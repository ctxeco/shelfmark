// SPDX-License-Identifier: Apache-2.0
// The dependency bag every activity factory receives. Dependency-injected —
// no module-level singletons — so an activity test is a plain function call
// against a mocked `deps` object, and a host wires exactly one of these into
// its worker (`createActivities(deps)` in index.ts).
import type { ShelfmarkPorts, ShelfmarkStore } from '@shelfmark/core';

export interface ShelfmarkWorkflowsConfig {
  /** Task queue the host serves these workflows on. Also the queue its
   *  start helpers must use — see DEFAULT_TASK_QUEUE. */
  taskQueue?: string;
}

export interface ShelfmarkWorkflowDeps {
  /** The connector-private Mongo store (@shelfmark/core `storeFromDb` /
   *  `createStoreClient`). */
  store: ShelfmarkStore;
  /** The five host seams (ports.ts). `sink` and `resolveAuth` are the two a
   *  host must supply; the rest default per the ports contract. */
  ports: ShelfmarkPorts;
  config?: ShelfmarkWorkflowsConfig;
}

/** The default task queue. One queue for all three workflow types — the
 *  worker registers the whole bundle, and the (type, queue) pairs are pinned
 *  by test/workflowRegistration.test.ts. */
export const DEFAULT_TASK_QUEUE = 'shelfmark-queue';

export function taskQueueFor(config?: ShelfmarkWorkflowsConfig): string {
  return config?.taskQueue ?? DEFAULT_TASK_QUEUE;
}

// ── The workflowId = runId convention ───────────────────────────────────────
// Each helper is doing TWO jobs and both sides must agree byte-for-byte: it
// is the Temporal idempotency pin the host starts the workflow under (a
// double-clicked "map it" is a duplicate-start rejection, not a second
// concurrent walk of the same remote drive), and it is the `runId` the
// workflow writes its run document under (the workflows use
// workflowInfo().workflowId as the runId), which the host's status routes
// look up. A route hand-rolling `map-${id}` would work until one side
// changed the prefix — so the prefix lives here, once.

export function driveMapWorkflowId(connectionId: string): string {
  return `map-${connectionId}`;
}

/** The `ingest-` namespace is per-CONNECTION here; a host that also pins
 *  per-document ids on the same queue must keep its own namespace disjoint. */
export function selectiveIngestWorkflowId(connectionId: string): string {
  return `ingest-${connectionId}`;
}

export function connectorSyncWorkflowId(connectionId: string): string {
  return `connector-sync-${connectionId}`;
}
