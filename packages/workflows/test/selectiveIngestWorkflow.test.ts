// SPDX-License-Identifier: Apache-2.0
// 34-S14a — selectiveIngestWorkflow against a real time-skipping Temporal
// server: consent BEFORE any download (call-order proof), exactly the
// resolved set ingested (batch contents asserted — no more, no less),
// missing-remote files as named per-file failures, continueAsNew resume
// without re-ingest, and finalize honesty on every path.
//
// PORT NOTE: the source suite also proved a first-ingest billing credit's
// ordering; billing is host territory and crossed no port, so those cases
// have nothing to test here (see the workflow's own port note).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { selectiveIngestWorkflow } from '../src/workflows/selectiveIngest';
import { DEFAULT_TASK_QUEUE, type SelectedIngestFile } from '../src/index';
import * as workflowBundle from '../src/workflows/index';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = join(TEST_DIR, '../src/workflows/index.ts');

describe('selectiveIngestWorkflow', () => {
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

  const DECIDED_AT = '2026-08-20T10:00:00.000Z';

  function selFile(itemId: string, path: string, size = 1000): SelectedIngestFile {
    return {
      itemId,
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      remotePath: path.slice(0, path.lastIndexOf('/')) || '/',
      size,
    };
  }

  interface Recorder {
    order: string[];
    ingestBatches: any[][];
    ingestLabels: string[];
    ingestRunIds: string[];
    finalizeCalls: any[];
    updateCalls: any[];
    startCalls: any[];
    planCalls: number;
    consentCalls: number;
  }
  function recorder(): Recorder {
    return {
      order: [],
      ingestBatches: [],
      ingestLabels: [],
      ingestRunIds: [],
      finalizeCalls: [],
      updateCalls: [],
      startCalls: [],
      planCalls: 0,
      consentCalls: 0,
    };
  }

  /** Serves batches from `resolved` with the same cursor semantics as the
   *  real activity; `pageSize` lets a test force multiple batches without
   *  500 files. */
  function activitiesFor(
    resolved: SelectedIngestFile[],
    r: Recorder,
    opts: {
      pageSize?: number;
      unresolvedReaddPaths?: string[];
      failItems?: Record<string, string>;
      overrides?: Record<string, (...args: any[]) => Promise<any>>;
    } = {}
  ) {
    return {
      getConnection: async () => {
        r.order.push('getConnection');
        return baseConnection;
      },
      checkCloudEgressAllowed: async () => {
        r.order.push('checkCloudEgressAllowed');
      },
      verifySelectiveIngestConsent: async () => {
        r.order.push('verifySelectiveIngestConsent');
        r.consentCalls++;
        return {
          active: true,
          consentId: 'c-ingest',
          disclosureSha256: 'sha-d',
          target: null,
          exclusions: [],
        };
      },
      resolveSelectiveIngestPlan: async () => {
        r.order.push('resolveSelectiveIngestPlan');
        r.planCalls++;
        return {
          mapRunId: 'map-run-1',
          decidedAt: DECIDED_AT,
          selectedFiles: resolved.length,
          selectedBytes: resolved.reduce((a, f) => a + f.size, 0),
          unresolvedReaddPaths: opts.unresolvedReaddPaths ?? [],
          unresolvedReaddsOmitted: 0,
          funnelPolicyVersion: '1.0.0-rc1',
          funnelPolicySha256: 'f'.repeat(64),
          // 34-S14f — the per-folder denominators the real activity computes
          // (folderTotalsOf), so the workflow's rollup starts at the count
          // the customer approved per folder instead of materialising it as
          // files trickle in.
          folderTotals: [...new Set(resolved.map((f) => f.remotePath))].map((path) => ({
            path,
            selected: resolved.filter((f) => f.remotePath === path).length,
            selectedBytes: resolved
              .filter((f) => f.remotePath === path)
              .reduce((a, f) => a + f.size, 0),
          })),
          folderTotalsOmitted: 0,
        };
      },
      listSelectedIngestBatch: async (
        _tenantId: string,
        _connectionId: string,
        _mapRunId: string,
        _decidedAt: string,
        afterPath: string | null,
        limit: number
      ) => {
        r.order.push('listSelectedIngestBatch');
        const size = Math.min(opts.pageSize ?? limit, limit);
        const start = afterPath === null ? 0 : resolved.findIndex((f) => f.path > afterPath);
        const from = start === -1 ? resolved.length : start;
        const files = resolved.slice(from, from + size);
        const more = from + files.length < resolved.length;
        return {
          files,
          nextAfterPath: more && files.length > 0 ? files[files.length - 1]!.path : null,
        };
      },
      ingestFileBatch: async (
        _connectionId: string,
        _tenantId: string,
        label: string,
        runId: string,
        files: { itemId: string; name: string; remotePath: string }[]
      ) => {
        r.order.push('ingestFileBatch');
        r.ingestBatches.push(files);
        r.ingestLabels.push(label);
        r.ingestRunIds.push(runId);
        return files.map((f) => {
          const err = opts.failItems?.[f.itemId];
          return err
            ? { itemId: f.itemId, status: 'failed' as const, error: err }
            : { itemId: f.itemId, status: 'ingested' as const };
        });
      },
      startSelectiveIngestRun: async (input: any) => {
        r.order.push('startSelectiveIngestRun');
        r.startCalls.push(input);
      },
      updateSelectiveIngestRun: async (
        tenantId: string,
        runId: string,
        snapshot: any,
        connectionId?: string
      ) => {
        r.order.push('updateSelectiveIngestRun');
        r.updateCalls.push({ tenantId, runId, snapshot, connectionId });
      },
      finalizeSelectiveIngestRun: async (...args: any[]) => {
        r.order.push(`finalize:${args[3]}`);
        r.finalizeCalls.push(args);
      },
      ...(opts.overrides ?? {}),
    };
  }

  async function run(taskQueue: string, activities: any, input: Record<string, unknown> = {}) {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });
    return worker.runUntil(
      testEnv.client.workflow.execute(selectiveIngestWorkflow, {
        workflowId: `${taskQueue}-${Date.now()}`,
        taskQueue,
        args: [{ connectionId: 'conn-map-1', ...input }],
      })
    );
  }

  it('refuses without an ACTIVE ingest_content consent BEFORE any download — call-order proof, fail closed', async () => {
    const r = recorder();
    const result = await run(
      'test-sel-no-consent',
      activitiesFor([selFile('i-a', '/Docs/a.md')], r, {
        overrides: {
          verifySelectiveIngestConsent: async () => {
            r.order.push('verifySelectiveIngestConsent');
            return {
              active: false,
              consentId: null,
              disclosureSha256: null,
              target: null,
              exclusions: [],
            };
          },
        },
      })
    );

    expect(result).toContain('[REFUSED_NO_CONSENT]');
    // NOTHING download-adjacent ran: no plan, no batch listing, no ingest,
    // no egress check, no run start — the refusal is the run's whole life.
    expect(r.order).toEqual([
      'getConnection',
      'verifySelectiveIngestConsent',
      'finalize:refused_no_consent',
    ]);
    const [tenantId, , connectionId, status, snapshot] = r.finalizeCalls[0];
    expect(tenantId).toBe('ACME-01');
    expect(connectionId).toBe('conn-map-1');
    expect(status).toBe('refused_no_consent');
    expect(snapshot.provider).toBe('onedrive');
  }, 30_000);

  it('with consent active, the consent check still PRECEDES every download-adjacent call', async () => {
    const r = recorder();
    await run('test-sel-order', activitiesFor([selFile('i-a', '/Docs/a.md')], r));
    const consentIdx = r.order.indexOf('verifySelectiveIngestConsent');
    for (const later of [
      'resolveSelectiveIngestPlan',
      'checkCloudEgressAllowed',
      'listSelectedIngestBatch',
      'ingestFileBatch',
    ]) {
      expect(r.order.indexOf(later), later).toBeGreaterThan(consentIdx);
    }
  }, 30_000);

  it('ingests EXACTLY the resolved set — batch contents asserted, no more, no less, none twice', async () => {
    const r = recorder();
    const resolved = [
      selFile('i-a', '/Docs/a.md'),
      selFile('i-b', '/Docs/b.md'),
      selFile('i-r', '/Docs/readded-receipt.pdf'),
      selFile('i-z', '/notes/z.md'),
    ];
    const result = await run('test-sel-exact', activitiesFor(resolved, r, { pageSize: 3 }));

    const flattened = r.ingestBatches.flat();
    // 34-S14d — `size` rides along, from the ledger the customer approved,
    // so the ingest ceiling is applied before a byte is fetched.
    expect(flattened).toEqual(
      resolved.map((f) => ({
        itemId: f.itemId,
        name: f.name,
        remotePath: f.remotePath,
        size: f.size,
      }))
    );
    // tenant_id, the resolved label and the runId rode along on every batch —
    // and the run finished honest.
    expect(r.ingestLabels.every((l) => l === 'general')).toBe(true);
    expect(r.ingestRunIds.every((id) => id.startsWith('test-sel-exact-'))).toBe(true);
    expect(r.finalizeCalls).toHaveLength(1);
    const [, , , status, snapshot] = r.finalizeCalls[0];
    expect(status).toBe('complete');
    expect(snapshot).toMatchObject({ selected: 4, ingested: 4, failed: 0, skipped: 0 });
    expect(result).toContain('ingested=4');
    // Progress flushed unconditionally per batch (2 pages of ≤3).
    expect(r.updateCalls.length).toBe(2);
  }, 30_000);

  it('the workflow input label overrides the stored default — the step is a property of THIS decision', async () => {
    const r = recorder();
    await run('test-sel-label', activitiesFor([selFile('i-a', '/Docs/a.md')], r), {
      label: 'restricted',
    });
    expect(r.ingestLabels).toEqual(['restricted']);
  }, 30_000);

  it('a selected file that no longer exists remotely finalizes as a NAMED per-file failure, not a crash', async () => {
    const r = recorder();
    const resolved = [selFile('i-a', '/Docs/a.md'), selFile('i-gone', '/Docs/deleted-remotely.md')];
    const result = await run(
      'test-sel-missing-remote',
      activitiesFor(resolved, r, {
        failItems: { 'i-gone': 'Failed to download file: HTTP 404 itemNotFound' },
      })
    );

    expect(result).toContain('[SUCCESS]');
    expect(result).toContain('failed=1');
    const [, , , status, snapshot] = r.finalizeCalls[0];
    expect(status).toBe('complete');
    expect(snapshot).toMatchObject({ ingested: 1, failed: 1, failuresTruncated: false });
    expect(snapshot.failures).toEqual([
      {
        path: '/Docs/deleted-remotely.md',
        name: 'deleted-remotely.md',
        error: 'Failed to download file: HTTP 404 itemNotFound',
      },
    ]);
  }, 30_000);

  it('a re-added path with no ledger row is a NAMED per-file failure recorded up front', async () => {
    const r = recorder();
    await run(
      'test-sel-unresolved-readd',
      activitiesFor([selFile('i-a', '/Docs/a.md')], r, {
        unresolvedReaddPaths: ['/Docs/ghost.md'],
      })
    );
    const [, , , status, snapshot] = r.finalizeCalls[0];
    expect(status).toBe('complete');
    expect(snapshot).toMatchObject({ ingested: 1, failed: 1 });
    expect(snapshot.failures[0]).toMatchObject({
      path: '/Docs/ghost.md',
      error: expect.stringContaining('no map_suggestions row'),
    });
  }, 30_000);

  it('continues as new on the batch threshold and the resumed run never re-ingests a file — one finalize, at the true end', async () => {
    const r = recorder();
    const resolved = [
      selFile('i-1', '/Docs/f1.md'),
      selFile('i-2', '/Docs/f2.md'),
      selFile('i-3', '/Docs/f3.md'),
      selFile('i-4', '/Docs/f4.md'),
      selFile('i-5', '/Docs/f5.md'),
      selFile('i-6', '/Docs/f6.md'),
    ];
    const result = await run(
      'test-sel-can',
      activitiesFor(resolved, r, { pageSize: 2 }),
      // 1 batch per execution: pages 2..3 arrive via continueAsNew hops.
      { continueAsNewAfter: 1 }
    );

    // Every file ingested EXACTLY once across the chained executions.
    const flattened = r.ingestBatches.flat().map((f) => f.itemId);
    expect(flattened).toEqual(['i-1', 'i-2', 'i-3', 'i-4', 'i-5', 'i-6']);
    expect(new Set(flattened).size).toBe(6);
    // The plan and the run doc were made ONCE (fresh execution only)…
    expect(r.planCalls).toBe(1);
    expect(r.startCalls).toHaveLength(1);
    // …consent is re-verified on EVERY hop (a revocation stops the next
    // hop, fail closed)…
    expect(r.consentCalls).toBe(3);
    // …and the ContinueAsNew marker was rethrown, never finalized 'failed':
    // exactly one finalize, 'complete', at the true end.
    expect(r.finalizeCalls).toHaveLength(1);
    expect(r.finalizeCalls[0][3]).toBe('complete');
    expect(r.finalizeCalls[0][4]).toMatchObject({ selected: 6, ingested: 6, failed: 0 });
    expect(result).toContain('ingested=6');
  }, 30_000);

  it('carries the DENOMINATOR, the folder rollup and the four states into every progress write (34-S14f)', async () => {
    // The map supplies a real denominator — the count the customer approved —
    // so the UI can stop guessing a percentage. `done` is written rather than
    // left for three screens to assemble from four fields three ways.
    const r = recorder();
    const resolved = [
      selFile('i-a', '/Docs/a.md'),
      selFile('i-b', '/Docs/b.md'),
      selFile('i-c', '/Docs/huge.pdf'),
      selFile('i-d', '/Docs/poor.pdf'),
      selFile('i-z', '/notes/z.md'),
    ];
    const result = await run(
      'test-sel-progress',
      activitiesFor(resolved, r, {
        pageSize: 3,
        overrides: {
          ingestFileBatch: async (
            _c: string,
            _t: string,
            _label: string,
            _runId: string,
            files: any[]
          ) => {
            r.order.push('ingestFileBatch');
            r.ingestBatches.push(files);
            return files.map((f) => {
              if (f.itemId === 'i-c') {
                return {
                  itemId: f.itemId,
                  status: 'skipped',
                  skipReason: 'too_large',
                  error: 'too_large: …',
                };
              }
              if (f.itemId === 'i-d') {
                // The sink said "not now" — its own lane, never a failure.
                return { itemId: f.itemId, status: 'deferred', error: 'sink deferred: quota' };
              }
              return { itemId: f.itemId, status: 'ingested' };
            });
          },
        },
      })
    );

    const [, , , status, snapshot] = r.finalizeCalls[0];
    expect(status).toBe('complete');
    // The denominator, and every terminal outcome against it.
    expect(snapshot.selected).toBe(5);
    expect(snapshot.ingested).toBe(3);
    expect(snapshot.skipped).toBe(1);
    expect(snapshot.deferred).toBe(1);
    expect(snapshot.failed).toBe(0);
    expect(snapshot.done).toBe(5);
    expect(snapshot.done).toBe(snapshot.selected);
    expect(snapshot.skippedByReason).toEqual({ too_large: 1 });
    // Per-folder rollup: each folder starts at its own denominator from the
    // plan, so a row reads "0 of 4" from the first poll.
    expect(snapshot.folders).toEqual([
      { path: '/Docs', selected: 4, ingested: 2, skipped: 1, failed: 0, deferred: 1 },
      { path: '/notes', selected: 1, ingested: 1, skipped: 0, failed: 0, deferred: 0 },
    ]);
    expect(snapshot.foldersTruncated).toBe(false);
    expect(snapshot.foldersOmitted).toBe(0);
    // The last file touched, by full path — what "reading …" names.
    expect(snapshot.currentPath).toBe('/notes/z.md');
    // Every per-batch flush names the connection, which is what lets the
    // activity mirror progress onto a document a route actually serves.
    expect(r.updateCalls.every((c) => c.connectionId === 'conn-map-1')).toBe(true);
    expect(r.updateCalls[0].snapshot.selected).toBe(5);
    expect(result).toContain('deferred=1');
    expect(result).toContain('done=5');
  }, 30_000);

  it("a resume carrying an OLDER release's state completes truthfully, not with NaN (34-S14f)", async () => {
    // A hop that continued as new under older code has no deferred, no
    // skippedByReason, no folders — and `undefined++` is NaN on a screen the
    // customer is watching.
    const r = recorder();
    const resolved = [selFile('i-a', '/Docs/a.md'), selFile('i-b', '/Docs/b.md')];
    const result = await run('test-sel-old-resume', activitiesFor(resolved, r), {
      resume: {
        runId: 'ingest-conn-map-1',
        mapRunId: 'map-run-1',
        decidedAt: DECIDED_AT,
        funnelPolicySha256: 'f'.repeat(64),
        afterPath: null,
        // Exactly the older shape — five fields, nothing else.
        progress: { selected: 2, ingested: 0, failed: 0, skipped: 0, batchesDone: 0 },
        failures: [],
        failuresTruncated: false,
        failuresOmitted: 0,
        unresolvedReaddsOmitted: 0,
      },
    });

    expect(result).not.toContain('NaN');
    expect(result).toContain('ingested=2');
    expect(result).toContain('deferred=0');
    const [, , , , snapshot] = r.finalizeCalls[0];
    expect(snapshot.done).toBe(2);
    expect(snapshot.folders).toEqual([]);
    // The plan is NOT re-resolved on a resume — the old state is adopted.
    expect(r.planCalls).toBe(0);
  }, 30_000);

  it("finalizes 'failed' (never stuck at 'ingesting') when the plan itself refuses — e.g. no decided selection on record", async () => {
    const r = recorder();
    await expect(
      run(
        'test-sel-no-plan',
        activitiesFor([], r, {
          overrides: {
            resolveSelectiveIngestPlan: async () => {
              r.order.push('resolveSelectiveIngestPlan');
              throw ApplicationFailure.create({
                nonRetryable: true,
                type: 'NoSelectionOnRecord',
                message: 'no map_selections decision exists',
              });
            },
          },
        })
      )
    ).rejects.toThrow();
    expect(r.ingestBatches).toHaveLength(0);
    expect(r.finalizeCalls).toHaveLength(1);
    expect(r.finalizeCalls[0][3]).toBe('failed');
  }, 30_000);

  it("JRN-8: a SelectionOutsideConsentScope refusal from the plan finalizes 'failed' with the typed cause surfaced", async () => {
    const r = recorder();
    const err: any = await run(
      'test-sel-oos',
      activitiesFor([], r, {
        overrides: {
          resolveSelectiveIngestPlan: async () => {
            r.order.push('resolveSelectiveIngestPlan');
            throw ApplicationFailure.create({
              nonRetryable: true,
              type: 'SelectionOutsideConsentScope',
              message: 'resolved selection row /Elsewhere/leak.md is outside the consented target',
            });
          },
        },
      })
    ).then(
      () => null,
      (e) => e
    );
    expect(err).not.toBeNull();
    expect(String(err.cause?.cause?.type ?? err.cause?.type)).toBe('SelectionOutsideConsentScope');
    expect(r.ingestBatches).toHaveLength(0);
    expect(r.finalizeCalls[0][3]).toBe('failed');
  }, 30_000);

  it('finalizes an unported provider honestly as unsupported_provider without resolving anything', async () => {
    const r = recorder();
    const result = await run(
      'test-sel-unsupported',
      activitiesFor([selFile('i-a', '/Docs/a.md')], r, {
        overrides: {
          getConnection: async () => {
            r.order.push('getConnection');
            return { ...baseConnection, provider: 'other_drive' };
          },
        },
      })
    );
    expect(result).toContain('[UNSUPPORTED_PROVIDER]');
    expect(r.planCalls).toBe(0);
    expect(r.ingestBatches).toHaveLength(0);
    expect(r.finalizeCalls[0][3]).toBe('unsupported_provider');
  }, 30_000);
});

// ── Registration: the bundle-side half, pinned by name ──────────────────────
describe('selectiveIngestWorkflow registration', () => {
  it('is exported from the workflow bundle under its own name, on the default queue', () => {
    expect(typeof workflowBundle.selectiveIngestWorkflow).toBe('function');
    expect(workflowBundle.selectiveIngestWorkflow.name).toBe('selectiveIngestWorkflow');
    expect(DEFAULT_TASK_QUEUE).toBe('shelfmark-queue');
  });
});
