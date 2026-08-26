// SPDX-License-Identifier: Apache-2.0
// Plan 34 34-S13b — the cost RANGE for step 13 ("Open and read N files"),
// computed from the default selection's extensions. Deterministic arithmetic,
// no model call, and honest about what it cannot know: `bytes ÷ 4` is
// defensible for plain text and nearly meaningless for a .docx (the plan's
// own words — 34-S13b, resolved in docs/project/design-history.md), so binary
// formats get a RANGE with a stated multiplier pair, the binary share is
// named, and the method string spells out the arithmetic so the UI renders a
// range with its provenance instead of a fake single number. Reconciliation
// against real token counts happens after parsing (step 14+), not here.

/**
 * The cost model's constants, exported as ONE frozen object so the UI's live
 * cost mirror imports the same numbers this estimator computes with — a
 * single source of truth instead of two hand-synced copies.
 */
export const COST_MODEL = Object.freeze({
  /**
   * Extensions whose bytes ARE the text — the ÷4 heuristic applies as-is.
   * Lowercased last-dot extension, the same discipline the funnel policy's
   * detection rules use (name_regex_with_extensions in @shelfmark/policy).
   */
  TEXT_LIKE_EXTENSIONS: Object.freeze(['md', 'txt', 'csv']) as readonly string[],

  /** The standard ~4-bytes-per-token prose heuristic; both ends of the range
   *  use it for the text share. */
  TEXT_BYTES_PER_TOKEN: 4,

  /**
   * Binary low end: a container format that is mostly structure and media —
   * images in a .pptx, XML scaffolding and zip compression in a .docx — can
   * yield as little as ~1 token per 50 bytes of file. Chosen as the stated
   * low-yield bound, not measured per format; the reconciliation after
   * parsing is what replaces this guess with a number that has provenance.
   */
  BINARY_BYTES_PER_TOKEN_LOW_YIELD: 50,

  /**
   * Binary high end: no format yields more extracted text than its own
   * bytes, so the ceiling is the same ÷4 as plain text. A .csv-dense .xlsx
   * approaches it; most files sit far below.
   */
  BINARY_BYTES_PER_TOKEN_HIGH_YIELD: 4,
});

/** The arithmetic, named — rendered by the UI beside the range. */
export const COST_ESTIMATE_METHOD =
  `text-like bytes (${COST_MODEL.TEXT_LIKE_EXTENSIONS.map((e) => '.' + e).join('/')}) ÷ ` +
  `${COST_MODEL.TEXT_BYTES_PER_TOKEN} per token on both ends; binary/other bytes ÷ ` +
  `${COST_MODEL.BINARY_BYTES_PER_TOKEN_LOW_YIELD} (low) to ÷ ${COST_MODEL.BINARY_BYTES_PER_TOKEN_HIGH_YIELD} (high) ` +
  'per token; ends rounded up to whole tokens; reconciled against real token counts after parsing';

/** What the estimator needs from a suggestions-ledger row: the filename
 *  (for its extension) and the byte size. */
export interface CostEstimateRow {
  name: string;
  size: number;
}

export interface IngestCostEstimate {
  textShareBytes: number;
  binaryShareBytes: number;
  /** Fraction of the selection's BYTES in binary/other formats — the share
   *  the plan says must be named. 0 for an empty selection (not NaN). */
  binaryShareOfSelection: number;
  tokenLow: number;
  tokenHigh: number;
  method: string;
}

/** Lowercased last-dot extension, or null when there is none. A file with no
 *  extension is counted in the BINARY share: its format is unknown, and the
 *  honest bucket for unknown is the wide range, not the confident one. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The honest range over the DEFAULT selection's rows (verdict 'selected' —
 * the caller filters; this function only sums). Pure and deterministic:
 * same rows in, same range out, no model call anywhere.
 *
 * `ledgerTruncated` (the ingest workers' MAX_SUGGESTION_ROWS write cap
 * having bitten) is stated in the method string when true — an estimate over
 * a partial ledger must say so rather than quietly covering a subset.
 */
export function estimateIngestCost(
  rows: CostEstimateRow[],
  opts?: { ledgerTruncated?: boolean }
): IngestCostEstimate {
  let textShareBytes = 0;
  let binaryShareBytes = 0;
  for (const row of rows) {
    const size = typeof row.size === 'number' && Number.isFinite(row.size) && row.size > 0 ? row.size : 0;
    const ext = extensionOf(row.name);
    if (ext !== null && COST_MODEL.TEXT_LIKE_EXTENSIONS.includes(ext)) {
      textShareBytes += size;
    } else {
      binaryShareBytes += size;
    }
  }
  const totalBytes = textShareBytes + binaryShareBytes;
  const textTokens = textShareBytes / COST_MODEL.TEXT_BYTES_PER_TOKEN;
  return {
    textShareBytes,
    binaryShareBytes,
    binaryShareOfSelection: totalBytes === 0 ? 0 : binaryShareBytes / totalBytes,
    tokenLow: Math.ceil(textTokens + binaryShareBytes / COST_MODEL.BINARY_BYTES_PER_TOKEN_LOW_YIELD),
    tokenHigh: Math.ceil(textTokens + binaryShareBytes / COST_MODEL.BINARY_BYTES_PER_TOKEN_HIGH_YIELD),
    method:
      COST_ESTIMATE_METHOD +
      (opts?.ledgerTruncated
        ? '; ledger truncated at its write cap — estimate covers the kept rows only'
        : ''),
  };
}
