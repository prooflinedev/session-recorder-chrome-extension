import { describe, expect, it } from 'vitest';
import type {
  ConsolePayload,
  ErrorPayload,
  NetRequestPayload,
  SessionEvent,
} from '@/lib/session/types';
import {
  fingerprint,
  normalizeMessage,
  primarySignal,
  requestTemplate,
  stackFrames,
} from './fingerprint';

let sequence = 0;
function errorEvent(t: number, payload: ErrorPayload): SessionEvent {
  return { id: `e${++sequence}`, sessionId: 's', t, type: 'error', importance: 1, payload };
}
function request(t: number, payload: Partial<NetRequestPayload>): SessionEvent {
  return {
    id: `e${++sequence}`,
    sessionId: 's',
    t,
    type: 'net-request',
    importance: 1,
    payload: {
      requestId: `r${sequence}`,
      method: 'GET',
      url: 'https://api.example.com/todos/7',
      requestHeaders: [],
      responseHeaders: [],
      ...payload,
    },
  };
}
const exception = (t: number, message = 'TypeError: x is undefined') =>
  errorEvent(t, { origin: 'exception', message });
function consoleEvent(t: number, payload: ConsolePayload): SessionEvent {
  return { id: `e${++sequence}`, sessionId: 's', t, type: 'console', importance: 1, payload };
}
/**
 * The app's own console.error call. Capture records its source (`url:line`) and
 * usually no stack.
 */
const consoleError = (
  t: number,
  text = 'Checkout failed',
  { source = 'https://shop.example.com/assets/checkout-Xy12ab34.js:10', stack }: { source?: string; stack?: string } = {},
) => consoleEvent(t, { level: 'error', text, source, ...(stack ? { stack } : {}) });
/** A browser Log.entryAdded entry: CSP violations, resource-load failures, network notices. */
const browserLog = (t: number, message: string) => errorEvent(t, { origin: 'log', message });

describe('primary signal', () => {
  it('prefers the first exception, then the first console error, then the first failed request', () => {
    const failed = request(1, { failed: true, failureReason: 'net::ERR_FAILED' });
    const logged = consoleError(2);
    const first = exception(4);
    const later = exception(3, 'RangeError: later in the list');
    // Events are taken in time order regardless of their stored order.
    expect(primarySignal([failed, logged, first, later])).toBe(later);
    expect(primarySignal([failed, consoleError(9), logged])).toBe(logged);
    const serverError = request(6, { status: 503 });
    expect(primarySignal([serverError, failed])).toBe(failed);
    expect(primarySignal([serverError])).toBe(serverError);
  });
  it('ignores client errors, successful requests and other error origins', () => {
    expect(
      primarySignal([
        request(1, { status: 404 }),
        request(2, { status: 422 }),
        request(3, { status: 200 }),
        errorEvent(4, { origin: 'network', message: 'GET /todos 404' }),
        errorEvent(5, { origin: 'console', message: 'console' }),
      ]),
    ).toBeUndefined();
    expect(primarySignal([])).toBeUndefined();
  });
  it('leaves Chrome’s resource-load console errors to the request signal', () => {
    // Chrome logs every failed load, including 4xx such as a missing favicon.
    const missing = browserLog(
      1,
      'Failed to load resource: the server responded with a status of 404 (File not found)',
    );
    expect(primarySignal([missing])).toBeUndefined();
    const serverError = request(3, { status: 500 });
    expect(
      primarySignal([
        missing,
        browserLog(2, 'Failed to load resource: the server responded with a status of 500 ()'),
        serverError,
      ]),
    ).toBe(serverError);
  });
  it('never uses a browser log entry as the signal', () => {
    expect(
      primarySignal([
        browserLog(1, "Refused to load the script 'https://cdn.example.com/x.js' because it violates the Content Security Policy"),
        consoleEvent(2, { level: 'warn', text: 'Deprecated API' }),
        consoleEvent(3, { level: 'log', text: 'Checkout failed' }),
      ]),
    ).toBeUndefined();
  });
});

