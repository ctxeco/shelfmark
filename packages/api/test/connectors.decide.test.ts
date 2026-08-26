// SPDX-License-Identifier: Apache-2.0
// The Decide endpoints — between the map and the ingest.
//
//   `34-S12c`: GET /:id/map/suggestions (the ledger, paginated with its total
//              stated), PUT /:id/map/selection (the decision, rebuilt not
//              patched), GET /:id/map/selection (read it back).
//   `34-S13b`: costEstimate — the honest token RANGE, computed server-side.
//   `34-S13c`: POST /:id/ingest — the SECOND consent, enforced at the edge,
//              and the label question finally answered (LabelPolicy).
//
// Acceptance shape mirrors connectors.map.test.ts: per-collection database
// mock (the decide path touches five collections), the workflow client
// mocked at the start seam, consent DERIVATION real — the activeConsents
// semantics under test are the actual @shelfmark/core export, not a
// reimplementation. The cost arithmetic is pinned separately in the core
// package's tests; here it is asserted end-to-end.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { LabelRefusedError, type AuthContext } from '@shelfmark/core';
import type { Db } from 'mongodb';
import { shelfmarkApi } from '../src/plugin.js';

const connectionFindOneMock = vi.fn();
const suggestionsFindOneMock = vi.fn();
const selectionFindOneMock = vi.fn();
const consentsToArrayMock = vi.fn();
const updateOneMock = vi.fn();

const dbMock = {
  collection: (name: string) => ({
    findOne: (...args: unknown[]) =>
      name === 'map_suggestions'
        ? suggestionsFindOneMock(...args)
        : name === 'map_selections'
          ? selectionFindOneMock(...args)
          : connectionFindOneMock(...args),
    updateOne: (...args: unknown[]) => updateOneMock(name, ...args),
    // Only listConsentEvents uses find() on these routes — capture its
    // filter so tenant scoping of the consent read is assertable.
    find: (...args: unknown[]) => ({
      sort: () => ({ toArray: () => consentsToArrayMock(...args) }),
    }),
  }),
} as unknown as Db;

const startWorkflowMock = vi.fn();
const tenantFlagsMock = vi.fn();
const labelResolveMock = vi.fn();

const KNOWN_LABELS = ['default', 'commercial'];

const CONNECTION = {
  connectionId: 'conn-1',
  tenantId: 'ACME-01',
  provider: 'onedrive',
  driveId: 'drive-abc',
  rootFolderId: null,
  rootPath: null,
};

/** An ACTIVE ingest_content grant, in the shape listConsentEvents returns. */
const INGEST_GRANT = {
  consentId: 'consent-ingest-1',
  tenantId: 'ACME-01',
  connectionId: 'conn-1',
  action: 'granted',
  revokesConsentId: null,
  scope: 'ingest_content',
};

/** The workers' ledger rows, path codepoint order. One text-like selected,
 *  one binary selected, one subtracted duplicate, one selected with a
 *  reported sensitive shape. */
const ROWS = [
  { itemId: 'i-1', path: '/Docs/a.md', name: 'a.md', size: 400, modified: '2026-08-01T00:00:00Z', verdict: 'selected' },
  { itemId: 'i-2', path: '/Docs/b.docx', name: 'b.docx', size: 1000, modified: '2026-08-01T00:00:00Z', verdict: 'selected' },
  {
    itemId: 'i-3',
    path: '/Docs/bank/statement.pdf',
    name: 'statement.pdf',
    size: 2000,
    modified: '2026-06-01T00:00:00Z',
    verdict: 'selected',
    reportedShapes: ['bank_statement_shape'],
  },
  {
    itemId: 'i-4',
    path: '/Docs/old/b.docx',
    name: 'b.docx',
    size: 1000,
    modified: '2026-07-01T00:00:00Z',
    verdict: 'subtracted:duplicate_fingerprint',
    subtractedBy: 'duplicate_fingerprint',
  },
];

