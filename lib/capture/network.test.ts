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

describe('NetworkCapturer value-based redaction', () => {
  function captureRequest(redactionEnabled: boolean): NetRequestPayload {
    const emitted: RawEvent[] = [];
    const { cap } = makeCapturer({
      getSettings: () => ({ ...SETTINGS, redactionEnabled }),
      emit: (raw) => emitted.push(raw),
    });
    const rid = 'r-pii';
    cap.handle(1, 'Network.requestWillBeSent', {
      requestId: rid,
      request: {
        method: 'POST',
        url: 'https://x/api/pay?customer=86095742719',
        headers: { 'content-type': 'application/json' },
        postData: '{"account":"DE89370400440532013000","payment":"4111111111111111"}',
      },
      type: 'XHR',
    });
    cap.handle(1, 'Network.loadingFailed', { requestId: rid, errorText: 'x' });
    return payloadOf(emitted[0]!);
  }

  it('masks personal numbers in the URL and body when redaction is on', () => {
    const p = captureRequest(true);
    expect(p.url).toBe('https://x/api/pay?customer=«redacted»');
    expect(JSON.parse(p.requestBody!.text!)).toEqual({
      account: '«redacted»',
      payment: '«redacted»',
    });
  });

  it('keeps the values when redaction is off for the recording', () => {
    const p = captureRequest(false);
    expect(p.url).toBe('https://x/api/pay?customer=86095742719');
    expect(JSON.parse(p.requestBody!.text!)).toEqual({
      account: 'DE89370400440532013000',
      payment: '4111111111111111',
    });
  });
});
