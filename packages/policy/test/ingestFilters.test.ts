// SPDX-License-Identifier: Apache-2.0
// 34-S14d — the two bounds and the closed skip vocabulary, on their own.
// The connector-level proof (that a skipped file is NEVER downloaded) lives
// with the connector activity tests; this file pins the decisions themselves.
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_INGEST_FILE_BYTES,
  UNREADABLE_EXTENSIONS,
  INGEST_CONCURRENCY,
  INGEST_SKIP_REASONS,
  INGEST_SKIP_REASON_VALUES,
  MAX_INGEST_FILE_BYTES_ENV,
  countSkipReason,
  extensionOf,
  maxIngestFileBytes,
  oversizedAfterDownload,
  preIngestSkip,
  skipErrorText,
} from '../src/ingestFilters.js';

afterEach(() => {
  delete process.env[MAX_INGEST_FILE_BYTES_ENV];
});

describe('the size ceiling', () => {
  it('is derived from the fan-out and the pod limit, not picked round', () => {
    // 15 concurrent downloads × 2 copies each (Buffer + the multipart copy)
    // × 25 MiB ≈ 750 MiB against the worker pod's 2Gi limit. If either number
    // moves, this arithmetic is where the other one gets re-checked.
    expect(DEFAULT_MAX_INGEST_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(INGEST_CONCURRENCY * 2 * DEFAULT_MAX_INGEST_FILE_BYTES).toBeLessThan(1024 * 1024 * 1024);
  });

  it('honours the env override', () => {
    process.env[MAX_INGEST_FILE_BYTES_ENV] = '4096';
    expect(maxIngestFileBytes()).toBe(4096);
  });

  it('falls back to the default on a malformed override — an unparseable value is never "no limit"', () => {
    for (const bad of ['', '   ', 'lots', '-1', '10MB', '0']) {
      process.env[MAX_INGEST_FILE_BYTES_ENV] = bad;
      expect(maxIngestFileBytes(), bad).toBe(DEFAULT_MAX_INGEST_FILE_BYTES);
    }
  });
});

describe('preIngestSkip', () => {
  it('skips an oversized file by name, with the bound AND the value in the reason', () => {
    process.env[MAX_INGEST_FILE_BYTES_ENV] = '1000';
    const skip = preIngestSkip({ name: 'huge.pdf', size: 3_221_225_472 });
    expect(skip?.reason).toBe(INGEST_SKIP_REASONS.TOO_LARGE);
    // The bound that bit and the value that hit it — a reason token with no
    // measurement is half a story.
    expect(skip?.detail).toContain('3221225472');
    expect(skip?.detail).toContain('1000');
    expect(skip?.detail).toContain(MAX_INGEST_FILE_BYTES_ENV);
    expect(skip?.detail).toContain('never downloaded');
  });

  it('skips an unsupported type BEFORE the size question — "we do not read video" is the useful fact', () => {
    process.env[MAX_INGEST_FILE_BYTES_ENV] = '1000';
    const skip = preIngestSkip({ name: 'holiday.mov', size: 3_221_225_472 });
    expect(skip?.reason).toBe(INGEST_SKIP_REASONS.UNSUPPORTED_TYPE);
    expect(skip?.detail).toContain('.mov');
  });

  it('passes an ordinary document of ordinary size', () => {
    expect(preIngestSkip({ name: 'contract.pdf', size: 120_000 })).toBeNull();
    expect(preIngestSkip({ name: 'NOTES.MD', size: 12 })).toBeNull();
  });

  it('does NOT apply the size bound when the provider reported no size — absent is not zero', () => {
    process.env[MAX_INGEST_FILE_BYTES_ENV] = '10';
    // A native Google Doc reports no size at all; guessing "0" here would let
    // an arbitrarily large export through silently, and guessing "huge" would
    // skip a file nobody asked us to skip. The bound moves to after the
    // download instead — see oversizedAfterDownload.
    expect(preIngestSkip({ name: 'exported.docx' })).toBeNull();
    expect(preIngestSkip({ name: 'exported.docx', size: null })).toBeNull();
    expect(oversizedAfterDownload(11)?.reason).toBe(INGEST_SKIP_REASONS.TOO_LARGE);
    expect(oversizedAfterDownload(11)?.detail).toContain('after the fetch');
    expect(oversizedAfterDownload(9)).toBeNull();
  });

  it('treats a dotfile as having no extension rather than inventing one', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('report')).toBe('');
    expect(extensionOf('a.b.PDF')).toBe('pdf');
    // A dotfile has no extension, and under the denylist that means TRIED,
    // not skipped — '.gitignore' is text the parser reads fine.
    expect(preIngestSkip({ name: '.gitignore', size: 10 })).toBeNull();
  });

  it('skips only what is unreadable by construction — the parser TRIES everything else', () => {
    // The inversion that matters: the parser's route_for() ENDS with
    // `return "unstructured"`, so unstructured is the default, not another
    // table. An allowlist mirroring the explicit tables refused to download
    // legacy Office and mail exports the platform can already read, and told
    // the customer it had skipped them on purpose. Denylist, so being wrong
    // costs a wasted download and an honest parse failure instead of a
    // silent corpus shrink.
    for (const ext of ['mov', 'mp4', 'zip', 'exe', 'iso', 'dmg', 'ttf', 'mp3']) {
      expect(UNREADABLE_EXTENSIONS.has(ext), ext).toBe(true);
      expect(preIngestSkip({ name: `f.${ext}`, size: 10 })?.reason, ext).toBe('unsupported_type');
    }
    // Explicitly routed types are downloaded.
    for (const ext of ['pdf', 'docx', 'xlsx', 'csv', 'md', 'txt', 'html', 'json', 'heic', 'png']) {
      expect(preIngestSkip({ name: `f.${ext}`, size: 10 }), ext).toBeNull();
    }
    // THE REGRESSION THIS EXISTS FOR: unlisted-but-readable. Every one of
    // these routes to unstructured, which reads them; the allowlist skipped
    // them all.
    for (const ext of ['doc', 'ppt', 'msg', 'eml', 'xlsm', 'pages', 'numbers']) {
      expect(preIngestSkip({ name: `f.${ext}`, size: 10 }), ext).toBeNull();
    }
    // An unknown extension is TRIED, not pre-judged.
    expect(preIngestSkip({ name: 'f.wibble', size: 10 })).toBeNull();
    expect(preIngestSkip({ name: 'no-extension-at-all', size: 10 })).toBeNull();
  });
});

describe('the skip vocabulary', () => {
  it('is CLOSED — the per-reason rollup can never grow past it', () => {
    // 'deferred' is the sink-declined-for-now status (the DocumentSink
    // declined the file for the moment and owns resuming it).
    expect([...INGEST_SKIP_REASON_VALUES].sort()).toEqual(
      ['already_ingested', 'deferred', 'too_large', 'unsupported_google_format', 'unsupported_type'].sort()
    );
  });

  it('folds unknown reasons into one named bucket rather than growing the map', () => {
    let rollup = countSkipReason(undefined, INGEST_SKIP_REASONS.TOO_LARGE);
    rollup = countSkipReason(rollup, INGEST_SKIP_REASONS.TOO_LARGE);
    rollup = countSkipReason(rollup, 'something-nobody-declared');
    rollup = countSkipReason(rollup, undefined);
    expect(rollup).toEqual({ too_large: 2, unnamed: 2 });
  });

  it('puts the token first in the error text so a log grep finds it', () => {
    const text = skipErrorText({ reason: INGEST_SKIP_REASONS.TOO_LARGE, detail: '1 > 0' });
    expect(text.startsWith('too_large:')).toBe(true);
  });
});
