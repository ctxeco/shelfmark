---
title: Two verbs
parent: Concepts
nav_order: 1
---

# Two verbs

**Map** and **ingest** are two different acts. shelfmark keeps them apart at
every layer: two consent scopes, two tenant switches, two egress questions,
two workflows, two run documents. Everything else in the design is downstream
of that separation.

The [design history](../project/design-history.md) states the thesis. This
page states the mechanics: what each verb costs, what each verb touches, and
where the boundary between them is enforced.

## The cost asymmetry is real, and it is large

A map's unit of work is a **listing page**. The walk asks Microsoft Graph for
one folder's children at a time:

```
GET /drives/{driveId}/items/{folderId}/children
    ?$select=id,name,folder,size,lastModifiedDateTime&$top=200
```

That is one HTTP call per **200 items**, and the `$select` is deliberately
wide enough to end the walk's questions in that same call — the folder facet
carries `childCount` (so empty folders are counted without listing them), and
`size` on a folder is Graph's **recursive subtree size**, which is what makes
a pruned subtree's bytes accountable without ever walking it. Nothing on this
path opens a file.

An ingest's unit of work is a **file**. Each selected file is downloaded whole
into a `Buffer` and handed to your `DocumentSink`, at a bounded fan-out of
`INGEST_CONCURRENCY = 15` per batch activity, under a size ceiling that
defaults to 25 MiB. The download is per file; whatever your sink does —
parsing, embedding, indexing — is also per file.

So a drive of ten thousand items is a few dozen listing calls to map, and ten
thousand downloads plus ten thousand pipeline passes to ingest. Those two
numbers do not belong behind one button.

## Metadata is not the low-sensitivity half

The cost asymmetry is not a sensitivity asymmetry, and shelfmark never trades
on the confusion between them. A path is written by a person to be meaningful
to people, which makes it almost pure signal with no filler:

```
/Legal/Litigation/<matter>/Settlement Draft.docx
```

Nobody opened that file. You already know there is a dispute, who it is with,
which side is being advised, and that a settlement is being drafted. A folder
named `Oncology` works the same way.

The shipped map disclosure says exactly this, in a section headed *"This is
not a privacy feature"* — it is the one claim in the consent copy that argues
**against** the product's convenience. The honest form of the claim is not
"this is safe because it is only metadata"; it is "we read less, and we tell
you precisely what we read."

{: .note }
> The shipped disclosure text describes a **wider** metadata set than this
> walk currently requests — it also names owners, last-modifiers and the
> sharing/permission structure around an item. The Graph client in this repo
> maps exactly five fields (`id`, `name`, the folder facet, `size`,
> `lastModifiedDateTime`) and reads no permission or ownership data on any
> path. Treat the disclosure as the ceiling on what may be read under that
> consent, and the `$select` above as what is read today. If you narrow or
> widen either, they are versioned artifacts and the procedure is in
> [consent governance](../project/consent-governance.md).

Two consequences you can see in the code:

- Mapping is **default-OFF** at the tenant level. `TenantFlags.mappingEnabled`
  is checked with a strict `=== true`, so absent means off, while
  `connectorsEnabled` is a default-on posture. A map sends names and counts
  outward, so it must be consented **and** enabled.
- The mapping switch is re-checked at map time even though the consent-grant
  route already required it. The gap between grant time and map time is the
  case that matters: an admin who turns mapping off after a consent was
  granted has withdrawn the tenant-level precondition, and a standing consent
  must not outrank it. Consent is necessary, never sufficient.

## Map → human selection → ingest exactly the selection

The order is the point. Each arrow is a place a person can stop.

1. **Map.** The walk enumerates metadata, prunes machine-generated and
   consent-excluded subtrees at the folder boundary, classifies every item
   through the pinned rule artifact, and writes one `map_runs` document plus
   one `map_suggestions` ledger. See [classification](classification.md).
2. **Look.** The run document is returned verbatim — the counts, the
   reconciliation arithmetic, the itemized prune manifest with the rule that
   pruned each subtree, and every truncation flag. See
   [honest accounting](honest-accounting.md).
3. **Decide.** The funnel proposes a **default selection**; the person
   subtracts from it (one click) and adds back to it (one deliberate act). The
   decision is stored as `removedPaths` / `readdedPaths` against a named map
   run — a diff from a named proposal, not an opaque list.
4. **Consent again.** A separate `ingest_content` disclosure, separately
   hashed into a separate consent record.
5. **Ingest.** The selection is resolved against the ledger rows and ingested
   — exactly that set, re-verified against the consent's scope on every batch.

A `map_metadata` grant does **not** satisfy `ingest_content`. The scope string
is the whole difference, and both the API edge and the workflow derive
liveness from the same append-only event stream. See
[the consent model](consent-model.md).

{: .note }
> `POST /:id/map` takes no label field, deliberately. Ingestion mints
> documents and so needs a sensitivity label; the map mints none — it reads
> names, sizes and counts. Which label the eventual corpus lands under is a
> decision made *after* the person has seen the map. A label accepted at map
> time would be recorded before the information it governs exists.

## What each verb touches

| | Map | Ingest |
| --- | --- | --- |
| Graph calls | `children` listings only (`$top=200`) | `children` listings, then a content download per selected file |
| Bytes read | zero file bytes | every selected file, whole, into memory |
| Consent scope | `map_metadata` | `ingest_content` |
| Tenant switch | `connectorsEnabled` **and** `mappingEnabled` (opt-in) | `connectorsEnabled` |
| Egress question | `checkMapEgress({ tenantId })` | `checkCloudEgress({ tenantId, label })` |
| Label | none asserted | resolved through `LabelPolicy` before the sink sees it |
| Writes | `map_runs`, a candidate spool, one `map_suggestions` doc | `selective_ingest_runs`, plus whatever your sink writes |
| Crosses `DocumentSink` | never | every accepted file |
| Reversal | delete the map | the contents entered your pipeline |

The two egress questions are genuinely different questions, not one question
with a nullable argument — the reason is in [the ports](the-ports.md#egressgate)
and the incident that produced it is in the
[design history](../project/design-history.md).

## Why this is worth the extra screen

Collapsing the verbs is not merely impolite; it removes the only cheap moment
where a person can see the shape of what they are about to copy. The map costs
a few dozen calls and produces an exact, itemized account of a drive —
including what was *not* walked and why. Spending that before spending
thousands of downloads is the whole argument, and it is why the selection step
sits between two consents rather than after one.
