// SPDX-License-Identifier: Apache-2.0
// FsDocumentSink unit tests — the sink half of the ports contract:
// happy-path txt + pdf, honest failure for unparseable types, the
// DEMO_DEFER_OVER_MB deferred lane, and the no-duplicate retry obligation.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentMeta } from '@shelfmark/core';
import { FsDocumentSink, MANIFEST_FILE, openSearchIndex } from '../src/sinks/fsSink.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'shelfmark-fssink-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function meta(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    documentId: 'doc-0000000000000000000000000000abcd',
    tenantId: 'demo',
    connectionId: 'conn-test',
    runId: 'ingest-conn-test',
    filename: 'notes.txt',
    mimetype: 'text/plain',
    size: 0,
    remotePath: '/Finance/2026',
    remoteFileId: 'item-1',
    label: 'default',
    isRetry: false,
    ...overrides,
  };
}

async function manifestLines(): Promise<{ meta: DocumentMeta; outcome: { status: string } }[]> {
  const raw = await readFile(path.join(dataDir, MANIFEST_FILE), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
}

/** A minimal but structurally valid PDF (correct xref offsets) with one
 *  page of Helvetica text — enough for pdf-parse's real parser. */
function minimalPdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // content stream, built below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

describe('FsDocumentSink', () => {
  it('accepts a txt file: bytes, sidecar, manifest line, searchable', async () => {
    const sink = new FsDocumentSink({ dataDir });
    const content = Buffer.from('hello searchable corpus about invoices', 'utf8');

    const outcome = await sink.accept(meta(), content);
    expect(outcome).toEqual({ status: 'ingested' });

    const base = path.join(dataDir, 'ingested', 'demo', 'conn-test', 'Finance', '2026');
    expect((await readFile(path.join(base, 'notes.txt'))).equals(content)).toBe(true);
    expect(await readFile(path.join(base, 'notes.txt.txt'), 'utf8')).toBe(
      'hello searchable corpus about invoices'
    );

    const lines = await manifestLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.outcome.status).toBe('ingested');
    expect(lines[0]!.meta.documentId).toBe(meta().documentId);

    const index = await openSearchIndex(dataDir);
    expect(index).not.toBeNull();
    const hits = index!.search('invoices');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(meta().documentId);
  });

  it('accepts a pdf: extracts real text into the sidecar and index', async () => {
    const sink = new FsDocumentSink({ dataDir });
    const outcome = await sink.accept(
      meta({ filename: 'report.pdf', mimetype: 'application/pdf', remoteFileId: 'item-pdf' }),
      minimalPdf('Hello shelfmark PDF')
    );
    expect(outcome).toEqual({ status: 'ingested' });

    const sidecar = await readFile(
      path.join(dataDir, 'ingested', 'demo', 'conn-test', 'Finance', '2026', 'report.pdf.txt'),
      'utf8'
    );
    expect(sidecar).toContain('Hello shelfmark PDF');

    const index = await openSearchIndex(dataDir);
    const hits = index!.search('shelfmark');
    expect(hits.map((h) => h.filename)).toContain('report.pdf');
  });

  it('answers {status:failed} honestly for unparseable types', async () => {
    const sink = new FsDocumentSink({ dataDir });
    const outcome = await sink.accept(
      meta({
        filename: 'numbers.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      Buffer.from('not really a spreadsheet')
    );
    expect(outcome.status).toBe('failed');
    expect(outcome).toHaveProperty('error', expect.stringContaining('no text extractor'));

    // Nothing stored, no index entry — only the manifest tells the story.
    await expect(
      stat(path.join(dataDir, 'ingested', 'demo', 'conn-test', 'Finance', '2026', 'numbers.xlsx'))
    ).rejects.toThrow();
    expect(await openSearchIndex(dataDir)).toBeNull();
    const lines = await manifestLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.outcome.status).toBe('failed');
  });

  it('answers {status:failed} for a corrupt pdf, not a crash', async () => {
    const sink = new FsDocumentSink({ dataDir });
    const outcome = await sink.accept(
      meta({ filename: 'broken.pdf', mimetype: 'application/pdf' }),
      Buffer.from('%PDF-1.4 this is not a real pdf body')
    );
    expect(outcome.status).toBe('failed');
  });

  it('defers over the threshold on first pass, accepts the isRetry re-submission', async () => {
    const sink = new FsDocumentSink({ dataDir, deferOverBytes: 10 });
    const big = Buffer.from('this text is definitely longer than ten bytes', 'utf8');

    const first = await sink.accept(meta(), big);
    expect(first.status).toBe('deferred');
    expect(first).toHaveProperty('reason', expect.stringContaining('DEMO_DEFER_OVER_MB'));
    // Deferred = "not now": nothing written but the manifest line.
    expect(await openSearchIndex(dataDir)).toBeNull();

    const retry = await sink.accept(meta({ isRetry: true }), big);
    expect(retry).toEqual({ status: 'ingested' });

    const lines = await manifestLines();
    expect(lines.map((l) => l.outcome.status)).toEqual(['deferred', 'ingested']);
  });

  it('updates on isRetry with the same documentId — never duplicates', async () => {
    const sink = new FsDocumentSink({ dataDir });
    const v1 = Buffer.from('first version about alpaca budgets', 'utf8');
    const v2 = Buffer.from('second version about alpaca budgets, revised', 'utf8');

    await sink.accept(meta(), v1);
    // Same document re-submitted after a remote MOVE + new content.
    const outcome = await sink.accept(meta({ isRetry: true, remotePath: '/Archive/2026' }), v2);
    expect(outcome).toEqual({ status: 'ingested' });

    // Index: still exactly one entry for the id, carrying the new location.
    const index = await openSearchIndex(dataDir);
    expect(index!.documentCount).toBe(1);
    const hits = index!.search('alpaca');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.remotePath).toBe('/Archive/2026');

    // Files: the old copies are gone, the new ones exist.
    const oldBase = path.join(dataDir, 'ingested', 'demo', 'conn-test', 'Finance', '2026');
    const newBase = path.join(dataDir, 'ingested', 'demo', 'conn-test', 'Archive', '2026');
    await expect(stat(path.join(oldBase, 'notes.txt'))).rejects.toThrow();
    await expect(stat(path.join(oldBase, 'notes.txt.txt'))).rejects.toThrow();
    expect((await readFile(path.join(newBase, 'notes.txt'))).equals(v2)).toBe(true);

    // Manifest: append-only — BOTH accepts are history.
    const lines = await manifestLines();
    expect(lines).toHaveLength(2);
  });

  it('sanitizes hostile path segments — writes stay inside the data dir', async () => {
    const sink = new FsDocumentSink({ dataDir });
    const outcome = await sink.accept(
      meta({ remotePath: '/../../etc', filename: '..' }),
      Buffer.from('escape attempt', 'utf8')
    );
    expect(outcome).toEqual({ status: 'ingested' });
    // '..' segments collapse to '_' — the write landed inside dataDir.
    const escaped = path.join(dataDir, 'ingested', 'demo', 'conn-test', '_', '_', 'etc', '_');
    expect((await readFile(escaped, 'utf8')).toString()).toBe('escape attempt');
  });
});
