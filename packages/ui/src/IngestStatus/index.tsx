// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 34-S14f (UI half) and 34-S15b — the Ingest phase's screen: what the
 * customer watches while their approved files are opened, and what they are
 * told when it stops.
 *
 * ══ WHY THIS IS A SEPARATE MODULE ══════════════════════════════════════════
 *
 * The Connections screen already carries one closed-state derivation
 * (`browseView`) whose whole existence is a lesson: four independent booleans
 * over four regions left a combination that rendered NOTHING, in front of a
 * customer, under an enabled button. That lesson has now cost three fixes.
 * The ingest panel has strictly more inputs than the picker did — five
 * outcome counters, a denominator that can be absent or stale, a per-folder
 * rollup with two separate truncation records, and a status vocabulary that a
 * worker can extend before this build knows about it — so it gets the same
 * treatment from the first line: everything that bears on "what is true about
 * this run right now" collapses HERE into a closed set of states, and
 * `IngestPanel` renders that set exhaustively behind a compile-time `never`.
 *
 * ══ WHERE THE DATA COMES FROM, EXACTLY ═════════════════════════════════════
 *
 * `connector_connections.lastIngestProgress`, served by the connections list
 * route (whole connection documents minus the encrypted refresh token).
 * Written every batch and once terminally by @shelfmark/workflows'
 * selective-ingest activities (`mirrorIngestProgress`).
 *
 * NOT `selective_ingest_runs`. That collection is the canonical record and it
 * carries more (per-file `failures[]`), but no route serves it, so it is
 * unreachable from a browser. A screen built against an unreachable record
 * is the same "declared but unreachable" defect 34-S14d fixed for `skipped`,
 * and this module refuses to pretend otherwise: where the itemization is
 * missing, the copy says so and names why rather than showing a bare count.
 */
import React from 'react';
import { t } from '../i18n/index.js';
import type { MessageKey } from '../i18n/types.js';
import { getLocale } from '../i18n/index.js';

// ── the wire shape ─────────────────────────────────────────────────────────

/** The run statuses the selective-ingest workflow writes. Closed there;
 *  closed here; and a token outside the set is NAMED rather than coerced —
 *  see `normalizeIngestProgress`. */
export const INGEST_RUN_STATUSES = [
  'ingesting',
  'complete',
  'failed',
  'refused_no_consent',
  'unsupported_provider',
] as const;

export type IngestRunStatus = (typeof INGEST_RUN_STATUSES)[number];

/** One folder's live rollup. `selected` is the folder's own denominator, taken
 *  from the approved selection at plan time — not a running total. */
export interface IngestFolderProgress {
  path: string;
  selected: number;
  ingested: number;
  skipped: number;
  failed: number;
  deferred: number;
}

export interface IngestProgress {
  runId: string;
  /** One of INGEST_RUN_STATUSES, or 'unrecognized' when the service named a
   *  state this build does not know (a worker deployed ahead of this UI). */
  status: IngestRunStatus | 'unrecognized';
  /** The token verbatim, so an unrecognized state can be quoted on screen
   *  instead of hidden behind a shrug. */
  rawStatus: string;
  /** THE DENOMINATOR — what the customer approved at step 13. */
  selected: number;
  /** ingested + skipped + failed + deferred, written by the workflow.
   *  Read, never re-derived: four fields summed by three screens is three
   *  chances to sum them differently. */
  done: number;
  ingested: number;
  skipped: number;
  failed: number;
  /** NOT a failure. The sink answered `deferred` — declined for now — and
   *  the retry pass owns re-submitting it (the `deferred` lane of
   *  @shelfmark/core's DocumentSink contract). */
  deferred: number;
  /** Per-reason rollup over the connectors' closed skip vocabulary. */
  skippedByReason: Record<string, number>;
  /** Full path of the last file touched — what "Reading …" names. */
  currentPath: string | null;
  folders: IngestFolderProgress[];
  foldersTruncated: boolean;
  foldersOmitted: number;
  failuresTruncated: boolean;
  failuresOmitted: number;
  /** ISO-8601 from the store's Date, or null when the field never arrived. */
  updatedAt: string | null;
}

function num(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** A per-reason rollup is a map keyed on a CLOSED vocabulary server-side, so
 *  the only job here is to refuse anything that is not a positive count —
 *  never to reject an unfamiliar key, which would silently drop the very
 *  reason a newer worker added. */
function reasonMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = num(value);
    if (n > 0) out[key] = n;
  }
  return out;
}

function folderRows(raw: unknown): IngestFolderProgress[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row) => row && typeof row === 'object')
    .map((row: any) => ({
      path: typeof row.path === 'string' ? row.path : '',
      selected: num(row.selected),
      ingested: num(row.ingested),
      skipped: num(row.skipped),
      failed: num(row.failed),
      deferred: num(row.deferred),
    }));
}

