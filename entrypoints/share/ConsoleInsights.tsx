import { useMemo, useState } from 'react';
import {
  consoleBucketSize, consoleSeverityCounts, consoleTimeline, groupConsoleEvents,
  normalizeConsoleEvents, type ConsoleSeverity,
} from '@/lib/session/console-insights';

const severities = [
  ['error', 'Errors'], ['warning', 'Warnings'], ['diagnostic', 'Diagnostics'],
] as const;
const elapsed = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 3)}s`;

type Selection =
  | { kind: 'severity'; value: ConsoleSeverity }
  | { kind: 'bucket'; start: number; end: number }
  | { kind: 'group'; ids: Set<string> };

export function ConsoleInsights({ events, startedAt }: { events: readonly unknown[]; startedAt: number }) {
  const entries = useMemo(() => normalizeConsoleEvents(events), [events]);
  const summary = useMemo(() => {
    const errors = entries.filter((event) => event.severity === 'error');
    const duration = entries.at(-1)?.time ?? 0;
    const bucketSize = consoleBucketSize(duration);
    const buckets = consoleTimeline(errors, duration, bucketSize);
    return {
      counts: consoleSeverityCounts(entries),
      groups: groupConsoleEvents(errors),
      buckets,
      bucketSize,
      peak: buckets.reduce((best, bucket) => bucket.count > best.count ? bucket : best, buckets[0]!),
    };
  }, [entries]);
  const [selection, setSelection] = useState<Selection>();
  const [limit, setLimit] = useState(20);
  function select(next?: Selection) {
    setSelection(next);
    setLimit(20);
  }
  const matches = useMemo(() => {
    if (!selection) return [];
    return entries.filter((event) => {
      switch (selection.kind) {
        case 'severity': return event.severity === selection.value;
        case 'bucket': return event.severity === 'error' && event.time >= selection.start && event.time < selection.end;
        case 'group': return selection.ids.has(event.id);
      }
    });
  }, [entries, selection]);
  const { counts, groups, buckets, bucketSize, peak } = summary;
  const total = counts.error + counts.warning + counts.diagnostic;
  const errorEnd = counts.error / total * 100;
  const warningEnd = (counts.error + counts.warning) / total * 100;
  const repeated = groups.filter((group) => group.count > 1).slice(0, 5);

  return (
    <section className="report-evidence console-insights" aria-labelledby="console-insights-title">
      <div className="section-heading"><h2 id="console-insights-title">Console Insights</h2></div>
      {!total ? <p className="muted">No console activity was captured in this recording.</p> : <>
        <h3>Key findings</h3>
        <ul className="console-findings">
          <li>Error occurrences: {counts.error}. Distinct error groups: {groups.length}.</li>
          <li>{counts.warning} warnings and {counts.diagnostic} diagnostic occurrences.</li>
          {peak.count > 0 && <li>Peak activity: {peak.count} errors from {elapsed(peak.start)} to {elapsed(peak.end)} after recording started.</li>}
          {repeated.length > 0 && <li>Most repeated error: {repeated[0]!.count} occurrences. Its recorded entries span {elapsed(repeated[0]!.events[0]!.time)} to {elapsed(repeated[0]!.events.at(-1)!.time)}.</li>}
        </ul>
        <div className="console-charts">
          <div className="console-timeline">
            <h3>Error timeline</h3>
            <p className="muted">{elapsed(bucketSize)} buckets from recording start{counts.error > 0 && ` · Peak: ${peak.count}`}</p>
            {counts.error ? <div className="console-histogram" role="group" aria-label="Error timeline buckets">
              {buckets.map((bucket) => (
                <button key={bucket.start} type="button" disabled={!bucket.count}
                  aria-pressed={selection?.kind === 'bucket' && selection.start === bucket.start}
                  aria-label={`${elapsed(bucket.start)} to ${elapsed(bucket.end)}: ${bucket.count} errors`}
                  title={`${elapsed(bucket.start)} to ${elapsed(bucket.end)}: ${bucket.count} errors`}
                  onClick={() => select({ kind: 'bucket', start: bucket.start, end: bucket.end })}>
                  <span style={{ height: `${bucket.count / peak.count * 100}%` }} />
                </button>
              ))}
            </div> : <p className="muted">No errors in the captured console activity.</p>}
            {!!counts.error && <div className="console-axis"><span>0s</span><span>{elapsed(buckets.at(-1)!.end)}</span></div>}
          </div>
          <div>
            <h3>Severity distribution</h3>
            <div className="console-severity">
              <div className="console-pie" aria-hidden="true" style={{
                background: `conic-gradient(var(--console-error) 0 ${errorEnd}%, var(--console-warning) ${errorEnd}% ${warningEnd}%, var(--console-diagnostic) ${warningEnd}% 100%)`,
              }} />
              <ul className="console-legend">
                {severities.map(([value, label]) => (
                  <li key={value}><button type="button" disabled={!counts[value]}
                    aria-pressed={selection?.kind === 'severity' && selection.value === value}
                    onClick={() => select({ kind: 'severity', value })}>
                    <i className={`console-swatch console-swatch--${value}`} aria-hidden="true" />{label} <strong>{counts[value]}</strong>
                  </button></li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <h3>Top repeated errors</h3>
        {repeated.length ? <ol className="console-ranking">
          {repeated.map(({ events: group, count }) => (
            <li key={group[0]!.id}><button type="button"
              aria-pressed={selection?.kind === 'group' && selection.ids.has(group[0]!.id)}
              onClick={() => select({ kind: 'group', ids: new Set(group.map((event) => event.id)) })}>
              <span>{group[0]!.message || 'Message unavailable'}</span><strong>{count}</strong>
              <span className="console-rank-bar" aria-hidden="true" style={{ width: `${count / repeated[0]!.count * 100}%` }} />
            </button></li>
          ))}
        </ol> : <p className="muted">No repeated errors were captured.</p>}
        <p className="muted">Select a time bucket, severity label, or repeated error to inspect its evidence. Coalesced repeats share one recorded timestamp.</p>
        {selection && <div className="console-matches">
          <div className="section-heading">
            <h3 aria-live="polite">Matching console events ({matches.length})</h3>
            <button className="btn" type="button" onClick={() => select()}>Clear selection</button>
          </div>
          <ul className="console-evidence">
            {matches.slice(0, limit).map((event) => {
              const timestamp = new Date(startedAt + event.time);
              return (
                <li key={event.id}>
                  <div className="muted">{elapsed(event.time)} elapsed · {event.severity} · {event.origin} · {event.count} occurrence{event.count === 1 ? '' : 's'}</div>
                  {Number.isFinite(timestamp.getTime()) && <time dateTime={timestamp.toISOString()}>{timestamp.toISOString()}</time>}
                  <p>{event.message || 'Message unavailable'}</p>
                  {event.source && <code>{event.source}</code>}
                  {event.stack && <details><summary>Stack trace</summary><pre>{event.stack}</pre></details>}
                  <div className="muted">Event <code>{event.id}</code></div>
                </li>
              );
            })}
          </ul>
          {matches.length > limit && <button className="btn" type="button" onClick={() => setLimit(limit + 20)}>Show more events</button>}
        </div>}
      </>}
    </section>
  );
}
