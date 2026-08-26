// SPDX-License-Identifier: Apache-2.0
import { afterAll, describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DriveMap,
  DEFAULT_COST_MODEL,
  COST_MIRROR_OF,
  MAP_LEDGER_TUNING,
  MAP_STREAM_TUNING,
  MapLandedStage,
  ShelfmarkProvider,
  computeInversion,
  funnelReconciliation,
  isRowSelected,
  parseSuggestions,
  parseVerdict,
  selectionTotals,
  stageForRunResolution,
  type ShelfmarkConfig,
} from '../src/index';

const LABELS = [
  { id: 'commercial', label: 'commercial' },
  { id: 'unclassified', label: 'unclassified' },
];

// Deliberately odd spacing and wording: the assertion below compares the
// rendered node's textContent to THIS string byte-for-byte, which is what
// "verbatim" means — a renderer that trims, rewraps or paraphrases fails.
const DISCLOSURE_TEXT =
  'The operator will read the names, sizes, dates and sharing structure of every item under the folder you chose. It will not open any file.';
const DISCLOSURE_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const NEW_DISCLOSURE_TEXT = 'REVISED consent wording, reviewed 2026-08-20. It still opens nothing.';
const NEW_DISCLOSURE_SHA = '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae';

interface MockRes {
  status: number;
  body: unknown;
}

const res = (status: number, body: unknown): MockRes => ({ status, body });

const okDisclosure = (text = DISCLOSURE_TEXT, sha256 = DISCLOSURE_SHA): MockRes =>
  res(200, { disclosureId: 'map-disclosure-v1', scope: 'map_metadata', locale: 'en', text, sha256 });

const noConsents: MockRes = res(200, { connectionId: 'conn-1', events: [], active: [] });

// The SECOND disclosure — step 13's own words, deliberately different from
// the map's so a test that renders the wrong one fails loudly.
const INGEST_DISCLOSURE_TEXT =
  'The operator will open each file you selected, read the words inside it, and store that text so it can be searched.';
const INGEST_DISCLOSURE_SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const NEW_INGEST_DISCLOSURE_TEXT = 'REVISED reading disclosure, reviewed 2026-08-20.';
const NEW_INGEST_DISCLOSURE_SHA = '60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752';

const okIngestDisclosure = (text = INGEST_DISCLOSURE_TEXT, sha256 = INGEST_DISCLOSURE_SHA): MockRes =>
  res(200, { disclosureId: 'ingest-disclosure-v1', scope: 'ingest_content', locale: 'en', text, sha256 });

/**
 * A scripted SSE connection for GET /:id/map/stream: a Response-shaped
 * object whose body reader is fed from a controllable chunk queue, so tests
 * push frames/heartbeats/drops mid-render exactly the way the transport
 * delivers them (including one frame split across two chunks — the reader
 * buffers bytes, not frames).
 */
interface SseScript {
  response: unknown;
  /** One `data: <json>\n\n` frame. */
  frame(payload: unknown): void;
  /** One `: hb\n\n` comment heartbeat — must be ignored by the reader. */
  comment(): void;
  /** Raw transport bytes — for splitting a frame across chunks. */
  raw(text: string): void;
  /** Server closes the stream (done) — a transport drop if no terminal frame came. */
  close(): void;
  /** Transport error mid-read. */
  fail(message?: string): void;
}

function sseScript(): SseScript {
  const encoder = new TextEncoder();
  const chunks: Array<{ value?: Uint8Array; done?: boolean; error?: Error }> = [];
  let pending: { resolve: (r: { done: boolean; value?: Uint8Array }) => void; reject: (e: Error) => void } | null =
    null;
  const deliver = () => {
    if (!pending || chunks.length === 0) return;
    const next = chunks.shift()!;
    const p = pending;
    pending = null;
    if (next.error) p.reject(next.error);
    else p.resolve({ done: next.done === true, value: next.value });
  };
  const push = (c: { value?: Uint8Array; done?: boolean; error?: Error }) => {
    chunks.push(c);
    deliver();
  };
  return {
    response: {
      ok: true,
      status: 200,
      json: async () => ({}),
      body: {
        getReader: () => ({
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
              pending = { resolve, reject };
              deliver();
            }),
          cancel: async () => {},
        }),
      },
    },
    frame: (payload) => push({ value: encoder.encode(`data: ${JSON.stringify(payload)}\n\n`) }),
    comment: () => push({ value: encoder.encode(': hb\n\n') }),
    raw: (text) => push({ value: encoder.encode(text) }),
    close: () => push({ done: true }),
    fail: (message = 'transport down') => push({ error: new Error(message) }),
  };
}

interface ApiConfig {
  /** GET <baseUrl> throws (transport down) — the deep-link scope lookup's
   *  failure path. */
  connectionsReject?: boolean;
  /** GET /conn-1/map — the stage resolution, AND every polling-fallback tick
   * (the mock is static, the dedupe is the point). */
  runResolution?: MockRes;
  /** GET /consents/disclosure — a queue, so the 409 re-fetch can serve new text. */
  disclosure?: MockRes[];
  /** GET /:id/consents — the active-grant lookup. */
  consents?: MockRes;
  /** POST /:id/consents — the grant. */
  grant?: MockRes[];
  /** POST /:id/map — the start. */
  mapStart?: MockRes[];
  /** GET /:id/map/stream — scripted connections in connection order;
   * 'reject' rejects the fetch itself (transport down before headers). An
   * exhausted/absent queue serves a silent, never-speaking open stream so
   * consent-stage tests are not entangled with the stream transport. */
  streams?: Array<SseScript | 'reject'>;

  // ── 34-S11c/S12a/S13a — the Decide endpoints ──
  /** GET /:id/map/suggestions — a queue, so pagination serves page 2 next. */
  suggestions?: MockRes[];
  /** GET /:id/map/selection — the decision already on record (404 = none). */
  selectionGet?: MockRes;
  /** PUT /:id/map/selection — a queue; bodies are recorded. */
  selectionPut?: MockRes[];
  /** POST /:id/ingest — a queue; bodies are recorded. */
  ingest?: MockRes[];
  /** The tenant's SHAPE via the host's collaboratorCount hook. Default: one
   *  person (single-owner), so the shared-tenant note is absent unless a
   *  test deliberately asks for a team. 'reject' is the hook-throws path,
   *  null the honest "could not tell". */
  collaborators?: number | null | 'reject';
  /** GET disclosure?scope=ingest_content — its own queue, so the map's
   *  disclosure queue is untouched by step-13 tests. */
  ingestDisclosure?: MockRes[];
}

/** The collaborators knob for the CURRENT render — read lazily by the
 * provider config's collaboratorCount hook. */
let currentCollaborators: number | null | 'reject' = 1;

/**
 * URL-dispatching fetch mock recording call ORDER and POST bodies — the
 * ordering assertions ("map start fires only after the grant succeeds")
 * are the point of this page, so the harness records enough to make them.
 */
function installApi(cfg: ApiConfig) {
  currentCollaborators = cfg.collaborators === undefined ? 1 : cfg.collaborators;
  const order: string[] = [];
  const grantBodies: any[] = [];
  const mapStartBodies: any[] = [];
  const selectionBodies: any[] = [];
  const ingestBodies: any[] = [];
  const suggestionsUrls: string[] = [];
  const disclosureQueue = [...(cfg.disclosure ?? [okDisclosure()])];
  const ingestDisclosureQueue = [...(cfg.ingestDisclosure ?? [okIngestDisclosure()])];
  const grantQueue = [...(cfg.grant ?? [])];
  const mapStartQueue = [...(cfg.mapStart ?? [])];
  const streamQueue = [...(cfg.streams ?? [])];
  const suggestionsQueue = [...(cfg.suggestions ?? [])];
  const selectionPutQueue = [...(cfg.selectionPut ?? [])];
  const ingestQueue = [...(cfg.ingest ?? [])];

  const respond = (r: MockRes) => ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.body,
  });
  const next = (queue: MockRes[], label: string): MockRes => {
    const head = queue.shift();
    if (!head) throw new Error(`no scripted response left for ${label}`);
    return head;
  };

  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && u.startsWith('/api/v1/connectors/consents/disclosure')) {
      // Scope-dispatched: the two consents are two disclosures, and a test
      // that served the map's words for the ingest scope would be proving
      // nothing about step 13.
      if (u.includes('scope=ingest_content')) {
        order.push('GET ingest disclosure');
        return respond(next(ingestDisclosureQueue, 'GET ingest disclosure'));
      }
      order.push('GET disclosure');
      return respond(next(disclosureQueue, 'GET disclosure'));
    }
    if (method === 'GET' && u.startsWith('/api/v1/connectors/conn-1/map/suggestions')) {
      order.push('GET suggestions');
      suggestionsUrls.push(u);
      return respond(next(suggestionsQueue, 'GET suggestions'));
    }
    if (method === 'GET' && u === '/api/v1/connectors/conn-1/map/selection') {
      order.push('GET selection');
      return respond(cfg.selectionGet ?? res(404, { error: 'no_selection' }));
    }
    if (method === 'PUT' && u === '/api/v1/connectors/conn-1/map/selection') {
      order.push('PUT selection');
      selectionBodies.push(JSON.parse(String(init?.body ?? 'null')));
      return respond(next(selectionPutQueue, 'PUT selection'));
    }
    if (method === 'POST' && u === '/api/v1/connectors/conn-1/ingest') {
      order.push('POST ingest');
      ingestBodies.push(JSON.parse(String(init?.body ?? 'null')));
      return respond(next(ingestQueue, 'POST ingest'));
    }
    if (method === 'GET' && u === '/api/v1/connectors/conn-1/map/stream') {
      order.push('GET stream');
      const head = streamQueue.shift();
      if (head === 'reject') throw new Error('stream transport down');
      if (head) return head.response as any;
      return sseScript().response as any; // silent open stream
    }
    if (method === 'GET' && u === '/api/v1/connectors/conn-1/map') {
      order.push('GET map');
      return respond(cfg.runResolution ?? res(404, { error: 'no_map_run' }));
    }
    if (method === 'GET' && u === '/api/v1/connectors/conn-1/consents') {
      order.push('GET consents');
      return respond(cfg.consents ?? noConsents);
    }
    if (method === 'POST' && u === '/api/v1/connectors/conn-1/consents') {
      order.push('POST consents');
      grantBodies.push(JSON.parse(String(init?.body ?? 'null')));
      return respond(next(grantQueue, 'POST consents'));
    }
    if (method === 'POST' && u === '/api/v1/connectors/conn-1/map') {
      order.push('POST map');
      mapStartBodies.push(JSON.parse(String(init?.body ?? 'null')));
      return respond(next(mapStartQueue, 'POST map'));
    }
    if (method === 'GET' && u === '/api/v1/connectors') {
      order.push('GET connectors');
      if (cfg.connectionsReject) throw new Error('connections lookup down');
      return respond(res(200, { connections: [] }));
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }) as any;

  return { order, grantBodies, mapStartBodies, selectionBodies, ingestBodies, suggestionsUrls };
}

const PICKED_SCOPE = { rootFolderId: 'f-finance', rootPath: '/Finance' };

/** The host harness. No router: the routes seam renders plain anchors, which
 * is a legitimate host and keeps these tests about the components. The
 * collaboratorCount hook reads the per-test knob. */
const harnessConfig: ShelfmarkConfig = {
  transport: {
    baseUrl: '/api/v1/connectors',
    headers: () => ({ Authorization: 'Bearer test-token' }),
  },
  routes: {
    connections: '/connectors',
    map: (id: string) => `/connectors/${id}/map`,
    renderLink: (to: string, label: React.ReactNode) => <a href={to}>{label}</a>,
  },
  labels: LABELS,
  collaboratorCount: async () => {
    if (currentCollaborators === 'reject') throw new Error('collaborator lookup down');
    return currentCollaborators;
  },
};

function renderMap(scope: unknown = PICKED_SCOPE) {
  return render(
    <ShelfmarkProvider config={harnessConfig}>
      <DriveMap connectionId="conn-1" scope={scope as any} />
    </ShelfmarkProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  currentCollaborators = 1;
  // Stream timing at test scale — the product's 700 ms reading pace and the
  // reconnect/poll delays would make real-timer tests glacial. Tests that
  // assert PACING itself set revealMs back up explicitly.
  MAP_STREAM_TUNING.revealMs = 0;
  MAP_STREAM_TUNING.reconnectDelayMs = 0;
  MAP_STREAM_TUNING.pollMs = 25;
});

afterAll(() => {
  MAP_STREAM_TUNING.revealMs = 700;
  MAP_STREAM_TUNING.reconnectDelayMs = 500;
  MAP_STREAM_TUNING.pollMs = 2500;
});

