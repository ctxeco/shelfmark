// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = axios as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

/** An axios-shaped rejection: what the client actually has to read a status off. */
function httpError(status: number, data?: unknown, headers?: Record<string, string>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: headers ?? {} },
  });
}

describe('graph oauth', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CONNECTOR_MS_CLIENT_ID = 'client-123';
    process.env.CONNECTOR_MS_CLIENT_SECRET = 'secret-123';
    mockedAxios.get = vi.fn();
    mockedAxios.post = vi.fn();
  });

  afterEach(() => {
    delete process.env.CONNECTOR_MS_CLIENT_ID;
    delete process.env.CONNECTOR_MS_CLIENT_SECRET;
    vi.resetModules();
  });

  describe('buildAuthorizeUrl', () => {
    it('uses the /organizations authority — MSA sign-in is refused', async () => {
      const { buildAuthorizeUrl } = await import('../src/index.js');

      const url = buildAuthorizeUrl('state-1', 'challenge-1', 'https://app.example/cb');

      // Files.Read.All/Sites.Read.All are work-or-school-account resources;
      // personal Microsoft accounts don't have them, so /common would only
      // invite sign-ins that can never work.
      expect(url.startsWith('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?')).toBe(true);
      const params = new URL(url).searchParams;
      expect(params.get('scope')).toBe('offline_access Files.Read.All Sites.Read.All');
      expect(params.get('code_challenge')).toBe('challenge-1');
      expect(params.get('code_challenge_method')).toBe('S256');
      expect(params.get('client_id')).toBe('client-123');
      expect(params.get('state')).toBe('state-1');
    });

    it('requireConfigured: throws before building anything when the env credentials are unset', async () => {
      delete process.env.CONNECTOR_MS_CLIENT_ID;
      vi.resetModules();
      const { buildAuthorizeUrl, GraphConnectorError } = await import('../src/index.js');

      expect(() => buildAuthorizeUrl('s', 'c', 'https://app.example/cb')).toThrowError(GraphConnectorError);
      expect(() => buildAuthorizeUrl('s', 'c', 'https://app.example/cb')).toThrowError(
        /CONNECTOR_MS_CLIENT_ID/
      );
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('posts the PKCE verifier with the authorization code', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'Files.Read.All' },
      });
      const { exchangeCodeForTokens } = await import('../src/index.js');

      const tokens = await exchangeCodeForTokens('code-1', 'verifier-1', 'https://app.example/cb');

      expect(tokens.accessToken).toBe('at');
      const [tokenUrl, body] = mockedAxios.post.mock.calls[0];
      expect(tokenUrl).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('code-1');
      expect(body.get('code_verifier')).toBe('verifier-1');
    });
  });

  describe('refreshAccessToken', () => {
    it('reports the granted scopes so a 404 can later be explained', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'at',
          refresh_token: 'rt-new',
          expires_in: 3600,
          scope: 'offline_access Files.Read.All Sites.Read.All',
        },
      });
      const { refreshAccessToken } = await import('../src/index.js');

      const tokens = await refreshAccessToken('rt-old');

      expect(tokens.scopes).toEqual(['offline_access', 'Files.Read.All', 'Sites.Read.All']);
      expect(tokens.refreshToken).toBe('rt-new');
    });

    it('never returns an undefined refresh token over a working one', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'at', expires_in: 3600 } });
      const { refreshAccessToken } = await import('../src/index.js');

      const tokens = await refreshAccessToken('rt-old');

      // Storing `undefined` here would overwrite a live credential with
      // nothing and kill the connection outright.
      expect(tokens.refreshToken).toBe('rt-old');
    });

    // ---- 34-S09c sanctioned fix: the token endpoint throttles too ---------

    it('a 429 from a refresh carries status and Retry-After instead of a flattened sentence', async () => {
      mockedAxios.post.mockRejectedValue(httpError(429, { error: 'temporarily_throttled' }, { 'retry-after': '45' }));
      const { refreshAccessToken, GraphHttpError } = await import('../src/index.js');

      const err = await refreshAccessToken('rt-old').catch((e) => e);

      expect(err).toBeInstanceOf(GraphHttpError);
      expect(err.status).toBe(429);
      expect(err.retryAfterSeconds).toBe(45);
      expect(err.isThrottled).toBe(true);
    });

    it('a blank Retry-After on a refresh failure reads as null — never as retry-now', async () => {
      // Number('') === 0, so a blank header must NOT be read as "wait 0
      // seconds": that is five back-to-back retries against the very throttle
      // asking us to slow down. Blank means the server said nothing usable.
      mockedAxios.post.mockRejectedValue(httpError(429, undefined, { 'retry-after': '  ' }));
      const { refreshAccessToken } = await import('../src/index.js');

      const err = await refreshAccessToken('rt-old').catch((e) => e);

      expect(err.status).toBe(429);
      expect(err.retryAfterSeconds).toBeNull();
    });
  });
});
