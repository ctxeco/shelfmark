// SPDX-License-Identifier: Apache-2.0
// The ingest head and the delta plumbing, at the activity level:
//
//   * 34-S14d — oversized and unsupported files are 'skipped' with a NAMED
//     reason and are NEVER downloaded (and the post-download ceiling covers
//     the no-reported-size case);
//   * the sink handoff — DocumentMeta carries the stable documentId, the
//     label, the runId and the provenance; every SinkOutcome maps onto the
//     run vocabulary, 'deferred' included (34-S14e generalized), and a
//     THROWING sink is a named per-file failure, not a crashed batch;
//   * 34-S14c — an expired deltaLink (HTTP 410) falls back to a full
//     re-enumeration, recorded rather than disguised as a first crawl.
//
// The source system's {connectionId, remoteFileId} documents-table dedupe
// (34-S14b) does not exist here — the sink owns terminal storage — so its
// guarantee is pinned as the documentIdFor contract instead: same inputs,
// same id, forever.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// graphClient: the network calls are stubbed, but the 410 DETECTION
// (isDeltaResyncRequired, GraphHttpError) is the real thing under test.
const downloadFileMock = vi.fn(async (): Promise<Buffer> => Buffer.from('file bytes'));
const listDeltaPageMock = vi.fn(async () => ({ items: [], deltaLink: 'delta-1' }) as any);
vi.mock('@shelfmark/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shelfmark/graph')>();
  return {
    ...actual,
    refreshAccessToken: async () => ({
      accessToken: 'at',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      scopes: [],
    }),
    listDeltaPage: (...args: any[]) => listDeltaPageMock(...(args as [])),
    downloadFile: (...args: any[]) => downloadFileMock(...(args as [])),
  };
});

import { GraphHttpError } from '@shelfmark/graph';
import { INGEST_SKIP_REASONS, MAX_INGEST_FILE_BYTES_ENV } from '@shelfmark/policy';
import {
  encryptToken,
  type DocumentMeta,
  type ShelfmarkPorts,
  type SinkOutcome,
} from '@shelfmark/core';
import {
  createConnectionActivities,
  createIngestActivities,
  documentIdFor,
  guessMimetype,
} from '../src/index';
import { fakeStore, type FakeData } from './fakeStore';

const TENANT = 'ACME-01';
const CONN = 'conn-1';
const RUN_ID = 'connector-sync-conn-1';

// A real DEK so the token round-trips through the real tokenCrypto.
process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const data: FakeData = {};

interface SinkCall {
  meta: DocumentMeta;
  bytes: Buffer;
}
const sinkCalls: SinkCall[] = [];
let sinkAnswer: (meta: DocumentMeta) => Promise<SinkOutcome> | SinkOutcome;

const ports: ShelfmarkPorts = {
  resolveAuth: async () => null,
  sink: {
    accept: async (meta, bytes) => {
      sinkCalls.push({ meta, bytes });
      return sinkAnswer(meta);
    },
  },
};

const deps = { store: fakeStore(data), ports };
const ingest = createIngestActivities(deps);
const connection = createConnectionActivities(deps);

function seedConnection(extra: Record<string, unknown> = {}) {
  data.connector_connections = [
    {
      connectionId: CONN,
      tenantId: TENANT,
      provider: 'onedrive',
      driveId: 'drive-1',
      rootFolderId: null,
      defaultLabel: 'general',
      deltaLink: null,
      encRefreshToken: encryptToken('refresh-token'),
      ...extra,
    },
  ];
}

/** `size: null` OMITS the field entirely — "the provider reported no size",
 *  which is a different fact from a size of zero and takes a different path. */
const file = (itemId: string, name = 'a.pdf', size: number | null = 100) => ({
  itemId,
  name,
  remotePath: '/Docs',
  ...(size === null ? {} : { size }),
});

beforeEach(() => {
  for (const key of Object.keys(data)) delete data[key];
  seedConnection();
  delete process.env[MAX_INGEST_FILE_BYTES_ENV];
  sinkCalls.length = 0;
  sinkAnswer = () => ({ status: 'ingested' });
  downloadFileMock.mockClear().mockImplementation(async () => Buffer.from('file bytes'));
  listDeltaPageMock.mockReset(); // reset, NOT clear: mockClear leaves queued
  // mockResolvedValueOnce/mockRejectedValueOnce implementations in place, so
  // an unconsumed once-value leaks into the next test in file order —
  // observed live when a mutation left one queued and a later negative-case
  // test failed for a reason that had nothing to do with it.
});

// ══ The stable-id contract (34-S14b restated as a port obligation) ══════════

