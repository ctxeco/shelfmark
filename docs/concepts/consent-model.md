---
title: Consent model
parent: Concepts
nav_order: 2
---

# Consent model

The consent ledger is not an audit log. An audit log records that something
happened; this records **what a person was told and agreed to**, and it has to
survive being read back by someone who was not there — a regulator, a
customer, a court. Three properties follow from that, and they shape the whole
module (`packages/core/src/consent/`).

For the governance rules around the disclosure *text* — one canon, vendored
everywhere, never edited in place — see
[consent governance](../project/consent-governance.md). This page is about the
mechanism.

## One document per event, never mutated

`connector_consents` holds one immutable document per consent **event**. There
is no `status` field, and there is no update path in the module at all.

A revocation is an **insert** carrying `revokesConsentId`:

```ts
export interface ConsentRecord {
  consentId: string;
  tenantId: string;
  connectionId: string;
  subjectSub: string;          // required — see below
  subjectUpn: string | null;
  scope: ConsentScope;         // 'map_metadata' | 'ingest_content'
  target: ConsentTarget;
  exclusions: string[];
  disclosureId: string;
  disclosureSha256: string;
  disclosureLocale: ConsentLocale;
  disclosureText: string;      // the full text shown, verbatim
  action: ConsentAction;       // 'granted' | 'revoked'
  revokesConsentId: string | null;
  grantedAt: Date;
  sourceIp: string | null;
  userAgent: string | null;
}
```

Liveness is therefore **derived**, not stored:

```ts
export function activeConsents(events: ConsentRecord[]): ConsentRecord[] {
  const revoked = new Set(
    events
      .filter((e) => e.action === 'revoked' && e.revokesConsentId)
      .map((e) => e.revokesConsentId as string)
  );
  return events.filter((e) => e.action === 'granted' && !revoked.has(e.consentId));
}
```

The alternative this replaced was `$set: { status: 'disconnected' }`. That
answer loses the previous state, and with it the answer to *"what was
permitted on 12 August"*. Under an event stream that question is a filter over
the same documents, not a value somebody overwrote.

The revocation event carries the grant's own scope, target, exclusions and
disclosure forward, so a reader holding **only that one document** can see
which permission, over which subtree, on which words, was withdrawn.

{: .note }
> A second revocation of the same grant answers `409 consent_already_revoked`.
> That is a caller-facing guard, not a correctness invariant — the log is
> append-only and the first event already withdrew the grant. Nothing
> downstream may depend on there being exactly one revocation event.

## A persistence failure answers an error, never 2xx

The write is `w: 'majority', j: true`, an unacknowledged write throws, and the
write path deliberately has **no** `try`/`catch`:

```ts
const result = await db
  .collection(CONSENT_COLLECTION)
  .insertOne({ ...record }, { writeConcern: { w: 'majority', j: true } });

if (!result?.acknowledged) {
  throw new ConsentError(
    'consent_not_recorded',
    503,
    'The consent record was not acknowledged by the database; the operation did not start.'
  );
}
```

`j: true` means acknowledged only once the write is on the journal of a
majority of the replica set. A default-write-concern insert can be
acknowledged and then lost to a failover — which, for evidence, means the
operation ran against a consent nobody can produce.

Every error propagates to the caller, which refuses the operation. At the HTTP
edge a `ConsentError` answers its own status code and anything else becomes
`503 consent_not_recorded`. A logged warning plus a 200 would mean reading
someone's storage on the strength of a promise you no longer hold. That is the
difference between an audit log and evidence.

`subjectSub` is likewise **required** — a consent whose actor is unknown is
refused (`403 consent_subject_required`), not recorded with a placeholder. An
unattributable consent is not a weaker consent; it is not a consent. Both
`subjectSub` and `subjectUpn` come from the host-verified `AuthContext`, never
from the request body: an actor field filled in by the caller is not
attribution, it is a claim the caller made about itself.

## The disclosure round trip

The record has to be able to say *"these are the words the subject read"*
rather than *"the subject clicked a button next to something."* That takes a
round trip with a hash on it.

1. `GET /consents/disclosure?scope=…&locale=…` returns `{ disclosureId, scope,
   locale, text, sha256 }`. The `sha256` is the registry's own hash of its own
   bytes, computed at load and compared against the manifest there, so it can
   never be a hash of something other than the `text` in the same response.
2. The UI renders that text **verbatim** — whitespace preserved, no trimming,
   no interpolation.
3. The grant echoes back `disclosureSha256` — the hash of the bytes actually
   displayed.
4. The server compares it against the SHA of *its own* registry text. A
   mismatch is `409 disclosure_text_mismatch`.

```ts
const sha = disclosureSha256(disclosure.text);
if (input.presentedSha256 !== sha) {
  throw new ConsentError(
    'disclosure_text_mismatch',
    409,
    'The disclosure shown to the user does not match the current disclosure text.'
  );
}
```

The text stored on the record is **always the server's registry text**, never
anything the caller sent. The caller only gets to prove, via the hash, that
what it displayed was that text. A mismatch means the words on the screen were
not these words — a portal running a stale bundle, or a caller inventing a
consent — and the record would be a false statement about what the subject
read.

### Why the record stores the text, not an i18n key

An i18n key changes on any deploy and leaves the record pointing at words
nobody can reconstruct. *"The user agreed to `consent.map.body`"* is not a
record of what the user agreed to. The record stores the full text, its
SHA-256, and its locale, so what the person saw is what the record holds —
independent of every later edit to the codebase.

