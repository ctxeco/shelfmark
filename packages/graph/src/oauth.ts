// SPDX-License-Identifier: Apache-2.0
// Microsoft Graph OAuth for document-drive connectors (OneDrive/SharePoint).
//
// Deliberately a SEPARATE app registration/credential from any mail-sending
// integration a deployment might also run: a mail sender typically uses
// APPLICATION permissions + the client-credentials grant (one shared
// mailbox), while this client needs DELEGATED permissions + the
// authorization-code grant (each connected organization's own OneDrive/
// SharePoint, consented to by that organization's own Microsoft 365
// admin/user).
//
// One multi-tenant Entra app registration (`Accounts in any organizational
// directory`), created ONCE in your own Entra tenant — NOT one app per
// connected customer. Each customer does its own OAuth consent against this
// SAME app the first time it connects; Microsoft's `/organizations` endpoint
// resolves which of the customer's own Entra tenants the signed-in user
// belongs to. The refresh token that consent produces is per-customer/
// per-user and is what actually gets stored (encrypted) on the deployment's
// connection record — no per-customer app registration is needed.
//
// This is the ONE token module for both halves of the package: the browse
// path (interactive consent + refresh) and the walk path (refresh only)
// used to carry duplicate refresh implementations; the merge keeps exactly
// one.
import axios from 'axios';
import { GraphConnectorError, toGraphHttpError } from './errors.js';

const MS_CLIENT_ID = process.env.CONNECTOR_MS_CLIENT_ID || '';
const MS_CLIENT_SECRET = process.env.CONNECTOR_MS_CLIENT_SECRET || '';
const GRAPH_SCOPES = 'offline_access Files.Read.All Sites.Read.All';

function requireConfigured(): void {
  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new GraphConnectorError(
      'Microsoft connector not configured — CONNECTOR_MS_CLIENT_ID/CLIENT_SECRET must both be set'
    );
  }
}

export interface GraphTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** Scopes the provider says this token actually carries; `[]` when it did not say. */
  scopes: string[];
}

export function buildAuthorizeUrl(state: string, codeChallenge: string, redirectUri: string): string {
  requireConfigured();
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: GRAPH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  // /organizations (not /common) — Files.Read.All/Sites.Read.All are
  // work-or-school-account resources; personal Microsoft accounts (MSA)
  // don't have them, so there is no reason to accept MSA sign-in here.
  return `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?${params.toString()}`;
}

async function requestToken(body: URLSearchParams): Promise<GraphTokens> {
  requireConfigured();
  try {
    const { data } = await axios.post(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      body,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: Number(data.expires_in) || 3600,
      // `34-S06d`'s prerequisite: knowing what the token actually carries is
      // the only local signal that can explain a Graph 404 as a missing scope.
      scopes: typeof data.scope === 'string' ? data.scope.split(' ').filter(Boolean) : [],
    };
  } catch (err) {
    // `34-S09c`: the token endpoint throttles too, and a background sync that
    // cannot see a 429 off its refresh call retries straight into the
    // throttle. GraphHttpError preserves status + Retry-After here exactly as
    // the drive calls do.
    throw toGraphHttpError('Graph token request failed', err);
  }
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<GraphTokens> {
  return requestToken(
    new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      scope: GRAPH_SCOPES,
    })
  );
}

export async function refreshAccessToken(refreshToken: string): Promise<GraphTokens> {
  const tokens = await requestToken(
    new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: GRAPH_SCOPES,
    })
  );
  // Microsoft rotates the refresh token on this grant and returns the new one,
  // which the caller MUST persist (`34-S07e`). The fallback matters anyway:
  // an omitted `refresh_token` would otherwise store `undefined` over a
  // working credential and kill the connection outright.
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}
