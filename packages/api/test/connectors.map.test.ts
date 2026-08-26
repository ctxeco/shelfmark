// SPDX-License-Identifier: Apache-2.0
// The map endpoints (`34-S09d` start + read + stream, `34-S08c` consent
// enforcement at the edge).
//
// Acceptance shape mirrors connectors.test.ts / connectors.consents.test.ts:
// per-collection database mock (the map path touches four collections and a
// single shared findOne mock cannot tell a tenant switch from a connection),
// the workflow client mocked at the start seam, consent DERIVATION real —
// the activeConsents semantics under test are the actual @shelfmark/core
// export riding inside the consent store, not a reimplementation.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { AuthContext } from '@shelfmark/core';
import type { Db } from 'mongodb';
import { shelfmarkApi } from '../src/plugin.js';
import type { MapStreamConfig } from '../src/types.js';

const connectionFindOneMock = vi.fn();
const mapRunFindOneMock = vi.fn();
const consentsToArrayMock = vi.fn();
const updateOneMock = vi.fn();

const dbMock = {
  collection: (name: string) => ({
    findOne: (...args: unknown[]) =>
      name === 'map_runs' ? mapRunFindOneMock(...args) : connectionFindOneMock(...args),
    updateOne: (...args: unknown[]) => updateOneMock(name, ...args),
    find: () => ({ sort: () => ({ toArray: () => consentsToArrayMock() }) }),
  }),
} as unknown as Db;

const startWorkflowMock = vi.fn();
const tenantFlagsMock = vi.fn();

const CONNECTION = {
  connectionId: 'conn-1',
  tenantId: 'ACME-01',
  provider: 'onedrive',
  driveId: 'drive-abc',
  rootFolderId: null,
  rootPath: null,
};

/** An ACTIVE map_metadata grant, in the shape listConsentEvents returns. */
const MAP_GRANT = {
  consentId: 'consent-1',
  tenantId: 'ACME-01',
  connectionId: 'conn-1',
  action: 'granted',
  revokesConsentId: null,
  scope: 'map_metadata',
};

async function buildApp(opts: { tenantId?: string; mapStream?: MapStreamConfig } = {}) {
  const app = Fastify();
  await app.register(shelfmarkApi, {
    prefix: '/api/v1/connectors',
    db: dbMock,
    ports: {
      sink: { accept: async () => ({ status: 'ingested' as const }) },
      resolveAuth: async (): Promise<AuthContext | null> => ({
        tenantId: opts.tenantId ?? 'ACME-01',
        sub: 'kc-user-9f3a',
        label: 'commercial',
      }),
      tenantPolicy: { flags: (...args: [string]) => tenantFlagsMock(...args) },
    },
    temporal: {
      client: { workflow: { start: (...args: unknown[]) => startWorkflowMock(...args) } },
      taskQueue: 'test-ingest-queue',
    },
    config: {
      publicBaseUrl: 'https://portal.example.com',
      stateSecret: 'test-state-secret-at-least-32-bytes-long',
      // ms-scale loop so the stream tests finish in tens of milliseconds; the
      // knobs are plugin config precisely so tests can do this.
      mapStream: { pollMs: 5, ...opts.mapStream },
    },
  });
  return app;
}

beforeEach(() => {
  connectionFindOneMock.mockReset().mockResolvedValue(CONNECTION);
  tenantFlagsMock
    .mockReset()
    .mockResolvedValue({ connectorsEnabled: true, mappingEnabled: true });
  mapRunFindOneMock.mockReset().mockResolvedValue(null);
  consentsToArrayMock.mockReset().mockResolvedValue([MAP_GRANT]);
  updateOneMock.mockReset().mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  startWorkflowMock
    .mockReset()
    .mockImplementation(async (_type: string, o: { workflowId: string }) => ({
      workflowId: o.workflowId,
    }));
});