/**
 * Defensive read of `lastIngestProgress` off the wire.
 *
 * Returns null for "this connection has no selective-ingest run" — which is
 * true of every connection until the customer completes step 13, and of every
 * connection at all until the workers' mirror ships. Null is the ABSENCE of a
 * run, never a run that did nothing; those two are different states and the
 * panel says different things about them.
 *
 * A `status` this build does not recognise is preserved in `rawStatus` and
 * flagged, because the alternative — mapping it onto the nearest known token —
 * is how a finished run gets reported as still running.
 */
export function normalizeIngestProgress(raw: unknown): IngestProgress | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const rawStatus = typeof r.status === 'string' ? r.status : '';
  if (rawStatus === '') return null;
  const known = (INGEST_RUN_STATUSES as readonly string[]).includes(rawStatus);
  return {
    runId: typeof r.runId === 'string' ? r.runId : '',
    status: known ? (rawStatus as IngestRunStatus) : 'unrecognized',
    rawStatus,
    selected: num(r.selected),
    // DERIVED, never trusted off the wire. `done` is a convenience total
    // and the counts are the truth; a run whose `done` is absent or stale —
    // an in-flight workflow started by the previous deploy, mid rolling
    // upgrade — used to report done:0 WITH failures, and a zero `done` sent
    // the panel to the neutral "nothing was opened and nothing was changed"
    // card while three files had failed. That is the completion-tone defect
    // exactly: a screen claiming calm over a run that did not have it. The
    // wire value is kept only as a floor, so a server that legitimately
    // counts higher than the four buckets (a status we do not model yet) is
    // not lost.
    done: Math.max(num(r.done), num(r.ingested) + num(r.skipped) + num(r.failed) + num(r.deferred)),
    ingested: num(r.ingested),
    skipped: num(r.skipped),
    failed: num(r.failed),
    deferred: num(r.deferred),
    skippedByReason: reasonMap(r.skippedByReason),
    currentPath: typeof r.currentPath === 'string' && r.currentPath !== '' ? r.currentPath : null,
    folders: folderRows(r.folders),
    foldersTruncated: r.foldersTruncated === true,
    foldersOmitted: num(r.foldersOmitted),
    failuresTruncated: r.failuresTruncated === true,
    failuresOmitted: num(r.failuresOmitted),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
  };
}

// ── the denominator ────────────────────────────────────────────────────────

/**
 * Whether a percentage may be shown at all.
 *
 * Step 14's whole point is that there is finally a TRUE denominator — the
 * count the customer approved at step 13 — replacing a heuristic the old code
 * called "not a true ETA" in its own comment. Which means the percentage is
 * now a claim about their decision, and a claim is only worth making when it
 * holds:
 *
 *  - `trusted`  — a positive denominator that the work has not passed.
 *  - `stale`    — more files processed than were approved. Reachable when a
 *                 re-decision lands mid-run, or when a plan built by an older
 *                 pod is resumed by a newer one. The counts are still true;
 *                 the RATIO is not, so no ratio is shown.
 *  - `unknown`  — no denominator at all (a mirror written before `selected`
 *                 existed, or a refusal that never planned a selection).
 *
 * Nothing here invents a percentage from what it has. A progress bar without
 * a denominator is a drawing, not a measurement, so the two non-trusted cases
 * render counts and no bar.
 */
export type IngestDenominator =
  | { kind: 'trusted'; selected: number; pct: number }
  | { kind: 'stale'; selected: number }
  | { kind: 'unknown' };

export function ingestDenominator(p: IngestProgress): IngestDenominator {
  if (!(p.selected > 0)) return { kind: 'unknown' };
  if (p.done > p.selected) return { kind: 'stale', selected: p.selected };
  const pct = Math.max(0, Math.min(100, Math.round((p.done / p.selected) * 100)));
  return { kind: 'trusted', selected: p.selected, pct };
}

// ── which panel a connection owes the customer ─────────────────────────────

/**
 * The connection fields that decide WHICH progress panel is the truth right
 * now. Structural rather than the page's `Connection` type so the decision
 * can be enumerated in a test without a fetch.
 */
export interface ConnectorActivityInput {
  /** `connector_connections.status`. */
  status: string;
  lastSyncStatus: string | null;
  /** ISO-8601 terminal timestamp of the legacy all-at-once sync. */
  lastSyncAt: string | null;
  ingest: IngestProgress | null;
}

export type ConnectorActivity =
  | { kind: 'syncing' }
  | { kind: 'ingest'; view: IngestView }
  | { kind: 'syncComplete' }
  | { kind: 'syncFailed' }
  | { kind: 'idle' };

function isNewer(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true;
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (Number.isNaN(at)) return false;
  if (Number.isNaN(bt)) return true;
  return at >= bt;
}

