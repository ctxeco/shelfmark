---
title: Mounting the API
parent: Guides
nav_order: 2
---

# Mounting the API

`@shelfmark/api` is a Fastify plugin. One `register` call wires the whole HTTP
surface: connections and OAuth, browse, the map plus its narration stream, the
Decide flow, selective ingest, and the consent routes.

It is `fastify-plugin`-wrapped with `encapsulate: true`, which means the routes
live in their own context: your `prefix` applies normally, nothing leaks
decorators onto your root instance, and a root-level auth hook of yours still
propagates *into* this context (root hooks reach every child plugin).

Fastify **5.x** is required — the plugin declares it. For the routes it
registers, see the [HTTP API reference](../reference/http-api.md).

## The options object

From `packages/api/src/types.ts`:

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

Four validations run at register time and each throws rather than defaulting:

| Missing | Error |
| --- | --- |
| `db` | `requires options.db (a connected mongodb Db)` |
| `ports.resolveAuth` | `requires options.ports.resolveAuth (the AuthContextResolver port)` |
| `temporal.client` / `temporal.taskQueue` | `requires options.temporal ({ client, taskQueue })` |
| `config.publicBaseUrl`, `config.stateSecret` | see below |

### `config`

```ts
export interface ShelfmarkApiConfig {
  publicBaseUrl: string;   // REQUIRED, no default
  stateSecret: string;     // REQUIRED, >= 32 bytes
  returnPath?: string;     // default '/connectors'
  disclosureRegistry?: DisclosureRegistry;  // default: core's vendored artifact
  mapStream?: MapStreamConfig;
}
```

**`publicBaseUrl` — required, deliberately no fallback.** It builds the OAuth
redirect URIs. A hardcoded default here would be a live misconfiguration: the
identity provider would redirect the user's authorization code to whatever
host the default named, and the failure would surface as a broken OAuth round
trip on someone else's domain rather than as an error anywhere near the actual
mistake. Scheme plus host; a trailing slash is stripped for you.

**`stateSecret` — required, at least 32 bytes.** HMAC key for the signed OAuth
state JWT (HS256). The length is enforced at register because HS256's security
floor *is* the key size, and a short secret silently weakens the only thing
authenticating the anonymous callback. Generate with
`openssl rand -base64 48`.

**`returnPath`** — where the callback redirects the human afterwards. Default
`/connectors`; point it at whatever page in your app renders `<Connections/>`.

**`disclosureRegistry`** — the pinned disclosure set the consent routes serve
and verify against. Defaults to the artifact vendored in `@shelfmark/core`. If
you supply your own canonical consent tree, every semantic — including the 409
SHA-mismatch refusal — applies to your bytes instead. See
[Consent governance](../project/consent-governance.md).

**`mapStream`** — three numbers for the narration stream, all sanitized at
register:

| Field | Default | Meaning |
| --- | --- | --- |
| `pollMs` | `700` | Poll cadence against the run document. Matches the narration engine's minimum per-line pace, so the stream runs at reading speed. |
| `heartbeatMs` | `15000` | Idle threshold before an SSE comment heartbeat. |
| `noRunTimeoutMs` | `5000` | How long a stream opened before the workflow's first write waits for a run document before 404-framing and closing. |

Non-finite and negative values fall back to the defaults — a host reading
these from an environment variable can hand over `Number('15s')`, and every
`elapsed >= NaN` comparison is false, which would silently turn heartbeats
*off* and proxy-cut exactly the long quiet walks the heartbeat exists to keep
alive. `heartbeatMs: 0` is preserved, because zero means always-due.

## Registering it

The demo's server (`demo/src/server.ts`) is the reference. The essentials:

```ts
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { Client, Connection } from '@temporalio/client';
import shelfmarkApi from '@shelfmark/api';
import { ensureStoreIndexes } from '@shelfmark/core';

const API_PREFIX = '/api/v1/connectors';

const mongo = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5000 });
await mongo.connect();
const db = mongo.db('shelfmark');
await ensureStoreIndexes(db); // idempotent; safe at every startup

const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS! });
const temporalClient = new Client({ connection });

const app = Fastify({ logger: true });

await app.register(shelfmarkApi, {
  prefix: API_PREFIX,
  db,
  ports,                       // your ShelfmarkPorts — see ../concepts/the-ports.md
  temporal: { client: temporalClient, taskQueue: 'shelfmark-queue' },
  config: {
    publicBaseUrl: process.env.PUBLIC_BASE_URL!,
    stateSecret: process.env.CONNECTOR_OAUTH_STATE_SECRET!,
    returnPath: '/connections',
  },
});

await app.listen({ port: 8787, host: '0.0.0.0' });
```