The registry keeps superseded wordings resolvable by id forever
(`getDisclosureById`), because the consent log is append-only and a record
written last year must still be readable. `superseded` is not "deleted" and
not "wrong": it is the exact text some person agreed to on some date.

### Fail closed at load, and no locale fallback

Every vendored disclosure file is hashed at import and compared to the
manifest, and every `(scope, locale)` pair must resolve to **exactly one**
current entry. Anything else throws at import — the process does not start.
A consent surface that is wrong is worse than one that is down.

There is no fallback locale. An unregistered locale answers `400
disclosure_not_found` rather than substituting English, because storing
English words on the record of a Spanish-speaking subject and asserting they
read them is a false record — worse than a refusal. The locale set is
`'en' | 'es-MX'`; a request that explicitly says `locale=es` is refused too,
for the same reason. (`defaultConsentLocale()` maps a coarser `UI_LOCALE`
environment value onto that set as a **server-side default** only.)

Hosts that own their own canonical consent tree build a registry over their
own pinned bytes with `createDisclosureRegistry(dir)` and hand it to the
consent store. Every semantic above — including the 409 — then applies to
those bytes.

## Scope enforcement: the consent bounds the walk

A consent record has always carried a target (which folder) and exclusions
(which subtrees are carved out). The failure this design was extracted from is
that **nothing enforced them**: a grant for `/Finance` with `/Finance/HR`
excluded authorized a map of the entire drive. The record said one thing and
the walk did another.

The algebra lives in one module (`workflows/consentScope.ts`) and is enforced
at both the workflow and the activity layer — one algebra, two enforcement
points, zero drift.

**The map root must BE the consented folder.**

```ts
export function mapRootWithinConsent(
  rootFolderId: string | null,
  target: ConsentScopeTarget | null | undefined
): boolean {
  if (!target || target.folderId === null) return true; // whole drive consented
  return rootFolderId !== null && rootFolderId === target.folderId;
}
```

Fail closed on **identity**, not on path strings. A root that is a strict
descendant of the target would also be safe, but proving descent takes
provider calls the consent check must not make — so it is refused, and the
person maps the folder they consented to. A refusal finalizes the run as
`refused_out_of_scope` and raises the typed failure
`MapOutsideConsentScope`, with the run document as evidence. The check runs
before the first provider call **on every execution**, including every
`continueAsNew` resume, so a consent revoked at minute 28 stops the map at the
next hop rather than at the end.

The folder-id pin is also what makes the *path* comparisons sound: all
consent-scope paths are compared in the walk's own path space, rooted at the
mapped folder, and the two spaces coincide only because the root must be the
consented folder.

**Excluded subtrees are pruned at the boundary — and reported.**

An excluded folder is never descended into. It is recorded in the prune
manifest under the rule id `consent_excluded`, its recursive size is added to
`reconciliation.prunedFolderBytes`, and a narration line names it. The
include-and-report discipline applies to the system's own restraint too: you
can see what the carve-out cost you, without anything inside it being walked.

One deliberate asymmetry, spelled out in the workflow: an excluded **file**
whose parent was not excluded is still counted in the aggregates, because its
metadata was unavoidably returned by a listing the consent authorized — but it
never reaches the candidate spool, so it can never be selected. The aggregates
describe what the walk *observed*; the spool describes what may be *selected*.

**An out-of-scope selection is a typed refusal, not a filter.**

```ts
throw ApplicationFailure.create({
  nonRetryable: true,
  type: SELECTION_OUT_OF_SCOPE_ERROR_TYPE,
  message: `selective ingest: resolved selection row ${outOfScope.path} is …`,
});
```

One out-of-scope row voids the **whole** resolution. Silently dropping the
offending rows would ingest a subset of the decision without saying so;
refusing names the conflict and sends the customer back to re-map or
re-consent. The check runs inside the resolution, so both the plan and every
subsequent batch re-verify it — a consent re-granted narrower mid-ingest stops
the next batch.

## An oversized exclusion list is refused, not truncated

```ts
export const MAX_EXCLUSIONS = 500;
const MAX_EXCLUSION_LENGTH = 1024;
```

Over the cap, the grant answers `400 consent_exclusions_invalid`. It does not
keep the first 500.

This is the one place where the house style of
[honest accounting](honest-accounting.md) — *state the cap, report the
truncation* — is not enough. Truncating an exclusion list fails **open**: the
501st carve-out silently becomes a subtree the map is allowed to walk, and the
resulting consent record would assert an exclusion set the person did not
choose. A flag saying "we dropped some of your exclusions" on a record that
authorizes a walk is not a repair. So the request is refused and the person
narrows the scope instead.

## Where each check sits

| Check | Where | On failure |
| --- | --- | --- |
| `connectorsEnabled` | grant route, map route | `403 connectors_disabled_for_tenant` |
| `mappingEnabled === true` | grant route (map scope), map route | `403 mapping_disabled_for_tenant` |
| Active grant for the scope | map route, ingest route | `403 map_consent_required` / `403 ingest_consent_required` |
| Active grant, again | workflow, every `continueAsNew` hop | run finalized `refused_no_consent` |
| Root within consented target | workflow, before the first provider call | `refused_out_of_scope` + `MapOutsideConsentScope` |
| Exclusions | walk, at each folder boundary | pruned and reported as `consent_excluded` |
| Selection within scope | ingest plan **and** every batch | `SelectionOutsideConsentScope` |

The edge refusal is the one the UI acts on — a typed 403 the consent screen
can route to, instead of a 202 followed by a run document that says
`refused_no_consent`. The worker-side checks are defense in depth, and they
are the ones that hold when the run outlives the request that started it.
