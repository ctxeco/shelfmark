// SPDX-License-Identifier: Apache-2.0
// jsdom shims for hosts (and this package's own suite) testing these
// components. Import as `@shelfmark/ui/test-setup` from a vitest/jest
// setupFiles entry.
import '@testing-library/jest-dom/vitest';

// @tanstack/react-virtual (the prune report and the ledger) needs its scroll
// container to report a real size; jsdom's layout engine always reports 0,
// which makes every row estimate as out-of-view and renders an empty list in
// tests. A fixed, generous fake size + a callback-invoking ResizeObserver
// keeps virtualized components testable without mocking the library itself.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;

// Must actually invoke the callback (with a synthetic size) on observe() —
// @tanstack/react-virtual waits for a ResizeObserver entry before it
// considers the scroll container measured at all; a fully no-op mock left
// it permanently unmeasured and every row out of the visible range.
(globalThis as any).ResizeObserver = class {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
};

// jsdom doesn't implement scrollIntoView at all — a no-op is all any test
// needs here, same "jsdom is missing a browser API" class of gap as the
// ResizeObserver patch above.
HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

// jsdom doesn't implement matchMedia either — usePrefersReducedMotion calls
// it for the initial read and the live OS-change listener. A no-op-but-
// correctly-shaped stub covers every test that doesn't specifically assert
// on reduced-motion behavior; tests that do can override window.matchMedia
// per-test. Guarded so a per-test override isn't clobbered.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}
