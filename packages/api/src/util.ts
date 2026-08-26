// SPDX-License-Identifier: Apache-2.0
// Small shared helpers for the route modules. Everything here is pure or
// transport-trivial; anything with a policy opinion lives in the route that
// holds the opinion.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext, ShelfmarkPorts } from '@shelfmark/core';

/** The one collection every route touches: the per-tenant connection records.
 *  Re-exported from @shelfmark/core — the store package owns the name. */
export { CONNECTIONS_COLLECTION } from '@shelfmark/core';

/**
 * Resolve the caller through the host's AuthContextResolver port. `null`
 * means unauthenticated and the API layer answers 401 here, once, so no
 * route can forget to. The OAuth callback route is the ONE deliberate
 * exception and does not call this — see the carve-out comment on it.
 */
export async function requireAuth(
  ports: ShelfmarkPorts,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthContext | null> {
  const auth = await ports.resolveAuth(request);
  if (!auth) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return auth;
}

/**
 * Fastify's default query parser hands back an ARRAY when a key repeats
 * (`?folderId=a&folderId=b`). Everything downstream — a Graph path segment —
 * expects one string, so collapse to the first and let a blank be absent.
 */
export function firstString(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && single !== '' ? single : undefined;
}

/** Body-supplied identifiers are strings or they are absent — never coerced. */
export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * A selection-paths field is an array of non-empty strings or it is absent
 * (absent means "none", so {} is a valid keep-everything decision). null on
 * anything else — a number, a nested array, an empty-string path — so the
 * route can 400 by field name instead of coercing a malformed decision into
 * a quiet one.
 */
export function pathsArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') return null;
    out.push(entry);
  }
  return out;
}
