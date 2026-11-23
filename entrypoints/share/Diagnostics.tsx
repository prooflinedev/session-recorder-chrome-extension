import React, { useMemo, useState } from 'react';
import { formatClock } from '@/lib/export/markdown';
import type { SessionEvent } from '@/lib/session/types';

type DiagnosticEvent = Extract<SessionEvent, { type: 'error' | 'console' | 'net-request' }>;
type Category = 'all' | DiagnosticEvent['type'];
const PAGE_SIZE = 50;

function summary(event: DiagnosticEvent): string {
  if (event.type === 'error') return event.payload.message;
  if (event.type === 'console') return `${event.payload.level}: ${event.payload.text}`;
  const p = event.payload;
  const status = p.failed ? `Failed${p.failureReason ? `: ${p.failureReason}` : ''}` : (p.status ?? 'Pending');
  return `${p.method} ${p.url} — ${status}`;
}

export function Diagnostics({ events }: { events: SessionEvent[] }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const indexed = useMemo(() => events.flatMap((event) => {
    if (event.type !== 'error' && event.type !== 'console' && event.type !== 'net-request') return [];
    const detail = JSON.stringify(event, null, 2);
    return [{ event, detail, search: detail.toLocaleLowerCase() }];
  }), [events]);
  const matches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return indexed.filter(({ event, search }) =>
      (category === 'all' || event.type === category) && (!term || search.includes(term)),
    );
  }, [indexed, query, category]);

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
      <div className="diagnostics-list">
        {matches.slice(0, limit).map(({ event, detail }) => (
          <details className="diagnostic-event" key={event.id}>
            <summary><time>{formatClock(event.t)}</time><span className="diagnostic-kind">{event.type === 'net-request' ? 'Network' : event.type === 'console' ? 'Console' : 'Error'}</span><span className="diagnostic-summary">{summary(event)}</span></summary>
            <pre className="diagnostic-data">{detail}</pre>
          </details>
        ))}
      </div>
      {matches.length > limit && <button type="button" className="text-action diagnostics-more" onClick={() => setLimit((n) => n + PAGE_SIZE)}>Show more events</button>}
    </div>
  );
}
