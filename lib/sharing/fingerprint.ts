/**
 * Error fingerprint (version v1) for finding issues filed for the same bug.
 * Without source maps, frames from minified code are weak evidence; the
 * normalized message carries most of the weight.
 */
import type { NetRequestPayload, SessionEvent } from '@/lib/session/types';
import { sha256Hex } from '@/lib/util/hash';

type ErrorEvent = Extract<SessionEvent, { type: 'error' }>;
type ConsoleEvent = Extract<SessionEvent, { type: 'console' }>;
type RequestEvent = Extract<SessionEvent, { type: 'net-request' }>;
export type SignalEvent = ErrorEvent | ConsoleEvent | RequestEvent;

/**
 * The event that best identifies the bug: the first uncaught exception, else the
 * app's first console.error call, else the first failed or 5xx request. 4xx
 * responses are usually expected application behaviour and are ignored. Browser
 * log entries (`error` events from `log`: CSP violations, resource-load failures,
 * network notices) never identify the bug; a failed load is its request.
 */
export function primarySignal(events: SessionEvent[]): SignalEvent | undefined {
  const ordered = [...events].sort((a, b) => a.t - b.t);
  return (
    ordered.find(
      (event): event is ErrorEvent =>
        event.type === 'error' && event.payload.origin === 'exception',
    ) ??
    ordered.find(
      (event): event is ConsoleEvent =>
        event.type === 'console' && event.payload.level === 'error',
    ) ??
    ordered.find(
      (event): event is RequestEvent =>
        event.type === 'net-request' &&
        (event.payload.failed === true || (event.payload.status ?? 0) >= 500),
    )
  );
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]*[^\s'"`<>().,;:!?]/gi;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(UUID, 'gi');
/** Eight or more hex characters with at least one digit and one letter. */
const HEX_PATTERN = /(?<![\w$])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}(?![\w$])/gi;
/** Numbers that are not part of an identifier such as `user42`. */
const NUMBER_PATTERN = /(?<![\w$])\d+(?:\.\d+)?/g;
/**
 * A quote must not start or end inside a word, so "can't" is not a quotation.
 * Quoted values may span lines; their content is redacted all the same.
 */
const QUOTED_PATTERN = /(?<![\w$])(['"`])([\s\S]*?)\1(?![\w$])/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MESSAGE_CAP = 200;

/** Remove values that vary between occurrences of the same bug. */
export function normalizeMessage(message: string): string {
  return message
    .replace(URL_PATTERN, '<url>')
    .replace(EMAIL_PATTERN, '<email>')
    .replace(UUID_PATTERN, '<uuid>')
    .replace(HEX_PATTERN, '<hex>')
    .replace(NUMBER_PATTERN, '<n>')
    .replace(QUOTED_PATTERN, (quoted, _quote, content: string) =>
      IDENTIFIER.test(content) ? quoted : '<str>',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_CAP);
}

const FRAME_LIMIT = 3;
/** Shorter names are treated as minified and carry no meaning across builds. */
const MIN_FUNCTION_NAME = 3;
/** A trailing `-HASH` or `.HASH` (6+ characters with a digit), optionally before `.chunk`. */
const BUILD_HASH = /[-.]([A-Za-z0-9_]{6,})(?=(?:\.chunk)?\.[A-Za-z0-9]+$)/;

function withoutBuildHash(file: string): string {
  return file.replace(BUILD_HASH, (match, hash: string) => (/\d/.test(hash) ? '' : match));
}

function frame(line: string): string | undefined {
  const call = /^\s*at\s+(?:(.*?)\s+\((.*)\)|(\S+))\s*$/.exec(line);
  if (!call) return undefined;
  const bare = call[3] ?? '';
  const bareIsLocation = bare.includes('://');
  const name = (call[1] ?? (bareIsLocation ? '' : bare)).replace(/^(?:async|new)\s+/, '');
  const location = call[2] ?? (bareIsLocation ? bare : '');
  let url: URL;
  try {
    url = new URL(location.replace(/(?::\d+){1,2}$/, ''));
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const file = withoutBuildHash(url.pathname.split('/').pop() ?? '');
  const named = name.length >= MIN_FUNCTION_NAME && !name.includes('<anonymous>');
  return named ? `${name}@${file}` : file;
}

/** The top frames from web pages, without positions or build hashes that change per deploy. */
export function stackFrames(stack: string | undefined): string[] {
  const frames: string[] = [];
  for (const line of stack?.split('\n') ?? []) {
    const value = frame(line);
    if (value !== undefined) frames.push(value);
    if (frames.length === FRAME_LIMIT) break;
  }
  return frames;
}

const ID_SEGMENTS = [
  /^\d+$/,
  new RegExp(`^${UUID}$`, 'i'),
  /^[0-9a-f]{8,}$/i,
  // Long random tokens mix letters and digits.
  /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{16,}$/,
];

/** Method, host and path template; the query and fragment never leave the recording. */
export function requestTemplate(
  request: Pick<NetRequestPayload, 'method' | 'url' | 'status' | 'failed' | 'failureReason'>,
): string {
  let host = '';
  let path: string;
  try {
    const url = new URL(request.url);
    host = url.host;
    path = url.pathname;
  } catch {
    path = request.url.split(/[?#]/)[0] ?? '';
  }
  const template = path
    .split('/')
    .map((segment) => (ID_SEGMENTS.some((pattern) => pattern.test(segment)) ? ':id' : segment))
    .join('/');
  const outcome =
    (request.status ?? 0) >= 500
      ? '5xx'
      : `failed${request.failureReason ? `:${request.failureReason}` : ''}`;
  return `${request.method.toUpperCase()} ${host}${template} ${outcome}`;
}

export interface ErrorFingerprint {
  /** `sr-` and twelve hex characters, for example `sr-7c41e9a2b3d0`. */
  id: string;
  /** The normalized error message; empty for a request signal. */
  message: string;
}
const FINGERPRINT_VERSION = 'v1';

/** A Sentry-style grouping key for the recording's primary error, if it has one. */
export async function fingerprint(
  events: SessionEvent[],
): Promise<ErrorFingerprint | undefined> {
  const signal = primarySignal(events);
  if (!signal) return undefined;
  const [kind, message, detail] =
    signal.type === 'error'
      ? [
          signal.payload.origin,
          normalizeMessage(signal.payload.message),
          stackFrames(signal.payload.stack).join(','),
        ]
      : signal.type === 'console'
        ? [
            'console',
            normalizeMessage(signal.payload.text),
            stackFrames(signal.payload.stack).join(','),
          ]
        : ['request', '', requestTemplate(signal.payload)];
  const key = [FINGERPRINT_VERSION, kind, message, detail].join('|');
  const hash = await sha256Hex(new TextEncoder().encode(key));
  return { id: `sr-${hash.slice(0, 12)}`, message };
}
