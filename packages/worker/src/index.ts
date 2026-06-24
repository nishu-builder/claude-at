import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REGION,
  MODEL,
  SECRET_IDS,
  requireEnv,
  getJob,
  updateJob,
  updateThread,
  getSecret,
  Discord,
  installationToken,
  authedCloneUrl,
  parseRepo,
} from "@claude-at/shared";
import { runClaude } from "./claude";

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

async function main(): Promise<void> {
  const jobId = requireEnv("JOB_ID");
  const job = await getJob(jobId);
  if (!job) {
    console.error(`job ${jobId} not found`);
    process.exit(1);
  }

  await updateJob(jobId, { status: "running" });

  const token = await getSecret(SECRET_IDS.discordBotToken);
  const discord = new Discord(token);

  const msg = await discord.createMessage(job.threadId, "🧠 Thinking…");
  const progressMessageId = msg.id;
  await updateJob(jobId, { progressMessageId });

  try {
    const repo = job.repo;
    let cwd: string;
    if (repo) {
      const { owner, name } = parseRepo(repo);
      const ghToken = await installationToken(owner, name);
      cwd = await mkdtemp(join(tmpdir(), "claude-at-"));
      await run("git", ["clone", "--depth", "1", authedCloneUrl(owner, name, ghToken), cwd]);
    } else {
      cwd = await mkdtemp(join(tmpdir(), "claude-at-"));
    }

    let latestActivity = "";
    let lastRendered = "";

    const interval = setInterval(() => {
      const next = render(latestActivity);
      if (next === lastRendered) return;
      lastRendered = next;
      void discord.editMessage(job.threadId, progressMessageId, next).catch(() => {});
    }, 1500);

    let result;
    try {
      result = await runClaude({
        prompt: job.prompt,
        cwd,
        resume: process.env.ENABLE_RESUME === "1" ? job.resumeSessionId : undefined,
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: REGION,
          ANTHROPIC_MODEL: MODEL.main,
          ANTHROPIC_SMALL_FAST_MODEL: MODEL.smallFast,
        },
        callbacks: {
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

    const finalLine = isError ? "🔴 Failed" : `✅ Done (${costUsd ? "$" + costUsd.toFixed(2) : ""})`;
    await discord.editMessage(job.threadId, progressMessageId, finalLine);

    const body = text.trim();
    if (!body) {
      await discord.createMessage(job.threadId, "(no output)");
    } else {
      for (const part of chunk(body, 1900)) {
        await discord.createMessage(job.threadId, part);
      }
    }

    process.exit(0);
  } catch (err) {
    await updateJob(jobId, { status: "failed", error: String(err) }).catch(() => {});
    await discord.createMessage(job.threadId, "🔴 Error: " + String(err)).catch(() => {});
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
