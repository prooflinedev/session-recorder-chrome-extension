/**
 * Test fixtures: a fluent builder for synthetic recording sessions.
 *
 * Produces `{ session, events, assets }` triples that are realistic enough to
 * exercise the trimmer, markdown renderer, and bundle builder. Each chained
 * call appends one `SessionEvent` with a monotonically increasing `t`, a
 * correct `importance` (via `scoreEvent`), and the right `protected` flag (via
 * `PROTECTED_TYPES`). Screenshot/voice/file/annotation calls also register a
 * matching `Asset`. This module is a test helper — it is not pure and is never
 * shipped, but it deliberately avoids touching `chrome`/DOM so it runs in node.
 */

import { PROTECTED_TYPES, scoreEvent } from '@/lib/session/events';
import { makeDefaultSettings } from '@/lib/session/settings';
import type {
  AnnotationPayload,
  Asset,
  ClickPayload,
  ConsoleLevel,
  ConsolePayload,
  ElementDescriptor,
  ErrorPayload,
  EventPayloadMap,
  EventType,
  FilePayload,
  InputPayload,
  NavPayload,
  NetBody,
  NetRequestPayload,
  ScreenshotPayload,
  ScreenshotTrigger,
  ScrollPayload,
  Session,
  SessionEvent,
  TabInfo,
  TextSelectPayload,
  VideoSegmentPayload,
  VoiceSegmentPayload,
} from '@/lib/session/types';

/** ms added to `t` between consecutive events. */
const STEP_MS = 500;

/** 1x1 transparent PNG, base64 (no data: prefix). */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A minimal 1x1 PNG blob, used for screenshot / annotation assets. */
export function tinyPngBlob(): Blob {
  return new Blob([base64ToBytes(TINY_PNG_BASE64)], { type: 'image/png' });
}

/** A tiny opaque binary blob, used for audio / file assets. */
function tinyBinaryBlob(mime: string, size = 32): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 13) & 0xff;
  return new Blob([bytes], { type: mime });
}

function byteLength(text: string): number {
  // Cheap UTF-8 byte count without needing TextEncoder guarantees.
  return new Blob([text]).size;
}

function descriptorFor(text: string, tag = 'button'): ElementDescriptor {
  const slug = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  return {
    tag,
    text: text.slice(0, 80),
    role: tag === 'button' ? 'button' : undefined,
    selector: slug ? `${tag}.${slug || 'el'}` : tag,
  };
}

function resourceTypeFor(url: string, mime: string | undefined): string {
  const m = (mime ?? '').toLowerCase();
  const u = url.toLowerCase();
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|ico)(\?|$)/.test(u)) {
    return 'Image';
  }
  if (m.includes('css') || /\.css(\?|$)/.test(u)) return 'Stylesheet';
  if (m.includes('font') || /\.(woff2?|ttf|otf|eot)(\?|$)/.test(u)) return 'Font';
  if (m.includes('javascript') || /\.js(\?|$)/.test(u)) return 'Script';
  return 'Fetch';
}

function netBody(text: string | undefined, mime: string): NetBody | undefined {
  if (text === undefined) return undefined;
  const size = byteLength(text);
  return { present: true, mime, text, originalSize: size };
}

export class SessionBuilder {
  private readonly session: Session;
  private readonly events: SessionEvent[] = [];
  private readonly assets: Asset[] = [];
  private t = 0;
  private seq = 0;
  private assetSeq = 0;
  private reqSeq = 0;
  private readonly primaryTabId: number;

  constructor(overrides?: Partial<Session>) {
    const startedAt = overrides?.startedAt ?? Date.UTC(2026, 0, 2, 15, 0, 0);
    const initialUrl = overrides?.initialUrl ?? 'https://app.example.com/dashboard';
    const primaryTab: TabInfo = {
      tabId: 1,
      url: initialUrl,
      title: 'Example App',
      attachedAt: startedAt,
      role: 'primary',
      attached: true,
    };
    this.session = {
      id: overrides?.id ?? 'sess_fixture',
      name: overrides?.name ?? 'Fixture session',
      startedAt,
      initialUrl,
      tabs: overrides?.tabs ?? [primaryTab],
      settings: overrides?.settings ?? makeDefaultSettings(),
      status: overrides?.status ?? 'stopped',
      counts: {},
      assetBytes: 0,
      ...(overrides?.endedAt !== undefined ? { endedAt: overrides.endedAt } : {}),
    };
    const firstTab = this.session.tabs[0];
    this.primaryTabId = firstTab ? firstTab.tabId : 1;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private push<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    tabId: number = this.primaryTabId,
  ): void {
    this.t += STEP_MS;
    const importance = scoreEvent({ type, tabId, payload });
    const event: SessionEvent = {
      id: `evt_${++this.seq}`,
      sessionId: this.session.id,
      t: this.t,
      tabId,
      type,
      importance,
      ...(PROTECTED_TYPES.has(type) ? { protected: true } : {}),
      payload,
    } as SessionEvent;
    this.events.push(event);
    this.session.counts[type] = (this.session.counts[type] ?? 0) + 1;
  }

