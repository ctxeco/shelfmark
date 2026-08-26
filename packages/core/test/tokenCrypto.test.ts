// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import { decryptToken, encryptToken } from '../src/tokenCrypto.js';

beforeEach(() => {
  process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

afterEach(() => {
  delete process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY;
});

describe('tokenCrypto', () => {
  it('round-trips a plaintext refresh token', () => {
    const plaintext = 'M.R3_BAY.some-fake-refresh-token-value';
    const encrypted = encryptToken(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext/iv on every call (no nonce reuse)', () => {
    const a = encryptToken('same-plaintext');
    const b = encryptToken('same-plaintext');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails closed on a tampered auth tag', () => {
    const encrypted = encryptToken('secret-value');
    const tampered = { ...encrypted, tag: Buffer.from(encrypted.tag, 'base64').fill(0).toString('base64') };
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('throws when the encryption key is missing', () => {
    delete process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken('x')).toThrow(/CONNECTOR_TOKEN_ENCRYPTION_KEY/);
  });

  it('throws when the encryption key is the wrong length', () => {
    process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    expect(() => encryptToken('x')).toThrow(/32 bytes/);
  });
});
