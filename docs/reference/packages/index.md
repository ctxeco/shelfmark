---
title: Packages
parent: Reference
nav_order: 4
has_children: true
---

# Packages

Six packages plus a runnable demo. Everything is `Apache-2.0`, ESM-first,
`node >= 20`, published from `packages/*` as `@shelfmark/<name>`.

| Package | What it is | Runtime dependencies | Standalone? |
| --- | --- | --- | --- |
| [`@shelfmark/policy`](policy.md) | rules engine: artifact classifier, selection funnel, ingest filters — rules as SHA-pinned data | **none** | yes |
| [`@shelfmark/graph`](graph.md) | Microsoft Graph drive client: PKCE OAuth, drive resolution, delta, honest pagination | `axios` | yes |
| [`@shelfmark/core`](core.md) | domain types, the five ports, consent engine, cost estimate, token crypto, Mongo store | `mongodb` | needs Mongo for the store half |
| [`@shelfmark/workflows`](workflows.md) | Temporal workflows + activities | `core`, `graph`, `policy`, `@temporalio/*`, `mongodb` | needs Temporal + Mongo |
| [`@shelfmark/api`](api.md) | the Fastify plugin | `core`, `graph`, `@temporalio/client`, `fastify-plugin`, `jose`, `mongodb`; peer `fastify` ^5 | needs Mongo + a Temporal client |
| [`@shelfmark/ui`](ui.md) | React components | peer `react`, `react-dom`, `react-router-dom`, `@tanstack/react-virtual` | yes (talks HTTP) |
| `demo/` | runnable reference host: `FsDocumentSink`, server, worker, web, docker-compose | — | — |

## The dependency shape

```
policy ──┐
graph  ──┼──> workflows ──> (Temporal worker)
core   ──┘        │
  │               └── mongodb
  └──> api ──> (Fastify host)          ui ──> HTTP ──> api
```

`policy` and `graph` sit at the bottom and depend on nothing in this
repository. `policy` is genuinely zero-dependency — it does not even take
`@types/node` at runtime, and declares the one `process.env` property it reads
itself rather than pulling Node typings a consumer might conflict with.

`core` is the only package with the Mongo dependency, and it is a **hard**
dependency by design: the run records, the consent evidence, the candidates
spool and the selection ledger rely on keyed idempotent upserts that the
workflows assume. The `Db` handle is injectable (`storeFromDb`), so hosts own
connection lifecycle and tests need no running server — but there is no
alternative store backend, and none is planned.

## Enforced import boundaries

Two boundaries matter enough that violating them would break something real.

### `@shelfmark/ui` imports neither `@shelfmark/core` nor `mongodb`

Importing `core` from a browser bundle would drag `mongodb` into it. So the UI
duplicates the cost-model constants **by value** (`DEFAULT_COST_MODEL` in
`provider.tsx`) instead of importing `COST_MODEL`.

That duplication is deliberate and it is watched rather than trusted: the
DriveMap ledger runs a live mirror-vs-server equivalence check. At zero edits,
the client-side running total must reproduce the server's own emitted range;
disagreement withdraws the edited range on screen rather than showing a number
the server did not compute. Divergence between the two copies is visible, not
silent.

The UI's only coupling to a host is `<ShelfmarkProvider>`: a transport
(`baseUrl` + `headers()`), a routing adapter, a label vocabulary, and a locale.
No other origin is contacted.

### `@shelfmark/api` never imports `@shelfmark/workflows`

The API starts workflows **by string type name** over the Temporal client; it
holds the three type-name constants and the three id builders itself, and it
does not appear in its own `package.json` dependencies. That keeps the HTTP
edge free of Temporal's workflow-side toolchain and lets a host deploy the API
and the worker as separate processes with separate bundles.

The cost of a string contract is that it has no compiler on either side. In the
source system that exact gap was found broken in production: a workflow type
the API started for every event had zero occurrences in the worker — not
exported from the bundle, no handler anywhere. Every event was verified,
deduped, 200'd and dropped. Nothing failed; a workflow registered on no queue
is silent by construction.

So the pairing is pinned by a test in the workflows package that asserts each
promised `(workflowType, taskQueue)` against the actual bundle exports:
`driveMapWorkflow`, `selectiveIngestWorkflow`, `connectorSyncWorkflow`, all on
`DEFAULT_TASK_QUEUE` (`shelfmark-queue`). Temporal resolves workflow types out
of the bundle by **export name**, so "is it exported from the bundle" is not a
proxy for "is it registered" — it *is* the registration. The id builders exist
in both packages with identical bodies for the same reason: the workflowId is
also the runId the status routes look up.

### The workflow bundle exports exactly three functions

`packages/workflows/src/workflows/index.ts` exports the three workflows and
nothing else. An extra exported function there would register a bogus workflow
type.

## Constants a host is expected to know

| Constant | Value | Package |
| --- | --- | --- |
| `LIST_ALL_CHILDREN_CEILING` | 2000 children per browse call | graph |
| `MAX_SUGGESTION_ROWS` | 20,000 ledger rows (write cap) | workflows |
| suggestions response page cap | 2000 rows (`rowsPageCap`) | api |
| SSE frame cap | 32,000 bytes | api |
| `MAX_EXCLUSIONS` | 500 consent exclusions | core |
| `INGEST_CONCURRENCY` | 15 concurrent downloads per batch | policy |
| `DEFAULT_MAX_INGEST_FILE_BYTES` | 25 MiB | policy |
| `SELECTIVE_INGEST_BATCH_SIZE` | 20 files | workflows |
| `DEFAULT_TASK_QUEUE` | `shelfmark-queue` | workflows |
