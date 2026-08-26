// SPDX-License-Identifier: Apache-2.0
// 34-S14a — selectiveIngestWorkflow: ingest EXACTLY the selection the
// customer decided — the suggestions' default selection minus their removals
// plus their deliberate re-adds — nothing more, nothing less.
//
// Structure copies the sync workflow's shape (batched fan-in through the
// shared batch-ingest activity, continueAsNew-bounded, unconditional
// per-batch progress flush, finalize-on-failure discipline) and the map's
// consent posture (fail closed BEFORE any download, re-verified on EVERY
// continueAsNew hop — a consent revoked at minute 28 stops the ingest at the
// next hop, not at the end). JRN-8: the resolution itself is bounded by the
// consent's target and exclusions — an out-of-scope selection row is a typed
// refusal in the activities, never a silent subset.
//
// The selection itself NEVER enters workflow state or history: the plan
// activity returns counts, and each batch is paged out of the resolved
// selection by cursor (path order, deterministic). What a hop carries is the
// cursor and the counters — an enterprise selection costs this workflow the
// same state bytes as a ten-file one.
//
// Workflow type name MUST stay exactly `selectiveIngestWorkflow` — hosts
// start it by string on the pinned id from deps.ts
// (selectiveIngestWorkflowId), and test/workflowRegistration.test.ts pins
// the (type, queue) pair.
//
// PORT NOTE — patch markers: the source carried a `patched()` marker here
// (an unconditional new activity command is a non-determinism error against
// in-flight histories). A fresh OSS history has none to protect, so no
// markers exist in this file. The source also granted a first-ingest billing
// credit at this point in the flow; billing is host territory and crossed no
// port, so the call is simply absent — a host wanting an equivalent hook
// owns it in its sink or its start helper.
import {
  proxyActivities,
  continueAsNew,
  workflowInfo,
  ContinueAsNew,
  log,
} from '@temporalio/workflow';
import type { ConnectionActivities } from '../activities/connection';
import type { EgressActivities } from '../activities/egress';
import type { IngestActivities } from '../activities/ingest';
import type {
  SelectiveIngestActivities,
  SelectiveIngestFailure,
  SelectiveIngestFolderProgress,
} from '../activities/selectiveIngest';

const { getConnection } = proxyActivities<ConnectionActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

// The same egress gate the sync path crosses — no download phase runs
// without the host's cloud-egress answer for this tenant at this label.
const { checkCloudEgressAllowed } = proxyActivities<EgressActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

// Same long ceiling as the sync workflow gives this exact activity: bounded
// concurrent downloads + sink handoffs per call, but never an unbounded
// number of files in one invocation.
const { ingestFileBatch } = proxyActivities<IngestActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { initialInterval: '10s', backoffCoefficient: 2, maximumAttempts: 3 },
});

const {
  verifySelectiveIngestConsent,
  resolveSelectiveIngestPlan,
  listSelectedIngestBatch,
  startSelectiveIngestRun,
  updateSelectiveIngestRun,
  finalizeSelectiveIngestRun,
} = proxyActivities<SelectiveIngestActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

// ── Named bounds — every one recorded when it bites ─────────────────────────

/** Files handed to one ingestFileBatch call — the sync workflow's BATCH_SIZE
 *  precedent (the activity fans out ~15-wide internally, so a batch of 20 is
 *  one comfortable activity invocation). */
export const SELECTIVE_INGEST_BATCH_SIZE = 20;
/** continueAsNew threshold in BATCHES per execution: 25 × 20 = 500 files per
 *  hop, the same item budget the sync's threshold keeps. Configurable via
 *  input so tests exercise the resume path without 500 real files. */
export const DEFAULT_SELECTIVE_INGEST_BATCHES_PER_RUN = 25;
/** Per-file failures itemized in state and the run doc; beyond this,
 *  failuresTruncated:true and failuresOmitted counts the rest (the failed
 *  COUNT still counts every failure — only the itemization is bounded). */
export const MAX_RECORDED_INGEST_FAILURES = 200;

export interface SelectiveIngestProgress {
  /** THE DENOMINATOR (34-S14f): the count the customer approved — the map's
   *  default selection minus their removals plus their re-adds. The UI
   *  stopped needing to guess a percentage the moment this became real. */
  selected: number;
  ingested: number;
  failed: number;
  skipped: number;
  /** Deferred by the sink (declined for now — 34-S14e generalized). Its own
   *  counter because it is neither a failure nor a decision this library
   *  took about the file. */
  deferred: number;
  /** 34-S14d — per-reason skip rollup over the closed vocabulary. */
  skippedByReason: Record<string, number>;
  batchesDone: number;
}

/** Terminal outcomes so far, against `selected`. Written into the run record
 *  rather than left for each screen to re-derive from four fields. */
