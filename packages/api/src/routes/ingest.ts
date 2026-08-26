// SPDX-License-Identifier: Apache-2.0
// The Decide flow — the endpoints between the map and the ingest.
//
//   `34-S12c`: GET /:id/map/suggestions (the verdict ledger, paginated with
//              its total stated), PUT /:id/map/selection (the decision,
//              rebuilt not patched), GET /:id/map/selection (read it back).
//   `34-S13b`: costEstimate — the honest token RANGE, computed server-side.
//   `34-S13c`: POST /:id/ingest — the SECOND consent, enforced at the edge,
//              and the label question finally answered (resolved through the
//              host's LabelPolicy).
//
// The workflow half lives in @shelfmark/workflows (selectiveIngestWorkflow),
// which re-verifies the ACTIVE ingest_content consent worker-side on every
// continueAsNew hop and refuses BY NAME (NoSelectionOnRecord,
// MapSuggestionsMissing, SuggestionRowsTruncated, SelectionChangedMidRun)
// anything the edge let through. The refusals HERE are the ones the UI acts
// on — typed codes before any write or start, same doctrine as the map's 403.
//
// POST /:id/sync is UNTOUCHED by this flow: all-or-nothing legacy sync keeps
// its existing contract; the Decide flow is the map path's ingest.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  LabelRefusedError,
  MAP_SELECTIONS_COLLECTION,
  MAP_SUGGESTIONS_COLLECTION,
  estimateIngestCost,
} from '@shelfmark/core';
import { driveMapWorkflowId } from '../workflowStarters.js';
import { CONNECTIONS_COLLECTION, firstString, pathsArray, requireAuth } from '../util.js';
import type { RouteContext } from '../types.js';

/** The SECOND consent (`34-S13c`) — the scope under which file CONTENTS
 *  leave the drive. Must match the workflows package's INGEST_CONSENT_SCOPE
 *  and the consent registry's ConsentScope. */
const INGEST_CONSENT_SCOPE = 'ingest_content';

// MAP_SUGGESTIONS_COLLECTION (the workers' one-per-run suggestions document —
// this package only READS it) and MAP_SELECTIONS_COLLECTION (the customer's
// decided selection, `34-S12c` — this package WRITES it and the workers read
// it back) are imported from @shelfmark/core: the store package owns the names.

/**
 * Response page cap for the suggestions verdict ledger — NAMED, and stated
 * in every response (`rowsPageCap`), never silent (the browse-contract
 * lesson: a bounded thing that does not say so in the output is a silent
 * cap). Provenance: a ledger row measures ~250 B (measured on the reference
 * walk), so a full page is ~500 KB of JSON; the measured reference drive
 * produces 1,983 rows, which fits in ONE page, so pagination only engages on
 * drives bigger than the reference. Distinct from the workers' 20,000-row
 * WRITE cap (rowsTruncated/rowsOmitted/rowCap, passed through verbatim
 * below): that bounds what the ledger holds, this bounds what one response
 * carries.
 */
const MAX_SUGGESTION_ROWS_PER_RESPONSE = 2_000;

/** Opaque rows cursor — an offset under the hood, but the client never
 *  parses it (the browse contract's cursor discipline: opaque, never a
 *  provider URL, and here never an arithmetic invitation either). */
function encodeRowsCursor(offset: number): string {
  return Buffer.from(`rows:${offset}`, 'utf8').toString('base64url');
}

/** null for anything this server did not mint: garbage base64, a foreign
 *  payload, a non-integer. Range checks are the caller's (they need the
 *  ledger's length). */
function decodeRowsCursor(cursor: string): number | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^rows:(0|[1-9][0-9]{0,8})$/.exec(decoded);
  return match ? Number(match[1]) : null;
}

interface ConnectionParams {
  id: string;
}

interface SuggestionsQuery {
  cursor?: string | string[];
}

