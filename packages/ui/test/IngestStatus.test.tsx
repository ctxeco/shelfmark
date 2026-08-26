// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  connectorActivity,
  fileOutcomeStyle,
  IngestPanel,
  ingestDenominator,
  ingestView,
  INGEST_RUN_STATUSES,
  isConnectorActive,
  MAX_FOLDER_ROWS,
  normalizeIngestProgress,
  orderedFolders,
  outcomeGroups,
  type IngestFolderProgress,
  type IngestProgress,
  type IngestRunStatus,
  type IngestView,
} from '../src/IngestStatus/index';

function progress(over: Partial<IngestProgress> = {}): IngestProgress {
  const status = over.status ?? 'complete';
  return {
    runId: 'ingest-conn-1',
    status,
    rawStatus: typeof status === 'string' ? status : 'complete',
    selected: 0,
    done: 0,
    ingested: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    skippedByReason: {},
    currentPath: null,
    folders: [],
    foldersTruncated: false,
    foldersOmitted: 0,
    failuresTruncated: false,
    failuresOmitted: 0,
    updatedAt: null,
    ...over,
  };
}

function renderPanel(view: IngestView) {
  return render(
    <IngestPanel
      view={view}
      onStartWorking={() => {}}
      reducedMotion={false}
      renderReviewLink={(label) => <a href="/connectors/conn-1/map">{label}</a>}
    />
  );
}

// ── the wire read ──────────────────────────────────────────────────────────

describe('normalizeIngestProgress — absence is not a run that did nothing', () => {
  it('returns null when the connection carries no ingest record at all', () => {
    expect(normalizeIngestProgress(undefined)).toBeNull();
    expect(normalizeIngestProgress(null)).toBeNull();
    expect(normalizeIngestProgress('ingesting')).toBeNull();
    expect(normalizeIngestProgress([])).toBeNull();
    // An object with no status is not a run — it is a shape we cannot read,
    // and reading it as "complete with zero files" would invent a completion.
    expect(normalizeIngestProgress({ selected: 40, done: 40 })).toBeNull();
  });

  it('reads zero as zero and a missing counter as zero, but never a missing STATUS as a state', () => {
    const p = normalizeIngestProgress({ runId: 'r', status: 'complete', selected: 5 })!;
    expect(p.selected).toBe(5);
    expect(p.done).toBe(0);
    expect(p.deferred).toBe(0);
    expect(p.skippedByReason).toEqual({});
    expect(p.folders).toEqual([]);
  });

  it('NAMES a status it does not know instead of coercing it to the nearest one', () => {
    // A worker deployed ahead of this build. Mapping this onto 'ingesting'
    // would show a spinner forever; mapping it onto 'complete' would report a
    // finish that never happened.
    const p = normalizeIngestProgress({ runId: 'r', status: 'quarantined', done: 3, ingested: 3 })!;
    expect(p.status).toBe('unrecognized');
    expect(p.rawStatus).toBe('quarantined');
    const { container } = renderPanel(ingestView(p));
    expect(container.textContent).toContain('quarantined');
    expect(container.textContent).toContain('does not know');
  });

  it('keeps an unfamiliar skip-reason key rather than dropping the files it counts', () => {
    const p = normalizeIngestProgress({
      status: 'complete',
      skippedByReason: { too_large: 2, encrypted_container: 7, bogus: 0, nope: 'x' },
    })!;
    expect(p.skippedByReason).toEqual({ too_large: 2, encrypted_container: 7 });
  });

  it('discards a non-finite counter instead of rendering NaN at a customer', () => {
    const p = normalizeIngestProgress({ status: 'ingesting', done: Number.NaN, selected: 'many' })!;
    expect(p.done).toBe(0);
    expect(p.selected).toBe(0);
  });
});

// ── the denominator ────────────────────────────────────────────────────────

describe('ingestDenominator — a percentage is a claim about their decision', () => {
  it('trusts a positive denominator the work has not passed', () => {
    expect(ingestDenominator(progress({ selected: 200, done: 50 }))).toEqual({
      kind: 'trusted',
      selected: 200,
      pct: 25,
    });
  });

  it('refuses a percentage when more files were handled than were approved', () => {
    // Reachable: a re-decision lands mid-run, or a rolling deploy resumes a
    // plan an older pod built. 320% is not a progress bar.
    expect(ingestDenominator(progress({ selected: 10, done: 32 }))).toEqual({ kind: 'stale', selected: 10 });
  });

  it('refuses a percentage when there is no denominator at all', () => {
    expect(ingestDenominator(progress({ selected: 0, done: 12 }))).toEqual({ kind: 'unknown' });
  });
});

