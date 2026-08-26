---
title: "@shelfmark/core"
parent: Packages
grand_parent: Reference
nav_order: 3
---

# `@shelfmark/core`

Domain types, **the five ports**, the consent engine, the cost estimate, token
crypto, and the Mongo store. One runtime dependency: `mongodb`.

```bash
pnpm add @shelfmark/core
```

```ts
import {
  // ports
  type ShelfmarkPorts, type DocumentSink, type AuthContext,
  DEFAULT_TENANT_POLICY, DEFAULT_LABEL_POLICY, ALLOW_ALL_EGRESS, LabelRefusedError,
  // consent
  createConsentStore, defaultDisclosureRegistry, activeConsents, ConsentError,
  // store
  storeFromDb, createStoreClient, ensureStoreIndexes,
  // misc
  encryptToken, decryptToken, estimateIngestCost, COST_MODEL,
} from '@shelfmark/core';
```

The package index re-exports everything from `tokenCrypto`, `costEstimate`,
`consent/disclosures`, `consent/store`, `ports`, and `store/`.

## The ports

`packages/core/src/ports.ts` defines the five seams a host plugs into:
`DocumentSink`, `AuthContextResolver`, `TenantPolicy`, `LabelPolicy`,
`EgressGate`, bundled as `ShelfmarkPorts`.

They are explained properly — including what each one replaced and why the
defaults are shaped the way they are — in
[Concepts → The five ports](../../concepts/the-ports.md). What belongs in a
reference page:

```ts
export interface ShelfmarkPorts {
  sink: DocumentSink;                 // required
  resolveAuth: AuthContextResolver;   // required
  tenantPolicy?: TenantPolicy;        // default: everything enabled
  labelPolicy?: LabelPolicy;          // default: labels()=[], resolve()='default'
  egressGate?: EgressGate;            // default: allow
}

export const DEFAULT_TENANT_POLICY: TenantPolicy;  // { connectorsEnabled: true, mappingEnabled: true }
export const DEFAULT_LABEL_POLICY: LabelPolicy;    // labels() => [], resolve(r) => r ?? 'default'
export const ALLOW_ALL_EGRESS: EgressGate;         // both checks allow

export class LabelRefusedError extends Error {
  constructor(readonly requested: string | undefined, message?: string);
}
```

Three contract points a host must not get wrong:

- **`DocumentSink.accept()` is the boundary.** Connector territory ends when
  bytes cross it. A sink seeing a repeated `documentId` with `isRetry` **must
  update, not duplicate** — that obligation replaces a dedupe query this
  library cannot make, because it owns no document table.
- **A host that cannot resolve a tenant must answer
  `{connectorsEnabled: false, mappingEnabled: false}`** — fail closed. The
  shipped default answers everything-enabled, which is honest for a
  single-tenant demo and exactly the posture a multi-tenant host must replace.
- **A configured `EgressGate` that throws must not be treated as allow.** The
  workflows convert it into a *retryable* typed failure: the run pauses and
  retries. A missing gate is a decision; a broken gate is an outage.

`EgressGate` has two methods rather than one with a nullable label, because
they are different questions. A map opens no documents, so asking "what is this
content's label?" at map time guarantees a wrong answer — the map's question is
the tenant-level one.

`SinkOutcome` is the four-state vocabulary:

```ts
type SinkOutcome =
  | { status: 'ingested' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; skipReason: string; error?: string }
  | { status: 'deferred'; reason: string };
```

{: .note }
> `ports.ts` also exports an `IngestSkipReason` union
> (`already_ingested | too_large | unsupported_type | deferred`) describing
> what *this library* decides. `@shelfmark/policy` exports a same-named,
> slightly wider closed vocabulary that adds `unsupported_google_format` and is
> the one the rollups are keyed on. A sink's own `skipReason` string is carried
> verbatim — an open vocabulary at the sink seam is acceptable because the sink
> is host code.

## Consent

### The disclosure registry

```ts
export type ConsentScope = 'map_metadata' | 'ingest_content';
export type ConsentLocale = 'en' | 'es-MX';
export type DisclosureStatus = 'current' | 'superseded';

export interface DisclosureRegistry {
  getDisclosure(scope: ConsentScope, locale: ConsentLocale): ConsentDisclosure | undefined;
  getDisclosureById(disclosureId: string, locale: ConsentLocale): ConsentDisclosure | undefined;
  listDisclosures(): readonly ConsentDisclosure[];
}

export const defaultDisclosureRegistry: DisclosureRegistry;
export function createDisclosureRegistry(dir: string): DisclosureRegistry;
export function disclosureSha256(text: string): string;
export function defaultConsentLocale(): ConsentLocale;
export function isConsentScope(v: unknown): v is ConsentScope;
export function isConsentLocale(v: unknown): v is ConsentLocale;
export const VENDORED_CONSENT_DIR: string;
```

