---
title: Installation
parent: Getting started
nav_order: 1
---

# Installation

shelfmark is a pnpm monorepo of six libraries plus a runnable demo. There is
no installer and nothing is published to a registry yet — you clone the repo,
build it, and consume the packages from the workspace. This page covers what
must exist on the machine first, why one of those requirements is
non-negotiable, and what the build and the gates actually run.

## Prerequisites

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | `>= 20` — every `package.json` declares `"engines": { "node": ">=20" }`; `.nvmrc` pins `20`; CI runs the matrix on **20 and 22** | ESM, `node:` builtins, and the Temporal SDK's floor |
| pnpm | `10.34.5` — pinned by the root `"packageManager"` field | workspace protocol (`workspace:*`) between the packages |
| MongoDB | reachable instance | the connector-private store: connections, consent records, map runs, candidates, suggestions, selections, ingest runs |
| Temporal server | reachable frontend (gRPC, `:7233` by default) | `@shelfmark/workflows` is Temporal — the map walk and selective ingest are workflows, not request handlers |

Enable pnpm through corepack rather than installing it globally, so the pinned
version is the one that runs:

```bash
corepack enable
```

Both Mongo and Temporal can come from the demo's compose file if you have
nothing running — see [running the demo](running-the-demo.md).

### glibc is a hard requirement, not a preference

{: .warning }
> `@temporalio/core-bridge` — pulled in by `@temporalio/worker`, which the
> **host** supplies (`@shelfmark/workflows` declares `@temporalio/worker` only
> as a devDependency; the demo depends on it directly) — is a **native Rust
> module linked against glibc**. On a musl-based image it fails at `require`
> time. Use `node:20-slim` (Debian), **never** `node:20-alpine`.

This is why the demo's `Dockerfile` says, in the file itself:

```dockerfile
# node:20-slim, NEVER alpine: @temporalio/core-bridge is a native (Rust)
# module linked against glibc; musl-based images fail at require time.
FROM node:20-slim
```

The failure mode is worth naming because it does not look like a libc problem:
the worker process dies during module evaluation, before any of your code runs,
so the first thing you see is a container that exits immediately with a loader
error about a shared object. Nothing in the shelfmark code is involved.

The constraint only binds processes that host a **Temporal worker**. A process
that only registers the Fastify plugin (`@shelfmark/api`) pulls in
`@temporalio/client`, which is pure JavaScript. If you split the API server and
the worker into different images, only the worker image needs glibc — but
keeping both on `node:20-slim` costs nothing and removes a trap.

## Install from the repository

```bash
git clone https://github.com/ctxeco/shelfmark && cd shelfmark
pnpm install
pnpm build
pnpm test
```

`pnpm build` runs `turbo run build`, which respects `dependsOn: ["^build"]` —
packages build in dependency order and each emits to its own `dist/`.
`pnpm test` declares `dependsOn: ["build"]`, so tests always run against built
output rather than a stale one.

`pnpm lint` exists at the root (`turbo run lint`), but no package currently
defines a `lint` script, so today it resolves to nothing. It is not a gate.

## The monorepo layout

```
shelfmark/
├── packages/
│   ├── policy/       @shelfmark/policy
│   ├── graph/        @shelfmark/graph
│   ├── core/         @shelfmark/core
│   ├── workflows/    @shelfmark/workflows
│   ├── api/          @shelfmark/api
│   └── ui/           @shelfmark/ui
├── demo/             the runnable reference host (private, never published)
├── consent/          the canonical disclosure texts + their SHA-256 manifest
└── scripts/          the three gates
```

`pnpm-workspace.yaml` names exactly `packages/*` and `demo`.

| Package | What it is | Runtime dependencies |
| --- | --- | --- |
| `@shelfmark/policy` | The rules engine: artifact classifier, funnel/selection policy, ingest filters. Rules are versioned JSON artifacts vendored under `vendor/`, loaded by path and hashed at load. | **none** — zero-dependency by design |
| `@shelfmark/graph` | The Microsoft Graph drive client: PKCE OAuth against `/organizations`, personal and SharePoint drive resolution, delta queries, paginated browse where truncation is a flag plus a continuation cursor, download, and `GraphHttpError` carrying `retryAfterSeconds`. | `axios` |
| `@shelfmark/core` | Domain types, **the five ports** (`src/ports.ts`), the consent engine and disclosure registry, the cost estimate, `tokenCrypto` (AES-256-GCM for refresh tokens at rest), and the Mongo store (`src/store/`). | `mongodb` |
| `@shelfmark/workflows` | The Temporal layer: `driveMap`, `selectiveIngest` and `sync` workflows plus their activities, assembled by `createActivities(deps)`. | `@temporalio/*`, `mongodb`, the three sibling packages |
| `@shelfmark/api` | The Fastify 5 plugin. One `register` call mounts connections + OAuth callbacks, consents, browse, map (including the SSE narration stream) and ingest. | `@shelfmark/core`, `@shelfmark/graph`, `@temporalio/client`, `fastify-plugin`, `jose`, `mongodb`; **peer** `fastify@^5` |
| `@shelfmark/ui` | React components — `Connections`, `DriveMap`, `IngestPanel` — behind `ShelfmarkProvider`, in English and Mexican Spanish. | **peer only**: `react`, `react-dom`, `react-router-dom`, `@tanstack/react-virtual` |

