// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The workflow suites stand up a real time-skipping Temporal test server
    // (the only way to genuinely exercise continueAsNew, retry and
    // failure-handling — not just type-check the files). Give them room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
