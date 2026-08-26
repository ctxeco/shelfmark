// SPDX-License-Identifier: Apache-2.0
// Root-folder picker — a UI convenience, not a general Graph read-through
// proxy. Resolves the drive (OneDrive default drive, or a SharePoint site's
// document library from a hostname+path pair) on first call if the
// connection doesn't have one yet, then lists a folder honestly and says
// whether there is more.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  GraphConnectorError,
  getMyDrive,
  getSharePointDrive,
  listAllChildren,
  refreshAccessToken,
} from '@shelfmark/graph';
import type { EncryptedToken } from '@shelfmark/core';
import { CONNECTIONS_COLLECTION, firstString, requireAuth } from '../util.js';
import { connectionAccessToken, type ProviderTokens } from '../tokenCache.js';
import type { RouteContext } from '../types.js';

interface ConnectionParams {
  id: string;
}

interface BrowseQuery {
  folderId?: string | string[];
  cursor?: string | string[];
  sharepointHostname?: string | string[];
  sharepointSitePath?: string | string[];
}

/**
 * Browse failures, told apart instead of flattened (`34-S09c`).
 *
 * Every one of these used to be `502 browse_failed`, which is the same
 * sentence for "slow down", "you never granted us that permission" and "that
 * folder is gone". The provider client preserves `status`, so the answer can
 * carry what actually happened:
 *
 *   429 `browse_throttled`   + Retry-After — the caller can back off, and the
 *                              Map phase's retry policy (`34-S09b`, in the
 *                              workflows package) has something to read. No
 *                              retrying HERE: a request-scoped handler cannot
 *                              outlive the wait it would be sleeping through.
 *   403 `browse_scope_missing` — the token verifiably lacks the scope. Graph
 *                              answers 404 for this, which is why it needs
 *                              its own code; the UI turns it into the
 *                              sentence a person can act on (`34-S06d`).
 *   404 `browse_folder_not_found` — a genuine not-found. Distinguishable from
 *                              the connection-level 404 above by its `error`
 *                              value.
 *   502 `browse_failed`      — everything else, unchanged.
 */
function sendBrowseFailure(
  fastify: FastifyInstance,
  reply: FastifyReply,
  err: unknown,
  connectionId: string
): void {
  const detailed = err instanceof GraphConnectorError ? err : null;
  const status = detailed?.status ?? null;
  const scopeMissing = detailed?.scopeMissing === true;

  fastify.log.error(
    `Connector browse failed for ${connectionId} (status=${status ?? 'none'}, provider_code=${
      detailed?.providerErrorCode ?? 'none'
    }): ${(err as Error).message}`
  );

  if (detailed?.isThrottled) {
    const retryAfterSeconds = detailed.retryAfterSeconds;
    if (retryAfterSeconds !== null) reply.header('Retry-After', String(retryAfterSeconds));
    reply.code(429).send({ error: 'browse_throttled', retryAfterSeconds });
    return;
  }
  if (scopeMissing) {
    reply.code(403).send({ error: 'browse_scope_missing' });
    return;
  }
  if (status === 404) {
    reply.code(404).send({ error: 'browse_folder_not_found' });
    return;
  }
  reply.code(502).send({ error: 'browse_failed' });
}

