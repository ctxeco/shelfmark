---
title: "@shelfmark/graph"
parent: Packages
grand_parent: Reference
nav_order: 2
---

# `@shelfmark/graph`

The Microsoft Graph drive client: PKCE OAuth, drive resolution, folder
listing with honest pagination, delta queries, and file download. One
dependency (`axios`), no store, no Temporal, no opinions about retry.

```bash
pnpm add @shelfmark/graph
```

```ts
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getMyDrive,
  getSharePointDrive,
  listAllChildren,
  listDeltaPage,
  downloadFile,
  GraphHttpError,
} from '@shelfmark/graph';
```

## Configuration

Two environment variables, read at module load:

| Env var | Purpose |
| --- | --- |
| `CONNECTOR_MS_CLIENT_ID` | the Entra app registration's client id |
| `CONNECTOR_MS_CLIENT_SECRET` | its client secret |

Either missing → every OAuth call throws `GraphConnectorError`
("Microsoft connector not configured"), which the API layer turns into
`503 connector_not_configured`.

Scopes requested: `offline_access Files.Read.All Sites.Read.All`. **Read-only —
no write scope is requested and no write call exists in this package.**

The authority is `https://login.microsoftonline.com/organizations`, not
`/common`: `Files.Read.All`/`Sites.Read.All` are work-or-school-account
resources, so there is no reason to accept personal Microsoft account sign-in.

This is deliberately a **separate app registration** from any mail-sending
integration a deployment might also run. A mail sender typically uses
application permissions plus the client-credentials grant; this client needs
**delegated** permissions plus the authorization-code grant. One multi-tenant
registration, created once in your own tenant — **not one app per connected
customer**. Each customer consents against that same app; the per-customer
refresh token is what ends up stored.

## OAuth

```ts
export interface GraphTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** Scopes the provider says this token actually carries; [] when it did not say. */
  scopes: string[];
}

export function buildAuthorizeUrl(state: string, codeChallenge: string, redirectUri: string): string;
export function exchangeCodeForTokens(code: string, codeVerifier: string, redirectUri: string): Promise<GraphTokens>;
export function refreshAccessToken(refreshToken: string): Promise<GraphTokens>;
```

`buildAuthorizeUrl` emits `response_type=code`, `response_mode=query`,
`code_challenge_method=S256`. The caller owns the PKCE verifier and the state.

`scopes` matters beyond bookkeeping: knowing what a token actually carries is
the only local signal that can explain a Graph 404 as a missing permission.

{: .warning }
> **Microsoft rotates the refresh token on the refresh grant** and may
> invalidate the previous one. `refreshAccessToken` returns the new one and the
> caller **must persist it**. If the response omits one, the function falls
> back to the token you passed in — without that fallback, an omitted field
> would store `undefined` over a working credential and kill the connection
> outright.
>
> A discarded rotation fails **nothing** that day. The symptom surfaces weeks
> later as an `invalid_grant` with no event anywhere near it to explain why,
> which is the most expensive shape a bug can have.

The token endpoint throttles too, and its failures go through the same wrapper
as the drive calls — a background sync that cannot see a 429 on its refresh
retries straight into the throttle.

## Drives

```ts
export function getMyDrive(accessToken: string, grantedScopes?: string[]): Promise<{ driveId: string }>;
export function getSharePointDrive(
  accessToken: string,
  hostname: string,
  sitePath: string,
  grantedScopes?: string[]
): Promise<{ driveId: string }>;
```

`getSharePointDrive('…', 'contoso.sharepoint.com', '/sites/Finance')` resolves
the site, then its **default document library** drive. A full "browse all
sites" picker is deferred; this is the simplest correct way to target one
library.

