// SPDX-License-Identifier: Apache-2.0
// Plan 25 Phase C — the verbatim consent disclosures.
//
// ── ONE BODY OF TEXT, VENDORED, NEVER AUTHORED HERE ─────────────────────────
//
// This module holds NO disclosure copy. The words live in exactly one place —
// the canonical `consent/disclosures/*.md` tree at the repository root,
// indexed by `consent/disclosures.manifest.json` — and this package carries a
// byte-identical VENDORED copy under `vendor/consent/`, which CI
// sha256-compares against the canonical tree on every build. Drift is a red
// build, never a silent divergence. Same shape and deliberately the same
// discipline as vendoring a shared ontology across services (23-E7 / gate
// G-7); see the canonical tree's README.
//
// WHY THE CANONICAL COPY IS NOT IN THIS FILE, WHERE IT USED TO BE.
// Until 2026-08-13 this module held one body of copy and the portal that
// displays it held another. They were not variants — they were incompatible:
// different ids (`map_metadata.v1` vs `map`), different locales (`en|es` vs
// `en|es-MX`), and directly contradictory statements about what revocation
// does, with BOTH claiming to be the exact words stored with the decision.
// Two consequences, both reproduced against the running routes before this
// change:
//
//   * feeding the portal's bytes to the grant endpoint returned
//     409 `disclosure_text_mismatch` — the round trip could never close;
//   * asking for locale `es-MX` — the only Spanish locale the portal's
//     locale type admits — returned 400 `disclosure_not_found`, so **no
//     Spanish speaker could grant consent at all.**
//
// Making either consumer canonical would have left that consumer unpinned,
// with only the other side going red — the asymmetry that produced the drift.
// So canonical sits beside the compliance material it implements, and every
// consumer vendors and pins.
//
// ── THE RECORD STORES WORDS, NOT KEYS ───────────────────────────────────────
//
// The consent record stores the full text of whichever disclosure was shown,
// plus its SHA-256 and its locale — never an i18n key. A key changes on any
// deploy and leaves the record pointing at words nobody can reconstruct; "the
// user agreed to consent.map.body" is not a record of what the user agreed to.
//
// ── HOW TO CORRECT A DISCLOSURE — all steps, or the correction is a no-op ────
//
//   1. In the canonical tree, ADD a new file per locale whose NAME carries the
//      new id (`map_metadata.v2.en.md`, `map_metadata.v2.es-MX.md`). Never edit
//      an existing file: locales are not corrected one at a time, because `en`
//      on v2 and `es-MX` on v1 is two different permissions under one name.
//   2. POINT `manifest.current[scope]` at the new id. The old entries stay in
//      the manifest forever — `getDisclosureById` is how a record stored last
//      year is read back, and removing the entry is what makes an old record
//      unreconstructible.
//   3. RE-VENDOR here and update the pins in the disclosures test.
//
// Step 2 is the one that used to be missing, and its absence is why this
// procedure is spelled out. `getDisclosure` resolved on (scope, locale) ALONE
// and returned the first match, so a correctly-registered v2 was never served:
// the documented procedure was followed by a reviewer and did nothing, with the
// whole suite green. Serving is now decided by `status`, which is DERIVED from
// `manifest.current` rather than typed per entry — one place to change, and
// "two entries both claiming to be current" is unrepresentable rather than
// merely checked.
//
// ── FAIL CLOSED AT LOAD ─────────────────────────────────────────────────────
//
// Every vendored file is hashed at import and compared to the manifest, and
// every (scope, locale) pair must resolve to exactly one current entry.
// Anything else throws, which takes the process down at startup rather than
// letting it serve a disclosure whose bytes are not the bytes the manifest
// describes. A consent surface that is wrong is worse than one that is down.
//
// ── WHAT THE TEXT NOW PROMISES, AND WHY IT IS SMALLER ───────────────────────
//
// The retired copy in this module closed with "the map built under this
// permission stops being used", present tense. Nothing anywhere consumes
// the consent log — it is written and listed by the consent routes and read by
// nothing else — so that sentence described code that did not exist. The
// canonical text says what is true instead: withdrawal is recorded as a new
// event, the original record is never altered or deleted, we do not map or read
// under a withdrawn permission, and withdrawal does NOT by itself erase a map
// already built. A later phase still owes the enforcement; it no longer owes an
// already-published promise.

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

