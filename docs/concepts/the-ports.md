---
title: The ports
parent: Concepts
nav_order: 4
---

# The ports

shelfmark plugs into a host system at exactly five seams, declared in
`packages/core/src/ports.ts`. If you are adopting this library, this is the
page that matters: everything else is behavior you inherit, and this is the
behavior you supply.

The division of labor is stated at the top of that file, and it is worth
reading as a contract rather than a preamble:

> shelfmark owns the walk, the consent ledger, the selection algebra and the
> run records; the **host** owns identity, authorization policy, tenancy
> switches, sensitivity labels, and — decisively — what happens to a file's
> bytes after download.

That is what makes the library consumable. Every coupling the system it was
extracted from had — a signed-context token, a policy sidecar, a clearance
ladder, a RAG pipeline — maps onto exactly one interface here, so you can
adopt the connector without inheriting any of those decisions.

```ts
export interface ShelfmarkPorts {
  sink: DocumentSink;
  resolveAuth: AuthContextResolver;
  /** Default: everything enabled, no default label. */
  tenantPolicy?: TenantPolicy;
  /** Default: labels()=[] (label UI hidden), resolve()='default'. */
  labelPolicy?: LabelPolicy;
  /** Default: allow. See the fail-closed contract. */
  egressGate?: EgressGate;
}
```

Two are required. Three have exported no-op defaults —
`DEFAULT_TENANT_POLICY`, `DEFAULT_LABEL_POLICY`, `ALLOW_ALL_EGRESS` — which
hosts and tests can compose from rather than reimplement.

---

## `DocumentSink` — the handoff boundary

This is **the** port. Everything else configures the run; this one decides
what the run is *for*.

```ts
export interface DocumentSink {
  accept(meta: DocumentMeta, content: Buffer): Promise<SinkOutcome>;
}
```

### Where the boundary sits

Connector territory ends when bytes cross `accept()`. The connector keeps
everything that protects its own bandwidth and the honesty of its ledger:

- the **pre-download filters** — unreadable-by-construction types (media,
  archives, executables) and the size ceiling applied to the provider-reported
  size, both decided *before a single byte is fetched*;
- the **download** itself;
- the **post-download size ceiling**, for the one case the pre-filter cannot
  cover — a provider that reported no size up front. The file was opened, so
  the message says so, but it is still a skip: nothing about the document is
  broken, we declined to process it.

Everything after bytes-in-hand — object storage, parsing, chunking, indexing,
entity extraction, budget accounting, whatever your pipeline does — is the
sink's business, and none of it appears in this package. There is no storage
client here and no HTTP call to a processing service. The demo ships an
`FsDocumentSink` that builds a searchable local text corpus; a RAG pipeline is
exactly one other implementation of the same interface.

### What a sink is told

```ts
export interface DocumentMeta {
  documentId: string;    // connector-generated, STABLE across retries
  tenantId: string;
  connectionId: string;
  runId: string;
  filename: string;
  mimetype: string;      // the connector's guess; sniff for yourself if you like
  size: number;
  remotePath: string;    // real remote folder path — provenance, not storage layout
  remoteFileId: string;  // provider item id — the dedupe key
  label: string;         // already resolved through LabelPolicy
  isRetry: boolean;
}
```

`runId` is threaded through so a sink can attribute what it accepted to the
run record the customer is watching. `remotePath` is provenance — it makes
folder-scoped filtering work in whatever you build, with no further connector
work — and it is deliberately *not* a storage layout instruction.

### The four outcomes

```ts
export type SinkOutcome =
  | { status: 'ingested' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; skipReason: string; error?: string }
  | { status: 'deferred'; reason: string };
```

| Outcome | Means | What the run does |
| --- | --- | --- |
| `ingested` | you took it | counted as read |
| `failed` | something broke | named per file in the run record |
| `skipped` | you deliberately did not take it | counted, with your reason token carried verbatim into the per-reason rollup |
| `deferred` | you decline **for now** — quota, budget, backpressure | recorded as deferred; **you** own resuming it |

`deferred` is the outcome most systems lack, and its absence is a specific bug
this design already paid for: the same file entering by two paths reported two
contradictory statuses, because "the pipeline is full right now" had to be
spelled as a failure. A deferral is not a failure. The run records it, the
ledger shows it, and a host retry pass re-submits with `isRetry: true`.

