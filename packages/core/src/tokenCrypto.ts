// SPDX-License-Identifier: Apache-2.0
// Envelope encryption for connector OAuth refresh tokens (plan: document
// ingestion connectors). A refresh token is a per-tenant, runtime-created
// secret (minted when a tenant admin completes an OAuth flow) — unlike
// static, deploy-time secrets that are synced from the deployment's secret
// store into env vars, a refresh token has nowhere to be provisioned ahead
// of time. Storing ciphertext in the database alongside a single
// per-environment data-encryption-key (DEK) — sourced the same way every
// other static secret is — keeps this consistent with the existing
// static-secret pattern rather than requiring dynamic runtime writes to the
// secret store.
//
// Unification note: this module originally lived as a byte-for-byte
// duplicate in two independently deployed services — the API edge (which
// encrypts at OAuth-callback time) and the sync worker (which decrypts to
// refresh/use the token during a sync). Each side decrypts what the other
// encrypted, so the two copies had to stay algorithm-compatible forever;
// eliminating that load-bearing duplication is the point of this shared
// module. Any change here is a wire-format change for every stored token:
// coordinate a re-encryption migration before altering the algorithm, IV
// size, tag length, or DEK sourcing.
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, the AES-GCM standard/recommended size

export interface EncryptedToken {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
}

function getDek(): Buffer {
  const raw = process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY || '';
  if (!raw) {
    throw new Error('CONNECTOR_TOKEN_ENCRYPTION_KEY is not configured');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('CONNECTOR_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)');
  }
  return key;
}

export function encryptToken(plaintext: string): EncryptedToken {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getDek(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptToken(encrypted: EncryptedToken): string {
  const decipher = createDecipheriv(ALGORITHM, getDek(), Buffer.from(encrypted.iv, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
