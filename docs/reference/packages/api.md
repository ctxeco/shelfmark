---
title: "@shelfmark/api"
parent: Packages
grand_parent: Reference
nav_order: 5
---

# `@shelfmark/api`

The Fastify 5 plugin. One `register` call mounts the whole HTTP surface:
connections and OAuth, consents, browse, map plus its SSE narration stream,
selection, and selective ingest.

```bash
pnpm add @shelfmark/api fastify
```

```ts
import Fastify from 'fastify';
import shelfmarkApi from '@shelfmark/api';

const app = Fastify({ logger: true });
await app.register(shelfmarkApi, {
  prefix: '/api/v1/connectors',
  db,
  ports,
  temporal: { client: temporalClient, taskQueue: 'shelfmark-queue' },
  config: {
    publicBaseUrl: process.env.PUBLIC_BASE_URL!,
    stateSecret: process.env.SHELFMARK_STATE_SECRET!,
    returnPath: '/connections',
  },
});
```

`fastify` is a **peer** dependency (`^5`). The route-by-route contract —
methods, bodies, responses, error codes, SSE frames — is
[HTTP API](../http-api.md); this page is the package surface.

## Options

```ts
export interface ShelfmarkApiOptions {
  db: Db;                                             // connected mongodb Db
  ports: ShelfmarkPorts;                              // only resolveAuth is strictly required here
  temporal: { client: WorkflowStartClient; taskQueue: string };
  config: ShelfmarkApiConfig;
}

export interface ShelfmarkApiConfig {
  publicBaseUrl: string;          // REQUIRED, no default
  stateSecret: string;            // REQUIRED, ≥ 32 bytes
  returnPath?: string;            // default '/connectors'
  disclosureRegistry?: DisclosureRegistry;
  mapStream?: { pollMs?: number; heartbeatMs?: number; noRunTimeoutMs?: number };
}
```

