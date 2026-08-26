// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CONSENT_LOCALES,
  CONSENT_SCOPES,
  ConsentDisclosure,
  ConsentLocale,
  ConsentScope,
  VENDORED_CONSENT_DIR,
  createDisclosureRegistry,
  defaultConsentLocale,
  defaultDisclosureRegistry,
  disclosureSha256,
  getDisclosure,
  getDisclosureById,
  isConsentLocale,
  isConsentScope,
  listDisclosures,
  selectCurrentDisclosure,
  selectDisclosureById,
} from '../src/consent/disclosures.js';

// Plan 25 Phase C. These are not UI-copy tests — the disclosure text is the
// thing a stored consent record asserts the human read, so the governance rule
// ("never edit text in place; mint a new disclosureId") needs a check that
// FAILS when it is broken, not a comment asking nicely.
//
// WHERE THE WORDS COME FROM. This package authors none of them. Canonical is
// the repository's `consent/` tree, vendored byte-identically into
// `vendor/consent/`, with CI sha256-comparing the two on every build. The pins
// below are the in-package half of that: they fail on an edit to the vendored
// copy even before CI compares it to the canonical tree.
//
// WHY THE SUBSTANCE CHECKS BELOW ARE WHOLE SENTENCES AND NOT TOKENS.
// An earlier version asserted `toContain('not harmless')` under a comment
// claiming the disclosure "must not sell path-reading as low-sensitivity", and
// `toMatch(/delete|elimina/i)` under a comment claiming none of them says we
// may delete a user's file. Both are token-presence checks standing in for a
// claim about MEANING, and a verifier broke both while keeping them green:
//
//   - the sensitivity paragraph was rewritten to "Because we read only names
//     and never contents, mapping is a privacy-preserving operation" with the
//     words "not harmless" left in place elsewhere — the overclaim §6.1 exists
//     to prevent, passing the check meant to prevent it;
//   - the never-modify sentence was inverted to "We create, change, move, and
//     delete any file or folder in your storage at our discretion" — which
//     still contains "delete", so the regex was satisfied by the exact
//     promise-breaking sentence it was written to forbid.
//
// A phrase being present is not the same claim as an overclaim being absent.
// Every check below therefore asserts a whole sentence, in EVERY locale, and
// the FORBIDDEN patterns catch the specific rewrites that would otherwise
// survive.

/**
 * SHA-256 of every registered disclosure, pinned.
 *
 * Editing a vendored file without minting a new `disclosureId` fails
 * `pins every registered disclosure text by SHA-256`. That is the whole point:
 * silently re-wording `map_metadata.v1` would leave every already-stored record
 * claiming its subject read words that no longer exist anywhere, and nothing
 * else in this repo would notice.
 */
const PINNED: Record<string, string> = {
  'map_metadata.v1|en': '145e3d7b326816dcbaf500c3056ade36e001fab34f5c1c52196f7e70d4838025',
  'map_metadata.v1|es-MX': 'b2b6ff9f62fa7bf25aaba5cf9bdb9d0ed8c5ebd6f497f4176e9146e7b2320c65',
  'ingest_content.v1|en': '90ebf79b000b75f63b9929c12fcee062c081e1186865bdb180a78aeadadba8ae',
  'ingest_content.v1|es-MX': '1dfe22af5ba410a7723170aa9e32f7865d189003614d16d59e49856c217c555b',
};

/** SHA-256 of the vendored manifest itself — one hash covering the whole set. */
const PINNED_MANIFEST_SHA = '6951541a6eecef64768265e7cb6f9380b7bea13bf3cf30abe61098d26ae8e234';

