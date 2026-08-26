// SPDX-License-Identifier: Apache-2.0
// 34-S11b — the funnel port's gate: SHA pins on the vendored artifacts, the
// cross-implementation equivalence battery over the SHARED hand-authored
// fixture (one corpus, one evaluate call — corpus-level rules are
// meaningless case-by-case), and the JRN-D1 load-refusal floor.
//
// Every expectation here is PINNED IN THIS FILE, never read from the
// artifact — the validator doctrine. Delete a rule, flip a shape's subtract,
// spell a holdback, and a test goes red naming the check.
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadArtifactClasses } from '../src/artifactClassifier.js';
import {
  FunnelPolicy,
  FunnelPolicyError,
  compareCodepoints,
  evaluateFunnel,
  loadFunnelPolicy,
  parseFunnelPolicy,
  vendoredFunnelFixturePath,
  vendoredFunnelPolicyPath,
  vendoredSelectionPolicyPath,
  type FunnelResult,
  type WalkRecord,
} from '../src/funnelPolicy.js';

/** SHA-256 pins (funnel-policy 1.0.0-rc1; fixture 1.0.0; selection-policy
 *  1.1.0-rc1). The reference Python suite pins the SAME fixture SHA — re-pin
 *  BOTH suites in the same change or not at all, and move the vendored bytes
 *  with them. */
const VENDORED_FUNNEL_POLICY_SHA256 =
  '8f41d4d1d4418ce938eb476070a9288f246738eb091898be34e2fcb869ef48be';
const VENDORED_FUNNEL_FIXTURE_SHA256 =
  '08e1eed7bb8595d3af1cafb07a66a94129a58eed4727a487580d5c872b948d99';
const VENDORED_SELECTION_POLICY_SHA256 =
  'f199bc06f37b9a340917479cebb735af912413c90f9fca9ebf239e17d2bc0ad3';

/** Pinned in this file, not read from the fixture: 61 hand-authored cases. */
const PINNED_FIXTURE_CASE_COUNT = 61;

/** The stub floor the policy must resolve from selection-policy S0. Pinned
 *  HERE as a literal: if selection-policy moves min_bytes, this pin moves in
 *  the same commit — the cross-artifact loudness the reference demands. */
const PINNED_STUB_FLOOR = 200;

/** JRN-D1 pins — the eight shapes, report-only, forever. */
const PINNED_SHAPE_IDS = [
  'bank_statement_shape',
  'credential_shape',
  'tax_shape',
  'government_identity_shape',
  'legal_shape',
  'insurance_shape',
  'pastoral_shape',
  'payroll_shape',
];

/** The pinned precedence — six named rules around the propagation step. */
const PINNED_PRECEDENCE = [
  'archived_dump_copy',
  'stub_under_200b',
  'receipt_shape',
  'machine_output_in_prose',
  'third_party_publication',
  'propagation',
  'duplicate_fingerprint',
];

/** An upstream canonical copy of the artifacts, when one is provided (set
 *  POLICY_CANONICAL_DIR to run the byte-identity drift checks against it;
 *  unset, the SHA pins above are the guard). */
const CANONICAL_DIR = process.env.POLICY_CANONICAL_DIR || '';
const CANONICAL: Array<{ vendored: string; canonical: string }> = CANONICAL_DIR
  ? [
      {
        vendored: vendoredFunnelPolicyPath(),
        canonical: join(CANONICAL_DIR, 'funnel-policy.v1.json'),
      },
      {
        vendored: vendoredFunnelFixturePath(),
        canonical: join(CANONICAL_DIR, 'funnel-equivalence.v1.jsonl'),
      },
      {
        vendored: vendoredSelectionPolicyPath(),
        canonical: join(CANONICAL_DIR, 'selection-policy.v1.json'),
      },
    ]
  : [];

