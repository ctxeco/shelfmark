// SPDX-License-Identifier: Apache-2.0
// Provider HTTP error details — shared by the Microsoft Graph and Google
// Drive connector clients (Plan 34 `34-S09c`).
//
// WHAT THIS EXISTS TO STOP. Both clients used to collapse every axios failure
// into `new XError(\`...: ${(err as Error).message}\`)`, which threw away
// `response.status`. A 429, a 404 and a 500 all arrived at the call site as
// the same opaque string, so no caller could implement a throttle-aware retry
// (`34-S09b`, another repo) or tell "you were never granted that scope" from
// "that folder is gone" (`34-S06d`) — the latter cost a real debugging round
// trip on 2026-08-14.
//
// This module makes the failure LEGIBLE. It deliberately does NOT retry,
// back off, or sleep: retry policy is `34-S09b`'s and lives with the workflow
// that can actually be resumed, not inside a request-scoped HTTP client.

export interface ProviderHttpErrorDetails {
  /** HTTP status the provider answered with, or null if the call never got one. */
  status: number | null;
  /** Parsed `Retry-After`, in seconds. null when absent or unparseable. */
  retryAfterSeconds: number | null;
  /** The provider's own error identifier, e.g. Graph `itemNotFound`, Google `userRateLimitExceeded`. */
  providerErrorCode: string | null;
}

/**
 * RFC 9110 `Retry-After`: either delta-seconds or an HTTP-date. Both are
 * normalised to whole seconds from now; an HTTP-date already in the past
 * clamps to 0 rather than going negative, because a negative wait is not a
 * thing a caller can act on.
 */
export function parseRetryAfter(raw: unknown, nowMs: number = Date.now()): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** Case-insensitive header read that works for both plain objects and axios's AxiosHeaders. */
function readHeader(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== 'object') return undefined;
  const bag = headers as Record<string, unknown> & { get?: (n: string) => unknown };
  if (typeof bag.get === 'function') {
    const viaGetter = bag.get(name);
    if (viaGetter !== undefined && viaGetter !== null) return viaGetter;
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(bag)) {
    if (key.toLowerCase() === wanted) return bag[key];
  }
  return undefined;
}

/**
 * The provider's own error identifier, across the three shapes we actually
 * receive:
 *   Graph          `{ error: { code: 'itemNotFound', message } }`
 *   Google Drive   `{ error: { code: 403, status: 'PERMISSION_DENIED',
 *                              errors: [{ reason: 'userRateLimitExceeded' }] } }`
 *   OAuth token    `{ error: 'invalid_grant', error_description }`
 *
 * Google's `error.code` is a NUMBER (the HTTP status again), so the string
 * guard is load-bearing — without it this would return "403" and shadow the
 * genuinely useful `PERMISSION_DENIED`/`userRateLimitExceeded`.
 */
function extractProviderErrorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const error = (data as Record<string, unknown>).error;
  if (typeof error === 'string') {
    return error.trim() === '' ? null : error;
  }
  if (!error || typeof error !== 'object') return null;
  const bag = error as Record<string, unknown>;
  if (typeof bag.code === 'string' && bag.code.trim() !== '') return bag.code;
  if (typeof bag.status === 'string' && bag.status.trim() !== '') return bag.status;
  const first = Array.isArray(bag.errors) ? bag.errors[0] : null;
  if (first && typeof first === 'object') {
    const reason = (first as Record<string, unknown>).reason;
    if (typeof reason === 'string' && reason.trim() !== '') return reason;
  }
  return null;
}

/**
 * Pull whatever the transport actually told us out of a thrown error. A
 * network-level failure (DNS, connect timeout) legitimately has no status —
 * that is `null`, meaning "we never got an answer", never `0` or `500`.
 */
export function extractHttpErrorDetails(
  err: unknown,
  nowMs: number = Date.now()
): ProviderHttpErrorDetails {
  const response = (err as { response?: unknown } | null | undefined)?.response;
  if (!response || typeof response !== 'object') {
    return { status: null, retryAfterSeconds: null, providerErrorCode: null };
  }
  const bag = response as Record<string, unknown>;
  const rawStatus = bag.status;
  const status = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : null;
  return {
    status,
    retryAfterSeconds: parseRetryAfter(readHeader(bag.headers, 'retry-after'), nowMs),
    providerErrorCode: extractProviderErrorCode(bag.data),
  };
}
