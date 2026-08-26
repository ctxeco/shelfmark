// SPDX-License-Identifier: Apache-2.0
// 34-S09b — activities for driveMapWorkflow: the metadata-only map of a
// customer's drive.
//
// ══ WHAT THIS MODULE NEVER DOES ═════════════════════════════════════════════
//
// Read a file's CONTENT. The map is a walk over names, sizes, and folder
// facets; the one provider call in here is @shelfmark/graph's listFolderPage
// (children metadata, $select'd fields only). The workflow suite scans this
// module's source the way the reference walker's suite AST-scans for content
// endpoints — a content or network endpoint cannot appear here silently.
//
// ══ CONSENT, FAIL CLOSED ════════════════════════════════════════════════════
//
// verifyMapConsent runs before the first provider call, and a connection
// with no ACTIVE `map_metadata` consent finalizes 'refused_no_consent'
// without one Graph request. "Active" is DERIVED from the append-only event
// stream exactly as @shelfmark/core's consent store derives it — a grant is
// live until some revocation event names its consentId. There is no status
// field to read; the derivation IS the check. JRN-8: the check now also
// returns the grant's TARGET and EXCLUSIONS, and the workflow bounds the
// walk by them — a consent record whose scope the walk ignores is a record,
// not a consent.
//
// ══ THE STORE ONLY, IN THIS MODULE ══════════════════════════════════════════
//
// Every read and write goes through the injected store and is tenant-scoped:
// tenantId is in the filter, not just the document.
import { ApplicationFailure } from '@temporalio/activity';
import {
  MAX_EXCLUSIONS,
  type ConsentScopeTargetRecord,
  type MapCandidateDoc,
  type MapRunStatus,
  type MapSuggestionRow,
} from '@shelfmark/core';
import { GraphHttpError, listFolderPage } from '@shelfmark/graph';
import {
  MACHINE_GENERATED,
  compareCodepoints,
  evaluateFunnel,
  loadArtifactClasses,
  loadFunnelPolicy,
  type WalkRecord,
} from '@shelfmark/policy';
import type { ShelfmarkWorkflowDeps } from '../deps';
import { getConnectionDoc, getGraphAccessTokenFor, requireActiveConnection } from './connection';

/** The consent scope the map requires — @shelfmark/core's ConsentScope
 *  'map_metadata'. Names and counts leave the workspace under this scope;
 *  file contents never do. */
export const MAP_CONSENT_SCOPE = 'map_metadata';
/** ApplicationFailure type for a Graph 429 — retryable, with nextRetryDelay
 *  carrying Graph's own Retry-After so Temporal waits what Graph asked. */
export const GRAPH_THROTTLED_ERROR_TYPE = 'GraphThrottled';

// ── Consent verification ────────────────────────────────────────────────────

/** The subset of a connector_consents event this module reads. */
export interface ConsentEventDoc {
  consentId: string;
  action: 'granted' | 'revoked';
  revokesConsentId: string | null;
  scope: string;
  disclosureSha256?: string;
  /** JRN-8 — the grant's scope: which subtree, and which carve-outs. */
  target?: { folderId?: string | null; folderPath?: string | null } | null;
  exclusions?: string[];
}

export interface MapConsentCheck {
  active: boolean;
  /** Evidence carried into the map_runs doc: WHICH grant authorized the run. */
  consentId: string | null;
  disclosureSha256: string | null;
  /** JRN-8 — the grant's target. `null` folderId (or a null target on a
   *  legacy event) means the whole drive was consented. */
  target: ConsentScopeTargetRecord | null;
  /** JRN-8 — the grant's recorded exclusions, verbatim. The workflow prunes
   *  matching subtrees AT THE BOUNDARY and records every prune. */
  exclusions: string[];
}

/**
 * Pure port of the consent store's activeConsents derivation, parametric on
 * the scope: a grant is active unless ANY revocation event names its
 * consentId (time ordering is irrelevant to the derivation — the stream is
 * append-only). Exported separately from the activities so the semantics are
 * unit-testable without Mongo: two implementations of one rule set must not
 * diverge silently. The ingest-consent check (selectiveIngest.ts) derives
 * through THIS function with its own scope — one derivation, two scopes,
 * zero drift.
 */
