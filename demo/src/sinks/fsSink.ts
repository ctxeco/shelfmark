// SPDX-License-Identifier: Apache-2.0
//
// FsDocumentSink — the demo's default DocumentSink and a genuinely useful
// one: it turns a selective ingest into a local, searchable text corpus.
//
// For every accepted file it:
//   1. writes the ORIGINAL bytes under
//        <dataDir>/ingested/<tenant>/<connection>/<remotePath>/<filename>
//      (the remote folder layout is provenance and becomes the storage
//      layout — OneDrive/SharePoint forbid same-name siblings, so
//      remotePath+filename is unique per connection);
//   2. extracts plain text in-process (extractText.ts: pdf-parse, mammoth,
//      passthrough for text-native types) and writes a `<filename>.txt`
//      sidecar next to the bytes;
//   3. appends one line to <dataDir>/manifest.jsonl — the full DocumentMeta
//      plus the outcome, for EVERY accept() including failures and
//      deferrals. Append-only: the manifest is the sink's honest history,
//      while files/index below are its current state;
//   4. updates a MiniSearch index persisted at <dataDir>/search-index.json,
//      which the demo server's /api/v1/demo/search endpoint queries.
//
// CONTRACT POINTS (ports.ts):
//   * Unparseable types answer {status:'failed'} honestly — no empty
//     sidecar, no index entry pretending a spreadsheet was read.
//   * DEMO_DEFER_OVER_MB demonstrates the `deferred` lane: a first-pass file
//     over the threshold answers {status:'deferred'} (quota-style "not
//     now"); the re-submission with isRetry is then accepted, so the full
//     defer → retry → ingested loop is visible in the run ledger.
//   * The no-duplicate retry contract: documentId is stable per
//     (connectionId, remoteFileId), and a repeated documentId UPDATES —
//     the index entry is replaced, and if the file moved/renamed remotely
//     the previously written bytes+sidecar are removed. The append-only
//     manifest keeps both events, which is the point of a manifest.
//
// Accepts are serialized through an internal queue: the ingest activity runs
// a concurrent batch, and index + state persistence are read-modify-write.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import MiniSearch, { type Options as MiniSearchOptions } from 'minisearch';
import type { DocumentMeta, DocumentSink, SinkOutcome } from '@shelfmark/core';
import { extractText } from './extractText.js';

/** One options object shared by writer (sink) and reader (server search
 *  endpoint) — MiniSearch.loadJSON requires the exact same options. */
export const SEARCH_INDEX_OPTIONS = {
  idField: 'id',
  fields: ['text', 'filename', 'remotePath'],
  storeFields: ['filename', 'remotePath', 'excerpt', 'label', 'tenantId', 'connectionId', 'ingestedAt'],
} satisfies MiniSearchOptions;

export const SEARCH_INDEX_FILE = 'search-index.json';
export const MANIFEST_FILE = 'manifest.jsonl';
const STATE_FILE = 'documents.json';
const EXCERPT_CHARS = 400;

export interface FsSinkOptions {
  dataDir: string;
  /** Files strictly larger than this defer on first pass; null = never. */
  deferOverBytes?: number | null;
}

/** Where one document's current files live — kept so an update after a
 *  remote move/rename can remove the superseded copies. Paths are stored
 *  RELATIVE to dataDir so the corpus is relocatable and no absolute local
 *  path (usernames included) ever lands inside the corpus files. */
interface DocumentState {
  bytesPath: string;
  sidecarPath: string;
}

