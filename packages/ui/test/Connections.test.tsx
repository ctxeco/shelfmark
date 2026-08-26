// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React, { useMemo } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  BrowsePickerBody,
  browseView,
  Connections,
  ShelfmarkProvider,
  type BrowseErrorState,
  type BrowseItem,
  type BrowseView,
  type PickedScope,
  type ShelfmarkConfig,
} from '../src/index';

const LABELS = [
  { id: 'commercial', label: 'commercial' },
  { id: 'unclassified', label: 'unclassified' },
];

/** Probe for the 34-S08a navigation contract: renders where the picker's
 * CTA landed and the scope state it carried, without pulling the real map
 * flow (its own fetches, its own test file) into these tests. */
function MapRouteProbe() {
  const { connectionId } = useParams();
  const location = useLocation();
  return (
    <div>
      <p data-testid="map-route-connection">{connectionId}</p>
      <p data-testid="map-route-state">{JSON.stringify(location.state)}</p>
    </div>
  );
}

/** The host harness: a provider config that wires the routes seam to a real
 * router, exactly the way a host application would. */
function ConnectionsScreen({ params }: { params: URLSearchParams }) {
  const navigate = useNavigate();
  const config = useMemo<ShelfmarkConfig>(
    () => ({
      transport: {
        baseUrl: '/api/v1/connectors',
        headers: () => ({ Authorization: 'Bearer test-token' }),
      },
      routes: {
        connections: '/connectors',
        map: (id: string) => `/connectors/${id}/map`,
        renderLink: (to: string, label: React.ReactNode) => <Link to={to}>{label}</Link>,
        onOpenMap: (id: string, scope: PickedScope) => navigate(`/connectors/${id}/map`, { state: scope }),
        onStartWorking: () => {},
      },
      labels: LABELS,
    }),
    [navigate]
  );
  return (
    <ShelfmarkProvider config={config}>
      <main>
        <Connections
          oauthError={params.get('error')}
          autoBrowseConnectionId={params.get('connected') ? params.get('connectionId') : null}
        />
      </main>
    </ShelfmarkProvider>
  );
}

function renderAt(path: string) {
  const params = new URLSearchParams(path.split('?')[1] ?? '');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/connectors" element={<ConnectionsScreen params={params} />} />
        <Route path="/connectors/:connectionId/map" element={<MapRouteProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

const originalLocation = window.location;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  // jsdom throws "Not implemented: navigation" on a real assignment.
  delete (window as any).location;
  (window as any).location = { ...originalLocation, href: '' };
});

describe('Connections', () => {
  it('lists existing connections', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        connections: [
          {
            connectionId: 'conn-1',
            provider: 'onedrive',
            status: 'connected',
            rootPath: '/Finance',
            defaultLabel: 'commercial',
            lastSyncAt: null,
            lastSyncStatus: null,
            lastSyncProgress: { discovered: 0, ingested: 0, skipped: 0, failed: 0 },
          },
        ],
      }),
    });

    renderAt('/connectors');

    await waitFor(() => expect(screen.getByText(/\/Finance/)).toBeInTheDocument());
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows the empty state when there are no connections', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ connections: [] }) });
    renderAt('/connectors');
    await waitFor(() => expect(screen.getByText(/no connectors yet/i)).toBeInTheDocument());
  });

  // Plan 34-S06a: the redirect now fires from inside the handoff card, not
  // from the connect button. The button opens the card; the card names whose
  // consent screen is coming and offers a real "Not now".
  it('names the grantor before redirecting, and only redirects from the handoff', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorizeUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?mock=1' }),
      });

    const user = userEvent.setup();
    renderAt('/connectors');
    await waitFor(() => expect(screen.getByText(/no connectors yet/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /connect onedrive/i }));

    // The handoff is on screen and NOTHING has been requested yet.
    expect(screen.getByText(/microsoft will ask for permission next/i)).toBeInTheDocument();
    expect(screen.getByText(/that screen is theirs, not ours/i)).toBeInTheDocument();
    expect(window.location.href).toBe('');
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /continue to microsoft/i }));

    await waitFor(() => expect(window.location.href).toContain('login.microsoftonline.com'));
    const [, secondCall] = (globalThis.fetch as any).mock.calls;
    expect(secondCall[0]).toBe('/api/v1/connectors/microsoft/authorize?target=onedrive');
    expect(secondCall[1].method).toBe('POST');
  });

  it('lets the reader back out of the handoff without contacting the provider', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ connections: [] }) });

    const user = userEvent.setup();
    renderAt('/connectors');
    await waitFor(() => expect(screen.getByText(/no connectors yet/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /connect sharepoint/i }));
    expect(screen.getByText(/microsoft will ask for permission next/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /not now/i }));

    expect(screen.queryByText(/microsoft will ask for permission next/i)).not.toBeInTheDocument();
    expect(window.location.href).toBe('');
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it('shows the OAuth error banner from the callback redirect', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ connections: [] }) });
    renderAt('/connectors?error=access_denied');
    await waitFor(() => expect(screen.getByText(/connection failed/i)).toBeInTheDocument());
    expect(screen.getByText(/access_denied/)).toBeInTheDocument();
  });

  // Plan 34-S08a. "Map this folder" used to POST /:id/sync from right here —
  // the fused two-consents-in-one-button design. It now ENTERS the map flow:
  // routes.onOpenMap carrying the picked scope, where the consent stage owns
  // the grant and the map start. No network call of any kind fires from this
  // click.
  it('auto-opens the folder picker and "Map this folder" enters the map flow with the picked scope', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          connections: [
            {
              connectionId: 'conn-1',
              provider: 'onedrive',
              status: 'connected',
              rootPath: null,
              defaultLabel: null,
              lastSyncAt: null,
              lastSyncStatus: null,
              lastSyncProgress: { discovered: 0, ingested: 0, skipped: 0, failed: 0 },
            },
          ],
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 'f1', name: 'Finance', isFolder: true }] }),
      });

    const user = userEvent.setup();
    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    // Auto-opened picker shows the browsed root folder's contents.
    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());

    const callsBefore = (globalThis.fetch as any).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /map this folder/i }));

    // Landed on the map route with the picked scope (drive root here).
    await waitFor(() => expect(screen.getByTestId('map-route-connection')).toHaveTextContent('conn-1'));
    expect(JSON.parse(screen.getByTestId('map-route-state').textContent || 'null')).toEqual({
      rootFolderId: null,
      rootPath: '/',
    });

    // The click itself contacted nothing — no sync, no map, no consent.
    expect((globalThis.fetch as any).mock.calls.length).toBe(callsBefore);
    const syncCall = (globalThis.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('/sync'));
    expect(syncCall).toBeUndefined();
  });

  it('carries a picked subfolder as the scope, not the drive root', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          connections: [
            {
              connectionId: 'conn-1',
              provider: 'onedrive',
              status: 'connected',
              rootPath: null,
              defaultLabel: null,
              lastSyncAt: null,
              lastSyncStatus: null,
              lastSyncProgress: { discovered: 0, ingested: 0, skipped: 0, failed: 0 },
            },
          ],
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 'f1', name: 'Finance', isFolder: true }] }),
      });

    const user = userEvent.setup();
    renderAt('/connectors?connected=onedrive&connectionId=conn-1');
    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());

    // Descend into /Finance, then map THAT folder.
    await user.click(screen.getByRole('button', { name: /Finance/ }));
    await user.click(screen.getByRole('button', { name: /map this folder/i }));

    await waitFor(() => expect(screen.getByTestId('map-route-connection')).toHaveTextContent('conn-1'));
    expect(JSON.parse(screen.getByTestId('map-route-state').textContent || 'null')).toEqual({
      rootFolderId: 'f1',
      rootPath: '/Finance',
    });
  });

  it('disconnects a connection', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          connections: [
            {
              connectionId: 'conn-1',
              provider: 'onedrive',
              status: 'connected',
              rootPath: '/Finance',
              defaultLabel: 'commercial',
              lastSyncAt: null,
              lastSyncStatus: null,
              lastSyncProgress: { discovered: 0, ingested: 0, skipped: 0, failed: 0 },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connectionId: 'conn-1', status: 'disconnected' }) })
      .mockResolvedValue({ ok: true, json: async () => ({ connections: [] }) });

    const user = userEvent.setup();
    renderAt('/connectors');
    await waitFor(() => expect(screen.getByText(/\/Finance/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /disconnect/i }));

    await waitFor(() => {
      const deleteCall = (globalThis.fetch as any).mock.calls.find((c: any[]) => c[1]?.method === 'DELETE');
      expect(deleteCall).toBeDefined();
      expect(deleteCall[0]).toBe('/api/v1/connectors/conn-1');
    });
  });
});

