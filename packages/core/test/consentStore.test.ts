// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

// Plan 25 Phase C — the three properties that make this evidence rather than
// an audit log, tested one at a time:
//   1. the write is durable and NEVER swallowed
//   2. revocation is a new event, never a status overwrite
//   3. an unattributable consent is refused
//
// The store takes its Db handle by injection, so the "mock" here is simply the
// handle we pass in — no module interception, same observable surface.

const insertOneMock = vi.fn();
const updateOneMock = vi.fn();
const deleteOneMock = vi.fn();
const findToArrayMock = vi.fn();
const findMock = vi.fn();

let collectionsUsed: string[] = [];

const fakeDb = {
  collection: (name: string) => {
    collectionsUsed.push(name);
    return {
      insertOne: (...args: unknown[]) => insertOneMock(...args),
      updateOne: (...args: unknown[]) => updateOneMock(...args),
      deleteOne: (...args: unknown[]) => deleteOneMock(...args),
      find: (...args: unknown[]) => {
        findMock(...args);
        return { sort: () => ({ toArray: () => findToArrayMock() }) };
      },
    };
  },
} as unknown as Db;

import {
  CONSENT_COLLECTION,
  ConsentError,
  ConsentRecord,
  MAX_EXCLUSIONS,
  activeConsents,
  createConsentStore,
} from '../src/consent/store.js';
import {
  ConsentDisclosure,
  DisclosureRegistry,
  disclosureSha256,
  getDisclosure,
} from '../src/consent/disclosures.js';

const store = createConsentStore(fakeDb);
const { recordConsentGrant, recordConsentRevocation, listConsentEvents } = store;

const EN_MAP = getDisclosure('map_metadata', 'en')!;
const EN_MAP_SHA = disclosureSha256(EN_MAP.text);

function grantInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'ACME-01',
    connectionId: 'conn-1',
    subjectSub: 'kc-user-9f3a',
    subjectUpn: 'dana@acme.example',
    scope: 'map_metadata' as const,
    locale: 'en' as const,
    presentedSha256: EN_MAP_SHA,
    target: {
      provider: 'onedrive',
      siteId: null,
      driveId: 'drive-abc',
      folderId: 'folder-7',
      folderPath: '/Clients/Acme',
    },
    exclusions: ['/Clients/Acme/Personal'],
    sourceIp: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
    ...overrides,
  };
}

function storedGrant(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    consentId: 'consent-aaa',
    tenantId: 'ACME-01',
    connectionId: 'conn-1',
    subjectSub: 'kc-user-9f3a',
    subjectUpn: 'dana@acme.example',
    scope: 'map_metadata',
    target: {
      provider: 'onedrive',
      siteId: null,
      driveId: 'drive-abc',
      folderId: 'folder-7',
      folderPath: '/Clients/Acme',
    },
    exclusions: ['/Clients/Acme/Personal'],
    disclosureId: EN_MAP.disclosureId,
    disclosureSha256: EN_MAP_SHA,
    disclosureLocale: 'en',
    disclosureText: EN_MAP.text,
    action: 'granted',
    revokesConsentId: null,
    grantedAt: new Date('2026-08-13T10:00:00Z'),
    sourceIp: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
    ...overrides,
  };
}

beforeEach(() => {
  collectionsUsed = [];
  insertOneMock.mockReset().mockResolvedValue({ acknowledged: true });
  updateOneMock.mockReset().mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  deleteOneMock.mockReset().mockResolvedValue({ acknowledged: true, deletedCount: 1 });
  findToArrayMock.mockReset().mockResolvedValue([]);
  findMock.mockReset();
});

