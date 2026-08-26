// SPDX-License-Identifier: Apache-2.0
//
// <ShelfmarkProvider> — the ONE seam between these components and the host
// application. Every coupling the source screens had to their shell (an
// auth header helper, a router, a session's clearance ladder, a users
// endpoint, a window-global locale) maps onto exactly one field of this
// config, which is what makes the components consumable without inheriting
// any of those decisions — the same move @shelfmark/core's ports make for
// the backend.
import React, { createContext, useContext, useMemo } from 'react';
import { setLocale, type LocaleCode } from './i18n/index.js';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion.js';

/** The scope a folder picker carries into the map flow. A null rootFolderId
 * means the drive root — a real value, not an absence. */
export interface PickedScope {
  rootFolderId: string | null;
  rootPath: string | null;
}

export interface ShelfmarkTransport {
  /**
   * Base URL of the @shelfmark/api connector routes as the host mounted
   * them (e.g. '/api/v1/connectors'). Every request these components make
   * is `${baseUrl}<route>` — no other origin is ever contacted.
   */
  baseUrl: string;
  /** Called per request — auth headers, tenant headers, whatever the host's
   * AuthContextResolver expects on the other end. */
  headers(): Record<string, string>;
}

export interface ShelfmarkRoutes {
  /** Path of the host page that renders <Connections/> (back-links). */
  connections: string;
  /** Path of the host page that renders <DriveMap/> for a connection. */
  map(connectionId: string): string;
  /** Renders a host link (router <Link>, plain <a>, …). The components
   * never hardcode an anchor, so the host's routing wins everywhere. */
  renderLink(to: string, label: React.ReactNode): React.ReactNode;
  /** "Start working with these files" — where the host's corpus lives.
   * Absent → the CTA still renders and the click is a no-op. */
  onStartWorking?(scope: { scopePath: string | null; scopeLabel: string }): void;
  /**
   * Navigate to the map flow CARRYING the picked scope — the one navigation
   * renderLink cannot express, because the scope is state, not a path (the
   * consent screen must name the folder the reader just picked, and a query
   * string would make an opaque folder id a bookmarkable claim). Absent →
   * the CTA falls back to renderLink(map(id), …) and the map resolves its
   * scope from the connection's stored root.
   */
  onOpenMap?(connectionId: string, scope: PickedScope): void;
}

/** One offerable sensitivity label. Display text comes from the host —
 * labels are the HOST's vocabulary (LabelPolicy in @shelfmark/core), so
 * there is deliberately no built-in list to fall back to. */
export interface ShelfmarkLabel {
  id: string;
  label: string;
}

/**
 * The cost-model constants the running-total mirror uses. Defaults are the
 * same constants as @shelfmark/core's COST_MODEL — duplicated here BY VALUE
 * because importing @shelfmark/core would drag its Mongo dependency into a
 * browser bundle. The live mirror-vs-server equivalence check (see
 * selectionTotals in DriveMap) is what keeps divergence between the two
 * copies visible: at zero delta the mirror must reproduce the server's own
 * emitted range, and disagreement withdraws the edited range on screen.
 */
export interface ShelfmarkCostModel {
  textLikeExtensions: string[];
  textBytesPerToken: number;
  binaryLowYield: number;
  binaryHighYield: number;
}

export const DEFAULT_COST_MODEL: ShelfmarkCostModel = {
  textLikeExtensions: ['md', 'txt', 'csv'],
  textBytesPerToken: 4,
  binaryLowYield: 50,
  binaryHighYield: 4,
};

export type ShelfmarkProviderId = 'onedrive' | 'sharepoint';

export interface ShelfmarkConfig {
  transport: ShelfmarkTransport;
  routes: ShelfmarkRoutes;
  /**
   * The labels a reader may pick for ingested content. Empty or absent →
   * every label control is hidden and no label travels on the ingest start;
   * the host's LabelPolicy default applies server-side. This replaces the
   * source platform's fixed clearance ladder: the ladder was one host's
   * vocabulary, not the product's.
   */
  labels?: ShelfmarkLabel[];
  costModel?: ShelfmarkCostModel;
  /**
   * How many people can sign in to this workspace — the input to the
   * shared-tenant advisory (JRN-D1's second said-out-loud sentence). The
   * count, never the people. Resolve to null for "could not tell" (renders
   * the honest assume-shared sentence); absent entirely → same.
   */
  collaboratorCount?: () => Promise<number | null>;
  /** Which providers the connect screen offers. Default: both. */
  providers?: ShelfmarkProviderId[];
  locale?: LocaleCode;
  /** Overrides the OS prefers-reduced-motion signal when set. */
  reducedMotion?: boolean;
}

export interface ResolvedShelfmarkConfig extends ShelfmarkConfig {
  labels: ShelfmarkLabel[];
  costModel: ShelfmarkCostModel;
  providers: ShelfmarkProviderId[];
}

const ShelfmarkContext = createContext<ResolvedShelfmarkConfig | null>(null);

export const ShelfmarkProvider: React.FC<{ config: ShelfmarkConfig; children?: React.ReactNode }> = ({
  config,
  children,
}) => {
  const resolved = useMemo<ResolvedShelfmarkConfig>(() => {
    // The locale is set during render, before any child calls t() — the
    // provider is the single writer of the i18n module's state.
    setLocale(config.locale ?? 'en');
    return {
      ...config,
      labels: config.labels ?? [],
      costModel: config.costModel ?? DEFAULT_COST_MODEL,
      providers: config.providers ?? ['onedrive', 'sharepoint'],
    };
  }, [config]);
  return <ShelfmarkContext.Provider value={resolved}>{children}</ShelfmarkContext.Provider>;
};

export function useShelfmark(): ResolvedShelfmarkConfig {
  const ctx = useContext(ShelfmarkContext);
  if (!ctx) {
    throw new Error('useShelfmark: no <ShelfmarkProvider> above this component');
  }
  return ctx;
}

/** The reduced-motion signal, config override first. */
export function useReducedMotion(): boolean {
  const { reducedMotion } = useShelfmark();
  const os = usePrefersReducedMotion();
  return reducedMotion ?? os;
}

/** `${baseUrl}${path}` — the only URL constructor in the package. */
export function apiUrl(transport: ShelfmarkTransport, path: string): string {
  return `${transport.baseUrl}${path}`;
}

/** Display text for a label id: the host's word for it, or — for an id the
 * config does not know — the id verbatim as data (the closed-vocabulary
 * fallback every table in this package uses). */
export function labelDisplay(labels: readonly ShelfmarkLabel[], id: string): string {
  return labels.find((l) => l.id === id)?.label ?? id;
}
