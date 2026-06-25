import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REGION,
  MODEL,
  SECRET_IDS,
  AUDIT_BUCKET,
  MEMORY_BUCKET,
  getJob,
  updateJob,
  updateThread,
  getSecret,
  getObjectText,
  putObjectText,
  listQueuedJobs,
  claimJob,
  Discord,
  installationToken,
  authedCloneUrl,
  parseRepo,
  createPullRequest,
  getIdentityOrDefault,
  DEFAULT_IDENTITY_ID,
  type JobRecord,
} from "@claude-at/shared";
import { runClaude, type ClaudeResult } from "./claude";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function currentTaskArn(): Promise<string | undefined> {
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!uri) return undefined;
  try {
    const res = await fetch(`${uri}/task`);
    const data = (await res.json()) as { TaskARN?: string };
    return data.TaskARN;
  } catch {
    return undefined;
  }
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function render(activity: string): string {
  const header = "🟡 Working…";
  return activity ? `${header}\n${activity}`.slice(0, 1900) : header;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function gitOut(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim()));
    });
  });
}

async function processJob(job: JobRecord): Promise<void> {
  const jobId = job.jobId;
  await updateJob(jobId, { status: "running" });

  const identity = await getIdentityOrDefault(job.identityId ?? DEFAULT_IDENTITY_ID);
  const tag = `[${identity.displayName}] `;

  const token = await getSecret(SECRET_IDS.discordBotToken);
  const discord = new Discord(token);

  const introText = job.repo
    ? `🧠 **${identity.displayName}** working in \`${job.repo}\`…`
    : `🧠 **${identity.displayName}** thinking… (no repo attached)`;
  const msg = await discord.createMessage(job.threadId, introText);
  const progressMessageId = msg.id;
  await updateJob(jobId, { progressMessageId });

  const repo = job.repo;
  const memKey = `${identity.memoryNs}/${job.threadId}/memory.md`;
  let memory: string | undefined;
  try {
    if (MEMORY_BUCKET) memory = await getObjectText(MEMORY_BUCKET, memKey);
  } catch (e) {
    console.error("memory read failed (continuing without memory)", e);
  }
  let effectivePrompt = memory
    ? `You are continuing work in a Discord thread. Accumulated context from earlier in this thread:\n\n<thread_memory>\n${memory}\n</thread_memory>\n\nNow handle this new request:\n${job.prompt}`
    : job.prompt;

  const events: unknown[] = [];
  const startedAt = new Date().toISOString();

  const writeAudit = async (result: ClaudeResult | undefined): Promise<void> => {
    if (!AUDIT_BUCKET) return;
    const key = `${new Date().toISOString().slice(0, 10)}/${jobId}.json`;
    const audit = {
      jobId,
      threadId: job.threadId,
      channelId: job.channelId,
      guildId: job.guildId,
      userId: job.userId,
      repo: job.repo ?? null,
      prompt: job.prompt,
      effectivePrompt,
      model: MODEL.main,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: {
        text: result?.text,
        costUsd: result?.costUsd,
        sessionId: result?.sessionId,
        isError: result?.isError,
      },
      events,
    };
    try {
      await putObjectText(AUDIT_BUCKET, key, JSON.stringify(audit, null, 2), "application/json");
    } catch (e) {
      console.error("audit write failed", e);
    }
  };

  let ghToken: string | undefined;
  let defaultBranch: string | undefined;
  let tempDir: string | undefined;

  try {
    const cwd = await mkdtemp(join(tmpdir(), "claude-at-"));
    tempDir = cwd;
    if (repo) {
      const { owner, name } = parseRepo(repo);
      ghToken = await installationToken(owner, name);
      await run("git", ["clone", "--depth", "1", authedCloneUrl(owner, name, ghToken), cwd]);
      defaultBranch = (await gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    }

    if (repo && ghToken) {
      effectivePrompt += `\n\n---\nYou have the \`gh\` CLI authenticated for \`${repo}\`. If this request references a GitHub issue or PR (by number or link), read it yourself with \`gh issue view <n>\` / \`gh pr view <n>\` and address it.`;
    }

    let latestActivity = "";
    let lastRendered = "";

    const interval = setInterval(() => {
      const next = render(latestActivity);
      if (next === lastRendered) return;
      lastRendered = next;
      void discord.editMessage(job.threadId, progressMessageId, next).catch(() => {});
    }, 1500);

    let result: ClaudeResult;
    try {
      result = await runClaude({
        prompt: effectivePrompt,
        cwd,
        appendSystemPrompt: identity.persona || undefined,
        allowedTools: identity.allowedTools,
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: REGION,
          ANTHROPIC_MODEL: MODEL.main,
          ANTHROPIC_SMALL_FAST_MODEL: MODEL.smallFast,
          ...(ghToken ? { GH_TOKEN: ghToken } : {}),
          ...(repo ? { GH_REPO: repo } : {}),
        },
        callbacks: {
          onEvent: (evt) => {
            events.push(evt);
          },
          onSession: (id) => {
            latestActivity = `🟢 session ${id.slice(0, 8)}`;
          },
          onActivity: (line) => {
            latestActivity = line;
          },
        },
      });
    } finally {
      clearInterval(interval);
    }

    const { text, costUsd, sessionId, isError } = result;

    await updateJob(jobId, {
      status: isError ? "failed" : "succeeded",
      resultSessionId: sessionId,
      costUsd,
      error: isError ? text : undefined,
    });
    await updateThread(job.threadId, { claudeSessionId: sessionId, repo });

    if (!isError && MEMORY_BUCKET) {
      const entry = `\n\n## ${new Date().toISOString()}\n**Request:** ${job.prompt}\n**Response:** ${result.text.slice(0, 1500)}`;
      const base = memory ?? "# Thread memory\n";
      let next = base + entry;
      if (next.length > 12000) next = "# Thread memory (older entries trimmed)\n" + next.slice(-12000);
      await putObjectText(MEMORY_BUCKET, memKey, next, "text/markdown");
    }

    await writeAudit(result);

    if (repo && ghToken && defaultBranch && !isError) {
      try {
        const dirty = (await gitOut(cwd, ["status", "--porcelain"])).trim();
        if (dirty) {
          await gitOut(cwd, ["add", "-A"]);
          await gitOut(cwd, [
            "-c",
            "user.name=claude-at",
            "-c",
            "user.email=claude-at[bot]@users.noreply.github.com",
            "commit",
            "-m",
            `claude-at: ${job.prompt.slice(0, 60)}`,
          ]);
        }
        const ahead = parseInt(
          (await gitOut(cwd, ["rev-list", "--count", `origin/${defaultBranch}..HEAD`])).trim() || "0",
          10,
        );
        if (ahead > 0) {
          const branch = `claude-at/${jobId.slice(0, 8)}`;
          await gitOut(cwd, ["branch", branch]);
          await gitOut(cwd, ["push", "origin", branch]);
          const { owner, name } = parseRepo(repo);
          const pr = await createPullRequest(owner, name, ghToken, {
            title: job.prompt.slice(0, 72) || "claude-at changes",
            head: branch,
            base: defaultBranch,
            body: `Requested in Discord by <@${job.userId}>.\n\n> ${job.prompt}\n\n---\n\n${result.text.slice(0, 1500)}\n\n🤖 Generated by claude-at`,
          });
          await updateJob(jobId, { prUrl: pr.url });
          await discord.createMessage(job.threadId, `${tag}📬 Opened PR: ${pr.url}`);
        }
      } catch (e) {
        await discord
          .createMessage(job.threadId, `${tag}⚠️ Made changes but couldn't open a PR: ${String(e)}`)
          .catch(() => {});
        const diff = await gitOut(cwd, ["diff", `origin/${defaultBranch}`]).catch(() => "");
        if (diff)
          await discord
            .createMessage(job.threadId, "```diff\n" + diff.slice(0, 1800) + "\n```")
            .catch(() => {});
      }
    }

    const finalLine = isError ? "🔴 Failed" : `✅ Done (${costUsd ? "$" + costUsd.toFixed(2) : ""})`;
    await discord.editMessage(job.threadId, progressMessageId, finalLine);

    const body = text.trim();
    if (!body) {
      await discord.createMessage(job.threadId, `${tag}(no output)`);
    } else {
      for (const part of chunk(body, 1900)) {
        await discord.createMessage(job.threadId, tag + part);
      }
    }

    return;
  } catch (err) {
    await writeAudit({ text: String(err), costUsd: undefined, sessionId: undefined, isError: true });
    await updateJob(jobId, { status: "failed", error: String(err) }).catch(() => {});
    await discord.createMessage(job.threadId, tag + "🔴 Error: " + String(err)).catch(() => {});
    return;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<void> {
  const jobId = process.env.JOB_ID;
  if (jobId) {
    const job = await getJob(jobId);
    if (!job) {
      console.error("job not found");
      process.exit(1);
    }
    try {
      await processJob(job);
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  }

  console.log("worker pool ready — polling");
  for (;;) {
    try {
      const jobs = await listQueuedJobs();
      let claimed = false;
      for (const job of jobs) {
        const arn = await currentTaskArn();
        if (await claimJob(job.jobId, arn)) {
          const fresh = (await getJob(job.jobId)) ?? job;
          await processJob(fresh);
          claimed = true;
          break;
        }
      }
      if (!claimed) await sleep(1500 + Math.floor(Math.random() * 1500));
    } catch (e) {
      console.error("pool loop error", e);
      await sleep(3000);
    }
  }
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