  private addAsset(kind: Asset['kind'], mime: string, blob: Blob): string {
    const id = `asset_${++this.assetSeq}`;
    this.assets.push({
      id,
      sessionId: this.session.id,
      kind,
      mime,
      size: blob.size,
      blob,
    });
    this.session.assetBytes += blob.size;
    return id;
  }

  // --------------------------------------------------------------------------
  // Interaction / navigation
  // --------------------------------------------------------------------------

  click(text: string, opts?: { modifiers?: string[]; button?: number; tag?: string }): this {
    const payload: ClickPayload = {
      descriptor: descriptorFor(text, opts?.tag ?? 'button'),
      modifiers: opts?.modifiers ?? [],
      ...(opts?.button !== undefined ? { button: opts.button } : {}),
    };
    this.push('click', payload);
    return this;
  }

  input(
    name: string,
    value: string,
    opts?: { redacted?: boolean; inputType?: string },
  ): this {
    const descriptor: ElementDescriptor = {
      tag: 'input',
      name,
      selector: `input[name="${name}"]`,
    };
    const payload: InputPayload = {
      descriptor,
      value,
      redacted: opts?.redacted ?? false,
      ...(opts?.inputType ? { inputType: opts.inputType } : {}),
    };
    this.push('input', payload);
    return this;
  }

  textSelect(
    text: string,
    opts?: { cleared?: boolean; truncated?: boolean; tag?: string },
  ): this {
    const payload: TextSelectPayload = opts?.cleared
      ? { cleared: true }
      : {
          text,
          cleared: false,
          descriptor: descriptorFor(text.slice(0, 24), opts?.tag ?? 'p'),
          ...(opts?.truncated ? { truncated: true } : {}),
        };
    this.push('text-select', payload);
    return this;
  }

  scroll(): this {
    const from = { x: 0, y: (this.seq % 5) * 200 };
    const payload: ScrollPayload = {
      from,
      to: { x: 0, y: from.y + 400 },
      container: 'window',
    };
    this.push('scroll', payload);
    return this;
  }

  nav(url: string, title?: string): this {
    const payload: NavPayload = {
      url,
      ...(title !== undefined ? { title } : {}),
      transitionType: 'link',
    };
    this.push('nav', payload);
    return this;
  }

  // --------------------------------------------------------------------------
  // Deep capture
  // --------------------------------------------------------------------------

  net(
    method: string,
    url: string,
    opts?: { status?: number; reqBody?: string; resBody?: string; mime?: string },
  ): this {
    const status = opts?.status ?? 200;
    const mime = opts?.mime ?? 'application/json';
    const resourceType = resourceTypeFor(url, mime);
    const payload: NetRequestPayload = {
      requestId: `req_${++this.reqSeq}`,
      method: method.toUpperCase(),
      url,
      resourceType,
      status,
      statusText: status >= 400 ? 'Error' : 'OK',
      requestHeaders: [
        { name: 'accept', value: 'application/json' },
        { name: 'content-type', value: 'application/json' },
      ],
      responseHeaders: [{ name: 'content-type', value: mime }],
      mime,
      // Epoch ms, like real capture.
      timing: { startedAt: this.session.startedAt + this.t + STEP_MS, durationMs: 42 },
      initiator: 'script',
    };
    const reqBody = netBody(opts?.reqBody, 'application/json');
    if (reqBody) payload.requestBody = reqBody;
    const resBody = netBody(opts?.resBody, mime);
    if (resBody) payload.responseBody = resBody;
    this.push('net-request', payload);
    return this;
  }

  consoleLog(level: string, text: string): this {
    const payload: ConsolePayload = {
      level: level as ConsoleLevel,
      text,
      source: 'https://app.example.com/main.js:120',
    };
    this.push('console', payload);
    return this;
  }

  error(message: string): this {
    const payload: ErrorPayload = {
      message,
      stack: `Error: ${message}\n    at handler (https://app.example.com/main.js:200:15)`,
      origin: 'exception',
    };
    this.push('error', payload);
    return this;
  }

  // --------------------------------------------------------------------------
  // Visual / voice / files
  // --------------------------------------------------------------------------

  screenshot(trigger?: string): this {
    const assetId = this.addAsset('screenshot', 'image/png', tinyPngBlob());
    const payload: ScreenshotPayload = {
      assetId,
      width: 1,
      height: 1,
      trigger: (trigger as ScreenshotTrigger) ?? 'interaction',
      ahash: '0000000000000000',
      contextText: 'Example App dashboard',
    };
    this.push('screenshot', payload);
    return this;
  }

  marker(name: string): this {
    this.push('marker', { name });
    return this;
  }

  note(text: string): this {
    this.push('note', { text });
    return this;
  }

  voice(transcript: string, tStart: number, tEnd: number): this {
    const assetId = this.addAsset('audio', 'audio/webm', tinyBinaryBlob('audio/webm', 64));
    const payload: VoiceSegmentPayload = {
      assetId,
      tStart,
      tEnd,
      transcript,
      provider: 'openai',
    };
    this.push('voice-segment', payload);
    return this;
  }

