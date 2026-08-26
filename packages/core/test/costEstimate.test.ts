// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { COST_MODEL, estimateIngestCost } from '../src/costEstimate.js';

// 34-S13b — the arithmetic pinned BY HAND. Expected numbers below are
// computed from the stated method (text ÷ 4; binary ÷ 50 low, ÷ 4 high;
// ceil), never by calling the function under test with itself.

describe('estimateIngestCost (34-S13b)', () => {
  it('pins the divisors themselves — a silently retuned multiplier is a contract change, not a tweak', () => {
    expect(COST_MODEL.TEXT_BYTES_PER_TOKEN).toBe(4);
    expect(COST_MODEL.BINARY_BYTES_PER_TOKEN_LOW_YIELD).toBe(50);
    expect(COST_MODEL.BINARY_BYTES_PER_TOKEN_HIGH_YIELD).toBe(4);
    // The UI's live cost mirror imports COST_MODEL — the extension list is
    // part of the same contract as the divisors.
    expect(COST_MODEL.TEXT_LIKE_EXTENSIONS).toEqual(['md', 'txt', 'csv']);
  });

  it('splits text-like from binary by lowercased last-dot extension and quotes the range', () => {
    const est = estimateIngestCost([
      { name: 'notes.md', size: 400 }, // text: 100 tokens
      { name: 'REPORT.TXT', size: 200 }, // text (case-insensitive): 50 tokens
      { name: 'deck.pptx', size: 1000 }, // binary: 20..250
    ]);

    expect(est.textShareBytes).toBe(600);
    expect(est.binaryShareBytes).toBe(1000);
    expect(est.binaryShareOfSelection).toBe(1000 / 1600);
    expect(est.tokenLow).toBe(170); // 150 + 1000/50
    expect(est.tokenHigh).toBe(400); // 150 + 1000/4
  });

  it('a file with no extension, and a dotfile, land in the BINARY share — unknown formats get the wide range, not the confident one', () => {
    const est = estimateIngestCost([
      { name: 'README', size: 100 },
      { name: '.gitignore', size: 100 },
      { name: 'trailingdot.', size: 100 },
    ]);
    expect(est.textShareBytes).toBe(0);
    expect(est.binaryShareBytes).toBe(300);
  });

  it('an empty selection is all zeros with share 0 — never NaN', () => {
    const est = estimateIngestCost([]);
    expect(est).toMatchObject({
      textShareBytes: 0,
      binaryShareBytes: 0,
      binaryShareOfSelection: 0,
      tokenLow: 0,
      tokenHigh: 0,
    });
  });

  it('rounds both ends UP to whole tokens', () => {
    // 401 text bytes -> 100.25 -> 101; 3 binary bytes -> +0.06 low / +0.75 high.
    const est = estimateIngestCost([
      { name: 'a.txt', size: 401 },
      { name: 'b.bin', size: 3 },
    ]);
    expect(est.tokenLow).toBe(101); // ceil(100.25 + 0.06)
    expect(est.tokenHigh).toBe(101); // ceil(100.25 + 0.75)
  });

  it('treats a missing/negative/NaN size as 0 bytes rather than corrupting the sums', () => {
    const est = estimateIngestCost([
      { name: 'a.txt', size: -50 },
      { name: 'b.txt', size: Number.NaN },
      { name: 'c.txt', size: 400 },
    ]);
    expect(est.textShareBytes).toBe(400);
    expect(est.tokenLow).toBe(100);
  });

  it('the method string names the arithmetic — provenance rides the number', () => {
    const est = estimateIngestCost([{ name: 'a.md', size: 4 }]);
    expect(est.method).toContain('.md/.txt/.csv');
    expect(est.method).toContain('÷ 4');
    expect(est.method).toContain('÷ 50');
    expect(est.method).toContain('reconciled against real token counts after parsing');
    expect(est.method).not.toContain('truncated');
  });

  it('states it when the estimate covers a truncated ledger — a partial-coverage estimate must say so', () => {
    const est = estimateIngestCost([{ name: 'a.md', size: 4 }], { ledgerTruncated: true });
    expect(est.method).toContain('ledger truncated at its write cap — estimate covers the kept rows only');
  });

  it('is deterministic: same rows, same range, no model call anywhere', () => {
    const rows = [
      { name: 'a.md', size: 123 },
      { name: 'b.docx', size: 4567 },
    ];
    expect(estimateIngestCost(rows)).toEqual(estimateIngestCost(rows));
  });
});
