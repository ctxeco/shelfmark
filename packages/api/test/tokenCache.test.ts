// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { decryptToken, encryptToken } from '@shelfmark/core';
import { connectionAccessToken, forgetConnectionTokens, __testing } from '../src/tokenCache.js';

const STORED_REFRESH_TOKEN = 'stored-refresh-token';

type TokenParams = Parameters<typeof connectionAccessToken>[0];

function params(overrides: Partial<TokenParams> = {}) {
  return {
    tenantId: 'ACME-01',
    connectionId: 'conn-1',
    encRefreshToken: encryptToken(STORED_REFRESH_TOKEN),
    refresh: vi.fn().mockResolvedValue({
      accessToken: 'access-1',
      refreshToken: STORED_REFRESH_TOKEN,
      expiresIn: 3600,
      scopes: ['Files.Read.All'],
    }),
    persistRotatedRefreshToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as TokenParams & {
    refresh: ReturnType<typeof vi.fn>;
    persistRotatedRefreshToken: ReturnType<typeof vi.fn>;
  };
}

describe('tokenCache', () => {
  beforeEach(() => {
    process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __testing.reset();
    vi.useRealTimers();
  });

  afterEach(() => {
    __testing.reset();
    vi.useRealTimers();
    delete process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY;
  });

  // ---- 34-S07e (a): rotation is persisted, not discarded ------------------

  describe('refresh token rotation', () => {
    it('persists a rotated refresh token, encrypted', async () => {
      const p = params({
        refresh: vi.fn().mockResolvedValue({
          accessToken: 'access-1',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 3600,
        }),
      });

      await connectionAccessToken(p);

      expect(p.persistRotatedRefreshToken).toHaveBeenCalledTimes(1);
      const [stored] = p.persistRotatedRefreshToken.mock.calls[0];
      // Encrypted at rest with the same envelope the connection was created
      // with — and it round-trips to the NEW token, not the dead one.
      expect(stored).toEqual({
        ciphertext: expect.any(String),
        iv: expect.any(String),
        tag: expect.any(String),
      });
      expect(decryptToken(stored)).toBe('rotated-refresh-token');
      expect(decryptToken(stored)).not.toBe(STORED_REFRESH_TOKEN);
    });

    it('does not write when the provider handed back the same token', async () => {
      const p = params();

      await connectionAccessToken(p);

      expect(p.persistRotatedRefreshToken).not.toHaveBeenCalled();
    });

    it('does not write when the provider returned no refresh token at all', async () => {
      const p = params({
        refresh: vi.fn().mockResolvedValue({ accessToken: 'access-1', refreshToken: '', expiresIn: 3600 }),
      });

      await connectionAccessToken(p);

      // Overwriting a live credential with nothing is worse than keeping it.
      expect(p.persistRotatedRefreshToken).not.toHaveBeenCalled();
    });

    it('decrypts the STORED token and hands the plaintext to the provider', async () => {
      const p = params();

      await connectionAccessToken(p);

      expect(p.refresh).toHaveBeenCalledWith(STORED_REFRESH_TOKEN);
    });

    it('still serves the request but reports loudly when the write-back fails', async () => {
      const onRotationPersistFailure = vi.fn();
      const p = params({
        refresh: vi.fn().mockResolvedValue({
          accessToken: 'access-1',
          refreshToken: 'rotated-refresh-token',
          expiresIn: 3600,
        }),
        persistRotatedRefreshToken: vi.fn().mockRejectedValue(new Error('store down')),
        onRotationPersistFailure,
      });

      const result = await connectionAccessToken(p);

      expect(result.accessToken).toBe('access-1');
      // The connection is dying either way — the provider already retired the
      // old token. What must not happen is silence.
      expect(onRotationPersistFailure).toHaveBeenCalledTimes(1);
    });
  });

  // ---- 34-S07e (b): the cache ---------------------------------------------

  describe('access token cache', () => {
    it('refreshes once and serves the second call from cache', async () => {
      const p = params();

      const first = await connectionAccessToken(p);
      const second = await connectionAccessToken(p);

      expect(p.refresh).toHaveBeenCalledTimes(1);
      expect(second.accessToken).toBe(first.accessToken);
      expect(second.scopes).toEqual(['Files.Read.All']);
    });

    it('refreshes again once the real expiry (minus the safety margin) has passed', async () => {
      vi.useFakeTimers();
      const p = params({
        refresh: vi
          .fn()
          .mockResolvedValueOnce({ accessToken: 'access-1', refreshToken: STORED_REFRESH_TOKEN, expiresIn: 3600 })
          .mockResolvedValueOnce({ accessToken: 'access-2', refreshToken: STORED_REFRESH_TOKEN, expiresIn: 3600 }),
      });

      expect((await connectionAccessToken(p)).accessToken).toBe('access-1');
      vi.advanceTimersByTime(3600_000 - __testing.SAFETY_MARGIN_MS - 1000);
      expect((await connectionAccessToken(p)).accessToken).toBe('access-1');
      vi.advanceTimersByTime(2000);
      expect((await connectionAccessToken(p)).accessToken).toBe('access-2');
      expect(p.refresh).toHaveBeenCalledTimes(2);
    });

    it('never serves a token inside its final minute', async () => {
      vi.useFakeTimers();
      const p = params({
        refresh: vi.fn().mockResolvedValue({
          accessToken: 'access-1',
          refreshToken: STORED_REFRESH_TOKEN,
          expiresIn: 30, // shorter than the safety margin
        }),
      });

      await connectionAccessToken(p);
      await connectionAccessToken(p);

      // A token whose whole life is inside the margin is used once and never
      // stored — caching it would serve a value we have declared unsafe.
      expect(p.refresh).toHaveBeenCalledTimes(2);
      expect(__testing.cacheSize()).toBe(0);
    });

    it('keys the cache on tenant AND connection, so no token crosses tenants', async () => {
      const acme = params({ tenantId: 'ACME-01' });
      const other = params({
        tenantId: 'OTHER-02',
        refresh: vi.fn().mockResolvedValue({
          accessToken: 'other-tenant-token',
          refreshToken: STORED_REFRESH_TOKEN,
          expiresIn: 3600,
        }),
      });

      const a = await connectionAccessToken(acme);
      const b = await connectionAccessToken(other);

      expect(a.accessToken).toBe('access-1');
      expect(b.accessToken).toBe('other-tenant-token');
      expect(other.refresh).toHaveBeenCalledTimes(1);
    });

    it('collapses concurrent refreshes into a single round trip', async () => {
      let resolve!: (v: unknown) => void;
      const gate = new Promise((r) => (resolve = r));
      const refresh = vi.fn().mockImplementation(async () => {
        await gate;
        return { accessToken: 'access-1', refreshToken: 'rotated', expiresIn: 3600 };
      });
      const p = params({ refresh });

      const all = Promise.all([
        connectionAccessToken(p),
        connectionAccessToken(p),
        connectionAccessToken(p),
      ]);
      resolve(undefined);
      const results = await all;

      // Without single-flight, a burst fires one refresh each — and on a
      // rotating provider the losers persist a token already retired.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(p.persistRotatedRefreshToken).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.accessToken)).toEqual(['access-1', 'access-1', 'access-1']);
    });

    it('lets a failed refresh be retried rather than sticking', async () => {
      const refresh = vi
        .fn()
        .mockRejectedValueOnce(new Error('provider down'))
        .mockResolvedValueOnce({ accessToken: 'access-2', refreshToken: STORED_REFRESH_TOKEN, expiresIn: 3600 });
      const p = params({ refresh });

      await expect(connectionAccessToken(p)).rejects.toThrow('provider down');
      expect((await connectionAccessToken(p)).accessToken).toBe('access-2');
    });

    it('rejects a refresh that produced no access token', async () => {
      const p = params({
        refresh: vi.fn().mockResolvedValue({ accessToken: '', refreshToken: 'x', expiresIn: 3600 }),
      });

      await expect(connectionAccessToken(p)).rejects.toThrow(/no access token/i);
    });

    it('reports [] scopes when the provider did not say', async () => {
      const p = params({
        refresh: vi.fn().mockResolvedValue({
          accessToken: 'access-1',
          refreshToken: STORED_REFRESH_TOKEN,
          expiresIn: 3600,
        }),
      });

      expect((await connectionAccessToken(p)).scopes).toEqual([]);
    });

    it('stays bounded under many connections', async () => {
      for (let i = 0; i < __testing.MAX_CACHE_ENTRIES + 50; i += 1) {
        await connectionAccessToken(params({ connectionId: `conn-${i}` }));
      }
      expect(__testing.cacheSize()).toBeLessThanOrEqual(__testing.MAX_CACHE_ENTRIES);
    });
  });

  describe('forgetConnectionTokens', () => {
    it('forces the next call to refresh, so a disconnect takes effect at once', async () => {
      const p = params();

      await connectionAccessToken(p);
      forgetConnectionTokens('ACME-01', 'conn-1');
      await connectionAccessToken(p);

      expect(p.refresh).toHaveBeenCalledTimes(2);
    });

    it('does not evict another tenant’s entry for the same connection id', async () => {
      const acme = params({ tenantId: 'ACME-01' });
      const other = params({ tenantId: 'OTHER-02' });
      await connectionAccessToken(acme);
      await connectionAccessToken(other);

      forgetConnectionTokens('ACME-01', 'conn-1');

      await connectionAccessToken(other);
      expect(other.refresh).toHaveBeenCalledTimes(1);
    });
  });
});