/**
 * Two progress records can exist on one connection: the legacy all-at-once
 * sync's (`lastSyncProgress`, written by the sync workflow) and the
 * selective ingest's (`lastIngestProgress`, written by the selective-ingest
 * workflow). They are separate documents, written by separate workflows, and
 * neither touches the other's fields.
 *
 * The customer arriving from step 13 has just approved a specific set of
 * files. Landing them on the older all-or-nothing panel — which still shows
 * whatever their last full sync did, possibly weeks ago — would answer a
 * question they did not ask, so the order below is:
 *
 *  1. **A LIVE READ WINS.** They just started it; it is the only thing on
 *     their mind, and it is the only record that is still moving.
 *  2. A live legacy sync next, for the same reason.
 *  3. Otherwise the MORE RECENT terminal record, because "what happened last"
 *     is the honest answer when both exist.
 *  4. An ingest record with no usable timestamp still beats rendering
 *     nothing — it is a real run that really happened.
 */
export function connectorActivity(input: ConnectorActivityInput): ConnectorActivity {
  const ingest = input.ingest;
  if (ingest && ingest.status === 'ingesting') return { kind: 'ingest', view: ingestView(ingest) };
  if (input.status === 'syncing') return { kind: 'syncing' };
  if (ingest && isNewer(ingest.updatedAt, input.lastSyncAt)) {
    return { kind: 'ingest', view: ingestView(ingest) };
  }
  if (input.lastSyncStatus === 'complete') return { kind: 'syncComplete' };
  if (input.status === 'error' && input.lastSyncStatus === 'failed') return { kind: 'syncFailed' };
  if (ingest) return { kind: 'ingest', view: ingestView(ingest) };
  return { kind: 'idle' };
}

/** Whether this connection has work in flight, and therefore whether the page
 *  must keep polling. The old test was `status === 'syncing'` alone, which is
 *  a field the selective ingest never writes — so a customer who had just
 *  consented watched a frozen panel until they reloaded by hand. */
export function isConnectorActive(input: ConnectorActivityInput): boolean {
  return input.status === 'syncing' || input.ingest?.status === 'ingesting';
}

// ── the closed view set ────────────────────────────────────────────────────

/**
 * Every state an ingest run can present, and nothing else.
 *
 * The ordering inside `ingestView` is the whole design:
 *  1. The SERVER'S OWN STATUS outranks any counter. A run that says it failed
 *     did fail, whatever its counts add up to.
 *  2. Within 'complete', `done === 0` comes first — "finished having done
 *     nothing" is a different sentence from "finished badly", and the old
 *     sync panel conflated them (an empty crawl with retry-pass failures
 *     rendered "Sync finished with failures" over "This folder is empty",
 *     with no retry button anywhere).
 *  3. Then FAILURES, which are the only thing that earns an alarm colour.
 *  4. Then DEFERRALS, which are recoverable and must never be styled as
 *     errors — the sink declined for now, and the retry pass re-submits.
 *  5. Then "everything was skipped", which is not a failure and not a success.
 *  6. Only then, clean.
 */
export type IngestView =
  /** Running. Carries the denominator state, because the bar is only drawn
   *  when there is something true to draw it against. */
  | { kind: 'reading'; p: IngestProgress; denominator: IngestDenominator }
  /** Finished, nothing failed, nothing parked, something was read. */
  | { kind: 'complete'; p: IngestProgress }
  /** Finished with at least one failure. Amber, and the words say it too. */
  | { kind: 'partial'; p: IngestProgress }
  /** Finished with no failures but files the sink deferred. */
  | { kind: 'deferred'; p: IngestProgress }
  /** Finished, work happened, and none of it produced a searchable file. */
  | { kind: 'nothingRead'; p: IngestProgress }
  /** Finished having processed nothing at all. */
  | { kind: 'nothingDone'; p: IngestProgress }
  /** The run itself stopped — not "these files failed". */
  | { kind: 'runFailed'; p: IngestProgress }
  /** The workflow refused before opening anything. */
  | { kind: 'refused'; p: IngestProgress; reason: 'no_consent' | 'unsupported_provider' }
  /** A status this build does not know. Quoted, never coerced. */
  | { kind: 'unrecognized'; p: IngestProgress };

export function ingestView(p: IngestProgress): IngestView {
  switch (p.status) {
    case 'ingesting':
      return { kind: 'reading', p, denominator: ingestDenominator(p) };
    case 'failed':
      return { kind: 'runFailed', p };
    case 'refused_no_consent':
      return { kind: 'refused', p, reason: 'no_consent' };
    case 'unsupported_provider':
      return { kind: 'refused', p, reason: 'unsupported_provider' };
    case 'complete':
      // ORDER IS THE GUARANTEE. Anything that happened outranks the
      // did-nothing card: a failure first, then a deferral, and only then
      // the question of whether anything was opened at all. Testing
      // `done <= 0` first let a run with failures but a zero/absent `done`
      // render "nothing was changed" — the same shape of lie the
      // completion-tone fix was written to end, arriving by a different
      // door.
      if (p.failed > 0) return { kind: 'partial', p };
      if (p.deferred > 0) return { kind: 'deferred', p };
      if (p.done <= 0) return { kind: 'nothingDone', p };
      if (p.ingested <= 0) return { kind: 'nothingRead', p };
      return { kind: 'complete', p };
    case 'unrecognized':
      return { kind: 'unrecognized', p };
    default: {
      // Adding a status to IngestRunStatus without giving it a view stops the
      // build here rather than rendering a blank card at runtime.
      const _never: never = p.status;
      return _never;
    }
  }
}

