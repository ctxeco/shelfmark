// SPDX-License-Identifier: Apache-2.0
// Tiny search box over the FsDocumentSink corpus, via the demo-only
// /api/v1/demo/search endpoint (MiniSearch index the worker maintains).
// Demo-only on purpose: search is sink/host territory, not library surface.
import React, { useEffect, useRef, useState } from 'react';

interface SearchHit {
  documentId: string;
  score: number;
  filename: string;
  remotePath: string;
  excerpt: string;
  label: string;
  ingestedAt: string;
}

export const SearchBox: React.FC = () => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (q === '') {
      setHits(null);
      return;
    }
    timer.current = setTimeout(() => {
      fetch(`/api/v1/demo/search?q=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { results?: SearchHit[] } | null) => setHits(body?.results ?? []))
        .catch(() => setHits([]));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  return (
    <section>
      <label htmlFor="corpus-search" className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
        Search the ingested corpus
      </label>
      <input
        id="corpus-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search ingested documents…"
        className="w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-slate-600 focus:outline-none"
      />
      {hits !== null && (
        <ul className="mt-2 divide-y divide-slate-800/60 rounded border border-slate-800">
          {hits.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-500">No matches in the corpus yet.</li>
          )}
          {hits.map((hit) => (
            <li key={hit.documentId} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-slate-200">{hit.filename}</span>
                <span className="shrink-0 font-mono text-[11px] text-slate-500">{hit.remotePath}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{hit.excerpt}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
