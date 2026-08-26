// SPDX-License-Identifier: Apache-2.0
// 34-S11b — the TypeScript PORT of the default-selection funnel evaluator.
//
// ══ THE ARTIFACT IS NORMATIVE; THIS FILE IS A PORT ══════════════════════════
//
// The rules are DATA, loaded from funnel-policy.v1.json (vendored in this
// package at vendor/). Nothing in this file hardcodes a rule, a regex, a
// floor, or a shape. The rule set was authored against a reference Python
// implementation, and the shared fixture (funnel-equivalence.v1.jsonl,
// vendored beside the artifact under the identical SHA-256 pin) asserts that
// the two implementations agree on (verdict, shapes) PAIRS over one corpus —
// the classifier-port discipline (25B §2.3), applied to the funnel: two
// implementations of one rule set must not diverge silently.
//
// The stub floor is NOT in the funnel artifact: stub_under_200b resolves it
// from selection-policy.v1.json#/parameters/min_bytes BY REFERENCE (the
// number has exactly one home — S0_has_substance). That is why
// selection-policy.v1.json is vendored too, under the same pin discipline.
//
// ══ JRN-D1, ENFORCED AT LOAD (owner, 2026-08-19) ════════════════════════════
//
// The funnel carries NO never-suggest category. Every sensitive shape rule
// must say report: true and subtract: "NEVER"; any holdback spelling
// (never_suggest / ask_first / hold_back and their squashed forms) as an
// object key OR a rule id refuses to LOAD here — same floor as the reference
// evaluator, which checks BOTH keys and rule ids (the rule-id half was a
// real hole its battery caught mid-build; this port keeps both halves).
//
// ══ WHAT THIS FILE NEVER DOES ═══════════════════════════════════════════════
//
// Read a file's CONTENT. It is handed observed metadata records and returns
// verdicts. It also never TRUSTS a walk record's recorded class fields —
// every record is re-classified through artifactClassifier under the version
// the policy pins, and a version mismatch refuses to evaluate.
//
// ══ PORTING NOTES (divergence-prone corners, pinned by the fixture) ═════════
//
//  * String order is CODEPOINT order everywhere (Python str comparison).
//    JS default string compare is UTF-16 code-unit order, which differs for
//    astral-plane characters — so every determinism-bearing comparison here
//    goes through compareCodepoints(), never `<` on raw strings.
//  * Regexes compile with the `i` flag only (Python re.I). Documented limit,
//    preserved as written: Python's `\d` matches Unicode digits where JS's is
//    ASCII-only — unreachable on the fixture and on real Graph names, and if
//    it ever matters it is an ARTIFACT+fixture change, never a silent fix.
//  * ancestor_order is min(first-match idx) < max(then-match idx) — the
//    fixture's resolution note pins the deep-nesting reading explicitly.
//  * fingerprint_collapse is applied LAST over survivors; keeper is the
//    fewest-'/'-components path, tie broken on raw path codepoints, then id.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { ArtifactClasses } from './artifactClassifier.js';

/** This module's directory, resolved for both build formats (same guard as
 *  the classifier: CJS has __dirname, ESM derives it). */
const moduleDir: string =
  typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));

/** The evaluator's own schema floor for JRN-D1 — byte-for-byte the reference
 *  implementation's list. These fragments may not appear as an object key or
 *  a rule id anywhere in the policy. */
export const FORBIDDEN_FRAGMENTS = [
  'never_suggest',
  'neversuggest',
  'ask_first',
  'askfirst',
  'hold_back',
  'holdback',
] as const;

const DETECTION_KINDS = new Set([
  'ancestor_order',
  'size_under',
  'name_regex',
  'name_regex_with_extensions',
  'fingerprint_collapse',
]);

/** The policy violates its own schema. Refuse to evaluate — a funnel run
 *  under a malformed policy is a number with no provenance. */
export class FunnelPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunnelPolicyError';
  }
}

/** One walk record as the evaluator reads it — the same field names the
 *  reference implementation and the fixture use. Extra fields (a walk's
 *  RECORDED artifact_class/class_rule, for instance) are carried and
 *  IGNORED: classes are recomputed, never trusted. */