// ── 34-S15b: why, not just how many ────────────────────────────────────────

describe('outcomeGroups — a skip is never a failure, and no counted file vanishes', () => {
  it('separates failures, deferrals and each named skip reason into their own rows', () => {
    const groups = outcomeGroups({
      failed: 12,
      deferred: 40,
      skipped: 9,
      skippedByReason: { too_large: 5, unsupported_type: 4 },
    });
    expect(groups.map((g) => [g.cause, g.count])).toEqual([
      ['deferred', 40],
      ['failed', 12],
      ['too_large', 5],
      ['unsupported_type', 4],
    ]);
    // The whole point: a file we deliberately never opened is not a file that
    // broke, and the two never share a row or a count.
    const failedRow = groups.find((g) => g.cause === 'failed')!;
    expect(failedRow.count).toBe(12);
    expect(groups.filter((g) => g.cause !== 'failed').reduce((n, g) => n + g.count, 0)).toBe(49);
  });

  it('says what to do — and says plainly when nothing will help', () => {
    const groups = outcomeGroups({
      failed: 1,
      deferred: 1,
      skipped: 3,
      skippedByReason: { too_large: 1, already_ingested: 1, sealed_by_destination: 1 },
    });
    const by = Object.fromEntries(groups.map((g) => [g.cause, g]));
    expect(by.failed.recovery).toBe('retry');
    // Recoverable, and the copy names WHAT recovers it — and what does not.
    expect(by.deferred.recovery).toBe('automatic');
    expect(by.deferred.advice).toMatch(/declined these for now/);
    expect(by.deferred.advice).toMatch(/re-submits them automatically/);
    // Fixable by the customer, with the act named.
    expect(by.too_large.recovery).toBe('customer');
    expect(by.too_large.advice).toMatch(/Split the file/);
    // Not fixable, and it says so rather than inviting a pointless retry.
    expect(by.already_ingested.recovery).toBe('none');
    expect(by.already_ingested.advice).toMatch(/Nothing to do\./);
    // A reason this build does not know still reaches a row, honestly.
    expect(by.sealed_by_destination.recovery).toBe('unknown');
    expect(by.sealed_by_destination.title).toMatch(/without a recorded reason/);
  });

  it('gives skips the rollup could not account for a row of their own', () => {
    // An older worker counted `skipped` before `skippedByReason` existed.
    // Dropping the difference would be a silent cap on the explanation.
    const groups = outcomeGroups({ failed: 0, deferred: 0, skipped: 30, skippedByReason: { too_large: 4 } });
    expect(groups.map((g) => [g.cause, g.count])).toEqual([
      ['unnamed', 26],
      ['too_large', 4],
    ]);
    expect(groups[0]!.recovery).toBe('unknown');
  });

  it('merges into the reason the worker already calls "unnamed" instead of showing it twice', () => {
    const groups = outcomeGroups({ failed: 0, deferred: 0, skipped: 10, skippedByReason: { unnamed: 3 } });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ cause: 'unnamed', count: 10 });
  });

  it('has nothing to explain about a clean run', () => {
    expect(outcomeGroups({ failed: 0, deferred: 0, skipped: 0, skippedByReason: {} })).toEqual([]);
  });

  it('orders itself the same way twice, so a poll never reshuffles the same numbers', () => {
    const counts = {
      failed: 5,
      deferred: 5,
      skipped: 10,
      skippedByReason: { too_large: 5, unsupported_type: 5 },
    };
    const a = outcomeGroups(counts).map((g) => g.cause);
    const b = outcomeGroups(counts).map((g) => g.cause);
    expect(a).toEqual(b);
    expect(a).toEqual(['deferred', 'failed', 'too_large', 'unsupported_type']);
  });
});

// ── the four-state file vocabulary ─────────────────────────────────────────