`ensureStoreIndexes(db)` is not optional in spirit: the map candidate spool's
unique index is load-bearing for the idempotent upserts the workflows depend
on. It is idempotent, so run it at every startup.

**The prefix rides into the redirect URI.** The plugin computes
`callbackPath` as `` `${fastify.prefix}/microsoft/callback` ``, so the
registered route and the URI handed to the identity provider cannot drift
apart. With the values above, the redirect URI to register in Entra is:

```
<PUBLIC_BASE_URL>/api/v1/connectors/microsoft/callback
```

See [Entra app setup](../getting-started/entra-setup.md) for the registration
itself.

## Wiring `AuthContextResolver`

The resolver is the identity seam. Its contract:

```ts
export type AuthContextResolver = (req: {
  headers: Record<string, string | string[] | undefined>;
}) => Promise<AuthContext | null>;

export interface AuthContext {
  tenantId: string;   // scopes every query and every stored record
  sub: string;        // the consent actor recorded on every grant
  upn?: string;       // display identity, shown in consent receipts
  label?: string;     // the actor's own sensitivity label, if you have such a notion
}
```

`null` means unauthenticated and the API answers `401 {"error":"unauthenticated"}`.
The plugin passes the whole Fastify request, but the declared contract is
`headers` — depend on more than that at your own risk.

A multi-tenant example over a bearer JWT your gateway already issued:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthContext, AuthContextResolver } from '@shelfmark/core';

const jwks = createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URL!));

