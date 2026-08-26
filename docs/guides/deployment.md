---
title: Deployment
parent: Guides
nav_order: 5
---

# Deployment

What it takes to run this for real, and — equally — what this project does not
give you.

{: .warning }
> This page describes the components, the constants that bound them, and the
> signals worth watching. It is **not** a production runbook. There is no
> high-availability guidance, no Kubernetes manifests, no Helm chart, no
> metrics exporter, and no managed offering. The demo's `docker-compose.yml`
> is a demo topology (a single-node Temporal dev server writing to a local
> file, a single-node Mongo, bind-mounted data) and is not a starting point
> for production.

## Node 20 on glibc — never alpine

```
node:20-slim, NEVER alpine: @temporalio/core-bridge is a native (Rust)
module linked against glibc; musl-based images fail at require time.
```

That comment is in `demo/Dockerfile` and it is the single most important
packaging fact here. The Temporal SDK's core bridge is a compiled native
addon. On a musl-based image (alpine and friends) it does not fail at build
time or at deploy time — it fails when the worker process first `require`s it,
which is to say in production, at start, with a linker error rather than
anything that names the real problem.

`engines.node` is `>=20` across every package and `.nvmrc` pins `20`. Both
processes — the API and the worker — should run the same runtime.

## The components

Five moving parts. Only the first two are yours to write.

| Component | What it is | Notes |
| --- | --- | --- |
| **API process** | Your Fastify app with `@shelfmark/api` registered | Starts workflows; never runs them. Serves the OAuth callback, so it must be reachable at `publicBaseUrl`. |
| **Temporal worker** | A process running `createActivities(deps)` against the workflow bundle | Does all the real work: walking, downloading, calling your sink. Needs outbound network to the provider and to whatever your sink writes. |
| **Temporal server** | Durable execution | Any deployment you like. The workflows use `continueAsNew` to keep history bounded. |
| **MongoDB** | Seven connector-private collections | Consent evidence, run records, the candidate spool, the selection ledger. See below on write concern. |
| **Your sink's storage** | Whatever `accept()` writes to | Entirely outside this project's knowledge. |

The two processes must agree on the **task queue** string and should build
their ports object from the same code — the API's `ports` and the worker's
`ports` describe the same policy, and only the worker's `sink` is ever called.

Wiring for both is in [Mounting the API](api-integration.md).

### The database

Seven collections, all created on demand:

`connector_connections` · `connector_consents` · `map_runs` ·
`map_candidates` · `map_suggestions` · `map_selections` ·
`selective_ingest_runs`

Call `ensureStoreIndexes(db)` at startup in **both** processes. It is
idempotent. The load-bearing one is the candidate spool's unique index —
`map_candidates` upserts are keyed on `(tenantId, runId, path)`, and without
that index a Temporal activity retry re-inserts instead of re-asserting.

Consent writes use `w: 'majority', j: true`, an unacknowledged write throws,
and every error propagates to the caller, which refuses the operation. That is
deliberate — the difference between an audit log and evidence — but it means
your Mongo deployment has to be able to acknowledge majority journaled writes,
and that a database under write pressure will refuse consents rather than
quietly proceeding without them.

## Environment variables the library itself reads

Almost everything is passed as options. Exactly three environment variables
are read inside the packages:

| Variable | Read by | When | Notes |
| --- | --- | --- | --- |
| `CONNECTOR_MS_CLIENT_ID` | `@shelfmark/graph` | **at module load** | Must be set before the module is imported. |
| `CONNECTOR_MS_CLIENT_SECRET` | `@shelfmark/graph` | **at module load** | Same. |
| `CONNECTOR_TOKEN_ENCRYPTION_KEY` | `@shelfmark/core` | per call | Base64 of exactly 32 bytes. |
| `CONNECTOR_MAX_INGEST_FILE_BYTES` | `@shelfmark/policy` | per call | Optional override of the 25 MiB ceiling. Read per call so an operator can change it without a code change. A malformed or non-positive value falls back to the default rather than disabling the bound — an unparseable value must never read as "no limit". |