export interface WalkRecord {
  name?: string;
  is_folder?: boolean;
  path?: string;
  size?: number;
  id?: string;
  [key: string]: unknown;
}

export interface FunnelRollup {
  files: number;
  bytes: number;
}

export interface FunnelVerdict {
  verdict: string;
  shapes: string[];
}

export interface FunnelResult {
  candidates: FunnelRollup;
  subtractions: { rule: string; files: number; bytes: number }[];
  default_selection: FunnelRollup;
  sensitive_shape_report: Record<string, { candidates: number; default_selection: number }>;
  verdicts: Record<string, FunnelVerdict>;
}

// ── Codepoint-order string comparison (Python str `<`) ──────────────────────
export function compareCodepoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}

function ancestorsOf(path: string): string[] {
  // Python: (path or "").split("/")[:-1] — the item's own trailing segment is
  // not an ancestor; empties are preserved exactly as the reference does.
  return (path || '').split('/').slice(0, -1);
}

function extOf(name: string): string {
  // Python: name.rsplit(".", 1)[-1].lower() if "." in name else ""
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
}

function* walkKeys(obj: unknown, trail = ''): Generator<{ trail: string; key: string }> {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) yield* walkKeys(obj[i], `${trail}[${i}]`);
  } else if (obj !== null && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      yield { trail: `${trail}/${k}`, key: k };
      yield* walkKeys(v, `${trail}/${k}`);
    }
  }
}

type CompiledDetection =
  | { kind: 'ancestor_order'; first: RegExp; then: RegExp }
  | { kind: 'size_under'; floor: number }
  | { kind: 'name_regex'; regex: RegExp }
  | { kind: 'name_regex_with_extensions'; regex: RegExp; extensions: Set<string> }
  | { kind: 'fingerprint_collapse' };

interface CompiledRule {
  id: string;
  scope: string;
  kind: string;
  detection: CompiledDetection;
}

/**
 * The ONLY place this module turns artifact text into a RegExp.
 *
 * Static analyzers flag `new RegExp(<non-literal>)` as a ReDoS risk, and in
 * general they are right to. Two things make it safe here, and one of them
 * needed code rather than an argument:
 *
 *  1. The PATTERN is not user input. It comes from funnel-policy.v1.json,
 *     vendored and SHA-pinned by the test suite — changing a pattern means
 *     moving a pinned hash, which is a reviewed act, not an attack.
 *  2. The INPUT is untrusted: these run over customer file names. So a
 *     pathological pattern authored in good faith could still hang a worker
 *     on a crafted name, and an argument about provenance would not help.
 *     The source is therefore bounded HERE, at load.
 *
 * Refusing at load is the important half. The artifact is governed data, and
 * a governed artifact that cannot load is a loud red gate — which is the
 * outcome this design wants over a worker pinned at 100% CPU by a filename.
 */
const MAX_POLICY_PATTERN_LENGTH = 512;

/** Nested quantifiers — `(a+)+`, `(a*)*` — the classic catastrophic
 *  backtracking shapes. Conservative on purpose: it refuses some innocent
 *  patterns too, and that costs a reviewer one rewording rather than costing
 *  a customer an outage. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/;

function compilePolicyRegex(pattern: unknown, where: string): RegExp {
  const src = String(pattern ?? '');
  if (src === '') {
    throw new FunnelPolicyError(`${where}: regex is empty`);
  }
  if (src.length > MAX_POLICY_PATTERN_LENGTH) {
    throw new FunnelPolicyError(
      `${where}: regex is ${src.length} chars, over the ${MAX_POLICY_PATTERN_LENGTH} ceiling`
    );
  }
  if (NESTED_QUANTIFIER.test(src)) {
    throw new FunnelPolicyError(`${where}: regex has a nested quantifier, refused as a ReDoS risk`);
  }
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(src, 'i');
}

/**
 * The loaded, SHA-pinned funnel artifact. A port of the reference
 * implementation's FunnelPolicy class — same load-time refusals in the same
 * order, so a malformed artifact fails BY THE SAME NAME on both sides.
 */
