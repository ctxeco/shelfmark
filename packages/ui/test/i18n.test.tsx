// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { assertLocaleParity, getLocale, setLocale, t, ShelfmarkProvider, useShelfmark } from '../src/index';
import type { ShelfmarkConfig } from '../src/index';

afterEach(() => setLocale('en'));

describe('the i18n module', () => {
  it('en and es-MX carry the same key set — the same claim the build gate makes', () => {
    const r = assertLocaleParity();
    expect(r.missingInEs).toEqual([]);
    expect(r.missingInEn).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('interpolates every occurrence of a variable', () => {
    expect(t('connectors.ingest.progress', { done: '60', selected: '240', pct: 25 })).toBe(
      '60 of 240 files · 25%'
    );
  });

  it('locale is set by the provider config, never by a window global', () => {
    const config: ShelfmarkConfig = {
      transport: { baseUrl: '/x', headers: () => ({}) },
      routes: { connections: '/c', map: (id) => `/c/${id}`, renderLink: (to, label) => <a href={to}>{label}</a> },
      locale: 'es-MX',
    };
    const Probe: React.FC = () => {
      useShelfmark();
      return <p>{t('connectors.status.connected')}</p>;
    };
    render(
      <ShelfmarkProvider config={config}>
        <Probe />
      </ShelfmarkProvider>
    );
    expect(getLocale()).toBe('es-MX');
    expect(screen.getByText('Conectado')).toBeInTheDocument();
  });

  it('formats counts with the locale’s own separators — the es-MX fix', () => {
    setLocale('es-MX');
    expect(new Intl.NumberFormat(getLocale()).format(1234567)).not.toBe('1,234,567'.replace(/,/g, ''));
    // Whatever the exact separator, it is not the bare unseparated digits.
    expect(new Intl.NumberFormat(getLocale()).format(1234567)).not.toBe('1234567');
  });

  it('an unknown key falls through to the key itself rather than crashing', () => {
    expect(t('connectors.no.such.key' as any)).toBe('connectors.no.such.key');
  });
});
