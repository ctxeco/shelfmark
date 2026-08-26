---
title: Honest accounting
parent: Concepts
nav_order: 5
---

# Honest accounting

This is the house style, and it is the most portable idea in the repository.
It is not a tone; it is a set of rules with mechanical consequences, and most
of them were learned by shipping the opposite first.

**The premise:** an unstated cap reads as *"covered"* when it isn't. A list
that stops at 2,000 entries and says nothing is indistinguishable, to a
reader, from a complete list — and unlike a crash, nobody goes looking for it.
Silent truncation is the one defect class that is invisible in the output, in
the logs, and in the diff.

## The five rules

1. **Every cap states itself.** A bound that can bite must be a named constant
   with a stated derivation, and it must appear in the output when it bites.
2. **Truncation is a flag plus a number, never a silence.** `truncated: true`
   is half an answer; `truncated: true` beside `omitted: 417` is the answer.
3. **Unknown vocabulary renders verbatim as data.** An id this build does not
   recognize is quoted on screen, not dropped and not replaced by a shrug.
4. **A listing that could not complete says so rather than looking empty.**
   Empty and incomplete are different states and must never share a rendering.
5. **Reconciliation arithmetic is shown, not asserted.** If the numbers are
   supposed to add up, print the addition — and refuse to emit a result that
   does not.

## Rule 1 & 2 in the code

### Pagination: `null` if and only if complete

The browse client's cursor carries a stated invariant:

```ts
export interface DriveItemPage {
  items: DriveItem[];
  /** Opaque continuation token, or null. **null if and only if the listing is
   *  complete** — a null cursor over an incomplete listing is the silent
   *  truncation this exists to kill. */
  nextCursor: string | null;
}
```

Before that cursor existed, this function read exactly one page and dropped
the provider's continuation link on the floor — so a folder past ~200 children
was silently under-reported. A product pitched as *"we show you your real
drive"* was quietly lying about what is in it.

The invariant is defended even in the ugly case. If the provider says the
listing is incomplete but the continuation link cannot be reduced to an opaque
token, the client **throws**:

> Graph returned a continuation link with no recognisable paging token —
> refusing to report a partial listing as complete

Answering `nextCursor: null` there would reintroduce the same lie as a parse
failure. Passing the raw provider URL through to a browser is not an option
either — it can carry credentials in its query string. So it fails loudly,
which is recoverable, rather than under-reporting a drive, which is not
detectable.

One layer up, `listAllChildren` follows pages for you up to
`LIST_ALL_CHILDREN_CEILING = 2000` children and then **says so**:

```ts
export interface DriveChildrenListing {
  items: DriveItem[];
  nextCursor: string | null;
  /** true if and only if the ceiling — not the end of the folder — stopped the listing. */
  truncated: boolean;
}
```

Note the precision of that comment: landing *exactly* on the ceiling with the
provider reporting no more pages is a **complete** listing, not a truncated
one. `truncated` means one specific thing.

### The map's four bounds

The map workflow carries a comment block over its constants —
*"Every one of these is RECORDED when it bites"* — and each one has a paired
flag and counter:

| Bound | Value | When it bites |
| --- | --- | --- |
| `MAX_TOP_FOLDER_ROLLUPS` | 40 | `rollupTruncated: true`, `topFoldersOmitted` counts every dropped attribution |
| `MAX_PRUNE_MANIFEST_ENTRIES` | 2000 | `pruneManifestTruncated: true`, `pruneManifestOmitted` counts the rest |
| `NARRATION_MAX_LINES` | 300 | `narrationDropped` counts what overflowed |
| `DEFAULT_MAP_PAGES_PER_RUN` | 200 | not a truncation — the `continueAsNew` checkpoint |

Crucially, each bound truncates an **itemization**, never a **total**. The
per-top-folder table stops at 40 folders, but every item still counts in
`aggregates` and `perClass`. The prune manifest stops at 2,000 entries, but
`foldersPruned` and `prunedFolderBytes` still count *every* prune. The UI says
exactly that: *"{omitted} more are counted in every total above."*

`appendNarration` is four lines and shows the pattern in miniature:

```ts
export function appendNarration(
  state: { narration: NarrationLine[]; narrationDropped: number },
  kind: NarrationKind, text: string, atMs: number
): void {
  if (state.narration.length >= NARRATION_MAX_LINES) {
    state.narrationDropped++;      // the drop is COUNTED, never silent
    return;
  }
  state.narration.push({ kind, tier: 'none', text, atMs });
}
```

### A cap with a derivation, and a downstream refusal

The verdict ledger's row cap is the strongest example, because it states its
arithmetic and then makes the truncation *fatal downstream* rather than merely
visible:

```ts
/** Verdict-ledger rows kept INSIDE the map_suggestions document. NAMED cap,
 *  recorded when it bites (rowsTruncated + rowsOmitted + this cap value in
 *  the doc): a BSON document tops out at 16 MB and a measured row is ~250 B,
 *  so 20,000 rows ≈ 5 MB — three-fold headroom under the hard limit. */
export const MAX_SUGGESTION_ROWS = 20_000;
```

