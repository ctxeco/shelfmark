// SPDX-License-Identifier: Apache-2.0
//
// Side-effect .env loader for the demo processes. Imported FIRST (before any
// @shelfmark/* import) so env-at-module-load consumers — notably
// @shelfmark/graph, which captures CONNECTOR_MS_CLIENT_ID/SECRET when its
// oauth module is evaluated — see the values from demo/.env. ESM evaluates
// dependencies in import-declaration order, so `import './env.js'` as the
// first import of server.ts/worker.ts is a real ordering guarantee, not a
// stylistic one.
//
// Deliberately tiny instead of a dotenv dependency: KEY=VALUE lines, `#`
// comments, optional surrounding quotes. Existing process env always wins —
// docker-compose and CI set real env and must not be overridden by a stray
// local file.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse simple KEY=VALUE lines. Exported for the doctor's reuse via dist. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(envPath: string): void {
  let text: string;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return; // No .env is fine — compose/CI provide real env.
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Both src/env.ts (tsx dev) and dist/env.js (built) sit one level below the
// demo package root, so `../.env` is demo/.env from either location.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.resolve(here, '..', '.env'));
