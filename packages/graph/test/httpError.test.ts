// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { extractHttpErrorDetails, parseRetryAfter } from '../src/httpError.js';

const NOW = Date.parse('2026-08-19T12:00:00Z');

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120);
    expect(parseRetryAfter(90, NOW)).toBe(90);
  });

  it('reads an HTTP-date and converts it to seconds from now', () => {
    expect(parseRetryAfter('Wed, 19 Aug 2026 12:02:00 GMT', NOW)).toBe(120);
  });

  it('clamps an already-past HTTP-date to 0 rather than going negative', () => {
    // A negative wait is not something a caller can act on.
    expect(parseRetryAfter('Wed, 19 Aug 2026 11:59:00 GMT', NOW)).toBe(0);
  });

  it('keeps 0 as 0, distinct from "absent"', () => {
    expect(parseRetryAfter('0', NOW)).toBe(0);
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
  });

  it('returns null for anything unparseable', () => {
    expect(parseRetryAfter('soon', NOW)).toBeNull();
    expect(parseRetryAfter('', NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter({}, NOW)).toBeNull();
  });
});

describe('extractHttpErrorDetails', () => {
  it('returns null status for a transport failure that never got an answer', () => {
    // Not 0, not 500 — "we never got an answer" is its own state.
    expect(extractHttpErrorDetails(new Error('ECONNREFUSED'), NOW)).toEqual({
      status: null,
      retryAfterSeconds: null,
      providerErrorCode: null,
    });
  });

  it('reads status, Retry-After and a Graph error code', () => {
    const err = {
      response: {
        status: 429,
        headers: { 'retry-after': '17' },
        data: { error: { code: 'activityLimitReached', message: 'Throttled' } },
      },
    };

    expect(extractHttpErrorDetails(err, NOW)).toEqual({
      status: 429,
      retryAfterSeconds: 17,
      providerErrorCode: 'activityLimitReached',
    });
  });

  it('finds the header whatever its casing', () => {
    const err = { response: { status: 503, headers: { 'Retry-After': '5' }, data: {} } };
    expect(extractHttpErrorDetails(err, NOW).retryAfterSeconds).toBe(5);
  });

  it('reads a header bag that exposes a getter, as axios does', () => {
    const err = {
      response: {
        status: 429,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '11' : null) },
        data: {},
      },
    };
    expect(extractHttpErrorDetails(err, NOW).retryAfterSeconds).toBe(11);
  });

  it('prefers Google’s string status over its NUMERIC error.code', () => {
    const err = { response: { status: 403, headers: {}, data: { error: { code: 403, status: 'PERMISSION_DENIED' } } } };
    // Without the string guard this returns "403", shadowing the only part
    // of the payload that says anything useful.
    expect(extractHttpErrorDetails(err, NOW).providerErrorCode).toBe('PERMISSION_DENIED');
  });

  it('falls back to Google’s first error reason', () => {
    const err = {
      response: { status: 403, headers: {}, data: { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } } },
    };
    expect(extractHttpErrorDetails(err, NOW).providerErrorCode).toBe('userRateLimitExceeded');
  });

  it('reads the flat OAuth error shape', () => {
    const err = { response: { status: 400, headers: {}, data: { error: 'invalid_grant' } } };
    expect(extractHttpErrorDetails(err, NOW).providerErrorCode).toBe('invalid_grant');
  });

  it('survives a response with no body at all', () => {
    expect(extractHttpErrorDetails({ response: { status: 500 } }, NOW)).toEqual({
      status: 500,
      retryAfterSeconds: null,
      providerErrorCode: null,
    });
  });

  it('ignores a non-numeric status instead of inventing one', () => {
    expect(extractHttpErrorDetails({ response: { status: 'oops' } }, NOW).status).toBeNull();
  });
});