export type ConsentScope = 'map_metadata' | 'ingest_content';

/**
 * The locales that have reviewed, legally-operative text.
 *
 * `es-MX`, not bare `es`: the portal that renders these words types its
 * locales as `'en' | 'es-MX'` and enforces parity across exactly those two. A
 * consent surface speaking a locale the portal cannot produce is a surface no
 * Spanish speaker can reach — which is exactly what `'es'` was.
 */
export type ConsentLocale = 'en' | 'es-MX';

export const CONSENT_SCOPES: readonly ConsentScope[] = Object.freeze([
  'map_metadata',
  'ingest_content',
]);

export const CONSENT_LOCALES: readonly ConsentLocale[] = Object.freeze(['en', 'es-MX']);

/**
 * Whether this wording is the one to SHOW, or one kept only so that records
 * already stored against it can still be read back.
 *
 * `superseded` is not "deleted" and not "wrong" — it is the exact text some
 * human agreed to on some date, and it must stay resolvable by id for as long
 * as any record references it, which is forever (the consent log is
 * append-only). DERIVED from `manifest.current`, never typed per entry.
 */
export type DisclosureStatus = 'current' | 'superseded';

export interface ConsentDisclosure {
  /** Stable id for this exact wording. A new wording is a new id, never an edit. */
  disclosureId: string;
  scope: ConsentScope;
  locale: ConsentLocale;
  /** The words shown to the human, stored verbatim on the consent record. */
  text: string;
  /** SHA-256 of the canonical file's UTF-8 bytes. Computed here, never typed. */
  sha256: string;
  /** Exactly one entry per (scope, locale) is `current`. */
  status: DisclosureStatus;
}

interface ManifestEntry {
  disclosureId: string;
  scope: string;
  locale: string;
  file: string;
  sha256: string;
}

interface ConsentManifest {
  artifact: string;
  version: string;
  scopes: string[];
  locales: string[];
  current: Record<string, string>;
  disclosures: ManifestEntry[];
}

// The CJS bundle has no usable `import.meta.url` (the bundler rewrites
// `import.meta` to an empty object) but does have `__dirname`; the ESM builds
// and the test runner have the former and not the latter. Shadow-declare the
// CJS global so both probes typecheck under either module system.
declare const __dirname: string | undefined;

function moduleDir(): string {
  const url = import.meta.url as string | undefined;
  if (typeof url === 'string' && url.startsWith('file:')) {
    return dirname(fileURLToPath(url));
  }
  if (typeof __dirname === 'string') {
    return __dirname;
  }
  throw new Error(
    'Cannot locate the consent module directory: neither import.meta.url nor __dirname is usable.'
  );
}

/**
 * The vendored artifact root.
 *
 * Resolved from this module's own directory so ONE strategy works everywhere
 * the module runs. Under the test runner this file executes from
 * `src/consent/`, two hops above which is the package root; the published
 * build is BUNDLED flat into `dist/`, one hop above which is the package root
 * (`vendor/` ships alongside `dist/` in the package files). Probe both; if
 * neither holds a manifest, keep the src-shaped guess so the load below fails
 * loudly at import with the real path in the error, rather than serving a
 * disclosure it does not have.
 */
export const VENDORED_CONSENT_DIR: string = (() => {
  const fromModule = moduleDir();
  const candidates = [
    resolve(fromModule, '..', '..', 'vendor', 'consent'), // src/consent/ → package root
    resolve(fromModule, '..', 'vendor', 'consent'), // dist/ (bundled) → package root
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'disclosures.manifest.json'))) return candidate;
  }
  return candidates[0]!;
})();

/** SHA-256 of the exact UTF-8 bytes of a disclosure text, lowercase hex. */
export function disclosureSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A pinned set of disclosures a host can resolve against.
 *
 * The DEFAULT registry (below) is this package's vendored artifact, loaded and
 * SHA-verified at import. A host that owns its own canonical consent tree can
 * build a registry over its own pinned bytes with `createDisclosureRegistry`
 * and hand it to the consent store — the resolution rules and the fail-closed
 * checks are identical; only the directory differs.
 */
