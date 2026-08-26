// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  ArtifactClasses,
  CONTAINER,
  MACHINE_GENERATED,
  UNCLASSIFIED,
  clearArtifactClassesCache,
  loadArtifactClasses,
  parseArtifactClasses,
  vendoredArtifactClassesPath,
  vendoredEquivalenceFixturePath,
} from '../src/artifactClassifier.js';

// 34-S09a — the TypeScript classifier port, held to the reference Python
// implementation through the SHARED hand-authored fixture. Every test below
// is named for the failure it prevents. The equivalence battery asserts
// (class, rule) PAIRS, never class alone — a port that lands the right class
// off the wrong rule has still diverged, it just has not been caught yet.

const testDir = dirname(fileURLToPath(import.meta.url));

/** An upstream canonical copy of the artifacts, when one is provided (set
 *  POLICY_CANONICAL_DIR to a directory holding the canonical files to run
 *  the byte-identity drift checks against it; unset, the SHA pins below are
 *  the guard). */
const CANONICAL_DIR = process.env.POLICY_CANONICAL_DIR || '';
const CANONICAL_ARTIFACT = CANONICAL_DIR ? join(CANONICAL_DIR, 'artifact-classes.v1.json') : '';
const CANONICAL_FIXTURE = CANONICAL_DIR ? join(CANONICAL_DIR, 'classifier-equivalence.v1.jsonl') : '';

/** SHA-256 pins (artifact-classes 1.0.0-rc2; fixture 1.0.0). Changing either
 *  vendored file must be a deliberate act with the pin moved in the same
 *  commit — vendor drift fails BY NAME, here and in CI. */
const VENDORED_ARTIFACT_SHA256 = '1240557c0824e78f5ac46b2039019b5721da5c6d4a46c824037f3ba637a727c1';
const VENDORED_FIXTURE_SHA256 = '0797503d59e913b5ef12eaa62e75f0d29a351c600c3111d4bcf3ecdaa862139e';

/** The fixture's own published shape (both suites pin all three). */
const PINNED_EQUIVALENCE_CASE_COUNT = 111;
const EQUIVALENCE_CASE_KEYS = ['name', 'is_folder', 'path', 'expected_class', 'expected_rule'];
const EQUIVALENCE_RULE_FAMILIES = [
  'prune_ancestor',
  'prune_self',
  'is_folder',
  'machine_name',
  'extension',
  'name',
  'no_rule_matched',
];

interface FixtureCase {
  caseId: string;
  name: string;
  is_folder: boolean;
  path: string;
  expected_class: string;
  expected_rule: string;
  raw: Record<string, unknown>;
}

/** Parsed once at collection time so the 111 cases become 111 named tests,
 *  mirroring the reference suite's parametrization. Line 1 is the metadata
 *  record (carries `fixture`, no `name`) and is skipped — its shape has its
 *  own test below. */