interface FixtureCase extends WalkRecord {
  expected_verdict: string;
  expected_shapes: string[];
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rawPolicy(): Record<string, any> {
  return JSON.parse(readFileSync(vendoredFunnelPolicyPath(), 'utf8'));
}
function rawSelection(): Record<string, any> {
  return JSON.parse(readFileSync(vendoredSelectionPolicyPath(), 'utf8'));
}
function parse(mutated: unknown, selection: unknown = rawSelection()): FunnelPolicy {
  return parseFunnelPolicy(mutated, selection, 'test', 'sha-test');
}

describe('vendored funnel artifacts: SHA pins and upstream drift', () => {
  it("the vendored funnel-policy's SHA-256 must match its pin, so a rule edit is always deliberate", () => {
    expect(sha256Of(vendoredFunnelPolicyPath())).toBe(VENDORED_FUNNEL_POLICY_SHA256);
  });

  it("the vendored fixture's SHA-256 must match the pin the reference suite shares, so the two suites can only drift loudly", () => {
    expect(sha256Of(vendoredFunnelFixturePath())).toBe(VENDORED_FUNNEL_FIXTURE_SHA256);
  });

  it("the vendored selection-policy's SHA-256 must match its pin (the stub floor's single home)", () => {
    expect(sha256Of(vendoredSelectionPolicyPath())).toBe(VENDORED_SELECTION_POLICY_SHA256);
  });

  it('matches the canonical copies byte-for-byte when a canonical checkout is provided', () => {
    if (CANONICAL.length === 0) {
      // Deliberately not silent: the SHA pins above still bite
      // unconditionally.
      console.warn(
        '[funnelPolicy.test] no canonical checkout provided (POLICY_CANONICAL_DIR) — drift check not run here; the SHA pins still apply'
      );
      return;
    }
    for (const { vendored, canonical } of CANONICAL) {
      if (!existsSync(canonical)) {
        console.warn(
          `[funnelPolicy.test] canonical file not present at ${canonical} — drift check not run here; the SHA pin still applies`
        );
        continue;
      }
      expect(readFileSync(vendored).equals(readFileSync(canonical)), vendored).toBe(true);
    }
  });
});

describe('funnel policy load: what the vendored artifact must say', () => {
  it('loads the vendored copy, exposing version, SHA and the referenced stub floor', () => {
    const policy = loadFunnelPolicy();
    expect(policy.version).toBe('1.0.0-rc1');
    expect(policy.sha256).toBe(VENDORED_FUNNEL_POLICY_SHA256);
    expect(policy.candidateClass).toBe('human_prose');
    expect(policy.classificationVersion).toBe('1.0.0-rc2');
    // The floor is RESOLVED from selection-policy (S0), never duplicated in
    // the funnel artifact; the literal here is this suite's own pin.
    expect(policy.stubFloor).toBe(PINNED_STUB_FLOOR);
    expect([...policy.shapeIds]).toEqual(PINNED_SHAPE_IDS);
    expect(policy.collapseRuleId).toBe('duplicate_fingerprint');
    expect(policy.perItemRules.map((r) => r.id)).toEqual(PINNED_PRECEDENCE.slice(0, 5));
  });
});

describe('JRN-D1 and schema refusals at load — each mutation caught by name', () => {
  it('refuses a sensitive shape whose subtract is not the literal NEVER', () => {
    const doc = rawPolicy();
    doc.sensitive_shape_rules.shapes[7].subtract = 'when_asked';
    expect(() => parse(doc)).toThrowError(/JRN-D1 violation: shape 'payroll_shape'/);
  });

  it('refuses a sensitive shape whose report is not true', () => {
    const doc = rawPolicy();
    doc.sensitive_shape_rules.shapes[0].report = false;
    expect(() => parse(doc)).toThrowError(/JRN-D1 violation: shape 'bank_statement_shape'/);
  });

  it('refuses the top-level sensitive subtract flipped away from NEVER', () => {
    const doc = rawPolicy();
    doc.sensitive_shape_rules.subtract = 'SOMETIMES';
    expect(() => parse(doc)).toThrowError(/sensitive_shape_rules.subtract must be the literal 'NEVER'/);
  });

  it('refuses a holdback spelling as an object KEY anywhere in the document', () => {
    const doc = rawPolicy();
    doc.never_suggest = ['anything'];
    expect(() => parse(doc)).toThrowError(/JRN-D1 violation: key 'never_suggest'/);
  });

  it('refuses a holdback spelling as a RULE ID — the exact hole the reference battery caught (keys checked, ids not)', () => {
    const doc = rawPolicy();
    doc.subtraction_rules[2].id = 'askFirst_receipts';
    expect(() => parse(doc)).toThrowError(/rule id 'askFirst_receipts' spells a holdback/);
  });

  it('refuses a sensitive shape id appearing among subtraction_rules', () => {
    const doc = rawPolicy();
    doc.subtraction_rules[2].id = 'payroll_shape';
    expect(() => parse(doc)).toThrowError(/'payroll_shape' is a sensitive shape/);
  });

  it('refuses an unknown detection kind — fail closed, never skip a rule', () => {
    const doc = rawPolicy();
    doc.subtraction_rules[3].detection.kind = 'content_probe';
    expect(() => parse(doc)).toThrowError(/unknown detection kind "content_probe"/);
  });

  it('refuses a literal floor smuggled in beside floor_from (the bound has one home)', () => {
    const doc = rawPolicy();
    doc.subtraction_rules[1].detection.floor = 150;
    expect(() => parse(doc)).toThrowError(/literal floor beside floor_from/);
  });

  it('refuses a fingerprint collapse that is not the LAST rule', () => {
    const doc = rawPolicy();
    const rules = doc.subtraction_rules as any[];
    const collapse = rules.pop();
    rules.unshift(collapse);
    expect(() => parse(doc)).toThrowError(/must be the LAST rule/);
  });

  it('refuses a policy with no fingerprint collapse at all', () => {
    const doc = rawPolicy();
    doc.subtraction_rules = (doc.subtraction_rules as any[]).slice(0, -1);
    expect(() => parse(doc)).toThrowError(/no fingerprint_collapse rule/);
  });

  it('refuses a precedence list that disagrees with the rule order', () => {
    const doc = rawPolicy();
    doc.precedence = [...PINNED_PRECEDENCE].reverse();
    expect(() => parse(doc)).toThrowError(/precedence .* disagrees/);
  });

  it('refuses a flipped propagation asymmetry — location evidence must never reach across fingerprints', () => {
    const doc = rawPolicy();
    doc.propagation.propagates_scopes = ['location'];
    doc.propagation.never_propagates_scopes = ['document'];
    expect(() => parse(doc)).toThrowError(/propagation asymmetry violated/);
  });
});

describe('funnel equivalence over the shared fixture — one corpus, one evaluate() call', () => {
  let cases: FixtureCase[] = [];
  let result: FunnelResult;

  beforeAll(() => {
    const lines = readFileSync(vendoredFunnelFixturePath(), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    // The leading metadata record carries a 'fixture' key and no 'name' —
    // both suites MUST skip it (fixture contract).
    expect(lines[0].fixture).toBe('funnel-equivalence');
    expect(lines[0].name).toBeUndefined();
    cases = lines.slice(1) as FixtureCase[];
    result = evaluateFunnel(cases, loadFunnelPolicy(), loadArtifactClasses());
  });

  it(`carries exactly ${PINNED_FIXTURE_CASE_COUNT} cases with exactly the published keys`, () => {
    expect(cases.length).toBe(PINNED_FIXTURE_CASE_COUNT);
    const required = ['name', 'is_folder', 'path', 'size', 'expected_verdict', 'expected_shapes'];
    const optional = ['artifact_class', 'class_rule'];
    for (const c of cases) {
      for (const k of required) expect(Object.keys(c), c.path as string).toContain(k);
      for (const k of Object.keys(c)) {
        expect([...required, ...optional], `unexpected key ${k} on ${c.path}`).toContain(k);
      }
    }
  });

  it('agrees with every hand-authored (verdict, shapes) pair — 61/61, zero divergences', () => {
    for (const c of cases) {
      const key = (c.path || c.name || '') as string;
      if (c.expected_verdict === 'not_walked_folder') {
        // The sentinel outside the grammar: folders never enter the funnel,
        // so the evaluator must emit NO verdict for them at all.
        expect(result.verdicts[key], key).toBeUndefined();
        continue;
      }
      const got = result.verdicts[key];
      expect(got, `no verdict emitted for ${key}`).toBeDefined();
      expect(got!.verdict, key).toBe(c.expected_verdict);
      expect(got!.shapes, key).toEqual(c.expected_shapes);
    }
  });

  it('ignores recorded walk-time class fields — classes are recomputed, never trusted', () => {
    // The fixture's design-notes.md case carries a deliberately WRONG
    // recorded artifact_class ('media'); re-classification must land it
    // selected. Already covered by the loop above, pinned here by name so a
    // regression says what it broke.
    expect(result.verdicts['code/projx/design-notes.md']!.verdict).toBe('selected');
  });

  it('reports sensitive shapes as counts over candidates AND the default selection, subtracting nothing', () => {
    // Hand-countable from the fixture: candidates carrying each shape /
    // still standing in the default. The archived AcmeBank copy keeps its
    // shape while subtracted (report counts candidates too); the tax-shaped
    // stub is subtracted for SIZE, never for shape.
    expect(result.sensitive_shape_report['bank_statement_shape']).toEqual({
      candidates: 3,
      default_selection: 2,
    });
    expect(result.sensitive_shape_report['tax_shape']).toEqual({
      candidates: 3,
      default_selection: 2,
    });
    expect(result.sensitive_shape_report['government_identity_shape']).toEqual({
      candidates: 2,
      default_selection: 2,
    });
    expect(result.sensitive_shape_report['payroll_shape']).toEqual({
      candidates: 1,
      default_selection: 1,
    });
    // No shape id ever appears as a subtraction row.
    for (const row of result.subtractions) {
      expect(PINNED_SHAPE_IDS).not.toContain(row.rule);
    }
  });

  it('reconciles: candidates minus the named subtraction rows equals the default selection, files and bytes', () => {
    const subFiles = result.subtractions.reduce((a, r) => a + r.files, 0);
    const subBytes = result.subtractions.reduce((a, r) => a + r.bytes, 0);
    expect(result.candidates.files - subFiles).toBe(result.default_selection.files);
    expect(result.candidates.bytes - subBytes).toBe(result.default_selection.bytes);
    expect(result.subtractions.map((r) => r.rule)).toEqual(PINNED_PRECEDENCE);
  });

  it('is deterministic under record shuffle — same corpus, same verdicts', () => {
    const reversed = [...cases].reverse();
    const again = evaluateFunnel(reversed, loadFunnelPolicy(), loadArtifactClasses());
    expect(again.verdicts).toEqual(result.verdicts);
    expect(again.subtractions).toEqual(result.subtractions);
    expect(again.default_selection).toEqual(result.default_selection);
  });
});

describe('evaluate-time refusals and the propagation edges', () => {
  it('refuses a classifier whose version differs from the policy pin — a stale classification cannot masquerade as a funnel', () => {
    const policy = loadFunnelPolicy();
    const fakeClassifier = { version: '0.9.9', classify: () => ({ classId: 'human_prose', rule: 'x' }) };
    expect(() => evaluateFunnel([], policy, fakeClassifier as any)).toThrowError(
      /classifier is 0\.9\.9, policy pins 1\.0\.0-rc2/
    );
    expect(() => evaluateFunnel([], policy, fakeClassifier as any)).toThrowError(FunnelPolicyError);
  });

  it('emits subtracted:propagated_from:<rule> when a PATH-dependent document rule hits one copy — v1 rules are fingerprint-invariant, so the edge needs a synthetic rule (same construction as the reference battery)', () => {
    const doc = rawPolicy();
    // A document-scoped rule that reads PATH evidence: same detection kind as
    // archived_dump_copy, but document scope — exactly what a future
    // "quarantine folder" rule would look like.
    doc.subtraction_rules.splice(5, 0, {
      id: 'synthetic_path_document_rule',
      scope: 'document',
      detection: {
        kind: 'ancestor_order',
        first: '^quarantine$',
        then: '^inbox$',
      },
      rationale: 'battery-only synthetic rule',
      cannot_detect: 'n/a',
    });
    doc.precedence = [
      'archived_dump_copy',
      'stub_under_200b',
      'receipt_shape',
      'machine_output_in_prose',
      'third_party_publication',
      'synthetic_path_document_rule',
      'propagation',
      'duplicate_fingerprint',
    ];
    const policy = parse(doc);
    const records: WalkRecord[] = [
      { name: 'memo.md', is_folder: false, path: 'quarantine/inbox/memo.md', size: 4096 },
      { name: 'memo.md', is_folder: false, path: 'Documents/memo.md', size: 4096 },
    ];
    const res = evaluateFunnel(records, policy, loadArtifactClasses());
    expect(res.verdicts['quarantine/inbox/memo.md']!.verdict).toBe(
      'subtracted:synthetic_path_document_rule'
    );
    // The fingerprint-identical copy OUTSIDE the quarantine tree is reached
    // by propagation, attributed to its source rule.
    expect(res.verdicts['Documents/memo.md']!.verdict).toBe(
      'subtracted:propagated_from:synthetic_path_document_rule'
    );
    expect(res.subtractions.find((r) => r.rule === 'propagation')).toEqual({
      rule: 'propagation',
      files: 1,
      bytes: 4096,
    });
  });

  it('never propagates a LOCATION-scoped subtraction — the archived copy dies where it sits, the live original stands', () => {
    // Pinned by the fixture's old plan.md trio inside the corpus run; pinned
    // again here in isolation so the edge has its own named test.
    const records: WalkRecord[] = [
      { name: 'old plan.md', is_folder: false, path: 'code/archive_2024_backup/Downloads/old plan.md', size: 2048 },
      { name: 'old plan.md', is_folder: false, path: 'Documents/personalDownloads/old plan.md', size: 2048 },
    ];
    const res = evaluateFunnel(records, loadFunnelPolicy(), loadArtifactClasses());
    expect(res.verdicts['code/archive_2024_backup/Downloads/old plan.md']!.verdict).toBe(
      'subtracted:archived_dump_copy'
    );
    // Sole standing member of its fingerprint group: no duplicate, no
    // propagation — SELECTED.
    expect(res.verdicts['Documents/personalDownloads/old plan.md']!.verdict).toBe('selected');
    expect(res.subtractions.find((r) => r.rule === 'propagation')).toEqual({
      rule: 'propagation',
      files: 0,
      bytes: 0,
    });
  });
});

describe('compareCodepoints — the determinism-bearing comparator', () => {
  it('orders by codepoint, not locale and not case-folded ("D" 0x44 before "c" 0x63)', () => {
    expect(compareCodepoints('Documents/notes/Overview.md', 'code/misc/overview.md')).toBeLessThan(0);
    expect(compareCodepoints('a', 'a')).toBe(0);
    expect(compareCodepoints('ab', 'a')).toBeGreaterThan(0);
  });
});
