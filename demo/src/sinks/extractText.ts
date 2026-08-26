// SPDX-License-Identifier: Apache-2.0
//
// In-process plain-text extraction shared by both demo sinks. The supported
// vocabulary tracks @shelfmark/workflows' guessMimetype exactly: pdf via
// pdf-parse, docx via mammoth, passthrough for the text-native types
// (txt/md/csv/html/json). Everything else — xlsx, pptx, octet-stream —
// is an HONEST failure ({ok:false}), never a silent empty sidecar: a demo
// corpus that pretends it read a spreadsheet is worse than one that says
// it cannot.
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The mimetypes stored as UTF-8 text verbatim — no parser involved. */
export const PASSTHROUGH_MIMETYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
]);

export type ExtractResult = { ok: true; text: string } | { ok: false; error: string };

export async function extractText(mimetype: string, content: Buffer): Promise<ExtractResult> {
  try {
    if (mimetype === 'application/pdf') {
      const parsed = await pdfParse(content);
      return { ok: true, text: parsed.text };
    }
    if (mimetype === DOCX_MIME) {
      const result = await mammoth.extractRawText({ buffer: content });
      return { ok: true, text: result.value };
    }
    if (PASSTHROUGH_MIMETYPES.has(mimetype)) {
      return { ok: true, text: content.toString('utf8') };
    }
    return { ok: false, error: `no text extractor for ${mimetype}` };
  } catch (err) {
    // A corrupt PDF / truncated DOCX lands here: a per-file failure the run
    // ledger reports, never a batch crash.
    return { ok: false, error: `extraction failed (${mimetype}): ${(err as Error).message}` };
  }
}