describe('message normalization', () => {
  it.each([
    ['Order 9f1c2e4a-1b2c-4d3e-8f9a-0b1c2d3e4f5a failed', 'Order <uuid> failed'],
    ['Token deadbeef1234 was rejected', 'Token <hex> was rejected'],
    ['No account for jane.doe@example.com', 'No account for <email>'],
    ['Failed to load https://cdn.example.com/app.js?v=3#top now', 'Failed to load <url> now'],
    ['Expected 3 items, got 12.5 at 42px', 'Expected <n> items, got <n> at <n>px'],
    ["Cannot read properties of undefined (reading 'id')", "Cannot read properties of undefined (reading 'id')"],
    ['Unexpected value "hello world" in \'total\'', "Unexpected value <str> in 'total'"],
    ['Template `a-b` and \'$el_2\' and \'9 lives\'', "Template <str> and '$el_2' and <str>"],
    ["Can't find variable: user42", "Can't find variable: user42"],
  ])('normalizes %j', (message, expected) => {
    expect(normalizeMessage(message)).toBe(expected);
  });
  it('redacts quoted values that span lines', () => {
    expect(normalizeMessage('Invalid value "Confidential project\nlaunch plan"')).toBe(
      'Invalid value <str>',
    );
    expect(normalizeMessage("Can't parse 'line one\r\nline two' or `a\nb`")).toBe(
      "Can't parse <str> or <str>",
    );
  });
  it('redacts quoted values that contain escaped quotes', () => {
    expect(normalizeMessage('Invalid value "\\"internal\\" project launch plan"')).toBe(
      'Invalid value <str>',
    );
    expect(normalizeMessage("Invalid value 'it\\'s the project launch plan' here")).toBe(
      'Invalid value <str> here',
    );
    expect(normalizeMessage('Bad path "C:\\\\temp\\\\" and "next"')).toBe("Bad path <str> and \"next\"");
    // An apostrophe inside a word still does not end a quoted value.
    expect(normalizeMessage("Unexpected value 'don't know' here")).toBe('Unexpected value <str> here');
  });
  it('collapses whitespace, trims and caps at 200 characters', () => {
    expect(normalizeMessage('  TypeError:\n\t  boom   here ')).toBe('TypeError: boom here');
    expect(normalizeMessage('x'.repeat(300))).toHaveLength(200);
  });
});

describe('stack frames', () => {
  it('keeps file basenames without build hashes, line, column, query or fragment', () => {
    expect(
      stackFrames(
        [
          '    at submitOrder (https://shop.example.com/assets/index-B3k9x2Lq.js:12:345)',
          '    at handleClick (http://localhost:5173/static/js/main.3f9a1c.js?v=2#x:1:99)',
          '    at loadCart (https://shop.example.com/static/js/123.a1b2c3d4.chunk.js:4:4)',
        ].join('\n'),
      ),
    ).toEqual(['submitOrder@index.js', 'handleClick@main.js', 'loadCart@123.chunk.js']);
    expect(
      stackFrames(
        '    at renderApp (https://shop.example.com/_next/static/chunks/pages/app-0f1e2d3c4b5a.js:1:2)',
      ),
    ).toEqual(['renderApp@app.js']);
  });
  it('keeps readable file names that are not hashes', () => {
    expect(
      stackFrames('    at loadCart (https://shop.example.com/js/checkout-summary.js:4:4)'),
    ).toEqual(['loadCart@checkout-summary.js']);
  });
  it('drops minified and anonymous function names', () => {
    expect(
      stackFrames(
        [
          '    at t (https://shop.example.com/a.js:1:1)',
          '    at Ve (https://shop.example.com/b.js:1:1)',
          '    at <anonymous> (https://shop.example.com/c.js:1:1)',
        ].join('\n'),
      ),
    ).toEqual(['a.js', 'b.js', 'c.js']);
    expect(stackFrames('    at https://shop.example.com/d.js:7:8')).toEqual(['d.js']);
    expect(stackFrames('    at async submitOrder (https://shop.example.com/e.js:1:1)')).toEqual([
      'submitOrder@e.js',
    ]);
  });
  it('ignores frames outside http pages and keeps the top three', () => {
    expect(
      stackFrames(
        [
          '    at inject (chrome-extension://abcdefghijklmnop/content.js:1:1)',
          '    at nativeFn',
          '    at one (https://shop.example.com/one.js:1:1)',
          '    at evalCode (file:///tmp/two.js:1:1)',
          '    at two (https://shop.example.com/two.js:1:1)',
          '    at three (https://shop.example.com/three.js:1:1)',
          '    at four (https://shop.example.com/four.js:1:1)',
        ].join('\n'),
      ),
    ).toEqual(['one@one.js', 'two@two.js', 'three@three.js']);
    expect(stackFrames(undefined)).toEqual([]);
  });
});

