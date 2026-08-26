// SPDX-License-Identifier: Apache-2.0
//
// The ports — the five seams where a host system plugs into shelfmark.
//
// Design rule: shelfmark owns the walk, the consent ledger, the selection
// algebra and the run records; the HOST owns identity, authorization policy,
// tenancy switches, sensitivity labels, and — decisively — what happens to a
// file's bytes after download. Every coupling the source platform had
// (a signed-context token, a policy sidecar, a clearance ladder, a RAG
// pipeline) maps onto exactly one interface here, which is what makes the
// library consumable without inheriting any of those decisions.

/** Identity of the human driving a request. */
export interface AuthContext {
  /** Tenant/workspace id. Scopes every query and every stored record. */
  tenantId: string;
  /** Stable subject id — the consent actor recorded on every grant. */
  sub: string;
  /** Display identity (e.g. UPN), shown in consent receipts. */
  upn?: string;
  /** The actor's own opaque sensitivity label, if the host has such a notion. */
  label?: string;
}

/**
 * Host resolves this per-request; `null` means unauthenticated (the API layer
 * answers 401). The OAuth callback routes are the one deliberate exception —
 * they arrive tokenless from the provider and authenticate via the signed
 * state JWT instead; any gateway in front must allowlist exactly those paths.
 */
export type AuthContextResolver = (req: {
  headers: Record<string, string | string[] | undefined>;
}) => Promise<AuthContext | null>;

/** Per-tenant feature switches. */
export interface TenantFlags {
  /** Master switch for the connector surface. Default-on posture. */
  connectorsEnabled: boolean;
  /** Switch for metadata mapping. Deliberately default-OFF, opt-in:
   *  a map sends names and counts outward, so it is consented AND enabled. */
  mappingEnabled: boolean;
  /** Optional default label applied to ingested documents. */
  defaultLabel?: string;
}

export interface TenantPolicy {
  flags(tenantId: string): Promise<TenantFlags>;
}

/**
 * Opaque sensitivity labels. The source platform's export-control clearance
 * ladder generalizes to: an ordered list the UI can offer, plus a resolve()
 * hook that may CAP a requested label (never raise it) or refuse outright.
 */
export interface LabelPolicy {
  /** Ordered list for pickers. Empty array → label UI is hidden entirely. */
  labels(): readonly { id: string; nameKey?: string }[];
  /**
   * Effective label for content ingested under `ctx`. May return a different
   * (capped) label than requested. Throw LabelRefusedError to refuse.
   */
  resolve(requested: string | undefined, ctx: AuthContext): string;
}

export class LabelRefusedError extends Error {
  constructor(
    readonly requested: string | undefined,
    message?: string
  ) {
    super(message ?? `label refused: ${requested ?? '(none)'}`);
    this.name = 'LabelRefusedError';
  }
}

/**
 * Optional egress control, consulted before any network-reaching phase.
 * Absent from config → allow (no-op default).
 *
 * FAIL-CLOSED CONTRACT: if a CONFIGURED gate throws (unreachable, timeout),
 * callers convert that into a retryable typed failure — the run pauses and
 * retries; it never proceeds as if allowed. A missing gate is a decision;
 * a broken gate is an outage.
 *
 * The two checks are deliberately different questions (a lesson paid for in
 * production): a MAP opens no documents, so it must never be asked "what is
 * this document's label" — the right question is the tenant-level one.
 */
export interface EgressGate {
  /** May this tenant's content (at this label) leave for cloud processing? */
  checkCloudEgress(q: { tenantId: string; label: string }): Promise<EgressDecision>;
  /** May this tenant run a metadata map at all? */
  checkMapEgress(q: { tenantId: string }): Promise<EgressDecision>;
}

export type EgressDecision = { allowed: true } | { allowed: false; reason: string };

/** Skip vocabulary for files the connector never hands to the sink. */
export type IngestSkipReason =
  | 'already_ingested'
  | 'too_large'
  | 'unsupported_type'
  | 'deferred';

/**
 * THE handoff boundary. Connector territory ends when bytes cross accept().
 *
 * The connector keeps everything that protects its own bandwidth and the
 * honesty of its ledger: download, pre-ingest filters, the post-download size
 * ceiling. Everything after bytes-in-hand — object storage, parsing,
 * indexing, whatever the host's pipeline does — is the sink's business.
 * The demo ships a filesystem sink that builds a searchable local corpus;
 * the source platform's RAG pipeline is exactly one implementation of this
 * interface.
 */
export interface DocumentSink {
  accept(meta: DocumentMeta, content: Buffer): Promise<SinkOutcome>;
}

export interface DocumentMeta {
  /** Connector-generated, STABLE across retries of the same file. */
  documentId: string;
  tenantId: string;
  connectionId: string;
  runId: string;
  filename: string;
  /** The connector's guess; the sink may sniff for itself. */
  mimetype: string;
  size: number;
  /** Real remote folder path — provenance, not storage layout. */
  remotePath: string;
  /** Provider item id — the dedupe key. A sink seeing a repeated
   *  (connectionId, remoteFileId) with isRetry MUST update, not duplicate. */
  remoteFileId: string;
  /** Already resolved through LabelPolicy before the sink sees it. */
  label: string;
  isRetry: boolean;
}

export type SinkOutcome =
  | { status: 'ingested' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; skipReason: string; error?: string }
  /** Sink declines FOR NOW (quota, budget, backpressure). The run records it,
   *  the ledger shows it, and the retry pass re-submits with isRetry. */
  | { status: 'deferred'; reason: string };

/** Everything a host wires together to run shelfmark. */
export interface ShelfmarkPorts {
  sink: DocumentSink;
  resolveAuth: AuthContextResolver;
  /** Default: everything enabled, no default label. */
  tenantPolicy?: TenantPolicy;
  /** Default: labels()=[] (label UI hidden), resolve()='default'. */
  labelPolicy?: LabelPolicy;
  /** Default: allow. See the fail-closed contract above. */
  egressGate?: EgressGate;
}

/** The no-op defaults, exported so hosts and tests can compose from them. */
export const DEFAULT_TENANT_POLICY: TenantPolicy = {
  async flags() {
    return { connectorsEnabled: true, mappingEnabled: true };
  },
};

export const DEFAULT_LABEL_POLICY: LabelPolicy = {
  labels() {
    return [];
  },
  resolve(requested) {
    return requested ?? 'default';
  },
};

export const ALLOW_ALL_EGRESS: EgressGate = {
  async checkCloudEgress() {
    return { allowed: true };
  },
  async checkMapEgress() {
    return { allowed: true };
  },
};
