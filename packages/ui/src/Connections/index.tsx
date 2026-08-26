// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getLocale, t } from '../i18n/index.js';
import type { MessageKey } from '../i18n/types.js';
import { labelDisplay, useReducedMotion, useShelfmark, type PickedScope, type ShelfmarkProviderId } from '../provider.js';
import {
  connectorActivity,
  fileOutcomeStyle,
  IngestPanel,
  isConnectorActive,
  normalizeIngestProgress,
  type IngestProgress,
} from '../IngestStatus/index.js';
import { OutcomeReasons } from '../IngestStatus/index.js';

type Provider = ShelfmarkProviderId;

interface RecentFile {
  name: string;
  path: string;
  /** Four states since 34-S14d/e, not three. Typed as a bare string because
   *  it arrives off the wire from a worker that can ship a fifth before this
   *  build knows it — `fileOutcomeStyle` is total for exactly that reason. */
  status: string;
  /** 34-S14d/e — the named skip reason or deferral detail, truncated
   *  worker-side at 300 chars with a visible marker. */
  reason?: string;
}

export interface Connection {
  connectionId: string;
  provider: Provider;
  status: 'connected' | 'syncing' | 'error' | 'disconnected';
  rootFolderId: string | null;
  rootPath: string | null;
  defaultLabel: string | null;
  lastSyncAt: string | null;
  lastSyncStartedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncProgress: {
    discovered: number;
    ingested: number;
    skipped: number;
    failed: number;
    /** 34-S14e. Optional: a connection last synced by an older worker
     *  build has no such field until its next sync overwrites the whole
     *  progress object. `undefined` means "this run predates the counter",
     *  never zero, and every read below goes through `formatCount`/`?? 0`. */
    deferred?: number;
    /** 34-S14d — per-reason skip rollup over the closed vocabulary. */
    skippedByReason?: Record<string, number>;
    foldersScanned?: number;
    currentFolder?: string | null;
    recentFiles?: RecentFile[];
  };
  /** 34-S14c — recorded on EVERY finalize, zero included. */
  lastSyncDeltaExpiredFallbacks?: number;
  /** 34-S14f — the selective ingest's own progress, mirrored onto the
   *  connection document because that is the only place a browser can read
   *  it (no route serves `selective_ingest_runs`). Read through
   *  `normalizeIngestProgress`, never destructured raw. */
  lastIngestProgress?: unknown;
}

/** One parse per connection per render, shared by the poll predicate, the
 *  panel choice and the panel itself — three readers deriving the same shape
 *  three times is three chances to derive it differently. */
function ingestOf(c: Connection): IngestProgress | null {
  return normalizeIngestProgress(c.lastIngestProgress);
}

/** The connection reduced to just what decides which panel is the truth. */
function activityInputOf(c: Connection) {
  return {
    status: c.status,
    lastSyncStatus: c.lastSyncStatus,
    lastSyncAt: c.lastSyncAt,
    ingest: ingestOf(c),
  };
}

/**
 * 34-S15a — the tone of a finished all-at-once sync, decided in ONE place.
 *
 * The completion-tone fix exists because every card read "✓ Sync complete"
 * in green over 448 failures. That fix drove the colour AND the words from
 * the failure count, which was right and is kept. What it could not know is
 * that 34-S14e was about to add a fourth outcome: a file the sink DEFERRED —
 * which is NOT a failure (nothing is broken, its place is kept, it finishes
 * on its own once the sink accepts it) and must never be styled as one; that
 * parity with the deferred lane in @shelfmark/core's sink contract is the
 * whole point. So a run with deferrals and no failures gets its own tone and
 * its own words rather than being rounded to either neighbour.
 */
export type CompletionTone = 'clean' | 'partial' | 'deferred';

export function completionTone(p: { failed: number; deferred?: number }): CompletionTone {
  if (p.failed > 0) return 'partial';
  if ((p.deferred ?? 0) > 0) return 'deferred';
  return 'clean';
}

/** The counters the shared "why files were not read" rollup needs, read off
 *  a legacy sync's progress object so BOTH paths explain themselves through
 *  the same function and the same words. */
function syncCounts(p: Connection['lastSyncProgress']) {
  return {
    failed: p.failed,
    deferred: p.deferred ?? 0,
    skippedByReason: p.skippedByReason ?? {},
    skipped: p.skipped,
  };
}

/** "2m 14s" / "38s" — null if either timestamp is missing (sync never ran,
 * or hasn't reached a terminal state with lastSyncAt set yet). */
function formatDuration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!(ms > 0)) return null;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Files processed vs. files found so far — not a true ETA (discovered
 * keeps growing as more pages page in), but gives a live sense of motion. */
function syncPct(p: Connection['lastSyncProgress']): number {
  const processed = p.ingested + p.skipped + p.failed;
  if (p.discovered <= 0) return processed > 0 ? 100 : 8;
  return Math.max(8, Math.min(100, Math.round((processed / p.discovered) * 100)));
}

/** 1,247 not 1247 — matters once a sync is genuinely into the thousands, and
 * through Intl.NumberFormat(locale) so es-MX gets its own separators.
 * Defensive against undefined: connections synced before foldersScanned
 * existed won't have it until their next sync overwrites the whole
 * progress object. */
function formatCount(n: number | undefined): string {
  return new Intl.NumberFormat(getLocale()).format(n ?? 0);
}

/**
 * The browse contract (Plan 34-S07a). This package owns the JSON shapes;
 * the @shelfmark/api routes follow. GET /:id/browse?folderId&cursor returns
 * `{ items: BrowseItem[], nextCursor: string | null, truncated?: boolean }`.
 *
 * Two rules carry the whole change:
 *
 * 1. `nextCursor` is null IF AND ONLY IF the listing is complete. A
 *    non-null cursor the caller ignores is a caller bug; a null cursor on
 *    an incomplete listing is a SERVER bug, and is exactly the silent
 *    truncation this replaces (`@odata.nextLink` was being dropped, so any
 *    folder past ~200 children just stopped). The cursor is opaque here —
 *    server-side it wraps the provider's own continuation, which for Graph
 *    is a full URL that can carry credentials in its query string and must
 *    never reach this client.
 *
 * 2. `size` / `modified` / `childCount` are null ONLY for "the provider
 *    did not tell us", never as a stand-in for zero. A 0-byte file has
 *    size 0; an empty folder has childCount 0. Plan 34 step 10 renders
 *    "empty" and "contains N items reporting no size" as DIFFERENT
 *    absence states, so collapsing the two here would destroy the
 *    distinction before it ever reaches that screen.
 *
 * `truncated` is the server saying its own follow-the-cursor ceiling — a
 * documented 2,000-children bound in @shelfmark/graph — stopped the listing
 * rather than the end of the folder. It always travels with a non-null
 * cursor, and the picker states it rather than letting the generic partial
 * banner absorb it.
 */
export interface BrowseItem {
  id: string;
  name: string;
  isFolder: boolean;
  /** Bytes. null ONLY when the provider does not report it. */
  size: number | null;
  /** ISO-8601. null ONLY when the provider does not report it. */
  modified: string | null;
  /** Folders only; null when unknown. Files are always null. */
  childCount: number | null;
}

interface BrowsePage {
  items: BrowseItem[];
  /** null means THIS IS THE LAST PAGE. */
  nextCursor: string | null;
  /** True when the SERVER's own listing ceiling stopped this page short. */
  truncated: boolean;
}

/**
 * Defensive read of one item off the wire. `typeof x === 'number'` and not
 * `x || null`: the falsy test would rewrite a 0-byte file and an empty
 * folder as "not reported", which is the one distinction rule 2 above
 * exists to preserve. A field that is absent entirely (an older server
 * that has not shipped 34-S07a yet) reads as null — "not reported" — which
 * is true of it, and degrades to the old behaviour rather than crashing.
 */
function normalizeBrowseItem(raw: any): BrowseItem {
  const isFolder = raw?.isFolder === true;
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? ''),
    isFolder,
    size: typeof raw?.size === 'number' ? raw.size : null,
    modified: typeof raw?.modified === 'string' ? raw.modified : null,
    childCount: !isFolder ? null : typeof raw?.childCount === 'number' ? raw.childCount : null,
  };
}

