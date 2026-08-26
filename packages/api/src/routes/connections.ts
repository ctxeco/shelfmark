// SPDX-License-Identifier: Apache-2.0
// Connection lifecycle: OAuth authorize + callback, list, legacy sync,
// disconnect.
//
// PROVIDER SPLIT. Only Microsoft (OneDrive/SharePoint) ships in this
// package, but the registration layout is deliberately per-provider: one
// authorize + one callback block per provider, sharing the
// `connector_connections` collection and route shape. A host adding a
// provider adds a sibling block (its own authorize/callback pair, its own
// provider branch in browse, its own sync workflow type) rather than
// threading a provider switch through these handlers — the platform this was
// extracted from runs a second, private provider through exactly this seam,
// which is the live proof the seam holds.
//
// ---------------------------------------------------------------------------
// TWO TENANT SWITCHES, TWO DELIBERATELY DIFFERENT POSTURES — HISTORY.
//
// In the source platform, every pre-existing connector path (authorize,
// browse, sync) read the tenant record with a DEFAULT-ON posture: a missing
// field, or no tenant record at all, meant enabled. That was a RECORDED
// fail-open, kept on purpose — live tenants provisioned before the switch
// existed were running on those paths, and flipping the default would have
// silently 403'd their working syncs: an availability incident dressed up as
// a security fix. The consent grant path, newer and with nothing in
// production on it, failed CLOSED from day one: no tenant record meant NOT
// enabled, and a `map_metadata` grant additionally required the mapping
// switch to be explicitly on ("consent should be given, not assumed").
//
// THE PORT COLLAPSES BOTH READS onto one seam: `TenantPolicy.flags()`. The
// split now lives in two places —
//   * structurally: `mappingEnabled` keeps its strict `=== true` check at
//     every site (grant time AND map time), so mapping stays opt-in no
//     matter what a host's flags() answers loosely;
//   * contractually: a host that cannot resolve a tenant MUST answer
//     `{ connectorsEnabled: false, mappingEnabled: false }` — fail closed.
//     The default-ON legacy posture is now a host decision made in its
//     flags() implementation, documented, not embedded here. The shipped
//     DEFAULT_TENANT_POLICY (used when no tenantPolicy port is supplied)
//     answers everything-enabled, which is the honest default for a
//     single-tenant demo and exactly the posture a multi-tenant host must
//     replace.
//
// REVOCATION IS NEVER GATED by either switch. A tenant whose connectors were
// turned off after a grant must still be able to withdraw it; a gate that
// blocks withdrawal turns an operational switch into a trap.
// ---------------------------------------------------------------------------
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { GraphConnectorError, buildAuthorizeUrl, exchangeCodeForTokens } from '@shelfmark/graph';
import { LabelRefusedError, encryptToken } from '@shelfmark/core';
import { CONNECTIONS_COLLECTION, requireAuth } from '../util.js';
import { forgetConnectionTokens } from '../tokenCache.js';
import type { RouteContext } from '../types.js';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface AuthorizeQuery {
  target?: string; // 'onedrive' | 'sharepoint'
}

interface SyncBody {
  rootFolderId?: unknown;
  rootPath?: unknown;
  defaultLabel?: unknown;
}

interface ConnectionParams {
  id: string;
}