describe('fileOutcomeStyle — four states, and a fifth cannot take the page down', () => {
  it('gives every declared state a glyph AND a word', () => {
    for (const status of ['ingested', 'skipped', 'failed', 'deferred']) {
      const s = fileOutcomeStyle(status);
      expect(s.icon).not.toBe('');
      expect(s.label).not.toBe('');
    }
    expect(fileOutcomeStyle('deferred').label).toBe('Deferred');
    // Not rose. A deferral is the sink declining for now with the file's
    // place kept — styling it as an error is the exact source-divergent
    // semantics the shared `deferred` vocabulary exists to end.
    expect(fileOutcomeStyle('deferred').className).not.toMatch(/rose/);
    expect(fileOutcomeStyle('failed').className).toMatch(/rose/);
  });

  it('answers an unknown status instead of throwing on an undefined lookup', () => {
    const s = fileOutcomeStyle('quarantined');
    expect(s.label).toBe('Unknown state');
    expect(s.icon).toBe('?');
  });
});

// ── which panel a connection owes the customer ─────────────────────────────

describe('connectorActivity — the customer arriving from step 13 lands on THEIR run', () => {
  const base = { status: 'connected', lastSyncStatus: null, lastSyncAt: null, ingest: null };

  it('shows a live read over any terminal sync record, however recent', () => {
    const a = connectorActivity({
      ...base,
      lastSyncStatus: 'complete',
      lastSyncAt: '2026-08-20T12:00:00.000Z',
      ingest: progress({ status: 'ingesting', selected: 10, done: 2 }),
    });
    expect(a.kind).toBe('ingest');
    expect(a.kind === 'ingest' && a.view.kind).toBe('reading');
  });

  it('shows a live legacy sync when no read is running', () => {
    expect(connectorActivity({ ...base, status: 'syncing' }).kind).toBe('syncing');
  });

  it('prefers the more recent terminal record when both exist', () => {
    const older = connectorActivity({
      ...base,
      lastSyncStatus: 'complete',
      lastSyncAt: '2026-08-20T12:00:00.000Z',
      ingest: progress({ updatedAt: '2026-08-19T12:00:00.000Z' }),
    });
    expect(older.kind).toBe('syncComplete');

    const newer = connectorActivity({
      ...base,
      lastSyncStatus: 'complete',
      lastSyncAt: '2026-08-19T12:00:00.000Z',
      ingest: progress({ updatedAt: '2026-08-20T12:00:00.000Z' }),
    });
    expect(newer.kind).toBe('ingest');
  });

  it('still shows an ingest run whose timestamp is unusable rather than nothing', () => {
    const a = connectorActivity({ ...base, ingest: progress({ updatedAt: 'not-a-date' }) });
    expect(a.kind).toBe('ingest');
  });

  it('falls to idle only when there is genuinely nothing to report', () => {
    expect(connectorActivity(base).kind).toBe('idle');
  });

  it('polls for a selective ingest, which never sets the connection to "syncing"', () => {
    // The bug this closes: `status` stays 'connected' for the whole selective
    // ingest, so the old `status === 'syncing'` predicate never fired and the
    // panel sat frozen until the customer reloaded by hand.
    expect(isConnectorActive({ ...base, ingest: progress({ status: 'ingesting' }) })).toBe(true);
    expect(isConnectorActive({ ...base, status: 'syncing' })).toBe(true);
    expect(isConnectorActive({ ...base, ingest: progress({ status: 'complete' }) })).toBe(false);
    expect(isConnectorActive(base)).toBe(false);
  });
});

// ── the folder rollup and its two bounds ───────────────────────────────────

