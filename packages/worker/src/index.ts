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
  type Identity,
  type Webhook,
} from "@claude-at/shared";
import { runClaude, type ClaudeResult } from "./claude";
import { provisionData, runSetupHook } from "./provision";
import { startReaper } from "./reaper";

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

// Posts thread messages as the identity. When the channel grants Manage
// Webhooks, each message carries the identity's display name + avatar via a
// webhook execute — a true per-message profile that never rewrites earlier
// messages. Otherwise it falls back to plain bot messages with a `[name] `
// text prefix. Resolving the webhook is best-effort and cached for the job.
class Poster {
  private webhook: Webhook | null | undefined;

  constructor(
    private discord: Discord,
    private identity: Identity,
    private threadId: string,
    private parentChannelId: string | undefined,
  ) {}

  private get tag(): string {
    return `[${this.identity.displayName}] `;
  }

  private async resolveWebhook(): Promise<Webhook | null> {
    if (this.webhook !== undefined) return this.webhook;
    if (!this.parentChannelId) return (this.webhook = null);
    try {
      this.webhook = await this.discord.ensureWebhook(this.parentChannelId);
    } catch (e) {
      console.error("webhook unavailable, falling back to tagged messages", e);
      this.webhook = null;
    }
    return this.webhook;
  }

  // Post a message and return an opaque handle for later edits.
  async create(content: string): Promise<{ webhookMessageId?: string; botMessageId?: string }> {
    const hook = await this.resolveWebhook();
    if (hook) {
      const m = await this.discord.executeWebhook(hook, {
        content,
        username: this.identity.displayName,
        avatarUrl: this.identity.avatarUrl,
        threadId: this.threadId,
        wait: true,
      });
      if (m) return { webhookMessageId: m.id };
    }
    const m = await this.discord.createMessage(this.threadId, this.tag + content);
    return { botMessageId: m.id };
  }

  async edit(handle: { webhookMessageId?: string; botMessageId?: string }, content: string): Promise<void> {
    if (handle.webhookMessageId) {
      const hook = await this.resolveWebhook();
      if (hook) {
        await this.discord.editWebhookMessage(hook, handle.webhookMessageId, content, this.threadId);
        return;
      }
    }
    if (handle.botMessageId) {
      await this.discord.editMessage(this.threadId, handle.botMessageId, this.tag + content);
    }
  }
}

