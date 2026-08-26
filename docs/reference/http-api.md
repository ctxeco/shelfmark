---
title: HTTP API
parent: Reference
nav_order: 1
---

# HTTP API

Everything `@shelfmark/api` exposes. The package is a single Fastify 5 plugin;
one `register` call mounts all seventeen routes under whatever prefix the host
chooses.

```ts
import Fastify from 'fastify';
import shelfmarkApi from '@shelfmark/api';

const app = Fastify({ logger: true });
await app.register(shelfmarkApi, {
  prefix: '/api/v1/connectors',
  db,                                   // a connected mongodb Db
  ports,                                // the five host seams
  temporal: { client: temporalClient, taskQueue: 'shelfmark-queue' },
  config: {
    publicBaseUrl: 'https://app.example.com',
    stateSecret: process.env.SHELFMARK_STATE_SECRET!, // ≥ 32 bytes
    returnPath: '/connections',
  },
});
```

Paths below are written relative to the mount prefix; the demo mounts at
`/api/v1/connectors`, so `POST /:id/map` is
`POST /api/v1/connectors/conn-…/map`.

The plugin is wrapped with `fastify-plugin` but **encapsulated**
(`encapsulate: true`): the host's prefix applies normally and nothing leaks
decorators onto the root instance. A root-level auth hook still propagates
*into* the plugin's context — that propagation is what puts the consent routes
inside a host's own authorization coverage by construction.

## Register-time refusals

The plugin throws at `register` — never at first request — when:

| Condition | Message |
| --- | --- |
| `options.db` missing | requires `options.db` (a connected mongodb Db) |
| `ports.resolveAuth` not a function | requires `options.ports.resolveAuth` |
| `temporal.client` or `temporal.taskQueue` missing | requires `options.temporal ({ client, taskQueue })` |
| `config.publicBaseUrl` missing or empty | it builds the OAuth redirect URIs and has **deliberately no default** |
| `config.stateSecret` missing or empty | required |
| `config.stateSecret` under 32 bytes | HS256's security floor is the key size |

`publicBaseUrl` has no fallback on purpose: a hardcoded default would be a
*live* misconfiguration — the identity provider would redirect authorization
codes at whatever host the default named, and the failure would surface as a
broken OAuth round trip on someone else's domain rather than as an error
anywhere near the mistake.

## Authentication

Every route resolves the caller through the host's `AuthContextResolver`
(`ports.resolveAuth`). `null` means unauthenticated and the API layer answers
`401 {"error":"unauthenticated"}` in one shared helper, so no route can forget
to. `auth.tenantId` — never a header, never a path parameter — scopes every
query, so another tenant's connection is indistinguishable from one that does
not exist.

**Exactly one route is anonymous:** `GET /microsoft/callback`. The identity
provider redirects the user's browser there with an authorization code, and
that redirect carries no session. What authenticates it instead is the signed
state JWT this server minted at `POST /microsoft/authorize` — HS256 over
`config.stateSecret`, ten-minute expiry enforced by `jwtVerify`. A tampered,
forged, or expired state is a `400` before any token exchange or write.

{: .warning }
> An auth gateway in front of this API must allowlist **exactly**
> `<prefix>/microsoft/callback` and nothing else. No consent path may ever be
> anonymous-reachable — an unauthenticated caller could otherwise write a
> consent record attributed to nobody. (The package's own `resolveAuth` gate
> answers 401 on every consent route regardless; the gateway rule is defence
> in depth.)

---

## Connections and OAuth

### `POST /microsoft/authorize`

Mints the PKCE pair and the signed state, and returns the URL to send the
browser to.

| | |
| --- | --- |
| Auth | required |
| Query | `target` — `sharepoint`, or `onedrive` for any other value (including absent) |
| Body | none |

The state JWT carries `tenantId`, `target`, `codeVerifier` and `actingSub` —
the acting human's `sub`, which rides the state because the callback is
anonymous and this is the only place that identity survives the round trip. It
is deliberately **not** the registered `sub` claim: this token's subject is the
OAuth flow, not the person who started it.

```http
HTTP/1.1 200 OK
{"authorizeUrl":"https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=…&code_challenge_method=S256&…"}
```

Errors: `401 unauthenticated` · `403 connectors_disabled_for_tenant` ·
`503 connector_not_configured` (the Graph client has no
`CONNECTOR_MS_CLIENT_ID`/`CONNECTOR_MS_CLIENT_SECRET`).

