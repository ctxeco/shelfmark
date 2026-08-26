// SPDX-License-Identifier: Apache-2.0
// Connection lifecycle + browse + legacy sync — ported with the suite shape
// of the source platform's route tests: Fastify inject end-to-end, the
// database mocked at the collection seam, the Graph client mocked at the
// module seam, auth supplied by a resolveAuth stub (the port of the verified
// session token).
//
// Google-provider suites are NOT ported: only Microsoft ships in this
// package. The provider seam is the per-provider route split itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { randomBytes } from 'crypto';
import { LabelRefusedError, type AuthContext, type TenantFlags } from '@shelfmark/core';
import type { Db } from 'mongodb';

const findOneMock = vi.fn();
const findToArrayMock = vi.fn();
const insertOneMock = vi.fn();
const updateOneMock = vi.fn();

const dbMock = {
  collection: () => ({
    findOne: (...args: unknown[]) => findOneMock(...args),
    find: () => ({ sort: () => ({ toArray: (...args: unknown[]) => findToArrayMock(...args) }) }),
    insertOne: (...args: unknown[]) => insertOneMock(...args),
    updateOne: (...args: unknown[]) => updateOneMock(...args),
  }),
} as unknown as Db;

const decryptTokenMock = vi.fn().mockReturnValue('decrypted-refresh-token');
vi.mock('@shelfmark/core', async () => {
  const actual = await vi.importActual<typeof import('@shelfmark/core')>('@shelfmark/core');
  return {
    ...actual,
    decryptToken: (...args: unknown[]) => decryptTokenMock(...args),
  };
});

const buildAuthorizeUrlMock = vi.fn();
const exchangeCodeForTokensMock = vi.fn();
const refreshAccessTokenMock = vi.fn();
const getMyDriveMock = vi.fn();
const getSharePointDriveMock = vi.fn();
const listAllChildrenMock = vi.fn();
vi.mock('@shelfmark/graph', async () => {
  const actual = await vi.importActual<typeof import('@shelfmark/graph')>('@shelfmark/graph');
  return {
    ...actual,
    buildAuthorizeUrl: (...args: unknown[]) => buildAuthorizeUrlMock(...args),
    exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokensMock(...args),
    refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
    getMyDrive: (...args: unknown[]) => getMyDriveMock(...args),
    getSharePointDrive: (...args: unknown[]) => getSharePointDriveMock(...args),
    listAllChildren: (...args: unknown[]) => listAllChildrenMock(...args),
  };
});

import { shelfmarkApi } from '../src/plugin.js';
import { __testing as tokenCacheTesting } from '../src/tokenCache.js';

const STATE_SECRET = 'test-state-secret-at-least-32-bytes-long';
const startWorkflowMock = vi.fn();
const tenantFlagsMock = vi.fn();
const labelResolveMock = vi.fn();

/** The label ladder the host stub honours: a requested label it does not
 *  recognise falls to the caller's own — a cap, never a raise. */
const KNOWN_LABELS = ['default', 'commercial'];

interface AppOptions {
  sub?: string;
  upn?: string;
  tenantId?: string;
  /** Omit the tenantPolicy port entirely (exercises the shipped default). */
  noTenantPolicy?: boolean;
}

