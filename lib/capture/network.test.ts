import { describe, expect, it, vi } from 'vitest';
import type {
  CaptureSettings,
  NetRequestPayload,
  RawEvent,
} from '@/lib/session/types';
import { NetworkCapturer, type NetworkDeps } from './network';

const SETTINGS: CaptureSettings = {
  screenshotPolicy: 'key-moments',
  inlineBodyCapBytes: 64 * 1024,
  assetBodyCapBytes: 512 * 1024,
  fileCapBytes: 1024 * 1024,
  redactionEnabled: true,
  customRedaction: { headerNames: [], bodyKeyPatterns: [], urlParamPatterns: [] },
  filterTelemetry: true,
  hoverDwellMs: 0,
  screenshotQuality: 70,
  screenshotDedupThreshold: 4,
  captureApiSpec: false,
};

function makeCapturer(overrides: Partial<NetworkDeps> = {}): {
  cap: NetworkCapturer;
  emitted: RawEvent[];
} {
  const emitted: RawEvent[] = [];
  const deps: NetworkDeps = {
    send: vi.fn(async () => ({})),
    getSettings: () => SETTINGS,
    emit: (raw) => emitted.push(raw),
    storeBodyAsset: vi.fn(async () => 'asset-1'),
    sessionStart: () => 0,
    ...overrides,
  };
  return { cap: new NetworkCapturer(deps), emitted };
}

function payloadOf(raw: RawEvent): NetRequestPayload {
  return raw.payload as NetRequestPayload;
}

describe('NetworkCapturer WebSockets', () => {
  it('emits one net-request with accumulated frames when a still-open socket is flushed', () => {
    const { cap, emitted } = makeCapturer();
    const rid = 'ws-1';

    cap.handle(7, 'Network.webSocketCreated', {
      requestId: rid,
      url: 'wss://app.example.com/api/chat/ws/orchestrator',
      initiator: { type: 'script' },
    });
    cap.handle(7, 'Network.webSocketFrameSent', {
      requestId: rid,
      response: { opcode: 1, payloadData: 'hello from client' },
    });
    cap.handle(7, 'Network.webSocketFrameReceived', {
      requestId: rid,
      response: { opcode: 1, payloadData: 'hi from server' },
    });
    cap.handle(7, 'Network.webSocketFrameReceived', {
      requestId: rid,
      response: { opcode: 2, payloadData: 'AAECAwQF' /* binary base64 */ },
    });

    // Socket never closes; recording stops -> flush.
    expect(emitted).toHaveLength(0);
    cap.flushOpen();

    expect(emitted).toHaveLength(1);
    const p = payloadOf(emitted[0]!);
    expect(emitted[0]!.tabId).toBe(7);
    expect(p.websocket).toBe(true);
    expect(p.url).toBe('wss://app.example.com/api/chat/ws/orchestrator');
    expect(p.wsFrames).toHaveLength(3);
    expect(p.wsFrames![0]).toMatchObject({
      dir: 'sent',
      opcode: 1,
      text: 'hello from client',
    });
    expect(p.wsFrames![1]).toMatchObject({ dir: 'recv', opcode: 1 });
    expect(p.wsFrames![2]).toMatchObject({
      dir: 'recv',
      opcode: 2,
      text: 'AAECAwQF',
    });
  });

  it('does not double-emit: a socket flushed then closed emits exactly once', () => {
    const { cap, emitted } = makeCapturer();
    const rid = 'ws-2';
    cap.handle(3, 'Network.webSocketCreated', {
      requestId: rid,
      url: 'wss://x/y',
    });
    cap.handle(3, 'Network.webSocketFrameReceived', {
      requestId: rid,
      response: { opcode: 1, payloadData: 'frame' },
    });
    cap.flushOpen();
    cap.handle(3, 'Network.webSocketClosed', { requestId: rid });
    expect(emitted).toHaveLength(1);
  });

  it('redacts secrets in text frames', () => {
    const { cap, emitted } = makeCapturer();
    cap.handle(4, 'Network.webSocketCreated', { requestId: 'ws-3', url: 'wss://x/y' });
    cap.handle(4, 'Network.webSocketFrameSent', {
      requestId: 'ws-3',
      response: { opcode: 1, payloadData: '{"token":"WS_SECRET","n":1}' },
    });
    cap.flushOpen();
    const text = payloadOf(emitted[0]!).wsFrames![0]!.text!;
    expect(text).not.toContain('WS_SECRET');
    expect(JSON.parse(text)).toEqual({ token: '«redacted»', n: 1 });
  });

  it('flushOpen leaves in-flight normal requests untouched', () => {
    const { cap, emitted } = makeCapturer();
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'req-1',
      request: { method: 'GET', url: 'https://x/data', headers: {} },
      type: 'XHR',
    });
    cap.flushOpen();
    expect(emitted).toHaveLength(0);
  });
});