export interface DisclosureRegistry {
  /** The disclosure to SHOW for (scope, locale) — current version only, no fallback. */
  getDisclosure(scope: ConsentScope, locale: ConsentLocale): ConsentDisclosure | undefined;
  /** A stored record's disclosure BY ID, regardless of status. */
  getDisclosureById(disclosureId: string, locale: ConsentLocale): ConsentDisclosure | undefined;
  listDisclosures(): readonly ConsentDisclosure[];
}

function loadDisclosures(dir: string): readonly ConsentDisclosure[] {
  const manifestPath = join(dir, 'disclosures.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ConsentManifest;

  const loaded = manifest.disclosures.map((entry) => {
    if (!(CONSENT_SCOPES as readonly string[]).includes(entry.scope)) {
      throw new Error(`Vendored consent manifest declares unknown scope "${entry.scope}".`);
    }
    if (!(CONSENT_LOCALES as readonly string[]).includes(entry.locale)) {
      throw new Error(`Vendored consent manifest declares unknown locale "${entry.locale}".`);
    }
    // `entry.file` is a name out of the vendored manifest, and the manifest
    // is SHA-pinned — but scope and locale were validated against allowlists
    // just above while the FILENAME was joined unchecked, which is the one
    // field in this loop that reaches the filesystem. Validate it in kind: a
    // bare filename, nothing that could climb out of the vendored directory.
    // (Pre-existing; fixed while a security-scanner gate was being cleared for
    // the Plan 34 deploy rather than left red.)
    // Containment, not a filename pattern: these are relative paths WITH a
    // subdirectory ('disclosures/map_metadata.v1.en.md'), so the honest check
    // is that the resolved path stays inside the vendored directory — which
    // holds for any shape of relative path and cannot be argued with.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const disclosurePath = resolve(dir, entry.file);
    if (disclosurePath !== resolve(dir) && !disclosurePath.startsWith(resolve(dir) + sep)) {
      throw new Error(
        `Vendored consent manifest declares a disclosure file outside the vendored directory: "${entry.file}".`
      );
    }
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const text = readFileSync(disclosurePath, 'utf8');
    const sha = disclosureSha256(text);
    if (sha !== entry.sha256) {
      // Fail closed at import. The alternative is serving text whose hash the
      // manifest disagrees with, and then writing that hash onto a consent
      // record — a record that asserts something false about itself.
      throw new Error(
        `Vendored consent disclosure ${entry.file} does not match its manifest SHA-256 ` +
          `(manifest=${entry.sha256} bytes=${sha}). Re-vendor from the canonical consent/ tree.`
      );
    }
    return Object.freeze({
      disclosureId: entry.disclosureId,
      scope: entry.scope as ConsentScope,
      locale: entry.locale as ConsentLocale,
      text,
      sha256: sha,
      // DERIVED, not declared. `current` names one id per scope, so two entries
      // for one (scope, locale) cannot both be current by construction.
      status: (manifest.current[entry.scope] === entry.disclosureId
        ? 'current'
        : 'superseded') as DisclosureStatus,
    });
  });

  // Every scope must be showable in every locale, or somebody cannot consent.
  for (const scope of CONSENT_SCOPES) {
    for (const locale of CONSENT_LOCALES) {
      const current = loaded.filter(
        (d) => d.scope === scope && d.locale === locale && d.status === 'current'
      );
      if (current.length !== 1) {
        throw new Error(
          `Vendored consent artifact has ${current.length} current disclosures for ` +
            `${scope}/${locale}; a scope missing a locale means that language cannot ` +
            'consent at all, and two means we cannot say which words were shown.'
        );
      }
    }
  }

  return Object.freeze(loaded);
}

/**
 * Build a registry over a pinned disclosure tree on disk. Same manifest shape,
 * same SHA verification, same exactly-one-current invariant as the default —
 * everything is checked here, at construction, so a registry that exists is a
 * registry whose bytes are the bytes its manifest describes.
 */
export function createDisclosureRegistry(dir: string): DisclosureRegistry {
  const entries = loadDisclosures(dir);
  return Object.freeze({
    getDisclosure: (scope: ConsentScope, locale: ConsentLocale) =>
      selectCurrentDisclosure(entries, scope, locale),
    getDisclosureById: (disclosureId: string, locale: ConsentLocale) =>
      selectDisclosureById(entries, disclosureId, locale),
    listDisclosures: () => entries,
  });
}

/** The package's own vendored set — loaded, verified, and frozen at import. */
export const defaultDisclosureRegistry: DisclosureRegistry =
  createDisclosureRegistry(VENDORED_CONSENT_DIR);

export function isConsentScope(value: unknown): value is ConsentScope {
  return typeof value === 'string' && (CONSENT_SCOPES as readonly string[]).includes(value);
}

export function isConsentLocale(value: unknown): value is ConsentLocale {
  return typeof value === 'string' && (CONSENT_LOCALES as readonly string[]).includes(value);
}

/**
 * The locale to use when a caller names none.
 *
 * The deployment's `UI_LOCALE` env var answers `'en' | 'es'` for ordinary UI
 * strings (unset means `en`, and anything starting with `es` means Spanish)
 * and is deliberately not changing — unrelated messages depend on that
 * coarser answer. This maps it onto the consent locale set once, here, where
 * the mapping is visible.
 *
 * It is a SERVER-SIDE DEFAULT, not a wire alias: a request that explicitly says
 * `locale=es` is still refused. Substituting Mexican-Spanish consent text for a
 * locale we did not review, on a record that will assert the subject read it,
 * is the same false-record failure as falling back to English.
 */
export function defaultConsentLocale(): ConsentLocale {
  const raw = (process.env.UI_LOCALE || 'en').trim().toLowerCase();
  return raw.startsWith('es') ? 'es-MX' : 'en';
}

/**
 * The resolution rule, as a pure function over any registry.
 *
 * Exported separately from `getDisclosure` so the rule can be tested against a
 * registry that actually HAS more than one version — the real registry has one,
 * so a test written only against it cannot tell "serves the current version"
 * apart from "serves whichever entry happens to be first", which is precisely
 * the bug this replaced.
 *
 * Returns undefined unless EXACTLY ONE entry is current for that (scope,
 * locale). Two currents is an ambiguous registry, and the fail-closed answer to
 * "which of these two texts did we show you" is to refuse to record a consent
 * at all rather than pick one.
 */
export function selectCurrentDisclosure(
  entries: readonly ConsentDisclosure[],
  scope: ConsentScope,
  locale: ConsentLocale
): ConsentDisclosure | undefined {
  const current = entries.filter(
    (d) => d.scope === scope && d.locale === locale && d.status === 'current'
  );
  return current.length === 1 ? current[0] : undefined;
}

/** By-id resolution, as a pure function. See `getDisclosureById`. */
export function selectDisclosureById(
  entries: readonly ConsentDisclosure[],
  disclosureId: string,
  locale: ConsentLocale
): ConsentDisclosure | undefined {
  return entries.find((d) => d.disclosureId === disclosureId && d.locale === locale);
}

/**
 * Resolve the disclosure to SHOW for a scope in a locale — the current
 * version, never merely the first one registered.
 *
 * NO FALLBACK, deliberately. Falling back to English for an unregistered
 * locale would store English words on the record of a Spanish-speaking
 * subject and assert they read them — a false record, which is worse than a
 * refusal. An unknown locale returns undefined and the caller refuses.
 */
export function getDisclosure(
  scope: ConsentScope,
  locale: ConsentLocale
): ConsentDisclosure | undefined {
  return defaultDisclosureRegistry.getDisclosure(scope, locale);
}

/**
 * Resolve a stored record's disclosure BY ID, regardless of status.
 *
 * This is the reader for the audit direction: a consent written in March
 * against `map_metadata.v1` still resolves after `v2` supersedes it, so
 * "which permission did this person actually give" is answerable from the
 * registry and not only from the verbatim copy on the record itself. Locale
 * is required because one id exists per locale — an id alone would resolve to
 * whichever translation is listed first.
 */
export function getDisclosureById(
  disclosureId: string,
  locale: ConsentLocale
): ConsentDisclosure | undefined {
  return defaultDisclosureRegistry.getDisclosureById(disclosureId, locale);
}

export function listDisclosures(): readonly ConsentDisclosure[] {
  return defaultDisclosureRegistry.listDisclosures();
}
