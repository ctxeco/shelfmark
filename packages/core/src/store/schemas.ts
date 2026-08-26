// SPDX-License-Identifier: Apache-2.0
// The connector-private collections, as TypeScript document shapes.
//
// Seven collections, all owned by this library and nothing else: connections,
// the append-only consent event stream (shape defined by consent/store.ts),
// map runs, the per-page candidates spool, the one-per-run suggestions
// ledger, the customer's decided selections, and the selective-ingest run
// records. There is deliberately NO shared-with-host `documents` collection
// here: connector territory ends when bytes cross `DocumentSink.accept()`
// (see ports.ts), and what the host stores about a document afterwards is the
// host's schema, not this one.
//
// Vocabulary note (the one deliberate rename from the source shapes): the
// source platform's `paused_budget` status and `pausedBudget` counters —
// "the ingest pipeline's budget is exhausted, park the file" — generalize in
// this library to `deferred`: the sink declined the file FOR NOW (quota,
// budget, backpressure — the sink's reasons are its own), the run records it,
// and a later pass re-submits it. Same lane, sink-neutral name.

import type { EncryptedToken } from '../tokenCrypto.js';

// ── Collection names ────────────────────────────────────────────────────────
// `connector_consents` is named by consent/store.ts (CONSENT_COLLECTION) —
// the consent module owns that collection's name and shape; the store client
// simply gives it a typed accessor alongside the rest.

export const CONNECTIONS_COLLECTION = 'connector_connections';
export const MAP_RUNS_COLLECTION = 'map_runs';
/** 34-S11b — the per-page candidates SPOOL. Rows live here, never in
 *  workflow state (an enterprise drive's candidate list would blow the
 *  continueAsNew payload cap), and never outlive their run: consumed and
 *  deleted by the suggestions write on 'complete', swept by the run's
 *  finalize on every terminal status. */
export const MAP_CANDIDATES_COLLECTION = 'map_candidates';
/** 34-S11b — one suggestions document per completed map run: the funnel
 *  table (every subtraction named and counted), the JRN-D1 sensitive-shape
 *  COUNTS, the default selection, and the per-item verdict ledger. */
export const MAP_SUGGESTIONS_COLLECTION = 'map_suggestions';
/** Written by the API layer when the customer confirms their selection: one
 *  doc per decided selection. */
export const MAP_SELECTIONS_COLLECTION = 'map_selections';
export const SELECTIVE_INGEST_RUNS_COLLECTION = 'selective_ingest_runs';

// ── connector_connections ───────────────────────────────────────────────────

/** The reason a stored delta token was abandoned, recorded on the connection
 *  document BEFORE the re-enumeration runs — so even a crash mid-fallback
 *  leaves the reason for the re-crawl visible (34-S14c). */
export interface DeltaExpiryRecord {
  at: Date;
  action: 'full_reenumeration';
  detail: string;
}

/** One connected drive. Created by the API layer's OAuth callback; read and
 *  updated by the workflows. */
