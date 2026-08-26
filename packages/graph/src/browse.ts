// SPDX-License-Identifier: Apache-2.0
// Browse path — the interactive folder-picker's view of a drive. Everything
// here is designed to be safe to surface to an untrusted client: cursors are
// opaque $skiptoken values (never provider URLs), listings either complete,
// paginate honestly, or fail loudly — silent truncation is the one defect
// this file exists to keep dead (`34-S07b`).
import axios from 'axios';
import { GraphConnectorError, toGraphHttpError, GRAPH_DRIVE_SCOPES } from './errors.js';
import { toDriveItem, type DriveItem } from './items.js';

export interface DriveItemPage {
  items: DriveItem[];
  /**
   * Opaque continuation token, or null. **null if and only if the listing is
   * complete** — a null cursor over an incomplete listing is the silent
   * truncation `34-S07b` exists to kill.
   */
  nextCursor: string | null;
}

export interface ListChildrenOptions {
  /** A `nextCursor` from a previous page. */
  cursor?: string | null;
  pageSize?: number;
  /** The access token's granted scopes, so a 404 can be explained (see toGraphHttpError). */
  grantedScopes?: string[];
}

const GRAPH_ITEM_SELECT = 'id,name,folder,size,lastModifiedDateTime';
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 999; // Graph's own ceiling for $top on /children

function clampPageSize(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)));
}

const SKIP_TOKEN_PARAMS = ['$skiptoken', 'skiptoken'];

/**
 * Pull ONLY the paging token out of `@odata.nextLink`, discarding the rest of
 * the URL. The client never sees the link itself: it is a fully-formed
 * provider URL, and handing one to a browser is how a query-string credential
 * escapes. What comes back here is an opaque provider-specific token that is
 * useless without our own request context.
 */
export function pagingTokenFromNextLink(nextLink: string): string | null {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    return null;
  }
  for (const [key, value] of url.searchParams.entries()) {
    if (SKIP_TOKEN_PARAMS.includes(key.toLowerCase()) && value !== '') return value;
  }
  return null;
}

/**
 * One page of one folder's children — files INCLUDED, not just folders.
 *
 * `34-S07a` widened `$select`: `size`, `lastModifiedDateTime` and the folder
 * facet's `childCount` all ride along on a request Graph was already serving,
 * so the extra metadata costs nothing on the wire.
 *
 * `34-S07b` added the cursor. Before it, this function read exactly one page
 * and dropped `@odata.nextLink` on the floor, so a folder past ~200 children
 * was silently truncated — a product pitched as "we show you your real drive"
 * quietly lying about what is in it.
 *
 * The 4th argument is optional, so `listChildren(token, driveId, folderId)`
 * still compiles; the RETURN type is now a page, because a bare array has
 * nowhere to carry "there is more" and that absence was the whole defect.
 */
export async function listChildren(
  accessToken: string,
  driveId: string,
  folderId?: string,
  options: ListChildrenOptions = {}
): Promise<DriveItemPage> {
  // Path segments are encoded: an id carrying `/` or `?` would otherwise
  // rewrite the request path rather than name an item inside it.
  const base = `/drives/${encodeURIComponent(driveId)}`;
  const path = folderId ? `${base}/items/${encodeURIComponent(folderId)}/children` : `${base}/root/children`;
  const params: Record<string, string | number> = {
    $select: GRAPH_ITEM_SELECT,
    $top: clampPageSize(options.pageSize),
  };
  if (options.cursor) params.$skiptoken = options.cursor;

  let data: any;
  try {
    ({ data } = await axios.get(`https://graph.microsoft.com/v1.0${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params,
    }));
  } catch (err) {
    throw toGraphHttpError('Failed to list folder', err, {
      grantedScopes: options.grantedScopes,
      requiredScopes: GRAPH_DRIVE_SCOPES,
    });
  }

  const nextLink = data?.['@odata.nextLink'];
  let nextCursor: string | null = null;
  if (typeof nextLink === 'string' && nextLink !== '') {
    nextCursor = pagingTokenFromNextLink(nextLink);
    if (!nextCursor) {
      // Graph just said the listing is incomplete. Answering `nextCursor:
      // null` here would tell the caller the opposite — the same silent
      // truncation this work item removed, reintroduced as a parse failure.
      // Passing the raw link through instead is not an option: it is a
      // provider URL and can carry credentials in its query string. So this
      // fails loudly, which is recoverable, rather than under-reporting a
      // customer's drive, which is not detectable.
      throw new GraphConnectorError(
        'Graph returned a continuation link with no recognisable paging token — refusing to report a partial listing as complete',
        { providerErrorCode: 'nextlink_unparseable' }
      );
    }
  }

  return {
    items: (data?.value || []).map(toDriveItem),
    nextCursor,
  };
}

/**
 * Documented ceiling for {@link listAllChildren}: the follow-the-nextLink
 * loop stops once it holds this many children. Big enough that a folder a
 * human actually browses fits in one answer; small enough that one API call
 * cannot be made to fan out unboundedly against a pathological folder.
 */
export const LIST_ALL_CHILDREN_CEILING = 2000;

export interface DriveChildrenListing {
  items: DriveItem[];
  /**
   * The cursor to continue from when `truncated`; null when the listing is
   * complete. Same invariant as {@link DriveItemPage}: null if and only if
   * there is nothing more.
   */
  nextCursor: string | null;
  /** true if and only if the ceiling — not the end of the folder — stopped the listing. */
  truncated: boolean;
}

/**
 * `listChildren` with the paging followed for you, honestly.
 *
 * The defect this replaces: call paths that wanted "all the children" took
 * the FIRST page and stopped, so a folder past one page was silently
 * under-reported — the exact lie `34-S07b` killed at the single-page level,
 * reintroduced one layer up. This follows `@odata.nextLink` (as re-issued
 * opaque cursors) up to {@link LIST_ALL_CHILDREN_CEILING} children and then
 * SAYS SO: `truncated: true` plus the cursor to continue from. A
 * continuation link that cannot be reduced to an opaque token still THROWS
 * (in `listChildren`) — never an under-report, silent or otherwise.
 */
export async function listAllChildren(
  accessToken: string,
  driveId: string,
  folderId?: string,
  options: ListChildrenOptions = {}
): Promise<DriveChildrenListing> {
  const items: DriveItem[] = [];
  let cursor: string | null = options.cursor ?? null;
  let pages = 0;
  for (;;) {
    pages += 1;
    const page = await listChildren(accessToken, driveId, folderId, { ...options, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) {
      // Graph said the listing is complete — even landing exactly on the
      // ceiling is a complete listing, not a truncated one.
      return { items, nextCursor: null, truncated: false };
    }
    // A well-behaved server sends at least one item per continued page, so
    // the page counter only trips on a server looping us on empty pages;
    // reporting truncated-with-cursor is the honest reading of that too.
    if (items.length >= LIST_ALL_CHILDREN_CEILING || pages >= LIST_ALL_CHILDREN_CEILING) {
      return { items, nextCursor: cursor, truncated: true };
    }
  }
}
