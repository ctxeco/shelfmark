---
title: Data model
parent: Reference
nav_order: 3
---

# Data model

Seven MongoDB collections, all owned by this library and nothing else. Shapes
live in `packages/core/src/store/schemas.ts`; the typed accessors and the index
set live in `packages/core/src/store/client.ts`.

| Collection | Constant | Written by | Read by |
| --- | --- | --- | --- |
| `connector_connections` | `CONNECTIONS_COLLECTION` | API (OAuth callback, sync, map, ingest, disconnect), workflows | everything |
| `connector_consents` | `CONSENT_COLLECTION` | API (grant, revoke) — append only | API gates, workflows |
| `map_runs` | `MAP_RUNS_COLLECTION` | map workflow | API read + SSE stream |
| `map_candidates` | `MAP_CANDIDATES_COLLECTION` | map activities (spool) | the suggestions write, once |
| `map_suggestions` | `MAP_SUGGESTIONS_COLLECTION` | map activities, once per completed run | API, ingest workflow |
| `map_selections` | `MAP_SELECTIONS_COLLECTION` | API (`PUT /:id/map/selection`) | ingest workflow |
| `selective_ingest_runs` | `SELECTIVE_INGEST_RUNS_COLLECTION` | ingest workflow | API (via the connection mirror) |

There is deliberately **no shared-with-host `documents` collection.** Connector
territory ends when bytes cross `DocumentSink.accept()`; what the host stores
about a document afterwards is the host's schema, not this one.

## Mongo is a hard dependency

On purpose. The run records, the consent evidence, the candidates spool and the
selection ledger are relational-enough documents with idempotent upsert
semantics the workflows depend on — a Temporal activity retry re-asserts rather
than duplicates *precisely because* the spool upsert is keyed. Abstracting the
store behind a sixth port would trade that load-bearing specificity for a
lowest-common-denominator interface nobody asked for. The `Db` handle is still
injectable (`storeFromDb(db)`), so hosts own connection lifecycle and tests need
no running server.

## Indexes

`ensureStoreIndexes(db)` is idempotent — `createIndex` on an existing identical
index is a no-op — so it runs at every startup. `createStoreClient()` calls it
on connect.

```ts
await connections.createIndex({ connectionId: 1 }, { unique: true });
await connections.createIndex({ tenantId: 1, connectionId: 1 });
await consents.createIndex({ tenantId: 1, connectionId: 1, grantedAt: -1 });
await mapRuns.createIndex({ tenantId: 1, runId: 1 }, { unique: true });
await mapCandidates.createIndex({ tenantId: 1, runId: 1, path: 1 }, { unique: true });
await mapSuggestions.createIndex({ tenantId: 1, runId: 1 }, { unique: true });
await mapSelections.createIndex({ tenantId: 1, connectionId: 1, decidedAt: -1 });
await selectiveIngestRuns.createIndex({ tenantId: 1, runId: 1 }, { unique: true });
```

**What each unique index buys.** The load-bearing one is the spool's: without
`{tenantId, runId, path}` being unique, two concurrent activity retries of the
same page could both miss the filter and insert twice. The constraint turns
that race into the idempotent re-assertion the workflow assumes. The run-record
uniques give the same guarantee to the start/finalize upserts. The rest are
query paths the activities actually take.

{: .note }
> `map_selections` is upserted on `{runId, tenantId}` but its index is
> `{tenantId, connectionId, decidedAt}` and is **not** unique — it exists for
> the workers' latest-decision sort, not for uniqueness. Stated because it is
> the one place where the upsert key and the index do not line up.

## Ids

| Id | Shape | Minted by |
| --- | --- | --- |
| `connectionId` | `conn-<uuid v4>` | the OAuth callback |
| `consentId` | `consent-<uuid v4>` | every consent event, grant and revocation alike |
| map `runId` | `map-<connectionId>` | `driveMapWorkflowId()` |
| ingest `runId` | `ingest-<connectionId>` | `selectiveIngestWorkflowId()` |
| sync workflow id | `connector-sync-<connectionId>` | `connectorSyncWorkflowId()` |
| `documentId` (sink) | `doc-<first 32 hex of sha256(connectionId + NUL + remoteFileId)>` — the separator is a NUL byte, not a space | `documentIdFor()` |

