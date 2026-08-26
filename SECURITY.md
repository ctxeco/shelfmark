# Security Policy

## Reporting a vulnerability

Use **GitHub Private Vulnerability Reporting** on this repository
(Security tab → "Report a vulnerability"). Reports go directly to the
maintainers without public disclosure.

Please do not open public issues for suspected vulnerabilities.

What helps us triage fast: the affected package (`@shelfmark/*`), a minimal
reproduction, and whether the issue is reachable through the demo composition
or requires a custom deployment.

Areas we consider security-sensitive in this codebase:

- The OAuth state JWT and PKCE flow (`@shelfmark/api`)
- Refresh-token encryption at rest (`@shelfmark/core` tokenCrypto)
- The consent engine — anything that would let a map or ingest run outside
  its recorded consent scope
- The sanitization/hygiene CI gates themselves

## Supported versions

| Version | Supported |
| --- | --- |
| latest 0.x | ✅ |
| anything older | ❌ — upgrade to latest |

Pre-1.0, fixes land on `main` and ship in the next 0.x release; we do not
backport.