export interface ConnectorConnectionDoc {
  connectionId: string;
  tenantId: string;
  /** 'onedrive' | 'sharepoint' in this library; the provider seam is
   *  documented and other providers plug in as host code. */
  provider: string;
  /** Resolved lazily on first browse (a SharePoint site must be named by the
   *  admin before its drive is known) — null until then. */
  driveId: string | null;
  /** Chosen subtree root, or null for the whole drive. */
  rootFolderId: string | null;
  /** Default sensitivity label for ingested documents — an opaque id from
   *  the host's LabelPolicy vocabulary (ports.ts), null until chosen. The
   *  label question is deliberately NOT asked at connect or map time: it is
   *  a statement about file contents, and nothing has been read yet. */
  defaultLabel: string | null;
  /** Graph delta token from the last completed sync; null before the first. */
  deltaLink: string | null;
  /** The OAuth refresh token, envelope-encrypted (tokenCrypto.ts).
   *  Nulled on disconnect — a disconnected connection keeps its history but
   *  can no longer mint access tokens (browse answers connection_disconnected). */
  encRefreshToken: EncryptedToken | null;
  /** Lifecycle status maintained by the API layer and the sync finalize
   *  ('connected' | 'error' | host-defined transitional states). */
  status?: string;
  lastSyncStatus?: 'complete' | 'failed';
  lastSyncAt?: Date;
  lastSyncStartedAt?: Date;
  /** Human-readable root path shown in listings ('/Finance/2026'). */
  rootPath?: string | null;
  /** The sub of the human who connected it — audit, not authorization. */
  createdBy?: string;
  createdAt?: Date;
  /** The polled sync progress (workflows' SyncProgressRecord — kept loose
   *  here because the wire shape is additive-only and owned there). */
  lastSyncProgress?: unknown;
  /** Recorded on EVERY sync finalize, zero included — "this sync did not
   *  re-enumerate" is a fact a completion screen needs as much as the
   *  opposite (34-S14c). */
  lastSyncDeltaExpiredFallbacks?: number;
  lastDeltaExpiry?: DeltaExpiryRecord;
  deltaExpiryCount?: number;
  /** 34-S14f — the selective-ingest progress mirror. The run document is
   *  canonical; this copy exists because the connections listing is the one
   *  document a polling UI already receives, and a denominator written only
   *  where no route serves it is not progress anybody can watch. */
  lastIngestProgress?: unknown;
}

// ── map_runs ────────────────────────────────────────────────────────────────

export type MapRunStatus =
  | 'mapping'
  | 'complete'
  | 'failed'
  | 'refused_no_consent'
  /** JRN-8 — the mapped root falls outside the consented target. The run
   *  document is the evidence: the map refused rather than walked. */
  | 'refused_out_of_scope'
  | 'unsupported_provider';

/** The grant's scope as carried into the run document (JRN-8): WHICH subtree
 *  the human consented to. Path fields are in the walk's own path space —
 *  '/'-rooted at the mapped folder. */
export interface ConsentScopeTargetRecord {
  folderId: string | null;
  folderPath: string | null;
}

export interface MapRunDoc {
  tenantId: string;
  runId: string;
  connectionId: string;
  /** Set on refusal paths too, where the start activity never ran and
   *  nothing else would record which provider was refused — a consent audit
   *  should not need a join to connector_connections to answer that. */
  provider?: string;
  status: MapRunStatus;
  /** Evidence: WHICH grant authorized the run. */
  consentId: string | null;
  consentDisclosureSha256: string | null;
  /** JRN-8 — the grant's target and exclusions, pinned on the run so the
   *  ledger can show what scope the walk was bounded by. */
  consentTarget?: ConsentScopeTargetRecord | null;
  consentExclusions?: string[];
  /** required_run_outputs: which rule-artifact bytes classified this run. */
  classifierVersion?: string;
  artifactSha?: string;
  startedAt?: Date;
  finishedAt?: Date | null;
  // ── The flushed snapshot (workflows' MapRunSnapshot — accumulators with
  // their own truncation records; every bounded thing says when it bit). ────
  progress?: unknown;
  aggregates?: unknown;
  topFolders?: unknown;
  rollupTruncated?: boolean;
  topFoldersOmitted?: number;
  pruneManifest?: unknown;
  pruneManifestTruncated?: boolean;
  pruneManifestOmitted?: number;
  reconciliation?: unknown;
  narration?: unknown;
  narrationDropped?: number;
}

// ── map_candidates (the spool) ──────────────────────────────────────────────

/** One spooled candidate row. `itemId` is deliberately carried beyond the
 *  task-minimum field set: it is the remote identity selective ingest needs
 *  to fetch the file later, and without it the suggestions ledger could name
 *  a file it cannot act on (34-S14a). Upserts are keyed on
 *  (tenantId, runId, path) — see ensureStoreIndexes. */
export interface MapCandidateDoc {
  tenantId: string;
  runId: string;
  connectionId: string;
  itemId: string;
  path: string;
  name: string;
  size: number;
  modified: string;
  classRule: string;
}

// ── map_suggestions ─────────────────────────────────────────────────────────

