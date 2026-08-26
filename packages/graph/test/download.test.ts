// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { downloadFile, GraphHttpError } from '../src/index.js';

vi.mock('axios');
const mockedGet = vi.mocked(axios.get);

beforeEach(() => {
  mockedGet.mockReset();
});

describe('downloadFile', () => {
  it('returns the file bytes and encodes ids into the request path', async () => {
    mockedGet.mockResolvedValueOnce({ data: Buffer.from('file bytes here') } as any);

    const bytes = await downloadFile('token', 'drive-1', 'item/../7?x=1');

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString('utf8')).toBe('file bytes here');
    const [url, config] = mockedGet.mock.calls[0] as any[];
    expect(url).not.toContain('/../');
    expect(url).toContain(encodeURIComponent('item/../7?x=1'));
    expect(config.responseType).toBe('arraybuffer');
  });

  // ---- 34-S09c sanctioned fix: downloads are the highest-volume call ------

  it('a 429 carries status and Retry-After instead of a flattened sentence', async () => {
    mockedGet.mockRejectedValueOnce({
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': '30' } },
    });

    const err: any = await downloadFile('token', 'drive-1', 'item-9').then(
      () => null,
      (e) => e
    );

    expect(err).toBeInstanceOf(GraphHttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.isThrottled).toBe(true);
    expect(err.message).toContain('item-9');
  });

  it('a blank Retry-After reads as null — never as retry-now', async () => {
    // Number('') === 0, so a blank header must NOT be read as "wait 0
    // seconds"; blank means the server said nothing usable, same as absent.
    mockedGet.mockRejectedValueOnce({
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': '' } },
    });

    const err: any = await downloadFile('token', 'drive-1', 'item-9').then(
      () => null,
      (e) => e
    );

    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBeNull();
  });

  it('a transport failure that never got an answer yields null status', async () => {
    mockedGet.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const err: any = await downloadFile('token', 'drive-1', 'item-9').then(
      () => null,
      (e) => e
    );

    expect(err).toBeInstanceOf(GraphHttpError);
    expect(err.status).toBeNull();
    expect(err.retryAfterSeconds).toBeNull();
  });
});
