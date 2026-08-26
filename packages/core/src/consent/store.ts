// SPDX-License-Identifier: Apache-2.0
// Plan 25 Phase C — the append-only connector consent record.
//
// One document per consent EVENT in `connector_consents`. Never mutated.
//
// This is NOT another audit collection, and the three differences are the
// whole point of the file:
//
//  1. THE WRITE IS NEVER SWALLOWED. The egress audit log this module grew up
//     beside wrapped its Mongo insert in `catch {}` and called the durable
//     copy "best-effort" — a reasonable choice for a log whose structured
//     line already went to the log aggregator, and the exactly wrong choice
//     here. A consent record that did not persist means we cannot show a
//     regulator, a customer, or a court what the human agreed to; proceeding
//     anyway would be reading someone's storage on the strength of a promise
//     we no longer hold. So the write is `w:'majority', j:true`, an
//     unacknowledged write throws, and every error propagates to the caller,
//     which refuses the operation. That is the difference between an audit
//     log and evidence.
//
//  2. REVOCATION IS A NEW EVENT. The connector-lifecycle DELETE route this
//     replaced did `$set: { status: 'disconnected' }` — the previous state is
//     gone, and with it the answer to "what was permitted on 12 August". Here
//     a revocation is an INSERT carrying `revokesConsentId`. There is no
//     status field to overwrite and no update path in this module at all:
//     whether a consent is live is DERIVED from the event stream
//     (`activeConsents`).
//
//  3. `subjectSub` IS REQUIRED. A consent whose actor is unknown is refused,
//     not recorded with a placeholder. This is where the null that an honest
//     OAuth callback records (rather than back-filling the tenant slug into
//     an actor field) becomes a hard gate: an unattributable consent is not a
//     weaker consent, it is not a consent. Modelled on the one good precedent
//     available at extraction time — the human-verdict audit write: mandatory
//     human, mandatory reason, explicitly append-only.
//
// The database handle is INJECTED (`createConsentStore(db)`) rather than
// pulled from a connection singleton, so the host owns connection lifecycle
// and the evidence semantics above stay testable without a running replica
// set. Nothing else changed in the port: the operations, the error contract,
// and every property above are the originals.

import { randomUUID } from 'crypto';
import type { Db } from 'mongodb';
import {
  ConsentLocale,
  ConsentScope,
  DisclosureRegistry,
  defaultDisclosureRegistry,
  disclosureSha256,
} from './disclosures.js';

export const CONSENT_COLLECTION = 'connector_consents';

export type ConsentAction = 'granted' | 'revoked';

export interface ConsentTarget {
  /** Always the connection's own provider — never taken from the request body. */
  provider: string;
  siteId: string | null;
  driveId: string | null;
  folderId: string | null;
  folderPath: string | null;
}

export interface ConsentRecord {
  consentId: string;
  tenantId: string;
  connectionId: string;
  /** The acting human's `sub`. Required — see property 3 above. */
  subjectSub: string;
  /**
   * The acting human's UPN / preferred username, when the VERIFIED identity
   * carries one. Never accepted from a request body: an actor field filled in
   * by the caller is not attribution, it is a claim the caller made about
   * itself. Null when the token has no such claim, for the same reason the
   * OAuth callback records null rather than the tenant slug.
   */
  subjectUpn: string | null;
  scope: ConsentScope;
  target: ConsentTarget;
  exclusions: string[];
  disclosureId: string;
  disclosureSha256: string;
  disclosureLocale: ConsentLocale;
  /** The full text shown to the subject, verbatim. Never an i18n key. */
  disclosureText: string;
  action: ConsentAction;
  /** Set only on a `revoked` event; the `consentId` of the grant it withdraws. */
  revokesConsentId: string | null;
  /**
   * The moment of the event. Named `grantedAt` for both actions because the
   * record shape is uniform across events and `action` already says which
   * kind of event this is; a revocation with its own timestamp field would
   * mean two documents in one collection with two different time columns.
   */
  grantedAt: Date;
  sourceIp: string | null;
  userAgent: string | null;
}

export type ConsentErrorCode =
  | 'consent_subject_required'
  | 'consent_scope_invalid'
  | 'consent_exclusions_invalid'
  | 'disclosure_not_found'
  | 'disclosure_text_mismatch'
  | 'consent_not_found'
  | 'consent_already_revoked'
  | 'consent_not_recorded';