The module-load timing on the first two is a real constraint: the demo's
`src/env.ts` is imported as the *first* import of both entry points precisely
so the `.env` values exist before `@shelfmark/graph` evaluates. In a container
where the environment is set by the platform, this is a non-issue.

`publicBaseUrl`, `stateSecret`, the Mongo handle, the Temporal client and the
task queue are all plugin **options**, not environment variables. What you
call them in your own configuration is your business.

## Scaling, from the code's own constants

Every number below is a named constant with a stated derivation. None of them
is configurable by environment variable except where noted; the map and ingest
`continueAsNew` thresholds are configurable per-workflow-input, which exists so
tests can exercise the resume path without hundreds of real items.

### Ingest

| Constant | Value | Where | Meaning |
| --- | --- | --- | --- |
| `INGEST_CONCURRENCY` | `15` | `@shelfmark/policy` | Concurrent downloads inside one batch activity. Your sink is called up to this many times at once. |
| `DEFAULT_MAX_INGEST_FILE_BYTES` | 25 MiB | `@shelfmark/policy` | Largest file opened. Overridable via env. |
| `SELECTIVE_INGEST_BATCH_SIZE` | `20` | `@shelfmark/workflows` | Files per `ingestFileBatch` activity call. |
| `DEFAULT_SELECTIVE_INGEST_BATCHES_PER_RUN` | `25` | `@shelfmark/workflows` | `continueAsNew` threshold: 25 × 20 = 500 files per execution. |
| `MAX_RECORDED_INGEST_FAILURES` | `200` | `@shelfmark/workflows` | Per-file failures itemized. Beyond it, `failuresTruncated: true` and `failuresOmitted` counts the rest — the failed *count* still counts every failure. |

**Worker memory is derived from the first two, and they must be read
together.** The batch holds up to `INGEST_CONCURRENCY` files in memory, and
each exists roughly twice at its peak (the downloaded buffer plus whatever
copy your sink makes on its way out). At 15 × 2 × 25 MiB that is about 750 MiB
of file bytes at full fan-out, which is why the ceiling was chosen against a
2 GiB worker limit. Raising the ceiling without lowering the concurrency buys
an OOM kill, and an OOM kill fails the whole batch — including the files that
were fine.

### The map walk

| Constant | Value | Meaning |
| --- | --- | --- |
| `DEFAULT_MAP_PAGES_PER_RUN` | `200` | `continueAsNew` threshold in pages. Pages are the map's unit of work, since it ingests nothing. |
| listing page size | `200` | `$top` on the walk's folder listing. |
| `MAX_TOP_FOLDER_ROLLUPS` | `40` | Per-top-level-folder rollups kept. Beyond it, `rollupTruncated: true` and `topFoldersOmitted` counts every dropped attribution — the items still count in the aggregates. |
| `MAX_PRUNE_MANIFEST_ENTRIES` | `2000` | Itemized prunes kept. `pruneManifestTruncated` + `pruneManifestOmitted` beyond it; `foldersPruned` and `prunedFolderBytes` still count every prune. |
| `NARRATION_MAX_LINES` | `300` | Narration lines kept; `narrationDropped` counts the overflow. |
| `ITEMS_NARRATION_STRIDE` | `2500` | One milestone narration line per this many items. |
| `MAX_SUGGESTION_ROWS` | `20000` | Rows in the suggestions ledger. |

### Browse and sync

| Constant | Value | Meaning |
| --- | --- | --- |
| browse page size | `200` default, `999` max | The provider's own ceiling for the listing call. |
| `LIST_ALL_CHILDREN_CEILING` | `2000` | Where the follow-the-pages convenience stops, with `truncated: true`. |
| sync batch size | `20` | Files per ingest activity call on the sync path. |
| sync `continueAsNew` | `500` items | Same item budget as the selective ingest's hop. |
| `MAX_FOLDER_ROLLUP_ENTRIES` | `200` | Per-folder progress rows in the ingest run document. |

### The narration stream