describe('stageForRunResolution', () => {
  it('derives the stage the task table specifies', () => {
    expect(stageForRunResolution(404, { error: 'no_map_run' })).toEqual({ kind: 'consent' });
    expect(stageForRunResolution(200, { status: 'mapping' }).kind).toBe('mapping');
    expect(stageForRunResolution(200, { status: 'complete' }).kind).toBe('landed');
    expect(stageForRunResolution(200, { status: 'failed' }).kind).toBe('landed');
    expect(stageForRunResolution(200, { status: 'refused_no_consent' }).kind).toBe('refused');
    expect(stageForRunResolution(200, { status: 'unsupported_provider' }).kind).toBe('refused');
  });

  it('treats anything the server did not name as a resolve failure, never as consent', () => {
    // A 404 that is NOT no_map_run (proxy miss, gone connection) must not
    // invite a consent grant against an unknown state.
    expect(stageForRunResolution(404, { error: 'No connection conn-1' })).toEqual({ kind: 'resolveFailed' });
    expect(stageForRunResolution(404, null)).toEqual({ kind: 'resolveFailed' });
    expect(stageForRunResolution(500, { error: 'boom' })).toEqual({ kind: 'resolveFailed' });
    expect(stageForRunResolution(200, { status: 'weird_future_status' })).toEqual({ kind: 'resolveFailed' });
  });
});

