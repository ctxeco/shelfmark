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

describe('graph browse path', () => {
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

  // ---- 34-S07b: pagination ------------------------------------------------

  describe('listChildren pagination', () => {
    it('returns nextCursor null when Graph sends no continuation link', async () => {
      mockedAxios.get.mockResolvedValue({ data: { value: [{ id: 'a', name: 'A' }] } });
      const { listChildren } = await import('../src/index.js');

      const page = await listChildren('at', 'drive-1');

      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
    });

    it('extracts ONLY the paging token from @odata.nextLink, never the URL itself', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          value: [],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$select=id,name&$top=200&$skiptoken=UGFnZWQ9VFJVRQ',
        },
      });
      const { listChildren } = await import('../src/index.js');

      const page = await listChildren('at', 'drive-1');

      expect(page.nextCursor).toBe('UGFnZWQ9VFJVRQ');
      // The load-bearing assertion: a provider URL can carry credentials in
      // its query string, so no part of one may reach the client.
      expect(page.nextCursor).not.toContain('https://');
      expect(page.nextCursor).not.toContain('graph.microsoft.com');
    });

    it('sends a supplied cursor back as $skiptoken', async () => {
      mockedAxios.get.mockResolvedValue({ data: { value: [] } });
      const { listChildren } = await import('../src/index.js');

      await listChildren('at', 'drive-1', 'folder-9', { cursor: 'TOKEN-2' });

      const [, config] = mockedAxios.get.mock.calls[0];
      expect(config.params.$skiptoken).toBe('TOKEN-2');
    });

    it('walks three pages and drops nothing — the truncation that 34-S07b fixes', async () => {
      const { listChildren } = await import('../src/index.js');
      const link = (token: string) =>
        `https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$top=2&$skiptoken=${token}`;
      mockedAxios.get
        .mockResolvedValueOnce({
          data: { value: [{ id: '1', name: 'one' }, { id: '2', name: 'two' }], '@odata.nextLink': link('T1') },
        })
        .mockResolvedValueOnce({
          data: { value: [{ id: '3', name: 'three' }, { id: '4', name: 'four' }], '@odata.nextLink': link('T2') },
        })
        .mockResolvedValueOnce({ data: { value: [{ id: '5', name: 'five' }] } });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { items: { id: string }[]; nextCursor: string | null } = await listChildren(
          'at',
          'drive-1',
          undefined,
          { cursor }
        );
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(['1', '2', '3', '4', '5']);
      // Page 2 and 3 must have asked with the cursor page 1 and 2 handed back.
      expect(mockedAxios.get.mock.calls[1][1].params.$skiptoken).toBe('T1');
      expect(mockedAxios.get.mock.calls[2][1].params.$skiptoken).toBe('T2');
    });

    it('THROWS rather than claim completeness when a continuation link cannot be parsed', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { value: [{ id: 'a', name: 'A' }], '@odata.nextLink': 'not-a-url-at-all' },
      });
      const { listChildren, GraphConnectorError } = await import('../src/index.js');

      // Reporting nextCursor: null here would under-report a customer's drive
      // and be undetectable. Failing loudly is recoverable.
      await expect(listChildren('at', 'drive-1')).rejects.toBeInstanceOf(GraphConnectorError);
      await expect(listChildren('at', 'drive-1')).rejects.toMatchObject({
        providerErrorCode: 'nextlink_unparseable',
      });
    });

    it('clamps $top into Graph’s allowed range', async () => {
      mockedAxios.get.mockResolvedValue({ data: { value: [] } });
      const { listChildren } = await import('../src/index.js');

      await listChildren('at', 'drive-1', undefined, { pageSize: 100000 });
      expect(mockedAxios.get.mock.calls[0][1].params.$top).toBe(999);

      await listChildren('at', 'drive-1', undefined, { pageSize: 0 });
      expect(mockedAxios.get.mock.calls[1][1].params.$top).toBe(1);

      await listChildren('at', 'drive-1');
      expect(mockedAxios.get.mock.calls[2][1].params.$top).toBe(200);
    });
  });

  // ---- Sanctioned fix: auto-paging with an honest ceiling ------------------

  describe('listAllChildren auto-paging', () => {
    const link = (token: string) =>
      `https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$top=200&$skiptoken=${token}`;
    const page = (offset: number, count: number, nextToken?: string) => ({
      data: {
        value: Array.from({ length: count }, (_, i) => ({ id: `i${offset + i}`, name: `n${offset + i}` })),
        ...(nextToken ? { '@odata.nextLink': link(nextToken) } : {}),
      },
    });

    it('follows @odata.nextLink across pages and returns the union, not the first page', async () => {
      // The defect this function replaces: call paths that wanted "all the
      // children" took the FIRST page and stopped.
      mockedAxios.get
        .mockResolvedValueOnce(page(0, 2, 'T1'))
        .mockResolvedValueOnce(page(2, 2, 'T2'))
        .mockResolvedValueOnce(page(4, 1));
      const { listAllChildren } = await import('../src/index.js');

      const listing = await listAllChildren('at', 'drive-1');

      expect(listing.items.map((i) => i.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
      expect(listing.truncated).toBe(false);
      expect(listing.nextCursor).toBeNull();
      expect(mockedAxios.get.mock.calls[1][1].params.$skiptoken).toBe('T1');
      expect(mockedAxios.get.mock.calls[2][1].params.$skiptoken).toBe('T2');
    });

    it('stops at the documented ceiling, sets truncated, and hands back the continue cursor', async () => {
      const { listAllChildren, LIST_ALL_CHILDREN_CEILING } = await import('../src/index.js');
      expect(LIST_ALL_CHILDREN_CEILING).toBe(2000);
      const half = LIST_ALL_CHILDREN_CEILING / 2;
      mockedAxios.get
        .mockResolvedValueOnce(page(0, half, 'T1'))
        .mockResolvedValueOnce(page(half, half, 'T2'))
        .mockResolvedValueOnce(page(2 * half, half, 'T3'));

      const listing = await listAllChildren('at', 'drive-1');

      expect(listing.items).toHaveLength(LIST_ALL_CHILDREN_CEILING);
      expect(listing.truncated).toBe(true);
      expect(listing.nextCursor).toBe('T2');
      // The ceiling must stop the FETCHING too, not just trim the result.
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('a listing that ends exactly at the ceiling is complete, not truncated', async () => {
      const { listAllChildren, LIST_ALL_CHILDREN_CEILING } = await import('../src/index.js');
      const half = LIST_ALL_CHILDREN_CEILING / 2;
      mockedAxios.get
        .mockResolvedValueOnce(page(0, half, 'T1'))
        .mockResolvedValueOnce(page(half, half)); // no nextLink: Graph says done

      const listing = await listAllChildren('at', 'drive-1');

      expect(listing.items).toHaveLength(LIST_ALL_CHILDREN_CEILING);
      expect(listing.truncated).toBe(false);
      expect(listing.nextCursor).toBeNull();
    });

    it('still THROWS on an unparseable continuation link mid-walk — never under-reports silently', async () => {
      mockedAxios.get
        .mockResolvedValueOnce(page(0, 2, 'T1'))
        .mockResolvedValueOnce({
          data: { value: [{ id: 'x', name: 'X' }], '@odata.nextLink': 'not-a-url-at-all' },
        });
      const { listAllChildren, GraphConnectorError } = await import('../src/index.js');

      const err = await listAllChildren('at', 'drive-1').catch((e) => e);

      expect(err).toBeInstanceOf(GraphConnectorError);
      expect(err.providerErrorCode).toBe('nextlink_unparseable');
    });
  });

  // ---- 34-S07a: the widened item shape, and null-vs-zero ------------------

  describe('listChildren item shape', () => {
    it('returns files as well as folders, with size, modified and childCount', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          value: [
            {
              id: 'fold',
              name: 'Finance',
              folder: { childCount: 12 },
              size: 90210,
              lastModifiedDateTime: '2026-08-01T12:00:00Z',
            },
            {
              id: 'file',
              name: 'budget.xlsx',
              size: 20480,
              lastModifiedDateTime: '2026-07-04T10:00:00Z',
            },
          ],
        },
      });
      const { listChildren } = await import('../src/index.js');

      const { items } = await listChildren('at', 'drive-1');

      expect(items[0]).toEqual({
        id: 'fold',
        name: 'Finance',
        isFolder: true,
        size: 90210,
        modified: '2026-08-01T12:00:00Z',
        childCount: 12,
      });
      expect(items[1]).toEqual({
        id: 'file',
        name: 'budget.xlsx',
        isFolder: false,
        size: 20480,
        modified: '2026-07-04T10:00:00Z',
        childCount: null,
      });
    });

    it('keeps ZERO as zero and ABSENT as null — they are different absence states', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          value: [
            { id: 'empty-file', name: 'placeholder.txt', size: 0, lastModifiedDateTime: '2026-01-01T00:00:00Z' },
            { id: 'empty-folder', name: 'Empty', folder: { childCount: 0 }, size: 0 },
            { id: 'quiet', name: 'Unknown', folder: {} },
          ],
        },
      });
      const { listChildren } = await import('../src/index.js');

      const { items } = await listChildren('at', 'drive-1');

      // A 0-byte file is 0, not "we do not know".
      expect(items[0].size).toBe(0);
      // An empty folder has childCount 0, not null.
      expect(items[1].childCount).toBe(0);
      expect(items[1].size).toBe(0);
      // A folder facet with no childCount is genuinely unknown.
      expect(items[2].childCount).toBeNull();
      expect(items[2].size).toBeNull();
      expect(items[2].modified).toBeNull();
    });

    it('asks Graph for the widened field set', async () => {
      mockedAxios.get.mockResolvedValue({ data: { value: [] } });
      const { listChildren } = await import('../src/index.js');

      await listChildren('at', 'drive-1');

      const select = mockedAxios.get.mock.calls[0][1].params.$select;
      expect(select).toContain('size');
      expect(select).toContain('lastModifiedDateTime');
      expect(select).toContain('folder');
    });

    it('encodes ids into the request path instead of letting them rewrite it', async () => {
      mockedAxios.get.mockResolvedValue({ data: { value: [] } });
      const { listChildren } = await import('../src/index.js');

      await listChildren('at', 'drive-1', '../../evil?x=1');

      const [url] = mockedAxios.get.mock.calls[0];
      expect(url).not.toContain('../..');
      expect(url).toContain(encodeURIComponent('../../evil?x=1'));
    });
  });

  // ---- 34-S09c: status preservation --------------------------------------

  describe('GraphConnectorError detail', () => {
    it('preserves status and Retry-After off a 429', async () => {
      mockedAxios.get.mockRejectedValue(
        httpError(429, { error: { code: 'activityLimitReached' } }, { 'retry-after': '120' })
      );
      const { listChildren, GraphConnectorError, GraphHttpError } = await import('../src/index.js');

      const err = await listChildren('at', 'drive-1').catch((e) => e);

      expect(err).toBeInstanceOf(GraphConnectorError);
      expect(err).toBeInstanceOf(GraphHttpError);
      expect(err.status).toBe(429);
      expect(err.retryAfterSeconds).toBe(120);
      expect(err.providerErrorCode).toBe('activityLimitReached');
      expect(err.isThrottled).toBe(true);
    });

    it('tells a 404 apart from a 500 apart from a 429', async () => {
      const { listChildren } = await import('../src/index.js');
      for (const status of [404, 500, 429]) {
        mockedAxios.get.mockRejectedValueOnce(httpError(status));
        const err = await listChildren('at', 'drive-1').catch((e) => e);
        expect(err.status).toBe(status);
      }
    });

    it('reports null status for a transport failure that never got an answer', async () => {
      mockedAxios.get.mockRejectedValue(new Error('ECONNRESET'));
      const { listChildren } = await import('../src/index.js');

      const err = await listChildren('at', 'drive-1').catch((e) => e);

      expect(err.status).toBeNull();
      expect(err.isThrottled).toBe(false);
    });

    it('flags a 404 as a MISSING SCOPE when the token verifiably lacks it', async () => {
      mockedAxios.get.mockRejectedValue(httpError(404, { error: { code: 'itemNotFound' } }));
      const { listChildren } = await import('../src/index.js');

      const err = await listChildren('at', 'drive-1', undefined, {
        grantedScopes: ['offline_access', 'https://graph.microsoft.com/User.Read'],
      }).catch((e) => e);

      expect(err.status).toBe(404);
      expect(err.scopeMissing).toBe(true);
      expect(err.message).toContain('missing-permission');
    });

    it('does NOT flag a 404 as a missing scope when the scope IS held', async () => {
      mockedAxios.get.mockRejectedValue(httpError(404, { error: { code: 'itemNotFound' } }));
      const { listChildren } = await import('../src/index.js');

      const err = await listChildren('at', 'drive-1', 'gone', {
        grantedScopes: ['https://graph.microsoft.com/Files.Read.All'],
      }).catch((e) => e);

      expect(err.scopeMissing).toBe(false);
    });

    it('says nothing about scopes when the caller supplied no scope list', async () => {
      mockedAxios.get.mockRejectedValue(httpError(404));
      const { listChildren } = await import('../src/index.js');

      const err = await listChildren('at', 'drive-1').catch((e) => e);

      // A false positive would send someone to re-consent a healthy
      // connection; silence is the safer unknown.
      expect(err.scopeMissing).toBe(false);
    });

    it('keeps the plain single-argument constructor working', async () => {
      const { GraphConnectorError } = await import('../src/index.js');
      const err = new GraphConnectorError('nothing else supplied');
      expect(err.message).toBe('nothing else supplied');
      expect(err.status).toBeNull();
      expect(err.scopeMissing).toBe(false);
    });
  });
});
