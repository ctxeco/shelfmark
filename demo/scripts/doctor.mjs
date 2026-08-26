// SPDX-License-Identifier: Apache-2.0
//
// `pnpm doctor` — the demo preflight. Checks every required env var, prints
// the EXACT redirect URI to register in the Entra app, and pings Mongo and
// Temporal. Pass/fail per check; exit 1 if anything failed. This script is
// what makes the 30-minute path real: every misconfiguration it catches is
// one that would otherwise surface as a broken OAuth round trip.
//
// Plain Node ESM, no build step. Reads demo/.env (existing process env wins).
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoRoot = path.resolve(here, '..');

// ── Tiny .env loader (mirrors src/env.ts; process env always wins) ──────────
// DOCTOR_SKIP_DOTENV=1 skips the file entirely — the smoke test uses it so a
// developer's real demo/.env can never leak into the assertions.
try {
  if (process.env.DOCTOR_SKIP_DOTENV) throw new Error('skipped');
  const text = readFileSync(path.join(demoRoot, '.env'), 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // No .env — env may come from the shell/compose; the checks below decide.
}

let failed = 0;
const pass = (name, detail) => console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, detail) => {
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

const looksUnfilled = (v) => v.startsWith('<') || v.includes('openssl rand');

// ── 1. Required env vars ────────────────────────────────────────────────────
const REQUIRED = [
  ['PUBLIC_BASE_URL', 'builds the OAuth redirect URIs; no default by design'],
  ['CONNECTOR_MS_CLIENT_ID', 'Entra app registration client id'],
  ['CONNECTOR_MS_CLIENT_SECRET', 'Entra app registration client secret value'],
  ['CONNECTOR_OAUTH_STATE_SECRET', 'signs the OAuth state JWT (>= 32 bytes)'],
  ['CONNECTOR_TOKEN_ENCRYPTION_KEY', 'base64 of exactly 32 bytes (AES-256-GCM)'],
];
for (const [name, hint] of REQUIRED) {
  const value = process.env[name]?.trim();
  if (!value) fail(`env ${name}`, `missing — ${hint}`);
  else if (looksUnfilled(value)) fail(`env ${name}`, 'still the .env.example placeholder');
  else pass(`env ${name}`);
}

// Format checks that would otherwise fail at boot with the same names.
const stateSecret = process.env.CONNECTOR_OAUTH_STATE_SECRET?.trim() ?? '';
if (stateSecret && !looksUnfilled(stateSecret)) {
  if (Buffer.byteLength(stateSecret, 'utf8') >= 32) pass('CONNECTOR_OAUTH_STATE_SECRET length (>= 32 bytes)');
  else fail('CONNECTOR_OAUTH_STATE_SECRET length', 'must be at least 32 bytes — `openssl rand -base64 48`');
}
const dek = process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY?.trim() ?? '';
if (dek && !looksUnfilled(dek)) {
  if (Buffer.from(dek, 'base64').length === 32) pass('CONNECTOR_TOKEN_ENCRYPTION_KEY decodes to 32 bytes');
  else fail('CONNECTOR_TOKEN_ENCRYPTION_KEY', 'must be base64 of exactly 32 bytes — `openssl rand -base64 32`');
}

// ── 2. The redirect URI to register ─────────────────────────────────────────
const base = (process.env.PUBLIC_BASE_URL?.trim() ?? '').replace(/\/$/, '');
if (base && !looksUnfilled(base)) {
  console.log('');
  console.log('Register this EXACT redirect URI (type Web) on the Entra app:');
  console.log('');
  console.log(`    ${base}/api/v1/connectors/microsoft/callback`);
  console.log('');
}

// ── 3. Reachability ─────────────────────────────────────────────────────────
async function checkMongo() {
  const uri = process.env.MONGODB_URI?.trim() || 'mongodb://localhost:27017';
  try {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      pass('mongo reachable', uri);
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err) {
    fail('mongo reachable', `${uri} — ${err.message}`);
  }
}

function checkTemporal() {
  const address = process.env.TEMPORAL_ADDRESS?.trim() || 'localhost:7233';
  const [host, portRaw] = address.split(':');
  const port = Number(portRaw || 7233);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    const done = (ok, detail) => {
      socket.destroy();
      if (ok) pass('temporal reachable', address);
      else fail('temporal reachable', `${address} — ${detail}`);
      resolve();
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'connect timeout'));
    socket.once('error', (err) => done(false, err.message));
  });
}

await checkMongo();
await checkTemporal();

console.log('');
if (failed > 0) {
  console.log(`doctor: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('doctor: all checks passed');
