/**
 * Network capture: assembles the multi-event CDP `Network.*` stream into a single
 * `NetRequestPayload` per request (and per WebSocket), applying redaction and body
 * truncation before handing the event to the background funnel.
 *
 * CDP delivers a request across several events keyed by `requestId`
 * (requestWillBeSent → responseReceived → loadingFinished/Failed, plus the
 * *ExtraInfo variants). We accumulate the parts in a `pending` map and emit once
 * the request terminates. On `loadingFinished` we must fetch the response body
 * *immediately* — CDP evicts bodies quickly. See IMPLEMENTATION.md §2.2.
 */

import type {
  CaptureSettings,
  NetBody,
  NetHeader,
  NetRequestPayload,
  RawEvent,
  WsFrame,
} from '@/lib/session/types';
import { API_SPEC_BODY_CAP_BYTES } from '@/lib/session/settings';
import { isApiIsh } from '@/lib/export/openapi';
import { redactBody, redactHeaders, redactUrl } from './redaction';

/** Injected collaborators; see docs/internal-api.md §lib/capture/network.ts. */
export interface NetworkDeps {
  /** DebuggerManager.send — issue a CDP command against a tab. */
  send: (
    tabId: number,
    method: string,
    params?: object,
  ) => Promise<Record<string, unknown>>;
  getSettings: () => CaptureSettings;
  /** The background `recordEvent` funnel. */
  emit: (raw: RawEvent) => void;
  /** Persist an overflowing body whole; returns the asset id. */
  storeBodyAsset: (
    text: string,
    mime: string,
    base64: boolean,
  ) => Promise<string>;
  /** ms epoch of session start, used for WebSocket frame timestamps. */
  sessionStart: () => number;
}

/** In-flight accumulation for a single request or WebSocket. */
interface PartialRequest {
  requestId: string;
  /** Tab that owns this request; needed to emit still-open sockets on flush. */
  tabId?: number;
  method?: string;
  url?: string;
  reqHeaders: Record<string, string>;
  respHeaders: Record<string, string>;
  requestBodyText?: string;
  status?: number;
  statusText?: string;
  mime?: string;
  resourceType?: string;
  initiator?: string;
  fromCache?: boolean;
  timing?: { startedAt: number; durationMs?: number };
  /** CDP monotonic timestamp (seconds) of request start, for duration calc. */
  startMonotonic?: number;
  websocket?: boolean;
  wsFrames?: WsFrame[];
}

/** WebSocket frame text cap (bytes ~ chars). */
const WS_FRAME_TEXT_CAP = 2 * 1024;
/** Max WebSocket frames retained per socket. */
const WS_FRAME_CAP = 100;

export class NetworkCapturer {
  private readonly pending = new Map<string, PartialRequest>();
  /** Last in-flight emit per requestId, so redirect hops sharing one id emit in order. */
  private readonly emitQueue = new Map<string, Promise<void>>();
  /** Bumped on reset so deferred emits from a previous recording are dropped. */
  private generation = 0;

  constructor(private readonly deps: NetworkDeps) {}

  /** Route a `Network.*` CDP event. Never throws. */
  handle(tabId: number, method: string, params: Record<string, unknown>): void {
    try {
      switch (method) {
        case 'Network.requestWillBeSent':
          this.onRequestWillBeSent(tabId, params);
          break;
        case 'Network.requestWillBeSentExtraInfo':
          this.onRequestExtraInfo(params);
          break;
        case 'Network.responseReceived':
          this.onResponseReceived(params);
          break;
        case 'Network.responseReceivedExtraInfo':
          this.onResponseExtraInfo(params);
          break;
        case 'Network.loadingFinished':
          // Async: fetch the body NOW before CDP evicts it.
          void this.onLoadingFinished(tabId, params);
          break;
        case 'Network.loadingFailed':
          this.onLoadingFailed(tabId, params);
          break;
        case 'Network.webSocketCreated':
          this.onWebSocketCreated(tabId, params);
          break;
        case 'Network.webSocketFrameSent':
          this.onWebSocketFrame(tabId, 'sent', params);
          break;
        case 'Network.webSocketFrameReceived':
          this.onWebSocketFrame(tabId, 'recv', params);
          break;
        case 'Network.webSocketClosed':
          this.onWebSocketClosed(tabId, params);
          break;
        default:
          break;
      }
    } catch {
      /* never let a malformed CDP event escape into the debugger listener */
    }
  }