function doneCount(p: SelectiveIngestProgress): number {
  return p.ingested + p.skipped + p.failed + p.deferred;
}

/** Everything a continueAsNew hop carries. Internal only — external callers
 *  (the host's start helper) never set `resume`. Deliberately tiny: cursor +
 *  counters + the bounded failure itemization; never file lists. */
export interface SelectiveIngestResumeState {
  runId: string;
  mapRunId: string;
  decidedAt: string;
  funnelPolicySha256: string | null;
  afterPath: string | null;
  progress: SelectiveIngestProgress;
  failures: SelectiveIngestFailure[];
  failuresTruncated: boolean;
  failuresOmitted: number;
  unresolvedReaddsOmitted: number;
  /** 34-S14f — per-folder rollup, seeded with each folder's denominator from
   *  the plan and incremented as outcomes land. Bounded by the plan's own
   *  MAX_FOLDER_ROLLUP_ENTRIES; `foldersOmitted` counts the distinct folders
   *  past it, whose files still count in the totals above. */
  folders: SelectiveIngestFolderProgress[];
  foldersTruncated: boolean;
  foldersOmitted: number;
  /** Full path of the last file this run touched. */
  currentPath: string | null;
}

/** Adopts a resume state from a PREVIOUS release of this package: fields
 *  added later do not exist in a hop that continued as new under older code,
 *  and `undefined++` is NaN. An in-flight execution must still complete, and
 *  complete truthfully. */
function normalizeResume(resume: SelectiveIngestResumeState): SelectiveIngestResumeState {
  return {
    ...resume,
    progress: {
      ...resume.progress,
      deferred: resume.progress.deferred ?? 0,
      skippedByReason: resume.progress.skippedByReason ?? {},
    },
    folders: resume.folders ?? [],
    foldersTruncated: resume.foldersTruncated ?? false,
    foldersOmitted: resume.foldersOmitted ?? 0,
    currentPath: resume.currentPath ?? null,
  };
}

/** One outcome into the counters and the folder rollup — the ONE place the
 *  four-state vocabulary is folded, so 'deferred' can never be counted as a
 *  failure by an `else` branch nobody revisited. */
function countOutcome(
  state: SelectiveIngestResumeState,
  folderPath: string,
  status: 'ingested' | 'failed' | 'skipped' | 'deferred',
  skipReason?: string
): void {
  const p = state.progress;
  if (status === 'ingested') p.ingested++;
  else if (status === 'deferred') p.deferred++;
  else if (status === 'skipped') {
    p.skipped++;
    const key = skipReason ?? 'unnamed';
    p.skippedByReason[key] = (p.skippedByReason[key] ?? 0) + 1;
  } else p.failed++;

  const folder = state.folders.find((f) => f.path === folderPath);
  // A folder past the plan's itemization cap has no row here — its files are
  // still in the totals above, and `foldersOmitted` already said how many
  // folders that covers.
  if (!folder) return;
  if (status === 'ingested') folder.ingested++;
  else if (status === 'deferred') folder.deferred++;
  else if (status === 'skipped') folder.skipped++;
  else folder.failed++;
}

export interface SelectiveIngestWorkflowInput {
  connectionId: string;
  /**
   * The label the customer chose for this ingest — already resolved through
   * the host's LabelPolicy at the edge — passed IN rather than read off the
   * connection document.
   *
   * Why: the start route may persist a default label alongside starting this
   * workflow, and reading the document here would race that write: a worker
   * picking the run up before the write landed would read null and cross the
   * egress gate with the wrong question — the exact class of failure that
   * killed the first live map. Carrying the value in the input removes the
   * race entirely, and is the more honest model anyway — the label is a
   * property of THIS ingest decision, not a field the run happens to find
   * lying around.
   *
   * Optional so an execution started by an older release still resolves,
   * falling back to the connection document.
   */
  label?: string | null;
  /** Internal only — set by continueAsNew to resume mid-ingest. */
  resume?: SelectiveIngestResumeState;
  continueAsNewAfter?: number;
}

/** Bounded failure append: at the cap the DROP is counted, never silent. */
export function recordFailure(
  state: {
    failures: SelectiveIngestFailure[];
    failuresTruncated: boolean;
    failuresOmitted: number;
  },
  failure: SelectiveIngestFailure
): void {
  if (state.failures.length >= MAX_RECORDED_INGEST_FAILURES) {
    state.failuresTruncated = true;
    state.failuresOmitted++;
    return;
  }
  state.failures.push(failure);
}

function snapshotOf(state: SelectiveIngestResumeState) {
  return {
    mapRunId: state.mapRunId,
    decidedAt: state.decidedAt,
    funnelPolicySha256: state.funnelPolicySha256,
    ...state.progress,
    done: doneCount(state.progress),
    currentPath: state.currentPath,
    folders: state.folders,
    foldersTruncated: state.foldersTruncated,
    foldersOmitted: state.foldersOmitted,
    failures: state.failures,
    failuresTruncated: state.failuresTruncated,
    failuresOmitted: state.failuresOmitted,
    unresolvedReaddsOmitted: state.unresolvedReaddsOmitted,
  };
}