**This module holds no disclosure copy.** The words live in exactly one place —
the canonical `consent/disclosures/*.md` tree at the repository root, indexed by
`consent/disclosures.manifest.json` — and the package carries a byte-identical
**vendored** copy under `vendor/consent/`, SHA-compared against the canonical
tree on every build. Drift is a red build, never a silent divergence.

**Fail closed at load.** Every vendored file is hashed at import and compared to
the manifest; every (scope, locale) pair must resolve to exactly one `current`
entry. Anything else throws, taking the process down at startup rather than
letting it serve a disclosure whose bytes are not the bytes the manifest
describes. A consent surface that is wrong is worse than one that is down.

`status` is **derived** from `manifest.current`, never typed per entry, so "two
entries both claiming to be current" is unrepresentable rather than merely
checked. `superseded` is not "deleted" and not "wrong" — it is the exact text
some human agreed to on some date, and it must stay resolvable by id for as long
as any record references it, which is forever.

**No locale fallback.** An unregistered locale returns `undefined` and the
caller refuses. Falling back to English would store English words on a Spanish
speaker's record and assert they read them — a false record, worse than a
refusal. `defaultConsentLocale()` maps the deployment's coarse `UI_LOCALE`
(`en`/`es…`) onto the consent locale set as a **server-side default only**: an
explicit `locale=es` on a request is still refused.

To correct a disclosure — **all three steps, or the correction is a no-op**:

1. Add a **new file per locale** whose name carries the new id
   (`map_metadata.v2.en.md`, `map_metadata.v2.es-MX.md`). Never edit an existing
   file: `en` on v2 and `es-MX` on v1 is two different permissions under one
   name.
2. Point `manifest.current[scope]` at the new id. Old entries stay in the
   manifest **forever** — `getDisclosureById` is how a record stored last year
   is read back.
3. Re-vendor and move the pins in the disclosures test.

Step 2 is the one that used to be missing, which is why the procedure is spelled
out: resolution used to be on (scope, locale) alone, returning the first match,
so a correctly-registered v2 was never served. A reviewer followed the documented
procedure, nothing happened, and the whole suite stayed green.

### The consent store

```ts
export const CONSENT_COLLECTION = 'connector_consents';
export const MAX_EXCLUSIONS = 500;

export interface ConsentStore {
  recordConsentGrant(input: GrantConsentInput): Promise<ConsentRecord>;
  recordConsentRevocation(input: RevokeConsentInput): Promise<ConsentRecord>;
  listConsentEvents(tenantId: string, connectionId: string): Promise<ConsentRecord[]>;
  activeConsents(events: ConsentRecord[]): ConsentRecord[];
}

export function createConsentStore(db: Db, options?: { registry?: DisclosureRegistry }): ConsentStore;
export function activeConsents(events: ConsentRecord[]): ConsentRecord[];  // pure, standalone too

export class ConsentError extends Error {
  readonly code: ConsentErrorCode;
  readonly statusCode: number;
}
```

