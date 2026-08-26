---
title: "@shelfmark/policy"
parent: Packages
grand_parent: Reference
nav_order: 1
---

# `@shelfmark/policy`

The rules engine: which drive items are machine-generated noise, which
candidates survive the default-selection funnel, and which files the ingest
never opens. **Zero runtime dependencies** and no network access — the only I/O
is reading its own rule artifacts off disk.

```bash
pnpm add @shelfmark/policy
```

```ts
import {
  loadArtifactClasses,
  loadFunnelPolicy,
  evaluateFunnel,
  preIngestSkip,
} from '@shelfmark/policy';
```

Ships ESM (`dist/index.js`) and CJS (`dist/index.cjs`), plus the vendored rule
artifacts under the `./vendor/*` export.

## The artifact is normative; the code is a port

Nothing in this package hardcodes an extension, a prune segment, a machine
name, a regex, or a size floor. The rules are **data**, loaded from versioned
JSON artifacts. The TypeScript here is a port of a reference implementation,
and shared hand-authored fixtures assert that the two implementations agree —
because two implementations of one rule set diverging silently is a failure
this design was bitten by once already.

Two documented limits are preserved *as written* rather than quietly fixed,
because changing either is an artifact revision plus a fixture re-pin:

- Only **one** compound-extension tail is probed (the tail after the first
  dot), so `vendor.bundle.min.js` re-probes `bundle.min.js`, misses, and lands
  on the bare tail `js`.
- Regexes compile with the `i` flag only, matching Python's `re.I`. Python's
  `\d` matches Unicode digits where JavaScript's is ASCII-only.

## Vendored artifacts and the SHA pin

`packages/policy/vendor/`:

| File | What it is |
| --- | --- |
| `artifact-classes.v1.json` | the classifier's rule set — version `1.0.0-rc2`; 7 classes, 36 prune segments, 31 exact machine-generated filenames |
| `funnel-policy.v1.json` | the default-selection funnel — version `1.0.0-rc1`; 6 subtraction rules plus propagation, in a pinned precedence order |
| `selection-policy.v1.json` | version `1.1.0-rc1`; referenced **only** for `parameters.min_bytes` (200), the stub floor |
| `classifier-equivalence.v1.jsonl` | the shared classifier fixture (111 cases) |
| `funnel-equivalence.v1.jsonl` | the shared funnel fixture |

The stub floor lives in `selection-policy.v1.json` and is resolved **by
reference**, which is why that file is vendored at all: the number has exactly
one home.

**Every vendored file is SHA-256 pinned in the test suite.** Changing one is a
deliberate act with the pin moved in the same commit; vendor drift fails by
name. The package manifest's `files` list is pinned the same way, because a
`vendor/` directory that does not ship turns into a load failure at first
classify.

The loaders expose `version` and `sha256` because every map run records which
rule bytes classified it — the run document's `classifierVersion`/`artifactSha`
and the suggestions document's `funnelPolicyVersion`/`funnelPolicySha256`.

### Operator overrides

| Env var | Overrides |
| --- | --- |
| `ARTIFACT_CLASSES_PATH` | the classifier artifact |
| `FUNNEL_POLICY_PATH` | the funnel artifact |
| `SELECTION_POLICY_PATH` | the selection artifact (the stub floor) |
| `CONNECTOR_MAX_INGEST_FILE_BYTES` | the ingest size ceiling |

A configured-but-unreadable path **throws** rather than silently falling back:
an operator who pointed at a rule set meant it to be in force. Loaders cache
per process, keyed on the resolved path(s); `clearArtifactClassesCache()` and
`clearFunnelPolicyCache()` are the test and config-reload hooks.

Both loaders write their load line to **stderr**, not stdout — walk-comparison
tooling uses stdout as a pure data channel, and a load line on stdout was
caught by a byte-for-byte diff against the reference implementation.

## The classifier

```ts
export class ArtifactClasses {
  readonly version: string;
  readonly sha256: string;
  readonly source: string;
  readonly classIds: ReadonlySet<string>;
  readonly extensionCountByClass: Readonly<Record<string, number>>;
  classify(name: string, isFolder: boolean, path?: string): Classification;
  shouldWalk(folderName: string, path?: string): boolean;
}

export interface Classification { classId: string; rule: string }

export function loadArtifactClasses(): ArtifactClasses;
export function parseArtifactClasses(raw: unknown, source: string, sha256: string): ArtifactClasses;
export function clearArtifactClassesCache(): void;
export function vendoredArtifactClassesPath(): string;
export function vendoredEquivalenceFixturePath(): string;

export const MACHINE_GENERATED = 'machine_generated';
export const CONTAINER = 'container';
export const UNCLASSIFIED = 'unclassified';
```

