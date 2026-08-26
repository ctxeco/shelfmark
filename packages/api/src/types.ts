// SPDX-License-Identifier: Apache-2.0
// Plugin option and route-context types for @shelfmark/api.
import type { Db } from 'mongodb';
import type {
  ConsentStore,
  DisclosureRegistry,
  LabelPolicy,
  ShelfmarkPorts,
  TenantPolicy,
} from '@shelfmark/core';
import type { WorkflowStartClient, WorkflowStarters } from './workflowStarters.js';

/**
 * Knobs for the map narration SSE stream. Numbers, sanitized at register: a
 * host that reads these from an env var can hand over `Number('15s')` — NaN —
 * and every `elapsed >= NaN` compare is false, which would silently turn
 * heartbeats OFF and proxy-cut exactly the long quiet walks the heartbeat
 * exists to keep alive. So non-finite/negative values fall back to the
 * defaults. But 0 stays 0 for `heartbeatMs`: '0' means always-due, which
 * tests use for determinism — a `|| default` idiom (which eats 0) is wrong
 * here.
 */
export interface MapStreamConfig {
  /** Poll cadence against the run document. Default 700ms — the narration
   *  engine's minimum per-line pace, so the stream runs at reading speed. */
  pollMs?: number;
  /** Idle threshold before an SSE comment heartbeat. Default 15000. */
  heartbeatMs?: number;
  /** How long a stream opened before the workflow's first write waits for a
   *  run doc before 404-framing and closing. Default 5000. */
  noRunTimeoutMs?: number;
}

export interface ShelfmarkApiConfig {
  /**
   * REQUIRED — the externally reachable base URL of this deployment
   * (scheme + host, no trailing slash needed). It builds the OAuth redirect
   * URIs, so a wrong default is a live OAuth misconfiguration: the provider
   * would redirect the user's authorization code somewhere that is not this
   * server. There is deliberately NO fallback; the plugin throws at register
   * without it.
   */
  publicBaseUrl: string;
  /**
   * REQUIRED — HMAC secret for the signed OAuth state JWT (HS256). At least
   * 32 bytes, enforced at register: HS256's security floor is the key size,
   * and a short secret silently weakens the only thing authenticating the
   * anonymous callback.
   */
  stateSecret: string;
  /** Where the callback redirects the human afterwards. Default '/connectors'. */
  returnPath?: string;
  /**
   * The pinned disclosure set the consent routes serve and verify against.
   * Defaults to @shelfmark/core's vendored artifact; a host that owns its own
   * canonical consent tree supplies its own registry, and every semantic —
   * including the 409 SHA-mismatch refusal — applies to that host's bytes.
   */
  disclosureRegistry?: DisclosureRegistry;
  mapStream?: MapStreamConfig;
}

export interface ShelfmarkApiOptions {
  /** The database holding the connector-private collections. */
  db: Db;
  /** The five host seams. Only resolveAuth is strictly required here. */
  ports: ShelfmarkPorts;
  /** The durable-execution client and the task queue the workers listen on. */
  temporal: { client: WorkflowStartClient; taskQueue: string };
  config: ShelfmarkApiConfig;
}

/** Everything a route module needs, resolved once at register. */
export interface RouteContext {
  db: Db;
  ports: ShelfmarkPorts;
  tenantPolicy: TenantPolicy;
  labelPolicy: LabelPolicy;
  consents: ConsentStore;
  registry: DisclosureRegistry;
  starters: WorkflowStarters;
  /** Trailing slash stripped. */
  publicBaseUrl: string;
  returnPath: string;
  /** The mounted path of the Microsoft OAuth callback (prefix included). */
  callbackPath: string;
  /** The HS256 key bytes for the state JWT. */
  stateKey: Uint8Array;
  mapStream: Required<MapStreamConfig>;
}