export class ConsentError extends Error {
  constructor(
    public readonly code: ConsentErrorCode,
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'ConsentError';
  }
}

/** Hard cap so one request cannot write an unbounded document. */
export const MAX_EXCLUSIONS = 500;
const MAX_EXCLUSION_LENGTH = 1024;

export interface GrantConsentInput {
  tenantId: string;
  connectionId: string;
  subjectSub: string | null | undefined;
  subjectUpn: string | null | undefined;
  scope: ConsentScope;
  locale: ConsentLocale;
  /**
   * The SHA-256 the portal computed over the text it actually displayed. It
   * must equal the SHA of the registry text this server would show. A
   * mismatch means the words on the screen were not these words — a portal
   * running a stale bundle, or a caller inventing a consent — and the record
   * would be a false statement about what the subject read.
   */
  presentedSha256: string;
  target: Omit<ConsentTarget, 'provider'> & { provider: string };
  exclusions: unknown;
  sourceIp: string | null;
  userAgent: string | null;
}

export interface RevokeConsentInput {
  tenantId: string;
  connectionId: string;
  consentId: string;
  subjectSub: string | null | undefined;
  subjectUpn: string | null | undefined;
  sourceIp: string | null;
  userAgent: string | null;
}

/** The operations over one consent log. Built by `createConsentStore`. */
export interface ConsentStore {
  recordConsentGrant(input: GrantConsentInput): Promise<ConsentRecord>;
  recordConsentRevocation(input: RevokeConsentInput): Promise<ConsentRecord>;
  listConsentEvents(tenantId: string, connectionId: string): Promise<ConsentRecord[]>;
  activeConsents(events: ConsentRecord[]): ConsentRecord[];
}

export interface ConsentStoreOptions {
  /**
   * The pinned disclosure set to resolve and verify against. Defaults to this
   * package's vendored artifact; a host that owns its own canonical consent
   * tree supplies its own registry here and every semantic below — including
   * the 409 SHA-mismatch refusal — applies to that host's bytes instead.
   */
  registry?: DisclosureRegistry;
}

function requireSubject(subjectSub: string | null | undefined): string {
  if (typeof subjectSub !== 'string' || subjectSub.trim() === '') {
    throw new ConsentError(
      'consent_subject_required',
      403,
      'Consent requires an identified user; this token carries no subject claim.'
    );
  }
  return subjectSub;
}

function normalizeExclusions(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_EXCLUSIONS) {
    throw new ConsentError(
      'consent_exclusions_invalid',
      400,
      `exclusions must be an array of at most ${MAX_EXCLUSIONS} strings`
    );
  }
  return raw.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '' || entry.length > MAX_EXCLUSION_LENGTH) {
      throw new ConsentError(
        'consent_exclusions_invalid',
        400,
        'each exclusion must be a non-empty string'
      );
    }
    return entry;
  });
}

/**
 * Which consents are live, DERIVED from the events. There is no status field
 * to read and none to overwrite: a grant is live until some later event
 * revokes it by id. This is what property 2 buys — the answer to "what was
 * permitted last Tuesday" is a filter on the same stream, not a lost value.
 *
 * Pure over the events, so it is exported standalone as well as on the store.
 */
export function activeConsents(events: ConsentRecord[]): ConsentRecord[] {
  const revoked = new Set(
    events
      .filter((e) => e.action === 'revoked' && e.revokesConsentId)
      .map((e) => e.revokesConsentId as string)
  );
  return events.filter((e) => e.action === 'granted' && !revoked.has(e.consentId));
}