### The workflowId doubles as the run id

Each id builder does **two jobs**, and both sides must agree byte-for-byte:

1. It is the **Temporal idempotency pin** the API starts the workflow under. A
   double-clicked "map it" is a duplicate-start rejection — which the starter
   treats as success and returns the same id for — not a second concurrent walk
   of the same remote drive.
2. It is the **`runId` the workflow writes its run documents under**. The
   workflows use `workflowInfo().workflowId` as the runId, and
   `GET /:id/map`, `GET /:id/map/stream` and `GET /:id/map/suggestions` look up
   documents by exactly that string.

A route hand-rolling `` `map-${id}` `` would work until one side changed the
prefix. So the prefix lives in one function per family, exported from both
`@shelfmark/api` (`workflowStarters.ts`) and `@shelfmark/workflows` (`deps.ts`)
with identical bodies, and the (type, queue) pairs are pinned by a registration
test.

Because ids are pinned per connection, **a connection has at most one map run
and one selective-ingest run at a time**, and re-running overwrites the same
document rather than accumulating history.

`documentId` is hashed rather than concatenated so it is fixed-length and
carries no remote path or provider identifier into whatever namespace the sink
stores it in. It is a pure function of `(connectionId, remoteFileId)`, which is
what makes a sink's "update, don't duplicate" obligation checkable.

## The four-state outcome vocabulary

Used uniformly by the sync path, the selective-ingest path and the UI:

| Status | Meaning |
| --- | --- |
| `ingested` | the sink accepted the bytes |
| `failed` | the download or the sink failed — a named reason travels with it |
| `skipped` | the connector deliberately never opened it, for a reason from the closed skip vocabulary |
| `deferred` | the sink declined **for now** (quota, budget, backpressure); a later pass re-submits with `isRetry: true` |

`deferred` is the one deliberate rename from the source shapes: a
`paused_budget` status meaning "the ingest pipeline's budget is exhausted, park
the file" generalizes to a sink-neutral name. It is counted apart from `failed`
because nothing is wrong with those files, and apart from `skipped` because it
is not a decision this library took. Counters seed all four from birth — the
OAuth callback writes `deferred: 0` into `lastSyncProgress` — so every record is
shaped alike and a UI can read it with `?? 0`.

---

## `connector_connections`

One connected drive. Created by the API's OAuth callback; read and updated by
the API and the workflows.

| Field | Type | Meaning |
| --- | --- | --- |
| `connectionId` | `string` | `conn-<uuid>`; unique across the collection |
| `tenantId` | `string` | scopes every query and every stored record |
| `provider` | `string` | `'onedrive' \| 'sharepoint'` in this library; the seam is documented and other providers plug in as host code |
| `driveId` | `string \| null` | resolved lazily on first browse |
| `rootFolderId` | `string \| null` | chosen subtree root; null = whole drive |
| `rootPath` | `string \| null` | human-readable root shown in listings (`/Finance/2026`) |
| `defaultLabel` | `string \| null` | opaque id from the host's `LabelPolicy` vocabulary |
| `deltaLink` | `string \| null` | Graph delta token from the last completed sync |
| `encRefreshToken` | `EncryptedToken \| null` | AES-256-GCM envelope: `{ciphertext, iv, tag}`, all base64 |
| `status` | `string?` | `'connected'`, `'syncing'`, `'disconnected'`, or host-defined transitional states |
| `createdBy` | `string?` | the `sub` of the human who connected it — audit, not authorization |
| `createdAt` | `Date?` | |
| `lastSyncStatus` | `'complete' \| 'failed'` | |
| `lastSyncAt`, `lastSyncStartedAt` | `Date?` | |
| `lastSyncProgress` | `unknown` | the workflows' `SyncProgressRecord`; kept loose here because the wire shape is additive-only and owned there |
| `lastSyncDeltaExpiredFallbacks` | `number?` | recorded on **every** sync finalize, zero included |
| `lastDeltaExpiry` | `{at, action:'full_reenumeration', detail}` | written **before** the re-enumeration runs, so a crash mid-fallback still leaves the reason visible |
| `deltaExpiryCount` | `number?` | |
| `lastIngestProgress` | `unknown` | mirror of the selective-ingest snapshot |

**The nullable fields are nullable for real reasons.**

