/**
 * Network and console capture from child debugger sessions: cross-site iframes
 * and workers, which Chrome reports as separate targets of the recorded tab.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ConsolePayload,
  ErrorPayload,
  NetRequestPayload,
  RawEvent,
} from '@/lib/session/types';
import { makeDefaultSettings } from '@/lib/session/settings';
import type { ChildTarget } from './debugger';
import { NetworkCapturer, type NetworkDeps } from './network';
import { ConsoleCapturer } from './console';

const PAY_FRAME: ChildTarget = {
  sessionId: 'S-IFRAME',
  type: 'iframe',
  url: 'https://pay.example.com/fields.html?token=abc123',
  crossSite: true,
};
const SEARCH_WORKER: ChildTarget = {
  sessionId: 'S-WORKER',
  type: 'worker',
  url: 'https://app.example.com/search-worker.js',
  crossSite: false,
};

function network(overrides: Partial<NetworkDeps> = {}) {
  const emitted: RawEvent[] = [];
  const send = vi.fn(async (..._args: unknown[]) => ({ body: '{"ok":false}', base64Encoded: false }));
  const deps: NetworkDeps = {
    send,
    getSettings: () => makeDefaultSettings(),
    emit: (raw) => emitted.push(raw),
    storeBodyAsset: vi.fn(async () => 'asset-1'),
    sessionStart: () => 0,
    ...overrides,
  };
  return { cap: new NetworkCapturer(deps), emitted, send };
}

/** Let `onLoadingFinished`'s body fetch settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function request(
  cap: NetworkCapturer,
  child: ChildTarget | undefined,
  requestId: string,
  init: { method: string; url: string; postData?: string; status: number },
): void {
  cap.handle(1, 'Network.requestWillBeSent', {
    requestId,
    request: { method: init.method, url: init.url, headers: {}, postData: init.postData },
    timestamp: 1,
    wallTime: 1_700_000_000,
    type: 'Fetch',
  }, child);
  cap.handle(1, 'Network.responseReceived', {
    requestId,
    response: { status: init.status, statusText: '', headers: { 'content-type': 'application/json' }, mimeType: 'application/json' },
    type: 'Fetch',
  }, child);
  cap.handle(1, 'Network.loadingFinished', { requestId, timestamp: 1.2 }, child);
}

describe('network capture from child sessions', () => {
  it('records a cross-site frame request with its status and target, but never reads its bodies', async () => {
    const { cap, emitted, send } = network();
    request(cap, PAY_FRAME, '900.2', {
      method: 'POST',
      url: 'https://pay.example.com/api/charge',
      postData: '{"card":"4242 4242 4242 4242","cvc":"123"}',
      status: 402,
    });
    await settle();

    expect(emitted).toHaveLength(1);
    const p = emitted[0]!.payload as NetRequestPayload;
    expect(p).toMatchObject({ method: 'POST', url: 'https://pay.example.com/api/charge', status: 402 });
    expect(p.target).toMatchObject({ type: 'iframe', crossSite: true });
    // The frame URL is redacted like any other URL.
    expect(p.target!.url).not.toContain('abc123');
    expect(p.requestBody).toEqual({ present: false, omitted: 'cross-site' });
    expect(p.responseBody).toEqual({ present: false, omitted: 'cross-site' });
    expect(JSON.stringify(emitted)).not.toContain('4242');
    expect(send).not.toHaveBeenCalled();
  });

  it("reads a same-origin worker's response body through the worker's own session", async () => {
    const { cap, emitted, send } = network();
    request(cap, SEARCH_WORKER, '700.5', {
      method: 'GET',
      url: 'https://app.example.com/api/search?q=weekender',
      status: 404,
    });
    await settle();

    expect(send).toHaveBeenCalledWith(1, 'Network.getResponseBody', { requestId: '700.5' }, 'S-WORKER');
    const p = emitted[0]!.payload as NetRequestPayload;
    expect(p.status).toBe(404);
    expect(p.target).toEqual({ type: 'worker', url: 'https://app.example.com/search-worker.js' });
    expect(p.responseBody).toMatchObject({ present: true, text: '{"ok":false}' });
  });

  it("completes a worker request whose ExtraInfo Chrome reports on the page's session", async () => {
    const { cap, emitted } = network();
    // Chrome sends requestWillBeSent and responseReceived on the worker session,
    // but the ExtraInfo pair on the page session. Both must land on one request.
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: '700.6',
      request: { method: 'GET', url: 'https://app.example.com/api/search', headers: {} },
      timestamp: 1,
    }, SEARCH_WORKER);
    cap.handle(1, 'Network.requestWillBeSentExtraInfo', {
      requestId: '700.6',
      headers: { cookie: 'session=secret', 'x-trace': 't-1' },
    });
    cap.handle(1, 'Network.responseReceived', {
      requestId: '700.6',
      hasExtraInfo: true,
      response: { status: 404, headers: {} },
    }, SEARCH_WORKER);
    cap.handle(1, 'Network.responseReceivedExtraInfo', {
      requestId: '700.6',
      statusCode: 404,
      headers: { 'x-request-id': 'r-9' },
    });
    cap.handle(1, 'Network.loadingFinished', { requestId: '700.6', timestamp: 1.1 }, SEARCH_WORKER);
    await settle();

    expect(emitted).toHaveLength(1);
    const p = emitted[0]!.payload as NetRequestPayload;
    expect(p.target?.type).toBe('worker');
    expect(p.requestHeaders.find((h) => h.name === 'x-trace')?.value).toBe('t-1');
    expect(p.responseHeaders.find((h) => h.name === 'x-request-id')?.value).toBe('r-9');
    // Redaction still applies to headers that arrived on the page session.
    expect(JSON.stringify(p)).not.toContain('session=secret');
  });

  it('leaves page requests untouched: no target, bodies read through the page', async () => {
    const { cap, emitted, send } = network();
    request(cap, undefined, '700.4', { method: 'GET', url: 'https://app.example.com/api/cart', status: 404 });
    await settle();
    expect(send).toHaveBeenCalledWith(1, 'Network.getResponseBody', { requestId: '700.4' });
    expect((emitted[0]!.payload as NetRequestPayload).target).toBeUndefined();
  });

  it('keeps cross-site WebSocket frames as timing only', () => {
    const { cap, emitted } = network();
    cap.handle(1, 'Network.webSocketCreated', { requestId: 'ws-9', url: 'wss://pay.example.com/live' }, PAY_FRAME);
    cap.handle(1, 'Network.webSocketFrameSent', {
      requestId: 'ws-9',
      response: { opcode: 1, payloadData: '{"pan":"4242424242424242"}' },
    }, PAY_FRAME);
    cap.handle(1, 'Network.webSocketClosed', { requestId: 'ws-9' }, PAY_FRAME);
    const p = emitted[0]!.payload as NetRequestPayload;
    expect(p.wsFrames).toHaveLength(1);
    expect(p.wsFrames![0]!.text).toBeUndefined();
    expect(JSON.stringify(emitted)).not.toContain('4242');
  });
});

describe('console capture from child sessions', () => {
  function consoleCapturer(observesWorkers = false) {
    const emitted: RawEvent[] = [];
    const cap = new ConsoleCapturer((raw) => emitted.push(raw), makeDefaultSettings, () => observesWorkers);
    return { cap, emitted };
  }

  it("names the frame an exception came from, with the frame's URL redacted", () => {
    const { cap, emitted } = consoleCapturer();
    cap.handle(1, 'Runtime.exceptionThrown', {
      exceptionDetails: { exception: { description: 'Error: Charge failed with HTTP 402\n    at pay (fields.js:3:1)' } },
    }, PAY_FRAME);
    const p = emitted[0]!.payload as ErrorPayload;
    expect(p.message).toBe('Error: Charge failed with HTTP 402');
    expect(p.target).toMatchObject({ type: 'iframe', crossSite: true });
    expect(p.target!.url).not.toContain('abc123');
  });

  it('does not merge the same message from the page and from a frame', () => {
    vi.useFakeTimers();
    try {
      const { cap, emitted } = consoleCapturer();
      const log = { type: 'error', args: [{ type: 'string', value: 'Request failed' }] };
      cap.handle(1, 'Runtime.consoleAPICalled', log);
      cap.handle(1, 'Runtime.consoleAPICalled', log, PAY_FRAME);
      vi.advanceTimersByTime(1000);
      expect(emitted).toHaveLength(2);
      expect((emitted[0]!.payload as ConsolePayload).target).toBeUndefined();
      expect((emitted[1]!.payload as ConsolePayload).target?.type).toBe('iframe');
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the page's forwarded copy of a worker error only while the worker is observed", () => {
    const forwarded = {
      entry: { source: 'worker', level: 'error', text: 'Uncaught Error: Search index unavailable' },
    };
    const observed = consoleCapturer(true);
    observed.cap.handle(1, 'Log.entryAdded', forwarded);
    expect(observed.emitted).toHaveLength(0);

    // If the worker could not be attached, the forwarded copy is all we have.
    const unobserved = consoleCapturer(false);
    unobserved.cap.handle(1, 'Log.entryAdded', forwarded);
    expect(unobserved.emitted).toHaveLength(1);
  });
});
