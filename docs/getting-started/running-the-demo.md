---
title: Running the demo
parent: Getting started
nav_order: 3
---

# Running the demo

`demo/` is the reference host: an API server, a Temporal worker, a small React
shell, and an `FsDocumentSink` that turns a selective ingest into a searchable
local text corpus. It exists to be read as much as run — it is the answer to
"what does a host actually have to wire up".

This page is the fastest path from a clone to a mapped drive.

**Before you start:** [installation](installation.md) (Node ≥ 20, pnpm,
`pnpm install && pnpm build`) and [Entra app setup](entra-setup.md) — you need
a client id and a client secret before anything can connect.

## 1. Configuration

```bash
cp demo/.env.example demo/.env
```

`demo/.env` is gitignored. Fill in five values; everything else has a default.

| Variable | What it is |
| --- | --- |
| `PUBLIC_BASE_URL` | The externally reachable base URL of the demo, scheme + host, no trailing slash. It **builds the OAuth redirect URI**, so it has to match what you registered in Entra. `http://localhost:5173` for the dev path, `http://localhost:8787` for the compose path. There is deliberately no default. |
| `CONNECTOR_MS_CLIENT_ID` | The Entra app registration's Application (client) ID. |
| `CONNECTOR_MS_CLIENT_SECRET` | The client secret **value** (not the id — Entra shows the value once). |
| `CONNECTOR_OAUTH_STATE_SECRET` | HMAC key for the short-TTL OAuth state JWT. At least 32 bytes: `openssl rand -base64 48`. |
| `CONNECTOR_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key encrypting refresh tokens at rest. Base64 of **exactly** 32 bytes: `openssl rand -base64 32`. |

The optional knobs — `MONGODB_URI`, `MONGODB_DB`, `TEMPORAL_ADDRESS`, `PORT`,
`DEMO_DATA_DIR`, `DEMO_LABELS`, `DEMO_DEFER_OVER_MB`, `DEMO_SINK` and the S3
group — are documented with their defaults and failure modes in
[configuration](configuration.md).

## 2. Run the doctor

```bash
pnpm demo:doctor          # from the repo root
# or, from demo/:  pnpm doctor
```

The doctor is plain Node with no build step. It reads `demo/.env` (real
process env always wins), checks each required variable is present and not
still the `.env.example` placeholder, verifies the two generated secrets decode
to the right sizes, pings Mongo with the driver (a two-second
server-selection timeout) and opens a TCP connection to Temporal. Each
check prints `PASS` or `FAIL` with the reason; it exits `1` if anything failed.

Then it prints the single thing that fixes most first runs:

```
Register this EXACT redirect URI (type Web) on the Entra app:

    http://localhost:5173/api/v1/connectors/microsoft/callback
