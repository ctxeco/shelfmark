// SPDX-License-Identifier: Apache-2.0
// The @shelfmark/api Fastify plugin — one register call wires the whole HTTP
// surface: connections + OAuth, browse, map (+ SSE narration stream), the
// Decide flow, selective ingest, and the consent routes.
//
// Wrapped with fastify-plugin for the name/version metadata, but with
// `encapsulate: true` — the routes live in their own context so a host's
// `prefix` applies normally and nothing here leaks decorators onto the root
// instance. A host's root-level auth hook still propagates INTO this context
// (root hooks reach every child plugin), which is what the consent routes'
// coverage argument relies on; see routes/consents.ts.
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_LABEL_POLICY,
  DEFAULT_TENANT_POLICY,
  createConsentStore,
  defaultDisclosureRegistry,
} from '@shelfmark/core';
import { createWorkflowStarters } from './workflowStarters.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerBrowseRoutes } from './routes/browse.js';
import { registerMapRoutes } from './routes/map.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerConsentRoutes } from './routes/consents.js';
import type { RouteContext, ShelfmarkApiOptions } from './types.js';

/** Minimum HS256 key size for the OAuth state secret, in bytes. */
const MIN_STATE_SECRET_BYTES = 32;

function sanitizePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 0 is a meaningful value here (always-due heartbeats), so only
 *  non-finite/negative values fall back — `|| fallback` would eat the 0. */
function sanitizeNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function shelfmarkApiPlugin(
  fastify: FastifyInstance,
  options: ShelfmarkApiOptions
): Promise<void> {
  const { db, ports, temporal, config } = options;

  if (!db) throw new Error('@shelfmark/api requires options.db (a connected mongodb Db)');
  if (!ports || typeof ports.resolveAuth !== 'function') {
    throw new Error('@shelfmark/api requires options.ports.resolveAuth (the AuthContextResolver port)');
  }
  if (!temporal || !temporal.client || !temporal.taskQueue) {
    throw new Error('@shelfmark/api requires options.temporal ({ client, taskQueue })');
  }
  if (!config || typeof config.publicBaseUrl !== 'string' || config.publicBaseUrl === '') {
    // FAIL FAST, no default. This value builds the OAuth redirect URIs: a
    // hardcoded fallback here is a LIVE misconfiguration — the identity
    // provider would redirect authorization codes to whatever host the
    // default names, and the failure would surface as a broken OAuth round
    // trip on someone else's domain, not as an error anywhere near the
    // actual mistake.
    throw new Error(
      '@shelfmark/api requires options.config.publicBaseUrl — it builds the OAuth redirect URIs and has deliberately no default'
    );
  }
  if (typeof config.stateSecret !== 'string' || config.stateSecret === '') {
    throw new Error('@shelfmark/api requires options.config.stateSecret');
  }
  const stateKey = new TextEncoder().encode(config.stateSecret);
  if (stateKey.length < MIN_STATE_SECRET_BYTES) {
    // HS256's security floor is the key size; a short secret silently
    // weakens the only thing authenticating the anonymous OAuth callback.
    throw new Error(
      `@shelfmark/api: config.stateSecret must be at least ${MIN_STATE_SECRET_BYTES} bytes`
    );
  }

  const registry = config.disclosureRegistry ?? defaultDisclosureRegistry;
  const ctx: RouteContext = {
    db,
    ports,
    tenantPolicy: ports.tenantPolicy ?? DEFAULT_TENANT_POLICY,
    labelPolicy: ports.labelPolicy ?? DEFAULT_LABEL_POLICY,
    consents: createConsentStore(db, { registry }),
    registry,
    starters: createWorkflowStarters(temporal.client, temporal.taskQueue),
    publicBaseUrl: config.publicBaseUrl.replace(/\/$/, ''),
    returnPath: config.returnPath ?? '/connectors',
    // The mounted prefix rides into the redirect URI, so the registered
    // callback route and the URI handed to the identity provider cannot
    // drift apart.
    callbackPath: `${fastify.prefix}/microsoft/callback`,
    stateKey,
    mapStream: {
      pollMs: sanitizePositive(config.mapStream?.pollMs, 700),
      heartbeatMs: sanitizeNonNegative(config.mapStream?.heartbeatMs, 15_000),
      noRunTimeoutMs: sanitizePositive(config.mapStream?.noRunTimeoutMs, 5_000),
    },
  };

  await registerConnectionRoutes(fastify, ctx);
  await registerBrowseRoutes(fastify, ctx);
  await registerMapRoutes(fastify, ctx);
  await registerIngestRoutes(fastify, ctx);
  await registerConsentRoutes(fastify, ctx);
}

export const shelfmarkApi = fp<ShelfmarkApiOptions>(shelfmarkApiPlugin, {
  name: '@shelfmark/api',
  fastify: '5.x',
  encapsulate: true,
});

export default shelfmarkApi;