/** Carries the transport status and the server's `retryAfterSeconds`
 * alongside its error code — 34-S06d needs the status for the legacy branch
 * below, and a throttle the caller cannot time is a throttle the caller
 * ignores. */
class BrowseFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null
  ) {
    super(code || `HTTP ${status}`);
    this.name = 'BrowseFailure';
  }
}

/**
 * Plan 34-S06d / 34-S09c. **These are the codes GET /:id/browse actually
 * sends** — read off the @shelfmark/api browse route (`sendBrowseFailure`,
 * plus the two guards ahead of the try block), not inferred. The table this
 * replaces matched codes that route has never emitted; every real failure
 * therefore fell through to the generic branch, and the generic branch tells
 * a customer to disconnect and reconnect their drive. For a folder they
 * deleted themselves that advice cannot work, and following it destroys a
 * working connection to find out.
 *
 * `connectors.browseScopeHint` — the "these two are indistinguishable"
 * sentence — is now the LEGACY branch only: a bare 404 carrying no code, from
 * a server predating 34-S09c and so genuinely unable to tell a missing
 * scope from a missing folder. When the server names the case, the client
 * says the named thing instead of hedging.
 */
const BROWSE_ERROR_MESSAGE_KEYS: Record<string, MessageKey> = {
  browse_scope_missing: 'connectors.browseScopeMissingHint',
  browse_folder_not_found: 'connectors.browseFolderNotFoundHint',
  connection_disconnected: 'connectors.browseDisconnectedHint',
  connectors_disabled_for_tenant: 'connectors.browseDisabledHint',
  sharepoint_site_required: 'connectors.sharepointSite.prompt',
  browse_failed: 'connectors.browseFailedHint',
};

/** The one code in this file the SERVER never sends — it is minted by
 * `fetchBrowsePage` when a 200 arrives carrying something we cannot read.
 * Named rather than anonymous so the sentence it selects is chosen by the
 * same table lookup as every other failure. */
const BROWSE_UNREADABLE_CODE = 'browse_unreadable_response';

/**
 * The connection guard answers `404 { error: "No connection <id>" }` when the
 * connection is absent OR belongs to another tenant. It never passes through
 * `sendBrowseFailure`, which is why it carries free-form prose instead of a
 * code and why an earlier pass missed it while reading that helper correctly.
 *
 * The prose is NEVER rendered — it is matched, and a written sentence is
 * rendered in its place. Matching is worth doing because the alternative was
 * the bare-404 branch below telling the customer to disconnect and reconnect
 * a drive over a connection that is not there to disconnect: destructive
 * advice for a case it cannot fix.
 */
function isConnectionMissingMessage(code: string | null): boolean {
  return code !== null && /^No connection\b/.test(code);
}

/** The code survives alongside the sentence because two branches of the UI
 * key off it: `sharepoint_site_required` opens the site form rather than
 * being a dead end, and a throttle keeps the "load the rest" control alive
 * so the reader can resume instead of starting the folder over. */
export interface BrowseErrorState {
  /** Present only for `browse_throttled`. Kept on the state because the
   *  WORDING depends on which recovery control the view ends up rendering,
   *  and that is not known here — see `browseFailureMessage`. */
  readonly retryAfterSeconds?: number | null;
  code: string | null;
  message: string;
}

function describeBrowseFailure(err: unknown): BrowseErrorState {
  if (err instanceof BrowseFailure) {
    if (err.code === 'browse_throttled') {
      return {
        code: err.code,
        retryAfterSeconds: err.retryAfterSeconds,
        message:
          err.retryAfterSeconds !== null
            ? t('connectors.browseThrottledHint', { seconds: err.retryAfterSeconds })
            : t('connectors.browseThrottledHintNoDelay'),
      };
    }
    const key = err.code ? BROWSE_ERROR_MESSAGE_KEYS[err.code] : undefined;
    if (key) return { code: err.code, message: t(key) };
    if (err.code === BROWSE_UNREADABLE_CODE) {
      return { code: err.code, message: t('connectors.browseUnreadableHint') };
    }
    // Everything from here down is named by STATUS, because everything from
    // here down comes from a guard that answers with prose instead of a code:
    // the host's auth/policy gateway (401 `Unauthorized`, 403 policy prose),
    // the connection lookup (404 `No connection <id>`), and anything that
    // fails outside the route's try block (a bare 5xx). None were in the
    // table, so all of them fell to `browseFailedHint`, which ends
    // "disconnect this drive and connect it again". For a session that has
    // expired that advice is self-defeating — reconnecting needs the very
    // session that just expired to complete the OAuth round trip — and for a
    // policy denial it is simply false.
    if (err.status === 401) return { code: err.code, message: t('connectors.browseSignedOutHint') };
    if (err.status === 403) return { code: err.code, message: t('connectors.browsePolicyDeniedHint') };
    if (err.status === 404) {
      if (isConnectionMissingMessage(err.code)) {
        return { code: err.code, message: t('connectors.browseConnectionGoneHint') };
      }
      // LEGACY ONLY, and now genuinely only: a 404 with NO body at all, from
      // a server predating 34-S09c that cannot tell a missing scope from a
      // missing folder. A 404 that names something is not that case, and used
      // to inherit this hedge — including the connection-level one above.
      if (err.code === null) return { code: err.code, message: t('connectors.browseScopeHint') };
    }
    if (err.status >= 500) return { code: err.code, message: t('connectors.browseServerErrorHint') };
    return { code: err.code, message: t('connectors.browseUnexpectedHint') };
  }
  return { code: null, message: t('connectors.browseError') };
}

/** "1.4 MB" / "0 B" — 0 is a real size and renders as one. */
function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Provider timestamps are ISO-8601. An unparseable one still came from the
 * provider, so it falls back to its own date part rather than claiming the
 * provider reported nothing. */