The reference drive produces 1,983 rows; the cap exists for enterprise drives.
And when it bites, selective ingest **refuses to resolve a selection at all**:

```ts
if (suggestions.rowsTruncated === true) {
  throw ApplicationFailure.create({
    nonRetryable: true,
    type: 'SuggestionRowsTruncated',
    message: '… resolving a selection against a partial ledger would silently ' +
             'ingest a subset of the decision. Refusing; enterprise-scale ledger ' +
             'resolution is future work, on record.',
  });
}
```

That is the honest ordering: a visible cap is fine for a *report*; it is not
fine for a *decision*. The UI carries the same statement to the person —
this drive cannot be decided yet, and nothing will be read.

### A bound that cannot be disabled by accident

```ts
/** A malformed or non-positive override falls back to the default rather than
 *  disabling the bound — an unparseable env var must never read as "no limit". */
export function maxIngestFileBytes(): number {
  const raw = (process.env[MAX_INGEST_FILE_BYTES_ENV] || '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_INGEST_FILE_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INGEST_FILE_BYTES;
}
```

And the 25 MiB default is derived rather than round: an ingest batch holds up
to 15 files in memory at once and each exists **twice** at its peak — the
downloaded buffer plus the multipart copy built for the hop out — so the
ceiling has to satisfy `15 × 2 × ceiling ≪` whatever memory your deployment
grants the ingest worker. Against a 2 GiB limit, 25 MiB gives ~750 MiB of file
bytes at full fan-out, leaving the rest of the heap for everything else the
worker is doing. Raising it without lowering the concurrency
buys an out-of-memory kill, which fails the whole batch including the files
that were fine. The two numbers must be read together, which is why they live
in the same file.

### The reason token carries the numbers

Every skip travels with its measurement, not just its category:

```ts
return {
  reason: INGEST_SKIP_REASONS.TOO_LARGE,
  detail: `${file.size} bytes exceeds the ${ceiling}-byte connector ingest ceiling ` +
          `(${MAX_INGEST_FILE_BYTES_ENV}); the file was never downloaded`,
};
```

*A reason token with no measurement is half a story* — the comment says so in
those words. The rendered string puts the token first so a log grep finds it
and the numbers after so a human learns what bit.

## Rule 3: unknown ids render verbatim

Every lookup table in the UI package shares one fallback: an id the build does
not know is shown **as itself**.

```ts
function classLabel(id: string): string {
  const d = CLASS_DISPLAY[id];
  return d ? t(d.label) : id; // unknown class id: rendered verbatim as data
}
```

