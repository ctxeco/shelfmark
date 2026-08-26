// SPDX-License-Identifier: Apache-2.0
// Walk path — the Microsoft Graph calls a background sync/walk workflow
// needs: paginated folder listing and delta queries (file download lives in
// download.ts, token refresh in oauth.ts — the merge removed the duplicate
// refresh implementation the walk client used to carry). The interactive
// OAuth steps (authorize URL, code exchange) are oauth.ts's too; a walk
// workflow never initiates a new consent flow, only refreshes an
// already-granted token.
//
// Unlike browse.ts, pages here continue via the raw `@odata.nextLink` URL:
// this path runs server-side inside a durable workflow, the link never
// reaches a browser, and Graph's delta contract requires replaying the link
// verbatim. The opaque-cursor discipline is a BROWSE rule about what may
// cross to an untrusted client, not a Graph rule.
import axios from 'axios';
import { GraphHttpError, toGraphHttpError } from './errors.js';
import { toDriveItem, type DriveItem } from './items.js';

const WALK_ITEM_SELECT = 'id,name,folder,size,lastModifiedDateTime';

export interface FolderPage {
  items: DriveItem[];
  nextLink?: string;
}

/**
 * One page of a folder's children. Pass `pageUrl` (the previous page's
 * `nextLink`) to continue; omit it (with `folderId`) to fetch the first
 * page. Kept to one Graph call per invocation deliberately — the CALLER's
 * workflow loops over pages, not this function, so no single durable-step
 * invocation can run long on a folder with thousands of entries.
 *
 * `34-S09b`: revived (was dead since the delta rewrite) as the map walk's one
 * provider call. `$select=folder` returns the ENTIRE folder facet, childCount
 * included, so the map's empty-folder count needs no wider $select; `size` on
 * a folder is Graph's RECURSIVE subtree size, which is exactly what makes a
 * prune-manifest byte count meaningful. Throws GraphHttpError (status +
 * Retry-After preserved) rather than a message-only error.
 */
export async function listFolderPage(
  accessToken: string,
  driveId: string,
  folderId: string | null,
  pageUrl?: string
): Promise<FolderPage> {
  const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`;
  const url =
    pageUrl ||
    (folderId
      ? `${base}/items/${encodeURIComponent(folderId)}/children?$select=${WALK_ITEM_SELECT}&$top=200`
      : `${base}/root/children?$select=${WALK_ITEM_SELECT}&$top=200`);
  try {
    const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    return { items: (data.value || []).map(toDriveItem), nextLink: data['@odata.nextLink'] };
  } catch (err) {
    throw toGraphHttpError('Failed to list folder page', err);
  }
}

export type DeltaDriveItem = DriveItem & { path: string; deleted: boolean };

export interface DeltaPage {
  items: DeltaDriveItem[];
  nextLink?: string;
  deltaLink?: string;
  /** `34-S14c` — set ONLY when this page is the first page of a full
   *  re-enumeration forced by an expired delta token (HTTP 410 Gone). The
   *  caller records it so a re-crawl caused by token expiry is
   *  distinguishable from a normal first crawl, which looks identical
   *  otherwise. Absent on every ordinary page. */
  deltaExpired?: boolean;
}

/** HTTP status Graph answers with when a stored `deltaLink`/`nextLink` has
 *  aged out. Named because the fallback that depends on it is a behaviour
 *  change, not a magic number. */
export const GRAPH_DELTA_EXPIRED_STATUS = 410;

/** Graph's own error code inside a 410 body. Matched as a secondary signal so
 *  a proxy that rewrites the status (or a wrapper that already flattened it)
 *  still resolves to "resync required" rather than to five retries against a
 *  permanently dead token. */
export const GRAPH_RESYNC_REQUIRED_CODE = 'resyncRequired';

/**
 * `34-S14c` — is this failure "your delta token is gone, start over"?
 *
 * Microsoft Graph answers 410 Gone when a stored deltaLink has aged out.
 * Nothing used to detect it: `listDeltaPage` flattened every axios error into
 * a message-only error, so a long-idle connection burned all of its retry
 * attempts on a PERMANENT error and finalised the sync 'failed' — and stayed
 * failing, because the same dead token was stored.
 */
export function isDeltaResyncRequired(err: unknown): boolean {
  if (err instanceof GraphHttpError && err.status === GRAPH_DELTA_EXPIRED_STATUS) return true;
  const message = (err as Error | undefined)?.message ?? '';
  return message.includes(GRAPH_RESYNC_REQUIRED_CODE);
}

/**
 * This single call is BOTH the first full crawl AND every incremental
 * resync after it — no separate BFS/`listFolderPage` walk is needed here.
 * Called fresh (no `deltaOrNextLink`), Graph's delta API returns the ENTIRE
 * current tree (every item, as if newly created), paginated; the final
 * page's `@odata.deltaLink` is then stored and passed back in on every
 * future sync, at which point this returns only what changed. Scoped to
 * `rootFolderId` when the connection has one chosen (delta on a specific
 * item's subtree, not just the whole drive); falls back to the drive root.
 */
export async function listDeltaPage(
  accessToken: string,
  driveId: string,
  rootFolderId: string | null,
  deltaOrNextLink?: string
): Promise<DeltaPage> {
  const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`;
  const scopedRoot = rootFolderId
    ? `${base}/items/${encodeURIComponent(rootFolderId)}/delta`
    : `${base}/root/delta`;
  const url = deltaOrNextLink || scopedRoot;
  try {
    const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const items = (data.value || []).map((item: any) => ({
      ...toDriveItem(item),
      // This function always calls the plural /drives/{driveId}/... endpoint
      // (never the singular /me/drive/... shorthand), so parentReference.path
      // always comes back as "/drives/{drive-id}/root:/Finance/2026" — strip
      // that Graph-internal drive-id prefix to get a real folder path. The
      // previous regex assumed the singular "/drive/root:" form, which never
      // matches here, so the raw drive-id string was leaking straight into
      // every ingested document's `path` field un-stripped.
      path: (item.parentReference?.path || '').replace(/^\/drives\/[^/]+\/root:?/, '') || '/',
      deleted: Boolean(item.deleted),
    }));
    return {
      items,
      nextLink: data['@odata.nextLink'],
      deltaLink: data['@odata.deltaLink'],
    };
  } catch (err) {
    // `34-S14c`: was a message-only wrap, which destroyed `response.status`
    // in the message text — so no caller could see the 410 that means "this
    // token is gone". GraphHttpError IS a GraphConnectorError, so every
    // existing generic handler is unaffected; what changes is that
    // `err.status` now survives the wrap. (`34-S09c` finished the same
    // migration for downloadFile and the token requests — in this package
    // every HTTP path throws GraphHttpError.)
    throw toGraphHttpError('Failed to list delta page', err);
  }
}
