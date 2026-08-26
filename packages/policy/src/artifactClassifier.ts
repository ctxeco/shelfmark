// SPDX-License-Identifier: Apache-2.0
// 34-S09a (second half) — the TypeScript PORT of the artifact classifier.
//
// ══ THE ARTIFACT IS NORMATIVE; THIS FILE IS A PORT ══════════════════════════
//
// The rules are DATA, loaded from artifact-classes.v1.json (vendored in this
// package at vendor/). Nothing in this file hardcodes an extension, a prune
// segment, or a machine-generated filename. The rule set was authored against
// a reference Python implementation, and the shared hand-authored fixture
// (classifier-equivalence.v1.jsonl, vendored beside the artifact) asserts
// that the two implementations agree on (class, rule) PAIRS — because two
// implementations of one rule set diverging silently is the failure this
// design was bitten by once already (selection-policy amendment, 2026-08-19).
// The artifact's own precedence commentary names the exact divergence mode:
// "extension-first would classify half of node_modules as human_source".
//
// ══ WHAT THIS FILE NEVER DOES ═══════════════════════════════════════════════
//
// Read a file's CONTENT. It is handed observed metadata (name, folder facet,
// ancestor path) and returns a string pair. The only I/O here is loading the
// rule artifact itself; artifactClassifier.test.ts scans this module's
// imports so a content or network endpoint cannot appear silently.
//
// ══ HOW THE ARTIFACT REACHES THIS PROCESS ═══════════════════════════════════
//
// An operator-provided file named by ARTIFACT_CLASSES_PATH is preferred, and
// the VENDORED copy (pinned by SHA-256 in the test suite) ships as the
// fallback so a consumer is never rule-blind. A configured-but-unreadable
// path THROWS rather than silently falling back: an operator who pointed at
// a rule set meant it to be in force.
//
// The vendored copies live at vendor/ (package root, OUTSIDE tsconfig's
// rootDir), so the compiler never copies them into dist/ — the package
// manifest ships them via its `files` list, and a test pins that line the
// same way the loader tests pin the vendored bytes. The '../vendor' hop
// below resolves identically from src/ (dev, vitest) and dist/ (built).
//
// ══ TENANCY NOTE ════════════════════════════════════════════════════════════
//
// classify() is a pure function of one item's observed metadata — the tenant
// or account an item belongs to is not an input to the RULES. Callers that
// EMIT records own attaching their tenant/account scoping to every record
// this classifier stamps (34-S09b).
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** This module's directory, resolved for both build formats: dist/index.cjs
 *  has a real __dirname; dist/index.js (ESM) derives it from import.meta.url.
 *  The typeof guard keeps the CJS bundle from ever evaluating import.meta. */
const moduleDir: string =
  typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));

// The three class ids the artifact's own precedence RULES name normatively
// (rules 1/2 assign machine_generated, the folder facet assigns container,
// rule 5 assigns unclassified). Everything else — the extension tables, the
// prune list, the exact names — stays data. Same three constants as the
// reference implementation.
export const MACHINE_GENERATED = 'machine_generated';
export const CONTAINER = 'container';
export const UNCLASSIFIED = 'unclassified';

/** One classification decision. The RULE is returned, not just the class,
 *  because the standing evidence bar is that a check names itself: a
 *  distribution that cannot say WHICH rule produced it is not auditable.
 *  Rule grammar (shared with the reference implementation and the fixture):
 *  `prune_ancestor:<seg>` | `prune_self:<name>` | `is_folder` |
 *  `machine_name:<name>` | `extension:<ext>` | `name:<name>` |
 *  `no_rule_matched` — all lowercased. */
export interface Classification {
  classId: string;
  rule: string;
}

/** The vendored fallback, resolved relative to THIS module so the same hop
 *  works from src/ under vitest and dist/ in the built package (both sit
 *  exactly one level below the directory that holds vendor/). */
export function vendoredArtifactClassesPath(): string {
  return join(moduleDir, '..', 'vendor', 'artifact-classes.v1.json');
}

/** The vendored shared classifier-equivalence fixture (25B §2.3) — the exact
 *  file the reference suite consumes, SHA-pinned. Exported so the
 *  equivalence test and any future consumer read ONE path. */
export function vendoredEquivalenceFixturePath(): string {
  return join(moduleDir, '..', 'vendor', 'classifier-equivalence.v1.jsonl');
}

/**
 * The loaded, SHA-pinned classification artifact. A port of the reference
 * implementation's ArtifactClasses class — same load-time refusals, same
 * precedence, same rule-attribution strings.
 */