`demo/` is the reference host: it wires the five ports, runs an API server and
a Temporal worker, and ships an `FsDocumentSink` that turns a selective ingest
into a local searchable corpus.

## Consuming the packages today

{: .important }
> **Nothing is published to npm.** Every package is at version `0.0.0`.
> `pnpm add @shelfmark/core` will not resolve. Plan for workspace consumption.

Changesets is configured (`.changeset/config.json`, one fixed version group
covering `@shelfmark/*`, `access: public`) so publishing is *prepared* — but it
has not happened. Until it does, these are the honest options:

**1. Work inside the workspace (what the demo does).** Add your host app as a
workspace member and depend on the packages by the workspace protocol:

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "demo"
  - "apps/*"        # your host app
```

```json
{
  "dependencies": {
    "@shelfmark/api": "workspace:*",
    "@shelfmark/core": "workspace:*",
    "@shelfmark/ui": "workspace:*",
    "@shelfmark/workflows": "workspace:*"
  }
}
```

This is the only path exercised end-to-end by the repo.

**2. Vendor the repo** (git submodule, subtree, or a plain copy) and point at
it the same way. Same mechanics, your version pin.

**3. Tarballs — for the leaf packages only.** After a build,
`pnpm -C packages/policy pack` produces an installable tarball; each
package's `files` field ships `dist` (and `vendor` where it exists). This works
for `@shelfmark/policy`, `@shelfmark/graph`, `@shelfmark/core` and
`@shelfmark/ui`, which have no workspace siblings among their runtime
dependencies. It does **not** work for `@shelfmark/api` or
`@shelfmark/workflows`: packing rewrites `workspace:*` to the concrete version,
so the tarball demands `@shelfmark/core@0.0.0` from a registry that does not
have it.

**Installing straight from git does not work either**, for a reason worth being
explicit about: `dist/` is gitignored and no package defines a `prepare`
script, so a git-sourced install would deliver source with no build output and
no `main` to resolve. Build it yourself.

## The gates

Three scripts under `scripts/` are required CI checks. All three are
runnable locally and all three are fast.

| Gate | Command | What it enforces |
| --- | --- | --- |
| Sanitization | `pnpm sanitize` | Bans identifiers belonging to the system this code was extracted from — internal repo names, internal domains, personal identifiers, real account ids, and any UUID not listed in `.sanitize-allowlist`. It skips `.env` (gitignored, holds real local credentials) but **does** scan `.env.example`. |
| Hygiene | `pnpm hygiene` | An `SPDX-License-Identifier: Apache-2.0` header in the first three lines of every `.ts`/`.tsx` under `packages/` and `demo/`; `"license": "Apache-2.0"` in every package manifest; `"private": true` only in the repo root and `demo/`. |
| Consent pin | `scripts/consent-pin-check.sh` | Every vendored disclosure byte-matches its canonical copy under `consent/disclosures/`, and every `sha256` in a manifest matches the file it names. |

{: .warning }
> `pnpm check` runs **sanitize + hygiene + build + test** — it does *not*
> include the consent-pin gate. CI does. Run `scripts/consent-pin-check.sh`
> yourself before pushing anything that touches `consent/` or a package's
> `vendor/consent/` tree.

The consent-pin gate is the mechanical half of a rule stated in
[CONTRIBUTING](../project/contributing.md): disclosure text is **never edited
in place**. Its SHA-256 is echoed back by the person consenting and stored in
their consent record; editing the bytes under a stored hash makes previously
recorded consents unresolvable, which defeats the entire mechanism. Any change
— including a typo fix — is a new version id with new manifest hashes.

CI (`.github/workflows/ci.yml`) additionally runs gitleaks, a DCO check
requiring `Signed-off-by:` on every PR commit (`git commit -s`), Semgrep with
SARIF upload, and — in sibling workflows — CodeQL and a Trivy scan of the demo
image.

## Next

- [Entra app setup](entra-setup.md) — the ~30 minutes of portal work that has
  to happen before anything can connect to a real drive.
- [Running the demo](running-the-demo.md) — clone to a mapped drive.
- [Configuration](configuration.md) — every environment variable and option
  object, with defaults and failure modes.