const SUGGESTIONS_DOC = {
  tenantId: 'ACME-01',
  runId: 'map-conn-1',
  connectionId: 'conn-1',
  funnelPolicyVersion: '1.0.0-rc1',
  funnelPolicySha256: '8f41d4d1',
  classifierVersion: '1.0.0-rc2',
  classifierSha256: 'cafe',
  candidates: { files: 4, bytes: 4400 },
  funnelTable: [
    { rule: 'archived_dump_copy', files: 0, bytes: 0 },
    { rule: 'duplicate_fingerprint', files: 1, bytes: 1000 },
  ],
  defaultSelection: { files: 3, bytes: 3400 },
  sensitiveReport: { bank_statement_shape: { candidates: 1, defaultSelection: 1 } },
  ranking: { ranked: false, reason: 'no portable ordering spec' },
  rows: ROWS,
  rowsTruncated: false,
  rowsOmitted: 0,
  rowCap: 20000,
  writtenAt: '2026-08-20T01:00:00.000Z',
};

/** The costEstimate the fixture implies — pinned here BY HAND from the
 *  artifact arithmetic (text 400 B ÷ 4 = 100; binary 3000 B ÷ 50 = 60 low,
 *  ÷ 4 = 750 high), not recomputed via the function under test. */
const EXPECTED_COST = {
  textShareBytes: 400,
  binaryShareBytes: 3000,
  binaryShareOfSelection: 3000 / 3400,
  tokenLow: 160,
  tokenHigh: 850,
};

function rowsCursor(offset: number): string {
  return Buffer.from(`rows:${offset}`, 'utf8').toString('base64url');
}

async function buildApp(tenantId = 'ACME-01') {
  const app = Fastify();
  await app.register(shelfmarkApi, {
    prefix: '/api/v1/connectors',
    db: dbMock,
    ports: {
      sink: { accept: async () => ({ status: 'ingested' as const }) },
      resolveAuth: async (): Promise<AuthContext | null> => ({
        tenantId,
        sub: 'kc-user-9f3a',
        label: 'commercial',
      }),
      tenantPolicy: { flags: (...args: [string]) => tenantFlagsMock(...args) },
      labelPolicy: {
        labels: () => KNOWN_LABELS.map((id) => ({ id })),
        resolve: (requested: string | undefined, ctx: AuthContext) =>
          labelResolveMock(requested, ctx),
      },
    },
    temporal: {
      client: { workflow: { start: (...args: unknown[]) => startWorkflowMock(...args) } },
      taskQueue: 'test-ingest-queue',
    },
    config: {
      publicBaseUrl: 'https://portal.example.com',
      stateSecret: 'test-state-secret-at-least-32-bytes-long',
    },
  });
  return app;
}

beforeEach(() => {
  connectionFindOneMock.mockReset().mockResolvedValue(CONNECTION);
  tenantFlagsMock
    .mockReset()
    .mockResolvedValue({ connectorsEnabled: true, mappingEnabled: true });
  suggestionsFindOneMock.mockReset().mockResolvedValue(SUGGESTIONS_DOC);
  selectionFindOneMock.mockReset().mockResolvedValue(null);
  consentsToArrayMock.mockReset().mockResolvedValue([INGEST_GRANT]);
  updateOneMock.mockReset().mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  startWorkflowMock
    .mockReset()
    .mockImplementation(async (_type: string, o: { workflowId: string }) => ({
      workflowId: o.workflowId,
    }));
  labelResolveMock
    .mockReset()
    .mockImplementation((requested: string | undefined, ctx: AuthContext) =>
      requested && KNOWN_LABELS.includes(requested) ? requested : (ctx.label ?? 'default')
    );
});