`classify()` is a pure function of one item's **observed metadata** — name,
folder flag, ancestor path. It never reads a file's content; the test suite
scans this module's imports so a content or network endpoint cannot appear
silently. It is also not tenant-aware: the tenant an item belongs to is not an
input to the rules, and callers that emit records own attaching their own
scoping.

The rule is returned, not just the class, because the standing evidence bar is
that a check names itself — a distribution that cannot say which rule produced
it is not auditable. The rule grammar, all lowercased:

`prune_ancestor:<seg>` · `prune_self:<name>` · `is_folder` ·
`machine_name:<name>` · `extension:<ext>` · `name:<name>` · `no_rule_matched`

**Precedence, exactly as the artifact states it** (it is stated there "because
it is where a reimplementation silently diverges" — extension-first would
classify half of `node_modules` as human source):

1. **Folder prune** — any prunable *ancestor* segment. The item's own trailing
   segment is not an ancestor, so a *file* named `coverage` does not prune
   itself. Attribution goes to the **shallowest** matching segment.
2. **Folder self** — a folder whose own name is prunable. Its subtree is never
   walked.
3. **Exact name** — `machine_generated_names` beats extension.
   `package-lock.json` and `config.json` share an extension and could not be
   less alike.
4. **Extension** — compound tail first, then the bare last-dot tail, then a
   whole-name lookup for extensionless build files (`dockerfile`, `makefile`,
   `license`, `cname`, `codeowners`, `gemfile`).
5. **Escape** — `unclassified`. Never a guess. It means *no rule named this
   item*; it does **not** mean "we cannot see inside it", which is
   `opaque_container` — a positive identification reached through rule 4.

`shouldWalk()` is derived from `classify()`: descend unless the folder is
`machine_generated`. This is where the economy lives — returning false on
`node_modules` is what turned a 327,140-item walk into 15,657 on the reference
drive.

**Load-time refusals.** An extension claimed by two classes is a contradiction
in the artifact, not something to resolve by iteration order, and throws at
load. An artifact with no `unclassified` escape class throws. So does a missing
`version` or `rules.prune_segments`.

## The funnel

```ts
export class FunnelPolicy {
  readonly version: string;
  readonly sha256: string;
  readonly candidateClass: string;
  readonly classificationVersion: string;
  readonly shapeIds: readonly string[];
  readonly collapseRuleId: string;
  readonly stubFloor: number;
}

export function loadFunnelPolicy(): FunnelPolicy;
export function parseFunnelPolicy(rawPolicy, rawSelection, source, sha256): FunnelPolicy;
export function evaluateFunnel(
  records: WalkRecord[],
  policy: FunnelPolicy,
  classifier: ArtifactClasses
): FunnelResult;
export function compareCodepoints(a: string, b: string): number;
export class FunnelPolicyError extends Error {}
export const FORBIDDEN_FRAGMENTS: readonly string[];
```

