// SPDX-License-Identifier: Apache-2.0
// Connector access tokens: rotation persistence + a per-connection cache.
// `34-S07e`. Two defects, one of which is invisible until it is old.
//
// (a) ROTATION WAS DISCARDED. `refreshAccessToken` returns a refresh token,
//     and the browse route used to read `.accessToken` off it and throw the
//     rest away. Microsoft rotates the refresh token on the refresh grant and
//     may invalidate the previous one, so the copy sitting in
//     `encRefreshToken` was already dead — and nothing failed that day. The
//     symptom surfaces weeks later as an `invalid_grant` with no event
//     anywhere near it to explain why, which is the most expensive shape a
//     bug can have.
//
// (b) EVERY BROWSE PAID A FULL REFRESH ROUND TRIP. One picker click, one
//     token exchange against the identity provider. The Map phase walks
//     thousands of folders, so that multiplies into thousands of avoidable
//     round trips against a service that throttles — self-inflicted 429s
//     ahead of `34-S09b`'s retry policy even existing.
//
// The cache holds ACCESS tokens only, in memory, keyed by tenant AND
// connection. Refresh tokens are never cached in plaintext: they are
// decrypted, used, and dropped inside a single call.
import { decryptToken, encryptToken, type EncryptedToken } from '@shelfmark/core';

/**
 * Refresh early. An access token that expires mid-flight fails the request
 * that is holding it, so the cache stops serving one a minute before the
 * provider stops honouring it.
 */
const SAFETY_MARGIN_MS = 60_000;

/** Bounded so a long-lived process with many connections cannot grow without limit. */
const MAX_CACHE_ENTRIES = 1000;

/** Structurally compatible with @shelfmark/graph's GraphTokens — and with any
 *  future provider client that answers the same four fields. */
export interface ProviderTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes?: string[];
}

export interface ConnectionAccessToken {
  accessToken: string;
  /** Granted scopes, `[]` when the provider did not report them. */
  scopes: string[];
}

interface CacheEntry {
  accessToken: string;
  scopes: string[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ConnectionAccessToken>>();

/**
 * Tenant id is part of the key, not decoration. Connection ids are UUIDs and
 * the caller already loads them tenant-scoped, but keying on the pair makes a
 * cached token structurally unable to be served to another tenant even if a
 * future caller forgets that scoping.
 */
function cacheKey(tenantId: string, connectionId: string): string {
  return `${tenantId} ${connectionId}`;
}

function prune(): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // Still full of live entries: evict oldest-first (Map preserves insertion
  // order). Evicting a live token costs one refresh, never correctness.
  for (const key of cache.keys()) {
    if (cache.size < MAX_CACHE_ENTRIES) break;
    cache.delete(key);
  }
}

export interface ConnectionAccessTokenParams {
  tenantId: string;
  connectionId: string;
  encRefreshToken: EncryptedToken;
  /** The provider client's own `refreshAccessToken`. */
  refresh: (refreshToken: string) => Promise<ProviderTokens>;
  /** Persist a ROTATED refresh token. Called only when it actually changed. */
  persistRotatedRefreshToken: (encrypted: EncryptedToken) => Promise<void>;
  /** Told about a failed write-back so it can be logged loudly. See below. */
  onRotationPersistFailure?: (err: unknown) => void;
}

async function refreshAndCache(
  key: string,
  params: ConnectionAccessTokenParams
): Promise<ConnectionAccessToken> {
  const currentRefreshToken = decryptToken(params.encRefreshToken);
  const tokens = await params.refresh(currentRefreshToken);
  if (!tokens || typeof tokens.accessToken !== 'string' || tokens.accessToken === '') {
    throw new Error('Connector token refresh returned no access token');
  }

  const returned = typeof tokens.refreshToken === 'string' ? tokens.refreshToken : '';
  if (returned !== '' && returned !== currentRefreshToken) {
    try {
      await params.persistRotatedRefreshToken(encryptToken(returned));
    } catch (err) {
      // The provider has already invalidated the old token, so failing this
      // request would not save the connection — it is broken either way, and
      // the caller's read can still be served with the access token we hold.
      // What must NOT happen is silence: this is the exact moment a
      // connection starts dying, and it is the only moment it is cheap to
      // notice.
      params.onRotationPersistFailure?.(err);
    }
  }

  const expiresIn = Number(tokens.expiresIn);
  const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000;
  const usableUntil = Date.now() + lifetimeMs - SAFETY_MARGIN_MS;
  const scopes = Array.isArray(tokens.scopes)
    ? tokens.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];

  // A token whose remaining life is already inside the safety margin is used
  // once and not stored — caching it would only serve a value we have
  // ourselves declared unsafe.
  if (usableUntil > Date.now()) {
    prune();
    cache.set(key, { accessToken: tokens.accessToken, scopes, expiresAt: usableUntil });
  }
  return { accessToken: tokens.accessToken, scopes };
}

/**
 * An access token for one connection: cached when it is still good, refreshed
 * when it is not, with any rotated refresh token written back on the way past.
 */
export async function connectionAccessToken(
  params: ConnectionAccessTokenParams
): Promise<ConnectionAccessToken> {
  const key = cacheKey(params.tenantId, params.connectionId);

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return { accessToken: hit.accessToken, scopes: hit.scopes };
  }

  // Single-flight. A burst of concurrent browses against one connection
  // otherwise fires a refresh each — and on a provider that rotates, several
  // simultaneous rotations race to persist, with the losers writing a token
  // the provider has already retired.
  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = refreshAndCache(key, params);
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Drop a connection's cached token. Called when a connection is disconnected:
 * without this, a revoked connection keeps serving reads from cache until the
 * access token happens to expire.
 */
export function forgetConnectionTokens(tenantId: string, connectionId: string): void {
  const key = cacheKey(tenantId, connectionId);
  cache.delete(key);
  inFlight.delete(key);
}

export const __testing = {
  SAFETY_MARGIN_MS,
  MAX_CACHE_ENTRIES,
  reset(): void {
    cache.clear();
    inFlight.clear();
  },
  cacheSize(): number {
    return cache.size;
  },
};