`ConsentErrorCode`: `consent_subject_required` · `consent_scope_invalid` ·
`consent_exclusions_invalid` · `disclosure_not_found` ·
`disclosure_text_mismatch` · `consent_not_found` · `consent_already_revoked` ·
`consent_not_recorded`. Each carries its own HTTP status — see
[Errors](../errors.md#consent).

This is **not another audit collection**, and the three differences are the
whole point:

1. **The write is never swallowed.** `w:'majority', j:true`; an unacknowledged
   write throws; every error propagates to the caller, which refuses the
   operation. A default-write-concern insert can be acknowledged and then lost
   to a failover, which for evidence means the operation ran against a consent
   nobody can produce. The adjacent audit log this grew up beside wrapped its
   insert in `catch {}` and called the durable copy best-effort — reasonable for
   a log whose structured line already reached an aggregator, and the exact
   inverse of what evidence requires.
2. **Revocation is a new event**, carrying `revokesConsentId`. There is no
   status field to overwrite and no update path in the module at all. Whether a
   consent is live is **derived** by `activeConsents`.
3. **`subjectSub` is required.** A consent whose actor is unknown is refused,
   not recorded with a placeholder. An unattributable consent is not a weaker
   consent — it is not a consent.

The stored record carries the **full disclosure text verbatim**, never an i18n
key: a key changes on any deploy and leaves the record pointing at words nobody
can reconstruct. The text stored is always the *server's* registry text; the
caller only gets to prove, via `presentedSha256`, that what it displayed was
that text. A mismatch is a `409` — a stale portal bundle, or a caller inventing
a consent, and the record would otherwise be a false statement about what the
subject read.

## Cost estimate

```ts
export const COST_MODEL: Readonly<{
  TEXT_LIKE_EXTENSIONS: readonly string[];   // ['md','txt','csv']
  TEXT_BYTES_PER_TOKEN: 4;
  BINARY_BYTES_PER_TOKEN_LOW_YIELD: 50;
  BINARY_BYTES_PER_TOKEN_HIGH_YIELD: 4;
}>;
export const COST_ESTIMATE_METHOD: string;

export function estimateIngestCost(
  rows: { name: string; size: number }[],
  opts?: { ledgerTruncated?: boolean }
): IngestCostEstimate;
```

Returns `{ textShareBytes, binaryShareBytes, binaryShareOfSelection, tokenLow,
tokenHigh, method }`.

Pure, deterministic arithmetic — **no model call anywhere**. It is a *range*
because `bytes ÷ 4` is defensible for plain text and nearly meaningless for a
`.docx`: a container format that is mostly structure and media can yield as
little as ~1 token per 50 bytes, and no format yields more extracted text than
its own bytes, so the ceiling is the same ÷4 as plain text. Those bounds are
**stated, not measured per format**; reconciliation against real token counts
happens after parsing, not here.

A file with **no extension counts in the binary share** — its format is
unknown, and the honest bucket for unknown is the wide range, not the confident
one. `binaryShareOfSelection` is `0` for an empty selection, not `NaN`. When
`ledgerTruncated` is set, the `method` string says the estimate covers the kept
rows only.

`COST_MODEL` is exported as one frozen object so the UI's live cost mirror
computes with the same numbers rather than a hand-synced copy.

## Token crypto

```ts
export interface EncryptedToken { ciphertext: string; iv: string; tag: string }  // all base64
export function encryptToken(plaintext: string): EncryptedToken;
export function decryptToken(encrypted: EncryptedToken): string;
```

AES-256-GCM with a 96-bit IV, keyed by `CONNECTOR_TOKEN_ENCRYPTION_KEY` — a
base64 value that must decode to **exactly 32 bytes**, checked on every call.
Missing or wrong-length throws.

A refresh token is a per-tenant, **runtime-created** secret: unlike deploy-time
secrets synced from a secret store into env vars, it has nowhere to be
provisioned ahead of time. Storing ciphertext in the database alongside one
per-environment data key keeps it consistent with the static-secret pattern
instead of requiring dynamic writes back into the secret store.

{: .warning }
> Any change here is a **wire-format change for every stored token**. The API
> edge encrypts at OAuth-callback time and the worker decrypts to use the token
> during a run, so the two sides must stay algorithm-compatible forever.
> Coordinate a re-encryption migration before altering the algorithm, IV size,
> tag length, or key sourcing.

## Store

```ts
export const DEFAULT_STORE_DB_NAME = 'shelfmark';

export function storeFromDb(db: Db): ShelfmarkStore;
export function createStoreClient(uri?: string, dbName?: string): Promise<ShelfmarkStoreClient>;
export function ensureStoreIndexes(db: Db): Promise<void>;
export function resolveMongoUri(serviceName: string): string;
```

`ShelfmarkStore` is `{ db, collections }`, where `collections` holds **typed
accessors** — `connections()`, `consents()`, `mapRuns()`, `mapCandidates()`,
`mapSuggestions()`, `mapSelections()`, `selectiveIngestRuns()`. Accessors rather
than fields, so a host can hand the same object across a reconnect: every call
re-reads the live `db`.

`createStoreClient()` connects with a 5-second server-selection timeout, ensures
indexes, and returns the store plus the `MongoClient` and a `close()`.

Collection names, the document shapes, the index set, and the lifecycle of each
collection are documented in [Data model](../data-model.md).

`resolveMongoUri` refuses to guess a URI in-cluster — see
[the rationale](../data-model.md#mongodb_uri-resolution).

## Gotchas

- Importing this package **loads and SHA-verifies the vendored disclosures at
  import time**. A tampered vendor directory is an import-time crash, by
  design.
- `encryptToken`/`decryptToken` read the key per call, so an env var set after
  import is picked up — unlike `@shelfmark/graph`'s client credentials.
- `listConsentEvents` returns events **newest first** (`grantedAt: -1`), and
  `activeConsents` preserves that order.
- The consent store's second-revocation guard is a caller-facing convenience,
  not a correctness invariant. The log is append-only, so a duplicate
  revocation would be harmless; nothing downstream may depend on there being
  exactly one.
