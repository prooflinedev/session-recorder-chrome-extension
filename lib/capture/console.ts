/**
 * Console + error capture: routes CDP Runtime/Log events into `console` and
 * `error` session events.
 *
 * Handles three CDP methods:
 *  - `Runtime.consoleAPICalled` -> `console` event (level-mapped, args stringified).
 *  - `Runtime.exceptionThrown`  -> `error` event `{origin:'exception'}`.
 *  - `Log.entryAdded`           -> `error` (level 'error') or `console` event.
 *
 * Consecutive identical `console` events (same level+text) within 1s are
 * coalesced into a single pending event whose `payload.repeat` is bumped, rather
 * than emitting a duplicate. The pending event flushes when a different message
 * arrives or after 1000ms of quiet.
 *
 * Every event carries `at`, the time the page produced it (CDP's own
 * timestamp), so holding a message for coalescing never moves it in the
 * timeline. Interaction events are stamped the same way, in the page.
 */

import type {
  CaptureSettings,
  ConsoleLevel,
  ConsolePayload,
  ErrorPayload,
  RawEvent,
} from '@/lib/session/types';
import { redactUrl, redactUrlsInText } from './redaction';

/** Max size (bytes/chars) of a joined console message before truncation. */
const TEXT_CAP = 2048;

/** Milliseconds of quiet after which a pending console event is flushed. */
const COALESCE_MS = 1000;

/** Minimal shape of a CDP RemoteObject (only the fields we read). */
interface RemoteObjectLike {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  preview?: { description?: string } & Record<string, unknown>;
}

/** Minimal shape of a CDP stack trace (only the fields we read). */
interface CallFrameLike {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}
interface StackTraceLike {
  callFrames?: CallFrameLike[];
}

interface Pending {
  key: string;
  raw: RawEvent<'console'>;
}

export class ConsoleCapturer {
  private readonly emit: (raw: RawEvent) => void;
  private readonly getSettings: () => CaptureSettings;
  private pending: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(emit: (raw: RawEvent) => void, getSettings: () => CaptureSettings) {
    this.emit = emit;
    this.getSettings = getSettings;
  }