const fixtureLines = readFileSync(vendoredEquivalenceFixturePath(), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');
const fixtureMeta = JSON.parse(fixtureLines[0]!) as Record<string, unknown>;
const fixtureCases: FixtureCase[] = fixtureLines.slice(1).map((line, i) => {
  const raw = JSON.parse(line) as Record<string, unknown>;
  return {
    caseId: `${String(i + 1).padStart(3, '0')}-${raw.is_folder ? 'folder' : 'file'}-${raw.name}`,
    name: String(raw.name ?? ''),
    is_folder: Boolean(raw.is_folder),
    path: String(raw.path ?? ''),
    expected_class: String(raw.expected_class ?? ''),
    expected_rule: String(raw.expected_rule ?? ''),
    raw,
  };
});

const originalArtifactPath = process.env.ARTIFACT_CLASSES_PATH;

beforeEach(() => {
  delete process.env.ARTIFACT_CLASSES_PATH;
  clearArtifactClassesCache();
});

afterEach(() => {
  if (originalArtifactPath === undefined) delete process.env.ARTIFACT_CLASSES_PATH;
  else process.env.ARTIFACT_CLASSES_PATH = originalArtifactPath;
  clearArtifactClassesCache();
});

describe('vendored observed artifacts', () => {
  it('the vendored artifact-classes must not drift from the canonical copy, when one is provided', () => {
    if (!CANONICAL_ARTIFACT || !existsSync(CANONICAL_ARTIFACT)) {
      // Deliberately not silent: the SHA pin below still bites
      // unconditionally — but the reader has to know which guard actually
      // ran here.
      console.warn(
        `[artifactClassifier.test] no canonical artifact provided (POLICY_CANONICAL_DIR) — drift check not run here; the SHA pin still applies`
      );
      return;
    }
    expect(readFileSync(vendoredArtifactClassesPath(), 'utf8')).toBe(readFileSync(CANONICAL_ARTIFACT, 'utf8'));
  });

  it('the vendored equivalence fixture must not drift from the canonical copy, when one is provided', () => {
    if (!CANONICAL_FIXTURE || !existsSync(CANONICAL_FIXTURE)) {
      console.warn(
        `[artifactClassifier.test] no canonical fixture provided (POLICY_CANONICAL_DIR) — drift check not run here; the SHA pin still applies`
      );
      return;
    }
    expect(readFileSync(vendoredEquivalenceFixturePath(), 'utf8')).toBe(readFileSync(CANONICAL_FIXTURE, 'utf8'));
  });

  it("the vendored artifact's SHA-256 must match its pin, so a rule-set edit is always deliberate", () => {
    const sha = createHash('sha256').update(readFileSync(vendoredArtifactClassesPath())).digest('hex');
    expect(sha).toBe(VENDORED_ARTIFACT_SHA256);
  });

  it("the vendored fixture's SHA-256 must match the pin its author published, so vendor drift fails by name", () => {
    const sha = createHash('sha256').update(readFileSync(vendoredEquivalenceFixturePath())).digest('hex');
    expect(sha).toBe(VENDORED_FIXTURE_SHA256);
  });

  it('the package manifest must ship vendor/, or the published package boots rule-blind', () => {
    // vendor/ lives OUTSIDE tsconfig rootDir, so the compiler never copies it
    // into dist/ — the same failure shape as any load-bearing data file the
    // build does not know about. Without the `files` entry, `pnpm test` stays
    // green from src/ while every INSTALLED copy throws "cannot read
    // .../vendor/artifact-classes.v1.json" at first classify. This test pins
    // the manifest line the same way the loader tests pin the vendored bytes.
    const pkg = JSON.parse(readFileSync(join(testDir, '..', 'package.json'), 'utf8'));
    expect(pkg.files).toContain('vendor');
    expect(pkg.exports['./vendor/*']).toBe('./vendor/*');
  });

  it('the classifier module must import only fs/path/crypto/url — metadata only, no content or network endpoint, structurally enforced', () => {
    // The reference walker's suite AST-scans for content endpoints; the map
    // path gets the same discipline. classify() is a pure function of
    // observed metadata — the only I/O permitted in the module is reading the
    // rule artifact itself ('url' is fileURLToPath, for resolving the
    // module's own directory under ESM).
    const source = readFileSync(join(testDir, '..', 'src', 'artifactClassifier.ts'), 'utf8');
    const specifiers = [...source.matchAll(/(?:from\s+|require\()\s*'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(['crypto', 'fs', 'path', 'url']).toContain(spec);
    }
    expect(source).not.toMatch(/\b(fetch|axios|https?\.request|XMLHttpRequest|net\.connect)\b/);
    expect(source).not.toMatch(/\/content\b/); // the Graph content endpoint must never appear here
  });
});

describe('loadArtifactClasses', () => {
  it('loads the vendored copy when no ARTIFACT_CLASSES_PATH is set, exposing version and SHA for the run record', () => {
    const ac = loadArtifactClasses();
    expect(ac.source).toBe(vendoredArtifactClassesPath());
    expect(ac.version).toBe('1.0.0-rc2');
    // required_run_outputs: every map run records "the artifact version and
    // SHA-256 this run was classified under" — so the loader must expose the
    // exact bytes-hash of what it loaded.
    expect(ac.sha256).toBe(VENDORED_ARTIFACT_SHA256);
    expect([...ac.classIds].sort()).toEqual([
      'container',
      'human_prose',
      'human_source',
      'machine_generated',
      'media',
      'opaque_container',
      'unclassified',
    ]);
  });

  it('a configured-but-unreadable ARTIFACT_CLASSES_PATH must throw, never fall back to the vendored rules', () => {
    // An operator who pointed at a rule set meant that rule set to be in
    // force. Quietly classifying a customer's drive under a stale vendored
    // copy is the exact failure the distribution contract exists to prevent.
    process.env.ARTIFACT_CLASSES_PATH = '/nonexistent/mount/artifact-classes.v1.json';
    expect(() => loadArtifactClasses()).toThrow(/cannot read \/nonexistent\/mount\/artifact-classes\.v1\.json/);
  });

  it('a configured ARTIFACT_CLASSES_PATH must win over the vendored fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shelfmark-artifact-classes-'));
    try {
      const doc = JSON.parse(readFileSync(vendoredArtifactClassesPath(), 'utf8'));
      doc.version = '9.9.9-mounted-test';
      const mounted = join(dir, 'artifact-classes.v1.json');
      writeFileSync(mounted, JSON.stringify(doc));
      process.env.ARTIFACT_CLASSES_PATH = mounted;
      const ac = loadArtifactClasses();
      expect(ac.source).toBe(mounted);
      expect(ac.version).toBe('9.9.9-mounted-test'); // proves the mounted BYTES were read, not just the path echoed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('load-time refusals (the artifact contradictions this port must refuse, exactly as the reference does)', () => {
  const minimalDoc = (overrides: Record<string, unknown> = {}) => ({
    version: '0.0.0-test',
    classes: [
      { id: 'human_source', example_extensions: ['ts'] },
      { id: 'unclassified', example_extensions: [] },
    ],
    rules: { prune_segments: ['node_modules'], machine_generated_names: ['yarn.lock'] },
    ...overrides,
  });

  it('an extension claimed by two classes is a contradiction in the artifact and must refuse to load, naming both classes', () => {
    // Resolving it by iteration order would silently let whichever class was
    // listed last win — a rule change nobody reviewed.
    const doc = minimalDoc({
      classes: [
        { id: 'human_source', example_extensions: ['ts'] },
        { id: 'machine_generated', example_extensions: ['ts'] },
        { id: 'unclassified', example_extensions: [] },
      ],
    });
    expect(() => parseArtifactClasses(doc, 'x', 'y')).toThrow(
      /extension 'ts' is claimed by both 'human_source' and 'machine_generated'/
    );
  });

  it('the same extension listed twice in ONE class is repetition, not contradiction — the reference tolerates it and the port must match', () => {
    const doc = minimalDoc({
      classes: [
        { id: 'human_source', example_extensions: ['ts', 'ts'] },
        { id: 'unclassified', example_extensions: [] },
      ],
    });
    expect(parseArtifactClasses(doc, 'x', 'y').classify('a.ts', false)).toEqual({
      classId: 'human_source',
      rule: 'extension:ts',
    });
  });

  it('an artifact with no `unclassified` class must refuse to load — a classifier with no escape is a classifier that lies', () => {
    const doc = minimalDoc({ classes: [{ id: 'human_source', example_extensions: ['ts'] }] });
    expect(() => parseArtifactClasses(doc, 'x', 'y')).toThrow(/the escape class is missing; refusing to load/);
  });

  it('extension matching must strip leading dots and lowercase, exactly as the reference loader normalises', () => {
    const doc = minimalDoc({
      classes: [
        { id: 'human_source', example_extensions: ['.TS'] },
        { id: 'unclassified', example_extensions: [] },
      ],
    });
    expect(parseArtifactClasses(doc, 'x', 'y').classify('App.Ts', false)).toEqual({
      classId: 'human_source',
      rule: 'extension:ts',
    });
  });
});

describe('precedence — every collision the artifact mandates, one named test each', () => {
  const ac = () => loadArtifactClasses();

  it('rule 1: a prunable ANCESTOR beats extension — a .md inside node_modules is a dependency README, not knowledge', () => {
    expect(ac().classify('README.md', false, 'code/engram/node_modules/lodash/README.md')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'prune_ancestor:node_modules',
    });
  });

  it('rule 1 attribution: when several ancestors are prunable, the SHALLOWEST segment is attributed (fixture resolution note 1)', () => {
    // A port scanning deepest-first fails here — and the fix is the port,
    // never the fixture.
    expect(ac().classify('app.py', false, 'code/engram/.venv/lib/site-packages/requests/app.py')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'prune_ancestor:.venv',
    });
  });

  it("rule 1 scope: the item's own trailing segment is NOT an ancestor — a file named `coverage` must not prune itself", () => {
    expect(ac().classify('coverage', false, 'code/tools/coverage')).toEqual({
      classId: UNCLASSIFIED,
      rule: 'no_rule_matched',
    });
  });

  it('rule 1/2 are folder-scoped: a FILE named `env` is human_source via the name fallback, while a FOLDER named `env` is pruned', () => {
    expect(ac().classify('env', false, 'infra/env')).toEqual({ classId: 'human_source', rule: 'name:env' });
    expect(ac().classify('env', true, 'infra/env')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'prune_self:env',
    });
  });

  it('rule 2: a folder whose own name is prunable is machine_generated, never container', () => {
    expect(ac().classify('dist', true, 'code/webapp/dist')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'prune_self:dist',
    });
    expect(ac().classify('webapp', true, 'code/webapp')).toEqual({ classId: CONTAINER, rule: 'is_folder' });
  });

  it('rule 3: an exact machine name beats extension — package-lock.json and config.json share an extension and could not be less alike', () => {
    expect(ac().classify('package-lock.json', false, 'code/webapp/package-lock.json')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'machine_name:package-lock.json',
    });
    expect(ac().classify('config.json', false, 'code/webapp/config.json')).toEqual({
      classId: 'human_source',
      rule: 'extension:json',
    });
  });

  it('rule 3 class-flips: desktop.ini and top_level.txt land machine_generated though their extensions read human', () => {
    expect(ac().classify('desktop.ini', false, 'Documents/desktop.ini')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'machine_name:desktop.ini',
    });
    expect(ac().classify('top_level.txt', false, 'code/pkg.egg-info/top_level.txt')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'machine_name:top_level.txt',
    });
  });

  it('rule 4 compound probe: the tail after the FIRST dot is probed before the bare last-dot extension (min.js over js, tar.gz over gz)', () => {
    expect(ac().classify('app.min.js', false, 'code/webapp/static/app.min.js')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'extension:min.js',
    });
    expect(ac().classify('app.js', false, 'code/webapp/static/app.js')).toEqual({
      classId: 'human_source',
      rule: 'extension:js',
    });
    expect(ac().classify('backup.tar.gz', false, 'Documents/backup.tar.gz')).toEqual({
      classId: 'opaque_container',
      rule: 'extension:tar.gz',
    });
  });

  it('rule 4 documented limit, preserved as written: only the first-dot tail is re-probed, so deep-dotted names land on their bare tail', () => {
    // vendor.bundle.min.js -> tail 'bundle.min.js' misses -> bare tail 'js'
    // -> human_source. a.b.tar.gz -> tail 'b.tar.gz' misses -> bare tail 'gz'
    // -> opaque_container. Both preserved per the 2026-08-19 amendment
    // precedent: if ever judged wrong, it is an artifact revision plus a
    // fixture re-pin — never a silent evaluator fix.
    expect(ac().classify('vendor.bundle.min.js', false, 'code/webapp/static/vendor.bundle.min.js')).toEqual({
      classId: 'human_source',
      rule: 'extension:js',
    });
    expect(ac().classify('a.b.tar.gz', false, 'Documents/a.b.tar.gz')).toEqual({
      classId: 'opaque_container',
      rule: 'extension:gz',
    });
  });

  it('rule 4 name fallback: extensionless build files carry their identity in the NAME (dockerfile, license)', () => {
    expect(ac().classify('Dockerfile', false, 'code/engram/Dockerfile')).toEqual({
      classId: 'human_source',
      rule: 'name:dockerfile',
    });
    expect(ac().classify('LICENSE', false, 'code/engram/LICENSE')).toEqual({
      classId: 'human_prose',
      rule: 'name:license',
    });
  });

  it('everything is case-insensitive: Pods prunes, IMG_4821.HEIC is media, Gemfile.lock is a lockfile', () => {
    expect(ac().classify('Pods', true, 'code/ios-app/Pods')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'prune_self:pods',
    });
    expect(ac().classify('IMG_4821.HEIC', false, 'Pictures/IMG_4821.HEIC')).toEqual({
      classId: 'media',
      rule: 'extension:heic',
    });
    expect(ac().classify('Gemfile.lock', false, 'code/site/Gemfile.lock')).toEqual({
      classId: MACHINE_GENERATED,
      rule: 'machine_name:gemfile.lock',
    });
  });

  it('package archives stay machine_generated — that class asserts PROVENANCE, opaque_container asserts OPACITY', () => {
    for (const name of ['pkg-1.0.0-py3-none-any.whl', 'library.jar', 'tool.nupkg']) {
      const { classId } = ac().classify(name, false, `Downloads/${name}`);
      expect(classId, name).toBe(MACHINE_GENERATED);
    }
  });

  it('opaque_container is a POSITIVE identification via rule 4, never the escape', () => {
    expect(ac().classify('bank statements.zip', false, 'Documents/bank statements.zip')).toEqual({
      classId: 'opaque_container',
      rule: 'extension:zip',
    });
    expect(ac().classify('mystery.xyzq', false, 'Documents/mystery.xyzq')).toEqual({
      classId: UNCLASSIFIED,
      rule: 'no_rule_matched',
    });
  });

  it('a path-less item (some walk shapes carry no path) classifies on name and facet alone', () => {
    expect(ac().classify('notes.md', false)).toEqual({ classId: 'human_prose', rule: 'extension:md' });
    expect(ac().classify('Documents', true)).toEqual({ classId: CONTAINER, rule: 'is_folder' });
  });
});

