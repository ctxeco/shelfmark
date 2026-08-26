// SPDX-License-Identifier: Apache-2.0
import { en } from './en.js';
import { esMX } from './es-MX.js';
import type { LocaleCode, MessageDict, MessageKey } from './types.js';

export type { LocaleCode, MessageKey, MessageDict };
export { en, esMX };

const DICTS: Record<LocaleCode, MessageDict> = {
  en,
  'es-MX': esMX,
};

function normalizeLocale(raw: string | undefined | null): LocaleCode {
  if (!raw) return 'en';
  const v = raw.trim();
  if (v === 'es-MX' || v === 'es_MX' || v === 'es') return 'es-MX';
  return 'en';
}

/**
 * Module-level active locale, set by <ShelfmarkProvider> from its config —
 * never from a window global. Components call t()/getLocale() freely; the
 * provider is the single writer.
 */
let currentLocale: LocaleCode = 'en';

export function setLocale(raw: string | undefined | null): void {
  currentLocale = normalizeLocale(raw);
}

/** Active UI locale. */
export function getLocale(): LocaleCode {
  return currentLocale;
}

export function t(key: MessageKey, vars?: Record<string, string | number>, locale?: LocaleCode): string {
  const loc = locale ?? getLocale();
  const dict = DICTS[loc] || en;
  let out = dict[key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return out;
}

/** Assert en/es-MX key parity — used by unit tests and the CI parity gate. */
export function assertLocaleParity(): { ok: boolean; missingInEs: string[]; missingInEn: string[] } {
  const enKeys = Object.keys(en) as MessageKey[];
  const esKeys = Object.keys(esMX) as MessageKey[];
  const missingInEs = enKeys.filter((k) => !(k in esMX));
  const missingInEn = esKeys.filter((k) => !(k in en));
  return { ok: missingInEs.length === 0 && missingInEn.length === 0, missingInEs, missingInEn };
}
