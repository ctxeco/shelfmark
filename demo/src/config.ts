// SPDX-License-Identifier: Apache-2.0
//
// Demo configuration — every knob the two processes (server, worker) read,
// resolved in ONE place, failing fast with named errors. The library's own
// fail-fast rules (publicBaseUrl and stateSecret in @shelfmark/api,
// CONNECTOR_TOKEN_ENCRYPTION_KEY in @shelfmark/core, MS client credentials
// in @shelfmark/graph) would each surface eventually; checking them here
// means a misconfigured demo dies at boot with the exact env var named,
// not at the first OAuth round trip.
import path from 'node:path';
import {
  DEFAULT_LABEL_POLICY,
  DEFAULT_TENANT_POLICY,
  LabelRefusedError,
  type AuthContext,
  type DocumentSink,
  type LabelPolicy,
  type ShelfmarkPorts,
} from '@shelfmark/core';
import { FsDocumentSink } from './sinks/fsSink.js';
import { s3SinkFromEnv } from './sinks/s3Sink.js';

/** Named error class so a boot failure is grep-ably a CONFIG failure. */
export class DemoConfigError extends Error {
  override name = 'DemoConfigError';
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new DemoConfigError(`Missing required env var ${name} — ${hint} (see demo/.env.example)`);
  }
  return value;
}

export interface DemoLabel {
  id: string;
  label: string;
}

export interface DemoConfig {
  publicBaseUrl: string;
  stateSecret: string;
  mongodbUri: string;
  mongoDbName: string;
  temporalAddress: string;
  taskQueue: string;
  port: number;
  dataDir: string;
  /** DEMO_DEFER_OVER_MB, converted to bytes; null = never defer. */
  deferOverBytes: number | null;
  /** DEMO_LABELS (JSON); empty = hidden-label policy (the default). */
  labels: DemoLabel[];
  sinkKind: 'fs' | 's3';
}

export function loadDemoConfig(): DemoConfig {
  const publicBaseUrl = requireEnv(
    'PUBLIC_BASE_URL',
    'builds the OAuth redirect URIs; deliberately no default'
  ).replace(/\/$/, '');
  const stateSecret = requireEnv(
    'CONNECTOR_OAUTH_STATE_SECRET',
    'signs the OAuth state JWT; >= 32 bytes, e.g. `openssl rand -base64 48`'
  );
  // Read at module load inside @shelfmark/graph — validated here so the
  // failure is at boot with a name, not mid-OAuth with a 500.
  requireEnv('CONNECTOR_MS_CLIENT_ID', 'the Entra app registration client id');
  requireEnv('CONNECTOR_MS_CLIENT_SECRET', 'the Entra app registration client secret value');
  const dek = requireEnv(
    'CONNECTOR_TOKEN_ENCRYPTION_KEY',
    'AES-256-GCM key for refresh tokens at rest; `openssl rand -base64 32`'
  );
  if (Buffer.from(dek, 'base64').length !== 32) {
    throw new DemoConfigError(
      'CONNECTOR_TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes — generate with `openssl rand -base64 32`'
    );
  }

  const deferOverMb = process.env.DEMO_DEFER_OVER_MB?.trim();
  let deferOverBytes: number | null = null;
  if (deferOverMb) {
    const mb = Number(deferOverMb);
    if (!Number.isFinite(mb) || mb < 0) {
      throw new DemoConfigError(`DEMO_DEFER_OVER_MB must be a non-negative number, got '${deferOverMb}'`);
    }
    deferOverBytes = Math.round(mb * 1024 * 1024);
  }

  const sinkKindRaw = process.env.DEMO_SINK?.trim() || 'fs';
  if (sinkKindRaw !== 'fs' && sinkKindRaw !== 's3') {
    throw new DemoConfigError(`DEMO_SINK must be 'fs' (default) or 's3', got '${sinkKindRaw}'`);
  }

  return {
    publicBaseUrl,
    stateSecret,
    mongodbUri: process.env.MONGODB_URI?.trim() || 'mongodb://localhost:27017',
    mongoDbName: process.env.MONGODB_DB?.trim() || 'shelfmark',
    temporalAddress: process.env.TEMPORAL_ADDRESS?.trim() || 'localhost:7233',
    taskQueue: 'shelfmark-queue',
    port: Number(process.env.PORT?.trim() || 8787),
    dataDir: path.resolve(process.env.DEMO_DATA_DIR?.trim() || './data'),
    deferOverBytes,
    labels: parseDemoLabels(process.env.DEMO_LABELS),
    sinkKind: sinkKindRaw,
  };
}