export class ArtifactClasses {
  readonly version: string;
  readonly sha256: string;
  readonly source: string;
  readonly classIds: ReadonlySet<string>;
  /** Per-class extension counts, kept so the artifact's self-describing
   *  counts can be REGENERATED rather than trusted (a count somebody typed
   *  is a claim; a count the loader emits is a measurement). */
  readonly extensionCountByClass: Readonly<Record<string, number>>;

  private readonly byExt: Map<string, string>;
  private readonly prune: Set<string>;
  private readonly machineNames: Set<string>;

  constructor(raw: unknown, source: string, sha256: string) {
    const doc = raw as Record<string, any>;
    const version = String(doc?.version ?? '');
    if (!version) throw new Error('artifact-classes: missing `version`');
    this.version = version;
    this.source = source;
    this.sha256 = sha256;

    const classes = doc?.classes;
    if (!Array.isArray(classes) || classes.length === 0) {
      throw new Error('artifact-classes: missing `classes`');
    }
    const rules = doc?.rules;
    if (!rules || !Array.isArray(rules.prune_segments)) {
      throw new Error('artifact-classes: missing `rules.prune_segments`');
    }

    // Extension -> class. Built once. A duplicate extension across two
    // classes is a CONTRADICTION in the artifact, not something to resolve
    // by iteration order — fail loudly at load rather than silently letting
    // whichever class was listed last win. (Byte-for-byte the reference
    // implementation's refusal, message included.)
    this.byExt = new Map();
    const extCount: Record<string, number> = {};
    for (const cls of classes) {
      const exts: unknown[] = cls?.example_extensions ?? [];
      extCount[String(cls?.id)] = exts.length;
      for (const ext of exts) {
        const e = String(ext).toLowerCase().replace(/^\.+/, '');
        const already = this.byExt.get(e);
        if (already !== undefined && already !== cls.id) {
          throw new Error(
            `artifact-classes ${this.version}: extension '${e}' is claimed by both ` +
              `'${already}' and '${cls.id}'. Resolve it in the artifact.`
          );
        }
        this.byExt.set(e, String(cls.id));
      }
    }
    this.extensionCountByClass = extCount;

    this.prune = new Set((rules.prune_segments as unknown[]).map((s) => String(s).toLowerCase()));
    // Exact filenames that are machine-generated whatever their extension —
    // the list validation against REAL drive names produced (the artifact's
    // machine_generated_names_note 1–3).
    this.machineNames = new Set(
      ((rules.machine_generated_names ?? []) as unknown[]).map((n) => String(n).toLowerCase())
    );
    this.classIds = new Set(classes.map((c: any) => String(c?.id)));
    if (!this.classIds.has(UNCLASSIFIED)) {
      throw new Error('artifact-classes: the escape class is missing; refusing to load');
    }
  }

  /**
   * Return { classId, rule } for one item's observed metadata.
   *
   * Precedence is the artifact's rules.precedence, EXACTLY — it is stated in
   * the artifact "because it is where a reimplementation silently diverges":
   *   1. FOLDER PRUNE (any prunable ANCESTOR segment; the item's own trailing
   *      segment is not an ancestor; attribution goes to the SHALLOWEST
   *      matching segment — fixture resolution note 1)
   *   2. FOLDER SELF (a folder whose own name is prunable; never walked)
   *   3. EXACT NAME (machine_generated_names beats extension — the lockfile
   *      distinction)
   *   4. EXTENSION (compound tail after the FIRST dot probed before the bare
   *      last-dot tail, then whole-name lookup for extensionless build files)
   *   5. ESCAPE (`unclassified` — no rule matched; NOT the same statement as
   *      opaque_container, which is a positive identification via rule 4)
   */
  classify(name: string, isFolder: boolean, path = ''): Classification {
    const segments = (path || '')
      .split('/')
      .filter((s) => s)
      .map((s) => s.toLowerCase());
    const own = (name || '').toLowerCase();

    // RULE 1 — folder prune beats everything. A .md inside node_modules is a
    // dependency's README, not the customer's knowledge. The trailing segment
    // is the item itself when it matches `own`, so it is excluded: a FILE
    // named `coverage` must not prune itself. Left-to-right scan = shallowest
    // segment attributed, pinned by the fixture's .venv/site-packages case.
    const ancestors =
      segments.length > 0 && segments[segments.length - 1] === own ? segments.slice(0, -1) : segments;
    for (const seg of ancestors) {
      if (this.prune.has(seg)) return { classId: MACHINE_GENERATED, rule: `prune_ancestor:${seg}` };
    }

    // RULE 2 — the folder itself. Its subtree is never walked.
    if (isFolder) {
      if (this.prune.has(own)) return { classId: MACHINE_GENERATED, rule: `prune_self:${own}` };
      return { classId: CONTAINER, rule: 'is_folder' };
    }

    // RULE 3 — exact filename, BEFORE extension. `package-lock.json` and
    // `config.json` share an extension and could not be less alike.
    if (this.machineNames.has(own)) return { classId: MACHINE_GENERATED, rule: `machine_name:${own}` };

    // RULE 4 — extension. Compound extensions the artifact lists verbatim
    // (e.g. "min.js", "tar.gz") are checked FIRST via the tail after the
    // first dot, or every minified bundle reads as source. DOCUMENTED LIMIT,
    // preserved as written (2026-08-19 amendment precedent): only that one
    // tail is probed, so `vendor.bundle.min.js` re-probes `bundle.min.js`,
    // misses, and lands on the bare tail `js` — and a deeply-dotted
    // `a.b.tar.gz` likewise lands via its bare tail `gz`. If that is ever
    // judged wrong it is an ARTIFACT revision plus a fixture re-pin, never a
    // silent evaluator fix here.
    const dot = own.indexOf('.');
    const compound = dot >= 0 ? own.slice(dot + 1) : '';
    if (compound) {
      const cls = this.byExt.get(compound);
      if (cls !== undefined) return { classId: cls, rule: `extension:${compound}` };
    }
    const ext = dot >= 0 ? own.slice(own.lastIndexOf('.') + 1) : '';
    if (ext) {
      const cls = this.byExt.get(ext);
      if (cls !== undefined) return { classId: cls, rule: `extension:${ext}` };
    }
    // Extensionless build files carry their identity in the NAME
    // (dockerfile, makefile, license, cname, codeowners, gemfile).
    const byName = this.byExt.get(own);
    if (byName !== undefined) return { classId: byName, rule: `name:${own}` };

    // RULE 5 — the escape. Never a guess. `unclassified` means no rule named
    // the item; it does NOT mean "we cannot see inside it" — that is
    // `opaque_container`, a POSITIVE identification reached through rule 4.
    return { classId: UNCLASSIFIED, rule: 'no_rule_matched' };
  }