Pass `grantedScopes` so a 404 can be explained (see
[scope disambiguation](#scope-disambiguation)). The required scope is
`Files.Read.All` for OneDrive, `Sites.Read.All` for SharePoint.

## Items

```ts
export interface DriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  modified: string | null;
  childCount: number | null;
}
export function toDriveItem(item: any): DriveItem;
export function numberOrNull(raw: unknown): number | null;
```

**Null means "the provider did not say" — never a stand-in for zero.** A 0-byte
file has `size: 0`; an empty folder has `childCount: 0`; a file always has
`childCount: null`. Merging two earlier Graph clients forced a choice between
one's lossy defaults (`size || 0`, `lastModified || ''`) and the other's
null-preserving mapping. Null-preserving won: collapsing "did not say" into a
plausible-looking value makes every downstream screen lie, and a caller that
wants a default can apply one, whereas the reverse reconstruction is
impossible.

On a **folder**, `size` is Graph's *recursive subtree* size — which is exactly
what makes a prune-manifest byte count meaningful without descending.

## Browse: pagination that says what it did

```ts
export const LIST_ALL_CHILDREN_CEILING = 2000;

export interface ListChildrenOptions {
  cursor?: string | null;
  pageSize?: number;      // clamped to 1…999 (Graph's $top ceiling), default 200
  grantedScopes?: string[];
}

export function listChildren(
  accessToken: string, driveId: string, folderId?: string, options?: ListChildrenOptions
): Promise<{ items: DriveItem[]; nextCursor: string | null }>;

export function listAllChildren(
  accessToken: string, driveId: string, folderId?: string, options?: ListChildrenOptions
): Promise<{ items: DriveItem[]; nextCursor: string | null; truncated: boolean }>;

export function pagingTokenFromNextLink(nextLink: string): string | null;
```

Three properties, all load-bearing:

- **`nextCursor` is null if and only if the listing is complete.** Before the
  cursor existed, this read exactly one page and dropped `@odata.nextLink` on
  the floor, so a folder past ~200 children was silently truncated — a product
  pitched as "we show you your real drive" quietly lying about what is in it.
- **The cursor is the paging token only, never the provider URL.**
  `@odata.nextLink` is a fully-formed URL that can carry credentials in its
  query string, and handing one to a browser is how a query-string credential
  escapes. `pagingTokenFromNextLink` extracts `$skiptoken` and discards the
  rest.
- **A continuation link with no recognisable token throws.** Answering
  `nextCursor: null` there would report a partial listing as complete —
  reintroducing the silent truncation as a parse failure. Passing the raw link
  through is not an option either. So it fails loudly, which is recoverable,
  rather than under-reporting a drive, which is not detectable.

`listAllChildren` follows the paging for you up to
`LIST_ALL_CHILDREN_CEILING` (**2000**) children and then says so:
`truncated: true` plus the cursor to continue from. `truncated` is true **if
and only if the ceiling** stopped the listing — landing exactly on the ceiling
with Graph reporting no continuation is a *complete* listing, not a truncated
one. A page counter also trips the same ceiling, so a server looping the client
on empty pages reports truncated-with-cursor rather than spinning.

`$select` is `id,name,folder,size,lastModifiedDateTime` — the folder facet
carries `childCount`, so the extra metadata rides a request Graph was already
serving and costs nothing on the wire.

## Walk: delta and folder pages

```ts
export const GRAPH_DELTA_EXPIRED_STATUS = 410;
export const GRAPH_RESYNC_REQUIRED_CODE = 'resyncRequired';

export function listFolderPage(
  accessToken: string, driveId: string, folderId: string | null, pageUrl?: string
): Promise<{ items: DriveItem[]; nextLink?: string }>;

export function listDeltaPage(
  accessToken: string, driveId: string, rootFolderId: string | null, deltaOrNextLink?: string
): Promise<DeltaPage>;

export function isDeltaResyncRequired(err: unknown): boolean;
export function downloadFile(accessToken: string, driveId: string, itemId: string): Promise<Buffer>;
```

`listDeltaPage` is **both** the first full crawl and every incremental resync
after it. Called fresh, Graph's delta API returns the entire current tree (every
item, as if newly created), paginated; the final page's `@odata.deltaLink` is
stored and passed back on every future sync, at which point only changes come
back. Scoped to `rootFolderId` when the connection has one; otherwise the drive
root.

`DeltaDriveItem` adds `path` and `deleted`. The path is derived by stripping
Graph's `/drives/{drive-id}/root:` prefix from `parentReference.path` — this
function always calls the **plural** `/drives/{driveId}/…` endpoint, so that is
always the shape. An earlier regex assumed the singular `/drive/root:` form,
which never matches here, and the raw drive-id string leaked into every
ingested document's `path` field.

`isDeltaResyncRequired` recognises an aged-out delta token: HTTP **410 Gone**,
or the string `resyncRequired` in the message as a secondary signal for a proxy
that rewrote the status. Without it, a long-idle connection burns all of its
retry attempts on a permanent error, finalizes the sync `failed`, and stays
failing because the same dead token is still stored.

{: .note }
> **Browse and walk page differently on purpose.** Browse re-issues opaque
> cursors because its output crosses to an untrusted client. Walk continues via
> the raw `@odata.nextLink`, because it runs server-side inside a durable
> workflow, the link never reaches a browser, and Graph's delta contract
> requires replaying the link verbatim. The opaque-cursor discipline is a
> *browse* rule about what may cross a trust boundary, not a Graph rule.

## Errors

```ts
export class GraphConnectorError extends Error {
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly providerErrorCode: string | null;
  readonly scopeMissing: boolean;
  get isThrottled(): boolean;   // status === 429
}
export class GraphHttpError extends GraphConnectorError {}

export const GRAPH_DRIVE_SCOPES = ['Files.Read.All', 'Sites.Read.All'];
export function toGraphHttpError(prefix: string, err: unknown, options?: GraphScopeContext): GraphConnectorError;
export function grantedIncludesAny(granted: string[] | undefined, required: string[]): boolean;
export function parseRetryAfter(raw: unknown, nowMs?: number): number | null;
export function extractHttpErrorDetails(err: unknown, nowMs?: number): ProviderHttpErrorDetails;
```

**Every HTTP path in this package throws `GraphHttpError`** — listing, delta,
download, and token requests alike. `GraphHttpError extends
GraphConnectorError`, so any generic `instanceof GraphConnectorError` handling
keeps working; what the subclass adds is provenance: this error came off the
wire with whatever the wire supplied.

`status` is `null` when the request never got an answer (DNS, connect timeout)
— never `0`, never a synthesized `500`.

`providerErrorCode` is extracted across the three shapes actually received:
Graph's `{error:{code}}`, Google Drive's `{error:{status, errors:[{reason}]}}`,
and the OAuth `{error: 'invalid_grant'}` form. Google's `error.code` is a
*number* (the HTTP status again), so the string guard is load-bearing —
without it the extractor would return `"403"` and shadow the genuinely useful
`PERMISSION_DENIED`/`userRateLimitExceeded`.

### Throttling

`parseRetryAfter` handles both RFC 9110 forms:

| Header | Result |
| --- | --- |
| absent, blank, or unparseable | `null` |
| `120` | `120` |
| HTTP-date in the future | whole seconds from now, rounded up |
| HTTP-date already past | `0` (clamped — a negative wait is not actionable) |

**Null, never zero, for an absent header.** Zero reads as "retry now" at the
exact moment the provider asked for patience.

This package **never retries, backs off, or sleeps.** Retry policy lives with
the caller that can actually be resumed — a durable workflow — not inside a
request-scoped HTTP client. What this package guarantees is that the caller can
*see* the throttle.

### Scope disambiguation

Graph answers **404, not 403**, when a delegated scope was never granted, so
status alone cannot separate "you may not" from "it is not there". That
confusion cost a real debugging round trip.

`toGraphHttpError` labels `scopeMissing: true` only when **all** of these hold:
the caller supplied `requiredScopes`; the status is one Graph uses ambiguously
(401, 403, 404); the caller supplied a non-empty `grantedScopes`; and none of
the required scopes is in it. With no scope list it says nothing rather than
guessing — a false negative is a missing hint, whereas a false positive would
send someone to re-consent a connection that was fine.

Granted scopes come back fully qualified
(`https://graph.microsoft.com/Files.Read.All`), so `grantedIncludesAny`
compares on the last path segment, case-insensitively.

## Gotchas

- Client id and secret are read **at module load**, not per call. Setting them
  after import has no effect.
- `listChildren`'s `pageSize` is clamped to 1…999; anything non-finite falls
  back to 200.
- Path segments are URL-encoded in every request, so an id containing `/` or
  `?` names an item rather than rewriting the request path.
- `downloadFile` returns the whole file as a `Buffer` — there is no streaming
  ingest. The size ceiling that makes this safe lives in `@shelfmark/policy`,
  not here.