export async function registerConnectionRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { db, ports, tenantPolicy, labelPolicy, starters } = ctx;
  const connections = () => db.collection(CONNECTIONS_COLLECTION);

  fastify.post(
    '/microsoft/authorize',
    async (request: FastifyRequest<{ Querystring: AuthorizeQuery }>, reply: FastifyReply) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const tenantId = auth.tenantId;
      const actingSub = auth.sub !== '' ? auth.sub : null;
      const target = request.query.target === 'sharepoint' ? 'sharepoint' : 'onedrive';

      if (!(await tenantPolicy.flags(tenantId)).connectorsEnabled) {
        reply.code(403).send({ error: 'connectors_disabled_for_tenant' });
        return;
      }

      const { verifier, challenge } = pkcePair();
      // `actingSub` rides the state JWT because the OAuth callback is
      // anonymous — it carries no session, so this is the ONLY place the
      // acting human's identity survives the round trip. Without it the
      // callback can record just the tenant id, which looks like an
      // attribution and is not one. The consent record (Plan 25 Phase C)
      // cannot be attributable until this field exists.
      //
      // Deliberately NOT the registered `sub` claim: a JWT's `sub` is the
      // subject of that token, and this token's subject is the OAuth flow,
      // not the person who started it. Reusing `sub` would also collide with
      // jose's registered-claim typing, which forbids the null we need.
      const state = await new SignJWT({ tenantId, target, codeVerifier: verifier, actingSub })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(ctx.stateKey);

      let authorizeUrl: string;
      try {
        authorizeUrl = buildAuthorizeUrl(state, challenge, `${ctx.publicBaseUrl}${ctx.callbackPath}`);
      } catch (err) {
        if (err instanceof GraphConnectorError) {
          reply.code(503).send({ error: 'connector_not_configured' });
          return;
        }
        throw err;
      }

      reply.code(200).send({ authorizeUrl });
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // THE ANONYMOUS-CALLBACK CARVE-OUT — read this before touching this route.
  //
  // This route is the ONE deliberately unauthenticated path in the whole
  // plugin: the identity provider redirects the user's browser here with an
  // authorization code, and that redirect carries no session with it. Any
  // auth gateway a host runs in front of this API must allowlist EXACTLY
  // this path (`<prefix>/microsoft/callback`) and nothing else — in
  // particular, no consent path may ever be anonymous-reachable (an
  // unauthenticated caller could otherwise write a consent record attributed
  // to nobody).
  //
  // What authenticates the request instead is the signed state JWT this
  // server minted ten minutes ago at /microsoft/authorize: HS256 over
  // `config.stateSecret`, expiry enforced by jwtVerify. A tampered, forged,
  // or expired state is a 400 before any token exchange or write happens.
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get(
    '/microsoft/callback',
    async (
      request: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>,
      reply: FastifyReply
    ) => {
      const { code, state, error } = request.query;
      if (error) {
        reply.redirect(`${ctx.publicBaseUrl}${ctx.returnPath}?error=${encodeURIComponent(error)}`);
        return;
      }
      if (!code || !state) {
        reply.code(400).send({ error: 'missing_code_or_state' });
        return;
      }

      let payload;
      try {
        ({ payload } = await jwtVerify(state, ctx.stateKey));
      } catch {
        reply.code(400).send({ error: 'invalid_or_expired_state' });
        return;
      }
      const tenantId = String(payload.tenantId);
      const target = payload.target === 'sharepoint' ? 'sharepoint' : 'onedrive';
      const codeVerifier = String(payload.codeVerifier);
      // null, never the tenant id. A null honestly reads as "we do not know
      // who did this"; a tenant id in an actor field reads as an answer and
      // is not one. Anything that requires attribution (the consent record)
      // refuses on null rather than accepting a placeholder.
      const createdBy =
        typeof payload.actingSub === 'string' && payload.actingSub ? payload.actingSub : null;

      try {
        const tokens = await exchangeCodeForTokens(
          code,
          codeVerifier,
          `${ctx.publicBaseUrl}${ctx.callbackPath}`
        );

        const connectionId = `conn-${randomUUID()}`;
        await connections().insertOne({
          connectionId,
          tenantId,
          provider: target,
          driveId: null,
          rootFolderId: null,
          rootPath: null,
          defaultLabel: null,
          encRefreshToken: encryptToken(tokens.refreshToken),
          deltaLink: null,
          status: 'connected',
          createdBy,
          createdAt: new Date(),
          lastSyncAt: null,
          lastSyncStartedAt: null,
          lastSyncStatus: null,
          lastSyncProgress: {
            discovered: 0,
            ingested: 0,
            skipped: 0,
            failed: 0,
            // Uniform four-state outcome vocabulary from birth — the sync
            // workflow carries `deferred` (sink declined for now) and the UI
            // reads it with ?? 0, so seeding it keeps every record shaped alike.
            deferred: 0,
            foldersScanned: 0,
            currentFolder: null,
            recentFiles: [],
          },
        });

        reply.redirect(
          `${ctx.publicBaseUrl}${ctx.returnPath}?connected=${target}&connectionId=${connectionId}`
        );
      } catch (err) {
        fastify.log.error(`Connector OAuth callback failed: ${(err as Error).message}`);
        reply.redirect(`${ctx.publicBaseUrl}${ctx.returnPath}?error=connect_failed`);
      }
    }
  );

  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAuth(ports, request, reply);
    if (!auth) return;
    const docs = await connections()
      .find({ tenantId: auth.tenantId }, { projection: { encRefreshToken: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    reply.code(200).send({ connections: docs });
  });

  fastify.post(
    '/:id/sync',
    async (
      request: FastifyRequest<{ Params: ConnectionParams; Body: SyncBody }>,
      reply: FastifyReply
    ) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      const tenantId = auth.tenantId;
      const { rootFolderId, rootPath, defaultLabel } = request.body || {};

      const conn = await connections().findOne({ connectionId, tenantId });
      if (!conn) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }
      if (!(await tenantPolicy.flags(tenantId)).connectorsEnabled) {
        reply.code(403).send({ error: 'connectors_disabled_for_tenant' });
        return;
      }

      // The connector has no interactive "session" at sync time (it runs
      // unattended, possibly hours later, on a schedule) — the label every
      // ingested file gets is fixed here, at configuration time, resolved
      // through the host's LabelPolicy against whichever admin is starting
      // the sync right now. The policy may CAP a requested label (never
      // raise it) or refuse outright; a refusal is a typed 403, not a
      // silent substitution. This deliberately avoids a latent bug class in
      // an adjacent upload path the source platform had: passing a caller's
      // live session privilege into the workflow instead of the
      // actually-resolved document label.
      let label: string;
      try {
        label = labelPolicy.resolve(
          typeof defaultLabel === 'string' ? defaultLabel : undefined,
          auth
        );
      } catch (err) {
        if (err instanceof LabelRefusedError) {
          reply.code(403).send({ error: 'label_refused', requested: err.requested ?? null });
          return;
        }
        throw err;
      }

      // Legacy `{ connectionId }` filter, kept as shipped: the doc was
      // already loaded under { connectionId, tenantId }, so this cannot
      // select another tenant's row. Newer writes (map, ingest, browse) use
      // the tenant-scoped filter as their standard — see those handlers.
      await connections().updateOne(
        { connectionId },
        {
          $set: {
            rootFolderId: typeof rootFolderId === 'string' ? rootFolderId : conn.rootFolderId,
            rootPath: typeof rootPath === 'string' ? rootPath : conn.rootPath,
            defaultLabel: label,
            status: 'syncing',
            lastSyncStartedAt: new Date(),
          },
        }
      );

      let workflowId: string;
      try {
        workflowId = await starters.startConnectorSyncWorkflow(connectionId);
      } catch (err) {
        fastify.log.error(
          `Failed to start connector sync workflow for ${connectionId}: ${(err as Error).message}`
        );
        reply.code(503).send({ error: 'Unable to start sync workflow — durable start failed' });
        return;
      }

      reply.code(202).send({ status: 'syncing', connectionId, workflowId });
    }
  );

  fastify.delete(
    '/:id',
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply: FastifyReply) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      const tenantId = auth.tenantId;
      const result = await connections().updateOne(
        { connectionId, tenantId },
        { $set: { status: 'disconnected', encRefreshToken: null } }
      );

      if (result.matchedCount === 0) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }
      // Nulling `encRefreshToken` stops FUTURE refreshes; a cached access token
      // would keep serving reads from a disconnected connection until it aged
      // out on its own. Disconnect has to mean disconnected now (`34-S07e`).
      forgetConnectionTokens(tenantId, connectionId);
      reply.code(200).send({ connectionId, status: 'disconnected' });
    }
  );
}
