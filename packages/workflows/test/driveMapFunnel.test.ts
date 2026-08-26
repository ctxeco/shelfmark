// SPDX-License-Identifier: Apache-2.0
// 34-S11b — driveMapWorkflow's spool-and-funnel wiring, at the WORKFLOW
// level (real time-skipping Temporal server, mocked activities): candidates
// are flushed per page and never enter workflow state; the suggestions
// document is written exactly once, on 'complete' only, after every page —
// across continueAsNew hops included.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { driveMapWorkflow } from '../src/workflows/driveMap';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = join(TEST_DIR, '../src/workflows/index.ts');

describe('driveMapWorkflow candidates spool + funnel at finalize', () => {
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
  const SUMMARY = {
    funnelPolicyVersion: '1.0.0-rc1',
    candidateFiles: 3,
    candidateBytes: 6000,
    subtractedFiles: 1,
    defaultSelectionFiles: 2,
    defaultSelectionBytes: 5000,
    rowsKept: 3,
    rowsTruncated: false,
    rowsOmitted: 0,
  };

  function fileItem(id: string, name: string, size: number, classId: string, path: string) {
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

  function activitiesFor(
    pages: Record<string, any>,
    record: {
      appendCalls: any[];
      suggestionCalls: any[];
      finalizeCalls: any[];
      order: string[];
    },
    overrides: Record<string, (...args: any[]) => Promise<any>> = {}
  ) {
    return {
      getConnection: async () => baseConnection,
      checkMapEgressAllowed: async () => {},
      verifyMapConsent: async () => ({
        active: true,
        consentId: 'consent-1',
        disclosureSha256: 'disclosure-sha',
        target: null,
        exclusions: [],
      }),
      startMapRun: async () => ({ ...ARTIFACT }),
      updateMapRunProgress: async () => {},
      listMapFolderPage: async (
        _tenantId: string,
        _connectionId: string,
        folderId: string | null,
        _folderPath: string,
        pageUrl?: string
      ) => {
        record.order.push(`list:${folderId ?? 'root'}|${pageUrl ?? ''}`);
        return pages[`${folderId ?? 'root'}|${pageUrl ?? ''}`];
      },
      appendMapCandidates: async (
        tenantId: string,
        runId: string,
        connectionId: string,
        items: any[]
      ) => {
        record.order.push('append');
        record.appendCalls.push({ tenantId, runId, connectionId, paths: items.map((i) => i.path) });
        return items.length;
      },
      writeMapSuggestions: async (tenantId: string, runId: string, connectionId: string) => {
        record.order.push('suggest');
        record.suggestionCalls.push({ tenantId, runId, connectionId });
        return { ...SUMMARY };
      },
      finalizeMapRun: async (...args: any[]) => {
        record.order.push(`finalize:${args[3]}`);
        record.finalizeCalls.push(args);
      },
      ...overrides,
    };
  }

  it("flushes candidates once per PAGE (that page's items only, tenant-scoped) and writes suggestions exactly once, after the last page — across continueAsNew hops", async () => {
    const record = {
      appendCalls: [] as any[],
      suggestionCalls: [] as any[],
      finalizeCalls: [] as any[],
      order: [] as string[],
    };
    const pages: Record<string, any> = {
      'root|': {
        items: [fileItem('f-r', 'root.md', 1000, 'human_prose', '/root.md')],
        nextLink: 'root-page-2',
        ...ARTIFACT,
      },
      'root|root-page-2': {
        items: [
          fileItem('f-a', 'a.md', 2000, 'human_prose', '/a.md'),
          fileItem('f-py', 'app.py', 3000, 'human_source', '/app.py'),
        ],
        ...ARTIFACT,
      },
    };
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-funnel-pages',
      workflowsPath: WORKFLOWS_PATH,
      activities: activitiesFor(pages, record),
    });

    const workflowId = `test-map-funnel-${Date.now()}`;
    const result = await worker.runUntil(
      testEnv.client.workflow.execute(driveMapWorkflow, {
        workflowId,
        taskQueue: 'test-map-funnel-pages',
        // 1 page per execution: the second page arrives via a continueAsNew
        // hop, so the spool provably works across executions.
        args: [{ connectionId: 'conn-map-1', continueAsNewAfter: 1 }],
      })
    );

    // One spool flush per page, carrying exactly THAT page's items (the
    // activity filters candidates; the workflow ships the page).
    expect(record.appendCalls).toHaveLength(2);
    expect(record.appendCalls[0]).toMatchObject({
      tenantId: 'ACME-01',
      runId: workflowId,
      connectionId: 'conn-map-1',
      paths: ['/root.md'],
    });
    expect(record.appendCalls[1].paths).toEqual(['/a.md', '/app.py']);

    // Suggestions written exactly once, AFTER every page, before finalize.
    expect(record.suggestionCalls).toEqual([
      { tenantId: 'ACME-01', runId: workflowId, connectionId: 'conn-map-1' },
    ]);
    const suggestIdx = record.order.indexOf('suggest');
    expect(suggestIdx).toBeGreaterThan(record.order.lastIndexOf('append'));
    expect(record.order.indexOf('finalize:complete')).toBeGreaterThan(suggestIdx);
    expect(record.finalizeCalls).toHaveLength(1);

    // The run's result and narration carry the funnel's named numbers.
    expect(result).toContain('defaultSelectionFiles=2');
    expect(result).toContain('candidates=3');
    const narration = record.finalizeCalls[0][4].narration as { text: string }[];
    expect(narration.some((l) => l.text.includes('Default selection proposed: 2 of 3'))).toBe(true);
  }, 30_000);

  it('never writes suggestions for a run that fails mid-walk — the funnel belongs to complete runs only', async () => {
    const record = {
      appendCalls: [] as any[],
      suggestionCalls: [] as any[],
      finalizeCalls: [] as any[],
      order: [] as string[],
    };
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-funnel-failure',
      workflowsPath: WORKFLOWS_PATH,
      activities: activitiesFor({}, record, {
        listMapFolderPage: async () => {
          throw new Error('Graph API unreachable');
        },
      }),
    });

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(driveMapWorkflow, {
          workflowId: `test-map-funnel-fail-${Date.now()}`,
          taskQueue: 'test-map-funnel-failure',
          args: [{ connectionId: 'conn-map-1' }],
        })
      )
    ).rejects.toThrow();

    expect(record.suggestionCalls).toHaveLength(0);
    expect(record.finalizeCalls[0][3]).toBe('failed');
  }, 30_000);

  it('fails the run honestly when the funnel itself cannot be computed (writeMapSuggestions exhausts retries)', async () => {
    const record = {
      appendCalls: [] as any[],
      suggestionCalls: [] as any[],
      finalizeCalls: [] as any[],
      order: [] as string[],
    };
    const pages: Record<string, any> = {
      'root|': { items: [fileItem('f-r', 'root.md', 1000, 'human_prose', '/root.md')], ...ARTIFACT },
    };
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-map-funnel-suggest-fail',
      workflowsPath: WORKFLOWS_PATH,
      activities: activitiesFor(pages, record, {
        writeMapSuggestions: async () => {
          throw new Error('classifier is 1.0.0-rc3, policy pins 1.0.0-rc2');
        },
      }),
    });

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(driveMapWorkflow, {
          workflowId: `test-map-funnel-sf-${Date.now()}`,
          taskQueue: 'test-map-funnel-suggest-fail',
          args: [{ connectionId: 'conn-map-1' }],
        })
      )
    ).rejects.toThrow();

    // A map whose funnel cannot be computed finalizes 'failed' — it does not
    // complete without its suggestions.
    expect(record.finalizeCalls).toHaveLength(1);
    expect(record.finalizeCalls[0][3]).toBe('failed');
  }, 60_000);
});

// ── Candidates are ABSENT from workflow state, structurally ─────────────────
// The runtime tests above prove the rows travel as activity ARGUMENTS; this
// scan pins the other half: nothing appendMapCandidates returns is kept, and
// the continueAsNew resume state has no candidate field to keep it in — the
// map's own source-scan idiom (driveMapWorkflow.test.ts).
describe('candidates never enter workflow state (source pin)', () => {
  const source = readFileSync(join(TEST_DIR, '../src/workflows/driveMap.ts'), 'utf8');

  it('DriveMapResumeState carries no candidate rows', () => {
    const decl = source.match(/export interface DriveMapResumeState \{[\s\S]*?\n\}/);
    expect(decl).not.toBeNull();
    expect(decl![0].toLowerCase()).not.toContain('candidate');
  });

  it('the spool call is fire-and-count — its result is never assigned', () => {
    expect(source).toMatch(/await appendMapCandidates\(/);
    expect(source).not.toMatch(/(const|let|var)\s+[\w{[]+\s*=\s*await appendMapCandidates/);
  });
});