export class FsDocumentSink implements DocumentSink {
  private readonly dataDir: string;
  private readonly deferOverBytes: number | null;
  private index: MiniSearch | null = null;
  private state: Record<string, DocumentState> = {};
  private initialized = false;
  /** Serialization queue — accept() bodies never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FsSinkOptions) {
    this.dataDir = options.dataDir;
    this.deferOverBytes = options.deferOverBytes ?? null;
  }

  accept(meta: DocumentMeta, content: Buffer): Promise<SinkOutcome> {
    const run = this.queue.then(() => this.acceptSerialized(meta, content));
    // A rejection must not poison the queue for the next file.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async acceptSerialized(meta: DocumentMeta, content: Buffer): Promise<SinkOutcome> {
    await this.init();

    // The deferred lane: "not now" (quota/budget/backpressure standing in
    // as a byte threshold). Honored only on the FIRST pass — the retry
    // re-submission (isRetry) is accepted, so the ledger shows the whole
    // defer → retry → ingested story instead of a file stuck forever.
    if (this.deferOverBytes !== null && content.length > this.deferOverBytes && !meta.isRetry) {
      const outcome: SinkOutcome = {
        status: 'deferred',
        reason: `demo defer threshold: ${content.length} bytes > ${this.deferOverBytes} (DEMO_DEFER_OVER_MB); re-submit with isRetry`,
      };
      await this.appendManifest(meta, outcome);
      return outcome;
    }

    const extracted = await extractText(meta.mimetype, content);
    if (!extracted.ok) {
      // Honest failure: no bytes kept, no sidecar, no index entry — only
      // the manifest line saying exactly why.
      const outcome: SinkOutcome = { status: 'failed', error: extracted.error };
      await this.appendManifest(meta, outcome);
      return outcome;
    }

    const destDir = path.join(
      this.dataDir,
      'ingested',
      safeSegment(meta.tenantId),
      safeSegment(meta.connectionId),
      ...remotePathSegments(meta.remotePath)
    );
    const bytesPath = path.join(destDir, safeSegment(meta.filename));
    const sidecarPath = `${bytesPath}.txt`;

    // No-duplicate update: a repeated documentId whose file moved or was
    // renamed remotely gets its OLD copies removed before the new write.
    const relBytesPath = path.relative(this.dataDir, bytesPath);
    const previous = this.state[meta.documentId];
    if (previous && previous.bytesPath !== relBytesPath) {
      await fs.rm(path.resolve(this.dataDir, previous.bytesPath), { force: true });
      await fs.rm(path.resolve(this.dataDir, previous.sidecarPath), { force: true });
    }

    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(bytesPath, content);
    await fs.writeFile(sidecarPath, extracted.text, 'utf8');

    const doc = {
      id: meta.documentId,
      text: extracted.text,
      filename: meta.filename,
      remotePath: meta.remotePath,
      excerpt: extracted.text.slice(0, EXCERPT_CHARS),
      label: meta.label,
      tenantId: meta.tenantId,
      connectionId: meta.connectionId,
      ingestedAt: new Date().toISOString(),
    };
    const index = this.index!;
    if (index.has(meta.documentId)) {
      index.replace(doc); // update, never a second entry
    } else {
      index.add(doc);
    }

    this.state[meta.documentId] = {
      bytesPath: relBytesPath,
      sidecarPath: path.relative(this.dataDir, sidecarPath),
    };
    await this.persistIndexAndState();

    const outcome: SinkOutcome = { status: 'ingested' };
    await this.appendManifest(meta, outcome);
    return outcome;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    this.index = await openSearchIndex(this.dataDir).then(
      (existing) => existing ?? new MiniSearch(SEARCH_INDEX_OPTIONS)
    );
    try {
      const raw = await fs.readFile(path.join(this.dataDir, STATE_FILE), 'utf8');
      this.state = JSON.parse(raw) as Record<string, DocumentState>;
    } catch {
      this.state = {};
    }
    this.initialized = true;
  }

  private async appendManifest(meta: DocumentMeta, outcome: SinkOutcome): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), meta, outcome });
    await fs.appendFile(path.join(this.dataDir, MANIFEST_FILE), `${line}\n`, 'utf8');
  }

  private async persistIndexAndState(): Promise<void> {
    await atomicWrite(path.join(this.dataDir, SEARCH_INDEX_FILE), JSON.stringify(this.index));
    await atomicWrite(path.join(this.dataDir, STATE_FILE), JSON.stringify(this.state, null, 2));
  }
}

/** Load the persisted index, or null when nothing was ingested yet. The
 *  server's /demo/search endpoint reads through this on every query so it
 *  always sees the worker's latest persisted write. */
export async function openSearchIndex(dataDir: string): Promise<MiniSearch | null> {
  try {
    const raw = await fs.readFile(path.join(dataDir, SEARCH_INDEX_FILE), 'utf8');
    return MiniSearch.loadJSON(raw, SEARCH_INDEX_OPTIONS);
  } catch {
    return null;
  }
}

/** One path segment made filesystem-safe. Refuses traversal by construction:
 *  every byte outside [A-Za-z0-9._ -] becomes '_', and '', '.', '..'
 *  collapse to '_'. Provider-controlled names never steer the write path. */
export function safeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

function remotePathSegments(remotePath: string): string[] {
  return remotePath
    .split('/')
    .filter((s) => s !== '')
    .map(safeSegment);
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, filePath);
}
