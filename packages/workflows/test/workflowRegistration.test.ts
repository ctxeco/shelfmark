// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import * as workflows from '../src/workflows/index';
import {
  DEFAULT_TASK_QUEUE,
  taskQueueFor,
  connectorSyncWorkflowId,
  driveMapWorkflowId,
  selectiveIngestWorkflowId,
} from '../src/index';

// ══ THE ABSENCE WAS THE BUG ══
//
// A host does not import this package's workflow functions to start them —
// it starts workflows BY STRING over the Temporal client. That is a contract
// with no compiler on either side of it, and in the source system it was
// found broken in production form: a workflow type the API layer started for
// every billing event had ZERO occurrences in the worker — not exported from
// the bundle, no handler anywhere. Every event was verified, deduped, 200'd
// and dropped. Nothing failed. Not a type error, not a test, not a lint. A
// workflow registered on no queue is silent by construction.
//
// This file is the check that makes that state impossible to reach quietly
// here: the three (workflowType, taskQueue) pairs this package promises its
// hosts are pinned against the actual bundle exports and the actual queue
// constant. A worker resolves ONE workflowsPath (src/workflows/index.ts) and
// Temporal resolves workflow types out of that bundle by EXPORT NAME — so
// "is it exported from the bundle" is not a proxy for "is it registered", it
// IS the registration.
//
// MAINTENANCE RULE: when this package adds a workflow a host is meant to
// start, add its (type, queue) row here in the same commit — and give it an
// id helper in deps.ts, because the workflowId is also the runId the status
// routes look up.

const PROMISED_WORKFLOWS: ReadonlyArray<{
  /** The workflow TYPE name a host passes to client.workflow.start(). */
  type: string;
  /** The task queue the host must start it on (and the worker must serve). */
  taskQueue: string;
}> = [
  { type: 'driveMapWorkflow', taskQueue: DEFAULT_TASK_QUEUE },
  { type: 'selectiveIngestWorkflow', taskQueue: DEFAULT_TASK_QUEUE },
  { type: 'connectorSyncWorkflow', taskQueue: DEFAULT_TASK_QUEUE },
];

describe('workflow registration contract with hosts', () => {
  for (const { type, taskQueue } of PROMISED_WORKFLOWS) {
    it(`exports ${type} from the workflow bundle (hosts start it by string)`, () => {
      const exported = (workflows as Record<string, unknown>)[type];
      expect(
        typeof exported,
        `hosts start workflow type "${type}" by string. It is not exported from ` +
          `src/workflows/index.ts, so no worker can run it: every start silently accumulates ` +
          `unhandled workflow tasks. Re-export it from the bundle entry.`
      ).toBe('function');
    });

    it(`starts ${type} on the documented queue (${taskQueue})`, () => {
      expect(taskQueue).toBe('shelfmark-queue');
    });
  }

  it('names each exported workflow function identically to the type hosts start', () => {
    // A re-export can be renamed (`export { a as b }`) — Temporal resolves by
    // the EXPORT key, so that would still work, but it makes the string in
    // host code impossible to grep for in this repo, which is precisely the
    // condition under which the source system's missing registration went
    // unnoticed.
    for (const { type } of PROMISED_WORKFLOWS) {
      const fn = (workflows as Record<string, unknown>)[type] as { name?: string } | undefined;
      expect(fn?.name, `workflow export "${type}" is bound to a function named "${fn?.name}"`).toBe(
        type
      );
    }
  });

  it('exports EXACTLY the three workflows from the bundle entry — an extra export would register a bogus type', () => {
    const fnExports = Object.entries(workflows)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(fnExports).toEqual(
      ['connectorSyncWorkflow', 'driveMapWorkflow', 'selectiveIngestWorkflow'].sort()
    );
  });
});

describe('the workflowId = runId convention (deps.ts id helpers)', () => {
  it('pins the three id prefixes — the Temporal idempotency pin IS the run-record key', () => {
    // Each helper does two jobs: it makes a double-clicked start a
    // duplicate-start rejection, and it is the runId the workflow writes its
    // run document under (workflowInfo().workflowId). A host hand-rolling
    // `map-${id}` would work until one side changed the prefix.
    expect(driveMapWorkflowId('conn-1')).toBe('map-conn-1');
    expect(selectiveIngestWorkflowId('conn-1')).toBe('ingest-conn-1');
    expect(connectorSyncWorkflowId('conn-1')).toBe('connector-sync-conn-1');
  });

  it('the task queue is configurable, defaulting to shelfmark-queue', () => {
    expect(taskQueueFor()).toBe('shelfmark-queue');
    expect(taskQueueFor({})).toBe('shelfmark-queue');
    expect(taskQueueFor({ taskQueue: 'my-queue' })).toBe('my-queue');
  });
});
