---
title: Configuration
parent: Getting started
nav_order: 4
---

# Configuration

Everything shelfmark reads, in one place: environment variables first, then
the two option objects a host constructs in code (the Fastify plugin's
options and the Temporal worker's activity dependencies).

Two rules govern the whole surface, and they are worth reading before the
tables:

1. **A value that would be dangerous to guess has no default.** The plugin
   throws at register without `publicBaseUrl`; the store refuses a
   credential-less fallback when it can tell it is running in a cluster. A
   fail-fast boot is cheaper than a wrong value discovered by a user.
2. **Workflow code reads no environment at all.** Temporal workflow code runs
   in a deterministic sandbox that does not reliably expose `process.env`, so
   every workflow tunable is a *workflow input* instead. Env vars are read in
   activities, in the API process, and at module load — never inside a
   workflow.

## Required by the connector

These four are what the Microsoft connector cannot function without.

| Variable | Required | Default | Controls | If it is wrong |
| --- | --- | --- | --- | --- |
| `CONNECTOR_MS_CLIENT_ID` | yes | none | The Entra app registration's client id, used to build the authorize URL and to exchange the code. | Missing or empty on either credential → `GraphConnectorError: Microsoft connector not configured — CONNECTOR_MS_CLIENT_ID/CLIENT_SECRET must both be set`. Wrong value → Microsoft rejects the authorize request. |
| `CONNECTOR_MS_CLIENT_SECRET` | yes | none | The client secret **value** from Certificates & secrets. | As above. An expired secret surfaces as a failed token exchange, i.e. a redirect to `?error=connect_failed`. |
| `CONNECTOR_OAUTH_STATE_SECRET` | yes | none | HMAC key (HS256) for the signed, short-TTL OAuth state JWT. Passed to the plugin as `config.stateSecret`. | Under 32 bytes → the plugin throws at register. This JWT is the *only* thing authenticating the anonymous OAuth callback, so a short secret silently weakens the whole flow. Rotating it invalidates in-flight authorizations. |
| `CONNECTOR_TOKEN_ENCRYPTION_KEY` | yes | none | AES-256-GCM data-encryption key protecting refresh tokens at rest. | Absent → `CONNECTOR_TOKEN_ENCRYPTION_KEY is not configured`. Not exactly 32 bytes after base64-decoding → `must decode to exactly 32 bytes (AES-256)`. **Changing it makes every already-stored refresh token undecryptable** — every connection must be re-authorized. |

{: .warning }
> `@shelfmark/graph` captures `CONNECTOR_MS_CLIENT_ID` and
> `CONNECTOR_MS_CLIENT_SECRET` **at module load**, when its `oauth` module is
> first evaluated. Setting them after that has no effect. This is why the
> demo's `src/env.ts` is the very first import in both `server.ts` and
> `worker.ts` — ESM evaluates dependencies in import-declaration order, so
> that ordering is a real guarantee, not a style choice. If you load a `.env`
> file yourself, load it before you import any `@shelfmark/*` module.

### Generating the two secrets

```bash
# CONNECTOR_OAUTH_STATE_SECRET — at least 32 bytes
openssl rand -base64 48

# CONNECTOR_TOKEN_ENCRYPTION_KEY — base64 of EXACTLY 32 bytes
openssl rand -base64 32
```

The sizes are checked, not suggested: the state secret is measured as UTF-8
bytes and must be ≥ 32; the DEK is base64-decoded and must be exactly 32 bytes.
`pnpm demo:doctor` verifies both before you ever reach an OAuth round trip.

{: .note }
> A deployment pattern worth stealing, from the system this was extracted
> from: seed the provider client id and secret with the literal string
> `DISABLED-not-configured` so the stack deploys green and the connector fails
> **closed** with a named error until real credentials exist. No deployment
> ever blocks on an app registration.

## Store and infrastructure

| Variable | Required | Default | Controls | If it is wrong |
| --- | --- | --- | --- | --- |
| `MONGODB_URI` | see note | demo: `mongodb://localhost:27017`; `@shelfmark/core`'s `resolveMongoUri`: `mongodb://mongodb:27017` off-cluster, **throws** in-cluster | The connector-private database. | Unreachable → the demo's boot fails at `mongo.connect()` with a five-second server-selection timeout. |
| `MONGODB_DB` | no | `shelfmark` (demo and `DEFAULT_STORE_DB_NAME`) | Database name inside that server. | A typo silently gives you an empty database: no connections, no consents, no map runs. |
| `KUBERNETES_SERVICE_HOST` | — | injected by the kubelet | Not yours to set. It is the discriminator `resolveMongoUri` uses to decide whether an unset `MONGODB_URI` is a convenience or a configuration error. | — |
| `TEMPORAL_ADDRESS` | no | `localhost:7233` (demo) | Temporal frontend, `host:port`. | Unreachable → the server and worker fail at connect. Pointing the API and the worker at different clusters is worse: workflows start and never run. |
| `PORT` | no | `8787` (demo) | Port the demo's Fastify server listens on (`host: 0.0.0.0`). | Changing it without changing `PUBLIC_BASE_URL` breaks the OAuth redirect. |

{: .important }
> `resolveMongoUri` (used by `createStoreClient` when you pass no URI) refuses
> the credential-less default **when `KUBERNETES_SERVICE_HOST` is set**, and
> throws instead. That behaviour was written after a real outage: a service
> with no `MONGODB_URI` in its manifest fell back to a credential-less
> default, kept reporting healthy with zero restarts, and answered every
> request with a 500 for hours once auth was enabled on the database. Two
> properties made that possible — relying on a default made the service
> **invisible to a configuration grep**, and it moved the failure from startup
> to first query. On a laptop the feedback loop is a developer looking at a
> terminal, so the convenient default stays.

## The public base URL

| Variable | Required | Default | Controls | If it is wrong |
| --- | --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | **yes** | **none, deliberately** | The externally reachable origin. It builds the OAuth redirect URI: `<PUBLIC_BASE_URL><prefix>/microsoft/callback`. A trailing slash is stripped. | A wrong value is a **live OAuth misconfiguration** — the identity provider redirects the user's authorization code to whatever host the value names. Mismatch with the registered Entra URI is rejected by Microsoft before your code sees anything. |

The plugin refuses to register without it, and the error says why:

```
@shelfmark/api requires options.config.publicBaseUrl — it builds the OAuth
redirect URIs and has deliberately no default
```

The mounted prefix rides into the redirect URI via `fastify.prefix`, so the
route that is registered and the URI you hand to Entra cannot drift apart.
With the demo's prefix (`/api/v1/connectors`) the URI is
`<PUBLIC_BASE_URL>/api/v1/connectors/microsoft/callback`.

## Policy artifacts

`@shelfmark/policy` ships its rule sets as versioned JSON under `vendor/` and
loads them by path, hashing the bytes so a run can record which rules
classified it. Each override exists so an operator can swap rules without a
code change.

| Variable | Required | Default | Controls | If it is wrong |
| --- | --- | --- | --- | --- |
| `ARTIFACT_CLASSES_PATH` | no | vendored `artifact-classes.v1.json` | The artifact classifier's rule set. | A configured-but-unreadable path **throws** — `artifact-classes: cannot read <path>` — it never silently falls back to the vendored copy. |
| `FUNNEL_POLICY_PATH` | no | vendored `funnel-policy.v1.json` | The selection funnel's per-item rules and shapes. | Same contract: unreadable throws (`FunnelPolicyError`). |
| `SELECTION_POLICY_PATH` | no | vendored `selection-policy.v1.json` | The selection half of the funnel. | Same contract. |
| `CONNECTOR_MAX_INGEST_FILE_BYTES` | no | `26214400` (25 MiB) | The ceiling returned by `maxIngestFileBytes()`. | A malformed or non-positive value falls back to the default rather than disabling the bound — an unparseable env var must never read as "no limit". |

Both loaders write a one-line load record to **stderr**, not stdout
(`artifact_classes_loaded version=… sha256=… source=…`), because comparison
tooling treats stdout as a pure data channel.

{: .note }
> `CONNECTOR_MAX_INGEST_FILE_BYTES` is honoured by `maxIngestFileBytes()` in
> `@shelfmark/policy`. Nothing in the shipped workflows calls that helper
> today — it is there for hosts applying the ingest filters themselves. The
> default is a derivation, not a round number: the ingest batch holds up to
> `INGEST_CONCURRENCY` files in memory and each exists twice at peak (the
> downloaded buffer plus the multipart copy), so `15 × 2 × ceiling` has to sit
> well under a 2 GiB worker limit. Raising it without lowering concurrency
> buys an OOM kill, which fails the whole batch — including the files that
> were fine.

## Locale

| Variable | Required | Default | Controls | If it is wrong |
| --- | --- | --- | --- | --- |
| `UI_LOCALE` | no | `en` | The **server-side default** consent locale when a request names none. Anything starting with `es` maps to `es-MX`; everything else to `en`. | It is a default, not a wire alias: a request that explicitly asks for an unreviewed locale is still refused. Substituting text for a locale that was never reviewed, on a record asserting the subject read it, is the same false-record failure as falling back to English. |

## Demo-only variables

Read by `demo/src/config.ts` and the demo sinks. None of them exist in the
libraries.

| Variable | Required | Default | Controls | If it is wrong |
| --- | --- | --- | --- | --- |
| `DEMO_DATA_DIR` | no | `./data`, resolved against the process working directory | Where `FsDocumentSink` writes bytes, `.txt` sidecars, `manifest.jsonl`, `search-index.json` and `documents.json`. | A different directory for server and worker means the worker writes a corpus the search endpoint cannot see. |
| `DEMO_LABELS` | no | absent → `[]` | Sensitivity-label vocabulary, as a JSON array of `{"id","label"}`. Present → a static `LabelPolicy` offering exactly those ids, defaulting to the first; absent → the default hidden-label policy, in which every label control disappears. | Invalid JSON, a non-array, or an entry missing a string `id`/`label` → `DemoConfigError` at boot, naming the index. |
| `DEMO_DEFER_OVER_MB` | no | unset → never defer | Demonstrates the sink's `deferred` outcome: files strictly larger than this many MB answer `{status:'deferred'}` on the first pass and are accepted on the `isRetry` re-submission. | A negative or non-numeric value → `DemoConfigError` at boot. |
| `DEMO_SINK` | no | `fs` | `fs` builds the local searchable corpus; `s3` switches to the S3-compatible reference sink. | Any other value → `DemoConfigError: DEMO_SINK must be 'fs' (default) or 's3'`. |
| `S3_BUCKET` | when `DEMO_SINK=s3` | none | Destination bucket. | Missing → a named `DemoConfigError` at boot. |
| `S3_ENDPOINT` | no | unset (AWS) | Custom S3-compatible endpoint. Setting it also turns on path-style addressing. | Unset against a non-AWS endpoint → the SDK targets AWS. |
| `S3_PREFIX` | no | `''` | Key prefix for objects and manifest entries. | — |
| `AWS_REGION` | no | `us-east-1` | Region passed to the S3 client. | — |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | no | — | Not read by shelfmark code; consumed by the AWS SDK's default credential chain, which also accepts profiles and instance roles. | Absent with no other credential source → the SDK fails on the first `PutObject`. |

The demo validates all of these in **one place** and fails at boot with the
offending variable named. The libraries' own rules would each surface
eventually — but at the first OAuth round trip rather than at startup, which
is a much worse place to learn about a typo.

## `@shelfmark/api` — plugin options

One `register` call mounts the whole HTTP surface. The options type is
`ShelfmarkApiOptions`:

```ts
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { Client, Connection } from '@temporalio/client';
import shelfmarkApi from '@shelfmark/api';
import { ensureStoreIndexes } from '@shelfmark/core';

const mongo = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5000 });
await mongo.connect();
const db = mongo.db('shelfmark');
await ensureStoreIndexes(db);

const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS! });
const app = Fastify({ logger: true });

await app.register(shelfmarkApi, {
  prefix: '/api/v1/connectors',
  db,                                   // a connected mongodb Db
  ports,                                // your five seams; resolveAuth is required here
  temporal: {
    client: new Client({ connection }),
    taskQueue: 'shelfmark-queue',        // must match the worker's queue
  },
  config: {
    publicBaseUrl: process.env.PUBLIC_BASE_URL!,          // REQUIRED, no default
    stateSecret: process.env.CONNECTOR_OAUTH_STATE_SECRET!, // REQUIRED, >= 32 bytes
    returnPath: '/connections',          // default '/connectors'
    // disclosureRegistry: myRegistry,   // default: core's vendored, SHA-pinned set
    // mapStream: { pollMs: 700, heartbeatMs: 15_000, noRunTimeoutMs: 5_000 },
  },
});
```

The type, verbatim from `packages/api/src/types.ts`:

```ts
export interface ShelfmarkApiOptions {
  /** The database holding the connector-private collections. */
  db: Db;
  /** The five host seams. Only resolveAuth is strictly required here. */
  ports: ShelfmarkPorts;
  /** The durable-execution client and the task queue the workers listen on. */
  temporal: { client: WorkflowStartClient; taskQueue: string };
  config: ShelfmarkApiConfig;
}
```

What the plugin validates at register, and the error you get:

| Missing / wrong | Error |
| --- | --- |
| `db` | `@shelfmark/api requires options.db (a connected mongodb Db)` |
| `ports.resolveAuth` not a function | `@shelfmark/api requires options.ports.resolveAuth (the AuthContextResolver port)` |
| `temporal.client` or `temporal.taskQueue` | `@shelfmark/api requires options.temporal ({ client, taskQueue })` |
| `config.publicBaseUrl` empty | the no-default message quoted above |
| `config.stateSecret` empty | `@shelfmark/api requires options.config.stateSecret` |
| `config.stateSecret` under 32 bytes | `@shelfmark/api: config.stateSecret must be at least 32 bytes` |

`ports.tenantPolicy` defaults to `DEFAULT_TENANT_POLICY` (connectors and
mapping enabled) and `ports.labelPolicy` to `DEFAULT_LABEL_POLICY`
(`labels()` returns `[]`, which hides every label control).

### The SSE stream knobs

`config.mapStream` tunes the map-narration stream. All three are numbers and
all three are sanitized at register:

| Field | Default | Meaning |
| --- | --- | --- |
| `pollMs` | `700` | Poll cadence against the run document — the narration engine's minimum per-line pace, so the stream runs at reading speed. |
| `heartbeatMs` | `15000` | Idle threshold before an SSE comment heartbeat. |
| `noRunTimeoutMs` | `5000` | How long a stream opened before the workflow's first write waits for a run document before framing a 404 and closing. |

{: .note }
> Non-finite and negative values fall back to the defaults, because a host
> reading these from an env var can hand over `Number('15s')` — `NaN` — and
> every `elapsed >= NaN` comparison is false, which would silently turn
> heartbeats **off** and let a proxy cut exactly the long quiet walks the
> heartbeat exists to protect. `0` is preserved for `heartbeatMs` (it means
> always-due, which tests rely on), so the sanitizer is a range check rather
> than the `|| default` idiom, which eats zero.

## `@shelfmark/workflows` — worker dependencies

A worker is built from exactly two things: the activity registry produced by
`createActivities(deps)`, and the workflow bundle entry.

```ts
import { createRequire } from 'node:module';
import { MongoClient } from 'mongodb';
import { NativeConnection, Worker } from '@temporalio/worker';
import { ensureStoreIndexes, storeFromDb } from '@shelfmark/core';
import { createActivities } from '@shelfmark/workflows';

const mongo = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5000 });
await mongo.connect();
const db = mongo.db('shelfmark');
await ensureStoreIndexes(db);

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS! });

// Resolve the package's workflow SOURCE through its export map — never a
// hardcoded path into the package's file layout.
const workflowsPath = createRequire(import.meta.url).resolve(
  '@shelfmark/workflows/workflows-source'
);

const worker = await Worker.create({
  connection,
  taskQueue: 'shelfmark-queue',
  workflowsPath,
  activities: createActivities({
    store: storeFromDb(db),
    ports,
    config: { taskQueue: 'shelfmark-queue' },
  }),
});

await worker.run();
```

The dependency bag, verbatim from `packages/workflows/src/deps.ts`:

```ts
export interface ShelfmarkWorkflowDeps {
  /** The connector-private Mongo store (@shelfmark/core `storeFromDb` /
   *  `createStoreClient`). */
  store: ShelfmarkStore;
  /** The five host seams (ports.ts). `sink` and `resolveAuth` are the two a
   *  host must supply; the rest default per the ports contract. */
  ports: ShelfmarkPorts;
  config?: ShelfmarkWorkflowsConfig;
}

export interface ShelfmarkWorkflowsConfig {
  /** Task queue the host serves these workflows on. Also the queue its
   *  start helpers must use — see DEFAULT_TASK_QUEUE. */
  taskQueue?: string;
}
```

`DEFAULT_TASK_QUEUE` is `'shelfmark-queue'`. One queue serves all three
workflow types.

{: .warning }
> The task queue in the plugin's `temporal.taskQueue` and the worker's
> `taskQueue` must be the same string. They are not validated against each
> other — they cannot be, since the two live in different processes. When they
> differ, the API starts workflows successfully and nothing ever executes
> them: the UI waits on a run that produces no lines. The Temporal Web UI
> shows the workflow queued with no worker polling.

`@shelfmark/workflows/workflows-source` points at `src/workflows/index.ts`,
shipped in the package's `files`, because `@temporalio/worker` bundles
TypeScript workflow source itself. Resolve it through the export map, as
above, rather than reaching into the package's internals.

## The ports

```ts
export interface ShelfmarkPorts {
  sink: DocumentSink;
  resolveAuth: AuthContextResolver;
  /** Default: everything enabled, no default label. */
  tenantPolicy?: TenantPolicy;
  /** Default: labels()=[] (label UI hidden), resolve()='default'. */
  labelPolicy?: LabelPolicy;
  /** Default: allow. See the fail-closed contract above. */
  egressGate?: EgressGate;
}
```

`DEFAULT_TENANT_POLICY`, `DEFAULT_LABEL_POLICY` and `ALLOW_ALL_EGRESS` are
exported from `@shelfmark/core` so hosts and tests can compose from them.

{: .important }
> An **absent** `egressGate` means allow — that is the contract, and it is a
> decision you are making. A gate that **is** configured and throws is
> something else entirely: it must be treated as a retryable outage, so the
> run pauses. It never proceeds as if allowed. A missing gate is a decision; a
> broken gate is an outage.

## See also

- [Entra app setup](entra-setup.md) — where the two `CONNECTOR_MS_*` values
  come from, and the callback path an auth gateway must exempt.
- [Running the demo](running-the-demo.md) — these variables in a working
  `.env`.
- [Reference](../reference/index.md) — routes, types and error codes.
