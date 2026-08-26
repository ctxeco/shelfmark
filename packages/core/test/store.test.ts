// SPDX-License-Identifier: Apache-2.0
// The store seam: the fail-fast URI rule, the typed accessors, and the
// index-ensure calls the workflows' idempotent upserts depend on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTIONS_COLLECTION,
  MAP_CANDIDATES_COLLECTION,
  MAP_RUNS_COLLECTION,
  MAP_SELECTIONS_COLLECTION,
  MAP_SUGGESTIONS_COLLECTION,
  SELECTIVE_INGEST_RUNS_COLLECTION,
  CONSENT_COLLECTION,
  ensureStoreIndexes,
  resolveMongoUri,
  storeFromDb,
} from '../src/index.js';

describe('resolveMongoUri — refuses to guess inside a cluster', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.MONGODB_URI;
    delete process.env.KUBERNETES_SERVICE_HOST;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('an explicit MONGODB_URI always wins', () => {
    process.env.MONGODB_URI = 'mongodb://user:pw@db.internal:27017';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    expect(resolveMongoUri('svc')).toBe('mongodb://user:pw@db.internal:27017');
  });

  it('off-cluster, the convenient local default survives — the feedback loop is a terminal', () => {
    expect(resolveMongoUri('svc')).toBe('mongodb://mongodb:27017');
  });

  it('in-cluster (KUBERNETES_SERVICE_HOST set), an unset URI is a configuration error, not a default', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    expect(() => resolveMongoUri('svc')).toThrow(/MONGODB_URI is not set/);
    expect(() => resolveMongoUri('svc')).toThrow(/no credentials/);
  });

  it('a whitespace-only URI is treated as unset, not passed to the driver', () => {
    process.env.MONGODB_URI = '   ';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    expect(() => resolveMongoUri('svc')).toThrow();
  });
});

function fakeDb() {
  const created: Record<string, unknown[]> = {};
  const collections = new Map<string, unknown>();
  const db = {
    collection(name: string) {
      if (!collections.has(name)) {
        collections.set(name, {
          __name: name,
          createIndex: vi.fn(async (spec: unknown, opts: unknown) => {
            (created[name] ??= []).push({ spec, opts });
            return 'ok';
          }),
        });
      }
      return collections.get(name);
    },
  };
  return { db: db as never, created };
}

describe('storeFromDb — typed accessors over the seven collections', () => {
  it('routes each accessor to its named collection', () => {
    const { db } = fakeDb();
    const store = storeFromDb(db);
    expect((store.collections.connections() as never as { __name: string }).__name).toBe(
      CONNECTIONS_COLLECTION
    );
    expect((store.collections.consents() as never as { __name: string }).__name).toBe(
      CONSENT_COLLECTION
    );
    expect((store.collections.mapRuns() as never as { __name: string }).__name).toBe(
      MAP_RUNS_COLLECTION
    );
    expect((store.collections.mapCandidates() as never as { __name: string }).__name).toBe(
      MAP_CANDIDATES_COLLECTION
    );
    expect((store.collections.mapSuggestions() as never as { __name: string }).__name).toBe(
      MAP_SUGGESTIONS_COLLECTION
    );
    expect((store.collections.mapSelections() as never as { __name: string }).__name).toBe(
      MAP_SELECTIONS_COLLECTION
    );
    expect((store.collections.selectiveIngestRuns() as never as { __name: string }).__name).toBe(
      SELECTIVE_INGEST_RUNS_COLLECTION
    );
  });
});

describe('ensureStoreIndexes — the uniqueness the idempotent upserts assume', () => {
  it('creates the unique (tenantId, runId, path) spool index and the run-record uniques', async () => {
    const { db, created } = fakeDb();
    await ensureStoreIndexes(db);

    const spool = created[MAP_CANDIDATES_COLLECTION] as { spec: unknown; opts: unknown }[];
    expect(spool).toContainEqual({
      spec: { tenantId: 1, runId: 1, path: 1 },
      opts: { unique: true },
    });
    for (const runs of [MAP_RUNS_COLLECTION, MAP_SUGGESTIONS_COLLECTION, SELECTIVE_INGEST_RUNS_COLLECTION]) {
      expect(created[runs]).toContainEqual({
        spec: { tenantId: 1, runId: 1 },
        opts: { unique: true },
      });
    }
    expect(created[CONNECTIONS_COLLECTION]).toContainEqual({
      spec: { connectionId: 1 },
      opts: { unique: true },
    });
    // The consent stream's one read path — the tenant-scoped event listing.
    expect(created[CONSENT_COLLECTION]).toContainEqual({
      spec: { tenantId: 1, connectionId: 1, grantedAt: -1 },
      opts: undefined,
    });
    expect(created[MAP_SELECTIONS_COLLECTION]).toContainEqual({
      spec: { tenantId: 1, connectionId: 1, decidedAt: -1 },
      opts: undefined,
    });
  });
});
