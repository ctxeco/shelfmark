// SPDX-License-Identifier: Apache-2.0
// 34-S14a — activities for selectiveIngestWorkflow: the customer-decided
// ingest of a mapped drive's selection.
//
// ══ WHAT THIS MODULE NEVER DOES ═════════════════════════════════════════════
//
// Download a file or hand bytes to the sink. The actual byte-fetching
// pipeline is ingest.ts's batch activity, reached by the WORKFLOW through its
// own proxy — this module only answers three questions from the store, all
// tenant-scoped in the filter itself: is there an ACTIVE ingest_content
// consent (fail closed), what exactly did the customer decide
// (map_selections resolved against map_suggestions rows, bounded by the
// consent's scope — JRN-8), and what happened (the selective_ingest_runs
// record, never stuck at 'ingesting').
//
// ══ CONSENT, FAIL CLOSED ════════════════════════════════════════════════════
//
// Same derivation as the map's consent check — literally the same function,
// map.ts's deriveActiveConsentForScope, with the ingest scope. A
// map_metadata grant does NOT satisfy ingest_content: mapping names is not
// permission to open files, and the scope string is the whole difference.
//
// ══ THE SELECTION ALGEBRA (one home) ════════════════════════════════════════
//
// selected set = the suggestions' default selection (rows with verdict
// 'selected') MINUS removedPaths PLUS readdedPaths — resolved against the
// map_suggestions rows, applied in that order so a path both removed and
// re-added ends IN the set (the re-add is the later, deliberate act). A
// re-added path with no suggestions row cannot be fetched (no itemId) and is
// reported as a NAMED per-file failure, never silently dropped. A truncated
// suggestions ledger (rowsTruncated) REFUSES resolution outright: ingesting
// only the rows that fit the cap would be a silent subset of the customer's
// decision, which is worse than a named refusal.
//
// ══ JRN-8: THE CONSENT SCOPE BOUNDS THE RESOLUTION ══════════════════════════
//
// A resolved row whose path falls outside the consented target, or inside a
// recorded exclusion, is a TYPED refusal ('SelectionOutsideConsentScope') of
// the WHOLE resolution — never a silent filter. Silently dropping the
// out-of-scope rows would ingest a subset of the decision without saying so
// (the SuggestionRowsTruncated discipline); refusing names the conflict and
// sends the customer back to re-map or re-consent. The check runs inside
// resolveLatestSelection, so BOTH the plan and every batch page re-verify it
// — a consent re-granted narrower mid-ingest stops the next batch.
import { ApplicationFailure } from '@temporalio/activity';
import type { MapSelectionDoc, SelectiveIngestRunStatus } from '@shelfmark/core';
import { compareCodepoints } from '@shelfmark/policy';
import type { ShelfmarkWorkflowDeps } from '../deps';
import {
  SELECTION_OUT_OF_SCOPE_ERROR_TYPE,
  isConsentExcluded,
  isWithinConsentTarget,
} from '../workflows/consentScope';
import {
  deriveActiveConsentForScope,
  consentCheckOf,
  type ConsentEventDoc,
  type MapConsentCheck,
  type MapSuggestionRow,
} from './map';

/** The consent scope selective ingest requires — @shelfmark/core's
 *  ConsentScope 'ingest_content'. File contents leave the drive under this
 *  scope and no other. */
export const INGEST_CONSENT_SCOPE = 'ingest_content';

/** One resolvable selected file — everything the fetch needs. `remotePath`
 *  is the containing folder (the ledger's paths are full item paths). */
export interface SelectedIngestFile {
  itemId: string;
  name: string;
  path: string;
  remotePath: string;
  size: number;
}

export function parentPathOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/**
 * The selection algebra, pure and unit-testable without Mongo (the same
 * export-the-semantics reasoning as deriveActiveConsentForScope). Output is
 * sorted by path codepoints so batching is deterministic across retries and
 * continueAsNew hops.
 */