describe('request template', () => {
  const template = (url: string, extra: Partial<NetRequestPayload> = { status: 500 }) =>
    requestTemplate({ method: 'get', url, ...extra });
  it('replaces identifiers in the path so the same endpoint matches', () => {
    expect(template('https://api.example.com/todos/7')).toBe(
      'GET api.example.com/todos/:id 5xx',
    );
    expect(template('https://api.example.com/todos/9')).toBe(
      template('https://api.example.com/todos/7'),
    );
    expect(
      template(
        'https://api.example.com/orders/9f1c2e4a-1b2c-4d3e-8f9a-0b1c2d3e4f5a/items/deadbeef42/x/Ab3dE5gH7jK9mN1pQ',
      ),
    ).toBe('GET api.example.com/orders/:id/items/:id/x/:id 5xx');
    expect(template('http://localhost:3000/api/checkout-summary/settings')).toBe(
      'GET localhost:3000/api/checkout-summary/settings 5xx',
    );
  });
  it('names the failure instead of a status', () => {
    expect(
      template('https://api.example.com/pay', {
        failed: true,
        failureReason: 'net::ERR_CONNECTION_REFUSED',
      }),
    ).toBe('GET api.example.com/pay failed:net::ERR_CONNECTION_REFUSED');
    expect(template('https://api.example.com/pay', { status: 502 })).toBe(
      template('https://api.example.com/pay', { status: 503 }),
    );
  });
  it('never includes the query or fragment', () => {
    const value = template('https://api.example.com/todos/7?token=abc123secret#session=xyz');
    expect(value).toBe('GET api.example.com/todos/:id 5xx');
    expect(value).not.toMatch(/token|abc123secret|session|xyz/);
  });
});