async function buildApp(opts: AppOptions = {}) {
  const app = Fastify();
  await app.register(shelfmarkApi, {
    prefix: '/api/v1/connectors',
    db: dbMock,
    ports: {
      sink: { accept: async () => ({ status: 'ingested' as const }) },
      resolveAuth: async (): Promise<AuthContext | null> => ({
        tenantId: opts.tenantId ?? 'ACME-01',
        // Empty string = the host could not identify a subject — the port of
        // the source platform's "token without a sub" case, which used to
        // silently record the tenant slug as the actor.
        sub: opts.sub ?? '',
        ...(opts.upn ? { upn: opts.upn } : {}),
        label: 'commercial',
      }),
      ...(opts.noTenantPolicy
        ? {}
        : { tenantPolicy: { flags: (...args: [string]) => tenantFlagsMock(...args) } }),
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
    config: { publicBaseUrl: 'https://portal.example.com', stateSecret: STATE_SECRET },
  });
  return app;
}

beforeEach(() => {
  // The browse path caches access tokens per connection (34-S07e), and a
  // cache that survived between tests would make the second test in a file
  // silently skip the refresh the first one primed.
  tokenCacheTesting.reset();
  process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  findOneMock.mockReset().mockResolvedValue({ tenantId: 'ACME-01' });
  findToArrayMock.mockReset().mockResolvedValue([]);
  insertOneMock.mockReset().mockResolvedValue({ acknowledged: true });
  updateOneMock.mockReset().mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  startWorkflowMock
    .mockReset()
    .mockImplementation(async (_type: string, opts: { workflowId: string }) => ({
      workflowId: opts.workflowId,
    }));
  tenantFlagsMock
    .mockReset()
    .mockResolvedValue({ connectorsEnabled: true, mappingEnabled: true } satisfies TenantFlags);
  labelResolveMock
    .mockReset()
    .mockImplementation((requested: string | undefined, ctx: AuthContext) =>
      requested && KNOWN_LABELS.includes(requested) ? requested : (ctx.label ?? 'default')
    );
  decryptTokenMock.mockReset().mockReturnValue('decrypted-refresh-token');
  buildAuthorizeUrlMock
    .mockReset()
    .mockReturnValue('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?mock=1');
  exchangeCodeForTokensMock.mockReset();
  refreshAccessTokenMock.mockReset();
  getMyDriveMock.mockReset();
  getSharePointDriveMock.mockReset();
  listAllChildrenMock.mockReset();
});

afterEach(() => {
  delete process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY;
});

describe('POST /api/v1/connectors/microsoft/authorize', () => {
  it('returns an authorize URL for an enabled tenant', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/microsoft/authorize' });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizeUrl).toContain('login.microsoftonline.com');
    expect(buildAuthorizeUrlMock).toHaveBeenCalledTimes(1);
    // The redirect URI is built from config.publicBaseUrl + the mounted
    // prefix — the fail-fast reason publicBaseUrl has no default.
    expect(buildAuthorizeUrlMock.mock.calls[0][2]).toBe(
      'https://portal.example.com/api/v1/connectors/microsoft/callback'
    );
  });

  it('403s when connectors are disabled for the tenant', async () => {
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/microsoft/authorize' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'connectors_disabled_for_tenant' });
    expect(buildAuthorizeUrlMock).not.toHaveBeenCalled();
  });

  it('DEFAULT-ON POSTURE, pinned at the port seam: no tenantPolicy port means enabled', async () => {
    // History (see the posture block in routes/connections.ts): the source
    // platform's legacy connector paths were a RECORDED fail-open —
    // missing tenant record meant enabled, kept deliberately because live
    // tenants ran on it. The port moves that decision into the host's
    // TenantPolicy; the shipped DEFAULT (no port supplied) answers
    // everything-enabled, and changing that is an act, not an accident.
    const app = await buildApp({ noTenantPolicy: true });
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/microsoft/authorize' });
    expect(res.statusCode).toBe(200);
  });

  it('503s connector_not_configured when the Graph client has no credentials', async () => {
    const { GraphConnectorError } = await vi.importActual<typeof import('@shelfmark/graph')>(
      '@shelfmark/graph'
    );
    buildAuthorizeUrlMock.mockImplementation(() => {
      throw new GraphConnectorError('Microsoft connector not configured');
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/microsoft/authorize' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'connector_not_configured' });
  });
});

describe('GET /api/v1/connectors/microsoft/callback', () => {
  async function getRealAuthorizeState(): Promise<string> {
    // Drive a real state JWT rather than hand-constructing one, so the test
    // exercises the actual sign/verify round trip.
    const { SignJWT } = await import('jose');
    return new SignJWT({ tenantId: 'ACME-01', target: 'onedrive', codeVerifier: 'verifier-value' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(STATE_SECRET));
  }

  it('exchanges the code, encrypts the refresh token, and creates a connection', async () => {
    exchangeCodeForTokensMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    const app = await buildApp();
    const state = await getRealAuthorizeState();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/connectors/microsoft/callback?code=abc123&state=${state}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('connected=onedrive');
    expect(insertOneMock).toHaveBeenCalledTimes(1);
    const inserted = insertOneMock.mock.calls[0][0];
    expect(inserted.tenantId).toBe('ACME-01');
    expect(inserted.provider).toBe('onedrive');
    expect(inserted.encRefreshToken.ciphertext).toBeDefined();
    expect(inserted.encRefreshToken.ciphertext).not.toContain('rt');
  });

  it('400s for a tampered/expired state', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/microsoft/callback?code=abc123&state=garbage',
    });
    expect(res.statusCode).toBe(400);
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('redirects with the upstream error when the provider reports one', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/microsoft/callback?error=access_denied',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=access_denied');
  });
});

