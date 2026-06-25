import { randomUUID } from "node:crypto";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type SendableChannels,
} from "discord.js";
import { ECSClient, StopTaskCommand } from "@aws-sdk/client-ecs";
import {
  REGION,
  SECRET_IDS,
  requireEnv,
  getSecret,
  getThread,
  getJob,
  putThread,
  putJob,
  updateJob,
  jobPk,
  threadPk,
  extractRepo,
  getChannelBinding,
  putChannelBinding,
  getIdentityOrDefault,
  DEFAULT_IDENTITY_ID,
  type JobRecord,
  type ThreadRecord,
} from "@claude-at/shared";

const CLUSTER = requireEnv("CLUSTER");

const ecs = new ECSClient({ region: REGION });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const COMMANDS = [
  { name: "status", description: "Show the latest claude-at task in this thread/channel" },
  { name: "stop", description: "Stop the running claude-at task in this thread" },
  {
    name: "bind",
    description: "Bind this channel to a claude-at identity",
    options: [{ name: "identity", description: "identity id", type: 3, required: true }],
  },
  { name: "identity", description: "Show the identity bound to this channel" },
];

async function registerCommands(guild: Guild): Promise<void> {
  try {
    await guild.commands.set(COMMANDS);
    console.log(`registered commands for guild ${guild.id}`);
  } catch (err) {
    console.error(`failed to register commands for guild ${guild.id}`, err);
  }
}

function onReady(): void {
  const u = client.user;
  console.log(`gateway ready as ${u?.username} (${u?.id})`);
  for (const guild of client.guilds.cache.values()) {
    void registerCommands(guild);
  }
}

client.once("clientReady", onReady);
client.once("ready", onReady);

client.on("guildCreate", (guild: Guild) => {
  void registerCommands(guild);
});

function stripMention(content: string, botId: string): string {
  return content.replaceAll(`<@${botId}>`, "").replaceAll(`<@!${botId}>`, "").trim();
}