export class FunnelPolicy {
  readonly version: string;
  readonly sha256: string;
  readonly source: string;
  readonly candidateClass: string;
  readonly classificationVersion: string;
  readonly shapeIds: readonly string[];
  readonly collapseRuleId: string;
  /** The resolved stub floor — selection-policy's min_bytes, REFERENCED. */
  readonly stubFloor: number;

  private readonly shapes: { id: string; regex: RegExp }[];
  private readonly rules: CompiledRule[];

  constructor(rawPolicy: unknown, rawSelection: unknown, source: string, sha256: string) {
    const doc = rawPolicy as Record<string, any>;
    this.source = source;
    this.sha256 = sha256;
    this.version = String(doc?.version ?? '');
    if (!this.version) throw new FunnelPolicyError('funnel-policy: missing `version`');

    // ── JRN-D1, enforced at load: no holdback spelling as ANY object key ────
    for (const { trail, key } of walkKeys(doc)) {
      const low = String(key).toLowerCase();
      for (const frag of FORBIDDEN_FRAGMENTS) {
        if (low.includes(frag)) {
          throw new FunnelPolicyError(
            `JRN-D1 violation: key '${key}' at ${trail} — the funnel carries no ` +
              'never-suggest/ask-first category, by owner decision 2026-08-19. ' +
              'Sensitive shapes are reported, never gated.'
          );
        }
      }
    }
    const ssr = doc['sensitive_shape_rules'];
    if (ssr?.subtract !== 'NEVER') {
      throw new FunnelPolicyError(
        `JRN-D1 violation: sensitive_shape_rules.subtract must be the literal 'NEVER', got ${JSON.stringify(
          ssr?.subtract
        )}`
      );
    }
    this.shapes = [];
    for (const sh of ssr['shapes'] as Record<string, any>[]) {
      if (sh?.subtract !== 'NEVER' || sh?.report !== true) {
        throw new FunnelPolicyError(
          `JRN-D1 violation: shape '${sh?.id}' must carry report: true and subtract: 'NEVER' — ` +
            'a subtracting sensitive rule is the retired survey design'
        );
      }
      const det = sh['detection'];
      if (det?.kind !== 'name_or_ancestor_regex') {
        throw new FunnelPolicyError(
          `shape '${sh['id']}': detection kind must be name_or_ancestor_regex, got ${JSON.stringify(
            det?.kind
          )}`
        );
      }
      const shapeId = String(sh['id']);
      this.shapes.push({ id: shapeId, regex: compilePolicyRegex(det['regex'], `shape '${shapeId}'`) });
    }
    this.shapeIds = this.shapes.map((s) => s.id);
    if (new Set(this.shapeIds).size !== this.shapeIds.length) {
      throw new FunnelPolicyError('duplicate sensitive shape ids');
    }

    // ── subtraction rules ───────────────────────────────────────────────────
    this.rules = [];
    let collapse: string | null = null;
    for (const rule of doc['subtraction_rules'] as Record<string, any>[]) {
      const rid = String(rule['id']);
      const scope = String(rule['scope']);
      const det = rule['detection'] as Record<string, any>;
      for (const frag of FORBIDDEN_FRAGMENTS) {
        if (rid.toLowerCase().includes(frag)) {
          throw new FunnelPolicyError(
            `JRN-D1 violation: rule id '${rid}' spells a holdback — the funnel carries no ` +
              'never-suggest/ask-first category, by owner decision 2026-08-19'
          );
        }
      }
      if (this.shapeIds.includes(rid)) {
        throw new FunnelPolicyError(
          `JRN-D1 violation: '${rid}' is a sensitive shape and may not appear among subtraction_rules`
        );
      }
      const kind = String(det['kind']);
      if (!DETECTION_KINDS.has(kind)) {
        throw new FunnelPolicyError(
          `rule '${rid}': unknown detection kind ${JSON.stringify(kind)} — an unrecognised rule ` +
            'must fail closed, never be skipped'
        );
      }
      if (kind === 'fingerprint_collapse') {
        if (collapse !== null) throw new FunnelPolicyError('two fingerprint_collapse rules');
        if (scope !== 'corpus') {
          throw new FunnelPolicyError(`rule '${rid}': collapse scope must be corpus`);
        }
        if (JSON.stringify(det['fields']) !== JSON.stringify(['name_lower', 'size_exact'])) {
          throw new FunnelPolicyError(
            `rule '${rid}': fingerprint fields must be ['name_lower','size_exact'], got ${JSON.stringify(
              det['fields']
            )}`
          );
        }
        if (det['keep'] !== 'shallowest_path' || det['keeper_tie_break'] !== 'lexicographic_path_codepoints') {
          throw new FunnelPolicyError(
            `rule '${rid}': keeper must be shallowest_path with lexicographic_path_codepoints tie-break`
          );
        }
        collapse = rid;
        this.rules.push({ id: rid, scope, kind, detection: { kind: 'fingerprint_collapse' } });
        continue;
      }
      if (scope !== 'location' && scope !== 'document') {
        throw new FunnelPolicyError(`rule '${rid}': scope must be location|document`);
      }
      let detection: CompiledDetection;
      if (kind === 'ancestor_order') {
        detection = {
          kind,
          first: compilePolicyRegex(det['first'], `rule '${rid}' first`),
          then: compilePolicyRegex(det['then'], `rule '${rid}' then`),
        };
      } else if (kind === 'size_under') {
        const ptr = String(det['floor_from'] ?? '');
        if ('floor' in det && typeof det['floor'] === 'number') {
          throw new FunnelPolicyError(
            `rule '${rid}': carries a literal floor beside floor_from — the bound lives in ` +
              'selection-policy (S0) and is referenced, never duplicated'
          );
        }
        if (!ptr.startsWith('selection-policy.v1.json#/parameters/min_bytes')) {
          throw new FunnelPolicyError(
            `rule '${rid}': floor_from must reference selection-policy.v1.json#/parameters/min_bytes`
          );
        }
        const sel = rawSelection as Record<string, any>;
        const floor = sel?.['parameters']?.['min_bytes'];
        if (!Number.isInteger(floor)) {
          throw new FunnelPolicyError('resolved min_bytes is not an integer');
        }
        detection = { kind, floor: floor as number };
      } else if (kind === 'name_regex') {
        detection = { kind, regex: compilePolicyRegex(det['regex'], `rule '${rid}'`) };
      } else {
        detection = {
          kind: 'name_regex_with_extensions',
          regex: compilePolicyRegex(det['regex'], `rule '${rid}'`),
          extensions: new Set((det['extensions'] as string[]).map((e) => String(e).toLowerCase())),
        };
      }
      this.rules.push({ id: rid, scope, kind, detection });
    }
    if (collapse === null) {
      throw new FunnelPolicyError(
        'no fingerprint_collapse rule — the funnel must own its dedupe or 4,022 copies re-enter'
      );
    }
    if (this.rules[this.rules.length - 1]!.id !== collapse) {
      throw new FunnelPolicyError(
        'fingerprint_collapse must be the LAST rule: it judges the survivors of every other rule'
      );
    }
    this.collapseRuleId = collapse;

    // ── precedence is the single order; the rule list must equal it ─────────
    const prec = doc['precedence'] as string[];
    const want = [
      ...this.rules.slice(0, -1).map((r) => r.id),
      'propagation',
      collapse,
    ];
    if (JSON.stringify(prec) !== JSON.stringify(want)) {
      throw new FunnelPolicyError(
        `precedence ${JSON.stringify(prec)} disagrees with subtraction_rules order ${JSON.stringify(want)}`
      );
    }

    const prop = doc['propagation'] as Record<string, any>;
    if (
      JSON.stringify(prop?.['propagates_scopes']) !== JSON.stringify(['document']) ||
      JSON.stringify(prop?.['never_propagates_scopes']) !== JSON.stringify(['location'])
    ) {
      throw new FunnelPolicyError(
        'propagation asymmetry violated: document-scoped subtractions propagate across ' +
          'fingerprint-identical copies, location-scoped never do — a false negative leaks a ' +
          'bank statement, a false positive loses a recoverable document'
      );
    }

    const cand = doc['candidates'] as Record<string, any>;
    this.candidateClass = String(cand['class']);
    this.classificationVersion = String(cand['classification_version']);
    const stubRule = this.rules.find((r) => r.kind === 'size_under');
    this.stubFloor = stubRule && stubRule.detection.kind === 'size_under' ? stubRule.detection.floor : 0;
  }

