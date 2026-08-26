// SPDX-License-Identifier: Apache-2.0
// Connection + token + delta-page activities: the store-facing half of the
// sync path. Split out of the source system's one big Graph-activities module
// three ways at port time — this file (connection/token/delta plumbing),
// egress.ts (the gate crossings), and ingest.ts (the download head that ends
// at `DocumentSink.accept()`).
import {
  decryptToken,
  encryptToken,
  type ConnectorConnectionDoc,
  type DeltaExpiryRecord,
} from '@shelfmark/core';
import {
  refreshAccessToken,
  listDeltaPage,
  isDeltaResyncRequired,
  type DeltaPage,
} from '@shelfmark/graph';
import type { IngestSkipReason } from '@shelfmark/policy';
import type { ShelfmarkWorkflowDeps } from '../deps';

export type Connection = ConnectorConnectionDoc;

// ── Plain helpers (shared with the map activities) ──────────────────────────

export async function getConnectionDoc(
  deps: ShelfmarkWorkflowDeps,
  connectionId: string
): Promise<Connection> {
  const doc = await deps.store.collections.connections().findOne({ connectionId });
  if (!doc) {
    throw new Error(`Connector connection ${connectionId} not found`);
  }
  return doc as Connection;
}

/**
 * The sync/map/ingest paths run only against a connection that is still
 * connected (encRefreshToken present — nulled on disconnect) and whose drive
 * has been resolved (driveId null only before the first browse). The store
 * type tells the truth about those nullable states, so the narrowing lives
 * here as typed refusals rather than as assertions scattered at call sites.
 */
export function requireActiveConnection(
  conn: Connection
): Connection & { driveId: string; encRefreshToken: NonNullable<Connection['encRefreshToken']> } {
  if (!conn.encRefreshToken) {
    throw new Error(
      `Connection ${conn.connectionId} is disconnected (no refresh token) — reconnect before syncing.`
    );
  }
  if (!conn.driveId) {
    throw new Error(
      `Connection ${conn.connectionId} has no resolved drive yet — browse once to resolve it before mapping or syncing.`
    );
  }
  return conn as Connection & {
    driveId: string;
    encRefreshToken: NonNullable<Connection['encRefreshToken']>;
  };
}

/**
 * Refreshes the access token for this connection. Graph refresh tokens
 * rotate on use — if the response carries a new one, re-encrypt and persist
 * it immediately so a later retry (or the next scheduled sync) doesn't
 * replay an already-invalidated token.
 */
export async function getGraphAccessTokenFor(
  deps: ShelfmarkWorkflowDeps,
  connectionId: string
): Promise<string> {
  const conn = requireActiveConnection(await getConnectionDoc(deps, connectionId));
  const tokens = await refreshAccessToken(decryptToken(conn.encRefreshToken));
  if (tokens.refreshToken && tokens.refreshToken !== decryptToken(conn.encRefreshToken)) {
    await deps.store.collections
      .connections()
      .updateOne({ connectionId }, { $set: { encRefreshToken: encryptToken(tokens.refreshToken) } });
  }
  return tokens.accessToken;
}

/** The expiry, on the connection document, BEFORE the re-enumeration runs —
 *  so even a crash mid-fallback leaves the reason for the re-crawl visible. */
async function recordDeltaExpiry(
  deps: ShelfmarkWorkflowDeps,
  connectionId: string,
  detail: string
): Promise<void> {
  const expiry: DeltaExpiryRecord = {
    at: new Date(),
    action: 'full_reenumeration',
    detail: detail.slice(0, 500),
  };
  await deps.store.collections
    .connections()
    .updateOne({ connectionId }, { $set: { lastDeltaExpiry: expiry }, $inc: { deltaExpiryCount: 1 } });
}

// ── The sync progress record ────────────────────────────────────────────────

/** The polled sync progress. Every field beyond the original four is
 *  OPTIONAL on purpose: the wire shape is additive-only, so a workflow
 *  execution started under an older release of this package still calls this
 *  activity with the shape it was born with. */
