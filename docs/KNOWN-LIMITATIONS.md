# Known limitations

Stated because the alternative is you finding them later and trusting the rest
of the docs less. Inherited honesty rule: an unstated cap reads as "covered"
when it isn't.

## Ranking is not validated

The selection policy ships an ordering, and the funnel's default selection is
useful — but the ranking **weights** carry no proven signal: on the original
validation corpus, randomized weights reproduced 77% of the top-100 selection
vs the declared weights' 81%. Treat the order as a convenience, not a
judgment. PRs tuning weights are declined without a validation corpus
(see CONTRIBUTING).

## Classifier error rate is unmeasured

The artifact classifier is rules-as-data with zero inference — precedence
folder-prune > exact-name > extension > escape — and its equivalence fixtures
pin behavior, but no labeled corpus has measured its error *rate*. It was
built and checked against one real drive.

## Provider timestamps are arrival, not authorship

`createdDateTime`/`lastModifiedDateTime` from the provider describe when the
item reached (or changed in) the drive — a decades-old document uploaded last
year carries last year's dates. Any time-based question over mapped metadata
inherits this. Nothing in shelfmark can fix it; we surface the dates the
provider reports.

## Whole-file buffers, no streaming

Downloads materialize as a `Buffer` before crossing `DocumentSink.accept()`.
Size ceilings bound memory (default 25 MiB, configurable). Streaming would
change the sink signature (`Buffer` → `Readable`) and is the intended v2
evolution of the port — declared now so sinks are written knowing it.

## SSE progress is Mongo-poll-based

The map's narration stream polls the run record (700 ms) rather than using
change streams. This is deliberate: the workflow flushes narration per page,
so polling matches the write pattern and keeps the store requirements plain.
Do not "fix" it into a change-stream dependency casually.

## MongoDB is a hard dependency

The consent ledger's write-concern semantics (`w:majority, j:true`,
append-only), the workflowId-doubles-as-runId convention, and the SSE poller's
read pattern are Mongo-shaped. A storage abstraction wide enough to hide that
would leak it anyway; we chose the honest dependency.

## One-corpus provenance

Everything above that says "measured" was measured on one real drive
(~8,200 files, 16.8 GB) plus synthetic fixtures. Two-corpus validation never
happened before extraction. The numbers are honest; their generality is
unproven.
