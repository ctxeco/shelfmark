// SPDX-License-Identifier: Apache-2.0
// 34-S14a — the selective ingest's store-facing half: the ingest_content
// consent check (fail closed, scope-distinct from the map's), the selection
// algebra (default minus removals plus re-adds, resolved against the
// suggestions ledger), the batch pager and its mid-run change refusal, the
// named refusals for every way a selection can fail to resolve — and JRN-8's
// typed refusal for a selection outside the consent's scope.
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapSuggestionRow } from '@shelfmark/core';
import type { DocumentSink, ShelfmarkPorts } from '@shelfmark/core';
import {
  createSelectiveIngestActivities,
  firstOutOfScopePath,
  folderTotalsOf,
  parentPathOf,
  resolveSelectionRows,
  INGEST_CONSENT_SCOPE,
  MAX_FOLDER_ROLLUP_ENTRIES,
  SELECTION_OUT_OF_SCOPE_ERROR_TYPE,
  type MapConsentCheck,
} from '../src/index';
import { fakeStore, type FakeData } from './fakeStore';

const MAP_SUGGESTIONS_COLLECTION = 'map_suggestions';
const MAP_SELECTIONS_COLLECTION = 'map_selections';
const SELECTIVE_INGEST_RUNS_COLLECTION = 'selective_ingest_runs';

const TENANT = 'ACME-01';
const CONN = 'conn-map-1';
const RUN = 'map-run-1';

const noSink: DocumentSink = {
  accept: async () => ({ status: 'failed', error: 'sink must not be reached by these activities' }),
};
const ports: ShelfmarkPorts = { sink: noSink, resolveAuth: async () => null };

const data: FakeData = {};
const activities = createSelectiveIngestActivities({ store: fakeStore(data), ports });

function row(path: string, verdict: string, itemId = `i-${path}`, size = 1000): MapSuggestionRow {
  const r: MapSuggestionRow = {
    itemId,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    size,
    modified: '2026-08-01T00:00:00Z',
    verdict,
  };
  if (verdict.startsWith('subtracted:')) r.subtractedBy = verdict.slice('subtracted:'.length);
  return r;
}

/** JRN-8 — the plan/batch tests seed an ACTIVE ingest consent, because the
 *  resolution itself now reads the consent's scope (that is the fix). */
function seedIngestConsent(
  extra: { target?: { folderId: string | null; folderPath: string | null }; exclusions?: string[] } = {}
) {
  data.connector_consents = [
    {
      tenantId: TENANT,
      connectionId: CONN,
      consentId: 'c-ingest',
      action: 'granted',
      revokesConsentId: null,
      scope: INGEST_CONSENT_SCOPE,
      disclosureSha256: 'sha-d',
      grantedAt: '2026-08-19',
      target: extra.target ?? { folderId: null, folderPath: null },
      exclusions: extra.exclusions ?? [],
    },
  ];
}

beforeEach(() => {
  for (const key of Object.keys(data)) delete data[key];
});

describe('resolveSelectionRows — the algebra, pure', () => {
  const rows = [
    row('/Documents/a.md', 'selected'),
    row('/Documents/b.md', 'selected'),
    row('/Documents/receipt.pdf', 'subtracted:receipt_shape'),
    row('/Documents/z-dup.md', 'subtracted:duplicate_fingerprint'),
  ];

  it('default selection = the selected rows, in path codepoint order', () => {
    const r = resolveSelectionRows(rows, [], []);
    expect(r.files.map((f) => f.path)).toEqual(['/Documents/a.md', '/Documents/b.md']);
    expect(r.unresolvedReaddPaths).toEqual([]);
  });

  it('removedPaths subtract from the default; re-adds re-admit SUBTRACTED rows', () => {
    const r = resolveSelectionRows(rows, ['/Documents/b.md'], ['/Documents/receipt.pdf']);
    expect(r.files.map((f) => f.path)).toEqual(['/Documents/a.md', '/Documents/receipt.pdf']);
  });

  it('a path both removed and re-added ends IN the set — the re-add is the later, deliberate act', () => {
    const r = resolveSelectionRows(rows, ['/Documents/a.md'], ['/Documents/a.md']);
    expect(r.files.map((f) => f.path)).toContain('/Documents/a.md');
  });

  it('a re-added path with no ledger row is reported unresolved, never silently dropped or invented', () => {
    const r = resolveSelectionRows(rows, [], ['/Documents/ghost.md']);
    expect(r.unresolvedReaddPaths).toEqual(['/Documents/ghost.md']);
    expect(r.files.map((f) => f.path)).not.toContain('/Documents/ghost.md');
  });

  it('carries itemId and derives the containing folder for the fetch', () => {
    const r = resolveSelectionRows(rows, [], []);
    expect(r.files[0]).toEqual({
      itemId: 'i-/Documents/a.md',
      name: 'a.md',
      path: '/Documents/a.md',
      remotePath: '/Documents',
      size: 1000,
    });
    expect(parentPathOf('/loose.md')).toBe('/');
  });
});

