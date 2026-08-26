// SPDX-License-Identifier: Apache-2.0
// Graph error taxonomy — ONE class hierarchy for every failure this package
// throws, merged from what were two parallel Graph clients (an interactive
// browse client and a background walk client) that had each grown half of it.
//
// `34-S09c`: a failure that came off the wire carries the status it arrived
// with, instead of being flattened into a sentence. `34-S09b`: the
// Retry-After header survives too, so a caller can implement a
// throttle-aware retry. This module still deliberately does NOT retry, back
// off, or sleep: retry policy lives with the caller that can actually be
// resumed, not inside a request-scoped HTTP client.
import { extractHttpErrorDetails } from './httpError.js';

/** The delegated scopes any drive/site listing needs — either one suffices. */
export const GRAPH_DRIVE_SCOPES = ['Files.Read.All', 'Sites.Read.All'];

export interface GraphConnectorErrorDetails {
  status?: number | null;
  retryAfterSeconds?: number | null;
  providerErrorCode?: string | null;
  /** True only when the token's OWN granted scopes prove this was a permission answer. */
  scopeMissing?: boolean;
}

/**
 * `34-S09c`. The second constructor argument is optional, so a plain
 * `new GraphConnectorError('...')` call site keeps working unchanged — but a
 * failure that came off the wire now carries the status it arrived with,
 * instead of being flattened into a sentence.
 */
export class GraphConnectorError extends Error {
  /** HTTP status from Graph, or null when the request never reached it. */
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly providerErrorCode: string | null;
  readonly scopeMissing: boolean;

  constructor(message: string, details: GraphConnectorErrorDetails = {}) {
    super(message);
    this.name = 'GraphConnectorError';
    this.status = details.status ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.providerErrorCode = details.providerErrorCode ?? null;
    this.scopeMissing = details.scopeMissing === true;
  }

  /** The whole point of preserving status: a caller can finally see a throttle. */
  get isThrottled(): boolean {
    return this.status === 429;
  }
}

/**
 * `34-S09b` — a GraphConnectorError raised by an actual HTTP exchange (or the
 * attempt at one). It EXTENDS rather than replaces the base class, so any
 * generic `instanceof GraphConnectorError` handling keeps working; what the
 * subclass adds is the guarantee of provenance — this error came off the
 * wire, with whatever status/Retry-After the wire supplied. Since the merge
 * (`34-S09c`, completed in this package) EVERY HTTP path throws it:
 * listing, delta, token requests, and file download alike.
 */
export class GraphHttpError extends GraphConnectorError {
  constructor(message: string, details: GraphConnectorErrorDetails = {}) {
    super(message, details);
    this.name = 'GraphHttpError';
  }
}

/**
 * Graph reports granted scopes fully qualified
 * (`https://graph.microsoft.com/Files.Read.All`), so compare on the last path
 * segment, case-insensitively.
 */
function normalizeScope(scope: string): string {
  return (scope.trim().split('/').pop() || '').toLowerCase();
}

export function grantedIncludesAny(granted: string[] | undefined, required: string[]): boolean {
  if (!granted || granted.length === 0) return false;
  const held = new Set(granted.map(normalizeScope));
  return required.some((scope) => held.has(normalizeScope(scope)));
}

/** Statuses Graph can answer with when a delegated scope was never granted. */
const SCOPE_AMBIGUOUS_STATUSES = new Set([401, 403, 404]);

export interface GraphScopeContext {
  grantedScopes?: string[];
  requiredScopes?: string[];
}

/**
 * Wrap a transport-level failure, preserving status + Retry-After (blank or
 * absent header reads as null — never as "retry now"; see httpError.ts).
 *
 * `34-S06d` / `34-S09c`. Graph answers **404, not 403**, when a delegated
 * scope is absent, so the status alone cannot separate "you may not" from
 * "it is not there" — which is exactly the confusion that burned a debugging
 * round trip on 2026-08-14.
 *
 * The token's own granted-scope list can separate them. When the caller
 * supplies it and the scope this call requires is simply not in it, the 404
 * is a permission answer wearing a not-found costume and gets labelled as
 * one. When the caller supplies no scope list we say nothing rather than
 * guess: `scopeMissing` stays false, and a false negative here is a missing
 * hint, whereas a false positive would send someone to re-consent a
 * connection that was fine.
 */
export function toGraphHttpError(
  prefix: string,
  err: unknown,
  options: GraphScopeContext = {}
): GraphConnectorError {
  if (err instanceof GraphConnectorError) return err;
  const details = extractHttpErrorDetails(err);
  const required = options.requiredScopes ?? [];
  const scopeMissing =
    required.length > 0 &&
    details.status !== null &&
    SCOPE_AMBIGUOUS_STATUSES.has(details.status) &&
    !!options.grantedScopes &&
    options.grantedScopes.length > 0 &&
    !grantedIncludesAny(options.grantedScopes, required);

  const statusSuffix = details.status !== null ? ` (HTTP ${details.status})` : '';
  const explanation = scopeMissing
    ? ` — the access token does not carry ${required.join(' or ')}, so this is a missing-permission` +
      ' answer rather than a missing item; the connection has to be reconnected to re-consent'
    : '';
  return new GraphHttpError(`${prefix}: ${(err as Error).message}${statusSuffix}${explanation}`, {
    ...details,
    scopeMissing,
  });
}
