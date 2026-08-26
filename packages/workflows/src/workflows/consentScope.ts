// SPDX-License-Identifier: Apache-2.0
// JRN-8 — the consent-scope algebra, pure.
//
// THE HOLE THIS CLOSES. The source system's consent records carried a target
// (which folder the human consented to) and an exclusions list (subtrees they
// carved out) — and the walk read NEITHER. The consent check answered "is
// there an active grant for this scope?" and the map then walked whatever the
// connection's root was, exclusions ignored. The record said one thing, the
// walk did another; the fix is to thread the grant's own target and
// exclusions into the walk and refuse or prune, fail closed, at the boundary.
//
// This module lives beside the workflow files (not the activities) because
// the WORKFLOW enforces the boundary: pruning must happen where the descend
// decision is made, deterministically, and a workflow bundle may only import
// pure code. The activities import it too — one algebra, two enforcement
// points, zero drift (the same reasoning as the consent derivation being one
// exported function under two scopes).
//
// PATH SPACE. All consent-scope paths here — `target.folderPath` and every
// exclusion — are compared in the walk's own path space: '/'-rooted at the
// MAPPED folder, exactly as the map reports paths. The folderId pin
// (`mapRootWithinConsent`) is what makes that comparison sound: the map
// refuses to run unless its root IS the consented folder (or the grant
// covers the whole drive), so the two path spaces coincide. Recording scope
// paths in any other space is a host error the string comparison cannot
// detect — the folderId equality is the fail-closed anchor.

/** ApplicationFailure type: the mapped root falls outside the consented
 *  target. Typed so a host's start helper can catch the refusal by name. */
export const MAP_OUT_OF_SCOPE_ERROR_TYPE = 'MapOutsideConsentScope';
/** ApplicationFailure type: a resolved selection row sits outside the
 *  consented target or inside a recorded exclusion. */
export const SELECTION_OUT_OF_SCOPE_ERROR_TYPE = 'SelectionOutsideConsentScope';
/** The prune-manifest rule id for a consent-excluded subtree. REPORT, never
 *  subtract silently (JRN-D1 applies to consent prunes too): the ledger
 *  carries every one of these with its path and its unopened bytes. */
export const CONSENT_EXCLUDED_RULE = 'consent_excluded';

/** The grant's target as the consent record carries it. `folderId: null`
 *  means the whole drive was consented. */
export interface ConsentScopeTarget {
  folderId: string | null;
  folderPath: string | null;
}

/** Collapse duplicate slashes, force a leading '/', drop a trailing one —
 *  so '/Team/', 'Team' and '/Team' all name the same subtree. */
export function normalizeConsentPath(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/')
    ? collapsed.slice(0, -1)
    : collapsed;
}

/**
 * May a map rooted at `rootFolderId` run under this grant? Fail closed on
 * identity, not on path strings: a subtree grant authorizes exactly the
 * folder it names, so the map root must BE that folder. (A root that is a
 * strict descendant of the target would also be safe, but proving descent
 * takes provider calls the consent check must not make — so it is refused,
 * and the customer maps the folder they consented to.)
 */
export function mapRootWithinConsent(
  rootFolderId: string | null,
  target: ConsentScopeTarget | null | undefined
): boolean {
  if (!target || target.folderId === null) return true; // whole drive consented
  return rootFolderId !== null && rootFolderId === target.folderId;
}

/** Is `path` inside the consented target subtree? Only meaningful for
 *  selection rows (the walk's own paths are inside by construction once the
 *  root pin holds); a null/root folderPath means everything qualifies. */
export function isWithinConsentTarget(path: string, folderPath: string | null | undefined): boolean {
  if (folderPath === null || folderPath === undefined) return true;
  const target = normalizeConsentPath(folderPath);
  if (target === '/') return true;
  const p = normalizeConsentPath(path);
  return p === target || p.startsWith(`${target}/`);
}

/**
 * Does `path` match a recorded exclusion — the exclusion itself, or anything
 * under it? This is the walk's prune predicate AND the selection refusal's
 * membership test.
 */
export function isConsentExcluded(path: string, exclusions: readonly string[]): boolean {
  if (exclusions.length === 0) return false;
  const p = normalizeConsentPath(path);
  return exclusions.some((raw) => {
    const e = normalizeConsentPath(raw);
    if (e === '/') return true; // an exclusion of the root excludes everything
    return p === e || p.startsWith(`${e}/`);
  });
}