export async function registerBrowseRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { db, ports, tenantPolicy } = ctx;

  // THE CONTRACT (`34-S07a`/`34-S07b`; the UI package owns the shape, this
  // package follows it byte for byte):
  //
  //   GET <prefix>/:id/browse?folderId=<id>&cursor=<opaque>
  //   -> { items: [{ id, name, isFolder, size, modified, childCount }],
  //        nextCursor: string | null,
  //        truncated: boolean }
  //
  //   * FILES ARE RETURNED, not just folders. The product is "names before
  //     files"; a picker that hides files cannot show what it promises.
  //   * The listing follows Graph's continuation links to a documented
  //     ceiling (@shelfmark/graph LIST_ALL_CHILDREN_CEILING, 2000 children)
  //     and then SAYS SO: `truncated: true` plus the cursor to continue
  //     from. `truncated` is true if and only if the ceiling — not the end
  //     of the folder — stopped the listing, and the UI renders it. A
  //     bounded thing that does not say so in the output is a silent cap,
  //     which is the one defect this contract exists to keep dead.
  //   * `nextCursor` is null IF AND ONLY IF the listing is complete. A
  //     non-null cursor the caller ignores is a caller bug. A null cursor on
  //     an incomplete listing is a SERVER bug — the silent truncation again.
  //   * The cursor is OPAQUE to the client and never a provider URL. Graph's
  //     `@odata.nextLink` is a fully-formed URL that can carry credentials in
  //     its query string; the client half of the cursor is stripped down to
  //     the paging token inside @shelfmark/graph.
  //   * `size`/`modified`/`childCount` are null ONLY for "the provider did
  //     not tell us", never as a stand-in for zero. A 0-byte file has size 0;
  //     an empty folder has childCount 0. The map screens render "empty" and
  //     "contains N items reporting no size" as DIFFERENT absence states, so
  //     collapsing the two here makes that screen lie.
  //
  // No consent check here on purpose: map consent gates `POST /:id/map`
  // (`34-S08c`), not the picker a customer uses to decide what to consent to.
  fastify.get(
    '/:id/browse',
    async (
      request: FastifyRequest<{ Params: ConnectionParams; Querystring: BrowseQuery }>,
      reply: FastifyReply
    ) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      // Tenant identity comes from the host-VERIFIED auth context only —
      // never a param, never a header. It is also what scopes the lookup
      // below, so a connection belonging to another tenant is
      // indistinguishable from one that does not exist.
      const tenantId = auth.tenantId;
      const folderId = firstString(request.query.folderId);
      const cursor = firstString(request.query.cursor);

      const collection = db.collection(CONNECTIONS_COLLECTION);
      const conn = await collection.findOne({ connectionId, tenantId });
      if (!conn) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }
      // The same switch POST /:id/sync and the authorize path sit behind.
      // Browse reads the CONTENTS of a connected drive, so a tenant that has
      // opted out of connectors must not be able to walk one. History: this
      // check was MISSING here in the source platform while its posture
      // comment claimed otherwise, and the gap had a security consequence —
      // an admin flipping the tenant switch off stopped new authorizations
      // and new syncs but left every existing connection fully browsable.
      // Closed 2026-08-19; the port keeps it closed.
      //
      // Ordered BEFORE the disconnected check below on purpose: a tenant
      // that is switched off should not be able to tell a live connection
      // from a disconnected one.
      if (!(await tenantPolicy.flags(tenantId)).connectorsEnabled) {
        reply.code(403).send({ error: 'connectors_disabled_for_tenant' });
        return;
      }
      if (!conn.encRefreshToken) {
        // DELETE /:id nulls the token out. Without this branch that lands in
        // the decrypt as a crash and answers 502 "browse_failed", which
        // reads as "the provider is broken" when the truth is "this
        // connection was disconnected".
        reply.code(409).send({ error: 'connection_disconnected' });
        return;
      }

      // `34-S07e`: cached access token, rotated refresh token persisted on
      // the way past.
      const tokenFor = (refresh: (token: string) => Promise<ProviderTokens>) =>
        connectionAccessToken({
          tenantId,
          connectionId,
          encRefreshToken: conn.encRefreshToken as EncryptedToken,
          refresh,
          persistRotatedRefreshToken: async (encrypted) => {
            // Tenant-scoped filter: this write is new, and a new write has no
            // reason to be able to address a document outside the caller's
            // tenant.
            await collection.updateOne(
              { connectionId, tenantId },
              { $set: { encRefreshToken: encrypted } }
            );
          },
          onRotationPersistFailure: (err) =>
            fastify.log.error(
              `Rotated refresh token NOT persisted for ${connectionId} — this connection will fail to refresh: ${
                (err as Error).message
              }`
            ),
        });

      try {
        const { accessToken, scopes } = await tokenFor(refreshAccessToken);

        let driveId = conn.driveId as string | null;
        if (!driveId) {
          if (conn.provider === 'sharepoint') {
            const sharepointHostname = firstString(request.query.sharepointHostname);
            const sharepointSitePath = firstString(request.query.sharepointSitePath);
            if (!sharepointHostname || !sharepointSitePath) {
              reply.code(400).send({ error: 'sharepoint_site_required' });
              return;
            }
            driveId = (
              await getSharePointDrive(accessToken, sharepointHostname, sharepointSitePath, scopes)
            ).driveId;
          } else {
            driveId = (await getMyDrive(accessToken, scopes)).driveId;
          }
          // Tenant-scoped like every other write in this handler. The doc was
          // already loaded under { connectionId, tenantId }, so this cannot
          // select another tenant's row either way — but a lone unscoped filter
          // among scoped ones reads as a deliberate exception and invites the
          // next writer to copy it.
          await collection.updateOne({ connectionId, tenantId }, { $set: { driveId } });
        }

        const listing = await listAllChildren(accessToken, driveId, folderId, {
          cursor,
          // Lets a Graph 404 be explained as a missing scope rather than a
          // missing folder — see @shelfmark/graph's toGraphHttpError.
          grantedScopes: scopes,
        });
        reply.code(200).send({
          items: listing.items,
          nextCursor: listing.nextCursor,
          truncated: listing.truncated,
        });
      } catch (err) {
        sendBrowseFailure(fastify, reply, err, connectionId);
      }
    }
  );
}