describe('the folder rollup names BOTH of its bounds', () => {
  function folder(over: Partial<IngestFolderProgress>): IngestFolderProgress {
    return { path: '/a', selected: 1, ingested: 1, skipped: 0, failed: 0, deferred: 0, ...over };
  }

  it('puts the folders needing attention first, deterministically', () => {
    const rows = orderedFolders([
      folder({ path: '/quiet', selected: 90, ingested: 90 }),
      folder({ path: '/broken', selected: 4, ingested: 1, failed: 3 }),
      folder({ path: '/parked', selected: 4, ingested: 2, deferred: 2 }),
    ]);
    expect(rows.map((r) => r.path)).toEqual(['/broken', '/parked', '/quiet']);
    expect(orderedFolders(rows).map((r) => r.path)).toEqual(['/broken', '/parked', '/quiet']);
  });

  it('states the screen bound and the RUN bound separately, never one behind the other', () => {
    const folders = Array.from({ length: 20 }, (_, i) =>
      folder({ path: `/f${String(i).padStart(2, '0')}`, selected: 20 - i, ingested: 20 - i })
    );
    const p = progress({
      status: 'complete',
      selected: 210,
      done: 210,
      ingested: 210,
      folders,
      foldersTruncated: true,
      foldersOmitted: 21,
    });
    const { container } = renderPanel(ingestView(p));
    expect(container.textContent).toContain('Showing 12 of 20 folders');
    expect(container.textContent).toContain('21 more folders were not itemised by this run');
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(MAX_FOLDER_ROWS);
  });

  it('seeds each folder row with its own denominator, not a running total', () => {
    const p = progress({
      status: 'ingesting',
      selected: 30,
      done: 4,
      ingested: 4,
      folders: [folder({ path: '/Finance', selected: 30, ingested: 4 })],
    });
    const { container } = renderPanel(ingestView(p));
    expect(container.textContent).toContain('4 of 30 read');
  });
});

// ── step 14 on screen ──────────────────────────────────────────────────────

describe('step 14 — honest progress against the approved total', () => {
  it('reads files (it does not scan them) and measures against what the customer approved', () => {
    const p = progress({
      status: 'ingesting',
      selected: 548,
      done: 137,
      ingested: 120,
      skipped: 10,
      failed: 5,
      deferred: 2,
      currentPath: '/Finance/2026/Q1 close.xlsx',
    });
    const { container } = renderPanel(ingestView(p));
    expect(container.textContent).toContain('Reading the files you approved');
    expect(container.textContent).not.toMatch(/scanning/i);
    expect(screen.getByText('Reading /Finance/2026/Q1 close.xlsx')).toBeInTheDocument();
    expect(screen.getByText('137 of 548 files · 25%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(bar.getAttribute('style')).toContain('width: 25%');
    // Four states in the running line, and a deferral counted apart from a
    // failure — `else progress.failed++` would have called it one.
    expect(container.textContent).toContain('120 read · 5 failed · 2 deferred · 10 skipped');
  });

  it('draws NO bar when there is no denominator, and says why there is no percentage', () => {
    const { container } = renderPanel(ingestView(progress({ status: 'ingesting', selected: 0, done: 9 })));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.textContent).toContain('did not record how many you approved');
    expect(container.textContent).not.toMatch(/\d+%/);
  });

  it('draws NO bar when the approved total has gone stale, and keeps the exact counts', () => {
    const { container } = renderPanel(ingestView(progress({ status: 'ingesting', selected: 10, done: 32 })));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.textContent).toContain('32 files handled, more than the 10 you approved');
    expect(container.textContent).toContain('The counts are still exact');
  });

  it('drops the animation when the reader has asked for less motion', () => {
    const view = ingestView(progress({ status: 'ingesting', selected: 10, done: 5 }));
    const still = render(
      <IngestPanel
        view={view}
        onStartWorking={() => {}}
        reducedMotion
        renderReviewLink={(l) => <a href="#x">{l}</a>}
      />
    );
    expect(still.getByRole('progressbar').className).not.toMatch(/animate-pulse/);
    still.unmount();
    const moving = renderPanel(view);
    expect(moving.getByRole('progressbar').className).toMatch(/animate-pulse/);
  });
});

// ── step 15 on screen ──────────────────────────────────────────────────────

