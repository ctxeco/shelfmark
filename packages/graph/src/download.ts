// SPDX-License-Identifier: Apache-2.0
// Raw file download — the walk path's byte fetch for ingestion.
import axios from 'axios';
import { toGraphHttpError } from './errors.js';

export async function downloadFile(
  accessToken: string,
  driveId: string,
  itemId: string
): Promise<Buffer> {
  try {
    const { data } = await axios.get(
      `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
      { headers: { Authorization: `Bearer ${accessToken}` }, responseType: 'arraybuffer' }
    );
    return Buffer.from(data);
  } catch (err) {
    // `34-S09c`: was a message-only wrap that destroyed `response.status`, so
    // a 429 on a download was indistinguishable from a 404 and no caller
    // could honor Retry-After. Downloads are the HIGHEST-volume call a sync
    // makes — the one place Graph is most likely to throttle — so this path
    // above all needed the status to survive.
    throw toGraphHttpError(`Failed to download file ${itemId}`, err);
  }
}
