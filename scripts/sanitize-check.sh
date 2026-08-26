#!/usr/bin/env bash
# shelfmark sanitization gate — REQUIRED CI check.
# Bans internal ctxEco-platform identifiers from ever entering this repo.
# Any hit outside the per-pattern allowlist fails the build. See CONTRIBUTING.md.
#
# Explicitly ALLOWED and never banned here:
#   - "contoso.sharepoint.com"      (Microsoft's official sample tenant)
#   - the bare brand word "ctxeco"  (the GitHub org name)
#   - plan keys like JRN-8, 34-S09c (opaque; resolved in docs/DESIGN-HISTORY.md)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Files the scanner must not scan: itself, the allowlist, git internals, deps.
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
          --exclude-dir=.turbo --exclude-dir=coverage --exclude-dir=data
          --exclude=sanitize-check.sh --exclude=.sanitize-allowlist
          --exclude=.env)
# .env is gitignored and holds a developer's real local credentials — it can
# never reach the repo, so the gate skips it (a local run must not read as a
# leak). .env.example IS committed and IS scanned.

fail=0

scan() { # scan <pattern> <flags> <label> [allowed-file...]
  local pattern="$1" flags="$2" label="$3"; shift 3
  local hits
  hits=$(grep -rn $flags -E "$pattern" . "${EXCLUDES[@]}" 2>/dev/null || true)
  # Drop hits in explicitly allowed files
  local allowed
  for allowed in "$@"; do
    hits=$(printf '%s\n' "$hits" | grep -v "^\./$allowed:" || true)
  done
  hits=$(printf '%s\n' "$hits" | sed '/^$/d')
  if [ -n "$hits" ]; then
    echo "SANITIZE FAIL [$label]:"
    printf '%s\n' "$hits" | head -20
    fail=1
  fi
}

scan 'zimax'            '-i' 'company brand'            NOTICE
scan '(^|[^a-zA-Z0-9])sai\.' '-i' 'internal host prefix'
scan 'ctxeco-(core-api|temporal-workers|web|infra-gitops|mcp-gateway|policies-opa|rag-agent|keycloak-extensions|learn|marketing|wiki|ci-templates|architecture)' '' 'internal repo name'
scan 'ctxeco\.(com|io|app|net|dev)' '-i' 'internal domain'
scan 'derek|triedstone' '-i' 'personal identifier'
scan 'acct_[A-Za-z0-9]' ''  'stripe account id'
scan 'mandala'          '-i' 'customer name'
scan 'gabriela'         '-i' 'customer contact'
scan 'minioadmin'       ''  'well-known default credential'
scan '@ctxeco\.com'     '-i' 'internal email domain'

# GUIDs: any UUID not present in .sanitize-allowlist (exact string, one per line,
# '#' comments allowed). Adding a line requires PR review.
GUID='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
guid_hits=$(grep -rn -E "$GUID" . "${EXCLUDES[@]}" 2>/dev/null | grep -v '^\./\.sanitize-allowlist:' || true)
if [ -n "$guid_hits" ]; then
  while IFS= read -r line; do
    uuid=$(printf '%s' "$line" | grep -o -E "$GUID" | head -1)
    if ! grep -q -F "$uuid" .sanitize-allowlist 2>/dev/null; then
      echo "SANITIZE FAIL [unallowlisted GUID]: $line"
      fail=1
    fi
  done <<< "$guid_hits"
fi

if [ "$fail" -ne 0 ]; then
  echo; echo "Sanitization gate FAILED. See CONTRIBUTING.md for the policy."
  exit 1
fi
echo "sanitize: clean"