describe('property 1 — the consent write is durable and never swallowed', () => {
  it('writes with writeConcern { w: majority, j: true }', async () => {
    await recordConsentGrant(grantInput());
    expect(insertOneMock).toHaveBeenCalledTimes(1);
    expect(insertOneMock.mock.calls[0][1]).toEqual({
      writeConcern: { w: 'majority', j: true },
    });
  });

  it('writes to the connector_consents collection', async () => {
    await recordConsentGrant(grantInput());
    expect(CONSENT_COLLECTION).toBe('connector_consents');
    expect(collectionsUsed).toContain('connector_consents');
  });

  it('propagates a Mongo failure to the caller instead of continuing', async () => {
    // The neighbouring egress audit log wrapped this same call in `catch {}`
    // and returned normally. Here the caller MUST learn the record did not
    // persist, because the caller is what decides whether the operation
    // starts.
    insertOneMock.mockRejectedValue(new Error('not primary; no replica set member'));
    await expect(recordConsentGrant(grantInput())).rejects.toThrow(/not primary/);
  });

  it('treats an unacknowledged write as a failure, not a success', async () => {
    insertOneMock.mockResolvedValue({ acknowledged: false });
    await expect(recordConsentGrant(grantInput())).rejects.toMatchObject({
      code: 'consent_not_recorded',
      statusCode: 503,
    });
  });

  it('propagates a Mongo failure on revocation too', async () => {
    findToArrayMock.mockResolvedValue([storedGrant()]);
    insertOneMock.mockRejectedValue(new Error('write concern timeout'));
    await expect(
      recordConsentRevocation({
        tenantId: 'ACME-01',
        connectionId: 'conn-1',
        consentId: 'consent-aaa',
        subjectSub: 'kc-user-9f3a',
        subjectUpn: null,
        sourceIp: null,
        userAgent: null,
      })
    ).rejects.toThrow(/write concern timeout/);
  });
});