  /** Non-collapse rules in precedence order, for the evaluator. */
  get perItemRules(): readonly CompiledRule[] {
    return this.rules.filter((r) => r.kind !== 'fingerprint_collapse');
  }

  ruleMatches(rid: string, rec: WalkRecord): boolean {
    const rule = this.rules.find((r) => r.id === rid);
    if (!rule) throw new FunnelPolicyError(`unknown rule id '${rid}'`);
    const name = rec.name || '';
    const det = rule.detection;
    if (det.kind === 'ancestor_order') {
      const segs = ancestorsOf(rec.path || '');
      const fi: number[] = [];
      const ti: number[] = [];
      for (let i = 0; i < segs.length; i++) {
        if (det.first.test(segs[i]!)) fi.push(i);
        if (det.then.test(segs[i]!)) ti.push(i);
      }
      return fi.length > 0 && ti.length > 0 && Math.min(...fi) < Math.max(...ti);
    }
    if (det.kind === 'size_under') return (rec.size ?? 0) < det.floor;
    if (det.kind === 'name_regex') return det.regex.test(name);
    if (det.kind === 'name_regex_with_extensions') {
      return det.extensions.has(extOf(name)) && det.regex.test(name);
    }
    return false; // fingerprint_collapse is corpus-level, never per-item
  }

