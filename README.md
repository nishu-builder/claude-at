# claude-at

**Claude Tag for Discord.** `@mention` the bot in a channel and a headless
[Claude Code](https://www.anthropic.com/claude-code) agent picks up the task, runs it in an
isolated AWS Fargate container (model served by **Amazon Bedrock**), streams its progress
into a thread, and — when it changes code — opens a real pull request.

It's the Discord twin of Anthropic's Slack-based "Claude Tag": a single shared agent that
fans out **parallel, ephemeral workers** to do real engineering.

## How it works

```
Discord @mention
   → Gateway (always-on Fargate service, discord.js)
        opens a thread, writes a Job to DynamoDB, ecs run-task → Worker
   → Worker (ephemeral Fargate task, one per job)
        GitHub App token → git clone → claude -p (Bedrock, stream-json)
        → streams stages into the thread → saves session id → (phase 2) opens a PR
```

No public endpoint is required: the gateway holds an **outbound** Discord Gateway
WebSocket, and workers are egress-only. Model auth is the worker's **IAM task role** via
Bedrock — there is no Anthropic API key anywhere.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Contract: types, config, GitHub App auth, Discord REST, Secrets, DynamoDB store |
| `packages/gateway` | discord.js listener → DynamoDB job + `ecs run-task` |
| `packages/worker` | Clone repo → headless Claude on Bedrock → stream to thread |
| `docker/` | Gateway + worker Dockerfiles (worker runs non-root) |
| `infra/terraform/` | ECR, ECS, DynamoDB, IAM, logs, security group, task defs, service |
| `scripts/` | `store-secret.sh`, `build-and-push.sh`, `identity.mjs` (manage identities), Discord bot runbook |
| `PLAN.md` | Full design doc |

TypeScript monorepo (npm workspaces), run with [`tsx`](https://tsx.is) — no build step.

## Quick start

Prereqs: an AWS account with Bedrock access to Claude, `claude`, Node 22+, Docker, and
Terraform. Set `AWS_PROFILE`.

```sh
npm install
npm run typecheck

# 1. Discord bot — create it (Developer Portal), enable Message Content Intent, then:
./scripts/store-secret.sh discord/agent-bot-token '<BOT_TOKEN>'   # see scripts/setup-discord-bot.md

# 2. GitHub App — create one that clones repos + opens PRs as itself, install it on your repos:
node scripts/create-github-app.mjs claude-at-agent               # see scripts/setup-github-app.md

# 3. Provision infra (default repo the worker clones when a mention doesn't name one)
cd infra/terraform && terraform apply -var 'default_repo=<owner>/<name>' && cd -

# 4. Build + push the images
./scripts/build-and-push.sh

# 5. Bring the gateway online
aws ecs update-service --cluster claude-at --service claude-at-gateway --desired-count 1
```

Then `@ClaudeTag <task>` in a channel, or `@ClaudeTag in <owner>/<repo>: <task>` to target a
specific repo. The bot opens a thread, works the task in an isolated container, streams its
stages, and — when it changes code — pushes a branch and opens a PR. `/status` and `/stop`
control the running task.

Then invite the bot to your server and `@Claude <task>` in a channel.

See [`scripts/setup-discord-bot.md`](scripts/setup-discord-bot.md) for the full bot runbook
and [`PLAN.md`](PLAN.md) for the architecture and the phased roadmap.

## Identities

An **identity** is a reusable agent configuration — **persona** (system prompt) +
**tools** (allowed tools) + **data** (default repo and allowed repos) + an **isolated
memory** namespace + an optional **avatar**. Identities are **admin-managed**, mirroring
Anthropic's Claude Tag model: an admin defines who the agent is, and channels are bound to
it. Identities live in the same `claude-at` DynamoDB table as jobs and threads.

The worker applies an identity by injecting its `persona` via `--append-system-prompt`,
restricting tools via `--allowedTools` when `allowedTools` is set, and namespacing memory
by `memoryNs`.

**Create one** (admin, with AWS creds):

```sh
AWS_PROFILE=sandbox-admin node scripts/identity.mjs create \
  --id eng --name "Eng Claude" \
  --repo nishu-builder/claude-at \
  --persona "You are a senior engineer…" \
  --avatar https://example.com/eng.png \
  --memory-ns eng
```

`list` shows all identities; pass `--repos a,b` and `--tools Bash,Edit` to constrain repos
and tools.

## Providing data and services to a job

A task often needs more than its repo — a database to seed, an extracted dataset, a
licensed asset, or a credential. Two mechanisms cover this, both running **before** the
agent starts so it works against a ready environment instead of improvising provisioning.

**Repo setup hook.** If the cloned repo contains an executable `.claude-at/setup.sh`, the
worker runs it (via `bash`, in the clone root) before handing off to the agent. Use it to
start a local DB, fetch fixtures, or build. Its combined stdout/stderr streams into the
thread and is captured in the audit log. It is bounded by a 10-minute timeout; a non-zero
exit (or timeout) **fails the job** rather than handing the agent a broken environment.

**Mountable datasets + secrets.** Attach data and credentials to an identity, scoped by
IAM:

```sh
node scripts/identity.mjs create --id wow --name "WoW Claude" \
  --repo me/vmangos-tools \
  --datasets "client=1.12.1/extracted,vmangos=db/vmangos-dump" \
  --secrets "DB_PASSWORD=claude-at/data/vmangos-pw"
```

- **Datasets** are `name=source` pairs. `source` is an `s3://bucket/prefix` URI or a bare
  prefix within the `claude-at-data-<account>` bucket (`DATA_BUCKET`). Each is synced into
  a per-identity dir and exposed to the hook and agent as `CLAUDE_AT_DATA_<NAME>` (with
  `CLAUDE_AT_DATA_DIR` pointing at the root). The sync is **incremental and cached across
  pool workers** — only missing or size-changed objects are re-fetched, so a large
  dataset downloads once per warm worker, not once per job.
- **Secrets** are `ENV=secretId` pairs injected as environment variables. `secretId` must
  live under `claude-at/data/` — the worker's IAM grant is confined to that prefix, so an
  identity can never mount the bot's own Discord/GitHub credentials. Store one with
  `scripts/store-secret.sh` (or the AWS console) under that prefix first.

**Per-identity avatars.** When the channel grants the bot **Manage Webhooks**, the worker
posts each thread message through a channel webhook carrying the identity's `displayName`
and `avatarUrl` — so the message *looks like it came from that persona* (custom name +
profile pic), set **per message**, never rewriting earlier messages. Without that
permission (or an avatar), it falls back to plain bot messages prefixed with
`[displayName]`.

**Bind a channel** to an identity, either in Discord:

```
/bind identity:eng
```

or from the CLI:

```sh
node scripts/identity.mjs bind --channel <channelId> --identity eng
```

**Repo resolution** for a mention follows this order:

1. an explicit `in owner/repo:` prefix in the message,
2. else the channel/thread identity's `defaultRepo`,
3. else none (the agent thinks without a repo attached).

**Memory** is namespaced by the identity: each thread's memory lives at
`<memoryNs>/<thread>/memory.md`, so two identities never share memory even in the same
server.

> v1 selects an identity by **channel binding** with a single bot, and webhooks give each
> identity its own per-message name + avatar. Making each identity separately
> **`@CustomName`-mentionable** (rather than sharing one bot mention) would mean running one
> Discord app per identity — a future enhancement.

## Security

The worker runs unattended with `--dangerously-skip-permissions`; the **container is the
sandbox** (ephemeral task, scoped IAM role, egress-only, blast radius = one cloned repo on
a throwaway branch). Suitable for a trusted server. For a shared/multi-tenant server, add a
per-request authz layer before widening write access.
