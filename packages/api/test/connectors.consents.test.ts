// SPDX-License-Identifier: Apache-2.0
// The consent routes (Plan key 25-*, Phase C).
//
// Acceptance for the phase: grant and revoke round-trip; a forced database
// failure aborts the operation rather than proceeding; the stored SHA matches
// the stored text; the actor is a user `sub`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VENDORED_CONSENT_DIR,
  disclosureSha256,
  getDisclosure,
  type AuthContext,
} from '@shelfmark/core';
import type { Db } from 'mongodb';
import { shelfmarkApi } from '../src/plugin.js';

const connectionFindOneMock = vi.fn();
const insertOneMock = vi.fn();
const updateOneMock = vi.fn();
const deleteOneMock = vi.fn();
const findToArrayMock = vi.fn();
const findCallsMock = vi.fn();

const dbMock = {
  collection: (name: string) => ({
    findOne: (...args: unknown[]) => connectionFindOneMock(...args),
    insertOne: (...args: unknown[]) => insertOneMock(name, ...args),
    updateOne: (...args: unknown[]) => updateOneMock(name, ...args),
    deleteOne: (...args: unknown[]) => deleteOneMock(name, ...args),
    find: (...args: unknown[]) => {
      findCallsMock(name, ...args);
      return { sort: () => ({ toArray: () => findToArrayMock() }) };
    },
  }),
} as unknown as Db;

const tenantFlagsMock = vi.fn();

const EN_MAP = getDisclosure('map_metadata', 'en')!;
const EN_MAP_SHA = disclosureSha256(EN_MAP.text);
const EN_INGEST_SHA = disclosureSha256(getDisclosure('ingest_content', 'en')!.text);

const CONNECTION = {
  connectionId: 'conn-1',
  tenantId: 'ACME-01',
  provider: 'onedrive',
  driveId: 'drive-abc',
};

interface AppOptions {
  sub?: string;
  upn?: string;
  tenantId?: string;
  /** resolveAuth answers null — the port of an unauthenticated caller. */
  noAuth?: boolean;
}

/** Every route the plugin registered, as `METHOD path`. */
let registeredRoutes: string[] = [];

async function buildApp(opts: AppOptions = {}) {
  const app = Fastify();
  registeredRoutes = [];
  app.addHook('onRoute', (route) => {
    for (const method of ([] as string[]).concat(route.method)) {
      registeredRoutes.push(`${method} ${route.url}`);
    }
  });
  await app.register(shelfmarkApi, {
    prefix: '/api/v1/connectors',
    db: dbMock,
    ports: {
      sink: { accept: async () => ({ status: 'ingested' as const }) },
      resolveAuth: async (): Promise<AuthContext | null> =>
        opts.noAuth
          ? null
          : {
              tenantId: opts.tenantId ?? 'ACME-01',
              sub: opts.sub ?? '',
              ...(opts.upn ? { upn: opts.upn } : {}),
              label: 'commercial',
            },
      tenantPolicy: { flags: (...args: [string]) => tenantFlagsMock(...args) },
    },
    temporal: {
      client: { workflow: { start: vi.fn() } },
      taskQueue: 'test-ingest-queue',
    },
    config: {
      publicBaseUrl: 'https://portal.example.com',
      stateSecret: 'test-state-secret-at-least-32-bytes-long',
    },
  });
  await app.ready();
  return app;
}

function grantPayload(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'map_metadata',
    locale: 'en',
    disclosureSha256: EN_MAP_SHA,
    target: { folderId: 'folder-7', folderPath: '/Clients/Acme' },
    exclusions: ['/Clients/Acme/Personal'],
    ...overrides,
  };
}

/**
 * Every consent path as a CONCRETE url — the form a request actually arrives
 * as, because anonymous allowlists match exact strings, not route patterns.
 */
const CONSENT_URLS = [
  '/api/v1/connectors/consents/disclosure',
  '/api/v1/connectors/conn-1/consents',
  '/api/v1/connectors/conn-1/consents/consent-aaa/revoke',
];

