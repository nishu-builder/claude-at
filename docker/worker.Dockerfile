FROM node:22-slim

# OS deps: git (clone), ca-certificates (TLS), ripgrep (Claude Code search).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally and verify the `claude` binary is on PATH.
RUN npm install -g @anthropic-ai/claude-code@2.1.190 \
    && claude --version

WORKDIR /app

# Copy manifests first for dependency-layer caching. Lockfile optional (glob).
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/worker/package.json packages/worker/package.json

# Full install (NOT --production): we run via tsx, which is a devDependency.
RUN npm install

# Copy the rest of the repo (app source, tsconfigs, etc.)
COPY . .

# Run as the unprivileged `node` user: Claude Code refuses
# --dangerously-skip-permissions as root. The `node` user (uid 1000) ships with
# the base image. Own /app and the config dir so tsx + claude can write.
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

CMD ["npx", "tsx", "packages/worker/src/index.ts"]