/** One verdict-ledger row. `verdict` carries the evaluator's full grammar
 *  (selected | subtracted:<rule_id> | subtracted:propagated_from:<rule_id> |
 *  not_candidate:<class>); `subtractedBy` is the bare source rule id, present
 *  only on subtracted rows; `reportedShapes` (sorted shape ids) is present
 *  only when non-empty — REPORTED, never acted on (JRN-D1). `rank` is
 *  deliberately ABSENT: see the `ranking` field on the document. */
export interface MapSuggestionRow {
  itemId: string;
  path: string;
  name: string;
  size: number;
  modified: string;
  verdict: string;
  subtractedBy?: string;
  reportedShapes?: string[];
}

export interface FunnelRollupRecord {
  files: number;
  bytes: number;
}

export interface MapSuggestionsDoc {
  tenantId: string;
  runId: string;
  connectionId: string;
  funnelPolicyVersion: string;
  funnelPolicySha256: string;
  classifierVersion: string;
  classifierSha256: string;
  candidates: FunnelRollupRecord;
  /** Every subtraction named and counted — including the propagation row and
   *  the fingerprint collapse — in the pinned precedence order. */
  funnelTable: unknown[];
  defaultSelection: FunnelRollupRecord;
  /** JRN-D1: COUNTS over candidates and over the default selection, zeros
   *  included. Never a gate, never subtracted. */
  sensitiveReport: Record<string, { candidates: number; defaultSelection: number }>;
  /** HONEST ABSENCE OF RANK — rank is omitted rather than invented; rows are
   *  in path codepoint order, which is not a quality ranking and does not
   *  pretend to be. */
  ranking: { ranked: false; reason: string };
  rows: MapSuggestionRow[];
  rowsTruncated: boolean;
  rowsOmitted: number;
  rowCap: number;
  createdAt?: Date;
  writtenAt?: Date;
}

// ── map_selections ──────────────────────────────────────────────────────────

/** The customer's decision, as the API layer records it: the suggestions'
 *  default selection MINUS removedPaths PLUS readdedPaths. */
export interface MapSelectionDoc {
  runId: string;
  tenantId: string;
  connectionId: string;
  removedPaths: string[];
  readdedPaths: string[];
  decidedAt: string | Date;
}

// ── selective_ingest_runs ───────────────────────────────────────────────────

export type SelectiveIngestRunStatus =
  | 'ingesting'
  | 'complete'
  | 'failed'
  | 'refused_no_consent'
  | 'unsupported_provider';

export interface SelectiveIngestFailureRecord {
  path: string;
  name: string;
  /** The named reason — a download that 404s remotely, a sink refusal, a
   *  re-added path with no ledger row. Never a bare count. */
  error: string;
}

/** One folder's live rollup: the denominator from the plan, plus what has
 *  actually happened in it so far (34-S14f). */
export interface SelectiveIngestFolderProgressRecord {
  path: string;
  selected: number;
  ingested: number;
  skipped: number;
  failed: number;
  /** Deferred by the sink — declined for now, owned by a later pass. */
  deferred: number;
}

export interface SelectiveIngestRunDoc {
  tenantId: string;
  runId: string;
  connectionId: string;
  provider?: string;
  status: SelectiveIngestRunStatus;
  consentId?: string | null;
  consentDisclosureSha256?: string | null;
  mapRunId?: string | null;
  decidedAt?: string | null;
  selectedFiles?: number;
  selectedBytes?: number;
  funnelPolicyVersion?: string | null;
  funnelPolicySha256?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
  // ── The flushed snapshot (workflows' SelectiveIngestSnapshot). ────────────
  selected?: number;
  ingested?: number;
  failed?: number;
  skipped?: number;
  /** Deferred by the sink (was `pausedBudget` in the source shapes) — not a
   *  failure, and not a decision this library took about the file. */
  deferred?: number;
  done?: number;
  batchesDone?: number;
  currentPath?: string | null;
  skippedByReason?: Record<string, number>;
  failures?: SelectiveIngestFailureRecord[];
  failuresTruncated?: boolean;
  failuresOmitted?: number;
  unresolvedReaddsOmitted?: number;
  folders?: SelectiveIngestFolderProgressRecord[];
  foldersTruncated?: boolean;
  foldersOmitted?: number;
}
