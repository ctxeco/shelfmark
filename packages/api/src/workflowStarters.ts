// SPDX-License-Identifier: Apache-2.0
// Durable-workflow start helpers and the workflow-id conventions.
//
// Every start here pins its workflowId to the connection, so a double-clicked
// "sync now" / "map it" / "read these files" is a duplicate-start rejection,
// not a second concurrent walk of the same remote drive — and
// AlreadyStarted = success is the convention throughout: the pinned id is
// returned as if the start had happened, because the run the caller wanted is
// running.
//
// The id builders are exported because each is doing TWO jobs and both sides
// must agree byte-for-byte: it is the Temporal idempotency pin here, and it is
// the runId the workflow writes its run documents under (the workflow uses
// workflowInfo().workflowId as the runId), which the read/stream routes look
// up. A route hand-rolling `map-${id}` would work until one side changed the
// prefix.
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

/** Workflow type names — must match the exports in @shelfmark/workflows. */
export const CONNECTOR_SYNC_WORKFLOW = 'connectorSyncWorkflow';
export const DRIVE_MAP_WORKFLOW = 'driveMapWorkflow';
export const SELECTIVE_INGEST_WORKFLOW = 'selectiveIngestWorkflow';

/**
 * The slice of a Temporal Client these helpers need, stated structurally so
 * tests (and hosts wrapping their own client) can satisfy it without the
 * whole SDK surface. A real `Client` from @temporalio/client is assignable.
 */
export interface WorkflowStartClient {
  workflow: {
    start(
      workflowType: string,
      options: { taskQueue: string; workflowId: string; args: unknown[] }
    ): Promise<{ workflowId: string }>;
  };
}

export function connectorSyncWorkflowId(connectionId: string): string {
  return `connector-sync-${connectionId}`;
}

/**
 * The pinned workflowId for one connection's map — the Temporal idempotency
 * pin AND the `map_runs.runId` the workflow writes under; the GET /:id/map
 * and /:id/map/stream routes look it up by this exact string.
 */
export function driveMapWorkflowId(connectionId: string): string {
  return `map-${connectionId}`;
}

/**
 * The pinned workflowId for one connection's selective ingest — same
 * two-jobs contract as driveMapWorkflowId, against the selective-ingest run
 * records. Connection ids are minted `conn-<uuid>` at OAuth-callback time, so
 * the `ingest-` namespace cannot collide with any other id family a host
 * pins on the same queue unless that host also mints `conn-` ids.
 */
export function selectiveIngestWorkflowId(connectionId: string): string {
  return `ingest-${connectionId}`;
}

export interface WorkflowStarters {
  /**
   * Start (or no-op onto) the legacy all-or-nothing crawl/ingest for one
   * connection. One provider ships here; a host adding a provider adds its
   * own workflow type and its own starter beside this one rather than
   * widening this signature.
   */
  startConnectorSyncWorkflow(connectionId: string): Promise<string>;
  /** Start (or no-op onto) the metadata-only drive map for one connection. */
  startDriveMapWorkflow(connectionId: string): Promise<string>;
  /**
   * Start (or no-op onto) the selective ingest of the decided selection.
   *
   * `defaultLabel` is the step-13 label, passed to the workflow rather than
   * left for it to read off the connection. The ingest route $sets it AFTER
   * this start (so a 503 cannot relabel a connection that ingested nothing),
   * which would race the workflow's own read — a worker that picked the run
   * up first saw null and was refused egress, a failure mode observed live.
   */
  startSelectiveIngestWorkflow(
    connectionId: string,
    defaultLabel?: string | null
  ): Promise<string>;
}

export function createWorkflowStarters(
  client: WorkflowStartClient,
  taskQueue: string
): WorkflowStarters {
  async function start(workflowType: string, workflowId: string, args: unknown[]): Promise<string> {
    try {
      const handle = await client.workflow.start(workflowType, { taskQueue, workflowId, args });
      return handle.workflowId;
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        // AlreadyStarted = success: the run the caller wanted is running.
        return workflowId;
      }
      throw err;
    }
  }

  return Object.freeze({
    startConnectorSyncWorkflow: (connectionId: string) =>
      start(CONNECTOR_SYNC_WORKFLOW, connectorSyncWorkflowId(connectionId), [{ connectionId }]),
    startDriveMapWorkflow: (connectionId: string) =>
      // args shape is [{ connectionId }] — the workflow reads roots/tenant/
      // provider/encRefreshToken from the connection document itself, and
      // re-verifies the ACTIVE map_metadata consent worker-side (defense in
      // depth behind the edge refusal in the map route).
      start(DRIVE_MAP_WORKFLOW, driveMapWorkflowId(connectionId), [{ connectionId }]),
    startSelectiveIngestWorkflow: (connectionId: string, defaultLabel?: string | null) =>
      // [{ connectionId, defaultLabel }] ONLY — the workflow's input type may
      // carry continueAsNew plumbing fields, but those are its internals and
      // are never set from the edge. The workflow re-verifies the ACTIVE
      // ingest_content consent on EVERY execution including continueAsNew
      // hops, resolves the latest selection against the suggestions ledger,
      // and ingests exactly the resolved set.
      start(SELECTIVE_INGEST_WORKFLOW, selectiveIngestWorkflowId(connectionId), [
        { connectionId, defaultLabel },
      ]),
  });
}
