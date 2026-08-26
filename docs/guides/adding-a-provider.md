---
title: Adding a provider
parent: Guides
nav_order: 4
---

# Adding a provider

{: .warning }
> **OneDrive and SharePoint are what ships.** There is no provider plugin API,
> no registry, no runtime registration, and no second provider in the tree to
> check your work against. This page documents the *seam* — the surface a
> provider client presents and the places that currently assume the Microsoft
> one — so that adding a provider is a bounded fork rather than an
> archaeology project. It is not a supported extension point, and nothing
> here is covered by a compatibility promise.

What is real is that the seam was drawn deliberately. The provider-specific
code is one package (`@shelfmark/graph`), it is imported from a countable
number of call sites, and the two workflows refuse an unknown provider by name
rather than mis-walking it. That is the starting position.

## The shape of the seam

`@shelfmark/graph` is a plain module of functions — no class, no interface to
implement, no dependency injection. A second provider client is a sibling
package exporting the same six capabilities. Here is what each one has to
guarantee, taken from the Microsoft implementation.

### 1. Interactive OAuth with PKCE

```ts
buildAuthorizeUrl(state: string, codeChallenge: string, redirectUri: string): string
exchangeCodeForTokens(code: string, codeVerifier: string, redirectUri: string): Promise<GraphTokens>

export interface GraphTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** Scopes the provider says this token actually carries; `[]` when it did not say. */
  scopes: string[];
}
```

The `state` argument is the signed JWT the API mints; the provider client only
carries it. `code_challenge_method` is `S256`.

Reporting `scopes` is not optional decoration. It is the only local signal
that can explain an ambiguous error: Microsoft answers **404, not 403**, when a
delegated scope was never granted, so the status alone cannot separate "you may
not" from "it is not there". With the token's own granted-scope list, a 404 on
a call requiring a scope the token does not hold gets labelled a permission
answer wearing a not-found costume. Without it, the code says nothing rather
than guessing — a false negative is a missing hint, a false positive sends
someone to re-consent a connection that was fine.

The token cache's `ProviderTokens` interface is already written for this:
"structurally compatible with `@shelfmark/graph`'s `GraphTokens` — and with any
future provider client that answers the same four fields."

### 2. Token refresh, with rotation handled

```ts
refreshAccessToken(refreshToken: string): Promise<GraphTokens>
```

Microsoft rotates the refresh token on this grant and returns the new one,
which the caller must persist. Two rules the implementation encodes and any
provider client should copy:

- If the response omits a refresh token, **return the one you were given**.
  Storing `undefined` over a working credential kills the connection outright.
- The refresh endpoint throttles too. A background sync that cannot see a 429
  off its refresh call retries straight into the throttle, so token requests
  must raise the same status-preserving error type as drive calls.

Persisting the rotated token is the *caller's* job and already exists,
provider-neutrally: `getGraphAccessTokenFor` re-encrypts and updates
`encRefreshToken` on the connection document whenever the refreshed token
differs.

### 3. Drive resolution

```ts
getMyDrive(accessToken, grantedScopes?): Promise<{ driveId: string }>
getSharePointDrive(accessToken, hostname, sitePath, grantedScopes?): Promise<{ driveId: string }>
```

Every other call is keyed by `driveId`. The connection document stores it as
`driveId: string | null` — null until the first browse resolves it, because a
SharePoint site must be named by an admin before its drive is known. A
provider whose "drive" is a different noun (a workspace, a bucket, a library)
still has to produce one opaque string here.

### 4. Interactive listing, with an honest cursor

```ts
listChildren(
  accessToken: string,
  driveId: string,
  folderId?: string,
  options?: { cursor?: string | null; pageSize?: number; grantedScopes?: string[] }
): Promise<DriveItemPage>

export interface DriveItemPage {
  items: DriveItem[];
  /** null if and only if the listing is complete. */
  nextCursor: string | null;
}
```

Two contracts here are load-bearing, and both are scar tissue:

- **`nextCursor === null` if and only if the listing is complete.** An earlier
  version read one page and dropped the continuation link, so a folder past
  ~200 children was silently truncated — a product pitched as "we show you
  your real drive" quietly lying about what is in it.
- **The cursor is an opaque token, never a provider URL.** A continuation link
  is a fully-formed provider URL and can carry credentials in its query
  string; handing one to a browser is how such a credential escapes. The
  Microsoft client extracts only the paging token. If the provider hands back
  a continuation link with no extractable token, the client **throws** rather
  than reporting `nextCursor: null` — failing loudly is recoverable,
  under-reporting a customer's drive is not detectable.

There is also a paging-followed convenience with a stated ceiling:

```ts
export const LIST_ALL_CHILDREN_CEILING = 2000;

export interface DriveChildrenListing {
  items: DriveItem[];
  nextCursor: string | null;
  /** true if and only if the ceiling — not the end of the folder — stopped the listing. */
  truncated: boolean;
}
```