async function processJob(job: JobRecord): Promise<void> {
  const jobId = job.jobId;
  await updateJob(jobId, { status: "running" });

  const identity = await getIdentityOrDefault(job.identityId ?? DEFAULT_IDENTITY_ID);

  const token = await getSecret(SECRET_IDS.discordBotToken);
  const discord = new Discord(token);
  const poster = new Poster(discord, identity, job.threadId, job.parentChannelId);

  const introText = job.repo
    ? `🧠 working in \`${job.repo}\`…`
    : `🧠 thinking… (no repo attached)`;
  const progress = await poster.create(introText);
  await updateJob(jobId, { progressMessageId: progress.botMessageId ?? progress.webhookMessageId });

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

  effectivePrompt += `\n\n---\nYou are working inside a Debian Linux container with passwordless \`sudo\`. If a task needs a tool that is not installed (Python, a compiler, a CLI, system libraries), install it yourself rather than giving up — e.g. \`sudo apt-get update && sudo apt-get install -y <pkg>\`, \`uv pip install <pkg>\`, \`pip3 install --break-system-packages <pkg>\`, or \`npm i -g <pkg>\`. Only proprietary software or licensed data you cannot fetch is genuinely off-limits; if you hit that, say so plainly and do as much as you can without it.`;

  // Thread memory is written incrementally: an in-progress entry now, rewritten
  // with the outcome on success or failure. Both writes derive from the same
  // base snapshot, so the final one replaces the in-progress entry. Per-thread
  // serialization in the gateway keeps these single-object writes race-free.
  const memBase = memory ?? "# Thread memory\n";
  const memTs = new Date().toISOString();
  const writeMemory = async (outcome: string): Promise<void> => {
    if (!MEMORY_BUCKET) return;
    let next = `${memBase}\n\n## ${memTs}\n**Request:** ${job.prompt}${outcome}`;
    if (next.length > 12000) next = "# Thread memory (older entries trimmed)\n" + next.slice(-12000);
    try {
      await putObjectText(MEMORY_BUCKET, memKey, next, "text/markdown");
    } catch (e) {
      console.error("memory write failed", e);
    }
  };
  await writeMemory("\n**Status:** ⏳ working…");

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
      effectivePrompt += `\n\n---\nYou have the \`gh\` CLI authenticated for \`${repo}\`. If this request references a GitHub issue or PR (by number or link), read it yourself with \`gh issue view <n>\` / \`gh pr view <n>\` and address it. If you change code, end your reply with a line \`PR_TITLE: <a concise imperative title for the change>\`, and if you addressed a GitHub issue also include \`Closes #<n>\` in your reply.`;
    }

    let latestActivity = "";
    let lastRendered = "";

    // Provision identity-scoped datasets + secrets, then run the repo's setup
    // hook — both before the agent starts, so it certifies against real data in
    // a ready environment instead of improvising provisioning each run.
    const { env: provisionedEnv, lines: provisionLines } = await provisionData(identity);
    for (const line of provisionLines) {
      await poster.create(line).catch(() => {});
    }
    const dataVars = Object.keys(provisionedEnv);
    if (dataVars.length > 0) {
      effectivePrompt += `\n\n---\nProvisioned data and credentials are available as environment variables: ${dataVars
        .map((v) => `\`$${v}\``)
        .join(", ")}. \`CLAUDE_AT_DATA_*\` vars point at synced dataset directories; use them to certify against real data.`;
    }

    if (repo) {
      let hookBuf = "";
      let hookLast = 0;
      const flushHook = async (): Promise<void> => {
        if (hookBuf.length === hookLast) return;
        hookLast = hookBuf.length;
        latestActivity = `🛠️ setup: ${hookBuf.replace(/\s+/g, " ").trim().slice(-200)}`;
      };
      const hookTimer = setInterval(() => void flushHook(), 1500);
      let setup;
      try {
        setup = await runSetupHook(cwd, provisionedEnv, (d) => {
          hookBuf += d;
          if (hookBuf.length > 8000) hookBuf = hookBuf.slice(-8000);
        });
      } finally {
        clearInterval(hookTimer);
      }
      if (setup.ran) {
        const tail = setup.output.trim().slice(-1500);
        const head = setup.ok ? "🛠️ Ran `.claude-at/setup.sh`" : "🔴 `.claude-at/setup.sh` failed";
        await poster.create(tail ? `${head}\n\`\`\`\n${tail}\n\`\`\`` : head).catch(() => {});
        events.push({ type: "setup_hook", ok: setup.ok, output: setup.output });
        if (!setup.ok) throw new Error("setup hook failed; aborting before agent");
      }
    }

    const interval = setInterval(() => {
      const next = render(latestActivity);
      if (next === lastRendered) return;
      lastRendered = next;
      void poster.edit(progress, next).catch(() => {});
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
          ...provisionedEnv,
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
    const titleMatch = text.match(/^\s*PR_TITLE:\s*(.+)$/im);
    const prTitle = (titleMatch?.[1]?.trim() || job.prompt).slice(0, 72) || "claude-at changes";
    const cleanText = text.replace(/^\s*PR_TITLE:.*$/im, "").trim();

    await updateJob(jobId, {
      status: isError ? "failed" : "succeeded",
      resultSessionId: sessionId,
      costUsd,
      error: isError ? text : undefined,
    });
    await updateThread(job.threadId, { claudeSessionId: sessionId, repo });

    await writeMemory(
      isError ? `\n**Failed:** ${(text || "claude error").slice(0, 500)}` : `\n**Response:** ${cleanText.slice(0, 1500)}`,
    );

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
            title: prTitle,
            head: branch,
            base: defaultBranch,
            body: `Requested in Discord by <@${job.userId}>.\n\n> ${job.prompt}\n\n---\n\n${cleanText.slice(0, 1500)}\n\n🤖 Generated by claude-at`,
          });
          await updateJob(jobId, { prUrl: pr.url });
          await poster.create(`📬 Opened PR: ${pr.url}`);
        }
      } catch (e) {
        await poster.create(`⚠️ Made changes but couldn't open a PR: ${String(e)}`).catch(() => {});
        const diff = await gitOut(cwd, ["diff", `origin/${defaultBranch}`]).catch(() => "");
        if (diff) await poster.create("```diff\n" + diff.slice(0, 1800) + "\n```").catch(() => {});
      }
    }

    const finalLine = isError ? "🔴 Failed" : `✅ Done (${costUsd ? "$" + costUsd.toFixed(2) : ""})`;
    await poster.edit(progress, finalLine);

    const body = cleanText;
    if (!body) {
      await poster.create("(no output)");
    } else {
      for (const part of chunk(body, 1900)) {
        await poster.create(part);
      }
    }

    return;
  } catch (err) {
    await writeAudit({ text: String(err), costUsd: undefined, sessionId: undefined, isError: true });
    await updateJob(jobId, { status: "failed", error: String(err) }).catch(() => {});
    await writeMemory(`\n**Failed:** ${String(err).slice(0, 500)}`);
    await poster.create("🔴 Error: " + String(err)).catch(() => {});
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
  startReaper();
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