describe('NetworkCapturer API-spec full-body capture', () => {
  const API_SETTINGS: CaptureSettings = { ...SETTINGS, captureApiSpec: true };
  // Over both the inline cap (64 KB) and the asset cap (512 KB), under 10 MB.
  const bigJson = `{"data":"${'x'.repeat(600 * 1024)}"}`;

  function finishXhr(
    cap: NetworkCapturer,
    url: string,
    opts?: { postData?: string },
  ): void {
    const rid = 'r-api';
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: rid,
      request: {
        method: opts?.postData ? 'POST' : 'GET',
        url,
        headers: { 'content-type': 'application/json' },
        ...(opts?.postData ? { postData: opts.postData } : {}),
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.responseReceived', {
      requestId: rid,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
      },
    });
    cap.handle(1, 'Network.loadingFinished', { requestId: rid });
  }

  it('does not store a delayed response body in a new recording after reset', async () => {
    let finishOldBody!: (body: { body: string; base64Encoded: boolean }) => void;
    const send = vi.fn(async () => ({ body: '{"new":true}', base64Encoded: false }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishOldBody = resolve; }));
    const storeBodyAsset = vi.fn(async () => 'asset-old');
    const { cap, emitted } = makeCapturer({
      getSettings: () => ({ ...API_SETTINGS, inlineBodyCapBytes: 16 }),
      send,
      storeBodyAsset,
    });
    finishXhr(cap, 'https://api.example.com/v1/old');
    cap.reset();
    // Reuse even the request ID: membership must identify the old hop itself.
    finishXhr(cap, 'https://api.example.com/v1/new');
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    finishOldBody({ body: `{"old":"${'x'.repeat(64)}"}`, base64Encoded: false });
    // send() is the only await before the mocked store call. Let its entire
    // continuation settle, including the unguarded path used as the regression.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeBodyAsset.mock.calls.length).toBe(0);
    expect(emitted).toHaveLength(1);
    expect(payloadOf(emitted[0]!)).toMatchObject({ url: 'https://api.example.com/v1/new' });
  });

  it('stores the full response body past the normal asset cap when the flag is on', async () => {
    const storeBodyAsset = vi.fn(async () => 'asset-api');
    const { cap, emitted } = makeCapturer({
      getSettings: () => API_SETTINGS,
      send: vi.fn(async () => ({ body: bigJson, base64Encoded: false })),
      storeBodyAsset,
    });
    finishXhr(cap, 'https://api.example.com/v1/users');
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const body = payloadOf(emitted[0]!).responseBody!;
    expect(body.truncated).toBe(true);
    expect(body.assetId).toBe('asset-api');
    expect(storeBodyAsset).toHaveBeenCalledWith(
      bigJson,
      'application/json',
      false,
    );
  });

  it('respects the old asset cap for the same body when the flag is off', async () => {
    const storeBodyAsset = vi.fn(async () => 'asset-api');
    const { cap, emitted } = makeCapturer({
      send: vi.fn(async () => ({ body: bigJson, base64Encoded: false })),
      storeBodyAsset,
    });
    finishXhr(cap, 'https://api.example.com/v1/users');
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const body = payloadOf(emitted[0]!).responseBody!;
    expect(body.truncated).toBe(true);
    expect(body.assetId).toBeUndefined();
    expect(storeBodyAsset).not.toHaveBeenCalled();
  });

  it('stores an overflowing request body as an asset when the flag is on', async () => {
    const storeBodyAsset = vi.fn(async () => 'asset-req');
    const { cap, emitted } = makeCapturer({
      getSettings: () => API_SETTINGS,
      send: vi.fn(async () => ({ body: '{"ok":true}', base64Encoded: false })),
      storeBodyAsset,
    });
    finishXhr(cap, 'https://api.example.com/v1/users', { postData: bigJson });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const body = payloadOf(emitted[0]!).requestBody!;
    expect(body.truncated).toBe(true);
    expect(body.assetId).toBe('asset-req');
    expect(storeBodyAsset).toHaveBeenCalledWith(
      bigJson,
      'application/json',
      false,
    );
  });

  it('never raises the cap for telemetry endpoints', async () => {
    const storeBodyAsset = vi.fn(async () => 'asset-tel');
    const { cap, emitted } = makeCapturer({
      getSettings: () => API_SETTINGS,
      send: vi.fn(async () => ({ body: bigJson, base64Encoded: false })),
      storeBodyAsset,
    });
    finishXhr(cap, 'https://api.segment.io/v1/batch', { postData: bigJson });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const p = payloadOf(emitted[0]!);
    expect(p.requestBody!.assetId).toBeUndefined();
    expect(p.responseBody!.assetId).toBeUndefined();
    expect(storeBodyAsset).not.toHaveBeenCalled();
  });

  it('never raises the cap for static assets', async () => {
    const storeBodyAsset = vi.fn(async () => 'asset-css');
    const { cap, emitted } = makeCapturer({
      getSettings: () => API_SETTINGS,
      send: vi.fn(async () => ({ body: 'x'.repeat(600 * 1024), base64Encoded: false })),
      storeBodyAsset,
    });
    const rid = 'r-css';
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: rid,
      request: { method: 'GET', url: 'https://cdn.example.com/app.css', headers: {} },
      type: 'Stylesheet',
    });
    cap.handle(1, 'Network.responseReceived', {
      requestId: rid,
      response: { status: 200, headers: { 'content-type': 'text/css' }, mimeType: 'text/css' },
    });
    cap.handle(1, 'Network.loadingFinished', { requestId: rid });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(payloadOf(emitted[0]!).responseBody!.assetId).toBeUndefined();
    expect(storeBodyAsset).not.toHaveBeenCalled();
  });
});