client.on("messageCreate", async (message: Message) => {
  let jobId: string | undefined;
  try {
    console.log(
      `[msg] ch=${message.channelId} thread=${message.channel.isThread()} author=${message.author.username} bot=${message.author.bot} mention=${client.user ? message.mentions.users.has(client.user.id) : "?"} len=${message.content.length}`,
    );
    if (message.author.bot) return;
    const botId = client.user?.id;
    if (!botId) return;

    const inOwnedThread = message.channel.isThread() && (await getThread(message.channelId)) !== undefined;
    const mentioned =
      message.mentions.users.has(botId) ||
      message.content.includes(`<@${botId}>`) ||
      message.content.includes(`<@!${botId}>`);
    if (!mentioned && !inOwnedThread) return;

    const prompt = stripMention(message.content, botId);
    if (!prompt) {
      await message.reply("What would you like me to do? Mention me with a task.");
      return;
    }

    const { repo: routedRepo, rest } = extractRepo(prompt);
    if (!rest) {
      await message.reply("What would you like me to do? Mention me with a task.");
      return;
    }

    const existingThread = message.channel.isThread() ? await getThread(message.channelId) : undefined;

    const bindChannelId = message.channel.isThread()
      ? message.channel.parentId ?? message.channelId
      : message.channelId;
    const identityId =
      existingThread?.identityId ?? (await getChannelBinding(bindChannelId))?.identityId ?? DEFAULT_IDENTITY_ID;
    const identity = await getIdentityOrDefault(identityId);

    const repo = routedRepo ?? existingThread?.repo ?? identity.defaultRepo ?? undefined;
    if (repo && identity.allowedRepos && identity.allowedRepos.length > 0 && !identity.allowedRepos.includes(repo)) {
      await message.reply(`🚫 **${identity.displayName}** isn't allowed to work in \`${repo}\`.`);
      return;
    }

    let threadId: string;
    let thread: SendableChannels;
    if (message.channel.isThread()) {
      threadId = message.channelId;
      thread = message.channel;
    } else {
      const created = await message.startThread({ name: rest.slice(0, 80), autoArchiveDuration: 1440 });
      threadId = created.id;
      thread = created;
    }

    const existing = existingThread ?? (await getThread(threadId));
    const resumeSessionId = existing?.claudeSessionId;

    jobId = randomUUID();
    const now = new Date().toISOString();

    const job: JobRecord = {
      pk: jobPk(jobId),
      jobId,
      status: "queued",
      prompt: rest,
      guildId: message.guildId ?? "",
      channelId: message.channelId,
      threadId,
      userId: message.author.id,
      identityId: identity.id,
      repo,
      resumeSessionId,
      createdAt: now,
      updatedAt: now,
    };
    await putJob(job);

    const threadRec: ThreadRecord = {
      pk: threadPk(threadId),
      threadId,
      identityId: identity.id,
      repo,
      claudeSessionId: existing?.claudeSessionId,
      lastJobId: jobId,
      updatedAt: now,
    };
    await putThread(threadRec);
    console.log(`[job] ${jobId} repo=${repo ?? "-"} thread=${threadId} prompt="${rest.slice(0, 60)}"`);

    await thread.send("🟡 On it…");
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

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const t = await getThread(interaction.channelId);
  if (!t?.lastJobId) {
    await interaction.reply({ content: "No claude-at task found here.", flags: MessageFlags.Ephemeral });
    return;
  }
  const job = await getJob(t.lastJobId);
  if (!job) {
    await interaction.reply({ content: "No claude-at task found here.", flags: MessageFlags.Ephemeral });
    return;
  }
  const cost = job.costUsd ? `$${job.costUsd.toFixed(2)}` : "—";
  const prompt = job.prompt.length > 150 ? `${job.prompt.slice(0, 150)}…` : job.prompt;
  const lines = [
    `**status:** ${job.status}`,
    `**repo:** ${job.repo ?? "—"}`,
    `**cost:** ${cost}`,
    `**prompt:** ${prompt}`,
  ];
  if (job.status === "failed" && job.error) lines.push(`**error:** ${job.error}`);
  await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const t = await getThread(interaction.channelId);
  const job = t?.lastJobId ? await getJob(t.lastJobId) : undefined;
  if (job?.status === "running" && job.taskArn) {
    await ecs.send(
      new StopTaskCommand({ cluster: requireEnv("CLUSTER"), task: job.taskArn, reason: "stopped via /stop" }),
    );
    await updateJob(job.jobId, { status: "failed", error: "stopped by user" });
    await interaction.editReply("🛑 Stopped the running task.");
  } else {
    await interaction.editReply("No running task to stop here.");
  }
}

async function handleBind(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getString("identity", true);
  await putChannelBinding(interaction.channelId, id);
  const idn = await getIdentityOrDefault(id);
  await interaction.reply({
    content: `Bound this channel to **${idn.displayName}** (\`${id}\`)`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleIdentity(interaction: ChatInputCommandInteraction): Promise<void> {
  const bindChannelId = interaction.channel?.isThread?.()
    ? interaction.channel.parentId ?? interaction.channelId
    : interaction.channelId;
  const identityId = (await getChannelBinding(bindChannelId))?.identityId ?? DEFAULT_IDENTITY_ID;
  const identity = await getIdentityOrDefault(identityId);
  const allowedRepos =
    identity.allowedRepos && identity.allowedRepos.length > 0 ? String(identity.allowedRepos.length) : "any";
  const allowedTools =
    identity.allowedTools && identity.allowedTools.length > 0 ? identity.allowedTools.join(", ") : "all";
  const lines = [
    `**identity:** ${identity.displayName} (\`${identity.id}\`)`,
    `**defaultRepo:** ${identity.defaultRepo ?? "—"}`,
    `**allowedRepos:** ${allowedRepos}`,
    `**allowedTools:** ${allowedTools}`,
  ];
  await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "status") await handleStatus(interaction);
    else if (interaction.commandName === "stop") await handleStop(interaction);
    else if (interaction.commandName === "bind") await handleBind(interaction);
    else if (interaction.commandName === "identity") await handleIdentity(interaction);
  } catch (err) {
    console.error("interaction error", err);
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
