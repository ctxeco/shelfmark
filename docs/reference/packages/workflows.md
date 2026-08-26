---
title: "@shelfmark/workflows"
parent: Packages
grand_parent: Reference
nav_order: 4
---

# `@shelfmark/workflows`

The Temporal layer: three workflows and the dependency-injected activity
registry behind them. Needs a running Temporal service and the Mongo store.

```bash
pnpm add @shelfmark/workflows
```

## Building a worker

A host builds its worker from exactly two things:

```ts
import { Worker } from '@temporalio/worker';
import { createActivities, DEFAULT_TASK_QUEUE } from '@shelfmark/workflows';
import { storeFromDb } from '@shelfmark/core';

const worker = await Worker.create({
  workflowsPath: require.resolve('@shelfmark/workflows/workflows-source'),
  activities: createActivities({ store: storeFromDb(db), ports }),
  taskQueue: DEFAULT_TASK_QUEUE,   // 'shelfmark-queue'
});
await worker.run();
```

- `createActivities(deps)` returns the full registry. Names are disjoint by
  construction — each factory prefixes its own domain — so the spread-merge
  cannot shadow.
- The workflow bundle entry is `@shelfmark/workflows/workflows-source`
  (unbuilt TypeScript, for Temporal's own bundler) or the built `./workflows`
  export.

```ts
export interface ShelfmarkWorkflowDeps {
  store: ShelfmarkStore;              // from @shelfmark/core
  ports: ShelfmarkPorts;              // sink + resolveAuth required
  config?: { taskQueue?: string };
}
export function createActivities(deps: ShelfmarkWorkflowDeps): ShelfmarkActivities;
export const DEFAULT_TASK_QUEUE = 'shelfmark-queue';
export function taskQueueFor(config?: ShelfmarkWorkflowsConfig): string;
```

Dependency injection is the point: there are **no module-level singletons**, so
an activity test is a plain function call against a mocked `deps`.

The package index (`@shelfmark/workflows`) exports the activity factories,
types, constants and id helpers — everything the *start* side needs. It
deliberately does **not** export the workflow functions; those live only in the
bundle entry, because Temporal registers workflow types from that module's
exported functions and an extra export there would register a bogus type.

## Workflow ids

```ts
export function driveMapWorkflowId(connectionId: string): string;        // map-<id>
export function selectiveIngestWorkflowId(connectionId: string): string; // ingest-<id>
export function connectorSyncWorkflowId(connectionId: string): string;   // connector-sync-<id>
```

Each does two jobs — the Temporal idempotency pin **and** the `runId` the
workflow writes its documents under. See
[Data model → Ids](../data-model.md#the-workflowid-doubles-as-the-run-id).

The three `(workflowType, taskQueue)` pairs are pinned by a test against the
actual bundle exports. Adding a workflow means adding its row there and its id
helper in the same commit.

## The three workflows

### `driveMapWorkflow`

Input: `{ connectionId, resume?, continueAsNewAfter? }` — the API sends
`[{ connectionId }]` only; `resume` is internal `continueAsNew` state and is
never set from the edge.

It walks the drive **metadata-only**, classifying every item, spooling
candidates, and writing one `map_runs` document as it goes. Gate order, all
before any provider call:

1. active `map_metadata` consent, derived from the append-only event stream —
   otherwise the run finalizes `refused_no_consent` and **nothing is fetched**;
2. provider is `onedrive` or `sharepoint` — otherwise `unsupported_provider`;
3. the mapped root is within the consent's target — otherwise
   `refused_out_of_scope` **and** a typed `MapOutsideConsentScope` failure;
4. `checkMapEgressAllowed(tenantId)` — the tenant-level question, never a
   content label.

Consent is re-verified on **every** `continueAsNew` hop, and the grant's
recorded **exclusions prune subtrees at the boundary** exactly like classifier
prunes: never descended, always reported in the prune manifest under the
`consent_excluded` rule.

The classifier artifact's SHA is **pinned on the first page**; a mid-run swap
fails the run (`ArtifactClassesChangedMidRun`) rather than blending two rule
sets into one report.

`continueAsNew` fires after `DEFAULT_MAP_PAGES_PER_RUN` (**200**) pages — pages
are the map's unit of work, since it ingests nothing.

### `selectiveIngestWorkflow`

Input: `{ connectionId, label?, resume?, continueAsNewAfter? }`.

Ingests **exactly** the decided selection — the suggestions' default selection
minus removals plus deliberate re-adds — nothing more, nothing less. It batches
through the shared `ingestFileBatch` activity at `SELECTIVE_INGEST_BATCH_SIZE`
(**20**) files per call, `continueAsNew`ing after
`DEFAULT_SELECTIVE_INGEST_BATCHES_PER_RUN` (**25**) batches — 500 files a hop.

**The selection never enters workflow state or history.** The plan activity
returns counts; each batch is paged out of the resolved selection by a
deterministic path-order cursor. A hop carries the cursor and the counters, so
an enterprise selection costs the same state bytes as a ten-file one.

The consent is re-read on the plan **and on every batch resolution**, not only
up front: a consent revoked or re-granted narrower mid-ingest stops the very
next resolution. The resolution is bounded by the consent's target and
exclusions, and **one** out-of-scope row voids the whole resolution rather than
silently ingesting a subset.

`checkCloudEgressAllowed(tenantId, label)` gates the download phase.

{: .note }
> The label is resolved as `input.label ?? connection.defaultLabel ??
> 'default'`. `label` is optional so an execution started by an older release
> still resolves. A host starting this workflow directly should pass `label`
> in the input rather than relying on the connection document — the start route
> writes `defaultLabel` *after* the start, and a worker that picks the run up
> first would read the older value.

### `connectorSyncWorkflow`

Input: `{ connectionId, resumeLink?, progress?, continueAsNewAfter? }`.

The legacy **all-or-nothing** delta sync: the first full crawl and every
incremental resync after it, through Graph's delta API. Batches of 20,
`continueAsNew` after 500 items. On a 410 the stored delta token is abandoned,
the reason is recorded on the connection **before** the re-enumeration runs, and
a full re-enumeration follows — so a re-crawl caused by token expiry is
distinguishable from a normal first crawl, which looks identical otherwise.

{: .warning }
> **The retry-failed-files pass is not ported.** The source system opened every
> sync by re-attempting its currently-`failed` documents, because delta only
> surfaces *remotely changed* files and a file that failed on the ingest side
> would never come back around. That pass was a query against the platform's own
> documents table; here, terminal document storage lives behind
> `DocumentSink.accept()` and there is no table to enumerate failures from. A
> host re-submits failures through its own pass with `isRetry: true` — the flag
> exists on `FileToIngest` for exactly that, and the stable `documentId` makes
> the re-submission an update by contract, never a duplicate.

## Activity retry policies

Set with `proxyActivities` inside each workflow:

| Activity group | `startToCloseTimeout` | Retry |
| --- | --- | --- |
| connection, egress, map, selective-ingest (store reads/writes, one Graph call each) | 2 minutes | `initialInterval: 5s`, `backoffCoefficient: 2`, `maximumAttempts: 5` |
| `ingestFileBatch` (downloads + sink hand-offs) | 10 minutes | `initialInterval: 10s`, `backoffCoefficient: 2`, `maximumAttempts: 3` |

A Graph 429 **overrides** that backoff: `graphThrottleFailure` carries
`Retry-After` as `nextRetryDelay`, so Temporal waits what Graph asked rather
than what the policy guessed.

## Activity surface

Grouped by factory. All are `async` and all are dependency-injected.

**Connection** — `getConnection`, `getGraphAccessToken`, `listRemoteDeltaPage`,
`updateSyncProgress`, `finalizeSync`. Plus the plain helpers
`getConnectionDoc`, `getGraphAccessTokenFor`, `requireActiveConnection` (the
narrowing that refuses a disconnected connection or one with no resolved
drive).

**Egress** — `checkCloudEgressAllowed(tenantId, label)`,
`checkMapEgressAllowed(tenantId)`.

**Map** — `verifyMapConsent`, `listMapFolderPage`, `startMapRun`,
`updateMapRunProgress`, `finalizeMapRun`, `appendMapCandidates`,
`writeMapSuggestions`.

**Selective ingest** — `verifySelectiveIngestConsent`,
`resolveSelectiveIngestPlan`, `listSelectedIngestBatch`,
`startSelectiveIngestRun`, `updateSelectiveIngestRun`,
`finalizeSelectiveIngestRun`.

**Ingest** — `ingestFileBatch(connectionId, tenantId, label, runId, files)`.

### Ingest helpers worth knowing

```ts
export function documentIdFor(connectionId: string, remoteFileId: string): string;
export function guessMimetype(name: string): string;

export interface FileToIngest {
  itemId: string; name: string; remotePath: string;
  size?: number | null;   // "not reported" is NOT zero
  isRetry?: boolean;
}
export interface IngestOutcome {
  itemId: string;
  status: 'ingested' | 'failed' | 'skipped' | 'deferred';
  error?: string;
  skipReason?: IngestSkipReason;
}
```

`ingestFileBatch` runs `INGEST_CONCURRENCY` (15) downloads at a time. The
pre-filter runs **inside** `processFile`, not only at enqueue time, so every
path is covered — otherwise an unreadable 3 GB file re-submitted by a host retry
pass would be re-downloaded in full on every attempt, forever.

A sink that **throws** (rather than answering `{status:'failed'}`) is still a
per-file failure named in the run record: one broken file must not crash the
whole batch activity.

## Consent-scope algebra

```ts
export const CONSENT_EXCLUDED_RULE = 'consent_excluded';
export function normalizeConsentPath(path: string): string;
export function isWithinConsentTarget(...): boolean;
export function isConsentExcluded(...): boolean;
export function mapRootWithinConsent(rootFolderId: string | null, target: ConsentScopeTarget | null): boolean;
```

Pure, and imported by **both** the workflow (which prunes at the descend
decision, deterministically) and the activities (which refuse out-of-scope
selection rows). One algebra, two enforcement points, zero drift.

`normalizeConsentPath` collapses duplicate slashes, forces a leading `/` and
drops a trailing one, so `/Team/`, `Team` and `/Team` all name the same subtree.

`mapRootWithinConsent` fails closed on **identity, not path strings**: a subtree
grant authorizes exactly the folder it names, so the map root must *be* that
folder (or the grant must cover the whole drive). A root that is a strict
descendant of the target would also be safe, but proving descent takes provider
calls the consent check must not make — so it is refused instead.

All consent-scope paths are compared in the walk's own path space: `/`-rooted at
the **mapped folder**. The folderId pin is what makes that comparison sound;
recording scope paths in any other space is a host error the string comparison
cannot detect.

## Named bounds

Every one of these is **recorded when it bites**.

| Constant | Value | Bounds |
| --- | --- | --- |
| `DEFAULT_MAP_PAGES_PER_RUN` | 200 | pages per map execution before `continueAsNew` |
| `MAX_TOP_FOLDER_ROLLUPS` | 40 | per-top-folder rollups kept (`rollupTruncated`, `topFoldersOmitted`) |
| `MAX_PRUNE_MANIFEST_ENTRIES` | 2000 | itemized prune entries (`pruneManifestTruncated`, `pruneManifestOmitted`) |
| `NARRATION_MAX_LINES` | 300 | narration lines (`narrationDropped`) |
| `ITEMS_NARRATION_STRIDE` | 2500 | items between milestone narration lines |
| `MAX_SUGGESTION_ROWS` | 20,000 | ledger rows written (`rowsTruncated`, `rowsOmitted`, `rowCap`) |
| `SELECTIVE_INGEST_BATCH_SIZE` | 20 | files per `ingestFileBatch` call |
| `DEFAULT_SELECTIVE_INGEST_BATCHES_PER_RUN` | 25 | batches per execution before `continueAsNew` |
| `MAX_RECORDED_INGEST_FAILURES` | 200 | itemized failures (`failuresTruncated`, `failuresOmitted`) |
| `MAX_FOLDER_ROLLUP_ENTRIES` | 200 | per-folder rollups, first 200 in path order (`foldersOmitted`) |
| `MAX_UNRESOLVED_READDS_RECORDED` | 200 | unresolved re-add paths carried in state (`unresolvedReaddsOmitted`) |

The caps bound the **itemization, never the arithmetic**: files in an omitted
folder still count in the run's totals, and every pruned folder still counts in
`foldersPruned`/`prunedFolderBytes` even when its manifest entry did not fit.

## Typed failures

Every refusal is an `ApplicationFailure` with a stable `type`, so a host can
catch it by name. The complete list — with retryability and meaning — is in
[Errors → Typed workflow failures](../errors.md#typed-workflow-failures).

`graphThrottleFailure(err)` is exported for unit tests: it is the seam where
"Retry-After honoured" either holds or silently does not.

## Determinism notes

Workflow code runs in Temporal's deterministic sandbox, so:

- `fmtInt` and `fmtBytes` are hand-rolled rather than `toLocaleString` —
  ICU-dependent output inside workflow code is replay roulette.
- Tunables come from the **workflow input**, not env vars: workflow code does
  not reliably see `process.env` the way activity code does. That is why
  `continueAsNewAfter` exists on all three inputs — tests exercise the resume
  path without 200 real pages or 500 real files.
- There are **no `patched()` markers anywhere in this package, by design.** A
  fresh history has no in-flight executions to protect. The first change that
  needs one is the first one that should add one.

## Gotchas

- Activities are registered by the object keys `createActivities` returns.
  Renaming an activity is a wire-compatibility change for in-flight histories.
- `getConnectionDoc` looks up by `connectionId` alone; tenant scoping is
  asserted separately (`TenantScopeViolation`) rather than being folded into
  the filter.
- The progress record shapes are **additive-only**: every field beyond the
  original four is optional, because an execution started under an older
  release still calls the activity with the shape it was born with.
- The refusal statuses (`refused_no_consent`, `unsupported_provider`,
  `refused_out_of_scope`) are recorded by an **upserting** finalize, so they
  leave a run document even though the start activity never ran.
