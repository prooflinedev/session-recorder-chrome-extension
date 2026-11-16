import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawEvent } from '@/lib/session/types';
import { ConsoleCapturer } from './console';

describe('ConsoleCapturer', () => {
  let emitted: RawEvent[];
  let cap: ConsoleCapturer;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    cap = new ConsoleCapturer((raw) => emitted.push(raw));
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

  describe('Console secret protection', () => {
    it('sanitizes recognizable secrets in console.log arguments and text', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      consoleApi(1, 'log', [
        { type: 'string', value: 'Auth token initialized:' },
        { type: 'string', value: jwt },
      ]);
      vi.advanceTimersByTime(1000);
      expect(emitted).toHaveLength(1);
      const p = emitted[0]!.payload as import('@/lib/session/types').ConsolePayload;
      expect(p.text).toBe('Auth token initialized: «redacted»');
      expect(p.args).toEqual(['Auth token initialized:', '«redacted»']);
    });

    it('sanitizes recognizable secrets in exception messages and stack traces', () => {
      // Constructed with join to prevent false positives in git secret scanners
      const apiKey = ['sk', 'live', '51Abcdefghijklmnopqrstuv'].join('_');
      cap.handle(1, 'Runtime.exceptionThrown', {
        exceptionDetails: {
          text: 'Uncaught',
          exception: {
            type: 'object',
            subtype: 'error',
            description: `Error: Stripe call failed with key ${apiKey}\n    at init (https://x/app.js?key=${apiKey}:5:9)`,
          },
        },
      });
      expect(emitted).toHaveLength(1);
      const p = emitted[0]!.payload as import('@/lib/session/types').ErrorPayload;
      expect(p.message).toBe('Error: Stripe call failed with key «redacted»');
      expect(p.stack).toContain('at init (https://x/app.js?key=«redacted»:5:9)');
    });

    it('sanitizes recognizable secrets in Log.entryAdded', () => {
      const pat = 'ghp_123456789012345678901234567890123456';
      cap.handle(1, 'Log.entryAdded', {
        entry: {
          level: 'error',
          text: `GitHub push rejected for token ${pat}`,
        },
      });
      expect(emitted).toHaveLength(1);
      const p = emitted[0]!.payload as import('@/lib/session/types').ErrorPayload;
      expect(p.message).toBe('GitHub push rejected for token «redacted»');
    });

    it('bypasses sanitization when redactionEnabled is false in settings', () => {
      const rawEmitted: RawEvent[] = [];
      const rawCap = new ConsoleCapturer({
        emit: (raw) => rawEmitted.push(raw),
        getSettings: () => ({ redactionEnabled: false } as any),
      });
      rawCap.handle(1, 'Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ type: 'string', value: 'Key is AKIAIOSFODNN7EXAMPLE' }],
      });
      vi.advanceTimersByTime(1000);
      expect(rawEmitted).toHaveLength(1);
      const p = rawEmitted[0]!.payload as import('@/lib/session/types').ConsolePayload;
      expect(p.text).toBe('Key is AKIAIOSFODNN7EXAMPLE');
    });

    it('sanitizes script source URLs that contain query or path tokens', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlF54m5dK_Zc';
      consoleApi(1, 'info', [{ type: 'string', value: 'hello' }], `https://x/app.js?token=${jwt}`, 40);
      vi.advanceTimersByTime(1000);
      expect(emitted).toHaveLength(1);
      const p = emitted[0]!.payload as import('@/lib/session/types').ConsolePayload;
      expect(p.source).toBe('https://x/app.js?token=«redacted»:40');
    });

    it('remains resilient and does not throw when getSettings throws', () => {
      const safeEmitted: RawEvent[] = [];
      const safeCap = new ConsoleCapturer({
        emit: (raw) => safeEmitted.push(raw),
        getSettings: () => {
          throw new Error('Storage disconnected');
        },
      });
      expect(() => {
        safeCap.handle(1, 'Runtime.consoleAPICalled', {
          type: 'log',
          args: [{ type: 'string', value: 'Token is ghp_123456789012345678901234567890123456' }],
        });
      }).not.toThrow();
      vi.advanceTimersByTime(1000);
      expect(safeEmitted).toHaveLength(1);
      // Defaults safely to redacting when settings are unresolvable
      expect((safeEmitted[0]!.payload as any).text).toBe('Token is «redacted»');
    });
  });
});
