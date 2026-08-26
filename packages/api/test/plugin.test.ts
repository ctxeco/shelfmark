// SPDX-License-Identifier: Apache-2.0
// Plugin-level contracts NEW to the port (sanctioned changes, tested as new
// behavior): fail-fast config validation — publicBaseUrl REQUIRED with no
// default, state secret with an enforced size floor — and the resolveAuth
// 401 gate across the authenticated surface.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { AuthContext } from '@shelfmark/core';
import type { Db } from 'mongodb';
import { shelfmarkApi } from '../src/plugin.js';
import type { ShelfmarkApiOptions } from '../src/types.js';

const findOneMock = vi.fn();
const dbMock = {
  collection: () => ({
    findOne: (...args: unknown[]) => findOneMock(...args),
    find: () => ({ sort: () => ({ toArray: async () => [] }) }),
    insertOne: vi.fn(),
    updateOne: vi.fn(),
  }),
} as unknown as Db;

function baseOptions(overrides: Partial<ShelfmarkApiOptions> = {}): ShelfmarkApiOptions {
  return {
    db: dbMock,
    ports: {
      sink: { accept: async () => ({ status: 'ingested' as const }) },
      resolveAuth: async (): Promise<AuthContext | null> => ({
        tenantId: 'ACME-01',
        sub: 'kc-user-9f3a',
      }),
    },
    temporal: { client: { workflow: { start: vi.fn() } }, taskQueue: 'q' },
    config: {
      publicBaseUrl: 'https://portal.example.com',
      stateSecret: 'test-state-secret-at-least-32-bytes-long',
    },
    ...overrides,
  };
}

beforeEach(() => {
  findOneMock.mockReset().mockResolvedValue(null);
});

describe('fail-fast config validation', () => {
  it('REFUSES to register without publicBaseUrl — no default, ever', async () => {
    // The removed default is the point: publicBaseUrl builds the OAuth
    // redirect URIs, so a fallback value is a LIVE misconfiguration that
    // surfaces as a broken OAuth round trip on someone else's host. The
    // plugin throws at register, where the mistake actually is.
    const opts = baseOptions();
    opts.config = { ...opts.config, publicBaseUrl: '' };
    const app = Fastify();
    app.register(shelfmarkApi, opts);
    await expect(app.ready()).rejects.toThrow(/publicBaseUrl/);
  });

  it('refuses a state secret under 32 bytes', async () => {
    const opts = baseOptions();
    opts.config = { ...opts.config, stateSecret: 'short' };
    const app = Fastify();
    app.register(shelfmarkApi, opts);
    await expect(app.ready()).rejects.toThrow(/32 bytes/);
  });

  it('refuses a missing state secret', async () => {
    const opts = baseOptions();
    opts.config = { ...opts.config, stateSecret: '' };
    const app = Fastify();
    app.register(shelfmarkApi, opts);
    await expect(app.ready()).rejects.toThrow(/stateSecret/);
  });

  it('refuses a missing resolveAuth port', async () => {
    const opts = baseOptions();
    opts.ports = { ...opts.ports, resolveAuth: undefined as never };
    const app = Fastify();
    app.register(shelfmarkApi, opts);
    await expect(app.ready()).rejects.toThrow(/resolveAuth/);
  });

  it('registers cleanly with a valid config', async () => {
    const app = Fastify();
    await app.register(shelfmarkApi, baseOptions());
    await app.ready();
  });
});

describe('the resolveAuth 401 gate', () => {
  async function unauthenticatedApp() {
    const app = Fastify();
    await app.register(shelfmarkApi, {
      ...baseOptions({
        ports: {
          sink: { accept: async () => ({ status: 'ingested' as const }) },
          resolveAuth: async () => null,
        },
      }),
      prefix: '/api/v1/connectors',
    } as ShelfmarkApiOptions & { prefix: string });
    return app;
  }

  it('answers 401 unauthenticated on every authenticated route family', async () => {
    const app = await unauthenticatedApp();
    const probes: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }> = [
      { method: 'POST', url: '/api/v1/connectors/microsoft/authorize' },
      { method: 'GET', url: '/api/v1/connectors/' },
      { method: 'GET', url: '/api/v1/connectors/conn-1/browse' },
      { method: 'POST', url: '/api/v1/connectors/conn-1/sync' },
      { method: 'DELETE', url: '/api/v1/connectors/conn-1' },
      { method: 'POST', url: '/api/v1/connectors/conn-1/map' },
      { method: 'GET', url: '/api/v1/connectors/conn-1/map' },
      { method: 'GET', url: '/api/v1/connectors/conn-1/map/stream' },
      { method: 'GET', url: '/api/v1/connectors/conn-1/map/suggestions' },
      { method: 'PUT', url: '/api/v1/connectors/conn-1/map/selection' },
      { method: 'GET', url: '/api/v1/connectors/conn-1/map/selection' },
      { method: 'POST', url: '/api/v1/connectors/conn-1/ingest' },
    ];
    for (const probe of probes) {
      const res = await app.inject(probe);
      expect(res.statusCode, `${probe.method} ${probe.url}`).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    }
    // And no database work happened for any of them.
    expect(findOneMock).not.toHaveBeenCalled();
  });

  it('the map stream 401s BEFORE hijacking — a plain JSON refusal, not a dead SSE socket', async () => {
    const app = await unauthenticatedApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/map/stream' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
