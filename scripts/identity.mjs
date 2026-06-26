#!/usr/bin/env node
// Admin CLI for claude-at identities + channel bindings (DynamoDB table "claude-at").
//
// An identity = persona (system prompt) + default repo + allowed repos/tools +
// mountable datasets/secrets + a memory namespace. The worker injects the persona
// via --append-system-prompt, namespaces memory by memoryNs, restricts tools via
// --allowedTools, syncs datasets into the job's env (CLAUDE_AT_DATA_*), and injects
// named secrets as env vars. The gateway resolves a channel's identity (here or via
// /bind) and uses its defaultRepo.
//
// Usage:
//   AWS_PROFILE=sandbox-admin node scripts/identity.mjs create --id <id> --name <displayName> \
//     [--persona <text>] [--avatar <url>] [--repo <owner/name>] [--repos <a,b>] [--tools <Bash,Edit>] \
//     [--datasets <name=source,...>] [--secrets <ENV=claude-at/data/id,...>] [--memory-ns <ns>]
//   AWS_PROFILE=sandbox-admin node scripts/identity.mjs list
//   AWS_PROFILE=sandbox-admin node scripts/identity.mjs bind --channel <channelId> --identity <id>

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = "claude-at";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const USAGE = `claude-at identity admin

Usage:
  node scripts/identity.mjs create --id <id> --name <displayName> [options]
  node scripts/identity.mjs list
  node scripts/identity.mjs bind --channel <channelId> --identity <id>

create options:
  --id <id>             identity id (required)
  --name <displayName>  display name (required)
  --persona <text>      system prompt appended for this identity (default "")
  --avatar <url>        avatar image URL shown per message (needs Manage Webhooks)
  --repo <owner/name>   default repo used when a mention names none
  --repos <a,b,c>       comma-separated allowed repos
  --tools <Bash,Edit>   comma-separated allowed tools (restricts the worker)
  --datasets <list>     datasets to mount, "name=source" pairs (source = s3://bucket/prefix
                        or a bare prefix in DATA_BUCKET), e.g. "vmangos=db/vmangos,client=s3://my-bucket/1.12.1"
  --secrets <list>      secrets to inject, "ENV=secretId" pairs (secretId must start
                        with "claude-at/data/"), e.g. "DB_PASSWORD=claude-at/data/vmangos-pw"
  --memory-ns <ns>      memory namespace / isolation key (default <id>)

Run with AWS creds, e.g. AWS_PROFILE=sandbox-admin node scripts/identity.mjs ...`;

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`flag --${key} needs a value`);
    out[key] = next;
    i++;
  }
  return out;
}

function requireFlag(flags, name) {
  const v = flags[name];
  if (v === undefined || v === "") throw new Error(`missing required flag --${name}`);
  return v;
}

function splitList(v) {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const DATA_SECRET_PREFIX = "claude-at/data/";

function parsePairs(v, sep, what) {
  return splitList(v).map((entry) => {
    const i = entry.indexOf(sep);
    if (i <= 0) throw new Error(`bad ${what} "${entry}", expected key${sep}value`);
    return [entry.slice(0, i).trim(), entry.slice(i + 1).trim()];
  });
}

function parseDatasets(v) {
  return parsePairs(v, "=", "dataset").map(([name, source]) => {
    if (!source) throw new Error(`dataset "${name}" needs a source`);
    return { name, source };
  });
}

function parseSecrets(v) {
  return parsePairs(v, "=", "secret").map(([env, secretId]) => {
    if (!secretId.startsWith(DATA_SECRET_PREFIX)) {
      throw new Error(`secret "${env}" id must start with "${DATA_SECRET_PREFIX}" (got "${secretId}")`);
    }
    return { env, secretId };
  });
}

async function create(flags) {
  const id = requireFlag(flags, "id");
  const displayName = requireFlag(flags, "name");
  const now = new Date().toISOString();
  const item = {
    pk: `IDENTITY#${id}`,
    id,
    displayName,
    persona: flags.persona ?? "",
    memoryNs: flags["memory-ns"] ?? id,
    createdAt: now,
    updatedAt: now,
  };
  if (flags.avatar) item.avatarUrl = flags.avatar;
  if (flags.repo) item.defaultRepo = flags.repo;
  if (flags.repos) item.allowedRepos = splitList(flags.repos);
  if (flags.tools) item.allowedTools = splitList(flags.tools);
  if (flags.datasets) item.datasets = parseDatasets(flags.datasets);
  if (flags.secrets) item.secrets = parseSecrets(flags.secrets);

  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
  console.log("Stored identity:");
  console.log(JSON.stringify(item, null, 2));
}

async function list() {
  const r = await doc.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p)",
      ExpressionAttributeValues: { ":p": "IDENTITY#" },
    }),
  );
  const items = (r.Items ?? []).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (items.length === 0) {
    console.log("No identities found.");
    return;
  }
  const rows = items.map((it) => ({
    id: it.id ?? "",
    displayName: it.displayName ?? "",
    defaultRepo: it.defaultRepo ?? "—",
    memoryNs: it.memoryNs ?? "",
    allowedTools: it.allowedTools && it.allowedTools.length > 0 ? it.allowedTools.join(",") : "all",
    datasets: it.datasets && it.datasets.length > 0 ? it.datasets.map((d) => d.name).join(",") : "—",
    secrets: it.secrets && it.secrets.length > 0 ? it.secrets.map((s) => s.env).join(",") : "—",
  }));
  console.table(rows);
}

async function bind(flags) {
  const channelId = requireFlag(flags, "channel");
  const identityId = requireFlag(flags, "identity");
  const item = {
    pk: `CHANNEL#${channelId}`,
    channelId,
    identityId,
    updatedAt: new Date().toISOString(),
  };
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
  console.log(`Bound channel ${channelId} to identity ${identityId}.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }
  const flags = parseFlags(rest);
  switch (cmd) {
    case "create":
      await create(flags);
      break;
    case "list":
      await list();
      break;
    case "bind":
      await bind(flags);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e?.message ?? e);
  process.exit(1);
});