// ---------------------------------------------------------------------------
// Plan 34-S07. The folder picker is the screen the product's pitch — "names
// before files" — either survives or dies on. Three properties are load
// bearing, and each had already been broken once by a render that discarded
// what the server correctly returned:
//
//   * files appear at all;
//   * "not reported" and "zero" are visibly different answers;
//   * an incomplete listing can never present itself as the whole folder.
//
// They are asserted here rather than left to review because all three fail
// SILENTLY — the screen looks fine in every one of them.

function connectionFixture(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'conn-1',
    provider: 'onedrive',
    status: 'connected',
    rootFolderId: null,
    rootPath: null,
    defaultLabel: null,
    lastSyncAt: null,
    lastSyncStartedAt: null,
    lastSyncStatus: null,
    lastSyncProgress: { discovered: 0, ingested: 0, skipped: 0, failed: 0 },
    ...overrides,
  };
}

/** Routes by URL instead of by call order: the browse loop makes a variable
 * number of requests, so a `mockResolvedValueOnce` chain cannot express
 * "however many pages it takes". */
function installFetch(browse: (url: string, callIndex: number) => any, connection: Record<string, unknown> = {}) {
  let browseCalls = 0;
  const browseUrls: string[] = [];
  (globalThis.fetch as any).mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/browse')) {
      browseUrls.push(u);
      return browse(u, browseCalls++);
    }
    return { ok: true, json: async () => ({ connections: [connectionFixture(connection)] }) };
  });
  return { browseUrls, browseCallCount: () => browseCalls };
}

const page = (items: unknown[], nextCursor: string | null = null, truncated = false) => ({
  ok: true,
  json: async () => ({ items, nextCursor, truncated }),
});

const failure = (status: number, body: Record<string, unknown>) => ({
  ok: false,
  status,
  json: async () => body,
});