export function deriveActiveConsentForScope(
  events: ConsentEventDoc[],
  scope: string
): ConsentEventDoc | null {
  const revoked = new Set(
    events
      .filter((e) => e.action === 'revoked' && e.revokesConsentId)
      .map((e) => e.revokesConsentId as string)
  );
  return (
    events.find((e) => e.action === 'granted' && e.scope === scope && !revoked.has(e.consentId)) ??
    null
  );
}

/** The map-scope derivation, unchanged in behaviour since 34-S09b. */
export function deriveActiveMapConsent(events: ConsentEventDoc[]): ConsentEventDoc | null {
  return deriveActiveConsentForScope(events, MAP_CONSENT_SCOPE);
}

/** JRN-8 — one place turns a grant event into the check result, so the map
 *  and ingest checks carry scope identically. Exclusions are bounded by the
 *  consent store's own cap; the slice here is belt-and-braces against a
 *  hand-written event. */
export function consentCheckOf(grant: ConsentEventDoc | null): MapConsentCheck {
  if (!grant) {
    return { active: false, consentId: null, disclosureSha256: null, target: null, exclusions: [] };
  }
  return {
    active: true,
    consentId: grant.consentId,
    disclosureSha256: grant.disclosureSha256 ?? null,
    target: grant.target
      ? { folderId: grant.target.folderId ?? null, folderPath: grant.target.folderPath ?? null }
      : null,
    exclusions: refuseOversizedExclusions(grant.exclusions ?? []),
  };
}

/**
 * The write path (core's consent store) refuses a grant carrying more than
 * MAX_EXCLUSIONS, so an oversized list can only reach us via a hand-written
 * store document. Truncating it here would be the fail-OPEN direction — an
 * exclusion past the cap would silently be walked and ingested, which is the
 * one thing a consent carve-out must never do. Refuse instead: the map does
 * not run until the record is repaired.
 */
function refuseOversizedExclusions(exclusions: string[]): string[] {
  if (exclusions.length > MAX_EXCLUSIONS) {
    throw ApplicationFailure.nonRetryable(
      `consent record carries ${exclusions.length} exclusions, above the ${MAX_EXCLUSIONS} cap ` +
        `the write path enforces — refusing to map under a consent whose carve-outs cannot all be honored.`,
      'ConsentExclusionsOversized'
    );
  }
  return exclusions;
}

// ── The one provider call: a classified folder page ─────────────────────────

/** One drive item, classified. tenant_id is attached by the caller's map_runs
 *  writes — the classifier itself is a pure function of observed metadata. */
export interface MapPageItem {
  id: string;
  name: string;
  isFolder: boolean;
  /** Graph folder size is RECURSIVE over the subtree — a pruned folder's
   *  size is the whole subtree's bytes, which is what makes prunedBytes
   *  meaningful without descending. */
  size: number;
  /** From the folder facet; null for files or when Graph omitted it. */
  childCount: number | null;
  /** Graph lastModifiedDateTime, '' when omitted (the candidates spool
   *  carries it; additive). */
  modified: string;
  /** Built from the walk's own breadcrumbs (folderPath + name), never from
   *  parentReference parsing. */
  path: string;
  classId: string;
  rule: string;
  /** Folders only (always false for files): descend unless the classifier
   *  says machine_generated — the reference implementation's should_walk. */
  shouldWalk: boolean;
}

export interface MapFolderPageResult {
  items: MapPageItem[];
  nextLink?: string;
  /** required_run_outputs: every run records which rules classified it. The
   *  workflow pins these on the first page and fails the run if a mid-run
   *  artifact swap changes them — a map classified under two rule sets is
   *  not a map of anything. */
  artifactVersion: string;
  artifactSha256: string;
}

/** '/'-joined breadcrumb path, collapsed. '' + 'Docs' -> '/Docs'. */
export function mapPathJoin(folderPath: string, name: string): string {
  return `${folderPath}/${name}`.replace(/\/+/g, '/');
}

