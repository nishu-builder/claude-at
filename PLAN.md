# claude-at — Claude Tag for Discord

`@mention` a bot in Discord, and a headless Claude Code agent picks up the task,
works through it stage-by-stage in an isolated container, streams progress back
into a thread, and (phase 2) opens a real PR. The Discord twin of Anthropic's
Slack-based "Claude Tag".

## Prerequisites

- An AWS account with **Amazon Bedrock** access to Anthropic Claude. This project uses the
  `us.anthropic.claude-opus-4-8` + `us.anthropic.claude-haiku-4-5` inference profiles in
  `us-east-1`, reached via your configured AWS profile/role (set `AWS_PROFILE`).
- Headless Claude Code on Bedrock (validated end-to-end):
  `CLAUDE_CODE_USE_BEDROCK=1 ANTHROPIC_MODEL=us.anthropic.claude-opus-4-8 ANTHROPIC_SMALL_FAST_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0 claude -p ... --output-format json`
  returns `{ result, session_id, total_cost_usd, ... }`.
- A **GitHub App** (id + private key) stored in Secrets Manager → the agent clones (and,
  phase 2, opens PRs) as itself.
- The account's **default VPC** + public subnets (Fargate tasks run there, egress-only).
- A **Discord bot** with the Message Content Intent enabled; its token stored in Secrets
  Manager as `discord/agent-bot-token`. See "Manual steps".
- Local tooling for deploys: `claude`, Node 22+, Docker, Terraform.

## Decisions

| Decision | Choice |
|---|---|
| Trigger UX | `@mention` the bot (persistent Discord Gateway listener) |
| Model backend | AWS Bedrock `us.anthropic.claude-opus-4-8` (in-account, IAM-based) |
| v1 scope | Thin vertical slice: mention → headless Claude → stream result into thread |
| Runtime | ECS Fargate (always-on gateway service + ephemeral worker task per job) |
| Language | TypeScript (discord.js + AWS SDK v3; worker shells out to `claude`) |
| State | DynamoDB (jobs + thread→session mapping) |
| Networking | Default VPC public subnets, egress-only. No inbound, no LB. |

Rationale for the gateway split: the Discord Gateway connection must be a single,
stable, always-on WebSocket; the actual work is bursty, long-running, parallel, and
benefits from per-task isolation. Outbound-only WebSocket means **no public endpoint
is needed** — no Cloudflare/API-GW in v1 (those would only be needed for a
slash-command/Interactions HTTP path, a phase-3 option).

## Architecture

```
 Discord (@Claude do X)
        │  Gateway WebSocket (MESSAGE_CREATE, Message Content Intent)
        ▼
 ┌─────────────────────────┐
 │  Gateway service        │  always-on Fargate service (1 task)
 │  (discord.js)           │  • detect @mention / thread reply
 │                         │  • create/find thread, ack instantly
 │                         │  • write Job to DynamoDB
 │                         │  • ecs run-task → Worker (1 per job)
 └───────────┬─────────────┘
             │ RunTask(JOB_ID)            ┌────────────────────────────┐
             ▼                            │ DynamoDB  claude-at         │
 ┌─────────────────────────┐  read/write │  JOB#<id>    {prompt,...}   │
 │  Worker task (ephemeral) │◄───────────►│  THREAD#<id> {repo,session} │
 │  • read Job from Dynamo │             └────────────────────────────┘
 │  • GitHub App token →    │
 │    git clone repo        │             Bedrock: us.anthropic.claude-opus-4-8
 │  • claude -p --resume    │────────────►(InvokeModelWithResponseStream)
 │      --output-format     │
 │      stream-json         │             Discord REST (bot token)
 │  • stream stages → thread│────────────►POST/PATCH /channels/{thread}/messages
 │  • save new session_id   │
 │  • (phase 2) push + PR    │────────────►GitHub API
 └─────────────────────────┘
```

### Components (monorepo, npm workspaces)

```
claude-at/
  PLAN.md
  package.json            # workspaces: packages/*
  tsconfig.base.json
  packages/
    shared/               # contract: types, config, github-app, discord REST, secrets, dynamo store
    gateway/              # discord.js listener → DynamoDB job + ecs run-task
    worker/               # entrypoint: clone → claude headless → stream → finalize
  docker/
    gateway.Dockerfile
    worker.Dockerfile
  infra/terraform/        # ECR, ECS, IAM, DynamoDB, log groups, SG, task defs, service
  scripts/                # store-secret, build-and-push, discord-bot setup runbook
```

## Data contract

