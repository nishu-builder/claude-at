# CLAUDE.md

Orientation for working on **claude-at** — the Claude Tag for Discord. Read this first; it
saves re-discovering the layout each run. Deeper detail: `README.md`, `PLAN.md`,
`CONTRIBUTING.md`.

## Layout

- `packages/shared/` — the contract: `types.ts`, `config.ts` (`NAMES`, `MODEL`,
  `SECRET_IDS`), `store.ts` (DynamoDB), `discord.ts`, `github.ts`, `s3.ts`, `secrets.ts`.
- `packages/gateway/` — always-on discord.js listener (`src/index.ts`).
- `packages/worker/` — ephemeral job runner: `index.ts` (pool loop), `claude.ts` (spawns
  Claude Code), `reaper.ts` (sweeps dead workers).
- `infra/terraform/` — all AWS infra (`dynamodb.tf`, `ecs.tf`, `iam.tf`, `s3.tf`, …).
- `docker/` — `gateway.Dockerfile`, `worker.Dockerfile` (worker runs **non-root**).
- `scripts/` — operational scripts + setup runbooks.

TypeScript monorepo (npm workspaces), run with `tsx` — **no build step**.

## Flow

1. Someone `@mentions` the bot in Discord.
2. **Gateway** opens a thread and writes a `queued` `JOB#` record to DynamoDB. (It does
   *not* `ecs run-task`; its only ECS call is `StopTask` for `/stop`.)
3. A **warm Fargate worker pool** polls and claims the job via the `status-index` GSI
   (`listQueuedJobs` → `claimJob`, a conditional write so only one worker wins).
4. The worker clones the repo (GitHub App token) and runs **headless Claude Code on
   Bedrock** (`claude -p`, `stream-json`) in the clone.
5. It streams stages into the thread and, when code changed, opens a **PR**.

## DynamoDB (single table `claude-at`)

One table, `pk`-prefixed by record type: `JOB#`, `THREAD#`, `IDENTITY#`, `CHANNEL#`.
Sparse `status-index` GSI (`hash=status`, `range=createdAt`) — only `JOB#` records carry a
`status`, so the worker pool Queries `status = queued` (FIFO) instead of Scanning. All
access goes through `packages/shared/src/store.ts`.

## Deploy

- **Auto:** merge to `main` → `.github/workflows/deploy.yml` (typecheck → build/push both
  images to ECR → `terraform apply` → force-new-deployment on both services).
- **Manual:** export AWS creds, then `cd infra/terraform` and run `terraform` with
  `-backend-config=backend.hcl` (see `backend.hcl.example`).

## Conventions

- Concise, **strongly-typed** TS (`strict` + `noUncheckedIndexedAccess`); handle the
  `undefined` cases rather than asserting them away.
- **No comments** unless the *why* is genuinely non-obvious. Match surrounding style
  (double quotes, 2-space indent, `const` exports, small modules).
- **Surgical changes** — keep diffs scoped to one concern; touch `shared` only when the
  contract must change.
- Centralize names/config in `shared/config.ts`; read env via `requireEnv`. **No Anthropic
  API key** — model auth is the worker's IAM task role via Bedrock. Secrets stay in Secrets
  Manager.
- Infra and the code that needs it land in the same PR; IAM stays least-privilege.
- Gate before pushing: `npm run typecheck` (and `terraform fmt`/`validate` for infra).

## Known gotchas

- **S3 `GetObject` returns 403, not 404, on a missing key** unless the role also has
  `s3:ListBucket` — without it, a missing key looks like an auth failure. The memory bucket
  role grants `s3:ListBucket` for exactly this reason (`infra/terraform/iam.tf`).
- **discord.js self-mention detection** needs the raw `<@botId>` / `<@!botId>` content-token
  check, not just `message.mentions` (`packages/gateway/src/index.ts`).
