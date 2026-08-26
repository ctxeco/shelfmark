// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    // Testing Library's auto-cleanup registers itself against the global
    // afterEach; without globals the DOM would leak across tests.
    globals: true,
    // The same shims the package exports to hosts as
    // `@shelfmark/ui/test-setup` — this suite runs on them too, which is
    // what keeps the export honest.
    setupFiles: ['./src/test-setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
