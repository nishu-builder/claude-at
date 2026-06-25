# syntax=docker/dockerfile:1

# ── Builder ───────────────────────────────────────────────────────────────
# Install workspace deps and bundle the worker (+ its prod deps) into a single
# JS file with esbuild. Nothing from this stage ships except that bundle, so
# tsx/typescript/discord.js and the rest of node_modules stay out of runtime.
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/worker/package.json packages/worker/package.json
RUN npm install

COPY . .

# Bundle to ESM, targeting the runtime node. The createRequire banner lets any
# CommonJS-only transitive dep (AWS SDK internals) resolve require() under ESM.
RUN npx --yes esbuild@0.28.1 packages/worker/src/index.ts \
    --bundle --platform=node --format=esm --target=node22 \
    --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" \
    --outfile=dist/worker.mjs \
    && node --check dist/worker.mjs

# ── Runtime ───────────────────────────────────────────────────────────────
FROM node:22-slim

# OS deps: git (clone), ca-certificates (TLS), ripgrep (search),
# gh (so the agent can read GitHub issues/PRs itself via GH_TOKEN), curl/gnupg (gh apt repo).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally and verify the `claude` binary is on PATH.
RUN npm install -g @anthropic-ai/claude-code@2.1.190 \
    && claude --version

WORKDIR /app

# The whole worker is a single bundled file — no node_modules at runtime.
COPY --from=builder /app/dist/worker.mjs ./worker.mjs

# Run as the unprivileged `node` user: Claude Code refuses
# --dangerously-skip-permissions as root. The `node` user (uid 1000) ships with
# the base image. Own /app and the config dir so node + claude can write.
ENV HOME=/home/node \
    CLAUDE_CONFIG_DIR=/home/node/.claude
RUN mkdir -p /home/node/.claude && chown -R node:node /app /home/node

# Bedrock auth (model/region come from the ECS task definition at runtime).
# No ANTHROPIC_API_KEY: auth is via the Bedrock IAM task role.
ENV CLAUDE_CODE_USE_BEDROCK=1 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    API_TIMEOUT_MS=600000 \
    BASH_DEFAULT_TIMEOUT_MS=120000

USER node

CMD ["node", "worker.mjs"]
