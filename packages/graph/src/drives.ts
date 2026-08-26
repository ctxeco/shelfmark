// SPDX-License-Identifier: Apache-2.0
// Drive resolution — turning "my OneDrive" or a pasted SharePoint site URL
// into the driveId every other call in this package needs.
import axios from 'axios';
import { toGraphHttpError } from './errors.js';

/** The signed-in user's own default drive — the OneDrive target. */
export async function getMyDrive(
  accessToken: string,
  grantedScopes?: string[]
): Promise<{ driveId: string }> {
  try {
    const { data } = await axios.get('https://graph.microsoft.com/v1.0/me/drive', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { driveId: data.id };
  } catch (err) {
    throw toGraphHttpError('Failed to resolve OneDrive', err, {
      grantedScopes,
      requiredScopes: ['Files.Read.All'],
    });
  }
}

/**
 * Resolves a SharePoint site's default document library drive from its
 * hostname + server-relative path (e.g. host="contoso.sharepoint.com",
 * sitePath="/sites/Finance") — the admin pastes this from their SharePoint
 * URL. A full "browse all sites" picker is deferred; this is the simplest
 * correct way to target one library for a v1.
 */
export async function getSharePointDrive(
  accessToken: string,
  hostname: string,
  sitePath: string,
  grantedScopes?: string[]
): Promise<{ driveId: string }> {
  try {
    const site = await axios.get(
      `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(hostname)}:${sitePath}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const drive = await axios.get(`https://graph.microsoft.com/v1.0/sites/${site.data.id}/drive`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { driveId: drive.data.id };
  } catch (err) {
    throw toGraphHttpError('Failed to resolve SharePoint site drive', err, {
      grantedScopes,
      requiredScopes: ['Sites.Read.All'],
    });
  }
}