/** The consent document handed to insertOne, or undefined if nothing was written. */
function writtenConsent(): any {
  const call = insertOneMock.mock.calls.find((c) => c[0] === 'connector_consents');
  return call?.[1];
}

beforeEach(() => {
  connectionFindOneMock.mockReset().mockResolvedValue(CONNECTION);
  // Both switches explicitly ON: mapping consent is default-OFF, so every
  // happy-path test in this file has to say so out loud rather than inherit it.
  tenantFlagsMock
    .mockReset()
    .mockResolvedValue({ connectorsEnabled: true, mappingEnabled: true });
  insertOneMock.mockReset().mockResolvedValue({ acknowledged: true });
  updateOneMock.mockReset().mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  deleteOneMock.mockReset().mockResolvedValue({ acknowledged: true, deletedCount: 1 });
  findToArrayMock.mockReset().mockResolvedValue([]);
  findCallsMock.mockReset();
});

describe('GET /api/v1/connectors/consents/disclosure', () => {
  it('returns the verbatim text and the SHA a grant must echo back', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/consents/disclosure?scope=map_metadata&locale=en',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe(EN_MAP.text);
    expect(res.json().sha256).toBe(EN_MAP_SHA);
    expect(res.json().disclosureId).toBe('map_metadata.v1');
  });

  it('serves Spanish text for locale=es-MX, not a translated key', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/consents/disclosure?scope=map_metadata&locale=es-MX',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe(getDisclosure('map_metadata', 'es-MX')!.text);
    expect(res.json().text).not.toBe(EN_MAP.text);
    expect(res.json().locale).toBe('es-MX');
  });

  it('refuses bare "es" — it is not an alias for es-MX', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/consents/disclosure?scope=map_metadata&locale=es',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('disclosure_not_found');
    expect(res.payload).not.toContain(EN_MAP.text.slice(0, 40));
  });

  it('refuses an unsupported locale instead of falling back to English', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/consents/disclosure?scope=map_metadata&locale=fr',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('disclosure_not_found');
    expect(res.payload).not.toContain(EN_MAP.text.slice(0, 40));
  });

  it('rejects an unregistered scope', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/consents/disclosure?scope=read_everything&locale=en',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('consent_scope_invalid');
  });
});

