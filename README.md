# shelfmark

**Map a drive before you copy it. Ingest only what was chosen.**

shelfmark connects to OneDrive / SharePoint, walks the drive **metadata-only**
(names, paths, sizes, dates — no file is opened), classifies every item with a
rules-as-data policy engine, shows the human an honest ledger of what's there
— including what was pruned and why — and then ingests **exactly the files
they selected**, delivering the bytes to a pluggable `DocumentSink` you
implement. Map and ingest are separately consented, with SHA-pinned disclosure
text stored verbatim in every consent record.

> **Project status: best-effort.** Extracted from a production system and
> maintained as time allows. Issues and PRs welcome; no support SLA. The
> [design history](docs/DESIGN-HISTORY.md) — including the measured negative
> results — is the most transferable thing in the repo.

## Packages

| Package | What it is |
| --- | --- |
| `@shelfmark/policy` | zero-dependency rules engine: artifact classifier, selection funnel, ingest filters — rules as versioned, SHA-pinned data |
| `@shelfmark/graph` | throttle-correct Microsoft Graph drive client: PKCE OAuth, personal + SharePoint drive resolution, delta queries, honest pagination (`truncated` is a flag, never a silence), Retry-After carried on every path |
| `@shelfmark/core` | domain types, the five ports, consent engine (append-only ledger, disclosure SHA round trip), cost estimate, token crypto, Mongo store |
| `@shelfmark/workflows` | Temporal workflows: consent-scoped map walk, selective ingest, delta sync — continueAsNew checkpointing, typed refusals, throttle-honoring retries |
| `@shelfmark/api` | Fastify plugin: 17 routes incl. the SSE map-narration stream |
| `@shelfmark/ui` | React components: Connections, DriveMap (consent → live narration → landing analysis → selection ledger → second consent), IngestStatus — en + es-MX |
| `demo/` | runnable end-to-end: OAuth → map → select → ingest into a local searchable corpus |

The host plugs in at five seams (`packages/core/src/ports.ts`):
`DocumentSink` (what happens to bytes — **the** boundary), `AuthContextResolver`,
`TenantPolicy`, `LabelPolicy`, `EgressGate`. The demo's `FsDocumentSink` builds
a searchable local text corpus; a RAG pipeline is just another sink.

## Quickstart

```bash
git clone https://github.com/ctxeco/shelfmark && cd shelfmark
pnpm install && pnpm build && pnpm test
# then: docs/SETUP.md — Entra app registration (~30 min) — and demo/
```

## What this claims, and what it doesn't

Claims are calibrated deliberately; the uncomfortable ones are stated rather
than discovered.

**True, and tested:**
- Mapping opens **zero** documents; it reads listings only.
- The map's narration is deterministic arithmetic — **no model calls exist in
  this codebase**; an egress-inventory test pins the complete set of network
  destinations (Microsoft endpoints, your store, your sink, your gate).
- Every count is exact and every cap states itself: pruned subtrees are
  itemized with the rule that pruned them, truncation is always a flag plus a
  number, a selection ledger that can't show everything says so and disables
  Continue.
- Map and ingest are **separately consented**; the walk enforces the consent's
  scope and exclusions (refusing an out-of-scope root, pruning-and-reporting
  excluded subtrees).
- Sensitive-looking files are **reported, never silently excluded** — and the
  policy loader structurally refuses a holdback rule.
- Read-only: no write scope is requested and no write call exists.

**Not claimed** (details in [KNOWN-LIMITATIONS](docs/KNOWN-LIMITATIONS.md)):
the ranking's weights carry proven signal (they don't — random weights
reproduce 77% of the top-100 vs the declared 81%); a measured classifier error
rate; provider timestamps meaning authorship; streaming ingest; that any of
the measurements generalize beyond the one corpus they were made on.

## Docs

[SETUP](docs/SETUP.md) · [KNOWN-LIMITATIONS](docs/KNOWN-LIMITATIONS.md) ·
[DESIGN-HISTORY](docs/DESIGN-HISTORY.md) ·
[CONSENT-GOVERNANCE](docs/CONSENT-GOVERNANCE.md) · [I18N](docs/I18N.md) ·
[CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md)

## License

Apache-2.0. Extracted from the ctxeco platform and relicensed for any
organization, any purpose. Copyright holder in [NOTICE](NOTICE).