export function resolveSelectionRows(
  rows: MapSuggestionRow[],
  removedPaths: string[],
  readdedPaths: string[]
): { files: SelectedIngestFile[]; unresolvedReaddPaths: string[] } {
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const removed = new Set(removedPaths);
  const chosen = new Set<string>();
  for (const r of rows) {
    if (r.verdict === 'selected' && !removed.has(r.path)) chosen.add(r.path);
  }
  const unresolved = new Set<string>();
  for (const p of readdedPaths) {
    // A re-add targets any ledger row (a subtracted one, or a removed
    // default row — the re-add is the later act and wins).
    if (byPath.has(p)) chosen.add(p);
    else unresolved.add(p);
  }
  const files = [...chosen].sort(compareCodepoints).map((p) => {
    const r = byPath.get(p) as MapSuggestionRow;
    return {
      itemId: r.itemId,
      name: r.name,
      path: r.path,
      remotePath: parentPathOf(r.path),
      size: r.size,
    };
  });
  return { files, unresolvedReaddPaths: [...unresolved].sort(compareCodepoints) };
}

/** JRN-8, pure half: the first resolved path that falls outside the consent
 *  scope, or null when every row is inside it. Exported so the refusal
 *  semantics are testable without a store. */
export function firstOutOfScopePath(
  files: readonly SelectedIngestFile[],
  consent: MapConsentCheck
): { path: string; reason: 'outside_target' | 'consent_excluded' } | null {
  for (const f of files) {
    if (!isWithinConsentTarget(f.path, consent.target?.folderPath ?? null)) {
      return { path: f.path, reason: 'outside_target' };
    }
    if (isConsentExcluded(f.path, consent.exclusions)) {
      return { path: f.path, reason: 'consent_excluded' };
    }
  }
  return null;
}

interface ResolvedSelection {
  selection: MapSelectionDoc;
  files: SelectedIngestFile[];
  unresolvedReaddPaths: string[];
  funnelPolicyVersion: string | null;
  funnelPolicySha256: string | null;
}

function decidedAtIso(value: string | Date | undefined | null): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/**
 * 34-S14f — per-folder rollup entries itemized in the plan, workflow state
 * and the run document.
 *
 * NAMED and RECORDED: a selection spanning more folders than this keeps the
 * FIRST 200 in path-codepoint order (the order the ingest itself walks, so
 * the itemized folders are exactly the ones the customer watches first), and
 * `folderTotalsOmitted` counts the distinct folders that did not fit. Every
 * file in an omitted folder still counts in the run's top-level totals — the
 * cap bounds the ITEMIZATION, never the arithmetic.
 */
export const MAX_FOLDER_ROLLUP_ENTRIES = 200;

/** One folder's share of the approved selection — the DENOMINATOR a progress
 *  bar needs per folder, known up front because the map already resolved the
 *  whole selection. */
export interface SelectedFolderTotal {
  path: string;
  selected: number;
  selectedBytes: number;
}

/** Bound on the unresolved-re-add paths carried back into workflow state —
 *  named, and the overflow is counted (these are customer-typed paths,
 *  ordinarily a handful; the cap exists so a pathological doc cannot flood
 *  workflow state). */
export const MAX_UNRESOLVED_READDS_RECORDED = 200;

export interface SelectiveIngestPlan {
  mapRunId: string;
  /** Pinned so a selection re-decided mid-ingest is detected, not blended. */
  decidedAt: string;
  selectedFiles: number;
  selectedBytes: number;
  unresolvedReaddPaths: string[];
  unresolvedReaddsOmitted: number;
  funnelPolicyVersion: string | null;
  funnelPolicySha256: string | null;
  /** 34-S14f — the per-folder denominators, in path order, capped at
   *  MAX_FOLDER_ROLLUP_ENTRIES. */
  folderTotals: SelectedFolderTotal[];
  /** Distinct folders beyond the cap. Zero on any ordinary selection; nonzero
   *  is the cap saying so out loud. */
  folderTotalsOmitted: number;
}

/** The per-folder denominators of a resolved selection, in path-codepoint
 *  order (the order the files themselves are already sorted in, so folders
 *  come out grouped and deterministic). Pure — the same reasoning as
 *  resolveSelectionRows. */