Landing exactly on the ceiling with the provider reporting completion is
`truncated: false`. The flag means "a bound bit here", not "there might be
more".

`DriveItem` is the one shape both paths map onto, and it is
**null-preserving**:

```ts
export interface DriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  /** Bytes. `null` means ONLY "the provider did not report a size" — never a
   *  stand-in for zero. On a FOLDER this is the RECURSIVE subtree size. */
  size: number | null;
  modified: string | null;
  /** Folders only. `0` is a genuinely empty folder; `null` is "unknown". */
  childCount: number | null;
}
```

Collapsing "did not say" into a plausible-looking value makes every downstream
screen lie, and the reverse reconstruction is impossible. A provider client
that defaults `size` to `0` breaks the byte reconciliation the map ledger is
built on.

The **recursive folder size** deserves its own note: it is what makes a
prune-manifest byte count meaningful *without descending into the pruned
subtree*. A provider that reports only per-file sizes cannot produce the same
prune accounting, and the honest thing is to report that gap rather than to
sum zero.

### 5. The walk: one page per call, and delta *or* an explicit alternative

```ts
listFolderPage(accessToken, driveId, folderId: string | null, pageUrl?): Promise<FolderPage>
listDeltaPage(accessToken, driveId, rootFolderId: string | null, deltaOrNextLink?): Promise<DeltaPage>
```

`listFolderPage` is deliberately one provider call per invocation: the
*caller's* workflow loops over pages, so no single durable step can run long on
a folder with thousands of entries. It requests 200 items per page and selects
`id,name,folder,size,lastModifiedDateTime`.

Unlike the browse path, these pages continue via the raw continuation URL,
because this path runs server-side inside a durable workflow, the link never
reaches a browser, and delta contracts require replaying the link verbatim.
The opaque-cursor discipline is a *browse* rule about what may cross to an
untrusted client, not a transport rule.

**A provider with no delta API is not disqualified.** The two halves use
different calls:

| Workflow | Enumeration call | Needs delta? |
| --- | --- | --- |
| `driveMapWorkflow` | `listFolderPage` (breadth-first over the queue) | No |
| `selectiveIngestWorkflow` | the candidate spool the map wrote, then `downloadFile` | No |
| `connectorSyncWorkflow` | `listDeltaPage` | Yes |

So the map-then-decide-then-ingest journey — the part this project is actually
about — needs only paged folder listing and download. The all-or-nothing sync
workflow is the piece that wants delta. A provider without one either skips
that workflow or implements the same interface as a full BFS re-enumeration
per run, which is what a fresh delta call already does on the Microsoft side:
called with no stored link, it returns the entire current tree as if newly
created, and only the *stored link* makes later calls incremental.

If you do implement delta, implement the expiry path too:

```ts
export const GRAPH_DELTA_EXPIRED_STATUS = 410;
export const GRAPH_RESYNC_REQUIRED_CODE = 'resyncRequired';
isDeltaResyncRequired(err: unknown): boolean
```

A stored token that has aged out is a **permanent** error. Before this was
detected, a long-idle connection burned all its retry attempts on it and
finalized the sync failed — and stayed failing, because the same dead token
was stored. The fallback is a full re-enumeration whose first page carries
`deltaExpired: true`, which the caller records so a re-crawl caused by expiry
is distinguishable from a normal first crawl.

### 6. Download

```ts
downloadFile(accessToken, driveId, itemId): Promise<Buffer>
```

