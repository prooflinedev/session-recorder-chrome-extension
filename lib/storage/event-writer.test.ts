import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@/lib/session/types';
import { EventWriter } from './index';

const event = (id: string): SessionEvent =>
  ({ id, sessionId: 'ses_1', t: 0, type: 'marker', payload: { name: id } }) as SessionEvent;

const ids = (events: SessionEvent[]) => events.map((e) => e.id);

/** A store whose next `failures` writes reject, like a full disk. */
function flakyStore() {
  const saved: string[] = [];
  const attempts: string[][] = [];
  const store = {
    saved,
    attempts,
    failures: 0,
    write: vi.fn(async (events: SessionEvent[]) => {
      attempts.push(ids(events));
      if (store.failures > 0) {
        store.failures -= 1;
        throw new DOMException('The disk is full.', 'QuotaExceededError');
      }
      saved.push(...ids(events));
    }),
  };
  return store;
}

describe('EventWriter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes buffered events in order', async () => {
    const store = flakyStore();
    const writer = new EventWriter({ write: store.write });
    writer.add(event('a'));
    writer.add(event('b'));
    await writer.flush();
    writer.add(event('c'));
    await writer.flush();
    expect(store.saved).toEqual(['a', 'b', 'c']);
  });

  it('keeps writing after one write fails', async () => {
    const store = flakyStore();
    store.failures = 1;
    const writer = new EventWriter({ write: store.write });

    writer.add(event('a'));
    await expect(writer.flush()).rejects.toThrow('The disk is full.');
    writer.add(event('b'));
    await writer.flush();
    writer.add(event('c'));
    await writer.flush();

    expect(store.saved).toEqual(['a', 'b', 'c']);
  });

  it('retries a failed batch before newer events', async () => {
    const store = flakyStore();
    store.failures = 1;
    const writer = new EventWriter({ write: store.write });

    writer.add(event('a'));
    writer.add(event('b'));
    await writer.flush().catch(() => {});
    expect(writer.size()).toBe(2);

    writer.add(event('c'));
    await writer.flush();

    expect(store.attempts).toEqual([['a', 'b'], ['a', 'b', 'c']]);
    expect(writer.size()).toBe(0);
  });

  it('reports failures and recovery to its callbacks', async () => {
    const store = flakyStore();
    store.failures = 1;
    const onError = vi.fn();
    const onFlush = vi.fn();
    const writer = new EventWriter({ write: store.write, onError, onFlush });

    writer.add(event('a'));
    writer.add(event('b'));
    await writer.flush().catch(() => {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'QuotaExceededError' }),
      2,
    );
    expect(onFlush).not.toHaveBeenCalled();

    await writer.flush();
    expect(onFlush).toHaveBeenCalledWith(2);
  });

  it('a caller waiting on an empty flush still waits for retried events', async () => {
    const store = flakyStore();
    store.failures = 1;
    const writer = new EventWriter({ write: store.write });

    writer.add(event('a'));
    const first = writer.flush().catch(() => {});
    const second = writer.flush();
    await first;
    await second;

    expect(store.saved).toEqual(['a']);
  });

  it('retries on the idle timer instead of on every event while failing', async () => {
    const store = flakyStore();
    store.failures = 1;
    const writer = new EventWriter({ write: store.write, maxBatch: 2, flushMs: 1000 });

    writer.add(event('a'));
    writer.add(event('b')); // reaches maxBatch: immediate write, which fails
    await vi.advanceTimersByTimeAsync(0);
    expect(store.write).toHaveBeenCalledTimes(1);

    for (const id of ['c', 'd', 'e', 'f']) writer.add(event(id));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(store.saved).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('drops the oldest events beyond maxPending and counts them', async () => {
    const store = flakyStore();
    store.failures = 1;
    const onError = vi.fn();
    const writer = new EventWriter({ write: store.write, maxPending: 3, onError });

    for (const id of ['a', 'b', 'c', 'd', 'e']) writer.add(event(id));
    await writer.flush().catch(() => {});

    expect(writer.dropped).toBe(2);
    expect(onError).toHaveBeenCalledWith(expect.anything(), 3);
    await writer.flush();
    expect(store.saved).toEqual(['c', 'd', 'e']);
  });

  it('does not leave unhandled rejections from timer or dispose writes', async () => {
    const store = flakyStore();
    store.failures = 2;
    const onError = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.useRealTimers();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const writer = new EventWriter({ write: store.write, onError, flushMs: 10 });
      writer.add(event('a'));
      await wait(30);
      writer.dispose();
      await wait(30);

      expect(onError).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
