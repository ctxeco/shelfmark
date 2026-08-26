// SPDX-License-Identifier: Apache-2.0
//
// Tailwind preset for hosts rendering @shelfmark/ui components.
//
//   // tailwind.config.js
//   import shelfmark from '@shelfmark/ui/tailwind-preset';
//   export default { presets: [shelfmark], content: [ ...your globs...,
//     './node_modules/@shelfmark/ui/dist/**/*.js' ] };
//
// The colors read the CSS variables shipped in `@shelfmark/ui/styles.css`
// (import that file, or copy its blocks into your own sheet). Only the
// shades these components actually pair across themes are variable-mapped:
// the slate ramp (the entire chrome), and the accent `-400` text shades with
// their `-950` badge backgrounds — every `bg-{hue}-950/NN text-{hue}-400`
// status pill flips to a readable light-mode pill without per-call-site
// patches. Other shades of the same hues stay plain Tailwind literals
// because they already read acceptably on both backgrounds.
//
// The `light:` variant reads `[data-theme="light"]` on an ancestor — the
// host sets that attribute (see styles.css); dark is the default posture.

const v = (name: string) => `rgb(var(--color-${name}) / <alpha-value>)`;

const preset = {
  darkMode: ['selector', '[data-theme="dark"]'] as [string, string],
  theme: {
    extend: {
      colors: {
        slate: {
          50: v('slate-50'),
          100: v('slate-100'),
          200: v('slate-200'),
          300: v('slate-300'),
          400: v('slate-400'),
          500: v('slate-500'),
          600: v('slate-600'),
          700: v('slate-700'),
          800: v('slate-800'),
          900: v('slate-900'),
          950: v('slate-950'),
        },
        blue: { 400: v('blue-400'), 950: v('blue-950') },
        emerald: { 400: v('emerald-400'), 950: v('emerald-950') },
        rose: { 400: v('rose-400'), 950: v('rose-950') },
        amber: { 400: v('amber-400'), 950: v('amber-950') },
        violet: { 300: v('violet-300'), 400: v('violet-400'), 950: v('violet-950') },
        sky: { 400: v('sky-400') },
        /** "lighten in dark mode / darken in light mode" wash — for glass
         * chrome where the fix direction flips per theme. */
        overlay: v('overlay'),
      },
    },
  },
  plugins: [
    // `light:x` reads as "x, but only when the light theme is active" —
    // the natural complement to dark-by-default utilities, without
    // inverting the mental model to `dark:` everywhere.
    function ({ addVariant }: { addVariant: (name: string, definition: string) => void }) {
      addVariant('light', ':is([data-theme="light"] &)');
    },
  ],
};

export default preset;
