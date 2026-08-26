// SPDX-License-Identifier: Apache-2.0
// 34-S14d — the pre-filters that make `skipped` REACHABLE on the Graph path,
// and the two bounds the connector ingest tail never had.
//
// ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
//
// `IngestOutcome.status` has declared 'skipped' since the connectors shipped
// and NOTHING on the Graph path could ever emit it (only the Google connector
// did, for native Google formats). A declared status nothing can reach is a
// vocabulary that lies about what the system can tell you.
//
// Meanwhile the same path downloaded whole files into memory with no size
// ceiling and no type allowlist, so a 3 GB video became a full in-memory
// download followed by a guaranteed parse failure — counted as 'failed',
// polluting exactly the completion numbers step 15 exists to make honest.
// A file we deliberately never opened is not a file that failed. It is
// skipped, for a NAMED reason, and the reason travels with the outcome.
//
// ══ EVERY BOUND IS NAMED, AND RECORDED WHEN IT BITES ════════════════════════
//
// Both bounds below are constants with a stated derivation, both are
// reported per file through `IngestOutcome.skipReason` + `error`, and both
// are rolled up per reason in the sync/ingest progress documents. Nothing
// here drops a file silently.

/** Concurrent downloads inside ONE ingest batch activity. Was an inline `15`
 *  in both connectors; named here because the size ceiling below is derived
 *  from it and the two numbers must be read together. Unchanged value. */
export const INGEST_CONCURRENCY = 15;

/**
 * Largest file this connector will open, in bytes.
 *
 * DERIVATION, not a round number: the ingest batch holds up to
 * INGEST_CONCURRENCY files in memory at once, and each one exists TWICE at
 * its peak — the downloaded Buffer plus the multipart copy `form-data`
 * builds for the parser hop. Against a 2Gi worker memory limit (whatever
 * your deployment's manifest grants the ingest worker), the ceiling has to
 * satisfy 15 × 2 × ceiling ≪ 2Gi: 25 MiB gives ~750 MiB of file bytes at
 * full fan-out, leaving the rest of the heap for everything else the worker
 * is doing. Raising this without lowering INGEST_CONCURRENCY buys an
 * OOMKill, which fails the whole batch — including the files that were fine.
 */
export const DEFAULT_MAX_INGEST_FILE_BYTES = 25 * 1024 * 1024;

/** Env override for the ceiling, read per call so an operator can raise it
 *  without a code change (and so tests can exercise the bound cheaply). */
export const MAX_INGEST_FILE_BYTES_ENV = 'CONNECTOR_MAX_INGEST_FILE_BYTES';

/** Minimal module-scoped view of `process` — just the one property this file
 *  touches — so the package stays zero-dependency (no @types/node) and the
 *  declaration never collides with a consumer's own Node typings. */
declare const process: { env: Record<string, string | undefined> };

/** The ceiling in force right now. A malformed or non-positive override
 *  falls back to the default rather than disabling the bound — an
 *  unparseable env var must never read as "no limit". */
export function maxIngestFileBytes(): number {
  const raw = (process.env[MAX_INGEST_FILE_BYTES_ENV] || '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_INGEST_FILE_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INGEST_FILE_BYTES;
}

/**
 * Extensions the document parser CANNOT read — the deny side, deliberately.
 *
 * THE FIRST VERSION OF THIS WAS AN ALLOWLIST AND IT WAS WRONG. It mirrored
 * the document parser's explicit route tables and treated "not in a route
 * table" as "the parser cannot read this". But the parser's `route_for()`
 * ends `return "unstructured"` — unstructured is the DEFAULT, not another
 * table — and Unstructured's auto-partitioner reads .doc, .ppt, .msg, .eml
 * and .xlsm among others. An allowlist therefore silently refused to
 * download legacy Office documents and mail exports on every real tenant,
 * reported them to the customer as a deliberate skip, and advised them to
 * convert files the platform could already read. A corpus shrink presented
 * as an intentional choice is worse than a crash, because nobody looks for
 * it.
 *
 * So the filter now matches the parser's own posture: TRY, unless the type
 * is unreadable by construction. These are containers and media whose bytes
 * hold no extractable document text — the multi-gigabyte videos and archives
 * the ceiling exists for. Everything else is downloaded and offered to the
 * parser, which is allowed to fail honestly on a file it turns out not to
 * understand.
 *
 * Note what is NOT here: images. `png/jpg/tiff/heic/…` route to docling and
 * docling_via_heic for OCR, so they are read, not skipped.
 *
 * Adding an entry is a claim that the parser cannot read the type at all.
 * Removing one costs nothing but a wasted download and an honest parse
 * failure — which is the safer direction to be wrong in, and is why this is
 * a denylist.
 */
export const UNREADABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // moving image / audio — no document text, and the largest files on a drive
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'aiff', 'aif',
  // archives and disk images — opaque by construction; opening one is a
  // different consent question (the artifact classifier calls this
  // opaque_container)
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso', 'pkg',
  'jar', 'war', 'onepkg',
  // executables, objects and installers
  'exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'apk', 'deb', 'rpm', 'app',
  'o', 'obj', 'class', 'pyc', 'wasm',
  // fonts and other non-document binaries
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // virtual machine / database blobs
  'vmdk', 'vdi', 'qcow2', 'sqlite', 'db', 'mdb', 'accdb',
]);