describe('firstOutOfScopePath — JRN-8, pure', () => {
  const consented = (
    target: { folderId: string | null; folderPath: string | null } | null,
    exclusions: string[] = []
  ): MapConsentCheck => ({
    active: true,
    consentId: 'c',
    disclosureSha256: null,
    target,
    exclusions,
  });
  const files = resolveSelectionRows(
    [row('/Team/a.md', 'selected'), row('/Team/Private/tax.pdf', 'selected')],
    [],
    []
  ).files;

  it('a whole-drive grant with no exclusions admits everything', () => {
    expect(firstOutOfScopePath(files, consented(null))).toBeNull();
    expect(firstOutOfScopePath(files, consented({ folderId: null, folderPath: null }))).toBeNull();
  });

  it('names the first row outside the consented target', () => {
    const hit = firstOutOfScopePath(files, consented({ folderId: 'fld-x', folderPath: '/Other' }));
    expect(hit).toEqual({ path: '/Team/Private/tax.pdf', reason: 'outside_target' });
  });

  it('names the first row inside a recorded exclusion', () => {
    const hit = firstOutOfScopePath(files, consented(null, ['/Team/Private']));
    expect(hit).toEqual({ path: '/Team/Private/tax.pdf', reason: 'consent_excluded' });
  });
});

describe('verifySelectiveIngestConsent — fail closed, scope-distinct', () => {
  it('an ACTIVE ingest_content grant is active, with its evidence AND its scope (JRN-8)', async () => {
    seedIngestConsent({
      target: { folderId: 'fld-docs', folderPath: '/Documents' },
      exclusions: ['/Documents/Private'],
    });
    expect(await activities.verifySelectiveIngestConsent(TENANT, CONN)).toEqual({
      active: true,
      consentId: 'c-ingest',
      disclosureSha256: 'sha-d',
      target: { folderId: 'fld-docs', folderPath: '/Documents' },
      exclusions: ['/Documents/Private'],
    });
  });

  it("the map's map_metadata consent does NOT satisfy ingest_content — mapping names is not permission to open files", async () => {
    data.connector_consents = [
      {
        tenantId: TENANT,
        connectionId: CONN,
        consentId: 'c-map',
        action: 'granted',
        revokesConsentId: null,
        scope: 'map_metadata',
        grantedAt: '2026-08-19',
      },
    ];
    expect((await activities.verifySelectiveIngestConsent(TENANT, CONN)).active).toBe(false);
  });

  it('a revoked grant is inactive — the derivation, not a status field, is the check', async () => {
    seedIngestConsent();
    data.connector_consents!.push({
      tenantId: TENANT,
      connectionId: CONN,
      consentId: 'c-2',
      action: 'revoked',
      revokesConsentId: 'c-ingest',
      scope: INGEST_CONSENT_SCOPE,
      grantedAt: '2026-08-20',
    });
    expect((await activities.verifySelectiveIngestConsent(TENANT, CONN)).active).toBe(false);
  });

  it('an empty stream is inactive (fail closed)', async () => {
    expect((await activities.verifySelectiveIngestConsent(TENANT, CONN)).active).toBe(false);
  });
});

function seedSuggestions(rows: MapSuggestionRow[], extra: Record<string, any> = {}) {
  data[MAP_SUGGESTIONS_COLLECTION] = [
    {
      tenantId: TENANT,
      runId: RUN,
      connectionId: CONN,
      funnelPolicyVersion: '1.0.0-rc1',
      funnelPolicySha256: 'f'.repeat(64),
      rows,
      rowsTruncated: false,
      rowsOmitted: 0,
      rowCap: 20000,
      ...extra,
    },
  ];
}

function seedSelection(extra: Record<string, any> = {}) {
  data[MAP_SELECTIONS_COLLECTION] = [
    {
      tenantId: TENANT,
      connectionId: CONN,
      runId: RUN,
      removedPaths: [],
      readdedPaths: [],
      decidedAt: '2026-08-20T10:00:00.000Z',
      ...extra,
    },
  ];
}