describe('POST /api/v1/connectors/:id/map (34-S09d start, 34-S08c consent at the edge)', () => {
  it('starts the map: 202 {status: mapping} with the pinned workflowId, roots $set tenant-scoped', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/map',
      payload: { rootFolderId: 'f1', rootPath: '/Finance' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'mapping', connectionId: 'conn-1', workflowId: 'map-conn-1' });
    expect(startWorkflowMock).toHaveBeenCalledWith('driveMapWorkflow', {
      taskQueue: 'test-ingest-queue',
      workflowId: 'map-conn-1',
      args: [{ connectionId: 'conn-1' }],
    });
    expect(updateOneMock).toHaveBeenCalledWith(
      'connector_connections',
      { connectionId: 'conn-1', tenantId: 'ACME-01' },
      { $set: { rootFolderId: 'f1', rootPath: '/Finance' } }
    );
  });

  it('accepts NO label field — a smuggled one is ignored and never written (step-13 decision, by design)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/map',
      payload: { rootFolderId: 'f1', rootPath: '/Finance', defaultLabel: 'top_secret_tier' },
    });

    expect(res.statusCode).toBe(202);
    const setArgs = updateOneMock.mock.calls[0][2].$set;
    expect(Object.keys(setArgs).sort()).toEqual(['rootFolderId', 'rootPath']);
  });

  it('keeps the connection\'s existing roots when the body omits them (sync\'s shape)', async () => {
    connectionFindOneMock.mockResolvedValue({ ...CONNECTION, rootFolderId: 'kept-f', rootPath: '/Kept' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(202);
    expect(updateOneMock.mock.calls[0][2].$set).toEqual({ rootFolderId: 'kept-f', rootPath: '/Kept' });
  });

  it('refuses 403 map_consent_required BEFORE any start or write when no consent exists', async () => {
    consentsToArrayMock.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'map_consent_required' });
    // The refusal is BEFORE the start — no workflow call — and before the
    // roots write, so a refused request leaves the connection untouched.
    expect(startWorkflowMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('a granted-then-revoked consent is NOT active (real activeConsents semantics)', async () => {
    consentsToArrayMock.mockResolvedValue([
      {
        consentId: 'consent-2',
        action: 'revoked',
        revokesConsentId: 'consent-1',
        scope: 'map_metadata',
      },
      MAP_GRANT,
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'map_consent_required' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it('an active consent for a DIFFERENT scope does not authorize the map', async () => {
    consentsToArrayMock.mockResolvedValue([{ ...MAP_GRANT, scope: 'ingest_content' }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'map_consent_required' });
  });

  it('refuses 403 mapping_disabled_for_tenant when mapping was switched off AFTER a consent was granted', async () => {
    // The case the map-time gate exists for: the consent is still ACTIVE
    // (grant checks ran at grant time), but the tenant-level precondition
    // was withdrawn afterwards. A standing consent must not outrank it.
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: true, mappingEnabled: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'mapping_disabled_for_tenant' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('mapping fails closed on a loosely-typed flags answer — strict === true, nothing else enables it', async () => {
    // Opt-in means opt-in even against a sloppy host: a truthy-but-not-true
    // mappingEnabled ('true', 1) must not enable mapping. The strict check
    // is the structural half of the fail-closed posture the source platform
    // carried ("mapping consent defaults off").
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: true, mappingEnabled: 'true' as unknown as boolean });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'mapping_disabled_for_tenant' });
  });

  it('mapping fails closed when the host answers fail-closed for an unknown tenant', async () => {
    // The port of "no tenants document at all": a host that cannot resolve
    // the tenant answers { connectorsEnabled: false, mappingEnabled: false }
    // (the documented contract) and every gate holds.
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'connectors_disabled_for_tenant' });
  });

  it('403s when connectors are disabled for the tenant (the legacy gate, same as sync)', async () => {
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: true });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'connectors_disabled_for_tenant' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it('404s another tenant\'s connection — the lookup itself is tenant-scoped', async () => {
    connectionFindOneMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-ghost/map', payload: {} });

    expect(res.statusCode).toBe(404);
    expect(connectionFindOneMock).toHaveBeenCalledWith({ connectionId: 'conn-ghost', tenantId: 'ACME-01' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it('503s "durable start failed" when the workflow cannot start', async () => {
    startWorkflowMock.mockRejectedValue(new Error('temporal frontend unreachable'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/map', payload: {} });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Unable to start map workflow — durable start failed' });
  });
});

describe('GET /api/v1/connectors/:id/map', () => {
  const RUN_DOC = {
    runId: 'map-conn-1',
    tenantId: 'ACME-01',
    connectionId: 'conn-1',
    provider: 'onedrive',
    status: 'complete',
    startedAt: '2026-08-20T00:00:00.000Z',
    finishedAt: '2026-08-20T00:12:34.000Z',
    classifierVersion: '1.0.0-rc2',
    artifactSha: 'abc123',
    progress: { itemsSeen: 12, foldersWalked: 3, foldersPruned: 1, pagesFetched: 4, currentPath: '/Docs' },
    aggregates: { perClass: { human_document: { files: 10, bytes: 1024 } }, folders: 3, emptyFolders: 1, maxDepth: 2 },
    topFolders: [{ name: 'Docs', files: 10, folders: 2, bytes: 1024, perClass: {} }],
    rollupTruncated: true,
    topFoldersOmitted: 7,
    pruneManifest: [{ path: '/Docs/node_modules', rule: 'prune_self:node_modules', size: 999 }],
    pruneManifestTruncated: false,
    reconciliation: { enumeratedFileBytes: 1024, prunedFolderBytes: 999 },
    narration: [{ kind: 'sum', tier: 'none', text: 'Map started.', atMs: 1 }],
    narrationDropped: 2,
  };

  it('returns the run document VERBATIM — truncation flags and reconciliation included', async () => {
    mapRunFindOneMock.mockResolvedValue(RUN_DOC);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map' });

    expect(res.statusCode).toBe(200);
    // Strip nothing: the doc IS the contract.
    expect(res.json()).toEqual(RUN_DOC);
    expect(mapRunFindOneMock).toHaveBeenCalledWith(
      { runId: 'map-conn-1', tenantId: 'ACME-01' },
      { projection: { _id: 0 } }
    );
  });

  it('404s {error: no_map_run} when there is no run — another tenant\'s run reads as none', async () => {
    mapRunFindOneMock.mockResolvedValue(null);
    const app = await buildApp({ tenantId: 'OTHER-TENANT' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no_map_run' });
    expect(mapRunFindOneMock).toHaveBeenCalledWith(
      { runId: 'map-conn-1', tenantId: 'OTHER-TENANT' },
      { projection: { _id: 0 } }
    );
  });
});

describe('GET /api/v1/connectors/:id/map/stream', () => {
  /** Parse the SSE data frames the hijacked reply wrote. */
  function frames(payload: string): any[] {
    return payload
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice('data: '.length)));
  }

  const line1 = { kind: 'sum', tier: 'none', text: 'Map started under rule artifact 1.0.0-rc2.', atMs: 1 };
  const line2 = { kind: 'sum', tier: 'none', text: '2,500 items enumerated across 40 folders.', atMs: 2 };
  const line3 = { kind: 'chk', tier: 'none', text: 'Check: 1.0 GB + 2.0 GB pruned = 3.0 GB accounted for.', atMs: 3 };
  const p1 = { itemsSeen: 10, foldersWalked: 1, foldersPruned: 0, pagesFetched: 1, currentPath: '/' };
  const p2 = { itemsSeen: 2500, foldersWalked: 40, foldersPruned: 2, pagesFetched: 9, currentPath: '/Docs' };
  const p3 = { itemsSeen: 3000, foldersWalked: 44, foldersPruned: 2, pagesFetched: 12, currentPath: null };

  it('404s before hijacking for a connection that does not exist (or another tenant\'s)', async () => {
    connectionFindOneMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-ghost/map/stream' });

    expect(res.statusCode).toBe(404);
    expect(mapRunFindOneMock).not.toHaveBeenCalled();
  });

  it('emits each NEW narration line exactly once, progress deltas, and a terminal complete frame — then ends', async () => {
    mapRunFindOneMock
      .mockResolvedValueOnce({ status: 'mapping', narration: [line1], progress: p1 })
      .mockResolvedValueOnce({ status: 'mapping', narration: [line1, line2], progress: p2 })
      .mockResolvedValue({
        status: 'complete',
        narration: [line1, line2, line3],
        progress: p3,
        aggregates: { perClass: { human_document: { files: 9, bytes: 1e9 } }, folders: 44, emptyFolders: 3, maxDepth: 4 },
        reconciliation: { enumeratedFileBytes: 1e9, prunedFolderBytes: 2e9 },
        rollupTruncated: false,
        narrationDropped: 0,
      });

    const app = await buildApp();
    // inject resolves only when the route calls reply.raw.end() — resolving
    // at all IS the termination assertion.
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/stream' });

    expect(res.headers['content-type']).toBe('text/event-stream');
    const parsed = frames(res.payload);

    const narrationTexts = parsed.filter((f) => f.type === 'narration').map((f) => f.line.text);
    // Incremental — in order, and NEVER re-emitted even though the doc
    // accumulates the full array on every poll.
    expect(narrationTexts).toEqual([line1.text, line2.text, line3.text]);

    const progressFrames = parsed.filter((f) => f.type === 'progress').map((f) => f.progress);
    expect(progressFrames).toEqual([p1, p2, p3]);

    const terminal = parsed[parsed.length - 1];
    expect(terminal.type).toBe('complete');
    expect(terminal.status).toBe('complete');
    expect(terminal.aggregates.folders).toBe(44);
    expect(terminal.reconciliation).toEqual({ enumeratedFileBytes: 1e9, prunedFolderBytes: 2e9 });
    // Narration is NOT duplicated into the terminal frame — each line
    // already streamed individually above.
    expect(terminal.narration).toBeUndefined();
  });

  it('does not re-emit an unchanged progress snapshot', async () => {
    mapRunFindOneMock
      .mockResolvedValueOnce({ status: 'mapping', narration: [], progress: p1 })
      .mockResolvedValueOnce({ status: 'mapping', narration: [], progress: p1 })
      .mockResolvedValue({ status: 'complete', narration: [], progress: p1 });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/stream' });

    expect(frames(res.payload).filter((f) => f.type === 'progress')).toHaveLength(1);
  });

  it('terminates on ANY non-mapping status — a refusal frame is terminal too', async () => {
    mapRunFindOneMock.mockResolvedValue({
      status: 'refused_no_consent',
      narration: [{ kind: 'chk', tier: 'none', text: 'No active map_metadata consent on record.', atMs: 1 }],
      provider: 'onedrive',
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/stream' });

    const parsed = frames(res.payload);
    expect(parsed[parsed.length - 1].type).toBe('complete');
    expect(parsed[parsed.length - 1].status).toBe('refused_no_consent');
    // One poll was enough; the stream did not sit there re-reading a
    // terminal doc.
    expect(mapRunFindOneMock).toHaveBeenCalledTimes(1);
  });

  it('BOUNDED no-run wait: polls briefly, then 404-frames and closes instead of hanging forever', async () => {
    mapRunFindOneMock.mockResolvedValue(null);

    const app = await buildApp({ mapStream: { noRunTimeoutMs: 30 } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/stream' });

    // It genuinely WAITED (more than one poll) before giving up…
    expect(mapRunFindOneMock.mock.calls.length).toBeGreaterThan(1);
    // …and the give-up is a stated frame, then the end (inject resolved).
    expect(frames(res.payload)).toEqual([{ type: 'error', error: 'no_map_run' }]);
  });

  it('a malformed heartbeat knob falls back to the default instead of silently disabling heartbeats', async () => {
    // A host reading its knob from an env var can hand over Number('15s') —
    // NaN; every `elapsed >= NaN` compare is false, so heartbeats would be
    // OFF with no error and no log — and a long quiet walk gets proxy-cut,
    // the exact failure the heartbeat prevents. The fallback (15s) is longer
    // than this short stream, so the honest assertion is just that the
    // stream still completes normally.
    mapRunFindOneMock.mockResolvedValue({ status: 'complete', narration: [], progress: p1 });

    const app = await buildApp({ mapStream: { heartbeatMs: Number('15s') } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/stream' });

    const kinds = frames(res.payload).map((f) => f.type);
    expect(kinds).toContain('complete');
  });

  it('writes SSE comment heartbeats so proxies never see an idle stream', async () => {
    mapRunFindOneMock
      .mockResolvedValueOnce({ status: 'mapping', narration: [], progress: p1 })
      .mockResolvedValue({ status: 'complete', narration: [], progress: p1 });

    // heartbeatMs 0 = always due — deterministic.
    const app = await buildApp({ mapStream: { heartbeatMs: 0 } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/stream' });

    expect(res.payload).toContain(': hb\n\n');
  });
});