describe('fingerprint', () => {
  const crash = (overrides: { message?: string; stack?: string } = {}) =>
    errorEvent(1, {
      origin: 'exception',
      message:
        overrides.message ?? "TypeError: Cannot read properties of undefined (reading 'total')",
      stack:
        overrides.stack ??
        [
          '    at calculateTotals (https://shop.example.com/assets/cart-Xy12ab34.js:10:20)',
          '    at submitOrder (https://shop.example.com/assets/index-B3k9x2Lq.js:30:40)',
        ].join('\n'),
    });
  it('is pinned for a known input', async () => {
    expect(await fingerprint([crash()])).toEqual({
      id: 'sr-bc0b15b8d47d',
      message: "TypeError: Cannot read properties of undefined (reading 'total')",
    });
  });
  it('is stable across identifiers, numbers, positions and bundle hashes', async () => {
    const first = await fingerprint([
      errorEvent(1, {
        origin: 'exception',
        message: 'Order 9f1c2e4a-1b2c-4d3e-8f9a-0b1c2d3e4f5a failed after 3 tries',
        stack: '    at submitOrder (https://shop.example.com/assets/index-B3k9x2Lq.js:30:40)',
      }),
    ]);
    const second = await fingerprint([
      consoleError(0, 'Unrelated console error'),
      errorEvent(5, {
        origin: 'exception',
        message: 'Order 0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d failed after 12 tries',
        stack: '    at submitOrder (https://shop.example.com/assets/index-Qw7Er8Ty.js:31:7)',
      }),
    ]);
    expect(first?.id).toMatch(/^sr-[0-9a-f]{12}$/);
    expect(second?.id).toBe(first?.id);
    const todo = (url: string) => fingerprint([request(1, { url, status: 500 })]);
    expect((await todo('https://api.example.com/todos/7?token=a'))?.id).toBe(
      (await todo('https://api.example.com/todos/9'))?.id,
    );
  });
  it('differs for another message, top frame or endpoint', async () => {
    const base = (await fingerprint([crash()]))!.id;
    expect((await fingerprint([crash({ message: 'TypeError: total is not a function' })]))!.id).not.toBe(base);
    expect(
      (await fingerprint([
        crash({ stack: '    at applyCoupon (https://shop.example.com/assets/cart-Xy12ab34.js:1:1)' }),
      ]))!.id,
    ).not.toBe(base);
    const endpoint = async (url: string) =>
      (await fingerprint([request(1, { url, status: 500 })]))!.id;
    expect(await endpoint('https://api.example.com/todos/7')).not.toBe(
      await endpoint('https://api.example.com/orders/7'),
    );
    // The same text from console.error is a different signal than an uncaught exception.
    expect(
      (await fingerprint([consoleError(1, "TypeError: Cannot read properties of undefined (reading 'total')")]))!.id,
    ).not.toBe(base);
  });
  it('has no fingerprint without a signal and never exposes a request query', async () => {
    expect(await fingerprint([request(1, { status: 404 })])).toBeUndefined();
    const failed = await fingerprint([
      request(1, { url: 'https://api.example.com/todos/7?token=abc123secret', failed: true }),
    ]);
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed)).not.toContain('abc123secret');
  });
});

describe('console errors', () => {
  it('fingerprints the app’s console.error text and stack', async () => {
    const stack = '    at submitOrder (https://shop.example.com/assets/index-B3k9x2Lq.js:30:40)';
    const result = await fingerprint([
      browserLog(0, 'Refused to frame https://ads.example.com/'),
      consoleError(1, 'Checkout failed for order 42', { stack }),
    ]);
    expect(result?.message).toBe('Checkout failed for order <n>');
    expect(result?.id).toMatch(/^sr-[0-9a-f]{12}$/);
    expect(result?.id).not.toBe(
      (await fingerprint([consoleError(1, 'Checkout failed for order 42')]))?.id,
    );
  });
  it('uses the source file when the console error has no stack', async () => {
    const id = async (source?: string) =>
      (
        await fingerprint([
          source
            ? consoleError(1, 'Checkout failed', { source })
            : consoleEvent(1, { level: 'error', text: 'Checkout failed' }),
        ])
      )?.id;
    const checkout = await id('https://shop.example.com/assets/checkout-Xy12ab34.js:10');
    expect(await id('https://shop.example.com/assets/cart-Xy12ab34.js:10')).not.toBe(checkout);
    expect(await id('https://shop.example.com/assets/checkout-Qw98er76.js:245')).toBe(checkout);
    expect(await id('https://shop.example.com/assets/checkout-Xy12ab34.js?v=2:7')).toBe(checkout);
    expect(await id('chrome-extension://abcdefghijklmnop/content.js:5')).toBe(await id());
    expect(checkout).not.toBe(await id());
  });
  it('prefers stack frames over the source', async () => {
    const stack = '    at submitOrder (https://shop.example.com/assets/index-B3k9x2Lq.js:30:40)';
    const withStack = await fingerprint([consoleError(1, 'Checkout failed', { stack })]);
    expect(withStack?.id).toBe(
      (
        await fingerprint([
          consoleError(1, 'Checkout failed', {
            source: 'https://shop.example.com/assets/other.js:1',
            stack,
          }),
        ])
      )?.id,
    );
  });
  it('has no fingerprint for a session with only a browser log error', async () => {
    expect(await fingerprint([browserLog(1, 'Checkout failed for order 42')])).toBeUndefined();
  });
});