The connector's *own* skip vocabulary is closed
(`already_ingested | too_large | unsupported_type | deferred` plus the Google
export case), because those roll up into a polled progress document and an
open string set there is an unbounded map. Your `skipReason` at the sink seam
may be any token you like — the sink is host code, and the closed vocabulary
governs only what the library itself decides. Unrecognized tokens are counted
under `unnamed` rather than dropped.

{: .important }
> A sink that **throws** instead of answering is treated as a per-file
> `failed`, named in the run record. One broken file — or one hiccup in your
> pipeline — must not crash a whole batch activity.

### The `isRetry` / stable-`documentId` contract

This is the part a sink must actually implement, not merely read.

```ts
export function documentIdFor(connectionId: string, remoteFileId: string): string {
  const digest = createHash('sha256')
    .update(`${connectionId} ${remoteFileId}`)
    .digest('hex');
  return `doc-${digest.slice(0, 32)}`;
}
```

`documentId` is a pure function of `(connectionId, remoteFileId)`, so every
re-enumeration, retry and re-sync of the same remote file produces the same
id. It is hashed rather than concatenated so it is fixed-length and carries no
remote path or provider identifier into whatever namespace you store it in.

**A sink seeing a repeated `(connectionId, remoteFileId)` with `isRetry` MUST
update, not duplicate.**

That obligation exists because the system this was extracted from deduped by
querying its own documents table before every download — and a re-enumeration
*without* that check silently doubled the corpus. This library has no such
table (you own terminal storage), so the same guarantee is carried by the
contract instead. A sink that keeps its own records may answer
`{ status: 'skipped', skipReason: 'already_ingested' }` from them, and the run
ledger reports it exactly as the original system did.

{: .warning }
> Downloads materialize as a whole `Buffer` before crossing `accept()`. There
> is no streaming; the size ceiling (25 MiB by default, `CONNECTOR_MAX_INGEST_FILE_BYTES`)
> is what bounds memory. Moving to `Readable` is the intended v2 evolution of
> this port, declared now so sinks are written knowing it. See
> [known limitations](../project/known-limitations.md).

Implementation walk-through: [implementing a DocumentSink](../guides/document-sink.md).

---

## `AuthContextResolver` — who is driving

```ts
export type AuthContextResolver = (req: {
  headers: Record<string, string | string[] | undefined>;
}) => Promise<AuthContext | null>;

export interface AuthContext {
  tenantId: string;   // scopes every query and every stored record
  sub: string;        // the consent actor recorded on every grant
  upn?: string;       // display identity, shown in consent receipts
  label?: string;     // the actor's own opaque sensitivity label, if you have such a notion
}
```

**Replaces:** whatever your platform already does — a signed context header, a
session lookup, a JWT verification.

**What a host typically does:** verify the incoming credential and map it to a
tenant and a stable subject id.

**Default:** none. This port is required.

**Failure semantics:** `null` means unauthenticated and the API layer answers
`401`. There is one deliberate exception: the OAuth callback routes arrive
tokenless from the provider and authenticate via the signed state JWT instead.
Any gateway in front must allowlist **exactly** those paths — and no consent
path may ever be on an anonymous allowlist.

`tenantId` is not advisory. It appears in the query filter of every read and
every write, so a `connectionId` from another tenant reads as *absent* rather
than as another tenant's data — including its consent history.

`sub` is what the consent ledger records as the acting human. A token with no
subject claim cannot grant consent at all
([the consent model](consent-model.md)).

---

## `TenantPolicy` — the switches

```ts
export interface TenantFlags {
  connectorsEnabled: boolean;
  mappingEnabled: boolean;
  defaultLabel?: string;
}
export interface TenantPolicy {
  flags(tenantId: string): Promise<TenantFlags>;
}
```

**Replaces:** a feature-flag service, an entitlement lookup, a per-workspace
settings row.

**What a host typically does:** read its own plan/entitlement state for the
tenant.

**Default:** `DEFAULT_TENANT_POLICY` answers
`{ connectorsEnabled: true, mappingEnabled: true }` with no default label, so
the demo runs out of the box.