| Constant | Value | Meaning |
| --- | --- | --- |
| frame cap | 32 000 bytes | A frame over this is dropped and logged, never silently shrunk. The terminal frame degrades by shedding itemizations, each shed explicitly flagged. |
| `pollMs` | `700` | Run-document poll cadence (configurable). |
| `heartbeatMs` | `15000` | Idle threshold before a comment heartbeat (configurable). |
| access-token cache | 1000 entries, 60 s safety margin | Bounded so a long-lived process with many connections cannot grow without limit; a token stops being served a minute before the provider stops honoring it. |

Every one of these bounds **records itself when it bites**. That is the design
rule the codebase applies without exception: a bounded thing that does not say
so in its output is a silent cap, and silent caps are the defect class this
project keeps finding. It also means your monitoring has real fields to read
rather than inferences to make.

## What to monitor

Everything here is a document field or a log line that already exists. There is
no metrics endpoint and no OpenTelemetry wiring — exporting these is your job.

**Run records — `map_runs`**

- `status` — terminal values include `unsupported_provider` and the refusal
  paths, which are *not* failures and should not page anyone.
- `narrationDropped`, `rollupTruncated` / `topFoldersOmitted`,
  `pruneManifestTruncated` / `pruneManifestOmitted` — a bound bit. Persistent
  non-zeros mean customers are routinely hitting a cap and the ledger they see
  is itemized less completely than it looks.
- `classifierVersion` / `artifactSha` — which rule-artifact bytes classified
  the run. A map classified under two rule sets is not a map of anything, so
  the workflow pins these on the first page and fails the run if a mid-run
  artifact swap changes them. Watch for those failures after a deploy that
  changes the artifact.
- `consentId` / `consentDisclosureSha256` — which grant authorized the run.

**Run records — `selective_ingest_runs`**

