// SPDX-License-Identifier: Apache-2.0
// The Map — start + read + stream (`34-S09d`), with consent enforcement at
// the edge (`34-S08c`).
//
// The workflow half lives in @shelfmark/workflows (driveMapWorkflow), started
// by name on the host's task queue with args [{connectionId}]. The workflow
// verifies the ACTIVE map_metadata consent AGAIN before any provider call and
// re-verifies on every continueAsNew hop. That worker-side check is defense
// in depth; the refusal HERE is the one the UI acts on — a 403 with a typed
// code the consent screen can route to, instead of a 202 followed by a run
// doc that says 'refused_no_consent'.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// The workers' map-run documents — this package only ever READS them. The
// run doc is written by the workflow; the edge starts, watches, and refuses.
// The collection name comes from @shelfmark/core (the store package owns it).
import { MAP_RUNS_COLLECTION } from '@shelfmark/core';
import { driveMapWorkflowId } from '../workflowStarters.js';
import { CONNECTIONS_COLLECTION, requireAuth } from '../util.js';
import { openSseStream } from '../sse.js';
import type { RouteContext } from '../types.js';

/** The one consent scope the map requires — must match the workflows
 *  package's MAP_CONSENT_SCOPE and the consent registry's ConsentScope. */
const MAP_CONSENT_SCOPE = 'map_metadata';

/** Same cap family as the per-frame cap the source platform's chat stream
 *  carried, and for the same documented reason: one oversized SSE frame can
 *  repeat the proxy-cutoff failure mode. Narration/progress frames are small
 *  by construction; the terminal frame is the one that can grow (a full
 *  pruneManifest is up to 2000 entries) and degrades instead of dying. */
const MAX_MAP_FRAME_BYTES = 32_000;

interface ConnectionParams {
  id: string;
}

/**
 * POST /:id/map body (`34-S09d`). NO label field, by design: sync fixes
 * `defaultLabel` at configuration time because ingestion mints documents,
 * but the map mints none — it reads names, sizes and counts. Which label the
 * eventually-ingested corpus lands under is the Decide phase's step-13
 * decision, made AFTER the customer has seen the map. A label accepted here
 * would be recorded before the information it governs exists. Do not add it
 * back.
 */
interface MapBody {
  rootFolderId?: unknown;
  rootPath?: unknown;
}

