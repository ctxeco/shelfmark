#!/usr/bin/env bash
# shelfmark hygiene gate — REQUIRED CI check.
# 1) SPDX header in every source file  2) license field in every package.json
# 3) "private": true only where allowed
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
fail=0

while IFS= read -r f; do
  if ! head -3 "$f" | grep -q 'SPDX-License-Identifier: Apache-2.0'; then
    echo "HYGIENE FAIL [missing SPDX header]: $f"; fail=1
  fi
done < <(find packages demo -type f \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null)

while IFS= read -r p; do
  if ! grep -q '"license": "Apache-2.0"' "$p"; then
    echo "HYGIENE FAIL [missing license field]: $p"; fail=1
  fi
done < <(find packages -name package.json -maxdepth 2 -not -path '*/node_modules/*' 2>/dev/null)

while IFS= read -r p; do
  case "$p" in
    ./package.json|./demo/package.json) ;;
    *) echo "HYGIENE FAIL [private:true outside root/demo]: $p"; fail=1 ;;
  esac
done < <(grep -rl '"private": true' . --include=package.json --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null)

[ "$fail" -ne 0 ] && exit 1
echo "hygiene: clean"