describe('documentIdFor — the dedupe key the sink contract stands on', () => {
  it('is a pure function of (connectionId, remoteFileId): a re-crawl produces the SAME id', () => {
    const first = documentIdFor(CONN, 'item-1');
    expect(documentIdFor(CONN, 'item-1')).toBe(first);
    expect(first).toMatch(/^doc-[0-9a-f]{32}$/);
  });

  it('carries neither the raw item id nor the connection id into the id itself', () => {
    expect(documentIdFor(CONN, 'item-1')).not.toContain('item-1');
    expect(documentIdFor(CONN, 'item-1')).not.toContain(CONN);
  });

  it('distinguishes connections and files — no cross-connection collision by construction', () => {
    expect(documentIdFor(CONN, 'item-1')).not.toBe(documentIdFor(CONN, 'item-2'));
    expect(documentIdFor(CONN, 'item-1')).not.toBe(documentIdFor('conn-2', 'item-1'));
  });
});

// ══ The sink handoff ════════════════════════════════════════════════════════

describe('ingestFileBatch — bytes cross accept() with the full meta contract', () => {
  it('hands the sink the bytes and a DocumentMeta with stable id, provenance, label and runId', async () => {
    const outcomes = await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [
      file('f1', 'report.pdf', 100),
    ]);

    expect(outcomes).toEqual([{ itemId: 'f1', status: 'ingested' }]);
    expect(sinkCalls).toHaveLength(1);
    const { meta, bytes } = sinkCalls[0]!;
    expect(bytes.toString()).toBe('file bytes');
    expect(meta).toEqual({
      documentId: documentIdFor(CONN, 'f1'),
      tenantId: TENANT,
      connectionId: CONN,
      runId: RUN_ID,
      filename: 'report.pdf',
      mimetype: 'application/pdf',
      size: bytes.length,
      remotePath: '/Docs',
      remoteFileId: 'f1',
      label: 'general',
      isRetry: false,
    });
  });

  it('a host retry pass sets isRetry, and the sink sees it with the SAME documentId', async () => {
    await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [
      { ...file('f1'), isRetry: true },
    ]);
    expect(sinkCalls[0]!.meta.isRetry).toBe(true);
    expect(sinkCalls[0]!.meta.documentId).toBe(documentIdFor(CONN, 'f1'));
  });

  it("maps a sink 'deferred' onto the run vocabulary — NOT a failure (34-S14e generalized)", async () => {
    // Deferred is the sink saying "not now" (quota, budget, backpressure).
    // Folding it into `failed` is the source-divergent story the four-state
    // vocabulary exists to prevent: same file, two entry paths, two
    // contradictory statuses.
    sinkAnswer = () => ({ status: 'deferred', reason: 'ingest allowance exhausted; resume later' });
    const [outcome] = await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [file('f1')]);
    expect(outcome!.status).toBe('deferred');
    expect(outcome!.status).not.toBe('failed');
    expect(outcome!.error).toContain('allowance exhausted');
  });

  it("carries a sink 'skipped' with its own reason token (e.g. the sink's already_ingested dedupe)", async () => {
    sinkAnswer = (meta) => ({
      status: 'skipped',
      skipReason: INGEST_SKIP_REASONS.ALREADY_INGESTED,
      error: `already_ingested: document ${meta.documentId} already holds this remote file`,
    });
    const [outcome] = await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [file('f1')]);
    expect(outcome!.status).toBe('skipped');
    expect(outcome!.skipReason).toBe(INGEST_SKIP_REASONS.ALREADY_INGESTED);
  });

  it('a THROWING sink is a NAMED per-file failure, and the rest of the batch still lands', async () => {
    sinkAnswer = (meta) => {
      if (meta.remoteFileId === 'f-broken') throw new Error('sink store unreachable');
      return { status: 'ingested' };
    };
    const outcomes = await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [
      file('f-ok'),
      file('f-broken'),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['ingested', 'failed']);
    expect(outcomes[1]!.error).toContain('sink store unreachable');
  });

  it('a failed download is a per-file failure too — one dead remote file cannot crash the batch', async () => {
    downloadFileMock.mockRejectedValueOnce(
      new GraphHttpError('Failed to download file f-gone (HTTP 404)', { status: 404 })
    );
    const outcomes = await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [
      file('f-gone'),
      file('f-ok'),
    ]);
    expect(outcomes[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('404') });
    expect(outcomes[1]!.status).toBe('ingested');
  });
});

// ══ 34-S14d — THE UNREACHABLE STATUS ════════════════════════════════════════