describe('NetworkCapturer binary bodies', () => {
  it('replaces a gzip-encoded response body with a short marker', async () => {
    const gzipGarbage = 'garbage-that-should-not-appear';
    const { cap, emitted } = makeCapturer({
      send: vi.fn(async () => ({ body: gzipGarbage, base64Encoded: false })),
    });
    const rid = 'r-gzip';
    cap.handle(2, 'Network.requestWillBeSent', {
      requestId: rid,
      request: { method: 'GET', url: 'https://x/data', headers: {} },
      type: 'XHR',
    });
    cap.handle(2, 'Network.responseReceived', {
      requestId: rid,
      response: {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        mimeType: 'text/plain',
      },
    });
    cap.handle(2, 'Network.loadingFinished', { requestId: rid });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const body = payloadOf(emitted[0]!).responseBody!;
    expect(body.present).toBe(true);
    expect(body.base64).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.text).toContain('binary body');
    expect(body.text).toContain('gzip');
    expect(body.text).not.toContain('garbage');
    expect(body.originalSize).toBeGreaterThan(0);
  });

  it('replaces a high-non-printable request body with a marker (no binary header)', () => {
    const emitted: RawEvent[] = [];
    const { cap } = makeCapturer({ emit: (raw) => emitted.push(raw) });
    // 10 control chars (0x01) + a short readable tail -> >15% non-printable.
    // content-type is plain text, so ONLY the char-ratio heuristic can flag it.
    const binary = String.fromCharCode(1).repeat(10) + 'marker-text-payload';
    const rid = 'r-bin';
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: rid,
      request: {
        method: 'POST',
        url: 'https://x/ingest',
        headers: { 'content-type': 'text/plain' },
        postData: binary,
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.loadingFailed', {
      requestId: rid,
      errorText: 'net::ERR',
    });

    expect(emitted).toHaveLength(1);
    const body = payloadOf(emitted[0]!).requestBody!;
    expect(body.text).toContain('binary body');
    expect(body.base64).toBe(false);
    expect(body.text).not.toContain('marker-text-payload');
  });

  it('flags a Latin-1-decoded compressed beacon (C1 control chars) as binary', () => {
    const emitted: RawEvent[] = [];
    const { cap } = makeCapturer({ emit: (raw) => emitted.push(raw) });
    // Simulate a `compression=gzip-js` beacon: high-entropy bytes decoded as
    // Latin-1 — mostly high chars with a healthy fraction of C1 controls
    // (U+0080–U+009F). This has NO C0 control chars, so the old heuristic missed it.
    let beacon = '';
    for (let i = 0; i < 400; i++) {
      // cycle through C1 controls + printable high-Latin, as gzip output does.
      beacon += String.fromCharCode(0x80 + (i % 0x60)); // 0x80..0xDF
    }
    const rid = 'r-beacon';
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: rid,
      request: {
        method: 'POST',
        url: 'https://x/ingest/i/v0/e?compression=gzip-js',
        headers: { 'content-type': 'text/plain' },
        postData: beacon,
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: rid, errorText: 'x' });

    const body = payloadOf(emitted[0]!).requestBody!;
    expect(body.text).toContain('binary body');
    expect(body.text).not.toContain(beacon.slice(0, 20));
  });

  it('keeps genuinely textual bodies intact (redaction still applies)', () => {
    const emitted: RawEvent[] = [];
    const { cap } = makeCapturer({ emit: (raw) => emitted.push(raw) });
    const rid = 'r-json';
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: rid,
      request: {
        method: 'POST',
        url: 'https://x/api',
        headers: { 'content-type': 'application/json' },
        postData: '{"name":"alice","note":"plain text here"}',
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: rid, errorText: 'x' });

    const body = payloadOf(emitted[0]!).requestBody!;
    expect(body.text).toContain('plain text here');
    expect(body.text).not.toContain('binary body');
  });
});

