// SPDX-License-Identifier: Apache-2.0
// Doctor smoke test: spawn scripts/doctor.mjs with a controlled env and
// assert the checks report honestly — env PASSes, the EXACT redirect URI,
// reachability FAILs against ports where nothing listens, exit code 1.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doctor = path.join(demoRoot, 'scripts', 'doctor.mjs');

async function runDoctor(env: Record<string, string>): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileP(process.execPath, [doctor], {
      cwd: demoRoot,
      env: { PATH: process.env.PATH ?? '', DOCTOR_SKIP_DOTENV: '1', ...env },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? '', code: e.code ?? 1 };
  }
}

describe('doctor.mjs', () => {
  it('passes env checks, prints the exact redirect URI, fails unreachable services', async () => {
    const { stdout, code } = await runDoctor({
      PUBLIC_BASE_URL: 'http://localhost:5173',
      CONNECTOR_MS_CLIENT_ID: 'test-client-id',
      CONNECTOR_MS_CLIENT_SECRET: 'test-client-secret',
      CONNECTOR_OAUTH_STATE_SECRET: 'a'.repeat(48),
      CONNECTOR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      // Ports where nothing listens — reachability must FAIL honestly.
      MONGODB_URI: 'mongodb://127.0.0.1:59991/?directConnection=true',
      TEMPORAL_ADDRESS: '127.0.0.1:59992',
    });

    expect(stdout).toContain('PASS  env PUBLIC_BASE_URL');
    expect(stdout).toContain('PASS  env CONNECTOR_MS_CLIENT_ID');
    expect(stdout).toContain('PASS  CONNECTOR_TOKEN_ENCRYPTION_KEY decodes to 32 bytes');
    // The one string the whole 30-minute path hangs on:
    expect(stdout).toContain('http://localhost:5173/api/v1/connectors/microsoft/callback');
    expect(stdout).toContain('FAIL  mongo reachable');
    expect(stdout).toContain('FAIL  temporal reachable');
    expect(code).toBe(1);
  }, 30_000);

  it('fails fast and names each missing env var', async () => {
    const { stdout, code } = await runDoctor({
      // Nothing configured at all; keep reachability quick too.
      MONGODB_URI: 'mongodb://127.0.0.1:59991/?directConnection=true',
      TEMPORAL_ADDRESS: '127.0.0.1:59992',
    });
    expect(stdout).toContain('FAIL  env PUBLIC_BASE_URL');
    expect(stdout).toContain('FAIL  env CONNECTOR_MS_CLIENT_ID');
    expect(stdout).toContain('FAIL  env CONNECTOR_MS_CLIENT_SECRET');
    expect(stdout).toContain('FAIL  env CONNECTOR_OAUTH_STATE_SECRET');
    expect(stdout).toContain('FAIL  env CONNECTOR_TOKEN_ENCRYPTION_KEY');
    expect(code).toBe(1);
  }, 30_000);
});
