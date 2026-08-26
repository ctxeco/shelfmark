// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { getLocale, t } from '../i18n/index.js';
import {
  apiUrl,
  DEFAULT_COST_MODEL,
  useReducedMotion,
  useShelfmark,
  type PickedScope,
  type ShelfmarkCostModel,
  type ShelfmarkTransport,
} from '../provider.js';

/**
 * Plan 34-S08a/S08b — the map flow, hosted on whatever page the host mounts
 * <DriveMap connectionId=…/> on.
 *
 * ONE component hosts the whole map flow as internal stages: consent →
 * mapping (the narrated stream, 34-S09) → landed (the inversion, 34-S10d).
 * This file builds the scaffold, the stage machine, and the CONSENT stage —
 * the design spec calls it the most important screen in the product: the
 * button label IS the consent record, and the word "agree" appears nowhere.
 *
 * Stage boundaries:
 *   - `MapMappingStage` — 34-S09: the reasoning stream. SSE reader on
 *     `GET /:id/map/stream` (fetch + body reader), reveal pacing at reading
 *     speed, the four glyph kinds, reconnect-once then a stated polling
 *     fallback, and terminal routing back into the page via `onTerminal`.
 *   - `MapLandedStage` — 34-S10d/S10e: the landing. The inversion (one
 *     composition, two encodings, a 900 ms morph that only plays when
 *     divergence is the message), the six absence states, the reconciliation
 *     strip, the prune report, the top-folder rollup, a ranked finding pool
 *     with a floor and a named unremarkable state. It receives the terminal
 *     run doc verbatim (the server strips nothing — GET /:id/map is the
 *     map_runs doc minus the store's own _id).
 */

/** The map_runs statuses GET /:id/map can answer with (the doc travels
 * verbatim from the @shelfmark/api map route). */
export type MapRunStatus = 'mapping' | 'complete' | 'failed' | 'refused_no_consent' | 'unsupported_provider';

export interface MapRunProgress {
  itemsSeen?: number;
  foldersWalked?: number;
  foldersPruned?: number;
  pagesFetched?: number;
  currentPath?: string | null;
}

/**
 * One narration line, as the worker writes it and the stream delivers it
 * (`{type:'narration', line}` frames; also the `narration` array on the
 * run doc). `tier` is 'none' for the arithmetic kinds today; 34-S09e's
 * narration engine adds 'ask' lines carrying the host's inference tier
 * aliases (never model names) — the chip branch for those is already built
 * below.
 */
export interface MapNarrationLine {
  kind: 'sum' | 'chk' | 'ask' | 'fix' | (string & {});
  tier: string;
  text: string;
  atMs?: number;
}

/**
 * Stream timing, exported as a test seam (the same move the server's stream
 * route makes with its env knobs): tests run the loop at ms scale, the
 * product runs it at reading speed. `revealMs` is the spec's "minimum
 * 700 ms per line so it runs at reading speed"; it is a floor between
 * reveals, not a metronome.
 */
export const MAP_STREAM_TUNING = {
  revealMs: 700,
  reconnectDelayMs: 500,
  pollMs: 2500,
};

/** Visible-line cap — older lines roll off the top, and the roll-off is
 * STATED on screen, never silent. The full transcript is retained (replay,
 * and evidence on failure). */
export const VISIBLE_LINE_CAP = 40;

/**
 * The run doc as this page reads it. Deliberately open (`[key: string]`):
 * the doc is the contract and travels verbatim — aggregates, topFolders,
 * pruneManifest, reconciliation and narration all ride along for the stream
 * and landing stages to type precisely when they consume them.
 */
export interface MapRunDoc {
  runId?: string;
  status: MapRunStatus;
  provider?: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: MapRunProgress;
  [key: string]: unknown;
}

/**
 * The flow's stage, derived from GET /:id/map on mount:
 *
 *   404 no_map_run          → consent   (no run has ever started — ask first)
 *   200 status 'mapping'    → mapping   (a run is underway — show the stream)
 *   200 'complete'|'failed' → landed    (terminal — show the landing)
 *   200 refusal statuses    → refused   (their own honest explanations —
 *                                        including 'refused_no_consent'
 *                                        arriving from MID-RUN revocation
 *                                        with partial progress recorded)
 *   anything else           → resolveFailed (say so, offer retry)
 *
 * 'refused' is split from 'landed' on purpose: the landing stage's job is
 * the inversion for a run that ran; a refusal's job is to explain why one
 * did not (or stopped), and collapsing the two invites the landing screen
 * to render a refusal as a chart with zeroes.
 *
 * The Decide stages (34-S11c/S12a/S13a) are NOT reachable from
 * `stageForRunResolution`: they are entered by an act, from the landing's
 * "Review what to ingest". A refresh therefore lands back on the map's own
 * landing rather than deep-linking into a decision screen whose evidence the
 * reader has not seen — and every one of them still carries its own honest
 * empty/refusal states rather than depending on the arrival path.
 */
export type MapFlowStage =
  | { kind: 'resolving' }
  | { kind: 'consent' }
  | { kind: 'mapping'; run: MapRunDoc | null }
  | { kind: 'landed'; run: MapRunDoc }
  | { kind: 'refused'; run: MapRunDoc }
  | { kind: 'resolveFailed' }
  /** 34-S11c/34-S12a — the suggestion ledger and the subtractive pass. */
  | { kind: 'ledger' }
  /** 34-S13a — the second consent, over a decision already on record. */
  | { kind: 'ingestConsent'; decision: DecisionSnapshot }
  /** POST /:id/ingest answered 202 — the run exists. */
  | { kind: 'ingestStarted'; workflowId: string; files: number };

const REFUSAL_STATUSES: ReadonlySet<string> = new Set(['refused_no_consent', 'unsupported_provider']);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'failed']);

/**
 * Pure derivation from the resolve fetch — exported so the stage machine is
 * testable as a table rather than through render timing. A 404 whose body
 * is NOT `no_map_run` (e.g. a route-level miss) is a resolve failure, not
 * an invitation to consent: consent must only render when the server said,
 * specifically, that no run exists.
 */
export function stageForRunResolution(status: number, body: unknown): MapFlowStage {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 404 && b.error === 'no_map_run') return { kind: 'consent' };
  if (status === 200 && typeof b.status === 'string') {
    const run = b as unknown as MapRunDoc;
    if (b.status === 'mapping') return { kind: 'mapping', run };
    if (TERMINAL_STATUSES.has(b.status)) return { kind: 'landed', run };
    if (REFUSAL_STATUSES.has(b.status)) return { kind: 'refused', run };
  }
  return { kind: 'resolveFailed' };
}

export type { PickedScope };

function scopeFromProp(scope: PickedScope | null | undefined): PickedScope | null {
  if (!scope || typeof scope !== 'object') return null;
  return {
    rootFolderId: typeof scope.rootFolderId === 'string' ? scope.rootFolderId : null,
    rootPath: typeof scope.rootPath === 'string' ? scope.rootPath : null,
  };
}

interface DisclosureDoc {
  disclosureId: string;
  scope: string;
  locale: string;
  /** SHA-pinned consent copy. Displayed VERBATIM, never paraphrased — the
   * stored consent record says "these are the words the subject read", and
   * that claim is only true if these are, byte for byte, the words. */
  text: string;
  sha256: string;
}

type DisclosureState = { phase: 'loading' } | { phase: 'ready'; doc: DisclosureDoc } | { phase: 'failed' };

interface ActiveConsent {
  consentId: string;
  scope: string;
  grantedAt?: string;
}

/**
 * The disclosure round trip, factored out of the map consent stage in
 * 34-S13a so the INGEST consent screen reuses it instead of forking it:
 * same fetch, same three phases, same refusal to accept a body without both
 * `text` and `sha256`. Only the scope differs.
 *
 * The fork was the thing to avoid. "Verbatim" is a property of ONE renderer;
 * two of them are two places where trimming, re-wrapping or paraphrasing can
 * creep in independently, and the stored consent record's claim — "these are
 * the words the subject read" — is only true while every screen that shows
 * them shows the same bytes.
 */
function useDisclosure(scope: string): { state: DisclosureState; refetch: () => Promise<void> } {
  const { transport } = useShelfmark();
  const [state, setState] = useState<DisclosureState>({ phase: 'loading' });
  const refetch = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch(
        apiUrl(transport, `/consents/disclosure?scope=${encodeURIComponent(scope)}&locale=${encodeURIComponent(getLocale())}`),
        { headers: transport.headers() }
      );
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || typeof body.text !== 'string' || typeof body.sha256 !== 'string') {
        setState({ phase: 'failed' });
        return;
      }
      setState({ phase: 'ready', doc: body as DisclosureDoc });
    } catch {
      setState({ phase: 'failed' });
    }
  }, [scope, transport]);
  return { state, refetch };
}

/** The SHA-pinned consent copy, rendered VERBATIM — one renderer, both
 *  consents. `whitespace-pre-wrap` and a bare `{text}` child are the whole
 *  point: no trimming, no re-wrapping, no interpolation. */
const DisclosureBlock: React.FC<{ state: DisclosureState; onRetry: () => void }> = ({ state, onRetry }) => (
  <div className="border border-slate-800 rounded-lg bg-slate-950/60">
    <p className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-slate-500 border-b border-slate-800">
      {t('mapConsent.disclosureTitle')}
    </p>
    {state.phase === 'loading' ? (
      <p className="px-4 py-3 text-xs text-slate-500">{t('mapConsent.disclosureLoading')}</p>
    ) : state.phase === 'failed' ? (
      <div className="px-4 py-3">
        <p className="text-xs text-rose-300">{t('mapConsent.disclosureError')}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs font-semibold text-slate-300 border border-slate-700 rounded px-3 py-1.5 hover:border-slate-500"
        >
          {t('mapConsent.disclosureRetry')}
        </button>
      </div>
    ) : (
      <div className="px-4 py-3">
        <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{state.doc.text}</p>
        <p className="mt-3 text-[10px] font-mono text-slate-600 break-all">
          {t('mapConsent.disclosureSha', { sha: state.doc.sha256 })}
        </p>
      </div>
    )}
  </div>
);

/**
 * The one problem on screen at a time, named by what actually happened.
 * `stale` (409) keeps the reader on the page with the REFRESHED text;
 * `start_failed` (503 from POST /:id/map after the grant landed) is the one
 * state where retry must NOT re-grant — one grant, then the start retried.
 */
type ConsentProblem =
  | { kind: 'stale' }
  | { kind: 'mapping_disabled' }
  | { kind: 'connectors_disabled' }
  | { kind: 'consent_not_active' }
  | { kind: 'grant_failed' }
  | { kind: 'start_failed' }
  | { kind: 'connection_gone' };

type ConsentBusy = 'granting' | 'starting' | null;

const PROBLEM_MESSAGE: Record<ConsentProblem['kind'], Parameters<typeof t>[0]> = {
  stale: 'mapConsent.staleDisclosure',
  mapping_disabled: 'mapConsent.mappingDisabled',
  connectors_disabled: 'mapConsent.connectorsDisabled',
  consent_not_active: 'mapConsent.consentNotActive',
  grant_failed: 'mapConsent.grantFailed',
  start_failed: 'mapConsent.startFailed',
  connection_gone: 'mapConsent.connectionGone',
};

/** "1,247" — via Intl for locale-correct separators (the es-MX thousands
 * fix), defensive against absent counters (a run doc from an older worker
 * may not carry every progress field). */
function fmtCount(n: number | undefined): string {
  return typeof n === 'number' ? new Intl.NumberFormat(getLocale()).format(n) : '0';
}

/** "10.1 GB" — the SAME decimal-unit idiom the map narration itself uses
 * (@shelfmark/workflows' drive-map fmtBytes): the landing's numbers must
 * read like the stream's numbers, because the customer just watched the
 * stream compute them. */