### `GET /microsoft/callback`

The anonymous carve-out. Verifies the state, exchanges the code, encrypts the
refresh token, inserts the connection document, and **redirects** — it never
returns JSON on the success path.

| | |
| --- | --- |
| Auth | none (state JWT instead — see above) |
| Query | `code`, `state`, `error` |

Redirect targets, all `${publicBaseUrl}${returnPath}` with a query string:

| Situation | Redirect query |
| --- | --- |
| Provider returned `error` | `?error=<urlencoded provider error>` |
| Success | `?connected=<onedrive\|sharepoint>&connectionId=conn-<uuid>` |
| Token exchange or insert threw | `?error=connect_failed` (logged server-side) |

JSON error responses: `400 missing_code_or_state` ·
`400 invalid_or_expired_state`.

The inserted document records `createdBy: null` when the state carried no
`actingSub` — never the tenant id. A null honestly reads as "we do not know who
did this"; a tenant id in an actor field reads as an answer and is not one.

### `GET /`

Every connection for the caller's tenant, newest first, with
`encRefreshToken` projected out.

```http
HTTP/1.1 200 OK
{"connections":[{"connectionId":"conn-…","tenantId":"acme","provider":"onedrive",
  "driveId":"b!…","rootFolderId":null,"rootPath":null,"defaultLabel":null,
  "deltaLink":null,"status":"connected","createdBy":"user-42",
  "createdAt":"2026-08-19T10:04:11.000Z","lastSyncAt":null,
  "lastSyncStartedAt":null,"lastSyncStatus":null,
  "lastSyncProgress":{"discovered":0,"ingested":0,"skipped":0,"failed":0,
    "deferred":0,"foldersScanned":0,"currentFolder":null,"recentFiles":[]}}]}
```

Errors: `401 unauthenticated`.

### `POST /:id/sync`

The legacy **all-or-nothing** delta sync — untouched by the map/decide flow and
kept at its shipped contract. Starts `connectorSyncWorkflow` on the pinned id
`connector-sync-<connectionId>`.

| | |
| --- | --- |
| Auth | required |
| Body | `rootFolderId?: string`, `rootPath?: string`, `defaultLabel?: string` (non-strings are ignored and the stored value is kept) |

The label is resolved **here, at configuration time**, through the host's
`LabelPolicy` against whichever admin is starting the sync — the sync itself
runs unattended, possibly hours later, with no session to consult. The policy
may cap a requested label (never raise it) or refuse; a refusal is a typed 403,
not a silent substitution.

```http
HTTP/1.1 202 Accepted
{"status":"syncing","connectionId":"conn-…","workflowId":"connector-sync-conn-…"}
```

Errors: `401` · `404 No connection <id>` · `403 connectors_disabled_for_tenant`
· `403 label_refused` (body carries `requested`) · `503` on a durable-start
failure.

### `DELETE /:id`

Sets `status: 'disconnected'`, nulls `encRefreshToken`, and drops the
connection's cached access token.

```http
HTTP/1.1 200 OK
{"connectionId":"conn-…","status":"disconnected"}
```

Nulling the refresh token only stops *future* refreshes; a cached access token
would keep serving reads from a disconnected connection until it aged out on
its own, so the cache eviction is part of the contract. Disconnect means
disconnected now.