describe('DriveMap — consent stage', () => {
  it('renders the fetched disclosure VERBATIM, with the spec titles and the honest table row', async () => {
    installApi({});
    renderMap();

    await waitFor(() => expect(screen.getByText(/It will not open any file\./)).toBeInTheDocument());

    // Verbatim: the rendered node's text is byte-identical to the payload.
    const disclosureNode = screen.getByText(/The operator will read the names/);
    expect(disclosureNode.textContent).toBe(DISCLOSURE_TEXT);
    expect(screen.getByText(new RegExp(DISCLOSURE_SHA))).toBeInTheDocument();

    // 34-S08a/b copy: the title, the honesty line, and the comparison row
    // that was nearly a lie — names and counts DO leave, to inference.
    expect(screen.getByText('Read the names, not the files.')).toBeInTheDocument();
    expect(screen.getByText(/tells us something even if it is empty/)).toBeInTheDocument();
    expect(screen.getByText('names and counts, to the inference service')).toBeInTheDocument();
    // The consent verb is the button label; "agree" appears nowhere.
    expect(screen.getByRole('button', { name: 'Map this folder — read names only' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bagree\b/i);
  });

  it('never asserts a scope it could not confirm — no scope prop + failed lookup says so instead of claiming "/"', async () => {
    // The server falls back to the connection's STORED root, which may be a
    // subfolder like /Finance. A consent screen that says "Covers / and
    // everything inside it" in that state has mislabelled its own scope —
    // the one thing a consent screen may never do.
    installApi({ connectionsReject: true });
    renderMap(null); // deep link: no picker scope

    await waitFor(() => expect(screen.getByText(/could not confirm which folder/i)).toBeInTheDocument());
    expect(screen.queryByText(/Covers \/ and everything inside it/)).not.toBeInTheDocument();
    // The consent action itself is still available — the copy is honest
    // about what it covers, so the customer can still decide.
    expect(screen.getByRole('button', { name: 'Map this folder — read names only' })).toBeInTheDocument();
  });

  it('grants echoing the exact displayed sha, and starts the map only after the grant succeeds', async () => {
    const api = installApi({
      grant: [res(201, { consentId: 'c-1', disclosureSha256: DISCLOSURE_SHA })],
      mapStart: [res(202, { status: 'mapping', connectionId: 'conn-1', workflowId: 'wf-1' })],
    });
    const user = userEvent.setup();
    renderMap();

    await waitFor(() => expect(screen.getByText(/It will not open any file\./)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Map this folder — read names only' }));

    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    // The grant echoed the EXACT sha rendered — the round trip that lets the
    // record say which words were read.
    expect(api.grantBodies).toHaveLength(1);
    expect(api.grantBodies[0].disclosureSha256).toBe(DISCLOSURE_SHA);
    expect(api.grantBodies[0].scope).toBe('map_metadata');
    expect(api.grantBodies[0].locale).toBe('en');

    // The map start carried the scope the picker sent us here with.
    expect(api.mapStartBodies).toHaveLength(1);
    expect(api.mapStartBodies[0]).toEqual({ rootFolderId: 'f-finance', rootPath: '/Finance' });

    // Order: consent grant strictly before the map start.
    expect(api.order.indexOf('POST consents')).toBeLessThan(api.order.indexOf('POST map'));
  });

  it('never starts the map when the grant fails', async () => {
    const api = installApi({
      grant: [res(503, { error: 'consent_not_recorded' })],
    });
    const user = userEvent.setup();
    renderMap();

    await waitFor(() => expect(screen.getByText(/It will not open any file\./)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Map this folder — read names only' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/consent was not recorded/i));
    expect(api.order).not.toContain('POST map');
  });

  it('on 409 disclosure_text_mismatch: re-fetches the text, says so, and does NOT silently re-grant', async () => {
    const api = installApi({
      disclosure: [okDisclosure(), okDisclosure(NEW_DISCLOSURE_TEXT, NEW_DISCLOSURE_SHA)],
      grant: [res(409, { error: 'disclosure_text_mismatch' })],
    });
    const user = userEvent.setup();
    renderMap();

    await waitFor(() => expect(screen.getByText(/It will not open any file\./)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Map this folder — read names only' }));

    // Says the text changed and that nothing was recorded…
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/consent text changed .* Nothing was recorded/i)
    );
    // …shows the CURRENT words…
    await waitFor(() => expect(screen.getByText(NEW_DISCLOSURE_TEXT)).toBeInTheDocument());
    expect(api.order.filter((o) => o === 'GET disclosure')).toHaveLength(2);
    // …and granted exactly once (the refused attempt), started nothing.
    expect(api.order.filter((o) => o === 'POST consents')).toHaveLength(1);
    expect(api.order).not.toContain('POST map');
  });

  it('active-consent fast path: skips the grant and goes straight to the start', async () => {
    const api = installApi({
      consents: res(200, {
        connectionId: 'conn-1',
        events: [],
        active: [{ consentId: 'c-9', scope: 'map_metadata', grantedAt: '2026-08-19T10:00:00Z' }],
      }),
      mapStart: [res(202, { status: 'mapping', connectionId: 'conn-1', workflowId: 'wf-1' })],
    });
    const user = userEvent.setup();
    renderMap();

    // The page says the record already stands (and why another map won't ask).
    await waitFor(() => expect(screen.getByText(/already on record/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Map this folder — read names only' }));

    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());
    expect(api.order).not.toContain('POST consents');
    expect(api.order.filter((o) => o === 'POST map')).toHaveLength(1);
  });

  it('on 503 from the start: retry re-POSTs the start ONLY — one grant, then the start retried', async () => {
    const api = installApi({
      grant: [res(201, { consentId: 'c-1', disclosureSha256: DISCLOSURE_SHA })],
      mapStart: [
        res(503, { error: 'Unable to start map workflow — durable start failed' }),
        res(202, { status: 'mapping', connectionId: 'conn-1', workflowId: 'wf-2' }),
      ],
    });
    const user = userEvent.setup();
    renderMap();

    await waitFor(() => expect(screen.getByText(/It will not open any file\./)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Map this folder — read names only' }));

    // The failure names what stands (the consent) and what failed (the start).
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/consent is on record/i));
    await user.click(screen.getByRole('button', { name: 'Start the map again' }));

    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());
    expect(api.order.filter((o) => o === 'POST consents')).toHaveLength(1);
    expect(api.order.filter((o) => o === 'POST map')).toHaveLength(2);
  });

  it('renders honest copy when an administrator has mapping switched off', async () => {
    const api = installApi({
      grant: [res(403, { error: 'mapping_disabled_for_tenant' })],
    });
    const user = userEvent.setup();
    renderMap();

    await waitFor(() => expect(screen.getByText(/It will not open any file\./)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Map this folder — read names only' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/administrator has mapping switched off/i)
    );
    expect(api.order).not.toContain('POST map');
  });
});

describe('DriveMap — stage resolution from an existing run', () => {
  it('a running map lands on the mapping stage, not consent', async () => {
    installApi({
      runResolution: res(200, {
        runId: 'r-1',
        status: 'mapping',
        progress: { itemsSeen: 1200, foldersWalked: 88 },
      }),
    });
    renderMap();

    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());
    expect(screen.getByText(/1,200 items listed · 88 folders walked/)).toBeInTheDocument();
    expect(screen.queryByText('Read the names, not the files.')).not.toBeInTheDocument();
  });

  it('a terminal run lands on the landing stage', async () => {
    installApi({
      runResolution: res(200, {
        runId: 'r-1',
        status: 'complete',
        progress: { itemsSeen: 15657, foldersWalked: 7469 },
      }),
    });
    renderMap();

    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
    expect(screen.getByText(/15,657 items listed across 7,469 folders/)).toBeInTheDocument();
  });

  it('refused_no_consent renders its own explanation, INCLUDING mid-run partial progress', async () => {
    installApi({
      runResolution: res(200, {
        runId: 'r-1',
        status: 'refused_no_consent',
        progress: { itemsSeen: 4200, foldersWalked: 310 },
      }),
    });
    renderMap();

    await waitFor(() => expect(screen.getByText('The map stopped: consent was revoked.')).toBeInTheDocument());
    expect(screen.getByText(/stopped where it stood/)).toBeInTheDocument();
    // The partial record is stated, not hidden: revocation mid-run left a
    // real, truthful trace and the screen says exactly how much.
    expect(screen.getByText(/4,200 items across 310 folders/)).toBeInTheDocument();
    expect(screen.queryByText('Read the names, not the files.')).not.toBeInTheDocument();
  });

  it('unsupported_provider renders its own explanation', async () => {
    installApi({
      runResolution: res(200, { runId: 'r-1', status: 'unsupported_provider' }),
    });
    renderMap();

    await waitFor(() => expect(screen.getByText('This drive cannot be mapped yet.')).toBeInTheDocument());
    expect(screen.getByText(/Nothing was read\./)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 34-S09 — the reasoning stream. The narration IS the product: these tests
// hold the reader to exactly-once in-order delivery, reading-pace buffering,
// a cap that states itself, a reduced-motion path with no theatre, honest
// terminal routing, and a polling fallback that says so out loud.
// ---------------------------------------------------------------------------

const MAPPING_RUN = res(200, { runId: 'r-1', status: 'mapping' });

const nl = (text: string, atMs: number, kind = 'sum', tier = 'none') => ({ kind, tier, text, atMs });

describe('DriveMap — the reasoning stream (34-S09)', () => {
  it('parses frames in order, reveals each line exactly once, and ignores heartbeats', async () => {
    const s1 = sseScript();
    installApi({ runResolution: MAPPING_RUN, streams: [s1] });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    s1.comment();
    s1.frame({ type: 'narration', line: nl('first: 15,657 items under /Documents', 1) });
    s1.comment();
    // One frame split across two transport chunks — the reader buffers
    // bytes and splits on '\n\n', it does not assume chunk == frame.
    s1.raw('data: {"type":"narration","line":{"kind":"chk","tier":"none",');
    s1.raw('"text":"second: totals reconcile","atMs":2}}\n\n');
    s1.frame({ type: 'narration', line: nl('third: corrected the ranking', 3, 'fix') });

    await waitFor(() => expect(screen.getByText('third: corrected the ranking')).toBeInTheDocument());
    expect(screen.getAllByText('first: 15,657 items under /Documents')).toHaveLength(1);
    expect(screen.getAllByText('second: totals reconcile')).toHaveLength(1);

    // In order, on screen — not just present.
    const bodyText = document.body.textContent ?? '';
    expect(bodyText.indexOf('first:')).toBeLessThan(bodyText.indexOf('second:'));
    expect(bodyText.indexOf('second:')).toBeLessThan(bodyText.indexOf('third:'));

    // The four-kind vocabulary: glyphs carry accessible names (arithmetic
    // distinguishable from inference by ear as well as at a glance), and
    // every tier-'none' line wears the translated 'no model' chip.
    expect(screen.getAllByRole('img', { name: 'arithmetic' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'check' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'correction' })).toHaveLength(1);
    expect(screen.getAllByText('no model')).toHaveLength(3);
  });

  it('an ask line renders the blue glyph and its tier alias verbatim on the chip', async () => {
    const s1 = sseScript();
    installApi({ runResolution: MAPPING_RUN, streams: [s1] });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    // 34-S09e is not shipped, but the contract already carries tier — the
    // branch is built now so 'ask' lines light up without a UI change.
    s1.frame({ type: 'narration', line: nl('naming the twelve clusters', 1, 'ask', 'fast') });

    await waitFor(() => expect(screen.getByText('naming the twelve clusters')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: 'model asked' })).toBeInTheDocument();
    expect(screen.getByText('fast')).toBeInTheDocument();
    expect(screen.queryByText('no model')).not.toBeInTheDocument();
  });

  it('a reconnect does not duplicate narration: the re-sent prefix is deduped by index', async () => {
    const s1 = sseScript();
    const s2 = sseScript();
    const api = installApi({ runResolution: MAPPING_RUN, streams: [s1, s2] });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    s1.frame({ type: 'narration', line: nl('alpha', 1) });
    s1.frame({ type: 'narration', line: nl('beta', 2) });
    await waitFor(() => expect(screen.getByText('beta')).toBeInTheDocument());
    s1.close(); // transport drop, no terminal frame — reconnect once

    await waitFor(() => expect(api.order.filter((o) => o === 'GET stream')).toHaveLength(2));
    // A fresh server connection replays the run doc's narration from index
    // 0 (the server keeps no per-client cursor), then says something new.
    s2.frame({ type: 'narration', line: nl('alpha', 1) });
    s2.frame({ type: 'narration', line: nl('beta', 2) });
    s2.frame({ type: 'narration', line: nl('gamma', 3, 'chk') });

    await waitFor(() => expect(screen.getByText('gamma')).toBeInTheDocument());
    expect(screen.getAllByText('alpha')).toHaveLength(1);
    expect(screen.getAllByText('beta')).toHaveLength(1);
    // One drop is a reconnect, not a fallback — the polling notice must NOT show.
    expect(screen.queryByText(/checks progress every few seconds/)).not.toBeInTheDocument();
  });

  it('buffers when the server outruns the reader: reveals at reading pace, not arrival pace', async () => {
    MAP_STREAM_TUNING.revealMs = 250;
    const s1 = sseScript();
    installApi({ runResolution: MAPPING_RUN, streams: [s1] });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    for (let n = 1; n <= 5; n++) s1.frame({ type: 'narration', line: nl(`burst line ${n}`, n) });

    // The first line lands almost immediately…
    await waitFor(() => expect(screen.getByText('burst line 1')).toBeInTheDocument());
    // …while the last is still buffered, because reveals pace at revealMs.
    expect(screen.queryByText('burst line 5')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('burst line 5')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('caps the visible stream at 40 lines and STATES the cap instead of rolling off silently', async () => {
    const s1 = sseScript();
    installApi({ runResolution: MAPPING_RUN, streams: [s1] });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    for (let n = 1; n <= 45; n++) {
      s1.frame({ type: 'narration', line: nl(`cap line ${String(n).padStart(2, '0')}`, n) });
    }

    await waitFor(() => expect(screen.getByText('cap line 45')).toBeInTheDocument());
    expect(screen.getByText(/Showing the last 40 of 45 lines/)).toBeInTheDocument();
    // Oldest five rolled off; the 6th is the oldest still visible.
    expect(screen.queryByText('cap line 01')).not.toBeInTheDocument();
    expect(screen.queryByText('cap line 05')).not.toBeInTheDocument();
    expect(screen.getByText('cap line 06')).toBeInTheDocument();
  });

  it('prefers-reduced-motion renders the whole transcript instantly — the pacing is theatre, not information', async () => {
    // Pacing this slow would time the test out if it were honoured.
    MAP_STREAM_TUNING.revealMs = 100000;
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const s1 = sseScript();
      installApi({ runResolution: MAPPING_RUN, streams: [s1] });
      renderMap();
      await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

      for (let n = 1; n <= 5; n++) s1.frame({ type: 'narration', line: nl(`instant line ${n}`, n) });
      await waitFor(() => expect(screen.getByText('instant line 5')).toBeInTheDocument());
      for (let n = 1; n <= 5; n++) expect(screen.getByText(`instant line ${n}`)).toBeInTheDocument();

      // And the terminal advances immediately — no hold, no theatre.
      s1.frame({ type: 'complete', status: 'complete', runId: 'r-1', progress: { itemsSeen: 5, foldersWalked: 1 } });
      await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
    } finally {
      window.matchMedia = original;
    }
  });

  it("the terminal 'complete' frame advances to the landing stage once the reveal has drained", async () => {
    const s1 = sseScript();
    installApi({ runResolution: MAPPING_RUN, streams: [s1] });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    s1.frame({ type: 'narration', line: nl('the last narration line', 1) });
    s1.frame({
      type: 'complete',
      status: 'complete',
      runId: 'r-1',
      progress: { itemsSeen: 15657, foldersWalked: 7469 },
    });

    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
    expect(screen.getByText(/15,657 items listed across 7,469 folders/)).toBeInTheDocument();
    expect(screen.queryByText('The map is running.')).not.toBeInTheDocument();
  });

  it("a mid-run 'refused_no_consent' terminal routes to the refusal stage with its partial progress", async () => {
    const s1 = sseScript();
    installApi({ runResolution: MAPPING_RUN, streams: [s1] });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    s1.frame({
      type: 'complete',
      status: 'refused_no_consent',
      runId: 'r-1',
      progress: { itemsSeen: 4200, foldersWalked: 310 },
    });

    await waitFor(() => expect(screen.getByText('The map stopped: consent was revoked.')).toBeInTheDocument());
    expect(screen.getByText(/4,200 items across 310 folders/)).toBeInTheDocument();
  });

  it("a terminal 'failed' renders honest failure copy IN PLACE with the narration retained as evidence", async () => {
    const s1 = sseScript();
    installApi({ runResolution: MAPPING_RUN, streams: [s1] });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    s1.frame({ type: 'narration', line: nl('walked 300 folders', 1) });
    s1.frame({ type: 'narration', line: nl('then the provider hung up', 2, 'fix') });
    s1.frame({ type: 'complete', status: 'failed', runId: 'r-1' });

    await waitFor(() => expect(screen.getByText('The map failed.')).toBeInTheDocument());
    // The transcript stays — it is the record of how far it got — and the
    // page does NOT swap to the landing placeholder.
    expect(screen.getByText('walked 300 folders')).toBeInTheDocument();
    expect(screen.getByText('then the provider hung up')).toBeInTheDocument();
    expect(screen.getByText(/record of how far it got/)).toBeInTheDocument();
    expect(screen.queryByText('The map is running.')).not.toBeInTheDocument();
  });

  it('Replay re-runs the reveal from retained lines client-side — zero refetches', async () => {
    const s1 = sseScript();
    const api = installApi({ runResolution: MAPPING_RUN, streams: [s1] });
    const user = userEvent.setup();
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is running.')).toBeInTheDocument());

    s1.frame({ type: 'narration', line: nl('replayable line', 1) });
    await waitFor(() => expect(screen.getByText('replayable line')).toBeInTheDocument());
    const fetchesBefore = api.order.length;

    await user.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(screen.getByText('replayable line')).toBeInTheDocument());
    expect(screen.getAllByText('replayable line')).toHaveLength(1);
    expect(api.order.length).toBe(fetchesBefore);
  });

  it('after two stream failures it falls back to polling GET /:id/map and SAYS so, without duplicating lines', async () => {
    const api = installApi({
      runResolution: res(200, {
        runId: 'r-1',
        status: 'mapping',
        progress: { itemsSeen: 900, foldersWalked: 40, currentPath: '/Docs/Archive' },
        narration: [nl('polled line one', 1), nl('polled line two', 2, 'chk')],
      }),
      streams: ['reject', 'reject'],
    });
    renderMap();

    // The fallback states itself — never silent.
    await waitFor(() => expect(screen.getByText(/checks progress every few seconds/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('polled line two')).toBeInTheDocument());

    // Let several poll ticks land against the same doc; index-dedupe keeps
    // each line single.
    await waitFor(() => expect(api.order.filter((o) => o === 'GET map').length).toBeGreaterThan(3));
    expect(screen.getAllByText('polled line one')).toHaveLength(1);
    expect(screen.getAllByText('polled line two')).toHaveLength(1);

    // Progress renders from the polled doc, currentPath included.
    expect(screen.getByText(/reading names in \/Docs\/Archive/)).toBeInTheDocument();
    expect(api.order.filter((o) => o === 'GET stream')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 34-S10d / 34-S10e — the map landing. Every number is arithmetic off the
// run doc, so the tests hold the arithmetic itself; the morph only plays
// when divergence is the message; sub-pixel segments may not lie by
// geometry; every absence state and every truncation flag is TEXT, asserted
// as text — never colour.
// ---------------------------------------------------------------------------

/**
 * The rich fixture — proportions modelled on the drive the design spec was
 * written against (the numbers reconcile internally, which is the property
 * the assertions lean on):
 *   totalFiles 8,190 · totalBytes 6,008,813,031
 *   knowledge (prose+source) = 6,548 files (80.0%) / 526,500,107 B (8.8%)
 *   divergence: unclassified 59.99 bytes-pct vs 8.75 files-pct ≈ 51 points
 *   `container` is the sub-pixel sliver: 26 KB ≈ 0.0028 px on a 640 px bar.
 */
const RICH_PER_CLASS = {
  human_prose: { files: 1978, bytes: 163_890_055 },
  human_source: { files: 4570, bytes: 362_610_052 },
  machine_generated: { files: 520, bytes: 217_956_707 },
  media: { files: 403, bytes: 1_659_827_490 },
  unclassified: { files: 717, bytes: 3_604_502_727 },
  container: { files: 2, bytes: 26_000 },
};

const RICH_DOC = {
  runId: 'r-1',
  status: 'complete',
  provider: 'onedrive',
  progress: { itemsSeen: 15657, foldersWalked: 7469, foldersPruned: 12 },
  aggregates: { perClass: RICH_PER_CLASS, folders: 7469, emptyFolders: 5375, maxDepth: 9 },
  topFolders: [
    { name: 'code', files: 5000, folders: 3000, bytes: 5_011_280_000, perClass: {} },
    { name: 'Documents', files: 1500, folders: 800, bytes: 500_000_000, perClass: {} },
  ],
  pruneManifest: [
    { path: '/code/node_modules', rule: 'prune_self:node_modules', size: 9_000_000_000 },
    { path: '/old/.git', rule: 'prune_self:.git', size: 1_070_000_000 },
  ],
  reconciliation: { enumeratedFileBytes: 6_008_813_031, prunedFolderBytes: 10_070_000_000 },
};

/** Low divergence, nothing above any finding floor: files and bytes tell
 * the same story, no dominant folder, few empties, little pruned. */
const UNREMARKABLE_DOC = {
  runId: 'r-2',
  status: 'complete',
  progress: { itemsSeen: 1100, foldersWalked: 100, foldersPruned: 1 },
  aggregates: {
    perClass: {
      human_prose: { files: 500, bytes: 5_000_000 },
      machine_generated: { files: 480, bytes: 4_800_000 },
    },
    folders: 100,
    emptyFolders: 10,
    maxDepth: 4,
  },
  topFolders: [{ name: 'stuff', files: 900, folders: 90, bytes: 3_000_000, perClass: {} }],
  pruneManifest: [{ path: '/stuff/.cache', rule: 'prune_self:.cache', size: 1_000_000 }],
  reconciliation: { enumeratedFileBytes: 9_800_000, prunedFolderBytes: 1_000_000 },
};

function renderLanded(run: unknown, extra?: { onRemap?: () => void }) {
  return render(
    <ShelfmarkProvider config={harnessConfig}>
      <MapLandedStage connectionId="conn-1" run={run as any} onRemap={extra?.onRemap} />
    </ShelfmarkProvider>
  );
}

async function withReducedMotion(fn: () => Promise<void>): Promise<void> {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  try {
    await fn(); // the stub must outlive the awaited renders, not just the call
  } finally {
    window.matchMedia = original;
  }
}

function barSegments(encoding: 'bytes' | 'files' = 'bytes'): Element[] {
  const label =
    encoding === 'bytes'
      ? 'Class composition of the mapped folder, by bytes'
      : 'Class composition of the mapped folder, by file count';
  return Array.from(screen.getByRole('img', { name: label }).children);
}

describe('MapLandedStage — the inversion (34-S10d)', () => {
  it('inversion math from the fixture: percentages sum to 100 under both encodings, and the headline numbers are the knowledge shares', () => {
    const inv = computeInversion(RICH_DOC as any)!;
    expect(inv).not.toBeNull();

    const filesSum = inv.classes.reduce((s, c) => s + c.filesPct, 0);
    const bytesSum = inv.classes.reduce((s, c) => s + c.bytesPct, 0);
    expect(filesSum).toBeCloseTo(100, 6);
    expect(bytesSum).toBeCloseTo(100, 6);

    expect(inv.totalFiles).toBe(8190);
    expect(inv.totalBytes).toBe(6_008_813_031);
    expect(inv.knowledgeFilesPct).toBeCloseTo(((1978 + 4570) / 8190) * 100, 6);
    expect(inv.knowledgeBytesPct).toBeCloseTo(((163_890_055 + 362_610_052) / 6_008_813_031) * 100, 6);

    // Divergence is the max per-class gap between the two encodings —
    // recomputed here from the raw fixture, not trusted from the code.
    const expected = Math.max(
      ...Object.values(RICH_PER_CLASS).map((c) => Math.abs((c.bytes / 6_008_813_031) * 100 - (c.files / 8190) * 100))
    );
    expect(inv.divergencePoints).toBeCloseTo(expected, 6);
    expect(inv.divergencePoints).toBeGreaterThan(20);
  });

  it('renders the headline and the three ranked arithmetic cards, none of which can be wrong', async () => {
    installApi({ runResolution: res(200, RICH_DOC) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    // The headline: two divisions off aggregates.
    expect(screen.getByText(/is 80\.0% of your files and 8\.8% of your bytes/)).toBeInTheDocument();

    // The ranked pool: dominant folder (83.4) > empty folders (72.0) >
    // pruned share (62.6) — the inversion candidate (~51 points) is real
    // but outranked, so exactly these three cards render.
    expect(screen.getByText('One folder dominates')).toBeInTheDocument();
    expect(screen.getByText(/code holds 83\.4% of every byte/)).toBeInTheDocument();
    expect(screen.getByText('Empty folders')).toBeInTheDocument();
    expect(screen.getByText(/5,375 of 7,469 folders — 72\.0% — hold nothing/)).toBeInTheDocument();
    expect(screen.getByText('Skipped on purpose')).toBeInTheDocument();
    expect(screen.getByText(/10\.1 GB — 62\.6% of everything under this root/)).toBeInTheDocument();
    expect(screen.queryByText('The inversion')).not.toBeInTheDocument();
    expect(screen.queryByText('An unremarkable drive.')).not.toBeInTheDocument();
  });

  it('the toggle switches encodings: title, axis and pressed state follow', async () => {
    installApi({ runResolution: res(200, RICH_DOC) });
    const user = userEvent.setup();
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    expect(screen.getByText('By bytes — what storage bills you for')).toBeInTheDocument();
    expect(screen.getByText('6,008,813,031 bytes in files')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByText('By file count — what a person calls “my files”')).toBeInTheDocument();
    expect(screen.getByText('8,190 files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Size' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the morph plays when divergence is the message: proportional segments carry the transition class', async () => {
    installApi({ runResolution: res(200, RICH_DOC) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    const proportional = barSegments().filter((s) => s.getAttribute('data-not-to-scale') !== 'true');
    expect(proportional.length).toBeGreaterThan(0);
    for (const seg of proportional) expect(seg.className).toContain('map-morph');
  });

  it('the morph is SUPPRESSED when divergence is under ~20 points — an animation whose meaning is divergence must not play when there is none', async () => {
    installApi({ runResolution: res(200, UNREMARKABLE_DOC) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    for (const seg of barSegments()) expect(seg.className).not.toContain('map-morph');
  });

  it('the morph is SUPPRESSED under prefers-reduced-motion even at high divergence', async () => {
    await withReducedMotion(async () => {
      installApi({ runResolution: res(200, RICH_DOC) });
      renderMap();
      await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
      for (const seg of barSegments()) expect(seg.className).not.toContain('map-morph');
    });
  });

  it('sub-pixel rule: a sliver gets a floored width, a hatch, "not to scale", and is excluded from proportional hit-testing', async () => {
    installApi({ runResolution: res(200, RICH_DOC) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    const segments = barSegments();
    const floored = segments.filter((s) => s.getAttribute('data-not-to-scale') === 'true');
    expect(floored).toHaveLength(1); // the 26 KB `container` sliver
    const sliver = floored[0] as HTMLElement;
    expect(sliver.style.width).toBe('6px'); // floored, not proportional
    expect(sliver.className).toContain('map-hatch');
    // Excluded from proportional hit-testing: no pointer events, no title —
    // its geometry is a lie of necessity, so it may not answer for itself.
    expect(sliver.className).toContain('pointer-events-none');
    expect(sliver.getAttribute('title')).toBeNull();

    // A proportional segment DOES carry its data at its geometry.
    const proportional = segments.find((s) => s.getAttribute('data-not-to-scale') !== 'true')!;
    expect(proportional.getAttribute('title')).toMatch(/files/);

    // The state is stated in text, twice: the legend marker and the caption.
    expect(screen.getByText('not to scale')).toBeInTheDocument();
    expect(screen.getByText(/Hatched slivers are drawn at a minimum width/)).toBeInTheDocument();
    // And the sliver's counts live in its legend row — colour is never alone.
    expect(screen.getByText('Containers')).toBeInTheDocument();
  });
});

describe('MapLandedStage — absence states and reconciliation (34-S10d)', () => {
  it('every absence state renders as text with its count — and `not reached` stays dormant without a drive-reported total', async () => {
    installApi({ runResolution: res(200, RICH_DOC) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    expect(screen.getByText('What was measured, and what was not')).toBeInTheDocument();
    expect(screen.getByText('measured')).toBeInTheDocument();
    expect(screen.getByText('8,190 files · 6.0 GB')).toBeInTheDocument();
    expect(screen.getByText('pruned')).toBeInTheDocument();
    expect(screen.getByText('10.1 GB across 12 subtrees')).toBeInTheDocument();
    expect(screen.getByText('opaque')).toBeInTheDocument();
    expect(screen.getByText('0 files')).toBeInTheDocument(); // we looked; no archives — stated, not hidden
    expect(screen.getByText('unclassified')).toBeInTheDocument();
    expect(screen.getByText('717 files')).toBeInTheDocument();
    expect(screen.getByText('empty')).toBeInTheDocument();
    // Empty folders are UNDRAWABLE at any honest width — the legend states
    // the number instead of faking a segment.
    expect(screen.getByText('5,375 folders')).toBeInTheDocument();
    expect(screen.getByText(/no honest width exists for them/)).toBeInTheDocument();

    // The doc carries no drive-reported total today, so `not reached`
    // cannot be computed and must NOT render (a gap needs two figures).
    expect(screen.queryByText('not reached')).not.toBeInTheDocument();
  });

  it('the dormant `not reached` branch wakes when the doc carries driveReportedBytes, and the strip normalises to the drive figure', async () => {
    const doc = {
      ...RICH_DOC,
      reconciliation: { ...RICH_DOC.reconciliation, driveReportedBytes: 17_240_000_000 },
    };
    installApi({ runResolution: res(200, doc) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    // 17.24 GB reported − 16.08 GB accounted = 1.16 GB not reached.
    expect(screen.getByText('not reached')).toBeInTheDocument();
    expect(screen.getByText('1.2 GB')).toBeInTheDocument();
    expect(
      screen.getByText('Your drive reports 17.2 GB. 16.1 GB is accounted for above; the remaining 1.2 GB was not reached.')
    ).toBeInTheDocument();
  });

  it('the reconciliation strip SHOWS the arithmetic, and it equals the doc', async () => {
    installApi({ runResolution: res(200, RICH_DOC) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    // 6,008,813,031 + 10,070,000,000 = 16,078,813,031 → the displayed sum.
    expect(screen.getByText('6.0 GB in files + 10.1 GB pruned = 16.1 GB accounted for.')).toBeInTheDocument();
  });

  it('the prune report itemises each subtree with the rule that fired, and the top-folder rollup renders', async () => {
    installApi({ runResolution: res(200, RICH_DOC) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    expect(screen.getByText('2 pruned subtrees · 10.1 GB left unwalked')).toBeInTheDocument();
    expect(screen.getByText('/code/node_modules')).toBeInTheDocument();
    expect(screen.getByText('prune_self:node_modules')).toBeInTheDocument();
    expect(screen.getByText('/old/.git')).toBeInTheDocument();
    expect(screen.getByText('prune_self:.git')).toBeInTheDocument();

    expect(screen.getByText('Top-level folders')).toBeInTheDocument();
    expect(screen.getByText('code')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
  });

  it('a long manifest renders through the virtualizer, with its count still stated', async () => {
    const doc = {
      ...RICH_DOC,
      pruneManifest: Array.from({ length: 50 }, (_, i) => ({
        path: `/big/cache-${i}`,
        rule: 'prune_self:cache',
        size: 1_000_000,
      })),
    };
    installApi({ runResolution: res(200, doc) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    // jsdom cannot measure the scroll viewport (the virtualized-list
    // precedent), so the assertion is the virtualized container plus the
    // stated count — not the itemized rows.
    expect(screen.getByTestId('prune-virtual')).toBeInTheDocument();
    expect(screen.getByText('50 pruned subtrees · 10.1 GB left unwalked')).toBeInTheDocument();
  });

  it('every truncation flag renders as its own stated row — a bounded list that does not say so is a silent cap', async () => {
    const doc = {
      ...RICH_DOC,
      rollupTruncated: true,
      topFoldersOmitted: 4,
      pruneManifestTruncated: true,
      pruneManifestOmitted: 12,
      narrationDropped: 7,
    };
    installApi({ runResolution: res(200, doc) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    expect(screen.getByText(/Only the largest 2 folders are itemised here — 4 more are counted/)).toBeInTheDocument();
    expect(screen.getByText(/This list is itself truncated: 12 more pruned subtrees/)).toBeInTheDocument();
    expect(screen.getByText(/7 narration lines were dropped from the stored record/)).toBeInTheDocument();
  });

  it('elision flags on an arriving doc trigger a fetch of the full record', async () => {
    const { pruneManifest, topFolders, ...rest } = RICH_DOC;
    void pruneManifest;
    void topFolders;
    const elidedRun = { ...rest, pruneManifestElided: true, topFoldersElided: true };
    const api = installApi({ runResolution: res(200, RICH_DOC) });
    renderLanded(elidedRun);

    // The full doc replaces the elided frame: real lists, no elision rows.
    await waitFor(() => expect(screen.getByText('/code/node_modules')).toBeInTheDocument());
    expect(screen.getByText('code')).toBeInTheDocument();
    expect(api.order).toContain('GET map');
    expect(screen.queryByText(/full record could not be fetched/)).not.toBeInTheDocument();
  });

  it('when the full record cannot be fetched, the elision renders as a stated row — never hidden', async () => {
    const { pruneManifest, topFolders, ...rest } = RICH_DOC;
    void pruneManifest;
    void topFolders;
    const elidedRun = { ...rest, pruneManifestElided: true, topFoldersElided: true };
    installApi({ runResolution: res(500, { error: 'boom' }) });
    renderLanded(elidedRun);

    // One stated row per elided section (top folders + prune report).
    await waitFor(() => expect(screen.getAllByText(/full record could not be fetched/)).toHaveLength(2));
    expect(screen.queryByText('/code/node_modules')).not.toBeInTheDocument();
  });
});

describe('MapLandedStage — the unremarkable drive and the honest edges (34-S10e)', () => {
  it('when no finding clears its floor, the NAMED unremarkable state renders instead of manufactured cards', async () => {
    installApi({ runResolution: res(200, UNREMARKABLE_DOC) });
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());

    expect(screen.getByText('An unremarkable drive.')).toBeInTheDocument();
    expect(screen.getByText(/That is not a failure/)).toBeInTheDocument();
    expect(screen.queryByText('One folder dominates')).not.toBeInTheDocument();
    expect(screen.queryByText('Empty folders')).not.toBeInTheDocument();
    expect(screen.queryByText('Skipped on purpose')).not.toBeInTheDocument();
    expect(screen.queryByText('The inversion')).not.toBeInTheDocument();
    // The accounting still renders — reassurance does not depend on wow.
    expect(screen.getByText('9.8 MB in files + 1.0 MB pruned = 10.8 MB accounted for.')).toBeInTheDocument();
  });

  it('a refusal-status doc renders the refusal explanation, not a dashboard of zeroes', () => {
    installApi({});
    renderLanded({
      status: 'refused_no_consent',
      provider: 'onedrive',
      progress: { itemsSeen: 4200, foldersWalked: 310 },
      narration: [nl('walked a while', 1)],
    });

    expect(screen.getByText('The map stopped: consent was revoked.')).toBeInTheDocument();
    expect(screen.getByText(/4,200 items across 310 folders/)).toBeInTheDocument();
    expect(screen.queryByText('The map is complete.')).not.toBeInTheDocument();
    expect(screen.queryByText('The accounting')).not.toBeInTheDocument();
    expect(screen.queryByText(/of your files and/)).not.toBeInTheDocument();
  });

  it('a failed doc reached by refresh renders the transcript as evidence, with partial progress and the drop count', async () => {
    installApi({
      runResolution: res(200, {
        runId: 'r-9',
        status: 'failed',
        progress: { itemsSeen: 300, foldersWalked: 40 },
        narration: [nl('walked 40 folders', 1), nl('then the provider hung up', 2, 'fix')],
        narrationDropped: 3,
      }),
    });
    renderMap();

    await waitFor(() => expect(screen.getByText('The map failed.')).toBeInTheDocument());
    expect(screen.getByText('The narration, as it ran')).toBeInTheDocument();
    expect(screen.getByText('walked 40 folders')).toBeInTheDocument();
    expect(screen.getByText('then the provider hung up')).toBeInTheDocument();
    expect(screen.getByText(/record of how far it got/)).toBeInTheDocument();
    expect(screen.getByText(/Before failing it had listed 300 items across 40 folders/)).toBeInTheDocument();
    expect(screen.getByText(/3 narration lines were dropped/)).toBeInTheDocument();
    // The failure page is the evidence page, not the inversion page.
    expect(screen.queryByText(/of your files and/)).not.toBeInTheDocument();
  });

  it('the exit is the entry to step 11: inside the page it advances to the ledger; standalone it still has a real destination', async () => {
    // Rendered standalone (no onReview), the CTA keeps the link it carried
    // before step 11 existed — a real destination, never a dead button.
    installApi({});
    renderLanded(RICH_DOC);
    expect(screen.getByRole('link', { name: 'Review what to ingest' })).toHaveAttribute('href', '/connectors');
    expect(screen.getByText(/Choosing what to read is the next step/)).toBeInTheDocument();
    cleanup();

    // Inside the page it is the entry point into Decide (34-S11c).
    installApi({ runResolution: res(200, RICH_DOC), suggestions: [res(200, suggestionsBody())] });
    const user = userEvent.setup();
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Review what to ingest' }));
    await waitFor(() => expect(screen.getByText('What we suggest reading')).toBeInTheDocument());
  });
});

// ===========================================================================
// 34-S11c / 34-S12a / 34-S12b / 34-S13a/b — Decide.
//
// The fixtures are HAND-AUTHORED AND SELF-CONSISTENT: the funnel table, the
// candidate/default totals, the eight ledger rows and the cost block all
// describe the SAME eight files, so every assertion below can be reconciled
// by hand against the numbers in this one place rather than against the code
// that renders them.
//
//   /Docs/notes.txt              selected                     8,000 B  text
//   /Docs/plan.md                selected                    40,000 B  text
//   /Docs/report.pdf             selected                 2,000,000 B  binary
//   /Archive/logs.txt            − machine_output_in_prose  500,000 B
//   /Books/standard.pdf          − third_party_publication 14,700,000 B
//   /Receipts/dinner.pdf         − receipt_shape             25,000 B
//   /Copies/dinner.pdf           − propagated_from:receipt_shape 25,000 B
//   /Media/clip.mov              not_candidate:media    100,000,000 B
//
//   candidates      = 7 files / 17,298,000 B   (the media file is not one)
//   subtractions    = 4 files / 15,250,000 B
//   default         = 3 files /  2,048,000 B   = 8,000 + 40,000 + 2,000,000
//   cost: text 48,000 B ÷ 4 = 12,000 tokens both ends;
//         binary 2,000,000 B ÷ 50 = 40,000 low, ÷ 4 = 500,000 high
//         → 52,000–512,000 tokens, binary share 2,000,000 / 2,048,000
// ===========================================================================
const LEDGER_ROWS = [
  { itemId: 'i1', path: '/Docs/notes.txt', name: 'notes.txt', size: 8_000, modified: '', verdict: 'selected' },
  { itemId: 'i2', path: '/Docs/plan.md', name: 'plan.md', size: 40_000, modified: '', verdict: 'selected' },
  {
    itemId: 'i3',
    path: '/Docs/report.pdf',
    name: 'report.pdf',
    size: 2_000_000,
    modified: '',
    verdict: 'selected',
    reportedShapes: ['tax_shape'],
  },
  {
    itemId: 'i4',
    path: '/Archive/logs.txt',
    name: 'logs.txt',
    size: 500_000,
    modified: '',
    verdict: 'subtracted:machine_output_in_prose',
    subtractedBy: 'machine_output_in_prose',
  },
  {
    itemId: 'i5',
    path: '/Books/standard.pdf',
    name: 'standard.pdf',
    size: 14_700_000,
    modified: '',
    verdict: 'subtracted:third_party_publication',
    subtractedBy: 'third_party_publication',
  },
  {
    itemId: 'i6',
    path: '/Receipts/dinner.pdf',
    name: 'dinner.pdf',
    size: 25_000,
    modified: '',
    verdict: 'subtracted:receipt_shape',
    subtractedBy: 'receipt_shape',
  },
  {
    itemId: 'i7',
    path: '/Copies/dinner.pdf',
    name: 'dinner.pdf',
    size: 25_000,
    modified: '',
    verdict: 'subtracted:propagated_from:receipt_shape',
    subtractedBy: 'receipt_shape',
  },
  {
    itemId: 'i8',
    path: '/Media/clip.mov',
    name: 'clip.mov',
    size: 100_000_000,
    modified: '',
    verdict: 'not_candidate:media',
  },
];

/** The funnel table in the policy's own precedence order, zero rows
 *  INCLUDED — a rule that only appears when it fires cannot be audited. */
const FUNNEL_TABLE = [
  { rule: 'archived_dump_copy', files: 0, bytes: 0 },
  { rule: 'stub_under_200b', files: 0, bytes: 0 },
  { rule: 'receipt_shape', files: 1, bytes: 25_000 },
  { rule: 'machine_output_in_prose', files: 1, bytes: 500_000 },
  { rule: 'third_party_publication', files: 1, bytes: 14_700_000 },
  { rule: 'propagation', files: 1, bytes: 25_000 },
  { rule: 'duplicate_fingerprint', files: 0, bytes: 0 },
];

const COST_ESTIMATE = {
  textShareBytes: 48_000,
  binaryShareBytes: 2_000_000,
  binaryShareOfSelection: 2_000_000 / 2_048_000,
  tokenLow: 52_000,
  tokenHigh: 512_000,
  method: 'text-like bytes (.md/.txt/.csv) ÷ 4 per token on both ends; binary/other bytes ÷ 50 (low) to ÷ 4 (high)',
};

function suggestionsBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 'tenant-a',
    runId: 'drive-map-conn-1',
    connectionId: 'conn-1',
    funnelPolicyVersion: '1.0.0-rc1',
    funnelPolicySha256: '8f41d4d1d4418ce938eb476070a9288f246738eb091898be34e2fcb869ef48be',
    classifierVersion: '1.0.0-rc2',
    classifierSha256: 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66',
    candidates: { files: 7, bytes: 17_298_000 },
    funnelTable: FUNNEL_TABLE,
    defaultSelection: { files: 3, bytes: 2_048_000 },
    sensitiveReport: {
      bank_statement_shape: { candidates: 0, defaultSelection: 0 },
      credential_shape: { candidates: 2, defaultSelection: 1 },
      tax_shape: { candidates: 1, defaultSelection: 1 },
    },
    ranking: { ranked: false, reason: 'no portable ordering spec published for the funnel port' },
    rows: LEDGER_ROWS,
    rowsTotal: LEDGER_ROWS.length,
    rowsPageCap: 2_000,
    nextCursor: null,
    rowsTruncated: false,
    rowsOmitted: 0,
    rowCap: 20_000,
    costEstimate: COST_ESTIMATE,
    writtenAt: '2026-08-20T10:00:00.000Z',
    ...over,
  };
}

/** Land on the ledger the way a customer does: the map's landing, then its
 *  "Review what to ingest" button. Never by deep link — the Decide stages are
 *  entered by an act, on purpose. */
async function renderLedger(cfg: ApiConfig = {}) {
  const api = installApi({
    runResolution: res(200, RICH_DOC),
    suggestions: [res(200, suggestionsBody())],
    ...cfg,
  });
  const user = userEvent.setup();
  renderMap();
  await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Review what to ingest' }));
  await waitFor(() => expect(screen.getByText('What we suggest reading')).toBeInTheDocument());
  return { api, user };
}

function ledgerRow(path: string): HTMLElement {
  const el = document.querySelector(`[data-testid="ledger-row"][data-path="${path}"]`);
  if (!el) throw new Error(`no ledger row rendered for ${path}`);
  return el as HTMLElement;
}

describe('the funnel, as pure arithmetic (34-S11c)', () => {
  it('reconciles from the fixture: candidates − every named subtraction == the default selection, files AND bytes', () => {
    const p = parseSuggestions(suggestionsBody())!;
    const r = funnelReconciliation(p);

    // Recomputed from the RAW fixture, not trusted from the payload.
    const subFiles = FUNNEL_TABLE.reduce((s, x) => s + x.files, 0);
    const subBytes = FUNNEL_TABLE.reduce((s, x) => s + x.bytes, 0);
    expect(subFiles).toBe(4);
    expect(subBytes).toBe(15_250_000);
    expect(r.subtractedFiles).toBe(subFiles);
    expect(r.subtractedBytes).toBe(subBytes);
    expect(r.candidates.files - subFiles).toBe(r.defaultSelection.files);
    expect(r.candidates.bytes - subBytes).toBe(r.defaultSelection.bytes);
    expect(r.reconciles).toBe(true);
    expect(r.residualFiles).toBe(0);
    expect(r.residualBytes).toBe(0);

    // And the default selection equals the sum of the rows the ledger marks
    // selected — the two halves of the fixture agree with each other.
    const selected = LEDGER_ROWS.filter((row) => row.verdict === 'selected');
    expect(selected).toHaveLength(r.defaultSelection.files);
    expect(selected.reduce((s, row) => s + row.size, 0)).toBe(r.defaultSelection.bytes);
  });

  it('a funnel that cannot add says so instead of rendering a broken one as clean', () => {
    // MUTATION: one subtraction row loses a file. The workers' evaluator
    // refuses this shape, so it should never arrive — which is exactly why
    // the screen must not silently absorb it if it ever does.
    const broken = suggestionsBody({
      funnelTable: FUNNEL_TABLE.map((r) => (r.rule === 'receipt_shape' ? { ...r, files: 0 } : r)),
    });
    const r = funnelReconciliation(parseSuggestions(broken)!);
    expect(r.reconciles).toBe(false);
    expect(r.residualFiles).toBe(-1);
  });

  it('parses the whole verdict grammar, and renders an unknown one as data rather than guessing', () => {
    expect(parseVerdict('selected')).toEqual({ kind: 'selected' });
    expect(parseVerdict('subtracted:receipt_shape')).toEqual({ kind: 'subtracted', rule: 'receipt_shape' });
    expect(parseVerdict('subtracted:propagated_from:receipt_shape')).toEqual({
      kind: 'propagated',
      rule: 'receipt_shape',
    });
    expect(parseVerdict('not_candidate:media')).toEqual({ kind: 'not_candidate', className: 'media' });
    expect(parseVerdict('something_new')).toEqual({ kind: 'unknown', raw: 'something_new' });
  });

  it('a payload with no funnel table is a load failure, never an empty funnel beside real rows', () => {
    expect(parseSuggestions({ rows: LEDGER_ROWS })).toBeNull();
    expect(parseSuggestions(null)).toBeNull();
    // Absent `ranking` reads as UNRANKED — the honest default when the
    // server claimed no order at all.
    const p = parseSuggestions(suggestionsBody({ ranking: undefined }))!;
    expect(p.ranking.ranked).toBe(false);
  });
});

describe('the running total and the cost mirror (34-S12a/34-S13b)', () => {
  const payload = () => parseSuggestions(suggestionsBody())!;
  const rowsByPath = () => new Map(payload().rows.map((r) => [r.path, r]));
  const edits = (removed: string[] = [], readded: string[] = []) => ({
    removed: new Set(removed),
    readded: new Set(readded),
  });

  it('unedited: the totals are the default and the range is the SERVER’s own numbers', () => {
    const t = selectionTotals(payload(), edits(), rowsByPath());
    expect(t.files).toBe(3);
    expect(t.bytes).toBe(2_048_000);
    expect(t.edited).toBe(false);
    expect(t.tokens).toEqual({ low: COST_ESTIMATE.tokenLow, high: COST_ESTIMATE.tokenHigh });
    // The live equivalence check: the mirror at zero delta reproduces the
    // server's emitted range exactly.
    expect(t.mirrorAgrees).toBe(true);
  });

  it('a removal subtracts exactly that row, from files, bytes AND the right half of the cost', () => {
    const t = selectionTotals(payload(), edits(['/Docs/report.pdf']), rowsByPath());
    expect(t.files).toBe(2);
    expect(t.bytes).toBe(48_000);
    expect(t.removedFiles).toBe(1);
    // 48,000 text bytes ÷ 4 = 12,000 tokens, no binary left at either end.
    expect(t.tokens).toEqual({ low: 12_000, high: 12_000 });
    expect(t.binaryShare).toBe(0);
  });

  it('a re-add adds exactly that row', () => {
    const t = selectionTotals(payload(), edits([], ['/Books/standard.pdf']), rowsByPath());
    expect(t.files).toBe(4);
    expect(t.bytes).toBe(16_748_000);
    expect(t.readdedFiles).toBe(1);
    // text 48,000 ÷ 4 = 12,000; binary 16,700,000 ÷ 50 = 334,000, ÷ 4 = 4,175,000
    expect(t.tokens).toEqual({ low: 346_000, high: 4_187_000 });
  });

  it('mirrors the workers’ own resolution: a re-add of a removed row WINS, and a removal of a non-selected row is a no-op', () => {
    // The selective-ingest activities' resolveSelectionRows: chosen =
    // selected − removed, then every readded path added back. Disagreeing
    // here would promise a set the ingest will not read.
    const both = selectionTotals(payload(), edits(['/Docs/plan.md'], ['/Docs/plan.md']), rowsByPath());
    expect(both.files).toBe(3);
    expect(both.removedFiles).toBe(0);

    const noop = selectionTotals(payload(), edits(['/Books/standard.pdf']), rowsByPath());
    expect(noop.files).toBe(3);
    expect(noop.removedFiles).toBe(0);

    const rows = rowsByPath();
    expect(isRowSelected(rows.get('/Docs/plan.md')!, edits(['/Docs/plan.md'], ['/Docs/plan.md']))).toBe(true);
    expect(isRowSelected(rows.get('/Docs/plan.md')!, edits(['/Docs/plan.md']))).toBe(false);
    expect(isRowSelected(rows.get('/Books/standard.pdf')!, edits())).toBe(false);
    expect(isRowSelected(rows.get('/Books/standard.pdf')!, edits([], ['/Books/standard.pdf']))).toBe(true);
  });

  it('files with no extension count as BINARY — the honest bucket for an unknown format is the wide range', () => {
    const p = parseSuggestions(
      suggestionsBody({
        rows: [
          { itemId: 'x', path: '/README', name: 'README', size: 400, modified: '', verdict: 'subtracted:receipt_shape' },
          ...LEDGER_ROWS,
        ],
      })
    )!;
    const t = selectionTotals(p, edits([], ['/README']), new Map(p.rows.map((r) => [r.path, r])));
    // 400 B into the binary share: low gains ceil-worth of 400/50 = 8,
    // high gains 100 — a text bucket would have given 100 at BOTH ends.
    expect(t.tokens).toEqual({ low: 52_008, high: 512_100 });
  });

  it('when the mirror and the server disagree, the edited range is WITHDRAWN rather than reported from arithmetic we know is wrong', () => {
    // MUTATION of the SERVER's side: a cost block whose tokenLow the mirror
    // cannot reproduce. This is the divergence guard doing its job.
    const p = parseSuggestions(suggestionsBody({ costEstimate: { ...COST_ESTIMATE, tokenLow: 1 } }))!;
    const rows = new Map(p.rows.map((r) => [r.path, r]));
    const unedited = selectionTotals(p, edits(), rows);
    expect(unedited.mirrorAgrees).toBe(false);
    // Unedited still shows the SERVER's numbers — it is the authority.
    expect(unedited.tokens).toEqual({ low: 1, high: COST_ESTIMATE.tokenHigh });
    const editedNow = selectionTotals(p, edits(['/Docs/report.pdf']), rows);
    expect(editedNow.tokens).toBeNull();
  });

  it('the mirrored constants are pinned to the core cost model’s, with their provenance named', () => {
    // Mutation-provable: change either side and this goes red naming the
    // check. The mirror exists only because no endpoint costs an UNSAVED
    // decision — see COST_MIRROR_OF's comment. The values are duplicated BY
    // VALUE rather than imported, because @shelfmark/core carries a Mongo
    // dependency no browser bundle should inherit; the live zero-delta
    // equivalence check above is what keeps the two copies honest.
    expect(DEFAULT_COST_MODEL.textLikeExtensions).toEqual(['md', 'txt', 'csv']);
    expect(DEFAULT_COST_MODEL.textBytesPerToken).toBe(4);
    expect(DEFAULT_COST_MODEL.binaryLowYield).toBe(50);
    expect(DEFAULT_COST_MODEL.binaryHighYield).toBe(4);
    expect(COST_MIRROR_OF).toContain('COST_MODEL');
    expect(COST_MIRROR_OF).toContain('@shelfmark/core');
  });

  it('a payload with no cost block promises no range at all', () => {
    const p = parseSuggestions(suggestionsBody({ costEstimate: undefined }))!;
    const t = selectionTotals(p, edits(), new Map(p.rows.map((r) => [r.path, r])));
    expect(t.tokens).toBeNull();
    expect(t.mirrorAgrees).toBe(false);
  });
});

describe('the suggestion ledger on screen (34-S11c)', () => {
  it('renders the funnel with every subtraction NAMED and COUNTED — zero rows included — and shows the arithmetic', async () => {
    await renderLedger();

    // Every rule in the policy's precedence order, including the two that
    // took nothing: a rule that only appears when it fires cannot be audited.
    for (const label of [
      'archived dump copies',
      'stubs under 200 bytes',
      'receipts',
      'machine output in prose clothing',
      'third-party publications',
      'duplicates of something already removed',
      'duplicate fingerprints',
    ]) {
      expect(screen.getByText(`− ${label}`)).toBeInTheDocument();
    }
    expect(screen.getByText(/Rules that took nothing are listed with a zero/)).toBeInTheDocument();

    // The arithmetic SHOWN, not asserted.
    expect(
      screen.getByText('7 candidates − 4 subtracted = 3 selected · 17.3 MB − 15.3 MB = 2.0 MB.')
    ).toBeInTheDocument();
    // Provenance: the rules that produced the recommendation, by version+sha.
    expect(screen.getByText(/Funnel policy 1\.0\.0-rc1 · SHA-256 8f41d4d1/)).toBeInTheDocument();
  });

  it('a funnel that does not add up renders the residual out loud, in red, with both figures', async () => {
    await renderLedger({
      suggestions: [
        res(200, suggestionsBody({ funnelTable: FUNNEL_TABLE.map((r) => (r.rule === 'receipt_shape' ? { ...r, files: 0 } : r)) })),
      ],
    });
    expect(screen.getByText(/These rows do not add up/)).toBeInTheDocument();
    expect(screen.getByText(/leaves 4, and the recorded selection is 3/)).toBeInTheDocument();
  });

  it('every row carries its reason: the rule that took it, or that it is selected', async () => {
    await renderLedger();
    expect(within(ledgerRow('/Docs/plan.md')).getByText('selected')).toBeInTheDocument();
    expect(
      within(ledgerRow('/Archive/logs.txt')).getByText('removed by machine output in prose clothing')
    ).toBeInTheDocument();
    expect(
      within(ledgerRow('/Books/standard.pdf')).getByText('removed by third-party publications')
    ).toBeInTheDocument();
    // The propagated edge reads as what it is — removed WITH its duplicate.
    expect(
      within(ledgerRow('/Copies/dinner.pdf')).getByText('removed with its duplicate, by receipts')
    ).toBeInTheDocument();
    expect(within(ledgerRow('/Media/clip.mov')).getByText(/not a candidate — classified Media/)).toBeInTheDocument();
  });

  it('rank absent renders as UNRANKED and says why — never path order borrowed as merit', async () => {
    await renderLedger();
    expect(
      screen.getByText(/in path order — which is not a quality ranking and is not presented as one/)
    ).toBeInTheDocument();
    expect(screen.getByText(/no portable ordering spec published for the funnel port/)).toBeInTheDocument();
    expect(within(ledgerRow('/Docs/plan.md')).getByText('unranked')).toBeInTheDocument();
  });

  it('a TIE renders AS a tie, and an arbitrary order says so — arbitrary order is never presented as merit', async () => {
    await renderLedger({
      suggestions: [
        res(
          200,
          suggestionsBody({
            ranking: { ranked: true, reason: '' },
            rows: LEDGER_ROWS.map((r) =>
              r.path === '/Docs/notes.txt'
                ? { ...r, rank: 3, tieGroupSize: 4 }
                : r.path === '/Docs/plan.md'
                  ? { ...r, rank: 1 }
                  : r.path === '/Docs/report.pdf'
                    ? { ...r, rank: 2, rankIsArbitrary: true }
                    : r
            ),
          })
        ),
      ],
    });
    expect(within(ledgerRow('/Docs/notes.txt')).getByText('tied at rank 3 with 3 others')).toBeInTheDocument();
    expect(within(ledgerRow('/Docs/plan.md')).getByText('rank 1')).toBeInTheDocument();
    expect(
      within(ledgerRow('/Docs/report.pdf')).getByText('rank 2 — order inside this tie is arbitrary')
    ).toBeInTheDocument();
    // The unranked caption is gone precisely because there IS an order now.
    expect(screen.queryByText(/is not a quality ranking/)).not.toBeInTheDocument();
  });

  it('pagination totals and the page cap render AS WORDS, and the opaque cursor is echoed verbatim', async () => {
    const page2 = suggestionsBody({ rows: [], rowsTotal: 12, nextCursor: null });
    const { api, user } = await renderLedger({
      suggestions: [res(200, suggestionsBody({ rowsTotal: 12, nextCursor: 'cm93czoy' })), res(200, page2)],
    });
    expect(screen.getByText('Showing 8 of 12 rows.')).toBeInTheDocument();
    expect(screen.getByText('One page carries at most 2,000 rows.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load the next page' }));
    await waitFor(() => expect(screen.getByText('That is every row in the ledger.')).toBeInTheDocument());
    // OPAQUE: echoed byte-for-byte, never parsed or rebuilt.
    expect(api.suggestionsUrls[1]).toBe('/api/v1/connectors/conn-1/map/suggestions?cursor=cm93czoy');
  });

  it('a cursor the server no longer recognises stops the listing and SAYS so — never a partial list presented as whole', async () => {
    const { user } = await renderLedger({
      suggestions: [res(200, suggestionsBody({ rowsTotal: 12, nextCursor: 'stale' })), res(400, { error: 'invalid_cursor' })],
    });
    await user.click(screen.getByRole('button', { name: 'Load the next page' }));
    await waitFor(() =>
      expect(screen.getByText(/did not recognise the position we asked to continue from/)).toBeInTheDocument()
    );
    expect(screen.queryByText('That is every row in the ledger.')).not.toBeInTheDocument();
  });

  it('the WRITE cap renders as words, and a truncated ledger refuses to be decided', async () => {
    await renderLedger({
      suggestions: [res(200, suggestionsBody({ rowsTruncated: true, rowsOmitted: 4_312, rowsTotal: 20_000 }))],
    });
    expect(screen.getByText(/The ledger itself stops at 20,000 rows — 4,312 more files are counted/)).toBeInTheDocument();
    // The same refusal the server (409 suggestion_rows_truncated) and the
    // workers make — surfaced before the click.
    expect(screen.getByRole('button', { name: 'Continue — approve the reading' })).toBeDisabled();
  });

  it('a long ledger virtualizes, and still states its counts', async () => {
    const many = Array.from({ length: MAP_LEDGER_TUNING.virtualizeRowsOver + 5 }, (_, i) => ({
      itemId: `v${i}`,
      path: `/Bulk/file-${i}.md`,
      name: `file-${i}.md`,
      size: 1_000,
      modified: '',
      verdict: 'selected',
    }));
    await renderLedger({ suggestions: [res(200, suggestionsBody({ rows: many, rowsTotal: many.length }))] });
    // jsdom cannot measure a scroll viewport, so (as with the prune report)
    // the assertion is the container and the STATED counts, not the rows.
    expect(screen.getByTestId('ledger-virtual')).toBeInTheDocument();
    expect(screen.getByText('Showing 45 of 45 rows.')).toBeInTheDocument();
  });
});

describe('a terminal run is not a dead end (JRN-9 / 34-S07f)', () => {
  it('a FAILED run offers a way to run again — it did not, and that cost two live attempts', async () => {
    // THE LIVE DEFECT, 2026-08-21. A failed run doc from hours earlier
    // resolved to 'landed', so opening the map flow rendered that stale
    // obituary and offered nothing. Pressing "Map this folder" navigated
    // here and never issued a POST at all — the customer-owner tried twice
    // and both times the page reported a failure that had already happened.
    installApi({});
    const onRemap = vi.fn();
    renderLanded({ runId: 'map-conn-1', status: 'failed', narration: [] }, { onRemap });

    const retry = screen.getByRole('button', { name: /try the map again/i });
    expect(retry).toBeEnabled();
    await userEvent.click(retry);
    expect(onRemap).toHaveBeenCalledTimes(1);
  });

  it('a COMPLETE run offers a re-map, because a map is a photograph', () => {
    installApi({});
    const onRemap = vi.fn();
    renderLanded(
      { runId: 'map-conn-1', status: 'complete', narration: [], progress: { itemsSeen: 12, foldersWalked: 3 } },
      { onRemap }
    );
    expect(screen.getByRole('button', { name: /map it again/i })).toBeInTheDocument();
  });
});

describe('JRN-D1 on screen: reported, not gated, and never a dossier (34-S12b)', () => {
  it('renders shape COUNTS over candidates and the default selection, zeros included — and no path anywhere near them', async () => {
    await renderLedger();
    const panel = screen.getByText('Sensitive shapes — reported, not gated').closest('div')!;

    expect(within(panel).getByText('Bank-statement shaped')).toBeInTheDocument();
    expect(within(panel).getByText('Credential shaped')).toBeInTheDocument();
    expect(within(panel).getByText('Tax shaped')).toBeInTheDocument();
    expect(within(panel).getByText(/Nothing below was removed for being sensitive/)).toBeInTheDocument();

    // COUNTS ONLY. Not one path, and no control that could sort or filter
    // the ledger into a ranked list of them — a ranked table of those paths
    // on one screen IS the dossier.
    expect(panel.textContent).not.toMatch(/\/Docs|\/Books|\/Receipts|\/Copies|\/Media/);
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/A ranked table of those paths on one screen is a dossier/)).toBeInTheDocument();
  });

  it('SCREEN-LEVEL: no sensitive path is listed anywhere outside its own ledger row', async () => {
    // The sibling-leak guard. The counts-panel assertion above is scoped to
    // the SensitiveCountsTable subtree, so a digest rendered as its SIBLING
    // — `rows.filter(r => r.reportedShapes?.length).map(r => r.path).join()`
    // dropped anywhere else on the page — passes it while shipping exactly
    // the dossier JRN-D1 forbids. This binds the invariant to the SCREEN.
    //
    // What is legitimate: a sensitive-shaped document appears in the full
    // ledger as ONE row among all the others, indistinguishable in kind.
    // What is forbidden: those paths collected together anywhere.
    await renderLedger();

    const sensitivePaths = LEDGER_ROWS.filter((r: any) => (r.reportedShapes ?? []).length > 0).map((r: any) => r.path);
    expect(sensitivePaths.length).toBeGreaterThan(0); // else this proves nothing

    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      // Skip the ledger row list itself — one row per document is the
      // product, and a container of ALL rows legitimately holds many paths.
      if (el.closest('[data-testid="ledger-row"]')) continue;
      if (el.querySelector('[data-testid="ledger-row"]')) continue;
      const text = el.textContent ?? '';
      const hits = sensitivePaths.filter((sp: string) => text.includes(sp));
      expect(hits, `a sensitive path is rendered outside its own ledger row: ${hits.join(', ')}`).toEqual([]);
    }
  });

  it('live credentials get rotate-don’t-exclude advice, and are NOT excluded', async () => {
    await renderLedger();
    expect(screen.getByText(/Rotate it, don’t exclude it/)).toBeInTheDocument();
    expect(screen.getByText(/1 files here look like live secrets/)).toBeInTheDocument();
    // Nothing was subtracted for being sensitive: the two shape-carrying
    // rules never appear as funnel rows.
    expect(screen.queryByText(/− Credential shaped/)).not.toBeInTheDocument();
    expect(within(ledgerRow('/Docs/report.pdf')).getByText('selected')).toBeInTheDocument();
  });

  it('on a SINGLE-OWNER tenant the who-else-can-search warning does not appear at all', async () => {
    await renderLedger(); // default: one person in the workspace
    await waitFor(() => expect(screen.getByText(/Rotate it, don’t exclude it/)).toBeInTheDocument());
    expect(screen.queryByText(/people can sign in to this workspace/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Assume everyone in this workspace can/)).not.toBeInTheDocument();
  });

  it('on a SHARED tenant it does, with the count — and an unknown shape says it is unknown rather than staying silent', async () => {
    await renderLedger({ collaborators: 3 });
    await waitFor(() => expect(screen.getByText(/3 people can sign in to this workspace/)).toBeInTheDocument());
    cleanup();

    await renderLedger({ collaborators: 'reject' });
    await waitFor(() => expect(screen.getByText(/Assume everyone in this workspace can/)).toBeInTheDocument());
    cleanup();

    // A host hook that answers null is the same honest "could not tell".
    await renderLedger({ collaborators: null });
    await waitFor(() => expect(screen.getByText(/Assume everyone in this workspace can/)).toBeInTheDocument());
  });
});

describe('the subtractive pass and its asymmetry (34-S12a)', () => {
  it('removing is ONE click; adding back is expand-then-confirm with the rule restated', async () => {
    const { user } = await renderLedger();

    // One click, done.
    await user.click(within(ledgerRow('/Docs/report.pdf')).getByRole('button', { name: 'Remove' }));
    expect(ledgerRow('/Docs/report.pdf')).toHaveAttribute('data-selected', 'false');
    expect(within(ledgerRow('/Docs/report.pdf')).getByText('Removed')).toBeInTheDocument();

    // A subtracted row offers no one-click anything — only "Add back…".
    const subtracted = ledgerRow('/Books/standard.pdf');
    expect(within(subtracted).queryByRole('button', { name: 'Add it back anyway' })).not.toBeInTheDocument();
    await user.click(within(subtracted).getByRole('button', { name: 'Add back…' }));

    // The rule being overridden is restated before the second act — IN the
    // confirmation panel, not merely somewhere on the page.
    const confirm = screen.getByRole('group', { name: 'Adding back standard.pdf' });
    expect(within(confirm).getByText(/taken out by “third-party publications”/)).toBeInTheDocument();
    expect(within(confirm).getByText(/Ask, don’t assume/)).toBeInTheDocument();
    expect(within(confirm).getByText('/Books/standard.pdf')).toBeInTheDocument();
    // Still not added — the row has not moved.
    expect(ledgerRow('/Books/standard.pdf')).toHaveAttribute('data-selected', 'false');

    await user.click(screen.getByRole('button', { name: 'Add it back anyway' }));
    expect(ledgerRow('/Books/standard.pdf')).toHaveAttribute('data-selected', 'true');
    expect(within(ledgerRow('/Books/standard.pdf')).getByText('Added back')).toBeInTheDocument();
  });

  it('a PROPAGATED row restates what actually happened — a copy was judged, not this file, and the override is one file wide', async () => {
    const { user } = await renderLedger();
    await user.click(within(ledgerRow('/Copies/dinner.pdf')).getByRole('button', { name: 'Add back…' }));
    const confirm = screen.getByRole('group', { name: 'Adding back dinner.pdf' });
    expect(within(confirm).getByText(/fingerprint-identical copy of it was taken out by “receipts”/)).toBeInTheDocument();
    expect(within(confirm).getByText(/the other copies are unaffected/)).toBeInTheDocument();
    // Saying "taken out by receipts" would overstate what was observed about
    // THIS file — that is the sentence the propagated branch exists to avoid.
    expect(within(confirm).queryByText(/^This file was taken out by/)).not.toBeInTheDocument();
  });

  it('backing out of a re-add leaves it out — the confirm is the act, not the expand', async () => {
    const { user } = await renderLedger();
    await user.click(within(ledgerRow('/Books/standard.pdf')).getByRole('button', { name: 'Add back…' }));
    await user.click(screen.getByRole('button', { name: 'Leave it out' }));
    expect(screen.queryByText(/Adding back standard.pdf/)).not.toBeInTheDocument();
    expect(ledgerRow('/Books/standard.pdf')).toHaveAttribute('data-selected', 'false');
  });

  it('the running total — files, bytes and the cost RANGE with the binary share — updates live', async () => {
    const { user } = await renderLedger();

    // Unedited: the server's own range, and the binary share named.
    expect(screen.getByText('3 files · 2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('Estimated 52,000–512,000 tokens.')).toBeInTheDocument();
    expect(
      screen.getByText(/97\.7% of this selection is PDF and Word, where size predicts text poorly/)
    ).toBeInTheDocument();
    expect(screen.getByText('Unchanged from the default selection.')).toBeInTheDocument();

    await user.click(within(ledgerRow('/Docs/report.pdf')).getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('2 files · 48.0 KB')).toBeInTheDocument();
    expect(screen.getByText('Estimated 12,000–12,000 tokens.')).toBeInTheDocument();
    // No binary left: the share sentence changes rather than saying "0%".
    expect(screen.getByText(/entirely plain-text formats/)).toBeInTheDocument();
    expect(screen.getByText('1 removed and 0 added back, from a default of 3 files.')).toBeInTheDocument();
    expect(screen.getByText(/You have changes that are not saved/)).toBeInTheDocument();
  });

  it('the PUT body is exactly the rows that were acted on, both arrays, rebuilt', async () => {
    const { api, user } = await renderLedger({
      selectionPut: [res(200, { runId: 'drive-map-conn-1', decidedAt: '2026-08-20T12:00:00.000Z' })],
    });
    await user.click(within(ledgerRow('/Docs/report.pdf')).getByRole('button', { name: 'Remove' }));
    await user.click(within(ledgerRow('/Books/standard.pdf')).getByRole('button', { name: 'Add back…' }));
    await user.click(screen.getByRole('button', { name: 'Add it back anyway' }));
    await user.click(screen.getByRole('button', { name: 'Save this decision' }));

    await waitFor(() => expect(api.selectionBodies).toHaveLength(1));
    expect(api.selectionBodies[0]).toEqual({
      removedPaths: ['/Docs/report.pdf'],
      readdedPaths: ['/Books/standard.pdf'],
    });
    await waitFor(() => expect(screen.getByText(/Decision saved/)).toBeInTheDocument());
  });

  it('an undone removal leaves the arrays empty — the decision sent is what is on screen', async () => {
    const { api, user } = await renderLedger({ selectionPut: [res(200, { decidedAt: '2026-08-20T12:00:00.000Z' })] });
    await user.click(within(ledgerRow('/Docs/plan.md')).getByRole('button', { name: 'Remove' }));
    await user.click(within(ledgerRow('/Docs/plan.md')).getByRole('button', { name: 'Undo' }));
    await user.click(screen.getByRole('button', { name: 'Save this decision' }));
    await waitFor(() => expect(api.selectionBodies).toHaveLength(1));
    expect(api.selectionBodies[0]).toEqual({ removedPaths: [], readdedPaths: [] });
  });

  it('a decision already on record comes back as THEIR selection, not the default', async () => {
    await renderLedger({
      selectionGet: res(200, {
        runId: 'drive-map-conn-1',
        removedPaths: ['/Docs/notes.txt'],
        readdedPaths: ['/Receipts/dinner.pdf'],
        decidedAt: '2026-08-19T09:00:00.000Z',
      }),
    });
    await waitFor(() => expect(ledgerRow('/Docs/notes.txt')).toHaveAttribute('data-selected', 'false'));
    expect(ledgerRow('/Receipts/dinner.pdf')).toHaveAttribute('data-selected', 'true');
    // 3 − notes.txt(8,000) + dinner.pdf(25,000)
    expect(screen.getByText('3 files · 2.1 MB')).toBeInTheDocument();
  });

  it('every save refusal renders by name, and the changes survive it', async () => {
    for (const [answer, needle] of [
      [res(400, { error: 'selection_path_unknown', field: 'removedPaths', path: '/Docs/gone.md' }), /does not recognise \/Docs\/gone.md in this ledger \(removedPaths\)/],
      [res(400, { error: 'selection_paths_invalid', field: 'readdedPaths' }), /readdedPaths we sent was not a valid list/],
      [res(404, { error: 'no_suggestions' }), /no suggestion ledger to decide against/],
      [res(409, { error: 'suggestion_rows_truncated' }), /larger than one record can hold/],
      [res(404, { error: 'No connection conn-1' }), /connection no longer exists, so nothing was saved/],
      [res(503, { error: 'boom' }), /decision was not saved. Your changes are still here/],
    ] as const) {
      const { user } = await renderLedger({ selectionPut: [answer] });
      await user.click(within(ledgerRow('/Docs/plan.md')).getByRole('button', { name: 'Remove' }));
      await user.click(screen.getByRole('button', { name: 'Save this decision' }));
      await waitFor(() => expect(screen.getByText(needle)).toBeInTheDocument());
      // The edit is still on screen — a failed save never silently reverts.
      expect(ledgerRow('/Docs/plan.md')).toHaveAttribute('data-selected', 'false');
      cleanup();
    }
  });

  it('no state renders nothing: a missing ledger and a failed load each say what happened', async () => {
    installApi({ runResolution: res(200, RICH_DOC), suggestions: [res(404, { error: 'no_suggestions' })] });
    let user = userEvent.setup();
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Review what to ingest' }));
    await waitFor(() => expect(screen.getByText(/This map produced no suggestion ledger/)).toBeInTheDocument());
    cleanup();

    const api = installApi({
      runResolution: res(200, RICH_DOC),
      suggestions: [res(500, { error: 'boom' }), res(200, suggestionsBody())],
    });
    user = userEvent.setup();
    renderMap();
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Review what to ingest' }));
    await waitFor(() => expect(screen.getByText(/suggestion ledger could not be loaded/)).toBeInTheDocument());
    // And the retry actually retries.
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('What we suggest reading')).toBeInTheDocument());
    expect(api.order.filter((o) => o === 'GET suggestions')).toHaveLength(2);
  });
});

describe('ingest consent — the second receipt (34-S13a/b/c)', () => {
  /** Decide, save, and land on step 13 — the only way there. */
  async function renderIngestConsent(cfg: ApiConfig = {}) {
    const { api, user } = await renderLedger({
      selectionPut: [res(200, { decidedAt: '2026-08-20T12:00:00.000Z' })],
      ...cfg,
    });
    await user.click(screen.getByRole('button', { name: 'Continue — approve the reading' }));
    await waitFor(() => expect(screen.getByText('Open and read the files you chose.')).toBeInTheDocument());
    return { api, user };
  }

  it('a decision is written BEFORE step 13 can promise anything — Decide is not optional on this flow', async () => {
    const { api } = await renderIngestConsent();
    expect(api.selectionBodies).toEqual([{ removedPaths: [], readdedPaths: [] }]);
    expect(api.order.indexOf('PUT selection')).toBeLessThan(api.order.indexOf('GET ingest disclosure'));
  });

  it('renders the INGEST disclosure verbatim with its sha, and the CTA carries the real live count', async () => {
    await renderIngestConsent();
    const node = screen.getByText(/The operator will open each file you selected/);
    expect(node.textContent).toBe(INGEST_DISCLOSURE_TEXT);
    expect(screen.getByText(new RegExp(INGEST_DISCLOSURE_SHA))).toBeInTheDocument();
    // The map's own words must NOT be the ones on this screen.
    expect(screen.queryByText(/It will not open any file\./)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open and read 3 files' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bagree\b/i);
  });

  it('the count on the button is the EDITED selection, and the cost is a range with the binary share named', async () => {
    const { user } = await renderLedger({ selectionPut: [res(200, { decidedAt: '2026-08-20T12:00:00.000Z' })] });
    await user.click(within(ledgerRow('/Docs/report.pdf')).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Continue — approve the reading' }));
    await waitFor(() => expect(screen.getByText('Open and read the files you chose.')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Open and read 2 files' })).toBeInTheDocument();
    expect(screen.getByText(/2 files · 48.0 KB, decided/)).toBeInTheDocument();
    expect(screen.getByText('Estimated 12,000–12,000 tokens.')).toBeInTheDocument();
    expect(screen.getByText(/How this is worked out:/)).toBeInTheDocument();
  });

  it('a one-file selection says “1 file”, not “1 files”', async () => {
    const one = LEDGER_ROWS.filter((r) => r.path === '/Docs/plan.md');
    const { user } = await renderLedger({
      suggestions: [
        res(
          200,
          suggestionsBody({
            rows: one,
            rowsTotal: 1,
            candidates: { files: 1, bytes: 40_000 },
            funnelTable: FUNNEL_TABLE.map((r) => ({ ...r, files: 0, bytes: 0 })),
            defaultSelection: { files: 1, bytes: 40_000 },
            costEstimate: { ...COST_ESTIMATE, textShareBytes: 40_000, binaryShareBytes: 0, binaryShareOfSelection: 0, tokenLow: 10_000, tokenHigh: 10_000 },
          })
        ),
      ],
      selectionPut: [res(200, { decidedAt: '2026-08-20T12:00:00.000Z' })],
    });
    await user.click(screen.getByRole('button', { name: 'Continue — approve the reading' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open and read 1 file' })).toBeInTheDocument());
  });

  it('THE LABEL QUESTION lands here, pre-filled with the host’s first label, with the map’s counts beside it — and is what gets POSTed', async () => {
    const { api, user } = await renderIngestConsent({
      grant: [res(201, { consentId: 'ic-1' })],
      ingest: [res(202, { status: 'ingesting', connectionId: 'conn-1', workflowId: 'ingest-conn-1' })],
    });

    const select = screen.getByLabelText('Data classification for these files') as HTMLSelectElement;
    // Pre-filled with the FIRST label the host offers — the value the picker
    // used to carry, now answered at the point the evidence exists.
    expect(select.value).toBe('commercial');
    // The picker's question, with the reason it moved here.
    expect(screen.getByText(/The folder picker deliberately stopped asking/)).toBeInTheDocument();
    // The host's LabelPolicy cap NAMED before it bites — resolve() lowers a
    // request above what policy allows and says nothing, which from this
    // screen would be a silent cap. The exact value is the host's business
    // (this UI holds no copy of the host's label lattice — a second copy of
    // a rule set is the thing that diverges), so the bound is stated
    // generically: lowered, never raised.
    expect(screen.getByText(/lower label than the one you choose/)).toBeInTheDocument();
    expect(screen.getByText(/lowers, never raises/)).toBeInTheDocument();
    // The evidence beside it — counts, still never paths.
    expect(screen.getByText(/What the map found in this selection, as evidence/)).toBeInTheDocument();
    expect(screen.getAllByText('Tax shaped').length).toBeGreaterThan(0);

    await user.selectOptions(select, 'unclassified');
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(api.ingestBodies).toHaveLength(1));
    expect(api.ingestBodies[0]).toEqual({ defaultLabel: 'unclassified' });
  });

  it('grants echoing the exact displayed sha, and starts the ingest ONLY after the grant succeeds', async () => {
    const { api, user } = await renderIngestConsent({
      grant: [res(201, { consentId: 'ic-1' })],
      ingest: [res(202, { status: 'ingesting', connectionId: 'conn-1', workflowId: 'ingest-conn-1' })],
    });
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(screen.getByText('Reading has started.')).toBeInTheDocument());

    expect(api.grantBodies).toHaveLength(1);
    expect(api.grantBodies[0].scope).toBe('ingest_content');
    expect(api.grantBodies[0].disclosureSha256).toBe(INGEST_DISCLOSURE_SHA);
    expect(api.order.indexOf('POST consents')).toBeLessThan(api.order.indexOf('POST ingest'));
  });

  it('never starts the ingest when the grant fails', async () => {
    const { api, user } = await renderIngestConsent({ grant: [res(503, { error: 'consent_not_recorded' })] });
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(screen.getByText(/Your consent was not recorded/)).toBeInTheDocument());
    expect(api.order).not.toContain('POST ingest');
  });

  it('on 409 disclosure_text_mismatch it re-fetches the words and does NOT silently re-grant', async () => {
    const { api, user } = await renderIngestConsent({
      grant: [res(409, { error: 'disclosure_text_mismatch' })],
      ingestDisclosure: [okIngestDisclosure(), okIngestDisclosure(NEW_INGEST_DISCLOSURE_TEXT, NEW_INGEST_DISCLOSURE_SHA)],
    });
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(screen.getByText(/consent text changed while this page was open/)).toBeInTheDocument());
    expect(screen.getByText(NEW_INGEST_DISCLOSURE_TEXT)).toBeInTheDocument();
    expect(api.grantBodies).toHaveLength(1);
    expect(api.order).not.toContain('POST ingest');
  });

  it('on 503 from the start, the grant is NOT repeated — one grant, then the start retried', async () => {
    const { api, user } = await renderIngestConsent({
      grant: [res(201, { consentId: 'ic-1' })],
      ingest: [res(503, { error: 'Unable to start ingest workflow — durable start failed' }), res(202, { workflowId: 'ingest-conn-1' })],
    });
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(screen.getByText(/Starting the read itself failed/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Start the read again' }));
    await waitFor(() => expect(screen.getByText('Reading has started.')).toBeInTheDocument());
    expect(api.grantBodies).toHaveLength(1);
    expect(api.ingestBodies).toHaveLength(2);
  });

  it('an active ingest_content grant skips the grant POST entirely', async () => {
    const { api, user } = await renderIngestConsent({
      consents: res(200, { active: [{ consentId: 'ic-0', scope: 'ingest_content', grantedAt: '2026-08-18T00:00:00.000Z' }] }),
      ingest: [res(202, { workflowId: 'ingest-conn-1' })],
    });
    expect(screen.getByText(/Reading consent is already on record/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(screen.getByText('Reading has started.')).toBeInTheDocument());
    expect(api.grantBodies).toHaveLength(0);
  });

  it('a map_metadata grant does NOT satisfy this consent — the second receipt is a second record', async () => {
    const { api, user } = await renderIngestConsent({
      consents: res(200, { active: [{ consentId: 'c-map', scope: 'map_metadata', grantedAt: '2026-08-18T00:00:00.000Z' }] }),
      grant: [res(201, { consentId: 'ic-1' })],
      ingest: [res(202, { workflowId: 'ingest-conn-1' })],
    });
    expect(screen.queryByText(/Reading consent is already on record/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(api.grantBodies).toHaveLength(1));
    expect(api.grantBodies[0].scope).toBe('ingest_content');
  });

  it('409 no_selection routes back to the ledger, honestly — never a retry loop against a 409 that cannot heal', async () => {
    const { user } = await renderIngestConsent({
      grant: [res(201, { consentId: 'ic-1' })],
      ingest: [res(409, { error: 'no_selection' })],
      suggestions: [res(200, suggestionsBody()), res(200, suggestionsBody())],
    });
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(screen.getByText(/no decision on record for this connection/)).toBeInTheDocument());
    // The button is not offered again — the flow, not the request, is wrong.
    expect(screen.getByRole('button', { name: 'Open and read 3 files' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Back to the ledger' }));
    await waitFor(() => expect(screen.getByText('What we suggest reading')).toBeInTheDocument());
  });

  it('every other refusal renders by name', async () => {
    for (const [answer, needle] of [
      [res(403, { error: 'ingest_consent_required' }), /no active reading consent for this connection/],
      [res(403, { error: 'connectors_disabled_for_tenant' }), /connectors switched off for this workspace/],
      [res(404, { error: 'No connection conn-1' }), /connection no longer exists/],
    ] as const) {
      const { user } = await renderIngestConsent({ grant: [res(201, { consentId: 'ic-1' })], ingest: [answer] });
      await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
      await waitFor(() => expect(screen.getByText(needle)).toBeInTheDocument());
      cleanup();
    }
  });

  it('a disclosure that will not load leaves nothing to consent to — the button stays disabled', async () => {
    await renderIngestConsent({ ingestDisclosure: [res(500, { error: 'boom' })] });
    await waitFor(() => expect(screen.getByText(/consent text could not be fetched/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Open and read 3 files' })).toBeDisabled();
  });

  it('with NO labels configured, the label picker is hidden and no label travels on the start', async () => {
    // The host's LabelPolicy default applies server-side; a UI with no label
    // vocabulary must not invent one. The counts evidence still renders —
    // it is the map's, not the label picker's.
    const noLabelConfig: ShelfmarkConfig = { ...harnessConfig, labels: [] };
    const api = installApi({
      runResolution: res(200, RICH_DOC),
      suggestions: [res(200, suggestionsBody())],
      selectionPut: [res(200, { decidedAt: '2026-08-20T12:00:00.000Z' })],
      grant: [res(201, { consentId: 'ic-1' })],
      ingest: [res(202, { workflowId: 'ingest-conn-1' })],
    });
    const user = userEvent.setup();
    render(
      <ShelfmarkProvider config={noLabelConfig}>
        <DriveMap connectionId="conn-1" scope={PICKED_SCOPE as any} />
      </ShelfmarkProvider>
    );
    await waitFor(() => expect(screen.getByText('The map is complete.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Review what to ingest' }));
    await waitFor(() => expect(screen.getByText('What we suggest reading')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Continue — approve the reading' }));
    await waitFor(() => expect(screen.getByText('Open and read the files you chose.')).toBeInTheDocument());

    expect(screen.queryByLabelText('Data classification for these files')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    // The sensitive-counts evidence still renders on the consent screen.
    expect(screen.getAllByText('Tax shaped').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(api.ingestBodies).toHaveLength(1));
    expect(api.ingestBodies[0]).toEqual({});
  });

  // UPDATED for 34-S14f, not relaxed. This test used to pin the OPPOSITE
  // sentence — "live progress is not on the connectors screen yet" — which
  // was the honest thing to say while the selective-ingest workflow wrote
  // only to `selective_ingest_runs` and nothing served it. It now mirrors
  // onto `connector_connections.lastIngestProgress`, the connections list
  // serves that, and <Connections/> renders it ahead of the legacy sync
  // panel. So the assertion flips to the new promise AND to the absence of
  // the old disclaimer: a stale "we cannot show you this" is a lie in the
  // other direction, and leaving it asserted would have kept it on screen.
  it('on 202 it hands off honestly: the run is named, and it points at the progress surface that now exists', async () => {
    const { user } = await renderIngestConsent({
      grant: [res(201, { consentId: 'ic-1' })],
      ingest: [res(202, { status: 'ingesting', connectionId: 'conn-1', workflowId: 'ingest-conn-1' })],
    });
    await user.click(screen.getByRole('button', { name: 'Open and read 3 files' }));
    await waitFor(() => expect(screen.getByText('Reading has started.')).toBeInTheDocument());
    expect(
      screen.getByText('3 files are being opened and read now. It runs in the background — you can leave this page.')
    ).toBeInTheDocument();
    expect(screen.getByText('Run ingest-conn-1')).toBeInTheDocument();
    expect(
      screen.getByText(/Live progress is on the connectors screen: files read against the 3 you approved/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/not on the connectors screen yet/)).not.toBeInTheDocument();
    // Page chrome (and its own back-link) is the HOST's now, so the only
    // link this stage renders is the CTA that names what is waiting there.
    expect(screen.queryAllByRole('link', { name: 'Back to connectors' })).toHaveLength(0);
    expect(screen.getByRole('link', { name: /Watch it read your files/ })).toHaveAttribute('href', '/connectors');
  });
});
