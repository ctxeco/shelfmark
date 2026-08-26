---
title: Contributing
parent: Project
nav_order: 4
---

# Contributing

The canonical, authoritative version is
[CONTRIBUTING.md](https://github.com/ctxeco/shelfmark/blob/main/CONTRIBUTING.md)
in the repository root. This page exists so the rules are discoverable from
the wiki; where the two ever disagree, the file in the repo wins.

Four of the rules here are unusual and load-bearing.

## Developer Certificate of Origin

Every commit carries a `Signed-off-by:` line matching its author
(`git commit -s`), enforced by CI. There is no CLA.

## The sanitization gate

`scripts/sanitize-check.sh` is a required check. It bans identifiers from the
platform this code was extracted from — internal repo names, internal domains,
personal identifiers, unallowlisted GUIDs.

If your PR trips it, fix the string; never edit the gate. Test fixtures
needing a UUID add a line to `.sanitize-allowlist` with a comment saying why —
reviewers treat allowlist additions as the most scrutinized lines in a diff.
`contoso.sharepoint.com` is Microsoft's official sample tenant and is the
preferred SharePoint fixture.

Plan-key references in comments (`JRN-8`, `34-S09c`, …) are deliberate
provenance and resolve in the [design history](design-history.md). They are
not litter; please do not tidy them away.

## No weight tuning without a corpus

The selection policy's ranking weights carry no proven signal: on the original
validation corpus, randomized weights reproduced 77% of the top-100 selection
against the declared weights' 81%. Any improvement credited to coefficient
changes is indistinguishable from noise.

PRs that tune ranking weights are declined unless they arrive with a
validation corpus and a measured, reproducible delta. Rule changes — new
artifact classes, new funnel rules — are welcome; those are data changes in
versioned artifacts and are reviewed on their own terms.

## Consent text is never edited in place

Any change to a disclosure document, including a typo fix, is a **new version
id** with new manifest hashes. Editing v1 in place would make previously
stored consent records unresolvable. CI enforces it. See
[consent governance](consent-governance.md).

## Practical

pnpm monorepo — `pnpm install`, `pnpm build`, `pnpm test`, `pnpm check`
(gates + build + test). Every source file starts with
`// SPDX-License-Identifier: Apache-2.0`. Changesets, fixed version group.
Node ≥ 20, glibc at runtime for the workflows package.