- `driveId` is null **until the first browse**. A SharePoint site must be named
  by the admin before its drive is known, so there is nothing to store at
  connect time. The workflows refuse to walk a connection with no resolved
  drive rather than guessing one.
- `encRefreshToken` is **nulled on disconnect**. The connection keeps its
  history but can no longer mint access tokens; browse answers
  `409 connection_disconnected` instead of crashing in the decrypt and
  reporting `502 browse_failed`, which would read as "the provider is broken".
  Nulling stops future refreshes only, so `DELETE /:id` also evicts the cached
  access token.
- `defaultLabel` is null until chosen, and it is chosen **late** — at
  `POST /:id/sync` (configuration time) or `POST /:id/ingest` (step 13), never
  at connect or map time. It is a statement about file contents, and nothing
  has been read yet.
- `deltaLink` is null before the first sync completes.

`lastIngestProgress` is a **mirror**; `selective_ingest_runs` is canonical. It
exists because the connections listing is the one document a polling UI already
receives — a denominator written only where no route serves it is not progress
anybody can watch. The mirror write is best-effort on purpose: a failed mirror
must not fail an ingest that is working.

## `connector_consents`

One document per consent **event**. Never mutated. There is no update path in
the module at all.

| Field | Type | Meaning |
| --- | --- | --- |
| `consentId` | `string` | `consent-<uuid>` — for a revocation, this is the revocation's own id |
| `tenantId`, `connectionId` | `string` | |
| `subjectSub` | `string` | **required**; a consent whose actor is unknown is refused, not recorded with a placeholder |
| `subjectUpn` | `string \| null` | from the verified identity, never a request body |
| `scope` | `'map_metadata' \| 'ingest_content'` | |
| `target` | `{provider, siteId, driveId, folderId, folderPath}` | `provider` is always the connection's own |
| `exclusions` | `string[]` | at most 500, each at most 1024 chars |
| `disclosureId` | `string` | e.g. `map_metadata.v1` |
| `disclosureSha256` | `string` | lowercase hex over the text's UTF-8 bytes |
| `disclosureLocale` | `'en' \| 'es-MX'` | |
| `disclosureText` | `string` | **the full text shown, verbatim — never an i18n key** |
| `action` | `'granted' \| 'revoked'` | |
| `revokesConsentId` | `string \| null` | set only on a `revoked` event |
| `grantedAt` | `Date` | the moment of the event, for **both** actions |
| `sourceIp`, `userAgent` | `string \| null` | |

`grantedAt` is named for both actions because the record shape is uniform and
`action` already says which kind of event this is; a revocation with its own
time column would mean two documents in one collection with two different time
columns.

**Whether a consent is live is derived, not stored.** `activeConsents(events)`
filters grants whose `consentId` no later `revoked` event names. That is what
makes "what was permitted last Tuesday" a filter over the same stream rather
than a lost value.

Lifecycle: append only. Nothing deletes from this collection — a `superseded`
disclosure stays resolvable by id forever precisely so a record written last
year can still be read back.

## `map_runs`

One document per map run, written by the map workflow, read verbatim by
`GET /:id/map` and the SSE stream.

| Field | Type | Meaning |
| --- | --- | --- |
| `tenantId`, `runId`, `connectionId` | `string` | `runId` = `map-<connectionId>` |
| `provider` | `string?` | set on refusal paths too, so a consent audit needs no join to answer which provider was refused |
| `status` | `MapRunStatus` | `mapping \| complete \| failed \| refused_no_consent \| refused_out_of_scope \| unsupported_provider` |
| `consentId` | `string \| null` | **which grant authorized this run** |
| `consentDisclosureSha256` | `string \| null` | which words that grant was given on |
| `consentTarget` | `{folderId, folderPath} \| null` | the grant's scope, pinned on the run |
| `consentExclusions` | `string[]` | |
| `classifierVersion`, `artifactSha` | `string?` | which rule-artifact bytes classified this run |
| `startedAt`, `finishedAt` | `Date`, `Date \| null` | |
| `progress`, `aggregates`, `topFolders`, `pruneManifest`, `reconciliation`, `narration` | `unknown` | the flushed snapshot |
| `rollupTruncated`, `topFoldersOmitted` | `boolean`, `number` | per-top-folder rollups cap at 40; `topFoldersOmitted` counts every **item attribution** the cap dropped |
| `pruneManifestTruncated`, `pruneManifestOmitted` | `boolean`, `number` | the itemized prune manifest caps at 2000 entries; `pruneManifestOmitted` counts the rest |
| `narrationDropped` | `number` | narration keeps 300 lines; this counts what overflowed |

