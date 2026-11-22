import { describe, expect, it } from 'vitest';
import {
  consoleBucketSize, consoleSeverityCounts, consoleTimeline, groupConsoleEvents, normalizeConsoleEvents,
} from './console-insights';

const log = (id: string, t: number, text: string, extra: object = {}) => ({
  id, t, type: 'console', payload: { level: 'error', text, ...extra },
});

describe('console insights', () => {
  it('handles empty and malformed evidence', () => {
    expect(normalizeConsoleEvents([])).toEqual([]);
    expect(normalizeConsoleEvents([
      null, { type: 'console' }, log('bad', NaN, 'bad'),
      log('bad-level', 0, 'bad', { level: 'constructor' }),
      { id: 'network', t: 0, type: 'error', payload: { origin: 'network' } },
      log('good', 0, '', { text: {}, repeat: -1, stack: [] }),
    ])).toEqual([{
      id: 'good', time: 0, severity: 'error', origin: 'error', message: '',
      count: 1, stack: '', source: '',
    }]);
  });

  it('assigns exact bucket boundaries and counts capture coalescing', () => {
    const events = normalizeConsoleEvents([
      log('a', 999, 'Failed', { repeat: 3 }), log('b', 1000, 'Failed'),
      log('c', 1000, 'Deprecated', { level: 'warn' }),
      log('d', 1000, 'Loading', { level: 'debug' }),
    ]);
    expect(consoleTimeline(events, 2000, 1000)).toEqual([
      { start: 0, end: 1000, count: 3 },
      { start: 1000, end: 2000, count: 1 },
      { start: 2000, end: 3000, count: 0 },
    ]);
    expect(consoleSeverityCounts(events)).toEqual({ error: 4, warning: 1, diagnostic: 1 });
    const longSession = 24 * 60 * 60 * 1000;
    expect(consoleTimeline([], longSession, consoleBucketSize(longSession)).length).toBeLessThanOrEqual(25);
  });

  it('groups repeats while retaining codes, sources, original IDs and chronological order', () => {
    const input = [
      log('b', 1000, 'HTTP 403', { source: 'main.js:1', repeat: 2 }),
      log('a', 1000, 'HTTP 403', { source: 'main.js:1' }),
      log('c', 0, 'HTTP 404', { source: 'main.js:1' }),
      log('d', 0, 'HTTP 403', { source: 'main.js:2' }),
      { id: 'e', t: 0, type: 'error', payload: { origin: 'exception', message: 'HTTP 403' } },
    ];
    const snapshot = structuredClone(input);
    const groups = groupConsoleEvents(normalizeConsoleEvents(input));
    expect(groups.map((group) => group.count)).toEqual([3, 1, 1, 1]);
    expect(groups[0]?.events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(groupConsoleEvents(normalizeConsoleEvents([...input].reverse()))).toEqual(groups);
    expect(input).toEqual(snapshot);
  });
});
