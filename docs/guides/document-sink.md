---
title: Implementing a DocumentSink
parent: Guides
nav_order: 1
---

# Implementing a DocumentSink

`DocumentSink` is one of [the five ports](../concepts/the-ports.md), and the
handoff boundary. Everything before it — walking the drive, classifying items,
enforcing the consent's scope, filtering, and downloading the bytes — is this
library's job. Everything after bytes-in-hand
— object storage, parsing, indexing, embedding, whatever your pipeline does —
is yours, and `accept()` is where it starts.

This is the one interface you cannot avoid implementing.

## The interface

From `packages/core/src/ports.ts`, verbatim:

```ts
export interface DocumentSink {
  accept(meta: DocumentMeta, content: Buffer): Promise<SinkOutcome>;
}

export interface DocumentMeta {
  /** Connector-generated, STABLE across retries of the same file. */
  documentId: string;
  tenantId: string;
  connectionId: string;
  runId: string;
  filename: string;
  /** The connector's guess; the sink may sniff for itself. */
  mimetype: string;
  size: number;
  /** Real remote folder path — provenance, not storage layout. */
  remotePath: string;
  /** Provider item id — the dedupe key. A sink seeing a repeated
   *  (connectionId, remoteFileId) with isRetry MUST update, not duplicate. */
  remoteFileId: string;
  /** Already resolved through LabelPolicy before the sink sees it. */
  label: string;
  isRetry: boolean;
}

export type SinkOutcome =
  | { status: 'ingested' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; skipReason: string; error?: string }
  /** Sink declines FOR NOW (quota, budget, backpressure). The run records it,
   *  the ledger shows it, and the retry pass re-submits with isRetry. */
  | { status: 'deferred'; reason: string };
```

`size` is `content.length` — the byte count of what you were actually handed,
not the provider's claim. `mimetype` is guessed from the filename extension
by `guessMimetype()` in `@shelfmark/workflows`; it is a hint, and a sink that
cares should sniff the buffer.

## A minimal sink that compiles

```ts
import type { DocumentMeta, DocumentSink, SinkOutcome } from '@shelfmark/core';

/** The smallest correct sink: in-memory, idempotent, honest. */
export class MemoryDocumentSink implements DocumentSink {
  private readonly docs = new Map<string, { meta: DocumentMeta; bytes: Buffer }>();

  async accept(meta: DocumentMeta, content: Buffer): Promise<SinkOutcome> {
    // Idempotency: documentId is stable per (connectionId, remoteFileId), so
    // `set` on an existing key is an UPDATE. Never push onto a list keyed by
    // anything else — that is how a re-enumeration doubles a corpus.
    const seen = this.docs.has(meta.documentId);
    if (seen && !meta.isRetry) {
      // Optional: you already have this file and nothing asked you to redo
      // it. Answering `skipped` is cheaper than re-processing, and the run
      // ledger reports it as a skip with your reason token.
      return { status: 'skipped', skipReason: 'already_ingested' };
    }
    this.docs.set(meta.documentId, { meta, bytes: content });
    return { status: 'ingested' };
  }

  get(documentId: string): Buffer | undefined {
    return this.docs.get(documentId)?.bytes;
  }
}
```

Wire it in wherever you build your ports object:

```ts
import type { ShelfmarkPorts } from '@shelfmark/core';

const ports: ShelfmarkPorts = {
  sink: new MemoryDocumentSink(),
  resolveAuth: async (req) => resolveYourAuth(req),
};
```

That is a working sink. The rest of this page is the contracts that separate a
working sink from a correct one.

## Contract 1 — idempotency on (connectionId, remoteFileId)

`documentId` is not random. It is derived, in
`packages/workflows/src/activities/ingest.ts`:

```ts
export function documentIdFor(connectionId: string, remoteFileId: string): string {
  const digest = createHash('sha256')
    .update(`${connectionId} ${remoteFileId}`)
    .digest('hex');
  return `doc-${digest.slice(0, 32)}`;
}
```

Every re-enumeration, retry, and re-sync of the same remote file produces the
same `documentId`. It is hashed rather than concatenated so it is fixed-length
and carries no remote path or provider identifier into whatever namespace you
store it in.

This matters because the library has no documents table of its own. The
system this was extracted from deduped by querying its own documents table for
`{connectionId, remoteFileId}` before downloading; a re-enumeration without
that check silently *doubled* the corpus. Here terminal document storage lives
behind the port, so the same guarantee is carried by contract instead:

> **A sink seeing a `documentId` it has seen before MUST update, not duplicate.**
{: .important }