describe('shouldWalk — derived from classify exactly as the reference should_walk is', () => {
  it('refuses to descend into a folder classify marks machine_generated, by its own name or by a pruned ancestor', () => {
    const ac = loadArtifactClasses();
    expect(ac.shouldWalk('node_modules', 'code/engram/node_modules')).toBe(false);
    expect(ac.shouldWalk('lodash', 'code/engram/node_modules/lodash')).toBe(false); // ancestor prune, not self
    expect(ac.shouldWalk('Documents', 'Documents')).toBe(true);
    expect(ac.shouldWalk('engram', 'code/engram')).toBe(true);
  });

  it('walks a folder whose name matches a machine FILE name — machine_generated_names is a file rule and must stay one', () => {
    // classify(as folder) returns container at rule 2, before rule 3 is ever
    // consulted; a port that checks machine names first would skip this
    // subtree. Same behaviour as the reference: should_walk('go.sum') is True.
    const ac = loadArtifactClasses();
    expect(ac.classify('go.sum', true, 'code/odd/go.sum')).toEqual({ classId: CONTAINER, rule: 'is_folder' });
    expect(ac.shouldWalk('go.sum', 'code/odd/go.sum')).toBe(true);
  });
});

describe('the shared equivalence fixture (25B §2.3) — one fixture, two implementations, zero silent divergence', () => {
  it('the metadata record is shaped for both suites: line 1 carries `fixture` and no `name`, and no case line carries `fixture`', () => {
    expect(fixtureMeta).toHaveProperty('fixture', 'classifier-equivalence');
    expect(fixtureMeta).not.toHaveProperty('name');
    expect(fixtureMeta).toHaveProperty('version');
    expect(Array.isArray(fixtureMeta.resolution_notes)).toBe(true);
    for (const c of fixtureCases) {
      expect(c.raw, c.caseId).not.toHaveProperty('fixture');
      expect(c.raw, c.caseId).toHaveProperty('name');
    }
  });

  it(`carries exactly ${PINNED_EQUIVALENCE_CASE_COUNT} cases, each with exactly the five published keys`, () => {
    expect(fixtureCases.length).toBe(PINNED_EQUIVALENCE_CASE_COUNT);
    for (const c of fixtureCases) {
      expect(Object.keys(c.raw).sort(), c.caseId).toEqual([...EQUIVALENCE_CASE_KEYS].sort());
      expect(typeof c.raw.name, c.caseId).toBe('string');
      expect(typeof c.raw.is_folder, c.caseId).toBe('boolean');
      expect(typeof c.raw.path, c.caseId).toBe('string');
    }
  });

  it('exercises every class and every rule family, so a dead branch in either implementation cannot hide', () => {
    const classesSeen = new Set(fixtureCases.map((c) => c.expected_class));
    const familiesSeen = new Set(fixtureCases.map((c) => c.expected_rule.split(':')[0]));
    expect([...classesSeen].sort()).toEqual([...loadArtifactClasses().classIds].sort());
    expect([...familiesSeen].sort()).toEqual([...EQUIVALENCE_RULE_FAMILIES].sort());
  });

  it.each(fixtureCases.map((c) => [c.caseId, c] as const))(
    'agrees with the hand-authored fixture on the (class, rule) PAIR: %s',
    (_caseId, c) => {
      const got = loadArtifactClasses().classify(c.name, c.is_folder, c.path);
      expect(got).toEqual({ classId: c.expected_class, rule: c.expected_rule });
    }
  );
});
