// SPDX-License-Identifier: Apache-2.0
// The consent routes (Plan key 25-*, Phase C): disclosure text, grant,
// revoke, history.
//
// These four routes are registered by THIS plugin on purpose. A root-level
// Fastify hook propagates into every encapsulated plugin registered on that
// instance, so a host that installs its authentication/authorization hook on
// the instance it registers @shelfmark/api on puts each route below inside
// that hook's coverage by construction. Moving them to a separate plugin
// would mean proving that registration separately — and a route outside the
// hook's coverage is invisible in the diff of the route file itself, which
// is exactly why they stay here.
//
// NOT an ordering argument, though an earlier version of this comment said
// it was: a root hook added AFTER `register` still fires (measured), so
// "registered after the hook" is not what buys the coverage and must not be
// relied on as if it were.
//
// Coverage is necessary and not sufficient — the host's gateway must also
// DENY an anonymous caller here. NO consent path may ever be on an anonymous
// allowlist: the only anonymous-reachable path in this plugin is the OAuth
// callback (see the carve-out comment in connections.ts), and this package's
// own resolveAuth gate answers 401 on every consent route regardless.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ConsentError,
  defaultConsentLocale,
  isConsentLocale,
  isConsentScope,
} from '@shelfmark/core';
import { CONNECTIONS_COLLECTION, requireAuth, str } from '../util.js';
import type { RouteContext } from '../types.js';

interface ConnectionParams {
  id: string;
}

interface GrantConsentBody {
  scope?: unknown;
  locale?: unknown;
  disclosureSha256?: unknown;
  target?: unknown;
  exclusions?: unknown;
}

/**
 * Consent failures never answer 2xx and are never swallowed.
 *
 * A `ConsentError` is a refusal we chose (no subject, bad scope, stale
 * disclosure) and carries its own status. Anything else is a failure to
 * PERSIST — which means the operation the consent would have authorised must
 * not start, so it becomes a 503 the caller has to handle, not a logged
 * warning and a success. (The source platform ran an adjacent audit log that
 * swallowed its write failures as "best-effort" — a reasonable choice for a
 * log whose structured line already reached the aggregator, and the exact
 * inverse of what evidence requires. This is deliberately that inverse.)
 */
function sendConsentFailure(
  fastify: FastifyInstance,
  reply: FastifyReply,
  err: unknown,
  context: string
): void {
  if (err instanceof ConsentError) {
    fastify.log.warn(`Consent refused (${context}): ${err.code}`);
    reply.code(err.statusCode).send({ error: err.code });
    return;
  }
  fastify.log.error(`Consent record not persisted (${context}): ${(err as Error).message}`);
  reply.code(503).send({ error: 'consent_not_recorded' });
}