/**
 * The CLOSED skip vocabulary. Closed on purpose: the progress documents
 * carry a per-reason rollup (`skippedByReason`), and a rollup keyed on an
 * open string set is an unbounded map on a polled document.
 */
export const INGEST_SKIP_REASONS = {
  /** {connectionId, remoteFileId} already has a non-failed document row —
   *  the dedupe that stops a re-crawl doubling the corpus (34-S14b). */
  ALREADY_INGESTED: 'already_ingested',
  /** Already parked at 'deferred' — the sink-declined-for-now status: the
   *  DocumentSink declined the file for the moment and owns resuming it.
   *  Re-ingesting it here would duplicate its vectors the moment the sink
   *  starts accepting again. */
  DEFERRED: 'deferred',
  /** Over `maxIngestFileBytes()`. */
  TOO_LARGE: 'too_large',
  /** Extension in UNREADABLE_EXTENSIONS — unreadable by construction. */
  UNSUPPORTED_TYPE: 'unsupported_type',
  /** Native Google format with no export target (Forms, Drawings, Sites…) —
   *  the Google connector's pre-existing skip, folded into the shared
   *  vocabulary so both connectors roll up the same way. */
  UNSUPPORTED_GOOGLE_FORMAT: 'unsupported_google_format',
} as const;

export type IngestSkipReason = (typeof INGEST_SKIP_REASONS)[keyof typeof INGEST_SKIP_REASONS];

/** Every reason, for the rollup's own bound check and for tests that assert
 *  the vocabulary is closed. */
export const INGEST_SKIP_REASON_VALUES: readonly IngestSkipReason[] = Object.freeze(
  Object.values(INGEST_SKIP_REASONS)
) as readonly IngestSkipReason[];

export interface IngestSkip {
  reason: IngestSkipReason;
  /** Human detail carrying the NUMBERS — the bound that bit and the value
   *  that hit it. A reason token with no measurement is half a story. */
  detail: string;
}

/** Lowercased extension with no dot, or '' for a name that has none. A
 *  leading-dot name ('.gitignore') has no extension by this rule, which is
 *  the same convention the artifact classifier uses. */
export function extensionOf(name: string): string {
  const cut = name.lastIndexOf('.');
  if (cut <= 0) return '';
  return name.slice(cut + 1).toLowerCase();
}

/**
 * The decision taken BEFORE a single byte is fetched.
 *
 * Type first, then size: for a 3 GB `.mov` both are true, and "we do not read
 * video" is the more useful thing to tell a customer than "it was big".
 *
 * `size` undefined means the provider did not report one (or an in-flight
 * workflow started before this field existed) — NOT zero. The size bound
 * cannot be applied without a size, so it is deferred to
 * `oversizedAfterDownload` below rather than guessed at.
 */
export function preIngestSkip(file: { name: string; size?: number | null }): IngestSkip | null {
  const ext = extensionOf(file.name);
  if (ext && UNREADABLE_EXTENSIONS.has(ext)) {
    return {
      reason: INGEST_SKIP_REASONS.UNSUPPORTED_TYPE,
      detail: `.${ext} holds no extractable document text (media, archive or binary); the file was never downloaded`,
    };
  }
  const ceiling = maxIngestFileBytes();
  if (typeof file.size === 'number' && file.size > ceiling) {
    return {
      reason: INGEST_SKIP_REASONS.TOO_LARGE,
      detail: `${file.size} bytes exceeds the ${ceiling}-byte connector ingest ceiling (${MAX_INGEST_FILE_BYTES_ENV}); the file was never downloaded`,
    };
  }
  return null;
}

/**
 * The same ceiling applied to bytes we already hold, for the one case
 * `preIngestSkip` cannot cover: a provider (or an in-flight workflow batch
 * from before `size` was carried) that gave us no size up front. The file WAS
 * opened, so the detail says so — but it is still a skip, not a failure:
 * nothing about the document is broken, we declined to process it.
 */
export function oversizedAfterDownload(byteLength: number): IngestSkip | null {
  const ceiling = maxIngestFileBytes();
  if (byteLength <= ceiling) return null;
  return {
    reason: INGEST_SKIP_REASONS.TOO_LARGE,
    detail: `${byteLength} downloaded bytes exceed the ${ceiling}-byte connector ingest ceiling (${MAX_INGEST_FILE_BYTES_ENV}); the provider reported no size up front, so this was caught after the fetch and before the parse`,
  };
}

/** The `error` string a skip travels with — token first so a log grep finds
 *  it, numbers after so a human learns what bit. */
export function skipErrorText(skip: IngestSkip): string {
  return `${skip.reason}: ${skip.detail}`;
}

/** Folds one skip reason into a bounded per-reason rollup. The vocabulary is
 *  closed (INGEST_SKIP_REASONS), so this map can never grow past its size. */
export function countSkipReason(
  rollup: Record<string, number> | undefined,
  reason: string | undefined
): Record<string, number> {
  const out = { ...(rollup ?? {}) };
  const key = reason && (INGEST_SKIP_REASON_VALUES as readonly string[]).includes(reason)
    ? reason
    : 'unnamed';
  out[key] = (out[key] ?? 0) + 1;
  return out;
}
