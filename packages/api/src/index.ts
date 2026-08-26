// SPDX-License-Identifier: Apache-2.0
// @shelfmark/api — the Fastify HTTP surface over the shelfmark connector.
export { shelfmarkApi, default } from './plugin.js';
export type {
  MapStreamConfig,
  RouteContext,
  ShelfmarkApiConfig,
  ShelfmarkApiOptions,
} from './types.js';
export { openSseStream, type SseSink, type SseStream, type SseStreamOptions } from './sse.js';
export {
  connectionAccessToken,
  forgetConnectionTokens,
  type ConnectionAccessToken,
  type ConnectionAccessTokenParams,
  type ProviderTokens,
} from './tokenCache.js';
export {
  CONNECTOR_SYNC_WORKFLOW,
  DRIVE_MAP_WORKFLOW,
  SELECTIVE_INGEST_WORKFLOW,
  connectorSyncWorkflowId,
  createWorkflowStarters,
  driveMapWorkflowId,
  selectiveIngestWorkflowId,
  type WorkflowStartClient,
  type WorkflowStarters,
} from './workflowStarters.js';