export function folderTotalsOf(files: SelectedIngestFile[]): {
  folderTotals: SelectedFolderTotal[];
  folderTotalsOmitted: number;
} {
  const totals: SelectedFolderTotal[] = [];
  let omitted = 0;
  const seenOmitted = new Set<string>();
  for (const f of files) {
    const existing = totals.find((t) => t.path === f.remotePath);
    if (existing) {
      existing.selected++;
      existing.selectedBytes += f.size;
      continue;
    }
    if (totals.length >= MAX_FOLDER_ROLLUP_ENTRIES) {
      // Counted ONCE per distinct folder, so the omitted figure is a folder
      // count and not a file count wearing a folder's name.
      if (!seenOmitted.has(f.remotePath)) {
        seenOmitted.add(f.remotePath);
        omitted++;
      }
      continue;
    }
    totals.push({ path: f.remotePath, selected: 1, selectedBytes: f.size });
  }
  return { folderTotals: totals, folderTotalsOmitted: omitted };
}

export interface SelectedIngestBatch {
  files: SelectedIngestFile[];
  /** Cursor for the next call; null when this batch exhausts the selection. */
  nextAfterPath: string | null;
}

export interface SelectiveIngestFailure {
  path: string;
  name: string;
  /** The named reason — a download that 404s remotely, a sink refusal, a
   *  re-added path with no ledger row. Never a bare count. */
  error: string;
}

/** One folder's live rollup: the denominator from the plan, plus what has
 *  actually happened in it so far. */
export interface SelectiveIngestFolderProgress {
  path: string;
  selected: number;
  ingested: number;
  skipped: number;
  failed: number;
  /** Deferred by the sink — declined for now, owned by a later pass. */
  deferred: number;
}

/** The flush/finalize payload — the workflow's accumulators, verbatim, every
 *  bounded thing carrying its own truncation record (no silent caps). */
export interface SelectiveIngestSnapshot {
  provider?: string;
  mapRunId?: string | null;
  decidedAt?: string | null;
  funnelPolicySha256?: string | null;
  selected?: number;
  ingested?: number;
  failed?: number;
  skipped?: number;
  batchesDone?: number;
  failures?: SelectiveIngestFailure[];
  failuresTruncated?: boolean;
  failuresOmitted?: number;
  unresolvedReaddsOmitted?: number;
  // ── 34-S14f: the honest denominator and its rollup ────────────────────────
  /** Deferred by the sink (declined for now — quota, budget, backpressure).
   *  Not a failure, and not a decision this library took about the file. */
  deferred?: number;
  /** Terminal outcomes so far: ingested + skipped + failed + deferred.
   *  Written rather than left to the reader, because `selected` is the
   *  denominator and a percentage assembled from four fields by three
   *  different screens is three chances to assemble it differently. */
  done?: number;
  /** Full path of the last file this run touched — what "reading …" names. */
  currentPath?: string | null;
  /** Per-reason skip rollup over the closed vocabulary (34-S14d). */
  skippedByReason?: Record<string, number>;
  /** Per-folder rollup, capped at MAX_FOLDER_ROLLUP_ENTRIES. */
  folders?: SelectiveIngestFolderProgress[];
  foldersTruncated?: boolean;
  /** Distinct folders past the cap. Their files still count in the totals. */
  foldersOmitted?: number;
}

export interface SelectiveIngestStartInput {
  tenantId: string;
  runId: string;
  connectionId: string;
  provider: string;
  consentId: string | null;
  consentDisclosureSha256: string | null;
  mapRunId: string;
  decidedAt: string;
  selectedFiles: number;
  selectedBytes: number;
  funnelPolicyVersion: string | null;
  funnelPolicySha256: string | null;
}

// ── The activity factory ────────────────────────────────────────────────────

