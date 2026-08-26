// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Plan 34-S09 — the first prefers-reduced-motion pathway in this design
 * system, and the precedent for every one after it. Two halves, use the
 * right one:
 *
 *   - CSS-driven motion (transitions, @keyframes) is silenced in CSS:
 *     see the `@keyframes rise-in` block in styles.css, whose utility
 *     class carries a baked-in `@media (prefers-reduced-motion: reduce)`
 *     override so no call site can forget it.
 *   - JS-driven motion (reveal timers, staged morphs, anything a media
 *     query cannot reach) uses THIS hook and branches: reduced means the
 *     full result immediately, not a faster version of the theatre.
 *
 * Live-updating: flipping the OS setting mid-session takes effect without
 * a reload, because a reader who just turned animations off has answered
 * the question and should not have to win an argument with a mounted
 * component. Defensive on `window.matchMedia` (jsdom lacks it natively;
 * the test setup stubs it) — absent means `false`, never a crash.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    if (typeof mql.addEventListener !== 'function') return; // ancient engine: initial read stands
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
