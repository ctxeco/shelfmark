// SPDX-License-Identifier: Apache-2.0
// connectorSyncWorkflow — the delta sync: first full crawl and every
// incremental resync after it, through Graph's delta API. Workflow type name
// MUST stay exactly `connectorSyncWorkflow` — hosts start it by string on
// the pinned id from deps.ts (connectorSyncWorkflowId), and
// test/workflowRegistration.test.ts pins the (type, queue) pair.
//
// PORT NOTE — the retry-failed-files pass is NOT here. The source system
// opened every sync by re-attempting its currently-'failed' documents,
// because delta only surfaces remotely-changed files and a file that failed
// on the ingest side would otherwise never come back around. That pass WAS a
// query against the platform's own documents table; in this library,
// terminal document storage lives behind `DocumentSink.accept()` and there
// is no table here to enumerate failures from. The gap is on record (see
// ingest.ts's port note): a host re-submits failures through its own pass
// with `isRetry: true`, and the stable documentId makes that an update by
// contract, never a duplicate.
import {
  ContinueAsNew,
  proxyActivities,
  continueAsNew,
  workflowInfo,
  log,
} from '@temporalio/workflow';
import type { ConnectionActivities } from '../activities/connection';
import type { EgressActivities } from '../activities/egress';
import type { IngestActivities } from '../activities/ingest';

// Lightweight activities (store reads/writes, one Graph API call each).
const { getConnection, listRemoteDeltaPage, updateSyncProgress, finalizeSync } =
  proxyActivities<ConnectionActivities>({
    startToCloseTimeout: '2 minutes',
    retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
  });

const { checkCloudEgressAllowed } = proxyActivities<EgressActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

// ingestFileBatch downloads and hands off to the sink, bounded-concurrent —
// a much longer ceiling than the activities above, but still bounded (no
// single activity call processes an unbounded number of files).
const { ingestFileBatch } = proxyActivities<IngestActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { initialInterval: '10s', backoffCoefficient: 2, maximumAttempts: 3 },
});

const BATCH_SIZE = 20;
// continueAsNew threshold — keeps workflow history bounded across a
// multi-thousand-file tree. Configurable via workflow input (not an env var
// — workflow code runs in Temporal's deterministic sandbox, which doesn't
// reliably expose process.env the way activity code does) so tests can
// exercise the continueAsNew path directly with a small threshold instead of
// needing 500 real items.
const DEFAULT_CONTINUE_AS_NEW_AFTER = 500;

export interface ConnectorSyncWorkflowInput {
  connectionId: string;
  /** Internal only — set by continueAsNew to resume mid-crawl. External
   * callers (the host's sync route) never set this. */
  resumeLink?: string;
  progress?: SyncProgress;
  continueAsNewAfter?: number;
}

interface RecentFile {
  name: string;
  path: string;
  status: 'ingested' | 'failed' | 'skipped' | 'deferred';
  /** 34-S14d/e — the named reason a file was skipped (or the deferral
   *  detail), carried with the outcome so the completion screen never has to
   *  render a bare count it cannot explain. */
  reason?: string;
}

interface SyncProgress {
  discovered: number;
  ingested: number;
  skipped: number;
  failed: number;
  /** Deferred by the sink (declined for now). Counted apart from `failed`:
   *  nothing is wrong with these documents, and a later pass owns them. */
  deferred: number;
  /** 34-S14d — per-reason rollup over the closed skip vocabulary. */
  skippedByReason: Record<string, number>;
  /** 34-S14c — times this sync fell back to a full re-enumeration because the
   *  stored delta token had expired. */
  deltaExpiredFallbacks: number;
  // A running count, not bounded/overwritten like the two fields below —
  // lets the completion UI tell "crawled fine, found zero files" apart
  // from "something's wrong" when a folder tree has no documents in it.
  foldersScanned: number;
  // Folder of the most recently processed batch, and the last ~15 files
  // touched — both bounded (overwritten each batch, never appended
  // indefinitely) so they stay cheap to carry through continueAsNew.
  currentFolder?: string | null;
  recentFiles?: RecentFile[];
}

/** 34-S14d/e — the per-file reason is a bound too. It rides in a document the
 *  UI polls and in workflow state carried across every continueAsNew hop, and
 *  a sink's failure text can be arbitrarily long. Truncation is MARKED, never
 *  silent; the full text lives wherever the sink records its own outcome. */
