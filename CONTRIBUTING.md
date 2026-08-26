# Contributing to shelfmark

Thanks for considering it. A few rules here are unusual and load-bearing —
please read this before your first PR.

## Developer Certificate of Origin (DCO)

Every commit must carry a `Signed-off-by:` line matching the commit author
(`git commit -s`). CI enforces this on every PR commit. Sign-off asserts the
[DCO](https://developercertificate.org/) — that you have the right to submit
the work under Apache-2.0. There is no CLA.

## The sanitization gate

`scripts/sanitize-check.sh` is a required CI check. It bans identifiers from
the platform this code was extracted from: internal repo names, internal
domains, personal identifiers, real account ids, and unallowlisted GUIDs.

Etiquette:
- If your PR trips the gate, fix the string — do not edit the gate.
- Test fixtures needing a UUID: invent one and add it to `.sanitize-allowlist`
  with a comment saying why; reviewers treat allowlist additions as the most
  scrutinized lines in the diff.
- `contoso.sharepoint.com` (Microsoft's official sample tenant) is fine and
  preferred for SharePoint fixtures.
- Plan-key references in comments (`JRN-8`, `34-S09c`, …) are deliberate —
  they resolve in `docs/DESIGN-HISTORY.md`. Don't "clean them up".

## The no-weight-tuning rule

`@shelfmark/policy` ships ranking weights that are **not validated**: measured
on the original corpus, randomized weights reproduced 77% of the top-100
selection vs the declared weights' 81%. Any improvement credited to
coefficient changes is indistinguishable from noise.

**PRs that tune ranking weights are declined unless they come with a
validation corpus and a measured, reproducible delta.** Rule changes (new
artifact classes, new funnel rules) are welcome — they are data changes in
versioned artifacts, reviewed on their own terms.

## Consent disclosure text

The files under `consent/disclosures/` are legal-adjacent text whose SHA-256
is echoed back by consenting users and stored in their consent records.

**Text is never edited in place.** Any change — including a typo fix — is a
new version id (`map_metadata.v2.en.md`, …) with new manifest hashes. CI
(`consent-pin`) fails any PR that modifies a disclosure file without adding a
new version. Editing in place would make previously stored consent records
unresolvable, which defeats the entire mechanism.

## Practical notes

- pnpm monorepo; `pnpm install`, `pnpm build`, `pnpm test`, `pnpm check`
  (gates + build + test).
- Every source file starts with `// SPDX-License-Identifier: Apache-2.0`
  (hygiene gate enforces).
- New packages: `"license": "Apache-2.0"` in package.json; `"private": true`
  only in `demo/`.
- Changesets, fixed version group: `pnpm changeset` with your PR.
- Node ≥ 20. The workflows package requires glibc at runtime
  (`@temporalio/core-bridge`): use `node:20-slim`, never alpine.