export async function selectiveIngestWorkflow(
  input: SelectiveIngestWorkflowInput
): Promise<string> {
  const { connectionId } = input;
  const batchesPerRun = input.continueAsNewAfter ?? DEFAULT_SELECTIVE_INGEST_BATCHES_PER_RUN;
  const runId = input.resume?.runId ?? workflowInfo().workflowId;

  const conn = await getConnection(connectionId);

  // ── CONSENT, FAIL CLOSED — before ANY download, on EVERY execution
  // including continueAsNew resumes. ingest_content is its own scope: the
  // map's metadata consent does not open files. ─────────────────────────────
  const consent = await verifySelectiveIngestConsent(conn.tenantId, connectionId);
  if (!consent.active) {
    await finalizeSelectiveIngestRun(conn.tenantId, runId, connectionId, 'refused_no_consent', {
      provider: conn.provider,
      ...(input.resume ? snapshotOf(normalizeResume(input.resume)) : {}),
    });
    return `[REFUSED_NO_CONSENT] Selective ingest ${connectionId}: no active ingest_content consent; nothing was downloaded.`;
  }

  // ── OneDrive/SharePoint first — the batch-ingest activity is Graph's;
  // another provider's selection needs that provider's equivalent behind the
  // documented seam, and pretending otherwise would be a silent gap. ────────
  if (conn.provider !== 'onedrive' && conn.provider !== 'sharepoint') {
    await finalizeSelectiveIngestRun(conn.tenantId, runId, connectionId, 'unsupported_provider', {
      provider: conn.provider,
    });
    return `[UNSUPPORTED_PROVIDER] Selective ingest ${connectionId}: provider ${conn.provider} is not supported yet (OneDrive/SharePoint first).`;
  }

  let state: SelectiveIngestResumeState | undefined = input.resume
    ? normalizeResume(input.resume)
    : undefined;

  // Same must-not-strand guarantee as every connector path: whatever fails
  // from here on — plan resolution included (NoSelectionOnRecord,
  // MapSuggestionsMissing, SuggestionRowsTruncated, SelectionChangedMidRun,
  // SelectionOutsideConsentScope are all NAMED, terminal refusals) — the run
  // document leaves 'ingesting', and a failure before the run doc exists
  // still upserts a 'failed' record as evidence.
  try {
    if (!state) {
      // The plan is counts + provenance, never the file list — the list is
      // paged below so no drive size can blow workflow state or history.
      const plan = await resolveSelectiveIngestPlan(conn.tenantId, connectionId);
      state = {
        runId,
        mapRunId: plan.mapRunId,
        decidedAt: plan.decidedAt,
        funnelPolicySha256: plan.funnelPolicySha256,
        afterPath: null,
        progress: {
          selected: plan.selectedFiles,
          ingested: 0,
          failed: 0,
          skipped: 0,
          deferred: 0,
          skippedByReason: {},
          batchesDone: 0,
        },
        failures: [],
        failuresTruncated: false,
        failuresOmitted: 0,
        unresolvedReaddsOmitted: plan.unresolvedReaddsOmitted,
        // 34-S14f — every folder starts at its own denominator, so a folder
        // row reads "0 of 34" from the first poll rather than materialising
        // its total as files trickle in.
        // `?? []` is not paranoia about our own activity: during a ROLLING
        // deploy a workflow task and an activity task can be served by
        // different processes, so a new workflow can legitimately receive a
        // plan built by an older release, which had no folderTotals. An
        // absent rollup means no per-folder rows for that run — never a
        // crash loop on the ingest the customer is watching.
        folders: (plan.folderTotals ?? []).map((t) => ({
          path: t.path,
          selected: t.selected,
          ingested: 0,
          skipped: 0,
          failed: 0,
          deferred: 0,
        })),
        foldersTruncated: (plan.folderTotalsOmitted ?? 0) > 0,
        foldersOmitted: plan.folderTotalsOmitted ?? 0,
        currentPath: null,
      };
      // A re-added path with no ledger row cannot be fetched (no remote id):
      // a NAMED per-file failure each, up front, never a silent drop.
      for (const path of plan.unresolvedReaddPaths) {
        state.progress.failed++;
        recordFailure(state, {
          path,
          name: path.slice(path.lastIndexOf('/') + 1),
          error: 'readded path has no map_suggestions row — nothing to resolve it against',
        });
      }
      await startSelectiveIngestRun({
        tenantId: conn.tenantId,
        runId,
        connectionId,
        provider: conn.provider,
        consentId: consent.consentId,
        consentDisclosureSha256: consent.disclosureSha256,
        mapRunId: plan.mapRunId,
        decidedAt: plan.decidedAt,
        selectedFiles: plan.selectedFiles,
        selectedBytes: plan.selectedBytes,
        funnelPolicyVersion: plan.funnelPolicyVersion,
        funnelPolicySha256: plan.funnelPolicySha256,
      });
    }

    // Cloud egress is gated per tenant at this label — inside the try so a
    // denial finalizes 'failed' honestly. The input's label if we were given
    // one, the connection's stored default otherwise (an execution from an
    // older release), the ports contract's default label failing that.
    // Never null-by-race — see the input field's comment.
    const ingestLabel = input.label ?? conn.defaultLabel ?? 'default';
    await checkCloudEgressAllowed(conn.tenantId, ingestLabel);

    let batchesThisRun = 0;
    for (;;) {
      const batch = await listSelectedIngestBatch(
        conn.tenantId,
        connectionId,
        state.mapRunId,
        state.decidedAt,
        state.afterPath,
        SELECTIVE_INGEST_BATCH_SIZE
      );
      if (batch.files.length > 0) {
        const outcomes = await ingestFileBatch(
          connectionId,
          conn.tenantId,
          ingestLabel,
          runId,
          // 34-S14d — `size` comes from the ledger the customer approved, so
          // the ingest ceiling is applied before a single byte is fetched.
          batch.files.map((f) => ({
            itemId: f.itemId,
            name: f.name,
            remotePath: f.remotePath,
            size: f.size,
          }))
        );
        for (let i = 0; i < outcomes.length; i++) {
          const outcome = outcomes[i]!;
          const file = batch.files[i]!;
          countOutcome(state, file.remotePath, outcome.status, outcome.skipReason);
          // What "reading …" names on the progress screen: the LAST file this
          // run touched, full path, not a folder guess.
          state.currentPath = file.path;
          if (outcome.status === 'failed') {
            // A selected file that no longer exists remotely (or that the
            // sink refuses) is a NAMED per-file failure in the run record —
            // the batch activity already catches per-file errors and reports
            // them here instead of crashing the batch. (The count itself
            // moved into countOutcome above, the single place every status
            // is folded.)
            recordFailure(state, {
              path: file.path,
              name: file.name,
              error: outcome.error ?? 'ingest failed (no error recorded)',
            });
          }
        }
      }
      state.progress.batchesDone++;
      batchesThisRun++;
      state.afterPath = batch.nextAfterPath ?? state.afterPath;
      // Unconditional, every batch — the polling UI must see the run move
      // even when a batch was all failures.
      await updateSelectiveIngestRun(conn.tenantId, runId, snapshotOf(state), connectionId);

      if (batch.nextAfterPath === null) break;
      if (batchesThisRun >= batchesPerRun) {
        log.info('selectiveIngestWorkflow: continuing as new', {
          connectionId,
          runId,
          afterPath: state.afterPath,
          progress: state.progress,
        });
        await continueAsNew<typeof selectiveIngestWorkflow>({
          connectionId,
          label: input.label,
          resume: state,
          continueAsNewAfter: input.continueAsNewAfter,
        });
      }
    }

    // Four terminal states, honest: complete (with per-file failures counted
    // and itemized), failed, refused_no_consent, unsupported_provider —
    // and never stuck at 'ingesting'. A run with failures is COMPLETE WITH
    // FAILURES (the sync precedent): the counts and the named failures are
    // the truth, not a blanket 'failed' that hides how much worked.
    await finalizeSelectiveIngestRun(
      conn.tenantId,
      runId,
      connectionId,
      'complete',
      snapshotOf(state)
    );
    return (
      `[SUCCESS] Selective ingest ${connectionId}: selected=${state.progress.selected} ` +
      `done=${doneCount(state.progress)} ingested=${state.progress.ingested} ` +
      `failed=${state.progress.failed} skipped=${state.progress.skipped} ` +
      `deferred=${state.progress.deferred} batches=${state.progress.batchesDone}` +
      (state.progress.failed > 0 ? ` (failures are itemized in the run record)` : '')
    );
  } catch (err) {
    // continueAsNew signals by THROWING its marker, and the call above sits
    // inside this try — without this rethrow every hop would finalize the
    // run 'failed' on its way to the next execution (the exact bug the sync
    // and map suites both pin).
    if (err instanceof ContinueAsNew) throw err;
    try {
      await finalizeSelectiveIngestRun(
        conn.tenantId,
        runId,
        connectionId,
        'failed',
        state ? snapshotOf(state) : { provider: conn.provider }
      );
    } catch (finalizeErr) {
      log.error('selectiveIngestWorkflow: finalize(failed) itself failed', {
        connectionId,
        runId,
        err: (finalizeErr as Error).message,
      });
    }
    throw err;
  }
}
