# Setup: Entra app registration and secrets

Time to first map: ~30 minutes, most of it in the Entra portal. The demo's
`pnpm demo:doctor` checks every step below and prints exactly what is wrong.

## 1. Register the Entra application

Entra portal → App registrations → **New registration**:

- **Supported account types: "Accounts in this organizational directory only"**
  (single-tenant), or multi-tenant *organizations* if you serve several
  tenants. **Never** select "+ personal Microsoft accounts": the code
  authenticates against the `/organizations` authority and refuses MSA — the
  delegated `Files.Read.All`/`Sites.Read.All` scopes behave differently on
  consumer accounts, and a registration that promises MSA while the code
  refuses it produces sign-in errors that look like your bug instead of a
  config mismatch. (In the source system this exact mismatch was an open
  finding, JRN-1; this guide is its resolution.)
- **Redirect URI** (type *Web*): `<publicBaseUrl>/api/v1/connectors/microsoft/callback`
  — for the demo, `http://localhost:5173/api/v1/connectors/microsoft/callback`.
  The URI must match byte-for-byte; trailing slashes count. This is where
  first runs die — `demo:doctor` prints the exact URI to paste.

## 2. Delegated permissions

API permissions → Add → Microsoft Graph → **Delegated**:

| Scope | Why |
| --- | --- |
| `Files.Read.All` | read the user's OneDrive items |
| `Sites.Read.All` | read SharePoint site libraries |
| `offline_access` | refresh tokens — sync/map runs outlive the session |
| `User.Read` | basic profile (sign-in plumbing) |

Everything is **read-only by design**: shelfmark never creates, renames,
moves, overwrites or deletes anything in the drive, and requests no write
scope. Do not add one.

**Enterprise reality:** `Sites.Read.All` (and often `Files.Read.All`) require
**admin consent** in most tenants — an ordinary work account cannot
self-serve. Send your Entra admin this link (fill in the tenant and client
id), which grants org-wide admin consent in one screen:

```
https://login.microsoftonline.com/{tenant-id}/adminconsent?client_id={client-id}
```

Until a Microsoft **publisher verification** is completed for the app
(Partner Center → MPN account → per-app "Verify and save"), users see an
"unverified publisher" warning on the consent screen. It does not block
consent in most configurations, but it kills conversion with strangers;
verify before showing this to customers.

## 3. Client secret

Certificates & secrets → New client secret. Copy the **value** immediately
(it is shown once).

## 4. Application secrets

Two more secrets belong to the deployment, not to Entra:

| Env var | Requirement | Generate |
| --- | --- | --- |
| `CONNECTOR_OAUTH_STATE_SECRET` | ≥ 32 bytes; signs the short-TTL OAuth state JWT | `openssl rand -base64 48` |
| `CONNECTOR_TOKEN_ENCRYPTION_KEY` | base64 of **exactly 32 bytes**; AES-256-GCM DEK for refresh tokens at rest | `openssl rand -base64 32` |

A useful deployment pattern from the source system: seed provider client
id/secret with the literal string `DISABLED-not-configured` so the stack
deploys green and the connector fails **closed** with a named
`connector_not_configured` error until real credentials exist — no deploy
ever waits on an OAuth registration.

## 5. Required configuration

`publicBaseUrl` (the API plugin option) has **no default and the plugin will
not start without it** — it builds the redirect URIs, and a wrong default is
a live OAuth misconfiguration, not a cosmetic one.

## 6. If you put a gateway or policy engine in front

The two OAuth callback routes arrive **without** a bearer token — the
provider redirects the user's browser there directly; authentication is the
signed state JWT inside the request. Any auth gateway in front must exempt
exactly these two paths (exact match, no wildcards):

```
/api/v1/connectors/microsoft/callback
```

(and its Google equivalent if you add a Google provider). Everything else on
the API surface expects your `AuthContextResolver` to authenticate it.