/**
 * DEMO_LABELS: a JSON array of { id, label } pairs, e.g.
 *   DEMO_LABELS=[{"id":"internal","label":"Internal"},{"id":"public","label":"Public"}]
 * Absent → [] → the default hidden-label policy: every label control in the
 * UI disappears and the server-side LabelPolicy default applies.
 */
export function parseDemoLabels(raw: string | undefined): DemoLabel[] {
  const text = raw?.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new DemoConfigError(`DEMO_LABELS is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new DemoConfigError('DEMO_LABELS must be a JSON array of {id, label} objects');
  }
  return parsed.map((entry, i) => {
    const e = entry as { id?: unknown; label?: unknown };
    if (typeof e?.id !== 'string' || !e.id || typeof e?.label !== 'string' || !e.label) {
      throw new DemoConfigError(`DEMO_LABELS[${i}] must be an object with string 'id' and 'label'`);
    }
    return { id: e.id, label: e.label };
  });
}

/**
 * A static LabelPolicy over the DEMO_LABELS vocabulary: offer the list,
 * default to the first entry when the reader picked nothing, refuse (typed)
 * anything outside the list. A production host caps rather than refuses when
 * its policy says so — see the LabelPolicy contract in @shelfmark/core.
 */
export function staticLabelPolicy(labels: DemoLabel[]): LabelPolicy {
  const ids = labels.map((l) => l.id);
  return {
    labels() {
      return labels.map((l) => ({ id: l.id }));
    },
    resolve(requested: string | undefined) {
      if (requested === undefined) return ids[0] ?? 'default';
      if (!ids.includes(requested)) throw new LabelRefusedError(requested);
      return requested;
    },
  };
}

/**
 * The demo's wiring of the five ports (@shelfmark/core ports.ts). Both
 * processes call this so the server's API surface and the worker's
 * activities agree on policy and sink.
 */
export function buildPorts(config: DemoConfig): ShelfmarkPorts {
  return {
    // THE boundary: bytes cross accept() and everything after — storage,
    // parsing, indexing — is sink business. DEMO_SINK=s3 swaps in the
    // S3-compatible reference sink; the default builds the local corpus.
    sink: buildSink(config),

    // Single-tenant demo resolver: every request is tenant 'demo', actor
    // 'demo-user'. This is the ONE deliberate shortcut of the demo — a
    // production host resolves a VERIFIED credential (e.g. a JWT its
    // gateway validated) into { tenantId, sub } per the AuthContextResolver
    // contract in @shelfmark/core's ports.ts, returning null for anything
    // unauthenticated so the API answers 401. The OAuth callback carve-out
    // (docs/SETUP.md §6) is already handled inside @shelfmark/api.
    resolveAuth: async () => {
      const ctx: AuthContext = { tenantId: 'demo', sub: 'demo-user', upn: 'demo-user@demo.example' };
      return ctx;
    },

    // Everything enabled, mapping included — the defaults exported by core.
    tenantPolicy: DEFAULT_TENANT_POLICY,

    // DEMO_LABELS present → a static vocabulary; absent → the default
    // hidden-label policy (labels()=[] hides every label control).
    labelPolicy: config.labels.length > 0 ? staticLabelPolicy(config.labels) : DEFAULT_LABEL_POLICY,

    // No egress gate: ABSENT means allow, by contract. The contract worth
    // restating here (ports.ts): a gate that IS configured but throws must
    // be treated as a retryable outage — the run pauses; it never proceeds
    // as if allowed. A missing gate is a decision; a broken gate is an
    // outage. The demo makes the decision.
    egressGate: undefined,
  };
}

function buildSink(config: DemoConfig): DocumentSink {
  if (config.sinkKind === 's3') {
    return s3SinkFromEnv({ deferOverBytes: config.deferOverBytes });
  }
  return new FsDocumentSink({ dataDir: config.dataDir, deferOverBytes: config.deferOverBytes });
}
