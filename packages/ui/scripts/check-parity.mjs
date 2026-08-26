// SPDX-License-Identifier: Apache-2.0
//
// i18n locale-parity gate — BUILD-BLOCKING (runs first in the package build
// script, and as a required CI check). Every message key must exist in en,
// in es-MX, AND in the MessageKey union — a string with no counterpart in
// either direction, or a key the type does not know, is a red build, not a
// runtime fallback.
//
// It parses the SOURCE files rather than importing them (the build has not
// produced dist yet when this runs), extracting quoted keys in the five
// shipped namespaces. The extraction pattern matches how the files are
// written: dictionary entries start a line with '<key>': and the type union
// lists | '<key>'. A key smuggled in some other shape would fail here loudly
// as a set mismatch, not silently pass.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const i18nDir = join(here, '..', 'src', 'i18n');

const NAMESPACES = ['labels', 'connectors', 'map', 'mapConsent', 'ingestConsent'];
// After the closing quote: a `:` (dictionary entry), end of line (union
// member), or `;` (the union's final member).
const KEY_RE = new RegExp(`^\\s*(?:\\| )?'((?:${NAMESPACES.join('|')})\\.[^']+)'(?::|;?$)`);

function keysOf(file) {
  const keys = new Set();
  for (const line of readFileSync(join(i18nDir, file), 'utf8').split('\n')) {
    const m = KEY_RE.exec(line);
    if (m) keys.add(m[1]);
  }
  if (keys.size === 0) {
    console.error(`i18n parity FAILED: no keys extracted from ${file} — the gate itself is broken`);
    process.exit(1);
  }
  return keys;
}

const en = keysOf('en.ts');
const es = keysOf('es-MX.ts');
const types = keysOf('types.ts');

let failed = false;
function diff(label, a, b) {
  const missing = [...a].filter((k) => !b.has(k)).sort();
  if (missing.length > 0) {
    failed = true;
    console.error(`i18n parity FAILED — ${label}:`);
    for (const k of missing) console.error(`  ${k}`);
  }
}

diff('in en but missing from es-MX', en, es);
diff('in es-MX but missing from en', es, en);
diff('in en but missing from the MessageKey union', en, types);
diff('in the MessageKey union but missing from en', types, en);

if (failed) process.exit(1);
console.log(`i18n parity OK — ${en.size} keys, en ↔ es-MX ↔ MessageKey`);