  video(tStart: number, tEnd: number, note?: string): this {
    const assetId = this.addAsset('video', 'video/webm', tinyBinaryBlob('video/webm', 128));
    const payload: VideoSegmentPayload = {
      assetId,
      tStart,
      tEnd,
      ...(note !== undefined ? { note } : {}),
    };
    this.push('video-segment', payload);
    return this;
  }

  annotation(shapes?: unknown[]): this {
    const assetId = this.addAsset('screenshot', 'image/png', tinyPngBlob());
    const defaultShapes = [
      {
        tool: 'arrow' as const,
        color: '#ff3b30',
        strokeWidth: 3,
        from: { x: 10, y: 10 },
        to: { x: 120, y: 90 },
      },
      {
        tool: 'text' as const,
        color: '#ff3b30',
        strokeWidth: 2,
        text: 'Click here to continue',
        rect: { x: 130, y: 80, w: 200, h: 24 },
      },
    ];
    const payload: AnnotationPayload = {
      shapes: (shapes as AnnotationPayload['shapes']) ?? defaultShapes,
      screenshotAssetId: assetId,
      viewport: { w: 1280, h: 800 },
    };
    this.push('annotation', payload);
    return this;
  }

  file(name: string, size: number): this {
    const mime = /\.csv$/i.test(name)
      ? 'text/csv'
      : /\.json$/i.test(name)
        ? 'application/json'
        : 'application/octet-stream';
    const assetId = this.addAsset('file', mime, tinyBinaryBlob(mime, Math.min(size, 256)));
    const payload: FilePayload = {
      assetId,
      fileName: name,
      mime,
      size,
      contextText: 'uploaded to Import dialog',
    };
    this.push('file-attached', payload);
    return this;
  }

  // --------------------------------------------------------------------------
  // Build
  // --------------------------------------------------------------------------

  build(): { session: Session; events: SessionEvent[]; assets: Asset[] } {
    const endedAt = this.session.endedAt ?? this.session.startedAt + this.t + STEP_MS;
    const session: Session = {
      ...this.session,
      endedAt,
      counts: { ...this.session.counts },
      tabs: this.session.tabs.map((tb) => ({ ...tb })),
    };
    return {
      session,
      events: this.events.slice(),
      assets: this.assets.slice(),
    };
  }
}

/**
 * A ready-made, expressive dataset that touches every category the trimmer,
 * markdown renderer, and bundle builder care about: GET + POST JSON requests, a
 * static `.png` asset request, repeated polling to one endpoint, a 500 response,
 * console logs including an error, scrolls, clicks, a marker, a note, a voice
 * segment, an annotation, and a file attachment.
 */
export function buildSampleSession(): {
  session: Session;
  events: SessionEvent[];
  assets: Asset[];
} {
  const b = new SessionBuilder({ name: 'Import a CSV of contacts' });

  b.nav('https://app.example.com/dashboard', 'Dashboard')
    .marker('Start: import contacts')
    .click('Contacts', { tag: 'a' })
    .nav('https://app.example.com/contacts', 'Contacts')
    .net('GET', 'https://api.example.com/v1/contacts?page=1', {
      status: 200,
      resBody: '{"items":[{"id":1,"name":"Ada"},{"id":2,"name":"Grace"}],"total":2}',
    })
    .net('GET', 'https://cdn.example.com/assets/logo.png', {
      status: 200,
      mime: 'image/png',
    })
    .scroll()
    .scroll()
    .click('Import')
    .input('file-name', 'contacts.csv')
    .file('contacts.csv', 4096)
    .consoleLog('log', 'parsing 128 rows')
    .net('POST', 'https://api.example.com/v1/contacts/import', {
      status: 200,
      reqBody: '{"fileName":"contacts.csv","rows":128}',
      resBody: '{"jobId":"job_42","accepted":128}',
    })
    .net('GET', 'https://api.example.com/v1/jobs/job_42', {
      status: 200,
      resBody: '{"jobId":"job_42","state":"running"}',
    })
    .net('GET', 'https://api.example.com/v1/jobs/job_42', {
      status: 200,
      resBody: '{"jobId":"job_42","state":"running"}',
    })
    .net('GET', 'https://api.example.com/v1/jobs/job_42', {
      status: 200,
      resBody: '{"jobId":"job_42","state":"done"}',
    })
    .screenshot('interaction')
    .voice('This is where you upload the contacts file.', 6000, 11000)
    .net('POST', 'https://api.example.com/v1/contacts/notify', {
      status: 500,
      reqBody: '{"jobId":"job_42"}',
      resBody: '{"error":"internal_error","message":"notification service down"}',
    })
    .consoleLog('error', 'Failed to send import notification (500)')
    .error('TypeError: Cannot read properties of undefined (reading "email")')
    .screenshot('error')
    .annotation()
    .note('Remember to verify the imported count matches the CSV.')
    .marker('Done: import complete');

  return b.build();
}