Key your storage on `documentId` (or on `(connectionId, remoteFileId)`, which
is equivalent), and make the write an upsert. If the file moved or was renamed
remotely, the id is unchanged and `remotePath`/`filename` are not — decide
deliberately whether to clean up the superseded copy. The filesystem
reference sink does; the object-store one does not, and says so.

## Contract 2 — the four outcomes, and when each is right

| Outcome | Means | Use it when |
| --- | --- | --- |
| `ingested` | The file is now in your corpus. | The write and whatever processing you consider mandatory succeeded. |
| `failed` | This file is broken *for you*. | A parse failed, a required write errored, the type turned out to be unreadable. Something is wrong with this file or this attempt. |
| `skipped` | You deliberately did not process it. | You already have it, your policy excludes it, it is not a type you handle. Nothing is wrong. |
| `deferred` | Not now. | Quota, budget, backpressure, a downstream service that is down. Nothing is wrong with the file and you expect to take it later. |

The distinction between `failed` and `deferred` is load-bearing, not
cosmetic. The system this came from reported sink deferrals as failures on one
of its two entry paths, so the same file could carry two contradictory
statuses depending on how it got there. `deferred` exists so "we declined for
the moment" never renders as "your document is broken".

`skipped` carries an **open** `skipReason` string — your vocabulary, carried
verbatim into the run's per-reason rollup. That is deliberate: the sink is
host code. The library's own skip vocabulary is closed (see
[what the sink is not responsible for](#what-the-sink-is-not-responsible-for))
precisely because a rollup keyed on an open string set would be an unbounded
map on a polled document; your own tokens are your own bound to keep. Keep the
set small and stable.

`failed` requires `error` and `deferred` requires `reason` — both are human
text and both surface in the run record and the ledger the customer is looking
at. Write them for that reader: say which bound bit and what the number was.

## Contract 3 — `deferred` means "not now", and nothing re-offers it for you

When you answer `deferred`:

- the run counts it in `deferred`, separately from `failed` and `skipped`;
- the ingest status screen renders a "finished, with files parked" card rather
  than a success or a failure;
- the file is **not** ingested, and this library will not come back for it on
  its own.

That last point is the honest version. The source system ran a
retry-failed-files pass at the start of every sync, driven by a query over its
own documents table. There is no such table here — terminal storage is behind
your sink — so the pass was deliberately not ported. Re-offering a deferred
file is a **host action**: submit it through a fresh run with `isRetry: true`
on the `FileToIngest`, and the stable `documentId` makes that re-submission an
update by contract rather than a duplicate.

If your sink defers, you need a plan for what re-submits. If you have no such
plan, `failed` with an honest message is more truthful than a `deferred` that
nothing will ever pick up.

## Contract 4 — throwing and returning `failed` are not the same act

The activity that calls you looks like this:

```ts
try {
  const buffer = await downloadFile(accessToken, driveId, file.itemId);
  // …size ceiling, DocumentMeta construction…
  const sunk = await deps.ports.sink.accept(meta, buffer);
  return outcomeFromSink(file.itemId, sunk);
} catch (err) {
  // A sink that THROWS (as opposed to answering {status:'failed'}) is
  // still a per-file failure, named in the run record — one broken file
  // (or one sink hiccup) must not crash the whole batch activity.
  return { itemId: file.itemId, status: 'failed', error: (err as Error).message };
}
```

So:

- **A throw does not crash the batch.** One bad file cannot take out the other
  fourteen files being processed alongside it.
- **A throw does not trigger a Temporal retry of the file.** It is caught and
  converted into a per-file `failed` outcome, exactly like a returned
  `{ status: 'failed' }`. There is no automatic second attempt at the sink.
- **A throw loses your control of the message.** The run record gets
  `err.message` and nothing else. A returned `failed` lets you write the
  sentence the customer reads.
- **A throw skips your own bookkeeping.** Anything you would have done on the
  way out — a manifest line, a metric, a cleanup — does not happen.

The practical rule: catch inside `accept()`, return the outcome you mean. Use
`deferred` for backpressure, never a throw. Reserve throwing for genuinely
unexpected states, and accept that it reads as a per-file failure when it
happens.

## The reference implementation: `FsDocumentSink`

`demo/src/sinks/fsSink.ts` is a real sink, not a stub — it turns a selective
ingest into a local searchable corpus. It is worth reading end to end; here is
what each part is demonstrating.

**Bytes, then text, then index.** For every accepted file it writes the
original bytes under
`<dataDir>/ingested/<tenant>/<connection>/<remotePath>/<filename>`, extracts
plain text in-process, writes a `<filename>.txt` sidecar beside the bytes, and
updates a MiniSearch index persisted to `search-index.json`. The remote folder
layout becomes the storage layout because OneDrive and SharePoint forbid
same-name siblings, which makes `remotePath + filename` unique per connection.

**Path segments are sanitized, not trusted.** Provider-controlled names never
steer the write path:

```ts
export function safeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}
```

**Accepts are serialized.** The ingest activity runs a concurrent batch, and
index plus state persistence are read-modify-write, so `accept()` queues:

```ts
accept(meta: DocumentMeta, content: Buffer): Promise<SinkOutcome> {
  const run = this.queue.then(() => this.acceptSerialized(meta, content));
  // A rejection must not poison the queue for the next file.
  this.queue = run.catch(() => undefined);
  return run;
}
```

Your sink will be called concurrently. Either make it safe under concurrency
or serialize like this — and note the `catch` that keeps one rejection from
poisoning the queue for every file behind it.

**Failures are honest.** An unparseable type answers `{status:'failed'}` with
the extractor's message: no empty sidecar, no index entry pretending a
spreadsheet was read.

**The `deferred` lane is demonstrated, not described.** With
`DEMO_DEFER_OVER_MB` set, a first-pass file over the threshold answers
`deferred`; the re-submission with `isRetry` is accepted. The whole
defer → retry → ingested story becomes visible in the run ledger.

**Updates clean up after a remote move.** Because `documentId` is stable, a
file that moved remotely arrives with the same id and a different path; the
sink removes the previously written bytes and sidecar before the new write,
and replaces (never adds) the index entry.

**The manifest is append-only.** Every `accept()` — including failures and
deferrals — appends one line to `manifest.jsonl` carrying the full
`DocumentMeta` and the outcome. Files and index are *current state*; the
manifest is *history*. When a document is updated after a move, the manifest
keeps both events, which is the point of having one.

## The object-store variant: `S3DocumentSink`

`demo/src/sinks/s3Sink.ts` is the same semantics against any S3-compatible
endpoint, and is the more useful starting point if your corpus lives in object
storage. What changes:

- **Keys are deterministic per document**, so a retry overwrites in place —
  the no-duplicate contract with no state store required.
- **The manifest is one object per accept**, at
  `manifest/<documentId>/<epoch-ms>.json`. S3 has no append, so a per-accept
  object *is* the append-only manifest.
- **A stated limitation, not a hidden one:** if a file moved remotely between
  attempts, the old key is not garbage-collected. Doing that portably needs a
  state store, which is the kind of thing a real host has and a demo should
  not fake. The manifest records both locations.

Note also that no library package ships an object-storage client. The demo
does, because the demo is host code — which is the entire point of the port.

## What the sink is *not* responsible for

The connector keeps everything that protects its own bandwidth and the honesty
of its ledger. By the time `accept()` is called, all of the following have
already happened, and re-implementing them in your sink is wasted work:

- **Download.** You are handed a `Buffer`. There is no streaming ingest —
  see [Known limitations](../project/known-limitations.md).
- **The size ceiling.** `DEFAULT_MAX_INGEST_FILE_BYTES` is 25 MiB, overridable
  per-call via the `CONNECTOR_MAX_INGEST_FILE_BYTES` environment variable. It
  is applied *before* the download from the provider-reported size, and again
  *after* the download for the one case a provider reports no size at all — so
  an oversized file costs one download and nothing else, and never reaches
  you. The number is derived, not round: the batch holds up to
  `INGEST_CONCURRENCY` files in memory at once, each existing twice at its
  peak, so the ceiling has to satisfy `15 × 2 × ceiling ≪` the worker's memory
  limit. Raising it without lowering the concurrency buys an OOM kill, which
  fails the whole batch including the files that were fine.
- **Unreadable-type refusal.** Extensions in `UNREADABLE_EXTENSIONS` (media,
  archives, executables, fonts, VM and database blobs) are skipped without
  being downloaded. Deliberately a **deny**list: an earlier allowlist version
  silently refused legacy Office documents and mail exports, reported them as
  a deliberate skip, and advised customers to convert files the platform could
  already read. Images are *not* on the list — they are downloaded and offered
  for OCR by whatever your sink uses.
- **Consent scope and exclusions.** The walk refuses an out-of-scope root and
  prunes-and-reports excluded subtrees. Nothing outside the grant reaches you.
- **Label resolution.** `meta.label` has already been through the host's
  `LabelPolicy`, which may have capped it or refused the run outright.

Concurrency is the one thing that *is* yours to handle: `accept()` is called
up to `INGEST_CONCURRENCY` (15) times concurrently within a single batch
activity.

## Where to go next

- [Mounting the API in your app](api-integration.md) — where you hand your
  ports object to the plugin and the worker.
- [Deployment](deployment.md) — the constants above as operational knobs, and
  what to watch.
