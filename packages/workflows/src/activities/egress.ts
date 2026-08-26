// SPDX-License-Identifier: Apache-2.0
// The egress gate crossings — the second slice of the source Graph-activities
// module's three-way split. In the source system these two checks called a
// policy sidecar over HTTP; here they call the host's `EgressGate` port, and
// every posture below is the ported one:
//
//   * ABSENT gate → allow. A missing gate is a decision the host made in
//     configuration (ALLOW_ALL_EGRESS is the documented default).
//   * CONFIGURED gate that THROWS → a RETRYABLE typed failure
//     ('EgressGateUnreachable'). Fail closed: the run pauses and retries; it
//     never proceeds as if allowed. A missing gate is a decision; a broken
//     gate is an outage.
//   * Gate says no → a NON-retryable typed failure. A denial is an answer,
//     and retrying an answer is how a denied tenant's run burns five
//     attempts discovering the same fact.
//
// The two checks are deliberately DIFFERENT QUESTIONS (a lesson paid for in
// production, on the first live map): a map opens no documents, so asking
// "what is this content's label?" at map time guarantees a wrong answer —
// the label question was deliberately deferred until ingest. The map's
// question is the tenant-level one — may this tenant run a metadata map at
// all — which is why `EgressGate` has two methods instead of one with a
// nullable label.
import { ApplicationFailure } from '@temporalio/activity';
import { ALLOW_ALL_EGRESS, type EgressDecision } from '@shelfmark/core';
import type { ShelfmarkWorkflowDeps } from '../deps';

/** Retryable: the gate exists but could not answer. The run waits. */
export const EGRESS_GATE_UNREACHABLE_ERROR_TYPE = 'EgressGateUnreachable';
/** Non-retryable: the gate answered no to cloud egress at this label. */
export const CLOUD_EGRESS_DENIED_ERROR_TYPE = 'CloudEgressDenied';
/** Non-retryable: the gate answered no to running a map for this tenant. */
export const MAP_EGRESS_DENIED_ERROR_TYPE = 'MapEgressDenied';

function gateUnreachable(question: string, err: unknown): ApplicationFailure {
  return ApplicationFailure.create({
    type: EGRESS_GATE_UNREACHABLE_ERROR_TYPE,
    // Retryable on purpose — see the fail-closed contract in ports.ts.
    nonRetryable: false,
    message: `Egress gate unreachable answering ${question} — failing closed: ${(err as Error).message}`,
  });
}

export function createEgressActivities(deps: ShelfmarkWorkflowDeps) {
  const gate = deps.ports.egressGate ?? ALLOW_ALL_EGRESS;

  return {
    /** May this tenant's content (at this label) leave for cloud processing?
     *  Consulted before any download-and-hand-off phase. */
    async checkCloudEgressAllowed(tenantId: string, label: string): Promise<void> {
      let decision: EgressDecision;
      try {
        decision = await gate.checkCloudEgress({ tenantId, label });
      } catch (err) {
        throw gateUnreachable('checkCloudEgress', err);
      }
      if (!decision.allowed) {
        throw ApplicationFailure.create({
          nonRetryable: true,
          type: CLOUD_EGRESS_DENIED_ERROR_TYPE,
          message: `Cloud egress denied for tenant ${tenantId} at label ${label}: ${decision.reason}`,
        });
      }
    },

    /** May this tenant run a metadata map at all? The tenant-level question —
     *  the map classifies nothing, so no label is asserted here. */
    async checkMapEgressAllowed(tenantId: string): Promise<void> {
      let decision: EgressDecision;
      try {
        decision = await gate.checkMapEgress({ tenantId });
      } catch (err) {
        throw gateUnreachable('checkMapEgress', err);
      }
      if (!decision.allowed) {
        throw ApplicationFailure.create({
          nonRetryable: true,
          type: MAP_EGRESS_DENIED_ERROR_TYPE,
          message: `Map egress denied for tenant ${tenantId}: ${decision.reason}`,
        });
      }
    },
  };
}

export type EgressActivities = ReturnType<typeof createEgressActivities>;
