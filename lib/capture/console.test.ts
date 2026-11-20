import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureSettings, RawEvent } from '@/lib/session/types';
import { makeDefaultSettings } from '@/lib/session/settings';
import { ConsoleCapturer } from './console';

describe('ConsoleCapturer', () => {
  let emitted: RawEvent[];
  let cap: ConsoleCapturer;
  let settings: CaptureSettings;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    settings = makeDefaultSettings();
    cap = new ConsoleCapturer((raw) => emitted.push(raw), () => settings);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const consoleApi = (
    tabId: number,
    type: string,
    args: unknown[],
    stackUrl?: string,
    line = 12,
  ) =>
    cap.handle(tabId, 'Runtime.consoleAPICalled', {
      type,
      args,
      stackTrace: stackUrl
        ? { callFrames: [{ url: stackUrl, lineNumber: line }] }
        : undefined,
    });

  it('stamps a held console message with the time the page logged it', () => {
    vi.setSystemTime(10_000);
    cap.handle(1, 'Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'payment rejected' }],
      timestamp: 9_990,
    });
    // Released 400 ms later by the next, different message.
    vi.setSystemTime(10_400);
    cap.handle(1, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'next' }],
      timestamp: 10_400,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.at).toBe(9_990);
  });

  it('stamps exceptions and log entries with their CDP time', () => {
    vi.setSystemTime(5_000);
    cap.handle(1, 'Runtime.exceptionThrown', {
      timestamp: 4_200,
      exceptionDetails: { exception: { type: 'object', description: 'TypeError: x' } },
    });
    cap.handle(1, 'Log.entryAdded', {
      entry: { level: 'error', text: 'Failed to load resource', timestamp: 4_300 },
    });
    expect(emitted.map((e) => e.at)).toEqual([4_200, 4_300]);
  });

  it('stamps a held non-error log entry with its CDP time', () => {
    vi.setSystemTime(5_000);
    cap.handle(1, 'Log.entryAdded', {
      entry: { level: 'warning', text: 'Deprecated API used', timestamp: 4_400 },
    });
    cap.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('console');
    expect(emitted[0]!.at).toBe(4_400);
  });

  it('rounds CDP sub-millisecond time to whole ms', () => {
    vi.setSystemTime(5_000);
    cap.handle(1, 'Runtime.exceptionThrown', {
      timestamp: 4_321.687,
      exceptionDetails: { text: 'boom' },
    });
    expect(emitted[0]!.at).toBe(4_322);
  });

  it('falls back to now for a missing, invalid or future timestamp', () => {
    vi.setSystemTime(7_000);
    for (const timestamp of [undefined, Number.NaN, -1, '6000', 8_000]) {
      cap.handle(1, 'Runtime.exceptionThrown', {
        timestamp,
        exceptionDetails: { text: 'boom' },
      });
    }
    expect(emitted.map((e) => e.at)).toEqual([7_000, 7_000, 7_000, 7_000, 7_000]);
  });

  it('maps warning -> warn and stringifies args, extracts source', () => {
    consoleApi(1, 'warning', [{ type: 'string', value: 'hi' }, { type: 'number', value: 3 }], 'https://x/app.js', 40);
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(1);
    const e = emitted[0]!;
    expect(e.type).toBe('console');
    const p = e.payload as import('@/lib/session/types').ConsolePayload;
    expect(p.level).toBe('warn');
    expect(p.text).toBe('hi 3');
    expect(p.source).toBe('https://x/app.js:40');
    expect(e.tabId).toBe(1);
  });

  it('prefers value, then description, then unserializableValue', () => {
    consoleApi(1, 'log', [
      { type: 'object', description: 'Object desc' },
      { type: 'number', unserializableValue: 'Infinity' },
    ]);
    vi.advanceTimersByTime(1000);
    const p = emitted[0]!.payload as import('@/lib/session/types').ConsolePayload;
    expect(p.text).toBe('Object desc Infinity');
  });

  it('coalesces consecutive duplicates into repeat', () => {
    consoleApi(1, 'log', [{ type: 'string', value: 'dup' }]);
    consoleApi(1, 'log', [{ type: 'string', value: 'dup' }]);
    consoleApi(1, 'log', [{ type: 'string', value: 'dup' }]);
    expect(emitted).toHaveLength(0); // still pending
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(1);
    const p = emitted[0]!.payload as import('@/lib/session/types').ConsolePayload;
    expect(p.repeat).toBe(3);
  });

  it('records how long a run of repeats lasted, keeping the first time', () => {
    vi.setSystemTime(1_000);
    // A poll fails every 700 ms, inside the 1 s quiet window each time.
    for (let i = 0; i < 5; i++) {
      if (i > 0) vi.advanceTimersByTime(700);
      cap.handle(1, 'Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ type: 'string', value: 'sync failed: 401' }],
        timestamp: Date.now(),
      });
    }
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.at).toBe(1_000);
    expect(emitted[0]!.payload).toMatchObject({ repeat: 5, repeatSpanMs: 2_800 });
  });

  it('keeps the longest span when duplicates arrive out of order', () => {
    vi.setSystemTime(5_000);
    for (const timestamp of [1_000, 3_000, 2_000]) {
      cap.handle(1, 'Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ type: 'string', value: 'sync failed: 401' }],
        timestamp,
      });
    }
    cap.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.at).toBe(1_000);
    expect(emitted[0]!.payload).toMatchObject({ repeat: 3, repeatSpanMs: 2_000 });
  });

  it('starts a run at its earliest occurrence when that arrives late', () => {
    vi.setSystemTime(5_000);
    for (const timestamp of [3_000, 1_000, 4_000]) {
      cap.handle(1, 'Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ type: 'string', value: 'sync failed: 401' }],
        timestamp,
      });
    }
    cap.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.at).toBe(1_000);
    expect(emitted[0]!.payload).toMatchObject({ repeat: 3, repeatSpanMs: 3_000 });
  });

  it('leaves a single message without a span', () => {
    consoleApi(1, 'log', [{ type: 'string', value: 'once' }]);
    cap.flush();
    expect((emitted[0]!.payload as any).repeatSpanMs).toBeUndefined();
  });

  it('flushes pending when a different message arrives', () => {
    consoleApi(1, 'log', [{ type: 'string', value: 'a' }]);
    consoleApi(1, 'log', [{ type: 'string', value: 'b' }]);
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.payload as any).text).toBe('a');
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(2);
    expect((emitted[1]!.payload as any).text).toBe('b');
  });

  it('does not coalesce across the quiet window', () => {
    consoleApi(1, 'log', [{ type: 'string', value: 'q' }]);
    vi.advanceTimersByTime(1000);
    consoleApi(1, 'log', [{ type: 'string', value: 'q' }]);
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(2);
    expect((emitted[0]!.payload as any).repeat).toBeUndefined();
  });

  it('exceptionThrown -> error origin exception with message + stack', () => {
    cap.handle(2, 'Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { type: 'object', subtype: 'error', description: 'TypeError: boom\n    at foo' },
        stackTrace: { callFrames: [{ functionName: 'foo', url: 'https://x/app.js', lineNumber: 5, columnNumber: 9 }] },
      },
    });
    expect(emitted).toHaveLength(1);
    const e = emitted[0]!;
    expect(e.type).toBe('error');
    const p = e.payload as import('@/lib/session/types').ErrorPayload;
    expect(p.origin).toBe('exception');
    expect(p.message).toBe('TypeError: boom');
    expect(p.stack).toContain('at foo (https://x/app.js:5:9)');
  });

  it('flushes pending console before an exception (ordering)', () => {
    consoleApi(1, 'log', [{ type: 'string', value: 'before' }]);
    cap.handle(1, 'Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', exception: { value: 'oops' } },
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[0]!.type).toBe('console');
    expect(emitted[1]!.type).toBe('error');
  });

  it.each([true, false])('preserves fallback exception stack locations with redaction %s', (enabled) => {
    settings.redactionEnabled = enabled;
    const stack = '    at load (https://api.test/app.js?token=secret:5:9)';
    cap.handle(2, 'Runtime.exceptionThrown', {
      exceptionDetails: {
        exception: { type: 'object', subtype: 'error', description: `TypeError: boom\n${stack}` },
      },
    });
    expect(emitted).toHaveLength(1);
    const payload = emitted[0]!.payload as import('@/lib/session/types').ErrorPayload;
    expect(payload.message).toBe('TypeError: boom');
    expect(payload.stack).toBe(enabled
      ? '    at load (https://api.test/app.js?token=«redacted»:5:9)'
      : stack);
  });

  it('Log.entryAdded error -> error origin log', () => {
    cap.handle(3, 'Log.entryAdded', {
      entry: { level: 'error', text: 'CSP violation', url: 'https://x', lineNumber: 1 },
    });
    expect(emitted).toHaveLength(1);
    const p = emitted[0]!.payload as import('@/lib/session/types').ErrorPayload;
    expect(emitted[0]!.type).toBe('error');
    expect(p.origin).toBe('log');
    expect(p.message).toBe('CSP violation');
  });

  it('Log.entryAdded non-error -> console event with mapped level', () => {
    cap.handle(3, 'Log.entryAdded', {
      entry: { level: 'warning', text: 'deprecated', url: 'https://x/app.js', lineNumber: 7 },
    });
    vi.advanceTimersByTime(1000);
    const e = emitted[0]!;
    expect(e.type).toBe('console');
    const p = e.payload as import('@/lib/session/types').ConsolePayload;
    expect(p.level).toBe('warn');
    expect(p.source).toBe('https://x/app.js:7');
  });

  it('caps text at 2KB', () => {
    const big = 'x'.repeat(5000);
    consoleApi(1, 'log', [{ type: 'string', value: big }]);
    vi.advanceTimersByTime(1000);
    const p = emitted[0]!.payload as import('@/lib/session/types').ConsolePayload;
    expect(p.text.length).toBeLessThanOrEqual(2049);
    expect(p.text.endsWith('…')).toBe(true);
  });

  it('flush emits the held message at once, with its repeat count', () => {
    consoleApi(1, 'error', [{ type: 'string', value: 'retry failed' }]);
    consoleApi(1, 'error', [{ type: 'string', value: 'retry failed' }]);
    expect(emitted).toHaveLength(0);
    cap.flush();
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.payload as any).repeat).toBe(2);
    // The quiet-window timer was cleared, so nothing is emitted twice.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(emitted).toHaveLength(1);
  });

  it('reset clears pending without emitting', () => {
    consoleApi(1, 'log', [{ type: 'string', value: 'gone' }]);
    cap.reset();
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(0);
  });

  it('honors the current recording redaction switch', () => {
    const url = 'https://api.example.test/data?token=secret';
    settings.redactionEnabled = false;
    consoleApi(1, 'warning', [{ value: url }], url);
    vi.advanceTimersByTime(1000);
    expect(JSON.stringify(emitted)).toContain('token=secret');

    emitted.length = 0;
    settings.redactionEnabled = true;
    consoleApi(1, 'warning', [{ value: url }], url);
    vi.advanceTimersByTime(1000);
    expect(JSON.stringify(emitted)).not.toContain('token=secret');
    expect(JSON.stringify(emitted)).toContain('token=«redacted»');
    expect((emitted[0]!.payload as import('@/lib/session/types').ConsolePayload).source)
      .toBe('https://api.example.test/data?token=«redacted»:12');
  });
});
