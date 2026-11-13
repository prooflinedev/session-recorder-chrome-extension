/**
 * Builds `network.har` from the same trimmed, already-redacted events as
 * `session.json`, so it never shows more than the rest of the zip.
 */

import { version } from '@/package.json';
import type {
  NetBody,
  NetHeader,
  NetRequestPayload,
  Session,
  SessionEvent,
} from '@/lib/session/types';

const PARTIAL = 'Body cut short at capture or by the export level.';

/** Returns null when there are no requests. */
export function buildHar(session: Session, events: SessionEvent[]): object | null {
  const entries = events.flatMap((e) =>
    e.type === 'net-request' ? [entry(session, e.t, e.payload)] : [],
  );
  if (!entries.length) return null;
  return {
    log: {
      version: '1.2',
      creator: { name: 'Session Recorder by Proofline', version },
      entries,
    },
  };
}

function entry(session: Session, t: number, p: NetRequestPayload): object {
  const time = p.timing?.durationMs ?? 0;
  const started = p.timing?.startedAt ?? session.startedAt + t - time;
  const request = body(p.requestBody, header(p.requestHeaders, 'content-type'));
  const response = body(p.responseBody, p.mime);
  const collapsed =
    p.collapsed &&
    `Shown once for ${p.collapsed.count} similar requests ` +
      `(statuses: ${p.collapsed.statuses.join(', ')}).`;

  return {
    startedDateTime: new Date(started).toISOString(),
    time,
    request: {
      method: p.method,
      url: p.url,
      httpVersion: '',
      cookies: [],
      headers: p.requestHeaders,
      queryString: queryString(p.url),
      ...(request && {
        postData: {
          mimeType: request.mimeType,
          text: request.text,
          ...(request.partial && { comment: PARTIAL }),
        },
      }),
      headersSize: -1,
      bodySize: request ? request.size : 0,
    },
    response: {
      status: p.status ?? (p.websocket ? 101 : 0),
      statusText: p.statusText ?? '',
      httpVersion: '',
      cookies: [],
      headers: p.responseHeaders,
      content: {
        size: response?.size ?? 0,
        mimeType: response?.mimeType ?? p.mime ?? '',
        ...(response && { text: response.text }),
        ...(response?.base64 && { encoding: 'base64' }),
        ...(response?.partial && { comment: PARTIAL }),
      },
      redirectURL: header(p.responseHeaders, 'location') ?? '',
      headersSize: -1,
      bodySize: -1,
      // Same field name Chrome uses.
      ...(p.failed && { _error: p.failureReason ?? 'Request failed' }),
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    ...(p.resourceType && { _resourceType: p.resourceType.toLowerCase() }),
    ...(p.wsFrames && {
      _webSocketMessages: p.wsFrames.map((f) => ({
        type: f.dir === 'sent' ? 'send' : 'receive',
        time: (session.startedAt + f.ts) / 1000,
        opcode: f.opcode,
        data: f.text ?? '',
      })),
    }),
    ...(collapsed && { comment: collapsed }),
  };
}

interface HarBody {
  text: string;
  mimeType: string;
  size: number;
  base64: boolean;
  partial: boolean;
}

function body(
  b: NetBody | undefined,
  fallbackMime: string | undefined,
): HarBody | null {
  if (!b?.present || b.text === undefined) return null;
  const base64 = b.base64 === true;
  const size =
    b.originalSize ??
    // Byte count of the base64 text.
    (base64
      ? Math.floor((b.text.replace(/=+$/, '').length * 3) / 4)
      : new TextEncoder().encode(b.text).length);
  return {
    text: b.text,
    mimeType: b.mime ?? fallbackMime ?? '',
    size,
    base64,
    partial: b.truncated === true,
  };
}

function queryString(url: string): NetHeader[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function header(headers: NetHeader[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}
