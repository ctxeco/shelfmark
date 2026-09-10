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
# Run as the base image's unprivileged `node` user (uid 1000). The process's
# only filesystem write is FsDocumentSink under DEMO_DATA_DIR, so the default
# location is created for that user here. On the compose path demo/data is a
# bind mount the temporal service (also uid 1000) already writes into, so
# this adds no new requirement on the host directory.
RUN mkdir -p /app/demo/data && chown node:node /app/demo/data
USER node
# Overridden per compose service: server (default) or worker.
CMD ["node", "dist/server.js"]