Every bounded accumulator carries its own truncation record. That is the rule
the whole document is built on: a bounded thing that does not say so in its
output is a silent cap. Note what the caps bound: **the itemization, never the
arithmetic.** Items in an omitted top-folder rollup still count in
`aggregates`; every pruned folder still counts in `foldersPruned` and
`prunedFolderBytes` even when its manifest entry did not fit.

Lifecycle: `startMapRun` upserts at `mapping` (`$setOnInsert` for `startedAt`);
`updateMapRunProgress` flushes unconditionally every page — a page with no
files still moved the walk, and a polling UI must see it; `finalizeMapRun`
upserts the terminal status and `finishedAt`. The finalize **upserts** so
refusal paths, where the start activity never ran, still leave a document as
evidence. Nothing deletes map runs; a re-map overwrites the same `runId`.

## `map_candidates` — the spool

Per-page candidate rows. They live here and **never in workflow state**: an
enterprise drive's candidate list would blow the `continueAsNew` payload cap.

| Field | Type | Meaning |
| --- | --- | --- |
| `tenantId`, `runId`, `connectionId` | `string` | |
| `itemId` | `string` | the remote identity selective ingest needs to fetch the file later |
| `path` | `string` | `/`-rooted breadcrumb path; the upsert key |
| `name`, `size`, `modified`, `classRule` | `string`, `number`, `string`, `string` | |

`itemId` is deliberately carried beyond the task-minimum field set: without it
the suggestions ledger could name a file it cannot act on.

Lifecycle: upserted per page on `{tenantId, runId, path}` (unique — the
idempotency the workflow assumes), consumed and **deleted** by the suggestions
write on `complete`, and swept by `finalizeMapRun` on every other terminal
status so a failed or refused run cannot orphan rows forever. A retry is a new
runId, so nothing ever reads a dead run's spool.

Delete rather than TTL, on purpose: every datum a downstream consumer needs —
`itemId` included — is carried into the suggestions rows, so the spool has
exactly one reader, retaining it would duplicate every row's bytes for nobody,
and a delete-after-write needs no TTL index.

## `map_suggestions`

One document per completed map run: the funnel table, the sensitive-shape
counts, the default selection, and the per-item verdict ledger.

| Field | Type | Meaning |
| --- | --- | --- |
| `tenantId`, `runId`, `connectionId` | `string` | |
| `funnelPolicyVersion`, `funnelPolicySha256` | `string` | provenance of the rules that produced this |
| `classifierVersion`, `classifierSha256` | `string` | |
| `candidates` | `{files, bytes}` | |
| `funnelTable` | `unknown[]` | every subtraction named and counted, in the pinned precedence order — including the propagation row and the fingerprint collapse |
| `defaultSelection` | `{files, bytes}` | |
| `sensitiveReport` | `Record<shapeId, {candidates, defaultSelection}>` | **counts**, zeros included. Never a gate, never subtracted |
| `ranking` | `{ranked: false, reason}` | |
| `rows` | `MapSuggestionRow[]` | the verdict ledger |
| `rowsTruncated`, `rowsOmitted`, `rowCap` | `boolean`, `number`, `number` | the write cap is 20,000 rows |
| `createdAt`, `writtenAt` | `Date?` | |

One ledger row:

| Field | Type | Meaning |
| --- | --- | --- |
| `itemId`, `path`, `name`, `size`, `modified` | | |
| `verdict` | `string` | `selected` \| `subtracted:<rule_id>` \| `subtracted:propagated_from:<rule_id>` \| `not_candidate:<class>` |
| `subtractedBy` | `string?` | the bare source rule id; present only on subtracted rows |
| `reportedShapes` | `string[]?` | sorted shape ids; present only when non-empty |

Two absences are deliberate and load-bearing:

- **`rank` is absent.** `ranking` says `{ranked: false}` with a reason instead
  of inventing one. Rows are in path codepoint order, which is not a quality
  ranking and does not pretend to be.
