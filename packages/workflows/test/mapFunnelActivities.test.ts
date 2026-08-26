// SPDX-License-Identifier: Apache-2.0
// 34-S11b — the candidates spool and the funnel at finalize, at the
// ACTIVITY level: appendMapCandidates (filters by the artifact's candidate
// class, upserts idempotently), writeMapSuggestions (one document, a table
// that reconciles, spool consumed), and finalizeMapRun's spool sweep. Only
// the store is faked; the funnel evaluation runs the REAL vendored artifacts
// through the real @shelfmark/policy port.
import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentSink, MapCandidateDoc, ShelfmarkPorts } from '@shelfmark/core';
import {
  createMapActivities,
  MAX_SUGGESTION_ROWS,
  type MapPageItem,
} from '../src/index';
import { fakeStore, type FakeData } from './fakeStore';

const MAP_CANDIDATES_COLLECTION = 'map_candidates';
const MAP_SUGGESTIONS_COLLECTION = 'map_suggestions';

const TENANT = 'ACME-01';
const RUN = 'map-run-1';
const CONN = 'conn-map-1';

const noSink: DocumentSink = {
  accept: async () => ({ status: 'failed', error: 'sink must not be reached by map activities' }),
};
const ports: ShelfmarkPorts = { sink: noSink, resolveAuth: async () => null };

const data: FakeData = {};
const activities = createMapActivities({ store: fakeStore(data), ports });

function pageFile(id: string, name: string, size: number, classId: string, path: string): MapPageItem {
  return {
    id,
    name,
    isFolder: false,
    size,
    childCount: null,
    modified: '2026-08-01T00:00:00Z',
    path,
    classId,
    rule: `extension:${name.split('.').pop()}`,
    shouldWalk: false,
  };
}

function spoolRow(itemId: string, path: string, size: number): MapCandidateDoc {
  return {
    tenantId: TENANT,
    runId: RUN,
    connectionId: CONN,
    itemId,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    size,
    modified: '2026-08-01T00:00:00Z',
    classRule: 'extension:md',
  };
}

beforeEach(() => {
  for (const key of Object.keys(data)) delete data[key];
});

describe('appendMapCandidates — the per-page spool', () => {
  it("spools only FILE items of the funnel artifact's candidate class (the class name is the artifact's, not this code's)", async () => {
    const kept = await activities.appendMapCandidates(TENANT, RUN, CONN, [
      pageFile('f-1', 'notes.md', 1000, 'human_prose', '/Documents/notes.md'),
      pageFile('f-2', 'app.py', 3000, 'human_source', '/Documents/app.py'),
      {
        ...pageFile('fld-1', 'Sub', 0, 'container', '/Documents/Sub'),
        isFolder: true,
        rule: 'is_folder',
      },
    ]);
    expect(kept).toBe(1);
    const rows = data[MAP_CANDIDATES_COLLECTION] ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      runId: RUN,
      connectionId: CONN,
      itemId: 'f-1',
      path: '/Documents/notes.md',
      name: 'notes.md',
      size: 1000,
      modified: '2026-08-01T00:00:00Z',
      classRule: 'extension:md',
    });
  });

  it('is idempotent under activity retries — a re-spooled page re-asserts, never duplicates', async () => {
    const page = [pageFile('f-1', 'notes.md', 1000, 'human_prose', '/Documents/notes.md')];
    await activities.appendMapCandidates(TENANT, RUN, CONN, page);
    await activities.appendMapCandidates(TENANT, RUN, CONN, page);
    expect(data[MAP_CANDIDATES_COLLECTION]).toHaveLength(1);
  });
});