- `deferred` — **the count worth alerting on.** A sink that starts deferring is
  telling you it is under pressure, and nothing in this library re-offers those
  files: a rising `deferred` with no corresponding retry activity means work is
  quietly not happening. See
  [the sink guide](document-sink.md#contract-3--deferred-means-not-now-and-nothing-re-offers-it-for-you).
- `failed` with `failuresTruncated` / `failuresOmitted` — the itemization is
  bounded at 200 even though the count is not.
- `skippedByReason` — a per-reason rollup over the closed skip vocabulary, so
  you can tell "412 files skipped" apart from *which bound* skipped them.
  `too_large` climbing means the ceiling is wrong for this customer;
  `unsupported_type` climbing is usually just a media-heavy drive.
- `ingested` vs `done` — a run that finished is not a run that worked. The
  ingest status screen ranks a failure above a deferral above a did-nothing
  card for exactly this reason; your dashboards should too.

**Throttling**

A provider 429 is translated into a durable failure carrying the provider's
own `Retry-After` as the next retry delay, so throttling shows up as *activity
retries with long gaps*, not as errors. Watch Temporal's activity retry counts
for the map and ingest activities. The retry policy is **not** the same on both:
the map's walk activities (and every other lightweight activity) are five
attempts with a 5 s initial interval and a coefficient of 2 under a 2-minute
start-to-close timeout, while `ingestFileBatch` — the activity that downloads
and calls your sink — is **three attempts with a 10 s initial interval** and the
same coefficient, under a 10-minute start-to-close timeout. A provider 429
overrides that backoff with the provider's own `Retry-After` either way.

**Delta expiry (sync path only)**

- `connector_connections.deltaExpiryCount` — monotonically increasing counter.
- `connector_connections.lastDeltaExpiry` — `{ at, action:
  'full_reenumeration', detail }`, written **before** the re-enumeration runs,
  so even a crash mid-fallback leaves the reason visible.
- `connector_connections.lastSyncDeltaExpiredFallbacks` — recorded on every
  sync finalize, **zero included**: "this sync did not re-enumerate" is a fact
  a completion screen needs as much as the opposite.

A connection whose expiry count is climbing is doing a full re-crawl every
time — expensive, and usually a sign of sync cadence versus the provider's
token lifetime.

**Stream health**

The frame-drop path logs at error level with the connection id, the byte size
and the frame type. It should be rare; a steady trickle means a customer's map
is producing frames larger than the cap and the terminal frame is degrading.

## Secrets

**The data-encryption key protects OAuth refresh tokens at rest. It does not
protect your corpus.**

Say that out loud to whoever asks, because the acronym invites the opposite
assumption. `CONNECTOR_TOKEN_ENCRYPTION_KEY` is an AES-256-GCM key used for
envelope-encrypting one field — `encRefreshToken` on the connection document.
The reason it exists is that a refresh token is a per-tenant secret *minted at
runtime* when a human completes an OAuth flow, so unlike deploy-time secrets it
has nowhere to be provisioned ahead of time. Ciphertext in the database plus a
single per-environment key sourced like every other static secret keeps it
consistent with the rest of the secret handling.

What it does **not** cover: the documents your sink stores, the extracted text,
the map's file names and paths, the consent records, or anything else in the
database. Encrypting those is your platform's problem and this library takes no
position on it.

**Rotating the key is a re-encryption migration, not a config change.** From
`tokenCrypto.ts`: any change to the algorithm, IV size, tag length or key
sourcing is a wire-format change for every stored token, and a coordinated
re-encryption has to happen first. Rotating the key value itself has the same
shape — every `encRefreshToken` in the database must be decrypted under the old
key and re-encrypted under the new one, with both keys available during the
window. Swapping the value alone breaks every existing connection, and it
breaks it as "cannot decrypt" at the next sync rather than as anything visible
at deploy time. There is no rotation tooling in this repo.

**The state secret** (`config.stateSecret`) rotates cheaply: the JWTs it signs
have a 10-minute expiry, so rotation invalidates only OAuth flows currently in
flight. Those users see `invalid_or_expired_state` and click connect again.

**The provider client secret** rotates on the identity provider's schedule.
Note that it is captured at module load, so rotating it means restarting both
processes.

## Backup and durability

Not all seven collections are equally precious.

**`connector_consents` is evidence.** It is append-only and never mutated — a
revocation is a *new* event carrying `revokesConsentId`, not a status
overwrite, so the answer to "what was permitted on the twelfth" is still in
there. Each record stores the disclosure text shown to the subject verbatim,
plus its SHA-256, its id and its locale — never an i18n key. Back it up
like you back up things you may one day have to show a regulator or a court,
and keep the backups at least as long as your retention obligations. Losing
this collection does not break the software; it destroys your ability to prove
what anyone agreed to.

**`connector_connections` is unrecoverable without the key.** It holds the
encrypted refresh tokens. A restore that does not also restore (or retain) the
data-encryption key gives you connection records that cannot mint a token —
every connection has to be reconnected by a human doing the OAuth flow again.

**`map_runs`, `map_candidates`, `map_suggestions`, `map_selections` and
`selective_ingest_runs` are reconstructible** by re-running a map, at the cost
of the provider calls. They are history and working state, not evidence. Back
them up if you want continuity of the ledger a customer is looking at; nothing
is permanently lost without them.

**Your sink's storage is outside all of this.** The library has no backup
story for your corpus because it has no idea what your corpus is.

## What this project does not provide

Stated plainly so nobody discovers it during an incident:

- **No high-availability guidance.** How many API replicas, how many workers,
  how to size Temporal, what to do in a region failure — none of that is here.
- **No Kubernetes manifests, no Helm chart, no Terraform.** The demo ships a
  `docker-compose.yml` for a laptop and a `Dockerfile` that builds both
  processes from the workspace.
- **No metrics or tracing integration.** The signals above are document fields
  and log lines. Nothing exports them.
- **No rate limiting, no quota enforcement, no per-tenant throttling** beyond
  honoring the provider's own `Retry-After`.
- **No migration tooling** — not for the store schema, not for key rotation,
  not for the disclosure artifact.
- **No support SLA.** The project is best-effort: extracted from a production
  system and maintained as time allows.

## Where to go next

- [Mounting the API](api-integration.md) — process wiring, worker startup, the
  proxy requirements for the stream.
- [Implementing a DocumentSink](document-sink.md) — the concurrency and
  idempotency contracts the constants above imply.
- [Known limitations](../project/known-limitations.md) — what the system does
  not claim.