describe('size and type pre-filters (34-S14d)', () => {
  it('an oversized file is SKIPPED with its reason and is never opened', async () => {
    process.env[MAX_INGEST_FILE_BYTES_ENV] = '1000';

    const [outcome] = await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [
      file('f-big', 'huge.pdf', 3_221_225_472),
    ]);

    expect(outcome!.status).toBe('skipped');
    expect(outcome!.skipReason).toBe(INGEST_SKIP_REASONS.TOO_LARGE);
    expect(outcome!.error).toContain('3221225472');
    expect(outcome!.error).toContain('1000');
    // The whole point: 'failed' would be a lie because the file was never
    // opened — and a 3 GB in-memory download is what this stops.
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(sinkCalls).toHaveLength(0);
  });

  it('an unsupported type is SKIPPED with its reason and is never opened', async () => {
    const [outcome] = await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [
      file('f-mov', 'holiday.mov', 40),
    ]);

    expect(outcome!.status).toBe('skipped');
    expect(outcome!.skipReason).toBe(INGEST_SKIP_REASONS.UNSUPPORTED_TYPE);
    expect(outcome!.error).toContain('.mov');
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(sinkCalls).toHaveLength(0);
  });

  it('with no reported size, the ceiling still bites — after the fetch, before the sink', async () => {
    process.env[MAX_INGEST_FILE_BYTES_ENV] = '5';
    downloadFileMock.mockResolvedValueOnce(Buffer.from('more than five bytes'));

    const [outcome] = await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [
      file('f-unsized', 'mystery.pdf', null),
    ]);

    expect(outcome!.status).toBe('skipped');
    expect(outcome!.skipReason).toBe(INGEST_SKIP_REASONS.TOO_LARGE);
    expect(outcome!.error).toContain('after the fetch');
    // Downloaded once, then dropped: the sink never sees it.
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(sinkCalls).toHaveLength(0);
  });
});

// ══ 34-S14c — THE EXPIRED DELTA TOKEN ═══════════════════════════════════════

describe('deltaLink expiry (34-S14c)', () => {
  function gone() {
    return new GraphHttpError('Failed to list delta page: Request failed (HTTP 410)', {
      status: 410,
      retryAfterSeconds: null,
    });
  }

  it('falls back to a FULL re-enumeration on 410, and records that it did', async () => {
    listDeltaPageMock
      .mockRejectedValueOnce(gone())
      .mockResolvedValueOnce({ items: [{ id: 'f1' }], deltaLink: 'delta-fresh' } as any);

    const page = await connection.listRemoteDeltaPage(CONN, 'https://graph.microsoft.com/expired-token');

    expect(page.deltaExpired).toBe(true);
    expect(page.deltaLink).toBe('delta-fresh');
    // The retry is a delta call with NO token — Graph's full-tree walk.
    expect(listDeltaPageMock.mock.calls[1]![3]).toBeUndefined();
    // …and the reason for the re-crawl is on the connection document, so it
    // never looks like an ordinary first crawl.
    const conn = data.connector_connections![0];
    expect(conn.lastDeltaExpiry.action).toBe('full_reenumeration');
    expect(conn.lastDeltaExpiry.detail).toContain('410');
    expect(conn.deltaExpiryCount).toBe(1);
  });

  it('does NOT swallow a 410 that arrives with no token — there was nothing to expire', async () => {
    listDeltaPageMock.mockRejectedValueOnce(gone());
    await expect(connection.listRemoteDeltaPage(CONN)).rejects.toThrow(/410/);
    expect(listDeltaPageMock).toHaveBeenCalledTimes(1);
    expect(data.connector_connections![0].lastDeltaExpiry).toBeUndefined();
  });

  it('does NOT treat an ordinary failure as expiry — a 503 still retries as itself', async () => {
    listDeltaPageMock.mockRejectedValueOnce(
      new GraphHttpError('Failed to list delta page: Service Unavailable (HTTP 503)', {
        status: 503,
        retryAfterSeconds: 30,
      })
    );
    await expect(
      connection.listRemoteDeltaPage(CONN, 'https://graph.microsoft.com/token')
    ).rejects.toThrow(/503/);
    expect(listDeltaPageMock).toHaveBeenCalledTimes(1);
    expect(data.connector_connections![0].deltaExpiryCount).toBeUndefined();
  });

  it('the re-enumeration hands the sink the SAME documentId — the fallback and the id contract compose', async () => {
    // Stated in the source's plan and pinned here in port form: a
    // re-enumeration against a non-deduping key IS the duplicate-corpus
    // event, which is why the fallback and the stable id landed together.
    await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [file('f1')]);
    listDeltaPageMock
      .mockRejectedValueOnce(gone())
      .mockResolvedValueOnce({ items: [{ id: 'f1' }], deltaLink: 'delta-fresh' } as any);
    await connection.listRemoteDeltaPage(CONN, 'https://graph.microsoft.com/expired-token');

    await ingest.ingestFileBatch(CONN, TENANT, 'general', RUN_ID, [file('f1')]);

    expect(sinkCalls).toHaveLength(2);
    expect(sinkCalls[1]!.meta.documentId).toBe(sinkCalls[0]!.meta.documentId);
  });
});

// ── Misc ────────────────────────────────────────────────────────────────────

describe('guessMimetype', () => {
  it('maps known document extensions and falls back to octet-stream', () => {
    expect(guessMimetype('a.pdf')).toBe('application/pdf');
    expect(guessMimetype('a.md')).toBe('text/markdown');
    expect(guessMimetype('weird.zzz')).toBe('application/octet-stream');
  });
});
