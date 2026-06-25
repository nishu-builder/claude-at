import { randomUUID } from "node:crypto";
import {
  Client,
  EmbedBuilder,
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
  getIdentity,
  getIdentityOrDefault,
  putIdentity,
  listIdentities,
  identityPk,
  DEFAULT_IDENTITY_ID,
  type JobRecord,
  type ThreadRecord,
  type Identity,
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
  {
    name: "create-identity",
    description: "Create or update a claude-at identity",
    options: [
      { name: "id", description: "short id, e.g. eng", type: 3, required: true },
      { name: "name", description: "display name", type: 3, required: true },
      { name: "persona", description: "system prompt / persona", type: 3, required: false },
      { name: "avatar", description: "avatar image URL shown per message", type: 3, required: false },
      { name: "repo", description: "default repo owner/name", type: 3, required: false },
      { name: "memory_ns", description: "memory namespace (defaults to id)", type: 3, required: false },
    ],
  },
  {
    name: "update-identity",
    description: "Update fields on an existing claude-at identity",
    options: [
      { name: "id", description: "short id of the identity to update", type: 3, required: true },
      { name: "name", description: "display name", type: 3, required: false },
      { name: "persona", description: "system prompt / persona", type: 3, required: false },
      { name: "avatar", description: "avatar image URL shown per message", type: 3, required: false },
      { name: "repo", description: "default repo owner/name", type: 3, required: false },
      { name: "memory_ns", description: "memory namespace", type: 3, required: false },
    ],
  },
  { name: "identities", description: "List claude-at identities" },
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

function describeActiveJob(job: JobRecord): string {
  const startedMs = Date.parse(job.createdAt);
  const secs = Number.isFinite(startedMs) ? Math.max(0, Math.round((Date.now() - startedMs) / 1000)) : undefined;
  const ago = secs === undefined ? "" : secs < 90 ? ` (${secs}s in)` : ` (${Math.round(secs / 60)}m in)`;
  const what = job.prompt.length > 120 ? `${job.prompt.slice(0, 120)}…` : job.prompt;
  const state = job.status === "queued" ? "Queued" : "Still working";
  return `⏳ ${state} on the current task${ago}: "${what}". I'll post the result here when it's done — no need to re-send.`;
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

    const existingThread = message.channel.isThread() ? await getThread(message.channelId) : undefined;
    const inOwnedThread = existingThread !== undefined;
    const mentioned =
      message.mentions.users.has(botId) ||
      message.content.includes(`<@${botId}>`) ||
      message.content.includes(`<@!${botId}>`);
    if (!mentioned && !inOwnedThread) return;

    // A task is already in flight for this thread: report its status instead of
    // spawning a second, context-less job that would race on the thread's memory
    // file and PR branch. (Genuine new instructions can wait for it to finish.)
    if (existingThread?.lastJobId) {
      const active = await getJob(existingThread.lastJobId);
      if (active && (active.status === "queued" || active.status === "running")) {
        await message.reply(describeActiveJob(active));
        return;
      }
    }

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
      parentChannelId: bindChannelId,
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
  const embed = new EmbedBuilder()
    .setTitle(`${identity.displayName} (${identity.id})`)
    .addFields(
      { name: "defaultRepo", value: identity.defaultRepo ?? "—", inline: true },
      { name: "allowedRepos", value: allowedRepos, inline: true },
      { name: "allowedTools", value: allowedTools, inline: true },
      { name: "memory ns", value: identity.memoryNs || "—", inline: true },
    );
  if (identity.avatarUrl) embed.setThumbnail(identity.avatarUrl);
  if (identity.persona) embed.setDescription(identity.persona.slice(0, 4096));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCreateIdentity(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getString("id", true);
  const name = interaction.options.getString("name", true);
  const persona = interaction.options.getString("persona");
  const avatar = interaction.options.getString("avatar");
  const repo = interaction.options.getString("repo");
  const memoryNs = interaction.options.getString("memory_ns");
  const now = new Date().toISOString();
  const identity: Identity = {
    pk: identityPk(id),
    id,
    displayName: name,
    persona: persona ?? "",
    avatarUrl: avatar || undefined,
    defaultRepo: repo || undefined,
    memoryNs: memoryNs || id,
    createdAt: now,
    updatedAt: now,
  };
  await putIdentity(identity);
  const lines = [
    `✅ Saved identity **${name}** (\`${id}\`)`,
    `${identity.defaultRepo ? `repo \`${identity.defaultRepo}\`` : "no default repo"} · memory ns \`${identity.memoryNs}\``,
    `Bind a channel with \`/bind identity:${id}\``,
  ];
  await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
}

async function handleUpdateIdentity(interaction: ChatInputCommandInteraction): Promise<void> {
  const id = interaction.options.getString("id", true);
  const existing = await getIdentity(id);
  if (!existing) {
    await interaction.reply({
      content: `No identity \`${id}\` found. Create it with \`/create-identity\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const name = interaction.options.getString("name");
  const persona = interaction.options.getString("persona");
  const avatar = interaction.options.getString("avatar");
  const repo = interaction.options.getString("repo");
  const memoryNs = interaction.options.getString("memory_ns");

  const changed: string[] = [];
  const updated: Identity = { ...existing, updatedAt: new Date().toISOString() };
  if (name !== null) {
    updated.displayName = name;
    changed.push("name");
  }
  if (persona !== null) {
    updated.persona = persona;
    changed.push("persona");
  }
  if (avatar !== null) {
    updated.avatarUrl = avatar || undefined;
    changed.push("avatar");
  }
  if (repo !== null) {
    updated.defaultRepo = repo || undefined;
    changed.push("repo");
  }
  if (memoryNs !== null) {
    updated.memoryNs = memoryNs || id;
    changed.push("memory_ns");
  }

  if (changed.length === 0) {
    await interaction.reply({
      content: "Nothing to update — provide at least one field to change.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await putIdentity(updated);
  await interaction.reply({
    content: `✅ Updated **${updated.displayName}** (\`${id}\`): ${changed.join(", ")}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleIdentities(interaction: ChatInputCommandInteraction): Promise<void> {
  const all = await listIdentities();
  if (all.length === 0) {
    await interaction.reply({ content: "No identities yet.", flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = all.map((i) => `• **${i.displayName}** (\`${i.id}\`) → ${i.defaultRepo ?? "—"}`);
  await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "status") await handleStatus(interaction);
    else if (interaction.commandName === "stop") await handleStop(interaction);
    else if (interaction.commandName === "bind") await handleBind(interaction);
    else if (interaction.commandName === "identity") await handleIdentity(interaction);
    else if (interaction.commandName === "create-identity") await handleCreateIdentity(interaction);
    else if (interaction.commandName === "update-identity") await handleUpdateIdentity(interaction);
    else if (interaction.commandName === "identities") await handleIdentities(interaction);
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