// ── 34-S15b: why, not just how many ────────────────────────────────────────

/**
 * What the customer can DO about a cause — the part a bare count never told
 * them, and the reason a partial completion used to be a number they could
 * only stare at.
 *
 *  - `none`      nothing is wrong and nothing is owed.
 *  - `automatic` it recovers by itself, and the copy names the trigger.
 *  - `customer`  they can act, and the copy names the act.
 *  - `retry`     reading again may work.
 *  - `unknown`   we did not record why. Said plainly; it is our gap, not
 *                theirs, and inviting a retry over it would be a guess.
 */
export type OutcomeRecovery = 'none' | 'automatic' | 'customer' | 'retry' | 'unknown';

export interface OutcomeGroup {
  /** Stable token: a skip reason from the connectors' closed vocabulary, or
   *  'failed' / 'deferred'. Used as a React key and asserted in tests —
   *  never rendered raw. */
  cause: string;
  count: number;
  recovery: OutcomeRecovery;
  /** Already localised, same discipline as `browseFailureMessage`. */
  title: string;
  advice: string;
}

/**
 * The connectors' skip vocabulary, mirrored from @shelfmark/policy's
 * ingestFilters (`INGEST_SKIP_REASONS`). Closed there, so this table is
 * total — but the lookup below still falls through to a written "we did not
 * record why" rather than dropping an unfamiliar key, because a rollup entry
 * with no row on screen is a silent cap on the explanation.
 */
const SKIP_CAUSES: Record<string, { title: MessageKey; advice: MessageKey; recovery: OutcomeRecovery }> = {
  already_ingested: {
    title: 'connectors.cause.alreadyIngested',
    advice: 'connectors.cause.alreadyIngestedAdvice',
    recovery: 'none',
  },
  deferred: {
    title: 'connectors.cause.deferred',
    advice: 'connectors.cause.deferredAdvice',
    recovery: 'automatic',
  },
  too_large: {
    title: 'connectors.cause.tooLarge',
    advice: 'connectors.cause.tooLargeAdvice',
    recovery: 'customer',
  },
  unsupported_type: {
    title: 'connectors.cause.unsupportedType',
    advice: 'connectors.cause.unsupportedTypeAdvice',
    recovery: 'customer',
  },
};

/** The counters any outcome rollup needs, so the selective-ingest mirror and
 *  the legacy sync's `lastSyncProgress` explain themselves through the SAME
 *  function — the two paths disagreeing about what a deferral means is
 *  exactly the source-divergent semantics 34-S14e closed worker-side. */
export interface OutcomeCounts {
  failed: number;
  deferred: number;
  skippedByReason: Record<string, number>;
  /** Total skips. Only used to notice skips the rollup did not name. */
  skipped: number;
}

/**
 * Failure and skip counts, grouped by cause, biggest first.
 *
 * Two invariants, both testable:
 *
 * 1. **A skip is never counted as a failure.** They are separate groups with
 *    separate words, because a file we deliberately never opened is not a
 *    file that broke — 34-S14d turned a large share of one measured run's
 *    448 "failures" into exactly that.
 * 2. **Every counted file reaches a row.** If `skipped` exceeds what
 *    `skippedByReason` accounts for — an older worker that counted skips
 *    before the rollup existed — the remainder gets the "no reason recorded"
 *    row rather than vanishing. A rollup that loses files is a silent cap.
 */