describe('NetworkCapturer redirects', () => {
  // Chrome reuses one requestId for every hop of a redirect chain; each later hop's
  // requestWillBeSent carries the previous hop's response as `redirectResponse`.
  function header(headers: { name: string; value: string }[], name: string): string | undefined {
    return headers.find((h) => h.name.toLowerCase() === name)?.value;
  }

  it.each(['before', 'after', 'split'])(
    'pairs ExtraInfo with its redirect hop when delivered %s the base events',
    async (order) => {
      const send = vi.fn(async () => ({ body: 'final response', base64Encoded: false }));
      const { cap, emitted } = makeCapturer({ send });
      const info = (kind: 'request' | 'response', hop: string) =>
        cap.handle(1, kind === 'request'
          ? 'Network.requestWillBeSentExtraInfo'
          : 'Network.responseReceivedExtraInfo', {
          requestId: 'ordered',
          headers: { [`X-${kind}-Hop`]: hop },
          ...(kind === 'response' ? { statusCode: hop === 'first' ? 302 : 200 } : {}),
        });
      if (order !== 'after') {
        info('request', 'first');
        info('request', 'final');
      }
      if (order === 'before') {
        info('response', 'first');
        info('response', 'final');
      }
      cap.handle(1, 'Network.requestWillBeSent', {
        requestId: 'ordered',
        request: { method: 'POST', url: 'https://app.example/login', headers: {}, postData: 'name=alice' },
      });
      cap.handle(1, 'Network.requestWillBeSent', {
        requestId: 'ordered',
        request: { method: 'GET', url: 'https://app.example/cached', headers: {} },
        redirectHasExtraInfo: true,
        redirectResponse: { status: 302, headers: { Location: '/cached' } },
      });
      cap.handle(1, 'Network.requestWillBeSent', {
        requestId: 'ordered',
        request: { method: 'GET', url: 'https://app.example/final', headers: {} },
        redirectHasExtraInfo: false,
        redirectResponse: { status: 307, headers: { Location: '/final' } },
      });
      cap.handle(1, 'Network.responseReceived', {
        requestId: 'ordered',
        hasExtraInfo: true,
        response: { status: 200, headers: {}, mimeType: 'text/plain' },
      });
      cap.handle(1, 'Network.loadingFinished', { requestId: 'ordered' });
      // Headers must not delay fetching the body, which CDP can evict.
      expect(send).toHaveBeenCalledWith(1, 'Network.getResponseBody', { requestId: 'ordered' });
      await Promise.resolve();
      await Promise.resolve();
      if (order !== 'before') expect(emitted).toHaveLength(0);
      if (order === 'after') {
        info('request', 'first');
        info('request', 'final');
      }
      if (order !== 'before') {
        info('response', 'first');
        info('response', 'final');
      }
      await vi.waitFor(() => expect(emitted).toHaveLength(3));
      const hops = emitted.map(payloadOf);
      expect(hops.map((p) => [
        p.url, p.status,
        header(p.requestHeaders, 'x-request-hop'),
        header(p.responseHeaders, 'x-response-hop'),
      ])).toEqual([
        ['https://app.example/login', 302, 'first', 'first'],
        ['https://app.example/cached', 307, undefined, undefined],
        ['https://app.example/final', 200, 'final', 'final'],
      ]);
      expect(hops[0]!.requestBody?.text).toBe('name=alice');
      expect(hops[1]!.requestBody).toBeUndefined();
      expect(hops[2]!.requestBody).toBeUndefined();
      expect(hops[2]!.responseBody?.text).toBe('final response');
      expect(header(hops[2]!.responseHeaders, 'location')).toBeUndefined();
    },
  );

  it('keeps available extra headers when a request fails without responseReceived', () => {
    const { cap, emitted } = makeCapturer();
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'cors',
      request: { method: 'GET', url: 'https://app.example/blocked', headers: {} },
    });
    cap.handle(1, 'Network.responseReceivedExtraInfo', {
      requestId: 'cors', statusCode: 403, headers: { 'X-Blocked': 'cors' },
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: 'cors', errorText: 'net::ERR_FAILED' });
    expect(emitted).toHaveLength(1);
    expect(payloadOf(emitted[0]!)).toMatchObject({ status: 403, failed: true });
    expect(header(payloadOf(emitted[0]!).responseHeaders, 'x-blocked')).toBe('cors');
  });

  it('drops unpaired extra headers on reset', () => {
    const { cap, emitted } = makeCapturer();
    cap.handle(1, 'Network.requestWillBeSentExtraInfo', {
      requestId: 'reused', headers: { 'X-Old-Session': 'old' },
    });
    cap.reset();
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'reused',
      request: { method: 'GET', url: 'https://app.example/new', headers: {} },
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: 'reused', errorText: 'net::ERR_ABORTED' });
    expect(emitted).toHaveLength(1);
    expect(header(payloadOf(emitted[0]!).requestHeaders, 'x-old-session')).toBeUndefined();
  });

  it('emits the 302 hop and the follow-up GET as separate requests', async () => {
    const { cap, emitted } = makeCapturer({
      send: vi.fn(async () => ({ body: '<h1>Dashboard</h1>', base64Encoded: false })),
    });
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'nav-1',
      request: {
        method: 'POST',
        url: 'https://app.example.com/login',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        postData: 'username=alice',
      },
      type: 'Document',
    });
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'nav-1',
      request: { method: 'GET', url: 'https://app.example.com/dashboard', headers: {} },
      redirectResponse: {
        status: 302,
        statusText: 'Found',
        headers: { Location: '/dashboard' },
        mimeType: 'text/html',
        fromDiskCache: true,
      },
      type: 'Document',
    });
    cap.handle(1, 'Network.responseReceived', {
      requestId: 'nav-1',
      response: { status: 200, headers: { 'Content-Type': 'text/html' }, mimeType: 'text/html' },
      type: 'Document',
    });
    cap.handle(1, 'Network.loadingFinished', { requestId: 'nav-1' });
    await vi.waitFor(() => expect(emitted).toHaveLength(2));

    const [hop1, hop2] = emitted.map(payloadOf);
    expect(hop1).toMatchObject({ method: 'POST', url: 'https://app.example.com/login', status: 302 });
    expect(hop1!.requestBody?.present).toBe(true);
    expect(header(hop1!.responseHeaders, 'location')).toBe('/dashboard');
    expect(hop1).toMatchObject({ mime: 'text/html', fromCache: true });

    expect(hop2).toMatchObject({ method: 'GET', url: 'https://app.example.com/dashboard', status: 200 });
    expect(hop2!.requestBody?.present ?? false).toBe(false);
    expect(header(hop2!.requestHeaders, 'content-type')).toBeUndefined();
    expect(header(hop2!.responseHeaders, 'location')).toBeUndefined();
  });

  it('emits every hop of a multi-redirect chain in order', async () => {
    const { cap, emitted } = makeCapturer();
    const hop = (url: string, redirectStatus?: number) =>
      cap.handle(1, 'Network.requestWillBeSent', {
        requestId: 'nav-2',
        request: { method: 'GET', url, headers: {} },
        ...(redirectStatus ? { redirectResponse: { status: redirectStatus, headers: {} } } : {}),
      });
    hop('https://a.example/old');
    hop('https://a.example/new', 301);
    hop('https://a.example/final', 302);
    cap.handle(1, 'Network.responseReceived', { requestId: 'nav-2', response: { status: 200, headers: {} } });
    cap.handle(1, 'Network.loadingFinished', { requestId: 'nav-2' });
    await vi.waitFor(() => expect(emitted).toHaveLength(3));

    expect(emitted.map(payloadOf).map((p) => [p.url, p.status])).toEqual([
      ['https://a.example/old', 301],
      ['https://a.example/new', 302],
      ['https://a.example/final', 200],
    ]);
  });
  it('keeps hop order when an earlier hop is still storing its request body', async () => {
    let finishStore!: (id: string) => void;
    const storeBodyAsset = vi.fn(
      () => new Promise<string>((resolve) => (finishStore = resolve)),
    );
    const send = vi.fn(async () => ({ body: '{"ok":true}', base64Encoded: false }));
    const { cap, emitted } = makeCapturer({
      getSettings: () => ({ ...SETTINGS, captureApiSpec: true }),
      storeBodyAsset,
      send,
    });
    const json = { 'content-type': 'application/json' };
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'nav-3',
      request: {
        method: 'POST',
        url: 'https://api.example.com/v1/upload',
        headers: json,
        postData: `{"data":"${'x'.repeat(100 * 1024)}"}`,
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'nav-3',
      request: { method: 'GET', url: 'https://api.example.com/v1/result', headers: {} },
      redirectResponse: { status: 303, headers: { Location: '/v1/result' } },
      type: 'XHR',
    });
    cap.handle(1, 'Network.responseReceived', {
      requestId: 'nav-3',
      response: { status: 200, headers: json, mimeType: 'application/json' },
    });
    cap.handle(1, 'Network.loadingFinished', { requestId: 'nav-3' });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    // The GET is done, but must not land ahead of the POST still being stored.
    expect(emitted).toHaveLength(0);

    finishStore('asset-post');
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    const [hop1, hop2] = emitted.map(payloadOf);
    expect(hop1).toMatchObject({ method: 'POST', status: 303 });
    expect(hop1!.requestBody?.assetId).toBe('asset-post');
    expect(hop2).toMatchObject({ method: 'GET', status: 200 });
  });

  it('drops queued hops when a new recording starts before storage settles', async () => {
    let finishStore!: (id: string) => void;
    const storeBodyAsset = vi.fn(
      () => new Promise<string>((resolve) => (finishStore = resolve)),
    );
    const { cap, emitted } = makeCapturer({
      getSettings: () => ({ ...SETTINGS, captureApiSpec: true }),
      storeBodyAsset,
    });
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'nav-4',
      request: {
        method: 'POST',
        url: 'https://api.example.com/v1/upload',
        headers: { 'content-type': 'application/json' },
        postData: `{"data":"${'x'.repeat(100 * 1024)}"}`,
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'nav-4',
      request: { method: 'GET', url: 'https://api.example.com/v1/result', headers: {} },
      redirectResponse: { status: 303, headers: {} },
      type: 'XHR',
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: 'nav-4', errorText: 'net::ERR_ABORTED' });
    expect(storeBodyAsset).toHaveBeenCalled();

    cap.reset(); // next recording starts
    finishStore('asset-old');
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toHaveLength(0);
  });
});

