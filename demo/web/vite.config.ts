// SPDX-License-Identifier: Apache-2.0
//
// Vite config for the demo web app. Run from demo/ as `vite web` /
// `vite build web` — this file sits in the app root. Dev: the server here
// proxies /api to the Fastify server on :8787, so the browser sees ONE
// origin and PUBLIC_BASE_URL=http://localhost:5173 covers both the pages
// and the OAuth callback. Build: emits to demo/dist/web, which the Fastify
// server serves statically when it exists.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';
import type { Config as TailwindConfig } from 'tailwindcss';
import shelfmarkPreset from '@shelfmark/ui/tailwind-preset';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(webRoot, '..', 'dist', 'web'),
    emptyOutDir: true,
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          // The preset's darkMode tuple is typed [string, string]; Tailwind's
          // Config wants the literal 'selector' tuple. Runtime shape is
          // exactly what Tailwind documents — widen through unknown.
          presets: [shelfmarkPreset as unknown as TailwindConfig],
          content: [
            path.join(webRoot, 'index.html'),
            path.join(webRoot, 'src/**/*.{ts,tsx}'),
            // The @shelfmark/ui components carry the utility classes; scan
            // the built package so Tailwind generates what they use.
            path.resolve(webRoot, '..', '..', 'packages', 'ui', 'dist', '**', '*.js'),
          ],
        }),
        autoprefixer(),
      ],
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
});