  /**
   * Whether an enumerator should descend into this folder — derived from
   * classify() exactly as the reference implementation's should_walk is:
   * classify the item AS A FOLDER and descend unless it is machine_generated
   * (i.e. prunable by its own name OR by a prunable ancestor). This is where
   * the economy lives: returning false on `node_modules` is what turned a
   * 327,140-item walk into 15,657.
   */
  shouldWalk(folderName: string, path = ''): boolean {
    return this.classify(folderName, true, path).classId !== MACHINE_GENERATED;
  }
}

/**
 * Parses raw artifact JSON into a loaded rule set, applying the load-time
 * refusals. A contradictory or escape-less artifact throws HERE, at load,
 * rather than mis-classifying a drive quietly.
 */
export function parseArtifactClasses(raw: unknown, source: string, sha256: string): ArtifactClasses {
  return new ArtifactClasses(raw, source, sha256);
}

let cached: ArtifactClasses | null = null;
let cachedSource: string | null = null;

/** Test hook + config-reload hook. */
export function clearArtifactClassesCache(): void {
  cached = null;
  cachedSource = null;
}

/**
 * The rule set this process is running, read once per process. An operator
 * path wins when ARTIFACT_CLASSES_PATH is set (same env var the reference
 * implementation honours); the vendored copy is the fallback.
 *
 * A configured-but-unreadable ARTIFACT_CLASSES_PATH THROWS rather than
 * silently falling back — the distribution contract shared by every governed
 * artifact this design ships (23-E7), applied to the map's rule set. The
 * version and SHA-256 are exposed because every map run must record which
 * rules classified it (artifact-classes `required_run_outputs`).
 */
export function loadArtifactClasses(): ArtifactClasses {
  const configured = process.env.ARTIFACT_CLASSES_PATH || '';
  const path = configured || vendoredArtifactClassesPath();
  if (cached && cachedSource === path) return cached;

  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new Error(`artifact-classes: cannot read ${path}: ${(err as Error).message}`);
  }
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const parsed = parseArtifactClasses(JSON.parse(raw.toString('utf8')), path, sha256);
  // stderr, NOT console.info/stdout: walk-comparison tooling uses stdout as
  // a pure data channel (a TSV diffed byte-for-byte against the reference
  // implementation), and the reference tooling prints its own load line to
  // stderr for the same reason. Found by that exact diff picking this line
  // up.
  process.stderr.write(
    `artifact_classes_loaded version=${parsed.version} sha256=${sha256} source=${path} ` +
      `classes=${parsed.classIds.size} extensions=${[...Object.values(parsed.extensionCountByClass)].reduce((a, b) => a + b, 0)}\n`
  );
  cached = parsed;
  cachedSource = path;
  return parsed;
}