describe('Connections folder picker', () => {
  it('renders files, not only folders', async () => {
    installFetch(() =>
      page([
        { id: 'f1', name: 'Finance', isFolder: true, size: null, modified: null, childCount: 3 },
        { id: 'd1', name: 'q3-report.pdf', isFolder: false, size: 1536, modified: '2026-02-01T10:00:00Z', childCount: null },
        { id: 'd2', name: 'minutes.docx', isFolder: false, size: 4096, modified: null, childCount: null },
      ])
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    // The defect this replaces: a folder holding only files reported "No
    // subfolders here" and showed nothing at all.
    await waitFor(() => expect(screen.getByText('q3-report.pdf')).toBeInTheDocument());
    expect(screen.getByText('minutes.docx')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.queryByText(/no subfolders/i)).not.toBeInTheDocument();

    // Folders navigate; files are rows, because there is nothing to open yet.
    expect(screen.getByRole('button', { name: /Finance/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /q3-report\.pdf/ })).not.toBeInTheDocument();
  });

  it('shows a folder holding only files, instead of calling it empty', async () => {
    installFetch(() =>
      page([{ id: 'd1', name: 'contract.pdf', isFolder: false, size: 120, modified: null, childCount: null }])
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText('contract.pdf')).toBeInTheDocument());
    expect(screen.queryByText(/this folder is empty/i)).not.toBeInTheDocument();
  });

  it('distinguishes "zero" from "not reported" on screen', async () => {
    installFetch(() =>
      page([
        // childCount 0 — a folder that really is empty.
        { id: 'f1', name: 'Archive', isFolder: true, size: null, modified: null, childCount: 0 },
        // childCount null — a provider that reports no child count at all.
        { id: 'f2', name: 'Shared', isFolder: true, size: null, modified: null, childCount: null },
        { id: 'f3', name: 'Contracts', isFolder: true, size: null, modified: null, childCount: 12 },
        // size 0 — a real, reported size for an empty file.
        { id: 'd1', name: 'placeholder.txt', isFolder: false, size: 0, modified: '2026-02-01T10:00:00Z', childCount: null },
        // size null — the provider said nothing.
        { id: 'd2', name: 'shortcut.lnk', isFolder: false, size: null, modified: null, childCount: null },
      ])
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText('placeholder.txt')).toBeInTheDocument());

    // A 0-byte file and an unknown-size file must not look the same.
    expect(screen.getByText('0 B')).toBeInTheDocument();
    // getAll, not get: folders state their size too now (see the defect-[5]
    // test below), so "size not reported" is a fact several rows can carry.
    expect(screen.getAllByText(/size not reported/i).length).toBeGreaterThan(0);

    // An empty folder and a folder whose count was withheld must not either.
    expect(screen.getByText(/^empty$/i)).toBeInTheDocument();
    expect(screen.getByText(/item count not reported/i)).toBeInTheDocument();
    expect(screen.getByText('12 items')).toBeInTheDocument();

    // A missing date is stated, not blank.
    expect(screen.getAllByText(/date not reported/i).length).toBeGreaterThan(0);
  });

  it('never renders an incomplete listing as a complete one', async () => {
    // Every page hands back another cursor — the pathological folder. The
    // auto-follow budget runs out and the listing STOPS, which is fine; what
    // is not fine is the screen implying that what stopped is the folder.
    const { browseCallCount } = installFetch((_url, i) =>
      page([{ id: `d${i}`, name: `file-${i}.pdf`, isFolder: false, size: 10, modified: null, childCount: null }], `cursor-${i + 1}`)
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/this list is NOT complete/i)).toBeInTheDocument());
    // The completeness claim is absent, not merely outweighed.
    expect(screen.queryByText(/items in this folder\./i)).not.toBeInTheDocument();
    // And the control that says there is more exists and is reachable.
    expect(screen.getByRole('button', { name: /load the rest/i })).toBeInTheDocument();
    // Bounded: it does not enumerate a pathological folder's hundreds of
    // thousands of items and hang the tab.
    expect(browseCallCount()).toBe(12);
  });

  it('follows the cursor past page one instead of listing what fitted in it', async () => {
    installFetch((_url, i) =>
      i === 0
        ? page([{ id: 'd0', name: 'first.pdf', isFolder: false, size: 1, modified: null, childCount: null }], 'cursor-1')
        : page([{ id: 'd1', name: 'second.pdf', isFolder: false, size: 2, modified: null, childCount: null }], null)
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    // Auto-followed to a null cursor in two hops — both items, and only then
    // the completeness claim, because the contract earned it.
    await waitFor(() => expect(screen.getByText('second.pdf')).toBeInTheDocument());
    expect(screen.getByText('first.pdf')).toBeInTheDocument();
    expect(screen.getByText(/all 2 items in this folder/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load the rest/i })).not.toBeInTheDocument();
  });

  it('completes the listing when the reader loads the rest', async () => {
    // 13 pages: one more than the auto-follow budget, so the reader has to
    // ask — which is the point of the control existing.
    installFetch((_url, i) =>
      page(
        [{ id: `d${i}`, name: `file-${i}.pdf`, isFolder: false, size: 10, modified: null, childCount: null }],
        i < 12 ? `cursor-${i + 1}` : null
      )
    );

    const user = userEvent.setup();
    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/this list is NOT complete/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /load the rest/i }));

    await waitFor(() => expect(screen.getByText(/all 13 items in this folder/i)).toBeInTheDocument());
    expect(screen.queryByText(/this list is NOT complete/i)).not.toBeInTheDocument();
    expect(screen.getByText('file-12.pdf')).toBeInTheDocument();
  });

  // The sanctioned 34-S07b follow-on: the SERVER can now say its own listing
  // ceiling — a documented 2,000-children bound in @shelfmark/graph — stopped
  // the walk. That is a different fact from the client's auto-follow budget,
  // and it gets its own stated banner rather than hiding inside the generic
  // partial line.
  it('states the SERVER truncation banner when a 200 carries truncated:true', async () => {
    installFetch((_url, i) =>
      page(
        [{ id: `d${i}`, name: `deep-${i}.pdf`, isFolder: false, size: 10, modified: null, childCount: null }],
        `cursor-${i + 1}`,
        true
      )
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/stopped listing at its own ceiling/i)).toBeInTheDocument());
    // The banner rides WITH the generic incompleteness statement and its
    // control — the ceiling is stated, and the way onward still exists.
    // (Both the banner and the partial line say "NOT complete" — the ceiling
    // is stated in addition to, never instead of, the generic statement.)
    expect(screen.getAllByText(/this list is NOT complete/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /load the rest/i })).toBeInTheDocument();
    // And no completeness claim anywhere near it.
    expect(screen.queryByText(/items in this folder\./i)).not.toBeInTheDocument();
  });

  it('keeps everything already fetched when a later page fails', async () => {
    installFetch((_url, i) =>
      i === 0
        ? page(
            [
              { id: 'd0', name: 'kept-one.pdf', isFolder: false, size: 1, modified: null, childCount: null },
              { id: 'd1', name: 'kept-two.pdf', isFolder: false, size: 2, modified: null, childCount: null },
            ],
            'cursor-1'
          )
        : failure(429, { error: 'browse_throttled', retryAfterSeconds: 30 })
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/asked us to slow down/i)).toBeInTheDocument());

    // The rows fetched before the failure are still correct and still there.
    expect(screen.getByText('kept-one.pdf')).toBeInTheDocument();
    expect(screen.getByText('kept-two.pdf')).toBeInTheDocument();
    // The wait is quantified from retryAfterSeconds, not hand-waved.
    expect(screen.getByText(/30 seconds/i)).toBeInTheDocument();
    // The cursor survived with them, so the listing can be resumed.
    expect(screen.getByRole('button', { name: /load the rest/i })).toBeInTheDocument();
    expect(screen.queryByText(/this folder is empty/i)).not.toBeInTheDocument();
  });

  it('tells a deleted folder from a permission problem, and does not advise reconnecting', async () => {
    installFetch(() => failure(404, { error: 'browse_folder_not_found' }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/no longer there/i)).toBeInTheDocument());
    expect(screen.getByText(/your connection is fine/i)).toBeInTheDocument();
    // The old generic branch told the customer to disconnect and reconnect a
    // working drive to fix a folder they had deleted themselves.
    expect(screen.queryByText(/disconnect this drive/i)).not.toBeInTheDocument();
  });

  it('says a scope is missing when the server says so', async () => {
    installFetch(() => failure(403, { error: 'browse_scope_missing' }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() =>
      expect(screen.getByText(/never granted permission to read that folder/i)).toBeInTheDocument()
    );
  });

  it('asks for the SharePoint site instead of blaming the drive, then sends it', async () => {
    const { browseUrls } = installFetch(
      (url) =>
        url.includes('sharepointHostname')
          ? page([{ id: 'f1', name: 'Policies', isFolder: true, size: null, modified: null, childCount: 2 }])
          : failure(400, { error: 'sharepoint_site_required' }),
      { provider: 'sharepoint' }
    );

    const user = userEvent.setup();
    renderAt('/connectors?connected=sharepoint&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/paste it from the address bar/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/sharepoint address/i), 'contoso.sharepoint.com');
    await user.type(screen.getByLabelText(/site path/i), '/sites/Finance');
    await user.click(screen.getByRole('button', { name: /open this site/i }));

    await waitFor(() => expect(screen.getByText('Policies')).toBeInTheDocument());
    const retried = browseUrls[browseUrls.length - 1]!;
    expect(retried).toContain('sharepointHostname=contoso.sharepoint.com');
    expect(retried).toContain('sharepointSitePath=%2Fsites%2FFinance');
  });

  it('states the carried label instead of asking for one', async () => {
    installFetch(() => page([]));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument());
    // 34-S07c: the control is gone, the value is stated — the host's FIRST
    // offered label — and where it gets decided is stated with it.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/filed as commercial for now/i)).toBeInTheDocument();
    expect(screen.getByText(/we will not open it/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Plan 34-S07, round 2. Five defects reproduced LIVE against the component by
// an independent verifier, all five the same failure in different costumes:
// the screen saying something that is not true about what it looked at.
//
// The root cause was structural. Four independent booleans guarded four render
// regions, and between them they did not cover the state space — a listing
// with ZERO rows and a LIVE cursor satisfied none of them and rendered a blank
// panel. So the fix is structural too: one derived `BrowseView`, rendered
// exhaustively. These tests assert the FAILURE SCENARIOS cannot happen, and
// the last one asserts the property that makes individual fixes unnecessary
// next time — no reachable combination of inputs renders an empty body.

/** A 200 whose body will not parse. `res.ok` is true, the headers arrived,
 * and nothing in the old code raised. */
const unreadableOk = () => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON at position 0');
  },
});

describe('Connections folder picker — an unreadable answer is a failure [D1]', () => {
  it('never renders an unparseable 200 as an empty, complete folder', async () => {
    installFetch(() => unreadableOk());

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    // The failure is stated. `.catch(() => ({}))` used to swallow it, and
    // items:[] + nextCursor:null IS the contract's "complete listing" — so the
    // screen asserted "This folder is empty." over an enabled "Map this
    // folder", and a customer mapped a folder we had just called empty.
    await waitFor(() =>
      expect(screen.getByText(/the answer was not something we could read/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/not an empty folder/i)).toBeInTheDocument();

    // None of the three lies are on screen.
    expect(screen.queryByText(/this folder is empty/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/items in this folder\./i)).not.toBeInTheDocument();
    expect(screen.queryByText(/all 0 items/i)).not.toBeInTheDocument();

    // And there is a way out.
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('treats a 200 carrying no items array as the same failure, not as nothing', async () => {
    // A proxy or a half-deployed server answering `200 {}` produced exactly
    // the same "empty complete folder" as an unparseable body did.
    installFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() =>
      expect(screen.getByText(/the answer was not something we could read/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/this folder is empty/i)).not.toBeInTheDocument();
  });

  it('still reads the error code out of a failure body it CAN parse', async () => {
    // The strictness above must not swallow the codes 34-S09c added: an
    // unreadable body is only a failure of its own on a 2xx.
    installFetch(() => failure(409, { error: 'connection_disconnected' }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/this drive is disconnected/i)).toBeInTheDocument());
    expect(screen.queryByText(/not something we could read/i)).not.toBeInTheDocument();
  });
});

describe('Connections folder picker — a zero-row incomplete listing [D2]', () => {
  it('offers a way to continue when every auto-followed page came back empty', async () => {
    // A provider can filter results AFTER paging, so a folder whose leading
    // pages hold only filtered-out entries legitimately answers items:[]
    // with a live continuation. All 12 auto-pages come back like that. The
    // old render: no rows, no empty state, no partial banner, no
    // Load-the-rest — a breadcrumb and an enabled "Map this folder" over
    // blank white.
    const { browseCallCount } = installFetch((_url, i) => page([], `cursor-${i + 1}`));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/this list is NOT complete/i)).toBeInTheDocument());
    expect(screen.getByText(/nothing listed yet/i)).toBeInTheDocument();

    // The exit exists and is usable.
    const loadTheRest = screen.getByRole('button', { name: /load the rest/i });
    expect(loadTheRest).toBeInTheDocument();
    expect(loadTheRest).toBeEnabled();

    // And nothing claims the folder was read.
    expect(screen.queryByText(/this folder is empty/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/items in this folder\./i)).not.toBeInTheDocument();
    expect(browseCallCount()).toBe(12);
  });

  it('does not tell a customer to "load the rest" without a load-the-rest control', async () => {
    // Same folder, then a 429 on page two. The throttle sentence renders and
    // says to wait and then load the rest — which, with zero rows fetched,
    // used to be advice about a button that did not exist. Cancel was the
    // only exit from the picker.
    installFetch((_url, i) => (i === 0 ? page([], 'cursor-1') : failure(429, { error: 'browse_throttled', retryAfterSeconds: 30 })));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/asked us to slow down/i)).toBeInTheDocument());
    expect(screen.getByText(/30 seconds/i)).toBeInTheDocument();

    // The control the message refers to is on the screen the message is on.
    expect(screen.getByRole('button', { name: /load the rest/i })).toBeEnabled();
    expect(screen.getByText(/this list is NOT complete/i)).toBeInTheDocument();
    expect(screen.queryByText(/this folder is empty/i)).not.toBeInTheDocument();
  });

  it('resumes a zero-row listing from its cursor and completes it', async () => {
    // The control is not decorative: it picks up from the cursor that
    // survived, and the state it lands in is the only one allowed to claim
    // the listing is whole.
    const { browseUrls } = installFetch((_url, i) =>
      i < 12
        ? page([], `cursor-${i + 1}`)
        : page([{ id: 'd1', name: 'survivor.pdf', isFolder: false, size: 4, modified: null, childCount: null }], null)
    );

    const user = userEvent.setup();
    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/nothing listed yet/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /load the rest/i }));

    await waitFor(() => expect(screen.getByText('survivor.pdf')).toBeInTheDocument());
    expect(screen.getByText(/all 1 items in this folder/i)).toBeInTheDocument();
    expect(screen.queryByText(/this list is NOT complete/i)).not.toBeInTheDocument();
    // It resumed rather than starting the folder over.
    expect(browseUrls[browseUrls.length - 1]).toContain('cursor=cursor-12');
  });
});