  /** Drop all in-flight state (e.g. between sessions). */
  reset(): void {
    this.pending.clear();
    this.emitQueue.clear();
    this.generation++;
  }

  /**
   * Emit every still-pending WebSocket record with its accumulated frames, then
   * drop it from `pending`. Called by the background on session stop: a socket
   * that never fired `webSocketClosed` would otherwise be lost entirely (with
   * all of its frames). In-flight normal requests are left untouched — only
   * WebSockets are flushed here. A record flushed this way is removed from
   * `pending`, so a later `webSocketClosed` will not double-emit it.
   */
  flushOpen(): void {
    for (const [requestId, p] of Array.from(this.pending.entries())) {
      if (p.websocket !== true) continue;
      this.pending.delete(requestId);
      this.emitRequest(p.tabId ?? -1, p, {});
    }
  }

  // --------------------------------------------------------------------------
  // Request lifecycle
  // --------------------------------------------------------------------------

  private onRequestWillBeSent(tabId: number, params: Record<string, unknown>): void {
    const requestId = asString(params.requestId);
    if (!requestId) return;

    // Chrome reuses the requestId for each hop of a redirect and reports the previous
    // hop's response here, so close that hop out before recording the next one.
    // shortcut: out-of-order *ExtraInfo events can attach raw headers to the adjacent hop, pair them via a queue if that shows up in reports.
    const redirect = asRecord(params.redirectResponse);
    const prev = this.pending.get(requestId);
    if (redirect && prev) {
      if (typeof redirect.status === 'number') prev.status = redirect.status;
      const statusText = asString(redirect.statusText);
      if (statusText) prev.statusText = statusText;
      mergeHeaders(prev.respHeaders, asRecord(redirect.headers));
      if (prev.timing && prev.startMonotonic !== undefined && typeof params.timestamp === 'number') {
        prev.timing.durationMs = Math.max(0, Math.round((params.timestamp - prev.startMonotonic) * 1000));
      }
      this.pending.delete(requestId);
      this.emitRequest(tabId, prev, {});
    }

    const p = this.ensure(requestId);

    const request = asRecord(params.request);
    if (request) {
      const method = asString(request.method);
      if (method) p.method = method;
      const url = asString(request.url);
      if (url) p.url = url;
      mergeHeaders(p.reqHeaders, asRecord(request.headers));
      const postData = asString(request.postData);
      if (postData !== undefined) p.requestBodyText = postData;
    }

    const initiator = asRecord(params.initiator);
    const initType = initiator ? asString(initiator.type) : undefined;
    if (initType) p.initiator = initType;

    const type = asString(params.type);
    if (type) p.resourceType = type;

    const wallTime =
      typeof params.wallTime === 'number' && params.wallTime > 0
        ? params.wallTime * 1000
        : Date.now();
    if (typeof params.timestamp === 'number') p.startMonotonic = params.timestamp;
    p.timing = { startedAt: Math.round(wallTime) };
  }

  private onRequestExtraInfo(params: Record<string, unknown>): void {
    const requestId = asString(params.requestId);
    if (!requestId) return;
    const p = this.ensure(requestId);
    mergeHeaders(p.reqHeaders, asRecord(params.headers));
  }

  private onResponseReceived(params: Record<string, unknown>): void {
    const requestId = asString(params.requestId);
    if (!requestId) return;
    const p = this.ensure(requestId);

    const response = asRecord(params.response);
    if (response) {
      if (typeof response.status === 'number') p.status = response.status;
      const statusText = asString(response.statusText);
      if (statusText) p.statusText = statusText;
      mergeHeaders(p.respHeaders, asRecord(response.headers));
      const mime = asString(response.mimeType);
      if (mime) p.mime = mime;
      if (response.fromDiskCache === true || response.fromServiceWorker === true) {
        p.fromCache = true;
      }
    }
    const type = asString(params.type);
    if (type) p.resourceType = type;
  }