/**
 * Translates a status-preserving Graph 429 into the ApplicationFailure that
 * makes Temporal wait what Graph asked (nextRetryDelay = Retry-After) rather
 * than its own backoff. Exported for unit tests: this is the seam where
 * "Retry-After honoured" either holds or silently doesn't. A blank or
 * unparseable Retry-After is null and stays null — never zero, which would
 * read as "retry now" at the exact moment the provider asked for patience.
 */
export function graphThrottleFailure(err: GraphHttpError): ApplicationFailure {
  return ApplicationFailure.create({
    message: `Graph throttled the map (HTTP 429${
      err.retryAfterSeconds !== null ? `, Retry-After ${err.retryAfterSeconds}s` : ''
    }): ${err.message}`,
    type: GRAPH_THROTTLED_ERROR_TYPE,
    // Retryable (a throttle is the opposite of terminal); when Graph named a
    // wait, the server-side retry honors it instead of the policy's backoff.
    nextRetryDelay: err.retryAfterSeconds !== null ? `${err.retryAfterSeconds}s` : undefined,
  });
}

// ── The run + spool + suggestions shapes ────────────────────────────────────

export interface MapRunStartInput {
  tenantId: string;
  runId: string;
  connectionId: string;
  provider: string;
  consentId: string | null;
  consentDisclosureSha256: string | null;
  /** JRN-8 — pinned on the run document: what scope bounded this walk. */
  consentTarget?: ConsentScopeTargetRecord | null;
  consentExclusions?: string[];
}

/** The per-page flush payload — the workflow's accumulators, verbatim. Kept
 *  as one bag so the live UI reads a consistent snapshot, and every bounded
 *  thing in it carries its own truncation record (no silent caps). */
export interface MapRunSnapshot {
  /** Set on the refusal paths, where startMapRun never ran and nothing else
   *  would record which provider was refused — a consent audit should not
   *  need a join to connector_connections to answer that. */
  provider?: string;
  progress?: unknown;
  aggregates?: unknown;
  topFolders?: unknown;
  rollupTruncated?: boolean;
  topFoldersOmitted?: number;
  pruneManifest?: unknown;
  pruneManifestTruncated?: boolean;
  pruneManifestOmitted?: number;
  reconciliation?: unknown;
  narration?: unknown;
  narrationDropped?: number;
}

/** Verdict-ledger rows kept INSIDE the map_suggestions document. NAMED cap,
 *  recorded when it bites (rowsTruncated + rowsOmitted + this cap value in
 *  the doc): a BSON document tops out at 16 MB and a measured row is ~250 B
 *  (path ≈ 60 chars on the reference walk, plus name/itemId/verdict), so
 *  20,000 rows ≈ 5 MB — three-fold headroom under the hard limit. The
 *  measured reference drive produces 1,983 rows; the cap exists for
 *  enterprise drives, and a truncated ledger REFUSES downstream resolution
 *  (see selectiveIngest.ts) rather than silently ingesting a subset. */
export const MAX_SUGGESTION_ROWS = 20_000;

export interface MapSuggestionsSummary {
  funnelPolicyVersion: string;
  candidateFiles: number;
  candidateBytes: number;
  subtractedFiles: number;
  defaultSelectionFiles: number;
  defaultSelectionBytes: number;
  rowsKept: number;
  rowsTruncated: boolean;
  rowsOmitted: number;
}

// ── The activity factory ────────────────────────────────────────────────────

