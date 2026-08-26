// SPDX-License-Identifier: Apache-2.0
// JRN-8 — the consent-scope algebra, pure. These are the predicates the
// workflow's boundary prune and the selection refusal both stand on; the
// workflow-level halves are proven in driveMapWorkflow.test.ts (the
// mutation-check prune test) and selectiveIngestActivities.test.ts (the
// typed refusal).
import { describe, expect, it } from 'vitest';
import {
  isConsentExcluded,
  isWithinConsentTarget,
  mapRootWithinConsent,
  normalizeConsentPath,
} from '../src/index';

describe('normalizeConsentPath', () => {
  it("forces a leading '/', collapses duplicates, drops a trailing one", () => {
    expect(normalizeConsentPath('Team')).toBe('/Team');
    expect(normalizeConsentPath('/Team/')).toBe('/Team');
    expect(normalizeConsentPath('//Team//Private')).toBe('/Team/Private');
    expect(normalizeConsentPath('/')).toBe('/');
    expect(normalizeConsentPath('')).toBe('/');
  });
});

describe('mapRootWithinConsent — fail closed on identity, not path strings', () => {
  it('a whole-drive grant (null folderId) admits any root', () => {
    expect(mapRootWithinConsent(null, { folderId: null, folderPath: null })).toBe(true);
    expect(mapRootWithinConsent('fld-x', { folderId: null, folderPath: null })).toBe(true);
  });

  it('a legacy grant with no target at all reads as whole-drive', () => {
    expect(mapRootWithinConsent(null, null)).toBe(true);
    expect(mapRootWithinConsent('fld-x', undefined)).toBe(true);
  });

  it('a subtree grant admits EXACTLY the folder it names', () => {
    const target = { folderId: 'fld-team', folderPath: '/Team' };
    expect(mapRootWithinConsent('fld-team', target)).toBe(true);
    expect(mapRootWithinConsent('fld-other', target)).toBe(false);
    // The drive root is NOT the consented subtree — mapping it would walk
    // siblings the human never consented to. Refused, not resolved.
    expect(mapRootWithinConsent(null, target)).toBe(false);
  });
});

describe('isWithinConsentTarget', () => {
  it('null / root folderPath admits everything', () => {
    expect(isWithinConsentTarget('/anything/x.md', null)).toBe(true);
    expect(isWithinConsentTarget('/anything/x.md', '/')).toBe(true);
    expect(isWithinConsentTarget('/anything/x.md', undefined)).toBe(true);
  });

  it('a subtree admits itself and its descendants, nothing else', () => {
    expect(isWithinConsentTarget('/Team', '/Team')).toBe(true);
    expect(isWithinConsentTarget('/Team/doc.md', '/Team')).toBe(true);
    expect(isWithinConsentTarget('/Team/deep/doc.md', '/Team')).toBe(true);
    expect(isWithinConsentTarget('/Teammates/doc.md', '/Team')).toBe(false); // prefix ≠ subtree
    expect(isWithinConsentTarget('/Other/doc.md', '/Team')).toBe(false);
  });
});

describe('isConsentExcluded — the prune predicate', () => {
  it('matches the exclusion itself and anything under it', () => {
    expect(isConsentExcluded('/Private', ['/Private'])).toBe(true);
    expect(isConsentExcluded('/Private/tax.pdf', ['/Private'])).toBe(true);
    expect(isConsentExcluded('/Private2/x.md', ['/Private'])).toBe(false); // prefix ≠ subtree
    expect(isConsentExcluded('/Docs/x.md', ['/Private'])).toBe(false);
  });

  it('normalizes both sides, so a sloppily-recorded exclusion still bites', () => {
    expect(isConsentExcluded('/Private/tax.pdf', ['Private/'])).toBe(true);
  });

  it('an empty exclusion list excludes nothing; a root exclusion excludes everything', () => {
    expect(isConsentExcluded('/anything', [])).toBe(false);
    expect(isConsentExcluded('/anything', ['/'])).toBe(true);
  });
});