describe('step 15 — the four outcomes, in the colour AND the words', () => {
  function card(view: IngestView): HTMLElement {
    const { container } = renderPanel(view);
    return container.firstElementChild as HTMLElement;
  }

  it('calls a clean run clean, and offers the way into the corpus', () => {
    const el = card(ingestView(progress({ status: 'complete', selected: 40, done: 40, ingested: 40 })));
    expect(el.className).toMatch(/emerald/);
    expect(el.textContent).toContain('Every approved file was read');
    expect(el.textContent).toContain('40 of the 40 files you approved are searchable now.');
    expect(within(el).getByRole('button', { name: /Start working with these files/ })).toBeInTheDocument();
    // Nothing to explain, so no "why" section is invented.
    expect(el.textContent).not.toContain('Why files were not read');
  });

  it('does not call a run with skipped files "every approved file", and explains each skip', () => {
    const el = card(
      ingestView(
        progress({
          status: 'complete',
          selected: 40,
          done: 40,
          ingested: 31,
          skipped: 9,
          skippedByReason: { unsupported_type: 6, too_large: 3 },
        })
      )
    );
    // Still green — nothing failed — but the words do not overclaim.
    expect(el.className).toMatch(/emerald/);
    expect(el.textContent).toContain('Read — with some files skipped');
    expect(el.textContent).toContain('Why files were not read');
    expect(el.textContent).toContain('Not a file type the reader opens — 6');
    expect(el.textContent).toContain('Larger than the size ceiling — 3');
  });

  it('drives a PARTIAL run from the failure count in both the colour and the words', () => {
    // The measured incident, verbatim: 103 of 548, 445 failures, every card
    // reading "✓ Sync complete" in green above "Start working with these
    // files". Colour alone was never enough — a green tick with a failure
    // count beside it still reads as success at a glance.
    const el = card(
      ingestView(progress({ status: 'complete', selected: 548, done: 548, ingested: 103, failed: 445, skipped: 0 }))
    );
    expect(el.className).toMatch(/amber/);
    expect(el.className).not.toMatch(/emerald/);
    expect(el.textContent).toContain('Finished with failures');
    expect(el.textContent).toContain('103 files are searchable. 445 could not be read and are NOT searchable.');
    expect(el.textContent).toContain('Opened, but could not be read — 445');
    expect(within(el).getByRole('link', { name: /Review the selection and read again/ })).toBeInTheDocument();
  });

  it('explains a partial with MIXED causes, and never rolls the deferrals into the failures', () => {
    const el = card(
      ingestView(
        progress({
          status: 'complete',
          selected: 100,
          done: 100,
          ingested: 40,
          failed: 20,
          deferred: 25,
          skipped: 15,
          skippedByReason: { too_large: 10, already_ingested: 5 },
        })
      )
    );
    expect(el.textContent).toContain('Finished with failures');
    expect(el.textContent).toContain('40 files are searchable. 20 could not be read');
    expect(el.textContent).toContain('Deferred — the ingest destination declined it for now — 25');
    expect(el.textContent).toContain('Opened, but could not be read — 20');
    expect(el.textContent).toContain('Larger than the size ceiling — 10');
    expect(el.textContent).toContain('Already read by an earlier run — 5');
    // The count that must never absorb the other three.
    expect(el.textContent).not.toContain('45 could not be read');
    expect(el.textContent).not.toContain('60 could not be read');
  });

  it('treats a wholly DEFERRED run as recoverable, not as a failure', () => {
    const el = card(
      ingestView(progress({ status: 'complete', selected: 80, done: 80, ingested: 0, deferred: 80 }))
    );
    expect(el.className).toMatch(/sky/);
    expect(el.className).not.toMatch(/rose|amber/);
    expect(el.textContent).toContain('Deferred — the destination declined the rest for now');
    expect(el.textContent).toContain('nothing is lost and nothing failed');
    expect(el.textContent).toContain('Recovers on its own');
    expect(el.textContent).toMatch(/re-submits them automatically/);
    // Nothing is searchable yet, so the door into the corpus is not offered.
    expect(within(el).queryByRole('button', { name: /Start working with these files/ })).toBeNull();
  });

  it('says plainly when a run finished having made nothing searchable', () => {
    const el = card(
      ingestView(
        progress({
          status: 'complete',
          selected: 12,
          done: 12,
          ingested: 0,
          skipped: 12,
          skippedByReason: { unsupported_type: 12 },
        })
      )
    );
    expect(el.textContent).toContain('Nothing became searchable');
    expect(el.textContent).toContain('All 12 files were skipped without being opened');
    expect(el.textContent).toContain('Not a file type the reader opens — 12');
  });

  it('tells an EMPTY approved selection apart from one that was approved and never touched', () => {
    const empty = card(ingestView(progress({ status: 'complete', selected: 0, done: 0 })));
    expect(empty.textContent).toContain('finished with an empty selection');

    const untouched = card(ingestView(progress({ status: 'complete', selected: 60, done: 0 })));
    expect(untouched.textContent).toContain('You approved 60 files and this run handled none of them');
    expect(untouched.textContent).not.toContain('empty selection');
  });

  it('separates a run that STOPPED from files that failed', () => {
    const el = card(ingestView(progress({ status: 'failed', selected: 90, done: 30, ingested: 28, failed: 2 })));
    expect(el.className).toMatch(/rose/);
    expect(el.textContent).toContain('The read stopped early');
    expect(el.textContent).toContain('28 files were read before it stopped and are searchable');
    // 34-S15b's live limit, stated rather than left as a mystery count.
    expect(el.textContent).toContain('this screen can show the causes but not yet the file list');
  });

  it('names a refusal for what it was, and does not blame the drive for a consent gap', () => {
    const noConsent = card(ingestView(progress({ status: 'refused_no_consent' })));
    expect(noConsent.textContent).toContain('The read was refused');
    expect(noConsent.textContent).toContain('No active consent to read file contents');
    expect(within(noConsent).getByRole('link', { name: /Review the selection/ })).toBeInTheDocument();

    const unsupported = card(ingestView(progress({ status: 'unsupported_provider' })));
    expect(unsupported.textContent).toContain('This drive cannot be read');
    expect(unsupported.textContent).toContain('No consent was used.');
    // Nothing here a review can fix, so no review link is dangled.
    expect(within(unsupported).queryByRole('link')).toBeNull();
  });
});

