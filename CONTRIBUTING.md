# Contributing to claude-at

Thanks for your interest in **claude-at** — the Claude Tag for Discord. This guide covers
how to get set up, the conventions the codebase follows, and how to land a change.

If you haven't yet, read the [`README.md`](README.md) for the what and [`PLAN.md`](PLAN.md)
for the architecture and the phased roadmap. New work should fit into that roadmap.

## Project shape

TypeScript monorepo (npm workspaces), run directly with [`tsx`](https://tsx.is) — **there
is no build step**. ECMAScript modules throughout (`"type": "module"`).

| Path | What |
|---|---|
| `packages/shared` | Contract: types, config, GitHub App auth, Discord REST, Secrets, DynamoDB store |
| `packages/gateway` | discord.js listener → DynamoDB job + `ecs run-task` |
| `packages/worker` | Clone repo → headless Claude on Bedrock → stream to thread |
| `docker/` | Gateway + worker Dockerfiles |
| `infra/terraform/` | All AWS infrastructure |
| `scripts/` | Operational scripts + the Discord bot runbook |

`packages/gateway` and `packages/worker` both depend on `@claude-at/shared`. Cross-cutting
types, config constants, and AWS/Discord/GitHub clients belong in `shared` — keep the two
services thin.

## Getting set up

Prereqs: Node 22+, npm, and `tsx` (installed via dev deps). For anything touching live
infrastructure you'll also need Docker, Terraform, the `claude` CLI, and an AWS account
with Bedrock access — see the README quick start.

```sh
npm install
npm run typecheck
```

`npm run typecheck` is the gate: it runs `tsc --noEmit` across the whole workspace. There
is no test suite yet — if you add one, wire it into a `test` script and mention it in your
PR.

To run a service locally:

```sh
npm run gateway   # tsx packages/gateway/src/index.ts
npm run worker    # tsx packages/worker/src/index.ts
```

Both read their secrets at runtime via AWS, so local runs need a configured `AWS_PROFILE`
with the right permissions.

## Conventions

- **TypeScript is strict.** `strict` and `noUncheckedIndexedAccess` are on — handle the
  `undefined` cases the compiler surfaces rather than asserting them away.
- **Centralize names and config.** Resource names, model ids, and secret ids live in
  `packages/shared/src/config.ts` (`NAMES`, `MODEL`, `SECRET_IDS`). Don't hardcode a
  cluster/table/secret string in a service — import it. Keep these in sync with the
  Terraform that creates the resources.
- **Read env through `requireEnv`** (from `shared/config`) for required variables, or
  `process.env.X ?? default` for optional ones.
- **No Anthropic API key.** Model auth is the worker's IAM task role via Bedrock. Don't
  introduce an API-key code path.
- **Secrets stay in Secrets Manager**, fetched at runtime via task roles — never baked into
  images or injected as plaintext container env. Use `./scripts/store-secret.sh` to seed a
  new secret and add its id to `SECRET_IDS`.
- **Match the surrounding style:** double quotes, 2-space indent, `const` exports, small
  focused modules. Look at neighboring files before adding a new one.

### Infrastructure

- All AWS resources are declared in `infra/terraform/`. Changes that add a resource a
  service needs (a table, a secret, an IAM action) must land in the same PR as the code
  that uses them.
- Run `terraform fmt` and `terraform validate` before sending an infra change, and include
  the relevant `terraform plan` summary in the PR.
- IAM stays least-privilege — the existing roles (worker, gateway, shared execution) are
  deliberately scoped. Widen them only as far as a change actually requires, and say why.
- The worker image runs as **non-root** (Claude Code refuses `--dangerously-skip-permissions`
  as root). Don't regress that in `docker/worker.Dockerfile`.

## Making a change

1. **Branch** off `main` (`git checkout -b <short-description>`). Never push directly to
   `main`.
2. Make your change. Keep it scoped to one concern; touch `shared` only when the contract
   genuinely needs to change.
3. Run `npm run typecheck` (and `terraform fmt`/`validate` if you touched infra).
4. **Commit** with a concise, imperative subject line, matching the existing history
   (e.g. `Worker: open a PR after a successful run`). Explain the *why* in the body when it
   isn't obvious.
5. **Open a PR** against `main`. In the description, cover what changed, why, how you
   verified it, and which phase of the roadmap it belongs to. Include any infra plan
   output.

## Security

The worker runs unattended with `--dangerously-skip-permissions`, so the **container is the
sandbox** — ephemeral task, scoped IAM role, egress-only, blast radius of one cloned repo on
a throwaway branch. Any change that widens the worker's reach (broader IAM, write access to
more repos, a network ingress path, loosening the non-root constraint) is a security-relevant
change: call it out explicitly in the PR so it gets the review it deserves.

Please don't open public issues for security problems — contact the maintainers directly.