export interface SyncProgressRecord {
  discovered: number;
  ingested: number;
  skipped: number;
  failed: number;
  foldersScanned: number;
  /** 34-S14e generalized — deferred by the sink (declined for now). Counted
   *  apart from `failed` because nothing is wrong with these files, and
   *  apart from `skipped` because it is not a decision this library took. */
  deferred?: number;
  /** 34-S14d — per-reason rollup over the CLOSED skip vocabulary, so a
   *  completion screen can say WHICH bound bit how often instead of showing
   *  an unexplained "skipped: 412". */
  skippedByReason?: Record<string, number>;
  /** 34-S14c — how many times this sync fell back to a full re-enumeration
   *  because the stored delta token had expired. Nonzero explains a re-crawl
   *  that would otherwise look like a first crawl. */
  deltaExpiredFallbacks?: number;
  currentFolder?: string | null;
  recentFiles?: {
    name: string;
    path: string;
    status: 'ingested' | 'failed' | 'skipped' | 'deferred';
    reason?: string;
  }[];
}

// ── The activity factory ────────────────────────────────────────────────────

export function createConnectionActivities(deps: ShelfmarkWorkflowDeps) {
  return {
    async getConnection(connectionId: string): Promise<Connection> {
      return getConnectionDoc(deps, connectionId);
    },

    async getGraphAccessToken(connectionId: string): Promise<string> {
      return getGraphAccessTokenFor(deps, connectionId);
    },

    /**
     * 34-S14c — one delta page, with the ONE Graph failure that is not an
     * error handled instead of retried to death.
     *
     * A stored `deltaLink` ages out (Graph answers 410 Gone). Before this,
     * that 410 looked like any other failure: the activity's retry policy
     * spent all five attempts on a permanently dead token, the sync finalised
     * 'failed', the dead token stayed stored, and the NEXT sync did the same
     * — a long-idle connection failed and stayed failing with nothing in the
     * product saying why.
     *
     * The fallback is a full re-enumeration (delta with no token returns the
     * entire current tree). That is only safe when the SINK dedupes on the
     * stable documentId (see ingest.ts and the DocumentMeta contract): a
     * re-enumeration against a non-deduping sink IS the duplicate-corpus
     * event, which is why the id contract and this fallback landed together
     * (34-S14b/c). The fallback is RECORDED — on the connection document
     * here, and on the sync's own progress/finalize record through
     * `deltaExpired` — so a re-crawl caused by expiry never masquerades as a
     * normal first crawl.
     */
    async listRemoteDeltaPage(connectionId: string, deltaOrNextLink?: string): Promise<DeltaPage> {
      const conn = requireActiveConnection(await getConnectionDoc(deps, connectionId));
      const accessToken = await getGraphAccessTokenFor(deps, connectionId);
      try {
        return await listDeltaPage(accessToken, conn.driveId, conn.rootFolderId, deltaOrNextLink);
      } catch (err) {
        // No token to expire means this IS already a full enumeration:
        // whatever failed, it is not token expiry, and retrying is right.
        if (!deltaOrNextLink || !isDeltaResyncRequired(err)) throw err;
        await recordDeltaExpiry(deps, connectionId, (err as Error).message);
        const page = await listDeltaPage(accessToken, conn.driveId, conn.rootFolderId, undefined);
        return { ...page, deltaExpired: true };
      }
    },

    async updateSyncProgress(connectionId: string, progress: SyncProgressRecord): Promise<void> {
      await deps.store.collections
        .connections()
        .updateOne({ connectionId }, { $set: { lastSyncProgress: progress } });
    },

    async finalizeSync(
      connectionId: string,
      status: 'complete' | 'failed',
      deltaLink?: string,
      /** 34-S14c — the run's own summary of anything that changed the SHAPE
       *  of the crawl. Optional and appended (additive-only wire shape). */
      summary?: { deltaExpiredFallbacks?: number }
    ): Promise<void> {
      const fallbacks = summary?.deltaExpiredFallbacks ?? 0;
      await deps.store.collections.connections().updateOne(
        { connectionId },
        {
          $set: {
            status: status === 'complete' ? 'connected' : 'error',
            lastSyncStatus: status,
            lastSyncAt: new Date(),
            // Recorded on EVERY finalize, including zero — "this sync did
            // not re-enumerate" is a fact the completion screen needs as
            // much as the opposite, and a field that only appears when it is
            // true reads as missing data on every other run.
            lastSyncDeltaExpiredFallbacks: fallbacks,
            ...(deltaLink ? { deltaLink } : {}),
          },
        }
      );
    },
  };
}

export type ConnectionActivities = ReturnType<typeof createConnectionActivities>;
export type { DeltaPage, IngestSkipReason };