Every one of these is validated **at register**, not at first request. See
[register-time refusals](../http-api.md#register-time-refusals).

`publicBaseUrl` has deliberately no fallback: it builds the OAuth redirect
URIs, so a wrong default is a live misconfiguration — the identity provider
would redirect authorization codes at whatever host the default named, and the
failure would surface as a broken round trip on someone else's domain rather
than as an error near the mistake. The trailing slash is stripped.

`stateSecret` is checked for ≥ 32 **bytes** because HS256's security floor is
the key size, and a short secret silently weakens the only thing authenticating
the anonymous OAuth callback.

`disclosureRegistry` defaults to `@shelfmark/core`'s vendored artifact. A host
with its own canonical consent tree supplies its own registry, and every
semantic — including the `409` SHA-mismatch refusal — applies to that host's
bytes.

`mapStream` numbers are **sanitized** at register. Non-finite or negative values
fall back to the defaults, because a host reading a knob from an env var can
hand over `Number('15s')` — `NaN` — and every `elapsed >= NaN` comparison is
false, which would silently turn heartbeats *off* and proxy-cut exactly the long
quiet walks they exist to keep alive. But `heartbeatMs: 0` stays `0`: zero means
always-due, and a `|| default` idiom would eat it.

## Encapsulation

The plugin is wrapped with `fastify-plugin` for its name/version metadata but
with `encapsulate: true`. The routes live in their own context, so the host's
`prefix` applies normally and nothing leaks decorators onto the root instance.

A host's **root-level auth hook still propagates in** — root hooks reach every
child plugin — and that propagation is the reason the four consent routes are
registered by this plugin rather than a separate one: a host that installs its
authorization hook on the instance it registers `@shelfmark/api` on puts each
consent route inside that hook's coverage *by construction*, and a route outside
the hook's coverage would be invisible in the diff of the route file itself.

{: .note }
> That is a **coverage** argument, not an ordering one. A root hook added
> *after* `register` still fires — measured. "Registered after the hook" is not
> what buys the coverage and must not be relied on as if it were.

The mounted prefix rides into the redirect URI via `fastify.prefix`, so the
registered callback route and the URI handed to the identity provider cannot
drift apart:
`<publicBaseUrl><prefix>/microsoft/callback`.

## Exported surface

```ts
export { shelfmarkApi, default } from './plugin.js';
export type { MapStreamConfig, RouteContext, ShelfmarkApiConfig, ShelfmarkApiOptions };

// SSE transport
export { openSseStream, type SseSink, type SseStream, type SseStreamOptions };

// token cache
export {
  connectionAccessToken, forgetConnectionTokens,
  type ConnectionAccessToken, type ConnectionAccessTokenParams, type ProviderTokens,
};

// workflow starters + the id conventions
export {
  CONNECTOR_SYNC_WORKFLOW, DRIVE_MAP_WORKFLOW, SELECTIVE_INGEST_WORKFLOW,
  connectorSyncWorkflowId, driveMapWorkflowId, selectiveIngestWorkflowId,
  createWorkflowStarters,
  type WorkflowStartClient, type WorkflowStarters,
};
```

### Workflow starters

```ts
export interface WorkflowStartClient {
  workflow: {
    start(type: string, options: { taskQueue: string; workflowId: string; args: unknown[] }):
      Promise<{ workflowId: string }>;
  };
}
export function createWorkflowStarters(client: WorkflowStartClient, taskQueue: string): WorkflowStarters;
```

The client is stated **structurally** — a real `Client` from
`@temporalio/client` is assignable, and so is a test double or a host's own
wrapper, without pulling in the whole SDK surface.

Args, exactly:

| Workflow | Id | Args |
| --- | --- | --- |
| `connectorSyncWorkflow` | `connector-sync-<id>` | `[{ connectionId }]` |
| `driveMapWorkflow` | `map-<id>` | `[{ connectionId }]` |
| `selectiveIngestWorkflow` | `ingest-<id>` | `[{ connectionId, defaultLabel }]` |

**`AlreadyStarted` is treated as success**: the pinned id is returned as if the
start had happened, because the run the caller wanted is running. A
double-clicked "sync now" / "map it" / "read these files" is a duplicate-start
rejection, not a second concurrent walk of the same remote drive.

The id builders are exported because each does two jobs and both sides must
agree byte-for-byte — the Temporal idempotency pin here, and the `runId` the
workflow writes its documents under, which the read and stream routes look up. A
route hand-rolling `` `map-${id}` `` would work until one side changed the
prefix.

{: .warning }
> **This package never imports `@shelfmark/workflows`.** Workflows are started
> by string type name, and the three names live here as constants. The
> corresponding `(type, queue)` pairs are pinned against the real bundle exports
> by a test in the workflows package — see
> [import boundaries](index.md#shelfmarkapi-never-imports-shelfmarkworkflows).

### The token cache

```ts
export function connectionAccessToken(params: ConnectionAccessTokenParams): Promise<ConnectionAccessToken>;
export function forgetConnectionTokens(tenantId: string, connectionId: string): void;
```

In-memory, **access tokens only**, keyed on `(tenantId, connectionId)`. Refresh
tokens are never cached in plaintext: they are decrypted, used, and dropped
inside a single call.

It exists because of two defects, one of which is invisible until it is old:

- **Rotation was discarded.** The browse path read `.accessToken` off the
  refresh response and threw the rest away, so the copy in `encRefreshToken` was
  already dead — and nothing failed that day. The symptom surfaces weeks later
  as an `invalid_grant` with no nearby event to explain it.
- **Every browse paid a full refresh round trip.** One picker click, one token
  exchange. The map walks thousands of folders, which multiplies into thousands
  of avoidable round trips against a service that throttles — self-inflicted
  429s.

Behaviour worth knowing:

- **Refresh early.** The cache stops serving a token 60 seconds before the
  provider stops honouring it. A token whose remaining life is already inside
  that margin is used once and not stored.
- **Single-flight.** A burst of concurrent browses against one connection fires
  **one** refresh. Without it, several simultaneous rotations race to persist,
  with the losers writing a token the provider has already retired.
- **Bounded** at 1000 entries: expired entries are pruned first, then
  oldest-first eviction. Evicting a live token costs one refresh, never
  correctness.
- **Tenant id is part of the key, not decoration** — a cached token is
  structurally unable to be served to another tenant even if a future caller
  forgets the scoping.
- **A failed rotation write-back does not fail the request.** The provider has
  already invalidated the old token, so failing would not save the connection —
  it is broken either way. What must not happen is silence, so
  `onRotationPersistFailure` fires and the route logs it loudly. That is the
  exact moment a connection starts dying, and the only moment it is cheap to
  notice.
- `forgetConnectionTokens` is called by `DELETE /:id`, because disconnect has to
  mean disconnected *now*.

### The SSE transport

```ts
export function openSseStream(sink: SseSink, options: SseStreamOptions): SseStream;

export interface SseSink { setHeader(n: string, v: string): void; write(c: string): unknown; end(): void }

export interface SseStreamOptions {
  heartbeatMs: number;       // 0 = always due
  maxFrameBytes: number;
  onFrameDropped?: (info: { bytes: number; type: string }) => void;
}

export interface SseStream {
  readonly closed: boolean;
  writeFrame(payload: Record<string, unknown>): boolean;  // false if dropped or closed
  heartbeatIfDue(): void;
  end(): void;      // idempotent
  abandon(): void;  // mark closed WITHOUT touching the sink — the client hung up
}
```

Framework-neutral: the sink is stated structurally, so Node's `ServerResponse`
satisfies it and so does any test double.

Three properties, each from production streaming history:

- **Per-frame byte cap.** One oversized frame can reproduce a documented
  proxy-cutoff failure mode — the proxy buffers, stalls, severs. A frame that
  busts the cap is **reported to the caller and never written**, and never
  silently shrunk here: degradation policy is the caller's, because only the
  caller knows which fields a frame can honestly shed. The map route's graded
  degradation is in [HTTP API](../http-api.md#the-byte-cap-and-its-graded-degradation).
- **Comment-frame heartbeats.** `: hb` is ignored by `EventSource` but keeps
  proxies from cutting a stream that has legitimately gone quiet while a walk
  grinds through a huge folder.
- **Closed is closed.** After the client disconnects or the stream ends, every
  write is a no-op. A poll loop that lost its client must not crash the process
  writing to a dead socket.

## Gotchas

- The plugin needs `ports.resolveAuth`; the other four ports are only consulted
  where the routes use them (`tenantPolicy`, `labelPolicy`). `sink` and
  `egressGate` are the worker's business, not the edge's.
- `POST /:id/sync` keeps a legacy unscoped `{ connectionId }` update filter,
  documented as such in the source. It cannot select another tenant's row —
  the document was already loaded under `{ connectionId, tenantId }` — but every
  newer write (browse, map, ingest) uses the tenant-scoped filter as the
  standard.
- The suggestions cursor is base64url of `rows:<n>`. Do not construct one; a
  cursor this server did not mint is `400 invalid_cursor`.
- `GET /:id/map` and `GET /:id/map/suggestions` do **not** read the connection
  document. The runId is derived from the path and `tenantId` scopes the query
  itself, so another tenant's run reads as no run.