const MAX_RECENT_REASON_CHARS = 300;
function recentReason(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length <= MAX_RECENT_REASON_CHARS
    ? text
    : `${text.slice(0, MAX_RECENT_REASON_CHARS)}…[truncated]`;
}

/** One outcome into the counters — the ONE place the four-state vocabulary
 *  is folded, so a new status can never be silently counted as a failure the
 *  way 'deferred' would have been by the old `else progress.failed++`. */
function countOutcome(
  progress: SyncProgress,
  status: 'ingested' | 'failed' | 'skipped' | 'deferred',
  skipReason?: string
): void {
  if (status === 'ingested') progress.ingested++;
  else if (status === 'deferred') progress.deferred++;
  else if (status === 'skipped') {
    progress.skipped++;
    const key = skipReason ?? 'unnamed';
    progress.skippedByReason[key] = (progress.skippedByReason[key] ?? 0) + 1;
  } else progress.failed++;
}

export async function connectorSyncWorkflow(input: ConnectorSyncWorkflowInput): Promise<string> {
  const { connectionId } = input;
  const continueAsNewAfter = input.continueAsNewAfter ?? DEFAULT_CONTINUE_AS_NEW_AFTER;
  const runId = workflowInfo().workflowId;
  // Counters added over this workflow's life are normalised on adoption, not
  // trusted: an execution that continued as new under an OLDER release of
  // this package carries a progress object without them, and `undefined++`
  // is NaN — a completion screen showing "NaN deferred" would be a worse
  // regression than the gap the counter fixed. In-flight executions must
  // complete, and complete truthfully.
  const carried = input.progress;
  const progress: SyncProgress = carried
    ? {
        ...carried,
        deferred: carried.deferred ?? 0,
        skippedByReason: carried.skippedByReason ?? {},
        deltaExpiredFallbacks: carried.deltaExpiredFallbacks ?? 0,
      }
    : {
        discovered: 0,
        ingested: 0,
        skipped: 0,
        failed: 0,
        deferred: 0,
        skippedByReason: {},
        deltaExpiredFallbacks: 0,
        foldersScanned: 0,
        currentFolder: null,
        recentFiles: [],
      };

  const conn = await getConnection(connectionId);
  // The connection's default label (already an id from the host's LabelPolicy
  // vocabulary), the ports contract's default failing that — the same value
  // crosses the egress gate and rides on every DocumentMeta, so the gate's
  // answer and the sink's label can never diverge within one sync.
  const syncLabel = conn.defaultLabel ?? 'default';
  await checkCloudEgressAllowed(conn.tenantId, syncLabel);

  // Resume mid-crawl (continueAsNew) > incremental resync (conn.deltaLink
  // from a prior completed sync) > first-ever full crawl (undefined —
  // Graph's delta API walks the whole tree when called with no token).
  let link: string | undefined = input.resumeLink ?? conn.deltaLink ?? undefined;

  let pendingBatch: { itemId: string; name: string; remotePath: string; size?: number | null }[] =
    [];
  let processedSinceCheckpoint = 0;

  async function flushBatch(): Promise<void> {
    if (pendingBatch.length === 0) return;
    const batch = pendingBatch;
    const outcomes = await ingestFileBatch(connectionId, conn.tenantId, syncLabel, runId, batch);
    const recentFiles: RecentFile[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i]!;
      const file = batch[i]!;
      countOutcome(progress, outcome.status, outcome.skipReason);
      recentFiles.push({
        name: file.name,
        path: file.remotePath,
        status: outcome.status,
        ...(outcome.error ? { reason: recentReason(outcome.error) } : {}),
      });
    }
    // Last 15 of *this* batch is enough to feel live without growing
    // unbounded — the UI only ever needs a recent window, not full history.
    progress.recentFiles = recentFiles.slice(-15);
    progress.currentFolder = batch[batch.length - 1]?.remotePath ?? progress.currentFolder ?? null;
    processedSinceCheckpoint += pendingBatch.length;
    pendingBatch = [];
    await updateSyncProgress(connectionId, progress);
  }

  // A crawl that fails partway through (Graph outage, egress revoked
  // mid-sync, etc.) must not leave the connection stuck at 'syncing'
  // forever, indistinguishable from "still running". Best-effort: if even
  // finalizeSync itself fails, the original error is still what's thrown.
  try {
    for (;;) {
      const page = await listRemoteDeltaPage(connectionId, link);
      // 34-S14c — the activity fell back to a full re-enumeration because the
      // stored delta token had expired. Counted here so the crawl that
      // follows is visibly a RE-crawl rather than an unexplained first one
      // (the activity also records it on the connection document).
      if (page.deltaExpired) {
        progress.deltaExpiredFallbacks++;
        log.warn('connectorSyncWorkflow: delta token expired — full re-enumeration', {
          connectionId,
          deltaExpiredFallbacks: progress.deltaExpiredFallbacks,
        });
      }

      for (const item of page.items) {
        if (item.deleted) continue;
        if (item.isFolder) {
          progress.foldersScanned++;
          progress.currentFolder = `${item.path || ''}/${item.name}`.replace(/\/+/g, '/');
          continue;
        }
        progress.discovered++;
        // 34-S14d — `size` rides along so the ingest activity can apply its
        // ceiling BEFORE opening the file. Delta already carried it; the
        // defect was that nothing passed it on.
        pendingBatch.push({
          itemId: item.id,
          name: item.name,
          remotePath: item.path || '/',
          size: item.size,
        });
        if (pendingBatch.length >= BATCH_SIZE) {
          await flushBatch();
        }
      }
      // Unconditional, not just when pendingBatch is empty — a page with
      // fewer than BATCH_SIZE scattered files (common on a tree with modest
      // per-folder file counts) would otherwise never flush, leaving
      // foldersScanned/discovered invisible to the polling UI for the whole
      // page even though real progress happened.
      await updateSyncProgress(connectionId, progress);

      if (page.nextLink) {
        link = page.nextLink;
        if (processedSinceCheckpoint >= continueAsNewAfter) {
          await flushBatch();
          log.info('connectorSyncWorkflow: continuing as new', { connectionId, progress });
          await continueAsNew<typeof connectorSyncWorkflow>({
            connectionId,
            resumeLink: link,
            progress,
            continueAsNewAfter,
          });
        }
        continue;
      }

      // Final page — no more nextLink, only a deltaLink (walk complete).
      await flushBatch();
      await finalizeSync(connectionId, 'complete', page.deltaLink, {
        deltaExpiredFallbacks: progress.deltaExpiredFallbacks,
      });
      return (
        `[SUCCESS] Connector sync ${connectionId}: foldersScanned=${progress.foldersScanned} ` +
        `discovered=${progress.discovered} ingested=${progress.ingested} skipped=${progress.skipped} ` +
        `failed=${progress.failed} deferred=${progress.deferred} ` +
        `deltaExpiredFallback=${progress.deltaExpiredFallbacks}`
      );
    }
  } catch (err) {
    // continueAsNew signals by THROWING a ContinueAsNew marker ("not an
    // actual error" — its own doc comment), and the continueAsNew call above
    // sits inside this try. Without this rethrow, every hop of a long sync
    // finalizes the connection 'failed' on its way to the next execution —
    // a healthy multi-thousand-file sync flickers through 'error' once per
    // continueAsNewAfter files, and the resumed run flips it back before
    // anyone looks. It survived in the source because that suite's
    // continue-as-new test never actually CONTINUED AS NEW: with only 3
    // files, no batch ever flushed, processedSinceCheckpoint stayed 0, and
    // both pages were fetched by one execution's loop — the test proved the
    // loop, not the hop. The reworked test feeds a full batch so the hop is
    // real, tracks finalize calls, and goes red if this guard is removed.
    if (err instanceof ContinueAsNew) throw err;
    try {
      // Pass the summary on the FAILURE path too. Without it finalizeSync's
      // `summary?.deltaExpiredFallbacks ?? 0` wrote a false zero, so a sync
      // that DID re-enumerate on a 410 and then failed later recorded "no
      // fallback happened" — erasing the one fact that explains why the run
      // was a full crawl instead of an incremental one.
      await finalizeSync(connectionId, 'failed', undefined, {
        deltaExpiredFallbacks: progress.deltaExpiredFallbacks,
      });
    } catch (finalizeErr) {
      log.error('connectorSyncWorkflow: finalizeSync(failed) itself failed', {
        connectionId,
        err: (finalizeErr as Error).message,
      });
    }
    throw err;
  }
}
