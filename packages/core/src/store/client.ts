// SPDX-License-Identifier: Apache-2.0
// The Mongo store client — one thin, typed seam over the seven
// connector-private collections.
//
// Mongo is a HARD dependency of this library, on purpose: the run records,
// the consent evidence, the candidates spool and the selection ledger are
// relational-enough documents with idempotent upsert semantics that the
// workflows depend on (a Temporal activity retry re-asserts rather than
// duplicates precisely because the spool upsert is keyed). Abstracting the
// store behind a fifth-and-a-half port would trade that load-bearing
// specificity for a lowest-common-denominator interface nobody asked for.
// The `Db` handle is still injectable (`storeFromDb`) so hosts own connection
// lifecycle and tests need no running server.
import { MongoClient, type Db } from 'mongodb';
import { CONSENT_COLLECTION, type ConsentRecord } from '../consent/store.js';
import { resolveMongoUri } from './mongoUri.js';
import {
  CONNECTIONS_COLLECTION,
  MAP_CANDIDATES_COLLECTION,
  MAP_RUNS_COLLECTION,
  MAP_SELECTIONS_COLLECTION,
  MAP_SUGGESTIONS_COLLECTION,
  SELECTIVE_INGEST_RUNS_COLLECTION,
  type ConnectorConnectionDoc,
  type MapCandidateDoc,
  type MapRunDoc,
  type MapSelectionDoc,
  type MapSuggestionsDoc,
  type SelectiveIngestRunDoc,
} from './schemas.js';
import type { Collection } from 'mongodb';

export const DEFAULT_STORE_DB_NAME = 'shelfmark';

/** Typed accessors for the seven connector-private collections. Accessors
 *  rather than fields so a host can hand the same object across a
 *  reconnect — every call re-reads the live `db`. */
export interface ShelfmarkCollections {
  connections(): Collection<ConnectorConnectionDoc>;
  consents(): Collection<ConsentRecord>;
  mapRuns(): Collection<MapRunDoc>;
  mapCandidates(): Collection<MapCandidateDoc>;
  mapSuggestions(): Collection<MapSuggestionsDoc>;
  mapSelections(): Collection<MapSelectionDoc>;
  selectiveIngestRuns(): Collection<SelectiveIngestRunDoc>;
}

export interface ShelfmarkStore {
  db: Db;
  collections: ShelfmarkCollections;
}

export interface ShelfmarkStoreClient extends ShelfmarkStore {
  client: MongoClient;
  close(): Promise<void>;
}

/** Wrap an already-connected `Db` — the injectable seam tests and hosts use. */
export function storeFromDb(db: Db): ShelfmarkStore {
  return {
    db,
    collections: {
      connections: () => db.collection<ConnectorConnectionDoc>(CONNECTIONS_COLLECTION),
      consents: () => db.collection<ConsentRecord>(CONSENT_COLLECTION),
      mapRuns: () => db.collection<MapRunDoc>(MAP_RUNS_COLLECTION),
      mapCandidates: () => db.collection<MapCandidateDoc>(MAP_CANDIDATES_COLLECTION),
      mapSuggestions: () => db.collection<MapSuggestionsDoc>(MAP_SUGGESTIONS_COLLECTION),
      mapSelections: () => db.collection<MapSelectionDoc>(MAP_SELECTIONS_COLLECTION),
      selectiveIngestRuns: () =>
        db.collection<SelectiveIngestRunDoc>(SELECTIVE_INGEST_RUNS_COLLECTION),
    },
  };
}

/**
 * Ensure the indexes the write paths depend on. Idempotent — `createIndex`
 * on an existing identical index is a no-op — so this runs at every startup.
 *
 * The one load-bearing index is the spool's: `map_candidates` upserts are
 * keyed on (tenantId, runId, path), and WITHOUT the unique index two
 * concurrent activity retries of the same page could both pass the filter
 * miss and insert twice — the unique constraint turns that race into the
 * idempotent re-assertion the workflow assumes. The run-record uniques give
 * the same guarantee to the start/finalize upserts; the rest are the query
 * paths the activities actually take.
 */
export async function ensureStoreIndexes(db: Db): Promise<void> {
  const s = storeFromDb(db).collections;
  await s.connections().createIndex({ connectionId: 1 }, { unique: true });
  await s.connections().createIndex({ tenantId: 1, connectionId: 1 });
  // The consent stream is append-only; this is its one read path (the
  // tenant-scoped event listing both consent checks derive from).
  await s.consents().createIndex({ tenantId: 1, connectionId: 1, grantedAt: -1 });
  await s.mapRuns().createIndex({ tenantId: 1, runId: 1 }, { unique: true });
  await s.mapCandidates().createIndex({ tenantId: 1, runId: 1, path: 1 }, { unique: true });
  await s.mapSuggestions().createIndex({ tenantId: 1, runId: 1 }, { unique: true });
  await s.mapSelections().createIndex({ tenantId: 1, connectionId: 1, decidedAt: -1 });
  await s.selectiveIngestRuns().createIndex({ tenantId: 1, runId: 1 }, { unique: true });
}

/**
 * Connect and return the typed store. `uri` falls back to `MONGODB_URI` via
 * the fail-fast rule in mongoUri.ts: a credential-less default is refused
 * when clearly running in a cluster, kept for the laptop loop otherwise.
 * Indexes are ensured on connect — the cheapest place to make the spool's
 * uniqueness guarantee unconditional.
 */
export async function createStoreClient(
  uri?: string,
  dbName: string = DEFAULT_STORE_DB_NAME
): Promise<ShelfmarkStoreClient> {
  const resolved = uri?.trim() || resolveMongoUri('shelfmark-store');
  const client = new MongoClient(resolved, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(dbName);
  await ensureStoreIndexes(db);
  const store = storeFromDb(db);
  return {
    ...store,
    client,
    close: () => client.close(),
  };
}
