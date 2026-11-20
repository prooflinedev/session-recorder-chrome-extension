import { describe, expect, it } from 'vitest';
import { placeEvent } from './events';
import type { RawEvent } from './types';

const START = 100_000;
const warn = (extra: { repeat?: number; repeatSpanMs?: number } = {}): RawEvent => ({
  type: 'console',
  tabId: 1,
  payload: { level: 'warn', text: 'sync failed: 401', ...extra },
});

describe('placeEvent', () => {
  it('places an event at its offset from the session start', () => {
    expect(placeEvent(warn({ repeat: 3, repeatSpanMs: 800 }), START + 2_500, START)).toEqual({
      t: 2_500,
      payload: { level: 'warn', text: 'sync failed: 401', repeat: 3, repeatSpanMs: 800 },
    });
  });

  it('moves a replayed message to the start', () => {
    expect(placeEvent(warn(), START - 5_000, START).t).toBe(0);
  });

  it('keeps the real end of a replayed run that continued into the session', () => {
    // First occurrence 5 s before recording, last 1 s after it.
    const raw = warn({ repeat: 7, repeatSpanMs: 6_000 });
    const placed = placeEvent(raw, START - 5_000, START);
    expect(placed).toEqual({ t: 0, payload: { ...raw.payload, repeatSpanMs: 1_000 } });
    expect(raw.payload).toMatchObject({ repeatSpanMs: 6_000 }); // input untouched
  });

  it('drops the span of a replayed run that ended before the session', () => {
    const placed = placeEvent(warn({ repeat: 4, repeatSpanMs: 2_000 }), START - 5_000, START);
    expect(placed.t).toBe(0);
    expect(placed.payload).not.toHaveProperty('repeatSpanMs');
    expect(placed.payload).toMatchObject({ repeat: 4 });
  });
});