const manifestPath = join(VENDORED_CONSENT_DIR, 'disclosures.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

describe('vendored consent artifact', () => {
  it('is the artifact this repo thinks it is — manifest SHA-256 pinned', () => {
    // Deliberately hashed with an implementation OTHER than the module's own
    // (`createHash` over the raw Buffer, not over a decoded string), so a bug
    // in disclosureSha256 cannot make this agree with itself.
    const actual = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    expect(
      actual,
      'vendor/consent/disclosures.manifest.json changed. Re-vendor from the canonical ' +
        'consent/ tree and update PINNED_MANIFEST_SHA deliberately — this is the review event.'
    ).toBe(PINNED_MANIFEST_SHA);
  });

  it('pins every registered disclosure text by SHA-256', () => {
    for (const d of listDisclosures()) {
      const key = `${d.disclosureId}|${d.locale}`;
      expect(PINNED[key], `unpinned disclosure ${key} — add its SHA to PINNED`).toBeDefined();
      expect(disclosureSha256(d.text), `text of ${key} changed without a new disclosureId`).toBe(
        PINNED[key]
      );
      expect(d.sha256, `${key} exposes a SHA that is not its own text's`).toBe(PINNED[key]);
    }
  });

  it('pins in both directions — a removed disclosure fails too', () => {
    const registered = new Set(listDisclosures().map((d) => `${d.disclosureId}|${d.locale}`));
    for (const key of Object.keys(PINNED)) {
      expect(registered.has(key), `pinned disclosure ${key} is no longer registered`).toBe(true);
    }
    expect(registered.size).toBe(Object.keys(PINNED).length);
  });

  it('exposes text byte-identical to the vendored file on disk', () => {
    for (const d of listDisclosures()) {
      const entry = manifest.disclosures.find(
        (e: { disclosureId: string; locale: string }) =>
          e.disclosureId === d.disclosureId && e.locale === d.locale
      );
      expect(entry, `${d.disclosureId}|${d.locale} is not in the manifest`).toBeDefined();
      const onDisk = readFileSync(join(VENDORED_CONSENT_DIR, entry.file), 'utf8');
      expect(d.text, `text drift for ${d.disclosureId}|${d.locale}`).toBe(onDisk);
    }
  });

  it('registers every .md file in the vendored tree — an unregistered file is invisible', () => {
    // The failure this catches: a file is vendored (or added) and never wired
    // into the manifest. Nothing breaks, nothing is shown, and a disclosure
    // everyone believes exists silently does not.
    const onDisk = readdirSync(join(VENDORED_CONSENT_DIR, 'disclosures'))
      .filter((f) => f.endsWith('.md'))
      .sort();
    const registered = listDisclosures()
      .map((d) => `${d.disclosureId}.${d.locale}.md`)
      .sort();
    expect(onDisk).toEqual(registered);
  });
});

describe('consent disclosure registry', () => {
  it('covers every scope in every supported locale', () => {
    for (const scope of CONSENT_SCOPES) {
      for (const locale of CONSENT_LOCALES) {
        const d = getDisclosure(scope, locale);
        expect(d, `no disclosure for ${scope}/${locale}`).toBeDefined();
        expect(d!.scope).toBe(scope);
        expect(d!.locale).toBe(locale);
        expect(d!.text.trim().length).toBeGreaterThan(200);
      }
    }
  });

  it('SERVES SPANISH — es-MX resolves, which is the locale the portal sends', () => {
    // The worst defect in the round this replaced: the API service registered
    // `es` and the portal can only produce `es-MX` (its locale type admits
    // exactly 'en' | 'es-MX'), so every Spanish grant was 400
    // disclosure_not_found. Named on its own so a regression reads as what it
    // is.
    for (const scope of CONSENT_SCOPES) {
      const d = getDisclosure(scope, 'es-MX');
      expect(d, `${scope} has no es-MX disclosure — no Spanish speaker can consent`).toBeDefined();
      expect(d!.locale).toBe('es-MX');
      expect(d!.text).not.toBe(getDisclosure(scope, 'en')!.text);
    }
    expect(isConsentLocale('es-MX')).toBe(true);
    expect(CONSENT_LOCALES).toContain('es-MX');
  });

  it('never falls back to another locale for an unregistered one', () => {
    // A fallback would store ENGLISH words on the record of a subject who was
    // shown something else — a false statement about what they read, which is
    // strictly worse than refusing to record consent at all. Bare `es` is in
    // here on purpose: it is NOT an alias for es-MX.
    expect(getDisclosure('map_metadata', 'fr' as ConsentLocale)).toBeUndefined();
    expect(getDisclosure('map_metadata', 'es' as ConsentLocale)).toBeUndefined();
    expect(getDisclosure('ingest_content', 'de' as ConsentLocale)).toBeUndefined();
  });

  it('has no disclosure for an unregistered scope', () => {
    expect(getDisclosure('delete_everything' as ConsentScope, 'en')).toBeUndefined();
  });

  it('validates scope and locale inputs, rejecting anything else', () => {
    expect(isConsentScope('map_metadata')).toBe(true);
    expect(isConsentScope('ingest_content')).toBe(true);
    expect(isConsentScope('MAP_METADATA')).toBe(false);
    expect(isConsentScope('')).toBe(false);
    expect(isConsentScope(undefined)).toBe(false);
    expect(isConsentScope(42)).toBe(false);

    expect(isConsentLocale('en')).toBe(true);
    expect(isConsentLocale('es-MX')).toBe(true);
    expect(isConsentLocale('es')).toBe(false);
    expect(isConsentLocale('es-mx')).toBe(false);
    expect(isConsentLocale('fr')).toBe(false);
    expect(isConsentLocale('EN')).toBe(false);
    expect(isConsentLocale(undefined)).toBe(false);
  });

  it('defaults a caller-unspecified locale onto a REGISTERED locale', () => {
    // UI_LOCALE mirrors the portal's env var and yields en|es for ordinary UI
    // strings. Whatever it says, the consent default must be a locale this
    // registry actually has — the old code fed 'es' straight in and got a 400
    // out of its own default path.
    const before = process.env.UI_LOCALE;
    try {
      process.env.UI_LOCALE = 'es';
      expect(defaultConsentLocale()).toBe('es-MX');
      expect(getDisclosure('map_metadata', defaultConsentLocale())).toBeDefined();
      process.env.UI_LOCALE = 'es-MX';
      expect(defaultConsentLocale()).toBe('es-MX');
      delete process.env.UI_LOCALE;
      expect(defaultConsentLocale()).toBe('en');
      expect(getDisclosure('map_metadata', defaultConsentLocale())).toBeDefined();
    } finally {
      if (before === undefined) delete process.env.UI_LOCALE;
      else process.env.UI_LOCALE = before;
    }
  });

  it('hashes the exact UTF-8 bytes, so an accent change is a different SHA', () => {
    expect(disclosureSha256('a')).toBe(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
    );
    expect(disclosureSha256('revocación')).not.toBe(disclosureSha256('revocacion'));
  });
});

// ---------------------------------------------------------------------------
// INJECTABLE REGISTRY — same fail-closed load, any pinned tree.
//
// `createDisclosureRegistry(dir)` is how a host that owns its own canonical
// consent tree replaces the vendored default. It must be the SAME loader with
// the SAME checks — a host registry that skipped SHA verification would be a
// consent surface whose bytes nobody vouched for.
// ---------------------------------------------------------------------------

describe('createDisclosureRegistry', () => {
  it('over the vendored dir, yields exactly the default registry set', () => {
    const registry = createDisclosureRegistry(VENDORED_CONSENT_DIR);
    expect(registry.listDisclosures()).toEqual(defaultDisclosureRegistry.listDisclosures());
    for (const scope of CONSENT_SCOPES) {
      for (const locale of CONSENT_LOCALES) {
        expect(registry.getDisclosure(scope, locale)).toEqual(getDisclosure(scope, locale));
      }
    }
    for (const d of listDisclosures()) {
      expect(registry.getDisclosureById(d.disclosureId, d.locale)).toEqual(
        getDisclosureById(d.disclosureId, d.locale)
      );
    }
  });

  it('fails closed on a directory with no manifest', () => {
    const empty = mkdtempSync(join(tmpdir(), 'consent-empty-'));
    expect(() => createDisclosureRegistry(empty)).toThrow();
  });

  it('fails closed at construction when bytes do not match the manifest SHA', () => {
    // Copy the real vendored artifact, then flip one byte of one disclosure.
    // The registry must refuse to exist — the alternative is serving text
    // whose hash the manifest disagrees with, and then writing that hash onto
    // a consent record.
    const dir = mkdtempSync(join(tmpdir(), 'consent-tampered-'));
    mkdirSync(join(dir, 'disclosures'));
    writeFileSync(join(dir, 'disclosures.manifest.json'), readFileSync(manifestPath));
    for (const entry of manifest.disclosures) {
      writeFileSync(join(dir, entry.file), readFileSync(join(VENDORED_CONSENT_DIR, entry.file)));
    }
    const victim = join(dir, manifest.disclosures[0].file);
    writeFileSync(victim, readFileSync(victim, 'utf8') + ' ');
    expect(() => createDisclosureRegistry(dir)).toThrow(/does not match its manifest SHA-256/);
  });
});

// ---------------------------------------------------------------------------
// VERSIONING — the correction procedure has to actually work.
//
// The module header says a correction means a NEW disclosureId, leaving the old
// entry intact "so every stored record still resolves". Resolution used to be
// `.find(d => d.scope === scope && d.locale === locale)` — the id was not in
// the lookup at all, so a correctly registered `map_metadata.v2` was never
// served and the documented procedure was a no-op with the suite green.
//
// These run against SYNTHETIC registries on purpose. The real registry has
// exactly one version of everything, so no test written against it can
// distinguish "serves the current version" from "serves the first entry" —
// which is exactly how the defect survived.
// ---------------------------------------------------------------------------

const fixture = (
  disclosureId: string,
  locale: ConsentLocale,
  text: string,
  status: 'current' | 'superseded'
): ConsentDisclosure => ({
  disclosureId,
  scope: 'map_metadata',
  locale,
  text,
  sha256: disclosureSha256(text),
  status,
});

const FIXTURE_V1_EN = fixture('map_metadata.v1', 'en', 'v1 english words', 'superseded');
const FIXTURE_V1_ES = fixture('map_metadata.v1', 'es-MX', 'v1 palabras en español', 'superseded');
const FIXTURE_V2_EN = fixture('map_metadata.v2', 'en', 'v2 english words', 'current');
const FIXTURE_V2_ES = fixture('map_metadata.v2', 'es-MX', 'v2 palabras en español', 'current');
const CORRECTED: readonly ConsentDisclosure[] = [
  FIXTURE_V1_EN,
  FIXTURE_V1_ES,
  FIXTURE_V2_EN,
  FIXTURE_V2_ES,
];

describe('disclosure versioning', () => {
  it('serves the CURRENT version once a correction supersedes the old one', () => {
    for (const locale of CONSENT_LOCALES) {
      const served = selectCurrentDisclosure(CORRECTED, 'map_metadata', locale);
      expect(served, `no current disclosure for map_metadata/${locale}`).toBeDefined();
      expect(
        served!.disclosureId,
        `the correction is a no-op for ${locale}: v1 is still being served`
      ).toBe('map_metadata.v2');
    }
  });

  it('keeps every superseded version resolvable BY ID, for records already stored', () => {
    // A consent written in March against v1 must still resolve in December. If
    // this stops working, "which permission did this person give" is answerable
    // only from the copy on the record, and a corrupted or truncated record has
    // nothing to be checked against.
    expect(selectDisclosureById(CORRECTED, 'map_metadata.v1', 'en')).toEqual(FIXTURE_V1_EN);
    expect(selectDisclosureById(CORRECTED, 'map_metadata.v1', 'es-MX')).toEqual(FIXTURE_V1_ES);
    expect(selectDisclosureById(CORRECTED, 'map_metadata.v2', 'en')).toEqual(FIXTURE_V2_EN);
  });

  it('resolves an id per locale, never one locale standing in for another', () => {
    expect(
      selectDisclosureById(CORRECTED, 'map_metadata.v1', 'fr' as ConsentLocale)
    ).toBeUndefined();
    expect(selectDisclosureById(CORRECTED, 'map_metadata.v3', 'en')).toBeUndefined();
  });

  it('refuses to serve anything when two entries both claim to be current', () => {
    // Fail closed. "Which of these two texts did we show you" has no correct
    // answer, and recording a consent against a guess is a false record.
    const ambiguous = [{ ...FIXTURE_V1_EN, status: 'current' as const }, FIXTURE_V2_EN];
    expect(selectCurrentDisclosure(ambiguous, 'map_metadata', 'en')).toBeUndefined();
  });

  it('refuses to serve anything when nothing is current', () => {
    const allRetired = [FIXTURE_V1_EN, { ...FIXTURE_V2_EN, status: 'superseded' as const }];
    expect(selectCurrentDisclosure(allRetired, 'map_metadata', 'en')).toBeUndefined();
  });

  it('has exactly one CURRENT disclosure per (scope, locale) in the real registry', () => {
    for (const scope of CONSENT_SCOPES) {
      for (const locale of CONSENT_LOCALES) {
        const current = listDisclosures().filter(
          (d) => d.scope === scope && d.locale === locale && d.status === 'current'
        );
        expect(
          current.map((d) => d.disclosureId),
          `${scope}/${locale} must have exactly one current disclosure`
        ).toHaveLength(1);
      }
    }
  });

  it('derives status from the manifest, so `current` decides what is served', () => {
    // status is not typed per entry — it comes from manifest.current[scope].
    // This is what makes "two entries both current" unrepresentable rather than
    // merely checked.
    for (const d of listDisclosures()) {
      const expected = manifest.current[d.scope] === d.disclosureId ? 'current' : 'superseded';
      expect(d.status, `${d.disclosureId}|${d.locale}`).toBe(expected);
    }
  });

  it('keeps a scope on ONE version across locales — never en on v2 and es-MX on v1', () => {
    // Two locales on different versions is two different permissions being
    // granted under one name, and the record only says which locale.
    for (const scope of CONSENT_SCOPES) {
      const currentIds = CONSENT_LOCALES.map((locale) => getDisclosure(scope, locale)?.disclosureId);
      expect(new Set(currentIds).size, `${scope} locales disagree on version: ${currentIds}`).toBe(
        1
      );
    }
  });

  it('resolves the real registry by id, current or not', () => {
    for (const d of listDisclosures()) {
      expect(getDisclosureById(d.disclosureId, d.locale), `${d.disclosureId}|${d.locale}`).toEqual(
        d
      );
    }
    expect(getDisclosureById('map_metadata.v99', 'en')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SUBSTANCE — the promises neither locale may quietly lose.
//
// The SHA pin above catches ANY edit. This catches the specific edit that
// matters: a rewrite that still looks like a disclosure while dropping or
// inverting a promise. Every requirement names what it protects and gives the
// whole sentence that carries it IN EACH LOCALE — `Record<ConsentLocale,
// string>` means a locale added to the platform without its sentence is a
// compile error, not a silently unchecked translation.
//
// Upstream of this extraction, the same substance was asserted, sentence for
// sentence, by the portal that renders these words and by a validator script
// living beside the canonical files. Three checks over one set of bytes is
// the point: this package hashes the words, the portal shows them, and the
// canonical tree owns them.
// ---------------------------------------------------------------------------

interface Requirement {
  /** What the sentence protects, in the words a failure should read as. */
  readonly requirement: string;
  readonly phrases: Readonly<Record<ConsentLocale, string>>;
}

/** Collapse whitespace before matching — the canonical files are hard-wrapped
 * prose, so a required sentence is usually split across a line break and
 * re-wrapping a paragraph must not fail a substance check. Exact bytes are
 * pinned separately. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const REQUIRED: Readonly<Record<ConsentScope, readonly Requirement[]>> = {
  map_metadata: [
    {
      requirement: 'states plainly that document contents are NOT opened under this permission',
      phrases: {
        en: 'We do not open, download, or read the contents of any document.',
        'es-MX': 'No abrimos, no descargamos ni leemos el contenido de ningún documento.',
      },
    },
    {
      requirement: 'says names and paths are sensitive rather than incidental',
      phrases: {
        en: 'Names and paths are not harmless.',
        'es-MX': 'Los nombres y las rutas no son inofensivos.',
      },
    },
    {
      requirement:
        'REFUSES to sell name-reading as privacy-preserving (§6.1 — the overclaim this platform must not make)',
      phrases: {
        en: '## This is not a privacy feature',
        'es-MX': '## Esto no es una función de privacidad',
      },
    },
    {
      requirement: 'uses the defensible framing: we read less, and we say precisely what',
      phrases: {
        en: 'we read less, and we tell you precisely what we read',
        'es-MX': 'leemos menos, y le decimos con precisión qué leemos',
      },
    },
    {
      requirement: 'warns that the sharing graph is organisational intelligence',
      phrases: {
        en: 'a map of sharing is also a map of who works with whom',
        'es-MX': 'un mapa del uso compartido es también un mapa de quién trabaja con quién',
      },
    },
    {
      requirement:
        'discloses INTRA-TENANT exposure — colleagues may reach it even where storage would not let them',
      phrases: {
        en: 'Other people in that workspace may be able to reach what it contains',
        'es-MX': 'Otras personas de ese espacio podrían alcanzar lo que contiene',
      },
    },
    {
      requirement:
        'discloses that using the map sends parts of it to the configured inference service',
      phrases: {
        en: 'are sent to the inference service configured for your workspace',
        'es-MX': 'se envían al servicio de inferencia configurado para su espacio de trabajo',
      },
    },
    {
      requirement: 'promises we never create, change, move or DELETE a user file',
      phrases: {
        en: 'this service does not create, rename, move, overwrite or delete anything in your storage while mapping. It never deletes one of your files',
        'es-MX':
          'este servicio no crea, no renombra, no mueve, no sobrescribe ni elimina nada en su almacenamiento mientras mapea. Nunca elimina un archivo suyo',
      },
    },
    {
      requirement: 'states the permission can be withdrawn at any time',
      phrases: {
        en: 'You can withdraw this permission at any time',
        'es-MX': 'Puede revocar este permiso cuando lo desee',
      },
    },
    {
      requirement:
        'is HONEST that withdrawal does not by itself erase a map already built (nothing consumes the consent record yet)',
      phrases: {
        en: '**Withdrawing does not, by itself, erase a map that was already built.**',
        'es-MX': '**Revocar no borra por sí solo el mapa que ya se construyó.**',
      },
    },
  ],
  ingest_content: [
    {
      requirement: 'states plainly that full document contents ARE read',
      phrases: {
        en: '**We download the full contents** of the supported documents in the folders',
        'es-MX': '**Descargamos el contenido completo** de los documentos compatibles',
      },
    },
    {
      requirement: 'states the text is indexed and can be quoted back word for word',
      phrases: {
        en: 'quoted back word for word in answers',
        'es-MX': 'citar textualmente en las respuestas',
      },
    },
    {
      requirement:
        'discloses that content is processed by the inference service configured for the workspace',
      phrases: {
        en: 'its text has to pass through the inference service configured for your workspace',
        'es-MX':
          'su texto tiene que pasar por el servicio de inferencia configurado para su espacio de trabajo',
      },
    },
    {
      requirement:
        'discloses INTRA-TENANT exposure — colleagues may retrieve it and be quoted passages',
      phrases: {
        en: 'other people in that workspace may be able to retrieve it',
        'es-MX': 'otras personas de ese espacio podrían recuperarlo',
      },
    },
    {
      requirement: 'states no other customer can read it and no model is trained on it',
      phrases: {
        en: 'your workspace is isolated from every other workspace',
        'es-MX': 'su espacio de trabajo está aislado de todos los demás',
      },
    },
    {
      requirement: 'promises we never create, change, move or DELETE a user file',
      phrases: {
        en: 'this service does not create, rename, move, overwrite or delete anything in your storage. **It never deletes one of your files',
        'es-MX':
          'este servicio no crea, no renombra, no mueve, no sobrescribe ni elimina nada en su almacenamiento. **Nunca elimina un archivo suyo',
      },
    },
    {
      requirement: 'states the permission can be withdrawn at any time',
      phrases: {
        en: 'You can withdraw this permission at any time',
        'es-MX': 'Puede revocar este permiso cuando lo desee',
      },
    },
    {
      requirement: 'is HONEST that withdrawal does not by itself remove what was already read',
      phrases: {
        en: '**Withdrawing does not, by itself, remove what has already been read.**',
        'es-MX': '**Revocar no elimina por sí solo lo que ya se leyó.**',
      },
    },
  ],
};

/**
 * Rewrites that would otherwise pass every "does it still say X" check by
 * ADDING a claim rather than removing one.
 *
 * Each entry is a real mutation a verifier landed, or its direct translation.
 * A denylist is the second layer and never the first — the required sentences
 * above are what actually hold the line.
 *
 * NOTE the Spanish pattern's negative lookbehind. The canonical refusal is
 * "Esto NO es una función de privacidad", which contains the affirmative as a
 * substring; a naive `/función de privacidad/i` would be tripped by the very
 * sentence that refuses the overclaim, and the check would then be deleted as
 * broken. Same trap, same fix, in the canonical tree's validator.
 */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /privacy[-\s]preserving/i, why: 'frames metadata-only reading as a privacy feature' },
  { pattern: /\bis a privacy feature\b/i, why: 'frames metadata-only reading as a privacy feature' },
  {
    pattern: /(?<!no )es una función de privacidad/i,
    why: 'frames metadata-only reading as a privacy feature',
  },
  { pattern: /protege la privacidad/i, why: 'frames metadata-only reading as a privacy feature' },
  { pattern: /preserva la privacidad/i, why: 'frames metadata-only reading as a privacy feature' },
  { pattern: /low[-\s]sensitivity/i, why: 'sells path-reading as low-sensitivity (§6.1)' },
  { pattern: /baja sensibilidad/i, why: 'sells path-reading as low-sensitivity (§6.1)' },
  { pattern: /at our discretion/i, why: "claims unbounded latitude over a user's storage" },
  { pattern: /a nuestra discreción/i, why: "claims unbounded latitude over a user's storage" },
  {
    pattern: /stops being used|deja de utilizarse/i,
    why: 'promises a present-tense revocation effect nothing implements — the exact sentence this round removed',
  },
];

/**
 * Internal vocabulary that must never reach a customer-facing page. House rule:
 * the graph database product is never named in customer-facing text.
 * Multi-character tokens only — a short token like "opa" is a substring of
 * ordinary Spanish ("ropa", "Europa").
 */
const FORBIDDEN_TERMS = [
  'falkordb',
  'neo4j',
  'cypher',
  'milvus',
  'mongodb',
  'litellm',
  'keycloak',
  'kubernetes',
  'seaweedfs',
  'openbao',
  'temporal workflow',
];

describe('disclosure substance — asserted in EVERY locale', () => {
  for (const scope of CONSENT_SCOPES) {
    for (const { requirement, phrases } of REQUIRED[scope]) {
      for (const locale of CONSENT_LOCALES) {
        it(`${scope} (${locale}) ${requirement}`, () => {
          const d = getDisclosure(scope, locale);
          expect(d, `no disclosure for ${scope}/${locale}`).toBeDefined();
          expect(flat(d!.text)).toContain(flat(phrases[locale]));
        });
      }
    }
  }

  it('requires the same substance of every registered scope — none left unchecked', () => {
    // The structural half of the cross-locale guarantee: a scope or locale that
    // exists in the registry but has no requirements would be free to say
    // anything at all, and every per-sentence test above would still pass.
    for (const scope of CONSENT_SCOPES) {
      expect(REQUIRED[scope]?.length, `${scope} has no required substance`).toBeGreaterThan(3);
      for (const { phrases } of REQUIRED[scope]) {
        for (const locale of CONSENT_LOCALES) {
          expect(
            phrases[locale]?.trim(),
            `${scope} has no phrase for locale ${locale}`
          ).toBeTruthy();
        }
      }
    }
  });

  it('never adds an overclaim, in either locale', () => {
    for (const d of listDisclosures()) {
      for (const { pattern, why } of FORBIDDEN) {
        expect(d.text, `${d.disclosureId}|${d.locale} ${why} (${pattern})`).not.toMatch(pattern);
      }
    }
  });

  it('never names internal infrastructure to a customer', () => {
    for (const d of listDisclosures()) {
      const lower = d.text.toLowerCase();
      for (const term of FORBIDDEN_TERMS) {
        expect(lower, `${d.disclosureId}|${d.locale} names "${term}"`).not.toContain(term);
      }
    }
  });
});

describe('cross-locale parity', () => {
  it('gives the locales genuinely different text, not one copied over the other', () => {
    for (const scope of CONSENT_SCOPES) {
      const [en, es] = [getDisclosure(scope, 'en')!, getDisclosure(scope, 'es-MX')!];
      expect(en.text).not.toBe(es.text);
      expect(en.sha256).not.toBe(es.sha256);
    }
  });

  it('keeps the same sections in both locales — a section dropped from one fails', () => {
    // Deleting a whole clause from the Spanish alone (the sharing warning, the
    // withdrawal clause) is the cheapest way to end up with two disclosures
    // that promise different things.
    for (const scope of CONSENT_SCOPES) {
      const headings = (locale: ConsentLocale) =>
        (getDisclosure(scope, locale)!.text.match(/^## /gm) ?? []).length;
      expect(headings('en'), `${scope}: en has too few sections to be checking anything`).toBeGreaterThan(5);
      expect(
        headings('es-MX'),
        `${scope}: es-MX has a different number of sections than en`
      ).toBe(headings('en'));
    }
  });

  it('registers the same disclosureIds in every locale', () => {
    const idsFor = (locale: ConsentLocale) =>
      listDisclosures()
        .filter((d) => d.locale === locale)
        .map((d) => d.disclosureId)
        .sort();
    expect(idsFor('es-MX')).toEqual(idsFor('en'));
  });
});