export function outcomeGroups(counts: OutcomeCounts): OutcomeGroup[] {
  const groups: OutcomeGroup[] = [];

  if (counts.failed > 0) {
    groups.push({
      cause: 'failed',
      count: counts.failed,
      recovery: 'retry',
      title: t('connectors.cause.failed'),
      advice: t('connectors.cause.failedAdvice'),
    });
  }

  if (counts.deferred > 0) {
    groups.push({
      cause: 'deferred',
      count: counts.deferred,
      recovery: 'automatic',
      title: t('connectors.cause.deferred'),
      advice: t('connectors.cause.deferredAdvice'),
    });
  }

  let named = 0;
  for (const [reason, count] of Object.entries(counts.skippedByReason)) {
    if (!(count > 0)) continue;
    named += count;
    const known = SKIP_CAUSES[reason];
    groups.push({
      cause: reason,
      count,
      recovery: known ? known.recovery : 'unknown',
      title: known ? t(known.title) : t('connectors.cause.unnamed'),
      advice: known ? t(known.advice) : t('connectors.cause.unnamedAdvice'),
    });
  }

  // Invariant 2. `unnamed` is also a legitimate key the worker itself writes
  // (an absent reason folds onto it), so a rollup that already carries one
  // merges rather than producing two rows.
  const unaccounted = counts.skipped - named;
  if (unaccounted > 0) {
    const existing = groups.find((g) => g.cause === 'unnamed');
    if (existing) existing.count += unaccounted;
    else
      groups.push({
        cause: 'unnamed',
        count: unaccounted,
        recovery: 'unknown',
        title: t('connectors.cause.unnamed'),
        advice: t('connectors.cause.unnamedAdvice'),
      });
  }

  // Deterministic: biggest cause first, ties broken by the token so the same
  // run never reorders itself between two polls of the same numbers.
  return groups.sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
}

const RECOVERY_LABEL: Record<OutcomeRecovery, MessageKey> = {
  none: 'connectors.cause.recoveryNone',
  automatic: 'connectors.cause.recoveryAutomatic',
  customer: 'connectors.cause.recoveryCustomer',
  retry: 'connectors.cause.recoveryRetry',
  unknown: 'connectors.cause.recoveryUnknown',
};

/** Tone, never colour alone: each label sits beside its own words. `retry` is
 *  the only amber one — a deferral is recoverable and is styled like it. */
const RECOVERY_CLASS: Record<OutcomeRecovery, string> = {
  none: 'text-slate-400 border-slate-700',
  automatic: 'text-sky-300 border-sky-800',
  customer: 'text-blue-300 border-blue-800',
  retry: 'text-amber-300 border-amber-800',
  unknown: 'text-slate-400 border-slate-700',
};

// ── the four-state file vocabulary ─────────────────────────────────────────

export type FileOutcomeStatus = 'ingested' | 'skipped' | 'failed' | 'deferred';

/**
 * Four states, not two — and never a colour on its own. Every call site pairs
 * the glyph with `label`, which is what a screen reader gets: the previous
 * list marked status with an `aria-hidden` glyph and a colour class, so a
 * non-sighted reader learned nothing at all about whether a file was read.
 *
 * `deferred` is deliberately NOT rose. The sink declined the file for now
 * with its place kept — that parity with the host's own deferred lane is the
 * whole point of the shared `deferred` vocabulary in @shelfmark/core.
 */
export const FILE_OUTCOME_STYLE: Record<FileOutcomeStatus, { icon: string; className: string; label: MessageKey }> = {
  ingested: { icon: '✓', className: 'text-emerald-400', label: 'connectors.fileStatus.ingested' },
  skipped: { icon: '○', className: 'text-slate-500', label: 'connectors.fileStatus.skipped' },
  failed: { icon: '✗', className: 'text-rose-400', label: 'connectors.fileStatus.failed' },
  deferred: { icon: '⏸', className: 'text-sky-400', label: 'connectors.fileStatus.deferred' },
};

/**
 * Total lookup. A worker that ships a fifth status before this build knows it
 * used to reach `FILE_OUTCOME_STYLE[status].className` on undefined and take
 * the whole connectors page down with it — a rolling deploy is not a rare
 * event, and a blank page is a worse answer than "unknown state".
 */
export function fileOutcomeStyle(status: string): { icon: string; className: string; label: string } {
  const known = (FILE_OUTCOME_STYLE as Record<string, (typeof FILE_OUTCOME_STYLE)['ingested']>)[status];
  if (known) return { icon: known.icon, className: known.className, label: t(known.label) };
  return { icon: '?', className: 'text-slate-500', label: t('connectors.fileStatus.unknown') };
}

// ── the folder rollup, and its own bound ───────────────────────────────────

/**
 * How many folder rows this panel draws.
 *
 * The run's own cap is 200 entries, which is the right bound for a document
 * and the wrong bound for a card — 200 rows inside a connector tile is not a
 * rollup, it is a second page. So there are TWO bounds on the same list and
 * BOTH are stated on screen: this one ("showing 12 of 41 folders") and the
 * run's ("N more folders were not itemized"). Neither is allowed to hide
 * behind the other.
 */
export const MAX_FOLDER_ROWS = 12;

/** Trouble first, then size, then path — deterministic, and it puts the
 *  folders a customer would actually want to look at at the top instead of
 *  whichever ones the crawl happened to reach first. */
export function orderedFolders(folders: IngestFolderProgress[]): IngestFolderProgress[] {
  return [...folders].sort((a, b) => {
    const at = a.failed + a.deferred;
    const bt = b.failed + b.deferred;
    if (at !== bt) return bt - at;
    if (a.selected !== b.selected) return b.selected - a.selected;
    return a.path.localeCompare(b.path);
  });
}

