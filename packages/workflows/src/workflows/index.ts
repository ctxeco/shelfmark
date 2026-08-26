// SPDX-License-Identifier: Apache-2.0
// The workflow-bundle entry — the file a Temporal worker's `workflowsPath`
// points at (also exported unbuilt as `@shelfmark/workflows/workflows-source`
// for Temporal's bundler). Temporal registers workflow TYPES from this
// module's exported functions, so it exports EXACTLY the three workflows and
// nothing else: an extra exported function here would register a bogus
// workflow type. The (type, queue) contract with host start helpers is
// pinned by test/workflowRegistration.test.ts.
export { driveMapWorkflow } from './driveMap';
export { selectiveIngestWorkflow } from './selectiveIngest';
export { connectorSyncWorkflow } from './sync';
