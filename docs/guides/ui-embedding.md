---
title: Embedding the UI
parent: Guides
nav_order: 3
---

# Embedding the UI

`@shelfmark/ui` ships the three screens of the map → decide → read flow as
React components. They are wired to a host application through
`<ShelfmarkProvider>` and nothing else: every coupling the original screens had
to their shell — an auth header helper, a router, a clearance ladder, a users
endpoint, a window-global locale — maps onto exactly one field of one config
object. That is the same move the [ports](../concepts/the-ports.md) make on
the backend.

## Install

```bash
pnpm add @shelfmark/ui
```

Peer dependencies, as declared:

```json
"peerDependencies": {
  "@tanstack/react-virtual": "^3.0.0",
  "react": "^18.0.0",
  "react-dom": "^18.0.0",
  "react-router-dom": "^6.0.0 || ^7.0.0"
}
```

`@tanstack/react-virtual` is genuinely used — the prune report and the
selection ledger virtualize. `react-router-dom` is declared as a peer, but
**no component in the package imports a router**: routing arrives through
`routes.renderLink`, and the package's own test suite is what uses the router
directly. If your app routes with something else, the components still work;
supply `renderLink` accordingly.

Then, once, at your app entry:

```tsx
import '@shelfmark/ui/styles.css';
```

## `ShelfmarkProvider`, field by field

```ts
export interface ShelfmarkConfig {
  transport: ShelfmarkTransport;
  routes: ShelfmarkRoutes;
  labels?: ShelfmarkLabel[];
  costModel?: ShelfmarkCostModel;
  collaboratorCount?: () => Promise<number | null>;
  providers?: ShelfmarkProviderId[];
  locale?: LocaleCode;
  reducedMotion?: boolean;
}
```

Wrap once, high in your tree, and memoize the config object — the provider
re-resolves on identity change:

```tsx
const config = useMemo<ShelfmarkConfig>(() => ({ /* … */ }), [deps]);

return (
  <ShelfmarkProvider config={config}>
    {/* your routes */}
  </ShelfmarkProvider>
);
```

### `transport` (required)

```ts
export interface ShelfmarkTransport {
  /** Base URL of the @shelfmark/api connector routes as the host mounted
   *  them (e.g. '/api/v1/connectors'). Every request these components make
   *  is `${baseUrl}<route>` — no other origin is ever contacted. */
  baseUrl: string;
  /** Called per request — auth headers, tenant headers, whatever the host's
   *  AuthContextResolver expects on the other end. */
  headers(): Record<string, string>;
}
```

`headers()` is called **per request**, not once — so a token that rotates
mid-session works without remounting:

```ts
transport: {
  baseUrl: '/api/v1/connectors',
  headers: () => ({ Authorization: `Bearer ${auth.accessToken()}` }),
}
```