describe('GET /api/v1/connectors/:id/map/suggestions (34-S12c read + 34-S13b cost range)', () => {
  it('serves the suggestions doc verbatim (minus _id) plus costEstimate, rowsTotal, rowsPageCap and a null nextCursor when one page holds it', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/suggestions' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The doc IS the contract — funnel table, sensitive counts, provenance,
    // ranking honesty, write-cap flags, all passed through untouched.
    expect(body.funnelTable).toEqual(SUGGESTIONS_DOC.funnelTable);
    expect(body.sensitiveReport).toEqual(SUGGESTIONS_DOC.sensitiveReport);
    expect(body.defaultSelection).toEqual(SUGGESTIONS_DOC.defaultSelection);
    expect(body.candidates).toEqual(SUGGESTIONS_DOC.candidates);
    expect(body.ranking).toEqual(SUGGESTIONS_DOC.ranking);
    expect(body.funnelPolicySha256).toBe('8f41d4d1');
    expect(body.rowsTruncated).toBe(false);
    expect(body.rowCap).toBe(20000);
    // Pagination contract: total stated, page cap named, complete listing
    // means null cursor — IF AND ONLY IF (the browse-contract lesson).
    expect(body.rows).toEqual(ROWS);
    expect(body.rowsTotal).toBe(4);
    expect(body.rowsPageCap).toBe(2000);
    expect(body.nextCursor).toBeNull();
    // Tenant isolation: the query itself is scoped; the runId is derived
    // from the path, never from the body.
    expect(suggestionsFindOneMock).toHaveBeenCalledWith(
      { runId: 'map-conn-1', tenantId: 'ACME-01' },
      { projection: { _id: 0 } }
    );
  });

  it('computes the 34-S13b cost RANGE over the selected rows — shares named, both ends stated, method naming the arithmetic', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/suggestions' });

    const { costEstimate } = res.json();
    expect(costEstimate).toMatchObject(EXPECTED_COST);
    // The method string names the arithmetic — the UI renders provenance,
    // not a bare number pair.
    expect(costEstimate.method).toContain('÷ 4');
    expect(costEstimate.method).toContain('÷ 50');
    expect(costEstimate.method).toContain('.md/.txt/.csv');
    // A range, not a fake point estimate.
    expect(costEstimate.tokenLow).toBeLessThan(costEstimate.tokenHigh);
  });

  it('404s {error: no_suggestions} when there is no doc — another tenant\'s doc reads as none', async () => {
    suggestionsFindOneMock.mockResolvedValue(null);
    const app = await buildApp('OTHER-TENANT');
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/suggestions' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no_suggestions' });
    expect(suggestionsFindOneMock).toHaveBeenCalledWith(
      { runId: 'map-conn-1', tenantId: 'OTHER-TENANT' },
      { projection: { _id: 0 } }
    );
  });

  it('paginates a ledger bigger than one page: total stated on every page, funnel table + sensitiveReport + costEstimate on every page, cursor null only at the end', async () => {
    // 2,500 rows — page cap is 2,000 (pinned literal, not imported from the
    // route: a validator pins its expectations in itself).
    const bigRows = Array.from({ length: 2500 }, (_, i) => ({
      itemId: `i-${i}`,
      path: `/f/${String(i).padStart(4, '0')}.txt`,
      name: `${i}.txt`,
      size: 10,
      modified: '2026-08-01T00:00:00Z',
      verdict: 'selected',
    }));
    suggestionsFindOneMock.mockResolvedValue({ ...SUGGESTIONS_DOC, rows: bigRows });

    const app = await buildApp();
    const page1 = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/suggestions' });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.rows).toHaveLength(2000);
    expect(body1.rows[0].path).toBe('/f/0000.txt');
    expect(body1.rowsTotal).toBe(2500);
    expect(body1.rowsPageCap).toBe(2000);
    // NOT the end — a non-null cursor, never a silent truncation.
    expect(typeof body1.nextCursor).toBe('string');
    // Opaque: not a bare offset the client is invited to do arithmetic on.
    expect(body1.nextCursor).not.toMatch(/^\d+$/);

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/connectors/conn-1/map/suggestions?cursor=${encodeURIComponent(body1.nextCursor)}`,
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.rows).toHaveLength(500);
    expect(body2.rows[0].path).toBe('/f/2000.txt');
    expect(body2.rowsTotal).toBe(2500);
    expect(body2.nextCursor).toBeNull();

    // The always-served block rides EVERY page — the Decide screens render
    // the funnel and the counts regardless of which rows are in view — and
    // the cost range covers the whole selection, not the page.
    for (const body of [body1, body2]) {
      expect(body.funnelTable).toEqual(SUGGESTIONS_DOC.funnelTable);
      expect(body.sensitiveReport).toEqual(SUGGESTIONS_DOC.sensitiveReport);
      expect(body.defaultSelection).toEqual(SUGGESTIONS_DOC.defaultSelection);
    }
    expect(body2.costEstimate).toEqual(body1.costEstimate);
    // 2,500 × 10 B of .txt ÷ 4 — the whole ledger, asserted on the LAST page.
    expect(body2.costEstimate.textShareBytes).toBe(25000);
    expect(body2.costEstimate.tokenLow).toBe(6250);
    expect(body2.costEstimate.tokenHigh).toBe(6250);
  });

  it('400s {error: invalid_cursor} on garbage and on a cursor beyond the ledger — never an empty page pretending to be the end', async () => {
    const app = await buildApp();

    const garbage = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/conn-1/map/suggestions?cursor=%21%21not-a-cursor%21%21',
    });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json()).toEqual({ error: 'invalid_cursor' });

    // Minted for a ledger this one is smaller than (a re-mapped run can
    // shrink the rows): out of range, refused by name.
    const stale = await app.inject({
      method: 'GET',
      url: `/api/v1/connectors/conn-1/map/suggestions?cursor=${rowsCursor(4)}`,
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json()).toEqual({ error: 'invalid_cursor' });
  });
});

describe('PUT /api/v1/connectors/:id/map/selection (34-S12c persist the decision)', () => {
  it('persists the decision REBUILT, not patched: one upsert keyed {runId, tenantId} carrying every field and a fresh decidedAt', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-1/map/selection',
      payload: { removedPaths: ['/Docs/b.docx'], readdedPaths: ['/Docs/old/b.docx'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runId).toBe('map-conn-1');
    expect(body.connectionId).toBe('conn-1');
    expect(body.removedPaths).toEqual(['/Docs/b.docx']);
    expect(body.readdedPaths).toEqual(['/Docs/old/b.docx']);
    expect(new Date(body.decidedAt).getTime()).not.toBeNaN();

    expect(updateOneMock).toHaveBeenCalledWith(
      'map_selections',
      { runId: 'map-conn-1', tenantId: 'ACME-01' },
      {
        $set: {
          runId: 'map-conn-1',
          tenantId: 'ACME-01',
          connectionId: 'conn-1',
          removedPaths: ['/Docs/b.docx'],
          readdedPaths: ['/Docs/old/b.docx'],
          decidedAt: expect.any(Date),
        },
      },
      { upsert: true }
    );
    // Rebuilt means REBUILT: the whole decision in one $set — no $addToSet,
    // no $pull, nothing that could merge two decisions into a third nobody
    // made. decidedAt is what the workers sort on and what
    // SelectionChangedMidRun pins against — every re-decision stamps fresh.
    const setArgs = updateOneMock.mock.calls[0][2].$set;
    expect(Object.keys(setArgs).sort()).toEqual([
      'connectionId',
      'decidedAt',
      'readdedPaths',
      'removedPaths',
      'runId',
      'tenantId',
    ]);
  });

  it('accepts the keep-everything decision: {} means no removals, no re-adds', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-1/map/selection',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(updateOneMock.mock.calls[0][2].$set.removedPaths).toEqual([]);
    expect(updateOneMock.mock.calls[0][2].$set.readdedPaths).toEqual([]);
  });

  it('a re-add may target a SUBTRACTED ledger row — that is what re-adding is', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-1/map/selection',
      payload: { removedPaths: [], readdedPaths: ['/Docs/old/b.docx'] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('400s NAMING the path and the field for a removal not in the ledger — and records nothing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-1/map/selection',
      payload: { removedPaths: ['/Docs/typo.docx'], readdedPaths: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'selection_path_unknown',
      field: 'removedPaths',
      path: '/Docs/typo.docx',
    });
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('400s NAMING the path and the field for a re-add not in the ledger', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-1/map/selection',
      payload: { removedPaths: [], readdedPaths: ['/Nowhere/ghost.pdf'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'selection_path_unknown',
      field: 'readdedPaths',
      path: '/Nowhere/ghost.pdf',
    });
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('400s by field name when a paths field is not an array of non-empty strings', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-1/map/selection',
      payload: { removedPaths: 'not-an-array', readdedPaths: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'selection_paths_invalid', field: 'removedPaths' });
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('404s {error: no_suggestions} when there is no ledger to validate against', async () => {
    suggestionsFindOneMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-1/map/selection',
      payload: { removedPaths: [], readdedPaths: [] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no_suggestions' });
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('409s {error: suggestion_rows_truncated} on a write-cap-truncated ledger — a decision against a partial ledger is refused, not recorded', async () => {
    suggestionsFindOneMock.mockResolvedValue({
      ...SUGGESTIONS_DOC,
      rowsTruncated: true,
      rowsOmitted: 5000,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-1/map/selection',
      payload: { removedPaths: [], readdedPaths: [] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'suggestion_rows_truncated' });
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('404s another tenant\'s connection — the lookup itself is tenant-scoped', async () => {
    connectionFindOneMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/connectors/conn-ghost/map/selection',
      payload: { removedPaths: [], readdedPaths: [] },
    });

    expect(res.statusCode).toBe(404);
    expect(connectionFindOneMock).toHaveBeenCalledWith({
      connectionId: 'conn-ghost',
      tenantId: 'ACME-01',
    });
    expect(updateOneMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/connectors/:id/map/selection', () => {
  const SELECTION_DOC = {
    runId: 'map-conn-1',
    tenantId: 'ACME-01',
    connectionId: 'conn-1',
    removedPaths: ['/Docs/b.docx'],
    readdedPaths: [],
    decidedAt: '2026-08-20T02:00:00.000Z',
  };

  it('returns the decision verbatim, tenant-scoped', async () => {
    selectionFindOneMock.mockResolvedValue(SELECTION_DOC);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/selection' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SELECTION_DOC);
    expect(selectionFindOneMock).toHaveBeenCalledWith(
      { runId: 'map-conn-1', tenantId: 'ACME-01' },
      { projection: { _id: 0 } }
    );
  });

  it('404s {error: no_selection} when none exists — another tenant\'s decision reads as none', async () => {
    selectionFindOneMock.mockResolvedValue(null);
    const app = await buildApp('OTHER-TENANT');
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/selection' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no_selection' });
    expect(selectionFindOneMock).toHaveBeenCalledWith(
      { runId: 'map-conn-1', tenantId: 'OTHER-TENANT' },
      { projection: { _id: 0 } }
    );
  });
});

describe('POST /api/v1/connectors/:id/ingest (34-S13c — the second consent, ENFORCED)', () => {
  beforeEach(() => {
    // The happy-path precondition: a decided selection on record. The
    // lookup uses the WORKERS' own filter shape ({tenantId, connectionId}),
    // asserted below.
    selectionFindOneMock.mockResolvedValue({
      runId: 'map-conn-1',
      tenantId: 'ACME-01',
      connectionId: 'conn-1',
      removedPaths: [],
      readdedPaths: [],
      decidedAt: '2026-08-20T02:00:00.000Z',
    });
  });

  it('starts the selective ingest: 202 {status: ingesting} with the pinned workflowId', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/ingest',
      payload: { defaultLabel: 'commercial' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      status: 'ingesting',
      connectionId: 'conn-1',
      workflowId: 'ingest-conn-1',
    });
    // The step-13 label travels IN the start call, not through a connection
    // write that happens after it. The route $sets defaultLabel AFTER this
    // start (so a 503 cannot relabel a connection that ingested nothing),
    // which raced the workflow's own read — a worker picking the run up
    // first saw null and was refused egress, a failure observed live on the
    // source platform's first map.
    expect(startWorkflowMock).toHaveBeenCalledWith('selectiveIngestWorkflow', {
      taskQueue: 'test-ingest-queue',
      workflowId: 'ingest-conn-1',
      args: [{ connectionId: 'conn-1', defaultLabel: 'commercial' }],
    });
    // The consent read and the selection read are both tenant-scoped in the
    // filter itself.
    expect(consentsToArrayMock).toHaveBeenCalledWith(
      { tenantId: 'ACME-01', connectionId: 'conn-1' },
      { projection: { _id: 0 } }
    );
    expect(selectionFindOneMock).toHaveBeenCalledWith({
      tenantId: 'ACME-01',
      connectionId: 'conn-1',
    });
  });

  it('refuses 403 ingest_consent_required BEFORE any write or start when no consent exists (call-order)', async () => {
    consentsToArrayMock.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/ingest',
      payload: { defaultLabel: 'commercial' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'ingest_consent_required' });
    // The refusal is BEFORE the start AND before the label write — a
    // refused request leaves the connection untouched.
    expect(startWorkflowMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('an active map_metadata consent does NOT satisfy ingest_content — the two consents are distinct records (JRN-2)', async () => {
    consentsToArrayMock.mockResolvedValue([{ ...INGEST_GRANT, scope: 'map_metadata' }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/ingest', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'ingest_consent_required' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it('a granted-then-revoked ingest_content consent is NOT active (real activeConsents semantics)', async () => {
    consentsToArrayMock.mockResolvedValue([
      {
        consentId: 'consent-2',
        action: 'revoked',
        revokesConsentId: 'consent-ingest-1',
        scope: 'ingest_content',
      },
      INGEST_GRANT,
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/ingest', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'ingest_consent_required' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it('refuses 409 no_selection when the Decide phase has not happened — never an implicit ingest-everything', async () => {
    selectionFindOneMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/ingest',
      payload: { defaultLabel: 'commercial' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'no_selection' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('caps defaultLabel against the CALLER — an over-reaching value falls to the caller\'s label, tenant-scoped $set', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/ingest',
      // Caller label is 'commercial' (buildApp) — the requested tier is
      // outside the host's ladder, so the LabelPolicy stub caps it.
      payload: { defaultLabel: 'top_secret_tier' },
    });

    expect(res.statusCode).toBe(202);
    expect(updateOneMock).toHaveBeenCalledWith(
      'connector_connections',
      { connectionId: 'conn-1', tenantId: 'ACME-01' },
      { $set: { defaultLabel: 'commercial' } }
    );
  });

  it('a missing defaultLabel lands on the caller\'s label, never a previous value and never a raise', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/ingest', payload: {} });

    expect(res.statusCode).toBe(202);
    expect(updateOneMock).toHaveBeenCalledWith(
      'connector_connections',
      { connectionId: 'conn-1', tenantId: 'ACME-01' },
      { $set: { defaultLabel: 'commercial' } }
    );
  });

  it('403s label_refused — typed — when the LabelPolicy refuses outright, before any start or write', async () => {
    labelResolveMock.mockImplementation((requested: string | undefined) => {
      throw new LabelRefusedError(requested);
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/ingest',
      payload: { defaultLabel: 'forbidden_tier' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'label_refused', requested: 'forbidden_tier' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('treats a duplicate start as success — AlreadyStarted resolves to the pinned id and the route answers 202', async () => {
    // The REAL starter maps WorkflowExecutionAlreadyStartedError to the
    // pinned workflowId — asserted here against the actual error class, not
    // a stub of the mapping.
    startWorkflowMock
      .mockImplementationOnce(async (_type: string, o: { workflowId: string }) => ({
        workflowId: o.workflowId,
      }))
      .mockRejectedValueOnce(
        new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          'ingest-conn-1',
          'selectiveIngestWorkflow'
        )
      );
    const app = await buildApp();

    const first = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/ingest', payload: {} });
    const second = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/ingest', payload: {} });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({
      status: 'ingesting',
      connectionId: 'conn-1',
      workflowId: 'ingest-conn-1',
    });
  });

  it('503s "durable start failed" when the workflow cannot start — fail loud, never a lying 202', async () => {
    startWorkflowMock.mockRejectedValue(new Error('temporal frontend unreachable'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/ingest', payload: {} });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Unable to start ingest workflow — durable start failed' });
    // AND the connection is not relabelled by a request that ingested
    // nothing. The label is a record of a decision about a run that is
    // actually going to happen; writing it before the start meant a 503 left
    // the label changed with no run to justify it, and the next sync would
    // inherit a tier the customer chose for a run that never existed.
    const labelWrites = updateOneMock.mock.calls.filter(
      (c: any[]) => JSON.stringify(c).includes('defaultLabel')
    );
    expect(labelWrites).toHaveLength(0);
  });

  it('403s when connectors are disabled for the tenant (the legacy gate, shape-parity with sync and map)', async () => {
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/ingest', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'connectors_disabled_for_tenant' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('404s another tenant\'s connection — the lookup itself is tenant-scoped', async () => {
    connectionFindOneMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-ghost/ingest', payload: {} });

    expect(res.statusCode).toBe(404);
    expect(connectionFindOneMock).toHaveBeenCalledWith({
      connectionId: 'conn-ghost',
      tenantId: 'ACME-01',
    });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it('POST /:id/sync is UNTOUCHED: no consent, no selection, no decide gates on the legacy path', async () => {
    // The all-or-nothing legacy sync must keep working for tenants that
    // never enter the map flow — no ingest_content consent, no decided
    // selection, and it still answers 202. (Its own suite pins the rest.)
    consentsToArrayMock.mockResolvedValue([]);
    selectionFindOneMock.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/sync', payload: {} });

    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('syncing');
    expect(startWorkflowMock).toHaveBeenCalledWith(
      'connectorSyncWorkflow',
      expect.objectContaining({ workflowId: 'connector-sync-conn-1' })
    );
  });
});
