# SPDX-License-Identifier: Apache-2.0
#
# shelfmark demo image — API server AND Temporal worker (compose picks the
# entrypoint per service). Build context is the REPO ROOT (see
# docker-compose.yml) because the demo consumes the workspace packages.
#
# node:20-slim, NEVER alpine: @temporalio/core-bridge is a native (Rust)
# module linked against glibc; musl-based images fail at require time.
FROM node:20-slim

RUN corepack enable
WORKDIR /app

# Workspace manifests first (layer-cache the install), then sources.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY scripts ./scripts
COPY consent ./consent
COPY packages ./packages
COPY demo ./demo

RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV NODE_ENV=production
WORKDIR /app/demo
# Overridden per compose service: server (default) or worker.
CMD ["node", "dist/server.js"]