export function createSelectiveIngestActivities(deps: ShelfmarkWorkflowDeps) {
  const { collections } = deps.store;

  async function activeIngestConsent(
    tenantId: string,
    connectionId: string
  ): Promise<MapConsentCheck> {
    const events = (await collections
      .consents()
      .find({ tenantId, connectionId }, { projection: { _id: 0 } })
      .sort({ grantedAt: -1 })
      .toArray()) as unknown as ConsentEventDoc[];
    return consentCheckOf(deriveActiveConsentForScope(events, INGEST_CONSENT_SCOPE));
  }

  async function resolveLatestSelection(
    tenantId: string,
    connectionId: string
  ): Promise<ResolvedSelection> {
    // JRN-8 — the consent scope is read HERE, on every resolution (the plan
    // AND every batch page), not only at the workflow's up-front check: a
    // consent revoked or re-granted narrower mid-ingest stops the very next
    // resolution, fail closed.
    const consent = await activeIngestConsent(tenantId, connectionId);
    if (!consent.active) {
      throw ApplicationFailure.create({
        nonRetryable: true,
        type: 'NoActiveIngestConsent',
        message:
          `selective ingest: no active ingest_content consent for connection ${connectionId} ` +
          'at resolution time — the selection cannot be resolved against a consent that is not there',
      });
    }
    const selection = (await collections
      .mapSelections()
      .find({ tenantId, connectionId }, { projection: { _id: 0 } })
      .sort({ decidedAt: -1 })
      .limit(1)
      .toArray()) as unknown as MapSelectionDoc[];
    if (selection.length === 0) {
      throw ApplicationFailure.create({
        nonRetryable: true,
        type: 'NoSelectionOnRecord',
        message:
          `selective ingest: no map_selections decision exists for connection ${connectionId} — ` +
          'the customer has not confirmed a selection, and this workflow ingests only ' +
          'decided selections, never guesses',
      });
    }
    const sel = selection[0]!;
    const suggestions = await collections
      .mapSuggestions()
      .findOne({ tenantId, runId: sel.runId }, { projection: { _id: 0 } });
    if (!suggestions) {
      throw ApplicationFailure.create({
        nonRetryable: true,
        type: 'MapSuggestionsMissing',
        message:
          `selective ingest: map_selections names run ${sel.runId} but no map_suggestions document ` +
          'exists for it — the selection cannot be resolved against a ledger that is not there',
      });
    }
    if (suggestions.rowsTruncated === true) {
      throw ApplicationFailure.create({
        nonRetryable: true,
        type: 'SuggestionRowsTruncated',
        message:
          `selective ingest: the suggestions ledger for run ${sel.runId} was truncated at its named ` +
          `cap (${suggestions.rowCap} rows kept, ${suggestions.rowsOmitted} omitted) — resolving a ` +
          'selection against a partial ledger would silently ingest a subset of the decision. ' +
          'Refusing; enterprise-scale ledger resolution is future work, on record.',
      });
    }
    const { files, unresolvedReaddPaths } = resolveSelectionRows(
      (suggestions.rows ?? []) as MapSuggestionRow[],
      sel.removedPaths ?? [],
      sel.readdedPaths ?? []
    );
    // JRN-8 — the typed refusal. One out-of-scope row voids the resolution.
    const outOfScope = firstOutOfScopePath(files, consent);
    if (outOfScope) {
      throw ApplicationFailure.create({
        nonRetryable: true,
        type: SELECTION_OUT_OF_SCOPE_ERROR_TYPE,
        message:
          `selective ingest: resolved selection row ${outOfScope.path} is ` +
          (outOfScope.reason === 'outside_target'
            ? `outside the consented target ${consent.target?.folderPath ?? '(whole drive)'}`
            : 'inside a recorded consent exclusion') +
          ' — ingesting it would exceed what the customer consented to. Refusing the whole ' +
          'resolution rather than silently ingesting a subset; re-map under the current consent ' +
          'or record a new consent for this scope.',
      });
    }
    return {
      selection: sel,
      files,
      unresolvedReaddPaths,
      funnelPolicyVersion: suggestions.funnelPolicyVersion ?? null,
      funnelPolicySha256: suggestions.funnelPolicySha256 ?? null,
    };
  }

  return {
    /**
     * Is there an ACTIVE ingest_content consent for this connection? Fail
     * closed: a store error propagates (the workflow fails and finalizes
     * 'failed'), an empty stream is active:false (the workflow refuses), and
     * the query is tenant-scoped in the filter itself.
     */
    async verifySelectiveIngestConsent(
      tenantId: string,
      connectionId: string
    ): Promise<MapConsentCheck> {
      return activeIngestConsent(tenantId, connectionId);
    },

    /**
     * Resolves the customer's latest decided selection into a PLAN — counts
     * and provenance only, never the file list itself (an enterprise
     * selection in a workflow's state or history is the cap this whole
     * design exists to avoid; the workflow pages through
     * listSelectedIngestBatch instead).
     */
    async resolveSelectiveIngestPlan(
      tenantId: string,
      connectionId: string
    ): Promise<SelectiveIngestPlan> {
      const r = await resolveLatestSelection(tenantId, connectionId);
      const kept = r.unresolvedReaddPaths.slice(0, MAX_UNRESOLVED_READDS_RECORDED);
      const { folderTotals, folderTotalsOmitted } = folderTotalsOf(r.files);
      return {
        mapRunId: r.selection.runId,
        decidedAt: decidedAtIso(r.selection.decidedAt),
        selectedFiles: r.files.length,
        selectedBytes: r.files.reduce((a, f) => a + f.size, 0),
        unresolvedReaddPaths: kept,
        unresolvedReaddsOmitted: r.unresolvedReaddPaths.length - kept.length,
        funnelPolicyVersion: r.funnelPolicyVersion,
        funnelPolicySha256: r.funnelPolicySha256,
        folderTotals,
        folderTotalsOmitted,
      };
    },

    /**
     * One page of the resolved selection, in path order, strictly after
     * `afterPath`. Stateless and deterministic: every call re-derives the
     * same sorted resolution from the same two documents, so a Temporal retry
     * or a continueAsNew hop re-reads its page instead of trusting carried
     * state. If the selection was RE-DECIDED since the plan was made
     * (decidedAt or runId moved), this refuses terminally — an ingest half
     * under one decision and half under another is not an ingest of either,
     * the same discipline as the map's mid-run artifact pin.
     */
    async listSelectedIngestBatch(
      tenantId: string,
      connectionId: string,
      mapRunId: string,
      decidedAt: string,
      afterPath: string | null,
      limit: number
    ): Promise<SelectedIngestBatch> {
      const r = await resolveLatestSelection(tenantId, connectionId);
      if (r.selection.runId !== mapRunId || decidedAtIso(r.selection.decidedAt) !== decidedAt) {
        throw ApplicationFailure.create({
          nonRetryable: true,
          type: 'SelectionChangedMidRun',
          message:
            `selective ingest: the decided selection moved mid-run (planned run ${mapRunId} @ ` +
            `${decidedAt}, now ${r.selection.runId} @ ${decidedAtIso(r.selection.decidedAt)}) — ` +
            'an ingest spanning two decisions is void; start a fresh ingest for the new decision',
        });
      }
      const start =
        afterPath === null ? 0 : r.files.findIndex((f) => compareCodepoints(f.path, afterPath) > 0);
      const from = start === -1 ? r.files.length : start;
      const files = r.files.slice(from, from + limit);
      const more = from + files.length < r.files.length;
      return {
        files,
        nextAfterPath: more && files.length > 0 ? files[files.length - 1]!.path : null,
      };
    },

    /** Creates (or, on a crash-retry, reasserts) the run document at
     *  'ingesting', stamped with WHICH consent authorized it and WHICH
     *  decided selection it executes. */
    async startSelectiveIngestRun(input: SelectiveIngestStartInput): Promise<void> {
      await collections.selectiveIngestRuns().updateOne(
        { runId: input.runId, tenantId: input.tenantId },
        {
          $setOnInsert: { startedAt: new Date() },
          $set: {
            tenantId: input.tenantId,
            runId: input.runId,
            connectionId: input.connectionId,
            provider: input.provider,
            status: 'ingesting' satisfies SelectiveIngestRunStatus,
            consentId: input.consentId,
            consentDisclosureSha256: input.consentDisclosureSha256,
            mapRunId: input.mapRunId,
            decidedAt: input.decidedAt,
            selectedFiles: input.selectedFiles,
            selectedBytes: input.selectedBytes,
            funnelPolicyVersion: input.funnelPolicyVersion,
            funnelPolicySha256: input.funnelPolicySha256,
            finishedAt: null,
          },
        },
        { upsert: true }
      );
    },

    /** Unconditional per-batch flush — the sync path's precedent: the
     *  polling UI must see the run move.
     *
     *  `connectionId` is OPTIONAL and appended (additive-only wire shape).
     *  When present, the snapshot is ALSO mirrored onto the connection
     *  document — see mirrorIngestProgress for why a canonical record
     *  nothing can read is not a record the customer has. */
    async updateSelectiveIngestRun(
      tenantId: string,
      runId: string,
      snapshot: SelectiveIngestSnapshot,
      connectionId?: string
    ): Promise<void> {
      await collections
        .selectiveIngestRuns()
        .updateOne({ runId, tenantId }, { $set: { ...snapshot } });
      if (connectionId) {
        await mirrorIngestProgress(deps, tenantId, connectionId, runId, 'ingesting', snapshot);
      }
    },

    /**
     * Terminal write, upserting so the refusal paths (no consent,
     * unsupported provider) leave a run document as evidence even though
     * startSelectiveIngestRun never ran for them. Same must-not-strand
     * guarantee as every finalize in this package: whatever happened, the
     * run leaves 'ingesting'.
     */
    async finalizeSelectiveIngestRun(
      tenantId: string,
      runId: string,
      connectionId: string,
      status: Exclude<SelectiveIngestRunStatus, 'ingesting'>,
      snapshot: SelectiveIngestSnapshot
    ): Promise<void> {
      await collections.selectiveIngestRuns().updateOne(
        { runId, tenantId },
        {
          $setOnInsert: { startedAt: new Date() },
          $set: {
            tenantId,
            runId,
            connectionId,
            status,
            finishedAt: new Date(),
            ...snapshot,
          },
        },
        { upsert: true }
      );
      // 34-S14f — the terminal state reaches the connection document too, so
      // a polling screen learns the run ENDED from the same field it watched
      // it run in, rather than waiting forever on a record that stopped
      // changing.
      await mirrorIngestProgress(deps, tenantId, connectionId, runId, status, snapshot);
    },
  };
}