describe('POST /api/v1/connectors/:id/consents — grant', () => {
  it('round-trips: the disclosure endpoint\'s SHA is accepted and the event is written', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a', upn: 'dana@acme.example' });

    // Take the SHA from the live endpoint, exactly as the UI would, so a
    // drift between what we serve and what we accept fails here.
    const shown = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/consents/disclosure?scope=map_metadata&locale=en',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ disclosureSha256: shown.json().sha256 }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().consentId).toMatch(/^consent-/);
    expect(res.json().action).toBe('granted');

    const written = writtenConsent();
    expect(written.tenantId).toBe('ACME-01');
    expect(written.connectionId).toBe('conn-1');
    expect(written.subjectSub).toBe('kc-user-9f3a');
    expect(written.subjectUpn).toBe('dana@acme.example');
    expect(written.action).toBe('granted');
    expect(written.revokesConsentId).toBeNull();
    expect(written.disclosureText).toBe(shown.json().text);
    expect(disclosureSha256(written.disclosureText)).toBe(written.disclosureSha256);
    expect(written.target).toEqual({
      provider: 'onedrive',
      siteId: null,
      driveId: 'drive-abc', // inherited from the connection when not supplied
      folderId: 'folder-7',
      folderPath: '/Clients/Acme',
    });
    expect(written.exclusions).toEqual(['/Clients/Acme/Personal']);
  });

  it('A SPANISH SPEAKER CAN GRANT CONSENT — es-MX round-trips end to end', async () => {
    // The single worst defect of the round this replaced on the source
    // platform: the API registered locale `es` while the portal's locale
    // type admits only `es-MX`, so the portal asked for es-MX, got 400
    // disclosure_not_found, and NO Spanish speaker could grant consent at
    // all. This walks the whole path the UI walks — fetch the words, echo
    // their SHA, get a record — and asserts the stored record is the SPANISH
    // text, not English standing in for it.
    const app = await buildApp({ sub: 'kc-user-mx-1', upn: 'legal-admin@acme.example' });

    const shown = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/consents/disclosure?scope=map_metadata&locale=es-MX',
    });
    expect(shown.statusCode, 'the UI cannot even display the Spanish disclosure').toBe(200);
    expect(shown.json().locale).toBe('es-MX');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ locale: 'es-MX', disclosureSha256: shown.json().sha256 }),
    });
    expect(res.statusCode, 'a Spanish speaker cannot grant consent').toBe(201);
    expect(res.json().disclosureLocale).toBe('es-MX');

    const written = writtenConsent();
    expect(written.disclosureLocale).toBe('es-MX');
    expect(written.disclosureText).toBe(shown.json().text);
    expect(written.disclosureText).not.toBe(EN_MAP.text);
    expect(disclosureSha256(written.disclosureText)).toBe(written.disclosureSha256);
    // The record must carry Spanish words, not an English body with an es-MX label.
    expect(written.disclosureText).toContain('Puede revocar este permiso cuando lo desee');
  });

  it('accepts the UI\'s OWN vendored bytes — the 409 that once made the round trip impossible', async () => {
    // On the source platform, the API and the portal each held their own
    // body of disclosure copy: hashing the portal's bytes and presenting
    // them returned 409 disclosure_text_mismatch, so the round trip could
    // never close. Both now vendor the SAME canonical file, so the UI's
    // bytes ARE the server's bytes. Read from the vendored tree the consent
    // registry actually loads — the consent-pin CI job is what proves every
    // vendored tree equals the canonical one.
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const uiBytes = readFileSync(
      join(VENDORED_CONSENT_DIR, 'disclosures', 'map_metadata.v1.en.md'),
      'utf8'
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ disclosureSha256: disclosureSha256(uiBytes) }),
    });
    expect(res.statusCode, 'the UI bytes are not the server bytes').toBe(201);
    expect(writtenConsent().disclosureText).toBe(uiBytes);
  });

  it('refuses a grant from a caller with no subject, writing nothing', async () => {
    const app = await buildApp(); // no sub
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('consent_subject_required');
    expect(writtenConsent()).toBeUndefined();
  });

  it('takes the actor from the verified auth context and ignores any actor in the body', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a', upn: 'dana@acme.example' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({
        subjectSub: 'kc-somebody-else',
        subjectUpn: 'attacker@evil.example',
        tenantId: 'OTHER-TENANT',
        target: { folderId: 'folder-7', folderPath: '/Clients/Acme', provider: 'google_drive' },
      }),
    });
    expect(res.statusCode).toBe(201);
    const written = writtenConsent();
    expect(written.subjectSub).toBe('kc-user-9f3a');
    expect(written.subjectUpn).toBe('dana@acme.example');
    expect(written.tenantId).toBe('ACME-01');
    // The provider is the connection's, so a consent cannot claim to cover a
    // provider this connection does not talk to.
    expect(written.target.provider).toBe('onedrive');
  });

  it('404s for a connection in another tenant, writing nothing', async () => {
    connectionFindOneMock.mockResolvedValue(null); // tenant-scoped query found nothing
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-elsewhere/consents',
      payload: grantPayload(),
    });
    expect(res.statusCode).toBe(404);
    expect(writtenConsent()).toBeUndefined();
    expect(connectionFindOneMock).toHaveBeenCalledWith({
      connectionId: 'conn-elsewhere',
      tenantId: 'ACME-01',
    });
  });

  it('403s when connectors are disabled for the tenant, writing nothing', async () => {
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: false });
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('connectors_disabled_for_tenant');
    expect(writtenConsent()).toBeUndefined();
  });

  it('403s when the host fails closed on an unknown tenant, writing nothing', async () => {
    // The port of the source platform's fail-open hole: its legacy check
    // answered TRUE for a tenant that did not exist, so an unknown tenant
    // could write a consent record. The fix — unknown state is the LOWEST
    // privilege, never the highest — now lives in the host's flags()
    // contract (unknown tenant → everything false), and this pins that the
    // route honours that answer with nothing written.
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: false });
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('connectors_disabled_for_tenant');
    expect(writtenConsent()).toBeUndefined();
  });

  it('403s a map_metadata grant when mapping was never enabled — consent is given, not assumed', async () => {
    // "Mapping consent defaults off." A flags answer with connectors on but
    // mappingEnabled not strictly true must NOT be able to consent to
    // mapping; the switch has to be thrown deliberately.
    tenantFlagsMock.mockResolvedValue({
      connectorsEnabled: true,
      mappingEnabled: undefined as unknown as boolean,
    });
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('mapping_disabled_for_tenant');
    expect(writtenConsent()).toBeUndefined();
  });

  it('403s a map_metadata grant when mappingEnabled is explicitly false', async () => {
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: true, mappingEnabled: false });
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('mapping_disabled_for_tenant');
    expect(writtenConsent()).toBeUndefined();
  });

  it('does not extend the mapping switch to ingest_content — that scope keeps the connector gate', async () => {
    // The default-OFF flip is scoped to MAPPING. Widening it to every scope
    // silently would be a second, undocumented posture change riding on
    // this one.
    tenantFlagsMock.mockResolvedValue({
      connectorsEnabled: true,
      mappingEnabled: undefined as unknown as boolean,
    });
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ scope: 'ingest_content', disclosureSha256: EN_INGEST_SHA }),
    });
    expect(res.statusCode).toBe(201);
    expect(writtenConsent().scope).toBe('ingest_content');
  });

  it('still 403s an ingest_content grant when the host fails closed on the tenant', async () => {
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: false });
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ scope: 'ingest_content', disclosureSha256: EN_INGEST_SHA }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('connectors_disabled_for_tenant');
    expect(writtenConsent()).toBeUndefined();
  });

  it('rejects an unregistered scope, writing nothing', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ scope: 'map_everything' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('consent_scope_invalid');
    expect(writtenConsent()).toBeUndefined();
  });

  it('409s when the SHA the client shows does not match the current text', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ disclosureSha256: 'd'.repeat(64) }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('disclosure_text_mismatch');
    expect(writtenConsent()).toBeUndefined();
  });

  it('409s when no SHA is supplied at all', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ disclosureSha256: undefined }),
    });
    expect(res.statusCode).toBe(409);
    expect(writtenConsent()).toBeUndefined();
  });

  it('refuses a locale it has no disclosure for, writing nothing', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload({ locale: 'fr' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('disclosure_not_found');
    expect(writtenConsent()).toBeUndefined();
  });

  it('answers 503 — never 2xx — when the consent record cannot be persisted', async () => {
    // The difference between an audit log and evidence: a best-effort log
    // swallows this and returns normally. Here the caller learns the record
    // is not there, so whatever the consent would have authorised does not
    // start.
    insertOneMock.mockRejectedValue(new Error('not primary; no replica set member'));
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('consent_not_recorded');
    expect(res.json().consentId).toBeUndefined();
  });

  it('answers 503 when the write is unacknowledged', async () => {
    insertOneMock.mockResolvedValue({ acknowledged: false });
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('consent_not_recorded');
  });

  it('records the source IP and user agent of the granting request', async () => {
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents',
      payload: grantPayload(),
      headers: { 'user-agent': 'Mozilla/5.0 (consent-test)' },
    });
    const written = writtenConsent();
    expect(written.userAgent).toBe('Mozilla/5.0 (consent-test)');
    expect(typeof written.sourceIp).toBe('string');
  });
});

