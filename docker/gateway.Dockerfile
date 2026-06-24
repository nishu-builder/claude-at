FROM node:22-slim

WORKDIR /app

# Copy manifests first for dependency-layer caching. The lockfile is optional
# (none committed yet); the glob keeps the build working whether or not it exists.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/worker/package.json packages/worker/package.json

# Full install (NOT --production): we run via tsx, which is a devDependency.
RUN npm install

# Copy the rest of the repo (app source, tsconfigs, etc.)
COPY . .

CMD ["npx", "tsx", "packages/gateway/src/index.ts"]
