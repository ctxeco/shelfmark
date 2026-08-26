# Design history

shelfmark was extracted from a production multi-tenant AI platform, where it
shipped as the drive-connector subsystem. The code carries its reasoning in
comments, many of which cite plan keys (`JRN-8`, `34-S09c`, `25-1b`, …). This
document is where those keys resolve, and — more usefully — where the measured
results live, including the negative ones. Most projects delete their negative
results; they are the most transferable thing here.

## The thesis: two verbs, separately priced and separately consented

**Map** and **Ingest** are different acts:

| | Map | Ingest |
| --- | --- | --- |
| reads | names, paths, sizes, dates | full contents |
| cost | one listing call per 200 items | download + process per file |
| consent | its own explicit record | its own, separate record |
| reversibility | delete the map | contents entered your pipeline |

A map of thousands of files costs a few dozen listing calls; ingesting them
costs a download and pipeline pass *per file*. Collapsing the two verbs into
one "connect your drive" button is how systems end up copying everything and
consenting to nothing. The whole design follows from keeping them apart: a
map-first flow, a human selection over the map, ingest of exactly the
selection — each verb behind its own disclosure whose bytes are SHA-echoed
into the consent record.

**Metadata is not low-sensitivity.** A path like
`/HR/terminations/2026/march/` reveals more per byte than most documents. The
map disclosure says what mapping reads, in those terms; nothing in the system
sells metadata access as "safe because it's only metadata."

## Include-and-report, never holdback (JRN-D1)

When the funnel detects sensitive-looking files (credential shapes, tax
documents, id scans), it **reports** them and never silently subtracts them —
"a system you cannot put your tax returns into is a worse drive search."
Live-credential shapes get rotate-don't-exclude advice. The funnel schema
enforces this structurally: every sensitive shape carries `report: true,
subtract: "NEVER"`, and the loader **refuses to load** a policy containing a
holdback spelling. An earlier design-note table that said `never suggest` /
`ask first` was retired; building from it would ship the reversed design.

## Classification precedence is the design (Plan 26)

`folder-prune > exact-name > extension > escape` — in that order, as data in
a versioned artifact, not constants in a scanner. Extension-first would
classify half of a dependency tree as source code. Ranking produces **an
ordering, never a verdict**; the cut is the human's budget decision.

## The measured negative results

These were found by controls and distributions, never by code review:

- **The headline estimate was wrong by 32.4 points.** The first
  machine-generated-share estimate retired 98.01% of a corpus; the controlled
  re-measure said 65.6%. The gate that caught it was an acceptance control,
  not a reviewer.
- **The escape hatch was a missing class.** 21.4% of corpus bytes sat in 29
  unknown extensions — a whole category the vocabulary lacked, found because
  escape-hatch volume was measured instead of ignored.
- **The ranking was alphabetical order wearing a score.** 128 items tied at
  the top; the "score" added nothing. Found by looking at the score
  distribution, not the scores.
- **Random weights reproduce 77% of the ranking** (declared weights: 81%).
  Whatever signal the coefficients carry is nearly indistinguishable from
  noise — hence the no-weight-tuning rule in CONTRIBUTING.
- **A harness once measured itself.** A self-check reported 1.00 agreement
  because it compared the measurement to itself; corrected, the number was
  0.17. Controls have to be controls.
- **The zero-items run where the policy was right.** The first live map
  returned zero items because the walk borrowed the ingest path's egress
  gate, which asks "what is this *document's* label?" — and a map opens no
  documents, so the answer was null and the gate failed closed *exactly as
  written*. The caller was asking the wrong question. That event is why the
  `EgressGate` port has two different questions (`checkMapEgress` takes no
  document label) and why the map must never be asked for one.
- **A wrong diagnosis, wrong in every part.** Large-document failures were
  attributed to a parser file-size limit. Falsification testing showed the
  parser was fine: a JSON body cap in a downstream gateway limited one
  *request*, and an unbatched vector insert put every chunk in that request —
  the real ceiling was ~100 KiB of parsed text, ~250× smaller than the
  enforced file limit, and stated nowhere. The fix was batching the insert.
  Two lessons survived into this code: caps must be stated where they bind,
  and "file size" is usually a proxy for the thing that actually overflows.

## The consent-scope hole (JRN-8) — fixed here

In the source system, consent records carried a target scope and exclusions —
and nothing enforced them. A consent for `/Finance` with `/Finance/HR`
excluded authorized a map of the entire drive. shelfmark fixes this in v1:
the walk refuses a root outside the consented target, prunes excluded
subtrees at the folder boundary, and **reports** each consent-prune in the
ledger (include-and-report applies to the system's own restraint too); a
selection outside scope is a typed refusal.

## Identifier glossary

| Key | What it names |
| --- | --- |
| `Plan 25` | the map/ingest two-verb design and the consent record |
| `25-1b` | pagination-honesty work item in the browse clients |
| `Plan 26` | the classification/funnel/selection pipeline and its controls |
| `Plan 34` / `34-S*` | the end-to-end onboarding journey; S-numbers are its steps (S08 consent enforcement, S09 the map narration stream, S13 selection/clearance, S14 ingest honesty) |
| `JRN-<n>` | numbered findings from the journey's live pilot (JRN-1 audience mismatch → resolved in SETUP; JRN-8 consent scope → fixed in v1; JRN-10 the wrong-diagnosis story above) |
| `JRN-D<n>` | journey design decisions (D1 include-and-report; D2 derived edges render client-side, never written) |
| `TGK-D4` | a source-platform rule that services never touch the graph store directly — survives here only in comments explaining module boundaries |

Where a comment cites a key not listed here, it names a source-platform work
item whose substance is already restated in the comment itself; the key is
kept as provenance.