```

{: .important }
> **This is where first runs die.** The redirect URI must match byte for byte
> — scheme, host, port, path, and the absence of a trailing slash all count.
> Paste the doctor's line into the Entra portal rather than retyping it. The
> URI is derived from your `PUBLIC_BASE_URL`, so if you switch between the dev
> path and the compose path, the URI changes and Entra needs both registered.

Reachability failures at this point are expected if you have not started
Mongo and Temporal yet — that is step 3.

## 3. Start it

Two paths. They differ in which process serves the browser, which changes
`PUBLIC_BASE_URL` and therefore the redirect URI.

### Path A — docker compose (one command, closest to a deployment)

```bash
cd demo
# PUBLIC_BASE_URL must be http://localhost:8787 for this path
docker compose up --build
```

Four services come up: the Temporal dev server (gRPC `:7233`, Web UI `:8233`),
MongoDB (`:27017`), the demo API server (`:8787`, serving the built web app),
and the Temporal worker. The images are pinned by multi-arch index digest —
bump them deliberately, never implicitly.

Open **<http://localhost:8787>**.

{: .note }
> Compose sets `MONGODB_URI`, `TEMPORAL_ADDRESS`, `PORT` and `DEMO_DATA_DIR`
> in its own `environment:` block, which takes precedence over the `env_file`.
> Values you set for those four in `demo/.env` are ignored on this path — they
> have to be the container-internal ones (`mongo:27017`, `temporal:7233`).
> `PUBLIC_BASE_URL` is interpolated (`${PUBLIC_BASE_URL:-http://localhost:8787}`),
> so your `.env` value does apply to it.

Mongo and Temporal ports are published to the host on purpose, so you can stop
the `app`/`worker` services and switch to Path B against the same database.

### Path B — three processes (the dev loop)

Bring up just the infrastructure, then run the app from source with watch mode:

```bash
cd demo
docker compose up temporal mongo      # or your own Mongo + `temporal server start-dev`
```

```bash
pnpm demo:dev                          # from the repo root
# or, from demo/:  pnpm dev
```

`concurrently` starts three named processes:

| Process | What | Port |
| --- | --- | --- |
| `server` | `tsx watch src/server.ts` — the Fastify API | `8787` |
| `worker` | `tsx watch src/worker.ts` — the Temporal worker | (polls `shelfmark-queue`) |
| `web` | `vite web` — the React shell | `5173` |

The Vite dev server proxies `/api` to `:8787`, so the browser sees **one
origin** and `PUBLIC_BASE_URL=http://localhost:5173` covers both the pages and
the OAuth callback.

Open **<http://localhost:5173>**.

{: .warning }
> The worker is not optional. The API only *starts* workflows; the map walk
> and the ingest run in the worker. With no worker polling `shelfmark-queue`,
> the UI sits on a run that never produces a line and nothing tells you why —
> check the Temporal Web UI at <http://localhost:8233> and you will see the
> workflow queued with no worker.

## 4. What you should see

The whole flow lives in two pages (`/connections` and
`/connections/:id/map`), which mount the packaged components. In order:

1. **Connect.** On `/connections`, pick OneDrive or SharePoint. You are sent to
   Microsoft, sign in, and consent to the delegated read-only scopes. The
   callback lands back on `/connections?connected=<provider>&connectionId=conn-…`;
   the refresh token is encrypted with your DEK before it is stored, and the
   connection list never projects it.

2. **Browse and pick a scope.** The browse view opens automatically for the
   connection you just made. Pick the folder you want mapped. A listing that
   hit its ceiling says so: `truncated: true` plus the cursor to continue
   from, never silence.

3. **The map consent.** The first of two consents. The disclosure text for
   scope `map_metadata` is on screen verbatim, and the button label *is* the
   record — the word "agree" appears nowhere. Granting posts the SHA-256 of
   the exact bytes displayed; a mismatch is a `409` and a re-fetch, not a
   shrug.

4. **The narration.** The walk streams over SSE (`GET /:id/map/stream`),
   revealed at reading speed — roughly 700 ms per line, with an SSE comment
   heartbeat after 15 s of quiet so proxies do not cut a long silent walk.
   Lines carry a kind glyph. The shipped walk emits `sum`, `chk` and `fix`
   only (`NarrationKind` in `workflows/src/workflows/driveMap.ts`); the UI also
   renders an `ask` kind, reserved for a host that adds model narration of its
   own — nothing here ever emits one. Every number in it is
   deterministic arithmetic; there are no model calls anywhere in this
   codebase. **No file is opened during the map** — it is listings only.

5. **The landing.** The terminal run document, rendered: exact counts, the
   top-folder rollup, pruned subtrees itemized *with the rule that pruned
   them*, truncation flags, a reconciliation strip, and the sensitive-looking
   findings reported as counts. Files that look sensitive are reported, never
   silently withheld.

6. **The ledger (decide).** The selection funnel's default selection, editable
   row by row, with the cost block. If the ledger cannot show every row it says
   so and disables Continue rather than implying you reviewed what you did not
   see.

7. **The second consent.** Scope `ingest_content`, same shape as the first,
   with the real count in the button label and the live selection behind it.
   A `map_metadata` grant does **not** satisfy it. If labels are configured
   (`DEMO_LABELS`), the label question is asked here — after the map is the
   evidence that makes it answerable — and nowhere earlier.

8. **Ingest.** `POST /:id/ingest` answers `202` with a workflow id and the page
   flips to "Reading has started." Live progress — files read, folders
   scanned, skipped/deferred/failed counts, recent files — renders on the
   connections screen while the worker works.

9. **Search the corpus.** The search box on `/connections` queries
   `GET /api/v1/demo/search`, a MiniSearch index over the extracted text. Hits
   come back with the filename, the remote path, an excerpt and the label.

At any point, <http://localhost:8233> shows the Temporal Web UI: the workflow
history, the activity retries, and the `continueAsNew` checkpoints.

## Where the files land

The `FsDocumentSink` writes everything under `DEMO_DATA_DIR` (default `./data`,
resolved against the process's working directory — `demo/data` on both paths):

```
demo/data/
├── ingested/<tenantId>/<connectionId>/<remotePath…>/<filename>      the original bytes
├── ingested/<tenantId>/<connectionId>/<remotePath…>/<filename>.txt  extracted plain text
├── manifest.jsonl        append-only: one line per accept(), including failures and deferrals
├── search-index.json     the persisted MiniSearch index the search endpoint reads
└── documents.json        current bytes/sidecar path per documentId
```

The remote folder layout becomes the storage layout: it is provenance, and
OneDrive/SharePoint forbid same-name siblings, so `remotePath` + `filename` is
unique per connection. Stored paths are **relative** to the data directory, so
no local absolute path — usernames included — ever lands inside the corpus.

The manifest is the sink's honest history and the files are its current state.
That distinction is deliberate: a re-ingest under the same `documentId` updates
the index and removes superseded bytes if the file moved or was renamed
remotely, while the manifest keeps both events. Text extraction covers PDF
(`pdf-parse`), DOCX (`mammoth`) and the text-native types passed through
verbatim; anything else — xlsx, pptx, octet-stream — is an honest
`{status:'failed'}` with a manifest line saying why, never an empty sidecar and
never an index entry pretending a spreadsheet was read.

{: .note }
> On the compose path, `demo/data/` also holds `temporal/` and `mongo/`
> subdirectories — the two services' volumes. `demo/data` is gitignored in its
> entirety. Deleting it resets the corpus but not the Mongo state that
> references it.

## Seeing the deferred lane

A `DocumentSink` has four outcomes, and `deferred` — "not now", the
quota/budget/backpressure answer — is the one you would otherwise never
exercise on a laptop. `DEMO_DEFER_OVER_MB` stands in for it with a byte
threshold:

```bash
DEMO_DEFER_OVER_MB=5
```

Files larger than that answer `{status:'deferred'}` on the first pass, with the
reason recorded in the manifest. The retry re-submission arrives with
`isRetry` set and is accepted — so the full **defer → retry → ingested** story
is visible in the run ledger and in the connections-screen counters, instead of
a file stuck forever in a state you cannot reproduce.

## What the demo is not

Read these before mistaking the demo for a deployment shape.

- **Single-tenant, no authentication.** The demo's `AuthContextResolver`
  returns a fixed `{ tenantId: 'demo', sub: 'demo-user' }` for *every* request
  — it never returns `null`, so nothing ever answers `401`. This is the one
  deliberate shortcut in the demo. A real host resolves a **verified**
  credential (a JWT its gateway validated, say) into that shape and returns
  `null` for anything unauthenticated. The two OAuth callback routes are the
  documented exception and are already handled inside `@shelfmark/api`.
- **No egress gate.** `egressGate` is left `undefined`, and by contract an
  absent gate means allow. That is a decision the demo makes explicitly, not
  an oversight — and it is not the same as a broken gate. A gate that *is*
  configured and throws must be treated as a retryable outage: the run pauses,
  it never proceeds as if allowed.
- **Everything enabled.** `tenantPolicy` is `DEFAULT_TENANT_POLICY`:
  connectors on, mapping on, for everyone.
- **Disposable state.** `demo/data/` and the Mongo database are local scratch.
  The Temporal dev server keeps its history in a SQLite file under the same
  tree. None of it is backed up, and the compose stack is not hardened for
  anything but a laptop.
- **Not a production topology.** One server process and one worker process on
  a task queue named `shelfmark-queue`, with no TLS, no replicas and no
  secrets manager.

## Next

- [Configuration](configuration.md) — every variable, its default, and what
  breaks when it is wrong.
- [Concepts](../concepts/index.md) — why map and ingest are separate acts.
- [Guides](../guides/index.md) — wiring the ports into your own host.
- [Known limitations](../project/known-limitations.md) — what is deliberately
  not claimed.
