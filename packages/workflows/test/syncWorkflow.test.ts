// SPDX-License-Identifier: Apache-2.0
// connectorSyncWorkflow against a real time-skipping local Temporal server —
// the only way to genuinely exercise continueAsNew and failure-handling
// behavior, not just type-check the workflow file.
//
// PORT NOTE: the source suite also proved a retry-failed-files pass ran once
// per fresh sync; that pass queried the platform's own documents table, which
// does not exist behind the sink boundary — see sync.ts's port note. Its
// guarantee lives on as the stable-documentId contract, pinned in
// ingestActivities.test.ts.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { connectorSyncWorkflow } from '../src/workflows/sync';
import { DEFAULT_TASK_QUEUE } from '../src/index';
import * as workflowBundle from '../src/workflows/index';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = join(TEST_DIR, '../src/workflows/index.ts');

describe('connectorSyncWorkflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  const baseConnection = {
    connectionId: 'conn-1',
    tenantId: 'ACME-01',
    provider: 'onedrive',
    driveId: 'drive-1',
    rootFolderId: null,
    defaultLabel: 'general',
    deltaLink: null,
  };

  function baseActivities(overrides: Record<string, (...args: any[]) => Promise<any>> = {}) {
    return {
      getConnection: async () => baseConnection,
      checkCloudEgressAllowed: async () => {},
      updateSyncProgress: async () => {},
      finalizeSync: async () => {},
      ingestFileBatch: async (
        _c: string,
        _t: string,
        _label: string,
        _runId: string,
        files: any[]
      ) => files.map((f) => ({ itemId: f.itemId, status: 'ingested' as const })),
      ...overrides,
    };
  }

  it('processes a single delta page and finalizes as complete', async () => {
    const finalizeCalls: any[] = [];
    const ingestArgs: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-single-page',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listRemoteDeltaPage: async () => ({
          items: [
            { id: 'f1', name: 'a.pdf', isFolder: false, size: 10, modified: '', path: '/Docs', deleted: false },
            { id: 'folder1', name: 'Sub', isFolder: true, size: 0, modified: '', path: '/', deleted: false },
            { id: 'f2', name: 'b.docx', isFolder: false, size: 10, modified: '', path: '/Docs', deleted: false },
          ],
          deltaLink: 'https://graph.microsoft.com/delta-token-final',
        }),
        ingestFileBatch: async (
          c: string,
          t: string,
          label: string,
          runId: string,
          files: any[]
        ) => {
          ingestArgs.push({ c, t, label, runId, count: files.length });
          return files.map((f) => ({ itemId: f.itemId, status: 'ingested' as const }));
        },
        finalizeSync: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    const workflowId = `test-connector-single-${Date.now()}`;
    const result = await worker.runUntil(
      testEnv.client.workflow.execute(connectorSyncWorkflow, {
        workflowId,
        taskQueue: 'test-connector-single-page',
        args: [{ connectionId: 'conn-1' }],
      })
    );

    expect(result).toMatch(/\[SUCCESS\]/);
    expect(result).toContain('discovered=2');
    expect(result).toContain('ingested=2');
    // Folders are filtered out — only the 2 real files reach ingestFileBatch,
    // with tenant, label and the workflowId-as-runId riding along.
    expect(ingestArgs).toEqual([
      { c: 'conn-1', t: 'ACME-01', label: 'general', runId: workflowId, count: 2 },
    ]);
    // 34-S14c — finalize carries the run's own summary as an appended
    // optional argument: `deltaExpiredFallbacks: 0` states "this sync did NOT
    // re-enumerate", which a completion screen needs as plainly as the
    // opposite (a field present only when true reads as missing data).
    expect(finalizeCalls).toEqual([
      [
        'conn-1',
        'complete',
        'https://graph.microsoft.com/delta-token-final',
        { deltaExpiredFallbacks: 0 },
      ],
    ]);
  }, 30_000);

  it('paginates across multiple delta pages before finalizing', async () => {
    let call = 0;
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-pagination',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listRemoteDeltaPage: async (_connectionId: string, link?: string) => {
          call++;
          if (!link) {
            return {
              items: [{ id: 'f1', name: 'a.pdf', isFolder: false, size: 1, modified: '', path: '/', deleted: false }],
              nextLink: 'page-2',
            };
          }
          return {
            items: [{ id: 'f2', name: 'b.pdf', isFolder: false, size: 1, modified: '', path: '/', deleted: false }],
            deltaLink: 'final-delta-token',
          };
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(connectorSyncWorkflow, {
        workflowId: `test-connector-pagination-${Date.now()}`,
        taskQueue: 'test-connector-pagination',
        args: [{ connectionId: 'conn-1' }],
      })
    );

    expect(call).toBe(2);
    expect(result).toContain('discovered=2');
    expect(result).toContain('ingested=2');
  }, 30_000);

  it("resumes an incremental sync from the connection's stored deltaLink, not a fresh crawl", async () => {
    let receivedLink: string | undefined;
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-incremental',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        getConnection: async () => ({
          ...baseConnection,
          deltaLink: 'https://graph.microsoft.com/existing-delta',
        }),
        listRemoteDeltaPage: async (_connectionId: string, link?: string) => {
          receivedLink = link;
          return { items: [], deltaLink: 'https://graph.microsoft.com/existing-delta' };
        },
      }),
    });

    await worker.runUntil(
      testEnv.client.workflow.execute(connectorSyncWorkflow, {
        workflowId: `test-connector-incremental-${Date.now()}`,
        taskQueue: 'test-connector-incremental',
        args: [{ connectionId: 'conn-1' }],
      })
    );

    expect(receivedLink).toBe('https://graph.microsoft.com/existing-delta');
  }, 30_000);

  it('continues as new after the configured threshold, then finishes across the resumed run', async () => {
    // THE PREVIOUS SHAPE OF THIS TEST (in the source) NEVER CONTINUED AS
    // NEW. It fed 3 files: no batch ever reached BATCH_SIZE (20), so
    // flushBatch never ran, processedSinceCheckpoint stayed 0, and the
    // threshold check never fired — both pages were fetched by ONE
    // execution's loop, while the test's comment claimed the second fetch
    // proved a resumed run. A vacuous test is how the hop's
    // finalize('failed') defect survived. This version feeds a FULL batch
    // (BATCH_SIZE files) so the checkpoint advances and the hop is real.
    let pageCalls = 0;
    const finalizeCalls: any[] = [];
    const page1Items = Array.from({ length: 20 }, (_, i) => ({
      id: `f${i}`,
      name: `file-${i}.pdf`,
      isFolder: false,
      size: 1,
      modified: '',
      path: '/',
      deleted: false,
    }));
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-continue-as-new',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        finalizeSync: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
        listRemoteDeltaPage: async (_connectionId: string, link?: string) => {
          pageCalls++;
          if (!link) {
            // 20 files fills exactly one batch: flushBatch runs, the
            // checkpoint reaches 20 >= continueAsNewAfter, and the nextLink
            // triggers a genuine continueAsNew hop.
            return { items: page1Items, nextLink: 'page-2' };
          }
          expect(link).toBe('page-2'); // the resumed run picked up the link
          return {
            items: [
              { id: 'f20', name: 'last.pdf', isFolder: false, size: 1, modified: '', path: '/', deleted: false },
            ],
            deltaLink: 'final-delta-after-continue',
          };
        },
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(connectorSyncWorkflow, {
        workflowId: `test-connector-can-${Date.now()}`,
        taskQueue: 'test-connector-continue-as-new',
        args: [{ connectionId: 'conn-1', continueAsNewAfter: 2 }],
      })
    );

    expect(pageCalls).toBe(2);
    expect(result).toContain('discovered=21');
    expect(result).toContain('ingested=21');
    // THE POINT: zero 'failed' finalizations across the hop. Without the
    // ContinueAsNew rethrow guard, the hop finalizes 'failed' on its way to
    // the next execution and this reads ['failed', 'complete'].
    expect(finalizeCalls.map((c) => c[1])).toEqual(['complete']);
  }, 30_000);

  it('marks the connection failed (not stuck at syncing) when an activity exhausts retries', async () => {
    const finalizeCalls: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-failure',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listRemoteDeltaPage: async () => {
          throw new Error('Graph API unreachable');
        },
        finalizeSync: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
      }),
    });

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(connectorSyncWorkflow, {
          workflowId: `test-connector-failure-${Date.now()}`,
          taskQueue: 'test-connector-failure',
          args: [{ connectionId: 'conn-1' }],
        })
      )
    ).rejects.toThrow();

    // The summary travels on the FAILURE path too (34-S14c). Passing nothing
    // let finalizeSync's `?? 0` write "no fallback happened" onto a sync that
    // had re-enumerated on a 410 before failing — erasing the fact that
    // explains why it was a full crawl.
    expect(finalizeCalls).toEqual([['conn-1', 'failed', undefined, { deltaExpiredFallbacks: 0 }]]);
  }, 30_000);

  it('denies the sync before any page is fetched when cloud egress is denied', async () => {
    let deltaPageCalled = false;
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-egress-denied',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        checkCloudEgressAllowed: async () => {
          throw new Error('Cloud egress denied for tenant ACME-01 at label restricted');
        },
        listRemoteDeltaPage: async () => {
          deltaPageCalled = true;
          return { items: [], deltaLink: 'unused' };
        },
      }),
    });

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(connectorSyncWorkflow, {
          workflowId: `test-connector-egress-${Date.now()}`,
          taskQueue: 'test-connector-egress-denied',
          args: [{ connectionId: 'conn-1' }],
        })
      )
    ).rejects.toThrow();

    expect(deltaPageCalled).toBe(false);
  }, 30_000);

  it('counts a sink deferral apart from a failure, and rolls skips up by their named reason (34-S14d/e)', async () => {
    // The old `else progress.failed++` counted anything that was not
    // ingested-or-skipped as a failure — so a sink deferral would have been
    // reported as a broken document, the source-divergent story the
    // four-state vocabulary exists to prevent. And a bare "skipped: 3" with
    // no reasons is the unexplained number the per-reason rollup removes.
    const progressCalls: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-four-states',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        updateSyncProgress: async (_c: string, progress: any) => {
          progressCalls.push(progress);
        },
        listRemoteDeltaPage: async () => ({
          items: [
            { id: 'ok', name: 'a.pdf', isFolder: false, size: 10, modified: '', path: '/Docs', deleted: false },
            { id: 'big', name: 'huge.pdf', isFolder: false, size: 9e9, modified: '', path: '/Docs', deleted: false },
            { id: 'vid', name: 'clip.mov', isFolder: false, size: 10, modified: '', path: '/Docs', deleted: false },
            { id: 'broke', name: 'c.pdf', isFolder: false, size: 10, modified: '', path: '/Docs', deleted: false },
            { id: 'poor', name: 'd.pdf', isFolder: false, size: 10, modified: '', path: '/Docs', deleted: false },
          ],
          deltaLink: 'final-token',
        }),
        ingestFileBatch: async (
          _c: string,
          _t: string,
          _label: string,
          _runId: string,
          files: any[]
        ) =>
          files.map((f) => {
            if (f.itemId === 'big') {
              return {
                itemId: f.itemId,
                status: 'skipped',
                skipReason: 'too_large',
                error: 'too_large: 9000000000 bytes …',
              };
            }
            if (f.itemId === 'vid') {
              return {
                itemId: f.itemId,
                status: 'skipped',
                skipReason: 'unsupported_type',
                error: 'unsupported_type: .mov …',
              };
            }
            if (f.itemId === 'broke') {
              // Deliberately long: a sink's failure text can be arbitrarily
              // long, and this field is polled and carried across every hop.
              return { itemId: f.itemId, status: 'failed', error: `No content extracted: ${'x'.repeat(5000)}` };
            }
            if (f.itemId === 'poor') {
              return { itemId: f.itemId, status: 'deferred', error: 'sink deferred: allowance exhausted' };
            }
            return { itemId: f.itemId, status: 'ingested' };
          }),
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(connectorSyncWorkflow, {
        workflowId: `test-connector-four-states-${Date.now()}`,
        taskQueue: 'test-connector-four-states',
        args: [{ connectionId: 'conn-1' }],
      })
    );

    expect(result).toContain('ingested=1');
    expect(result).toContain('skipped=2');
    expect(result).toContain('failed=1');
    // The deferral is its own number. Folded into `failed` it would say 2.
    expect(result).toContain('deferred=1');
    const last = progressCalls[progressCalls.length - 1];
    expect(last.deferred).toBe(1);
    expect(last.skippedByReason).toEqual({ too_large: 1, unsupported_type: 1 });
    // The reason travels to the polled record with the file it belongs to…
    const skipped = last.recentFiles.find((f: any) => f.name === 'clip.mov');
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toContain('unsupported_type');
    // …and is itself bounded, with the truncation MARKED rather than silent —
    // this string rides in a polled document and across every hop.
    const failed = last.recentFiles.find((f: any) => f.name === 'c.pdf');
    expect(failed.reason.length).toBeLessThanOrEqual(300 + '…[truncated]'.length);
    // …and the size the ceiling is applied to was actually passed down.
    expect(last.discovered).toBe(5);
  }, 30_000);

  it('records a delta-expiry re-enumeration instead of letting it look like a first crawl (34-S14c)', async () => {
    const finalizeCalls: any[] = [];
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-delta-expired',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        finalizeSync: async (...args: any[]) => {
          finalizeCalls.push(args);
        },
        // The ACTIVITY does the 410 detection and the fallback (proved in
        // ingestActivities.test.ts); what the workflow owes is not losing
        // the fact that it happened.
        listRemoteDeltaPage: async () => ({
          items: [{ id: 'f1', name: 'a.pdf', isFolder: false, size: 1, modified: '', path: '/', deleted: false }],
          deltaLink: 'fresh-token',
          deltaExpired: true,
        }),
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(connectorSyncWorkflow, {
        workflowId: `test-connector-delta-expired-${Date.now()}`,
        taskQueue: 'test-connector-delta-expired',
        args: [{ connectionId: 'conn-1' }],
      })
    );

    expect(result).toContain('deltaExpiredFallback=1');
    expect(finalizeCalls[0][3]).toEqual({ deltaExpiredFallbacks: 1 });
  }, 30_000);

  it("a resume carrying an OLDER release's progress object completes truthfully, not with NaN", async () => {
    // An execution that continued as new under older code carries a progress
    // object with no deferred/skippedByReason/deltaExpiredFallbacks.
    // `undefined++` is NaN, and "NaN deferred" on a completion screen is a
    // worse regression than the gap the counter fixed.
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-connector-old-progress',
      workflowsPath: WORKFLOWS_PATH,
      activities: baseActivities({
        listRemoteDeltaPage: async () => ({
          items: [{ id: 'f1', name: 'a.pdf', isFolder: false, size: 1, modified: '', path: '/', deleted: false }],
          deltaLink: 'final-token',
        }),
      }),
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(connectorSyncWorkflow, {
        workflowId: `test-connector-old-progress-${Date.now()}`,
        taskQueue: 'test-connector-old-progress',
        args: [
          {
            connectionId: 'conn-1',
            resumeLink: 'page-2',
            // Exactly the older shape — five counters, nothing else.
            progress: { discovered: 7, ingested: 7, skipped: 0, failed: 0, foldersScanned: 2 },
          },
        ],
      })
    );

    expect(result).toContain('ingested=8');
    expect(result).toContain('deferred=0');
    expect(result).not.toContain('NaN');
  }, 30_000);
});

// ── Registration: the bundle-side half, pinned by name ──────────────────────
describe('connectorSyncWorkflow registration', () => {
  it('is exported from the workflow bundle under its own name, on the default queue', () => {
    expect(typeof workflowBundle.connectorSyncWorkflow).toBe('function');
    expect(workflowBundle.connectorSyncWorkflow.name).toBe('connectorSyncWorkflow');
    expect(DEFAULT_TASK_QUEUE).toBe('shelfmark-queue');
  });
});