/**
 * 34-S14f — the same progress, mirrored onto `connector_connections` as
 * `lastIngestProgress`.
 *
 * WHY A MIRROR AND NOT JUST THE RUN DOCUMENT: `selective_ingest_runs` is the
 * canonical record, but the connections listing is the one document a
 * polling UI already receives — exactly how the sync path's
 * `lastSyncProgress` reaches the screen. Writing the denominator only where
 * no route serves it would ship a progress record that is not progress
 * anybody can watch — the same "declared but unreachable" defect 34-S14d
 * fixed for `skipped`.
 *
 * Best effort ON PURPOSE: the run document above is the truth. A failed
 * mirror must not fail (and retry, and eventually fail) an ingest that is
 * working — it degrades to the run record, which is where an operator looks
 * anyway.
 */
async function mirrorIngestProgress(
  deps: ShelfmarkWorkflowDeps,
  tenantId: string,
  connectionId: string,
  runId: string,
  status: SelectiveIngestRunStatus,
  snapshot: SelectiveIngestSnapshot
): Promise<void> {
  try {
    await deps.store.collections.connections().updateOne(
      // Tenant-scoped in the filter itself — tenant isolation is absolute.
      { connectionId, tenantId },
      {
        $set: {
          lastIngestProgress: {
            runId,
            status,
            selected: snapshot.selected ?? 0,
            done: snapshot.done ?? 0,
            ingested: snapshot.ingested ?? 0,
            skipped: snapshot.skipped ?? 0,
            failed: snapshot.failed ?? 0,
            deferred: snapshot.deferred ?? 0,
            skippedByReason: snapshot.skippedByReason ?? {},
            currentPath: snapshot.currentPath ?? null,
            folders: snapshot.folders ?? [],
            foldersTruncated: snapshot.foldersTruncated ?? false,
            foldersOmitted: snapshot.foldersOmitted ?? 0,
            failuresTruncated: snapshot.failuresTruncated ?? false,
            failuresOmitted: snapshot.failuresOmitted ?? 0,
            updatedAt: new Date(),
          },
        },
      }
    );
  } catch (err) {
    console.warn(
      `selective ingest: could not mirror progress onto connection ${connectionId} ` +
        `(run ${runId}) — the run document remains authoritative: ${(err as Error).message}`
    );
  }
}

export type SelectiveIngestActivities = ReturnType<typeof createSelectiveIngestActivities>;