  /** Sensitive shape ids matched by the record's name OR any ancestor
   *  segment, sorted — REPORTED, never acted on (JRN-D1). */
  shapesFor(rec: WalkRecord): string[] {
    const name = rec.name || '';
    const segs = ancestorsOf(rec.path || '');
    const out: string[] = [];
    for (const { id, regex } of this.shapes) {
      if (regex.test(name) || segs.some((s) => regex.test(s))) out.push(id);
    }
    return out.sort(compareCodepoints);
  }
}

/** Parses raw artifact JSON (+ the selection-policy JSON its stub floor
 *  references) into a loaded policy, applying every load-time refusal. */
export function parseFunnelPolicy(
  rawPolicy: unknown,
  rawSelection: unknown,
  source: string,
  sha256: string
): FunnelPolicy {
  return new FunnelPolicy(rawPolicy, rawSelection, source, sha256);
}

/** The vendored fallbacks, resolved relative to THIS module (same one-level
 *  hop as the classifier: works from src/ under vitest and from dist/ in the
 *  built package). */
export function vendoredFunnelPolicyPath(): string {
  return join(moduleDir, '..', 'vendor', 'funnel-policy.v1.json');
}
export function vendoredSelectionPolicyPath(): string {
  return join(moduleDir, '..', 'vendor', 'selection-policy.v1.json');
}
/** The vendored shared funnel-equivalence fixture — the exact file the
 *  reference suite consumes, SHA-pinned. */
export function vendoredFunnelFixturePath(): string {
  return join(moduleDir, '..', 'vendor', 'funnel-equivalence.v1.jsonl');
}

let cached: FunnelPolicy | null = null;
let cachedKey: string | null = null;

/** Test hook + config-reload hook. */
export function clearFunnelPolicyCache(): void {
  cached = null;
  cachedKey = null;
}

function readOrThrow(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new FunnelPolicyError(`${what}: cannot read ${path}: ${(err as Error).message}`);
  }
}

/**
 * The funnel policy this process is running, read once per process. Operator
 * paths win when FUNNEL_POLICY_PATH / SELECTION_POLICY_PATH are set (same
 * env vars the reference implementation honours); the vendored copies are
 * the fallback. A configured-but-unreadable path THROWS rather than silently
 * falling back — the classifier's distribution contract, applied to the
 * funnel's rule set.
 */