describe('resolveSelectiveIngestPlan — named refusals, honest counts', () => {
  it('refuses by name when no ACTIVE ingest consent exists at resolution time (JRN-8, fail closed)', async () => {
    seedSelection();
    seedSuggestions([row('/Documents/a.md', 'selected')]);
    // No consent seeded at all.
    await expect(activities.resolveSelectiveIngestPlan(TENANT, CONN)).rejects.toMatchObject({
      type: 'NoActiveIngestConsent',
    });
  });

  it('refuses by name when no decision exists — this workflow never guesses a selection', async () => {
    seedIngestConsent();
    await expect(activities.resolveSelectiveIngestPlan(TENANT, CONN)).rejects.toMatchObject({
      type: 'NoSelectionOnRecord',
    });
  });

  it('refuses by name when the named suggestions document is missing', async () => {
    seedIngestConsent();
    seedSelection();
    await expect(activities.resolveSelectiveIngestPlan(TENANT, CONN)).rejects.toMatchObject({
      type: 'MapSuggestionsMissing',
    });
  });

  it('refuses by name when the suggestions ledger was truncated — a partial ledger must not silently ingest a subset', async () => {
    seedIngestConsent();
    seedSelection();
    seedSuggestions([row('/Documents/a.md', 'selected')], {
      rowsTruncated: true,
      rowsOmitted: 5,
      rowCap: 20000,
    });
    await expect(activities.resolveSelectiveIngestPlan(TENANT, CONN)).rejects.toMatchObject({
      type: 'SuggestionRowsTruncated',
    });
  });

  it('JRN-8: refuses, TYPED, when a resolved row falls outside the consented target — never a silent subset', async () => {
    seedIngestConsent({ target: { folderId: 'fld-docs', folderPath: '/Documents' } });
    seedSelection();
    seedSuggestions([
      row('/Documents/a.md', 'selected'),
      row('/Elsewhere/leak.md', 'selected'),
    ]);
    await expect(activities.resolveSelectiveIngestPlan(TENANT, CONN)).rejects.toMatchObject({
      type: SELECTION_OUT_OF_SCOPE_ERROR_TYPE,
      message: expect.stringContaining('/Elsewhere/leak.md'),
    });
  });

  it('JRN-8: refuses, TYPED, when a resolved row sits inside a recorded exclusion — a re-add cannot override the carve-out', async () => {
    seedIngestConsent({ exclusions: ['/Documents/Private'] });
    seedSelection({ readdedPaths: ['/Documents/Private/tax.pdf'] });
    seedSuggestions([
      row('/Documents/a.md', 'selected'),
      row('/Documents/Private/tax.pdf', 'subtracted:receipt_shape'),
    ]);
    await expect(activities.resolveSelectiveIngestPlan(TENANT, CONN)).rejects.toMatchObject({
      type: SELECTION_OUT_OF_SCOPE_ERROR_TYPE,
      message: expect.stringContaining('exclusion'),
    });
  });

  it('resolves the LATEST decision (by decidedAt) with counts and provenance, never the file list', async () => {
    seedIngestConsent();
    seedSuggestions([
      row('/Documents/a.md', 'selected', 'i-a', 100),
      row('/Documents/b.md', 'selected', 'i-b', 200),
      row('/Documents/r.pdf', 'subtracted:receipt_shape', 'i-r', 400),
    ]);
    data[MAP_SELECTIONS_COLLECTION] = [
      {
        tenantId: TENANT,
        connectionId: CONN,
        runId: RUN,
        removedPaths: ['/Documents/a.md', '/Documents/b.md', '/Documents/r.pdf'],
        readdedPaths: [],
        decidedAt: '2026-08-19T00:00:00.000Z', // superseded decision
      },
      {
        tenantId: TENANT,
        connectionId: CONN,
        runId: RUN,
        removedPaths: [],
        readdedPaths: ['/Documents/r.pdf', '/Documents/ghost.md'],
        decidedAt: '2026-08-20T10:00:00.000Z', // the decision in force
      },
    ];
    const plan = await activities.resolveSelectiveIngestPlan(TENANT, CONN);
    expect(plan).toMatchObject({
      mapRunId: RUN,
      decidedAt: '2026-08-20T10:00:00.000Z',
      selectedFiles: 3, // a, b, and the re-added receipt
      selectedBytes: 700,
      unresolvedReaddPaths: ['/Documents/ghost.md'],
      unresolvedReaddsOmitted: 0,
      funnelPolicyVersion: '1.0.0-rc1',
    });
    expect(plan).not.toHaveProperty('files');
  });
});