**Job** (`PK = JOB#<jobId>`): `{ jobId, status, prompt, guildId, channelId, threadId,
userId, repo?, resumeSessionId?, createdAt, resultSessionId?, costUsd?, error? }`
`status ∈ queued | running | succeeded | failed`.

**Thread** (`PK = THREAD#<threadId>`): `{ threadId, repo?, claudeSessionId?, lastJobId, updatedAt }`.
On a follow-up mention in a known thread, gateway reads `claudeSessionId` + `repo` and
passes them to the worker → context continuity. Worker writes the fresh `session_id` back.

**Gateway → Worker handoff:** RunTask container override env `JOB_ID` + `DDB_TABLE` only
(keeps us under the 8 KB RunTask overrides limit; everything else is read from DynamoDB).

## Model / IAM contract

Worker task definition env (static): `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION=us-east-1`,
`ANTHROPIC_MODEL=us.anthropic.claude-opus-4-8`,
`ANTHROPIC_SMALL_FAST_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0`.

- **Worker task role:** `bedrock:InvokeModel*` on the Anthropic inference profiles +
  underlying foundation models (cross-region inference needs regional model ARNs);
  `dynamodb:*Item` on the table; `secretsmanager:GetSecretValue` on `github/agent-app-*`
  and `discord/agent-bot-token`.
- **Gateway task role:** `ecs:RunTask` (worker family) + `iam:PassRole` (worker task &
  exec roles); `dynamodb:*Item` on the table; `GetSecretValue` on `discord/agent-bot-token`.
- **Execution role (shared):** ECR pull + CloudWatch logs.

Both the gateway and worker fetch their secrets at runtime via their task roles (no
container-injected secrets), keeping the execution role minimal.

## Security boundary

The worker runs `claude -p --dangerously-skip-permissions` (unattended). That is safe
because the **container is the sandbox**: ephemeral Fargate task, scoped IAM role, egress
only, blast radius limited to a cloned repo on a throwaway branch — the same model as the
Claude Code GitHub Action. The worker image runs as a **non-root** user (Claude Code
refuses `--dangerously-skip-permissions` as root). v1 operates against a single configured
repo; phase 2 widens to real repos with branch+PR (never direct pushes to default branches).

## Build phases

**Phase 1 — thin slice:**
1. Monorepo + `shared` contract (types, config, github-app, discord, secrets, dynamo).
2. Worker: read job → clone repo → run headless Claude on Bedrock → stream stages into the
   Discord thread → write summary + new session id. (PR creation off.)
3. Gateway: discord.js, detect @mention, create thread, write job, `ecs run-task`.
4. Terraform: ECR ×2, ECS cluster, DynamoDB, IAM roles, log groups, SG, worker task def,
   gateway service. Two Dockerfiles + build/push scripts.
5. Manual: create Discord bot, store `discord/agent-bot-token`, invite to server.
6. Deploy + live test: `@Claude summarize this repo` → watch it work in-thread.

**Phase 2 — real engineering:** worker pushes a branch + opens a PR via the GitHub App;
post PR link + diff summary in-thread; per-channel default repo + `owner/repo` routing in
the message; durable per-thread memory committed to a repo (replaces the v1 `--resume`
gate, which can't see a session file created on a different container); richer stage
rendering.

**Phase 3 — parity & scale:** SQS between gateway & worker (durability, backpressure,
concurrency caps, `/stop`); slash commands (`/claude`, `/status`, `/stop`) via an
Interactions endpoint; proactive updates (EventBridge → Claude reviews channels).
"Delegate to many Claudes in parallel" = N concurrent worker tasks, one per job/thread.

## Manual steps

1. **Create the Discord bot** (Developer Portal → New Application → Bot):
   - Enable **Message Content Intent** (required to read `@mention` text).
   - Copy the **bot token** and store it: `./scripts/store-secret.sh discord/agent-bot-token <token>`.
   - Invite URL with scope `bot`, perms: View Channels, Send Messages, Create Public
     Threads, Send Messages in Threads, Read Message History.
2. **Provision infra**: `cd infra/terraform && terraform apply` (set `AWS_PROFILE` and
   `-var default_repo=<owner/name>` for the worker's default target repo).
3. **Build + push images**: `./scripts/build-and-push.sh`.
4. Scale the gateway up once the bot token secret exists:
   `aws ecs update-service --cluster claude-at --service claude-at-gateway --desired-count 1`.

## Cost notes

Bedrock opus-4-8 ≈ the only material cost; a trivial turn measures ~$0.12 (dominated by
one-time system-prompt cache creation). Fargate: gateway ~1 always-on 0.25vCPU/0.5GB task;
workers bill per-second only while a job runs. DynamoDB on-demand, negligible.
