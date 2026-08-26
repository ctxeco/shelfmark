// SPDX-License-Identifier: Apache-2.0
// The map page: the packaged <DriveMap/> flow (consent → live narration →
// landing → decide → ingest) for one connection. The picked folder scope
// arrives as router state from routes.onOpenMap; a deep link or refresh has
// none and DriveMap resolves the scope from the connection's stored root.
import React from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { DriveMap, type PickedScope } from '@shelfmark/ui';

export const MapPage: React.FC = () => {
  const { connectionId } = useParams<{ connectionId: string }>();
  const location = useLocation();
  const scope = (location.state as PickedScope | null) ?? null;

  if (!connectionId) return null;

  return (
    <div className="space-y-4">
      <Link to="/connections" className="text-sm text-slate-400 hover:text-slate-200">
        &larr; connections
      </Link>
      <DriveMap connectionId={connectionId} scope={scope} />
    </div>
  );
};
