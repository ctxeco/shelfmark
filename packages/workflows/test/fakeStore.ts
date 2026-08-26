// SPDX-License-Identifier: Apache-2.0
// In-memory Mongo fake — just the surface the activities use, wrapped by the
// REAL storeFromDb so tests exercise the same typed accessors production
// wires up. Shared by the activity suites and the egress-inventory test.
import { storeFromDb, type ShelfmarkStore } from '@shelfmark/core';
import type { Db } from 'mongodb';

export type FakeData = Record<string, any[]>;

function matches(doc: any, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && '$exists' in v) return (doc[k] !== undefined) === v.$exists;
    return doc[k] === v;
  });
}

function fakeCollection(data: FakeData, name: string) {
  const arr = () => (data[name] ??= []);
  const cursor = (docs: any[]) => ({
    sort(spec: Record<string, 1 | -1>) {
      const [[key, dir]] = Object.entries(spec) as [string, 1 | -1][];
      docs = [...docs].sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : 0));
      return this;
    },
    limit(n: number) {
      docs = docs.slice(0, n);
      return this;
    },
    async toArray() {
      return docs.map((d) => ({ ...d }));
    },
  });
  return {
    find: (filter: Record<string, any> = {}, _opts?: unknown) =>
      cursor(arr().filter((d) => matches(d, filter))),
    findOne: async (filter: Record<string, any>, _opts?: unknown) => {
      const hit = arr().find((d) => matches(d, filter));
      return hit ? { ...hit } : null;
    },
    insertOne: async (doc: any) => {
      arr().push({ ...doc });
      return { acknowledged: true };
    },
    updateOne: async (filter: Record<string, any>, update: any, opts: { upsert?: boolean } = {}) => {
      const idx = arr().findIndex((d) => matches(d, filter));
      if (idx >= 0) {
        const row = arr()[idx];
        Object.assign(row, update.$set ?? {});
        for (const [k, by] of Object.entries((update.$inc ?? {}) as Record<string, number>)) {
          row[k] = (row[k] ?? 0) + by;
        }
      } else if (opts.upsert) {
        arr().push({ ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) });
      }
      return { matchedCount: idx >= 0 ? 1 : 0, modifiedCount: idx >= 0 ? 1 : 0 };
    },
    bulkWrite: async (ops: any[]) => {
      for (const op of ops) {
        const { filter, update, upsert } = op.updateOne;
        const idx = arr().findIndex((d) => matches(d, filter));
        if (idx >= 0) Object.assign(arr()[idx], update.$set ?? {});
        else if (upsert) arr().push({ ...(update.$set ?? {}) });
      }
    },
    deleteMany: async (filter: Record<string, any>) => {
      data[name] = arr().filter((d) => !matches(d, filter));
    },
    createIndex: async () => 'ok',
  };
}

/** A ShelfmarkStore over an in-memory object. Mutate/inspect `data` directly. */
export function fakeStore(data: FakeData): ShelfmarkStore {
  const db = { collection: (name: string) => fakeCollection(data, name) };
  return storeFromDb(db as unknown as Db);
}
