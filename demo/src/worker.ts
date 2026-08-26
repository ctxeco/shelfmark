// SPDX-License-Identifier: Apache-2.0
//
// The demo Temporal worker — the process that actually walks drives and
// ingests files. A host builds its worker from exactly two things
// (@shelfmark/workflows contract):
//
//   * createActivities(deps) — the dependency-injected activity registry
//     ({ store, ports, config }), and
//   * the workflow bundle entry: the package exposes its workflow SOURCE at
//     `@shelfmark/workflows/workflows-source` (→ src/workflows/index.ts,
//     shipped in the published files) precisely so a worker can hand it to
//     `workflowsPath` — @temporalio/worker bundles TypeScript workflow
//     source itself (webpack + swc). We resolve it through the export map
//     rather than hardcoding a path into the package's internals.
//
// Task queue: 'shelfmark-queue' — must match the server's plugin option
// (both read DemoConfig.taskQueue, which pins the same string as the
// package's DEFAULT_TASK_QUEUE).
import './env.js'; // FIRST import — see env.ts for why the order is load-bearing.
import { createRequire } from 'node:module';
import { MongoClient } from 'mongodb';
import { NativeConnection, Worker } from '@temporalio/worker';
import { ensureStoreIndexes, storeFromDb } from '@shelfmark/core';
import { createActivities } from '@shelfmark/workflows';
import { buildPorts, loadDemoConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadDemoConfig(); // fail fast, named errors
  const ports = buildPorts(config);

  const mongo = new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  const db = mongo.db(config.mongoDbName);
  await ensureStoreIndexes(db);
  const store = storeFromDb(db);

  const connection = await NativeConnection.connect({ address: config.temporalAddress });

  // Resolve the workflows-source export map entry to an absolute path.
  // createRequire honors package export maps from this module's location,
  // so the demo never reaches into @shelfmark/workflows' file layout.
  const workflowsPath = createRequire(import.meta.url).resolve(
    '@shelfmark/workflows/workflows-source'
  );

  const worker = await Worker.create({
    connection,
    taskQueue: config.taskQueue,
    workflowsPath,
    activities: createActivities({ store, ports, config: { taskQueue: config.taskQueue } }),
  });

  console.log(
    `[shelfmark-demo worker] polling '${config.taskQueue}' on ${config.temporalAddress} (sink: ${config.sinkKind})`
  );

  const shutdown = () => worker.shutdown();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await worker.run();
  } finally {
    await connection.close();
    await mongo.close();
  }
}

main().catch((err) => {
  console.error(`[shelfmark-demo worker] ${(err as Error).name}: ${(err as Error).message}`);
  process.exit(1);
});
