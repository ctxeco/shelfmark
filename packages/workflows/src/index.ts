// SPDX-License-Identifier: Apache-2.0
// @shelfmark/workflows — the Temporal layer, quarantined.
//
// A host builds its worker from exactly two things:
//   * `createActivities(deps)` below — the full dependency-injected activity
//     registry (no module-level singletons; an activity test is a function
//     call against a mocked `deps`), and
//   * the workflow bundle at `@shelfmark/workflows/workflows-source` (or the
//     built `./workflows` entry) as its `workflowsPath`.
//
// Everything else exported here is types, constants and the id helpers the
// host's START side needs — this entry never runs inside the workflow
// sandbox.
import { createConnectionActivities } from './activities/connection';
import { createEgressActivities } from './activities/egress';
import { createIngestActivities } from './activities/ingest';
import { createMapActivities } from './activities/map';
import { createSelectiveIngestActivities } from './activities/selectiveIngest';
import type { ShelfmarkWorkflowDeps } from './deps';

/** The one activity registry. Names are disjoint by construction (each
 *  factory prefixes its own domain), so the spread-merge cannot shadow. */
export function createActivities(deps: ShelfmarkWorkflowDeps) {
  return {
    ...createConnectionActivities(deps),
    ...createEgressActivities(deps),
    ...createMapActivities(deps),
    ...createSelectiveIngestActivities(deps),
    ...createIngestActivities(deps),
  };
}

export type ShelfmarkActivities = ReturnType<typeof createActivities>;

// ── Deps, config, task queue, id helpers ────────────────────────────────────
export {
  DEFAULT_TASK_QUEUE,
  taskQueueFor,
  driveMapWorkflowId,
  selectiveIngestWorkflowId,
  connectorSyncWorkflowId,
  type ShelfmarkWorkflowDeps,
  type ShelfmarkWorkflowsConfig,
} from './deps';

// ── Activity factories + their surfaces ─────────────────────────────────────
export {
  createConnectionActivities,
  getConnectionDoc,
  getGraphAccessTokenFor,
  type Connection,
  type ConnectionActivities,
  type SyncProgressRecord,
} from './activities/connection';
export {
  createEgressActivities,
  EGRESS_GATE_UNREACHABLE_ERROR_TYPE,
  CLOUD_EGRESS_DENIED_ERROR_TYPE,
  MAP_EGRESS_DENIED_ERROR_TYPE,
  type EgressActivities,
} from './activities/egress';
export {
  createMapActivities,
  deriveActiveConsentForScope,
  deriveActiveMapConsent,
  consentCheckOf,
  graphThrottleFailure,
  mapPathJoin,
  GRAPH_THROTTLED_ERROR_TYPE,
  MAP_CONSENT_SCOPE,
  MAX_SUGGESTION_ROWS,
  type ConsentEventDoc,
  type MapActivities,
  type MapConsentCheck,
  type MapFolderPageResult,
  type MapPageItem,
  type MapRunSnapshot,
  type MapRunStartInput,
  type MapSuggestionsSummary,
} from './activities/map';
export {
  createSelectiveIngestActivities,
  resolveSelectionRows,
  firstOutOfScopePath,
  folderTotalsOf,
  parentPathOf,
  INGEST_CONSENT_SCOPE,
  MAX_FOLDER_ROLLUP_ENTRIES,
  MAX_UNRESOLVED_READDS_RECORDED,
  type SelectedFolderTotal,
  type SelectedIngestBatch,
  type SelectedIngestFile,
  type SelectiveIngestActivities,
  type SelectiveIngestFailure,
  type SelectiveIngestFolderProgress,
  type SelectiveIngestPlan,
  type SelectiveIngestSnapshot,
  type SelectiveIngestStartInput,
} from './activities/selectiveIngest';
export {
  createIngestActivities,
  documentIdFor,
  guessMimetype,
  type FileToIngest,
  type IngestActivities,
  type IngestOutcome,
} from './activities/ingest';

// ── The consent-scope algebra (JRN-8) — shared by workflow and host code ────
export {
  CONSENT_EXCLUDED_RULE,
  MAP_OUT_OF_SCOPE_ERROR_TYPE,
  SELECTION_OUT_OF_SCOPE_ERROR_TYPE,
  isConsentExcluded,
  isWithinConsentTarget,
  mapRootWithinConsent,
  normalizeConsentPath,
  type ConsentScopeTarget,
} from './workflows/consentScope';

// ── Workflow input/state types + tunables (never the workflow functions —
// those live only in the bundle entry, ./workflows) ─────────────────────────
export {
  DEFAULT_MAP_PAGES_PER_RUN,
  MAX_TOP_FOLDER_ROLLUPS,
  MAX_PRUNE_MANIFEST_ENTRIES,
  NARRATION_MAX_LINES,
  ITEMS_NARRATION_STRIDE,
  appendNarration,
  fmtBytes,
  fmtInt,
  leadingClassByBytes,
  type ClassRollup,
  type DriveMapResumeState,
  type DriveMapWorkflowInput,
  type MapAggregates,
  type MapProgress,
  type MapReconciliation,
  type NarrationKind,
  type NarrationLine,
  type PruneEntry,
  type TopFolderRollup,
} from './workflows/driveMap';
export {
  DEFAULT_SELECTIVE_INGEST_BATCHES_PER_RUN,
  MAX_RECORDED_INGEST_FAILURES,
  SELECTIVE_INGEST_BATCH_SIZE,
  recordFailure,
  type SelectiveIngestProgress,
  type SelectiveIngestResumeState,
  type SelectiveIngestWorkflowInput,
} from './workflows/selectiveIngest';
export { type ConnectorSyncWorkflowInput } from './workflows/sync';