export function loadFunnelPolicy(): FunnelPolicy {
  const policyPath = process.env.FUNNEL_POLICY_PATH || vendoredFunnelPolicyPath();
  const selectionPath = process.env.SELECTION_POLICY_PATH || vendoredSelectionPolicyPath();
  const key = `${policyPath}\u0000${selectionPath}`;
  if (cached && cachedKey === key) return cached;

  const rawPolicy = readOrThrow(policyPath, 'funnel-policy');
  const rawSelection = readOrThrow(selectionPath, 'selection-policy');
  const sha256 = createHash('sha256').update(rawPolicy).digest('hex');
  const parsed = parseFunnelPolicy(
    JSON.parse(rawPolicy.toString('utf8')),
    JSON.parse(rawSelection.toString('utf8')),
    policyPath,
    sha256
  );
  // stderr, not stdout — stdout stays a pure data channel (classifier
  // precedent, found by a byte-for-byte TSV diff picking the load line up).
  process.stderr.write(
    `funnel_policy_loaded version=${parsed.version} sha256=${sha256} source=${policyPath} ` +
      `rules=${parsed.perItemRules.length + 1} shapes=${parsed.shapeIds.length} stub_floor=${parsed.stubFloor}\n`
  );
  cached = parsed;
  cachedKey = key;
  return parsed;
}

// ── The evaluator ───────────────────────────────────────────────────────────

const ckey = (r: WalkRecord): string => r.path || r.name || '';

/**
 * Apply the policy to one walk — a faithful port of the reference
 * implementation's evaluate(). `classifier` is a loaded ArtifactClasses; its
 * version is checked against the policy's pin so a stale classification can
 * never masquerade as a funnel measurement. Folders get NO verdict at all
 * (the fixture's not_walked_folder sentinel); non-candidates get
 * not_candidate:<class>; candidates get selected | subtracted:<rule_id> |
 * subtracted:propagated_from:<rule_id>, plus their sorted shape ids.
 */
