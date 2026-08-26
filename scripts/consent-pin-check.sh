#!/usr/bin/env bash
# consent-pin gate — REQUIRED CI check.
# 1) every vendored disclosure byte-matches the canon in consent/
# 2) every manifest sha256 matches the file it names
# 3) (in CI diffs) editing a disclosure in place without a new version id is
#    caught by 1+2 going red — text is NEVER edited in place; see CONTRIBUTING.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
fail=0
for canon in consent/disclosures/*.md; do
  base=$(basename "$canon")
  for vendored in packages/*/vendor/consent/disclosures/"$base"; do
    [ -f "$vendored" ] || continue
    if ! cmp -s "$canon" "$vendored"; then
      echo "CONSENT-PIN FAIL [canon/vendored diverge]: $vendored"; fail=1
    fi
  done
done
python3 - <<'PY' || fail=1
import json, hashlib, sys, os
for mf in ['consent/disclosures.manifest.json'] + [p for p in
           ['packages/core/vendor/consent/disclosures.manifest.json'] if os.path.exists(p)]:
    m = json.load(open(mf))
    root = os.path.dirname(mf)
    for d in m['disclosures']:
        f = os.path.join(root, d['file'])
        h = hashlib.sha256(open(f,'rb').read()).hexdigest()
        if h != d['sha256']:
            print(f"CONSENT-PIN FAIL [manifest hash wrong]: {f}"); sys.exit(1)
PY
[ "$fail" -ne 0 ] && exit 1
echo "consent-pin: clean"