  private onResponseExtraInfo(params: Record<string, unknown>): void {
    const requestId = asString(params.requestId);
    if (!requestId) return;
    const p = this.ensure(requestId);
    mergeHeaders(p.respHeaders, asRecord(params.headers));
    if (typeof params.statusCode === 'number' && p.status === undefined) {
      p.status = params.statusCode;
    }
  }

  private async onLoadingFinished(
    tabId: number,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const requestId = asString(params.requestId);
      if (!requestId) return;
      const p = this.pending.get(requestId);
      if (!p) return;
      this.pending.delete(requestId);

      if (
        p.timing &&
        p.startMonotonic !== undefined &&
        typeof params.timestamp === 'number'
      ) {
        p.timing.durationMs = Math.max(
          0,
          Math.round((params.timestamp - p.startMonotonic) * 1000),
        );
      }

      const settings = this.deps.getSettings();
      let responseBody: NetBody;
      try {
        const res = await this.deps.send(tabId, 'Network.getResponseBody', {
          requestId,
        });
        const rawText = asString(res.body) ?? '';
        const base64 = res.base64Encoded === true;
        responseBody = await this.buildResponseBody(
          rawText,
          base64,
          p.respHeaders,
          p.mime,
          settings,
          this.wantsFullApiBody(p, settings),
        );
      } catch {
        // Body was evicted (or the tab detached) before we could read it.
        responseBody = { present: false };
      }

      this.emitRequest(tabId, p, { responseBody });
    } catch {
      /* swallow — handle() must never throw */
    }
  }

  private onLoadingFailed(
    tabId: number,
    params: Record<string, unknown>,
  ): void {
    const requestId = asString(params.requestId);
    if (!requestId) return;
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    const failureReason = asString(params.errorText);
    this.emitRequest(tabId, p, { failed: true, failureReason });
  }

  // --------------------------------------------------------------------------
  // WebSockets
  // --------------------------------------------------------------------------

  private onWebSocketCreated(
    tabId: number,
    params: Record<string, unknown>,
  ): void {
    const requestId = asString(params.requestId);
    if (!requestId) return;
    const p = this.ensure(requestId);
    p.tabId = tabId;
    p.websocket = true;
    p.method = 'GET';
    p.resourceType = 'WebSocket';
    const url = asString(params.url);
    if (url) p.url = url;
    const initiator = asRecord(params.initiator);
    const initType = initiator ? asString(initiator.type) : undefined;
    if (initType) p.initiator = initType;
    p.wsFrames ??= [];
    if (!p.timing) p.timing = { startedAt: Date.now() };
  }

  private onWebSocketFrame(
    tabId: number,
    dir: 'sent' | 'recv',
    params: Record<string, unknown>,
  ): void {
    const requestId = asString(params.requestId);
    if (!requestId) return;
    const p = this.ensure(requestId);
    p.tabId = tabId;
    p.websocket = true;
    const frames = (p.wsFrames ??= []);
    if (frames.length >= WS_FRAME_CAP) return;

    const response = asRecord(params.response);
    const opcode =
      response && typeof response.opcode === 'number' ? response.opcode : 0;
    const payload = (response && asString(response.payloadData)) ?? '';
    let text = payload;
    let truncated = false;
    if (text.length > WS_FRAME_TEXT_CAP) {
      text = text.slice(0, WS_FRAME_TEXT_CAP);
      truncated = true;
    }
    const ts = Math.max(0, Date.now() - this.deps.sessionStart());
    const frame: WsFrame = { dir, opcode, ts, text };
    if (truncated) frame.truncated = true;
    frames.push(frame);
  }

  private onWebSocketClosed(
    tabId: number,
    params: Record<string, unknown>,
  ): void {
    const requestId = asString(params.requestId);
    if (!requestId) return;
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.websocket = true;
    this.emitRequest(tabId, p, {});
  }

  // --------------------------------------------------------------------------
  // Assembly + redaction
  // --------------------------------------------------------------------------

  /**
   * Should this request's FULL bodies be preserved for the OpenAPI compiler?
   * Only when the opt-in setting is on AND the request is API-ish (XHR/fetch or
   * JSON, not a websocket / static asset / telemetry beacon).
   */
  private wantsFullApiBody(
    p: PartialRequest,
    settings: CaptureSettings,
  ): boolean {
    if (!settings.captureApiSpec) return false;
    return isApiIsh({
      url: p.url ?? '',
      resourceType: p.resourceType,
      mime: p.mime,
      websocket: p.websocket,
    });
  }

  /** The stored-copy cap: raised generously for API-spec bodies. */
  private assetCapFor(settings: CaptureSettings, apiSpec: boolean): number {
    return apiSpec
      ? Math.max(settings.assetBodyCapBytes, API_SPEC_BODY_CAP_BYTES)
      : settings.assetBodyCapBytes;
  }

  private async buildResponseBody(
    rawText: string,
    base64: boolean,
    headers: Record<string, string>,
    mime: string | undefined,
    settings: CaptureSettings,
    apiSpec: boolean,
  ): Promise<NetBody> {
    // Binary / compressed textual bodies (gzip analytics beacons, protobuf, …)
    // would otherwise be inlined as pages of mojibake. Replace them with a short
    // human marker BEFORE redaction/truncation. base64 bodies are already binary
    // and handled by the base64 path below.
    if (!base64 && isProbablyBinary(rawText, headers)) {
      return binaryBodyMarker(rawText, mime, getHeader(headers, 'content-encoding'));
    }

    let text = rawText;
    // Redaction only applies to textual bodies (base64 payloads are binary).
    if (!base64 && settings.redactionEnabled) {
      text = redactBody(text, mime, settings.customRedaction).text;
    }

    const trunc = base64
      ? truncateBase64ToBytes(text, settings.inlineBodyCapBytes)
      : truncateTextToBytes(text, settings.inlineBodyCapBytes);

    const body: NetBody = { present: true, text: trunc.text };
    if (mime) body.mime = mime;
    if (base64) body.base64 = true;

    if (trunc.truncated) {
      body.truncated = true;
      body.originalSize = trunc.originalSize;
      // Preserve the full (redacted) body as an asset when it overflows the
      // inline cap but still fits the asset cap.
      if (trunc.originalSize <= this.assetCapFor(settings, apiSpec)) {
        try {
          body.assetId = await this.deps.storeBodyAsset(
            text,
            mime ?? 'application/octet-stream',
            base64,
          );
        } catch {
          /* asset store failed — keep the truncated inline copy */
        }
      }
    }
    return body;
  }

  private buildRequestBody(
    rawText: string,
    headers: Record<string, string>,
    mime: string | undefined,
    settings: CaptureSettings,
  ): { body: NetBody; overflowText?: string } {
    // Same binary guard as responses (e.g. gzip-compressed request beacons).
    if (isProbablyBinary(rawText, headers)) {
      return {
        body: binaryBodyMarker(rawText, mime, getHeader(headers, 'content-encoding')),
      };
    }

    let text = rawText;
    if (settings.redactionEnabled) {
      text = redactBody(text, mime, settings.customRedaction).text;
    }
    const trunc = truncateTextToBytes(text, settings.inlineBodyCapBytes);
    const body: NetBody = { present: true, text: trunc.text };
    if (mime) body.mime = mime;
    if (trunc.truncated) {
      body.truncated = true;
      body.originalSize = trunc.originalSize;
      // Hand the full redacted text back so the caller can store it whole
      // (API-spec capture); request bodies otherwise stay inline-only.
      return { body, overflowText: text };
    }
    return { body };
  }

  private emitRequest(
    tabId: number,
    p: PartialRequest,
    extra: {
      responseBody?: NetBody;
      failed?: boolean;
      failureReason?: string;
    },
  ): void {
    const settings = this.deps.getSettings();
    const rules = settings.customRedaction;
    const redact = settings.redactionEnabled;

    let url = p.url ?? '';
    if (redact && url) url = redactUrl(url, rules);

    const reqContentType = getHeader(p.reqHeaders, 'content-type');

    let requestHeaders = headersToArray(p.reqHeaders);
    let responseHeaders = headersToArray(p.respHeaders);
    if (redact) {
      requestHeaders = redactHeaders(requestHeaders, rules);
      responseHeaders = redactHeaders(responseHeaders, rules);
    }

    const payload: NetRequestPayload = {
      requestId: p.requestId,
      method: p.method ?? 'GET',
      url,
      requestHeaders,
      responseHeaders,
    };
    if (p.resourceType) payload.resourceType = p.resourceType;
    if (p.status !== undefined) payload.status = p.status;
    if (p.statusText) payload.statusText = p.statusText;

    // When set, the full request body must be stored as an asset before emit.
    let storeRequestBody: { text: string; mime: string } | undefined;
    if (p.requestBodyText !== undefined) {
      const { body, overflowText } = this.buildRequestBody(
        p.requestBodyText,
        p.reqHeaders,
        reqContentType,
        settings,
      );
      payload.requestBody = body;
      if (
        overflowText !== undefined &&
        this.wantsFullApiBody(p, settings) &&
        (body.originalSize ?? 0) <= this.assetCapFor(settings, true)
      ) {
        storeRequestBody = {
          text: overflowText,
          mime: reqContentType ?? 'application/octet-stream',
        };
      }
    }
    if (extra.responseBody) payload.responseBody = extra.responseBody;
    if (p.timing) payload.timing = p.timing;
    if (p.initiator) payload.initiator = p.initiator;
    if (extra.failed) {
      payload.failed = true;
      if (extra.failureReason) payload.failureReason = extra.failureReason;
    }
    if (p.fromCache) payload.fromCache = true;
    if (p.mime) payload.mime = p.mime;
    if (p.websocket) {
      payload.websocket = true;
      payload.wsFrames = p.wsFrames ?? [];
    }

    // Emission stays synchronous unless a full request body must be persisted
    // first (API-spec capture), or an earlier redirect hop with the same
    // requestId is still waiting on that store — then this hop queues behind it.
    const id = p.requestId;
    const prior = this.emitQueue.get(id);
    if (!storeRequestBody && !prior) {
      this.finishEmit(tabId, payload);
      return;
    }
    const stored = storeRequestBody
      ? this.storeRequestBody(payload, storeRequestBody)
      : undefined;
    const gen = this.generation;
    const done = Promise.all([prior, stored]).then(() => {
      if (gen === this.generation) this.finishEmit(tabId, payload);
    });
    this.emitQueue.set(id, done);
    void done.then(() => {
      if (this.emitQueue.get(id) === done) this.emitQueue.delete(id);
    });
  }

  /** Store an overflowing request body as an asset. Never rejects. */
  private async storeRequestBody(
    payload: NetRequestPayload,
    store: { text: string; mime: string },
  ): Promise<void> {
    try {
      const assetId = await this.deps.storeBodyAsset(store.text, store.mime, false);
      if (payload.requestBody) payload.requestBody.assetId = assetId;
    } catch {
      /* asset store failed — keep the truncated inline copy */
    }
  }

  private finishEmit(tabId: number, payload: NetRequestPayload): void {
    try {
      this.deps.emit({ type: 'net-request', tabId, payload });
    } catch {
      /* funnel errors must not propagate back into the CDP listener */
    }
  }

  private ensure(requestId: string): PartialRequest {
    let p = this.pending.get(requestId);
    if (!p) {
      p = { requestId, reqHeaders: {}, respHeaders: {} };
      this.pending.set(requestId, p);
    }
    return p;
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

/** Merge a CDP header map ({name: value}) into an accumulator, stringifying. */
function mergeHeaders(
  target: Record<string, string>,
  source: Record<string, unknown> | undefined,
): void {
  if (!source) return;
  for (const [name, value] of Object.entries(source)) {
    target[name] = typeof value === 'string' ? value : String(value);
  }
}

function headersToArray(map: Record<string, string>): NetHeader[] {
  return Object.entries(map).map(([name, value]) => ({ name, value }));
}

/** Case-insensitive header lookup over a name→value map. */
function getHeader(
  map: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Content-encodings that mean the body bytes are compressed (binary). */
const BINARY_CONTENT_ENCODINGS = /\b(?:gzip|br|deflate|zstd)\b/i;
/** Content-types that are inherently binary/streaming, not readable text. */
const BINARY_CONTENT_TYPES = /octet-stream|protobuf|grpc|event-stream/i;

/**
 * Heuristic: is this textual body actually binary/compressed and thus useless
 * (and huge) to inline? True when a content-encoding marks it compressed, the
 * content-type is a known binary/stream type, or the text has a high ratio of
 * characters that never occur in genuine text.
 *
 * "Never occurs in text": C0 control chars (minus tab/LF/CR), DEL, the C1
 * control block (U+0080–U+009F), and U+FFFD. The C1 block is the key signal for
 * client-compressed beacons (e.g. `compression=gzip-js`) sent as `text/plain`:
 * the deflate stream, decoded as Latin-1, sprays ~10%+ C1 chars, while real
 * text — including accented Latin (U+00A0+) and CJK/emoji (>U+00FF) — has
 * effectively none. Counting only C0 controls (~12% in high-entropy data)
 * missed these; folding in C1/DEL pushes them well clear of the threshold with
 * no false positives on legitimate Unicode bodies.
 */
function isProbablyBinary(
  text: string,
  headers: Record<string, string>,
): boolean {
  const enc = getHeader(headers, 'content-encoding');
  if (enc && BINARY_CONTENT_ENCODINGS.test(enc)) return true;
  const ct = getHeader(headers, 'content-type');
  if (ct && BINARY_CONTENT_TYPES.test(ct)) return true;

  if (text.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      c < 9 || // C0 controls (below tab)
      (c > 13 && c < 32) || // C0 controls (above CR)
      c === 0x7f || // DEL
      (c >= 0x80 && c <= 0x9f) || // C1 controls — only from mis-decoded binary
      c === 0xfffd // UTF-8 replacement char
    ) {
      nonPrintable++;
    }
  }
  return nonPrintable / text.length > 0.15;
}

/** Short human marker standing in for an un-shown binary body. */
function binaryBodyMarker(
  text: string,
  mime: string | undefined,
  enc: string | undefined,
): NetBody {
  const bytes = new TextEncoder().encode(text).length;
  const body: NetBody = {
    present: true,
    originalSize: bytes,
    truncated: false,
    base64: false,
    text: `«binary body — ${bytes} bytes${enc ? ', ' + enc : ''}, not shown»`,
  };
  if (mime) body.mime = mime;
  return body;
}

interface Truncation {
  text: string;
  truncated: boolean;
  originalSize: number;
}

/** Truncate a UTF-8 string to at most `cap` bytes without splitting a codepoint. */
function truncateTextToBytes(text: string, cap: number): Truncation {
  const bytes = new TextEncoder().encode(text);
  const originalSize = bytes.length;
  if (originalSize <= cap) {
    return { text, truncated: false, originalSize };
  }
  const truncatedText = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, cap),
  );
  return { text: truncatedText, truncated: true, originalSize };
}

/** Decoded byte length of a standard base64 string. */
function base64DecodedSize(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  let pad = 0;
  if (b64.charCodeAt(len - 1) === 61 /* '=' */) pad++;
  if (len > 1 && b64.charCodeAt(len - 2) === 61) pad++;
  return Math.floor(len / 4) * 3 - pad;
}

/** Truncate a base64 body to at most `cap` decoded bytes, staying valid base64. */
function truncateBase64ToBytes(b64: string, cap: number): Truncation {
  const originalSize = base64DecodedSize(b64);
  if (originalSize <= cap) {
    return { text: b64, truncated: false, originalSize };
  }
  const chars = Math.floor(cap / 3) * 4; // whole 3-byte groups → 4 chars each
  return { text: b64.slice(0, chars), truncated: true, originalSize };
}