/** "1,247" not "1247" — through Intl so es-MX gets its own separators. */
function fmt(n: number): string {
  return new Intl.NumberFormat(getLocale()).format(n);
}

/** '3 read · 1 failed · 2 deferred · 4 skipped', built from real keys (so the
 *  parity gate still covers every word) and omitting zeros (so a clean folder
 *  does not advertise three kinds of nothing). */
function outcomeLine(row: { ingested: number; failed: number; deferred: number; skipped: number }): string {
  const parts: string[] = [t('connectors.ingest.nRead', { n: fmt(row.ingested) })];
  if (row.failed > 0) parts.push(t('connectors.ingest.nFailed', { n: fmt(row.failed) }));
  if (row.deferred > 0) parts.push(t('connectors.ingest.nDeferred', { n: fmt(row.deferred) }));
  if (row.skipped > 0) parts.push(t('connectors.ingest.nSkipped', { n: fmt(row.skipped) }));
  return parts.join(' · ');
}

// ── presentation ───────────────────────────────────────────────────────────

const FolderRollup: React.FC<{ p: IngestProgress }> = ({ p }) => {
  if (p.folders.length === 0 && !p.foldersTruncated) return null;
  const ordered = orderedFolders(p.folders);
  const shown = ordered.slice(0, MAX_FOLDER_ROWS);
  return (
    <div className="mt-3 border border-slate-800/70 rounded-md bg-slate-950/60 p-2">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1.5">
        {t('connectors.ingest.foldersTitle')}
      </p>
      <ul className="space-y-1">
        {shown.map((f) => (
          <li key={f.path} className="flex items-baseline justify-between gap-3 text-xs font-mono">
            <span className="truncate text-slate-300">{f.path || '/'}</span>
            <span className="shrink-0 text-slate-500 tabular-nums">
              {t('connectors.ingest.folderRow', {
                ingested: fmt(f.ingested),
                selected: fmt(f.selected),
              })}
              {f.failed + f.deferred + f.skipped > 0 ? ` · ${outcomeLine(f)}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {ordered.length > shown.length && (
        <p className="mt-1.5 text-[11px] text-slate-500">
          {t('connectors.ingest.foldersShown', {
            shown: fmt(shown.length),
            total: fmt(ordered.length),
          })}
        </p>
      )}
      {p.foldersTruncated && (
        <p className="mt-1 text-[11px] text-amber-300/80">
          {t('connectors.ingest.foldersOmitted', { omitted: fmt(p.foldersOmitted) })}
        </p>
      )}
    </div>
  );
};

/**
 * 34-S15b on screen. Renders nothing when there is nothing to explain — a
 * clean run does not need a "why" section — and otherwise gives every cause
 * its own row: how many, what it means, and what (if anything) to do.
 */
export const OutcomeReasons: React.FC<{ counts: OutcomeCounts }> = ({ counts }) => {
  const groups = outcomeGroups(counts);
  if (groups.length === 0) return null;
  return (
    <div className="mt-3 border border-slate-800/70 rounded-md bg-slate-950/60 p-3">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">
        {t('connectors.cause.title')}
      </p>
      <ul className="space-y-2">
        {groups.map((g) => (
          <li key={g.cause}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-xs font-semibold text-slate-200">
                {g.title} — {fmt(g.count)}
              </p>
              <span
                className={`shrink-0 text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border ${RECOVERY_CLASS[g.recovery]}`}
              >
                {t(RECOVERY_LABEL[g.recovery])}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">{g.advice}</p>
          </li>
        ))}
      </ul>
    </div>
  );
};

function countsOf(p: IngestProgress): OutcomeCounts {
  return {
    failed: p.failed,
    deferred: p.deferred,
    skippedByReason: p.skippedByReason,
    skipped: p.skipped,
  };
}

/** The per-file failure itemization lives in `selective_ingest_runs`, which
 *  no route serves. Rather than show a bare number and let the customer
 *  wonder, the panel says which files it cannot name and why it cannot. */
const FailureItemizationNote: React.FC<{ p: IngestProgress }> = ({ p }) => {
  if (p.failed <= 0) return null;
  return (
    <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
      {t('connectors.ingest.failuresNotItemized')}
      {p.failuresTruncated ? ` ${t('connectors.ingest.failuresOmitted', { omitted: fmt(p.failuresOmitted) })}` : ''}
    </p>
  );
};

const TONE: Record<
  'reading' | 'clean' | 'partial' | 'deferred' | 'neutral' | 'error',
  { box: string; icon: string; heading: string; glyph: string }
> = {
  reading: {
    box: 'border-blue-900/50 bg-blue-950/10',
    icon: 'text-blue-400',
    heading: 'text-blue-300',
    glyph: '›',
  },
  clean: {
    box: 'border-emerald-900/60 bg-emerald-950/20',
    icon: 'text-emerald-400',
    heading: 'text-emerald-200',
    glyph: '✓',
  },
  partial: {
    box: 'border-amber-900/60 bg-amber-950/20',
    icon: 'text-amber-400',
    heading: 'text-amber-200',
    glyph: '!',
  },
  deferred: {
    box: 'border-sky-900/60 bg-sky-950/20',
    icon: 'text-sky-400',
    heading: 'text-sky-200',
    glyph: '⏸',
  },
  neutral: {
    box: 'border-slate-800 bg-slate-950/40',
    icon: 'text-slate-400',
    heading: 'text-slate-200',
    glyph: '○',
  },
  error: {
    box: 'border-rose-900/60 bg-rose-950/20',
    icon: 'text-rose-400',
    heading: 'text-rose-200',
    glyph: '✗',
  },
};

const Card: React.FC<{
  tone: keyof typeof TONE;
  title: string;
  children?: React.ReactNode;
}> = ({ tone, title, children }) => {
  const s = TONE[tone];
  return (
    <div className={`mt-3 border rounded-lg p-3 ${s.box}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={s.icon}>
          {s.glyph}
        </span>
        <p className={`text-sm font-semibold ${s.heading}`}>{title}</p>
      </div>
      {children}
    </div>
  );
};

export interface IngestPanelProps {
  view: IngestView;
  /** Where "start working with these files" lands (the host's corpus). */
  onStartWorking: () => void;
  /** Set when the OS asks for less motion — the bar stops pulsing and stops
   *  animating its width; the numbers still update. */
  reducedMotion: boolean;
  /**
   * The way back into the Decide flow, rendered by the host so this module
   * owns no routing. It is deliberately the only "do it again" this screen
   * offers: re-reading is a decision plus a consent, and both live there — a
   * button here that re-POSTed the ingest would rebuild the fused
   * two-consents-in-one-button design the whole journey exists to split.
   */
  renderReviewLink: (label: string) => React.ReactNode;
}

/**
 * The Ingest phase, rendered exhaustively. Adding a member to `IngestView`
 * without giving it a branch is a type error, not a blank card.
 */
export const IngestPanel: React.FC<IngestPanelProps> = ({ view, onStartWorking, reducedMotion, renderReviewLink }) => {
  const p = view.p;

  const runLine =
    p.runId !== '' ? (
      <p className="mt-2 text-[10px] font-mono text-slate-600 truncate">
        {t('connectors.ingest.runLabel', { runId: p.runId })}
      </p>
    ) : null;

  switch (view.kind) {
    case 'reading': {
      const d = view.denominator;
      return (
        <Card tone="reading" title={t('connectors.ingest.title')}>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <p className="text-2xl font-bold tabular-nums text-slate-100">{fmt(p.ingested)}</p>
              <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                {t('connectors.ingest.readLabel')}
              </p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-slate-100">
                {d.kind === 'unknown' ? '—' : fmt(d.selected)}
              </p>
              <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                {t('connectors.ingest.selectedLabel')}
              </p>
            </div>
          </div>

          <p className="mt-2 text-xs font-mono text-slate-400 truncate">
            {p.currentPath
              ? t('connectors.ingest.currentFile', { path: p.currentPath })
              : t('connectors.ingest.currentFileNone')}
          </p>

          {/* A bar is a RATIO drawn to scale. Without a trusted denominator
              there is no ratio, so there is no bar — the counts stand on
              their own and the sentence says why the percentage is missing.
              The old panel drew one regardless, floored at 8%, over a
              denominator its own comment admitted was not an ETA. */}
          {d.kind === 'trusted' ? (
            <>
              <div className="mt-2 h-1 w-full bg-slate-800 rounded overflow-hidden">
                <div
                  role="progressbar"
                  aria-valuenow={d.pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className={`h-full bg-blue-500 rounded ${
                    reducedMotion ? '' : 'transition-all duration-500 animate-pulse'
                  }`}
                  style={{ width: `${d.pct}%` }}
                />
              </div>
              <p className="mt-2 text-xs font-mono text-slate-400 tabular-nums">
                {t('connectors.ingest.progress', {
                  done: fmt(p.done),
                  selected: fmt(d.selected),
                  pct: d.pct,
                })}
              </p>
            </>
          ) : d.kind === 'stale' ? (
            <p className="mt-2 text-xs font-mono text-amber-300/90">
              {t('connectors.ingest.progressStale', {
                done: fmt(p.done),
                selected: fmt(d.selected),
              })}
            </p>
          ) : (
            <p className="mt-2 text-xs font-mono text-slate-400">
              {t('connectors.ingest.progressNoDenominator', { done: fmt(p.done) })}
            </p>
          )}

          <p className="mt-1 text-xs font-mono text-slate-500">{outcomeLine(p)}</p>
          <FolderRollup p={p} />
          {runLine}
        </Card>
      );
    }

    case 'complete':
      return (
        <Card
          tone="clean"
          title={p.skipped > 0 ? t('connectors.ingest.completeTitleWithSkips') : t('connectors.ingest.completeTitle')}
        >
          <p className="mt-1 text-xs font-mono text-slate-400">
            {p.selected > 0
              ? t('connectors.ingest.completeSummary', {
                  ingested: fmt(p.ingested),
                  selected: fmt(p.selected),
                })
              : t('connectors.ingest.completeSummaryNoDenominator', { ingested: fmt(p.ingested) })}
          </p>
          <OutcomeReasons counts={countsOf(p)} />
          <FolderRollup p={p} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onStartWorking}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded px-4 py-2 transition-colors"
            >
              {t('connectors.ingest.cta')} →
            </button>
          </div>
          {runLine}
        </Card>
      );

    case 'partial':
      return (
        <Card tone="partial" title={t('connectors.ingest.partialTitle')}>
          <p className="mt-1 text-xs font-mono text-slate-400">
            {t('connectors.ingest.partialSummary', {
              ingested: fmt(p.ingested),
              failed: fmt(p.failed),
            })}
          </p>
          <OutcomeReasons counts={countsOf(p)} />
          <FailureItemizationNote p={p} />
          <FolderRollup p={p} />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {p.ingested > 0 && (
              <button
                type="button"
                onClick={onStartWorking}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded px-4 py-2 transition-colors"
              >
                {t('connectors.ingest.cta')} →
              </button>
            )}
            {renderReviewLink(t('connectors.ingest.reviewCta'))}
          </div>
          {runLine}
        </Card>
      );

    case 'deferred':
      return (
        <Card tone="deferred" title={t('connectors.ingest.deferredTitle')}>
          <p className="mt-1 text-xs font-mono text-slate-400">
            {t('connectors.ingest.deferredSummary', {
              ingested: fmt(p.ingested),
              deferred: fmt(p.deferred),
            })}
          </p>
          <OutcomeReasons counts={countsOf(p)} />
          <FolderRollup p={p} />
          {p.ingested > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={onStartWorking}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded px-4 py-2 transition-colors"
              >
                {t('connectors.ingest.cta')} →
              </button>
            </div>
          )}
          {runLine}
        </Card>
      );

    case 'nothingRead':
      return (
        <Card tone="neutral" title={t('connectors.ingest.nothingReadTitle')}>
          <p className="mt-1 text-xs font-mono text-slate-400">
            {t('connectors.ingest.nothingReadSummary', { done: fmt(p.done) })}
          </p>
          <OutcomeReasons counts={countsOf(p)} />
          <FolderRollup p={p} />
          <div className="mt-3">{renderReviewLink(t('connectors.ingest.reviewCta'))}</div>
          {runLine}
        </Card>
      );

    case 'nothingDone':
      return (
        <Card tone="neutral" title={t('connectors.ingest.nothingDoneTitle')}>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            {p.selected > 0
              ? t('connectors.ingest.nothingDoneSelected', { selected: fmt(p.selected) })
              : t('connectors.ingest.nothingDoneEmptySelection')}
          </p>
          <div className="mt-3">{renderReviewLink(t('connectors.ingest.reviewCta'))}</div>
          {runLine}
        </Card>
      );

    case 'runFailed':
      return (
        <Card tone="error" title={t('connectors.ingest.failedTitle')}>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            {t('connectors.ingest.failedSummary', { ingested: fmt(p.ingested) })}
          </p>
          <OutcomeReasons counts={countsOf(p)} />
          <FailureItemizationNote p={p} />
          <FolderRollup p={p} />
          <div className="mt-3">{renderReviewLink(t('connectors.ingest.reviewCta'))}</div>
          {runLine}
        </Card>
      );

    case 'refused':
      return (
        <Card
          tone="error"
          title={
            view.reason === 'no_consent'
              ? t('connectors.ingest.refusedNoConsentTitle')
              : t('connectors.ingest.refusedUnsupportedTitle')
          }
        >
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            {view.reason === 'no_consent'
              ? t('connectors.ingest.refusedNoConsent')
              : t('connectors.ingest.refusedUnsupported')}
          </p>
          {view.reason === 'no_consent' && (
            <div className="mt-3">{renderReviewLink(t('connectors.ingest.reviewCta'))}</div>
          )}
          {runLine}
        </Card>
      );

    case 'unrecognized':
      return (
        <Card tone="neutral" title={t('connectors.ingest.unrecognizedTitle')}>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            {t('connectors.ingest.unrecognizedBody', { status: p.rawStatus })}
          </p>
          <p className="mt-1 text-xs font-mono text-slate-500">{outcomeLine(p)}</p>
          <OutcomeReasons counts={countsOf(p)} />
          {runLine}
        </Card>
      );

    default: {
      const _never: never = view;
      return _never;
    }
  }
};