export async function registerMapRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { db, ports, tenantPolicy, consents, starters } = ctx;

  /** Start the map. Mirrors POST /:id/sync's shape; consent-gated. */
  fastify.post(
    '/:id/map',
    async (
      request: FastifyRequest<{ Params: ConnectionParams; Body: MapBody }>,
      reply: FastifyReply
    ) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      const tenantId = auth.tenantId;
      const { rootFolderId, rootPath } = request.body || {};

      const collection = db.collection(CONNECTIONS_COLLECTION);
      const conn = await collection.findOne({ connectionId, tenantId });
      if (!conn) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }
      // Shape-parity with sync: the connector switch first, then the
      // fail-closed checks that actually decide.
      const flags = await tenantPolicy.flags(tenantId);
      if (!flags.connectorsEnabled) {
        reply.code(403).send({ error: 'connectors_disabled_for_tenant' });
        return;
      }
      // FAIL CLOSED on the tenant's mapping switch — EVEN THOUGH the consent
      // grant path already required it (POST /:id/consents refuses a
      // map_metadata grant unless `mappingEnabled === true`). The grant check
      // ran at grant TIME; this one runs at map time, and the gap between
      // them is exactly the case that matters: an admin who switches mapping
      // off AFTER a consent was granted has withdrawn the tenant-level
      // precondition, and a standing consent must not outrank it. Consent is
      // necessary, never sufficient — the same reasoning as the workers
      // re-verifying consent on every continueAsNew hop, applied to the
      // other switch. Strict `=== true`: mapping is opt-in, absent means OFF.
      if (flags.mappingEnabled !== true) {
        reply.code(403).send({ error: 'mapping_disabled_for_tenant' });
        return;
      }
      // ── `34-S08c`: CONSENT ENFORCEMENT AT THE EDGE (closes half of
      // JRN-2). "Active" is DERIVED from the append-only event stream by the
      // same activeConsents used to render the consent history: a grant plus
      // a later revocation naming its consentId is NOT active. No workflow
      // start, no connection write, happens past this point without one. ──
      const active = consents.activeConsents(
        await consents.listConsentEvents(tenantId, connectionId)
      );
      if (!active.some((c) => c.scope === MAP_CONSENT_SCOPE)) {
        reply.code(403).send({ error: 'map_consent_required' });
        return;
      }

      // Tenant-scoped filter (unlike sync's legacy `{ connectionId }` — this
      // write is newer and gets the browse handler's standard).
      await collection.updateOne(
        { connectionId, tenantId },
        {
          $set: {
            rootFolderId: typeof rootFolderId === 'string' ? rootFolderId : conn.rootFolderId,
            rootPath: typeof rootPath === 'string' ? rootPath : conn.rootPath,
          },
        }
      );

      let workflowId: string;
      try {
        workflowId = await starters.startDriveMapWorkflow(connectionId);
      } catch (err) {
        fastify.log.error(
          `Failed to start drive map workflow for ${connectionId}: ${(err as Error).message}`
        );
        reply.code(503).send({ error: 'Unable to start map workflow — durable start failed' });
        return;
      }

      reply.code(202).send({ status: 'mapping', connectionId, workflowId });
    }
  );

  /**
   * The current map run's document, verbatim. STRIP NOTHING: the doc IS the
   * contract — the UI renders the truncation flags (rollupTruncated,
   * pruneManifestTruncated, narrationDropped) and the reconciliation sums
   * as-is, because a bounded thing that does not say so in the output is a
   * silent cap (the defect class the map work kept finding). Only Mongo's own
   * `_id` is projected out; it is storage, not contract.
   *
   * No connection read needed: the runId is derived from the path and
   * `tenantId` scopes the query itself, so another tenant's run — like a
   * connection that does not exist — is indistinguishable from no run.
   */
  fastify.get(
    '/:id/map',
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply: FastifyReply) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;

      const doc = await db
        .collection(MAP_RUNS_COLLECTION)
        .findOne(
          { runId: driveMapWorkflowId(connectionId), tenantId: auth.tenantId },
          { projection: { _id: 0 } }
        );
      if (!doc) {
        reply.code(404).send({ error: 'no_map_run' });
        return;
      }
      reply.code(200).send(doc);
    }
  );

  /**
   * SSE for the watch-it-run step: the narration stream a customer READS
   * while the map walks their drive. Transport discipline (reply.hijack(),
   * manual headers, per-frame byte caps, client-close cleanup) lives in
   * sse.ts, with heartbeat comment frames on top because this stream can
   * legitimately go quiet for longer than a proxy idle timeout while the
   * walk grinds through a huge folder.
   *
   * Server-side it POLLS the map_runs doc (the workflow flushes progress
   * every page — polling is the correct transport for that write pattern):
   * each NEW narration line is emitted exactly once, progress is emitted
   * when it changes, and a terminal 'complete' frame closes the stream when
   * status leaves 'mapping'.
   *
   * NO BILLING/ATTRIBUTION GATE, deliberately. The narration at this stage
   * is arithmetic ('sum'/'chk'/'fix' lines): no model call happens anywhere
   * on this path, so there is nothing to attribute and nothing to bill. A
   * host that adds model narration ('ask' lines) MUST add its own
   * attribution gate at that point — the moment a model is asked, this route
   * stops being free.
   */
  fastify.get(
    '/:id/map/stream',
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply: FastifyReply) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      const tenantId = auth.tenantId;

      // Connection existence is checked BEFORE the hijack, while a plain
      // JSON 404 is still possible — tenant-scoped, so a foreign connection
      // reads as absent.
      const conn = await db.collection(CONNECTIONS_COLLECTION).findOne({ connectionId, tenantId });
      if (!conn) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }

      reply.hijack();
      const stream = openSseStream(reply.raw, {
        heartbeatMs: ctx.mapStream.heartbeatMs,
        maxFrameBytes: MAX_MAP_FRAME_BYTES,
        // A dropped frame is logged server-side, never silent — and only
        // narration/progress frames can be dropped (the terminal frame
        // degrades instead, below).
        onFrameDropped: ({ bytes, type }) =>
          fastify.log.error(
            `map stream frame for ${connectionId} dropped: ${bytes} bytes exceeds cap (type=${type})`
          ),
      });

      const runId = driveMapWorkflowId(connectionId);
      const runs = db.collection(MAP_RUNS_COLLECTION);

      // Knobs come sanitized from plugin config (see MapStreamConfig): the
      // ~700ms default poll matches the narration engine's minimum per-line
      // pace; the no-run timeout is BOUNDED, STATED — a stream opened before
      // the workflow's first write (or for a connection never mapped) waits
      // that long for a run doc, then 404-frames and closes rather than
      // hanging forever.
      const { pollMs, noRunTimeoutMs } = ctx.mapStream;

      let timer: NodeJS.Timeout | undefined;
      let narrationSent = 0;
      let lastProgressJson: string | null = null;
      const openedAt = Date.now();

      const end = () => {
        if (timer) clearTimeout(timer);
        stream.end();
      };
      request.raw.on('close', () => {
        if (timer) clearTimeout(timer);
        stream.abandon();
      });

      /** The terminal frame: the run doc minus narration (each line already
       *  streamed individually). Degrades under the frame cap by shedding
       *  its two unbounded-ish itemizations — both remain fetchable in full
       *  at GET /:id/map, and each shed is FLAGGED in the frame, not silent. */
      const completeFrame = (doc: Record<string, unknown>): Record<string, unknown> => {
        const { _id, narration, ...rest } = doc as Record<string, unknown> & { _id?: unknown };
        void _id;
        void narration;
        let frame: Record<string, unknown> = { type: 'complete', ...rest };
        if (Buffer.byteLength(JSON.stringify(frame)) > MAX_MAP_FRAME_BYTES) {
          const { pruneManifest, ...withoutManifest } = frame;
          void pruneManifest;
          frame = { ...withoutManifest, pruneManifestElided: true };
        }
        if (Buffer.byteLength(JSON.stringify(frame)) > MAX_MAP_FRAME_BYTES) {
          const { topFolders, ...withoutTop } = frame;
          void topFolders;
          frame = { ...withoutTop, topFoldersElided: true };
        }
        return frame;
      };

      const poll = async (): Promise<void> => {
        if (stream.closed) return;
        try {
          const doc = (await runs.findOne(
            { runId, tenantId },
            { projection: { _id: 0 } }
          )) as Record<string, unknown> | null;

          if (!doc) {
            if (Date.now() - openedAt >= noRunTimeoutMs) {
              stream.writeFrame({ type: 'error', error: 'no_map_run' });
              end();
              return;
            }
            stream.heartbeatIfDue();
            schedule();
            return;
          }

          // Each NEW narration line exactly once — the doc accumulates, the
          // stream deltas.
          const narration = Array.isArray(doc.narration) ? doc.narration : [];
          for (; narrationSent < narration.length; narrationSent++) {
            stream.writeFrame({ type: 'narration', line: narration[narrationSent] });
          }

          if (doc.progress !== undefined) {
            const progressJson = JSON.stringify(doc.progress);
            if (progressJson !== lastProgressJson) {
              lastProgressJson = progressJson;
              stream.writeFrame({ type: 'progress', progress: doc.progress });
            }
          }

          if (doc.status !== 'mapping') {
            // Terminal for every non-mapping status — 'complete', 'failed',
            // 'refused_no_consent', 'unsupported_provider'. The frame says
            // which; the UI routes on it.
            stream.writeFrame(completeFrame(doc));
            end();
            return;
          }

          stream.heartbeatIfDue();
          schedule();
        } catch (err) {
          // A store failure mid-stream ends the stream honestly rather than
          // leaving the client on a silent line that will never speak again.
          fastify.log.error(
            `map stream poll failed for ${connectionId}: ${(err as Error).message}`
          );
          stream.writeFrame({ type: 'error', error: 'map_stream_failed' });
          end();
        }
      };
      const schedule = () => {
        if (stream.closed) return;
        timer = setTimeout(() => {
          void poll();
        }, pollMs);
      };

      void poll();
    }
  );
}