Errors: `401` · `404 No connection <id>`. Note that disconnect is **not** gated
by the tenant connector switch — see [Errors](errors.md#tenant-and-feature-switches).

---

## Browse

### `GET /:id/browse`

The root-folder picker's view of a drive. A UI convenience, not a general Graph
read-through proxy.

| | |
| --- | --- |
| Auth | required |
| Query | `folderId?` (absent = drive root), `cursor?`, `sharepointHostname?`, `sharepointSitePath?` |

A repeated query key arrives as an array from Fastify's parser; the route
collapses to the first value and treats a blank as absent.

On the first browse of a connection with no `driveId` yet, the drive is
resolved and persisted: OneDrive uses the signed-in user's default drive;
SharePoint requires **both** `sharepointHostname` and `sharepointSitePath`
(e.g. `contoso.sharepoint.com` + `/sites/Finance`) or the route answers
`400 sharepoint_site_required`.

```http
HTTP/1.1 200 OK
{"items":[
   {"id":"01ABC…","name":"Finance","isFolder":true,"size":184320011,
    "modified":"2026-07-30T09:12:44Z","childCount":37},
   {"id":"01DEF…","name":"forecast.xlsx","isFolder":false,"size":0,
    "modified":"2026-08-02T16:41:08Z","childCount":null}],
 "nextCursor":null,
 "truncated":false}
```

**The contract, exactly:**

- **Files are returned, not just folders.** The product is "names before
  files"; a picker that hides files cannot show what it promises.
- The listing follows Graph's continuation links to a documented ceiling —
  `LIST_ALL_CHILDREN_CEILING`, **2000 children** — and then *says so*:
  `truncated: true` plus the cursor to continue from. `truncated` is true **if
  and only if the ceiling**, not the end of the folder, stopped the listing.
  Landing exactly on the ceiling with Graph reporting no continuation is a
  complete listing.
- `nextCursor` is `null` **if and only if** the listing is complete. A non-null
  cursor the caller ignores is a caller bug; a null cursor over an incomplete
  listing would be a server bug.
- **The cursor is opaque and is never a provider URL.** Graph's
  `@odata.nextLink` is a fully-formed URL that can carry credentials in its
  query string, so `@shelfmark/graph` strips it down to the paging token before
  it can cross to a client. Pass it back verbatim; do not parse it. If Graph
  ever returns a continuation link with no recognisable paging token, the call
  **throws** rather than reporting a partial listing as complete.
- `size` / `modified` / `childCount` are `null` **only** for "the provider did
  not tell us", never as a stand-in for zero. A 0-byte file has `size: 0`; an
  empty folder has `childCount: 0`. Folder `size` is Graph's *recursive*
  subtree size. Files always have `childCount: null`.

There is deliberately **no consent check here**: map consent gates
`POST /:id/map`, not the picker a customer uses to decide what to consent to.
The tenant connector switch *is* checked, and is ordered **before** the
disconnected check so a switched-off tenant cannot tell a live connection from
a disconnected one.

Errors: `401` · `404 No connection <id>` · `403 connectors_disabled_for_tenant`
· `409 connection_disconnected` · `400 sharepoint_site_required` ·
`429 browse_throttled` (+ `Retry-After`) · `403 browse_scope_missing` ·
`404 browse_folder_not_found` · `502 browse_failed`. See
[Errors](errors.md#browse-and-provider) for what each one means and what to do
about it.

---

## Map

### `POST /:id/map`

Starts `driveMapWorkflow` on the pinned id `map-<connectionId>`.

| | |
| --- | --- |
| Auth | required |
| Body | `rootFolderId?: string`, `rootPath?: string` |

There is **no label field, by design.** Sync fixes `defaultLabel` at
configuration time because ingestion mints documents; the map mints none — it
reads names, sizes and counts. Which label the eventually-ingested corpus lands
under is a decision made *after* the customer has seen the map, and it is taken
at `POST /:id/ingest`. A label accepted here would be recorded before the
information it governs exists.

Gate order: connection exists → `connectorsEnabled` → `mappingEnabled === true`
→ an **active** `map_metadata` consent. "Active" is derived from the
append-only consent event stream: a grant plus a later revocation naming its
`consentId` is not active. The mapping switch is re-checked here even though
the grant path already required it — the grant check ran at grant time, and an
admin who switched mapping off afterwards has withdrawn the tenant-level
precondition. Consent is necessary, never sufficient.

```http
HTTP/1.1 202 Accepted
{"status":"mapping","connectionId":"conn-…","workflowId":"map-conn-…"}
```

Starting is idempotent: the workflow id is pinned to the connection, so a
double-clicked "map it" is a duplicate-start rejection that the starter treats
as success and returns the same `workflowId`, not a second concurrent walk.

Errors: `401` · `404 No connection <id>` · `403 connectors_disabled_for_tenant`
· `403 mapping_disabled_for_tenant` · `403 map_consent_required` · `503` on a
durable-start failure.

### `GET /:id/map`

The current map run's document, **verbatim**, minus Mongo's `_id`.

Nothing is stripped: the document *is* the contract. The UI renders the
truncation flags (`rollupTruncated`, `pruneManifestTruncated`,
`narrationDropped`) and the reconciliation sums as-is, because a bounded thing
that does not say so in its output is a silent cap. The run id is derived from
the path (`map-<connectionId>`) and `tenantId` scopes the query, so another
tenant's run reads as no run.

```http
HTTP/1.1 200 OK
{"tenantId":"acme","runId":"map-conn-…","connectionId":"conn-…",
 "provider":"onedrive","status":"complete","consentId":"consent-…",
 "consentDisclosureSha256":"9f2c…","classifierVersion":"1.0.0",
 "artifactSha":"4b1e…","startedAt":"…","finishedAt":"…",
 "progress":{…},"aggregates":{…},"topFolders":[…],"rollupTruncated":false,
 "topFoldersOmitted":0,"pruneManifest":[…],"pruneManifestTruncated":false,
 "pruneManifestOmitted":0,"reconciliation":{…},"narration":[…],
 "narrationDropped":0}
```

Errors: `401` · `404 no_map_run`.

### `GET /:id/map/stream` — the narration stream

Server-sent events for the watch-it-run step. Documented in full
[below](#the-sse-stream).

---

## Decide: suggestions, selection, ingest

### `GET /:id/map/suggestions`

The one `map_suggestions` document for this connection's map run, verbatim
minus `_id`, **plus** a computed cost estimate, with the verdict ledger
paginated.

| | |
| --- | --- |
| Auth | required |
| Query | `cursor?` — opaque, from a previous response's `nextCursor` |

```http
HTTP/1.1 200 OK
{"tenantId":"acme","runId":"map-conn-…","connectionId":"conn-…",
 "funnelPolicyVersion":"1.0.0","funnelPolicySha256":"…",
 "classifierVersion":"1.0.0","classifierSha256":"…",
 "candidates":{"files":1983,"bytes":4139122019},
 "funnelTable":[…],
 "defaultSelection":{"files":1441,"bytes":2884001233},
 "sensitiveReport":{"…":{"candidates":12,"defaultSelection":9}},
 "ranking":{"ranked":false,"reason":"…"},
 "rows":[{"itemId":"01ABC…","path":"/Finance/2026/forecast.xlsx",
          "name":"forecast.xlsx","size":88213,
          "modified":"2026-08-02T16:41:08Z","verdict":"selected"}],
 "rowsTruncated":false,"rowsOmitted":0,"rowCap":20000,
 "costEstimate":{"textShareBytes":1290000,"binaryShareBytes":2882711233,
   "binaryShareOfSelection":0.9995527047682091,
   "tokenLow":57976725,"tokenHigh":721000309,
   "method":"text-like bytes (.md/.txt/.csv) ÷ 4 per token on both ends; …"},
 "rowsTotal":1983,"rowsPageCap":2000,"nextCursor":null}
```

**Pagination.** Only `rows` pages. The funnel table, `sensitiveReport`,
`defaultSelection`, `candidates` and the provenance fields ride **every**
response, page 1 or page N, because the Decide screens render them regardless
of which rows are in view. `rowsTotal` states the ledger's full length on every
response; `rowsPageCap` states the response cap (**2000 rows**) rather than
leaving it to be discovered; `nextCursor` is null if and only if the listing is
complete.

The cursor is opaque — an offset under the hood, base64url of `rows:<n>`, and
never something a client should construct. A cursor this server did not mint —
garbage, or one outlived by a rewritten ledger, since a re-mapped run can
shrink `rows` — is `400 invalid_cursor`, not an empty page pretending to be the
end of the listing.

Note the two distinct caps: `rowsPageCap` (2000) bounds what **one response**
carries; `rowCap` (20000, from the workers) bounds what the **ledger itself**
holds, and `rowsTruncated`/`rowsOmitted` report it when it bit.

{: .important }
> **`costEstimate` describes the whole selection, not the page.** It is
> computed over every ledger row with `verdict: "selected"`, regardless of
> which page is being served. It is deterministic arithmetic over file
> extensions and byte sizes — no model call — and it is a **range**, because
> `bytes ÷ 4` is defensible for plain text and nearly meaningless for a
> `.docx`. `method` spells the arithmetic out so the range renders with its
> provenance. When the ledger is truncated, the method string says the
> estimate covers the kept rows only.

Errors: `401` · `404 no_suggestions` · `400 invalid_cursor`.

### `PUT /:id/map/selection`

Records the customer's decision. **Rebuilt, not patched.**

| | |
| --- | --- |
| Auth | required |
| Body | `removedPaths?: string[]`, `readdedPaths?: string[]` |

Paths are `map_suggestions` rows' `path` values verbatim. An absent array means
"none", so `{}` is a valid keep-everything decision. Every path is validated
against the ledger; an unknown one is a `400` naming both the field and the
path, so a typo'd removal fails loudly here instead of becoming a named
per-file failure (re-adds) or a silent no-op (removals) inside the workflow
later.

Each PUT `$set`s every field of the decision, keyed `{runId, tenantId}`.
`decidedAt` is stamped fresh on every write because it is what the workers sort
on (latest decision wins) and what the mid-run change detection pins against — a
patched document with a stale `decidedAt` would let a mid-ingest re-decision go
undetected.

```http
HTTP/1.1 200 OK
{"runId":"map-conn-…","connectionId":"conn-…",
 "removedPaths":["/Archive/2019/old.pdf"],"readdedPaths":[],
 "decidedAt":"2026-08-20T11:02:53.114Z"}
```

Errors: `401` · `404 No connection <id>` · `404 no_suggestions` ·
`409 suggestion_rows_truncated` · `400 selection_paths_invalid` (with `field`)
· `400 selection_path_unknown` (with `field` and `path`).

A truncated ledger refuses the whole write: membership cannot be validated
honestly against a partial ledger — a real path beyond the cap would 400 as
unknown, and a decision recorded against the partial ledger would quietly cover
a subset.

### `GET /:id/map/selection`

The decision read back, verbatim minus `_id`, tenant-scoped.

```http
HTTP/1.1 200 OK
{"runId":"map-conn-…","tenantId":"acme","connectionId":"conn-…",
 "removedPaths":["/Archive/2019/old.pdf"],"readdedPaths":[],
 "decidedAt":"2026-08-20T11:02:53.114Z"}
```

Errors: `401` · `404 no_selection`.

### `POST /:id/ingest`

Starts `selectiveIngestWorkflow` on the pinned id `ingest-<connectionId>` —
the second consent, enforced at the edge, and the label question finally
answered.

| | |
| --- | --- |
| Auth | required |
| Body | `defaultLabel?: string` |

Gate order: connection exists → `connectorsEnabled` → an **active**
`ingest_content` consent (a `map_metadata` grant does not satisfy it) → a
decided selection on record → `LabelPolicy.resolve`.

A missing selection is a `409`, not a `404`: the connection exists; it is the
*flow* that is mid-state. The Decide phase is not optional on the map path — a
missing decision is never an implicit ingest-everything.

The workflow is started **before** the label is written to the connection. A
503 on the start would otherwise leave the connection relabelled by a request
that ingested nothing, and the next sync would inherit a label the customer
chose for a run that never existed.

```http
HTTP/1.1 202 Accepted
{"status":"ingesting","connectionId":"conn-…","workflowId":"ingest-conn-…"}
```

Errors: `401` · `404 No connection <id>` · `403 connectors_disabled_for_tenant`
· `403 ingest_consent_required` · `409 no_selection` · `403 label_refused` ·
`503` on a durable-start failure.

---

## Consents

### `GET /consents/disclosure`

The exact words to show the human, and the SHA the client must echo back.

| | |
| --- | --- |
| Auth | required |
| Query | `scope` — `map_metadata` \| `ingest_content`; `locale` — `en` \| `es-MX` (default from `UI_LOCALE`) |

```http
HTTP/1.1 200 OK
{"disclosureId":"map_metadata.v1","scope":"map_metadata","locale":"en",
 "text":"…the full disclosure text, verbatim…",
 "sha256":"3d1a…"}
```

Display `text` verbatim and return `sha256` as `disclosureSha256` on the grant.
That round trip is what lets the stored record say "these are the words the
subject read" instead of "the subject clicked a button next to something".

There is **no locale fallback**. A locale with no reviewed text is
`400 disclosure_not_found`, not a silent substitution — storing English words
on a Spanish-speaking subject's record and asserting they read them would be a
false record, which is worse than a refusal.

Errors: `401` · `400 consent_scope_invalid` · `400 disclosure_not_found`.

### `POST /:id/consents`

Grant one scope over one subtree. Appends **one event** to an append-only
stream; nothing is ever updated in place.

| | |
| --- | --- |
| Auth | required |
| Body | `scope`, `locale?`, `disclosureSha256`, `target?`, `exclusions?` |

`target` accepts `siteId`, `driveId`, `folderId`, `folderPath` — each a
non-empty string or null. `provider` is **always** the connection's own, never
taken from the body, so a consent can never claim to cover a provider this
connection does not talk to; `driveId` falls back to the connection's when the
body omits it. `exclusions` is an array of at most **500** non-empty strings,
each at most 1024 characters.

`subjectSub` and `subjectUpn` come from the host-verified auth context, never
from the body: a body-supplied actor is a caller's claim about itself. A
consent with no identified subject is **refused**, not recorded with a
placeholder — an unattributable consent is not a weaker consent, it is not a
consent.

```http
HTTP/1.1 201 Created
{"consentId":"consent-…","connectionId":"conn-…","scope":"map_metadata",
 "action":"granted","disclosureId":"map_metadata.v1","disclosureSha256":"3d1a…",
 "disclosureLocale":"en","subjectSub":"user-42",
 "grantedAt":"2026-08-19T10:06:02.881Z"}
```

The stored record carries the **full disclosure text verbatim**, never an i18n
key. The write uses `w:'majority', j:true`; an unacknowledged write is a `503`
and the operation the consent would have authorised does not start.

Errors: `401` · `404 No connection <id>` · `403 connectors_disabled_for_tenant`
· `403 mapping_disabled_for_tenant` (for `map_metadata` only) ·
`400 consent_scope_invalid` · `400 disclosure_not_found` ·
`400 consent_exclusions_invalid` · `403 consent_subject_required` ·
`409 disclosure_text_mismatch` · `503 consent_not_recorded`.

### `POST /:id/consents/:consentId/revoke`

Appends a **new** event carrying `revokesConsentId`. It never updates the
granting document — there is no status field to overwrite, and no update path
in the consent module at all. The revocation copies the grant's scope, target,
exclusions and disclosure forward so the event is self-contained.

```http
HTTP/1.1 201 Created
{"consentId":"consent-…","revokesConsentId":"consent-…","connectionId":"conn-…",
 "scope":"map_metadata","action":"revoked","subjectSub":"user-42",
 "grantedAt":"2026-08-22T08:31:10.442Z"}
```

{: .note }
> **Revocation is never gated by either tenant switch** — there is deliberately
> no `flags()` read on this route. A tenant whose connectors were turned off
> after a grant must still be able to withdraw it; a gate that blocks
> withdrawal turns an operational switch into a trap.

Errors: `401` · `404 No connection <id>` · `403 consent_subject_required` ·
`404 consent_not_found` · `409 consent_already_revoked` ·
`503 consent_not_recorded`.

### `GET /:id/consents`

Every event for one connection, newest first, plus which grants are currently
live. `active` is **derived** from the events — there is no stored status to
read.

```http
HTTP/1.1 200 OK
{"connectionId":"conn-…",
 "events":[{"consentId":"consent-…","tenantId":"acme","connectionId":"conn-…",
   "subjectSub":"user-42","subjectUpn":"ada@example.com","scope":"map_metadata",
   "target":{"provider":"onedrive","siteId":null,"driveId":"b!…",
     "folderId":"01ABC…","folderPath":"/Finance"},
   "exclusions":[],"disclosureId":"map_metadata.v1","disclosureSha256":"3d1a…",
   "disclosureLocale":"en","disclosureText":"…","action":"granted",
   "revokesConsentId":null,"grantedAt":"…","sourceIp":"203.0.113.7",
   "userAgent":"Mozilla/5.0 …"}],
 "active":[{"consentId":"consent-…","scope":"map_metadata","target":{…},
   "exclusions":[],"subjectSub":"user-42","grantedAt":"…"}]}
```

Errors: `401` · `404 No connection <id>`.

---

## The SSE stream

`GET /:id/map/stream` — the narration a customer reads while the map walks
their drive.

The route checks the connection exists **before** hijacking the reply, while a
plain JSON `404` is still possible. After that it takes over the raw response:
`Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`.

Server-side it **polls** the `map_runs` document — the workflow flushes
progress every page, and polling is the correct transport for that write
pattern. Each new narration line is emitted exactly once (the document
accumulates, the stream deltas); progress is emitted when it changes.

### Frame types

Every data frame is one JSON object with a `type`.

| `type` | Shape | When |
| --- | --- | --- |
| `narration` | `{"type":"narration","line":<narration line>}` | once per new line in the run document's `narration` array |
| `progress` | `{"type":"progress","progress":{…}}` | when the serialized `progress` object changes |
| `complete` | `{"type":"complete", …run document…}` | terminal — see below |
| `error` | `{"type":"error","error":"no_map_run"}` | no run document appeared within the no-run timeout |
| `error` | `{"type":"error","error":"map_stream_failed"}` | the store read failed mid-stream |

```
data: {"type":"narration","line":{"kind":"sum","text":"…"}}

data: {"type":"progress","progress":{"itemsSeen":18422,"foldersWalked":961,…}}

: hb

data: {"type":"complete","status":"complete","runId":"map-conn-…",…}
```

### The terminal frame

The stream ends on **any** non-`mapping` status — `complete`, `failed`,
`refused_no_consent`, `refused_out_of_scope`, `unsupported_provider`. The frame
is `{"type":"complete", …}` in every one of those cases; the `status` field
inside says which, and the UI routes on it. Do not treat the frame name as the
outcome.

The frame is the run document minus `_id` and minus `narration` (every line was
already streamed individually).

### The byte cap and its graded degradation

Every frame is measured before it is written. The cap is **32,000 bytes**.

One oversized SSE frame can reproduce a documented proxy-cutoff failure mode —
the proxy buffers, stalls, and severs the stream — which is why the cap exists
at all rather than trusting frames to stay small.

- **Narration and progress frames** are small by construction. A frame that
  busts the cap is **dropped and logged loudly**, never silently shrunk: the
  transport does not know which fields a frame can honestly shed, so it
  reports and the route decides.
- **The terminal frame** is the one that can grow (a full prune manifest runs
  to 2000 entries), so it *degrades* instead of dying, in two graded steps,
  each **flagged in the frame**:
  1. over the cap → drop `pruneManifest`, add `"pruneManifestElided": true`
  2. still over → drop `topFolders`, add `"topFoldersElided": true`

Both elided fields remain fetchable **in full** at `GET /:id/map`. Nothing is
shed without saying so.

### Heartbeats

An SSE comment frame — the literal bytes `: hb\n\n` — is written whenever the
stream has been idle past `mapStream.heartbeatMs` (default **15000**).
`EventSource` ignores comments; proxies do not, and a walk grinding through a
huge folder can legitimately go quiet for longer than a proxy idle timeout.

`heartbeatMs: 0` means "always due" and is honoured as 0 (tests use it for
determinism). Non-finite or negative values fall back to the default — a host
reading the knob from an env var can hand over `Number('15s')`, and every
`elapsed >= NaN` comparison is false, which would silently turn heartbeats
*off* and proxy-cut exactly the long quiet walks they exist to keep alive.

### The no-run timeout

A stream opened before the workflow's first write — or for a connection never
mapped — waits `mapStream.noRunTimeoutMs` (default **5000**) for a run
document, then emits `{"type":"error","error":"no_map_run"}` and closes.
Bounded, and stated, rather than hanging forever.

### Tunables

| `config.mapStream` | Default | Meaning |
| --- | --- | --- |
| `pollMs` | 700 | poll cadence against the run document — matches the narration engine's minimum per-line pace, so the stream runs at reading speed |
| `heartbeatMs` | 15000 | idle threshold before a comment heartbeat; 0 = always due |
| `noRunTimeoutMs` | 5000 | how long a stream waits for a run document before 404-framing and closing |

### Reconnection expectations

- There is **no `id:` field and no `Last-Event-ID` handling.** A reconnecting
  client is a new stream: `narrationSent` restarts at zero, so the whole
  accumulated narration replays. Clients must dedupe by index against what they
  already hold — which is exactly what the shipped UI does.
- The stream **ends after the terminal frame.** A bare `EventSource` would
  auto-reconnect and receive the terminal frame again (the run's status is
  still non-`mapping`), so a client must stop on the terminal frame.
- Client disconnect is handled: the route listens for `close` on the raw
  request, clears its timer and marks the stream abandoned without touching
  the socket. Once closed, every write is a no-op — a poll loop that lost its
  client must not crash the process writing to a dead socket.
- The shipped UI reads the stream with `fetch` + a streaming body reader (not
  `EventSource`), reconnects **once** after a drop, and on the second drop
  falls back to polling `GET /:id/map` every 2500 ms — and says on screen that
  it did. That is a reasonable pattern to copy.

{: .note }
> **No billing or attribution gate on this route, deliberately.** The narration
> at this stage is arithmetic; no model call happens anywhere on this path, so
> there is nothing to attribute and nothing to bill. A host that adds model
> narration must add its own attribution gate at that point — the moment a
> model is asked, this route stops being free.