// ── the exhaustiveness the picker lesson bought ────────────────────────────

describe('the ingest view state is exhaustive [structural]', () => {
  const statuses: (IngestRunStatus | 'unrecognized')[] = [...INGEST_RUN_STATUSES, 'unrecognized'];
  /** [ingested, skipped, failed, deferred] */
  const outcomes: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [3, 0, 0, 0],
    [0, 2, 0, 0],
    [0, 0, 4, 0],
    [0, 0, 0, 5],
    [3, 2, 4, 5],
    [0, 2, 0, 5],
    [3, 0, 4, 0],
  ];

  it('a stale or absent `done` cannot erase work that the counts prove happened', () => {
    // The rolling-deploy case, through the REAL normalizer — an in-flight
    // workflow started by the previous deploy sends progress with no `done`
    // while its counts are true. Trusting the wire meant three ingested
    // files rendered as "nothing was opened and nothing was changed": work
    // erased by a missing convenience total.
    const fromWire = normalizeIngestProgress({
      runId: 'ingest-conn-1',
      status: 'complete',
      selected: 3,
      ingested: 3, // no `done` on the wire at all
    })!;
    expect(fromWire.done).toBe(3);
    expect(ingestView(fromWire).kind).toBe('complete');

    // Failures with a zero `done` — the shape that rendered the calm card
    // over a run that was not calm.
    const withFailures = normalizeIngestProgress({
      runId: 'ingest-conn-1',
      status: 'complete',
      selected: 3,
      done: 0,
      failed: 3,
    })!;
    expect(withFailures.done).toBe(3);
    expect(ingestView(withFailures).kind).toBe('partial');

    // The wire value is a FLOOR, not a replacement: a server counting higher
    // than the four buckets we model is not silently truncated.
    const higher = normalizeIngestProgress({
      runId: 'ingest-conn-1',
      status: 'ingesting',
      selected: 10,
      done: 9,
      ingested: 2,
    })!;
    expect(higher.done).toBe(9);
  });

  it('renders something TRUE for every reachable combination of inputs', () => {
    const seen = new Set<string>();
    let combinations = 0;

    for (const status of statuses) {
      for (const [ingested, skipped, failed, deferred] of outcomes) {
        const consistent = ingested + skipped + failed + deferred;
        // `done` is swept INDEPENDENTLY of the counts. Deriving it from them
        // made this sweep structurally incapable of constructing the one
        // combination that mattered: a run with failures whose `done` is
        // zero or stale, which is exactly what an in-flight workflow from a
        // previous deploy sends mid rolling upgrade — and what rendered
        // "nothing was changed" over three failed files. A sweep that can
        // only build self-consistent inputs proves the panel handles inputs
        // it will never receive.
        for (const done of [consistent, 0, 1, consistent + 7]) {
          for (const selected of [0, consistent, consistent + 5, Math.max(0, consistent - 1)]) {
            combinations++;
            const p = progress({
              status,
              selected,
              done,
              ingested,
              skipped,
              failed,
              deferred,
              skippedByReason: skipped > 0 ? { too_large: skipped } : {},
            });
            const view = ingestView(p);
            seen.add(view.kind);
            const { container, unmount } = renderPanel(view);
            const text = (container.textContent ?? '').trim();
            const label = `${view.kind} status=${status} counts=${ingested}/${skipped}/${failed}/${deferred} selected=${selected}`;

            // Property 1 — the blank card cannot be reached. This is the exact
            // failure the picker shipped three times.
            expect(text, `blank card for ${label}`).not.toBe('');

            // Property 2 — no NaN, no "undefined", ever reaches a customer.
            expect(text, `unrendered value in ${label}`).not.toMatch(/NaN|undefined|\[object/);

            // Property 3 — no unsubstituted placeholder survives. `t()` swaps
            // vars by name, so a key gaining a var its call site does not pass
            // is invisible to the parity gate and to tsc alike.
            expect(text, `unsubstituted placeholder in ${label}`).not.toMatch(/\{[a-zA-Z]+\}/);

            // Property 4 — a percentage on screen is the real ratio, or absent.
            const pct = /(\d+)%/.exec(text);
            if (pct) {
              expect(selected, `percentage over a bad denominator in ${label}`).toBeGreaterThan(0);
              expect(done, `percentage over a stale denominator in ${label}`).toBeLessThanOrEqual(selected);
              expect(Number(pct[1]), `wrong percentage in ${label}`).toBe(Math.round((done / selected) * 100));
            }

            // Property 5 — a bar is drawn only where a true ratio exists.
            const bars = container.querySelectorAll('[role="progressbar"]');
            const drawable = view.kind === 'reading' && selected > 0 && done <= selected;
            expect(bars.length > 0, `bar/denominator disagreement in ${label}`).toBe(drawable);

            // Property 6 — the recoverable state is never dressed as an error.
            if (view.kind === 'deferred') {
              const cls = (container.firstElementChild as HTMLElement).className;
              expect(cls, `deferral styled as an alarm in ${label}`).not.toMatch(/rose|amber/);
            }

            // Property 7 — a failure always says so in WORDS, never in colour
            // alone. This is the whole of the completion-tone fix, made
            // structural.
            if (view.kind === 'partial') {
              expect(text, `silent failure in ${label}`).toContain('Finished with failures');
              expect(text, `unexplained failure in ${label}`).toContain('Opened, but could not be read');
            }

            // Property 7b — bound to the DATA, not to the view kind, so a
            // mis-derived view cannot satisfy it by relabelling itself. If a
            // terminal run carries failures, the screen says so in words and
            // never claims nothing changed, whatever `done` arrived as.
            if (status === 'complete' && failed > 0) {
              expect(view.kind, `failures rendered as ${view.kind} in ${label}`).toBe('partial');
              expect(text, `failure hidden in ${label}`).not.toContain('Nothing was opened');
            }

            unmount();
          }
        }
      }
    }

    expect(combinations).toBe(768);
    // A union member no enumeration reaches is a member no test has proved
    // anything about.
    expect([...seen].sort()).toEqual([
      'complete',
      'deferred',
      'nothingDone',
      'nothingRead',
      'partial',
      'reading',
      'refused',
      'runFailed',
      'unrecognized',
    ]);
  });

  it('reaches each terminal kind on exactly the conditions that make it true', () => {
    for (const [ingested, skipped, failed, deferred] of outcomes) {
      const done = ingested + skipped + failed + deferred;
      const view = ingestView(
        progress({ status: 'complete', selected: done, done, ingested, skipped, failed, deferred })
      );
      switch (view.kind) {
        case 'nothingDone':
          expect(done).toBe(0);
          break;
        case 'partial':
          expect(failed).toBeGreaterThan(0);
          break;
        case 'deferred':
          expect({ failed, deferred: deferred > 0 }).toEqual({ failed: 0, deferred: true });
          break;
        case 'nothingRead':
          expect({ ingested, failed, deferred }).toEqual({ ingested: 0, failed: 0, deferred: 0 });
          break;
        case 'complete':
          expect({ failed, deferred, positive: ingested > 0 }).toEqual({
            failed: 0,
            deferred: 0,
            positive: true,
          });
          break;
        default:
          throw new Error(`a 'complete' run reached ${view.kind}`);
      }
    }
  });
});