describe('POST /api/v1/connectors/:id/consents/:consentId/revoke', () => {
  const GRANT = {
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
    exclusions: [],
    disclosureId: 'map_metadata.v1',
    disclosureSha256: EN_MAP_SHA,
    disclosureLocale: 'en',
    disclosureText: EN_MAP.text,
    action: 'granted',
    revokesConsentId: null,
    grantedAt: new Date('2026-08-13T10:00:00Z'),
    sourceIp: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
  };

  it('appends a new revoked event and never overwrites the grant', async () => {
    findToArrayMock.mockResolvedValue([GRANT]);
    const app = await buildApp({ sub: 'kc-user-2b7c', upn: 'sam@acme.example' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents/consent-aaa/revoke',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().action).toBe('revoked');
    expect(res.json().revokesConsentId).toBe('consent-aaa');
    expect(res.json().consentId).not.toBe('consent-aaa');

    const call = insertOneMock.mock.calls.find((c) => c[0] === 'connector_consents');
    const written = call?.[1];
    expect(written.action).toBe('revoked');
    expect(written.revokesConsentId).toBe('consent-aaa');
    expect(written.subjectSub).toBe('kc-user-2b7c');
    // Contrast DELETE /:id, which $sets a status. Nothing here updates the
    // consent collection at all.
    expect(updateOneMock.mock.calls.filter((c) => c[0] === 'connector_consents')).toHaveLength(0);
    expect(deleteOneMock).not.toHaveBeenCalled();
  });

  it('revokes even when both tenant switches are OFF — withdrawal is never gated', async () => {
    // The gate on the grant path must not become a gate on WITHDRAWAL. A
    // tenant whose connectors were turned off after a grant would otherwise be
    // unable to withdraw the consent it already gave, which is the one
    // direction that must always work.
    tenantFlagsMock.mockResolvedValue({ connectorsEnabled: false, mappingEnabled: false });
    findToArrayMock.mockResolvedValue([GRANT]);
    const app = await buildApp({ sub: 'kc-user-2b7c' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents/consent-aaa/revoke',
    });
    expect(res.statusCode).toBe(201);
    const call = insertOneMock.mock.calls.find((c) => c[0] === 'connector_consents');
    expect(call?.[1].action).toBe('revoked');
    // Never gated means never even asked: the revoke path reads no flags.
    expect(tenantFlagsMock).not.toHaveBeenCalled();
  });

  it('refuses a revocation from a caller with no subject, writing nothing', async () => {
    findToArrayMock.mockResolvedValue([GRANT]);
    const app = await buildApp(); // no sub
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents/consent-aaa/revoke',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('consent_subject_required');
    expect(writtenConsent()).toBeUndefined();
  });

  it('404s for a consent id that is not on this connection', async () => {
    findToArrayMock.mockResolvedValue([]);
    const app = await buildApp({ sub: 'kc-user-2b7c' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents/consent-ghost/revoke',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('consent_not_found');
    expect(writtenConsent()).toBeUndefined();
  });

  it('409s on a second revocation of the same grant', async () => {
    findToArrayMock.mockResolvedValue([
      GRANT,
      { ...GRANT, consentId: 'consent-bbb', action: 'revoked', revokesConsentId: 'consent-aaa' },
    ]);
    const app = await buildApp({ sub: 'kc-user-2b7c' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents/consent-aaa/revoke',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('consent_already_revoked');
    expect(writtenConsent()).toBeUndefined();
  });

  it('404s for a connection in another tenant before looking at consents', async () => {
    connectionFindOneMock.mockResolvedValue(null);
    const app = await buildApp({ sub: 'kc-user-2b7c' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-elsewhere/consents/consent-aaa/revoke',
    });
    expect(res.statusCode).toBe(404);
    expect(findCallsMock).not.toHaveBeenCalled();
    expect(writtenConsent()).toBeUndefined();
  });

  it('answers 503 when the revocation cannot be persisted', async () => {
    findToArrayMock.mockResolvedValue([GRANT]);
    insertOneMock.mockRejectedValue(new Error('write concern timeout'));
    const app = await buildApp({ sub: 'kc-user-2b7c' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors/conn-1/consents/consent-aaa/revoke',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('consent_not_recorded');
  });
});

describe('GET /api/v1/connectors/:id/consents', () => {
  it('returns the event history and derives which grants are live', async () => {
    findToArrayMock.mockResolvedValue([
      { consentId: 'c1', action: 'granted', scope: 'map_metadata', revokesConsentId: null, target: {}, exclusions: [], subjectSub: 'kc-1', grantedAt: new Date() },
      { consentId: 'c2', action: 'granted', scope: 'ingest_content', revokesConsentId: null, target: {}, exclusions: [], subjectSub: 'kc-1', grantedAt: new Date() },
      { consentId: 'c3', action: 'revoked', scope: 'map_metadata', revokesConsentId: 'c1', target: {}, exclusions: [], subjectSub: 'kc-2', grantedAt: new Date() },
    ]);
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-1/consents' });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(3); // nothing is ever removed
    expect(res.json().active.map((c: any) => c.consentId)).toEqual(['c2']);
  });

  it('404s for a connection in another tenant', async () => {
    connectionFindOneMock.mockResolvedValue(null);
    const app = await buildApp({ sub: 'kc-user-9f3a' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/connectors/conn-elsewhere/consents' });
    expect(res.statusCode).toBe(404);
  });
});

describe('auth coverage — the consent routes are behind resolveAuth, and only the callback is not', () => {
  // The source platform proved this against its gateway's REAL anonymous
  // allowlists (a route the auth hook never sees is invisible in the diff of
  // the route file). The port's equivalent boundary is the resolveAuth gate
  // inside every handler plus the ONE documented carve-out — the OAuth
  // callback — and these tests pin both halves against the real routes.

  it('registers every consent route on the plugin itself', async () => {
    await buildApp({ sub: 'kc-user-9f3a' });
    for (const route of [
      'GET /api/v1/connectors/consents/disclosure',
      'POST /api/v1/connectors/:id/consents',
      'GET /api/v1/connectors/:id/consents',
      'POST /api/v1/connectors/:id/consents/:consentId/revoke',
    ]) {
      expect(
        registeredRoutes,
        `${route} is not registered by the plugin — if it moved elsewhere, prove that place is inside the host auth hook's coverage`
      ).toContain(route);
    }
  });

  it('reaches no handler work and writes nothing when the resolver answers null', async () => {
    const app = await buildApp({ noAuth: true });
    for (const url of [
      '/api/v1/connectors/conn-1/consents',
      '/api/v1/connectors/conn-1/consents/consent-aaa/revoke',
    ]) {
      const res = await app.inject({ method: 'POST', url, payload: grantPayload() });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    }
    const disclosure = await app.inject({
      method: 'GET',
      url: '/api/v1/connectors/consents/disclosure?scope=map_metadata&locale=en',
    });
    expect(disclosure.statusCode).toBe(401);
    expect(insertOneMock).not.toHaveBeenCalled();
    expect(connectionFindOneMock).not.toHaveBeenCalled();
  });

  it('NO consent route is anonymous-reachable — the OAuth callback is the only carve-out', async () => {
    // A consent grant is the act of an identified human. A consent route
    // reachable without auth would let an unauthenticated caller write a
    // consent record attributed to nobody, or read another tenant's history.
    const app = await buildApp({ noAuth: true });
    const methodFor: Record<string, 'GET' | 'POST'> = {
      '/api/v1/connectors/consents/disclosure': 'GET',
      '/api/v1/connectors/conn-1/consents': 'POST',
      '/api/v1/connectors/conn-1/consents/consent-aaa/revoke': 'POST',
    };
    for (const url of CONSENT_URLS) {
      const res = await app.inject({ method: methodFor[url]!, url });
      expect(res.statusCode, `${url} is anonymous-reachable`).toBe(401);
      // …including with a query string.
      const withQuery = await app.inject({
        method: methodFor[url]!,
        url: `${url}?scope=map_metadata`,
      });
      expect(withQuery.statusCode).toBe(401);
    }
    // The carve-out itself: the callback proceeds without a session (it is
    // authenticated by the signed state JWT instead) — a missing code/state
    // is its OWN 400, never a 401.
    const callback = await app.inject({ method: 'GET', url: '/api/v1/connectors/microsoft/callback' });
    expect(callback.statusCode).toBe(400);
    expect(callback.json()).toEqual({ error: 'missing_code_or_state' });
  });
});
