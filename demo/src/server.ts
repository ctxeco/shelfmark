// SPDX-License-Identifier: Apache-2.0
//
// The demo API server: a Fastify 5 app that registers the whole @shelfmark
// HTTP surface with one plugin call, plus two demo-only endpoints (config
// for the web app, search over the FsDocumentSink corpus), plus static
// serving of the built web app when it exists.
//
// Runs alongside src/worker.ts (the Temporal worker) — `pnpm dev` starts
// both plus the Vite dev server, which proxies /api here.
import './env.js'; // FIRST import — see env.ts for why the order is load-bearing.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { MongoClient } from 'mongodb';
import { Client, Connection } from '@temporalio/client';
import shelfmarkApi from '@shelfmark/api';
import { ensureStoreIndexes } from '@shelfmark/core';
import { buildPorts, loadDemoConfig } from './config.js';
import { openSearchIndex } from './sinks/fsSink.js';

const API_PREFIX = '/api/v1/connectors';

async function main(): Promise<void> {
  const config = loadDemoConfig(); // fail fast, named errors, before any I/O
  const ports = buildPorts(config);

  const mongo = new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  const db = mongo.db(config.mongoDbName);
  await ensureStoreIndexes(db);

  const connection = await Connection.connect({ address: config.temporalAddress });
  const temporalClient = new Client({ connection });

  const app = Fastify({ logger: true });

  // The entire library surface — connections + OAuth, consents, browse,
  // map (+ SSE narration stream), selection, ingest — in one register.
  // The prefix rides into the OAuth redirect URI via fastify.prefix, so
  // the registered callback route and the URI handed to Entra cannot
  // drift: <PUBLIC_BASE_URL>/api/v1/connectors/microsoft/callback.
  await app.register(shelfmarkApi, {
    prefix: API_PREFIX,
    db,
    ports,
    temporal: { client: temporalClient, taskQueue: config.taskQueue },
    config: {
      publicBaseUrl: config.publicBaseUrl,
      stateSecret: config.stateSecret,
      returnPath: '/connections', // where the web app renders <Connections/>
    },
  });

  // ── Demo-only endpoints (NOT part of the library surface) ────────────────
  // The web app reads its label vocabulary + provider list here so the demo
  // is configured in exactly one place (the server's env).
  app.get('/api/v1/demo/config', async () => ({
    labels: config.labels,
    providers: ['onedrive', 'sharepoint'] as const,
  }));

  // Tiny search over the FsDocumentSink corpus. Reloads the persisted index
  // per query — cheap at demo scale, and always sees the worker's latest
  // write without any cross-process signaling.
  app.get<{ Querystring: { q?: string } }>('/api/v1/demo/search', async (request) => {
    const q = request.query.q?.trim() ?? '';
    if (q === '') return { query: q, results: [] };
    const index = await openSearchIndex(config.dataDir);
    if (!index) return { query: q, results: [] };
    const results = index.search(q, { prefix: true, fuzzy: 0.2 }).slice(0, 20).map((hit) => ({
      documentId: hit.id as string,
      score: hit.score,
      filename: hit.filename as string,
      remotePath: hit.remotePath as string,
      excerpt: hit.excerpt as string,
      label: hit.label as string,
      ingestedAt: hit.ingestedAt as string,
    }));
    return { query: q, results };
  });

  // ── Static web app (production mode) ─────────────────────────────────────
  // `pnpm build` writes the Vite bundle to demo/dist/web; when it exists we
  // serve it with an SPA fallback. In dev the Vite server owns the origin
  // and proxies /api here instead.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, '..', 'dist', 'web');
  if (existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      reply.sendFile('index.html'); // SPA routes (/connections, …)
    });
  }

  const close = async () => {
    await app.close();
    await connection.close();
    await mongo.close();
  };
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`shelfmark demo API on :${config.port} — UI ${existsSync(webDist) ? 'served from dist/web' : 'via Vite dev server'}`);
}

main().catch((err) => {
  console.error(`[shelfmark-demo server] ${(err as Error).name}: ${(err as Error).message}`);
  process.exit(1);
});