**Failure semantics:** every call site checks `mappingEnabled` with a strict
`=== true`, so anything that is not literally `true` — absent, undefined, a
truthy string — reads as **off**. Mapping is opt-in by design: a map sends
names and counts outward. `connectorsEnabled` is a default-on posture by
contrast. A host that cannot resolve a tenant should answer fail-closed, which
is what makes an unknown tenant unable to write a consent record at all.

Both switches are checked twice: once when the consent is granted, and again
when the map is started. The gap between those moments is the case that
matters — an admin who turns mapping off *after* a grant has withdrawn the
tenant-level precondition, and a standing consent must not outrank it.

---

## `LabelPolicy` — sensitivity, capped not raised

```ts
export interface LabelPolicy {
  labels(): readonly { id: string; nameKey?: string }[];
  resolve(requested: string | undefined, ctx: AuthContext): string;
}
```

**Replaces:** a clearance ladder, a classification scheme, a data-handling
tier. The system this was extracted from had an export-control clearance
ladder; it generalizes to an ordered list plus a resolve hook.

**What a host typically does:** offer its own vocabulary in `labels()`, and in
`resolve()` cap the requested label against what the acting user is cleared
for.

**Default:** `DEFAULT_LABEL_POLICY` returns `labels() = []` — which **hides
the label UI entirely** — and `resolve()` passes the request through, falling
back to `'default'`.

**Failure semantics:** `resolve()` may return a **different, capped** label —
never a higher one — or throw `LabelRefusedError` to refuse outright. A
refusal becomes `403 label_refused` carrying the requested value. The resolved
label is fixed before the ingest workflow starts and is already resolved by
the time a `DocumentMeta` reaches your sink; it is also the label the cloud
egress question is asked at.

An id the host's config does not know renders **verbatim** in the UI rather
than being dropped — the closed-vocabulary fallback used by every table in the
UI package. See [honest accounting](honest-accounting.md).

---

## `EgressGate`

```ts
export interface EgressGate {
  /** May this tenant's content (at this label) leave for cloud processing? */
  checkCloudEgress(q: { tenantId: string; label: string }): Promise<EgressDecision>;
  /** May this tenant run a metadata map at all? */
  checkMapEgress(q: { tenantId: string }): Promise<EgressDecision>;
}

export type EgressDecision = { allowed: true } | { allowed: false; reason: string };
```

**Replaces:** a policy sidecar, a data-residency check, an OPA query.

**What a host typically does:** ask its own policy engine whether this
tenant's data may cross whatever boundary the deployment cares about.

**Default:** `ALLOW_ALL_EGRESS`. Absent from config → allow.

### The fail-closed contract

Three postures, and the distinction between the first two is the whole point:

| Situation | Behavior |
| --- | --- |
| **No gate configured** | allow — a missing gate is a *decision the host made in configuration* |
| **Configured gate throws** (unreachable, timeout) | retryable typed failure `EgressGateUnreachable`; the run pauses and retries and **never proceeds as if allowed** |
| **Gate answers no** | non-retryable typed failure (`MapEgressDenied` / `CloudEgressDenied`) |

*A missing gate is a decision; a broken gate is an outage.* And a denial is an
**answer** — retrying an answer is how a denied tenant's run burns five
attempts discovering the same fact, so denials are non-retryable on purpose.

### Why `checkMapEgress` takes no document label

This is the port's most load-bearing design decision, and it was bought with a
production incident.

The first live map returned **zero items**. Nothing was broken. The walk had
borrowed the ingest path's egress gate — the one that asks *"what is this
**document's** label?"* — and a map opens no documents, so the answer was null
and the gate failed closed **exactly as written**. The policy was right. The
caller was asking the wrong question.

So the port has two methods rather than one method with a nullable label. The
map's question is the tenant-level one: *may this tenant run a metadata map at
all?* The label question is deliberately deferred until ingest, because at map
time nothing has been read and any answer would be a guess.

The shape has a property worth naming: a host policy that *demands* a document
label will now fail closed against a caller asking the wrong question, because
the wrong question can no longer be spelled. That is the correct failure — but
it is a failure, and it will look like an empty result unless you read the
run's typed refusal.

See also [two verbs](two-verbs.md), which is the same separation one layer up.