Whole file into memory. See
[the sink guide](document-sink.md#what-the-sink-is-not-responsible-for) for the
size ceiling that makes that bounded, and
[Known limitations](../project/known-limitations.md) for the absence of
streaming ingest.

### 7. The error taxonomy

This is the part most likely to be under-built in a new provider client, and
the part that everything downstream depends on.

```ts
export interface GraphConnectorErrorDetails {
  status?: number | null;
  retryAfterSeconds?: number | null;
  providerErrorCode?: string | null;
  /** True only when the token's OWN granted scopes prove this was a permission answer. */
  scopeMissing?: boolean;
}
```

Rules the Microsoft client follows, each of which was paid for:

- **Every HTTP path throws the wire-error type** — listing, delta, token
  requests, and download alike. Flattening an axios failure into
  `` new Error(`...: ${err.message}`) `` destroys `response.status`, and a 429,
  a 404 and a 500 then arrive at the call site as the same opaque string.
- **`status: null` means "we never got an answer"** (DNS, connect timeout).
  Never `0`, never `500`.
- **`Retry-After` is parsed per RFC 9110** — delta-seconds or HTTP-date, both
  normalized to whole seconds from now, a past date clamped to `0`. A blank or
  unparseable header is `null` and **stays null** — never zero, which would
  read as "retry now" at the exact moment the provider asked for patience.
- **The client does not retry, back off, or sleep.** Retry policy lives with
  the caller that can actually be resumed, not inside a request-scoped HTTP
  client.

The consuming side of that contract is one exported function in
`@shelfmark/workflows`:

```ts
export function graphThrottleFailure(err: GraphHttpError): ApplicationFailure
```

It translates a status-preserving 429 into a Temporal `ApplicationFailure`
whose `nextRetryDelay` is the provider's own `Retry-After`, so the platform
waits what the provider asked rather than what a backoff policy guessed. A new
provider needs an equivalent, and the map activity's throttle branch
(`err.status === 429`) needs to recognize its error type.

## The policy engine is already provider-neutral

Nothing in `@shelfmark/policy` knows what a drive is. The classifier's entry
point is:

```ts
classify(name: string, isFolder: boolean, path = ''): Classification
```

Three primitives: a name, a boolean, a `/`-joined path. Its rules are
extension maps, exact machine-generated filenames, and prunable path segments,
loaded from a versioned, SHA-pinned JSON artifact. The ingest filters are the
same story — `preIngestSkip({ name, size })` and
`oversizedAfterDownload(byteLength)` take primitives, and the unreadable-type
denylist is a set of extensions.

So the classification, the pruning, the skip vocabulary and the funnel policy
carry over to any provider unchanged. The observed item shape a provider must
produce for the map is likewise plain data:

```ts
export interface MapPageItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  childCount: number | null;
  modified: string;
  /** Built from the walk's own breadcrumbs (folderPath + name), never from
   *  parent-reference parsing. */
  path: string;
  classId: string;
  rule: string;
  shouldWalk: boolean;
}
```

Note where `path` comes from: the walk's own breadcrumbs. A provider client
does not need to reconstruct paths — and on the delta path, where a provider
*does* hand back a parent reference, the Microsoft client strips its internal
drive-id prefix, because leaving it in leaked the raw drive-id string into
every ingested document's path.

## What currently assumes the Microsoft client

Plainly, so you can scope the work. Every file below imports
`@shelfmark/graph` or hardcodes the provider identifiers.

**Would need a provider branch:**

| File | What it does |
| --- | --- |
| `packages/graph/**` | The entire client. A second provider is a sibling package. |
| `packages/workflows/src/activities/connection.ts` | `refreshAccessToken`, `listDeltaPage`, `isDeltaResyncRequired`, and the delta-expiry bookkeeping. |
| `packages/workflows/src/activities/map.ts` | `listFolderPage`, and the `GraphHttpError` + 429 throttle branch. |
| `packages/workflows/src/activities/ingest.ts` | `downloadFile`. |
| `packages/api/src/routes/connections.ts` | `buildAuthorizeUrl` / `exchangeCodeForTokens`, and the route paths `/microsoft/authorize` and `/microsoft/callback`. |
| `packages/api/src/routes/browse.ts` | `listChildren` / `listAllChildren` and the truncation flag they feed. |

**Would need widening, but is already written as a seam:**

- `packages/workflows/src/workflows/driveMap.ts` and `selectiveIngest.ts` both
  begin with `if (conn.provider !== 'onedrive' && conn.provider !== 'sharepoint')`
  and finalize the run with status `unsupported_provider`. That refusal is the
  designed behavior: an unknown provider is refused loudly, never walked with
  the wrong client. Adding a provider means adding it to that check — and
  auditing what else in the workflow assumed the old client's semantics.
- `packages/api/src/workflowStarters.ts` — the starters are per-workflow-type.
  The comment states the intended shape: "a host adding a provider adds its own
  workflow type and its own starter beside this one rather than widening this
  signature."
- `packages/ui/src/provider.tsx` — `ShelfmarkProviderId` is the closed union
  `'onedrive' | 'sharepoint'`, and `<Connections/>` renders a button per member
  with its own message key. Adding a provider means a union member, a button,
  and an entry in **both** locale dictionaries — the en/es-MX parity check is a
  CI gate.

**Already provider-neutral, no change expected:**

- `packages/policy/**` — primitives in, classifications out.
- `packages/core/src/ports.ts` — no port mentions a provider.
- `packages/core/src/tokenCrypto.ts` — a refresh token is a refresh token.
- `packages/core/src/store/schemas.ts` — `provider` is typed `string`, with the
  comment: "`'onedrive' | 'sharepoint'` in this library; the provider seam is
  documented and other providers plug in as host code."
- `packages/api/src/tokenCache.ts` — `ProviderTokens` is structural.
- The consent records, the run documents, the candidate spool, the selection
  ledger, and the whole `DocumentSink` path.

## Honest assessment

The classification, consent, ledger and sink machinery is the majority of the
code and none of it cares which drive the bytes came from. The provider client
plus its call sites is a real but bounded piece of work — six capabilities and
roughly a dozen files.

What you do not get is a second implementation proving the seam is in the right
place. The interfaces above are one provider's shape, generalized once. Expect
to find at least one place where a Microsoft assumption is baked into something
that reads as neutral; the recursive folder size is the most likely candidate,
and the delta contract is the second.
