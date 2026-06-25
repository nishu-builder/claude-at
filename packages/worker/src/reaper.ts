import { ECSClient, DescribeTasksCommand } from "@aws-sdk/client-ecs";
import {
  REGION,
  SECRET_IDS,
  getSecret,
  listRunningJobs,
  reapJob,
  Discord,
  type JobRecord,
} from "@claude-at/shared";

// A job whose worker dies (OOM, ECS task replacement, crash) is left `running`
// forever — nothing flips it back. The reaper periodically sweeps for jobs that
// have been `running` past a grace period and whose ECS task is no longer alive,
// then requeues them (so a healthy pool worker picks them up) or, once they've
// burned through their retries, marks them `failed` and says so in the thread.

const REAP_GRACE_MS = 15 * 60 * 1000; // don't touch a job until it's this old
const REAP_INTERVAL_MS = 60 * 1000; // how often to sweep
const MAX_ATTEMPTS = 3; // requeue up to this many times, then give up

const CLUSTER = process.env.CLUSTER;

const ecs = new ECSClient({ region: REGION });

// ECS task lifecycle states that mean the task is still (or soon) doing work.
const LIVE_STATUSES = new Set(["PROVISIONING", "PENDING", "ACTIVATING", "RUNNING"]);

// Returns the subset of the given task ARNs that ECS still considers alive.
// ARNs ECS doesn't know about (aged out of the API) count as dead by omission.
async function liveTaskArns(arns: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  if (!CLUSTER || arns.length === 0) return live;
  // DescribeTasks accepts at most 100 tasks per call.
  for (let i = 0; i < arns.length; i += 100) {
    const batch = arns.slice(i, i + 100);
    const res = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: batch }));
    for (const task of res.tasks ?? []) {
      if (task.taskArn && LIVE_STATUSES.has(task.lastStatus ?? "")) live.add(task.taskArn);
    }
  }
  return live;
}

async function sweep(discord: Discord, now: number): Promise<void> {
  const running = await listRunningJobs();
  const stale = running.filter((j) => now - Date.parse(j.updatedAt) > REAP_GRACE_MS);
  if (stale.length === 0) return;

  const arns = [...new Set(stale.map((j) => j.taskArn).filter((a): a is string => !!a))];
  const live = await liveTaskArns(arns);

  for (const job of stale) {
    // No taskArn means the claimer never recorded one (or it was already reaped);
    // a known-but-not-live ARN means the worker is gone. Either way, it's dead.
    const dead = !job.taskArn || !live.has(job.taskArn);
    if (!dead) continue;
    await reapOne(discord, job);
  }
}

async function reapOne(discord: Discord, job: JobRecord): Promise<void> {
  // reapJob can't fence on a missing taskArn (the condition keys off it), so
  // skip those — a worker that never recorded an ARN is rare and will age out.
  if (!job.taskArn) return;

  const attempts = job.attempts ?? 1;
  if (attempts < MAX_ATTEMPTS) {
    const ok = await reapJob(job.jobId, job.taskArn, { status: "queued" });
    if (ok) {
      console.log(`reaper: requeued ${job.jobId} (attempt ${attempts}/${MAX_ATTEMPTS}, worker gone)`);
      await discord
        .createMessage(job.threadId, "♻️ The worker handling this job went away — retrying…")
        .catch(() => {});
    }
    return;
  }

  const reason = `Worker died ${MAX_ATTEMPTS} times without finishing — giving up.`;
  const ok = await reapJob(job.jobId, job.taskArn, { status: "failed", error: reason });
  if (ok) {
    console.log(`reaper: failed ${job.jobId} (exhausted ${MAX_ATTEMPTS} attempts)`);
    await discord.createMessage(job.threadId, `🔴 ${reason}`).catch(() => {});
  }
}

// Starts the background sweep loop. Safe to run on every pool worker: reapJob
// is a conditional write, so concurrent reapers race harmlessly — only one wins.
export function startReaper(): void {
  if (!CLUSTER) {
    console.warn("reaper: CLUSTER not set — stuck-job reaper disabled");
    return;
  }

  let discord: Discord | undefined;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return; // a slow sweep shouldn't pile up behind the timer
    busy = true;
    try {
      if (!discord) discord = new Discord(await getSecret(SECRET_IDS.discordBotToken));
      await sweep(discord, Date.now());
    } catch (e) {
      console.error("reaper sweep error", e);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), REAP_INTERVAL_MS);
  timer.unref?.(); // don't keep the process alive for the reaper alone
  void tick();
}
