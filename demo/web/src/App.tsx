// SPDX-License-Identifier: Apache-2.0
//
// The demo shell — deliberately SMALL. The packages carry the real UI;
// this app only wires <ShelfmarkProvider> (transport, routes, labels,
// providers) and lays two pages plus a search box around the components.
import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  ShelfmarkProvider,
  type PickedScope,
  type ShelfmarkConfig,
  type ShelfmarkLabel,
} from '@shelfmark/ui';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { MapPage } from './pages/MapPage';

export const App: React.FC = () => {
  const navigate = useNavigate();

  // Label vocabulary comes from the server (DEMO_LABELS env) so the demo is
  // configured in one place. Until the fetch lands the label UI is hidden
  // (empty list) — the provider's documented default posture.
  const [labels, setLabels] = useState<ShelfmarkLabel[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/demo/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { labels?: { id: string; label: string }[] } | null) => {
        if (!cancelled && body?.labels) setLabels(body.labels);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const config = useMemo<ShelfmarkConfig>(
    () => ({
      // Same-origin transport: the @shelfmark/api plugin is mounted at
      // /api/v1/connectors (Vite proxies /api to the server in dev). The
      // demo resolver accepts any request, so no auth headers travel.
      transport: { baseUrl: '/api/v1/connectors', headers: () => ({}) },
      routes: {
        connections: '/connections',
        map: (connectionId: string) => `/connections/${connectionId}/map`,
        renderLink: (to, label) => <Link to={to}>{label}</Link>,
        // Carry the picked folder scope as router STATE (not a query param —
        // see the ShelfmarkRoutes contract for why).
        onOpenMap: (connectionId: string, scope: PickedScope) =>
          navigate(`/connections/${connectionId}/map`, { state: scope }),
      },
      labels,
      providers: ['onedrive', 'sharepoint'],
    }),
    [labels, navigate]
  );

  return (
    <ShelfmarkProvider config={config}>
      <div className="mx-auto max-w-5xl px-4 py-6">
        <header className="mb-6 flex items-baseline justify-between">
          <Link to="/connections" className="text-lg font-semibold text-slate-100">
            shelfmark <span className="font-normal text-slate-500">demo</span>
          </Link>
          <span className="text-xs text-slate-500">map → decide → read</span>
        </header>
        <Routes>
          <Route path="/" element={<Navigate to="/connections" replace />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/connections/:connectionId/map" element={<MapPage />} />
          <Route path="*" element={<Navigate to="/connections" replace />} />
        </Routes>
      </div>
    </ShelfmarkProvider>
  );
};
