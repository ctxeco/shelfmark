---
title: Errors
parent: Reference
nav_order: 2
---

# Errors

Every failure the HTTP surface can answer with, and every typed refusal the
workflows can raise. Grouped by family; each row says what actually happened
and what the caller should do about it.

Error bodies are `{"error": "<code>"}`, sometimes with extra fields (noted
below). Two families of message are **sentences, not codes** — they are called
out where they occur, because matching on them is a mistake:

- `{"error":"No connection conn-…"}` — the connection 404, interpolating the
  id.
- `{"error":"Unable to start … workflow — durable start failed"}` — the 503
  from a failed durable start.

Everything else in this page is a stable token.

## Authentication

| Code | HTTP | What happened | What to do |
| --- | --- | --- | --- |
| `unauthenticated` | 401 | The host's `AuthContextResolver` returned `null`. | Authenticate. Every route except `GET /microsoft/callback` answers this. |
| `missing_code_or_state` | 400 | The OAuth callback arrived without `code` or `state`. | Restart the flow at `POST /microsoft/authorize`. |
| `invalid_or_expired_state` | 400 | The state JWT failed HS256 verification, or its 10-minute expiry passed. | Restart the flow. Nothing was exchanged and nothing was written. |
| `connector_not_configured` | 503 | `CONNECTOR_MS_CLIENT_ID` / `CONNECTOR_MS_CLIENT_SECRET` are not both set on the API process. | Operator fix; see [Entra setup](../getting-started/entra-setup.md). |