describe('connector attribution — createdBy is a human, or nothing', () => {
  // Consent-attribution prerequisite (Plan key 25-*, Phase C). Before this,
  // the callback wrote `createdBy: tenantId` — the tenant SLUG in an actor
  // field, which looks like an attribution and identifies nobody. The cause
  // was upstream: the OAuth state JWT carried only {tenantId, target,
  // codeVerifier}, so the acting user's identity was destroyed across the
  // round trip and the callback (anonymous, no session) had nothing else to
  // record.
  //
  // These tests deliberately take the state JWT from the mock's call args
  // rather than hand-building one. A hand-built state carrying actingSub
  // would still pass if the authorize route stopped emitting it — the check
  // would be unable to fail, which is the defect this suite exists to catch.

  async function stateFromRealAuthorize(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/microsoft/authorize' });
    expect(res.statusCode).toBe(200);
    expect(buildAuthorizeUrlMock).toHaveBeenCalledTimes(1);
    return buildAuthorizeUrlMock.mock.calls[0][0] as string;
  }

  it('records the acting user sub on the connection', async () => {
    exchangeCodeForTokensMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const state = await stateFromRealAuthorize(app);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/connectors/microsoft/callback?code=abc123&state=${state}`,
    });

    expect(res.statusCode).toBe(302);
    expect(insertOneMock.mock.calls[0][0].createdBy).toBe('kc-user-9f3a');
  });

  it('records null — never the tenant id — when the host identifies no subject', async () => {
    exchangeCodeForTokensMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    const app = await buildApp(); // no sub on the auth context
    const state = await stateFromRealAuthorize(app);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/connectors/microsoft/callback?code=abc123&state=${state}`,
    });

    expect(res.statusCode).toBe(302);
    const inserted = insertOneMock.mock.calls[0][0];
    expect(inserted.createdBy).toBeNull();
    // The specific regression: a tenant slug in an actor field is worse than
    // a null, because it reads as an answer.
    expect(inserted.createdBy).not.toBe('ACME-01');
    expect(inserted.tenantId).toBe('ACME-01');
  });

  it('does not let a forged actingSub through an unsigned state', async () => {
    // The attribution is only as good as the signature that carries it.
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({
      tenantId: 'ACME-01',
      target: 'onedrive',
      codeVerifier: 'verifier-value',
      actingSub: 'kc-someone-else',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('a-different-secret-that-is-at-least-32b'));

    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/connectors/microsoft/callback?code=abc123&state=${forged}`,
    });

    expect(res.statusCode).toBe(400);
    expect(insertOneMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/connectors/:id/browse', () => {
  const onedriveConn = {
    connectionId: 'conn-1',
    tenantId: 'ACME-01',
    provider: 'onedrive',
    driveId: 'drive-abc',
    encRefreshToken: { ciphertext: 'x', iv: 'y', tag: 'z' },
  };
  const folder = {
    id: 'f1',
    name: 'Finance',
    isFolder: true,
    size: null,
    modified: '2026-08-01T00:00:00Z',
    childCount: 3,
  };

  it('resolves and persists the OneDrive driveId on first browse', async () => {
    findOneMock.mockResolvedValueOnce({ ...onedriveConn, driveId: null });
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt2', expiresIn: 3600 });
    getMyDriveMock.mockResolvedValue({ driveId: 'drive-abc' });
    listAllChildrenMock.mockResolvedValue({ items: [folder], nextCursor: null, truncated: false });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([folder]);
    expect(getMyDriveMock).toHaveBeenCalledTimes(1);
    expect(updateOneMock).toHaveBeenCalledWith(
      { connectionId: 'conn-1', tenantId: 'ACME-01' },
      { $set: { driveId: 'drive-abc' } },
    );
  });

  it('404s for a connection that does not exist (or belongs to another tenant)', async () => {
    findOneMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-ghost/browse' });
    expect(res.statusCode).toBe(404);
  });

  it('403s when connectors are disabled for the tenant', async () => {
    // The gap this pins (closed in the source platform 2026-08-19 and kept
    // closed here): browse used to skip the tenant switch entirely, so an
    // admin flipping it off stopped new authorizations and syncs while
    // leaving every EXISTING connection browsable.
    findOneMock.mockResolvedValueOnce(onedriveConn);
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: false });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'connectors_disabled_for_tenant' });
    // The refusal has to land before the connection's token is spent, not
    // after — otherwise a disabled tenant still costs a provider round trip.
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(listAllChildrenMock).not.toHaveBeenCalled();
  });

  // ---- 34-S07a / 34-S07b: the contract itself -----------------------------

  it('returns FILES as well as folders, with the full item shape', async () => {
    findOneMock.mockResolvedValueOnce(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockResolvedValue({
      items: [
        folder,
        { id: 'd1', name: 'budget.xlsx', isFolder: false, size: 20480, modified: '2026-07-04T10:00:00Z', childCount: null },
      ],
      nextCursor: null,
      truncated: false,
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    const items = res.json().items;
    expect(items).toHaveLength(2);
    expect(items.some((i: any) => i.isFolder === false)).toBe(true);
    expect(Object.keys(items[1]).sort()).toEqual(
      ['childCount', 'id', 'isFolder', 'modified', 'name', 'size'].sort()
    );
  });

  it('reports nextCursor null and truncated false when the listing is complete', async () => {
    findOneMock.mockResolvedValueOnce(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockResolvedValue({ items: [folder], nextCursor: null, truncated: false });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.json().nextCursor).toBeNull();
    expect(res.json().truncated).toBe(false);
  });

  it('SURFACES the ceiling: truncated true rides the response with the cursor to continue from', async () => {
    // Fix #3 of the extraction (silent >200-child truncation): the graph
    // package follows continuation links to a documented 2000-child ceiling
    // and reports {truncated}; the route must pass that flag through so the
    // UI can render it — a bounded thing that does not say so in the output
    // is a silent cap.
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockResolvedValue({
      items: [folder],
      nextCursor: 'continue-here',
      truncated: true,
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.statusCode).toBe(200);
    expect(res.json().truncated).toBe(true);
    // truncated NEVER arrives with a null cursor — there is always a way to
    // continue a truncated listing.
    expect(res.json().nextCursor).toBe('continue-here');
  });

  it('passes a client cursor through to the provider and returns the next one', async () => {
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockResolvedValue({ items: [folder], nextCursor: 'cursor-page-3', truncated: true });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/conn-1/browse?folderId=f1&cursor=cursor-page-2',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().nextCursor).toBe('cursor-page-3');
    expect(listAllChildrenMock).toHaveBeenCalledWith(
      'at',
      'drive-abc',
      'f1',
      expect.objectContaining({ cursor: 'cursor-page-2' })
    );
  });

  it('walks a multi-page folder to the end without dropping an item', async () => {
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    const pages: Record<string, { items: any[]; nextCursor: string | null; truncated: boolean }> = {
      '': { items: [{ ...folder, id: 'a' }], nextCursor: 'c1', truncated: true },
      c1: { items: [{ ...folder, id: 'b' }], nextCursor: 'c2', truncated: true },
      c2: { items: [{ ...folder, id: 'c' }], nextCursor: null, truncated: false },
    };
    listAllChildrenMock.mockImplementation(
      async (_t: string, _d: string, _f: string | undefined, opts: any) => pages[opts?.cursor ?? '']
    );

    const app = await buildApp();
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    let requests = 0;
    do {
      const url =
        cursor === undefined || cursor === null
          ? '/api/v1/connectors/conn-1/browse'
          : `/api/v1/connectors/conn-1/browse?cursor=${encodeURIComponent(cursor)}`;
      const res: any = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().items.map((i: any) => i.id));
      cursor = res.json().nextCursor;
      requests += 1;
    } while (cursor !== null && requests < 10);

    expect(requests).toBe(3);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('collapses a repeated folderId query param instead of handing an array to the provider', async () => {
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockResolvedValue({ items: [], nextCursor: null, truncated: false });

    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse?folderId=f1&folderId=f2' });

    expect(listAllChildrenMock).toHaveBeenCalledWith('at', 'drive-abc', 'f1', expect.anything());
  });

  it('400s sharepoint_site_required when a SharePoint connection has no drive and no site named', async () => {
    findOneMock.mockResolvedValueOnce({ ...onedriveConn, provider: 'sharepoint', driveId: null });
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'sharepoint_site_required' });
    expect(getSharePointDriveMock).not.toHaveBeenCalled();
  });

  // ---- 34-S07e: token hygiene --------------------------------------------

  it('persists a ROTATED refresh token instead of discarding it', async () => {
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rotated-refresh-token',
      expiresIn: 3600,
    });
    listAllChildrenMock.mockResolvedValue({ items: [], nextCursor: null, truncated: false });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.statusCode).toBe(200);
    const write = updateOneMock.mock.calls.find((call) => 'encRefreshToken' in (call[1] as any).$set);
    expect(write).toBeDefined();
    expect(write![0]).toEqual({ connectionId: 'conn-1', tenantId: 'ACME-01' });
    expect(write![1].$set.encRefreshToken).toEqual(
      expect.objectContaining({ ciphertext: expect.any(String), iv: expect.any(String), tag: expect.any(String) })
    );
  });

  it('does not write when the provider returned the SAME refresh token', async () => {
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'decrypted-refresh-token', // what decryptToken hands back
      expiresIn: 3600,
    });
    listAllChildrenMock.mockResolvedValue({ items: [], nextCursor: null, truncated: false });

    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(updateOneMock.mock.calls.filter((call) => 'encRefreshToken' in (call[1] as any).$set)).toHaveLength(0);
  });

  it('caches the access token so a second browse does not pay another refresh', async () => {
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockResolvedValue({ items: [], nextCursor: null, truncated: false });

    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });
    await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse?folderId=f1' });

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(listAllChildrenMock).toHaveBeenCalledTimes(2);
  });

  it('drops the cached token when the connection is disconnected', async () => {
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockResolvedValue({ items: [], nextCursor: null, truncated: false });

    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });
    await app.inject({ method: 'DELETE', url: '/api/v1/connectors/conn-1' });
    await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
  });

  it('409s a disconnected connection rather than crashing into browse_failed', async () => {
    findOneMock.mockResolvedValue({ ...onedriveConn, status: 'disconnected', encRefreshToken: null });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('connection_disconnected');
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  // ---- 34-S09c: the status survives to the caller -------------------------

  it('answers 429 with Retry-After when Graph throttles', async () => {
    const { GraphConnectorError } = await vi.importActual<typeof import('@shelfmark/graph')>(
      '@shelfmark/graph'
    );
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockRejectedValue(
      new GraphConnectorError('Failed to list folder: throttled', {
        status: 429,
        retryAfterSeconds: 42,
        providerErrorCode: 'activityLimitReached',
      })
    );

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    expect(res.json()).toEqual({ error: 'browse_throttled', retryAfterSeconds: 42 });
  });

  it('distinguishes a missing-scope 404 from a genuine not-found', async () => {
    const { GraphConnectorError } = await vi.importActual<typeof import('@shelfmark/graph')>(
      '@shelfmark/graph'
    );
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });

    listAllChildrenMock.mockRejectedValue(
      new GraphConnectorError('Failed to list folder: 404', { status: 404, scopeMissing: true })
    );
    const app = await buildApp();
    const scopeRes = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });
    expect(scopeRes.statusCode).toBe(403);
    expect(scopeRes.json().error).toBe('browse_scope_missing');

    listAllChildrenMock.mockRejectedValue(
      new GraphConnectorError('Failed to list folder: 404', { status: 404, scopeMissing: false })
    );
    const missingRes = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse?folderId=gone' });
    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.json().error).toBe('browse_folder_not_found');
  });

  it('still answers 502 browse_failed for an unclassified failure', async () => {
    findOneMock.mockResolvedValue(onedriveConn);
    refreshAccessTokenMock.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    listAllChildrenMock.mockRejectedValue(new Error('socket hang up'));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/browse' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('browse_failed');
  });
});

describe('POST /api/v1/connectors/:id/sync', () => {
  it('resolves defaultLabel through the LabelPolicy and starts the workflow', async () => {
    findOneMock.mockResolvedValue({ connectionId: 'conn-1', tenantId: 'ACME-01' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/sync',
      payload: { rootFolderId: 'f1', rootPath: '/Finance', defaultLabel: 'commercial' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().workflowId).toBe('connector-sync-conn-1');
    expect(startWorkflowMock).toHaveBeenCalledWith('connectorSyncWorkflow', {
      taskQueue: 'test-ingest-queue',
      workflowId: 'connector-sync-conn-1',
      args: [{ connectionId: 'conn-1' }],
    });
    expect(updateOneMock).toHaveBeenCalledWith(
      { connectionId: 'conn-1' },
      {
        $set: {
          rootFolderId: 'f1',
          rootPath: '/Finance',
          defaultLabel: 'commercial',
          status: 'syncing',
          lastSyncStartedAt: expect.any(Date),
        },
      }
    );
  });

  it('caps an over-reaching requested label down to the caller\'s own', async () => {
    findOneMock.mockResolvedValue({ connectionId: 'conn-1', tenantId: 'ACME-01' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/sync',
      payload: { defaultLabel: 'top_secret_tier' },
    });

    expect(res.statusCode).toBe(202);
    const setArgs = updateOneMock.mock.calls[0][1].$set;
    // Capped to the caller's own label by the host's LabelPolicy — a cap,
    // never a raise, and never a previous value.
    expect(setArgs.defaultLabel).toBe('commercial');
    expect(labelResolveMock).toHaveBeenCalledWith(
      'top_secret_tier',
      expect.objectContaining({ tenantId: 'ACME-01', label: 'commercial' })
    );
  });

  it('403s label_refused — typed — when the LabelPolicy refuses outright', async () => {
    findOneMock.mockResolvedValue({ connectionId: 'conn-1', tenantId: 'ACME-01' });
    labelResolveMock.mockImplementation((requested: string | undefined) => {
      throw new LabelRefusedError(requested);
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/sync',
      payload: { defaultLabel: 'forbidden_tier' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'label_refused', requested: 'forbidden_tier' });
    expect(startWorkflowMock).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('404s for a connection that does not exist', async () => {
    findOneMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-ghost/sync', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it('503s "durable start failed" when the workflow cannot start', async () => {
    findOneMock.mockResolvedValue({ connectionId: 'conn-1', tenantId: 'ACME-01' });
    startWorkflowMock.mockRejectedValue(new Error('temporal frontend unreachable'));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/connectors/conn-1/sync', payload: {} });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Unable to start sync workflow — durable start failed' });
  });
});

describe('DELETE /api/v1/connectors/:id', () => {
  it('marks the connection disconnected and clears the stored token', async () => {
    updateOneMock.mockResolvedValue({ matchedCount: 1 });
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/connectors/conn-1' });
    expect(res.statusCode).toBe(200);
    expect(updateOneMock).toHaveBeenCalledWith(
      { connectionId: 'conn-1', tenantId: 'ACME-01' },
      { $set: { status: 'disconnected', encRefreshToken: null } }
    );
  });

  it('404s for a connection that does not exist', async () => {
    updateOneMock.mockResolvedValue({ matchedCount: 0 });
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/connectors/conn-ghost' });
    expect(res.statusCode).toBe(404);
  });
});