- **`reportedShapes` is reported, never acted on.** Sensitive-looking files are
  surfaced and counted; nothing subtracts them. The policy loader structurally
  refuses a rule that would.

Lifecycle: written once per run by the activity that consumes the spool. That
write is idempotency-guarded — a Temporal retry that finds the spool empty and
the suggestions document present returns the recorded summary rather than
re-evaluating an empty corpus over the top of a real one.

## `map_selections`

The customer's decision: the suggestions' default selection **minus**
`removedPaths` **plus** `readdedPaths`.

| Field | Type | Meaning |
| --- | --- | --- |
| `runId`, `tenantId`, `connectionId` | `string` | |
| `removedPaths` | `string[]` | ledger `path` values, verbatim |
| `readdedPaths` | `string[]` | |
| `decidedAt` | `Date \| string` | stamped fresh on every write |

Written by `PUT /:id/map/selection`, **rebuilt not patched**: every PUT
`$set`s the whole decision, both arrays included, keyed `{runId, tenantId}`
with `upsert: true`. `decidedAt` is what the workers sort on (latest decision
wins) and what `SelectionChangedMidRun` pins against — a patched document with a
stale `decidedAt` would let a mid-ingest re-decision go undetected.

Read back by `GET /:id/map/selection` (keyed on `runId`) and by the ingest
activities (keyed `{tenantId, connectionId}`, sorted `decidedAt` descending,
limit 1 — hence that index).

Nothing deletes selections.

## `selective_ingest_runs`

One document per selective-ingest run, `runId` = `ingest-<connectionId>`.

| Field | Type | Meaning |
| --- | --- | --- |
| `tenantId`, `runId`, `connectionId`, `provider` | | |
| `status` | | `ingesting \| complete \| failed \| refused_no_consent \| unsupported_provider` |
| `consentId`, `consentDisclosureSha256` | `string \| null` | which `ingest_content` grant authorized it |
| `mapRunId`, `decidedAt` | `string \| null` | which decided selection it executes |
| `selectedFiles`, `selectedBytes` | `number` | the denominator, from the plan |
| `funnelPolicyVersion`, `funnelPolicySha256` | `string \| null` | |
| `startedAt`, `finishedAt` | | |
| `selected`, `ingested`, `failed`, `skipped`, `deferred`, `done`, `batchesDone` | `number` | the four-state counters plus batch bookkeeping |
| `currentPath` | `string \| null` | |
| `skippedByReason` | `Record<string, number>` | rollup over the **closed** skip vocabulary |
| `failures` | `{path, name, error}[]` | the **named** reason per file — never a bare count |
| `failuresTruncated`, `failuresOmitted` | | recorded failures cap at 200 |
| `folders` | `{path, selected, ingested, skipped, failed, deferred}[]` | per-folder live rollup |
| `foldersTruncated`, `foldersOmitted` | | folder rollups cap at 200 |
| `unresolvedReaddsOmitted` | `number` | re-added paths with no ledger row, capped at 200 recorded |

Lifecycle mirrors the map: `startSelectiveIngestRun` upserts at `ingesting`,
`updateSelectiveIngestRun` flushes per batch (and mirrors onto the connection),
`finalizeSelectiveIngestRun` upserts the terminal status — again upserting so
the refusal paths leave evidence, and again mirroring so a polling screen learns
the run *ended* from the same field it watched it run in, rather than waiting
forever on a record that stopped changing.

## `MONGODB_URI` resolution

`resolveMongoUri(serviceName)` refuses to guess a URI **inside a cluster**:

- `MONGODB_URI` set → use it.
- Unset **and** `KUBERNETES_SERVICE_HOST` present → **throw**. An unset URI in
  a pod is a configuration error.
- Unset off-cluster → `mongodb://mongodb:27017`, the laptop default.

The rule was written after an outage: a service fell back to a credential-less
default, kept reporting healthy with zero restarts, and answered every request
with a 500 for hours. Two properties of that default made it possible, and
neither is about MongoDB — the fallback made the service **invisible to
configuration search** (a survey grepping manifests for `MONGODB_URI` finds
only the services that configure themselves explicitly), and it **moved the
failure from startup to first query**, so it was discovered by a user rather
than by anyone watching the rollout.