`consent_subject_required` (403) belongs to this family in spirit — see
[Consent](#consent).

## Tenant and feature switches

Both switches are read through the host's `TenantPolicy.flags()`.

| Code | HTTP | What happened | What to do |
| --- | --- | --- | --- |
| `connectors_disabled_for_tenant` | 403 | `flags().connectorsEnabled` is false. | The tenant has opted out of the connector surface. An admin flips it back on. |
| `mapping_disabled_for_tenant` | 403 | `flags().mappingEnabled` is not strictly `true`. | Mapping is opt-in and absent means off. An admin enables it before a map can be consented to or run. |

Where each one is enforced:

| Route | `connectorsEnabled` | `mappingEnabled` |
| --- | --- | --- |
| `POST /microsoft/authorize` | yes | — |
| `GET /:id/browse` | yes | — |
| `POST /:id/sync` | yes | — |
| `POST /:id/map` | yes | yes (`=== true`) |
| `POST /:id/ingest` | yes | — |
| `POST /:id/consents` | yes | yes, for `scope: "map_metadata"` |
| `POST /:id/consents/:consentId/revoke` | **no** | **no** |
| `DELETE /:id` | **no** | **no** |

The two exemptions are deliberate. A tenant whose connectors were switched off
after a grant must still be able to **withdraw** it and to disconnect; a gate
that blocks withdrawal turns an operational switch into a trap.

The mapping switch is checked at **both** grant time and map time. The grant
check ran when the consent was recorded; the map check runs when the walk
starts, and the gap between them is the case that matters — an admin who
switched mapping off after a grant has withdrawn the tenant-level
precondition, and a standing consent must not outrank it. Consent is
necessary, never sufficient.

{: .warning }
> A host that cannot resolve a tenant **must** answer
> `{ connectorsEnabled: false, mappingEnabled: false }` — fail closed. The
> shipped `DEFAULT_TENANT_POLICY` (used when no `tenantPolicy` port is
> supplied) answers everything-enabled, which is the honest default for a
> single-tenant demo and exactly the posture a multi-tenant host must replace.

## Consent

| Code | HTTP | What happened | What to do |
| --- | --- | --- | --- |
| `consent_scope_invalid` | 400 | `scope` is not `map_metadata` or `ingest_content`. | Send one of the two. |
| `disclosure_not_found` | 400 | The locale is not `en`/`es-MX`, or the registry has no current disclosure for that (scope, locale). | Ask for a locale that has reviewed text. There is **no fallback** — English words on a Spanish speaker's record would be a false record. |
| `disclosure_text_mismatch` | 409 | The `disclosureSha256` the client echoed back does not match the SHA of the registry text this server would show. | The portal is running stale disclosure bytes. Re-fetch `GET /consents/disclosure`, re-display, re-submit. |
| `consent_subject_required` | 403 | The verified auth context carries no `sub`. | An unattributable consent is not a weaker consent — it is not a consent. Fix the token so it carries a subject claim. |
| `consent_exclusions_invalid` | 400 | `exclusions` is not an array, holds more than 500 entries, or holds a blank / non-string / over-1024-character entry. | Send at most 500 non-empty strings. |
| `consent_not_found` | 404 | No **granted** consent with that `consentId` on this connection (tenant-scoped). | Check the id against `GET /:id/consents`. |
| `consent_already_revoked` | 409 | A revocation event already names that `consentId`. | Nothing to do — the grant is already withdrawn. This is a caller-facing guard, not a correctness invariant; the log is append-only either way. |
| `consent_not_recorded` | 503 | The consent write was not acknowledged, or the store threw. | **Retry.** The operation the consent would have authorised did **not** start. |
| `map_consent_required` | 403 | No active `map_metadata` grant for this connection at `POST /:id/map`. | Grant it. "Active" is derived from the event stream: a grant with a later revocation naming it is not active. |
| `ingest_consent_required` | 403 | No active `ingest_content` grant at `POST /:id/ingest`. | Grant it. A `map_metadata` grant does **not** satisfy this. |

The 503 is the load-bearing one. A consent record that did not persist means
nobody can later show what the human agreed to, so the write is
`w:'majority', j:true`, every error propagates to the caller, and the route
refuses the operation rather than logging a warning and succeeding. That is the
difference between an audit log and evidence.

## Browse and provider

Every one of these used to be a single `502 browse_failed`, which is the same
sentence for "slow down", "you never granted us that permission" and "that
folder is gone".

| Code | HTTP | What happened | What to do |
| --- | --- | --- | --- |
| `sharepoint_site_required` | 400 | A SharePoint connection has no resolved `driveId` yet and the request omitted `sharepointHostname` or `sharepointSitePath`. | Send both. The admin pastes them from their SharePoint URL. |
| `connection_disconnected` | 409 | `encRefreshToken` is null — `DELETE /:id` nulled it. | Reconnect. Without this branch the null lands in the decrypt as a crash and reads as "the provider is broken". |
| `browse_throttled` | 429 | Graph answered 429. Body carries `retryAfterSeconds` (may be null). | Back off — see [the throttle contract](#the-throttle-contract). |
| `browse_scope_missing` | 403 | The access token's **own granted scopes** verifiably lack `Files.Read.All` / `Sites.Read.All`. | Reconnect to re-consent. Graph answers **404** for this, which is why it needs its own code. |
| `browse_folder_not_found` | 404 | A genuine Graph 404. Distinguishable from the connection 404 by the `error` value being a token rather than a sentence. | The folder is gone; refresh the picker. |
| `browse_failed` | 502 | Anything else off the provider. | Retry; check server logs, which record status and the provider's own error code. |

`browse_scope_missing` is only claimed when the caller supplied the token's
granted-scope list **and** the required scope is genuinely absent, on a status
Graph uses ambiguously (401, 403, 404). With no scope list the client says
nothing rather than guessing: a false negative is a missing hint, whereas a
false positive would send someone to re-consent a connection that was fine.

Browse never retries in-handler. A request-scoped handler cannot outlive the
wait it would be sleeping through; retry policy lives with the workflow that
can actually be resumed.

## Selection and the Decide flow

| Code | HTTP | What happened | What to do |
| --- | --- | --- | --- |
| `no_map_run` | 404 | No `map_runs` document for `map-<connectionId>` in this tenant. | Start a map. Also emitted as an SSE `error` frame when a stream waits out its no-run timeout. |
| `no_suggestions` | 404 | No `map_suggestions` document for the run. | The map has not completed (suggestions are written on `complete`), or it was refused. |
| `invalid_cursor` | 400 | The `cursor` was not minted by this server, or is outside the current ledger — a re-mapped run can shrink `rows`. | Restart the listing from page 1. Never an empty page pretending to be the end. |
| `selection_paths_invalid` | 400 | `removedPaths`/`readdedPaths` is not an array of non-empty strings. Body carries `field`. | Send an array of strings, or omit the field (absent means none, so `{}` is a valid keep-everything decision). |
| `selection_path_unknown` | 400 | A path is not among the suggestions ledger's rows. Body carries `field` and `path`. | Use `path` values from the ledger verbatim. A typo fails loudly here instead of silently later. |
| `suggestion_rows_truncated` | 409 | The ledger hit the workers' 20,000-row write cap, so membership cannot be validated honestly. | Nothing the caller can do — enterprise-scale ledger resolution is future work, on record. The workflow refuses the same case by name. |
| `no_selection` | 404 | `GET /:id/map/selection` — nothing decided yet. | Record a decision with `PUT /:id/map/selection`. |
| `no_selection` | 409 | `POST /:id/ingest` — nothing decided yet. **409, not 404**: the connection exists; it is the flow that is mid-state. | Record a decision first. A missing decision is never an implicit ingest-everything. |
| `label_refused` | 403 | The host's `LabelPolicy.resolve` threw `LabelRefusedError`. Body carries `requested` (the value asked for, or null). | Ask for a label the policy allows. A policy may **cap** a label silently; only an outright refusal reaches here. |

## Run lifecycle

`POST /:id/sync`, `POST /:id/map` and `POST /:id/ingest` answer **202** with
`{status, connectionId, workflowId}`. Starting is idempotent: the workflow id
is pinned to the connection, so a double-clicked button is a duplicate-start
rejection that the starter treats as success and returns the same `workflowId`
for — not a second concurrent walk of the same remote drive.

If the durable start itself fails, the route answers **503** with a sentence:

```json
{"error":"Unable to start map workflow — durable start failed"}
```

(and the corresponding sentences for sync and ingest). The failure is logged
server-side with the connection id and the underlying message. Retry.

Refusals that happen **inside** a run are not HTTP errors at all. They land as
a run-document `status` that the read and stream routes return:

| `map_runs.status` | Meaning |
| --- | --- |
| `mapping` | in flight |
| `complete` | finished |
| `failed` | the workflow failed |
| `refused_no_consent` | no active `map_metadata` grant at workflow time; **no provider call was made** |
| `refused_out_of_scope` | the mapped root is not the consented folder; no provider call was made |
| `unsupported_provider` | the connection's provider is not OneDrive/SharePoint |

`selective_ingest_runs.status` uses `ingesting | complete | failed |
refused_no_consent | unsupported_provider`.

Every finalize **upserts**, so the refusal paths leave a run document as
evidence even though the start activity never ran for them. Whatever happens, a
run leaves its in-flight status.

## The throttle contract

When Graph answers 429:

- `GET /:id/browse` answers **429 `browse_throttled`**. The body always carries
  `retryAfterSeconds`; the **`Retry-After` response header is set only when
  that value is non-null.**
- Inside the workflows, a Graph 429 becomes a **retryable**
  `GraphThrottled` `ApplicationFailure` whose `nextRetryDelay` is the
  `Retry-After` value — so Temporal waits what Graph asked rather than applying
  its own backoff. When there is no value, `nextRetryDelay` is left unset and
  the retry policy's own backoff applies.

How `Retry-After` is parsed (RFC 9110: delta-seconds **or** an HTTP-date):

| Header | `retryAfterSeconds` |
| --- | --- |
| absent | `null` |
| blank / whitespace only | `null` |
| unparseable (not digits, not a date) | `null` |
| `120` | `120` |
| an HTTP-date in the future | whole seconds from now, rounded up |
| an HTTP-date already in the past | `0` (clamped — a negative wait is not something a caller can act on) |

{: .important }
> **A blank or unparseable `Retry-After` is `null`, never `0`.** Zero reads as
> "retry now" at the exact moment the provider asked for patience, and that
> distinction is the whole reason the value is nullable rather than defaulted.
> A literal `Retry-After: 0`, or a date already past, is a genuine 0 — that is
> the provider actually saying "now".

The token endpoint throttles too, and `@shelfmark/graph` preserves status and
`Retry-After` on **every** HTTP path — listing, delta, download, and token
requests alike. Downloads are the highest-volume call a sync makes and the one
place Graph is most likely to throttle.

## Typed workflow failures

These are `ApplicationFailure`s raised in `@shelfmark/workflows`. They appear
in Temporal history and in the run document's terminal state; a host's start
helper can catch them by `type`.

| `type` | Retryable | What happened |
| --- | --- | --- |
| `GraphThrottled` | **yes** | Graph answered 429 during the map walk. `nextRetryDelay` = `Retry-After` when Graph named one. |
| `EgressGateUnreachable` | **yes** | A **configured** `EgressGate` threw (unreachable, timeout). The run pauses and retries; it never proceeds as if allowed. A missing gate is a decision; a broken gate is an outage. |
| `CloudEgressDenied` | no | `EgressGate.checkCloudEgress` answered no for this tenant at this label. A denial is an answer, and retrying an answer only burns attempts. |
| `MapEgressDenied` | no | `EgressGate.checkMapEgress` answered no for this tenant. |
| `TenantScopeViolation` | no | A workflow input's `tenantId` does not own the named connection. Tenant isolation is absolute — refused terminally, never retried into. |
| `ConsentExclusionsOversized` | no | The consent record carries more than 500 exclusions, which the write path refuses — so it can only have arrived by a hand-written store document. Truncating would silently walk and ingest an excluded subtree, so the map refuses until the record is repaired. |
| `MapOutsideConsentScope` | no | The mapped root is not the consented target folder. Checked before the first provider call, on **every** execution including each `continueAsNew` hop. Fail closed on folder **identity**, not on path strings. |
| `ArtifactClassesChangedMidRun` | no | The classifier artifact's SHA changed between pages of one map. A map classified under two rule sets is void. |
| `NoActiveIngestConsent` | no | No active `ingest_content` grant **at resolution time** — re-read on the plan and on every batch, so a consent revoked mid-ingest stops the very next resolution. |
| `NoSelectionOnRecord` | no | No `map_selections` decision exists. This workflow ingests only decided selections; it never guesses. |
| `MapSuggestionsMissing` | no | The selection names a run with no `map_suggestions` document — the selection cannot be resolved against a ledger that is not there. |
| `SuggestionRowsTruncated` | no | The ledger hit its named row cap. Resolving a selection against a partial ledger would silently ingest a subset. Message carries the kept/omitted counts. |
| `SelectionChangedMidRun` | no | The decided selection moved (different run id, or a newer `decidedAt`) while an ingest was in flight. An ingest spanning two decisions is void; start a fresh one. |
| `SelectionOutsideConsentScope` | no | A resolved selection row sits outside the consented target or inside a recorded exclusion. **One** out-of-scope row voids the whole resolution — refusing entirely rather than silently ingesting a subset. |

Two of these have edge-side twins that fire first and carry a typed HTTP code
instead: `map_consent_required` / `ingest_consent_required` at the routes, and
`suggestion_rows_truncated` at `PUT /:id/map/selection`. The worker-side checks
are defence in depth — they re-verify on every `continueAsNew` hop, which the
edge check cannot do.

## Per-file outcomes are not errors

A file that fails, is skipped, or is deferred does **not** fail its run. The
four-state outcome vocabulary is recorded per file in the run document:

| Status | Meaning |
| --- | --- |
| `ingested` | the sink accepted it |
| `failed` | the download or the sink failed; the named reason travels with it |
| `skipped` | the connector deliberately never opened it — reason from the closed vocabulary |
| `deferred` | the sink declined **for now** (quota, budget, backpressure) and owns resuming it |

`deferred` is counted apart from `failed` because nothing is wrong with those
files, and apart from `skipped` because it is not a decision this library took.
The closed skip vocabulary is `already_ingested`, `deferred`, `too_large`,
`unsupported_type`, `unsupported_google_format`; it is closed on purpose,
because `skippedByReason` is a rollup on a polled document and a rollup keyed
on an open string set is an unbounded map. A reason outside the vocabulary
rolls up as `unnamed` rather than growing the map.
