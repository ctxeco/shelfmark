---
title: "@shelfmark/ui"
parent: Packages
grand_parent: Reference
nav_order: 6
---

# `@shelfmark/ui`

Three React screens for the map-then-decide-then-read flow, wired to a host
through `<ShelfmarkProvider>` and nothing else.

```bash
pnpm add @shelfmark/ui
```

Peer dependencies: `react` ^18, `react-dom` ^18, `react-router-dom` ^6 or ^7,
`@tanstack/react-virtual` ^3. ESM only.

```ts
import { ShelfmarkProvider, Connections, DriveMap, IngestPanel } from '@shelfmark/ui';
import '@shelfmark/ui/styles.css';
```

Extra entry points: `@shelfmark/ui/styles.css`,
`@shelfmark/ui/tailwind-preset`, `@shelfmark/ui/test-setup`.

{: .note }
> This package imports **neither `@shelfmark/core` nor `mongodb`** — importing
> core from a browser bundle would drag Mongo into it. It talks to
> `@shelfmark/api` over HTTP and nothing else. See
> [import boundaries](index.md#enforced-import-boundaries).

## The provider

```ts
export interface ShelfmarkConfig {
  transport: ShelfmarkTransport;
  routes: ShelfmarkRoutes;
  labels?: ShelfmarkLabel[];
  costModel?: ShelfmarkCostModel;
  collaboratorCount?: () => Promise<number | null>;
  providers?: ShelfmarkProviderId[];   // default ['onedrive','sharepoint']
  locale?: LocaleCode;                 // default 'en'
  reducedMotion?: boolean;             // overrides the OS signal
}

export interface ShelfmarkTransport {
  baseUrl: string;                     // e.g. '/api/v1/connectors'
  headers(): Record<string, string>;   // called per request
}

export interface ShelfmarkRoutes {
  connections: string;
  map(connectionId: string): string;
  renderLink(to: string, label: React.ReactNode): React.ReactNode;
  onStartWorking?(scope: { scopePath: string | null; scopeLabel: string }): void;
  onOpenMap?(connectionId: string, scope: PickedScope): void;
}
```

`<ShelfmarkProvider config={…}>` is the **one** seam. Every coupling the source
screens had to their shell — an auth-header helper, a router, a session's
clearance ladder, a users endpoint, a window-global locale — maps onto exactly
one field here, the same move `@shelfmark/core`'s ports make for the backend.

- **`baseUrl` is the only origin contacted.** Every request is
  `${baseUrl}<route>`; `apiUrl(transport, path)` is the package's only URL
  constructor.
- **`renderLink` means the package hardcodes no anchor.** The host's routing
  wins everywhere.
- **`onOpenMap` is the one navigation `renderLink` cannot express**, because
  the picked scope is *state*, not a path: the consent screen must name the
  folder the reader just picked, and a query string would make an opaque folder
  id a bookmarkable claim. Absent → the CTA falls back to
  `renderLink(map(id), …)` and the map resolves its scope from the connection's
  stored root.
- **`labels` is the host's vocabulary** (`LabelPolicy` in `@shelfmark/core`), so
  there is deliberately no built-in list. Empty or absent → every label control
  is hidden and no label travels on the ingest start; the host's server-side
  default applies. `labelDisplay(labels, id)` falls back to the id verbatim —
  the closed-vocabulary rule every table in this package follows.
- **`collaboratorCount` is a count, never the people.** Resolve to `null` for
  "could not tell", which renders the honest assume-shared sentence; absent
  behaves the same.

```ts
export function useShelfmark(): ResolvedShelfmarkConfig;   // throws without a provider
export function useReducedMotion(): boolean;               // config override, else the OS signal
export function apiUrl(transport: ShelfmarkTransport, path: string): string;
export function labelDisplay(labels: readonly ShelfmarkLabel[], id: string): string;
export const DEFAULT_COST_MODEL: ShelfmarkCostModel;
```

The provider is the **single writer** of the i18n module's locale state — it
calls `setLocale` during render, before any child calls `t()`.

### `DEFAULT_COST_MODEL`

```ts
{ textLikeExtensions: ['md','txt','csv'], textBytesPerToken: 4,
  binaryLowYield: 50, binaryHighYield: 4 }
```

The same constants as `@shelfmark/core`'s `COST_MODEL`, duplicated **by value**
to keep Mongo out of a browser bundle. The duplication is watched, not trusted:
the ledger's live mirror runs an equivalence check against the server's own
emitted range at zero edits, and disagreement **withdraws the edited range on
screen** rather than showing a number the server did not compute.

## `<Connections>`

```ts
export interface ConnectionsProps {
  oauthError?: string | null;
  autoBrowseConnectionId?: string | null;
  onNoticeConsumed?: () => void;
}
```

The connect screen plus the folder picker. `oauthError` and
`autoBrowseConnectionId` come from the host's OAuth callback redirect query
(`?error=…`, `?connectionId=…`); the picker auto-opens for a
just-created connection. Both are one-shot — the host owns clearing its own
query params, and `onNoticeConsumed` fires when the component has acted.

The component is deliberately **not admin-gated**: the effective label is capped
to the host's `LabelPolicy` for the connecting user either way, so a connector
is not a bigger privilege grant than any other ingest path. Which route guards
wrap the page is the host's decision.

Exported alongside it, mostly as test seams and reusable derivations:
`BrowsePickerBody`, `browseView`, `browseFailureMessage`, `completionTone`, and
the `BrowseItem` / `BrowseErrorState` / `BrowseView` / `BrowseRecovery` types.

`browseView` exists because of a specific defect: four independent booleans over
four regions left a combination that rendered **nothing**, in front of a
customer, under an enabled button. That lesson cost three fixes, so the picker's
state is now derived once into a closed set and rendered exhaustively.

## `<DriveMap>`

```ts
export interface DriveMapProps {
  connectionId: string;
  scope?: PickedScope | null;
}
```

One component hosts the whole map flow as internal stages: **consent →
mapping → landed → selection ledger → the second consent.** `scope` is what the
host's picker carried in; absent, it is resolved from the connection's stored
root, so the consent screen never names a folder it is not sure of.

- The **consent stage** is the screen the design spec calls the most important
  in the product: the button label *is* the consent record, and the word "agree"
  appears nowhere.
- The **mapping stage** reads `GET /:id/map/stream` with `fetch` plus a body
  reader — **not** `EventSource`. It reveals lines at reading pace
  (`MAP_STREAM_TUNING.revealMs`, 700 ms floor between reveals, not a
  metronome), **reconnects once** after a drop, and on the second drop falls
  back to polling `GET /:id/map` every 2500 ms — and says on screen that it did.
  Under reduced motion the whole transcript appears at once; the pacing is
  theatre.
- `VISIBLE_LINE_CAP` (**40**) bounds the visible transcript; older lines roll
  off the top and **the roll-off is stated on screen**. The full transcript is
  retained for replay and as evidence on failure.
- On a `failed` run the screen **stays on the transcript** rather than swapping
  to a landing placeholder — the transcript is the evidence.
- The **landed stage** receives the terminal run document verbatim and renders
  the inversion, the six absence states, the reconciliation strip, the prune
  report, the top-folder rollup, and a ranked finding pool with a floor and a
  named unremarkable state.

Exported derivations and tunables: `MapLandedStage`, `MAP_STREAM_TUNING`,
`MAP_LANDING_TUNING`, `MAP_LEDGER_TUNING`, `VISIBLE_LINE_CAP`, `COST_MIRROR_OF`,
`stageForRunResolution`, `computeInversion`, `computeFindings`,
`landingAggregates`, `landingReconciliation`, `parseSuggestions`,
`parseVerdict`, `funnelReconciliation`, `selectionTotals`, `isRowSelected`,
`fmtBytes`.

{: .note }
> This package's `MapRunStatus` type lists `mapping | complete | failed |
> refused_no_consent | unsupported_provider`. The server can also answer
> `refused_out_of_scope`. Everything downstream of the stream treats a
> non-`mapping` status as terminal, and closed vocabularies render an unknown id
> verbatim as data — but if you are branching on the union yourself, account for
> the sixth value.

## `<IngestPanel>`

```ts
export interface IngestPanelProps {
  view: IngestView;
  onStartWorking: () => void;
  reducedMotion: boolean;
  renderReviewLink: (label: string) => React.ReactNode;
}
```

Rendered exhaustively behind a compile-time `never`: adding a member to
`IngestView` without giving it a branch is a type error, not a blank card.

**Where the data comes from, exactly:**
`connector_connections.lastIngestProgress`, served by the connections list
route — **not** `selective_ingest_runs`. That collection is canonical and
carries more (per-file `failures[]`), but no route serves it, so it is
unreachable from a browser. Where the itemization is missing, the copy **says
so and names why** rather than showing a bare count.

`renderReviewLink` is deliberately the only "do it again" the screen offers.
Re-reading is a decision plus a consent, and both live in the Decide flow; a
button here that re-POSTed the ingest would rebuild the fused
two-consents-in-one-button design the whole journey exists to split.

Exported alongside: `OutcomeReasons`, `connectorActivity`, `isConnectorActive`,
`normalizeIngestProgress`, `ingestDenominator`, `ingestView`, `outcomeGroups`,
`fileOutcomeStyle`, `orderedFolders`, `INGEST_RUN_STATUSES`,
`FILE_OUTCOME_STYLE`, `MAX_FOLDER_ROWS`.

**Forward compatibility is explicit.** A worker can ship a status this build
does not know, so `normalizeIngestProgress` maps anything outside
`INGEST_RUN_STATUSES` to `status: 'unrecognized'` while keeping `rawStatus`
verbatim — the token is **quoted on screen** rather than hidden behind a shrug.
`fileOutcomeStyle` is total for the same reason: the per-file vocabulary is four
states today and a worker could add a fifth.

`done` is **read, never re-derived**. Four counters summed by three screens is
three chances to sum them differently.

## i18n

```ts
export { t, getLocale, setLocale, assertLocaleParity, en, esMX };
export type { LocaleCode, MessageKey, MessageDict };
export { usePrefersReducedMotion };
```

Two locales, `en` and `es-MX`, with a build-time parity gate. Details — the
gate, the known blind spot around concatenated fragments, number and date
formatting, and how to add a locale — are in
[Internationalization](../i18n.md).

## Styling

The components are Tailwind-classed. A host using Tailwind extends the shipped
preset:

```js
// tailwind.config.js
import shelfmark from '@shelfmark/ui/tailwind-preset';

export default {
  presets: [shelfmark],
  content: ['./src/**/*.{ts,tsx}', './node_modules/@shelfmark/ui/dist/**/*.js'],
};
```

The preset's colors read CSS variables shipped in `@shelfmark/ui/styles.css` —
import that file or copy its blocks into your own sheet. **Dark is the default
posture**; the `light:` variant reads `[data-theme="light"]` on an ancestor,
which the host sets. Only the shades these components actually pair across
themes are variable-mapped: the slate ramp (all the chrome) and the accent
`-400` text shades with their `-950` badge backgrounds, so every status pill
flips to a readable light-mode pill without per-call-site patches.

## Gotchas

- `useShelfmark()` **throws** without a `<ShelfmarkProvider>` above it.
- The provider memoizes on the `config` object identity. Pass a stable
  reference (or memoize it) rather than an inline literal, or the locale is
  re-set and children re-render on every parent render.
- Byte-size unit labels (B/KB/MB/GB) are deliberately untranslated. Numbers
  format through `Intl.NumberFormat(locale)`.
- Closed vocabularies — skip reasons, funnel rules, artifact classes — render
  an unknown id **verbatim as data**, so a missing label never crashes a screen.
- `styles.css` is a separate import; it is not injected by the components.
