---
title: Security
parent: Project
nav_order: 5
---

# Security

## Reporting a vulnerability

Use **GitHub Private Vulnerability Reporting** on the repository
(Security tab → "Report a vulnerability"). Reports reach the maintainers
without public disclosure. Please do not open public issues for suspected
vulnerabilities. The canonical policy is
[SECURITY.md](https://github.com/ctxeco/shelfmark/blob/main/SECURITY.md).

## What is security-sensitive here

- **The OAuth state JWT and PKCE flow.** The callback routes are
  deliberately anonymous — the provider redirects a browser to them with no
  bearer token — and the signed, short-TTL state is what authenticates them.
- **Refresh-token encryption at rest.** AES-256-GCM envelope encryption; the
  DEK must decode to exactly 32 bytes.
- **The consent engine.** Anything that would let a map or ingest run outside
  its recorded scope is a security bug, not a feature request.
- **The CI gates themselves** — the sanitization gate is what keeps the
  extraction honest.

## What the encryption does and does not protect

`CONNECTOR_TOKEN_ENCRYPTION_KEY` protects **credentials**, not your corpus,
and it protects them against a stolen database — not against someone who can
read both the database and the key store. Say this out loud in your own threat
model rather than inheriting a comfortable assumption from ours.

## Trust boundaries worth stating

- shelfmark requests **read-only** provider scopes and contains no write call
  to provider storage.
- During a **map**, no document is opened; the only outbound traffic is to
  Microsoft endpoints, your configured store, your sink, and your egress gate
  if you configured one. An egress-inventory test pins that set.
- Once bytes cross `DocumentSink.accept()`, they are in **your** system and
  under your controls. shelfmark makes no claim about what happens after.

## Supported versions

Pre-1.0: fixes land on `main` and ship in the next 0.x release. There are no
backports.
