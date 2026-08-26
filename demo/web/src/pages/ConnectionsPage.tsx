// SPDX-License-Identifier: Apache-2.0
// The connections page: the packaged <Connections/> screen plus the demo
// search box over the FsDocumentSink corpus. OAuth callback query params
// (?error / ?connected&connectionId) are read here and cleared once the
// component has acted on them (onNoticeConsumed).
import React, { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Connections } from '@shelfmark/ui';
import { SearchBox } from '../components/SearchBox';

export const ConnectionsPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const oauthError = params.get('error');
  const autoBrowseConnectionId = params.get('connectionId');

  const onNoticeConsumed = useCallback(() => {
    setParams({}, { replace: true });
  }, [setParams]);

  return (
    <div className="space-y-8">
      <SearchBox />
      <Connections
        oauthError={oauthError}
        autoBrowseConnectionId={autoBrowseConnectionId}
        onNoticeConsumed={onNoticeConsumed}
      />
    </div>
  );
};
