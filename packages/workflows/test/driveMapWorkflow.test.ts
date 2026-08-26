// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { driveMapWorkflow } from '../src/workflows/driveMap';
import {
  appendNarration,
  fmtBytes,
  fmtInt,
  leadingClassByBytes,
  MAX_TOP_FOLDER_ROLLUPS,
  NARRATION_MAX_LINES,
  CONSENT_EXCLUDED_RULE,
  MAP_OUT_OF_SCOPE_ERROR_TYPE,
  DEFAULT_TASK_QUEUE,
  type NarrationLine,
} from '../src/index';
import * as workflowBundle from '../src/workflows/index';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = join(TEST_DIR, '../src/workflows/index.ts');

// A real time-skipping local Temporal server is the only way to genuinely
// exercise continueAsNew, retry, and failure-handling behavior — not just
// type-check the file.
describe('driveMapWorkflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  const baseConnection = {
    connectionId: 'conn-map-1',
    tenantId: 'ACME-01',
    provider: 'onedrive',
    driveId: 'drive-1',
    rootFolderId: null,
    defaultLabel: 'general',
    deltaLink: null,
  };

  const ARTIFACT = { artifactVersion: '1.0.0-rc2', artifactSha256: 'sha-test' };

  function fileItem(id: string, name: string, size: number, classId: string, path: string) {
    return {
      id,
      name,
      isFolder: false,
      size,
      childCount: null,
      path,
      classId,
      rule: `extension:${name.split('.').pop()}`,
      shouldWalk: false,
    };
  }

  function folderItem(
    id: string,
    name: string,
    path: string,
    opts: { classId?: string; rule?: string; size?: number; childCount?: number | null } = {}
  ) {
    const classId = opts.classId ?? 'container';
    return {
      id,
      name,
      isFolder: true,
      size: opts.size ?? 0,
      childCount: opts.childCount ?? null,
      path,
      classId,
      rule: opts.rule ?? 'is_folder',
      shouldWalk: classId !== 'machine_generated',
    };
  }

  function baseActivities(overrides: Record<string, (...args: any[]) => Promise<any>> = {}) {
    return {
      getConnection: async () => baseConnection,
      checkMapEgressAllowed: async () => {},
      verifyMapConsent: async () => ({
        active: true,
        consentId: 'consent-1',
        disclosureSha256: 'disclosure-sha',
        // JRN-8 — a whole-drive grant with no carve-outs is the neutral case.
        target: null,
        exclusions: [],
      }),
      startMapRun: async () => ({ ...ARTIFACT }),
      updateMapRunProgress: async () => {},
      finalizeMapRun: async () => {},
      listMapFolderPage: async () => ({ items: [], ...ARTIFACT }),
      // 34-S11b — the candidates spool and the funnel at finalize. Behaviour
      // has its own suites (mapFunnelActivities/driveMapFunnel); these
      // defaults just keep the walk-focused tests here runnable.
      appendMapCandidates: async () => 0,
      writeMapSuggestions: async () => ({
        funnelPolicyVersion: '1.0.0-rc1',
        candidateFiles: 0,
        candidateBytes: 0,
        subtractedFiles: 0,
        defaultSelectionFiles: 0,
        defaultSelectionBytes: 0,
        rowsKept: 0,
        rowsTruncated: false,
        rowsOmitted: 0,
      }),
      ...overrides,
    };
  }

  it('refuses without an active map_metadata consent BEFORE any provider call — fail closed', async () => {
    let listCalled = false;
    let startCalled = false;
    let egressCalled = false;
    const finalizeCalls: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-no-consent',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        verifyMapConsent: async () => ({
          active: false,
          consentId: null,
          disclosureSha256: null,
          target: null,
          exclusions: [],
        }),
        checkMapEgressAllowed: async () => {
          egressCalled = true;
        },
        startMapRun: async () => {
          startCalled = true;
          return { ...ARTIFACT };
        },
        listMapFolderPage: async () => {
          listCalled = true;
          return { items: [], ...ARTIFACT };
        },
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId: `test-map-no-consent-${Date.now()}`,
        taskQueue: 'test-map-no-consent',
        args: [{ connectionId: 'conn-map-1' }],
      })
    );

    expect(result).toContain('[REFUSED_NO_CONSENT]');
    // NOT ONE provider call, and no run doc was ever opened at 'mapping':
    // the refusal is the run's whole life.
    expect(listCalled).toBe(false);
    expect(startCalled).toBe(false);
    expect(egressCalled).toBe(false);
    expect(finalizeCalls).toHaveLength(1);
    const [tenantId, , connectionId, status, snapshot] = finalizeCalls[0];
    expect(tenantId).toBe('ACME-01');
    expect(connectionId).toBe('conn-map-1');
    expect(status).toBe('refused_no_consent');
    // The refusal doc is audit evidence, and startMapRun never ran for it —
    // so it must say which provider was refused without a join to
    // connector_connections.
    expect(snapshot.provider).toBe('onedrive');
    expect((snapshot.narration as NarrationLine[]).some((l) => l.kind === 'chk')).toBe(true);
  }, 30_000);

  it('finalizes an unported provider honestly as unsupported_provider without a provider call', async () => {
    let listCalled = false;
    const finalizeCalls: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-unsupported',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        getConnection: async () => ({ ...baseConnection, provider: 'other_drive' }),
        listMapFolderPage: async () => {
          listCalled = true;
          return { items: [], ...ARTIFACT };
        },
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId: `test-map-unsupported-${Date.now()}`,
        taskQueue: 'test-map-unsupported',
        args: [{ connectionId: 'conn-map-1' }],
      })
    );

    expect(result).toContain('[UNSUPPORTED_PROVIDER]');
    expect(listCalled).toBe(false);
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0][3]).toBe('unsupported_provider');
  }, 30_000);

  // ── JRN-8: the grant's target bounds the walk ─────────────────────────────
  it('JRN-8: refuses, TYPED, when the mapped root is outside the consented target — no provider call, run doc as evidence', async () => {
    let listCalled = false;
    const finalizeCalls: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-out-of-scope',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        // Connection maps the DRIVE ROOT, but the human consented to one
        // subtree. Walking the root would enumerate siblings the grant never
        // covered — the exact hole JRN-8 names.
        verifyMapConsent: async () => ({
          active: true,
          consentId: 'consent-1',
          disclosureSha256: 'disclosure-sha',
          target: { folderId: 'fld-team', folderPath: '/Team' },
          exclusions: [],
        }),
        listMapFolderPage: async () => {
          listCalled = true;
          return { items: [], ...ARTIFACT };
        },
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const err: any = await worker
      .runUntil(
        testEnv.client.workflow.execute(driveMapWorkflow, {
          workflowId: `test-map-oos-${Date.now()}`,
          taskQueue: 'test-map-out-of-scope',
          args: [{ connectionId: 'conn-map-1' }],
        })
      )
      .then(
        () => null,
        (e) => e
      );

    expect(err).not.toBeNull();
    expect(String(err.cause?.type)).toBe(MAP_OUT_OF_SCOPE_ERROR_TYPE);
    expect(listCalled).toBe(false);
    // The run document says out-of-scope — refusal evidence, not a generic
    // 'failed' (and exactly one finalize: the typed throw after the refusal
    // finalize must not double-finalize through the catch).
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0][3]).toBe('refused_out_of_scope');
    expect(finalizeCalls[0][4].provider).toBe('onedrive');
  }, 30_000);

  // ── JRN-8: THE MUTATION CHECK. A consent exclusion prunes AT THE BOUNDARY,
  // recorded under 'consent_excluded'. The page map below has NO entry for
  // the excluded folder: remove the prune conjunct in driveMap.ts and the
  // walk descends, the mock throws, and this test goes red. ─────────────────
  it('JRN-8 mutation check: a consent-excluded subtree is pruned at the boundary, never descended, and REPORTED in the ledger', async () => {
    const fetches: (string | null)[] = [];
    const appendCalls: any[] = [];
    const finalizeCalls: any[] = [];
    const pages: Record<string, any> = {
      root: {
        items: [
          folderItem('fld-docs', 'Documents', '/Documents', { childCount: 1 }),
          // Walkable by CLASS (container) — only the consent exclusion stops
          // the descent, which is exactly what the mutation check needs.
          folderItem('fld-priv', 'Private', '/Private', {
            childCount: 2,
            size: 7_000_000,
          }),
          fileItem('f-loose', 'notes.md', 1000, 'human_prose', '/notes.md'),
          // A consent-excluded FILE: never spooled as a candidate.
          fileItem('f-secret', 'secret.md', 500, 'human_prose', '/Private-notes/secret.md'),
        ],
        ...ARTIFACT,
      },
      'fld-docs': {
        items: [fileItem('f-a', 'a.md', 2000, 'human_prose', '/Documents/a.md')],
        ...ARTIFACT,
      },
      // deliberately NO 'fld-priv' entry — descending is the mutation.
    };
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-consent-prune',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        verifyMapConsent: async () => ({
          active: true,
          consentId: 'consent-1',
          disclosureSha256: 'disclosure-sha',
          target: null, // whole drive consented…
          exclusions: ['/Private', '/Private-notes/secret.md'], // …minus these
        }),
        listMapFolderPage: async (
          _tenantId: string,
          _connectionId: string,
          folderId: string | null
        ) => {
          fetches.push(folderId);
          const page = pages[folderId ?? 'root'];
          if (!page) throw new Error(`unexpected fetch of folder ${folderId} — consent prune leaked`);
          return page;
        },
        appendMapCandidates: async (_t: string, _r: string, _c: string, items: any[]) => {
          appendCalls.push(items.map((i) => i.path));
          return items.length;
        },
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId: `test-map-consent-prune-${Date.now()}`,
        taskQueue: 'test-map-consent-prune',
        args: [{ connectionId: 'conn-map-1' }],
      })
    );

    expect(result).toContain('[SUCCESS]');
    // The excluded folder was NEVER fetched.
    expect(fetches).toEqual([null, 'fld-docs']);

    const [, , , status, snapshot] = finalizeCalls[0];
    expect(status).toBe('complete');
    // REPORTED, not silently subtracted: the prune manifest names the
    // exclusion under its own rule, with its unopened bytes…
    expect(snapshot.pruneManifest).toEqual([
      { path: '/Private', rule: CONSENT_EXCLUDED_RULE, size: 7_000_000 },
    ]);
    // …the reconciliation carries those bytes…
    expect(snapshot.reconciliation).toEqual({
      enumeratedFileBytes: 1000 + 500 + 2000,
      prunedFolderBytes: 7_000_000,
    });
    expect(snapshot.progress.foldersPruned).toBe(1);
    // …and the narration says the human's carve-out did it.
    const narration = snapshot.narration as NarrationLine[];
    expect(
      narration.some((l) => l.text.includes('/Private') && l.text.includes(CONSENT_EXCLUDED_RULE))
    ).toBe(true);
    // The excluded FILE never reached the candidates spool; the others did.
    expect(appendCalls.flat()).toContain('/notes.md');
    expect(appendCalls.flat()).toContain('/Documents/a.md');
    expect(appendCalls.flat()).not.toContain('/Private-notes/secret.md');
  }, 30_000);

  it('prunes at the folder boundary — records the subtree, never descends — and reconciles bytes', async () => {
    const fetches: { folderId: string | null; pageUrl?: string; tenantId: string }[] = [];
    const finalizeCalls: any[] = [];
    const progressTenantIds: string[] = [];
    const pages: Record<string, any> = {
      root: {
        items: [
          folderItem('fld-docs', 'Documents', '/Documents', { childCount: 2 }),
          folderItem('fld-nm', 'node_modules', '/node_modules', {
            classId: 'machine_generated',
            rule: 'prune_self:node_modules',
            size: 4_200_000_000,
            childCount: 900,
          }),
          fileItem('f-notes', 'notes.md', 1000, 'human_prose', '/notes.md'),
        ],
        ...ARTIFACT,
      },
      'fld-docs': {
        items: [
          fileItem('f-report', 'report.pdf', 2000, 'human_prose', '/Documents/report.pdf'),
          fileItem('f-app', 'app.py', 3000, 'human_source', '/Documents/app.py'),
        ],
        ...ARTIFACT,
      },
    };
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-prune',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listMapFolderPage: async (
          tenantId: string,
          _connectionId: string,
          folderId: string | null,
          _folderPath: string,
          pageUrl?: string
        ) => {
          fetches.push({ folderId, pageUrl, tenantId });
          const page = pages[folderId ?? 'root'];
          if (!page) throw new Error(`unexpected fetch of folder ${folderId} — prune leaked`);
          return page;
        },
        updateMapRunProgress: async (tenantId: string) => {
          progressTenantIds.push(tenantId);
        },
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId: `test-map-prune-${Date.now()}`,
        taskQueue: 'test-map-prune',
        args: [{ connectionId: 'conn-map-1' }],
      })
    );

    expect(result).toContain('[SUCCESS]');
    // The pruned folder was NEVER fetched — the walk descended only into
    // Documents.
    expect(fetches.map((f) => f.folderId)).toEqual([null, 'fld-docs']);
    // tenant_id on every emitted call — tenant isolation is absolute.
    expect(fetches.every((f) => f.tenantId === 'ACME-01')).toBe(true);
    expect(progressTenantIds).toEqual(['ACME-01', 'ACME-01']);

    expect(finalizeCalls).toHaveLength(1);
    const [, , , status, snapshot] = finalizeCalls[0];
    expect(status).toBe('complete');
    expect(snapshot.pruneManifest).toEqual([
      { path: '/node_modules', rule: 'prune_self:node_modules', size: 4_200_000_000 },
    ]);
    expect(snapshot.reconciliation).toEqual({
      enumeratedFileBytes: 6000,
      prunedFolderBytes: 4_200_000_000,
    });
    expect(snapshot.aggregates.folders).toBe(2);
    expect(snapshot.aggregates.maxDepth).toBe(1);
    expect(snapshot.aggregates.perClass).toEqual({
      human_prose: { files: 2, bytes: 3000 },
      human_source: { files: 1, bytes: 3000 },
    });
    expect(snapshot.progress).toMatchObject({
      itemsSeen: 5,
      foldersWalked: 2,
      foldersPruned: 1,
      pagesFetched: 2,
    });
    // Top-level rollup: Documents' subtree, node_modules' row, and the
    // root's own loose file under '/'.
    const byName = Object.fromEntries(snapshot.topFolders.map((t: any) => [t.name, t]));
    expect(byName['Documents']).toMatchObject({ files: 2, folders: 1, bytes: 5000 });
    expect(byName['node_modules']).toMatchObject({ files: 0, folders: 1 });
    expect(byName['/']).toMatchObject({ files: 1, bytes: 1000 });
    expect(snapshot.rollupTruncated).toBe(false);
    // Narration: the prune said its name, and the close reconciled.
    const narration = snapshot.narration as NarrationLine[];
    expect(narration.some((l) => l.kind === 'sum' && l.text.includes('/node_modules'))).toBe(true);
    expect(narration.some((l) => l.kind === 'chk' && l.text.includes('accounted for'))).toBe(true);
    expect(narration.every((l) => l.tier === 'none')).toBe(true);
  }, 30_000);

  it('continues as new on the page threshold and the resumed run never re-walks a finished folder', async () => {
    const fetches: { folderId: string | null; pageUrl?: string }[] = [];
    let startCalls = 0;
    let consentCalls = 0;
    const finalizeCalls: any[] = [];
    const pages: Record<string, any> = {
      'root|': {
        items: [
          folderItem('fld-a', 'Alpha', '/Alpha', { childCount: 2 }),
          folderItem('fld-b', 'Beta', '/Beta', { childCount: 1 }),
        ],
        ...ARTIFACT,
      },
      'fld-a|': {
        items: [fileItem('f-a1', 'a1.md', 1000, 'human_prose', '/Alpha/a1.md')],
        nextLink: 'a-page-2',
        ...ARTIFACT,
      },
      'fld-a|a-page-2': {
        items: [fileItem('f-a2', 'a2.md', 1000, 'human_prose', '/Alpha/a2.md')],
        ...ARTIFACT,
      },
      'fld-b|': {
        items: [fileItem('f-b1', 'b1.md', 1000, 'human_prose', '/Beta/b1.md')],
        ...ARTIFACT,
      },
    };
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-continue-as-new',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        verifyMapConsent: async () => {
          consentCalls++;
          return {
            active: true,
            consentId: 'consent-1',
            disclosureSha256: 'disclosure-sha',
            target: null,
            exclusions: [],
          };
        },
        startMapRun: async () => {
          startCalls++;
          return { ...ARTIFACT };
        },
        listMapFolderPage: async (
          _tenantId: string,
          _connectionId: string,
          folderId: string | null,
          _folderPath: string,
          pageUrl?: string
        ) => {
          fetches.push({ folderId, pageUrl });
          return pages[`${folderId ?? 'root'}|${pageUrl ?? ''}`];
        },
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId: `test-map-can-${Date.now()}`,
        taskQueue: 'test-map-continue-as-new',
        args: [{ connectionId: 'conn-map-1', continueAsNewAfter: 1 }],
      })
    );

    // Four pages, each fetched EXACTLY once across four chained executions —
    // the resume carried the queue instead of re-walking finished folders.
    expect(fetches).toEqual([
      { folderId: null, pageUrl: undefined },
      { folderId: 'fld-a', pageUrl: undefined },
      { folderId: 'fld-a', pageUrl: 'a-page-2' },
      { folderId: 'fld-b', pageUrl: undefined },
    ]);
    // The run doc was created once (fresh execution only)…
    expect(startCalls).toBe(1);
    // …but consent is re-verified on EVERY hop: a revocation at minute 28
    // stops the map at the next continueAsNew, fail closed.
    expect(consentCalls).toBe(4);
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0][3]).toBe('complete');
    expect(result).toContain('itemsSeen=5');
    expect(result).toContain('foldersWalked=3');
    expect(result).toContain('pagesFetched=4');
  }, 30_000);

  it('honors a Graph 429 as a retry (nextRetryDelay from Retry-After), then completes', async () => {
    let calls = 0;
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-throttled',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listMapFolderPage: async () => {
          calls++;
          if (calls === 1) {
            // Exactly what map.ts's graphThrottleFailure throws — the
            // server-side retry waits the 3s Graph asked for (free under
            // time-skipping) instead of the policy's own backoff.
            throw ApplicationFailure.create({
              message: 'Graph throttled the map (HTTP 429, Retry-After 3s)',
              type: 'GraphThrottled',
              nextRetryDelay: '3s',
            });
          }
          return {
            items: [fileItem('f-1', 'a.md', 100, 'human_prose', '/a.md')],
            ...ARTIFACT,
          };
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId: `test-map-throttled-${Date.now()}`,
        taskQueue: 'test-map-throttled',
        args: [{ connectionId: 'conn-map-1' }],
      })
    );

    expect(calls).toBe(2);
    expect(result).toContain('[SUCCESS]');
  }, 30_000);

  it('finalizes the run as failed (never stuck at mapping) when the walk exhausts retries', async () => {
    const finalizeCalls: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-failure',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listMapFolderPage: async () => {
          throw new Error('Graph API unreachable');
        },
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(driveMapWorkflow, {
          workflowId: `test-map-failure-${Date.now()}`,
          taskQueue: 'test-map-failure',
          args: [{ connectionId: 'conn-map-1' }],
        })
      )
    ).rejects.toThrow();

    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0][3]).toBe('failed');
  }, 30_000);

  it('fails the run loudly if the rule artifact changes mid-run instead of blending two rule sets', async () => {
    const finalizeCalls: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-artifact-drift',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        // startMapRun pinned sha-test; the page claims different bytes.
        listMapFolderPage: async () => ({
          items: [],
          artifactVersion: '1.0.0-rc3',
          artifactSha256: 'sha-drifted',
        }),
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const err: any = await worker
      .runUntil(
        testEnv.client.workflow.execute(driveMapWorkflow, {
          workflowId: `test-map-artifact-drift-${Date.now()}`,
          taskQueue: 'test-map-artifact-drift',
          args: [{ connectionId: 'conn-map-1' }],
        })
      )
      .then(
        () => null,
        (e) => e
      );

    expect(err).not.toBeNull();
    // WorkflowFailedError's own message is generic — the drift refusal lives
    // on the cause chain.
    expect(String(err.cause?.message ?? err.message)).toMatch(/two rule sets/);
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0][3]).toBe('failed');
  }, 30_000);

  it('records the top-folder rollup cap when it bites — rollupTruncated:true, omissions counted, never silent', async () => {
    const fetches: any[] = [];
    const finalizeCalls: any[] = [];
    const manyFolders = Array.from({ length: MAX_TOP_FOLDER_ROLLUPS + 1 }, (_, i) =>
      // childCount 0: a leaf folder is counted but never listed (no no-op
      // provider call), so this whole test is one root page.
      folderItem(`fld-${i}`, `Folder-${i}`, `/Folder-${i}`, { childCount: 0 })
    );
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-rollup-cap',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listMapFolderPage: async (...args: any[]) => {
          fetches.push(args);
          return { items: manyFolders, ...ARTIFACT };
        },
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId: `test-map-rollup-cap-${Date.now()}`,
        taskQueue: 'test-map-rollup-cap',
        args: [{ connectionId: 'conn-map-1' }],
      })
    );

    expect(result).toContain('[SUCCESS]');
    expect(fetches).toHaveLength(1);
    const [, , , , snapshot] = finalizeCalls[0];
    expect(snapshot.topFolders).toHaveLength(MAX_TOP_FOLDER_ROLLUPS);
    expect(snapshot.rollupTruncated).toBe(true);
    expect(snapshot.topFoldersOmitted).toBe(1);
    // The capped item still counted everywhere else — only the itemization
    // was bounded.
    expect(snapshot.aggregates.folders).toBe(MAX_TOP_FOLDER_ROLLUPS + 1);
    expect(snapshot.aggregates.emptyFolders).toBe(MAX_TOP_FOLDER_ROLLUPS + 1);
  }, 30_000);

  it("corrects itself when the leading class inverts — the 'fix' line exists because the earlier sum became wrong", async () => {
    const finalizeCalls: any[] = [];
    const pages: Record<string, any> = {
      root: {
        items: [
          fileItem('f-essay', 'essay.md', 10_000, 'human_prose', '/essay.md'),
          folderItem('fld-sub', 'Sub', '/Sub', { childCount: 1 }),
        ],
        ...ARTIFACT,
      },
      'fld-sub': {
        items: [
          fileItem('f-bundle', 'bundle.min.js', 50_000, 'machine_generated', '/Sub/bundle.min.js'),
        ],
        ...ARTIFACT,
      },
    };
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-inversion',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listMapFolderPage: async (_t: string, _c: string, folderId: string | null) =>
          pages[folderId ?? 'root'],
        finalizeMapRun: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId: `test-map-inversion-${Date.now()}`,
        taskQueue: 'test-map-inversion',
        args: [{ connectionId: 'conn-map-1' }],
      })
    );

    const narration = finalizeCalls[0][4].narration as NarrationLine[];
    expect(narration.some((l) => l.kind === 'sum' && l.text.includes('human_prose leads'))).toBe(
      true
    );
    const fix = narration.find((l) => l.kind === 'fix');
    expect(fix).toBeDefined();
    expect(fix!.text).toContain('machine_generated');
    expect(fix!.text).toContain('overtaking human_prose');
  }, 30_000);
});