describe('writeMapSuggestions — one document, a table that reconciles, spool consumed', () => {
  function seedSpool() {
    data[MAP_CANDIDATES_COLLECTION] = [
      spoolRow('i-a', '/Documents/notes/a.md', 1000),
      spoolRow('i-tiny', '/Documents/notes/tiny.md', 50),
      spoolRow('i-dup1', '/Documents/dup.md', 2048),
      spoolRow('i-dup2', '/code/x/dup.md', 2048),
      spoolRow('i-w2', '/Documents/tax/w2.pdf', 5000),
    ];
  }

  it('writes the funnel table, the JRN-D1 shape counts and the verdict ledger — and candidates == selected + sum(subtractions), files AND bytes', async () => {
    seedSpool();
    const summary = await activities.writeMapSuggestions(TENANT, RUN, CONN);

    expect(summary.candidateFiles).toBe(5);
    expect(summary.candidateBytes).toBe(1000 + 50 + 2048 + 2048 + 5000);
    // tiny.md under the referenced 200 B floor; the deeper dup collapsed.
    expect(summary.subtractedFiles).toBe(2);
    expect(summary.defaultSelectionFiles).toBe(3);
    expect(summary.defaultSelectionBytes).toBe(1000 + 2048 + 5000);
    expect(summary.rowsTruncated).toBe(false);

    const docs = data[MAP_SUGGESTIONS_COLLECTION] ?? [];
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc).toMatchObject({ tenantId: TENANT, runId: RUN, connectionId: CONN });
    // Provenance: which rules produced this document.
    expect(doc.funnelPolicyVersion).toBe('1.0.0-rc1');
    expect(doc.funnelPolicySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.classifierVersion).toBe('1.0.0-rc2');

    // THE TABLE RECONCILES: candidates minus every named subtraction equals
    // the default selection, in files and in bytes (JRN-7 discipline).
    const subFiles = doc.funnelTable.reduce((a: number, r: any) => a + r.files, 0);
    const subBytes = doc.funnelTable.reduce((a: number, r: any) => a + r.bytes, 0);
    expect(doc.candidates.files - subFiles).toBe(doc.defaultSelection.files);
    expect(doc.candidates.bytes - subBytes).toBe(doc.defaultSelection.bytes);
    // Every subtraction is NAMED — including the zero rows.
    expect(doc.funnelTable.map((r: any) => r.rule)).toEqual([
      'archived_dump_copy',
      'stub_under_200b',
      'receipt_shape',
      'machine_output_in_prose',
      'third_party_publication',
      'propagation',
      'duplicate_fingerprint',
    ]);
    expect(doc.funnelTable.find((r: any) => r.rule === 'stub_under_200b')).toEqual({
      rule: 'stub_under_200b',
      files: 1,
      bytes: 50,
    });
    expect(doc.funnelTable.find((r: any) => r.rule === 'duplicate_fingerprint')).toEqual({
      rule: 'duplicate_fingerprint',
      files: 1,
      bytes: 2048,
    });

    // The verdict ledger: full grammar, subtractedBy on subtracted rows,
    // reportedShapes only where a shape matched, itemId carried for 34-S14a.
    const byPath = Object.fromEntries(doc.rows.map((r: any) => [r.path, r]));
    expect(byPath['/Documents/notes/a.md']).toMatchObject({ verdict: 'selected', itemId: 'i-a' });
    expect(byPath['/Documents/notes/a.md'].reportedShapes).toBeUndefined();
    expect(byPath['/Documents/notes/tiny.md']).toMatchObject({
      verdict: 'subtracted:stub_under_200b',
      subtractedBy: 'stub_under_200b',
    });
    // Shallowest path kept: /Documents/dup.md (3 segments) beats /code/x/dup.md (4).
    expect(byPath['/Documents/dup.md'].verdict).toBe('selected');
    expect(byPath['/code/x/dup.md']).toMatchObject({
      verdict: 'subtracted:duplicate_fingerprint',
      subtractedBy: 'duplicate_fingerprint',
    });
    expect(byPath['/Documents/tax/w2.pdf']).toMatchObject({
      verdict: 'selected',
      reportedShapes: ['tax_shape'],
    });

    // JRN-D1: counts over candidates AND the default selection, zeros
    // included, nothing subtracted for being sensitive.
    expect(doc.sensitiveReport.tax_shape).toEqual({ candidates: 1, defaultSelection: 1 });
    expect(doc.sensitiveReport.legal_shape).toEqual({ candidates: 0, defaultSelection: 0 });

    // Rank is honestly ABSENT — no portable ordering spec exists.
    expect(doc.ranking.ranked).toBe(false);
    expect(doc.rows.every((r: any) => !('rank' in r))).toBe(true);
    // The named row cap is recorded even when it does not bite.
    expect(doc.rowCap).toBe(MAX_SUGGESTION_ROWS);
    expect(doc.rowsTruncated).toBe(false);

    // THE SPOOL IS CONSUMED: suggestions carry everything downstream needs.
    expect(data[MAP_CANDIDATES_COLLECTION] ?? []).toHaveLength(0);
  });

  it('is idempotent under a Temporal retry AFTER the spool was consumed — returns the recorded summary instead of re-evaluating an empty corpus over the real one', async () => {
    seedSpool();
    const first = await activities.writeMapSuggestions(TENANT, RUN, CONN);
    const again = await activities.writeMapSuggestions(TENANT, RUN, CONN);
    expect(again).toEqual(first);
    const doc = (data[MAP_SUGGESTIONS_COLLECTION] ?? [])[0];
    expect(doc.candidates.files).toBe(5); // NOT clobbered to zero
  });

  it('writes an honest empty funnel for a drive with zero prose candidates', async () => {
    const summary = await activities.writeMapSuggestions(TENANT, RUN, CONN);
    expect(summary.candidateFiles).toBe(0);
    expect(summary.defaultSelectionFiles).toBe(0);
    const doc = (data[MAP_SUGGESTIONS_COLLECTION] ?? [])[0];
    expect(doc.rows).toEqual([]);
    // Zeros are still NAMED rows, not absent rows.
    expect(doc.funnelTable).toHaveLength(7);
  });
});

describe('finalizeMapRun sweeps the spool on every terminal status', () => {
  it('a failed run cannot orphan spool rows', async () => {
    data[MAP_CANDIDATES_COLLECTION] = [spoolRow('i-a', '/Documents/a.md', 1000)];
    await activities.finalizeMapRun(TENANT, RUN, CONN, 'failed', {});
    expect(data[MAP_CANDIDATES_COLLECTION] ?? []).toHaveLength(0);
    // …and only THIS run's rows: tenant/run scoping in the delete filter.
    data[MAP_CANDIDATES_COLLECTION] = [
      { ...spoolRow('i-b', '/Documents/b.md', 500), runId: 'another-run' },
    ];
    await activities.finalizeMapRun(TENANT, RUN, CONN, 'refused_no_consent', {});
    expect(data[MAP_CANDIDATES_COLLECTION]).toHaveLength(1);
  });
});