function formatModified(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The metadata line under a row's name — and the place the null-vs-zero rule
 * either survives or dies. `normalizeBrowseItem` preserves the distinction
 * off the wire; if the render then prints nothing for both, a 0-byte file and
 * a file whose size the provider withheld are identical on screen, which is
 * the distinction destroyed one layer later. So each absence gets its own
 * words:
 *
 *   size 0        → "0 B"                     (a real, reported size)
 *   size null     → "size not reported"       (the provider said nothing)
 *   childCount 0  → "empty"                   (a folder with nothing in it)
 *   childCount null → "item count not reported" (providers exist that report
 *                      no child count at all, by design)
 *
 * SIZE IS NOT A FILE-ONLY FACT. This was an if/else on `isFolder`, so a
 * folder got its child count and nothing else — and Graph reports a folder's
 * size, on the same request, through the widened `$select`
 * (`id,name,folder,size,lastModifiedDateTime`). On the one screen whose whole
 * purpose is deciding what to map, two folders of 12 items — one 4 MB of
 * memos, one 40 GB of video — were indistinguishable, because the render
 * discarded the number the server had already fetched. Folders now carry the
 * same size fact as files, under the same null-vs-zero rule, which is also
 * what step 10 needs in order to tell "empty" from "unknown".
 *
 * Returned as an array of strings rather than a joined sentence: the caller
 * renders them as separate nodes so the separator is markup, not translated
 * text, and nothing here escapes the parity gate by concatenation.
 */
function itemFacts(item: BrowseItem): string[] {
  const facts: string[] = [];
  if (item.isFolder) {
    facts.push(
      item.childCount === null
        ? t('connectors.browse.childCountUnknown')
        : item.childCount === 0
          ? t('connectors.browse.emptyMarker')
          : t('connectors.browse.childCount', { n: formatCount(item.childCount) })
    );
  }
  facts.push(item.size === null ? t('connectors.browse.sizeUnknown') : formatBytes(item.size));
  facts.push(item.modified === null ? t('connectors.browse.modifiedUnknown') : formatModified(item.modified));
  return facts;
}

/**
 * ONE view state for the picker body — the shape this screen was missing, and
 * the reason the same defect kept coming back wearing different clothes.
 *
 * Completeness used to be four independent booleans guarding four render
 * regions: `items.length > 0` for the list, `items.length === 0 && !error &&
 * cursor === null` for "This folder is empty", `items.length > 0` again for
 * the completeness banner and "Load the rest", and `cursor === null` for "Try
 * again". Between them they did not cover the state space. A listing with
 * ZERO rows and a LIVE cursor satisfied none of them and rendered a blank
 * panel: no rows, no empty state, no "this list is NOT complete", no way to
 * continue — under a breadcrumb and an enabled "Map this folder".
 *
 * That combination is not hypothetical. A provider can filter results AFTER
 * paging, so a folder whose leading pages hold only filtered-out entries
 * legitimately answers `items: []` with a live continuation; and a throttle
 * on page two of that same folder rendered "wait about 30 seconds, then load
 * the rest" with no load-the-rest control anywhere on the page.
 *
 * Patching each gate would have left the next hole. Everything that bears on
 * "what is true about this listing right now" — rows, cursor, failure,
 * in-flight — therefore collapses HERE, in one place, into a closed set of
 * states, and `BrowsePickerBody` renders that set exhaustively behind a
 * compile-time `never` check. Adding a sixth state without giving it a render
 * is a type error rather than a blank panel.
 *
 * The invariant every state holds: SAY SOMETHING TRUE ABOUT COMPLETENESS, or
 * say nothing about it while explicitly showing that work is still going on.
 * `complete` is reachable on exactly one path — no failure, cursor null — so
 * no truncated and no failed listing can present itself as the whole folder.
 */
export type BrowseView =
  /** Page one is in flight and nothing has been listed yet. The only state
   *  that makes no completeness claim, and it says outright it is working. */
  | { kind: 'loading' }
  /** The listing finished and the folder holds nothing. Empty AND complete —
   *  and unreachable while an error is present, which is what stops an
   *  unreadable 200 from being reported as an empty folder. */
  | { kind: 'empty' }
  /** The listing finished. Everything in the folder is on screen. */
  | { kind: 'complete'; items: BrowseItem[] }
  /** The listing stopped short with no failure — the auto-follow budget ran
   *  out, or the SERVER's own ceiling did (`serverTruncated`, stated as its
   *  own banner). `items` MAY BE EMPTY (the filtered-pages case above) and
   *  the state still owes the reader the truth and a way to continue. */
  | { kind: 'incomplete'; items: BrowseItem[]; busy: boolean; serverTruncated: boolean }
  /** A failure. Whatever was fetched before it is still correct and stays on
   *  screen; `recovery` names the one control that can move this forward. */
  | {
      kind: 'failed';
      items: BrowseItem[];
      error: BrowseErrorState;
      recovery: BrowseRecovery;
      busy: boolean;
    };

/** `site_form` — SharePoint was never told which site, so the form is the way
 * forward. `resume` — a cursor survived the failure, so the listing continues
 * from exactly where it stopped. `restart` — there is nothing to resume from,
 * so the folder starts over. Exactly one of the three, never zero. */
export type BrowseRecovery = 'site_form' | 'resume' | 'restart';

export interface BrowseViewInput {
  items: BrowseItem[];
  /** Non-null means the listing is NOT complete — the contract's own rule. */
  cursor: string | null;
  error: BrowseErrorState | null;
  /** Page one in flight. */
  loading: boolean;
  /** A later page in flight (auto-follow, or the reader asked). */
  loadingMore: boolean;
  /** The server said its own ceiling stopped the listing (rule 3 above). */
  serverTruncated?: boolean;
}

/**
 * The failure sentence, chosen WITH the recovery control in hand.
 *
 * These were picked independently and it went wrong in both directions.
 * `describeBrowseFailure` reads the error CODE; `browseView` reads the CURSOR.
 * A throttle mid-walk leaves a cursor, so the view renders "Load the rest" and
 * the throttle sentence naming it was right. A throttle on the FIRST request
 * leaves no cursor, so the view renders "Try again" while the same sentence
 * still said "then load the rest" — naming a button that is not on the screen.
 *
 * Every other code's wording is recovery-independent, so it passes through.
 */
export function browseFailureMessage(error: BrowseErrorState, recovery: BrowseRecovery): string {
  if (error.code !== 'browse_throttled') return error.message;
  const seconds = error.retryAfterSeconds ?? null;
  if (recovery === 'resume') {
    return seconds !== null
      ? t('connectors.browseThrottledHint', { seconds })
      : t('connectors.browseThrottledHintNoDelay');
  }
  return seconds !== null
    ? t('connectors.browseThrottledRetryHint', { seconds })
    : t('connectors.browseThrottledRetryHintNoDelay');
}

/**
 * The single place the picker's truth is decided. Pure, exported, and tested
 * over every combination of its inputs — a state machine that can be
 * enumerated is a state machine whose holes can be found by a test rather
 * than by a customer.
 *
 * Order matters and is deliberate:
 *  1. A FAILURE outranks everything. It is why `browse_unreadable_response`
 *     can never be mistaken for an empty folder: `empty` sits below this line.
 *  2. Page one in flight is next — nothing has been looked at yet, so nothing
 *     can yet be said about the folder.
 *  3. A LIVE CURSOR outranks emptiness. Zero rows plus a cursor is incomplete,
 *     not empty, and that is the state that used to render nothing at all.
 *  4. Only then: no failure, nothing in flight, cursor null. Now, and only
 *     now, the folder may be called empty or the listing called complete.
 */
export function browseView(input: BrowseViewInput): BrowseView {
  const { items, cursor, error, loading, loadingMore } = input;
  if (error) {
    return {
      kind: 'failed',
      items,
      error,
      recovery:
        error.code === 'sharepoint_site_required' ? 'site_form' : cursor !== null ? 'resume' : 'restart',
      busy: loading || loadingMore,
    };
  }
  if (loading) return { kind: 'loading' };
  if (cursor !== null) {
    return { kind: 'incomplete', items, busy: loadingMore, serverTruncated: input.serverTruncated === true };
  }
  if (items.length === 0) return { kind: 'empty' };
  return { kind: 'complete', items };
}

interface BrowsePickerBodyProps {
  view: BrowseView;
  /** Only used to key the SharePoint inputs to their own labels. */
  connectionId: string;
  sharepointHostname: string;
  sharepointSitePath: string;
  onSharepointHostnameChange: (value: string) => void;
  onSharepointSitePathChange: (value: string) => void;
  onSubmitSharepointSite: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpenFolder: (item: BrowseItem) => void;
}

/**
 * Renders `BrowseView` exhaustively. Every branch returns something a reader
 * can act on or learn from; the `never` at the bottom is the compile-time
 * guarantee that a state added later cannot silently render nothing.
 *
 * Exported so the exhaustiveness claim is testable directly — the test walks
 * every reachable combination of (items, cursor, error, loading, loadingMore)
 * and asserts the body is never blank, which is the assertion the four
 * independent booleans could not have passed.
 */
export const BrowsePickerBody: React.FC<BrowsePickerBodyProps> = ({
  view,
  connectionId,
  sharepointHostname,
  sharepointSitePath,
  onSharepointHostnameChange,
  onSharepointSitePathChange,
  onSubmitSharepointSite,
  onRetry,
  onLoadMore,
  onOpenFolder,
}) => {
  /* FILES ARE RENDERED. The picker used to `.filter(item => item.isFolder)` —
     a folder holding forty PDFs and no subfolders reported "No subfolders
     here", so the one product promise this screen exists to keep ("names
     before files") was broken by the render, after the server had returned
     the files and the parser had read them correctly. Folders stay clickable
     because they are the navigation; files are rows, not buttons, because
     there is nothing to open — which is the whole point of the step. */
  const rows = (items: BrowseItem[]) =>
    items.length === 0 ? null : (
      <ul className="max-h-56 overflow-y-auto divide-y divide-slate-800/60">
        {items.map((item, index) => {
          const facts = itemFacts(item);
          const body = (
            <>
              <span aria-hidden>{item.isFolder ? '📁' : '📄'}</span>
              <span className="sr-only">
                {item.isFolder ? t('connectors.browse.folderRowLabel') : t('connectors.browse.fileRowLabel')}
              </span>
              <span className="flex-1 truncate">{item.name}</span>
              <span className="shrink-0 text-[11px] font-mono text-slate-500">
                {facts.map((fact, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span aria-hidden> · </span>}
                    <span>{fact}</span>
                  </React.Fragment>
                ))}
              </span>
            </>
          );
          return (
            // Index-suffixed because the list only ever appends (paging never
            // reorders it), and a provider row that arrives with no id would
            // otherwise collide with the next one.
            <li key={`${item.id}-${index}`}>
              {item.isFolder ? (
                <button
                  type="button"
                  onClick={() => onOpenFolder(item)}
                  className="w-full text-left px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-900 rounded flex items-center gap-2"
                >
                  {body}
                </button>
              ) : (
                <div className="w-full px-2 py-1.5 text-sm text-slate-400 flex items-center gap-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    );

  /* The incompleteness statement and the control that acts on it, together —
     they are one fact stated twice, in words and in an affordance, and
     separating them is how a throttle message came to tell a customer to
     "load the rest" on a screen with no such button. The zero-row wording is
     its own sentence rather than "0 items so far", because a count of nothing
     is not a count. */
  const incompleteFooter = (count: number, busy: boolean) => (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <p className="text-[11px] font-mono text-amber-300">
        {count > 0
          ? t('connectors.browse.partial', { n: formatCount(count) })
          : t('connectors.browse.partialNone')}
      </p>
      <button
        type="button"
        onClick={onLoadMore}
        disabled={busy}
        className="text-xs font-semibold text-amber-200 border border-amber-800 rounded px-3 py-1.5 hover:border-amber-600 disabled:opacity-40"
      >
        {busy ? t('connectors.browse.loadingMore') : t('connectors.browse.loadMore')}
      </button>
    </div>
  );

  switch (view.kind) {
    case 'loading':
      return <p className="text-xs text-slate-500 py-3">{t('connectors.browsing')}</p>;

    case 'empty':
      return <p className="px-2 py-3 text-xs text-slate-500">{t('connectors.browse.folderEmpty')}</p>;

    case 'complete':
      return (
        <>
          {rows(view.items)}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="text-[11px] font-mono text-slate-500">
              {t('connectors.browse.complete', { n: formatCount(view.items.length) })}
            </p>
          </div>
        </>
      );

    case 'incomplete':
      return (
        <>
          {rows(view.items)}
          {/* The SERVER's own ceiling is a different fact from the client's
              auto-follow budget, so it gets its own stated banner instead of
              hiding inside the generic partial line (34-S07b's rule: every
              bound states itself). */}
          {view.serverTruncated && (
            <p role="status" className="mt-2 text-[11px] font-mono text-amber-300">
              {t('connectors.browse.serverTruncated')}
            </p>
          )}
          {incompleteFooter(view.items.length, view.busy)}
        </>
      );

    case 'failed':
      return (
        <>
          {/* A failure no longer replaces the list. Page 6 throttling does not
              unmake pages 1–5, so the rows already fetched stay on screen
              underneath this and the cursor that resumes them is still held. */}
          <div className="mb-2 border border-rose-900/60 rounded bg-rose-950/20 px-3 py-2">
            <p className="text-xs text-rose-300 leading-relaxed">
              {browseFailureMessage(view.error, view.recovery)}
            </p>
            {view.recovery === 'site_form' ? (
              /* Not a dead end any more. The token says who the customer is,
                 never which SharePoint site they mean, so the server answers
                 400 until it is told — and the browse request had never sent
                 it. They paste it from their own address bar; the server
                 persists the resolved drive on the connection, so this is
                 asked once per connection. */
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div>
                  <label
                    htmlFor={`sp-host-${connectionId}`}
                    className="block text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1"
                  >
                    {t('connectors.sharepointSite.hostnameLabel')}
                  </label>
                  <input
                    id={`sp-host-${connectionId}`}
                    type="text"
                    value={sharepointHostname}
                    onChange={(e) => onSharepointHostnameChange(e.target.value)}
                    placeholder={t('connectors.sharepointSite.hostnamePlaceholder')}
                    className="bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-blue-700"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`sp-path-${connectionId}`}
                    className="block text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1"
                  >
                    {t('connectors.sharepointSite.pathLabel')}
                  </label>
                  <input
                    id={`sp-path-${connectionId}`}
                    type="text"
                    value={sharepointSitePath}
                    onChange={(e) => onSharepointSitePathChange(e.target.value)}
                    placeholder={t('connectors.sharepointSite.pathPlaceholder')}
                    className="bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-blue-700"
                  />
                </div>
                <button
                  type="button"
                  onClick={onSubmitSharepointSite}
                  disabled={!sharepointHostname.trim() || !sharepointSitePath.trim()}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 text-xs font-semibold rounded px-3 py-1.5 border border-slate-700 transition-colors"
                >
                  {t('connectors.sharepointSite.submit')}
                </button>
              </div>
            ) : view.recovery === 'restart' ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={view.busy}
                className="mt-2 text-xs font-semibold text-rose-200 border border-rose-800 rounded px-3 py-1.5 hover:border-rose-600 disabled:opacity-40"
              >
                {t('connectors.browseRetry')}
              </button>
            ) : null}
          </div>
          {rows(view.items)}
          {view.recovery === 'resume' ? (
            // The cursor outlived the failure, so the honest statement is the
            // same one a budget-exhausted listing makes, and so is the control.
            incompleteFooter(view.items.length, view.busy)
          ) : view.items.length > 0 ? (
            // Rows on screen, no cursor to resume from, and a failure: we do
            // not know whether this is all of the folder, so we say exactly
            // that rather than counting what we happen to hold.
            //
            // CURRENTLY UNREACHABLE, deliberately retained. A failure is only
            // ever recorded with a null cursor on the first page of a browse,
            // and both callers pass an empty accumulator there — so today
            // `items.length > 0` implies a live cursor and the branch above
            // wins. It stays because this whole component exists to guarantee
            // no state renders nothing true, and deleting the fallback that
            // enforces that on the argument that nothing reaches it today is
            // precisely how the blank-panel hole came back twice. It is
            // covered as a unit, through `browseView` directly; read that test
            // as pinning the fallback's wording, not as a customer path.
            <p className="mt-2 text-[11px] font-mono text-amber-300">
              {t('connectors.browse.incompleteUnknown')}
            </p>
          ) : null}
        </>
      );

    default: {
      // Compile-time exhaustiveness. If a state is added above without a
      // branch here, this line stops the build — which is the whole point:
      // the previous shape let an uncovered combination render a blank panel
      // at RUNTIME, in front of a customer, with nothing to notice it.
      const _never: never = view;
      return _never;
    }
  }
};

const SYNCING_POLL_MS = 1500;

/**
 * How many pages a single browse follows on its own before handing the
 * reader an explicit control. Acceptance for 34-S07b is "a folder with 500
 * children lists 500 children", which this clears comfortably at any sane
 * provider page size. It is bounded rather than unbounded because a drive
 * can hold a pathological folder (hundreds of thousands of items in one is a
 * real shape), and a picker that hangs the tab enumerating one is not an
 * improvement on a picker that truncates. When the budget runs out the list
 * does NOT quietly stop: `nextCursor` is still non-null, `browseCursor`
 * holds it, and `browseView` therefore returns `incomplete` — which renders
 * "… this list is NOT complete" over a "Load the rest" button, and does so
 * whether the budget bought a thousand rows or (a provider filtering results
 * after paging) none at all. `complete` is reachable only with a null cursor
 * and no failure, so there is no state in which a truncated listing presents
 * itself as the whole folder.
 */
const MAX_AUTO_PAGES = 12;

export interface ConnectionsProps {
  /** The `error` value from the host's OAuth callback redirect, if any. */
  oauthError?: string | null;
  /** A connection id the host's OAuth callback just created — the folder
   *  picker auto-opens for it. One-shot: the host owns clearing its own
   *  query params (`onNoticeConsumed` fires when this component has acted). */
  autoBrowseConnectionId?: string | null;
  onNoticeConsumed?: () => void;
}

// Document ingestion connectors. Open to any authenticated tenant user (not
// admin-gated) — deliberately: the effective label is capped to the host's
// LabelPolicy for the connecting user either way, so a connector isn't a
// bigger privilege grant than any other ingest path in terms of what ends up
// visible in the tenant's corpus. The host decides which route guards wrap
// the page this renders on.
export const Connections: React.FC<ConnectionsProps> = ({
  oauthError = null,
  autoBrowseConnectionId = null,
  onNoticeConsumed,
}) => {
  const config = useShelfmark();
  const { transport, routes, labels, providers } = config;
  // Both progress bars move (a width transition plus a pulse). 34-S09's
  // precedent: JS-reachable motion branches on the hook, CSS-only motion is
  // silenced in the stylesheet. Tailwind's `animate-pulse` is neither —
  // it is a class this component chooses — so it is dropped here.
  const reducedMotion = useReducedMotion();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Provider | null>(null);

  // Root-folder picker state, one connection at a time.
  const [browsingId, setBrowsingId] = useState<string | null>(null);
  const [browseStack, setBrowseStack] = useState<{ id: string | null; name: string }[]>([
    { id: null, name: t('connectors.rootLabel') },
  ]);
  const [browseItems, setBrowseItems] = useState<BrowseItem[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseLoadingMore, setBrowseLoadingMore] = useState(false);
  /** The cursor for the NEXT page. null means the listing is complete —
   * that equivalence is the contract, and the UI below leans on it. */
  const [browseCursor, setBrowseCursor] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<BrowseErrorState | null>(null);
  /** The server said its own listing ceiling stopped the last page short. */
  const [browseServerTruncated, setBrowseServerTruncated] = useState(false);
  /** SharePoint only. The token identifies a person, not a site, so the first
   * browse of a SharePoint connection answers 400 `sharepoint_site_required`
   * until the customer pastes the site from their own SharePoint URL. Held
   * per-picker-session; the server persists the resolved `driveId` on the
   * connection, so this is asked once and never again for that connection. */
  const [sharepointHostname, setSharepointHostname] = useState('');
  const [sharepointSitePath, setSharepointSitePath] = useState('');
  const sharepointSite = useRef<{ hostname: string; sitePath: string } | null>(null);
  // Guards against a slow page from a folder the reader has already left
  // appending into the folder they are looking at now. Without it, paging
  // plus a fast breadcrumb click silently mixes two folders' children into
  // one list.
  const browseRequest = useRef(0);
  const [startingSyncId, setStartingSyncId] = useState<string | null>(null);
  /** Plan 34-S06a — which provider's consent handoff is on screen, if any.
   * Set by the connect buttons; the redirect only fires from inside it. */
  const [handoffProvider, setHandoffProvider] = useState<Provider | null>(null);

  // `silent` skips the loading flag for background polling refreshes during
  // a sync — without it, the whole panel (progress bar, recent-files list)
  // unmounted to a bare "Loading…" line every SYNCING_POLL_MS tick, which is
  // what read as "the screen is flashing while uploading."
  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const res = await fetch(transport.baseUrl, { headers: transport.headers() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        setConnections(body.connections ?? []);
      } catch (err: any) {
        setError(err?.message || t('connectors.listError'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [transport]
  );

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-open the folder picker for a freshly-connected drive. The host
  // clears its own one-shot query params via onNoticeConsumed.
  useEffect(() => {
    if (autoBrowseConnectionId) {
      setBrowsingId(autoBrowseConnectionId);
      setBrowseStack([{ id: null, name: t('connectors.rootLabel') }]);
      onNoticeConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBrowseConnectionId]);

  // Poll while any connection has work in flight. Keyed off a derived boolean
  // (not the `connections` array itself) so the interval isn't torn down
  // and recreated on every single poll tick — it only restarts when work
  // actually starts/stops.
  //
  // 34-S14f: this was `c.status === 'syncing'` alone, and the selective
  // ingest NEVER writes that field — it writes `lastIngestProgress` and
  // leaves `status` at 'connected'. A customer who had just consented at
  // step 13 therefore landed on a panel that would not move until they
  // reloaded the page by hand. `isConnectorActive` reads both records.
  const anyActive = connections.some((c) => isConnectorActive(activityInputOf(c)));
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(() => refresh(true), SYNCING_POLL_MS);
    return () => clearInterval(id);
  }, [anyActive, refresh]);

  const startConnect = async (provider: Provider) => {
    setConnecting(provider);
    try {
      const res = await fetch(`${transport.baseUrl}/microsoft/authorize?target=${provider}`, {
        method: 'POST',
        headers: transport.headers(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || t('connectors.connectError'));
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err?.message || t('connectors.connectError'));
      setConnecting(null);
    }
  };

  /** One page of the browse contract. Throws BrowseFailure so the caller
   * can tell a missing scope from a transport failure (34-S06d). */
  const fetchBrowsePage = useCallback(
    async (connectionId: string, folderId: string | null, cursor: string | null): Promise<BrowsePage> => {
      const qs = new URLSearchParams();
      if (folderId) qs.set('folderId', folderId);
      if (cursor) qs.set('cursor', cursor);
      // SharePoint's drive cannot be derived from the token — the server
      // needs the site hostname and server-relative path to resolve the
      // document library, and answers 400 `sharepoint_site_required` without
      // them. Omitted entirely for OneDrive, which resolves on its own.
      if (sharepointSite.current) {
        qs.set('sharepointHostname', sharepointSite.current.hostname);
        qs.set('sharepointSitePath', sharepointSite.current.sitePath);
      }
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const res = await fetch(`${transport.baseUrl}/${connectionId}/browse${suffix}`, {
        headers: transport.headers(),
      });
      // This was `await res.json().catch(() => ({}))`, and on a 200 that one
      // `.catch` was the difference between a failure and a lie. `res.ok` is
      // already true because the headers arrived, so a body that will not
      // parse raises nothing: `items` then read as `[]` (Array.isArray of
      // undefined is false) and `nextCursor` read as null (undefined is not a
      // string) — which is the contract's own definition of "this listing is
      // COMPLETE". A payload nobody could read rendered as "This folder is
      // empty." with no banner, no retry, and an enabled "Map this folder"
      // beneath it. A malformed payload is a FAILURE and is raised as one.
      let body: any = null;
      let readable = true;
      try {
        body = await res.json();
      } catch {
        readable = false;
      }
      if (!res.ok) {
        // An unreadable ERROR body is not the same problem: the status alone
        // still says something true, and every status has its own sentence.
        throw new BrowseFailure(
          res.status,
          typeof body?.error === 'string' ? body.error : null,
          typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : null
        );
      }
      if (!readable || body === null || typeof body !== 'object' || !Array.isArray(body.items)) {
        // A 200 carrying no `items` array is the same defect as an unparseable
        // one — we do not know what is in this folder — and "nothing" is the
        // one answer that must never be inferred from not knowing.
        throw new BrowseFailure(res.status, BROWSE_UNREADABLE_CODE, null);
      }
      return {
        items: body.items.map(normalizeBrowseItem),
        // Anything that is not a non-empty string is "complete". An older
        // server omits the field entirely and lands here, which is the
        // pre-34-S07a single-page behaviour rather than a false claim of
        // completeness introduced by this client.
        nextCursor: typeof body?.nextCursor === 'string' && body.nextCursor.length > 0 ? body.nextCursor : null,
        truncated: body?.truncated === true,
      };
    },
    [transport]
  );

  /**
   * Follows `nextCursor` until it is null, so a 500-child folder lists 500
   * children (34-S07b acceptance) instead of stopping at whatever the
   * provider chose to put in page one. Items are committed to state after
   * every page rather than at the end, so the list fills in front of the
   * reader instead of sitting behind a spinner; `browseCursor` is committed
   * with them, so at every instant the completeness banner below describes
   * the list actually on screen.
   */
  const runBrowse = useCallback(
    async (connectionId: string, folderId: string | null, startCursor: string | null, existing: BrowseItem[]) => {
      const reqId = ++browseRequest.current;
      const isFirstPage = startCursor === null;
      if (isFirstPage) {
        setBrowseLoading(true);
        setBrowseItems([]);
        setBrowseCursor(null);
      } else {
        setBrowseLoadingMore(true);
      }
      setBrowseError(null);
      setBrowseServerTruncated(false);
      let acc = existing;
      let cursor = startCursor;
      try {
        for (let page = 0; page < MAX_AUTO_PAGES; page++) {
          const body = await fetchBrowsePage(connectionId, folderId, cursor);
          if (reqId !== browseRequest.current) return; // superseded — a different folder is on screen
          acc = acc.concat(body.items);
          cursor = body.nextCursor;
          setBrowseItems(acc);
          setBrowseCursor(cursor);
          setBrowseServerTruncated(body.truncated);
          if (page === 0) setBrowseLoading(false);
          if (cursor === null) break;
          setBrowseLoadingMore(true);
        }
      } catch (err: unknown) {
        if (reqId !== browseRequest.current) return;
        setBrowseError(describeBrowseFailure(err));
        // The items already fetched are STILL CORRECT — page 6 throttling
        // does not unmake pages 1 through 5. Discarding them (which this did)
        // threw away a thousand good rows to report one bad request, and took
        // the cursor with them, so the only recovery left was to re-walk the
        // whole folder from the top. Both survive: the list keeps what it has,
        // and `cursor` still points at the page that failed, so "Load the
        // rest" resumes from exactly there.
        setBrowseItems(acc);
        setBrowseCursor(cursor);
      } finally {
        if (reqId === browseRequest.current) {
          setBrowseLoading(false);
          setBrowseLoadingMore(false);
        }
      }
    },
    [fetchBrowsePage]
  );

  /** Resumes from the committed cursor, keeping everything already listed.
   * Wired to the "Load the rest" button — the control whose PRESENCE is the
   * statement that the list on screen is not the whole folder. */
  const loadMoreBrowse = useCallback(() => {
    if (!browsingId || browseCursor === null || browseLoadingMore) return;
    const current = browseStack[browseStack.length - 1]!;
    runBrowse(browsingId, current.id, browseCursor, browseItems);
  }, [browsingId, browseCursor, browseLoadingMore, browseStack, browseItems, runBrowse]);

  /** Starts the current folder over from page one — for a failure that took
   * the whole listing with it (page one itself, or a SharePoint site that had
   * not been named yet), where there is no cursor to resume from. */
  const retryBrowse = useCallback(() => {
    if (!browsingId) return;
    const current = browseStack[browseStack.length - 1]!;
    runBrowse(browsingId, current.id, null, []);
  }, [browsingId, browseStack, runBrowse]);

  const submitSharepointSite = useCallback(() => {
    if (!sharepointHostname.trim() || !sharepointSitePath.trim()) return;
    sharepointSite.current = {
      hostname: sharepointHostname.trim(),
      sitePath: sharepointSitePath.trim(),
    };
    retryBrowse();
  }, [sharepointHostname, sharepointSitePath, retryBrowse]);

  // A SharePoint site named for one connection says nothing about the next
  // one, and carrying it across would silently browse the wrong library.
  // Declared ahead of the browse effect so the reset lands first.
  useEffect(() => {
    sharepointSite.current = null;
    setSharepointHostname('');
    setSharepointSitePath('');
  }, [browsingId]);

  useEffect(() => {
    if (!browsingId) return;
    const current = browseStack[browseStack.length - 1]!;
    runBrowse(browsingId, current.id, null, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsingId, browseStack, runBrowse]);

  /**
   * The picker's truth, derived ONCE, here, from every input that bears on
   * it — and then rendered exhaustively. Four independent booleans in the JSX
   * used to decide this between them, and the combination they all missed
   * (zero rows, live cursor) rendered a blank panel that claimed nothing and
   * offered nothing. There is now no way to add a render region that forgets
   * a case, because there is only one region and it switches on a closed set.
   */
  const browsePickerView = browseView({
    items: browseItems,
    cursor: browseCursor,
    error: browseError,
    loading: browseLoading,
    loadingMore: browseLoadingMore,
    serverTruncated: browseServerTruncated,
  });

  const openFolder = (item: BrowseItem) => {
    setBrowseStack((prev) => [...prev, { id: item.id, name: item.name }]);
  };

  const goToBreadcrumb = (index: number) => {
    setBrowseStack((prev) => prev.slice(0, index + 1));
  };

  /**
   * Plan 34-S08a — "Map this folder" is the ENTRY into the map flow, not a
   * sync. This used to POST /:id/sync directly (the fused two-consents-in-
   * one-button design the whole journey exists to split); it now carries the
   * picked scope to the host's map page via `routes.onOpenMap`, where the
   * consent stage shows the disclosure and the consent grant + map start
   * happen. Ingest (`POST /:id/sync`) moves behind its own consent at step
   * 13 — `resyncExisting` below still serves the already-synced retry paths.
   */
  const goToMapFlow = (connectionId: string) => {
    const current = browseStack[browseStack.length - 1]!;
    const rootPath = browseStack
      .slice(1)
      .map((s) => s.name)
      .join('/');
    const scope: PickedScope = {
      rootFolderId: current.id,
      rootPath: rootPath ? `/${rootPath}` : '/',
    };
    if (routes.onOpenMap) routes.onOpenMap(connectionId, scope);
    else window.location.assign(routes.map(connectionId));
  };

  /** Re-runs sync with the connection's already-chosen folder/label — no
   * need to re-open the folder picker. Failed files from the last sync get
   * automatically retried (the workers dedupe on remoteFileId and reuse
   * failed rows in place, or re-fetch them directly by id since delta
   * wouldn't otherwise resurface an unchanged file). */
  const resyncExisting = async (c: Connection) => {
    setStartingSyncId(c.connectionId);
    try {
      const res = await fetch(`${transport.baseUrl}/${c.connectionId}/sync`, {
        method: 'POST',
        headers: { ...transport.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rootFolderId: c.rootFolderId,
          rootPath: c.rootPath,
          defaultLabel: c.defaultLabel,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || t('connectors.syncError'));
      await refresh();
    } catch (err: any) {
      setError(err?.message || t('connectors.syncError'));
    } finally {
      setStartingSyncId(null);
    }
  };

  const disconnect = async (connectionId: string) => {
    try {
      const res = await fetch(`${transport.baseUrl}/${connectionId}`, {
        method: 'DELETE',
        headers: transport.headers(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err: any) {
      setError(err?.message || t('connectors.disconnectError'));
    }
  };

  /** The label the sync path still carries (34-S07c): the host's FIRST
   * offered label, stated rather than asked — classification is decided at
   * step 13, where the map supplies the evidence. With no labels configured
   * the note is hidden entirely (there is no label vocabulary to state). */
  const carriedLabel = labels.length > 0 ? labels[0] : null;

  const providerNameKey = (p: Provider): MessageKey =>
    p === 'onedrive' ? 'connectors.connectOneDrive' : 'connectors.connectSharePoint';

  return (
    <div className="space-y-6">
      {oauthError && (
        <p className="text-xs font-mono text-rose-400 border border-rose-900 bg-rose-950/30 rounded px-3 py-2">
          {t('connectors.oauthError', { error: oauthError })}
        </p>
      )}

      <section className="bg-slate-900 border border-slate-800 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-200 mb-1">{t('connectors.connectTitle')}</h2>
        <p className="text-xs text-slate-500 mb-4">{t('connectors.connectSubtitle')}</p>
        <div className="flex flex-wrap gap-3">
          {providers.map((provider, i) => (
            <button
              key={provider}
              type="button"
              onClick={() => setHandoffProvider(provider)}
              disabled={connecting !== null}
              className={
                i === 0
                  ? 'bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded px-4 py-2 transition-colors'
                  : 'bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 text-sm font-semibold rounded px-4 py-2 border border-slate-700 transition-colors'
              }
            >
              {connecting === provider ? t('connectors.connecting') : t(providerNameKey(provider))}
            </button>
          ))}
        </div>

        {/* Plan 34-S06a. The next thing this customer sees is a screen we
            did not write, asking for read access to their entire drive,
            under a publisher the provider may still report as unverified.
            They will be alarmed by it and they will blame us. Saying whose
            screen it is BEFORE the redirect — and repeating the two-verb
            promise the first-run card already made — is the difference
            between a surprise and an expectation being met. It renders
            here, in the flow, rather than as a modal: nothing is blocked,
            and "Not now" is a real answer. */}
        {handoffProvider && (
          <div className="mt-4 border border-blue-900/60 rounded-lg bg-blue-950/20 p-4">
            <p className="text-sm font-semibold text-slate-100">
              {t('connectors.oauthHandoff.title', { grantor: t('connectors.grantor.microsoft') })}
            </p>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed max-w-2xl">
              {t('connectors.oauthHandoff.body')}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => startConnect(handoffProvider)}
                disabled={connecting !== null}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded px-4 py-2 transition-colors"
              >
                {connecting !== null
                  ? t('connectors.connecting')
                  : t('connectors.oauthHandoff.continue', { grantor: t('connectors.grantor.microsoft') })}
              </button>
              <button
                type="button"
                onClick={() => setHandoffProvider(null)}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                {t('connectors.oauthHandoff.cancel')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        {loading ? (
          <p className="p-5 text-xs text-slate-500">{t('connectors.loading')}</p>
        ) : error ? (
          <p className="p-5 text-xs font-mono text-rose-400">{error}</p>
        ) : connections.length === 0 ? (
          <p className="p-5 text-xs text-slate-500">{t('connectors.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {connections.map((c) => {
              // 34-S14f — which of the two progress records this connection
              // owes the customer RIGHT NOW, decided once. What stood here
              // was three independent boolean guards over three regions,
              // none of which knew about `lastIngestProgress`: a customer
              // arriving from step 13 saw the older all-or-nothing sync
              // panel, reporting a crawl that might be weeks old, with no
              // sign at all that the read they had just approved was
              // running.
              const activity = connectorActivity(activityInputOf(c));
              const progress = c.lastSyncProgress;
              return (
                <li key={c.connectionId} className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-100">{t(providerNameKey(c.provider))}</p>
                      <p className="text-xs font-mono text-slate-500 mt-0.5">
                        {c.rootPath ? c.rootPath : t('connectors.noRootYet')}
                        {c.defaultLabel ? ` · ${labelDisplay(labels, c.defaultLabel)}` : ''}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-mono uppercase tracking-widest px-2 py-1 rounded border ${
                        c.status === 'syncing'
                          ? 'text-blue-300 border-blue-700 bg-blue-950/40'
                          : c.status === 'error'
                            ? 'text-rose-300 border-rose-800 bg-rose-950/40'
                            : c.status === 'disconnected'
                              ? 'text-slate-500 border-slate-800'
                              : 'text-emerald-300 border-emerald-800 bg-emerald-950/30'
                      }`}
                    >
                      {t(`connectors.status.${c.status}` as MessageKey)}
                    </span>
                  </div>

                  {/* ── The all-at-once sync, mid-crawl. ────────────────
                      34-S14f: "Scanning" was accurate when this panel was
                      written and is not accurate now. The crawl opens every
                      file it finds, downloads it, and hands it to the parser
                      — that is reading, not scanning, and the word has to
                      change when the act does. "Scanning" now belongs to the
                      map (step 9), which really does look at names only. */}
                  {activity.kind === 'syncing' && (
                    <div className="mt-3 border border-blue-900/50 rounded-lg bg-blue-950/10 p-3">
                      <p className="text-xs font-mono text-blue-300">
                        {t('connectors.reading.title', {
                          provider: t(`connectors.provider.${c.provider}` as MessageKey),
                        })}
                      </p>

                      {/* Stable, large numbers rather than fast-scrolling text —
                          on a sync spanning thousands of items, a small mono
                          line replacing itself every poll reads as flicker, not
                          progress. These two counts only ever grow. */}
                      <div className="mt-2 grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-2xl font-bold tabular-nums text-slate-100">
                            {formatCount(progress.ingested)}
                          </p>
                          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                            {t('connectors.syncing.filesIngestedLabel')}
                          </p>
                        </div>
                        <div>
                          <p className="text-2xl font-bold tabular-nums text-slate-100">
                            {formatCount(progress.foldersScanned)}
                          </p>
                          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                            {t('connectors.syncing.foldersScannedLabel')}
                          </p>
                        </div>
                      </div>

                      {progress.currentFolder && (
                        <p className="mt-2 text-xs font-mono text-slate-400 truncate">
                          {t('connectors.syncing.currentFolder', { folder: progress.currentFolder })}
                        </p>
                      )}
                      <div className="mt-2 h-1 w-full bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full bg-blue-500 rounded ${
                            reducedMotion ? '' : 'transition-all duration-500 animate-pulse'
                          }`}
                          style={{ width: `${syncPct(progress)}%` }}
                        />
                      </div>
                      <p className="mt-2 text-xs font-mono text-slate-500">
                        {t('connectors.syncing.counts', {
                          folders: formatCount(progress.foldersScanned),
                          discovered: formatCount(progress.discovered),
                          ingested: formatCount(progress.ingested),
                          skipped: formatCount(progress.skipped),
                          deferred: formatCount(progress.deferred),
                          failed: formatCount(progress.failed),
                        })}
                      </p>
                      {(progress.recentFiles?.length ?? 0) > 0 && (
                        <div className="mt-3 border border-slate-800/70 rounded-md bg-slate-950/60 p-2">
                          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1.5">
                            {t('connectors.syncing.recentTitle')}
                          </p>
                          <ul className="space-y-1 max-h-40 overflow-y-auto">
                            {progress.recentFiles!.map((f, i) => {
                              // Four states, and the glyph never carries one
                              // alone: the colour is decorative and the WORD
                              // is what a screen reader gets. The three
                              // `connectors.fileStatus.*` strings had been
                              // sitting in both dictionaries unused since the
                              // panel shipped, because nothing rendered them.
                              const style = fileOutcomeStyle(f.status);
                              return (
                                <li key={`${f.path}-${f.name}-${i}`} className="text-xs font-mono">
                                  <div className="flex items-center gap-2">
                                    <span aria-hidden className={style.className}>
                                      {style.icon}
                                    </span>
                                    <span className="sr-only">{style.label}</span>
                                    <span className="truncate text-slate-300">{f.name}</span>
                                    <span className="truncate text-slate-600">{f.path}</span>
                                  </div>
                                  {f.reason && (
                                    <p className="pl-5 text-[11px] text-slate-500 break-words">{f.reason}</p>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── The selective ingest: step 13's own read. ─────────── */}
                  {activity.kind === 'ingest' && (
                    <IngestPanel
                      view={activity.view}
                      reducedMotion={reducedMotion}
                      onStartWorking={() =>
                        routes.onStartWorking?.({ scopePath: c.rootPath, scopeLabel: c.rootPath || '/' })
                      }
                      renderReviewLink={(label) =>
                        routes.renderLink(
                          routes.map(c.connectionId),
                          <span className="inline-block bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-semibold rounded px-4 py-2 border border-slate-700 transition-colors">
                            {label}
                          </span>
                        )
                      }
                    />
                  )}

                  {activity.kind === 'syncComplete' &&
                    (() => {
                      // A sync that finished is NOT the same as a sync that
                      // worked. Measured live 2026-08-19: five connectors
                      // reported "✓ Sync complete" in green over 448 failures
                      // out of 548 files — an 18.8% success rate, presented
                      // above a button reading "Start working with these
                      // files". The customer has no way to tell.
                      //
                      // The outcome drives BOTH the colour and the words, and
                      // never colour alone: a green tick with a failure count
                      // beside it still reads as success at a glance. Three
                      // tones now, not two — 34-S14e's sink-deferred files
                      // are not failures and are not styled as any kind of
                      // alarm.
                      const tone = completionTone(progress);
                      const partial = tone === 'partial';
                      const deferredTone = tone === 'deferred';
                      const box = partial
                        ? 'border-amber-900/60 bg-amber-950/20'
                        : deferredTone
                          ? 'border-sky-900/60 bg-sky-950/20'
                          : 'border-emerald-900/60 bg-emerald-950/20';
                      const accent = partial ? 'text-amber-400' : deferredTone ? 'text-sky-400' : 'text-emerald-400';
                      const heading = partial ? 'text-amber-200' : deferredTone ? 'text-sky-200' : 'text-emerald-200';
                      const glyph = partial ? '!' : deferredTone ? '⏸' : '✓';
                      const title = partial
                        ? t('connectors.complete.titlePartial')
                        : deferredTone
                          ? t('connectors.complete.titleDeferred')
                          : t('connectors.complete.title');
                      const fallbacks = c.lastSyncDeltaExpiredFallbacks ?? 0;
                      const retryButton = (
                        <button
                          type="button"
                          onClick={() => resyncExisting(c)}
                          disabled={startingSyncId === c.connectionId}
                          className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 text-sm font-semibold rounded px-4 py-2 border border-slate-700 transition-colors"
                        >
                          {startingSyncId === c.connectionId
                            ? t('connectors.startingSync')
                            : t('connectors.retryFailed')}
                        </button>
                      );
                      return (
                        <div className={`mt-3 border rounded-lg p-3 ${box}`}>
                          <div className="flex items-center gap-2">
                            <span aria-hidden className={accent}>
                              {glyph}
                            </span>
                            <p className={`text-sm font-semibold ${heading}`}>{title}</p>
                          </div>
                          {progress.discovered === 0 ? (
                            <>
                              <p className="mt-1 text-xs font-mono text-slate-400">
                                {(progress.foldersScanned ?? 0) > 0
                                  ? t('connectors.complete.emptySummary', {
                                      folders: formatCount(progress.foldersScanned),
                                    })
                                  : t('connectors.complete.emptySummaryNoFolders')}
                              </p>
                              {/* Reachable, and it used to render a contradiction.
                                  The retry pass runs BEFORE the crawl and its
                                  failures increment `failed` without touching
                                  `discovered`, so a run that re-failed three files
                                  and then found nothing new showed "Sync finished
                                  with failures" in amber above "This folder is
                                  empty", with the retry button living in the other
                                  branch entirely — an alarm, no explanation, and
                                  no way to act. */}
                              {progress.failed > 0 && (
                                <p className="mt-1 text-xs text-amber-300/90">
                                  {t('connectors.complete.emptyWithFailures', {
                                    failed: formatCount(progress.failed),
                                  })}
                                </p>
                              )}
                              <p className="mt-1 text-xs text-slate-500">{t('connectors.complete.emptyHint')}</p>
                              <OutcomeReasons counts={syncCounts(progress)} />
                              {progress.failed > 0 && <div className="mt-3">{retryButton}</div>}
                            </>
                          ) : (
                            <>
                              <p className="mt-1 text-xs font-mono text-slate-400">
                                {t('connectors.complete.summary', {
                                  ingested: formatCount(progress.ingested),
                                  discovered: formatCount(progress.discovered),
                                })}
                                {progress.failed > 0
                                  ? t('connectors.complete.withFailures', { failed: formatCount(progress.failed) })
                                  : ''}
                                {(() => {
                                  const duration = formatDuration(c.lastSyncStartedAt, c.lastSyncAt);
                                  return duration ? ` · ${t('connectors.complete.duration', { duration })}` : '';
                                })()}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {partial
                                  ? t('connectors.complete.ctaSubtitlePartial', {
                                      ingested: formatCount(progress.ingested),
                                      failed: formatCount(progress.failed),
                                    })
                                  : t('connectors.complete.ctaSubtitle', { folder: c.rootPath || '/' })}
                              </p>
                              {partial && (
                                <p className="mt-1 text-xs text-amber-300/80">{t('connectors.complete.partialHint')}</p>
                              )}
                              {deferredTone && (
                                <p className="mt-1 text-xs text-sky-300/90">
                                  {t('connectors.complete.deferredHint', {
                                    deferred: formatCount(progress.deferred),
                                  })}
                                </p>
                              )}
                              {/* 34-S14c. Written on every finalize including zero,
                                  so silence here means "this run did not
                                  re-enumerate" rather than "we have no idea". */}
                              {fallbacks > 0 && (
                                <p className="mt-1 text-xs text-slate-500">
                                  {t('connectors.sync.deltaReenumerated', { n: formatCount(fallbacks) })}
                                </p>
                              )}
                              <OutcomeReasons counts={syncCounts(progress)} />
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    routes.onStartWorking?.({
                                      scopePath: c.rootPath,
                                      scopeLabel: c.rootPath || '/',
                                    })
                                  }
                                  className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded px-4 py-2 transition-colors"
                                >
                                  {t('connectors.complete.cta')} →
                                </button>
                                {progress.failed > 0 && retryButton}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })()}

                  {activity.kind === 'syncFailed' && (
                    <div className="mt-3 border border-rose-900/60 rounded-lg bg-rose-950/20 p-3">
                      <p className="text-sm font-semibold text-rose-300">{t('connectors.failed.title')}</p>
                      <p className="mt-1 text-xs font-mono text-slate-400">
                        {t('connectors.syncing.counts', {
                          folders: formatCount(progress.foldersScanned),
                          discovered: formatCount(progress.discovered),
                          ingested: formatCount(progress.ingested),
                          skipped: formatCount(progress.skipped),
                          deferred: formatCount(progress.deferred),
                          failed: formatCount(progress.failed),
                        })}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">{t('connectors.failed.hint')}</p>
                      <OutcomeReasons counts={syncCounts(progress)} />
                      <button
                        type="button"
                        onClick={() => resyncExisting(c)}
                        disabled={startingSyncId === c.connectionId}
                        className="mt-3 bg-rose-700 hover:bg-rose-600 disabled:opacity-40 text-white text-sm font-semibold rounded px-4 py-2 transition-colors"
                      >
                        {startingSyncId === c.connectionId ? t('connectors.startingSync') : t('connectors.retryFailed')}
                      </button>
                    </div>
                  )}

                  {c.status !== 'disconnected' && (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {/* A connection that ALREADY has a folder chosen must be
                          mappable from here. Moving the CTA into the picker
                          (34-S07d) left this card with nothing to act on: the
                          root was saved, and the only route to mapping it was
                          to re-enter the picker and pick the same folder
                          again. Found live by a customer-owner — "I have no
                          action options, only see that the connection is
                          there." The primary action belongs where the
                          connection is. */}
                      {c.rootPath && (
                        <button
                          type="button"
                          onClick={() => goToMapFlow(c.connectionId)}
                          className="text-xs font-semibold text-slate-950 bg-blue-400 hover:bg-blue-300 rounded px-3 py-1.5"
                        >
                          {t('map.pickRoot.cta')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setBrowsingId(c.connectionId);
                          setBrowseStack([{ id: null, name: t('connectors.rootLabel') }]);
                        }}
                        className="text-xs font-medium text-blue-400 hover:text-blue-300 underline"
                      >
                        {c.rootPath ? t('connectors.changeRoot') : t('connectors.pickRoot')}
                      </button>
                      <button
                        type="button"
                        onClick={() => disconnect(c.connectionId)}
                        className="text-xs font-medium text-rose-400 hover:text-rose-300 underline"
                      >
                        {t('connectors.disconnect')}
                      </button>
                    </div>
                  )}

                  {browsingId === c.connectionId && (
                    <div className="mt-4 border border-slate-800 rounded-lg p-3 bg-slate-950">
                      <nav className="flex flex-wrap items-center gap-1 text-xs font-mono text-slate-500 mb-2">
                        {browseStack.map((crumb, i) => (
                          <React.Fragment key={i}>
                            {i > 0 && <span>/</span>}
                            <button type="button" onClick={() => goToBreadcrumb(i)} className="hover:text-blue-300">
                              {crumb.name}
                            </button>
                          </React.Fragment>
                        ))}
                      </nav>

                      {/* ONE region, one closed set of states, rendered
                          exhaustively. What stood here was four independent
                          booleans over four regions — and a listing with zero
                          rows and a live cursor satisfied none of them, so the
                          panel rendered empty: no rows, no "this folder is
                          empty", no "this list is NOT complete", no way to
                          continue, under an enabled "Map this folder". The
                          state is derived above, in one place, and every
                          branch of it is answered in `BrowsePickerBody`. */}
                      <BrowsePickerBody
                        view={browsePickerView}
                        connectionId={c.connectionId}
                        sharepointHostname={sharepointHostname}
                        sharepointSitePath={sharepointSitePath}
                        onSharepointHostnameChange={setSharepointHostname}
                        onSharepointSitePathChange={setSharepointSitePath}
                        onSubmitSharepointSite={submitSharepointSite}
                        onRetry={retryBrowse}
                        onLoadMore={loadMoreBrowse}
                        onOpenFolder={openFolder}
                      />

                      <div className="mt-3 pt-3 border-t border-slate-800">
                        {/* 34-S07c/d. No classification control here: nothing
                            has been read, so there is no evidence to classify
                            from. The value still travels to the server; this
                            says what it is and where it gets decided. Hidden
                            entirely when the host offers no labels. */}
                        {carriedLabel && (
                          <p className="text-xs text-slate-500 leading-relaxed max-w-2xl">
                            {t('connectors.clearanceCarriedNote', { clearance: carriedLabel.label })}
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={() => goToMapFlow(c.connectionId)}
                            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-semibold rounded px-4 py-2 transition-colors"
                          >
                            {t('map.pickRoot.cta')}
                          </button>
                          <span className="text-xs text-slate-500">{t('map.pickRoot.ctaSubtitle')}</span>
                          <button
                            type="button"
                            onClick={() => setBrowsingId(null)}
                            className="text-xs text-slate-500 hover:text-slate-300"
                          >
                            {t('connectors.cancel')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
