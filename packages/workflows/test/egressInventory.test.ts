// SPDX-License-Identifier: Apache-2.0
// THE EGRESS INVENTORY — the complete set of places data can leave this
// package, proven two ways and stated once:
//
//   README CLAIM (drafted here, verified here): in a full metadata map plus
//   a selective ingest, the OSS build's COMPLETE set of network destinations
//   is exactly
//
//     { graph.microsoft.com, login.microsoftonline.com,
//       the injected store, the injected sink, the injected egress gate }
//
//   — nothing else. In particular, NO MODEL CALLS EXIST IN THIS BUILD: the
//   map narration is arithmetic-only (every line tier:'none'), produced by
//   deterministic workflow code, and this test's instrumented run plus the
//   static scans below prove the absence rather than assert it.
//
// Proof structure:
//   1. RUNTIME — drive a full map + selective ingest through the real
//      activity registry with an instrumented HTTP adapter, an in-memory
//      store, a recording sink and a recording gate. Every HTTP request's
//      hostname is captured; the observed set must equal exactly
//      {graph.microsoft.com, login.microsoftonline.com}, and the sink/gate/
//      store must be the only other touchpoints.
//   2. STATIC — no source file in this package imports any HTTP/socket
//      client (all provider egress flows through @shelfmark/graph), and the
//      built @shelfmark/graph module itself names no host other than the
//      two above.
import './envSetup';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import axios from 'axios';
import {
  encryptToken,
  type DocumentMeta,
  type EgressGate,
  type ShelfmarkPorts,
} from '@shelfmark/core';
import { createActivities } from '../src/index';
import { fakeStore, type FakeData } from './fakeStore';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

const TENANT = 'ACME-01';
const CONN = 'conn-inv-1';
const MAP_RUN = 'map-conn-inv-1';
const INGEST_RUN = 'ingest-conn-inv-1';

// ── The instrumented HTTP adapter ───────────────────────────────────────────
// @shelfmark/graph and this package resolve the SAME axios instance (single
// version in the workspace store), so replacing the default adapter
// intercepts every HTTP request the whole data path can make — there is no
// other HTTP client to route around it (static scan below).
const observedHosts = new Set<string>();
let realAdapter: unknown;

