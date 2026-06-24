# claude-at

**Claude Tag for Discord.** `@mention` the bot in a channel and a headless
[Claude Code](https://www.anthropic.com/claude-code) agent picks up the task, runs it in an
isolated AWS Fargate container (model served by **Amazon Bedrock**), streams its progress
into a thread, and — phase 2 — opens a real pull request.

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
| `scripts/` | `store-secret.sh`, `build-and-push.sh`, Discord bot runbook |
| `PLAN.md` | Full design doc |

TypeScript monorepo (npm workspaces), run with [`tsx`](https://tsx.is) — no build step.

## Quick start

Prereqs: an AWS account with Bedrock access to Claude, a GitHub App (id + private key in
Secrets Manager), `claude`, Node 22+, Docker, and Terraform. Set `AWS_PROFILE`.

```sh
npm install
npm run typecheck

# 1. Create a Discord bot (Developer Portal), enable Message Content Intent, then:
./scripts/store-secret.sh discord/agent-bot-token '<BOT_TOKEN>'

# 2. Provision infra (set a default target repo for the worker)
cd infra/terraform && terraform apply -var 'default_repo=<owner>/<name>' && cd -

# 3. Build + push the images
./scripts/build-and-push.sh

# 4. Bring the gateway online
aws ecs update-service --cluster claude-at --service claude-at-gateway --desired-count 1
```

Then invite the bot to your server and `@Claude <task>` in a channel.

See [`scripts/setup-discord-bot.md`](scripts/setup-discord-bot.md) for the full bot runbook
and [`PLAN.md`](PLAN.md) for the architecture and the phased roadmap.

## Security

The worker runs unattended with `--dangerously-skip-permissions`; the **container is the
sandbox** (ephemeral task, scoped IAM role, egress-only, blast radius = one cloned repo on
a throwaway branch). Suitable for a trusted server. For a shared/multi-tenant server, add a
per-request authz layer before widening write access.