  /** Route a `Runtime.*` / `Log.*` CDP event. Unknown methods are ignored. */
  handle(tabId: number, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        this.onConsoleApiCalled(tabId, params);
        break;
      case 'Runtime.exceptionThrown':
        this.onExceptionThrown(tabId, params);
        break;
      case 'Log.entryAdded':
        this.onLogEntryAdded(tabId, params);
        break;
      default:
        break;
    }
  }

  /** Drop any pending coalesced event and clear the flush timer. */
  reset(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  // --------------------------------------------------------------------------
  // Runtime.consoleAPICalled
  // --------------------------------------------------------------------------

  private onConsoleApiCalled(
    tabId: number,
    params: Record<string, unknown>,
  ): void {
    const level = mapConsoleType(params['type']);
    const args = Array.isArray(params['args'])
      ? (params['args'] as RemoteObjectLike[])
      : [];
    const argStrings = args.map((arg) => this.redactText(stringifyRemoteObject(arg)));
    const text = capText(argStrings.join(' '));
    const source = sourceFromStack(params['stackTrace'] as StackTraceLike | undefined, (url) => this.redactUrl(url));

    const payload: ConsolePayload = { level, text };
    if (argStrings.length > 0) payload.args = argStrings;
    if (source !== undefined) payload.source = source;

    this.pushConsole(tabId, payload, occurredAt(params['timestamp']));
  }

  // --------------------------------------------------------------------------
  // Runtime.exceptionThrown
  // --------------------------------------------------------------------------

  private onExceptionThrown(
    tabId: number,
    params: Record<string, unknown>,
  ): void {
    const details =
      (params['exceptionDetails'] as Record<string, unknown> | undefined) ?? {};
    const exception = details['exception'] as RemoteObjectLike | undefined;

    const description =
      typeof exception?.description === 'string' ? exception.description : undefined;
    const text = typeof details['text'] === 'string' ? (details['text'] as string) : undefined;

    let message: string;
    if (description) {
      // Error descriptions embed the stack; the message is the first line.
      message = description.split('\n', 1)[0] ?? description;
    } else if (exception !== undefined) {
      message = stringifyRemoteObject(exception);
    } else {
      message = text ?? 'Uncaught exception';
    }
    message = capText(this.redactText(message));

    const stack =
      formatStack(details['stackTrace'] as StackTraceLike | undefined, (url) => this.redactUrl(url)) ??
      (description && description.includes('\n')
        ? this.redactText(description.slice(description.indexOf('\n') + 1))
        : undefined);

    const payload: ErrorPayload = { origin: 'exception', message };
    if (stack !== undefined) payload.stack = capText(stack);

    // Preserve ordering: flush any pending console before the error.
    this.flush();
    this.emit(this.raw('error', tabId, payload, occurredAt(params['timestamp'])));
  }

  // --------------------------------------------------------------------------
  // Log.entryAdded
  // --------------------------------------------------------------------------

  private onLogEntryAdded(
    tabId: number,
    params: Record<string, unknown>,
  ): void {
    const entry = (params['entry'] as Record<string, unknown> | undefined) ?? {};
    const level = typeof entry['level'] === 'string' ? (entry['level'] as string) : '';
    const rawText = typeof entry['text'] === 'string' ? (entry['text'] as string) : '';
    const url = typeof entry['url'] === 'string' ? (entry['url'] as string) : undefined;
    const lineNumber =
      typeof entry['lineNumber'] === 'number' ? (entry['lineNumber'] as number) : undefined;
    const stackTrace = entry['stackTrace'] as StackTraceLike | undefined;
    const at = occurredAt(entry['timestamp']);

    const args = Array.isArray(entry['args'])
      ? (entry['args'] as RemoteObjectLike[]).map((arg) => this.redactText(stringifyRemoteObject(arg)))
      : [];
    const text = capText([this.redactText(rawText), ...args].filter((s) => s.length > 0).join(' '));

    const source =
      url !== undefined
        ? lineNumber !== undefined
          ? `${this.redactUrl(url)}:${lineNumber}`
          : this.redactUrl(url)
        : sourceFromStack(stackTrace, (url) => this.redactUrl(url));

    if (level === 'error') {
      const payload: ErrorPayload = { origin: 'log', message: text };
      const stack = formatStack(stackTrace, (url) => this.redactUrl(url));
      if (stack !== undefined) payload.stack = capText(stack);
      this.flush();
      this.emit(this.raw('error', tabId, payload, at));
      return;
    }

    const payload: ConsolePayload = { level: mapLogLevel(level), text };
    if (args.length > 0) payload.args = args;
    if (source !== undefined) payload.source = source;
    this.pushConsole(tabId, payload, at);
  }

  // --------------------------------------------------------------------------
  // Coalescing
  // --------------------------------------------------------------------------

  /** Buffer a console event, coalescing consecutive duplicates. */
  private pushConsole(tabId: number, payload: ConsolePayload, at: number): void {
    const key = `${payload.level}\u0000${payload.text}`;

    if (this.pending && this.pending.key === key) {
      // Duplicate within the quiet window: bump repeat, extend the window, and
      // remember how long the run has lasted (the event keeps its first time).
      const held = this.pending.raw;
      held.payload.repeat = (held.payload.repeat ?? 1) + 1;
      // Occurrence times need not arrive in order; never shrink a known span.
      held.payload.repeatSpanMs = Math.max(
        held.payload.repeatSpanMs ?? 0,
        at - (held.at ?? at),
      );
      this.arm();
      return;
    }

    // Different message: flush the previous one, then start a new pending.
    this.flush();
    this.pending = { key, raw: this.raw('console', tabId, payload, at) };
    this.arm();
  }

  /** (Re)start the quiet-window flush timer. */
  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, COALESCE_MS);
  }

  /**
   * Emit the pending console event (if any) and clear the timer. The session
   * calls this before it stops or pauses, so the last message is never lost.
   */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const raw = this.pending.raw;
      this.pending = null;
      this.emit(raw);
    }
  }

  private raw<T extends 'console' | 'error'>(
    type: T,
    tabId: number,
    payload: RawEvent<T>['payload'],
    at: number,
  ): RawEvent<T> {
    return { type, tabId, payload, at };
  }

  private redactText(text: string): string {
    const settings = this.getSettings();
    return settings.redactionEnabled
      ? redactUrlsInText(text, settings.customRedaction)
      : text;
  }

  private redactUrl(url: string): string {
    const settings = this.getSettings();
    return settings.redactionEnabled
      ? redactUrl(url, settings.customRedaction)
      : url;
  }
}