export async function registerConsentRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { db, ports, tenantPolicy, consents, registry } = ctx;

  /**
   * The exact words to show the human, and the SHA the client must echo back.
   *
   * The UI displays this text VERBATIM and returns `disclosureSha256` with
   * the grant. That round trip is what lets the stored record say "these are
   * the words the subject read" instead of "the subject clicked a button
   * next to something".
   */
  fastify.get(
    '/consents/disclosure',
    async (
      request: FastifyRequest<{ Querystring: { scope?: string; locale?: string } }>,
      reply: FastifyReply
    ) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { scope } = request.query;
      if (!isConsentScope(scope)) {
        reply.code(400).send({ error: 'consent_scope_invalid' });
        return;
      }
      const locale = request.query.locale ?? defaultConsentLocale();
      if (!isConsentLocale(locale)) {
        // No fallback to English — a locale we have no reviewed text for is
        // a refusal, not a silent substitution (see the registry's docs).
        reply.code(400).send({ error: 'disclosure_not_found' });
        return;
      }
      const disclosure = registry.getDisclosure(scope, locale);
      if (!disclosure) {
        reply.code(400).send({ error: 'disclosure_not_found' });
        return;
      }
      reply.code(200).send({
        disclosureId: disclosure.disclosureId,
        scope: disclosure.scope,
        locale: disclosure.locale,
        text: disclosure.text,
        // The registry's own hash of its own bytes — computed at load from the
        // vendored artifact and compared to the manifest there, so this can
        // never be a hash of something other than `text` above.
        sha256: disclosure.sha256,
      });
    }
  );

  /** Grant consent for one scope over one subtree. Appends one event. */
  fastify.post(
    '/:id/consents',
    async (
      request: FastifyRequest<{ Params: ConnectionParams; Body: GrantConsentBody }>,
      reply: FastifyReply
    ) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      const tenantId = auth.tenantId;
      const body = request.body || {};

      const conn = await db
        .collection(CONNECTIONS_COLLECTION)
        .findOne({ connectionId, tenantId });
      if (!conn) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }
      // Fail-closed tenant gate — see the posture block in connections.ts.
      // One flags() read, two checks: the connector switch here (before we
      // look at the body at all), the scope-specific switch once the scope
      // is known. A host that cannot resolve this tenant must have answered
      // fail-closed, which is what makes an unknown tenant unable to write a
      // consent record.
      const flags = await tenantPolicy.flags(tenantId);
      if (!flags.connectorsEnabled) {
        reply.code(403).send({ error: 'connectors_disabled_for_tenant' });
        return;
      }
      if (!isConsentScope(body.scope)) {
        reply.code(400).send({ error: 'consent_scope_invalid' });
        return;
      }
      // Mapping consent is DEFAULT OFF ("consent should be given, not
      // assumed"). Strict `=== true`: absent means OFF. This is the only
      // scope with its own switch today; a new scope that needs one adds its
      // own check here rather than widening this condition.
      if (body.scope === 'map_metadata' && flags.mappingEnabled !== true) {
        reply.code(403).send({ error: 'mapping_disabled_for_tenant' });
        return;
      }
      const locale = typeof body.locale === 'string' ? body.locale : defaultConsentLocale();
      if (!isConsentLocale(locale)) {
        reply.code(400).send({ error: 'disclosure_not_found' });
        return;
      }

      const target = (body.target ?? {}) as Record<string, unknown>;
      try {
        const record = await consents.recordConsentGrant({
          tenantId,
          connectionId,
          // Both come from the host-VERIFIED auth context, never the body. A
          // body-supplied actor is a caller's claim about itself, and a
          // record built from it would attribute a consent to whoever the
          // caller named.
          subjectSub: auth.sub !== '' ? auth.sub : null,
          subjectUpn: auth.upn ?? null,
          scope: body.scope,
          locale,
          presentedSha256: String(body.disclosureSha256 ?? ''),
          target: {
            // The provider is the connection's own, so a consent can never
            // claim to cover a provider this connection does not talk to.
            provider: String(conn.provider),
            siteId: str(target.siteId),
            driveId:
              str(target.driveId) ?? (typeof conn.driveId === 'string' ? conn.driveId : null),
            folderId: str(target.folderId),
            folderPath: str(target.folderPath),
          },
          exclusions: body.exclusions,
          sourceIp: request.ip ?? null,
          userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        });

        reply.code(201).send({
          consentId: record.consentId,
          connectionId,
          scope: record.scope,
          action: record.action,
          disclosureId: record.disclosureId,
          disclosureSha256: record.disclosureSha256,
          disclosureLocale: record.disclosureLocale,
          subjectSub: record.subjectSub,
          grantedAt: record.grantedAt,
        });
      } catch (err) {
        sendConsentFailure(fastify, reply, err, `grant on ${connectionId}`);
      }
    }
  );

  /**
   * Revoke a consent. This appends a NEW event carrying `revokesConsentId`;
   * it never updates the granting document. Contrast DELETE /:id in
   * connections.ts, which $sets a status and destroys the previous state.
   *
   * REVOCATION IS NEVER GATED by either tenant switch — deliberately no
   * flags() read here. A tenant whose connectors were turned off after a
   * grant must still be able to withdraw it.
   */
  fastify.post(
    '/:id/consents/:consentId/revoke',
    async (
      request: FastifyRequest<{ Params: ConnectionParams & { consentId: string } }>,
      reply: FastifyReply
    ) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId, consentId } = request.params;
      const tenantId = auth.tenantId;

      const conn = await db
        .collection(CONNECTIONS_COLLECTION)
        .findOne({ connectionId, tenantId });
      if (!conn) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }

      try {
        const record = await consents.recordConsentRevocation({
          tenantId,
          connectionId,
          consentId,
          subjectSub: auth.sub !== '' ? auth.sub : null,
          subjectUpn: auth.upn ?? null,
          sourceIp: request.ip ?? null,
          userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        });

        reply.code(201).send({
          consentId: record.consentId,
          revokesConsentId: record.revokesConsentId,
          connectionId,
          scope: record.scope,
          action: record.action,
          subjectSub: record.subjectSub,
          grantedAt: record.grantedAt,
        });
      } catch (err) {
        sendConsentFailure(fastify, reply, err, `revoke of ${consentId} on ${connectionId}`);
      }
    }
  );

  /**
   * The consent history for one connection: every event, plus which grants
   * are currently live. `active` is derived from the events — there is no
   * stored status to read.
   */
  fastify.get(
    '/:id/consents',
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply: FastifyReply) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      const tenantId = auth.tenantId;

      const conn = await db
        .collection(CONNECTIONS_COLLECTION)
        .findOne({ connectionId, tenantId });
      if (!conn) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }

      const events = await consents.listConsentEvents(tenantId, connectionId);
      reply.code(200).send({
        connectionId,
        events,
        active: consents.activeConsents(events).map((c) => ({
          consentId: c.consentId,
          scope: c.scope,
          target: c.target,
          exclusions: c.exclusions,
          subjectSub: c.subjectSub,
          grantedAt: c.grantedAt,
        })),
      });
    }
  );
}
