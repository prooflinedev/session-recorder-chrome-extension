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

/**
 * RemoteObjects recorded from Chrome 158 over CDP with `Runtime.enable`, verbatim
 * except that `objectId` is dropped. Chromium 149 sends the same payloads. All
 * secrets are made up.
 */
const CDP = {
  plain: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"status","type":"number","value":"409"},{"name":"code","type":"string","value":"X"}]}},
  empty: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[]}},
  arr: {"type":"object","subtype":"array","className":"Array","description":"Array(2)","preview":{"type":"object","subtype":"array","description":"Array(2)","overflow":false,"properties":[{"name":"0","type":"string","value":"GET"},{"name":"1","type":"number","value":"1"}]}},
  emptyArr: {"type":"object","subtype":"array","className":"Array","description":"Array(0)","preview":{"type":"object","subtype":"array","description":"Array(0)","overflow":false,"properties":[]}},
  arrMixed: {"type":"object","subtype":"array","className":"Array","description":"Array(10)","preview":{"type":"object","subtype":"array","description":"Array(10)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"string","value":"a"},{"name":"2","type":"object","value":"null","subtype":"null"},{"name":"3","type":"undefined","value":"undefined"},{"name":"4","type":"boolean","value":"true"},{"name":"5","type":"object","value":"Object"},{"name":"6","type":"object","value":"Array(2)","subtype":"array"},{"name":"7","type":"function","value":""},{"name":"8","type":"symbol","value":"Symbol(s)"},{"name":"9","type":"bigint","value":"10n"}]}},
  named: {"type":"object","subtype":"array","className":"Array","description":"Array(2)","preview":{"type":"object","subtype":"array","description":"Array(2)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"},{"name":"extra","type":"string","value":"v"}]}},
  sparse4: {"type":"object","subtype":"array","className":"Array","description":"Array(4)","preview":{"type":"object","subtype":"array","description":"Array(4)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"2","type":"number","value":"3"},{"name":"3","type":"number","value":"4"}]}},
  six: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":true,"properties":[{"name":"a","type":"number","value":"1"},{"name":"b","type":"number","value":"2"},{"name":"c","type":"number","value":"3"},{"name":"d","type":"number","value":"4"},{"name":"e","type":"number","value":"5"}]}},
  map: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"a","overflow":false,"properties":[]},"value":{"type":"number","description":"1","overflow":false,"properties":[]}}]}},
  emptyMap: {"type":"object","subtype":"map","className":"Map","description":"Map(0)","preview":{"type":"object","subtype":"map","description":"Map(0)","overflow":false,"properties":[{"name":"size","type":"number","value":"0"}]}},
  map8: {"type":"object","subtype":"map","className":"Map","description":"Map(7)","preview":{"type":"object","subtype":"map","description":"Map(7)","overflow":true,"properties":[{"name":"size","type":"number","value":"7"}],"entries":[{"key":{"type":"number","description":"1","overflow":false,"properties":[]},"value":{"type":"number","description":"1","overflow":false,"properties":[]}},{"key":{"type":"number","description":"2","overflow":false,"properties":[]},"value":{"type":"number","description":"2","overflow":false,"properties":[]}},{"key":{"type":"number","description":"3","overflow":false,"properties":[]},"value":{"type":"number","description":"3","overflow":false,"properties":[]}},{"key":{"type":"number","description":"4","overflow":false,"properties":[]},"value":{"type":"number","description":"4","overflow":false,"properties":[]}},{"key":{"type":"number","description":"5","overflow":false,"properties":[]},"value":{"type":"number","description":"5","overflow":false,"properties":[]}}]}},
  mapObj: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"k","overflow":false,"properties":[]},"value":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"status","type":"number","value":"1"},{"name":"token","type":"string","value":"t0ps3cret"}]}}]}},
  mapObjKey: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"id","type":"number","value":"1"}]},"value":{"type":"string","description":"v","overflow":false,"properties":[]}}]}},
  mapArr: {"type":"object","subtype":"map","className":"Map","description":"Map(3)","preview":{"type":"object","subtype":"map","description":"Map(3)","overflow":false,"properties":[{"name":"size","type":"number","value":"3"}],"entries":[{"key":{"type":"string","description":"list","overflow":false,"properties":[]},"value":{"type":"object","subtype":"array","description":"Array(3)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"string","value":"a"},{"name":"2","type":"object","value":"Object"}]}},{"key":{"type":"string","description":"six","overflow":false,"properties":[]},"value":{"type":"object","description":"Object","overflow":true,"properties":[{"name":"a","type":"number","value":"1"},{"name":"b","type":"number","value":"2"},{"name":"c","type":"number","value":"3"},{"name":"d","type":"number","value":"4"}]}},{"key":{"type":"string","description":"arr","overflow":false,"properties":[]},"value":{"type":"object","subtype":"array","description":"Array(6)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"},{"name":"2","type":"number","value":"3"},{"name":"3","type":"number","value":"4"},{"name":"4","type":"number","value":"5"},{"name":"5","type":"number","value":"6"}]}}]}},
  mapFn: {"type":"object","subtype":"map","className":"Map","description":"Map(5)","preview":{"type":"object","subtype":"map","description":"Map(5)","overflow":false,"properties":[{"name":"size","type":"number","value":"5"}],"entries":[{"key":{"type":"string","description":"f","overflow":false,"properties":[]},"value":{"type":"function","description":"function foo(a){return \"secretsource\"}","overflow":false,"properties":[]}},{"key":{"type":"string","description":"n","overflow":false,"properties":[]},"value":{"type":"object","subtype":"null","description":"null","overflow":false,"properties":[]}},{"key":{"type":"string","description":"u","overflow":false,"properties":[]},"value":{"type":"undefined","description":"undefined","overflow":false,"properties":[]}},{"key":{"type":"string","description":"s","overflow":false,"properties":[]},"value":{"type":"symbol","description":"Symbol(q)","overflow":false,"properties":[]}},{"key":{"type":"string","description":"b","overflow":false,"properties":[]},"value":{"type":"bigint","description":"10n","overflow":false,"properties":[]}}]}},
  mapNestedMap: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"k","overflow":false,"properties":[]},"value":{"type":"object","subtype":"map","description":"Map(1)","overflow":true,"properties":[{"name":"size","type":"number","value":"1"}]}}]}},
  mapErr: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"e","overflow":false,"properties":[]},"value":{"type":"object","subtype":"error","description":"Error: bad\n    at <anonymous>:1:27","overflow":false,"properties":[{"name":"stack","type":"string","value":"Error: bad\n    at <anonymous>:1:27"},{"name":"message","type":"string","value":"bad"}]}}]}},
  mapCookie: {"type":"object","subtype":"map","className":"Map","description":"Map(3)","preview":{"type":"object","subtype":"map","description":"Map(3)","overflow":false,"properties":[{"name":"size","type":"number","value":"3"}],"entries":[{"key":{"type":"string","description":"Cookie","overflow":false,"properties":[]},"value":{"type":"string","description":"a=b","overflow":false,"properties":[]}},{"key":{"type":"string","description":"X-Tenant-Id","overflow":false,"properties":[]},"value":{"type":"string","description":"acme","overflow":false,"properties":[]}},{"key":{"type":"string","description":"ok","overflow":false,"properties":[]},"value":{"type":"number","description":"1","overflow":false,"properties":[]}}]}},
  mapTokObj: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"token","overflow":false,"properties":[]},"value":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"number","value":"1"}]}}]}},
  set: {"type":"object","subtype":"set","className":"Set","description":"Set(1)","preview":{"type":"object","subtype":"set","description":"Set(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"value":{"type":"string","description":"a","overflow":false,"properties":[]}}]}},
  setObj: {"type":"object","subtype":"set","className":"Set","description":"Set(2)","preview":{"type":"object","subtype":"set","description":"Set(2)","overflow":false,"properties":[{"name":"size","type":"number","value":"2"}],"entries":[{"value":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"number","value":"1"},{"name":"b","type":"string","value":"two"}]}},{"value":{"type":"object","subtype":"array","description":"Array(2)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"}]}}]}},
  proxyArr: {"type":"object","subtype":"proxy","className":"Object","description":"Proxy(Array)","preview":{"type":"object","subtype":"proxy","description":"Proxy(Array)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"}]}},
  proxyObj: {"type":"object","subtype":"proxy","className":"Object","description":"Proxy(Object)","preview":{"type":"object","subtype":"proxy","description":"Proxy(Object)","overflow":false,"properties":[{"name":"status","type":"number","value":"409"},{"name":"token","type":"string","value":"x"}]}},
  nested: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"user","type":"object","value":"Object"},{"name":"list","type":"object","value":"Array(3)","subtype":"array"},{"name":"m","type":"object","value":"Map(1)","subtype":"map"},{"name":"d","type":"object","value":"Thu Jan 01 1970 05:30:00 GMT+0530 (India Standard Time)","subtype":"date"},{"name":"r","type":"object","value":"/x/g","subtype":"regexp"}]}},
  getter: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"x","type":"accessor"},{"name":"y","type":"number","value":"2"}]}},
  weirdKeys: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"1","type":"number","value":"4"},{"name":"a-b","type":"number","value":"1"},{"name":"with space","type":"number","value":"2"},{"name":"","type":"number","value":"3"},{"name":"q\"uote","type":"number","value":"5"}]}},
  longKey: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk","type":"number","value":"1"}]}},
  quotes: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"s","type":"string","value":"say \"hi\"\n\tok\\"}]}},
  errProp: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"error","type":"object","value":"TypeError: bad thing\n    at <anonymous>:1:21","subtype":"error"},{"name":"status","type":"number","value":"500"}]}},
  errPropMulti: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"error","type":"object","value":"Error: line1\nline2\n    at <anonymous>:1:21","subtype":"error"}]}},
  errPropStack: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"e","type":"object","value":"Error: https://a.test/?token=abc\n    at <anonymous>:1:31\n    at <anonymous>:1:80","subtype":"error"}]}},
  longErrTok: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"e","type":"object","value":"Error: fail https://a.test/?q=pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp&token=SE…","subtype":"error"}]}},
  objLongStrs: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"string","value":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"name":"b","type":"string","value":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},{"name":"c","type":"string","value":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},{"name":"d","type":"string","value":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},{"name":"e","type":"string","value":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}]}},
  tableObj: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"r1","type":"object","value":"Object","valuePreview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"number","value":"1"}]}},{"name":"r2","type":"object","value":"Object","valuePreview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"number","value":"2"}]}}]}},
  tableArr: {"type":"object","subtype":"array","className":"Array","description":"Array(2)","preview":{"type":"object","subtype":"array","description":"Array(2)","overflow":false,"properties":[{"name":"0","type":"object","value":"Array(2)","valuePreview":{"type":"object","subtype":"array","description":"Array(2)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"}]},"subtype":"array"},{"name":"1","type":"object","value":"Array(2)","valuePreview":{"type":"object","subtype":"array","description":"Array(2)","overflow":false,"properties":[{"name":"0","type":"number","value":"3"},{"name":"1","type":"number","value":"4"}]},"subtype":"array"}]}},
  table: {"type":"object","subtype":"array","className":"Array","description":"Array(2)","preview":{"type":"object","subtype":"array","description":"Array(2)","overflow":false,"properties":[{"name":"0","type":"object","value":"Object","valuePreview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"number","value":"1"},{"name":"token","type":"string","value":"t"}]}},{"name":"1","type":"object","value":"Object","valuePreview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"number","value":"2"},{"name":"token","type":"string","value":"u"}]}}]}},
  tableTok: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"token","type":"object","value":"Object","valuePreview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"number","value":"1"}]}},{"name":"row","type":"object","value":"Object","valuePreview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"b","type":"number","value":"2"}]}}]}},
  elInMap: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"k","overflow":false,"properties":[]},"value":{"type":"object","subtype":"node","description":"input#i","overflow":true,"properties":[{"name":"accept","type":"string","value":""},{"name":"alt","type":"string","value":""},{"name":"autocomplete","type":"string","value":""},{"name":"defaultChecked","type":"boolean","value":"false"}]}}]}},
  evtInMap: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"k","overflow":false,"properties":[]},"value":{"type":"object","description":"InputEvent","overflow":true,"properties":[{"name":"isTrusted","type":"boolean","value":"false"},{"name":"data","type":"string","value":"typed"},{"name":"isComposing","type":"boolean","value":"false"},{"name":"inputType","type":"string","value":""}]}}]}},
  headersInMap: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"k","overflow":false,"properties":[]},"value":{"type":"object","description":"Headers","overflow":false,"properties":[]}}]}},
  token: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"token","type":"string","value":"abc"},{"name":"status","type":"number","value":"1"}]}},
  hdrKeys: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"Cookie","type":"string","value":"a=b"},{"name":"Authorization","type":"string","value":"Bearer x"},{"name":"x-api-key","type":"string","value":"k"},{"name":"X-Tenant-Id","type":"string","value":"acme"},{"name":"ok","type":"number","value":"1"}]}},
  authNum: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"token","type":"number","value":"12345"},{"name":"session","type":"boolean","value":"true"},{"name":"auth","type":"object","value":"Object"},{"name":"password","type":"object","value":"null","subtype":"null"}]}},
  cookiePriv: {"type":"object","className":"P","description":"P","preview":{"type":"object","description":"P","overflow":false,"properties":[{"name":"#cookie","type":"string","value":"hid"},{"name":"#pin","type":"number","value":"1"},{"name":"ok","type":"number","value":"2"}]}},
  cookieSym: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"Symbol(cookie)","type":"string","value":"hid"},{"name":"Symbol(ok)","type":"number","value":"1"}]}},
  arrNamedTok: {"type":"object","subtype":"array","className":"Array","description":"Array(1)","preview":{"type":"object","subtype":"array","description":"Array(1)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"token","type":"string","value":"abc"}]}},
  urlKey: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"https://a.test/?token=abc&p=1","type":"number","value":"1"}]}},
  strUrlShort: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"u","type":"string","value":"https://a.test/?token=abc&p=2"},{"name":"n","type":"number","value":"1"}]}},
  strRel: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"u","type":"string","value":"/rel?token=abc&p=1"}]}},
  strJson: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"body","type":"string","value":"{\"token\":\"abc\",\"n\":1}"}]}},
  strForm: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"body","type":"string","value":"token=abc&n=1"}]}},
  jsonSecretInSet: {"type":"object","subtype":"set","className":"Set","description":"Set(1)","preview":{"type":"object","subtype":"set","description":"Set(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"value":{"type":"string","description":"{\"token\":\"abc\"}","overflow":false,"properties":[]}}]}},
  longStr: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"msg","type":"string","value":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}]}},
  longUrl: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"u","type":"string","value":"https://a.test/ppppppppppppppppppppppppppppppppppp…TssssssssssssssssssssssssssssssssssssssssTAIL&z=1"}]}},
  formLong: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"body","type":"string","value":"page=1&token=SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS…SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSTAIL"}]}},
  jsonMidParse: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"body","type":"string","value":"{\"note\":\"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn…mnopqrstuvwxyzSECRETTAIL\",\"z\":\"1234567890123456\"}"}]}},
  jsonTail: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"body","type":"string","value":"[\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…xxxxxxxxx\",{\"token\":\"abcTAIL\"},\"padpadpadpadpad\"]"}]}},
  setJsonLong: {"type":"object","subtype":"set","className":"Set","description":"Set(1)","preview":{"type":"object","subtype":"set","description":"Set(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"value":{"type":"string","description":"{\"user\":\"uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu\",\"token\":\"abcdefTAIL\"}","overflow":false,"properties":[]}}]}},
  setUrlLong: {"type":"object","subtype":"set","className":"Set","description":"Set(1)","preview":{"type":"object","subtype":"set","description":"Set(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"value":{"type":"string","description":"https://a.test/pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp?token=SECRET","overflow":false,"properties":[]}}]}},
  setFormLong: {"type":"object","subtype":"set","className":"Set","description":"Set(1)","preview":{"type":"object","subtype":"set","description":"Set(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"value":{"type":"string","description":"page=1&token=SECRETssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss","overflow":false,"properties":[]}}]}},
  throwClass: {"type":"object","className":"OrderState","description":"OrderState","preview":{"type":"object","description":"OrderState","overflow":false,"properties":[{"name":"status","type":"number","value":"409"}]}},
  throwPlain: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"status","type":"number","value":"409"},{"name":"code","type":"string","value":"X"}]}},
  rejTok: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"token","type":"string","value":"abc"}]}},
  throwEvt: {"type":"object","className":"InputEvent","description":"InputEvent","preview":{"type":"object","description":"InputEvent","overflow":true,"properties":[{"name":"isTrusted","type":"boolean","value":"false"},{"name":"data","type":"string","value":"typed"},{"name":"isComposing","type":"boolean","value":"false"},{"name":"inputType","type":"string","value":""},{"name":"dataTransfer","type":"object","value":"null","subtype":"null"}]}},
  err: {"type":"object","subtype":"error","className":"TypeError","description":"TypeError: boom\n    at <anonymous>:1:13","preview":{"type":"object","subtype":"error","description":"TypeError: boom\n    at <anonymous>:1:13","overflow":false,"properties":[{"name":"stack","type":"string","value":"TypeError: boom\n    at <anonymous>:1:13"},{"name":"message","type":"string","value":"boom"}]}},
  date: {"type":"object","subtype":"date","className":"Date","description":"Thu Jan 01 1970 05:30:00 GMT+0530 (India Standard Time)","preview":{"type":"object","subtype":"date","description":"Thu Jan 01 1970 05:30:00 GMT+0530 (India Standard Time)","overflow":false,"properties":[]}},
  regexp: {"type":"object","subtype":"regexp","className":"RegExp","description":"/a+/gi","preview":{"type":"object","subtype":"regexp","description":"/a+/gi","overflow":true,"properties":[{"name":"lastIndex","type":"number","value":"0"},{"name":"dotAll","type":"boolean","value":"false"},{"name":"flags","type":"string","value":"gi"},{"name":"global","type":"boolean","value":"true"},{"name":"hasIndices","type":"boolean","value":"false"}]}},
  dom: {"type":"object","subtype":"node","className":"HTMLDivElement","description":"div#d.c","preview":{"type":"object","subtype":"node","description":"div#d.c","overflow":true,"properties":[{"name":"align","type":"string","value":""},{"name":"title","type":"string","value":""},{"name":"lang","type":"string","value":""},{"name":"translate","type":"boolean","value":"true"},{"name":"dir","type":"string","value":""}]}},
  fn: {"type":"function","className":"Function","description":"function foo(a){return a}"},
  typed: {"type":"object","subtype":"typedarray","className":"Uint8Array","description":"Uint8Array(3)","preview":{"type":"object","subtype":"typedarray","description":"Uint8Array(3)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"},{"name":"2","type":"number","value":"3"},{"name":"buffer","type":"object","value":"ArrayBuffer(3)","subtype":"arraybuffer"},{"name":"byteLength","type":"number","value":"3"},{"name":"byteOffset","type":"number","value":"0"},{"name":"length","type":"number","value":"3"},{"name":"Symbol(Symbol.toStringTag)","type":"string","value":"Uint8Array"}]}},
  promise: {"type":"object","subtype":"promise","className":"Promise","description":"Promise","preview":{"type":"object","subtype":"promise","description":"Promise","overflow":false,"properties":[{"name":"[[PromiseState]]","type":"string","value":"fulfilled"},{"name":"[[PromiseResult]]","type":"object","value":"Object"}]}},
  inputEvt: {"type":"object","className":"InputEvent","description":"InputEvent","preview":{"type":"object","description":"InputEvent","overflow":true,"properties":[{"name":"isTrusted","type":"boolean","value":"false"},{"name":"data","type":"string","value":"typed"},{"name":"isComposing","type":"boolean","value":"false"},{"name":"inputType","type":"string","value":""},{"name":"dataTransfer","type":"object","value":"null","subtype":"null"}]}},
  customEvt: {"type":"object","className":"CustomEvent","description":"CustomEvent","preview":{"type":"object","description":"CustomEvent","overflow":true,"properties":[{"name":"isTrusted","type":"boolean","value":"false"},{"name":"detail","type":"object","value":"Object"},{"name":"type","type":"string","value":"x"},{"name":"target","type":"object","value":"null","subtype":"null"},{"name":"currentTarget","type":"object","value":"null","subtype":"null"}]}},
  headers: {"type":"object","className":"Headers","description":"Headers","preview":{"type":"object","description":"Headers","overflow":false,"properties":[]}},
  formdata: {"type":"object","className":"FormData","description":"FormData","preview":{"type":"object","description":"FormData","overflow":false,"properties":[]}},
  emptyClass: {"type":"object","className":"Foo","description":"Foo","preview":{"type":"object","description":"Foo","overflow":false,"properties":[]}},
  proxyFn: {"type":"object","subtype":"proxy","className":"Function","description":"Proxy(Function)","preview":{"type":"object","subtype":"proxy","description":"Proxy(Function)","overflow":false,"properties":[{"name":"length","type":"number","value":"0"},{"name":"name","type":"string","value":""},{"name":"prototype","type":"object","value":"Object"},{"name":"arguments","type":"object","value":"null","subtype":"null"},{"name":"caller","type":"object","value":"null","subtype":"null"}]}},
  proxyMap: {"type":"object","subtype":"proxy","className":"Object","description":"Proxy(Map)","preview":{"type":"object","subtype":"proxy","description":"Proxy(Map)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"string","description":"a","overflow":false,"properties":[]},"value":{"type":"number","description":"1","overflow":false,"properties":[]}}]}},
  proxyEvt: {"type":"object","subtype":"proxy","className":"Object","description":"Proxy(InputEvent)","preview":{"type":"object","subtype":"proxy","description":"Proxy(InputEvent)","overflow":true,"properties":[{"name":"isTrusted","type":"boolean","value":"false"},{"name":"data","type":"string","value":"typed"},{"name":"isComposing","type":"boolean","value":"false"},{"name":"inputType","type":"string","value":""},{"name":"dataTransfer","type":"object","value":"null","subtype":"null"}]}},
  url: {"type":"object","className":"URL","description":"URL","preview":{"type":"object","description":"URL","overflow":true,"properties":[{"name":"origin","type":"string","value":"https://a.test"},{"name":"protocol","type":"string","value":"https:"},{"name":"username","type":"string","value":""},{"name":"password","type":"string","value":""},{"name":"host","type":"string","value":"a.test"}]}},
  nodelist: {"type":"object","subtype":"array","className":"NodeList","description":"NodeList(1)","preview":{"type":"object","subtype":"array","description":"NodeList(1)","overflow":false,"properties":[{"name":"0","type":"object","value":"div#d.c","subtype":"node"}]}},
  args: {"type":"object","subtype":"array","className":"Arguments","description":"Arguments(2)","preview":{"type":"object","subtype":"array","description":"Arguments(2)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"},{"name":"callee","type":"function","value":""},{"name":"Symbol(Symbol.iterator)","type":"function","value":""}]}},
  subArr: {"type":"object","subtype":"array","className":"MyArr","description":"MyArr(3)","preview":{"type":"object","subtype":"array","description":"MyArr(3)","overflow":false,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"},{"name":"2","type":"number","value":"3"}]}},
  realEllipsis: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"msg","type":"string","value":"loading… please"}]}},
  jsonEscaped: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"body","type":"string","value":"{\"a\":\"{\\\"u\\\":\\\"https://a.test/?token=x\\\"}\",\"token\":\"SECRET\"}"}]}},
  jsonSpaced: {"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"body","type":"string","value":"{\"token\" : \"SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS…SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS\"}"}]}},
  mapSymKey: {"type":"object","subtype":"map","className":"Map","description":"Map(1)","preview":{"type":"object","subtype":"map","description":"Map(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"key":{"type":"symbol","description":"Symbol(cookie)","overflow":false,"properties":[]},"value":{"type":"string","description":"hid","overflow":false,"properties":[]}}]}},
  setObjString: {"type":"object","subtype":"set","className":"Set","description":"Set(1)","preview":{"type":"object","subtype":"set","description":"Set(1)","overflow":false,"properties":[{"name":"size","type":"number","value":"1"}],"entries":[{"value":{"type":"string","description":"Object","overflow":false,"properties":[]}}]}},
  tagUrl: {"type":"object","className":"https://a.test/?token=x","description":"https://a.test/?token=x","preview":{"type":"object","description":"https://a.test/?token=x","overflow":false,"properties":[{"name":"a","type":"number","value":"1"},{"name":"Symbol(Symbol.toStringTag)","type":"string","value":"https://a.test/?token=x"}]}},
};
type Fixture = keyof typeof CDP;

describe('ConsoleCapturer object previews', () => {
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

  const log = (arg: unknown) =>
    cap.handle(1, 'Runtime.consoleAPICalled', { type: 'log', args: [arg] });
  const logged = (arg: unknown): string => {
    log(arg);
    vi.advanceTimersByTime(1000);
    const p = emitted.at(-1)!.payload as import('@/lib/session/types').ConsolePayload;
    expect(p.args).toEqual([p.text]);
    return p.text;
  };
  const thrown = (exception: unknown): string => {
    cap.handle(1, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception } });
    return (emitted.at(-1)!.payload as import('@/lib/session/types').ErrorPayload).message;
  };

  it.each<[Fixture, string]>([
    ['plain', '{status: 409, code: "X"}'],
    ['empty', '{}'],
    ['throwClass', 'OrderState {status: 409}'],
    ['arr', '["GET", 1]'],
    ['emptyArr', '[]'],
    ['arrMixed', '[1, "a", null, undefined, true, Object, Array(2), ƒ, Symbol(s), 10n]'],
    ['named', '[1, 2, extra: "v"]'],
    ['sparse4', '[1, 2: 3, 3: 4]'],
    ['map', 'Map(1) {"a" => 1}'],
    ['emptyMap', 'Map(0) {}'],
    ['mapObjKey', 'Map(1) {{id: 1} => "v"}'],
    ['mapFn', 'Map(5) {"f" => ƒ, "n" => null, "u" => undefined, "s" => Symbol(q), "b" => 10n}'],
    ['mapNestedMap', 'Map(1) {"k" => Map(1) {…}}'],
    ['set', 'Set(1) {"a"}'],
    ['setObjString', 'Set(1) {"Object"}'],
    ['setObj', 'Set(2) {{a: 1, b: "two"}, [1, 2]}'],
    ['proxyArr', 'Proxy(Array) [1, 2]'],
    ['tableObj', '{r1: {a: 1}, r2: {a: 2}}'],
    ['tableArr', '[[1, 2], [3, 4]]'],
    ['getter', '{x: (...), y: 2}'],
    ['quotes', String.raw`{s: "say \"hi\"\n\tok\\"}`],
    ['weirdKeys', String.raw`{1: 4, "a-b": 1, "with space": 2, "": 3, "q\"uote": 5}`],
    ['nested', '{user: Object, list: Array(3), m: Map(1), d: Thu Jan 01 1970 05:30:00 GMT+0530 (India Standard Time), r: /x/g}'],
  ])('formats %s', (name, expected) => {
    expect(logged(CDP[name])).toBe(expected);
  });

  it.each<[Fixture, string]>([
    ['errProp', '{error: TypeError: bad thing, status: 500}'],
    ['errPropMulti', '{error: Error: line1}'],
    ['mapErr', 'Map(1) {"e" => Error: bad}'],
  ])('uses only the first line of a nested error in %s', (name, expected) => {
    expect(logged(CDP[name])).toBe(expected);
  });

  it.each<[Fixture, string]>([
    ['six', '{a: 1, b: 2, c: 3, d: 4, e: 5, …}'],
    ['map8', 'Map(7) {1 => 1, 2 => 2, 3 => 3, 4 => 4, 5 => 5, …}'],
    ['mapArr', 'Map(3) {"list" => [1, "a", Object], "six" => {a: 1, b: 2, c: 3, d: 4, …}, "arr" => [1, 2, 3, 4, 5, 6]}'],
  ])('marks fields Chrome left out of %s', (name, expected) => {
    expect(logged(CDP[name])).toBe(expected);
  });

  it('marks array items after the first 100', () => {
    // Same shape as the recorded Array(150), built here because it has 100 entries.
    const items = Array.from({ length: 100 }, (_, i) => String(i));
    const properties = items.map((i) => ({ name: i, type: 'number', value: i }));
    expect(logged({
      type: 'object', subtype: 'array', className: 'Array', description: 'Array(150)',
      preview: { type: 'object', subtype: 'array', description: 'Array(150)', overflow: true, properties },
    })).toBe(`[${items.join(', ')}, …]`);
  });

  it('caps one object at 500 characters', () => {
    const full = `{${[...'abcde'].map((c) => `${c}: "${c.repeat(100)}"`).join(', ')}}`;
    expect(logged(CDP.objLongStrs)).toBe(`${full.slice(0, 500)}…`);
  });

  it('caps a long key', () => {
    expect(logged(CDP.longKey)).toBe(`{"${'k'.repeat(100)}…": 1}`);
  });

  // Guards: these pass before the change and must keep passing after it.
  it.each<[Fixture, string]>([
    ['err', 'TypeError: boom\n    at <anonymous>:1:13'],
    ['date', 'Thu Jan 01 1970 05:30:00 GMT+0530 (India Standard Time)'],
    ['regexp', '/a+/gi'],
    ['dom', 'div#d.c'],
    ['fn', 'function foo(a){return a}'],
    ['typed', 'Uint8Array(3)'],
    ['promise', 'Promise'],
    ['inputEvt', 'InputEvent'],
    ['customEvt', 'CustomEvent'],
    ['headers', 'Headers'],
    ['formdata', 'FormData'],
    ['emptyClass', 'Foo'],
    ['nodelist', 'NodeList(1)'],
    ['args', 'Arguments(2)'],
    ['subArr', 'MyArr(3)'],
    ['proxyFn', 'Proxy(Function)'],
    ['proxyMap', 'Proxy(Map)'],
    ['proxyEvt', 'Proxy(InputEvent)'],
  ])('keeps the description of %s', (name, expected) => {
    expect(logged(CDP[name])).toBe(expected);
  });

  it('keeps the description of an object without a preview', () => {
    // Chrome replays messages logged before `Runtime.enable` without previews.
    expect(logged({ ...CDP.plain, preview: undefined })).toBe('Object');
  });

  it.each<[Fixture, string]>([
    ['elInMap', 'Map(1) {"k" => input#i}'],
    ['evtInMap', 'Map(1) {"k" => InputEvent}'],
    ['headersInMap', 'Map(1) {"k" => Headers}'],
  ])('keeps the description of the value nested in %s', (name, expected) => {
    expect(logged(CDP[name])).toBe(expected);
  });

  it('keeps different objects apart and still merges equal ones', () => {
    log(CDP.plain);
    log(CDP.six);
    log(CDP.six);
    vi.advanceTimersByTime(1000);
    expect(emitted.map((e) => e.payload)).toMatchObject([
      { text: '{status: 409, code: "X"}' },
      { text: '{a: 1, b: 2, c: 3, d: 4, e: 5, …}', repeat: 2 },
    ]);
  });

  it('formats a thrown object, and masks it', () => {
    expect(thrown(CDP.throwPlain)).toBe('{status: 409, code: "X"}');
    expect(thrown(CDP.rejTok)).toBe('{token: «redacted»}');
    expect(thrown(CDP.errPropStack)).toBe('{e: Error: https://a.test/?token=«redacted»}');
    expect(thrown(CDP.throwEvt)).toBe('InputEvent');
  });

  it('formats and masks objects in Log args', () => {
    cap.handle(1, 'Log.entryAdded', {
      entry: { level: 'error', text: 'failed', args: [CDP.plain, CDP.token] },
    });
    expect(emitted[0]!.payload).toMatchObject({
      message: 'failed {status: 409, code: "X"} {token: «redacted», status: 1}',
    });
  });

  it.each<[Fixture, string]>([
    ['token', '{token: «redacted», status: 1}'],
    ['authNum', '{token: «redacted», session: «redacted», auth: «redacted», password: «redacted»}'],
    ['hdrKeys', '{Cookie: «redacted», Authorization: «redacted», "x-api-key": «redacted», "X-Tenant-Id": «redacted», ok: 1}'],
    ['cookiePriv', 'P {#cookie: «redacted», #pin: «redacted», ok: 2}'],
    ['cookieSym', '{Symbol(cookie): «redacted», Symbol(ok): 1}'],
    ['mapCookie', 'Map(3) {"Cookie" => «redacted», "X-Tenant-Id" => «redacted», "ok" => 1}'],
    ['mapSymKey', 'Map(1) {Symbol(cookie) => «redacted»}'],
    ['mapTokObj', 'Map(1) {"token" => «redacted»}'],
    ['mapObj', 'Map(1) {"k" => {status: 1, token: «redacted»}}'],
    ['table', '[{a: 1, token: «redacted»}, {a: 2, token: «redacted»}]'],
    ['tableTok', '{token: «redacted», row: {b: 2}}'],
    ['arrNamedTok', '[1, token: «redacted»]'],
    ['url', 'URL {origin: "https://a.test", protocol: "https:", username: "", password: «redacted», host: "a.test", …}'],
    ['proxyObj', 'Proxy(Object) {status: 409, token: «redacted»}'],
  ])('masks values by key in %s', (name, expected) => {
    // Exact names, so `#cookie` and `Symbol(cookie)` match only once unwrapped.
    settings.customRedaction.headerNames = ['X-Tenant-Id'];
    settings.customRedaction.bodyKeyPatterns = ['^pin$'];
    expect(logged(CDP[name])).toBe(expected);
  });

  it.each<[Fixture, string]>([
    ['strUrlShort', '{u: "https://a.test/?token=«redacted»&p=2", n: 1}'],
    ['strRel', '{u: "/rel?token=«redacted»&p=1"}'],
    ['strForm', '{body: "token=«redacted»&n=1"}'],
    ['strJson', String.raw`{body: "{\n  \"token\": \"«redacted»\",\n  \"n\": 1\n}"}`],
    ['jsonEscaped', String.raw`{body: "{\n  \"a\": \"{\\\"u\\\":\\\"https://a.test/?token=«redacted»\"}\",\n  \"token\": \"«redacted»\"\n}"}`],
    ['jsonSecretInSet', String.raw`Set(1) {"{\n  \"token\": \"«redacted»\"\n}"}`],
    ['urlKey', '{"https://a.test/?token=«redacted»&p=1": «redacted»}'],
    ['errPropStack', '{e: Error: https://a.test/?token=«redacted»}'],
    ['tagUrl', 'https://a.test/?token=«redacted» {a: 1, Symbol(Symbol.toStringTag): "https://a.test/?token=«redacted»"}'],
  ])('cleans strings in %s', (name, expected) => {
    expect(logged(CDP[name])).toBe(expected);
  });

  it.each<[Fixture, string]>([
    ['longStr', `{msg: "${'a'.repeat(50)}…"}`],
    ['longUrl', `{u: "https://a.test/${'p'.repeat(35)}…"}`],
    ['formLong', '{body: "page=1&token=«redacted»…"}'],
    ['jsonTail', String.raw`{body: "[\"${'x'.repeat(48)}…"}`],
    ['realEllipsis', '{msg: "loading…"}'],
    ['jsonSpaced', '{body: "«redacted»"}'],
    ['jsonMidParse', '{body: "«redacted»"}'],
    ['longErrTok', `{e: Error: fail https://a.test/?q=${'p'.repeat(60)}&token=«redacted»…}`],
  ])('keeps only the text before the ellipsis in %s', (name, expected) => {
    expect(logged(CDP[name])).toBe(expected);
  });

  it.each<[Fixture, string]>([
    ['setUrlLong', `Set(1) {"https://a.test/${'p'.repeat(85)}…"}`],
    ['setFormLong', 'Set(1) {"page=1&token=«redacted»…"}'],
    ['setJsonLong', 'Set(1) {"«redacted»"}'],
  ])('caps a whole string before cleaning it in %s', (name, expected) => {
    expect(logged(CDP[name])).toBe(expected);
  });

  it('does not mask when redaction is off', () => {
    settings.redactionEnabled = false;
    expect(logged(CDP.token)).toBe('{token: "abc", status: 1}');
    expect(logged(CDP.strUrlShort)).toBe('{u: "https://a.test/?token=abc&p=2", n: 1}');
  });
});