describe('Connections folder picker — the sentence names the control that exists [D6]', () => {
  it('tells a customer to try again, not to "load the rest", when the FIRST page throttles', async () => {
    // The mirror image of the defect above, and it survived the fix for it.
    // The wording came from the error CODE and the control from the CURSOR,
    // chosen in two different places. A throttle mid-walk leaves a cursor, so
    // "Load the rest" is on screen and the sentence naming it was right. A
    // throttle on the FIRST request leaves no cursor, so the control is
    // "Try again" while the sentence still said "then load the rest" —
    // pointing at a button that is not there.
    installFetch(() => failure(429, { error: 'browse_throttled', retryAfterSeconds: 30 }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/asked us to slow down/i)).toBeInTheDocument());
    expect(screen.getByText(/30 seconds/i)).toBeInTheDocument();

    // Names the control that is actually rendered...
    expect(screen.getByText(/then try again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled();
    // ...and not the one that is not.
    expect(screen.queryByText(/load the rest/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load the rest/i })).not.toBeInTheDocument();
  });

  it('still says "load the rest" when a cursor survived the throttle', async () => {
    // The other half of the pairing: the original wording must not be lost
    // while fixing its mirror image.
    installFetch((_url, i) =>
      i === 0
        ? page([{ id: 'a', name: 'kept.pdf', isFolder: false, size: 1, modified: null, childCount: null }], 'cursor-1')
        : failure(429, { error: 'browse_throttled', retryAfterSeconds: 30 })
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/asked us to slow down/i)).toBeInTheDocument());
    expect(screen.getByText(/then load the rest/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load the rest/i })).toBeEnabled();
    expect(screen.queryByText(/then try again/i)).not.toBeInTheDocument();
    expect(screen.getByText('kept.pdf')).toBeInTheDocument();
  });

  it('drops the delay from both wordings when the server does not send one', async () => {
    installFetch(() => failure(429, { error: 'browse_throttled' }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/asked us to slow down/i)).toBeInTheDocument());
    expect(screen.getByText(/wait a moment, then try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/load the rest/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN|undefined|\{seconds\}/)).not.toBeInTheDocument();
  });
});

