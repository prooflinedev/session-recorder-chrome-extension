/**
 * Past-sessions list for the idle view: name, date, duration and asset size for
 * each recorded session. Clicking a row opens the export/review panel; the
 * delete button removes the session (cascading its events + assets).
 */

import React, { useState } from 'react';
import { formatClock } from '@/lib/export/markdown';
import type { Session } from '@/lib/session/types';
import { useSessionList } from './useSessionList';

interface SessionListProps {
  onOpen: (sessionId: string) => void;
}

export function SessionList({ onOpen }: SessionListProps): React.JSX.Element {
  const { sessions, loading, remove, now } = useSessionList();
  const [query, setQuery] = useState('');

  if (loading && sessions.length === 0) {
    return <p className="sessions__empty">Loading…</p>;
  }

  if (sessions.length === 0) {
    return <p className="sessions__empty">No recordings yet.</p>;
  }

  const term = query.trim().toLocaleLowerCase();
  const matches = sessions.filter((session) => session.name.toLocaleLowerCase().includes(term));

  return (
    <div className="sessions">
      <label className="sessions__search">
        Search recordings
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {matches.length === 0 && <p className="sessions__empty" role="status">No matching recordings.</p>}
      <ul className="sessions__list" aria-label="Recorded sessions">
        {matches.map((s) => (
          <li key={s.id} className="session-row">
            <button
              type="button"
              className="session-row__main"
              onClick={() => onOpen(s.id)}
            >
              <span className="session-row__name">{s.name}</span>
              <span className="session-row__meta">
                <time dateTime={new Date(s.startedAt).toISOString()} title={new Date(s.startedAt).toLocaleString()}>{relativeTime(s.startedAt, now)}</time> · {formatClock(durationOf(s))}
              </span>
            </button>
            <button
              type="button"
              className="session-row__delete"
              aria-label={`Delete ${s.name}`}
              title="Delete"
              onClick={() => void remove(s.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function durationOf(s: Session): number {
  return Math.max(0, (s.endedAt ?? s.startedAt) - s.startedAt);
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relativeTime(startedAt: number, now: number): string {
  const seconds = Math.max(0, (now - startedAt) / 1000);
  if (seconds < 60) return 'Just now';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3600], ['minute', 60]];
  const [unit, scale] = units.find(([, scale]) => seconds >= scale)!;
  return relative.format(-Math.floor(seconds / scale), unit);
}
