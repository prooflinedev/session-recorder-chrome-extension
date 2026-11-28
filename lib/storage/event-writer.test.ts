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

  it('retries on its timer instead of on every event while failing', async () => {
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

  it('retries a failed write on its own when no new events arrive', async () => {
    const store = flakyStore();
    store.failures = 1;
    const onFlush = vi.fn();
    const writer = new EventWriter({ write: store.write, onFlush, flushMs: 1000 });

    writer.add(event('a'));
    writer.add(event('b'));
    await writer.flush().catch(() => {});
    expect(store.saved).toEqual([]);

    // Storage has recovered; nothing else is recorded.
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saved).toEqual(['a', 'b']);
    expect(onFlush).toHaveBeenCalledWith(2);
    expect(writer.size()).toBe(0);
  });

  it('waits longer between retries while writes keep failing, then resets', async () => {
    const store = flakyStore();
    store.failures = 5;
    const writer = new EventWriter({ write: store.write, flushMs: 1000, maxRetryMs: 4000 });

    writer.add(event('a'));
    await writer.flush().catch(() => {}); // failure 1; retry in 1s
    await vi.advanceTimersByTimeAsync(1000); // failure 2; retry in 2s
    expect(store.write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(store.write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // failure 3; retry in 4s
    expect(store.write).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000); // failure 4; capped at 4s
    expect(store.write).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4000); // failure 5
    await vi.advanceTimersByTimeAsync(4000); // succeeds
    expect(store.write).toHaveBeenCalledTimes(6);
    expect(store.saved).toEqual(['a']);

    // After a success the next failure is retried after flushMs again.
    store.failures = 1;
    writer.add(event('b'));
    await writer.flush().catch(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saved).toEqual(['a', 'b']);
  });

  it('writes events added during a failing streak once storage recovers', async () => {
    const store = flakyStore();
    store.failures = 1;
    const writer = new EventWriter({ write: store.write, flushMs: 1000 });

    writer.add(event('a'));
    await writer.flush().catch(() => {});
    writer.add(event('b'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.saved).toEqual(['a', 'b']);
  });

  it('does not keep retrying after dispose', async () => {
    const store = flakyStore();
    store.failures = 100;
    const writer = new EventWriter({ write: store.write, flushMs: 1000 });

    writer.add(event('a'));
    writer.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.write).toHaveBeenCalledTimes(1);
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
    store.failures = 100;
    const onError = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.useRealTimers();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const writer = new EventWriter({ write: store.write, onError, flushMs: 10 });
      writer.add(event('a'));
      await wait(30); // idle-timer write and at least one retry fail
      writer.dispose(); // fails too
      await wait(30);

      expect(onError.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