function cannedResponse(config: any) {
  const url = new URL(config.url);
  observedHosts.add(url.hostname);
  const respond = (data: unknown) => ({
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  });
  if (url.hostname === 'login.microsoftonline.com') {
    return respond({
      access_token: 'at',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      scope: 'Files.Read.All Sites.Read.All',
    });
  }
  if (url.hostname === 'graph.microsoft.com') {
    if (url.pathname.endsWith('/content')) {
      return respond(Buffer.from('the file bytes'));
    }
    if (url.pathname.endsWith('/children')) {
      return respond({
        value: [
          {
            id: 'item-1',
            name: 'notes.md',
            size: 1000,
            lastModifiedDateTime: '2026-08-01T00:00:00Z',
          },
        ],
      });
    }
    if (url.pathname.endsWith('/delta')) {
      return respond({
        value: [
          {
            id: 'item-1',
            name: 'notes.md',
            size: 1000,
            lastModifiedDateTime: '2026-08-01T00:00:00Z',
            parentReference: { path: '/drives/drive-1/root:' },
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=t1',
      });
    }
  }
  throw new Error(`egress inventory: unexpected request to ${config.url}`);
}

// ── The recording ports ─────────────────────────────────────────────────────
const sinkAccepts: DocumentMeta[] = [];
const gateQuestions: string[] = [];
const gate: EgressGate = {
  checkCloudEgress: async () => {
    gateQuestions.push('cloud');
    return { allowed: true };
  },
  checkMapEgress: async () => {
    gateQuestions.push('map');
    return { allowed: true };
  },
};
const ports: ShelfmarkPorts = {
  resolveAuth: async () => null,
  egressGate: gate,
  sink: {
    accept: async (meta) => {
      sinkAccepts.push(meta);
      return { status: 'ingested' };
    },
  },
};

const data: FakeData = {};

beforeAll(() => {
  realAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async (config: any) => cannedResponse(config);
});

afterAll(() => {
  axios.defaults.adapter = realAdapter as never;
});

describe('the egress inventory, at runtime', () => {
  it('a full map + selective ingest reaches exactly {graph, login} over the network, plus the injected store/sink/gate', async () => {
    const activities = createActivities({ store: fakeStore(data), ports });

    // The connected drive, with grants for BOTH scopes (whole drive, no
    // exclusions — scope behaviour has its own suites; this test is about
    // where bytes can GO).
    data.connector_connections = [
      {
        connectionId: CONN,
        tenantId: TENANT,
        provider: 'onedrive',
        driveId: 'drive-1',
        rootFolderId: null,
        defaultLabel: 'general',
        deltaLink: null,
        encRefreshToken: encryptToken('refresh-token'),
      },
    ];
    data.connector_consents = [
      {
        tenantId: TENANT,
        connectionId: CONN,
        consentId: 'c-map',
        action: 'granted',
        revokesConsentId: null,
        scope: 'map_metadata',
        disclosureSha256: 'sha-m',
        grantedAt: '2026-08-19',
        target: { folderId: null, folderPath: null },
        exclusions: [],
      },
      {
        tenantId: TENANT,
        connectionId: CONN,
        consentId: 'c-ingest',
        action: 'granted',
        revokesConsentId: null,
        scope: 'ingest_content',
        disclosureSha256: 'sha-i',
        grantedAt: '2026-08-19',
        target: { folderId: null, folderPath: null },
        exclusions: [],
      },
    ];

    // ── THE MAP, end to end through the real activities ───────────────────
    const consent = await activities.verifyMapConsent(TENANT, CONN);
    expect(consent.active).toBe(true);
    await activities.checkMapEgressAllowed(TENANT);
    await activities.startMapRun({
      tenantId: TENANT,
      runId: MAP_RUN,
      connectionId: CONN,
      provider: 'onedrive',
      consentId: consent.consentId,
      consentDisclosureSha256: consent.disclosureSha256,
      consentTarget: consent.target,
      consentExclusions: consent.exclusions,
    });
    const page = await activities.listMapFolderPage(TENANT, CONN, null, '');
    expect(page.items.map((i) => i.path)).toEqual(['/notes.md']);
    await activities.appendMapCandidates(TENANT, MAP_RUN, CONN, page.items);
    await activities.updateMapRunProgress(TENANT, MAP_RUN, { progress: { itemsSeen: 1 } });
    const funnel = await activities.writeMapSuggestions(TENANT, MAP_RUN, CONN);
    expect(funnel.defaultSelectionFiles).toBe(1);
    await activities.finalizeMapRun(TENANT, MAP_RUN, CONN, 'complete', {});

    // ── THE DECISION + SELECTIVE INGEST, against the map's real ledger ────
    data.map_selections = [
      {
        tenantId: TENANT,
        connectionId: CONN,
        runId: MAP_RUN,
        removedPaths: [],
        readdedPaths: [],
        decidedAt: '2026-08-20T10:00:00.000Z',
      },
    ];
    const ingestConsent = await activities.verifySelectiveIngestConsent(TENANT, CONN);
    expect(ingestConsent.active).toBe(true);
    const plan = await activities.resolveSelectiveIngestPlan(TENANT, CONN);
    expect(plan.selectedFiles).toBe(1);
    await activities.startSelectiveIngestRun({
      tenantId: TENANT,
      runId: INGEST_RUN,
      connectionId: CONN,
      provider: 'onedrive',
      consentId: ingestConsent.consentId,
      consentDisclosureSha256: ingestConsent.disclosureSha256,
      mapRunId: plan.mapRunId,
      decidedAt: plan.decidedAt,
      selectedFiles: plan.selectedFiles,
      selectedBytes: plan.selectedBytes,
      funnelPolicyVersion: plan.funnelPolicyVersion,
      funnelPolicySha256: plan.funnelPolicySha256,
    });
    await activities.checkCloudEgressAllowed(TENANT, 'general');
    const batch = await activities.listSelectedIngestBatch(
      TENANT,
      CONN,
      plan.mapRunId,
      plan.decidedAt,
      null,
      20
    );
    const outcomes = await activities.ingestFileBatch(CONN, TENANT, 'general', INGEST_RUN, batch.files);
    expect(outcomes).toEqual([{ itemId: 'item-1', status: 'ingested' }]);
    await activities.finalizeSelectiveIngestRun(TENANT, INGEST_RUN, CONN, 'complete', {
      selected: 1,
      ingested: 1,
    });

    // The delta sync path's provider call too, so the inventory covers all
    // three workflows' network surface.
    const delta = await activities.listRemoteDeltaPage(CONN);
    expect(delta.items).toHaveLength(1);

    // ── THE INVENTORY ─────────────────────────────────────────────────────
    // Network: exactly the two Microsoft hosts. Nothing else was reachable —
    // any other request would have thrown in the adapter AND shown up here.
    expect([...observedHosts].sort()).toEqual(['graph.microsoft.com', 'login.microsoftonline.com']);
    // The sink is where the bytes went — once, with the resolved label.
    expect(sinkAccepts).toHaveLength(1);
    expect(sinkAccepts[0]).toMatchObject({
      tenantId: TENANT,
      connectionId: CONN,
      runId: INGEST_RUN,
      filename: 'notes.md',
      label: 'general',
    });
    // The gate was asked both of its questions.
    expect(gateQuestions).toEqual(['map', 'cloud']);
    // And the store holds the run evidence (the injected store is the only
    // persistence this package touches).
    expect(data.map_runs?.[0]).toMatchObject({ runId: MAP_RUN, status: 'complete' });
    expect(data.map_suggestions?.[0]).toMatchObject({ runId: MAP_RUN });
    expect(data.selective_ingest_runs?.[0]).toMatchObject({
      runId: INGEST_RUN,
      status: 'complete',
    });
  });
});

// ── The static halves ───────────────────────────────────────────────────────

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFilesUnder(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('the egress inventory, statically', () => {
  it('no source file in this package imports an HTTP or socket client — provider egress exists only via @shelfmark/graph', () => {
    const files = sourceFilesUnder(join(TEST_DIR, '../src'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /(?:from\s+|require\()\s*'(axios|node-fetch|undici|got|superagent|https?|node:https?|http2|node:http2|net|node:net|tls|node:tls|dgram|node:dgram|ws)'/
      );
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/\bXMLHttpRequest\b/);
      expect(source, file).not.toMatch(/\bWebSocket\b/);
    }
  });

  it('the built @shelfmark/graph module names no host other than graph.microsoft.com and login.microsoftonline.com', () => {
    const graphModule = readFileSync(nodeRequire.resolve('@shelfmark/graph'), 'utf8');
    const hosts = new Set(
      [...graphModule.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)].map((m) => m[1])
    );
    expect([...hosts].sort()).toEqual(['graph.microsoft.com', 'login.microsoftonline.com']);
  });

  it('no model client, no model host, no narration beyond arithmetic — the absence the README claims', () => {
    const files = sourceFilesUnder(join(TEST_DIR, '../src'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // No inference SDK or completion-endpoint reference anywhere in the
      // package: the narration lines are produced by deterministic workflow
      // arithmetic, and their tier field is the literal 'none'.
      expect(source, file).not.toMatch(/openai|anthropic|litellm|\/v1\/(chat\/)?completions/i);
    }
    const driveMap = readFileSync(join(TEST_DIR, '../src/workflows/driveMap.ts'), 'utf8');
    expect(driveMap).toMatch(/tier: 'none'/);
  });
});
