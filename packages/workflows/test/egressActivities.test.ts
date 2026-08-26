// SPDX-License-Identifier: Apache-2.0
// The egress gate crossings — ported postures from the source system's
// policy-sidecar checks, restated against the EgressGate port:
// absent gate = allow (a documented configuration decision), broken gate =
// RETRYABLE typed failure (fail closed, never proceed-as-allowed), denial =
// non-retryable typed failure (an answer, not an outage). And the two checks
// stay two different QUESTIONS — the map one never asserts a label, because
// the first live map in the source system died on exactly that category
// error (a tenant-level walk asked a content-level question).
import { describe, expect, it } from 'vitest';
import type { DocumentSink, EgressGate, ShelfmarkPorts } from '@shelfmark/core';
import {
  createEgressActivities,
  CLOUD_EGRESS_DENIED_ERROR_TYPE,
  EGRESS_GATE_UNREACHABLE_ERROR_TYPE,
  MAP_EGRESS_DENIED_ERROR_TYPE,
} from '../src/index';
import { fakeStore, type FakeData } from './fakeStore';

const noSink: DocumentSink = {
  accept: async () => ({ status: 'failed', error: 'unused' }),
};

function portsWith(gate?: EgressGate): ShelfmarkPorts {
  return { sink: noSink, resolveAuth: async () => null, ...(gate ? { egressGate: gate } : {}) };
}

function actsWith(gate?: EgressGate) {
  const data: FakeData = {};
  return createEgressActivities({ store: fakeStore(data), ports: portsWith(gate) });
}

describe('absent gate — allow is a configuration decision, not an accident', () => {
  it('both checks pass without a gate configured', async () => {
    const acts = actsWith(undefined);
    await expect(acts.checkCloudEgressAllowed('ACME-01', 'general')).resolves.toBeUndefined();
    await expect(acts.checkMapEgressAllowed('ACME-01')).resolves.toBeUndefined();
  });
});

describe('configured gate — asked the right question, answered honestly', () => {
  it('passes the tenant and label to checkCloudEgress, and ONLY the tenant to checkMapEgress', async () => {
    const questions: unknown[] = [];
    const acts = actsWith({
      checkCloudEgress: async (q) => {
        questions.push(['cloud', q]);
        return { allowed: true };
      },
      checkMapEgress: async (q) => {
        questions.push(['map', q]);
        return { allowed: true };
      },
    });
    await acts.checkCloudEgressAllowed('ACME-01', 'restricted');
    await acts.checkMapEgressAllowed('ACME-01');
    expect(questions).toEqual([
      ['cloud', { tenantId: 'ACME-01', label: 'restricted' }],
      // A map opens no documents, so no label is asserted — the tenant-level
      // question, whole and alone.
      ['map', { tenantId: 'ACME-01' }],
    ]);
  });

  it('a cloud denial is NON-retryable and typed, carrying the gate\'s own reason', async () => {
    const acts = actsWith({
      checkCloudEgress: async () => ({ allowed: false, reason: 'label restricted to on-prem' }),
      checkMapEgress: async () => ({ allowed: true }),
    });
    await expect(acts.checkCloudEgressAllowed('ACME-01', 'restricted')).rejects.toMatchObject({
      type: CLOUD_EGRESS_DENIED_ERROR_TYPE,
      nonRetryable: true,
      message: expect.stringContaining('label restricted to on-prem'),
    });
  });

  it('a map denial is NON-retryable and typed', async () => {
    const acts = actsWith({
      checkCloudEgress: async () => ({ allowed: true }),
      checkMapEgress: async () => ({ allowed: false, reason: 'tenant posture unknown' }),
    });
    await expect(acts.checkMapEgressAllowed('ACME-01')).rejects.toMatchObject({
      type: MAP_EGRESS_DENIED_ERROR_TYPE,
      nonRetryable: true,
    });
  });
});

describe('broken gate — fail closed, RETRYABLE (a missing gate is a decision; a broken gate is an outage)', () => {
  const broken: EgressGate = {
    checkCloudEgress: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    checkMapEgress: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  };

  it('a throwing gate becomes EgressGateUnreachable — retryable, never allowed-by-default', async () => {
    const acts = actsWith(broken);
    await expect(acts.checkCloudEgressAllowed('ACME-01', 'general')).rejects.toMatchObject({
      type: EGRESS_GATE_UNREACHABLE_ERROR_TYPE,
      nonRetryable: false,
      message: expect.stringContaining('failing closed'),
    });
    await expect(acts.checkMapEgressAllowed('ACME-01')).rejects.toMatchObject({
      type: EGRESS_GATE_UNREACHABLE_ERROR_TYPE,
      nonRetryable: false,
    });
  });
});