export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${Math.trunc(n)} B`;
}

/** "80.0" — one decimal, no % sign (the sign lives in the i18n string). */
function fmtPct(pct: number): string {
  return pct.toFixed(1);
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The host link renderer with a standard back-link label, shared by every
 * stage that offers a way back to the connections screen. */
function BackLink(): React.ReactNode {
  const { routes } = useShelfmark();
  return routes.renderLink(
    routes.connections,
    <span className="text-xs text-slate-500 hover:text-slate-300">{t('map.back')}</span>
  );
}

interface ConsentStageProps {
  connectionId: string;
  /** null = the scope could not be resolved (no scope prop AND the
   *  connection lookup failed). The consent line must then say so — the
   *  server will fall back to the connection's stored root, which may be a
   *  subfolder, and a consent screen that asserts '/' while the map covers
   *  /Finance has mislabelled its own scope. */
  scope: PickedScope | null;
  /** Advance the page to the mapping stage — the only exit on success. */
  onStarted: () => void;
}

/**
 * 34-S08a/S08b — the consent stage. THE BUTTON IS THE RECORD:
 * one primary action, labelled with the verb and its limit, that (1) POSTs
 * the grant echoing the disclosure SHA it displayed, (2) POSTs /:id/map
 * with the picked scope, (3) advances to the stream. No checkbox, no
 * "agree".
 */
const MapConsentStage: React.FC<ConsentStageProps> = ({ connectionId, scope, onStarted }) => {
  const { transport } = useShelfmark();
  // 34-S13a: the disclosure round trip now lives in useDisclosure, shared
  // verbatim with the ingest consent screen. Behaviour here is unchanged.
  const { state: disclosure, refetch: fetchDisclosure } = useDisclosure('map_metadata');
  const [activeGrant, setActiveGrant] = useState<ActiveConsent | null>(null);
  const [busy, setBusy] = useState<ConsentBusy>(null);
  const [problem, setProblem] = useState<ConsentProblem | null>(null);
  /**
   * Set once the grant POST answers 201 and NEVER cleared by a start
   * failure: consent is a record, not a session flag, and a 503 from the
   * workflow start does not unmake it. The one path that clears it is the
   * server itself answering `map_consent_required` — the record we thought
   * stood is not active (revoked between), so the truthful state is
   * "not granted" again.
   */
  const grantedThisSession = useRef(false);

  useEffect(() => {
    fetchDisclosure();
    // The consent HISTORY — to find an already-active map_metadata grant.
    //
    // WHY AN EXISTING GRANT SKIPS THE GRANT POST (34-S08 item 4): the consent
    // record OUTLIVES the run. It is an append-only event naming the words
    // read and the person who read them, not a per-run ritual — demanding a
    // fresh signature for every map would train the customer to click
    // through the one screen whose entire design is that clicking it means
    // something. Revocation is the customer's lever for withdrawing it (a
    // new event, POST /:id/consents/:consentId/revoke), and both the edge
    // and the worker re-check the ACTIVE set at map time, so a revoked
    // grant stops the very next start no matter what this page remembers.
    //
    // If this lookup itself fails we fall through with NO active grant and
    // would grant again on click — an append-only duplicate is harmless;
    // silently blocking the flow on a history read is not.
    (async () => {
      try {
        const res = await fetch(apiUrl(transport, `/${connectionId}/consents`), { headers: transport.headers() });
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        const active = Array.isArray(body?.active) ? (body.active as ActiveConsent[]) : [];
        setActiveGrant(active.find((c) => c && c.scope === 'map_metadata') ?? null);
      } catch {
        /* no active grant assumed — see comment above */
      }
    })();
  }, [connectionId, fetchDisclosure, transport]);

  /** POST /:id/map with the scope the picker carried. rootFolderId is sent
   * only when it is a string: the server's own guard (`typeof === 'string'`)
   * falls back to the connection's stored root for anything else, so null
   * ("the drive root") cannot currently be EXPRESSED as an override — a
   * server-contract gap that 34-S08e's target-binding rework owns. rootPath
   * always travels (it is '/' for the root, a real string). */
  const startMap = useCallback(async (): Promise<void> => {
    setBusy('starting');
    setProblem(null);
    try {
      const body: Record<string, string> = {};
      if (typeof scope?.rootFolderId === 'string') body.rootFolderId = scope.rootFolderId;
      if (typeof scope?.rootPath === 'string') body.rootPath = scope.rootPath;
      const res = await fetch(apiUrl(transport, `/${connectionId}/map`), {
        method: 'POST',
        headers: { ...transport.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resBody = await res.json().catch(() => ({}));
      if (res.status === 202) {
        onStarted();
        return;
      }
      if (res.status === 403 && resBody?.error === 'mapping_disabled_for_tenant') {
        setProblem({ kind: 'mapping_disabled' });
      } else if (res.status === 403 && resBody?.error === 'connectors_disabled_for_tenant') {
        setProblem({ kind: 'connectors_disabled' });
      } else if (res.status === 403 && resBody?.error === 'map_consent_required') {
        // The grant this page holds is not active server-side (revoked in
        // the gap). The truthful state is un-granted — say so, and require
        // the words to be read again before another grant.
        grantedThisSession.current = false;
        setActiveGrant(null);
        setProblem({ kind: 'consent_not_active' });
      } else if (res.status === 404) {
        setProblem({ kind: 'connection_gone' });
      } else {
        // 503 durable-start failure and anything unnamed: consent stays
        // granted; ONLY the start is retried (the button relabels to say so).
        setProblem({ kind: 'start_failed' });
      }
    } catch {
      setProblem({ kind: 'start_failed' });
    } finally {
      setBusy(null);
    }
  }, [connectionId, scope, onStarted, transport]);

  const onPrimary = useCallback(async () => {
    if (busy !== null) return;
    // Fast path (34-S08 item 4): an active grant on record, or one landed
    // earlier in this session, means the grant POST is SKIPPED — straight to
    // starting the map. See the effect above for why re-consent per run is
    // deliberately not demanded.
    if (grantedThisSession.current || activeGrant) {
      await startMap();
      return;
    }
    if (disclosure.phase !== 'ready') return;
    setBusy('granting');
    setProblem(null);
    try {
      const target: Record<string, string> = {};
      if (typeof scope?.rootFolderId === 'string') target.folderId = scope.rootFolderId;
      if (typeof scope?.rootPath === 'string') target.folderPath = scope.rootPath;
      const res = await fetch(apiUrl(transport, `/${connectionId}/consents`), {
        method: 'POST',
        headers: { ...transport.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'map_metadata',
          locale: getLocale(),
          // The ECHO that closes the round trip: the SHA of the exact bytes
          // rendered below, so the stored record can say which words were
          // read rather than that a button near some words was clicked.
          disclosureSha256: disclosure.doc.sha256,
          target,
        }),
      });
      const resBody = await res.json().catch(() => ({}));
      if (res.status === 201) {
        grantedThisSession.current = true;
        await startMap();
        return;
      }
      setBusy(null);
      if (res.status === 409 && resBody?.error === 'disclosure_text_mismatch') {
        // The words changed between render and click. NEVER grant a stale
        // SHA silently: surface it, re-fetch, and make the reader meet the
        // current text before the next click grants against ITS sha.
        setProblem({ kind: 'stale' });
        await fetchDisclosure();
      } else if (res.status === 403 && resBody?.error === 'mapping_disabled_for_tenant') {
        setProblem({ kind: 'mapping_disabled' });
      } else if (res.status === 403 && resBody?.error === 'connectors_disabled_for_tenant') {
        setProblem({ kind: 'connectors_disabled' });
      } else if (res.status === 404) {
        setProblem({ kind: 'connection_gone' });
      } else {
        // consent_not_recorded (503) and anything unnamed: the grant did NOT
        // land, so retrying grants again — that is correct here, and the
        // opposite of the start_failed case.
        setProblem({ kind: 'grant_failed' });
      }
    } catch {
      setBusy(null);
      setProblem({ kind: 'grant_failed' });
    }
  }, [busy, activeGrant, disclosure, scope, connectionId, startMap, fetchDisclosure, transport]);

  const folderLabel = scope === null ? null : scope.rootPath || '/';
  const consentOnRecord = activeGrant !== null || grantedThisSession.current;
  // Terminal-for-this-screen problems where offering the button again would
  // promise something the tenant switch forbids.
  const blocked =
    problem !== null &&
    (problem.kind === 'mapping_disabled' || problem.kind === 'connectors_disabled' || problem.kind === 'connection_gone');

  const ctaLabel =
    busy === 'granting'
      ? t('mapConsent.granting')
      : busy === 'starting'
        ? t('mapConsent.starting')
        : problem?.kind === 'start_failed'
          ? t('mapConsent.retryStart')
          : t('mapConsent.cta');

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-100">{t('mapConsent.title')}</h2>
        {/* 34-S08b — the honesty line. Reading names is less than reading
            files; the screen must not round it down to nothing. */}
        <p className="mt-2 text-sm text-slate-400 leading-relaxed max-w-2xl">{t('mapConsent.honesty')}</p>
        <p className="mt-2 text-xs font-mono text-slate-500">
          {folderLabel === null
            ? t('mapConsent.scopeLineUnknown')
            : t('mapConsent.scopeLine', { folder: folderLabel })}
        </p>
      </div>

      {/* The two-verb comparison table (34-S08a). Per-run numbers where
          available, copy where not: the Map column's "files opened" is 0 —
          always true, the promise itself — while the Ingest column has no
          number yet (no selection exists before the map), so it carries
          words instead of inventing one. The landing (34-S10d) and ingest
          consent (34-S13) screens hold the real counts once they exist. */}
      <div className="border border-slate-800 rounded-lg overflow-hidden">
        <p className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-slate-500 bg-slate-950/60 border-b border-slate-800">
          {t('mapConsent.vs.caption')}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-800">
                <th className="px-4 py-2" />
                <th className="px-4 py-2 text-xs font-semibold text-blue-300">{t('mapConsent.vs.mapCol')}</th>
                <th className="px-4 py-2 text-xs font-semibold text-amber-300/90">{t('mapConsent.vs.ingestCol')}</th>
              </tr>
            </thead>
            <tbody className="align-baseline">
              <tr className="border-b border-slate-800/60">
                <td className="px-4 py-2 text-xs text-slate-500">{t('mapConsent.vs.rowOpened')}</td>
                <td className="px-4 py-2 font-mono text-lg font-semibold text-emerald-300">0</td>
                <td className="px-4 py-2 text-xs text-slate-400">{t('mapConsent.vs.ingestOpenedUnknown')}</td>
              </tr>
              <tr className="border-b border-slate-800/60">
                <td className="px-4 py-2 text-xs text-slate-500">{t('mapConsent.vs.rowRead')}</td>
                <td className="px-4 py-2 text-xs text-slate-300">{t('mapConsent.vs.readMap')}</td>
                <td className="px-4 py-2 text-xs text-slate-400">{t('mapConsent.vs.readIngest')}</td>
              </tr>
              {/* The row that was nearly a lie: the map's model calls send
                  names and counts to the inference service, so this row says
                  exactly that — never "nothing". */}
              <tr className="border-b border-slate-800/60">
                <td className="px-4 py-2 text-xs text-slate-500">{t('mapConsent.vs.rowLeaves')}</td>
                <td className="px-4 py-2 text-xs text-slate-300">{t('mapConsent.vs.leavesMap')}</td>
                <td className="px-4 py-2 text-xs text-slate-400">{t('mapConsent.vs.leavesIngest')}</td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-xs text-slate-500">{t('mapConsent.vs.rowReversible')}</td>
                <td className="px-4 py-2 text-xs text-slate-300">{t('mapConsent.vs.reversibleMap')}</td>
                <td className="px-4 py-2 text-xs text-slate-400">{t('mapConsent.vs.reversibleIngest')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* The disclosure — SHA-pinned consent copy, rendered VERBATIM by the
          one renderer both consent screens share. */}
      <DisclosureBlock state={disclosure} onRetry={() => void fetchDisclosure()} />

      {activeGrant && (
        <p className="text-xs text-slate-500 leading-relaxed">
          {t('mapConsent.alreadyConsented', { date: fmtDate(activeGrant.grantedAt) })}
        </p>
      )}

      {problem && (
        <p
          role="alert"
          className={`text-xs leading-relaxed border rounded px-3 py-2 ${
            problem.kind === 'start_failed' || problem.kind === 'stale'
              ? 'text-amber-300 border-amber-900/60 bg-amber-950/20'
              : 'text-rose-300 border-rose-900/60 bg-rose-950/20'
          }`}
        >
          {t(PROBLEM_MESSAGE[problem.kind])}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* THE BUTTON IS THE RECORD. Enabled only once the exact words are
            on screen (or already on record) — a consent to text that failed
            to load would be a consent to nothing. */}
        <button
          type="button"
          onClick={onPrimary}
          disabled={busy !== null || blocked || (disclosure.phase !== 'ready' && !consentOnRecord)}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded px-5 py-2.5 transition-colors"
        >
          {ctaLabel}
        </button>
        <BackLink />
      </div>
    </section>
  );
};

/** Glyph, colour, and accessible name per narration kind — arithmetic must
 * be distinguishable from inference AT A GLANCE (design spec, step 9), so
 * the distinction is carried by glyph + colour + an aria name, never colour
 * alone. Unknown future kinds render as the muted arithmetic glyph rather
 * than crashing the stream. */
const NARRATION_KINDS: Record<string, { glyph: string; className: string; label: Parameters<typeof t>[0] }> = {
  sum: { glyph: '∑', className: 'text-slate-500', label: 'map.stream.kindSum' },
  chk: { glyph: '✓', className: 'text-emerald-400', label: 'map.stream.kindChk' },
  ask: { glyph: '?', className: 'text-blue-400', label: 'map.stream.kindAsk' },
  fix: { glyph: '↻', className: 'text-amber-400', label: 'map.stream.kindFix' },
};

/** Tier-chip styling. 'none' renders the translated "no model"; a real tier
 * value is an inference tier ALIAS (fast/standard — never a model name) and
 * renders verbatim as data. The fast branch exists now so 34-S09e's 'ask'
 * lines light up without a UI change; anything unrecognised gets the
 * violet treatment rather than an invisible chip. */
function tierChipClass(tier: string): string {
  if (tier === 'none') return 'border-emerald-900/60 text-emerald-400';
  if (tier === 'fast') return 'border-blue-900/60 text-blue-400';
  return 'border-violet-900/60 text-violet-400';
}

interface MappingStageProps {
  connectionId: string;
  /** The resolved run doc, or null when the map was started this session
   * (POST answered 202; the doc may not exist for a beat — the transport
   * below tolerates that race). */
  run: MapRunDoc | null;
  /** Called with the terminal run doc once the reader has seen every line —
   * the page routes it through `stageForRunResolution`. Deliberately NOT
   * called for status 'failed': the transcript is evidence, and the failed
   * rendering keeps it on screen instead of swapping to the landing. */
  onTerminal: (run: MapRunDoc) => void;
}

/**
 * 34-S09 — the reasoning stream: a stream you READ, not a log you tail.
 *
 * Transport: SSE on `GET /:id/map/stream` via fetch + response.body
 * .getReader() — a byte buffer, frames split on '\n\n', ': hb' comment
 * heartbeats carry no data: line and are skipped by construction. One
 * reconnect on a transport drop while the run is still live; a second drop
 * falls back to polling GET /:id/map — STATED on screen, never silent.
 *
 * Reconnect dedupe: a fresh stream connection replays the run doc's
 * narration from index 0 (the server keeps no per-client cursor), so the
 * i-th line of a connection IS doc.narration[i]. Lines already held are
 * skipped by index, with an atMs+text identity check so a future
 * resume-capable server (whose first line would be genuinely new) appends
 * instead of being swallowed.
 *
 * Pacing: lines reveal at reading speed — MAP_STREAM_TUNING.revealMs floor
 * between reveals, buffered when the server outruns the reader, capped at
 * VISIBLE_LINE_CAP visible lines with the cap stated. Under
 * prefers-reduced-motion the pacing is recognised as theatre and skipped:
 * the full transcript renders immediately (and the CSS reveal animation is
 * silenced by the `@media` override in styles.css).
 */
const MapMappingStage: React.FC<MappingStageProps> = ({ connectionId, run, onTerminal }) => {
  const { transport } = useShelfmark();
  const reducedMotion = useReducedMotion();
  /** Full retained transcript — every line received, in order. Replay
   * source, and on failure the evidence. */
  const [lines, setLines] = useState<MapNarrationLine[]>([]);
  /** How many of `lines` the reader has been shown (paced reveal). */
  const [revealed, setRevealed] = useState(0);
  const [progress, setProgress] = useState<MapRunProgress | null>(run?.progress ?? null);
  const [transportMode, setTransportMode] = useState<'sse' | 'polling'>('sse');
  /** Terminal run doc, parked until the reveal drains so the reader sees
   * every line before the page moves on. */
  const [terminalRun, setTerminalRun] = useState<MapRunDoc | null>(null);
  /** A 'failed' terminal renders HERE, transcript retained. */
  const [failedRun, setFailedRun] = useState<MapRunDoc | null>(null);

  const linesRef = useRef<MapNarrationLine[]>([]);
  const lastRevealAtRef = useRef(0);
  const terminalSeenRef = useRef(false);

  const appendLines = useCallback((incoming: MapNarrationLine[]) => {
    if (incoming.length === 0) return;
    linesRef.current = [...linesRef.current, ...incoming];
    setLines(linesRef.current);
  }, []);

  // ---- transport: SSE first, reconnect once, then stated polling ----
  useEffect(() => {
    let disposed = false;
    const ctrl = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let sseFailures = 0;

    /** Park the terminal doc for the reveal engine. A frame that shed its
     * big itemizations to fit the server's frame cap (pruneManifestElided /
     * topFoldersElided) is topped back up from GET /:id/map so the landing
     * stage gets the full doc; best-effort — the flagged frame is still
     * truthful if that fetch fails. */
    const handleTerminal = async (doc: MapRunDoc, elided: boolean): Promise<void> => {
      terminalSeenRef.current = true;
      let full = doc;
      if (elided) {
        try {
          const res = await fetch(apiUrl(transport, `/${connectionId}/map`), { headers: transport.headers() });
          const body = await res.json().catch(() => null);
          if (res.status === 200 && body && typeof body.status === 'string') full = body as MapRunDoc;
        } catch {
          /* keep the flagged frame — its elision flags say what is missing */
        }
      }
      if (!disposed) setTerminalRun(full);
    };

    const onFrame = (payload: Record<string, unknown>, connSeen: { narration: number }): void => {
      if (payload.type === 'narration' && payload.line && typeof payload.line === 'object') {
        const line = payload.line as MapNarrationLine;
        const i = connSeen.narration++;
        const stored = linesRef.current;
        if (i < stored.length && stored[i]!.text === line.text && stored[i]!.atMs === line.atMs) return;
        appendLines([line]);
        return;
      }
      if (payload.type === 'progress' && payload.progress && typeof payload.progress === 'object') {
        if (!disposed) setProgress(payload.progress as MapRunProgress);
        return;
      }
      if (payload.type === 'complete' && typeof payload.status === 'string') {
        const { type: _type, ...doc } = payload;
        void _type;
        void handleTerminal(
          doc as unknown as MapRunDoc,
          payload.pruneManifestElided === true || payload.topFoldersElided === true
        );
        return;
      }
      // {type:'error', error:'no_map_run'|'map_stream_failed'} — terminal
      // server-side; the read loop ends right after and the failure path
      // below takes it (a brief no_map_run race after the 202 heals on the
      // reconnect, and polling tolerates it too).
    };

    const readSse = async (): Promise<void> => {
      const connSeen = { narration: 0 };
      const res = await fetch(apiUrl(transport, `/${connectionId}/map/stream`), {
        headers: transport.headers(),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`map stream answered ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // ': hb' heartbeat comments have no data: line — dropped here.
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (payload && typeof payload === 'object') onFrame(payload as Record<string, unknown>, connSeen);
        }
      }
    };

    /** Polling fallback — GET /:id/map, dedupe by index against the doc's
     * accumulated narration array. A 404 no_map_run is tolerated (the
     * 202-then-first-write race reads as "no run yet"); a transient failure
     * just waits for the next tick. */
    const pollOnce = async (): Promise<void> => {
      if (disposed || terminalSeenRef.current) return;
      try {
        const res = await fetch(apiUrl(transport, `/${connectionId}/map`), { headers: transport.headers() });
        const body = await res.json().catch(() => null);
        if (res.status === 200 && body && typeof body.status === 'string') {
          const doc = body as MapRunDoc;
          const narration = Array.isArray(doc.narration) ? (doc.narration as MapNarrationLine[]) : [];
          if (narration.length > linesRef.current.length) {
            appendLines(narration.slice(linesRef.current.length));
          }
          if (doc.progress && !disposed) setProgress(doc.progress);
          if (doc.status !== 'mapping') {
            void handleTerminal(doc, false);
            return;
          }
        }
      } catch {
        /* transient — next tick tries again */
      }
      pollTimer = setTimeout(() => void pollOnce(), MAP_STREAM_TUNING.pollMs);
    };

    const startSse = (): void => {
      void readSse()
        .catch(() => undefined)
        .then(() => {
          if (disposed || terminalSeenRef.current) return;
          // The stream dropped without a terminal doc (transport error,
          // server end, or a terminal {type:'error'} frame). Reconnect
          // ONCE; on the second drop, fall back to polling — stated.
          sseFailures += 1;
          if (sseFailures < 2) {
            retryTimer = setTimeout(startSse, MAP_STREAM_TUNING.reconnectDelayMs);
          } else {
            setTransportMode('polling');
            void pollOnce();
          }
        });
    };

    startSse();
    return () => {
      disposed = true;
      ctrl.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [connectionId, appendLines, transport]);

  // ---- reveal engine: reading pace, buffered, reduced-motion instant ----
  useEffect(() => {
    if (revealed < lines.length) {
      if (reducedMotion) {
        // The pacing is theatre; reduced-motion readers get the whole
        // transcript at once, no animation.
        lastRevealAtRef.current = Date.now();
        setRevealed(lines.length);
        return;
      }
      const wait = Math.max(0, MAP_STREAM_TUNING.revealMs - (Date.now() - lastRevealAtRef.current));
      const timer = setTimeout(() => {
        lastRevealAtRef.current = Date.now();
        setRevealed((r) => Math.min(r + 1, linesRef.current.length));
      }, wait);
      return () => clearTimeout(timer);
    }
    // Fully drained. Act on a parked terminal only now — the reader has
    // seen every line first.
    if (!terminalRun) return;
    if (terminalRun.status === 'failed') {
      // Stays HERE: swapping to the landing placeholder would throw the
      // transcript away, and the transcript is the evidence.
      setFailedRun(terminalRun);
      setTerminalRun(null);
      return;
    }
    if (reducedMotion) {
      onTerminal(terminalRun);
      return;
    }
    const hold = setTimeout(() => onTerminal(terminalRun), MAP_STREAM_TUNING.revealMs);
    return () => clearTimeout(hold);
  }, [lines, revealed, terminalRun, reducedMotion, onTerminal]);

  /** Replay re-runs the reveal from the RETAINED lines, client-side — no
   * refetch (the stream re-sends nothing it hasn't already sent, and the
   * transcript is already whole here). */
  const replay = useCallback(() => {
    lastRevealAtRef.current = 0;
    setRevealed(0);
  }, []);

  const failed = failedRun !== null;
  const visibleStart = Math.max(0, revealed - VISIBLE_LINE_CAP);
  const visible = lines.slice(visibleStart, revealed);

  return (
    <section
      className={`bg-slate-900 border rounded-lg overflow-hidden ${failed ? 'border-rose-900/60' : 'border-slate-800'}`}
    >
      <div className="p-6 pb-4">
        <h2 className={`text-lg font-bold ${failed ? 'text-rose-300' : 'text-slate-100'}`}>
          {failed ? t('map.stage.failedTitle') : t('map.stage.mappingTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          {failed ? t('map.stage.failedBody') : t('map.stage.mappingBody')}
        </p>
      </div>

      <div className="border-t border-slate-800">
        <div className="px-6 py-2.5 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between gap-3">
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{t('map.stream.header')}</p>
          {lines.length > 0 && (
            <button
              type="button"
              onClick={replay}
              className="text-[11px] font-mono text-slate-400 border border-slate-700 rounded px-2.5 py-1 hover:border-slate-500 hover:text-slate-200"
            >
              {t('map.stream.replay')}
            </button>
          )}
        </div>

        {transportMode === 'polling' && (
          <p role="status" className="px-6 py-2 text-xs text-amber-300 bg-amber-950/20 border-b border-amber-900/40">
            {t('map.stream.fallbackNotice')}
          </p>
        )}

        <div className="px-6 py-4 min-h-[10rem] font-mono text-xs leading-relaxed" aria-live="polite">
          {visibleStart > 0 && (
            <p className="mb-2 text-[10px] text-slate-600">
              {t('map.stream.capNotice', { shown: fmtCount(VISIBLE_LINE_CAP), total: fmtCount(revealed) })}
            </p>
          )}
          {revealed === 0 && !failed && <p className="text-slate-600">{t('map.stream.waitingFirstLine')}</p>}
          {visible.map((line, i) => {
            const kind = NARRATION_KINDS[line.kind] ?? NARRATION_KINDS.sum!;
            return (
              <div
                key={visibleStart + i}
                className="animate-rise-in grid grid-cols-[1.1rem_auto_1fr] gap-x-2.5 items-baseline py-0.5"
              >
                <span role="img" aria-label={t(kind.label)} className={`font-semibold ${kind.className}`}>
                  {kind.glyph}
                </span>
                <span
                  className={`text-[9px] font-mono px-1 py-px border rounded whitespace-nowrap ${tierChipClass(line.tier)}`}
                >
                  {line.tier === 'none' ? t('map.stream.tierNone') : line.tier}
                </span>
                <span className="text-slate-300">{line.text}</span>
              </div>
            );
          })}
          {failed && <p className="mt-3 text-[11px] text-rose-300/80">{t('map.stream.failedTranscript')}</p>}
        </div>
      </div>

      {progress &&
        (typeof progress.itemsSeen === 'number' ||
          typeof progress.foldersWalked === 'number' ||
          progress.currentPath) && (
          <div className="px-6 py-3 border-t border-slate-800 bg-slate-950/40 text-xs font-mono text-slate-500 space-y-1">
            <p>
              {t('map.stream.progressCounts', {
                items: fmtCount(progress.itemsSeen),
                folders: fmtCount(progress.foldersWalked),
              })}
            </p>
            {progress.currentPath && (
              <p className="truncate text-slate-600">{t('map.stream.progressPath', { path: progress.currentPath })}</p>
            )}
          </div>
        )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// 34-S10d / 34-S10e — the map landing. The moment of understanding is NOT a
// graph: one headline, a 900 ms two-bar morph, three arithmetic cards —
// impressed, then reassured, in that order. Every number below is arithmetic
// off the run doc, so none of them can be wrong.
// ---------------------------------------------------------------------------

type MsgKey = Parameters<typeof t>[0];

/**
 * Landing tuning, exported as a test seam (the MAP_STREAM_TUNING pattern).
 * `morphMs` is the spec's 900 ms — the divergence IS the message, so the
 * duration is long enough to read. `morphMinDivergencePoints` is the spec's
 * "~20 points": an animation whose meaning is divergence must not play when
 * there is none, so below this the widths SNAP. `subPixelFloorPx` is the
 * sub-pixel rule's threshold: under it a segment gets `flooredWidthPx`, a
 * hatch, a "not to scale" label, and exclusion from proportional
 * hit-testing. `assumedBarWidthPx` is the geometry basis when the bar has
 * not been measured yet (and in jsdom, where clientWidth is always 0).
 */
export const MAP_LANDING_TUNING = {
  morphMs: 900,
  morphMinDivergencePoints: 20,
  subPixelFloorPx: 3,
  flooredWidthPx: 6,
  assumedBarWidthPx: 640,
  /** Prune manifests longer than this render through @tanstack/react-virtual
   * (the virtualized-list precedent); at or under it, plain rows. */
  virtualizePruneOver: 40,
};

/** The classifier's frozen vocabulary (artifact-classes.v1), in display
 * order — the escape hatch (`unclassified`) deliberately LAST but never
 * dropped: it is the classifier's own staleness signal. A future class id
 * the artifact adds renders too (neutral fill, raw id as its label — data,
 * like a tier alias), because silently dropping a class would make the bar
 * lie by omission. */
const CLASS_ORDER = [
  'human_prose',
  'human_source',
  'machine_generated',
  'media',
  'opaque_container',
  'container',
  'unclassified',
] as const;

/** "Knowledge" in the headline = what people wrote: prose + source. */
const KNOWLEDGE_CLASSES: ReadonlySet<string> = new Set(['human_prose', 'human_source']);

const CLASS_DISPLAY: Record<string, { label: MsgKey; swatch: string }> = {
  human_prose: { label: 'map.landed.class.human_prose', swatch: 'bg-emerald-500' },
  human_source: { label: 'map.landed.class.human_source', swatch: 'bg-blue-500' },
  machine_generated: { label: 'map.landed.class.machine_generated', swatch: 'bg-slate-500' },
  media: { label: 'map.landed.class.media', swatch: 'bg-amber-500' },
  opaque_container: { label: 'map.landed.class.opaque_container', swatch: 'map-fill-opaque' },
  container: { label: 'map.landed.class.container', swatch: 'bg-cyan-600' },
  unclassified: { label: 'map.landed.class.unclassified', swatch: 'map-fill-unclassified' },
};

function classLabel(id: string): string {
  const d = CLASS_DISPLAY[id];
  return d ? t(d.label) : id; // unknown class id: rendered verbatim as data
}
function classSwatch(id: string): string {
  return CLASS_DISPLAY[id]?.swatch ?? 'bg-slate-400';
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface LandingAggregates {
  perClass: Record<string, { files: number; bytes: number }>;
  folders: number;
  emptyFolders: number;
}

/** Defensive extraction — the doc travels verbatim from the store, so every
 * field is typed `unknown` until it is looked at. */
export function landingAggregates(doc: MapRunDoc): LandingAggregates | null {
  const a = asRecord(doc.aggregates);
  if (!a) return null;
  const rawPer = asRecord(a.perClass) ?? {};
  const perClass: LandingAggregates['perClass'] = {};
  for (const [id, v] of Object.entries(rawPer)) {
    const r = asRecord(v) ?? {};
    perClass[id] = { files: numOr0(r.files), bytes: numOr0(r.bytes) };
  }
  return { perClass, folders: numOr0(a.folders), emptyFolders: numOr0(a.emptyFolders) };
}

interface LandingReconciliation {
  enumeratedFileBytes: number;
  prunedFolderBytes: number;
  /** DORMANT TODAY (34-S10d note): the engine does not yet capture the
   * drive's own reported total at map start. The branch is built so the
   * reconciliation can normalise to the drive's figure — and draw the gap
   * as `not reached` instead of rounding it away — the day the field
   * appears on the doc. */
  driveReportedBytes: number | null;
}

export function landingReconciliation(doc: MapRunDoc): LandingReconciliation | null {
  const r = asRecord(doc.reconciliation);
  if (!r) return null;
  return {
    enumeratedFileBytes: numOr0(r.enumeratedFileBytes),
    prunedFolderBytes: numOr0(r.prunedFolderBytes),
    driveReportedBytes:
      typeof r.driveReportedBytes === 'number' && Number.isFinite(r.driveReportedBytes) && r.driveReportedBytes > 0
        ? r.driveReportedBytes
        : null,
  };
}

interface LandingTopFolder {
  name: string;
  files: number;
  folders: number;
  bytes: number;
}

function landingTopFolders(doc: MapRunDoc): LandingTopFolder[] {
  if (!Array.isArray(doc.topFolders)) return [];
  return doc.topFolders
    .map((v) => {
      const r = asRecord(v) ?? {};
      return {
        name: typeof r.name === 'string' ? r.name : '?',
        files: numOr0(r.files),
        folders: numOr0(r.folders),
        bytes: numOr0(r.bytes),
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

interface LandingPruneEntry {
  path: string;
  rule: string;
  size: number;
}

function landingPruneManifest(doc: MapRunDoc): LandingPruneEntry[] {
  if (!Array.isArray(doc.pruneManifest)) return [];
  return doc.pruneManifest.map((v) => {
    const r = asRecord(v) ?? {};
    return {
      path: typeof r.path === 'string' ? r.path : '?',
      rule: typeof r.rule === 'string' ? r.rule : '?',
      size: numOr0(r.size),
    };
  });
}

function landingNarration(doc: MapRunDoc): MapNarrationLine[] {
  return Array.isArray(doc.narration) ? (doc.narration as MapNarrationLine[]) : [];
}

export interface InversionClassRow {
  id: string;
  files: number;
  bytes: number;
  filesPct: number;
  bytesPct: number;
}

export interface InversionModel {
  classes: InversionClassRow[];
  totalFiles: number;
  totalBytes: number;
  /** Max over classes of |bytesPct − filesPct|, in percentage points — the
   * divergence the morph exists to show, and the gate that suppresses it. */
  divergencePoints: number;
  knowledgeFilesPct: number;
  knowledgeBytesPct: number;
}

/**
 * The inversion, as pure arithmetic: the same per-class composition under
 * two encodings. Basis for the bar is the perClass sums themselves, so the
 * percentages sum to 100 by construction; the reconciliation strip uses the
 * doc's own reconciliation numbers and shows its arithmetic separately.
 * Returns null when the doc has no aggregates or listed no files — the
 * caller renders an honest no-files line, never a zero chart.
 */
export function computeInversion(doc: MapRunDoc): InversionModel | null {
  const agg = landingAggregates(doc);
  if (!agg) return null;
  const ids = [
    ...CLASS_ORDER.filter((id) => id in agg.perClass),
    ...Object.keys(agg.perClass)
      .filter((id) => !(CLASS_ORDER as readonly string[]).includes(id))
      .sort(),
  ];
  const totalFiles = ids.reduce((s, id) => s + agg.perClass[id]!.files, 0);
  const totalBytes = ids.reduce((s, id) => s + agg.perClass[id]!.bytes, 0);
  if (totalFiles === 0) return null;
  const classes: InversionClassRow[] = ids.map((id) => ({
    id,
    files: agg.perClass[id]!.files,
    bytes: agg.perClass[id]!.bytes,
    filesPct: (agg.perClass[id]!.files / totalFiles) * 100,
    bytesPct: totalBytes > 0 ? (agg.perClass[id]!.bytes / totalBytes) * 100 : 0,
  }));
  const divergencePoints = classes.reduce((m, c) => Math.max(m, Math.abs(c.bytesPct - c.filesPct)), 0);
  const kFiles = classes.filter((c) => KNOWLEDGE_CLASSES.has(c.id)).reduce((s, c) => s + c.files, 0);
  const kBytes = classes.filter((c) => KNOWLEDGE_CLASSES.has(c.id)).reduce((s, c) => s + c.bytes, 0);
  return {
    classes,
    totalFiles,
    totalBytes,
    divergencePoints,
    knowledgeFilesPct: (kFiles / totalFiles) * 100,
    knowledgeBytesPct: totalBytes > 0 ? (kBytes / totalBytes) * 100 : 0,
  };
}

export type LandingFindingId = 'dominant_folder' | 'empty_folders' | 'pruned' | 'inversion' | 'opaque';

export interface LandingFinding {
  id: LandingFindingId;
  /** Salience, 0–100 — used only to rank; the floor already gated entry. */
  score: number;
  vars: Record<string, string | number>;
}

/** Floors for the ranked finding pool (34-S10e). A candidate below its
 * floor is not a finding — a wow-moment that only works on good input is a
 * demo, not a product, so a drive where nothing clears these renders the
 * named `unremarkable` state instead of manufactured cards. */
const FINDING_FLOORS = {
  inversionPoints: MAP_LANDING_TUNING.morphMinDivergencePoints, // same ~20-point bar as the morph
  emptyFolderShare: 0.33,
  dominantFolderShare: 0.5,
  prunedShare: 0.25,
  opaqueBytesPoints: 10,
};

/** The finding pool, ranked by salience, floored, top three — the "three
 * arithmetic cards". Every number in `vars` is a division or a subtraction
 * off the run doc; none can be wrong. */
export function computeFindings(doc: MapRunDoc, inv: InversionModel): LandingFinding[] {
  const pool: LandingFinding[] = [];

  if (inv.divergencePoints >= FINDING_FLOORS.inversionPoints) {
    pool.push({
      id: 'inversion',
      score: inv.divergencePoints,
      vars: {
        filesPct: fmtPct(inv.knowledgeFilesPct),
        bytesPct: fmtPct(inv.knowledgeBytesPct),
        points: fmtPct(inv.divergencePoints),
      },
    });
  }

  const agg = landingAggregates(doc);
  if (agg && agg.folders > 0) {
    const share = agg.emptyFolders / agg.folders;
    if (share >= FINDING_FLOORS.emptyFolderShare) {
      pool.push({
        id: 'empty_folders',
        score: share * 100,
        vars: { empty: fmtCount(agg.emptyFolders), folders: fmtCount(agg.folders), pct: fmtPct(share * 100) },
      });
    }
  }

  const top = landingTopFolders(doc)[0];
  if (top && inv.totalBytes > 0) {
    const share = top.bytes / inv.totalBytes;
    if (share >= FINDING_FLOORS.dominantFolderShare) {
      pool.push({ id: 'dominant_folder', score: share * 100, vars: { name: top.name, pct: fmtPct(share * 100) } });
    }
  }

  const recon = landingReconciliation(doc);
  if (recon) {
    const under = recon.enumeratedFileBytes + recon.prunedFolderBytes;
    const share = under > 0 ? recon.prunedFolderBytes / under : 0;
    if (share >= FINDING_FLOORS.prunedShare) {
      pool.push({
        id: 'pruned',
        score: share * 100,
        vars: { bytes: fmtBytes(recon.prunedFolderBytes), pct: fmtPct(share * 100) },
      });
    }
  }

  const opaque = inv.classes.find((c) => c.id === 'opaque_container');
  if (opaque && opaque.bytesPct >= FINDING_FLOORS.opaqueBytesPoints) {
    pool.push({
      id: 'opaque',
      score: opaque.bytesPct,
      vars: { files: fmtCount(opaque.files), pct: fmtPct(opaque.bytesPct) },
    });
  }

  return pool.sort((a, b) => b.score - a.score).slice(0, 3);
}

const FINDING_CARD: Record<LandingFindingId, { title: MsgKey; body: MsgKey }> = {
  inversion: { title: 'map.landed.card.inversionTitle', body: 'map.landed.card.inversionBody' },
  empty_folders: { title: 'map.landed.card.emptyTitle', body: 'map.landed.card.emptyBody' },
  dominant_folder: { title: 'map.landed.card.dominantTitle', body: 'map.landed.card.dominantBody' },
  pruned: { title: 'map.landed.card.prunedTitle', body: 'map.landed.card.prunedBody' },
  opaque: { title: 'map.landed.card.opaqueTitle', body: 'map.landed.card.opaqueBody' },
};

type MapEncoding = 'bytes' | 'files';

/**
 * The inversion section: one composition, two encodings, a toggle. The morph
 * is a width transition (`.map-morph`, duration from MAP_LANDING_TUNING)
 * applied ONLY when it has something to say: suppressed under
 * prefers-reduced-motion (the hook, plus the CSS class's own baked-in
 * override) and suppressed when divergence is under ~20 points — an
 * animation whose meaning is divergence must not play when there is none.
 *
 * THE SUB-PIXEL RULE: a segment whose true width is under ~3px gets a
 * floored width, a hatched fill, a "not to scale" label in the legend, and
 * `pointer-events: none` — excluded from proportional hit-testing, so the
 * chart cannot lie by geometry. And no state rides on colour alone: every
 * segment has a legend row carrying its name and counts as text.
 */
const InversionSection: React.FC<{ model: InversionModel }> = ({ model }) => {
  const reducedMotion = useReducedMotion();
  const [encoding, setEncoding] = useState<MapEncoding>('bytes');
  const barRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setMeasuredWidth(el.clientWidth);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const barWidth = measuredWidth > 0 ? measuredWidth : MAP_LANDING_TUNING.assumedBarWidthPx;
  const morphEnabled = !reducedMotion && model.divergencePoints >= MAP_LANDING_TUNING.morphMinDivergencePoints;

  const segments = model.classes.map((c) => {
    const pct = encoding === 'bytes' ? c.bytesPct : c.filesPct;
    const px = (pct / 100) * barWidth;
    return { ...c, pct, floored: px < MAP_LANDING_TUNING.subPixelFloorPx };
  });
  const anyFloored = segments.some((s) => s.floored);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-300">
          {encoding === 'bytes' ? t('map.landed.byBytes') : t('map.landed.byFiles')}
        </h3>
        <div
          role="group"
          aria-label={t('map.landed.encodingGroup')}
          className="flex border border-slate-700 rounded overflow-hidden text-[11px] font-mono"
        >
          <button
            type="button"
            aria-pressed={encoding === 'bytes'}
            onClick={() => setEncoding('bytes')}
            className={
              encoding === 'bytes' ? 'px-3 py-1 bg-slate-700 text-slate-100' : 'px-3 py-1 text-slate-400 hover:text-slate-200'
            }
          >
            {t('map.landed.toggleBytes')}
          </button>
          <button
            type="button"
            aria-pressed={encoding === 'files'}
            onClick={() => setEncoding('files')}
            className={
              encoding === 'files' ? 'px-3 py-1 bg-slate-700 text-slate-100' : 'px-3 py-1 text-slate-400 hover:text-slate-200'
            }
          >
            {t('map.landed.toggleFiles')}
          </button>
        </div>
      </div>

      <div
        ref={barRef}
        role="img"
        aria-label={encoding === 'bytes' ? t('map.landed.barAriaBytes') : t('map.landed.barAriaFiles')}
        className="flex h-8 w-full rounded overflow-hidden border border-slate-800 bg-slate-950"
      >
        {segments.map((s) =>
          s.floored ? (
            // Floored: fixed width, hatch, NO title and no pointer events —
            // its geometry is not proportional, so it may not answer
            // hit-tests as if it were. Its data lives in the legend row.
            <div
              key={s.id}
              data-not-to-scale="true"
              className={`map-hatch pointer-events-none shrink-0 ${classSwatch(s.id)}`}
              style={{ width: `${MAP_LANDING_TUNING.flooredWidthPx}px` }}
            />
          ) : (
            <div
              key={s.id}
              title={`${classLabel(s.id)} — ${t('map.landed.legendCounts', { files: fmtCount(s.files), bytes: fmtBytes(s.bytes) })}`}
              className={`min-w-0 ${classSwatch(s.id)}${morphEnabled ? ' map-morph' : ''}`}
              style={{ width: `${s.pct}%`, transitionDuration: `${MAP_LANDING_TUNING.morphMs}ms` }}
            />
          )
        )}
      </div>

      <div className="flex justify-between text-[10px] font-mono text-slate-600">
        <span>0</span>
        <span>
          {encoding === 'bytes'
            ? t('map.landed.axisBytes', { n: fmtCount(model.totalBytes) })
            : t('map.landed.axisFiles', { n: fmtCount(model.totalFiles) })}
        </span>
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((s) => (
          <li key={s.id} className="flex items-baseline gap-1.5 text-xs">
            <i className={`inline-block w-3 h-3 rounded-sm self-center ${classSwatch(s.id)}`} aria-hidden="true" />
            <span className="text-slate-300">{classLabel(s.id)}</span>
            <span className="font-mono text-[11px] text-slate-500">
              {t('map.landed.legendCounts', { files: fmtCount(s.files), bytes: fmtBytes(s.bytes) })}
            </span>
            {s.floored && (
              <span className="text-[10px] uppercase tracking-wide text-amber-300/80">{t('map.landed.notToScale')}</span>
            )}
          </li>
        ))}
      </ul>
      {anyFloored && <p className="text-[11px] text-slate-500">{t('map.landed.notToScaleCaption')}</p>}
    </div>
  );
};

interface AbsenceRow {
  key: string;
  swatch: string;
  name: MsgKey;
  meaning: MsgKey;
  count: MsgKey;
  countVars: Record<string, string | number>;
}

/**
 * The six absence states — "we looked and found nothing" and "we did not
 * look" are different sentences, so each state gets a fill treatment AND a
 * text label, never colour alone.
 *
 *   measured      what the walk enumerated, sized, classified
 *   pruned        deliberately not walked, by a named rule (the report below)
 *   opaque        archives — contents unknowable from metadata
 *   unclassified  the escape, surfaced as the classifier's own staleness signal
 *   not reached   DORMANT: only drawable against a drive-reported total,
 *                 which the doc does not carry yet (see landingReconciliation)
 *   empty         undrawable at any honest width — the number IS the picture
 */
const AbsencePanel: React.FC<{ doc: MapRunDoc; inv: InversionModel | null }> = ({ doc, inv }) => {
  const agg = landingAggregates(doc);
  const recon = landingReconciliation(doc);
  if (!agg) return null;
  const manifest = landingPruneManifest(doc);
  const prunedBytes = recon?.prunedFolderBytes ?? manifest.reduce((s, e) => s + e.size, 0);
  const prunedCount =
    typeof doc.progress?.foldersPruned === 'number'
      ? doc.progress.foldersPruned
      : manifest.length + numOr0(doc.pruneManifestOmitted);
  const opaqueFiles = agg.perClass['opaque_container']?.files ?? 0;
  const unclassifiedFiles = agg.perClass['unclassified']?.files ?? 0;

  const rows: AbsenceRow[] = [
    {
      key: 'measured',
      swatch: 'bg-emerald-500',
      name: 'map.landed.absence.measuredName',
      meaning: 'map.landed.absence.measuredMeaning',
      count: 'map.landed.absence.measuredCount',
      countVars: { files: fmtCount(inv?.totalFiles ?? 0), bytes: fmtBytes(inv?.totalBytes ?? 0) },
    },
    {
      key: 'pruned',
      swatch: 'map-fill-pruned',
      name: 'map.landed.absence.prunedName',
      meaning: 'map.landed.absence.prunedMeaning',
      count: 'map.landed.absence.prunedCount',
      countVars: { bytes: fmtBytes(prunedBytes), n: fmtCount(prunedCount) },
    },
    {
      key: 'opaque',
      swatch: 'map-fill-opaque',
      name: 'map.landed.absence.opaqueName',
      meaning: 'map.landed.absence.opaqueMeaning',
      count: 'map.landed.absence.opaqueCount',
      countVars: { files: fmtCount(opaqueFiles) },
    },
    {
      key: 'unclassified',
      swatch: 'map-fill-unclassified',
      name: 'map.landed.absence.unclassifiedName',
      meaning: 'map.landed.absence.unclassifiedMeaning',
      count: 'map.landed.absence.unclassifiedCount',
      countVars: { files: fmtCount(unclassifiedFiles) },
    },
  ];

  // `not reached` renders ONLY against a drive-reported total to reconcile
  // with — a gap needs two figures. The doc does not carry one today; the
  // branch waits for the engine to capture driveReportedBytes at map start.
  if (recon && recon.driveReportedBytes !== null) {
    const gap = Math.max(0, recon.driveReportedBytes - (recon.enumeratedFileBytes + recon.prunedFolderBytes));
    rows.push({
      key: 'notReached',
      swatch: 'map-fill-notreached',
      name: 'map.landed.absence.notReachedName',
      meaning: 'map.landed.absence.notReachedMeaning',
      count: 'map.landed.absence.notReachedCount',
      countVars: { bytes: fmtBytes(gap) },
    });
  }

  rows.push({
    key: 'empty',
    swatch: 'map-fill-empty',
    name: 'map.landed.absence.emptyName',
    meaning: 'map.landed.absence.emptyMeaning',
    count: 'map.landed.absence.emptyCount',
    countVars: { n: fmtCount(agg.emptyFolders) },
  });

  return (
    <div className="border border-slate-800 rounded-lg overflow-hidden">
      <p className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-slate-500 bg-slate-950/60 border-b border-slate-800">
        {t('map.landed.absenceTitle')}
      </p>
      <ul className="divide-y divide-slate-800/60">
        {rows.map((r) => (
          <li key={r.key} className="px-4 py-2.5 flex items-start gap-3">
            <i className={`inline-block w-3.5 h-3.5 rounded-sm mt-0.5 shrink-0 ${r.swatch}`} aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs">
                <span className="font-mono uppercase tracking-wide text-slate-300">{t(r.name)}</span>{' '}
                <span className="font-mono text-slate-500">{t(r.count, r.countVars)}</span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">{t(r.meaning)}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Reconciliation strip — the arithmetic is SHOWN, not asserted; when the
 * dormant drive-total branch wakes it normalises to the drive's own figure
 * instead of letting the bar quietly sum to 100%. */
const ReconStrip: React.FC<{ doc: MapRunDoc }> = ({ doc }) => {
  const recon = landingReconciliation(doc);
  if (!recon) return null;
  const accounted = recon.enumeratedFileBytes + recon.prunedFolderBytes;
  const narrationDropped = numOr0(doc.narrationDropped);
  return (
    <div className="border border-slate-800 rounded-lg bg-slate-950/60 p-4 space-y-2">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{t('map.landed.reconTitle')}</p>
      <p className="font-mono text-sm text-slate-200">
        {t('map.landed.reconArithmetic', {
          enumerated: fmtBytes(recon.enumeratedFileBytes),
          pruned: fmtBytes(recon.prunedFolderBytes),
          accounted: fmtBytes(accounted),
        })}
      </p>
      {recon.driveReportedBytes !== null &&
        (recon.driveReportedBytes > accounted ? (
          <p className="text-xs text-slate-400">
            {t('map.landed.reconDriveGap', {
              reported: fmtBytes(recon.driveReportedBytes),
              accounted: fmtBytes(accounted),
              gap: fmtBytes(recon.driveReportedBytes - accounted),
            })}
          </p>
        ) : (
          <p className="text-xs text-slate-400">
            {t('map.landed.reconDriveMatches', { reported: fmtBytes(recon.driveReportedBytes) })}
          </p>
        ))}
      {narrationDropped > 0 && (
        <p className="text-xs text-amber-300/90">{t('map.landed.narrationDroppedRow', { n: fmtCount(narrationDropped) })}</p>
      )}
    </div>
  );
};

/** Top-level folder rollup. `rollupTruncated` renders as its own stated row
 * — a bounded list that does not say so is a silent cap. */
const TopFoldersSection: React.FC<{ doc: MapRunDoc }> = ({ doc }) => {
  const folders = landingTopFolders(doc);
  const elided = doc.topFoldersElided === true;
  if (folders.length === 0 && !elided) return null;
  return (
    <div className="border border-slate-800 rounded-lg overflow-hidden">
      <p className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-slate-500 bg-slate-950/60 border-b border-slate-800">
        {t('map.landed.foldersTitle')}
      </p>
      {elided ? (
        <p className="px-4 py-3 text-xs text-amber-300/90">{t('map.landed.elidedRow')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-slate-800 text-slate-500">
                <th className="px-4 py-2 font-medium">{t('map.landed.foldersColFolder')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('map.landed.foldersColFiles')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('map.landed.foldersColFolders')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('map.landed.foldersColBytes')}</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((f) => (
                <tr key={f.name} className="border-b border-slate-800/40 last:border-b-0">
                  <td className="px-4 py-1.5 font-mono text-slate-300 truncate max-w-[14rem]">{f.name}</td>
                  <td className="px-4 py-1.5 font-mono text-slate-400 text-right">{fmtCount(f.files)}</td>
                  <td className="px-4 py-1.5 font-mono text-slate-400 text-right">{fmtCount(f.folders)}</td>
                  <td className="px-4 py-1.5 font-mono text-slate-400 text-right">{fmtBytes(f.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {doc.rollupTruncated === true && !elided && (
        <p className="px-4 py-2 text-xs text-amber-300/90 border-t border-slate-800">
          {t('map.landed.rollupTruncatedRow', {
            n: fmtCount(folders.length),
            omitted: fmtCount(numOr0(doc.topFoldersOmitted)),
          })}
        </p>
      )}
    </div>
  );
};

const PruneRow: React.FC<{ entry: LandingPruneEntry }> = ({ entry }) => (
  <div className="px-4 py-1.5 flex items-baseline gap-3 text-xs border-b border-slate-800/40 last:border-b-0">
    <span className="font-mono text-slate-300 truncate min-w-0 flex-1">{entry.path}</span>
    <span className="font-mono text-[10px] text-violet-300/90 border border-violet-900/60 rounded px-1.5 py-px whitespace-nowrap">
      {entry.rule}
    </span>
    <span className="font-mono text-slate-500 whitespace-nowrap">{fmtBytes(entry.size)}</span>
  </div>
);

/** Long manifests virtualize (the virtualized-list precedent — and as
 * there, jsdom cannot measure the viewport, so tests assert the itemized
 * rows on the short, non-virtualized path and the stated counts on the long
 * one). */
const PruneVirtualList: React.FC<{ entries: LandingPruneEntry[] }> = ({ entries }) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 10,
  });
  return (
    <div ref={parentRef} data-testid="prune-virtual" className="h-64 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
          >
            <PruneRow entry={entries[vi.index]!} />
          </div>
        ))}
      </div>
    </div>
  );
};

/** The prune report — the auditable list behind the `pruned` absence state:
 * every subtree with the rule that fired. Truncation ON the manifest
 * (pruneManifestTruncated) and elision OF the manifest (a terminal frame
 * that shed it and could not be topped back up) each render as their own
 * stated row. */
const PruneReportSection: React.FC<{ doc: MapRunDoc }> = ({ doc }) => {
  const entries = landingPruneManifest(doc);
  const recon = landingReconciliation(doc);
  const prunedBytes = recon?.prunedFolderBytes ?? entries.reduce((s, e) => s + e.size, 0);
  const elided = doc.pruneManifestElided === true;
  const nothingPruned = entries.length === 0 && !elided && doc.pruneManifestTruncated !== true && prunedBytes === 0;
  return (
    <div className="border border-slate-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between gap-3">
        <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{t('map.landed.pruneTitle')}</p>
        {!nothingPruned && !elided && (
          <p className="text-[11px] font-mono text-slate-500">
            {t('map.landed.pruneCount', { n: fmtCount(entries.length), bytes: fmtBytes(prunedBytes) })}
          </p>
        )}
      </div>
      {elided ? (
        <p className="px-4 py-3 text-xs text-amber-300/90">{t('map.landed.elidedRow')}</p>
      ) : nothingPruned ? (
        <p className="px-4 py-3 text-xs text-slate-500">{t('map.landed.pruneEmpty')}</p>
      ) : entries.length > MAP_LANDING_TUNING.virtualizePruneOver ? (
        <PruneVirtualList entries={entries} />
      ) : (
        <div>
          {entries.map((e) => (
            <PruneRow key={e.path} entry={e} />
          ))}
        </div>
      )}
      {doc.pruneManifestTruncated === true && !elided && (
        <p className="px-4 py-2 text-xs text-amber-300/90 border-t border-slate-800">
          {t('map.landed.pruneTruncatedRow', { omitted: fmtCount(numOr0(doc.pruneManifestOmitted)) })}
        </p>
      )}
    </div>
  );
};

/** Compact transcript block for the landing's failed path (a refresh after
 * a failed run — live failures keep their transcript in the stream stage).
 * The narration IS on the doc from GET /:id/map; rendering it here is what
 * makes the refreshed failure page carry the same evidence. */
const LandedTranscript: React.FC<{ lines: MapNarrationLine[]; dropped: number }> = ({ lines, dropped }) => (
  <div className="border border-slate-800 rounded-lg overflow-hidden">
    <p className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-slate-500 bg-slate-950/60 border-b border-slate-800">
      {t('map.landed.transcriptTitle')}
    </p>
    <div className="px-4 py-3 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        const kind = NARRATION_KINDS[line.kind] ?? NARRATION_KINDS.sum!;
        return (
          <div key={i} className="grid grid-cols-[1.1rem_auto_1fr] gap-x-2.5 items-baseline py-0.5">
            <span role="img" aria-label={t(kind.label)} className={`font-semibold ${kind.className}`}>
              {kind.glyph}
            </span>
            <span className={`text-[9px] font-mono px-1 py-px border rounded whitespace-nowrap ${tierChipClass(line.tier)}`}>
              {line.tier === 'none' ? t('map.stream.tierNone') : line.tier}
            </span>
            <span className="text-slate-300">{line.text}</span>
          </div>
        );
      })}
      {dropped > 0 && (
        <p className="mt-2 text-[11px] text-amber-300/90">{t('map.landed.narrationDroppedRow', { n: fmtCount(dropped) })}</p>
      )}
      <p className="mt-2 text-[11px] text-rose-300/80">{t('map.stream.failedTranscript')}</p>
    </div>
  </div>
);

/**
 * 34-S10d/S10e — the landing. Exported for direct tests (the page routes
 * refusals away from it, so its refusal-doc defense is only reachable by
 * rendering it directly).
 *
 * Arrival paths, same doc shape: mount-time GET /:id/map resolution, or the
 * stream stage's onTerminal after draining the reveal. The stream stage's
 * top-up of an elided terminal frame is BEST-EFFORT, so a doc can still
 * arrive carrying pruneManifestElided/topFoldersElided: this component
 * retries the full fetch once. The sections read the elision flags off the
 * CURRENT doc, so no extra state is needed: the frame-derived doc carries
 * the flags and renders stated elision rows; the fetched full doc (GET
 * /:id/map never elides) replaces it and the real lists render; a failed
 * fetch leaves the flags — and the stated rows — standing. Honest at every
 * instant.
 *
 * TRANSCRIPT DECISION (deliberate): a `complete` landing does NOT re-render
 * the narration even when the doc carries it (refresh path) — the stream
 * stage is the narration's home, and the landing's job is the accounting.
 * A `failed` landing DOES render it, because there the transcript is the
 * evidence of how far the run got.
 */
export const MapLandedStage: React.FC<{
  connectionId: string;
  run: MapRunDoc;
  /** 34-S11c — the entry point into the Decide stages. Optional so this
   *  component still renders standalone (tests, and any future embed); with
   *  no handler the CTA falls back to the host's connections link it carried
   *  before step 11 existed, which is a real destination rather than a dead
   *  button. */
  onReview?: () => void;
  /** JRN-9 / 34-S07f — a TERMINAL run must offer the action its state calls
   *  for. Without this a failed run was a dead end: the page resolved the
   *  stale doc to 'landed', reported a failure from hours earlier, and had no
   *  way to run again — so pressing "Map this folder" navigated to an old
   *  obituary and never started anything. A complete run needs it too, for a
   *  different reason: a map is a photograph, and drives move. */
  onRemap?: () => void;
}> = ({ connectionId, run, onReview, onRemap }) => {
  const { transport, routes } = useShelfmark();
  const [fullDoc, setFullDoc] = useState<MapRunDoc | null>(null);
  const doc = fullDoc ?? run;

  // An elided terminal frame sheds pruneManifest/topFolders to fit the
  // server's frame cap; the flags say so. The full doc is one GET away.
  useEffect(() => {
    if (run.pruneManifestElided !== true && run.topFoldersElided !== true) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(transport, `/${connectionId}/map`), { headers: transport.headers() });
        const body = await res.json().catch(() => null);
        if (!cancelled && res.status === 200 && body && typeof body.status === 'string') {
          setFullDoc(body as MapRunDoc);
        }
        // Any other answer: the flags stay on `run`, and the sections
        // render them as stated elision rows — the honest fallback.
      } catch {
        /* same — the flags speak */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run, connectionId, transport]);

  const inv = useMemo(() => computeInversion(doc), [doc]);
  const findings = useMemo(() => (inv ? computeFindings(doc, inv) : []), [doc, inv]);

  // A refusal doc carries only provider + narration (+ partial progress).
  // The page's stage machine never routes one here — but if one arrives
  // anyway, it gets the refusal explanation, never a dashboard of zeroes.
  if (REFUSAL_STATUSES.has(doc.status)) {
    return <MapRefusedStage run={doc} />;
  }

  if (doc.status === 'failed') {
    const lines = landingNarration(doc);
    const p = doc.progress;
    return (
      <section className="space-y-5">
        <div className="bg-slate-900 border border-rose-900/60 rounded-lg p-6">
          <h2 className="text-lg font-bold text-rose-300">{t('map.stage.failedTitle')}</h2>
          <p className="mt-2 text-sm text-slate-400">{t('map.stage.failedBody')}</p>
          {p && ((p.itemsSeen ?? 0) > 0 || (p.foldersWalked ?? 0) > 0) && (
            <p className="mt-3 text-xs font-mono text-slate-500">
              {t('map.landed.failedPartial', { items: fmtCount(p.itemsSeen), folders: fmtCount(p.foldersWalked) })}
            </p>
          )}
        </div>
        {onRemap && (
          <button
            type="button"
            onClick={onRemap}
            className="text-sm font-semibold text-slate-950 bg-rose-300 hover:bg-rose-200 rounded px-4 py-2"
          >
            {t('map.landed.retry')}
          </button>
        )}
        {lines.length > 0 && <LandedTranscript lines={lines} dropped={numOr0(doc.narrationDropped)} />}
      </section>
    );
  }

  const p = doc.progress;
  return (
    <section className="space-y-5">
      <div className="bg-slate-900 border border-emerald-900/60 rounded-lg p-6 space-y-5">
        <div>
          <h2 className="text-lg font-bold text-emerald-300">{t('map.stage.completeTitle')}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {p && (typeof p.itemsSeen === 'number' || typeof p.foldersWalked === 'number')
              ? t('map.stage.completeSummary', { items: fmtCount(p.itemsSeen), folders: fmtCount(p.foldersWalked) })
              : t('map.stage.completeNoCounts')}
          </p>
          {onRemap && (
            <button
              type="button"
              onClick={onRemap}
              className="mt-3 text-xs font-medium text-slate-300 border border-slate-700 rounded px-3 py-1.5 hover:border-slate-500"
            >
              {t('map.landed.remap')}
            </button>
          )}
        </div>

        {inv === null ? (
          <p className="text-sm text-slate-400">{t('map.landed.noFiles')}</p>
        ) : (
          <>
            {/* The headline: derived, not asserted — two divisions. */}
            <p className="text-xl font-bold tracking-tight text-slate-100 leading-snug max-w-2xl">
              {t('map.landed.headline', {
                filesPct: fmtPct(inv.knowledgeFilesPct),
                bytesPct: fmtPct(inv.knowledgeBytesPct),
              })}
            </p>

            <InversionSection model={inv} />

            {findings.length > 0 ? (
              <div className="grid sm:grid-cols-3 gap-3">
                {findings.map((f) => (
                  <div key={f.id} className="border border-slate-800 rounded-lg bg-slate-950/60 p-4">
                    <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                      {t(FINDING_CARD[f.id].title)}
                    </p>
                    <p className="mt-1.5 text-sm text-slate-300 leading-relaxed">{t(FINDING_CARD[f.id].body, f.vars)}</p>
                  </div>
                ))}
              </div>
            ) : (
              // 34-S10e — the named honest state. No finding cleared its
              // floor: say so, instead of manufacturing wow from thin input.
              <div className="border border-slate-800 rounded-lg bg-slate-950/60 p-4">
                <p className="text-sm font-semibold text-slate-200">{t('map.landed.unremarkableTitle')}</p>
                <p className="mt-1 text-sm text-slate-400 leading-relaxed">{t('map.landed.unremarkableBody')}</p>
              </div>
            )}
          </>
        )}
      </div>

      <AbsencePanel doc={doc} inv={inv} />
      <ReconStrip doc={doc} />
      <TopFoldersSection doc={doc} />
      <PruneReportSection doc={doc} />

      {/* The exit — now the entry point into step 11 (34-S11c). */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-400 max-w-md leading-relaxed">{t('map.landed.reviewCtaSub')}</p>
        {onReview ? (
          <button
            type="button"
            onClick={onReview}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded px-5 py-2.5 transition-colors"
          >
            {t('map.landed.reviewCta')}
          </button>
        ) : (
          routes.renderLink(
            routes.connections,
            <span className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded px-5 py-2.5 transition-colors">
              {t('map.landed.reviewCta')}
            </span>
          )
        )}
      </div>
    </section>
  );
};

/**
 * Refusals get their own stage and their own words — never the landing.
 * 'refused_no_consent' can arrive MID-RUN (the worker re-checks the active
 * consent set on every continuation hop), so it may carry partial
 * progress; that partial record is real and gets said out loud rather than
 * hidden, because "we stopped" and "we never looked" are different facts.
 */
const MapRefusedStage: React.FC<{ run: MapRunDoc }> = ({ run }) => {
  const noConsent = run.status === 'refused_no_consent';
  const p = run.progress;
  const hasPartial = noConsent && p !== undefined && ((p.itemsSeen ?? 0) > 0 || (p.foldersWalked ?? 0) > 0);
  return (
    <section className="bg-slate-900 border border-amber-900/60 rounded-lg p-6">
      <h2 className="text-lg font-bold text-amber-300">
        {noConsent ? t('map.refused.noConsentTitle') : t('map.refused.unsupportedTitle')}
      </h2>
      <p className="mt-2 text-sm text-slate-400 leading-relaxed">
        {noConsent ? t('map.refused.noConsentBody') : t('map.refused.unsupportedBody')}
      </p>
      {hasPartial && (
        <p className="mt-3 text-xs font-mono text-slate-500">
          {t('map.refused.partialProgress', {
            items: fmtCount(p!.itemsSeen),
            folders: fmtCount(p!.foldersWalked),
          })}
        </p>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// 34-S11c / 34-S12a / 34-S12b / 34-S13a/b — DECIDE. Steps 11, 12 and 13.
//
// Step 11 is a recommendation WITH REASONS, not a verdict: the funnel table
// first (every subtraction named and counted, the arithmetic SHOWN rather
// than asserted), then the JRN-D1 shape counts, then the rows — each row
// carrying the reason it is in or out. Step 12 is the subtractive pass, with
// friction deliberately asymmetric. Step 13 is the second receipt.
//
// The rules themselves are DATA and stay data: every label below is keyed by
// the rule/shape/class id the server sent, and an id this file has no label
// for renders VERBATIM (the tier-alias and class-id precedent) rather than
// being dropped. Nothing here re-derives a verdict; the funnel ran once, in
// the workers, against the governed artifact.
// ---------------------------------------------------------------------------

/** One funnel-table row as the workers write it (the drive-map activities'
 *  `funnelTable: result.subtractions`) — rule id, and what it took. Zero rows
 *  are present on purpose and are rendered. */
export interface FunnelTableRow {
  rule: string;
  files: number;
  bytes: number;
}

/** Counts, and only counts (JRN-D1). There is deliberately no path list on
 *  this shape, because a shape that carried one would eventually be rendered. */
export interface SensitiveCounts {
  candidates: number;
  defaultSelection: number;
}

/** One verdict-ledger row (the workers' suggestion-row shape). `rank`/
 *  `tieGroupSize`/`rankIsArbitrary` are RESERVED — the workers publish
 *  `ranking.ranked:false` today and omit them; the rendering below is built
 *  so the day a portable ordering spec exists, a tie renders AS a tie
 *  instead of as merit. */
export interface SuggestionRow {
  itemId: string;
  path: string;
  name: string;
  size: number;
  modified: string;
  verdict: string;
  subtractedBy?: string;
  reportedShapes?: string[];
  rank?: number;
  tieGroupSize?: number;
  rankIsArbitrary?: boolean;
}

/** The server's computed step-13 cost block, riding every page of
 *  GET /:id/map/suggestions and describing the whole DEFAULT selection,
 *  never the page. */
export interface IngestCostEstimate {
  textShareBytes: number;
  binaryShareBytes: number;
  binaryShareOfSelection: number;
  tokenLow: number;
  tokenHigh: number;
  method: string;
}

/** The suggestions payload as this page reads it: the map_suggestions doc
 *  plus the server's pagination envelope. */
export interface SuggestionsPayload {
  funnelPolicyVersion: string;
  funnelPolicySha256: string;
  classifierVersion: string;
  classifierSha256: string;
  candidates: { files: number; bytes: number };
  funnelTable: FunnelTableRow[];
  defaultSelection: { files: number; bytes: number };
  sensitiveReport: Record<string, SensitiveCounts>;
  ranking: { ranked: boolean; reason: string };
  rows: SuggestionRow[];
  rowsTotal: number;
  rowsPageCap: number;
  nextCursor: string | null;
  rowsTruncated: boolean;
  rowsOmitted: number;
  rowCap: number;
  costEstimate: IngestCostEstimate | null;
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function countsPair(v: unknown): { files: number; bytes: number } {
  const r = asRecord(v) ?? {};
  return { files: numOr0(r.files), bytes: numOr0(r.bytes) };
}

/**
 * Defensive parse of the suggestions response. Returns null ONLY when the
 * two things the whole screen is built on are absent — the funnel table and
 * the candidate/default totals — because a ledger screen that renders an
 * empty funnel next to a real row list would present "nothing was subtracted"
 * as a finding. Everything else degrades to a stated empty.
 */
export function parseSuggestions(body: unknown): SuggestionsPayload | null {
  const b = asRecord(body);
  if (!b) return null;
  if (!Array.isArray(b.funnelTable) || asRecord(b.candidates) === null || asRecord(b.defaultSelection) === null) {
    return null;
  }
  const funnelTable: FunnelTableRow[] = b.funnelTable.map((v) => {
    const r = asRecord(v) ?? {};
    return { rule: strOr(r.rule, '?'), files: numOr0(r.files), bytes: numOr0(r.bytes) };
  });
  const sensitiveReport: Record<string, SensitiveCounts> = {};
  for (const [id, v] of Object.entries(asRecord(b.sensitiveReport) ?? {})) {
    const r = asRecord(v) ?? {};
    sensitiveReport[id] = { candidates: numOr0(r.candidates), defaultSelection: numOr0(r.defaultSelection) };
  }
  const rows: SuggestionRow[] = Array.isArray(b.rows)
    ? b.rows.map((v) => {
        const r = asRecord(v) ?? {};
        const row: SuggestionRow = {
          itemId: strOr(r.itemId, ''),
          path: strOr(r.path, ''),
          name: strOr(r.name, ''),
          size: numOr0(r.size),
          modified: strOr(r.modified, ''),
          verdict: strOr(r.verdict, ''),
        };
        if (typeof r.subtractedBy === 'string') row.subtractedBy = r.subtractedBy;
        if (Array.isArray(r.reportedShapes)) {
          row.reportedShapes = r.reportedShapes.filter((s): s is string => typeof s === 'string');
        }
        if (typeof r.rank === 'number') row.rank = r.rank;
        if (typeof r.tieGroupSize === 'number') row.tieGroupSize = r.tieGroupSize;
        if (r.rankIsArbitrary === true) row.rankIsArbitrary = true;
        return row;
      })
    : [];
  const ranking = asRecord(b.ranking) ?? {};
  const cost = asRecord(b.costEstimate);
  return {
    funnelPolicyVersion: strOr(b.funnelPolicyVersion, '?'),
    funnelPolicySha256: strOr(b.funnelPolicySha256, '?'),
    classifierVersion: strOr(b.classifierVersion, '?'),
    classifierSha256: strOr(b.classifierSha256, '?'),
    candidates: countsPair(b.candidates),
    funnelTable,
    defaultSelection: countsPair(b.defaultSelection),
    sensitiveReport,
    // Absent `ranking` is read as UNRANKED, never as ranked: the honest
    // default when the server said nothing is that no order is claimed.
    ranking: { ranked: ranking.ranked === true, reason: strOr(ranking.reason, '') },
    rows,
    rowsTotal: typeof b.rowsTotal === 'number' ? b.rowsTotal : rows.length,
    rowsPageCap: numOr0(b.rowsPageCap),
    nextCursor: typeof b.nextCursor === 'string' ? b.nextCursor : null,
    rowsTruncated: b.rowsTruncated === true,
    rowsOmitted: numOr0(b.rowsOmitted),
    rowCap: numOr0(b.rowCap),
    costEstimate: cost
      ? {
          textShareBytes: numOr0(cost.textShareBytes),
          binaryShareBytes: numOr0(cost.binaryShareBytes),
          binaryShareOfSelection: numOr0(cost.binaryShareOfSelection),
          tokenLow: numOr0(cost.tokenLow),
          tokenHigh: numOr0(cost.tokenHigh),
          method: strOr(cost.method, ''),
        }
      : null,
  };
}

/** The evaluator's verdict grammar, parsed rather than string-matched at the
 *  call sites (@shelfmark/policy funnelPolicy: selected | subtracted:<rule_id>
 *  | subtracted:propagated_from:<rule_id> | not_candidate:<class>). An
 *  unrecognised verdict is `unknown` and renders raw — a future grammar must
 *  not make this screen lie or crash. */
export type RowVerdict =
  | { kind: 'selected' }
  | { kind: 'subtracted'; rule: string }
  | { kind: 'propagated'; rule: string }
  | { kind: 'not_candidate'; className: string }
  | { kind: 'unknown'; raw: string };

const PROPAGATED_PREFIX = 'subtracted:propagated_from:';

export function parseVerdict(raw: string): RowVerdict {
  if (raw === 'selected') return { kind: 'selected' };
  if (raw.startsWith(PROPAGATED_PREFIX)) return { kind: 'propagated', rule: raw.slice(PROPAGATED_PREFIX.length) };
  if (raw.startsWith('subtracted:')) return { kind: 'subtracted', rule: raw.slice('subtracted:'.length) };
  if (raw.startsWith('not_candidate:')) return { kind: 'not_candidate', className: raw.slice('not_candidate:'.length) };
  return { kind: 'unknown', raw };
}

/** Plain-language names for the funnel policy's rule ids, in the artifact's
 *  own vocabulary. An id with no entry renders as the id. */
const FUNNEL_RULE_LABEL: Record<string, MsgKey> = {
  archived_dump_copy: 'map.ledger.rule.archived_dump_copy',
  stub_under_200b: 'map.ledger.rule.stub_under_200b',
  receipt_shape: 'map.ledger.rule.receipt_shape',
  machine_output_in_prose: 'map.ledger.rule.machine_output_in_prose',
  third_party_publication: 'map.ledger.rule.third_party_publication',
  propagation: 'map.ledger.rule.propagation',
  duplicate_fingerprint: 'map.ledger.rule.duplicate_fingerprint',
};

/** One sentence per rule, condensed from the artifact's own `rationale`
 *  fields — the words the customer is asked to override in step 12. */
const FUNNEL_RULE_WHY: Record<string, MsgKey> = {
  archived_dump_copy: 'map.ledger.why.archived_dump_copy',
  stub_under_200b: 'map.ledger.why.stub_under_200b',
  receipt_shape: 'map.ledger.why.receipt_shape',
  machine_output_in_prose: 'map.ledger.why.machine_output_in_prose',
  third_party_publication: 'map.ledger.why.third_party_publication',
  propagation: 'map.ledger.why.propagation',
  duplicate_fingerprint: 'map.ledger.why.duplicate_fingerprint',
};

function ruleLabel(id: string): string {
  const key = FUNNEL_RULE_LABEL[id];
  return key ? t(key) : id;
}
function ruleWhy(id: string): string {
  const key = FUNNEL_RULE_WHY[id];
  return key ? t(key) : t('map.ledger.why.unknownRule');
}

/** The funnel policy's eight named shape ids. Same discipline: an id the
 *  artifact adds later renders verbatim, never silently. */
const SHAPE_LABEL: Record<string, MsgKey> = {
  bank_statement_shape: 'map.ledger.shape.bank_statement_shape',
  credential_shape: 'map.ledger.shape.credential_shape',
  tax_shape: 'map.ledger.shape.tax_shape',
  government_identity_shape: 'map.ledger.shape.government_identity_shape',
  legal_shape: 'map.ledger.shape.legal_shape',
  insurance_shape: 'map.ledger.shape.insurance_shape',
  pastoral_shape: 'map.ledger.shape.pastoral_shape',
  payroll_shape: 'map.ledger.shape.payroll_shape',
};

function shapeLabel(id: string): string {
  const key = SHAPE_LABEL[id];
  return key ? t(key) : id;
}

/** The shape id whose advice is rotate-don't-exclude (JRN-D1's one piece of
 *  said-out-loud advice that is still not a gate). */
const CREDENTIAL_SHAPE_ID = 'credential_shape';

export interface FunnelReconciliation {
  candidates: { files: number; bytes: number };
  subtractedFiles: number;
  subtractedBytes: number;
  expectedFiles: number;
  expectedBytes: number;
  defaultSelection: { files: number; bytes: number };
  residualFiles: number;
  residualBytes: number;
  reconciles: boolean;
}

/**
 * The funnel's own arithmetic, recomputed here from the rows the server
 * sent — SHOWN, not asserted. The workers' evaluator refuses a funnel that
 * cannot add, so `reconciles` should always be true; it is computed anyway
 * because the alternative is a screen that would render a broken funnel as a
 * clean one. When it is false the residual is stated, with both figures.
 */
export function funnelReconciliation(p: SuggestionsPayload): FunnelReconciliation {
  const subtractedFiles = p.funnelTable.reduce((s, r) => s + r.files, 0);
  const subtractedBytes = p.funnelTable.reduce((s, r) => s + r.bytes, 0);
  const expectedFiles = p.candidates.files - subtractedFiles;
  const expectedBytes = p.candidates.bytes - subtractedBytes;
  return {
    candidates: p.candidates,
    subtractedFiles,
    subtractedBytes,
    expectedFiles,
    expectedBytes,
    defaultSelection: p.defaultSelection,
    residualFiles: p.defaultSelection.files - expectedFiles,
    residualBytes: p.defaultSelection.bytes - expectedBytes,
    reconciles: expectedFiles === p.defaultSelection.files && expectedBytes === p.defaultSelection.bytes,
  };
}

/**
 * THE ONE PLACE the server's cost arithmetic is mirrored in this package,
 * and the only reason it is mirrored at all: the server's `costEstimate`
 * describes the DEFAULT selection, and step 12 edits that selection live.
 * Refetching cannot answer it — there is no endpoint that costs an unsaved
 * decision.
 *
 * Two implementations of one rule set diverge silently, so this one is not
 * allowed to be silent. `selectionTotals` runs the mirror at ZERO DELTA on
 * every render and compares it to the server's own emitted `tokenLow` /
 * `tokenHigh`; disagreement sets `mirrorAgrees:false`, the server's numbers
 * are the ones shown, and the edited range is withdrawn with a named notice
 * instead of quietly reported from arithmetic we just proved wrong. That is
 * a live equivalence check, on real data, on every render.
 *
 * The mirror is also a DELTA, not a re-derivation: it starts from the
 * server's own text/binary byte shares and adds or subtracts only the rows
 * the customer acted on. So it stays exact under pagination — a customer can
 * only act on a row they can see.
 *
 * The constants themselves live in the provider config (`costModel`), with
 * DEFAULT_COST_MODEL as the by-value copy of what this mirrors.
 */
export const COST_MIRROR_OF = 'the @shelfmark/core cost model (COST_MODEL)';

/** Lowercased last-dot extension; NO extension means binary, because the
 *  honest bucket for an unknown format is the wide range, not the confident
 *  one (the server's own extension rule makes the same call). */
function isTextLikeName(name: string, model: ShelfmarkCostModel): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return model.textLikeExtensions.includes(name.slice(dot + 1).toLowerCase());
}

function tokensFor(textBytes: number, binaryBytes: number, model: ShelfmarkCostModel): { low: number; high: number } {
  const text = textBytes / model.textBytesPerToken;
  return {
    low: Math.ceil(text + binaryBytes / model.binaryLowYield),
    high: Math.ceil(text + binaryBytes / model.binaryHighYield),
  };
}

/** The customer's edits, exactly as they travel in the PUT body. */
export interface SelectionEdits {
  removed: ReadonlySet<string>;
  readded: ReadonlySet<string>;
}

export interface SelectionTotals {
  files: number;
  bytes: number;
  removedFiles: number;
  readdedFiles: number;
  edited: boolean;
  binaryShare: number;
  /** null when the server sent no cost block, or when the mirror disagreed
   *  with it and the selection has been edited — never a guess. */
  tokens: { low: number; high: number } | null;
  mirrorAgrees: boolean;
}

/**
 * The running total, live. Mirrors the workers' own resolution exactly
 * (the selective-ingest activities' resolveSelectionRows): the default
 * selection, minus removals, plus re-adds, with a re-add of a removed row
 * WINNING. Any disagreement here would be a screen promising a set the
 * ingest will not read.
 */
export function selectionTotals(
  p: SuggestionsPayload,
  edits: SelectionEdits,
  rowsByPath: ReadonlyMap<string, SuggestionRow>,
  costModel: ShelfmarkCostModel = DEFAULT_COST_MODEL
): SelectionTotals {
  let files = p.defaultSelection.files;
  let bytes = p.defaultSelection.bytes;
  let textBytes = p.costEstimate?.textShareBytes ?? 0;
  let binaryBytes = p.costEstimate?.binaryShareBytes ?? 0;
  let removedFiles = 0;
  let readdedFiles = 0;

  for (const path of edits.removed) {
    const row = rowsByPath.get(path);
    // Re-add wins over remove (the workers' rule), and removing a row that
    // was never in the default is a no-op there — so it is a no-op here.
    if (!row || edits.readded.has(path)) continue;
    if (parseVerdict(row.verdict).kind !== 'selected') continue;
    removedFiles += 1;
    files -= 1;
    bytes -= row.size;
    if (isTextLikeName(row.name, costModel)) textBytes -= row.size;
    else binaryBytes -= row.size;
  }
  for (const path of edits.readded) {
    const row = rowsByPath.get(path);
    if (!row) continue;
    // A re-added row that was already selected is already inside the base
    // total; counting it again would inflate the promise.
    if (parseVerdict(row.verdict).kind === 'selected') continue;
    readdedFiles += 1;
    files += 1;
    bytes += row.size;
    if (isTextLikeName(row.name, costModel)) textBytes += row.size;
    else binaryBytes += row.size;
  }

  const server = p.costEstimate;
  const zeroDelta = server ? tokensFor(server.textShareBytes, server.binaryShareBytes, costModel) : null;
  const mirrorAgrees =
    server !== null && zeroDelta !== null && zeroDelta.low === server.tokenLow && zeroDelta.high === server.tokenHigh;
  const edited = removedFiles > 0 || readdedFiles > 0;
  const totalCostBytes = textBytes + binaryBytes;

  let tokens: { low: number; high: number } | null = null;
  if (server && !edited) tokens = { low: server.tokenLow, high: server.tokenHigh };
  else if (server && mirrorAgrees) tokens = tokensFor(textBytes, binaryBytes, costModel);

  return {
    files,
    bytes,
    removedFiles,
    readdedFiles,
    edited,
    binaryShare: totalCostBytes === 0 ? 0 : binaryBytes / totalCostBytes,
    tokens,
    mirrorAgrees,
  };
}

/** Whether a row is in the selection RIGHT NOW, under the workers' rule. */
export function isRowSelected(row: SuggestionRow, edits: SelectionEdits): boolean {
  if (edits.readded.has(row.path)) return true;
  if (edits.removed.has(row.path)) return false;
  return parseVerdict(row.verdict).kind === 'selected';
}

/**
 * Ledger tuning, exported as a test seam (the MAP_STREAM_TUNING pattern).
 * `virtualizeRowsOver` follows the prune report's precedent: long lists go
 * through @tanstack/react-virtual, short ones render plainly — and as there,
 * jsdom cannot measure a viewport, so tests assert itemised rows on the short
 * path and the STATED counts on the long one.
 */
export const MAP_LEDGER_TUNING = {
  virtualizeRowsOver: 40,
  rowHeightPx: 58,
};

/** The decision as step 13 needs it — carried forward from the ledger so the
 *  second consent states the size of the thing being consented to. */
export interface DecisionSnapshot {
  files: number;
  bytes: number;
  tokens: { low: number; high: number } | null;
  binaryShare: number;
  costMethod: string | null;
  mirrorAgrees: boolean;
  decidedAt: string | null;
  sensitiveReport: Record<string, SensitiveCounts>;
}

// ── step 11: the funnel table ──────────────────────────────────────────────

/** Every subtraction named and counted, in the policy's own precedence order
 *  (the server's array order — never re-sorted here, because the order IS
 *  the precedence). Zero rows included: a rule that only appears when it
 *  fires cannot be audited. */
const FunnelTable: React.FC<{ payload: SuggestionsPayload }> = ({ payload }) => {
  const recon = funnelReconciliation(payload);
  return (
    <div className="border border-slate-800 rounded-lg overflow-hidden">
      <p className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-slate-500 bg-slate-950/60 border-b border-slate-800">
        {t('map.ledger.funnelTitle')}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left border-b border-slate-800 text-slate-500">
              <th className="px-4 py-2 font-medium">{t('map.ledger.funnelColStage')}</th>
              <th className="px-4 py-2 font-medium text-right">{t('map.ledger.funnelColFiles')}</th>
              <th className="px-4 py-2 font-medium text-right">{t('map.ledger.funnelColBytes')}</th>
              <th className="px-4 py-2 font-medium">{t('map.ledger.funnelColWhy')}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-800/60">
              <td className="px-4 py-1.5 text-slate-300">{t('map.ledger.funnelCandidates')}</td>
              <td className="px-4 py-1.5 font-mono text-slate-200 text-right">{fmtCount(payload.candidates.files)}</td>
              <td className="px-4 py-1.5 font-mono text-slate-200 text-right">{fmtBytes(payload.candidates.bytes)}</td>
              <td className="px-4 py-1.5 text-slate-500" />
            </tr>
            {payload.funnelTable.map((r) => (
              <tr key={r.rule} className="border-b border-slate-800/40">
                <td className="px-4 py-1.5 text-slate-400">− {ruleLabel(r.rule)}</td>
                <td className="px-4 py-1.5 font-mono text-slate-400 text-right">−{fmtCount(r.files)}</td>
                <td className="px-4 py-1.5 font-mono text-slate-400 text-right">−{fmtBytes(r.bytes)}</td>
                <td className="px-4 py-1.5 text-slate-500 leading-relaxed max-w-md">{ruleWhy(r.rule)}</td>
              </tr>
            ))}
            <tr className="bg-slate-950/60">
              <td className="px-4 py-2 font-semibold text-slate-200">{t('map.ledger.funnelDefault')}</td>
              <td className="px-4 py-2 font-mono font-semibold text-emerald-300 text-right">
                {fmtCount(payload.defaultSelection.files)}
              </td>
              <td className="px-4 py-2 font-mono font-semibold text-emerald-300 text-right">
                {fmtBytes(payload.defaultSelection.bytes)}
              </td>
              <td className="px-4 py-2 text-slate-500" />
            </tr>
          </tbody>
        </table>
      </div>
      {/* The arithmetic SHOWN, not asserted — the same move the map
          landing's reconciliation strip makes. */}
      <div className="px-4 py-2.5 border-t border-slate-800 space-y-1.5">
        <p className="font-mono text-xs text-slate-300">
          {t('map.ledger.funnelArithmetic', {
            candidateFiles: fmtCount(recon.candidates.files),
            subtractedFiles: fmtCount(recon.subtractedFiles),
            selectedFiles: fmtCount(recon.defaultSelection.files),
            candidateBytes: fmtBytes(recon.candidates.bytes),
            subtractedBytes: fmtBytes(recon.subtractedBytes),
            selectedBytes: fmtBytes(recon.defaultSelection.bytes),
          })}
        </p>
        {!recon.reconciles && (
          <p role="alert" className="text-xs text-rose-300 leading-relaxed">
            {t('map.ledger.funnelResidual', {
              candidateFiles: fmtCount(recon.candidates.files),
              subtractedFiles: fmtCount(recon.subtractedFiles),
              expectedFiles: fmtCount(recon.expectedFiles),
              selectedFiles: fmtCount(recon.defaultSelection.files),
              residualFiles: fmtCount(Math.abs(recon.residualFiles)),
              residualBytes: fmtBytes(Math.abs(recon.residualBytes)),
            })}
          </p>
        )}
        <p className="text-[11px] text-slate-600 leading-relaxed">{t('map.ledger.zerosIncluded')}</p>
      </div>
    </div>
  );
};

// ── step 11/12b: the sensitive report, COUNTS ONLY ─────────────────────────

/**
 * JRN-D1, as a rendering rule. Counts of named shapes, over candidates and
 * over the default selection. There is no path here, no sort control, no
 * filter, and no drill-in — a ranked table of those paths on one screen IS
 * the dossier, and the cheapest way to never build one is to have no code
 * that could.
 */
const SensitiveCountsTable: React.FC<{ report: Record<string, SensitiveCounts>; showBody?: boolean }> = ({
  report,
  showBody = true,
}) => {
  const ids = Object.keys(report).sort();
  return (
    <div className="border border-slate-800 rounded-lg overflow-hidden">
      <p className="px-4 py-2 text-[10px] font-mono uppercase tracking-widest text-slate-500 bg-slate-950/60 border-b border-slate-800">
        {t('map.ledger.sensitiveTitle')}
      </p>
      {showBody && (
        <p className="px-4 pt-3 text-xs text-slate-400 leading-relaxed">{t('map.ledger.sensitiveBody')}</p>
      )}
      {ids.length === 0 ? (
        <p className="px-4 py-3 text-xs text-slate-500">{t('map.ledger.sensitiveNone')}</p>
      ) : (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-y border-slate-800 text-slate-500">
                <th className="px-4 py-2 font-medium">{t('map.ledger.sensitiveColShape')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('map.ledger.sensitiveColCandidates')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('map.ledger.sensitiveColSelected')}</th>
              </tr>
            </thead>
            <tbody>
              {ids.map((id) => (
                <tr key={id} className="border-b border-slate-800/40 last:border-b-0">
                  <td className="px-4 py-1.5 text-slate-300">{shapeLabel(id)}</td>
                  <td className="px-4 py-1.5 font-mono text-slate-400 text-right">{fmtCount(report[id]!.candidates)}</td>
                  <td className="px-4 py-1.5 font-mono text-slate-200 text-right">
                    {fmtCount(report[id]!.defaultSelection)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-2.5 text-[11px] text-slate-600 leading-relaxed border-t border-slate-800">
        {t('map.ledger.sensitiveCountsOnly')}
      </p>
    </div>
  );
};

/** The two things JRN-D1 says get said out loud, neither of them a gate:
 *  rotate-don't-exclude for live credentials, and — only on a SHARED tenant —
 *  who else can search this. On a single-owner tenant the question does not
 *  arise and no warning appears, which is why the tenant's shape has to be
 *  known rather than assumed. */
type TenantShape = { kind: 'loading' } | { kind: 'single' } | { kind: 'shared'; people: number } | { kind: 'unknown' };

const SaidOutLoud: React.FC<{ report: Record<string, SensitiveCounts>; shape: TenantShape }> = ({ report, shape }) => {
  const credentials = report[CREDENTIAL_SHAPE_ID]?.defaultSelection ?? 0;
  return (
    <>
      {credentials > 0 && (
        <p className="text-xs text-amber-300/90 leading-relaxed border border-amber-900/50 bg-amber-950/20 rounded px-3 py-2.5">
          {t('map.ledger.credentialAdvice', { n: fmtCount(credentials) })}
        </p>
      )}
      {shape.kind === 'shared' && (
        <p className="text-xs text-slate-300 leading-relaxed border border-slate-700 bg-slate-950/60 rounded px-3 py-2.5">
          {t('map.ledger.sharedTenantNote', { n: fmtCount(shape.people) })}
        </p>
      )}
      {shape.kind === 'unknown' && (
        <p className="text-xs text-slate-400 leading-relaxed border border-slate-700 bg-slate-950/60 rounded px-3 py-2.5">
          {t('map.ledger.tenantShapeUnknown')}
        </p>
      )}
    </>
  );
};

// ── step 11/12: the rows ───────────────────────────────────────────────────

/** The reason a row is in or out, as words. `subtractedBy` is preferred over
 *  re-parsing the verdict when the server sent it — same source rule id, one
 *  fewer place to get the grammar wrong. */
function verdictText(row: SuggestionRow): string {
  const v = parseVerdict(row.verdict);
  switch (v.kind) {
    case 'selected':
      return t('map.ledger.verdictSelected');
    case 'subtracted':
      return t('map.ledger.verdictSubtracted', { rule: ruleLabel(row.subtractedBy ?? v.rule) });
    case 'propagated':
      return t('map.ledger.verdictPropagated', { rule: ruleLabel(row.subtractedBy ?? v.rule) });
    case 'not_candidate':
      return t('map.ledger.verdictNotCandidate', { class: classLabel(v.className) });
    default:
      // A grammar this build does not know: the server's own string, as data.
      return v.raw;
  }
}

/**
 * Rank, rendered honestly. A TIE renders AS a tie — presenting arbitrary
 * order as merit is the specific failure 34-S11c names — and when the server
 * says `ranked:false` (which it does today, because no portable ordering
 * spec was published) the row says "unranked" rather than borrowing its
 * position in a path-ordered list as a score.
 */
function rankText(row: SuggestionRow, ranked: boolean): string | null {
  if (!ranked || typeof row.rank !== 'number') return t('map.ledger.rankUnranked');
  if (typeof row.tieGroupSize === 'number' && row.tieGroupSize > 1) {
    return t('map.ledger.rankTie', { rank: fmtCount(row.rank), others: fmtCount(row.tieGroupSize - 1) });
  }
  if (row.rankIsArbitrary) return `${t('map.ledger.rankValue', { rank: fmtCount(row.rank) })} — ${t('map.ledger.rankArbitrary')}`;
  return t('map.ledger.rankValue', { rank: fmtCount(row.rank) });
}

interface LedgerRowProps {
  row: SuggestionRow;
  ranked: boolean;
  selected: boolean;
  edited: 'removed' | 'readded' | null;
  onRemove: (row: SuggestionRow) => void;
  onUndo: (row: SuggestionRow) => void;
  onOpenReadd: (row: SuggestionRow) => void;
}

/**
 * One ledger row, and the asymmetry (34-S12a) at its narrowest point:
 *
 *   selected      → "Remove", ONE click, immediate.
 *   subtracted    → "Add back…", which opens the confirmation panel above
 *                   the list restating the rule being overridden. Two acts.
 *   either, edited → "Undo", one click — undoing your own edit is cheap in
 *                   both directions; only OVERRIDING A RULE is expensive.
 */
const LedgerRow: React.FC<LedgerRowProps> = ({ row, ranked, selected, edited, onRemove, onUndo, onOpenReadd }) => {
  const rank = rankText(row, ranked);
  return (
    <div
      data-testid="ledger-row"
      data-path={row.path}
      data-selected={selected ? 'true' : 'false'}
      className={`px-4 py-2 flex items-start gap-3 border-b border-slate-800/40 last:border-b-0 ${
        selected ? '' : 'opacity-70'
      }`}
      style={{ minHeight: MAP_LEDGER_TUNING.rowHeightPx }}
    >
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs text-slate-200 truncate">{row.name}</p>
        <p className="font-mono text-[10px] text-slate-600 truncate">{row.path}</p>
      </div>
      <span className="font-mono text-[11px] text-slate-500 whitespace-nowrap mt-0.5">{fmtBytes(row.size)}</span>
      <div className="w-56 shrink-0 mt-0.5">
        <p className={`text-[11px] ${selected ? 'text-emerald-300/90' : 'text-slate-400'}`}>{verdictText(row)}</p>
        {selected && rank && <p className="text-[10px] text-slate-600">{rank}</p>}
        {row.reportedShapes && row.reportedShapes.length > 0 && (
          <p className="text-[10px] text-amber-300/70 truncate">
            {t('map.ledger.rowShapesLabel')} {row.reportedShapes.map(shapeLabel).join(', ')}
          </p>
        )}
      </div>
      <div className="w-28 shrink-0 text-right mt-0.5">
        {edited !== null ? (
          <>
            <span className="block text-[10px] font-mono uppercase tracking-wide text-blue-300">
              {edited === 'removed' ? t('map.decide.removedMark') : t('map.decide.readdedMark')}
            </span>
            <button
              type="button"
              onClick={() => onUndo(row)}
              className="mt-0.5 text-[11px] text-slate-400 border border-slate-700 rounded px-2 py-0.5 hover:border-slate-500 hover:text-slate-200"
            >
              {t('map.decide.undo')}
            </button>
          </>
        ) : selected ? (
          <button
            type="button"
            onClick={() => onRemove(row)}
            className="text-[11px] text-slate-300 border border-slate-700 rounded px-2.5 py-1 hover:border-rose-700 hover:text-rose-300"
          >
            {t('map.decide.remove')}
          </button>
        ) : (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => onOpenReadd(row)}
            className="text-[11px] text-slate-400 border border-slate-800 rounded px-2.5 py-1 hover:border-slate-600 hover:text-slate-200"
          >
            {t('map.decide.readdOpen')}
          </button>
        )}
      </div>
    </div>
  );
};

/** Long ledgers virtualize — the prune report's precedent, same caveat: in
 *  jsdom the scroll element measures zero, so tests read the stated counts on
 *  this path and the itemised rows on the short one. */
const LedgerVirtualList: React.FC<{ rows: SuggestionRow[]; render: (row: SuggestionRow) => React.ReactNode }> = ({
  rows,
  render,
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => MAP_LEDGER_TUNING.rowHeightPx,
    overscan: 10,
  });
  return (
    <div ref={parentRef} data-testid="ledger-virtual" className="h-96 overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => (
          // MEASURED, not assumed: unlike the prune report's uniform rows, a
          // ledger row's height varies with whether it carries a rank line
          // and a shapes line. `rowHeightPx` is the first-paint estimate;
          // measureElement corrects it, so long ledgers cannot drift into
          // overlapping or gapped rows as the reader scrolls.
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
          >
            {render(rows[vi.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * The deliberate half of the asymmetry: adding back something a rule took
 * out happens HERE, not inline, and only after the rule that would be
 * overridden has been restated in the customer's own language. One pending
 * re-add at a time, by construction — a bulk "add everything back" control
 * would be exactly the symmetric affordance step 12 exists to withhold.
 *
 * It lives outside the (possibly virtualized) list on purpose: an expanding
 * row inside a fixed-height virtual list either clips its own confirmation
 * or forces measured rows, and neither is worth it for a panel that should
 * hold the reader's whole attention anyway.
 */
const ReaddConfirm: React.FC<{ row: SuggestionRow; onConfirm: () => void; onCancel: () => void }> = ({
  row,
  onConfirm,
  onCancel,
}) => {
  const reducedMotion = useReducedMotion();
  const v = parseVerdict(row.verdict);
  // The SOURCE rule id: `subtractedBy` when the server sent it, else whatever
  // the verdict grammar carried. For an unknown grammar the raw verdict is
  // the honest stand-in — it is what the record actually says.
  const sourceRule = row.subtractedBy ?? (v.kind === 'subtracted' || v.kind === 'propagated' ? v.rule : row.verdict);
  const restated =
    v.kind === 'not_candidate'
      ? t('map.decide.readdRestatedNotCandidate', { class: classLabel(v.className) })
      : v.kind === 'propagated'
        ? // A propagated row was not judged on its own evidence: a
          // fingerprint-identical copy was, and this one went with it. Saying
          // "taken out by receipts" would overstate what was actually
          // observed about THIS file — and the override's scope is one file,
          // which the copy says out loud.
          t('map.decide.readdRestatedPropagated', { rule: ruleLabel(sourceRule), why: ruleWhy(sourceRule) })
        : t('map.decide.readdRestated', { rule: ruleLabel(sourceRule), why: ruleWhy(sourceRule) });
  return (
    <div
      role="group"
      aria-label={t('map.decide.readdTitle', { name: row.name })}
      className={`border border-blue-900/60 bg-blue-950/20 rounded-lg px-4 py-3 space-y-2${
        reducedMotion ? '' : ' animate-rise-in'
      }`}
    >
      <p className="text-xs font-semibold text-blue-200">{t('map.decide.readdTitle', { name: row.name })}</p>
      <p className="font-mono text-[10px] text-slate-500 break-all">{row.path}</p>
      <p className="text-xs text-slate-300 leading-relaxed">{restated}</p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onConfirm}
          className="text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded px-3 py-1.5"
        >
          {t('map.decide.readdConfirm')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-slate-300 border border-slate-700 rounded px-3 py-1.5 hover:border-slate-500"
        >
          {t('map.decide.readdCancel')}
        </button>
      </div>
    </div>
  );
};

// ── the ledger stage ───────────────────────────────────────────────────────

type LedgerLoad =
  | { phase: 'loading' }
  | { phase: 'ready'; payload: SuggestionsPayload }
  | { phase: 'none' }
  | { phase: 'failed' };

/** Save outcomes, each named by what actually happened server-side. */
type SaveProblem =
  | { kind: 'path_unknown'; field: string; path: string }
  | { kind: 'paths_invalid'; field: string }
  | { kind: 'no_ledger' }
  | { kind: 'truncated' }
  | { kind: 'connection_gone' }
  | { kind: 'failed' };

type RowsPageProblem = 'invalid_cursor' | 'failed' | null;

/**
 * 34-S11c + 34-S12a — the suggestion ledger and the subtractive pass, one
 * screen because they are one act: you read the reasons and you disagree
 * with some of them.
 *
 * Every load outcome renders something true (the picker lesson): a ledger,
 * a named "this run has none", or a named failure with a retry. There is no
 * arrangement of server answers that renders an empty page.
 */
const MapLedgerStage: React.FC<{
  connectionId: string;
  onProceed: (decision: DecisionSnapshot) => void;
}> = ({ connectionId, onProceed }) => {
  const { transport, costModel, collaboratorCount } = useShelfmark();
  const [load, setLoad] = useState<LedgerLoad>({ phase: 'loading' });
  /** Rows accumulate across pages; the always-served block comes from the
   *  first page (the server sends it identically on every page). */
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageProblem, setPageProblem] = useState<RowsPageProblem>(null);

  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [readded, setReadded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [pendingReadd, setPendingReadd] = useState<SuggestionRow | null>(null);
  /** True once a decision exists server-side — the Continue gate. A decision
   *  is NOT optional on this flow (POST /:id/ingest answers 409 without one),
   *  so the button saves before it advances. */
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<SaveProblem | null>(null);
  const [tenantShape, setTenantShape] = useState<TenantShape>({ kind: 'loading' });

  const loadFirstPage = useCallback(async () => {
    setLoad({ phase: 'loading' });
    setPageProblem(null);
    try {
      const res = await fetch(apiUrl(transport, `/${connectionId}/map/suggestions`), { headers: transport.headers() });
      const body = await res.json().catch(() => null);
      if (res.status === 404) {
        setLoad({ phase: 'none' });
        return;
      }
      const parsed = res.status === 200 ? parseSuggestions(body) : null;
      if (!parsed) {
        setLoad({ phase: 'failed' });
        return;
      }
      setLoad({ phase: 'ready', payload: parsed });
      setRows(parsed.rows);
      setNextCursor(parsed.nextCursor);
    } catch {
      setLoad({ phase: 'failed' });
    }
  }, [connectionId, transport]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  // The decision already on record, if any — a returning customer must see
  // THEIR selection, not the default presented as if they had never decided.
  // 404 no_selection is not an error: it is the keep-everything default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(transport, `/${connectionId}/map/selection`), { headers: transport.headers() });
        if (res.status !== 200) return;
        const body = await res.json().catch(() => null);
        const b = asRecord(body);
        if (!b || cancelled) return;
        const asPaths = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
        setRemoved(new Set(asPaths(b.removedPaths)));
        setReadded(new Set(asPaths(b.readdedPaths)));
        setSavedAt(typeof b.decidedAt === 'string' ? b.decidedAt : null);
      } catch {
        /* no decision on record assumed — the honest default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, transport]);

  // The tenant's SHAPE, never its people: the host's collaboratorCount hook
  // answers with a count and nothing else. Rendering a colleague's address
  // here would be exactly the cross-tenant/other-people leak this package
  // refuses to build, and the count is the whole input to JRN-D1's
  // shared-tenant question. No hook configured, or a null/failed answer →
  // 'unknown', which renders the honest assume-shared sentence.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!collaboratorCount) {
        setTenantShape({ kind: 'unknown' });
        return;
      }
      try {
        const people = await collaboratorCount();
        if (cancelled) return;
        if (people === null || !Number.isFinite(people)) setTenantShape({ kind: 'unknown' });
        else if (people > 1) setTenantShape({ kind: 'shared', people });
        else setTenantShape({ kind: 'single' });
      } catch {
        if (!cancelled) setTenantShape({ kind: 'unknown' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collaboratorCount]);

  const loadNextPage = useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setPageProblem(null);
    try {
      const res = await fetch(
        apiUrl(transport, `/${connectionId}/map/suggestions?cursor=${encodeURIComponent(nextCursor)}`),
        { headers: transport.headers() }
      );
      const body = await res.json().catch(() => null);
      if (res.status === 400) {
        // The cursor is OPAQUE and was echoed verbatim; a 400 means the
        // server no longer recognises it (a rewritten ledger). Stop, say so —
        // never silently present a partial listing as the whole one.
        setPageProblem('invalid_cursor');
        setNextCursor(null);
        return;
      }
      const parsed = res.status === 200 ? parseSuggestions(body) : null;
      if (!parsed) {
        setPageProblem('failed');
        return;
      }
      setRows((prev) => [...prev, ...parsed.rows]);
      setNextCursor(parsed.nextCursor);
    } catch {
      setPageProblem('failed');
    } finally {
      setLoadingMore(false);
    }
  }, [connectionId, nextCursor, loadingMore, transport]);

  const rowsByPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  const payload = load.phase === 'ready' ? load.payload : null;
  const edits: SelectionEdits = useMemo(() => ({ removed, readded }), [removed, readded]);
  const totals = useMemo(
    () => (payload ? selectionTotals(payload, edits, rowsByPath, costModel) : null),
    [payload, edits, rowsByPath, costModel]
  );

  const onRemove = useCallback((row: SuggestionRow) => {
    setDirty(true);
    setReadded((prev) => {
      if (!prev.has(row.path)) return prev;
      const next = new Set(prev);
      next.delete(row.path);
      return next;
    });
    setRemoved((prev) => {
      if (parseVerdict(row.verdict).kind !== 'selected') return prev;
      const next = new Set(prev);
      next.add(row.path);
      return next;
    });
  }, []);

  const onUndo = useCallback((row: SuggestionRow) => {
    setDirty(true);
    setRemoved((prev) => {
      if (!prev.has(row.path)) return prev;
      const next = new Set(prev);
      next.delete(row.path);
      return next;
    });
    setReadded((prev) => {
      if (!prev.has(row.path)) return prev;
      const next = new Set(prev);
      next.delete(row.path);
      return next;
    });
  }, []);

  const confirmReadd = useCallback(() => {
    const row = pendingReadd;
    if (!row) return;
    setDirty(true);
    setRemoved((prev) => {
      if (!prev.has(row.path)) return prev;
      const next = new Set(prev);
      next.delete(row.path);
      return next;
    });
    setReadded((prev) => {
      const next = new Set(prev);
      next.add(row.path);
      return next;
    });
    setPendingReadd(null);
  }, [pendingReadd]);

  /** PUT the decision, REBUILT: both full arrays every time, exactly the
   *  rows that were acted on. Returns the saved timestamp, or null. */
  const save = useCallback(async (): Promise<string | null> => {
    setSaving(true);
    setSaveProblem(null);
    try {
      const res = await fetch(apiUrl(transport, `/${connectionId}/map/selection`), {
        method: 'PUT',
        headers: { ...transport.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ removedPaths: [...removed], readdedPaths: [...readded] }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200) {
        const at = typeof body?.decidedAt === 'string' ? body.decidedAt : new Date().toISOString();
        setSavedAt(at);
        setDirty(false);
        return at;
      }
      if (res.status === 400 && body?.error === 'selection_path_unknown') {
        setSaveProblem({ kind: 'path_unknown', field: String(body.field ?? '?'), path: String(body.path ?? '?') });
      } else if (res.status === 400 && body?.error === 'selection_paths_invalid') {
        setSaveProblem({ kind: 'paths_invalid', field: String(body.field ?? '?') });
      } else if (res.status === 409 && body?.error === 'suggestion_rows_truncated') {
        setSaveProblem({ kind: 'truncated' });
      } else if (res.status === 404 && body?.error === 'no_suggestions') {
        setSaveProblem({ kind: 'no_ledger' });
      } else if (res.status === 404) {
        setSaveProblem({ kind: 'connection_gone' });
      } else {
        setSaveProblem({ kind: 'failed' });
      }
      return null;
    } catch {
      setSaveProblem({ kind: 'failed' });
      return null;
    } finally {
      setSaving(false);
    }
  }, [connectionId, removed, readded, transport]);

  const proceed = useCallback(async () => {
    if (!payload || !totals) return;
    // The Decide phase is not optional: POST /:id/ingest answers 409 without
    // a decision on record, so the decision is written HERE before step 13
    // can promise anything.
    let at = savedAt;
    if (dirty || savedAt === null) {
      at = await save();
      if (at === null) return;
    }
    onProceed({
      files: totals.files,
      bytes: totals.bytes,
      tokens: totals.tokens,
      binaryShare: totals.binaryShare,
      costMethod: payload.costEstimate?.method ?? null,
      mirrorAgrees: totals.mirrorAgrees,
      decidedAt: at,
      sensitiveReport: payload.sensitiveReport,
    });
  }, [payload, totals, savedAt, dirty, save, onProceed]);

  if (load.phase === 'loading') {
    return <p className="text-xs text-slate-500">{t('map.ledger.loading')}</p>;
  }
  if (load.phase === 'none') {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-3">
        <h2 className="text-lg font-bold text-slate-100">{t('map.ledger.title')}</h2>
        <p className="text-sm text-slate-400 leading-relaxed">{t('map.ledger.noSuggestions')}</p>
        <BackLink />
      </section>
    );
  }
  if (load.phase === 'failed' || !payload || !totals) {
    return (
      <section className="bg-slate-900 border border-rose-900/60 rounded-lg p-6 space-y-3">
        <p className="text-sm text-rose-300 leading-relaxed">{t('map.ledger.loadError')}</p>
        <button
          type="button"
          onClick={() => void loadFirstPage()}
          className="text-xs font-semibold text-slate-300 border border-slate-700 rounded px-3 py-1.5 hover:border-slate-500"
        >
          {t('map.ledger.loadRetry')}
        </button>
      </section>
    );
  }

  const renderRow = (row: SuggestionRow): React.ReactNode => (
    <LedgerRow
      key={row.path}
      row={row}
      ranked={payload.ranking.ranked}
      selected={isRowSelected(row, edits)}
      edited={removed.has(row.path) ? 'removed' : readded.has(row.path) ? 'readded' : null}
      onRemove={onRemove}
      onUndo={onUndo}
      onOpenReadd={setPendingReadd}
    />
  );

  return (
    <section className="space-y-5">
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-3">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">{t('map.ledger.title')}</h2>
        <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">{t('map.ledger.subtitle')}</p>
        {/* Provenance, because a recommendation without the version of the
            rules that produced it cannot be argued with later. */}
        <p className="text-[10px] font-mono text-slate-600 break-all">
          {t('map.ledger.provenance', {
            policyVersion: payload.funnelPolicyVersion,
            policySha: payload.funnelPolicySha256,
            classifierVersion: payload.classifierVersion,
            classifierSha: payload.classifierSha256,
          })}
        </p>
      </div>

      <FunnelTable payload={payload} />

      <SensitiveCountsTable report={payload.sensitiveReport} />
      <SaidOutLoud report={payload.sensitiveReport} shape={tenantShape} />

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-2">
        <h3 className="text-sm font-semibold text-slate-200">{t('map.decide.title')}</h3>
        <p className="text-xs text-slate-400 leading-relaxed max-w-2xl">{t('map.decide.body')}</p>
      </div>

      {pendingReadd && (
        <ReaddConfirm row={pendingReadd} onConfirm={confirmReadd} onCancel={() => setPendingReadd(null)} />
      )}

      <div className="border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-2 bg-slate-950/60 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{t('map.ledger.rowsTitle')}</p>
          <p className="text-[11px] font-mono text-slate-500">
            {t('map.ledger.rowsCount', { shown: fmtCount(rows.length), total: fmtCount(payload.rowsTotal) })}
          </p>
        </div>
        <div className="px-4 py-1.5 border-b border-slate-800/60 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600">
          <span>{t('map.ledger.colFile')}</span>
          <span>{t('map.ledger.colSize')}</span>
          <span>{t('map.ledger.colReason')}</span>
          <span>{t('map.ledger.colAction')}</span>
        </div>
        {!payload.ranking.ranked && (
          <p className="px-4 py-2 text-[11px] text-slate-500 leading-relaxed border-b border-slate-800/60">
            {t('map.ledger.rankUnrankedCaption', { reason: payload.ranking.reason })}
          </p>
        )}
        {rows.length > MAP_LEDGER_TUNING.virtualizeRowsOver ? (
          <LedgerVirtualList rows={rows} render={renderRow} />
        ) : (
          <div>{rows.map(renderRow)}</div>
        )}
        <div className="px-4 py-2.5 border-t border-slate-800 space-y-1.5">
          {payload.rowsPageCap > 0 && (
            <p className="text-[11px] text-slate-600">
              {t('map.ledger.rowsPageCapNote', { cap: fmtCount(payload.rowsPageCap) })}
            </p>
          )}
          {pageProblem === 'invalid_cursor' && (
            <p role="alert" className="text-xs text-amber-300">
              {t('map.ledger.rowsCursorInvalid')}
            </p>
          )}
          {pageProblem === 'failed' && (
            <p role="alert" className="text-xs text-amber-300">
              {t('map.ledger.rowsPageFailed')}
            </p>
          )}
          {nextCursor !== null ? (
            <button
              type="button"
              onClick={() => void loadNextPage()}
              disabled={loadingMore}
              className="text-xs font-semibold text-slate-300 border border-slate-700 rounded px-3 py-1.5 hover:border-slate-500 disabled:opacity-40"
            >
              {loadingMore ? t('map.ledger.rowsLoadingMore') : t('map.ledger.rowsMore')}
            </button>
          ) : (
            pageProblem === null && <p className="text-[11px] text-slate-600">{t('map.ledger.rowsComplete')}</p>
          )}
          {/* The WRITE cap, stated in words. A ledger that stops without
              saying so is the silent cap this package does not ship. */}
          {payload.rowsTruncated && (
            <p role="alert" className="text-xs text-rose-300 leading-relaxed">
              {t('map.ledger.rowsTruncated', {
                cap: fmtCount(payload.rowCap),
                omitted: fmtCount(payload.rowsOmitted),
              })}
            </p>
          )}
        </div>
      </div>

      {/* The running total — live, and honest about which half of it is
          arithmetic and which half is an estimate. */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-2">
        <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{t('map.decide.totalsTitle')}</p>
        <p className="font-mono text-lg font-semibold text-slate-100">
          {t('map.decide.totalsCounts', { files: fmtCount(totals.files), bytes: fmtBytes(totals.bytes) })}
        </p>
        <p className="text-xs text-slate-400">
          {totals.edited
            ? t('map.decide.totalsDelta', {
                removed: fmtCount(totals.removedFiles),
                readded: fmtCount(totals.readdedFiles),
                defaultFiles: fmtCount(payload.defaultSelection.files),
              })
            : t('map.decide.totalsUnchanged')}
        </p>
        <CostRange totals={totals} method={payload.costEstimate?.method ?? null} />
        {dirty && <p className="text-xs text-amber-300 leading-relaxed">{t('map.decide.unsaved')}</p>}
        {savedAt && !dirty && (
          <p className="text-xs text-slate-500">{t('map.decide.saved', { date: fmtDate(savedAt) })}</p>
        )}
        {saveProblem && (
          <p role="alert" className="text-xs text-rose-300 leading-relaxed border border-rose-900/60 bg-rose-950/20 rounded px-3 py-2">
            {saveProblem.kind === 'path_unknown'
              ? t('map.decide.saveErrorPathUnknown', { path: saveProblem.path, field: saveProblem.field })
              : saveProblem.kind === 'paths_invalid'
                ? t('map.decide.saveErrorInvalid', { field: saveProblem.field })
                : saveProblem.kind === 'no_ledger'
                  ? t('map.decide.saveErrorNoLedger')
                  : saveProblem.kind === 'truncated'
                    ? t('map.decide.saveErrorTruncated')
                    : saveProblem.kind === 'connection_gone'
                      ? t('map.decide.saveErrorConnection')
                      : t('map.decide.saveFailed')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="text-xs font-semibold text-slate-200 border border-slate-700 rounded px-4 py-2 hover:border-slate-500 disabled:opacity-40"
          >
            {saving ? t('map.decide.saving') : t('map.decide.save')}
          </button>
          <button
            type="button"
            onClick={() => void proceed()}
            disabled={saving || payload.rowsTruncated}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-semibold rounded px-5 py-2.5 transition-colors"
          >
            {t('map.decide.continue')}
          </button>
          <BackLink />
        </div>
      </div>
    </section>
  );
};

/** The cost, as a RANGE with the binary share named — never a single number
 *  dressed up as knowledge. When the mirror and the server disagree the range
 *  for an edited selection is WITHDRAWN and the disagreement is named, rather
 *  than reported from arithmetic already proved wrong. */
const CostRange: React.FC<{ totals: SelectionTotals; method: string | null }> = ({ totals, method }) => (
  <div className="space-y-1">
    {totals.tokens ? (
      <p className="font-mono text-sm text-slate-200">
        {t('map.decide.costRange', {
          low: fmtCount(totals.tokens.low),
          high: fmtCount(totals.tokens.high),
        })}
      </p>
    ) : (
      <p className="text-xs text-amber-300 leading-relaxed">{t('map.decide.costEditedUnavailable')}</p>
    )}
    <p className="text-xs text-slate-400 leading-relaxed">
      {totals.binaryShare > 0
        ? t('map.decide.costBinaryShare', { pct: fmtPct(totals.binaryShare * 100) })
        : t('map.decide.costAllText')}
    </p>
    {!totals.mirrorAgrees && method !== null && (
      <p role="alert" className="text-xs text-amber-300 leading-relaxed">
        {t('map.decide.costDisagreement')}
      </p>
    )}
    {method !== null && <p className="text-[10px] text-slate-600 leading-relaxed">{t('map.decide.costMethod', { method })}</p>}
  </div>
);

// ── step 13: ingest consent, the second receipt ────────────────────────────

type IngestProblem =
  | { kind: 'stale' }
  | { kind: 'connectors_disabled' }
  | { kind: 'consent_not_active' }
  | { kind: 'grant_failed' }
  | { kind: 'start_failed' }
  | { kind: 'connection_gone' }
  | { kind: 'no_selection' };

const INGEST_PROBLEM_MESSAGE: Record<IngestProblem['kind'], MsgKey> = {
  stale: 'ingestConsent.staleDisclosure',
  connectors_disabled: 'ingestConsent.connectorsDisabled',
  consent_not_active: 'ingestConsent.consentNotActive',
  grant_failed: 'ingestConsent.grantFailed',
  start_failed: 'ingestConsent.startFailed',
  connection_gone: 'ingestConsent.connectionGone',
  no_selection: 'ingestConsent.noSelection',
};

const INGEST_CONSENT_SCOPE = 'ingest_content';

/**
 * 34-S13a/b — the SECOND receipt. Same shape as the map consent because it
 * is the same promise kept twice: the button label IS the record, carrying
 * the verb and the real count off the live selection ("Open and read 1,062
 * files"), the SHA-pinned words are on screen verbatim, and the grant echoes
 * the SHA of the exact bytes displayed.
 *
 * THE LABEL QUESTION LANDS HERE. The folder picker deliberately stopped
 * asking it (34-S07c) because classifying is a decision about file CONTENTS
 * and nothing had been read; the map is the evidence that makes it
 * answerable, so the select sits beside the map's own findings. The label
 * vocabulary is the HOST's (provider config) — with none configured the
 * picker is hidden, no label travels, and the host's LabelPolicy default
 * applies server-side.
 */
const MapIngestConsentStage: React.FC<{
  connectionId: string;
  decision: DecisionSnapshot;
  onStarted: (workflowId: string) => void;
  onBackToLedger: () => void;
}> = ({ connectionId, decision, onStarted, onBackToLedger }) => {
  const { transport, labels } = useShelfmark();
  const { state: disclosure, refetch: fetchDisclosure } = useDisclosure(INGEST_CONSENT_SCOPE);
  const [activeGrant, setActiveGrant] = useState<ActiveConsent | null>(null);
  const [busy, setBusy] = useState<ConsentBusy>(null);
  const [problem, setProblem] = useState<IngestProblem | null>(null);
  /** Pre-filled with the host's FIRST offered label — the value the picker
   *  used to carry, now answered at the point the evidence exists. The
   *  host's LabelPolicy may still cap it server-side (resolve() lowers,
   *  never raises). */
  const [label, setLabel] = useState<string>(labels[0]?.id ?? '');
  const grantedThisSession = useRef(false);

  useEffect(() => {
    void fetchDisclosure();
    (async () => {
      try {
        const res = await fetch(apiUrl(transport, `/${connectionId}/consents`), { headers: transport.headers() });
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        const active = Array.isArray(body?.active) ? (body.active as ActiveConsent[]) : [];
        setActiveGrant(active.find((c) => c && c.scope === INGEST_CONSENT_SCOPE) ?? null);
      } catch {
        /* no active grant assumed — an append-only duplicate grant is
           harmless; blocking the flow on a history read is not */
      }
    })();
  }, [connectionId, fetchDisclosure, transport]);

  const startIngest = useCallback(async (): Promise<void> => {
    setBusy('starting');
    setProblem(null);
    try {
      const res = await fetch(apiUrl(transport, `/${connectionId}/ingest`), {
        method: 'POST',
        headers: { ...transport.headers(), 'Content-Type': 'application/json' },
        // No labels configured → an empty body; the host's LabelPolicy
        // default applies server-side rather than this UI inventing one.
        body: JSON.stringify(label !== '' ? { defaultLabel: label } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        onStarted(typeof body?.workflowId === 'string' ? body.workflowId : '');
        return;
      }
      if (res.status === 409 && body?.error === 'no_selection') {
        // Honest routing: the decision is not on record, so the ledger is
        // where this goes — never a retry loop against a 409 that cannot heal.
        setProblem({ kind: 'no_selection' });
      } else if (res.status === 403 && body?.error === 'ingest_consent_required') {
        grantedThisSession.current = false;
        setActiveGrant(null);
        setProblem({ kind: 'consent_not_active' });
      } else if (res.status === 403) {
        setProblem({ kind: 'connectors_disabled' });
      } else if (res.status === 404) {
        setProblem({ kind: 'connection_gone' });
      } else {
        // 503 and anything unnamed: consent stays granted, ONLY the start is
        // retried — the same discipline the map consent screen keeps.
        setProblem({ kind: 'start_failed' });
      }
    } catch {
      setProblem({ kind: 'start_failed' });
    } finally {
      setBusy(null);
    }
  }, [connectionId, label, onStarted, transport]);

  const onPrimary = useCallback(async () => {
    if (busy !== null) return;
    if (grantedThisSession.current || activeGrant) {
      await startIngest();
      return;
    }
    if (disclosure.phase !== 'ready') return;
    setBusy('granting');
    setProblem(null);
    try {
      const res = await fetch(apiUrl(transport, `/${connectionId}/consents`), {
        method: 'POST',
        headers: { ...transport.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: INGEST_CONSENT_SCOPE,
          locale: getLocale(),
          disclosureSha256: disclosure.doc.sha256,
          target: {},
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) {
        grantedThisSession.current = true;
        await startIngest();
        return;
      }
      setBusy(null);
      if (res.status === 409 && body?.error === 'disclosure_text_mismatch') {
        setProblem({ kind: 'stale' });
        await fetchDisclosure();
      } else if (res.status === 403) {
        setProblem({ kind: 'connectors_disabled' });
      } else if (res.status === 404) {
        setProblem({ kind: 'connection_gone' });
      } else {
        setProblem({ kind: 'grant_failed' });
      }
    } catch {
      setBusy(null);
      setProblem({ kind: 'grant_failed' });
    }
  }, [busy, activeGrant, disclosure, connectionId, startIngest, fetchDisclosure, transport]);

  const consentOnRecord = activeGrant !== null || grantedThisSession.current;
  const blocked =
    problem !== null &&
    (problem.kind === 'connectors_disabled' || problem.kind === 'connection_gone' || problem.kind === 'no_selection');

  const ctaLabel =
    busy === 'granting'
      ? t('ingestConsent.granting')
      : busy === 'starting'
        ? t('ingestConsent.starting')
        : problem?.kind === 'start_failed'
          ? t('ingestConsent.retryStart')
          : decision.files === 1
            ? t('ingestConsent.ctaOne')
            : t('ingestConsent.cta', { n: fmtCount(decision.files) });

  return (
    <section className="bg-slate-900 border border-amber-900/50 rounded-lg p-6 space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-100">{t('ingestConsent.title')}</h2>
        <p className="mt-2 text-sm text-slate-400 leading-relaxed max-w-2xl">{t('ingestConsent.honesty')}</p>
        <p className="mt-2 text-xs font-mono text-slate-500">
          {decision.decidedAt
            ? t('ingestConsent.selectionLine', {
                files: fmtCount(decision.files),
                bytes: fmtBytes(decision.bytes),
                date: fmtDate(decision.decidedAt),
              })
            : t('ingestConsent.selectionLineUndated', {
                files: fmtCount(decision.files),
                bytes: fmtBytes(decision.bytes),
              })}
        </p>
      </div>

      {/* The cost, as a range, with the binary share named. */}
      <div className="border border-slate-800 rounded-lg bg-slate-950/60 p-4 space-y-1">
        <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{t('ingestConsent.costTitle')}</p>
        <CostRange
          totals={{
            files: decision.files,
            bytes: decision.bytes,
            removedFiles: 0,
            readdedFiles: 0,
            edited: false,
            binaryShare: decision.binaryShare,
            tokens: decision.tokens,
            mirrorAgrees: decision.mirrorAgrees,
          }}
          method={decision.costMethod}
        />
      </div>

      {/* THE LABEL QUESTION, with the map's own findings as evidence. The
          whole block is conditional on the host offering labels at all —
          empty list means no label UI, by design. */}
      <div className="border border-slate-800 rounded-lg p-4 space-y-3">
        {labels.length > 0 && (
          <>
            <label htmlFor="ingest-label" className="block text-sm font-semibold text-slate-200">
              {t('ingestConsent.clearanceLabel')}
            </label>
            <select
              id="ingest-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200"
            >
              {labels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 leading-relaxed max-w-2xl">{t('ingestConsent.clearanceHelp')}</p>
            {/* THE CAP, NAMED BEFORE IT BITES. The host's LabelPolicy.resolve
                may silently lower a requested label — correct, and invisible
                from here. Rather than duplicate the host's label lattice in
                this UI (a second copy of a rule set is the thing that
                diverges), the bound is simply stated. */}
            <p className="text-xs text-amber-300/80 leading-relaxed max-w-2xl">{t('ingestConsent.labelCap')}</p>
            <p className="text-xs text-slate-400">{t('ingestConsent.clearanceEvidence')}</p>
          </>
        )}
        {/* Counts only here too — the evidence for a classification decision
            is how MANY sensitive-shaped documents are in scope, never which. */}
        <SensitiveCountsTable report={decision.sensitiveReport} showBody={false} />
      </div>

      <DisclosureBlock state={disclosure} onRetry={() => void fetchDisclosure()} />

      {activeGrant && (
        <p className="text-xs text-slate-500 leading-relaxed">
          {t('ingestConsent.alreadyConsented', { date: fmtDate(activeGrant.grantedAt) })}
        </p>
      )}

      {problem && (
        <p
          role="alert"
          className={`text-xs leading-relaxed border rounded px-3 py-2 ${
            problem.kind === 'start_failed' || problem.kind === 'stale'
              ? 'text-amber-300 border-amber-900/60 bg-amber-950/20'
              : 'text-rose-300 border-rose-900/60 bg-rose-950/20'
          }`}
        >
          {t(INGEST_PROBLEM_MESSAGE[problem.kind])}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* THE BUTTON IS THE RECORD — the verb, and the real count. */}
        <button
          type="button"
          onClick={onPrimary}
          disabled={busy !== null || blocked || (disclosure.phase !== 'ready' && !consentOnRecord)}
          className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-semibold rounded px-5 py-2.5 transition-colors"
        >
          {ctaLabel}
        </button>
        <button
          type="button"
          onClick={onBackToLedger}
          className="text-xs text-slate-400 border border-slate-700 rounded px-3 py-1.5 hover:border-slate-500 hover:text-slate-200"
        >
          {t('ingestConsent.backToLedger')}
        </button>
        <BackLink />
      </div>
    </section>
  );
};

/**
 * The handoff after 202.
 *
 * Until 34-S14f this stage carried an amber banner saying live progress was
 * NOT on the connectors screen — true when it was written, and the honest
 * thing to say rather than sending a customer to a panel with no sign their
 * read was running. It is no longer true: the selective-ingest workflow now
 * mirrors its progress onto the connection document as `lastIngestProgress`,
 * the connections list already serves it, and <Connections/> renders it in
 * preference to the older all-at-once sync panel. So the banner is gone and
 * the link says what the customer will actually see there.
 *
 * Deliberately still a screen and not a bare redirect: `workflowId` is the
 * only receipt this flow ever hands over, and a redirect would destroy it
 * before it was read. The connectors panel repeats the run id, so nothing is
 * lost by clicking through — but nothing is lost by pausing here either.
 */
const MapIngestStartedStage: React.FC<{ workflowId: string; files: number }> = ({ workflowId, files }) => {
  const { routes } = useShelfmark();
  return (
    <section className="bg-slate-900 border border-emerald-900/60 rounded-lg p-6 space-y-3">
      <h2 className="text-lg font-bold text-emerald-300">{t('map.ingestStarted.title')}</h2>
      <p className="text-sm text-slate-400 leading-relaxed">{t('map.ingestStarted.body', { files: fmtCount(files) })}</p>
      {workflowId !== '' && (
        <p className="text-[10px] font-mono text-slate-600">{t('map.ingestStarted.workflow', { workflowId })}</p>
      )}
      <p className="text-xs text-slate-400 leading-relaxed border border-slate-800 bg-slate-950/40 rounded px-3 py-2">
        {t('map.ingestStarted.watch', { files: fmtCount(files) })}
      </p>
      {routes.renderLink(
        routes.connections,
        <span className="inline-block bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded px-5 py-2.5 transition-colors">
          {t('map.ingestStarted.cta')} →
        </span>
      )}
    </section>
  );
};

export interface DriveMapProps {
  connectionId: string;
  /** The scope the host's folder picker carried here (its own router state,
   * query params, whatever it chose). Absent → resolved from the
   * connection's stored root, so the consent screen never names a folder it
   * is not sure of. */
  scope?: PickedScope | null;
}

export const DriveMap: React.FC<DriveMapProps> = ({ connectionId, scope: scopeProp = null }) => {
  const { transport } = useShelfmark();
  const [stage, setStage] = useState<MapFlowStage>({ kind: 'resolving' });
  /** The scope this map covers. The prop when the host's picker sent one;
   * otherwise resolved from the connection's stored root (deep link,
   * refresh). */
  const [scope, setScope] = useState<PickedScope | null>(scopeFromProp(scopeProp));

  const resolve = useCallback(async () => {
    setStage({ kind: 'resolving' });
    try {
      const res = await fetch(apiUrl(transport, `/${connectionId}/map`), { headers: transport.headers() });
      const body = await res.json().catch(() => null);
      setStage(stageForRunResolution(res.status, body));
    } catch {
      setStage({ kind: 'resolveFailed' });
    }
  }, [connectionId, transport]);

  useEffect(() => {
    resolve();
  }, [resolve]);

  // Scope fallback for arrivals without a scope prop: the connection's own
  // stored root. POST /:id/map falls back to it server-side anyway; this
  // fetch exists so the SCREEN can say which folder the consent covers
  // instead of consenting to an unnamed one.
  useEffect(() => {
    if (scope !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(transport.baseUrl, { headers: transport.headers() });
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        const conn = Array.isArray(body?.connections)
          ? body.connections.find((c: { connectionId?: string }) => c?.connectionId === connectionId)
          : undefined;
        if (!cancelled && conn) {
          setScope({
            rootFolderId: typeof conn.rootFolderId === 'string' ? conn.rootFolderId : null,
            rootPath: typeof conn.rootPath === 'string' ? conn.rootPath : null,
          });
        }
      } catch {
        /* the consent stage renders its unknown-scope line until one resolves */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, connectionId, transport]);

  return (
    <div className="space-y-6">
      {stage.kind === 'resolving' ? (
        <p className="text-xs text-slate-500">{t('map.resolving')}</p>
      ) : stage.kind === 'resolveFailed' ? (
        <div className="bg-slate-900 border border-rose-900/60 rounded-lg p-5">
          <p className="text-xs text-rose-300">{t('map.resolveError')}</p>
          <button
            type="button"
            onClick={resolve}
            className="mt-2 text-xs font-semibold text-slate-300 border border-slate-700 rounded px-3 py-1.5 hover:border-slate-500"
          >
            {t('map.resolveRetry')}
          </button>
        </div>
      ) : stage.kind === 'consent' ? (
        <MapConsentStage
          connectionId={connectionId}
          scope={scope}
          onStarted={() => setStage({ kind: 'mapping', run: null })}
        />
      ) : stage.kind === 'mapping' ? (
        <MapMappingStage
          connectionId={connectionId}
          run={stage.run}
          // The terminal frame routes through the SAME derivation as the
          // mount-time resolution: 'complete' lands, refusal statuses get
          // their own stage. ('failed' never reaches here — the stream
          // stage renders it in place, transcript retained.)
          onTerminal={(terminalRun) => setStage(stageForRunResolution(200, terminalRun))}
        />
      ) : stage.kind === 'landed' ? (
        <MapLandedStage
          connectionId={connectionId}
          run={stage.run}
          // 34-S11c — "Review what to ingest" is the entry into Decide.
          onReview={() => setStage({ kind: 'ledger' })}
          // JRN-9 — route a re-map back through the consent stage rather
          // than adding a second start path. That stage already handles the
          // active-consent fast path (an existing grant skips straight to
          // starting), so a retry reuses tested code and never demands a
          // consent the customer already gave: the record outlives the run.
          onRemap={() => setStage({ kind: 'consent' })}
        />
      ) : stage.kind === 'ledger' ? (
        <MapLedgerStage
          connectionId={connectionId}
          onProceed={(decision) => setStage({ kind: 'ingestConsent', decision })}
        />
      ) : stage.kind === 'ingestConsent' ? (
        <MapIngestConsentStage
          connectionId={connectionId}
          decision={stage.decision}
          onStarted={(workflowId) => setStage({ kind: 'ingestStarted', workflowId, files: stage.decision.files })}
          // 409 no_selection routes BACK to the ledger, honestly — the
          // decision is what is missing, and the ledger is where it is made.
          onBackToLedger={() => setStage({ kind: 'ledger' })}
        />
      ) : stage.kind === 'ingestStarted' ? (
        <MapIngestStartedStage workflowId={stage.workflowId} files={stage.files} />
      ) : (
        <MapRefusedStage run={stage.run} />
      )}
    </div>
  );
};
