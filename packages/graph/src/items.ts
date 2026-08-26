// SPDX-License-Identifier: Apache-2.0
// The ONE drive-item shape both the browse path and the walk path map onto.
//
// Merging the two Graph clients forced a choice between the walk client's
// lossy defaults (`size || 0`, `lastModified || ''`) and the browse client's
// null-preserving mapping. Null-preserving wins: collapsing "Graph did not
// say" into a plausible-looking value makes every downstream screen lie
// (`34-S07a`), and a walk caller that wants a default can apply one — the
// reverse reconstruction is impossible.

export interface DriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  /**
   * Bytes. `null` means ONLY "Graph did not report a size" — never a stand-in
   * for zero. A 0-byte file has `size: 0`, and Plan 34 step 10 renders that
   * differently from an unknown size, so collapsing the two here would make a
   * downstream screen lie. On a FOLDER this is Graph's RECURSIVE subtree
   * size, which is exactly what makes a prune-manifest byte count meaningful
   * (`34-S09b`).
   */
  size: number | null;
  /** ISO-8601 last-modified, or null when Graph did not report one. */
  modified: string | null;
  /** Folders only. `0` is a genuinely empty folder; `null` is "unknown". Files are always null. */
  childCount: number | null;
}

/** Numbers only, and 0 survives — `||` would have turned a 0-byte file into null. */
export function numberOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** Map one raw Graph driveItem resource onto the shared shape. */
export function toDriveItem(item: any): DriveItem {
  const isFolder = Boolean(item.folder);
  return {
    id: item.id,
    name: item.name,
    isFolder,
    size: numberOrNull(item.size),
    modified: typeof item.lastModifiedDateTime === 'string' ? item.lastModifiedDateTime : null,
    // Files never carry a child count; a folder's is 0 when genuinely
    // empty and null only when Graph withheld the facet.
    childCount: isFolder ? numberOrNull(item.folder?.childCount) : null,
  };
}
