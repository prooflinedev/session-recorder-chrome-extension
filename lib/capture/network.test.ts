import { describe, expect, it, vi } from 'vitest';
import type {
  CaptureSettings,
  NetRequestPayload,
  RawEvent,
} from '@/lib/session/types';
import chromiumResponses from '@/lib/fixtures/chromium-compressed-responses.json';
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

/** The first `cap` UTF-8 bytes of `text`, decoded again (the inline cap counts bytes). */
function firstBytes(text: string, cap: number): string {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, cap));
}

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
  // Network.getResponseBody returns the body after Chrome has undone the
  // Content-Encoding, so a compressed response arrives here as plain text.
  async function finishResponse(headers: Record<string, string>, body: string) {
    const storeBodyAsset = vi.fn(
      async (_text: string, _mime: string, _base64: boolean) => 'asset-decoded',
    );
    const { cap, emitted } = makeCapturer({
      send: vi.fn(async () => ({ body, base64Encoded: false })),
      storeBodyAsset,
    });
    const rid = 'r-encoded';
    cap.handle(2, 'Network.requestWillBeSent', {
      requestId: rid,
      request: { method: 'GET', url: 'https://x/data', headers: {} },
      type: 'XHR',
    });
    cap.handle(2, 'Network.responseReceived', {
      requestId: rid,
      response: {
        status: 200,
        headers,
        mimeType: (headers['content-type'] ?? '').split(';')[0],
      },
    });
    cap.handle(2, 'Network.loadingFinished', { requestId: rid });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    return { emitted, storeBodyAsset };
  }

  // br, deflate and zstd are covered by the Chromium replay below.
  it('keeps a gzip-encoded JSON response body, which CDP returns decoded, and redacts it', async () => {
    const { emitted } = await finishResponse(
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      '{"error":"card_declined","password":"hunter2"}',
    );
    const body = payloadOf(emitted[0]!).responseBody!;
    expect(body.text).not.toContain('binary body');
    expect(body.text).not.toContain('hunter2');
    expect(JSON.parse(body.text!)).toEqual({
      error: 'card_declined',
      password: '«redacted»',
    });
    expect(body.base64).toBeUndefined();
  });

  it('applies the inline and asset caps to a large decoded gzip response', async () => {
    const big = `{"token":"tok-1","data":"${'x'.repeat(100 * 1024)}"}`;
    const { emitted, storeBodyAsset } = await finishResponse(
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      big,
    );
    const body = payloadOf(emitted[0]!).responseBody!;
    expect(body.truncated).toBe(true);
    expect(body.originalSize).toBeGreaterThan(SETTINGS.inlineBodyCapBytes);
    expect(new TextEncoder().encode(body.text!).length).toBeLessThanOrEqual(
      SETTINGS.inlineBodyCapBytes,
    );
    expect(body.assetId).toBe('asset-decoded');
    // The asset is the whole redacted body, not the inline prefix: it equals the
    // original with only the token replaced, and the inline text is its start.
    expect(storeBodyAsset).toHaveBeenCalledTimes(1);
    const stored = storeBodyAsset.mock.calls[0]![0];
    expect(stored).toBe(
      JSON.stringify({ token: '«redacted»', data: 'x'.repeat(100 * 1024) }, null, 2),
    );
    // Stored as plain JSON text: its own MIME type, not base64.
    expect(storeBodyAsset).toHaveBeenCalledWith(stored, 'application/json', false);
    expect(new TextEncoder().encode(stored).length).toBe(body.originalSize);
    expect(body.text).toBe(firstBytes(stored, SETTINGS.inlineBodyCapBytes));
  });

  it.each([
    ['a 3-byte character split by the cap', 'a'.repeat(64 * 1024 - 1) + '✓', 'a'.repeat(64 * 1024 - 1)],
    ['a 2-byte character split by the cap', 'a'.repeat(64 * 1024 - 1) + 'é', 'a'.repeat(64 * 1024 - 1)],
    ['a 4-byte character split by the cap', 'a'.repeat(64 * 1024 - 2) + '😀', 'a'.repeat(64 * 1024 - 2)],
    ['a character that ends exactly at the cap', 'a'.repeat(64 * 1024 - 3) + '✓', 'a'.repeat(64 * 1024 - 3) + '✓'],
  ])('cuts a decoded gzip preview before %s', async (_case, head, expected) => {
    const { emitted } = await finishResponse(
      { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
      head + 'b'.repeat(100),
    );
    const body = payloadOf(emitted[0]!).responseBody!;
    expect(body.truncated).toBe(true);
    expect(body.text).toBe(expected);
    expect(body.text).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(body.text!).length).toBeLessThanOrEqual(
      SETTINGS.inlineBodyCapBytes,
    );
  });

  it('stores no asset for a decoded gzip response over the asset cap', async () => {
    const huge = `{"token":"tok-1","data":"${'x'.repeat(600 * 1024)}"}`;
    expect(new TextEncoder().encode(huge).length).toBeGreaterThan(SETTINGS.assetBodyCapBytes);
    const { emitted, storeBodyAsset } = await finishResponse(
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      huge,
    );
    const body = payloadOf(emitted[0]!).responseBody!;
    expect(body.truncated).toBe(true);
    expect(body.originalSize).toBeGreaterThan(SETTINGS.assetBodyCapBytes);
    expect(new TextEncoder().encode(body.text!).length).toBeLessThanOrEqual(
      SETTINGS.inlineBodyCapBytes,
    );
    expect(body.assetId).toBeUndefined();
    expect(storeBodyAsset).not.toHaveBeenCalled();
    const redacted = JSON.stringify({ token: '«redacted»', data: 'x'.repeat(600 * 1024) }, null, 2);
    expect(body.text).toBe(firstBytes(redacted, SETTINGS.inlineBodyCapBytes));
  });

  // The content-type and control-character checks must not depend on the header:
  // each case runs with and without Content-Encoding.
  const withAndWithoutGzip = (cases: string[]) =>
    cases.flatMap((c) => [[c, 'gzip'], [c, '']] as [string, string][]);

  it.each(withAndWithoutGzip(['application/octet-stream', 'application/x-protobuf', 'text/event-stream']))(
    'still replaces a %s response body with a marker (content-encoding "%s")',
    async (contentType, enc) => {
      const { emitted } = await finishResponse(
        { 'content-type': contentType, ...(enc ? { 'content-encoding': enc } : {}) },
        'readable-but-binary-typed',
      );
      const body = payloadOf(emitted[0]!).responseBody!;
      expect(body.text).toBe(`«binary body — 25 bytes${enc ? ', ' + enc : ''}, not shown»`);
      expect(body.originalSize).toBe(25);
      expect(body).toMatchObject({ present: true, base64: false, truncated: false });
    },
  );

  it.each(['gzip', ''])(
    'still replaces a text body full of control characters (content-encoding "%s")',
    async (enc) => {
      const { emitted } = await finishResponse(
        { 'content-type': 'text/plain', ...(enc ? { 'content-encoding': enc } : {}) },
        String.fromCharCode(1).repeat(10) + 'marker-text-payload',
      );
      const body = payloadOf(emitted[0]!).responseBody!;
      expect(body.text).toBe(`«binary body — 29 bytes${enc ? ', ' + enc : ''}, not shown»`);
      expect(body).toMatchObject({ present: true, base64: false, truncated: false });
      expect(body.text).not.toContain('marker-text-payload');
    },
  );

  it('replaces a decoded gzip response that cannot be redacted with a marker', async () => {
    // Nested deeper than the recursive redactor can go; JSON.parse still succeeds.
    // About 80 KB: over the inline cap and under the asset cap, so a raw copy would
    // be stored if the failure fell through.
    const deep = '{"token":"tok-deep","d":' + '['.repeat(40000) + '1' + ']'.repeat(40000) + '}';
    expect(deep.length).toBeGreaterThan(SETTINGS.inlineBodyCapBytes);
    expect(deep.length).toBeLessThan(SETTINGS.assetBodyCapBytes);
    const { emitted, storeBodyAsset } = await finishResponse(
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      deep,
    );
    const body = payloadOf(emitted[0]!).responseBody!;
    expect(body).toMatchObject({ present: true, base64: false, truncated: false });
    expect(body.text).toBe(`«body not shown — ${deep.length} bytes, could not be redacted»`);
    expect(body.text).not.toContain('tok-deep');
    expect(storeBodyAsset).not.toHaveBeenCalled();
  });

  it('replaces a request body that cannot be redacted with a marker and stores no copy', async () => {
    const deep = '{"token":"tok-deep","d":' + '['.repeat(20000) + '1' + ']'.repeat(20000) + '}';
    // API-spec capture on, so a raw copy handed back for storage would show up here.
    const storeBodyAsset = vi.fn(
      async (_text: string, _mime: string, _base64: boolean) => 'asset-deep',
    );
    const { cap, emitted } = makeCapturer({
      getSettings: () => ({ ...SETTINGS, captureApiSpec: true, inlineBodyCapBytes: 1024 }),
      storeBodyAsset,
    });
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'r-deep',
      request: {
        method: 'POST',
        url: 'https://x/deep',
        headers: { 'content-type': 'application/json' },
        postData: deep,
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: 'r-deep', errorText: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeBodyAsset).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    const body = payloadOf(emitted[0]!).requestBody!;
    expect(body).toMatchObject({ present: true, base64: false, truncated: false });
    expect(body.text).toBe(`«body not shown — ${deep.length} bytes, could not be redacted»`);
    expect(body.text).not.toContain('tok-deep');
  });

  it('still replaces a gzip-encoded request body with a marker', () => {
    const { cap, emitted } = makeCapturer();
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: 'r-beacon-gzip',
      request: {
        method: 'POST',
        url: 'https://x/ingest',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        postData: '{"looks":"like text"}',
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.loadingFailed', {
      requestId: 'r-beacon-gzip',
      errorText: 'x',
    });

    const body = payloadOf(emitted[0]!).requestBody!;
    expect(body.text).toBe('«binary body — 21 bytes, gzip, not shown»');
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

describe('NetworkCapturer response bodies recorded from Chromium', () => {
  // A loopback server sent the same JSON plain, gzip, br, deflate and zstd, then
  // gzip bytes under an encoding Chromium does not know, then gzip-encoded binary.
  const bodies: Record<string, { body: string; base64Encoded: boolean }> =
    chromiumResponses.bodies;
  const sentJson = bodies.plain!.body;
  let fetched: string[] = [];

  async function replay(): Promise<Map<string, NetRequestPayload>> {
    fetched = [];
    const { cap, emitted } = makeCapturer({
      send: vi.fn(async (tabId: number, method: string, params?: object) => {
        const id = (params as { requestId: string }).requestId;
        fetched.push(`${tabId} ${method} ${id}`);
        // Only the real call gets a body: the events came from tab 1, and the body
        // must be asked for with Network.getResponseBody.
        if (tabId !== 1 || method !== 'Network.getResponseBody') return {};
        const recorded = bodies[id]!;
        if (recorded.base64Encoded) return { ...recorded };
        // Each text response gets its own non-redacted field, so a body fetched
        // under another request's id would show up in the assertions below.
        return { ...recorded, body: JSON.stringify({ ...JSON.parse(recorded.body), via: id }) };
      }),
    });
    for (const { method, params } of chromiumResponses.events) {
      cap.handle(1, method, params);
    }
    await vi.waitFor(() => expect(emitted).toHaveLength(Object.keys(bodies).length));
    return new Map(emitted.map((raw) => [payloadOf(raw).requestId, payloadOf(raw)]));
  }

  function encodingOf(p: NetRequestPayload): string | undefined {
    return p.responseHeaders.find((h) => /^content-encoding$/i.test(h.name))?.value;
  }

  it.each(['gzip', 'br', 'deflate', 'zstd'])(
    'keeps the decoded JSON body of a %s response',
    async (encoding) => {
      const payloads = await replay();
      const p = payloads.get(encoding)!;
      // What Chromium reported: the header names the encoding, the body is text.
      expect(encodingOf(p)).toBe(encoding);
      expect(p.responseBody!.mime).toBe('application/json');
      expect(p.responseBody!.present).toBe(true);
      expect(payloads.get('plain')!.responseBody!.present).toBe(true);
      expect(payloads.get('plain')!.responseBody!.mime).toBe('application/json');
      expect(bodies[encoding]).toEqual({ body: sentJson, base64Encoded: false });
      expect(JSON.parse(p.responseBody!.text!)).toEqual({
        error: 'card_declined',
        detail: 'Zahlung abgelehnt ✓',
        token: '«redacted»',
        via: encoding,
      });
      // Same stored body as the uncompressed control, apart from its own `via`.
      const control = payloads.get('plain')!.responseBody!;
      expect(JSON.parse(control.text!).via).toBe('plain');
      expect({ ...p.responseBody, text: JSON.parse(p.responseBody!.text!).via }).toEqual({
        ...control,
        text: encoding,
      });
      expect(JSON.parse(p.responseBody!.text!)).toEqual({ ...JSON.parse(control.text!), via: encoding });
    },
  );

  it('asks Chromium for the body of every request, on its tab, under its own id', async () => {
    await replay();
    expect([...fetched].sort()).toEqual(
      Object.keys(bodies).map((id) => `1 Network.getResponseBody ${id}`).sort(),
    );
  });

  it('stores bodies Chromium returned as base64 unchanged, still base64', async () => {
    const payloads = await replay();
    for (const id of ['unknown-encoding', 'blob-gzip']) {
      expect(bodies[id]!.base64Encoded).toBe(true);
      expect(payloads.get(id)!.responseBody).toMatchObject({
        base64: true,
        text: bodies[id]!.body,
      });
    }
    // Their headers and MIME type are kept as Chromium reported them.
    expect(encodingOf(payloads.get('unknown-encoding')!)).toBe('x-custom');
    expect(payloads.get('unknown-encoding')!.responseBody!.mime).toBe('application/json');
    for (const id of ['unknown-encoding', 'blob-gzip']) expect(payloads.get(id)!.responseBody!.present).toBe(true);
    expect(encodingOf(payloads.get('blob-gzip')!)).toBe('gzip');
    expect(payloads.get('blob-gzip')!.responseBody!.mime).toBe('application/octet-stream');
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
