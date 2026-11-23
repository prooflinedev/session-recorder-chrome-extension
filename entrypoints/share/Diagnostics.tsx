import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from '@/lib/export/markdown';
import type { SessionEvent } from '@/lib/session/types';

type DiagnosticEvent = Extract<SessionEvent, { type: 'error' | 'console' | 'net-request' }>;
type Category = 'all' | DiagnosticEvent['type'];
const PAGE_SIZE = 50;

/** Search unescaped values as well as field names, matching text shown in rows. */
function containsText(value: unknown, term: string): boolean {
  if (value === undefined) return false;
  if (value === null) return 'null'.includes(term);
  if (typeof value !== 'object') return String(value).toLocaleLowerCase().includes(term);
  if (Array.isArray(value)) return value.some((item) => containsText(item, term));
  return Object.entries(value).some(([key, item]) =>
    key.toLocaleLowerCase().includes(term) || containsText(item, term),
  );
}

function summary(event: DiagnosticEvent): string {
  if (event.type === 'error') return event.payload.message;
  if (event.type === 'console') return `${event.payload.level}: ${event.payload.text}`;
  const p = event.payload;
  const status = p.failed ? `Failed${p.failureReason ? `: ${p.failureReason}` : ''}` : (p.status ?? 'Pending');
  return `${p.method} ${p.url} — ${status}`;
}

const DiagnosticRow = React.memo(function DiagnosticRow({ event }: { event: DiagnosticEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="diagnostic-event" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary><time>{formatClock(event.t)}</time><span className="diagnostic-kind">{event.type === 'net-request' ? 'Network' : event.type === 'console' ? 'Console' : 'Error'}</span><span className="diagnostic-summary">{summary(event)}</span></summary>
      {open && <pre className="diagnostic-data">{JSON.stringify(event, null, 2)}</pre>}
    </details>
  );
});

export const Diagnostics = React.memo(function Diagnostics({ events }: { events: SessionEvent[] }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const listRef = useRef<HTMLDivElement>(null);
  const focusIndex = useRef<number | null>(null);
  const indexed = useMemo(() => events.flatMap((event) => {
    if (event.type !== 'error' && event.type !== 'console' && event.type !== 'net-request') return [];
    return [event];
  }), [events]);
  const matches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return indexed.filter((event) =>
      (category === 'all' || event.type === category) &&
      (!term || summary(event).toLocaleLowerCase().includes(term) ||
        (event.type === 'net-request' && 'network'.includes(term)) ||
        formatClock(event.t).includes(term) || containsText(event, term)),
    );
  }, [indexed, query, category]);

  useLayoutEffect(() => {
    if (focusIndex.current === null) return;
    listRef.current?.querySelectorAll<HTMLElement>('.diagnostic-event > summary')[focusIndex.current]?.focus();
    focusIndex.current = null;
  }, [limit]);

  const showMore = () => {
    focusIndex.current = limit;
    setLimit(Math.min(limit + PAGE_SIZE, matches.length));
  };

  return (
    <div className="diagnostics">
      <p className="muted">Search recorded errors, console messages, and network events, including captured details.</p>
      <div className="diagnostics-controls">
        <label>Search diagnostics
          <input type="search" value={query} placeholder="Search text, URL, status…" onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE); }} />
        </label>
        <label>Event type
          <select value={category} onChange={(e) => { setCategory(e.target.value as Category); setLimit(PAGE_SIZE); }}>
            <option value="all">All events</option>
            <option value="error">Errors</option>
            <option value="console">Console</option>
            <option value="net-request">Network</option>
          </select>
        </label>
      </div>
      <p className="diagnostics-count" role="status">{matches.length} of {indexed.length} events match{matches.length > limit ? ` · showing ${limit}` : ''}</p>
      {matches.length === 0 && <p className="muted">No matching diagnostics. Try another search or event type.</p>}
      <div className="diagnostics-list" ref={listRef}>
        {matches.slice(0, limit).map((event) => <DiagnosticRow key={event.id} event={event} />)}
      </div>
      {matches.length > limit && <button type="button" className="text-action diagnostics-more" onClick={showMore}>Show more events</button>}
    </div>
  );
});
