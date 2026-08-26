---
title: Home
nav_order: 1
---

# shelfmark

**Map a drive before you copy it. Ingest only what was chosen.**
{: .fs-6 .fw-300 }

[Get started](getting-started){: .btn .btn-primary .mr-2 }
[View on GitHub](https://github.com/ctxeco/shelfmark){: .btn }

---

shelfmark connects to OneDrive and SharePoint, walks the drive
**metadata-only** — names, paths, sizes, dates; no file is opened —
classifies every item with a rules-as-data policy engine, shows a person an
honest ledger of what is there (including what was pruned and why), and then
ingests **exactly the files they selected**, handing the bytes to a
`DocumentSink` you implement.

Map and ingest are **separately consented**, with SHA-pinned disclosure text
stored verbatim in every consent record.

{: .warning }
> **Project status: best-effort.** Extracted from a production system and
> maintained as time allows. Issues and PRs welcome; no support SLA.

## Why it is shaped this way

A map of ten thousand files costs a few dozen listing calls. Ingesting them
costs a download and a pipeline pass *per file*. Collapsing those two acts
into one "connect your drive" button is how systems end up copying everything
and consenting to nothing.

Keeping them apart is the whole design: map first, let a human select over the
map, ingest exactly the selection — each act behind its own disclosure whose
bytes are hashed into the consent record.

## Where to go

| If you want to… | Start at |
| --- | --- |
| Run it against your own drive | [Getting started](getting-started) |
| Understand the design | [Concepts](concepts) |
| Wire it into your own project | [Guides](guides) — especially [implementing a DocumentSink](guides/document-sink) |
| Look up a route, error, or type | [Reference](reference) |
| Know what it does *not* claim | [Known limitations](project/known-limitations) |

## What this claims, and what it does not

Claims are calibrated deliberately. The uncomfortable ones are stated rather
than left to be discovered.

**True, and tested:**

- Mapping opens **zero** documents; it reads listings only.
- The map's narration is deterministic arithmetic — **no model calls exist in
  this codebase**; an egress-inventory test pins the complete set of network
  destinations.
- Every count is exact and every cap states itself: pruned subtrees are
  itemized with the rule that pruned them; truncation is always a flag plus a
  number.
- The walk enforces the consent's scope and exclusions.
- Sensitive-looking files are **reported, never silently excluded** — the
  policy loader structurally refuses a holdback rule.
- Read-only: no write scope is requested and no write call exists.

**Not claimed** — see [Known limitations](project/known-limitations): that the
ranking's weights carry proven signal (random weights reproduce 77% of the
top-100 against the declared weights' 81%); a measured classifier error rate;
that provider timestamps mean authorship; streaming ingest; that any
measurement generalizes beyond the one corpus it was made on.

## License

Apache-2.0 — any organization, any purpose. Copyright holder in
[NOTICE](https://github.com/ctxeco/shelfmark/blob/main/NOTICE).