`FunnelResult` carries `candidates` and `default_selection` rollups
(`{files, bytes}`), the `subtractions` table (each rule's files and bytes), the
`sensitive_shape_report` counts, and a `verdicts` map keyed by path.

Verdict grammar: `selected` · `subtracted:<rule_id>` ·
`subtracted:propagated_from:<rule_id>` · `not_candidate:<class>`. Folders get
**no verdict at all**.

The vendored policy's subtraction rules, in their pinned precedence order:
`archived_dump_copy`, `stub_under_200b`, `receipt_shape`,
`machine_output_in_prose`, `third_party_publication`, `propagation`,
`duplicate_fingerprint`. The fingerprint collapse runs **last** over survivors;
the keeper is the path with the fewest `/` components, tie-broken on raw path
codepoints, then id.

**It never trusts a record's recorded class.** Every record is re-classified
through the classifier under the version the policy pins, and a version
mismatch refuses to evaluate — recompute under the pinned artifact or amend the
policy, never mix. Walk records carry `artifact_class`/`class_rule` fields
recorded at *walk* time under whatever version ran then.

**Codepoint order everywhere.** JavaScript's default string comparison is
UTF-16 code-unit order, which differs from Python's for astral-plane
characters, so every determinism-bearing comparison goes through
`compareCodepoints()` rather than `<` on raw strings.

### The holdback refusal, enforced at load

The funnel carries **no** never-suggest category. Every sensitive-shape rule
must declare `report: true` and `subtract: "NEVER"`. Any holdback spelling —
`never_suggest`, `neversuggest`, `ask_first`, `askfirst`, `hold_back`,
`holdback` — appearing as an **object key anywhere** or as a **rule id**
refuses to load. Both halves are checked; the rule-id half was a real hole the
reference implementation's own battery caught mid-build.

Sensitive shapes are **reported and counted, never gated**. This is a
structural refusal, not a convention: a policy that tried to hold files back
cannot be loaded at all.

Regexes are also bounded at load: an empty pattern, one over the length
ceiling, or one containing a nested quantifier is refused as a ReDoS risk.

## Ingest filters

```ts
export const INGEST_CONCURRENCY = 15;
export const DEFAULT_MAX_INGEST_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_INGEST_FILE_BYTES_ENV = 'CONNECTOR_MAX_INGEST_FILE_BYTES';
export const UNREADABLE_EXTENSIONS: ReadonlySet<string>;
export const INGEST_SKIP_REASONS: { … };
export const INGEST_SKIP_REASON_VALUES: readonly IngestSkipReason[];

export function maxIngestFileBytes(): number;
export function extensionOf(name: string): string;
export function preIngestSkip(file: { name: string; size?: number | null }): IngestSkip | null;
export function oversizedAfterDownload(byteLength: number): IngestSkip | null;
export function skipErrorText(skip: IngestSkip): string;
export function countSkipReason(rollup: Record<string, number> | undefined, reason: string | undefined): Record<string, number>;
```

**The size ceiling is derived, not a round number.** A batch holds up to
`INGEST_CONCURRENCY` files in memory at once, and each exists **twice** at its
peak — the downloaded buffer plus the copy built for the hand-off. Against a
2 GiB worker memory limit, the ceiling must satisfy `15 × 2 × ceiling ≪ 2 GiB`:
25 MiB gives roughly 750 MiB of file bytes at full fan-out. Raising it without
lowering the concurrency buys an OOM kill, which fails the whole batch —
including the files that were fine.

A malformed or non-positive `CONNECTOR_MAX_INGEST_FILE_BYTES` falls back to the
default rather than disabling the bound. An unparseable env var must never read
as "no limit".

**`UNREADABLE_EXTENSIONS` is a denylist, and the first version was an allowlist
and it was wrong.** The allowlist mirrored a document parser's explicit route
tables and treated "not in a route table" as "cannot be read" — but that
parser's routing *ends* in a default handler that reads `.doc`, `.ppt`, `.msg`,
`.eml` and `.xlsm` among others. The allowlist therefore silently refused to
download legacy Office documents and mail exports on every real tenant,
reported them as a deliberate skip, and advised customers to convert files the
platform could already read. A corpus shrink presented as an intentional choice
is worse than a crash, because nobody looks for it.

So the filter matches the parser's own posture: **try, unless the type is
unreadable by construction.** The list is media, archives, executables, fonts,
and VM/database blobs. Images are **not** on it — they route to OCR. Adding an
entry is a claim that the parser cannot read the type at all; removing one
costs a wasted download and an honest parse failure, which is the safer
direction to be wrong in.

`preIngestSkip` checks **type first, then size**: for a 3 GB `.mov` both are
true, and "we do not read video" is more useful to a customer than "it was
big". A `size` of `undefined` means the provider did not report one — **not
zero** — so the size bound is deferred to `oversizedAfterDownload`, applied to
bytes already in hand.

The skip vocabulary is **closed** — `already_ingested`, `deferred`,
`too_large`, `unsupported_type`, `unsupported_google_format` — because
`skippedByReason` is a rollup on a polled document, and a rollup keyed on an
open string set is an unbounded map. `countSkipReason` folds anything outside
the vocabulary into `unnamed` rather than growing the map.

## Gotchas

- `extensionOf('.gitignore')` is `''`. A leading-dot name has no extension by
  this package's convention, and the classifier agrees.
- The classifier's `path` argument is the **full breadcrumb path including the
  item's own name** when the caller has one; the ancestor scan drops the
  trailing segment only when it equals the item's own name.
- `loadArtifactClasses()` and `loadFunnelPolicy()` cache per process. In a
  long-lived worker, changing an env var without calling the clear hook has no
  effect.
- `evaluateFunnel` keys its `verdicts` map on `path || name || ''`. Two records
  sharing a path collide.