// ── Registration: the (type, queue) pair is pinned package-wide in
// workflowRegistration.test.ts; this block pins the bundle-side half by
// name, beside the workflow it registers. ───────────────────────────────────
describe('driveMapWorkflow registration', () => {
  it('is exported from the workflow bundle under its own name, on the default queue', () => {
    expect(typeof workflowBundle.driveMapWorkflow).toBe('function');
    expect(workflowBundle.driveMapWorkflow.name).toBe('driveMapWorkflow');
    expect(DEFAULT_TASK_QUEUE).toBe('shelfmark-queue');
  });
});

// ── Metadata-only, STRUCTURALLY (the reference walker's AST test, in this
// package's idiom): the map sources cannot grow a content endpoint silently. ─
describe('map path is metadata-only, structurally enforced', () => {
  // The file list is a literal — no input, user or otherwise, reaches this
  // join. Reading the map's own sources IS the test: it is what stops a
  // content endpoint appearing in them silently.
  const mapSources = [
    join(TEST_DIR, '../src/workflows/driveMap.ts'),
    join(TEST_DIR, '../src/activities/map.ts'),
  ].map((f) => ({ file: f, source: readFileSync(f, 'utf8') }));

  it('never references a content endpoint or raw-bytes surface', () => {
    for (const { file, source } of mapSources) {
      // Graph's file-content endpoint, and this package's own content
      // surfaces (the download-and-sink head).
      expect(source, file).not.toMatch(/\/content\b/);
      expect(source, file).not.toMatch(
        /\b(downloadFile|ingestFileBatch|processFile|DocumentSink|sink\.accept)\b/
      );
      // No direct HTTP client either — the one provider call reaches Graph
      // through @shelfmark/graph's listFolderPage (children metadata only).
      expect(source, file).not.toMatch(/\baxios\b/);
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('imports only its declared, metadata-safe modules', () => {
    const allowed: Record<string, string[]> = {
      'driveMap.ts': [
        '@temporalio/workflow',
        '../activities/connection',
        '../activities/egress',
        '../activities/map',
        './consentScope',
      ],
      'map.ts': [
        '@temporalio/activity',
        // Types, the classifier/funnel ports, and the metadata-only Graph
        // calls — the download surface lives in ingest.ts, reached by the
        // WORKFLOW's own proxy, never from here.
        '@shelfmark/core',
        '@shelfmark/graph',
        '@shelfmark/policy',
        '../deps',
        './connection',
      ],
    };
    for (const { file, source } of mapSources) {
      const base = file.slice(file.lastIndexOf('/') + 1);
      const specifiers = [...source.matchAll(/(?:from\s+|require\()\s*'([^']+)'/g)].map((m) => m[1]);
      expect(specifiers.length, base).toBeGreaterThan(0);
      for (const spec of specifiers) {
        expect(allowed[base], `${base} imports ${spec}`).toContain(spec);
      }
    }
  });
});

// ── Pure-helper units ───────────────────────────────────────────────────────
describe('narration and formatting helpers', () => {
  it('counts drops at the narration cap instead of silently swallowing lines', () => {
    const state = { narration: [] as NarrationLine[], narrationDropped: 0 };
    for (let i = 0; i < NARRATION_MAX_LINES; i++) appendNarration(state, 'sum', `line ${i}`, i);
    expect(state.narration).toHaveLength(NARRATION_MAX_LINES);
    expect(state.narrationDropped).toBe(0);
    appendNarration(state, 'chk', 'one past the cap', NARRATION_MAX_LINES);
    expect(state.narration).toHaveLength(NARRATION_MAX_LINES);
    expect(state.narrationDropped).toBe(1);
  });

  it('formats deterministically (no locale-dependent output inside workflow code)', () => {
    expect(fmtInt(15657)).toBe('15,657');
    expect(fmtInt(999)).toBe('999');
    expect(fmtBytes(4_200_000_000)).toBe('4.2 GB');
    expect(fmtBytes(3_437_000_000)).toBe('3.4 GB');
    expect(fmtBytes(61_900_000)).toBe('61.9 MB');
    expect(fmtBytes(1500)).toBe('1.5 KB');
    expect(fmtBytes(42)).toBe('42 B');
  });

  it('attributes pruned subtree bytes to machine_generated when ranking the leading class', () => {
    const leader = leadingClassByBytes(
      { human_prose: { files: 2, bytes: 5000 } },
      1_000_000 // a pruned node_modules outweighs the enumerated prose
    );
    expect(leader).toEqual({ classId: 'machine_generated', bytes: 1_000_000 });
    expect(leadingClassByBytes({}, 0)).toBeNull();
  });
});
