import { randomUUID } from "node:crypto";
import { Client, GatewayIntentBits, type Message, type SendableChannels } from "discord.js";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import {
  REGION,
  NAMES,
  SECRET_IDS,
  DEFAULT_REPO,
  requireEnv,
  getSecret,
  getThread,
  putThread,
  putJob,
  updateJob,
  jobPk,
  threadPk,
  type JobRecord,
  type ThreadRecord,
} from "@claude-at/shared";

const CLUSTER = requireEnv("CLUSTER");
const WORKER_TASKDEF = requireEnv("WORKER_TASKDEF");
const WORKER_SUBNETS = requireEnv("WORKER_SUBNETS");
const WORKER_SECURITY_GROUP = requireEnv("WORKER_SECURITY_GROUP");

const ecs = new ECSClient({ region: REGION });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

function onReady(): void {
  const u = client.user;
  console.log(`gateway ready as ${u?.username} (${u?.id})`);
}

client.once("clientReady", onReady);
client.once("ready", onReady);

function stripMention(content: string, botId: string): string {
  return content.replaceAll(`<@${botId}>`, "").replaceAll(`<@!${botId}>`, "").trim();
}

async function launchWorker(jobId: string): Promise<void> {
  const res = await ecs.send(
    new RunTaskCommand({
      cluster: CLUSTER,
      taskDefinition: WORKER_TASKDEF,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: WORKER_SUBNETS.split(","),
          securityGroups: [WORKER_SECURITY_GROUP],
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: NAMES.workerContainer,
            environment: [
              { name: "JOB_ID", value: jobId },
              { name: "DDB_TABLE", value: process.env.DDB_TABLE ?? NAMES.table },
            ],
          },
        ],
      },
    }),
  );
  if (res.failures && res.failures.length > 0) {
    throw new Error(`RunTask failures: ${JSON.stringify(res.failures)}`);
  }
}

client.on("messageCreate", async (message: Message) => {
  let jobId: string | undefined;
  try {
    if (message.author.bot) return;
    const botId = client.user?.id;
    if (!botId) return;

    const inOwnedThread = message.channel.isThread() && (await getThread(message.channelId)) !== undefined;
    const mentioned = message.mentions.users.has(botId);
    if (!mentioned && !inOwnedThread) return;

    const prompt = stripMention(message.content, botId);
    if (!prompt) {
      await message.reply("What would you like me to do? Mention me with a task.");
      return;
    }

    let threadId: string;
    let thread: SendableChannels;
    if (message.channel.isThread()) {
      threadId = message.channelId;
      thread = message.channel;
    } else {
      const created = await message.startThread({ name: prompt.slice(0, 80), autoArchiveDuration: 1440 });
      threadId = created.id;
      thread = created;
    }

    const existing = await getThread(threadId);
    const repo = existing?.repo || DEFAULT_REPO || undefined;
    const resumeSessionId = existing?.claudeSessionId;

    jobId = randomUUID();
    const now = new Date().toISOString();

    const job: JobRecord = {
      pk: jobPk(jobId),
      jobId,
      status: "queued",
      prompt,
      guildId: message.guildId ?? "",
      channelId: message.channelId,
      threadId,
      userId: message.author.id,
      repo,
      resumeSessionId,
      createdAt: now,
      updatedAt: now,
    };
    await putJob(job);

    const threadRec: ThreadRecord = {
      pk: threadPk(threadId),
      threadId,
      repo,
      claudeSessionId: existing?.claudeSessionId,
      lastJobId: jobId,
      updatedAt: now,
    };
    await putThread(threadRec);

    await thread.send("🟡 On it — launching a worker…");

    await launchWorker(jobId);
  } catch (err) {
    if (jobId) {
      try {
        await updateJob(jobId, { status: "failed", error: String(err) });
      } catch {}
    }
    try {
      if (message.channel.isSendable()) await message.channel.send(`🔴 Failed to start: ${String(err)}`);
    } catch {}
  }
});

async function main(): Promise<void> {
  const token = await getSecret(SECRET_IDS.discordBotToken);
  await client.login(token);
}

main().catch((err) => {
  console.error("gateway fatal", err);
  process.exit(1);
});
