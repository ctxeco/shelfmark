// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { GraphHttpError } from '@shelfmark/graph';
import {
  consentCheckOf,
  deriveActiveMapConsent,
  graphThrottleFailure,
  mapPathJoin,
  GRAPH_THROTTLED_ERROR_TYPE,
  MAP_CONSENT_SCOPE,
  type ConsentEventDoc,
} from '../src/index';

// ── Consent derivation — a PORT of the consent store's activeConsents ───────
//
// (@shelfmark/core consent/store.ts): a grant is live until some revocation
// event names its consentId; whether a consent is active is DERIVED from the
// append-only stream, never read off a status field. These tests pin the
// semantics this side must not drift from — two implementations of one rule
// set diverging silently is the failure class the whole vendored-artifact
// discipline exists to prevent.
describe('deriveActiveMapConsent', () => {
  const grant = (consentId: string, scope: string = MAP_CONSENT_SCOPE): ConsentEventDoc => ({
    consentId,
    action: 'granted',
    revokesConsentId: null,
    scope,
    disclosureSha256: `sha-${consentId}`,
  });
  const revoke = (consentId: string, revokes: string): ConsentEventDoc => ({
    consentId,
    action: 'revoked',
    revokesConsentId: revokes,
    scope: MAP_CONSENT_SCOPE,
  });

  it('finds an unrevoked map_metadata grant', () => {
    const active = deriveActiveMapConsent([grant('c-1')]);
    expect(active?.consentId).toBe('c-1');
    expect(active?.disclosureSha256).toBe('sha-c-1');
  });

  it('a revocation naming the grant deactivates it — revocation is a NEW EVENT, not an overwrite', () => {
    expect(deriveActiveMapConsent([revoke('c-2', 'c-1'), grant('c-1')])).toBeNull();
  });

  it('a revocation of a DIFFERENT grant leaves this one active', () => {
    const active = deriveActiveMapConsent([revoke('c-3', 'c-other'), grant('c-1')]);
    expect(active?.consentId).toBe('c-1');
  });

  it('one revoked grant does not shadow a second, still-live grant', () => {
    const active = deriveActiveMapConsent([grant('c-new'), revoke('c-r', 'c-old'), grant('c-old')]);
    expect(active?.consentId).toBe('c-new');
  });

  it('an ingest_content consent is NOT a map consent — scope is part of the check', () => {
    expect(deriveActiveMapConsent([grant('c-1', 'ingest_content')])).toBeNull();
  });

  it('an empty stream is a refusal, never a default-open', () => {
    expect(deriveActiveMapConsent([])).toBeNull();
  });

  it("pins the scope string to the core ConsentScope 'map_metadata'", () => {
    // Transcribed constant: if the consent canon renames the scope, this
    // moves in the same commit.
    expect(MAP_CONSENT_SCOPE).toBe('map_metadata');
  });
});

// ── JRN-8: the grant's scope travels with the check ─────────────────────────
describe('consentCheckOf', () => {
  it('carries the grant target and exclusions into the check result', () => {
    const check = consentCheckOf({
      consentId: 'c-1',
      action: 'granted',
      revokesConsentId: null,
      scope: MAP_CONSENT_SCOPE,
      disclosureSha256: 'sha-1',
      target: { folderId: 'fld-team', folderPath: '/Team' },
      exclusions: ['/Team/Private'],
    });
    expect(check).toEqual({
      active: true,
      consentId: 'c-1',
      disclosureSha256: 'sha-1',
      target: { folderId: 'fld-team', folderPath: '/Team' },
      exclusions: ['/Team/Private'],
    });
  });

  it('a grant with no recorded target reads as whole-drive (target null), with no exclusions', () => {
    const check = consentCheckOf({
      consentId: 'c-1',
      action: 'granted',
      revokesConsentId: null,
      scope: MAP_CONSENT_SCOPE,
    });
    expect(check.target).toBeNull();
    expect(check.exclusions).toEqual([]);
  });

  it('no grant is the inactive shape — nothing to scope, nothing to walk', () => {
    expect(consentCheckOf(null)).toEqual({
      active: false,
      consentId: null,
      disclosureSha256: null,
      target: null,
      exclusions: [],
    });
  });
});

// ── Throttle translation — where "Retry-After honoured" holds or doesn't ────
describe('graphThrottleFailure', () => {
  it("carries Graph's Retry-After as nextRetryDelay so Temporal waits what Graph asked", () => {
    const failure = graphThrottleFailure(
      new GraphHttpError('Failed to list folder page: throttled (HTTP 429)', {
        status: 429,
        retryAfterSeconds: 17,
      })
    );
    expect(failure.type).toBe(GRAPH_THROTTLED_ERROR_TYPE);
    expect(failure.nonRetryable).toBe(false);
    expect(failure.nextRetryDelay).toBe('17s');
    expect(failure.message).toContain('Retry-After 17s');
  });

  it('falls back to the retry policy backoff (no nextRetryDelay) when Graph sent no parseable Retry-After', () => {
    // A blank Retry-After stays null and null stays ABSENT here — never a
    // zero, which would read as "retry now" at the exact moment the provider
    // asked for patience.
    const failure = graphThrottleFailure(
      new GraphHttpError('Failed to list folder page: throttled (HTTP 429)', {
        status: 429,
        retryAfterSeconds: null,
      })
    );
    expect(failure.type).toBe(GRAPH_THROTTLED_ERROR_TYPE);
    expect(failure.nextRetryDelay).toBeUndefined();
  });
});

// ── Breadcrumb path building — the walk's own paths, not parentReference ────
describe('mapPathJoin', () => {
  it('joins root-level names', () => {
    expect(mapPathJoin('', 'Documents')).toBe('/Documents');
  });
  it('joins nested names and collapses duplicate slashes', () => {
    expect(mapPathJoin('/Documents', 'report.pdf')).toBe('/Documents/report.pdf');
    expect(mapPathJoin('/Documents/', 'a.md')).toBe('/Documents/a.md');
  });
});
