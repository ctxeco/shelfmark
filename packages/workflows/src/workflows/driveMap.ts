// SPDX-License-Identifier: Apache-2.0
// 34-S09b — driveMapWorkflow: the metadata-only map of a customer's drive.
// The customer consented to a map of names, sizes and counts; this workflow
// walks that metadata, prunes machine-generated subtrees at the folder
// boundary, prunes consent-excluded subtrees the same way (JRN-8),
// classifies every item through the vendored rule artifact, and writes one
// map_runs document — opening nothing.
//
// Structure: an explicit BFS FolderQueueEntry queue + continueAsNew (Graph's
// children listing returns ONE folder's direct children per call), the sync
// workflow's retry shape, unconditional page-level progress flush, and
// finalize-on-failure discipline. Classification happens in the ACTIVITY
// (loading the rule artifact is I/O; workflow code stays deterministic) —
// this file only aggregates what the activity already classified.
//
// PORT NOTE — patch markers: the source carried a `patched()` marker around
// the candidates-spool/funnel commands, because executions were in flight
// when that feature shipped and replaying new commands against old histories
// is a non-determinism error. A fresh OSS history has no pre-funnel
// executions to protect, so the marker is gone and the funnel path is
// unconditional. The same reasoning applies package-wide: no patched() calls
// anywhere, by design, until this package itself ships a change that needs
// one.
import {
  proxyActivities,
  continueAsNew,
  workflowInfo,
  ApplicationFailure,
  ContinueAsNew,
  log,
} from '@temporalio/workflow';
import type { ConnectionActivities } from '../activities/connection';
import type { EgressActivities } from '../activities/egress';
import type { MapActivities, MapPageItem, MapRunSnapshot } from '../activities/map';
import {
  CONSENT_EXCLUDED_RULE,
  MAP_OUT_OF_SCOPE_ERROR_TYPE,
  isConsentExcluded,
  mapRootWithinConsent,
} from './consentScope';

// getConnection is the shared connection activity; checkMapEgressAllowed is
// the map's OWN egress question (tenant-level — the map classifies nothing,
// so it must never be asked for a content label; see egress.ts for the
// production lesson behind the split).
const { getConnection } = proxyActivities<ConnectionActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

const { checkMapEgressAllowed } = proxyActivities<EgressActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