export function createMapActivities(deps: ShelfmarkWorkflowDeps) {
  const { collections } = deps.store;

  return {
    /**
     * Is there an ACTIVE map_metadata consent for this connection — and what
     * scope did it grant (JRN-8)? Fail closed: a store error here propagates
     * (the workflow fails and finalizes 'failed'), and an empty stream
     * returns active:false (the workflow refuses). The query is tenant-scoped
     * in the filter itself — a connectionId from another tenant reads as "no
     * consent", never as another tenant's consent history.
     */
    async verifyMapConsent(tenantId: string, connectionId: string): Promise<MapConsentCheck> {
      const events = (await collections
        .consents()
        .find({ tenantId, connectionId }, { projection: { _id: 0 } })
        .sort({ grantedAt: -1 })
        .toArray()) as unknown as ConsentEventDoc[];
      return consentCheckOf(deriveActiveMapConsent(events));
    },

    /**
     * ONE Graph children call, classified. The workflow loops over pages and
     * folders — no single activity invocation can run long on a huge folder.
     */
    async listMapFolderPage(
      tenantId: string,
      connectionId: string,
      folderId: string | null,
      folderPath: string,
      pageUrl?: string
    ): Promise<MapFolderPageResult> {
      const conn = await getConnectionDoc(deps, connectionId);
      if (conn.tenantId !== tenantId) {
        // Tenant isolation is absolute: a workflow input whose tenantId does
        // not own this connection is refused terminally, not retried into.
        throw ApplicationFailure.create({
          nonRetryable: true,
          type: 'TenantScopeViolation',
          message: `map: connection ${connectionId} does not belong to tenant ${tenantId}`,
        });
      }
      const active = requireActiveConnection(conn);
      const accessToken = await getGraphAccessTokenFor(deps, connectionId);
      let page;
      try {
        page = await listFolderPage(accessToken, active.driveId, folderId, pageUrl);
      } catch (err) {
        if (err instanceof GraphHttpError && err.status === 429) {
          throw graphThrottleFailure(err);
        }
        throw err;
      }
      const ac = loadArtifactClasses();
      const items: MapPageItem[] = page.items.map((item) => {
        const path = mapPathJoin(folderPath, item.name);
        const c = ac.classify(item.name, item.isFolder, path);
        return {
          id: item.id,
          name: item.name,
          isFolder: item.isFolder,
          // The graph client preserves "Graph did not say" as null; a rollup
          // can only SUM numbers, so an unreported size contributes 0 bytes
          // here — the count of files is still honest, only unknowable bytes
          // are unadded.
          size: item.size ?? 0,
          childCount: item.childCount ?? null,
          modified: item.modified ?? '',
          path,
          classId: c.classId,
          rule: c.rule,
          shouldWalk: item.isFolder ? c.classId !== MACHINE_GENERATED : false,
        };
      });
      return {
        items,
        nextLink: page.nextLink,
        artifactVersion: ac.version,
        artifactSha256: ac.sha256,
      };
    },

    /**
     * Creates (or, on a crash-retry, reasserts) the run document at status
     * 'mapping', stamped with the classifier artifact version + SHA the run
     * will be classified under (required_run_outputs) and — JRN-8 — the
     * consent scope that bounds it. Returns the pin so the workflow can
     * verify every subsequent page was classified by the same bytes.
     */
    async startMapRun(
      input: MapRunStartInput
    ): Promise<{ artifactVersion: string; artifactSha256: string }> {
      const ac = loadArtifactClasses();
      await collections.mapRuns().updateOne(
        { runId: input.runId, tenantId: input.tenantId },
        {
          $setOnInsert: { startedAt: new Date() },
          $set: {
            tenantId: input.tenantId,
            runId: input.runId,
            connectionId: input.connectionId,
            provider: input.provider,
            status: 'mapping' satisfies MapRunStatus,
            consentId: input.consentId,
            consentDisclosureSha256: input.consentDisclosureSha256,
            consentTarget: input.consentTarget ?? null,
            consentExclusions: input.consentExclusions ?? [],
            classifierVersion: ac.version,
            artifactSha: ac.sha256,
            finishedAt: null,
          },
        },
        { upsert: true }
      );
      return { artifactVersion: ac.version, artifactSha256: ac.sha256 };
    },

    /** Unconditional page-level flush — the sync path's precedent: a page
     *  with no files still moved the walk, and the polling UI must see it. */
    async updateMapRunProgress(
      tenantId: string,
      runId: string,
      snapshot: MapRunSnapshot
    ): Promise<void> {
      await collections.mapRuns().updateOne({ runId, tenantId }, { $set: { ...snapshot } });
    },

    /**
     * Terminal write, upserting so the refusal paths (no consent, out of
     * consent scope, unsupported provider) leave a run document as evidence
     * even though startMapRun never ran for them. Same
     * must-not-strand-at-'mapping' guarantee as the sync finalize.
     */
    async finalizeMapRun(
      tenantId: string,
      runId: string,
      connectionId: string,
      status: Exclude<MapRunStatus, 'mapping'>,
      snapshot: MapRunSnapshot
    ): Promise<void> {
      await collections.mapRuns().updateOne(
        { runId, tenantId },
        {
          $setOnInsert: { startedAt: new Date() },
          $set: {
            tenantId,
            runId,
            connectionId,
            status,
            finishedAt: new Date(),
            ...snapshot,
          },
        },
        { upsert: true }
      );
      // 34-S11b — the candidates spool must not outlive the run's terminal
      // write. On 'complete', writeMapSuggestions already consumed and
      // deleted it (this is a no-op); on every other terminal status this
      // sweep is what keeps a failed or refused run from orphaning spool rows
      // forever — a retry is a NEW runId, so nothing ever reads a dead run's
      // spool again.
      await collections.mapCandidates().deleteMany({ tenantId, runId });
    },

    /**
     * Spools one page's funnel candidates. Filters to FILE items of the
     * funnel policy's candidate class (rules are data — the class name comes
     * from the artifact, never from code), and upserts so a Temporal retry of
     * the same page is a re-assertion, not a duplication.
     */
    async appendMapCandidates(
      tenantId: string,
      runId: string,
      connectionId: string,
      items: MapPageItem[]
    ): Promise<number> {
      const policy = loadFunnelPolicy();
      const rows = items.filter((i) => !i.isFolder && i.classId === policy.candidateClass);
      if (rows.length === 0) return 0;
      await collections.mapCandidates().bulkWrite(
        rows.map((i) => ({
          updateOne: {
            filter: { tenantId, runId, path: i.path },
            update: {
              $set: {
                tenantId,
                runId,
                connectionId,
                itemId: i.id,
                path: i.path,
                name: i.name,
                size: i.size,
                modified: i.modified,
                classRule: i.rule,
              } satisfies MapCandidateDoc,
            },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      return rows.length;
    },

    /**
     * Consumes the run's candidates spool through the funnel and writes the
     * ONE map_suggestions document, then deletes the spool.
     *
     * WHY DELETE RATHER THAN TTL: every datum any downstream consumer needs —
     * itemId included — is carried into the suggestions rows, so the spool
     * has exactly one reader (this function) and retaining it would duplicate
     * every row's bytes per run for nobody; and a delete-after-write needs no
     * TTL index. The idempotency guard below keeps the delete safe under
     * Temporal retries: a retry that finds the spool empty AND the
     * suggestions document present returns the recorded summary instead of
     * re-evaluating an empty corpus over the top of a real one.
     */
    async writeMapSuggestions(
      tenantId: string,
      runId: string,
      connectionId: string
    ): Promise<MapSuggestionsSummary> {
      const spool = collections.mapCandidates();
      const suggestions = collections.mapSuggestions();

      const docs = (await spool
        .find({ tenantId, runId }, { projection: { _id: 0 } })
        .toArray()) as unknown as MapCandidateDoc[];
      const existing = await suggestions.findOne({ tenantId, runId });
      if (docs.length === 0 && existing) {
        // Retry after the spool was already consumed — the write happened;
        // report what it recorded.
        return {
          funnelPolicyVersion: existing.funnelPolicyVersion,
          candidateFiles: existing.candidates?.files ?? 0,
          candidateBytes: existing.candidates?.bytes ?? 0,
          subtractedFiles: ((existing.funnelTable ?? []) as { files: number }[]).reduce(
            (a, r) => a + r.files,
            0
          ),
          defaultSelectionFiles: existing.defaultSelection?.files ?? 0,
          defaultSelectionBytes: existing.defaultSelection?.bytes ?? 0,
          rowsKept: (existing.rows ?? []).length,
          rowsTruncated: existing.rowsTruncated === true,
          rowsOmitted: existing.rowsOmitted ?? 0,
        };
      }

      const policy = loadFunnelPolicy();
      const ac = loadArtifactClasses();
      const records: WalkRecord[] = docs.map((d) => ({
        name: d.name,
        is_folder: false,
        path: d.path,
        size: d.size,
        id: d.itemId,
      }));
      // evaluateFunnel RE-CLASSIFIES under the pinned artifact-classes
      // version and refuses a version mismatch — a suggestions doc can never
      // mix two rule sets, same discipline as the walk's own mid-run pin.
      const result = evaluateFunnel(records, policy, ac);

      const byPath = new Map(docs.map((d) => [d.path, d]));
      const allRows: MapSuggestionRow[] = Object.keys(result.verdicts)
        .sort(compareCodepoints)
        .map((path) => {
          const v = result.verdicts[path]!;
          const d = byPath.get(path);
          const row: MapSuggestionRow = {
            itemId: d?.itemId ?? '',
            path,
            name: d?.name ?? '',
            size: d?.size ?? 0,
            modified: d?.modified ?? '',
            verdict: v.verdict,
          };
          if (v.verdict.startsWith('subtracted:propagated_from:')) {
            row.subtractedBy = v.verdict.slice('subtracted:propagated_from:'.length);
          } else if (v.verdict.startsWith('subtracted:')) {
            row.subtractedBy = v.verdict.slice('subtracted:'.length);
          }
          if (v.shapes.length > 0) row.reportedShapes = v.shapes;
          return row;
        });
      const rows = allRows.slice(0, MAX_SUGGESTION_ROWS);
      const rowsOmitted = allRows.length - rows.length;

      const sensitiveReport: Record<string, { candidates: number; defaultSelection: number }> = {};
      for (const [sid, cnt] of Object.entries(result.sensitive_shape_report)) {
        sensitiveReport[sid] = {
          candidates: cnt.candidates,
          defaultSelection: cnt.default_selection,
        };
      }

      await suggestions.updateOne(
        { tenantId, runId },
        {
          $setOnInsert: { createdAt: new Date() },
          $set: {
            tenantId,
            runId,
            connectionId,
            funnelPolicyVersion: policy.version,
            funnelPolicySha256: policy.sha256,
            classifierVersion: ac.version,
            classifierSha256: ac.sha256,
            candidates: result.candidates,
            // Every subtraction named and counted — including the propagation
            // row and the fingerprint collapse — in the pinned precedence
            // order.
            funnelTable: result.subtractions,
            defaultSelection: result.default_selection,
            // JRN-D1: COUNTS over candidates and over the default selection,
            // zeros included. Never a gate, never subtracted.
            sensitiveReport,
            // HONEST ABSENCE OF RANK: the source selection policy orders
            // survivors with corpus statistics and weights its own
            // weights_note declares UNVALIDATED, and no portable ordering
            // spec was published with the funnel handoff. Rank is therefore
            // absent rather than invented; rows are in path codepoint order,
            // which is not a quality ranking and does not pretend to be.
            ranking: {
              ranked: false,
              reason:
                'no portable ordering spec published for the funnel port; ' +
                'selection-policy weights are unvalidated (its weights_note) — rank omitted, not invented',
            },
            rows,
            rowsTruncated: rowsOmitted > 0,
            rowsOmitted,
            rowCap: MAX_SUGGESTION_ROWS,
            writtenAt: new Date(),
          },
        },
        { upsert: true }
      );

      await spool.deleteMany({ tenantId, runId });

      return {
        funnelPolicyVersion: policy.version,
        candidateFiles: result.candidates.files,
        candidateBytes: result.candidates.bytes,
        subtractedFiles: result.subtractions.reduce((a, r) => a + r.files, 0),
        defaultSelectionFiles: result.default_selection.files,
        defaultSelectionBytes: result.default_selection.bytes,
        rowsKept: rows.length,
        rowsTruncated: rowsOmitted > 0,
        rowsOmitted,
      };
    },
  };
}

export type MapActivities = ReturnType<typeof createMapActivities>;
export type { MapSuggestionRow };