describe('NetworkCapturer header redaction (end to end through emitRequest)', () => {
  it('does not emit secret-bearing headers outside the exact blocklist', () => {
    const { cap, emitted } = makeCapturer();
    const rid = 'h-1';
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: rid,
      request: {
        url: 'https://app.example.com/api/me',
        method: 'GET',
        headers: {
          'X-CSRF-Token': 'FAKE-csrf-7f3a91',
          'X-Amz-Security-Token': 'FAKE-amz-91d0e5',
          'X-Goog-Signature': 'FAKE-sig-3c6e2b',
          authToken: 'FAKE-authtoken-5d17f0',
          'X-Request-Id': 'req-123',
        },
      },
      type: 'Fetch',
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: rid, errorText: 'net::ERR_FAILED' });
    const json = JSON.stringify(emitted);
    expect(json).not.toContain('FAKE-csrf-7f3a91');
    expect(json).not.toContain('FAKE-amz-91d0e5');
    expect(json).not.toContain('FAKE-sig-3c6e2b');
    expect(json).not.toContain('FAKE-authtoken-5d17f0');
    expect(json).toContain('req-123');
  });
});

describe('NetworkCapturer URL-bearing headers (end to end through emitRequest)', () => {
  it('masks secret query values in Referer and Location but keeps the other params', () => {
    const { cap, emitted } = makeCapturer();
    const rid = 'u-1';
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: rid,
      request: {
        url: 'https://app.example.com/start',
        method: 'GET',
        headers: { Referer: 'https://app.example.com/page?session_id=FAKE-ref-8a1&tab=2' },
      },
      type: 'Fetch',
    });
    cap.handle(1, 'Network.responseReceived', {
      requestId: rid,
      response: {
        status: 302,
        headers: { Location: '/landing?access_token=FAKE-loc-4c9&page=2' },
        mimeType: 'text/plain',
      },
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: rid, errorText: 'net::ERR_ABORTED' });
    const json = JSON.stringify(emitted);
    expect(json).not.toContain('FAKE-ref-8a1');
    expect(json).not.toContain('FAKE-loc-4c9');
    expect(json).toContain('tab=2');
    expect(json).toContain('/landing?access_token=');
    expect(json).toContain('page=2');
  });
});