export const resolveAuth: AuthContextResolver = async (req) => {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header?.startsWith('Bearer ')) return null;

  try {
    const { payload } = await jwtVerify(header.slice(7), jwks, {
      issuer: process.env.OIDC_ISSUER!,
      audience: process.env.OIDC_AUDIENCE!,
    });
    // Your claim names. Both must be present and non-empty: a consent whose
    // actor is unknown is refused by the consent store, not recorded with a
    // placeholder.
    const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : '';
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (tenantId === '' || sub === '') return null;

    const ctx: AuthContext = {
      tenantId,
      sub,
      upn: typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
    };
    return ctx;
  } catch {
    return null; // expired, forged, wrong audience — all the same answer
  }
};
```

Two things worth stating plainly:

- **`tenantId` is the isolation boundary.** Every query, every stored record,
  and every run is scoped by it. Deriving it from anything a caller can set
  freely (a header your gateway does not verify, a query parameter) collapses
  the boundary.
- **`sub` becomes evidence.** It is the actor recorded on every consent grant,
  and the consent store refuses a record whose actor is unknown rather than
  writing a placeholder. Return `null` rather than a synthetic subject.

The demo's resolver — every request is tenant `demo`, actor `demo-user` — is
the demo's one deliberate shortcut and is not a template.

## The anonymous OAuth callback carve-out

One route in the entire plugin is deliberately unauthenticated:

```
GET <prefix>/microsoft/callback
```

The identity provider redirects the user's browser there with an
authorization code, and that redirect carries no session. What authenticates
the request instead is the signed state JWT the server minted ten minutes
earlier at `POST <prefix>/microsoft/authorize`: HS256 over `config.stateSecret`,
with expiry enforced on verify. A tampered, forged, or expired state is a
`400` before any token exchange or database write happens. The acting human's
subject rides inside that state JWT, because the callback is the only place
their identity could otherwise be lost — and a callback that recorded just the
tenant id would look like an attribution without being one.

> **Any auth gateway in front of this API must allowlist exactly this path and
> nothing else.** In particular no consent path may ever be
> anonymous-reachable: an unauthenticated caller could otherwise write a
> consent record attributed to nobody.
{: .warning }

If your gateway matches on prefixes, make the rule exact
(`/api/v1/connectors/microsoft/callback`), not
`/api/v1/connectors/microsoft/*`.

## Starting the Temporal worker

The API process starts workflows; it does not run them. A second process must
poll the same task queue, or every map and ingest will sit pending forever.

A host builds its worker from exactly two things:

1. `createActivities(deps)` — the dependency-injected activity registry, and
2. the workflow **source** entry, exposed at
   `@shelfmark/workflows/workflows-source`, handed to `workflowsPath`.
   `@temporalio/worker` bundles TypeScript workflow source itself (webpack +
   swc), so this is source, not build output. Resolve it through the export
   map rather than hardcoding a path into the package's internals.

From `demo/src/worker.ts`:

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
const store = storeFromDb(db);

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS! });

// createRequire honors package export maps from this module's location, so
// nothing reaches into @shelfmark/workflows' file layout.
const workflowsPath = createRequire(import.meta.url).resolve(
  '@shelfmark/workflows/workflows-source'
);

const worker = await Worker.create({
  connection,
  taskQueue: 'shelfmark-queue',
  workflowsPath,
  activities: createActivities({
    store,
    ports,                                  // the SAME ports object shape as the API's
    config: { taskQueue: 'shelfmark-queue' },
  }),
});

process.once('SIGINT', () => worker.shutdown());
process.once('SIGTERM', () => worker.shutdown());
await worker.run();
```

Notes that will save you a debugging session:

- **The task queue string must match on both sides.** The API's
  `temporal.taskQueue` and the worker's `taskQueue` are the same queue.
  `DEFAULT_TASK_QUEUE` (`'shelfmark-queue'`) is exported from
  `@shelfmark/workflows` — use it rather than retyping the literal.
- **The worker's `ports.sink` is the one that matters.** The API process never
  calls `accept()`; the worker does. Both processes should build ports from
  the same code so policy and sink cannot disagree.
- **The worker needs its own Mongo connection and its own
  `ensureStoreIndexes`.** It writes run records and reads the candidate spool.
- **Node 20 on glibc, never alpine** — `@temporalio/core-bridge` is a native
  module. See [Deployment](deployment.md).

## The narration stream and your proxy

`GET <prefix>/:id/map/stream` is Server-Sent Events. The route hijacks the
reply and drives the raw response; the transport sets `Content-Type:
text/event-stream`, `Cache-Control: no-cache` and `Connection: keep-alive`,
caps every frame at 32 000 bytes, and emits `: hb` comment heartbeats when the
stream has been idle past `heartbeatMs`. Heartbeats exist because the stream
can legitimately go quiet for longer than a proxy idle timeout while the walk
grinds through a huge folder.

What this requires of anything you put in front of it:

- **No response buffering.** A buffering reverse proxy holds frames until it
  has "enough", which turns a live narration into a single dump at the end, or
  a cut connection. The plugin does not emit `X-Accel-Buffering`, so on nginx
  you must turn buffering off yourself for this route (`proxy_buffering off;`),
  and equivalently on other proxies.
- **An idle/read timeout longer than `heartbeatMs`.** The default heartbeat is
  15 seconds; a proxy that cuts at 10 will cut mid-walk.
- **No response compression on this route.** Compression middlewares commonly
  buffer.
- **HTTP/1.1 keep-alive to the origin**, and enough connection headroom that a
  long-lived stream per watching user does not exhaust the pool.

The stream degrades honestly rather than dying: a frame over the cap is
dropped and logged loudly (never silently shrunk), and the terminal frame
sheds its largest itemizations with an explicit `…Elided: true` flag, all of
which remain fetchable in full at `GET <prefix>/:id/map`. Polling that route
is a legitimate fallback if you cannot make streaming work in your topology.

There is no billing or attribution gate on the stream, deliberately: the
narration at that stage is arithmetic, and no model call happens anywhere on
that path. If you add model-generated narration, that is the moment the route
stops being free and needs your own gate.

## Where to go next

- [Embedding the UI](ui-embedding.md) — the React side that talks to these
  routes.
- [Implementing a DocumentSink](document-sink.md) — the port the worker calls.
- [Deployment](deployment.md) — processes, scaling constants, what to monitor.