describe('listSelectedIngestBatch — deterministic pages, mid-run change refusal', () => {
  beforeEach(() => {
    seedIngestConsent();
    seedSelection();
    seedSuggestions([
      row('/Documents/a.md', 'selected', 'i-a'),
      row('/Documents/b.md', 'selected', 'i-b'),
      row('/Documents/c.md', 'selected', 'i-c'),
    ]);
  });

  it('pages the resolved selection in path order with an exclusive cursor', async () => {
    const p1 = await activities.listSelectedIngestBatch(
      TENANT,
      CONN,
      RUN,
      '2026-08-20T10:00:00.000Z',
      null,
      2
    );
    expect(p1.files.map((f) => f.itemId)).toEqual(['i-a', 'i-b']);
    expect(p1.nextAfterPath).toBe('/Documents/b.md');
    const p2 = await activities.listSelectedIngestBatch(
      TENANT,
      CONN,
      RUN,
      '2026-08-20T10:00:00.000Z',
      p1.nextAfterPath,
      2
    );
    expect(p2.files.map((f) => f.itemId)).toEqual(['i-c']);
    expect(p2.nextAfterPath).toBeNull();
  });

  it('refuses terminally when the decision moved mid-run — an ingest spanning two decisions is void', async () => {
    await expect(
      activities.listSelectedIngestBatch(TENANT, CONN, RUN, '2026-08-19T00:00:00.000Z', null, 2)
    ).rejects.toMatchObject({ type: 'SelectionChangedMidRun' });
  });

  it('JRN-8: a consent re-granted narrower mid-ingest refuses the NEXT batch, typed', async () => {
    // The up-front check passed under the wide grant; between batches the
    // grant is revoked and re-granted with a narrower target. The very next
    // resolution refuses — fail closed at every page, not only at minute 0.
    data.connector_consents!.push(
      {
        tenantId: TENANT,
        connectionId: CONN,
        consentId: 'c-rev',
        action: 'revoked',
        revokesConsentId: 'c-ingest',
        scope: INGEST_CONSENT_SCOPE,
        grantedAt: '2026-08-21',
      },
      {
        tenantId: TENANT,
        connectionId: CONN,
        consentId: 'c-narrow',
        action: 'granted',
        revokesConsentId: null,
        scope: INGEST_CONSENT_SCOPE,
        grantedAt: '2026-08-21',
        target: { folderId: 'fld-x', folderPath: '/Elsewhere' },
        exclusions: [],
      }
    );
    await expect(
      activities.listSelectedIngestBatch(TENANT, CONN, RUN, '2026-08-20T10:00:00.000Z', null, 2)
    ).rejects.toMatchObject({ type: SELECTION_OUT_OF_SCOPE_ERROR_TYPE });
  });
});

describe('the per-folder denominators (34-S14f)', () => {
  const f = (path: string, size = 100) => ({
    itemId: `i-${path}`,
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    remotePath: path.slice(0, path.lastIndexOf('/')) || '/',
    size,
  });

  it('groups the approved selection by folder, in the order the ingest walks it', () => {
    const { folderTotals, folderTotalsOmitted } = folderTotalsOf([
      f('/Documents/a.md', 10),
      f('/Documents/b.md', 20),
      f('/notes/z.md', 5),
    ]);
    expect(folderTotals).toEqual([
      { path: '/Documents', selected: 2, selectedBytes: 30 },
      { path: '/notes', selected: 1, selectedBytes: 5 },
    ]);
    expect(folderTotalsOmitted).toBe(0);
  });

  it('caps the ITEMIZATION and counts the folders it dropped — never the arithmetic', () => {
    // The cap bounds a polled document, not the truth: files in an omitted
    // folder still count in the run's totals, and the omitted FOLDER count is
    // stated rather than left to be noticed.
    const files = Array.from({ length: MAX_FOLDER_ROLLUP_ENTRIES + 3 }, (_, i) =>
      // zero-padded so codepoint order is folder order
      f(`/f${String(i).padStart(4, '0')}/doc.md`)
    );
    const { folderTotals, folderTotalsOmitted } = folderTotalsOf(files);
    expect(folderTotals).toHaveLength(MAX_FOLDER_ROLLUP_ENTRIES);
    expect(folderTotalsOmitted).toBe(3);
  });

  it('rides on the plan, so the workflow starts every folder at its own denominator', async () => {
    seedIngestConsent();
    seedSuggestions([
      row('/Documents/a.md', 'selected', 'i-a', 100),
      row('/Documents/b.md', 'selected', 'i-b', 200),
      row('/notes/z.md', 'selected', 'i-z', 50),
    ]);
    seedSelection();
    const plan = await activities.resolveSelectiveIngestPlan(TENANT, CONN);
    expect(plan.selectedFiles).toBe(3);
    expect(plan.folderTotals).toEqual([
      { path: '/Documents', selected: 2, selectedBytes: 300 },
      { path: '/notes', selected: 1, selectedBytes: 50 },
    ]);
    expect(plan.folderTotalsOmitted).toBe(0);
  });
});

