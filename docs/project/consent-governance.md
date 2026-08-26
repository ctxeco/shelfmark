---
title: Consent governance
parent: Project
nav_order: 3
---

# Consent governance

`consent/` at the repo root holds **one** body of legally-operative consent
copy. Every package that shows it, or hashes it into a stored consent record,
holds a **vendored copy** and proves by SHA-256 in CI
(`scripts/consent-pin-check.sh`) that its copy has not drifted.

## The two rules

1. **One canon, vendored everywhere.** Canonical bytes live in `consent/`;
   consumers vendor byte-identical copies. CI compares every vendored copy
   against the canon and every manifest hash against the file it names.
2. **Text is never edited in place.** Any change — including a typo fix — is a
   **new version id** (`map_metadata.v2.en.md`, …) with new manifest hashes.
   The consent record stores the verbatim text, its sha256, and the locale;
   editing v1 in place would make previously stored consent records
   unresolvable, which defeats the mechanism.

## Why canonical is not inside a consumer package

Asymmetry. Make either the API package (which hashes the text into the record)
or the UI package (which shows it) canonical, and it becomes the one place
with no pin: its own edits are unconstrained and only the *other* side goes
red — at exactly the moment the other side's copy is the correct one.

This is not hypothetical. In the system this code was extracted from, two
independent bodies of this copy once coexisted. They disagreed on ids
(`map_metadata.v1` vs `map`), on locales (`es` vs `es-MX`), and on what
revocation does. Feeding the UI's bytes to the API's grant endpoint returned
`409 disclosure_text_mismatch`, and asking for the only Spanish locale the UI
permitted returned `400 disclosure_not_found` — **no Spanish speaker could
grant consent at all**. The canon-plus-pins shape exists so that cannot recur.

## The disclosure round trip (why the SHA matters)

The UI fetches the disclosure and renders it **verbatim** (`whitespace-pre-wrap`,
no trimming, no interpolation). The grant request echoes the sha256 of the
exact bytes rendered. The API refuses a grant whose echoed hash does not match
the registry (`409 disclosure_text_mismatch`) — so a stale or tampered
disclosure can never be silently consented to. The stored record carries the
verbatim text, hash, and locale: what the person saw is what the record holds,
independent of every later edit to the codebase.

## Operator substitution

The shipped text names "this service" — deliberately neutral. A deployment
that wants its own name in the disclosure creates its **own** versioned set
(new ids or a fork of `consent/`), re-hashes, and supplies it through
`createDisclosureRegistry(dir)` in `@shelfmark/core`. The governance rules
above apply unchanged to your fork: your consent records point at your bytes.