Whatever you put here has to satisfy the
[`AuthContextResolver`](api-integration.md#wiring-authcontextresolver) on the
server side. The demo sends no headers at all, because its resolver accepts
anything.

### `routes` (required)

```ts
export interface ShelfmarkRoutes {
  connections: string;
  map(connectionId: string): string;
  renderLink(to: string, label: React.ReactNode): React.ReactNode;
  onStartWorking?(scope: { scopePath: string | null; scopeLabel: string }): void;
  onOpenMap?(connectionId: string, scope: PickedScope): void;
}
```

- `connections` — the path of your page that renders `<Connections/>`, used
  for back-links.
- `map(connectionId)` — the path of your page that renders `<DriveMap/>`.
- `renderLink(to, label)` — you render the anchor. A router `<Link>`, a plain
  `<a>`, whatever your shell uses.
- `onStartWorking` — "start working with these files", i.e. wherever your
  corpus lives. Absent → the call-to-action still renders and the click is a
  no-op.
- `onOpenMap` — navigate into the map flow *carrying* the picked scope.

**Why routing is injected rather than owned.** A component library that
hardcodes `<a href>` fights every router; one that imports your router depends
on it. Injecting one function means the host's routing always wins, and the
package keeps zero opinion about it — the same reason the backend takes a
resolver instead of implementing auth.

`onOpenMap` exists because it is the one navigation `renderLink` cannot
express: the picked scope is *state*, not a path. The consent screen must name
the folder the reader just picked, and putting an opaque folder id in a query
string would make it a bookmarkable claim. React Router's location state is
the natural carrier:

```tsx
onOpenMap: (connectionId, scope) =>
  navigate(`/connections/${connectionId}/map`, { state: scope }),
```

If `onOpenMap` is absent the call-to-action falls back to
`renderLink(map(id), …)` and the map resolves its scope from the connection's
stored root instead.

### `labels`

```ts
export interface ShelfmarkLabel { id: string; label: string }
```

The sensitivity labels a reader may pick for ingested content. Display text
comes from you — labels are the *host's* vocabulary (the `LabelPolicy` port),
so there is deliberately no built-in list to fall back to.

> **Empty or absent hides every label control**, and no label travels on the
> ingest start; your server-side `LabelPolicy` default applies.
{: .note }

That is the default posture, and it is the right one until your system
actually has a label vocabulary. Offer a picker only if the server can honor
it: the effective label is capped (or refused) by `LabelPolicy` regardless of
what the UI sent.

### `costModel`

```ts
export const DEFAULT_COST_MODEL: ShelfmarkCostModel = {
  textLikeExtensions: ['md', 'txt', 'csv'],
  textBytesPerToken: 4,
  binaryLowYield: 50,
  binaryHighYield: 4,
};
```

These constants drive the running-total cost mirror as a reader edits the
selection. They are the same numbers as `COST_MODEL` in `@shelfmark/core`,
duplicated here **by value** because importing `@shelfmark/core` would drag its
Mongo dependency into a browser bundle.

The duplication is kept honest at runtime, not by convention: at zero edit
delta the mirror must reproduce the server's own emitted range, and if the two
disagree the edited range is withdrawn from the screen rather than shown. If
you override `costModel`, override it to match your server's estimator — a
mismatch shows up as a disappearing estimate, not as a wrong number.

### `collaboratorCount`

```ts
collaboratorCount?: () => Promise<number | null>;
```

How many people can sign in to this workspace — the input to the shared-tenant
advisory the consent screen shows. **The count, never the people.** Rendering
a colleague's address there would be exactly the leak this package refuses to
build.

Resolutions: `> 1` → the shared-workspace sentence with the number; `1` →
single; `null`, non-finite, a thrown error, or no hook configured at all →
`unknown`, which renders the honest "assume this workspace is shared"
sentence. There is no failure mode where an unknown answer renders as a
reassurance.

### `providers`

```ts
export type ShelfmarkProviderId = 'onedrive' | 'sharepoint';
```

Which providers the connect screen offers. Default: both. Restrict it if your
deployment's Entra app only carries one of the two scopes, or if you only want
to support one.

### `locale`

`'en'` or `'es-MX'`. The provider is the single writer of the i18n module's
locale — it is set during render, before any child calls `t()`, and never from
a window global. `'es'` and `'es_MX'` normalize to `'es-MX'`; anything
unrecognized falls back to `'en'`. Per key, a missing translation falls back to
the English string and then to the key itself, so a partial dictionary
degrades to English rather than to blanks. Key parity between the two
dictionaries is a CI gate. See [i18n](../reference/i18n.md).

### `reducedMotion`

Overrides the OS `prefers-reduced-motion` signal when set. Leave it unset and
the components read the OS signal themselves through a live-updating media
query. Set it to `true` in a screenshot or test harness.

## Mounting the components

### `<Connections/>`

The connect-and-manage screen: the provider picker, the folder picker, the
list of existing connections, and — while a run is in flight — the live
progress panels.

```tsx
export interface ConnectionsProps {
  /** The `error` value from the host's OAuth callback redirect, if any. */
  oauthError?: string | null;
  /** A connection id the host's OAuth callback just created — the folder
   *  picker auto-opens for it. One-shot: the host owns clearing its own
   *  query params (`onNoticeConsumed` fires when this component has acted). */
  autoBrowseConnectionId?: string | null;
  onNoticeConsumed?: () => void;
}
```

The OAuth callback redirects the browser to your `returnPath` with query
parameters; you read them and hand them in, and clear them when told:

```tsx
export const ConnectionsPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const onNoticeConsumed = useCallback(() => setParams({}, { replace: true }), [setParams]);

  return (
    <Connections
      oauthError={params.get('error')}
      autoBrowseConnectionId={params.get('connectionId')}
      onNoticeConsumed={onNoticeConsumed}
    />
  );
};
```

The component is not admin-gated by itself. Which route guards wrap the page
it renders on is your decision; the effective label is capped to your
`LabelPolicy` for the connecting user either way.

### `<DriveMap/>`

The whole map → consent → live narration → landing → decide → ingest flow for
one connection.

```tsx
export interface DriveMapProps {
  connectionId: string;
  /** The scope the host's folder picker carried here (its own router state,
   * query params, whatever it chose). Absent → resolved from the
   * connection's stored root, so the consent screen never names a folder it
   * is not sure of. */
  scope?: PickedScope | null;
}
```

```tsx
export const MapPage: React.FC = () => {
  const { connectionId } = useParams<{ connectionId: string }>();
  const location = useLocation();
  const scope = (location.state as PickedScope | null) ?? null;

  if (!connectionId) return null;
  return <DriveMap connectionId={connectionId} scope={scope} />;
};
```

A deep link or a refresh arrives with no state, and the component resolves the
scope from the connection's stored root rather than guessing.

### `<IngestPanel/>`

The ingest-phase screen. `<Connections/>` renders it for you whenever a
connection has an ingest run to show, so most hosts never mount it directly.
It is exported for hosts that want it on their own page:

```tsx
export interface IngestPanelProps {
  view: IngestView;
  onStartWorking: () => void;
  reducedMotion: boolean;
  renderReviewLink: (label: string) => React.ReactNode;
}
```

`view` is a closed discriminated union — `reading`, `complete`, `partial`,
`deferred`, `nothingRead`, `nothingDone`, `runFailed`, `refused`,
`unrecognized` — and the panel renders it exhaustively behind a compile-time
`never`, so adding a member without a branch is a type error rather than a
blank card. Build it from a run document with the exported helpers:

```tsx
import { IngestPanel, ingestView, normalizeIngestProgress } from '@shelfmark/ui';

const progress = normalizeIngestProgress(runDocFromYourFetch);
if (progress) {
  return (
    <IngestPanel
      view={ingestView(progress)}
      reducedMotion={false}
      onStartWorking={() => navigate('/corpus')}
      renderReviewLink={(label) => <Link to={mapPath}>{label}</Link>}
    />
  );
}
```

`normalizeIngestProgress` returns `null` for anything that is not a run
document, coerces an unknown status to `'unrecognized'` (quoted, never
coerced into a status it does not model), and derives `done` from the four
outcome counts rather than trusting the wire value — a stale `done: 0`
alongside three failures used to render the calm "nothing was changed" card
over a run that did not have it.

`renderReviewLink` is the only "do it again" the screen offers, and it points
back into the Decide flow deliberately: re-reading is a decision plus a
consent, and both live there. A button here that re-POSTed the ingest would
rebuild the fused two-consents-in-one-button design the whole journey exists
to split.

## Styling

Three pieces, and you can take one, two, or all three.

**1. The stylesheet (required).** `@shelfmark/ui/styles.css` defines the CSS
custom-property ramps the components' colors resolve through, plus the
component classes. Import it once at your entry point.

**2. The Tailwind preset (required if you build the classes yourself).** The
components are written in Tailwind utility classes, so your build has to
generate them:

```js
// tailwind.config.js
import shelfmark from '@shelfmark/ui/tailwind-preset';

export default {
  presets: [shelfmark],
  content: [
    './src/**/*.{ts,tsx}',
    './node_modules/@shelfmark/ui/dist/**/*.js', // <- required
  ],
};
```

The dist glob is not optional: without it Tailwind never sees the class names
inside the shipped components and purges every one of them.

**3. Light and dark.** Dark is the default posture — bare `:root` holds the
dark values, and they are byte-identical to Tailwind's real default palette,
so a dark-first app adopting the stylesheet is a no-op by construction.
`:root[data-theme='light']` substitutes readability-matched light values
(contrast computed against the screens' actual text/background pairs, not a
naive inversion).

Set `data-theme` on `<html>`, from your own shell, **before React exists** — an
attribute set after hydration is a visible flash. It is an attribute rather
than a class so it composes with the preset's `light:` variant
(`:is([data-theme="light"] &)`) using an attribute selector.

Only the shades the components actually pair across themes are variable-mapped:
the full slate ramp (the chrome) and the accent `-400` text shades with their
`-950` badge backgrounds, so every `bg-{hue}-950/NN text-{hue}-400` status pill
flips to a readable light-mode pill with no per-call-site patching. Other
shades stay plain Tailwind literals because they already read acceptably on
both backgrounds.

## Testing in jsdom

The package exports a setup file:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['@shelfmark/ui/test-setup'],
  },
});
```

You need it, and specifically you need it for `@tanstack/react-virtual`.
jsdom has no layout engine, so every element reports a size of 0; the
virtualizer concludes that every row is out of view and renders an empty list.
Worse, a no-op `ResizeObserver` mock is not enough — the virtualizer waits for
an actual `ResizeObserver` entry before it considers the scroll container
measured at all, so the container stays permanently unmeasured.

The setup file therefore: stubs `clientHeight`/`clientWidth` and
`getBoundingClientRect` with a fixed generous size; installs a
`ResizeObserver` that **invokes its callback** with a synthetic size on
`observe()`; no-ops `scrollIntoView`; and installs a correctly-shaped
`window.matchMedia` stub (guarded, so a per-test override is not clobbered)
for the reduced-motion hook. It also pulls in
`@testing-library/jest-dom/vitest`.

## Where to go next

- [Mounting the API](api-integration.md) — the routes these components call.
- [i18n](../reference/i18n.md) — the message dictionaries and the parity gate.