// ----------------------------------------------------------------------------
// Helpers (pure)
// ----------------------------------------------------------------------------

/**
 * When the page produced a CDP console/log/exception event, in whole epoch ms
 * like every other event. CDP's `Runtime.Timestamp` comes from the browser,
 * not page JavaScript, so a page that fakes `Date` cannot skew it. Missing or
 * invalid values, and any value in the future, fall back to now.
 */
function occurredAt(timestamp: unknown): number {
  const now = Date.now();
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
    ? Math.min(Math.round(timestamp), now)
    : now;
}

/** Map a `Runtime.consoleAPICalled` type to a `ConsoleLevel`. */
function mapConsoleType(type: unknown): ConsoleLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warn';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    case 'trace':
      return 'trace';
    case 'log':
    default:
      return 'log';
  }
}

/** Map a `Log.entryAdded` level to a `ConsoleLevel` (error handled by caller). */
function mapLogLevel(level: string): ConsoleLevel {
  switch (level) {
    case 'warning':
      return 'warn';
    case 'info':
      return 'info';
    case 'verbose':
      return 'debug';
    default:
      return 'log';
  }
}

/** Render a CDP RemoteObject to a readable string. */
function stringifyRemoteObject(obj: RemoteObjectLike | undefined): string {
  if (obj === undefined || obj === null) return '';

  if ('value' in obj && obj.value !== undefined) {
    const v = obj.value;
    if (typeof v === 'string') return v;
    if (v === null) return 'null';
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  if (typeof obj.description === 'string') return obj.description;
  if (typeof obj.unserializableValue === 'string') return obj.unserializableValue;
  if (obj.preview && typeof obj.preview.description === 'string') {
    return obj.preview.description;
  }
  if (typeof obj.type === 'string') {
    return obj.subtype ? `[${obj.type}:${obj.subtype}]` : `[${obj.type}]`;
  }
  return '';
}

/** `url:lineNumber` from the first call frame, if present. */
function sourceFromStack(
  stackTrace: StackTraceLike | undefined,
  cleanUrl: (url: string) => string,
): string | undefined {
  const frame = stackTrace?.callFrames?.[0];
  if (!frame || typeof frame.url !== 'string' || frame.url.length === 0) {
    return undefined;
  }
  const line = typeof frame.lineNumber === 'number' ? frame.lineNumber : 0;
  return `${cleanUrl(frame.url)}:${line}`;
}

/** Format call frames into a readable multi-line stack, or undefined. */
function formatStack(
  stackTrace: StackTraceLike | undefined,
  cleanUrl: (url: string) => string,
): string | undefined {
  const frames = stackTrace?.callFrames;
  if (!Array.isArray(frames) || frames.length === 0) return undefined;
  const lines = frames.map((f) => {
    const fn = f.functionName && f.functionName.length > 0 ? f.functionName : '<anonymous>';
    const url = typeof f.url === 'string' ? cleanUrl(f.url) : '';
    const line = typeof f.lineNumber === 'number' ? f.lineNumber : 0;
    const col = typeof f.columnNumber === 'number' ? f.columnNumber : 0;
    return url ? `    at ${fn} (${url}:${line}:${col})` : `    at ${fn}`;
  });
  return lines.join('\n');
}

/** Cap a string to `TEXT_CAP`, appending an ellipsis marker when truncated. */
function capText(text: string): string {
  if (text.length <= TEXT_CAP) return text;
  return `${text.slice(0, TEXT_CAP)}…`;
}