/** PUT /:id/map/selection body (`34-S12c`). Paths are map_suggestions rows'
 *  `path` values VERBATIM — leading-slash breadcrumb paths, validated
 *  against the ledger below. */
interface SelectionBody {
  removedPaths?: unknown;
  readdedPaths?: unknown;
}

/**
 * POST /:id/ingest body (`34-S13c`). THE label question finally lands here,
 * at step 13, by design — POST /:id/map refused to accept it (see MapBody in
 * map.ts) precisely because this is where the information it governs starts
 * to exist.
 */
interface IngestBody {
  defaultLabel?: unknown;
}

export async function registerIngestRoutes(
  fastify: FastifyInstance,
  ctx: RouteContext
): Promise<void> {
  const { db, ports, tenantPolicy, labelPolicy, consents, starters } = ctx;

  /**
   * The map_suggestions document — verbatim minus Mongo's `_id`, PLUS the
   * computed step-13 cost range, with the verdict ledger paginated. The
   * funnel table, sensitiveReport, defaultSelection, candidates and
   * provenance fields ride EVERY response (page 1 or page N) because the
   * Decide screens render them regardless of which rows are in view; only
   * `rows` pages. `rowsTotal` states the ledger's full length on every
   * response and `nextCursor` is null IF AND ONLY IF the listing is complete
   * — the browse contract, applied here on purpose (no silent truncation).
   *
   * JRN-D1 note: `sensitiveReport` is COUNTS, and stays counts here — this
   * endpoint adds no ranked sensitive-path view on top of the ledger. The
   * rows carry per-row reportedShapes in path codepoint order because the
   * ledger IS the audit trail; presentation rules (`34-S12b`: counts, never
   * a browsable ranked path list) bind the UI that renders them.
   *
   * No connection read needed — same reasoning as GET /:id/map: the runId is
   * derived from the path and tenantId scopes the query itself, so another
   * tenant's suggestions read as none.
   */
  fastify.get(
    '/:id/map/suggestions',
    async (
      request: FastifyRequest<{ Params: ConnectionParams; Querystring: SuggestionsQuery }>,
      reply: FastifyReply
    ) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      const cursor = firstString(request.query.cursor);

      const doc = (await db
        .collection(MAP_SUGGESTIONS_COLLECTION)
        .findOne(
          { runId: driveMapWorkflowId(connectionId), tenantId: auth.tenantId },
          { projection: { _id: 0 } }
        )) as Record<string, unknown> | null;
      if (!doc) {
        reply.code(404).send({ error: 'no_suggestions' });
        return;
      }

      const rows = Array.isArray(doc.rows) ? (doc.rows as Record<string, unknown>[]) : [];
      let offset = 0;
      if (cursor !== undefined) {
        const parsed = decodeRowsCursor(cursor);
        // A cursor this server never minted — garbage, or one outlived by a
        // rewritten ledger (a re-mapped run can shrink rows) — is a 400, not
        // an empty page pretending to be the end of the listing.
        if (parsed === null || parsed <= 0 || parsed >= rows.length) {
          reply.code(400).send({ error: 'invalid_cursor' });
          return;
        }
        offset = parsed;
      }
      const page = rows.slice(offset, offset + MAX_SUGGESTION_ROWS_PER_RESPONSE);
      const nextOffset = offset + page.length;

      // `34-S13b`: the honest range over the DEFAULT selection (verdict
      // 'selected'), whole ledger regardless of which page is being served —
      // the cost block describes the selection, not the page.
      const costEstimate = estimateIngestCost(
        rows
          .filter((r) => r.verdict === 'selected')
          .map((r) => ({ name: String(r.name ?? ''), size: Number(r.size ?? 0) })),
        { ledgerTruncated: doc.rowsTruncated === true }
      );

      reply.code(200).send({
        ...doc,
        costEstimate,
        rows: page,
        rowsTotal: rows.length,
        rowsPageCap: MAX_SUGGESTION_ROWS_PER_RESPONSE,
        nextCursor: nextOffset < rows.length ? encodeRowsCursor(nextOffset) : null,
      });
    }
  );

  /**
   * Persist the customer's decision (`34-S12c`) — the doc the workers'
   * latest-decision resolution reads back. REBUILT, NOT PATCHED: each PUT is
   * a complete re-decision keyed {runId, tenantId}, $set-ing every field of
   * the decision including both full arrays. `decidedAt` is stamped fresh on
   * every write because it is what the workers sort on (latest decision
   * wins) and what SelectionChangedMidRun pins against — a patched doc with
   * a stale decidedAt would let a mid-ingest re-decision go undetected.
   *
   * Validation is against the suggestions ledger: a path not among its rows
   * is a 400 NAMING the path and the field, so a typo'd removal fails loudly
   * here instead of becoming a workers-side named per-file failure later
   * (re-adds) or a silent no-op (removals).
   */
  fastify.put(
    '/:id/map/selection',
    async (
      request: FastifyRequest<{ Params: ConnectionParams; Body: SelectionBody }>,
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

      const runId = driveMapWorkflowId(connectionId);
      const suggestions = (await db
        .collection(MAP_SUGGESTIONS_COLLECTION)
        .findOne({ runId, tenantId }, { projection: { _id: 0 } })) as Record<
        string,
        unknown
      > | null;
      if (!suggestions) {
        // The Decide phase decides OVER the ledger; without one there is
        // nothing to validate a path against, and a decision recorded blind
        // would be resolved against whatever ledger appears later.
        reply.code(404).send({ error: 'no_suggestions' });
        return;
      }
      if (suggestions.rowsTruncated === true) {
        // A truncated ledger (the workers' named 20k write cap) cannot
        // validate membership honestly: a real path beyond the cap would 400
        // as unknown, and a decision recorded against the partial ledger
        // would quietly cover a subset. Refuse by name — the same posture as
        // the workers' SuggestionRowsTruncated refusal downstream.
        reply.code(409).send({ error: 'suggestion_rows_truncated' });
        return;
      }

      const removedPaths = pathsArray(body.removedPaths);
      if (removedPaths === null) {
        reply.code(400).send({ error: 'selection_paths_invalid', field: 'removedPaths' });
        return;
      }
      const readdedPaths = pathsArray(body.readdedPaths);
      if (readdedPaths === null) {
        reply.code(400).send({ error: 'selection_paths_invalid', field: 'readdedPaths' });
        return;
      }

      const rows = Array.isArray(suggestions.rows)
        ? (suggestions.rows as Record<string, unknown>[])
        : [];
      const ledgerPaths = new Set(rows.map((r) => String(r.path)));
      for (const [field, paths] of [
        ['removedPaths', removedPaths],
        ['readdedPaths', readdedPaths],
      ] as const) {
        for (const path of paths) {
          if (!ledgerPaths.has(path)) {
            reply.code(400).send({ error: 'selection_path_unknown', field, path });
            return;
          }
        }
      }

      const decidedAt = new Date();
      await db
        .collection(MAP_SELECTIONS_COLLECTION)
        .updateOne(
          { runId, tenantId },
          { $set: { runId, tenantId, connectionId, removedPaths, readdedPaths, decidedAt } },
          { upsert: true }
        );

      reply.code(200).send({ runId, connectionId, removedPaths, readdedPaths, decidedAt });
    }
  );

  /** Read the decision back — the doc verbatim minus `_id`, tenant-scoped;
   *  another tenant's decision reads as none, same as every map read. */
  fastify.get(
    '/:id/map/selection',
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply: FastifyReply) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;

      const doc = await db
        .collection(MAP_SELECTIONS_COLLECTION)
        .findOne(
          { runId: driveMapWorkflowId(connectionId), tenantId: auth.tenantId },
          { projection: { _id: 0 } }
        );
      if (!doc) {
        reply.code(404).send({ error: 'no_selection' });
        return;
      }
      reply.code(200).send(doc);
    }
  );

  /**
   * Start the selective ingest (`34-S13c` — the SECOND consent, enforced;
   * closes the rest of JRN-2). Mirrors POST /:id/map's gate order: the
   * connector switch for shape-parity with sync, then the fail-closed checks
   * that actually decide — an ACTIVE ingest_content consent (derived from
   * the same append-only event stream the map's check reads; a map_metadata
   * grant does NOT satisfy it), then the decided selection (the Decide phase
   * is not optional on the map flow — a missing decision is a 409, not an
   * implicit ingest-everything). All-or-nothing legacy sync remains at
   * POST /:id/sync, untouched.
   *
   * THE label question lands here, at step 13, by design (see MapBody's
   * comment in map.ts): resolved through the host's LabelPolicy against the
   * caller who is answering it NOW, then $set on the connection so the
   * ingested corpus lands under a value an admin actually chose after seeing
   * the map — never a value smuggled in before the map existed.
   */
  fastify.post(
    '/:id/ingest',
    async (
      request: FastifyRequest<{ Params: ConnectionParams; Body: IngestBody }>,
      reply: FastifyReply
    ) => {
      const auth = await requireAuth(ports, request, reply);
      if (!auth) return;
      const { id: connectionId } = request.params;
      const tenantId = auth.tenantId;
      const { defaultLabel } = request.body || {};

      const collection = db.collection(CONNECTIONS_COLLECTION);
      const conn = await collection.findOne({ connectionId, tenantId });
      if (!conn) {
        reply.code(404).send({ error: `No connection ${connectionId}` });
        return;
      }
      // Shape-parity with sync and map: the connector switch first.
      if (!(await tenantPolicy.flags(tenantId)).connectorsEnabled) {
        reply.code(403).send({ error: 'connectors_disabled_for_tenant' });
        return;
      }
      // ── `34-S13c`: the SECOND consent, derived not stored — same real
      // activeConsents derivation as the map's gate. No write, no start,
      // happens past this point without an active ingest_content grant. ──
      const active = consents.activeConsents(
        await consents.listConsentEvents(tenantId, connectionId)
      );
      if (!active.some((c) => c.scope === INGEST_CONSENT_SCOPE)) {
        reply.code(403).send({ error: 'ingest_consent_required' });
        return;
      }
      // The workers' own question, asked with the workers' own filter
      // ({tenantId, connectionId} — the selective-ingest activities'
      // latest-selection resolution): is there a decided selection at all?
      // 409, not 404 — the connection exists; it is the FLOW that is
      // mid-state.
      const selection = await db
        .collection(MAP_SELECTIONS_COLLECTION)
        .findOne({ tenantId, connectionId });
      if (!selection) {
        reply.code(409).send({ error: 'no_selection' });
        return;
      }

      // Same resolution discipline as sync's configuration-time label — the
      // host's LabelPolicy may cap a requested value (never raise it) or
      // refuse outright, and a refusal is a typed 403.
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

      // START FIRST, THEN WRITE. The label records a decision the customer
      // made about an ingest that is actually going to happen. Writing it
      // before the start meant a 503 left the connection relabelled by a
      // request that ingested nothing — and the next sync would inherit a
      // tier the customer chose for a run that never existed.
      let workflowId: string;
      try {
        workflowId = await starters.startSelectiveIngestWorkflow(connectionId, label);
      } catch (err) {
        fastify.log.error(
          `Failed to start selective ingest workflow for ${connectionId}: ${(err as Error).message}`
        );
        reply.code(503).send({ error: 'Unable to start ingest workflow — durable start failed' });
        return;
      }

      await collection.updateOne(
        { connectionId, tenantId },
        { $set: { defaultLabel: label } }
      );

      reply.code(202).send({ status: 'ingesting', connectionId, workflowId });
    }
  );
}
