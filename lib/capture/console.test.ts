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