describe('Connections folder picker — advice that cannot help [D3][D4]', () => {
  it('never advises destroying a connection over a connection-level 404', async () => {
    // The server's connection guard sits ABOVE the try block and answers
    // `404 { error: "No connection <id>" }` — free-form prose, not a code, so
    // it fell through to the bare-404 branch and got browseScopeHint:
    // "Disconnect this drive, connect it again…" — on a case where the
    // connection is already gone or was never this tenant's.
    installFetch(() => failure(404, { error: 'No connection conn-1' }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() =>
      expect(screen.getByText(/not available to your workspace any more/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/nothing here needs disconnecting/i)).toBeInTheDocument();
    expect(screen.queryByText(/disconnect this drive/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/accept every permission/i)).not.toBeInTheDocument();
    // The server's own prose is matched, never rendered — it is not a string
    // we wrote, and it carries an id.
    expect(screen.queryByText(/No connection conn-1/)).not.toBeInTheDocument();
  });

  it('tells an expired session to sign in again, not to reconnect the drive', async () => {
    // The host's auth gateway answers 401 {error:'Unauthorized'}. Reconnecting
    // is self-defeating advice for an expired session: the OAuth round trip
    // needs the very session that just expired.
    installFetch(() => failure(401, { error: 'Unauthorized' }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/sign-in has expired/i)).toBeInTheDocument());
    expect(screen.getByText(/sign in again/i)).toBeInTheDocument();
    expect(screen.queryByText(/disconnect this drive/i)).not.toBeInTheDocument();
  });

  it('names a policy denial as policy, not as a broken drive', async () => {
    installFetch(() => failure(403, { error: 'Forbidden: policy denied' }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() =>
      expect(screen.getByText(/workspace security policy blocked this request/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/ask an administrator/i)).toBeInTheDocument();
    expect(screen.queryByText(/disconnect this drive/i)).not.toBeInTheDocument();
  });

  it('says a bare 500 is ours, and does not send the customer to reconnect over it', async () => {
    installFetch(() => failure(500, { error: 'Internal Server Error' }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/something on our side failed/i)).toBeInTheDocument());
    expect(screen.queryByText(/disconnect this drive/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('keeps the legacy hedge for a bare 404 that names nothing at all', async () => {
    // The one case browseScopeHint still describes truthfully: a server
    // predating 34-S09c, which genuinely cannot tell a missing scope from a
    // missing folder. It must not be lost while the impostors are removed.
    installFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText(/both for a folder that is gone/i)).toBeInTheDocument());
  });
});

describe('Connections folder picker — a folder is allowed to have a size [D5]', () => {
  it('shows a folder’s reported size, and says so when it is not reported', async () => {
    // Graph returns a folder's size on the widened $select. The old if/else
    // on isFolder threw it away, so on the screen whose whole purpose is
    // choosing what to map, two folders of 12 items — 4 MB of memos and
    // 40 GB of video — were indistinguishable.
    installFetch(() =>
      page([
        { id: 'f1', name: 'Memos', isFolder: true, size: 4 * 1024 * 1024, modified: null, childCount: 12 },
        { id: 'f2', name: 'Video', isFolder: true, size: 40 * 1024 * 1024 * 1024, modified: null, childCount: 12 },
        // A provider reporting neither child count nor size.
        { id: 'f3', name: 'Drive folder', isFolder: true, size: null, modified: null, childCount: null },
        // A folder reported as holding nothing at all: 0 is a real answer
        // and must not read as "not reported".
        { id: 'f4', name: 'Empty', isFolder: true, size: 0, modified: null, childCount: 0 },
      ])
    );

    renderAt('/connectors?connected=onedrive&connectionId=conn-1');

    await waitFor(() => expect(screen.getByText('Memos')).toBeInTheDocument());

    expect(screen.getByText('4.0 MB')).toBeInTheDocument();
    expect(screen.getByText('40.0 GB')).toBeInTheDocument();
    // The two 12-item folders are no longer the same row.
    expect(screen.getByRole('button', { name: /Memos/ }).textContent).toContain('4.0 MB');
    expect(screen.getByRole('button', { name: /Video/ }).textContent).toContain('40.0 GB');
    // Unreported is stated, not blank — step 10 needs "empty" and "unknown"
    // to stay different answers.
    expect(screen.getByRole('button', { name: /Drive folder/ }).textContent).toContain('size not reported');
    // And zero is still zero.
    const emptyFolder = screen.getByRole('button', { name: /Empty/ }).textContent ?? '';
    expect(emptyFolder).toContain('0 B');
    expect(emptyFolder).not.toContain('size not reported');
  });
});

// ---------------------------------------------------------------------------
// The structural assertion. Everything above is a symptom; this is the shape.
//
// `browseView` is the ONE place (items, cursor, error, loading, loadingMore)
// becomes a claim about the folder, and `BrowsePickerBody` answers every
// member of that closed set. Walk the whole input space and assert the two
// properties the four independent booleans could not hold:
//
//   1. NOTHING RENDERS NOTHING. Every reachable combination puts something on
//      screen — the blank picker is unreachable by construction.
//   2. COMPLETENESS IS NEVER CLAIMED FALSELY. "All N items in this folder" and
//      "This folder is empty" appear only where cursor === null AND there is
//      no failure; anywhere else the body either says it is incomplete or says
//      it is still working.

const ITEM: BrowseItem = {
  id: 'x1',
  name: 'thing.pdf',
  isFolder: false,
  size: 1,
  modified: null,
  childCount: null,
};

const GENERIC_ERROR: BrowseErrorState = { code: null, message: 'Something went wrong.' };
const SITE_ERROR: BrowseErrorState = { code: 'sharepoint_site_required', message: 'Which site?' };

function renderBody(view: BrowseView) {
  return render(
    <BrowsePickerBody
      view={view}
      connectionId="conn-1"
      sharepointHostname=""
      sharepointSitePath=""
      onSharepointHostnameChange={() => {}}
      onSharepointSitePathChange={() => {}}
      onSubmitSharepointSite={() => {}}
      onRetry={() => {}}
      onLoadMore={() => {}}
      onOpenFolder={() => {}}
    />
  );
}

describe('the picker view state is exhaustive [structural]', () => {
  const itemSets: BrowseItem[][] = [[], [ITEM]];
  const cursors: (string | null)[] = [null, 'cursor-1'];
  const errors: (BrowseErrorState | null)[] = [null, GENERIC_ERROR, SITE_ERROR];
  const flags = [false, true];

  it('renders something for every reachable combination of inputs', () => {
    const seen = new Set<string>();
    let combinations = 0;

    for (const items of itemSets) {
      for (const cursor of cursors) {
        for (const error of errors) {
          for (const loading of flags) {
            for (const loadingMore of flags) {
              combinations++;
              const view = browseView({ items, cursor, error, loading, loadingMore });
              seen.add(view.kind);

              const { container, unmount } = renderBody(view);
              const text = (container.textContent ?? '').trim();
              const label = `${view.kind} items=${items.length} cursor=${cursor} error=${
                error?.code ?? (error ? 'generic' : 'none')
              } loading=${loading} loadingMore=${loadingMore}`;

              // Property 1 — the blank picker cannot be reached.
              expect(text, `blank body for ${label}`).not.toBe('');

              // Property 2 — completeness is claimed only where it is true.
              const claimsComplete = /items in this folder\.|This folder is empty\./i.test(text);
              if (cursor !== null || error !== null) {
                expect(claimsComplete, `false completeness claim for ${label}`).toBe(false);
              }

              // Every state that knows the listing is unfinished says so and
              // hands over a control. Two exemptions, and they are the two the
              // brief allows — never a third:
              //   * page one still in flight, which says nothing about the
              //     folder but says outright that it is working;
              //   * SharePoint not yet told which site, where the form is the
              //     way forward and there is no listing to continue.
              if (cursor !== null && error?.code !== 'sharepoint_site_required') {
                if (view.kind === 'loading') {
                  // The escape hatch is only legitimate while it is visible.
                  expect(text, `silent wait for ${label}`).toContain('Loading folders');
                } else {
                  expect(/NOT complete/i.test(text), `silent truncation for ${label}`).toBe(true);
                  expect(
                    within(container).getByRole('button', { name: /load the rest|loading more/i }),
                    `no way to continue for ${label}`
                  ).toBeInTheDocument();
                }
              }

              unmount();
            }
          }
        }
      }
    }

    expect(combinations).toBe(48);
    // Every member of the union is reachable — an enumeration that never
    // reaches a state proves nothing about it.
    expect([...seen].sort()).toEqual(['complete', 'empty', 'failed', 'incomplete', 'loading']);
  });

  it('reaches "complete" on exactly one path: no failure, no cursor, rows present', () => {
    for (const items of itemSets) {
      for (const cursor of cursors) {
        for (const error of errors) {
          for (const loading of flags) {
            for (const loadingMore of flags) {
              const view = browseView({ items, cursor, error, loading, loadingMore });
              if (view.kind === 'complete') {
                expect({ cursor, error, loading, items: items.length }).toEqual({
                  cursor: null,
                  error: null,
                  loading: false,
                  items: 1,
                });
              }
              if (view.kind === 'empty') {
                expect({ cursor, error, loading, items: items.length }).toEqual({
                  cursor: null,
                  error: null,
                  loading: false,
                  items: 0,
                });
              }
            }
          }
        }
      }
    }
  });

  it('says it is working rather than saying nothing, while page one is in flight', () => {
    const view = browseView({ items: [], cursor: null, error: null, loading: true, loadingMore: false });
    expect(view.kind).toBe('loading');
    const { container } = renderBody(view);
    expect(container.textContent).toContain('Loading folders');
  });

  it('keeps a failed listing’s rows, and never counts them as the folder', () => {
    // A failure with rows but no cursor to resume from: the rows are still
    // correct, so they stay — but what is on screen may not be the folder,
    // and the body says exactly that instead of counting.
    const view = browseView({
      items: [ITEM],
      cursor: null,
      error: GENERIC_ERROR,
      loading: false,
      loadingMore: false,
    });
    expect(view.kind).toBe('failed');
    const { container } = renderBody(view);
    expect(container.textContent).toContain('thing.pdf');
    expect(container.textContent).toContain('may not be all of it');
    expect(container.textContent).not.toMatch(/items in this folder\./i);
    expect(within(container).getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Plan 34-S15a. The four completion states first shipped with ZERO tests, and
// the completion-tone commit exists because the untested version had already
// been wrong in production: five connectors on the measured tenant read
// "✓ Sync complete" in green above a button saying "Start working with these
// files", while 445 of 548 files had failed. `JRN-4` is the row that says so.
//
// These are the regression armour for that exact defect. Every assertion
// pins BOTH halves of the fix — the colour and the words — because the words
// alone survived a green box once already, and the colour alone is not
// something a customer reads.
//
// 34-S14e added a fourth outcome after that commit: a file the sink DEFERRED.
// It is not a failure and is not styled as one, so it gets its own tone, its
// own words, and its own tests below.

function syncedConnection(over: Record<string, unknown> = {}, progress: Record<string, unknown> = {}) {
  return connectionFixture({
    rootPath: '/Finance',
    defaultLabel: 'commercial',
    lastSyncStartedAt: '2026-08-19T10:00:00.000Z',
    lastSyncAt: '2026-08-19T10:02:14.000Z',
    lastSyncStatus: 'complete',
    lastSyncProgress: {
      discovered: 548,
      ingested: 548,
      skipped: 0,
      failed: 0,
      deferred: 0,
      skippedByReason: {},
      foldersScanned: 31,
      ...progress,
    },
    ...over,
  });
}

function serveConnections(conns: Record<string, unknown>[]) {
  (globalThis.fetch as any).mockImplementation(async (_url: string, init?: any) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ status: 'syncing' }) };
    return { ok: true, json: async () => ({ connections: conns }) };
  });
}

/** The connector tile, so a "not in the document" assertion cannot be
 *  satisfied by the page around it. */
async function tile(): Promise<HTMLElement> {
  // Wait for the list to arrive, then take the row itself: the root path
  // shares its <p> with the label, and the folder rollup inside the ingest
  // panel repeats it, so no text query identifies the row uniquely.
  await screen.findAllByText(/^\/Finance/);
  return document.querySelector('main ul li') as HTMLElement;
}

describe('a finished sync is not the same as a sync that worked [34-S15a]', () => {
  it('CLEAN — green, "Sync complete", the way in, and no retry for nothing', async () => {
    serveConnections([syncedConnection()]);
    renderAt('/connectors');
    const el = await tile();

    const card = el.querySelector('.border-emerald-900\\/60') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText('Sync complete')).toBeInTheDocument();
    expect(card.textContent).toContain('548 of 548 files ingested');
    expect(card.textContent).toContain('in 2m 14s');
    expect(within(el).getByRole('button', { name: /Start working with these files/ })).toBeInTheDocument();
    // Offering "Retry failed files" over zero failures is an invitation to
    // re-crawl a whole drive for no reason.
    expect(within(el).queryByRole('button', { name: /Retry failed files/ })).toBeNull();
    expect(card.textContent).not.toContain('Why files were not read');
  });

  it('PARTIAL — amber, the failure count in the words, and the retry that goes with it', async () => {
    // The measured incident, verbatim.
    serveConnections([syncedConnection({}, { discovered: 548, ingested: 103, failed: 445, skipped: 0 })]);
    renderAt('/connectors');
    const el = await tile();

    const card = el.querySelector('.border-amber-900\\/60') as HTMLElement;
    expect(card, 'a partial sync must not render in the clean tone').not.toBeNull();
    expect(el.querySelector('.border-emerald-900\\/60')).toBeNull();
    expect(within(card).getByText('Sync finished with failures')).toBeInTheDocument();
    expect(card.textContent).toContain('103 of 548 files ingested, 445 failed');
    expect(card.textContent).toContain('445 could not be read and are NOT searchable');
    expect(card.textContent).toContain('only partly searchable');
    expect(within(el).getByRole('button', { name: /Retry failed files/ })).toBeInTheDocument();
  });

  it('PARTIAL — 34-S15b: the failures are explained by cause, not left as a number', async () => {
    serveConnections([
      syncedConnection(
        {},
        {
          discovered: 548,
          ingested: 103,
          failed: 200,
          skipped: 245,
          deferred: 0,
          skippedByReason: { unsupported_type: 180, too_large: 60, vaulted_by_owner: 5 },
        }
      ),
    ]);
    renderAt('/connectors');
    const el = await tile();

    expect(el.textContent).toContain('Why files were not read');
    expect(el.textContent).toContain('Opened, but could not be read — 200');
    // The reframe 34-S14d bought: a file we never downloaded is not a file
    // that broke, and 245 of these used to be counted as failures.
    expect(el.textContent).toContain('Not a file type the reader opens — 180');
    expect(el.textContent).toContain('Larger than the size ceiling — 60');
    // A reason token this build does not know still gets a written row.
    expect(el.textContent).toContain('Skipped without a recorded reason — 5');
    // What to do, per cause — including where the honest answer is "it is
    // our record's gap, not yours".
    expect(el.textContent).toContain('Save it as PDF, DOCX or plain text');
    expect(el.textContent).toContain('a gap in our record');
  });

  it('DEFERRED — its own tone and words, because a parked file is not a broken one', async () => {
    serveConnections([
      syncedConnection(
        {},
        {
          discovered: 548,
          ingested: 300,
          failed: 0,
          skipped: 0,
          deferred: 248,
        }
      ),
    ]);
    renderAt('/connectors');
    const el = await tile();

    const card = el.querySelector('.border-sky-900\\/60') as HTMLElement;
    expect(card, 'a deferred sync must not be reported as complete').not.toBeNull();
    expect(el.querySelector('.border-emerald-900\\/60')).toBeNull();
    expect(el.querySelector('.border-amber-900\\/60'), 'a deferral is not an error').toBeNull();
    expect(within(card).getByText('Deferred — the rest is parked, not failed')).toBeInTheDocument();
    expect(card.textContent).toContain('248 files are parked, not failed');
    expect(card.textContent).toContain('Recovers on its own');
    // Recoverable, and the copy names what recovers it AND what does not.
    expect(card.textContent).toContain('declined them for now');
    expect(card.textContent).toContain('re-submits them automatically');
    // Nothing failed, so nothing is offered to retry.
    expect(within(el).queryByRole('button', { name: /Retry failed files/ })).toBeNull();
  });

  it('EMPTY — says the folder held nothing, and does not offer a corpus to work with', async () => {
    serveConnections([syncedConnection({}, { discovered: 0, ingested: 0, failed: 0, skipped: 0, foldersScanned: 7 })]);
    renderAt('/connectors');
    const el = await tile();

    expect(el.textContent).toContain('No files found after scanning 7 folders');
    expect(el.textContent).toContain('Try a different root folder');
    expect(within(el).queryByRole('button', { name: /Start working with these files/ })).toBeNull();
  });

  it('EMPTY with no folders walked at all is a different sentence from an empty walk', async () => {
    serveConnections([syncedConnection({}, { discovered: 0, ingested: 0, failed: 0, skipped: 0, foldersScanned: 0 })]);
    renderAt('/connectors');
    const el = await tile();
    expect(el.textContent).toContain('This folder is empty');
    expect(el.textContent).not.toContain('No files found after scanning');
  });

  it('EMPTY carrying failures explains itself and offers the retry, instead of an alarm with no cause', async () => {
    // Reachable, and it used to render a contradiction: the retry pass runs
    // BEFORE the crawl and its failures increment `failed` without touching
    // `discovered`. A run that re-failed three files and then found nothing
    // new showed "Sync finished with failures" in amber above "This folder
    // is empty" — with the retry button in the OTHER branch entirely.
    serveConnections([syncedConnection({}, { discovered: 0, ingested: 0, failed: 3, skipped: 0, foldersScanned: 0 })]);
    renderAt('/connectors');
    const el = await tile();

    expect(within(el).getByText('Sync finished with failures')).toBeInTheDocument();
    expect(el.textContent).toContain('3 files carried over from the last run failed again');
    expect(el.textContent).toContain('Opened, but could not be read — 3');
    expect(within(el).getByRole('button', { name: /Retry failed files/ })).toBeInTheDocument();
  });

  it('FAILED — rose, "Sync failed", the counts, and the retry', async () => {
    serveConnections([
      syncedConnection(
        { status: 'error', lastSyncStatus: 'failed' },
        { discovered: 120, ingested: 40, skipped: 2, failed: 8, deferred: 1, foldersScanned: 5 }
      ),
    ]);
    renderAt('/connectors');
    const el = await tile();

    const card = el.querySelector('.border-rose-900\\/60') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText('Sync failed')).toBeInTheDocument();
    expect(card.textContent).toContain('5 folders scanned · 120 found · 40 read · 2 skipped · 1 deferred · 8 failed');
    expect(card.textContent).toContain('Retrying re-attempts just the failed files');
    expect(within(el).getByRole('button', { name: /Retry failed files/ })).toBeInTheDocument();
  });

  it('RETRY — the affordance actually re-runs the sync for that connection', async () => {
    serveConnections([syncedConnection({}, { discovered: 548, ingested: 103, failed: 445, skipped: 0 })]);
    const user = userEvent.setup();
    renderAt('/connectors');
    await tile();

    await user.click(screen.getByRole('button', { name: /Retry failed files/ }));

    await waitFor(() => {
      const post = (globalThis.fetch as any).mock.calls.find((c: any[]) => c[1]?.method === 'POST');
      expect(post).toBeDefined();
      expect(post[0]).toBe('/api/v1/connectors/conn-1/sync');
      expect(JSON.parse(post[1].body)).toMatchObject({ rootPath: '/Finance' });
    });
  });

  it('states a delta re-enumeration when one happened, and stays silent when none did', async () => {
    serveConnections([syncedConnection({ lastSyncDeltaExpiredFallbacks: 2 })]);
    const { unmount } = renderAt('/connectors');
    expect((await tile()).textContent).toContain('walked the whole folder again (2×)');
    unmount();

    serveConnections([syncedConnection({ lastSyncDeltaExpiredFallbacks: 0 })]);
    renderAt('/connectors');
    expect((await tile()).textContent).not.toContain('walked the whole folder again');
  });
});

describe('the sync panel reads files, and says so in four states [34-S14d/e]', () => {
  it('names the act it is performing — reading, not scanning', async () => {
    serveConnections([
      syncedConnection(
        { status: 'syncing', lastSyncStatus: null, lastSyncAt: null },
        { discovered: 100, ingested: 20, skipped: 1, failed: 1, deferred: 1, foldersScanned: 3 }
      ),
    ]);
    renderAt('/connectors');
    const el = await tile();

    expect(el.textContent).toContain('Reading your OneDrive files…');
    expect(el.textContent).not.toMatch(/Scanning your/);
    expect(el.textContent).toContain('files read');
    expect(el.textContent).toContain('3 folders scanned · 100 found · 20 read · 1 skipped · 1 deferred · 1 failed');
  });

  it('gives every recent file a WORD, not only a colour, and shows the reason it carries', async () => {
    serveConnections([
      syncedConnection(
        { status: 'syncing', lastSyncStatus: null, lastSyncAt: null },
        {
          discovered: 4,
          ingested: 1,
          skipped: 1,
          failed: 1,
          deferred: 1,
          foldersScanned: 1,
          recentFiles: [
            { name: 'ok.pdf', path: '/a/ok.pdf', status: 'ingested' },
            {
              name: 'huge.mov',
              path: '/a/huge.mov',
              status: 'skipped',
              reason: 'unsupported_type: .mov is not a type the document parser reads',
            },
            { name: 'broken.pdf', path: '/a/broken.pdf', status: 'failed', reason: 'parser returned no text' },
            { name: 'later.docx', path: '/a/later.docx', status: 'deferred', reason: 'sink declined for now' },
            { name: 'weird.bin', path: '/a/weird.bin', status: 'quarantined' },
          ],
        }
      ),
    ]);
    renderAt('/connectors');
    const el = await tile();

    // The three `connectors.fileStatus.*` strings had sat in both
    // dictionaries unused since this panel shipped: the status reached the
    // screen as an aria-hidden glyph and a colour class, so a screen-reader
    // user learned nothing at all about whether a file had been read.
    expect(within(el).getByText('Ingested')).toBeInTheDocument();
    expect(within(el).getByText('Skipped')).toBeInTheDocument();
    expect(within(el).getByText('Failed')).toBeInTheDocument();
    expect(within(el).getByText('Deferred')).toBeInTheDocument();
    // A worker that ships a fifth status must not take the page down.
    expect(within(el).getByText('Unknown state')).toBeInTheDocument();
    expect(el.textContent).toContain('.mov is not a type the document parser reads');
    expect(el.textContent).toContain('parser returned no text');
  });
});

// ---------------------------------------------------------------------------
// Plan 34-S14f, the UI half. Steps 12 and 13 end with the customer approving
// a specific set of files. Step 14 is what they watch while those files are
// opened — and until this landed, the connections screen could only show them
// the older all-at-once sync's panel, reporting a crawl that might be weeks
// old, with no sign at all that the read they had just consented to was
// running.

function ingestingConnection(ingest: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return connectionFixture({
    rootPath: '/Finance',
    defaultLabel: 'commercial',
    // The selective ingest NEVER writes these: it leaves the connection at
    // 'connected' and touches neither `lastSyncStatus` nor `lastSyncProgress`.
    status: 'connected',
    lastSyncStatus: null,
    lastSyncAt: null,
    lastIngestProgress: {
      runId: 'ingest-conn-1',
      status: 'ingesting',
      selected: 240,
      done: 60,
      ingested: 55,
      skipped: 3,
      failed: 1,
      deferred: 1,
      skippedByReason: { too_large: 3 },
      currentPath: '/Finance/2026/Q1 close.xlsx',
      folders: [{ path: '/Finance/2026', selected: 80, ingested: 55, skipped: 3, failed: 1, deferred: 1 }],
      foldersTruncated: false,
      foldersOmitted: 0,
      failuresTruncated: false,
      failuresOmitted: 0,
      updatedAt: '2026-08-20T09:00:00.000Z',
      ...ingest,
    },
    ...over,
  });
}

describe('the customer arriving from step 13 lands on THEIR run [34-S14f]', () => {
  it('shows the selective read, measured against the total they approved', async () => {
    serveConnections([ingestingConnection({})]);
    renderAt('/connectors');
    const el = await tile();

    expect(el.textContent).toContain('Reading the files you approved');
    expect(el.textContent).toContain('60 of 240 files · 25%');
    expect(el.textContent).toContain('Reading /Finance/2026/Q1 close.xlsx');
    expect(el.textContent).toContain('Run ingest-conn-1');
    // The per-folder rollup the map supplies for free.
    expect(el.textContent).toContain('/Finance/2026');
    expect(el.textContent).toContain('55 of 80 read');
  });

  it('does NOT put the legacy all-or-nothing panel in front of a live read', async () => {
    // Even when a full sync completed earlier: the read they just started is
    // the only record still moving, and it is the question they just asked.
    serveConnections([
      ingestingConnection(
        {},
        {
          lastSyncStatus: 'complete',
          lastSyncAt: '2026-08-20T08:00:00.000Z',
          lastSyncProgress: { discovered: 548, ingested: 548, skipped: 0, failed: 0, foldersScanned: 31 },
        }
      ),
    ]);
    renderAt('/connectors');
    const el = await tile();

    expect(el.textContent).toContain('Reading the files you approved');
    expect(within(el).queryByText('Sync complete')).toBeNull();
    expect(el.textContent).not.toContain('548 of 548 files ingested');
  });

  it('keeps a LIVE read in front even when a full sync finished more recently', async () => {
    // The case the recency rule alone gets wrong, and it is reachable: a
    // selective ingest whose last batch flushed at 09:00 is still running at
    // 11:00, while an all-at-once sync started later finished at 10:00. The
    // read is the only record still moving, and it is the one the customer
    // just consented to.
    serveConnections([
      ingestingConnection(
        { updatedAt: '2026-08-20T09:00:00.000Z' },
        {
          lastSyncStatus: 'complete',
          lastSyncAt: '2026-08-20T10:00:00.000Z',
          lastSyncProgress: { discovered: 548, ingested: 548, skipped: 0, failed: 0, foldersScanned: 31 },
        }
      ),
    ]);
    renderAt('/connectors');
    const el = await tile();
    expect(el.textContent).toContain('Reading the files you approved');
    expect(within(el).queryByText('Sync complete')).toBeNull();
  });

  it('shows the older full sync again once the read has finished and been overtaken', async () => {
    serveConnections([
      ingestingConnection(
        { status: 'complete', updatedAt: '2026-08-19T08:00:00.000Z' },
        {
          lastSyncStatus: 'complete',
          lastSyncAt: '2026-08-20T08:00:00.000Z',
          lastSyncProgress: { discovered: 548, ingested: 548, skipped: 0, failed: 0, foldersScanned: 31 },
        }
      ),
    ]);
    renderAt('/connectors');
    const el = await tile();
    expect(within(el).getByText('Sync complete')).toBeInTheDocument();
    expect(el.textContent).not.toContain('Reading the files you approved');
  });

  it('explains a partial read by cause and offers the only honest way to run it again', async () => {
    serveConnections([
      ingestingConnection({
        status: 'complete',
        selected: 240,
        done: 240,
        ingested: 100,
        failed: 90,
        skipped: 30,
        deferred: 20,
        skippedByReason: { unsupported_type: 30 },
        folders: [],
        failuresTruncated: true,
        failuresOmitted: 12,
      }),
    ]);
    renderAt('/connectors');
    const el = await tile();

    expect(el.textContent).toContain('Finished with failures');
    expect(el.textContent).toContain('100 files are searchable. 90 could not be read');
    expect(el.textContent).toContain('Opened, but could not be read — 90');
    expect(el.textContent).toContain('Deferred — the ingest destination declined it for now — 20');
    expect(el.textContent).toContain('Not a file type the reader opens — 30');
    // Every bound named when it bites.
    expect(el.textContent).toContain('12 of the failures were not itemised even there');
    // Re-reading is a decision plus a consent, and both live in the Decide
    // flow — a button here that re-POSTed the ingest would refuse the split
    // the whole journey exists to make.
    const link = within(el).getByRole('link', { name: /Review the selection and read again/ });
    expect(link).toHaveAttribute('href', '/connectors/conn-1/map');
  });

  it('renders a refusal rather than a blank tile', async () => {
    serveConnections([
      ingestingConnection({ status: 'refused_no_consent', selected: 0, done: 0, ingested: 0, folders: [] }),
    ]);
    renderAt('/connectors');
    expect((await tile()).textContent).toContain('The read was refused');
  });

  it('renders the connection normally when there is NO run document, and does not invent one', async () => {
    // Every connection is in this state until the customer finishes step 13,
    // and every connection was in it before the workers' mirror shipped.
    // Absence is not "a run that did nothing" — no panel, no zeroes, no crash.
    serveConnections([connectionFixture({ rootPath: '/Finance', defaultLabel: 'commercial' })]);
    const { unmount } = renderAt('/connectors');
    let el = await tile();
    expect(within(el).getByRole('button', { name: /Pick a folder|Change folder/ })).toBeInTheDocument();
    expect(el.textContent).not.toContain('Reading the files you approved');
    expect(el.textContent).not.toContain('Every approved file was read');
    unmount();

    // Same for a record this build cannot read at all.
    serveConnections([
      connectionFixture({
        rootPath: '/Finance',
        defaultLabel: 'commercial',
        lastIngestProgress: { selected: 40, done: 40 },
      }),
    ]);
    renderAt('/connectors');
    el = await tile();
    expect(el.textContent).not.toContain('Reading the files you approved');
    expect(el.textContent).not.toMatch(/NaN|undefined/);
  });

  it('keeps polling for a run that never sets the connection to "syncing"', async () => {
    vi.useFakeTimers();
    try {
      serveConnections([ingestingConnection({})]);
      renderAt('/connectors');
      await vi.advanceTimersByTimeAsync(0);
      const first = (globalThis.fetch as any).mock.calls.length;
      expect(first).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        (globalThis.fetch as any).mock.calls.length,
        'a selective ingest leaves status at "connected" — polling on that field alone froze the panel'
      ).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once the run is terminal', async () => {
    vi.useFakeTimers();
    try {
      serveConnections([
        ingestingConnection({ status: 'complete', done: 240, ingested: 240, failed: 0, skipped: 0, deferred: 0 }),
      ]);
      renderAt('/connectors');
      await vi.advanceTimersByTimeAsync(0);
      const first = (globalThis.fetch as any).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect((globalThis.fetch as any).mock.calls.length).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