describe('property 2 — revocation is a new event, never a status overwrite', () => {
  const revokeInput = {
    tenantId: 'ACME-01',
    connectionId: 'conn-1',
    consentId: 'consent-aaa',
    subjectSub: 'kc-user-2b7c',
    subjectUpn: 'sam@acme.example',
    sourceIp: '198.51.100.4',
    userAgent: 'curl/8',
  };

  it('appends a revoked event carrying revokesConsentId', async () => {
    findToArrayMock.mockResolvedValue([storedGrant()]);
    const record = await recordConsentRevocation(revokeInput);

    expect(insertOneMock).toHaveBeenCalledTimes(1);
    const written = insertOneMock.mock.calls[0][0];
    expect(written.action).toBe('revoked');
    expect(written.revokesConsentId).toBe('consent-aaa');
    expect(written.consentId).not.toBe('consent-aaa'); // a NEW event id
    expect(record.action).toBe('revoked');
  });

  it('never updates or deletes the granting document', async () => {
    findToArrayMock.mockResolvedValue([storedGrant()]);
    await recordConsentRevocation(revokeInput);
    // Contrast the connector-lifecycle DELETE this replaced, which $set
    // status: 'disconnected' and destroyed the answer to "what was permitted
    // last Tuesday".
    expect(updateOneMock).not.toHaveBeenCalled();
    expect(deleteOneMock).not.toHaveBeenCalled();
  });

  it('records the revoking human, who need not be the granting human', async () => {
    findToArrayMock.mockResolvedValue([storedGrant()]);
    await recordConsentRevocation(revokeInput);
    const written = insertOneMock.mock.calls[0][0];
    expect(written.subjectSub).toBe('kc-user-2b7c');
    expect(written.subjectUpn).toBe('sam@acme.example');
  });

  it('carries the grant\'s verbatim disclosure onto the revocation event', async () => {
    // So a reader holding only the revocation can see exactly which
    // permission, over which subtree, on which words, was withdrawn.
    findToArrayMock.mockResolvedValue([storedGrant()]);
    await recordConsentRevocation(revokeInput);
    const written = insertOneMock.mock.calls[0][0];
    expect(written.disclosureText).toBe(EN_MAP.text);
    expect(written.disclosureSha256).toBe(EN_MAP_SHA);
    expect(written.scope).toBe('map_metadata');
    expect(written.target.folderPath).toBe('/Clients/Acme');
  });

  it('refuses to revoke a consent that does not exist on this connection', async () => {
    findToArrayMock.mockResolvedValue([]);
    await expect(recordConsentRevocation(revokeInput)).rejects.toMatchObject({
      code: 'consent_not_found',
      statusCode: 404,
    });
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('refuses a second revocation of the same grant', async () => {
    findToArrayMock.mockResolvedValue([
      storedGrant(),
      storedGrant({ consentId: 'consent-bbb', action: 'revoked', revokesConsentId: 'consent-aaa' }),
    ]);
    await expect(recordConsentRevocation(revokeInput)).rejects.toMatchObject({
      code: 'consent_already_revoked',
      statusCode: 409,
    });
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the tenant AND the connection', async () => {
    findToArrayMock.mockResolvedValue([storedGrant()]);
    await recordConsentRevocation(revokeInput);
    expect(findMock.mock.calls[0][0]).toEqual({ tenantId: 'ACME-01', connectionId: 'conn-1' });
  });
});

describe('property 3 — an unattributable consent is refused', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
  ])('refuses a grant whose subjectSub is %s, writing nothing', async (_label, value) => {
    await expect(
      recordConsentGrant(grantInput({ subjectSub: value }))
    ).rejects.toMatchObject({ code: 'consent_subject_required', statusCode: 403 });
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('refuses a revocation whose subjectSub is missing, writing nothing', async () => {
    findToArrayMock.mockResolvedValue([storedGrant()]);
    await expect(
      recordConsentRevocation({
        tenantId: 'ACME-01',
        connectionId: 'conn-1',
        consentId: 'consent-aaa',
        subjectSub: null,
        subjectUpn: null,
        sourceIp: null,
        userAgent: null,
      })
    ).rejects.toMatchObject({ code: 'consent_subject_required', statusCode: 403 });
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('never substitutes the tenant id for a missing subject', async () => {
    // The exact regression the OAuth-state work fixed upstream: a tenant slug
    // in an actor field reads as an answer and identifies nobody.
    const err = await recordConsentGrant(grantInput({ subjectSub: null })).catch((e) => e);
    expect(err).toBeInstanceOf(ConsentError);
    expect(String(err.message)).not.toContain('ACME-01');
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('records subjectUpn as null when the identity carries none', async () => {
    const record = await recordConsentGrant(grantInput({ subjectUpn: undefined }));
    expect(record.subjectUpn).toBeNull();
    expect(insertOneMock.mock.calls[0][0].subjectUpn).toBeNull();
  });
});

describe('the stored disclosure is the server\'s own text, and its SHA matches', () => {
  it('stores the full verbatim text, its SHA, its locale and its id', async () => {
    const record = await recordConsentGrant(grantInput());
    const written = insertOneMock.mock.calls[0][0];
    expect(written.disclosureText).toBe(EN_MAP.text);
    expect(written.disclosureId).toBe('map_metadata.v1');
    expect(written.disclosureLocale).toBe('en');
    // Recomputed from what was STORED, not from what was passed in — the
    // stored record has to be self-verifying.
    expect(disclosureSha256(written.disclosureText)).toBe(written.disclosureSha256);
    expect(record.disclosureSha256).toBe(EN_MAP_SHA);
  });

  it('refuses when the SHA the client displayed does not match the current text', async () => {
    // A stale portal bundle showed different words. Recording this consent
    // would assert the subject read text they never saw.
    await expect(
      recordConsentGrant(grantInput({ presentedSha256: 'f'.repeat(64) }))
    ).rejects.toMatchObject({ code: 'disclosure_text_mismatch', statusCode: 409 });
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('refuses a scope/locale pair with no registered disclosure', async () => {
    await expect(
      recordConsentGrant(grantInput({ locale: 'fr' }))
    ).rejects.toMatchObject({ code: 'disclosure_not_found', statusCode: 400 });
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('stores the Spanish text — never the English one — for an es-MX consent', async () => {
    // es-MX and not bare 'es': that mismatch is what made every Spanish grant
    // 400 disclosure_not_found before the disclosures were unified on the one
    // canonical artifact. See disclosures.ts.
    const es = getDisclosure('map_metadata', 'es-MX')!;
    await recordConsentGrant(
      grantInput({ locale: 'es-MX', presentedSha256: disclosureSha256(es.text) })
    );
    const written = insertOneMock.mock.calls[0][0];
    expect(written.disclosureText).toBe(es.text);
    expect(written.disclosureText).not.toBe(EN_MAP.text);
    expect(written.disclosureLocale).toBe('es-MX');
  });

  it('refuses bare "es" — an unreviewed locale is never aliased onto es-MX', async () => {
    // Serving Mexican-Spanish text against a locale we did not review, on a
    // record that then asserts the subject read it, is the same false-record
    // failure as falling back to English.
    await expect(recordConsentGrant(grantInput({ locale: 'es' }))).rejects.toMatchObject({
      code: 'disclosure_not_found',
      statusCode: 400,
    });
    expect(insertOneMock).not.toHaveBeenCalled();
  });
});

describe('the record shape', () => {
  it('stores every field the consent record is specified to carry', async () => {
    const record = await recordConsentGrant(grantInput());
    const written = insertOneMock.mock.calls[0][0];
    expect(Object.keys(written).sort()).toEqual(
      [
        'action',
        'connectionId',
        'consentId',
        'disclosureId',
        'disclosureLocale',
        'disclosureSha256',
        'disclosureText',
        'exclusions',
        'grantedAt',
        'revokesConsentId',
        'scope',
        'sourceIp',
        'subjectSub',
        'subjectUpn',
        'target',
        'tenantId',
        'userAgent',
      ].sort()
    );
    expect(written.consentId).toMatch(/^consent-/);
    expect(written.action).toBe('granted');
    expect(written.revokesConsentId).toBeNull();
    expect(written.grantedAt).toBeInstanceOf(Date);
    expect(written.sourceIp).toBe('203.0.113.9');
    expect(written.userAgent).toBe('Mozilla/5.0');
    expect(written.target).toEqual({
      provider: 'onedrive',
      siteId: null,
      driveId: 'drive-abc',
      folderId: 'folder-7',
      folderPath: '/Clients/Acme',
    });
    expect(record.exclusions).toEqual(['/Clients/Acme/Personal']);
  });

  it('rejects exclusions that are not an array of non-empty strings', async () => {
    for (const bad of [['ok', 42], ['ok', ''], 'not-an-array', [{}]]) {
      insertOneMock.mockClear();
      await expect(recordConsentGrant(grantInput({ exclusions: bad }))).rejects.toMatchObject({
        code: 'consent_exclusions_invalid',
        statusCode: 400,
      });
      expect(insertOneMock).not.toHaveBeenCalled();
    }
  });

  it('rejects an unbounded exclusions list', async () => {
    const tooMany = Array.from({ length: MAX_EXCLUSIONS + 1 }, (_, i) => `/f/${i}`);
    await expect(recordConsentGrant(grantInput({ exclusions: tooMany }))).rejects.toMatchObject({
      code: 'consent_exclusions_invalid',
    });
    expect(insertOneMock).not.toHaveBeenCalled();
  });

  it('defaults an absent exclusions list to an empty array', async () => {
    const record = await recordConsentGrant(grantInput({ exclusions: undefined }));
    expect(record.exclusions).toEqual([]);
  });
});

describe('activeConsents — derived from the events, never from a status field', () => {
  it('drops a grant once a revocation names it', () => {
    const events: ConsentRecord[] = [
      storedGrant({ consentId: 'c1' }),
      storedGrant({ consentId: 'c2', scope: 'ingest_content' }),
      storedGrant({ consentId: 'c3', action: 'revoked', revokesConsentId: 'c1' }),
    ];
    expect(activeConsents(events).map((c) => c.consentId)).toEqual(['c2']);
  });

  it('keeps a grant when a revocation names a different consent', () => {
    const events: ConsentRecord[] = [
      storedGrant({ consentId: 'c1' }),
      storedGrant({ consentId: 'c9', action: 'revoked', revokesConsentId: 'c-other' }),
    ];
    expect(activeConsents(events).map((c) => c.consentId)).toEqual(['c1']);
  });

  it('never counts a revocation event itself as an active consent', () => {
    const events: ConsentRecord[] = [
      storedGrant({ consentId: 'c3', action: 'revoked', revokesConsentId: 'c1' }),
    ];
    expect(activeConsents(events)).toEqual([]);
  });

  it('returns nothing for an empty history', () => {
    expect(activeConsents([])).toEqual([]);
  });

  it('is exposed on the store too, and is the same derivation', () => {
    const events: ConsentRecord[] = [
      storedGrant({ consentId: 'c1' }),
      storedGrant({ consentId: 'c3', action: 'revoked', revokesConsentId: 'c1' }),
    ];
    expect(store.activeConsents(events)).toEqual(activeConsents(events));
  });
});

describe('listConsentEvents', () => {
  it('scopes the query to the tenant and hides Mongo internals', async () => {
    findToArrayMock.mockResolvedValue([storedGrant()]);
    const events = await listConsentEvents('ACME-01', 'conn-1');
    expect(findMock).toHaveBeenCalledWith(
      { tenantId: 'ACME-01', connectionId: 'conn-1' },
      { projection: { _id: 0 } }
    );
    expect(events).toHaveLength(1);
  });
});

describe('an injected disclosure registry replaces the vendored default', () => {
  // The host supplies its own pinned set; every semantic — including the 409
  // SHA-mismatch refusal — must then hold against the HOST's bytes, not the
  // vendored ones.
  const CUSTOM_TEXT = 'host-supplied disclosure words, pinned by the host, shown by the host';
  const customDisclosure: ConsentDisclosure = {
    disclosureId: 'map_metadata.v9',
    scope: 'map_metadata',
    locale: 'en',
    text: CUSTOM_TEXT,
    sha256: disclosureSha256(CUSTOM_TEXT),
    status: 'current',
  };
  const customRegistry: DisclosureRegistry = {
    getDisclosure: (scope, locale) =>
      scope === 'map_metadata' && locale === 'en' ? customDisclosure : undefined,
    getDisclosureById: (id, locale) =>
      id === 'map_metadata.v9' && locale === 'en' ? customDisclosure : undefined,
    listDisclosures: () => [customDisclosure],
  };
  const customStore = createConsentStore(fakeDb, { registry: customRegistry });

  it('resolves and stores the supplied registry text, not the vendored default', async () => {
    await customStore.recordConsentGrant(
      grantInput({ presentedSha256: disclosureSha256(CUSTOM_TEXT) })
    );
    const written = insertOneMock.mock.calls[0][0];
    expect(written.disclosureText).toBe(CUSTOM_TEXT);
    expect(written.disclosureText).not.toBe(EN_MAP.text);
    expect(written.disclosureId).toBe('map_metadata.v9');
    expect(written.disclosureSha256).toBe(disclosureSha256(CUSTOM_TEXT));
  });

  it('judges the SHA-mismatch refusal against the supplied registry', async () => {
    // The vendored default's SHA is now the WRONG sha — the words on the
    // host's screen were the host's words.
    await expect(
      customStore.recordConsentGrant(grantInput({ presentedSha256: EN_MAP_SHA }))
    ).rejects.toMatchObject({ code: 'disclosure_text_mismatch', statusCode: 409 });
    expect(insertOneMock).not.toHaveBeenCalled();
  });
});