describe('the progress mirror onto the connection document (34-S14f)', () => {
  it('writes lastIngestProgress where a route can actually serve it', async () => {
    // `selective_ingest_runs` is the canonical record; the connections
    // listing is the one document a polling UI already receives. A
    // denominator written only where no route can see it is the same
    // "declared but unreachable" defect 34-S14d fixed for `skipped`.
    data.connector_connections = [{ connectionId: CONN, tenantId: TENANT }];

    await activities.updateSelectiveIngestRun(
      TENANT,
      'ingest-conn-map-1',
      {
        selected: 10,
        done: 4,
        ingested: 2,
        skipped: 1,
        failed: 0,
        deferred: 1,
        skippedByReason: { too_large: 1 },
        currentPath: '/Documents/b.md',
        folders: [
          { path: '/Documents', selected: 10, ingested: 2, skipped: 1, failed: 0, deferred: 1 },
        ],
        foldersTruncated: false,
        foldersOmitted: 0,
      },
      CONN
    );

    const mirrored = data.connector_connections[0].lastIngestProgress;
    expect(mirrored).toMatchObject({
      runId: 'ingest-conn-map-1',
      status: 'ingesting',
      selected: 10,
      done: 4,
      ingested: 2,
      skipped: 1,
      failed: 0,
      deferred: 1,
      skippedByReason: { too_large: 1 },
      currentPath: '/Documents/b.md',
      foldersTruncated: false,
      foldersOmitted: 0,
    });
    expect(mirrored.folders).toHaveLength(1);
    // The canonical record is still the run document — and this flush is an
    // update, not an upsert, so with no started run there is nothing to match.
    expect(data[SELECTIVE_INGEST_RUNS_COLLECTION] ?? []).toHaveLength(0);
  });

  it('mirrors the TERMINAL state too — a polling screen learns the run ended from the field it watched', async () => {
    data.connector_connections = [{ connectionId: CONN, tenantId: TENANT }];
    await activities.finalizeSelectiveIngestRun(TENANT, 'ingest-conn-map-1', CONN, 'complete', {
      selected: 10,
      done: 10,
      ingested: 9,
      failed: 1,
    });
    expect(data.connector_connections[0].lastIngestProgress).toMatchObject({
      status: 'complete',
      selected: 10,
      done: 10,
    });
  });

  it('a three-argument call (an in-flight execution from an older release) still writes the run doc and mirrors nothing', async () => {
    data.connector_connections = [{ connectionId: CONN, tenantId: TENANT }];
    data[SELECTIVE_INGEST_RUNS_COLLECTION] = [{ runId: 'wf-old', tenantId: TENANT }];
    await activities.updateSelectiveIngestRun(TENANT, 'wf-old', { selected: 3, ingested: 1 });
    expect(data[SELECTIVE_INGEST_RUNS_COLLECTION]![0]).toMatchObject({ selected: 3, ingested: 1 });
    expect(data.connector_connections[0].lastIngestProgress).toBeUndefined();
  });
});

describe('finalizeSelectiveIngestRun — evidence even for refusals', () => {
  it('upserts a terminal record when no run doc was ever started', async () => {
    await activities.finalizeSelectiveIngestRun(TENANT, 'wf-1', CONN, 'refused_no_consent', {
      provider: 'onedrive',
    });
    const docs = data[SELECTIVE_INGEST_RUNS_COLLECTION]!;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      tenantId: TENANT,
      runId: 'wf-1',
      status: 'refused_no_consent',
      provider: 'onedrive',
    });
    expect(docs[0].finishedAt).toBeInstanceOf(Date);
  });
});