const {
  verifyMapConsent,
  startMapRun,
  updateMapRunProgress,
  finalizeMapRun,
  listMapFolderPage,
  appendMapCandidates,
  writeMapSuggestions,
} = proxyActivities<MapActivities>({
  startToCloseTimeout: '2 minutes',
  // Same lightweight-activity shape as the sync workflow. A Graph 429
  // overrides the backoff below via nextRetryDelay (map.ts's
  // graphThrottleFailure carries Retry-After), so Temporal waits what
  // Graph asked, not what this policy guesses.
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

// ── Named bounds. Every one of these is RECORDED when it bites — a bounded
// thing that does not say so in the output is a silent cap, and silent caps
// are the defect class this design keeps finding. ───────────────────────────

/** continueAsNew threshold, in PAGES fetched by this execution (pages are
 *  the map's unit of work since it ingests nothing). Configurable via input
 *  so tests exercise the resume path without 200 real pages. */
export const DEFAULT_MAP_PAGES_PER_RUN = 200;
/** Per-top-level-folder rollups kept; beyond this, rollupTruncated:true and
 *  topFoldersOmitted counts every ITEM attribution the cap dropped (the
 *  items themselves still count in aggregates/perClass — only the
 *  per-top-folder itemization is bounded). */
export const MAX_TOP_FOLDER_ROLLUPS = 40;
/** Prune-manifest entries kept; beyond this, pruneManifestTruncated:true and
 *  pruneManifestOmitted counts the rest (foldersPruned/prunedFolderBytes
 *  still count EVERY prune — only the itemized list is bounded). */
export const MAX_PRUNE_MANIFEST_ENTRIES = 2000;
/** Narration lines kept; narrationDropped counts what overflowed. */
export const NARRATION_MAX_LINES = 300;
/** A 'sum' items-milestone line every this-many items. */
export const ITEMS_NARRATION_STRIDE = 2500;

// ── Doc shapes ──────────────────────────────────────────────────────────────

export interface MapProgress {
  itemsSeen: number;
  foldersWalked: number;
  foldersPruned: number;
  pagesFetched: number;
  currentPath: string | null;
}

export interface ClassRollup {
  files: number;
  bytes: number;
}

export interface MapAggregates {
  /** FILE rollups per classId. Pruned-subtree bytes live in
   *  reconciliation.prunedFolderBytes, not here — a pruned folder's files
   *  were never enumerated, and pretending otherwise would double-count. */
  perClass: Record<string, ClassRollup>;
  folders: number;
  emptyFolders: number;
  maxDepth: number;
}

export interface TopFolderRollup {
  /** Top-level folder name; '/' is the bucket for files sitting directly in
   *  the mapped root. */
  name: string;
  files: number;
  folders: number;
  bytes: number;
  perClass: Record<string, ClassRollup>;
}

export interface PruneEntry {
  path: string;
  /** The attribution (e.g. 'prune_self:node_modules' from the classifier, or
   *  'consent_excluded' for a JRN-8 prune) — a manifest entry that cannot
   *  say WHICH rule pruned it is not auditable. */
  rule: string;
  /** Graph folder size — recursive subtree bytes left unopened. */
  size: number;
}

/** Every line is arithmetic in this build — the `tier` field is 'none' on
 *  all of them, and no model is ever consulted (the egress-inventory test
 *  proves the absence). The field exists so a host that layers narrated
 *  lines on top does not change the doc shape to do it. */
export type NarrationKind = 'sum' | 'chk' | 'fix';
export interface NarrationLine {
  kind: NarrationKind;
  tier: 'none';
  text: string;
  atMs: number;
}

export interface MapReconciliation {
  /** Bytes of every FILE enumerated by the walk. */
  enumeratedFileBytes: number;
  /** Recursive bytes of every folder pruned at the boundary. The two sums
   *  together account for the subtree without opening anything. */
  prunedFolderBytes: number;
}

interface MapFolderQueueEntry {
  folderId: string | null; // null = the drive root
  path: string; // this folder's OWN absolute path; '' for the root
  depth: number; // 0 for the root
  topFolder: string; // rollup bucket this subtree belongs to
  pageUrl?: string; // set when a folder's children span multiple pages
}

/** Everything a continueAsNew hop carries. Internal only — external callers
 *  (the host's start helper) never set `resume`. */
export interface DriveMapResumeState {
  runId: string;
  queue: MapFolderQueueEntry[];
  progress: MapProgress;
  aggregates: MapAggregates;
  topFolders: TopFolderRollup[];
  rollupTruncated: boolean;
  topFoldersOmitted: number;
  pruneManifest: PruneEntry[];
  pruneManifestTruncated: boolean;
  pruneManifestOmitted: number;
  reconciliation: MapReconciliation;
  narration: NarrationLine[];
  narrationDropped: number;
  artifactVersion: string | null;
  artifactSha256: string | null;
  announcedLeadingClass: string | null;
  lastItemsMilestone: number;
}

export interface DriveMapWorkflowInput {
  connectionId: string;
  /** Internal only — set by continueAsNew to resume mid-walk. */
  resume?: DriveMapResumeState;
  continueAsNewAfter?: number;
}

// ── Pure helpers (exported for unit tests) ──────────────────────────────────

/** Deterministic thousands separators — never toLocaleString (ICU-dependent
 *  output inside deterministic workflow code is replay roulette). */
export function fmtInt(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Deterministic decimal-unit byte formatting. */
export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${Math.trunc(n)} B`;
}

/** Bounded narration append: at the cap, the DROP is counted, never silent. */
export function appendNarration(
  state: { narration: NarrationLine[]; narrationDropped: number },
  kind: NarrationKind,
  text: string,
  atMs: number
): void {
  if (state.narration.length >= NARRATION_MAX_LINES) {
    state.narrationDropped++;
    return;
  }
  state.narration.push({ kind, tier: 'none', text, atMs });
}

/** Leading class by accounted bytes: enumerated file bytes per class, plus
 *  the pruned subtree bytes under machine_generated (a pruned node_modules
 *  is machine-generated bytes the walk accounted for without opening). */
export function leadingClassByBytes(
  perClass: Record<string, ClassRollup>,
  prunedFolderBytes: number
): { classId: string; bytes: number } | null {
  const totals: Record<string, number> = {};
  for (const [classId, rollup] of Object.entries(perClass)) totals[classId] = rollup.bytes;
  if (prunedFolderBytes > 0) {
    totals['machine_generated'] = (totals['machine_generated'] ?? 0) + prunedFolderBytes;
  }
  let leader: { classId: string; bytes: number } | null = null;
  for (const [classId, bytes] of Object.entries(totals)) {
    if (bytes > 0 && (leader === null || bytes > leader.bytes)) leader = { classId, bytes };
  }
  return leader;
}

function freshState(runId: string): DriveMapResumeState {
  return {
    runId,
    queue: [],
    progress: {
      itemsSeen: 0,
      foldersWalked: 0,
      foldersPruned: 0,
      pagesFetched: 0,
      currentPath: null,
    },
    aggregates: { perClass: {}, folders: 0, emptyFolders: 0, maxDepth: 0 },
    topFolders: [],
    rollupTruncated: false,
    topFoldersOmitted: 0,
    pruneManifest: [],
    pruneManifestTruncated: false,
    pruneManifestOmitted: 0,
    reconciliation: { enumeratedFileBytes: 0, prunedFolderBytes: 0 },
    narration: [],
    narrationDropped: 0,
    artifactVersion: null,
    artifactSha256: null,
    announcedLeadingClass: null,
    lastItemsMilestone: 0,
  };
}

function snapshotOf(state: DriveMapResumeState): MapRunSnapshot {
  return {
    progress: state.progress,
    aggregates: state.aggregates,
    topFolders: state.topFolders,
    rollupTruncated: state.rollupTruncated,
    topFoldersOmitted: state.topFoldersOmitted,
    pruneManifest: state.pruneManifest,
    pruneManifestTruncated: state.pruneManifestTruncated,
    pruneManifestOmitted: state.pruneManifestOmitted,
    reconciliation: state.reconciliation,
    narration: state.narration,
    narrationDropped: state.narrationDropped,
  };
}

function bumpClassRollup(map: Record<string, ClassRollup>, classId: string, bytes: number): void {
  const rollup = map[classId] ?? (map[classId] = { files: 0, bytes: 0 });
  rollup.files++;
  rollup.bytes += bytes;
}

/** Rollup bucket for an item seen while listing `current`: at the root, a
 *  folder is its own bucket and a loose file belongs to '/'; deeper, the
 *  queue entry already knows its top-level ancestor. */
function rollupBucketFor(current: MapFolderQueueEntry, item: MapPageItem): string {
  if (current.depth === 0) return item.isFolder ? item.name : '/';
  return current.topFolder;
}

function topFolderRollup(state: DriveMapResumeState, name: string): TopFolderRollup | null {
  const existing = state.topFolders.find((t) => t.name === name);
  if (existing) return existing;
  if (state.topFolders.length >= MAX_TOP_FOLDER_ROLLUPS) {
    // The CAP is recorded, not silent: the flag flips and the omission is
    // counted. Aggregates/perClass still count the item — only the
    // per-top-folder itemization is bounded.
    state.rollupTruncated = true;
    state.topFoldersOmitted++;
    return null;
  }
  const fresh: TopFolderRollup = { name, files: 0, folders: 0, bytes: 0, perClass: {} };
  state.topFolders.push(fresh);
  return fresh;
}

// ── The workflow ────────────────────────────────────────────────────────────

export async function driveMapWorkflow(input: DriveMapWorkflowInput): Promise<string> {
  const { connectionId } = input;
  const pagesPerRun = input.continueAsNewAfter ?? DEFAULT_MAP_PAGES_PER_RUN;
  // continueAsNew keeps the workflowId, so this is stable across hops; it is
  // still carried in resume state so the map_runs key never depends on that
  // implementation detail. Hosts pin the id via driveMapWorkflowId (deps.ts)
  // — the workflowId IS the runId.
  const runId = input.resume?.runId ?? workflowInfo().workflowId;

  const conn = await getConnection(connectionId);

  // ── CONSENT, FAIL CLOSED — before the first provider call, on EVERY
  // execution including continueAsNew resumes: a consent revoked at minute
  // 28 stops the map at the next hop, not at the end. ───────────────────────
  const consent = await verifyMapConsent(conn.tenantId, connectionId);
  if (!consent.active) {
    const refusalState = input.resume ?? freshState(runId);
    appendNarration(
      refusalState,
      'chk',
      'No active map_metadata consent on record for this connection — the map did not run; no provider call was made.',
      Date.now()
    );
    await finalizeMapRun(conn.tenantId, runId, connectionId, 'refused_no_consent', {
      ...snapshotOf(refusalState),
      provider: conn.provider,
    });
    return `[REFUSED_NO_CONSENT] Drive map ${connectionId}: no active map_metadata consent; nothing was fetched.`;
  }

  // ── ONEDRIVE/SHAREPOINT FIRST (JRN-D3): other providers are host code
  // behind the documented provider seam, and mapping one as if supported
  // here would be a silent gap. ─────────────────────────────────────────────
  if (conn.provider !== 'onedrive' && conn.provider !== 'sharepoint') {
    const refusalState = input.resume ?? freshState(runId);
    appendNarration(
      refusalState,
      'chk',
      `Provider ${conn.provider} is not supported by the map (OneDrive/SharePoint first) — no provider call was made.`,
      Date.now()
    );
    await finalizeMapRun(conn.tenantId, runId, connectionId, 'unsupported_provider', {
      ...snapshotOf(refusalState),
      provider: conn.provider,
    });
    return `[UNSUPPORTED_PROVIDER] Drive map ${connectionId}: provider ${conn.provider} is not mapped yet.`;
  }

  // ── JRN-8: THE GRANT'S TARGET BOUNDS THE WALK — checked before the first
  // provider call, on every execution. A subtree grant authorizes exactly
  // the folder it names; a map rooted anywhere else is refused, TYPED, with
  // the run document as evidence. Fail closed on identity (folderId), not
  // on path strings — see consentScope.ts. ──────────────────────────────────
  if (!mapRootWithinConsent(conn.rootFolderId ?? null, consent.target)) {
    const refusalState = input.resume ?? freshState(runId);
    appendNarration(
      refusalState,
      'chk',
      `The mapped root is outside the consented target (consent names folder ${consent.target?.folderPath ?? consent.target?.folderId ?? '(unknown)'}) — the map did not run; no provider call was made.`,
      Date.now()
    );
    await finalizeMapRun(conn.tenantId, runId, connectionId, 'refused_out_of_scope', {
      ...snapshotOf(refusalState),
      provider: conn.provider,
    });
    throw ApplicationFailure.create({
      nonRetryable: true,
      type: MAP_OUT_OF_SCOPE_ERROR_TYPE,
      message:
        `Drive map ${connectionId}: the mapped root (${conn.rootFolderId ?? 'drive root'}) is not ` +
        `the consented target folder (${consent.target?.folderId ?? 'whole drive'}) — refusing to walk ` +
        'outside the grant. Re-map the consented folder, or record a new consent for this root.',
    });
  }
  // JRN-8 — recorded exclusions prune subtrees AT THE BOUNDARY below,
  // exactly like classifier prunes: never descended, always reported.
  const consentExclusions = consent.exclusions;

  const state = input.resume ?? freshState(runId);
  if (!input.resume) {
    const pin = await startMapRun({
      tenantId: conn.tenantId,
      runId,
      connectionId,
      provider: conn.provider,
      consentId: consent.consentId,
      consentDisclosureSha256: consent.disclosureSha256,
      consentTarget: consent.target,
      consentExclusions,
    });
    state.artifactVersion = pin.artifactVersion;
    state.artifactSha256 = pin.artifactSha256;
    state.queue = [{ folderId: conn.rootFolderId ?? null, path: '', depth: 0, topFolder: '/' }];
    appendNarration(
      state,
      'sum',
      `Map started under rule artifact ${pin.artifactVersion} — names, sizes and counts only; no file is ever opened.`,
      Date.now()
    );
  }
  const queue = state.queue;

  // Same must-not-strand guarantee as the sync workflow: whatever fails
  // mid-walk, the run document leaves 'mapping'.
  try {
    // The map's own egress gate, on the tenant — NOT the ingest path's
    // label-bearing gate. The label question is deliberately unanswered at
    // map time (nothing has been read), so asking it here would guarantee a
    // wrong answer; see egress.ts. Inside the try: a denial finalizes
    // 'failed' honestly.
    await checkMapEgressAllowed(conn.tenantId);

    let pagesThisRun = 0;
    while (queue.length > 0) {
      const current = queue[0]!;
      const page = await listMapFolderPage(
        conn.tenantId,
        connectionId,
        current.folderId,
        current.path,
        current.pageUrl
      );
      pagesThisRun++;
      state.progress.pagesFetched++;
      if (!current.pageUrl) state.progress.foldersWalked++;
      state.progress.currentPath = current.path || '/';

      // The rule set must not change under a running map. startMapRun pinned
      // it; a mid-run artifact swap that alters the bytes fails the run
      // loudly instead of blending two rule sets into one report.
      if (state.artifactSha256 === null) {
        state.artifactSha256 = page.artifactSha256;
        state.artifactVersion = page.artifactVersion;
      } else if (state.artifactSha256 !== page.artifactSha256) {
        throw ApplicationFailure.nonRetryable(
          `artifact-classes changed mid-run (pinned ${state.artifactSha256}, page classified under ${page.artifactSha256}) — a map classified under two rule sets is void`,
          'ArtifactClassesChangedMidRun'
        );
      }

      for (const item of page.items) {
        state.progress.itemsSeen++;
        const bucketName = rollupBucketFor(current, item);
        const bucket = topFolderRollup(state, bucketName);

        if (item.isFolder) {
          const depth = current.depth + 1;
          state.aggregates.folders++;
          if (depth > state.aggregates.maxDepth) state.aggregates.maxDepth = depth;
          if (item.childCount === 0) state.aggregates.emptyFolders++;
          if (bucket) bucket.folders++;

          // JRN-8 — a recorded exclusion prunes here, at the same boundary
          // as a classifier prune, attributed to its own rule so the ledger
          // says the HUMAN's carve-out did it. Report, never subtract
          // silently: the manifest, the byte reconciliation and the
          // narration all carry it.
          const excludedByConsent = isConsentExcluded(item.path, consentExclusions);
          if (!item.shouldWalk || excludedByConsent) {
            // ── PRUNE AT THE BOUNDARY: never descend; record instead. ──────
            const pruneRule = excludedByConsent ? CONSENT_EXCLUDED_RULE : item.rule;
            state.progress.foldersPruned++;
            state.reconciliation.prunedFolderBytes += item.size;
            if (state.pruneManifest.length >= MAX_PRUNE_MANIFEST_ENTRIES) {
              state.pruneManifestTruncated = true;
              state.pruneManifestOmitted++;
            } else {
              state.pruneManifest.push({ path: item.path, rule: pruneRule, size: item.size });
            }
            appendNarration(
              state,
              'sum',
              `Skipped ${item.path} (${pruneRule}) — ${fmtBytes(item.size)} recorded without opening anything.`,
              Date.now()
            );
          } else if (item.childCount !== 0) {
            // childCount === 0 is a leaf: listing it would fetch an empty
            // page. The folder itself IS counted (folders/emptyFolders
            // above) — only the no-op provider call is skipped.
            queue.push({
              folderId: item.id,
              path: item.path,
              depth,
              topFolder: bucketName,
            });
          }
        } else {
          bumpClassRollup(state.aggregates.perClass, item.classId, item.size);
          state.reconciliation.enumeratedFileBytes += item.size;
          if (bucket) {
            bucket.files++;
            bucket.bytes += item.size;
            bumpClassRollup(bucket.perClass, item.classId, item.size);
          }
        }
      }

      // Page-level narration milestones — arithmetic only, in every build.
      if (state.progress.itemsSeen >= state.lastItemsMilestone + ITEMS_NARRATION_STRIDE) {
        state.lastItemsMilestone =
          Math.floor(state.progress.itemsSeen / ITEMS_NARRATION_STRIDE) * ITEMS_NARRATION_STRIDE;
        appendNarration(
          state,
          'sum',
          `${fmtInt(state.progress.itemsSeen)} items enumerated across ${fmtInt(
            state.progress.foldersWalked
          )} folders — ${fmtBytes(state.reconciliation.enumeratedFileBytes)} in files so far.`,
          Date.now()
        );
      }
      const leader = leadingClassByBytes(
        state.aggregates.perClass,
        state.reconciliation.prunedFolderBytes
      );
      if (leader && leader.classId !== state.announcedLeadingClass) {
        if (state.announcedLeadingClass === null) {
          appendNarration(
            state,
            'sum',
            `${leader.classId} leads by bytes so far (${fmtBytes(leader.bytes)}).`,
            Date.now()
          );
        } else {
          // The narrator corrects itself — an earlier sum is now wrong, and
          // saying so is the point (a narrator that is never wrong reads as
          // a progress bar with adjectives).
          appendNarration(
            state,
            'fix',
            `Correction: ${leader.classId} now leads by bytes (${fmtBytes(leader.bytes)}), overtaking ${state.announcedLeadingClass}.`,
            Date.now()
          );
        }
        state.announcedLeadingClass = leader.classId;
      }

      // ── 34-S11b: spool this page's funnel candidates — to the store, NEVER
      // into workflow state (an enterprise drive's candidate list would blow
      // the continueAsNew payload; the spool is the whole point). The
      // ACTIVITY decides which items are candidates by reading the funnel
      // artifact's candidate class — rules are data, and this workflow does
      // not know the class name. JRN-8: consent-excluded items never reach
      // the spool — an excluded FILE is filtered here by the same predicate
      // that prunes excluded folders above. The call is fire-and-count:
      // nothing it returns is kept in state.
      //
      // DELIBERATE: an excluded file IS still counted in the aggregates
      // (perClass, enumeratedFileBytes, top-folder rollups) even though it
      // never becomes a candidate. Its metadata was unavoidably returned by
      // the page fetch of its non-excluded parent — a listing the consent
      // authorized — and the aggregates describe what the walk OBSERVED,
      // while the spool describes what may be SELECTED. Excluding it from
      // the totals would make the reconciliation arithmetic lie about the
      // walk; excluding it from the spool is what the consent promises.
      // ────────────────────────────────────────────────────────────────────
      await appendMapCandidates(
        conn.tenantId,
        runId,
        connectionId,
        page.items.filter((i) => !isConsentExcluded(i.path, consentExclusions))
      );

      if (page.nextLink) {
        queue[0] = { ...current, pageUrl: page.nextLink };
      } else {
        queue.shift();
      }

      // Unconditional, every page — the sync workflow's precedent: a page of
      // folders with no files still moved the walk and the polling UI must
      // see it move.
      await updateMapRunProgress(conn.tenantId, runId, snapshotOf(state));

      if (pagesThisRun >= pagesPerRun && queue.length > 0) {
        log.info('driveMapWorkflow: continuing as new', {
          connectionId,
          runId,
          queueDepth: queue.length,
          pagesFetched: state.progress.pagesFetched,
        });
        await continueAsNew<typeof driveMapWorkflow>({
          connectionId,
          resume: state,
          continueAsNewAfter: input.continueAsNewAfter,
        });
      }
    }

    // ── Completion narration: the reconciliation IS the closing argument. ──
    const accounted =
      state.reconciliation.enumeratedFileBytes + state.reconciliation.prunedFolderBytes;
    const totalFiles = Object.values(state.aggregates.perClass).reduce((a, r) => a + r.files, 0);
    appendNarration(
      state,
      'chk',
      `Check: ${fmtBytes(state.reconciliation.enumeratedFileBytes)} enumerated across ${fmtInt(
        totalFiles
      )} files + ${fmtBytes(state.reconciliation.prunedFolderBytes)} in ${fmtInt(
        state.progress.foldersPruned
      )} pruned folders = ${fmtBytes(accounted)} accounted for.`,
      Date.now()
    );
    if (state.aggregates.folders > 0) {
      const pct = Math.round((state.aggregates.emptyFolders / state.aggregates.folders) * 1000) / 10;
      appendNarration(
        state,
        'sum',
        `${fmtInt(state.aggregates.emptyFolders)} of ${fmtInt(state.aggregates.folders)} folders are empty (${pct}%).`,
        Date.now()
      );
    }

    // ── 34-S11b: the funnel at finalize. The activity reads the run's
    // spooled candidates back (tenant-scoped), evaluates the funnel-policy
    // artifact, writes ONE map_suggestions document (named+counted
    // subtraction table, JRN-D1 shape COUNTS, the default selection, the
    // per-item verdict ledger), and deletes the spool. Runs BEFORE finalize
    // so a funnel that cannot be computed fails the run honestly instead of
    // completing without its suggestions. ─────────────────────────────────
    const funnel = await writeMapSuggestions(conn.tenantId, runId, connectionId);
    appendNarration(
      state,
      'sum',
      `Default selection proposed: ${fmtInt(funnel.defaultSelectionFiles)} of ${fmtInt(
        funnel.candidateFiles
      )} candidate files (${fmtBytes(funnel.defaultSelectionBytes)}) — ${fmtInt(
        funnel.subtractedFiles
      )} subtracted, every subtraction named and counted in the run's suggestions.` +
        (funnel.rowsTruncated
          ? ` Verdict ledger truncated at ${fmtInt(funnel.rowsKept)} rows (${fmtInt(
              funnel.rowsOmitted
            )} omitted — named cap).`
          : ''),
      Date.now()
    );
    const funnelNote =
      ` candidates=${funnel.candidateFiles}` +
      ` defaultSelectionFiles=${funnel.defaultSelectionFiles}` +
      ` defaultSelectionBytes=${funnel.defaultSelectionBytes}`;

    await finalizeMapRun(conn.tenantId, runId, connectionId, 'complete', snapshotOf(state));
    return (
      `[SUCCESS] Drive map ${connectionId}: itemsSeen=${state.progress.itemsSeen} ` +
      `foldersWalked=${state.progress.foldersWalked} foldersPruned=${state.progress.foldersPruned} ` +
      `pagesFetched=${state.progress.pagesFetched} files=${totalFiles} ` +
      `enumeratedFileBytes=${state.reconciliation.enumeratedFileBytes} ` +
      `prunedFolderBytes=${state.reconciliation.prunedFolderBytes}` +
      funnelNote
    );
  } catch (err) {
    // continueAsNew signals by THROWING a ContinueAsNew marker ("not an
    // actual error" — its own doc comment), and the continueAsNew call above
    // sits inside this try. Without this rethrow, every hop would finalize
    // the run 'failed' on its way to the next execution — caught by this
    // suite's resume test tracking finalize calls.
    if (err instanceof ContinueAsNew) throw err;
    try {
      await finalizeMapRun(conn.tenantId, runId, connectionId, 'failed', snapshotOf(state));
    } catch (finalizeErr) {
      log.error('driveMapWorkflow: finalizeMapRun(failed) itself failed', {
        connectionId,
        runId,
        err: (finalizeErr as Error).message,
      });
    }
    throw err;
  }
}