export function createConsentStore(db: Db, options: ConsentStoreOptions = {}): ConsentStore {
  const registry = options.registry ?? defaultDisclosureRegistry;

  /**
   * The single write path. Deliberately has NO try/catch: an insert that
   * throws must reach the caller, which refuses the operation. See property 1
   * above.
   */
  async function appendConsentEvent(record: ConsentRecord): Promise<ConsentRecord> {
    const result = await db
      .collection(CONSENT_COLLECTION)
      // j:true — acknowledged only once the write is on the journal of a
      // majority of the replica set. A default-write-concern insert can be
      // acknowledged and then lost to a failover, which for evidence means the
      // operation ran against a consent nobody can produce.
      .insertOne({ ...record }, { writeConcern: { w: 'majority', j: true } });

    if (!result?.acknowledged) {
      throw new ConsentError(
        'consent_not_recorded',
        503,
        'The consent record was not acknowledged by the database; the operation did not start.'
      );
    }
    return record;
  }

  async function recordConsentGrant(input: GrantConsentInput): Promise<ConsentRecord> {
    const subjectSub = requireSubject(input.subjectSub);
    const exclusions = normalizeExclusions(input.exclusions);

    const disclosure = registry.getDisclosure(input.scope, input.locale);
    if (!disclosure) {
      throw new ConsentError(
        'disclosure_not_found',
        400,
        `No disclosure is registered for scope ${input.scope} in locale ${input.locale}.`
      );
    }

    // The text stored is ALWAYS the server's own registry text, never anything
    // the caller sent. The caller only gets to prove, via the SHA, that what it
    // displayed was this text.
    const sha = disclosureSha256(disclosure.text);
    if (input.presentedSha256 !== sha) {
      throw new ConsentError(
        'disclosure_text_mismatch',
        409,
        'The disclosure shown to the user does not match the current disclosure text.'
      );
    }

    return appendConsentEvent({
      consentId: `consent-${randomUUID()}`,
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      subjectSub,
      subjectUpn: input.subjectUpn ?? null,
      scope: input.scope,
      target: {
        provider: input.target.provider,
        siteId: input.target.siteId ?? null,
        driveId: input.target.driveId ?? null,
        folderId: input.target.folderId ?? null,
        folderPath: input.target.folderPath ?? null,
      },
      exclusions,
      disclosureId: disclosure.disclosureId,
      disclosureSha256: sha,
      disclosureLocale: disclosure.locale,
      disclosureText: disclosure.text,
      action: 'granted',
      revokesConsentId: null,
      grantedAt: new Date(),
      sourceIp: input.sourceIp,
      userAgent: input.userAgent,
    });
  }

  async function recordConsentRevocation(input: RevokeConsentInput): Promise<ConsentRecord> {
    const subjectSub = requireSubject(input.subjectSub);

    const events = await listConsentEvents(input.tenantId, input.connectionId);
    const grant = events.find((e) => e.consentId === input.consentId && e.action === 'granted');
    if (!grant) {
      throw new ConsentError(
        'consent_not_found',
        404,
        `No granted consent ${input.consentId} on this connection.`
      );
    }
    // A second revocation of the same grant is redundant rather than corrupting
    // — the log is append-only and the first event already withdrew it — so
    // this is a caller-facing guard, not a correctness invariant. Nothing
    // downstream may depend on there being exactly one.
    if (events.some((e) => e.action === 'revoked' && e.revokesConsentId === input.consentId)) {
      throw new ConsentError(
        'consent_already_revoked',
        409,
        `Consent ${input.consentId} has already been revoked.`
      );
    }

    // The revocation carries the grant's own disclosure forward so the event is
    // self-contained: a reader holding only this document can see exactly which
    // permission, over which subtree, on which words, was withdrawn.
    return appendConsentEvent({
      consentId: `consent-${randomUUID()}`,
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      subjectSub,
      subjectUpn: input.subjectUpn ?? null,
      scope: grant.scope,
      target: grant.target,
      exclusions: grant.exclusions,
      disclosureId: grant.disclosureId,
      disclosureSha256: grant.disclosureSha256,
      disclosureLocale: grant.disclosureLocale,
      disclosureText: grant.disclosureText,
      action: 'revoked',
      revokesConsentId: grant.consentId,
      grantedAt: new Date(),
      sourceIp: input.sourceIp,
      userAgent: input.userAgent,
    });
  }

  /**
   * Every event for one connection, newest first. Tenant-scoped in the query
   * itself — a connectionId from another tenant returns nothing rather than
   * another tenant's consent history.
   */
  async function listConsentEvents(
    tenantId: string,
    connectionId: string
  ): Promise<ConsentRecord[]> {
    const docs = await db
      .collection(CONSENT_COLLECTION)
      .find({ tenantId, connectionId }, { projection: { _id: 0 } })
      .sort({ grantedAt: -1 })
      .toArray();
    return docs as unknown as ConsentRecord[];
  }

  return Object.freeze({
    recordConsentGrant,
    recordConsentRevocation,
    listConsentEvents,
    activeConsents,
  });
}
