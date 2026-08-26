// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { listDeltaPage, listFolderPage, GraphHttpError } from '../src/index.js';

vi.mock('axios');
const mockedGet = vi.mocked(axios.get);

beforeEach(() => {
  mockedGet.mockReset();
});

// A real 2026-07-25 bug: parentReference.path came back drive-id-prefixed
// ("/drives/{drive-id}/root:/...") and the old regex only stripped the
// singular "/drive/root:" form (never matches this endpoint's actual
// response shape, since listDeltaPage always calls /drives/{driveId}/...),
// so the raw Graph-internal path leaked straight into every document's
// `path` field and was shown to users verbatim in the "chat with this
// folder" scope label.
describe('listDeltaPage path stripping', () => {
  it('strips the /drives/{drive-id}/root: prefix, leaving only the human folder path', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        value: [
          {
            id: 'item-1',
            name: 'implementation-notes.md',
            parentReference: {
              path: '/drives/b!kcqnPdF1OkKlSCLC142D6HE5PyMKMkBLrfsJ0Ut8rLhTnYliAcgYR6kknsvJsUVA/root:/code/Customer-Security-Architecture/secai-framework/implementation',
            },
            file: {},
          },
        ],
      },
    } as any);

    const page = await listDeltaPage('token', 'drive-1', null);

    expect(page.items[0].path).toBe('/code/Customer-Security-Architecture/secai-framework/implementation');
  });

  it('falls back to "/" when parentReference is the drive root itself', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        value: [
          {
            id: 'item-2',
            name: 'readme.md',
            parentReference: {
              path: '/drives/b!kcqnPdF1OkKlSCLC142D6HE5PyMKMkBLrfsJ0Ut8rLhTnYliAcgYR6kknsvJsUVA/root:',
            },
            file: {},
          },
        ],
      },
    } as any);

    const page = await listDeltaPage('token', 'drive-1', null);

    expect(page.items[0].path).toBe('/');
  });

  it('falls back to "/" when parentReference is missing entirely', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { value: [{ id: 'item-3', name: 'orphan.md', file: {} }] },
    } as any);

    const page = await listDeltaPage('token', 'drive-1', null);

    expect(page.items[0].path).toBe('/');
  });
});

// 34-S09b — the map path's revived provider call. Two properties the old
// wrappers never had: HTTP status + Retry-After survive into the error
// (GraphHttpError), and the folder facet's childCount is surfaced so the map
// can count empty folders without a second call.
describe('listFolderPage (map path)', () => {
  it('preserves status and Retry-After on a 429 instead of flattening them into message text', async () => {
    mockedGet.mockRejectedValueOnce({
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': '17' } },
    });

    const err: any = await listFolderPage('token', 'drive-1', null).then(
      () => null,
      (e) => e
    );

    expect(err).toBeInstanceOf(GraphHttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(17);
    expect(err.message).toContain('HTTP 429');
  });

  it('a response-less failure (network error) yields null status and null Retry-After', async () => {
    mockedGet.mockRejectedValueOnce(new Error('socket hang up'));

    const err: any = await listFolderPage('token', 'drive-1', 'folder-1').then(
      () => null,
      (e) => e
    );

    expect(err).toBeInstanceOf(GraphHttpError);
    expect(err.status).toBeNull();
    expect(err.retryAfterSeconds).toBeNull();
  });

  it('an unparseable Retry-After degrades to null, not NaN', async () => {
    mockedGet.mockRejectedValueOnce({
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': 'soon' } },
    });

    const err: any = await listFolderPage('token', 'drive-1', null).then(
      () => null,
      (e) => e
    );

    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBeNull();
  });

  it('an HTTP-date Retry-After is parsed to whole seconds — the unified parser reads both RFC forms', async () => {
    // The walk client's original parser only understood delta-seconds and
    // dropped the HTTP-date form to null; the merged parser (httpError.ts)
    // reads both, so a date now yields an actionable wait.
    mockedGet.mockRejectedValueOnce({
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': 'Thu, 01 Jan 2032 00:00:00 GMT' } },
    });

    const err: any = await listFolderPage('token', 'drive-1', null).then(
      () => null,
      (e) => e
    );

    expect(err.status).toBe(429);
    expect(typeof err.retryAfterSeconds).toBe('number');
    expect(Number.isFinite(err.retryAfterSeconds)).toBe(true);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('a present-but-EMPTY Retry-After degrades to null, not to retry-immediately', async () => {
    // Number('') === 0, so a blank header used to read as "wait 0 seconds" —
    // five back-to-back retries against the very throttle asking us to slow
    // down. Blank means the server said nothing usable; the policy backoff
    // (null) is the honest reading, same as an absent header.
    mockedGet.mockRejectedValueOnce({
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': '  ' } },
    });

    const err: any = await listFolderPage('token', 'drive-1', null).then(
      () => null,
      (e) => e
    );

    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBeNull();
  });

  it('surfaces childCount from the folder facet ($select=folder returns the whole facet) and null for files', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        value: [
          { id: 'fld-1', name: 'Docs', folder: { childCount: 3 }, size: 12345 },
          { id: 'fld-2', name: 'Empty', folder: { childCount: 0 }, size: 0 },
          { id: 'f-1', name: 'a.md', file: {}, size: 10 },
        ],
      },
    } as any);

    const page = await listFolderPage('token', 'drive-1', null);

    expect(page.items[0].childCount).toBe(3);
    expect(page.items[1].childCount).toBe(0); // zero survives (empty-folder count depends on it)
    expect(page.items[2].childCount).toBeNull();
  });
});