export function evaluateFunnel(
  records: WalkRecord[],
  policy: FunnelPolicy,
  classifier: ArtifactClasses
): FunnelResult {
  if (classifier.version !== policy.classificationVersion) {
    throw new FunnelPolicyError(
      `classifier is ${classifier.version}, policy pins ${policy.classificationVersion} — ` +
        'recompute under the pinned artifact or amend the policy, never mix'
    );
  }

  // RECOMPUTE, NEVER TRUST: any recorded artifact_class/class_rule fields on
  // the records are walk-time output of whatever version ran then.
  const verdicts: Record<string, FunnelVerdict> = {};
  const candidates: WalkRecord[] = [];
  for (const rec of records) {
    if (rec.is_folder) continue;
    const { classId } = classifier.classify(rec.name || '', false, rec.path || '');
    const key = ckey(rec);
    if (classId !== policy.candidateClass) {
      verdicts[key] = { verdict: `not_candidate:${classId}`, shapes: [] };
      continue;
    }
    candidates.push(rec);
  }

  candidates.sort(
    (a, b) =>
      compareCodepoints(a.path || '', b.path || '') ||
      compareCodepoints(a.id || '', b.id || '') ||
      compareCodepoints(a.name || '', b.name || '')
  );

  const sub = new Map<string, string>(); // candidate key -> rule id (or propagated_from:)
  const bites: { rule: string; files: number; bytes: number }[] = [];

  const perItem = policy.perItemRules;
  const docScoped = new Set(perItem.filter((r) => r.scope === 'document').map((r) => r.id));

  for (const { id: rid } of perItem) {
    let n = 0;
    let b = 0;
    for (const rec of candidates) {
      const k = ckey(rec);
      if (sub.has(k)) continue;
      if (policy.ruleMatches(rid, rec)) {
        sub.set(k, rid);
        n += 1;
        b += rec.size ?? 0;
      }
    }
    bites.push({ rule: rid, files: n, bytes: b });
  }

  // Fingerprint groups on (lowercased name, exact size), members in candidate
  // order; group iteration in sorted-key order (name codepoints, then size) —
  // Python's sorted(dict-of-tuples).
  interface Group {
    nameLower: string;
    size: number;
    members: WalkRecord[];
  }
  const groups = new Map<string, Group>();
  for (const rec of candidates) {
    const nameLower = (rec.name || '').toLowerCase();
    const size = rec.size ?? 0;
    const gk = `${nameLower}\u0000${size}`;
    let g = groups.get(gk);
    if (!g) {
      g = { nameLower, size, members: [] };
      groups.set(gk, g);
    }
    g.members.push(rec);
  }
  const sortedGroups = [...groups.values()].sort(
    (a, b) => compareCodepoints(a.nameLower, b.nameLower) || a.size - b.size
  );
  const orderOf = new Map(perItem.map((r, i) => [r.id, i]));

  // Propagation: a DOCUMENT-scoped subtraction extends to every
  // fingerprint-identical candidate still standing, attributed to the
  // highest-precedence source. LOCATION-scoped subtractions never propagate:
  // the archived copy's exclusion says where the copy sits, not what the
  // document is, and propagating it would delete the surviving original.
  {
    let n = 0;
    let b = 0;
    for (const group of sortedGroups) {
      const hitSet = new Set<string>();
      for (const m of group.members) {
        const hit = sub.get(ckey(m));
        if (hit !== undefined && docScoped.has(hit)) hitSet.add(hit);
      }
      if (hitSet.size === 0) continue;
      const src = [...hitSet].sort((x, y) => (orderOf.get(x) as number) - (orderOf.get(y) as number))[0];
      for (const m of group.members) {
        const k = ckey(m);
        if (!sub.has(k)) {
          sub.set(k, `propagated_from:${src}`);
          n += 1;
          b += m.size ?? 0;
        }
      }
    }
    bites.push({ rule: 'propagation', files: n, bytes: b });
  }

  // Fingerprint collapse over the SURVIVORS, last: keeper is the shallowest
  // path (fewest '/'-separated components), tie broken on the raw path
  // string in codepoint order, then id — arbitrary but stated, so the same
  // corpus keeps the same copy every run.
  {
    let n = 0;
    let b = 0;
    for (const group of sortedGroups) {
      const standing = group.members.filter((m) => !sub.has(ckey(m)));
      if (standing.length <= 1) continue;
      let keeper = standing[0]!;
      const segCount = (m: WalkRecord) => (m.path || '').split('/').length;
      for (const m of standing.slice(1)) {
        const cmp =
          segCount(m) - segCount(keeper) ||
          compareCodepoints(m.path || '', keeper.path || '') ||
          compareCodepoints(m.id || '', keeper.id || '');
        if (cmp < 0) keeper = m;
      }
      for (const m of standing) {
        if (m === keeper) continue;
        sub.set(ckey(m), policy.collapseRuleId);
        n += 1;
        b += m.size ?? 0;
      }
    }
    bites.push({ rule: policy.collapseRuleId, files: n, bytes: b });
  }

  const selected: WalkRecord[] = [];
  const shapeCounts: Record<string, { candidates: number; default_selection: number }> = {};
  for (const sid of policy.shapeIds) shapeCounts[sid] = { candidates: 0, default_selection: 0 };
  for (const rec of candidates) {
    const k = ckey(rec);
    const shapes = policy.shapesFor(rec);
    for (const sid of shapes) shapeCounts[sid]!.candidates += 1;
    const hit = sub.get(k);
    if (hit !== undefined) {
      verdicts[k] = { verdict: `subtracted:${hit}`, shapes };
    } else {
      verdicts[k] = { verdict: 'selected', shapes };
      selected.push(rec);
      for (const sid of shapes) shapeCounts[sid]!.default_selection += 1;
    }
  }

  const candBytes = candidates.reduce((a, r) => a + (r.size ?? 0), 0);
  const selBytes = selected.reduce((a, r) => a + (r.size ?? 0), 0);
  const subFiles = bites.reduce((a, r) => a + r.files, 0);
  const subBytes = bites.reduce((a, r) => a + r.bytes, 0);
  if (candidates.length - subFiles !== selected.length || candBytes - subBytes !== selBytes) {
    throw new Error(
      'funnel does not reconcile: candidates minus named subtractions must equal the default ' +
        'selection, in files AND bytes — a funnel that cannot add is JRN-7, and it does not ship'
    );
  }

  return {
    candidates: { files: candidates.length, bytes: candBytes },
    subtractions: bites,
    default_selection: { files: selected.length, bytes: selBytes },
    sensitive_shape_report: shapeCounts,
    verdicts,
  };
}