The same for funnel rule ids, for sensitive shape ids (*"an id the artifact
adds later renders verbatim, never silently"*), and for host label ids
(`labelDisplay` returns the id when the host's config does not name it).

Run statuses go one step further: an unrecognized status is *typed* as
`'unrecognized'` **and** the raw token is carried alongside —

```ts
/** The token verbatim, so an unrecognized state can be quoted on screen
 *  instead of hidden behind a shrug. */
rawStatus: string;
```

The failure mode being avoided is a worker deployed ahead of the UI. Under a
drop-the-unknown policy, the new state simply vanishes from the screen and the
totals stop adding up for reasons nobody can see. Under this policy the screen
says an unfamiliar word — which is annoying, and true.

The connector's own skip vocabulary is closed (so a per-reason rollup on a
polled document cannot grow unboundedly), and the rollup folds anything
outside it into an explicit `unnamed` bucket rather than discarding it.

## Rule 4: empty is not the same as incomplete

The browse UI has four distinct renderings where a lazier design has one:

- `folderEmpty` — "This folder is empty."
- `complete` — "All {n} items in this folder."
- `partial` — "{n} items so far. This folder has more — this list is **NOT** complete."
- `partialNone` — "Nothing listed yet, and there is more of this folder still
  to read — this list is **NOT** complete."

That fourth string exists for the case that would otherwise be
indistinguishable from an empty folder: a listing that returned zero items
*and* a continuation cursor. There is also `incompleteUnknown` for a listing
that stopped early without a usable continuation point, and `serverTruncated`
for the ceiling case: *"The server stopped listing at its own ceiling — this
list is NOT complete."*

The same discipline covers a failed page-load mid-listing: *"The next page of
rows could not be loaded. What is above is still exact."* Two facts, both
stated — what broke, and what remains trustworthy.

## Rule 5: show the arithmetic

The map's closing narration is the reconciliation, written out. The line is
assembled from the run's own counters:

```ts
`Check: ${fmtBytes(enumeratedFileBytes)} enumerated across ${fmtInt(totalFiles)} files ` +
`+ ${fmtBytes(prunedFolderBytes)} in ${fmtInt(foldersPruned)} pruned folders ` +
`= ${fmtBytes(accounted)} accounted for.`
```

Two sums that together account for the subtree **without opening anything** —
enumerated file bytes plus the recursive size of every folder pruned at the
boundary. The landing page renders the same equation, and when the drive's own
reported total is available it states the gap rather than rounding it away:
*"Your drive reports {reported}. {accounted} is accounted for above; the
remaining {gap} was not reached."*

The funnel goes further and refuses to emit a result that does not add up:

```ts
if (candidates.length - subFiles !== selected.length ||
    candBytes - subBytes !== selBytes) {
  throw new Error(
    'funnel does not reconcile: candidates minus named subtractions must equal the ' +
    'default selection, in files AND bytes — a funnel that cannot add is JRN-7, and ' +
    'it does not ship'
  );
}
```

Two supporting habits make that check meaningful:

- **Zeros are included.** Every subtraction rule reports its files and bytes
  even when it took nothing. The UI says why: *"A rule that only appears when
  it fires cannot be audited."*
- **Counts are regenerated, not trusted.** The classifier loader recomputes
  the artifact's self-describing extension counts rather than reading them —
  *a count somebody typed is a claim; a count the loader emits is a
  measurement.*

And if the stored numbers ever *do* disagree, the UI shows the disagreement
rather than the tidier of the two: *"These rows do not add up… The recorded
numbers are shown exactly as they are; the discrepancy is stated rather than
hidden, and it is ours to fix."*

## Graded degradation: the SSE stream

The narration stream is where all five rules meet, because a transport can
force a choice between honesty and delivery.

Every frame is measured before it is written, against a 32,000-byte cap. One
oversized frame can reproduce a documented proxy failure mode: the proxy
buffers, stalls, and severs the stream. So a frame that busts the cap is
**reported to the caller** — never written, and never silently shrunk inside
the transport:

```ts
if (bytes > options.maxFrameBytes) {
  options.onFrameDropped?.({ bytes, type: String(payload.type) });
  return false;
}
```

Degradation policy belongs to the caller, *because only the caller knows which
fields a frame can honestly shed*. The map route logs every dropped
narration/progress frame at error level, and for the one frame that can
legitimately grow — the terminal frame carrying a full prune manifest — it
degrades in **named, flagged steps**:

```ts
if (tooBig(frame)) frame = { ...withoutManifest,  pruneManifestElided: true };
if (tooBig(frame)) frame = { ...withoutTop,       topFoldersElided: true };
```

Both elisions are flags in the frame, both remain fetchable **in full** at
`GET /:id/map`, and the UI's message for the case says both halves: the list
did not arrive, *"Every total above is still exact."*

The rest of the stream is built the same way. Comment heartbeats keep an idle
stream from being cut while a walk grinds through a huge folder. Closed is
closed: after the client hangs up, every write is a no-op. A stream opened
before the workflow's first write waits a **bounded, stated** interval for a
run document, then sends an `error` frame and closes — rather than hanging
forever looking like a slow map. A store failure mid-stream ends the stream
honestly rather than leaving the client on a line that will never speak again.

Even the transport fallback is narrated: *"The live stream could not stay
open, so this page checks progress every few seconds instead. Nothing is lost
— the narration catches up on each check."*

## Say what you cannot know

The rule extends past caps to estimates. The ingest cost estimate is
deterministic arithmetic with no model call, and it refuses to produce a
confident single number where it does not have one: bytes ÷ 4 is defensible
for plain text and nearly meaningless for a compressed container format. So it
emits a **range**, names the binary share of the selection, and ships the
arithmetic itself as a string the UI renders beside the number:

> text-like bytes (.md/.txt/.csv) ÷ 4 per token on both ends; binary/other
> bytes ÷ 50 (low) to ÷ 4 (high) per token; ends rounded up to whole tokens;
> reconciled against real token counts after parsing

A file with no extension counts in the **binary** share, deliberately: its
format is unknown, and the honest bucket for unknown is the wide range, not
the confident one. And if the underlying ledger hit its row cap, the method
string appends *"; ledger truncated at its write cap — estimate covers the
kept rows only"* — an estimate over a partial ledger must say so rather than
quietly covering a subset.

The same instinct governs the ingest type filter, which is a **denylist, not
an allowlist**, and says why: the first version was an allowlist, and it
silently refused to download legacy Office documents and mail exports the
downstream parser could already read — then reported them to the customer as a
deliberate skip. *"A corpus shrink presented as an intentional choice is worse
than a crash, because nobody looks for it."*

## Applying it to your own work

If you are extending shelfmark, the review question is not *"is this
bounded?"* — everything must be bounded. It is:

1. **What is the bound, and where is it written?** A named constant with a
   derivation, in the file where it binds. Caps must be stated where they
   bind: a real incident here was traced to a request-size ceiling ~250×
   smaller than the file-size limit that was actually enforced, and stated
   nowhere.
2. **What does the output say when it bites?** A flag and a count, in the
   record — and, if downstream turns that record into a *decision*, a refusal
   rather than a flag.
3. **Which totals stay exact?** Say so explicitly. "Itemization truncated,
   totals exact" is a much stronger statement than "truncated", and it is
   usually the true one.
4. **Is there a state that renders identically to a benign one?** Empty vs
   incomplete, skipped vs failed, deferred vs failed, unknown-id vs absent.
   Give each its own rendering.

The related project-level statement of the same value is
[known limitations](../project/known-limitations.md), which exists because the
alternative is a reader finding them later and trusting the rest of the docs
less.
