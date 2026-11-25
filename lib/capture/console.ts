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
 */

import type {
  CaptureSettings,
  ConsoleLevel,
  ConsolePayload,
  ErrorPayload,
  RawEvent,
  RedactionRules,
} from '@/lib/session/types';
import {
  buildKeyMatcher,
  DEFAULT_HEADER_BLOCKLIST,
  REDACTED,
  redactBody,
  redactUrl,
  redactUrlsInText,
} from './redaction';

/** Max size (bytes/chars) of a joined console message before truncation. */
const TEXT_CAP = 2048;

/** Max characters of one formatted object, including anything nested in it. */
const OBJECT_CAP = 500;

/** Max characters of one string or key in an object. Chrome uses 100 for fields. */
const PREVIEW_STRING_CAP = 100;

/** Milliseconds of quiet after which a pending console event is flushed. */
const COALESCE_MS = 1000;

/** Minimal shape of a CDP ObjectPreview (only the fields we read). */
interface ObjectPreviewLike {
  type?: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: PropertyPreviewLike[];
  entries?: { key?: ObjectPreviewLike; value: ObjectPreviewLike }[];
}
interface PropertyPreviewLike {
  name: string;
  type?: string;
  subtype?: string;
  value?: string;
  valuePreview?: ObjectPreviewLike;
}

/** How to hide secrets while formatting a preview. */
interface PreviewCleaner {
  text: (text: string) => string;
  isSecretKey: (key: string) => boolean;
}

/** Minimal shape of a CDP RemoteObject (only the fields we read). */
interface RemoteObjectLike {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  preview?: ObjectPreviewLike;
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
    const argStrings = args.map((arg) => this.renderArg(arg));
    const text = capText(argStrings.join(' '));
    const source = sourceFromStack(params['stackTrace'] as StackTraceLike | undefined, (url) => this.redactUrl(url));

    const payload: ConsolePayload = { level, text };
    if (argStrings.length > 0) payload.args = argStrings;
    if (source !== undefined) payload.source = source;

    this.pushConsole(tabId, payload);
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
    message = capText(this.renderPreview(exception) ?? this.redactText(message));

    const stack =
      formatStack(details['stackTrace'] as StackTraceLike | undefined, (url) => this.redactUrl(url)) ??
      (description && description.includes('\n')
        ? this.redactText(description.slice(description.indexOf('\n') + 1))
        : undefined);

    const payload: ErrorPayload = { origin: 'exception', message };
    if (stack !== undefined) payload.stack = capText(stack);

    // Preserve ordering: flush any pending console before the error.
    this.flush();
    this.emit(this.raw('error', tabId, payload));
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

    const args = Array.isArray(entry['args'])
      ? (entry['args'] as RemoteObjectLike[]).map((arg) => this.renderArg(arg))
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
      this.emit(this.raw('error', tabId, payload));
      return;
    }

    const payload: ConsolePayload = { level: mapLogLevel(level), text };
    if (args.length > 0) payload.args = args;
    if (source !== undefined) payload.source = source;
    this.pushConsole(tabId, payload);
  }

  // --------------------------------------------------------------------------
  // Coalescing
  // --------------------------------------------------------------------------

  /** Buffer a console event, coalescing consecutive duplicates. */
  private pushConsole(tabId: number, payload: ConsolePayload): void {
    const key = `${payload.level}\u0000${payload.text}`;

    if (this.pending && this.pending.key === key) {
      // Duplicate within the quiet window: bump repeat, extend the window.
      const prev = this.pending.raw.payload.repeat ?? 1;
      this.pending.raw.payload.repeat = prev + 1;
      this.arm();
      return;
    }

    // Different message: flush the previous one, then start a new pending.
    this.flush();
    this.pending = { key, raw: this.raw('console', tabId, payload) };
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

  /** Emit the pending console event (if any) and clear the timer. */
  private flush(): void {
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
  ): RawEvent<T> {
    return { type, tabId, payload };
  }

  private renderArg(arg: RemoteObjectLike): string {
    return this.renderPreview(arg) ?? this.redactText(stringifyRemoteObject(arg));
  }

  /**
   * The object's own values, or undefined to fall back to its description. The
   * result is already masked: running `redactText` on it would let an unquoted
   * URL swallow the `,` or `}` that follows.
   */
  private renderPreview(obj: RemoteObjectLike | undefined): string | undefined {
    if (!obj?.preview) return undefined;
    const settings = this.getSettings();
    return formatPreview(
      obj.preview,
      settings.redactionEnabled
        ? makePreviewCleaner(settings.customRedaction)
        : { text: capPreviewString, isSecretKey: () => false },
    );
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

/**
 * Format the fields Chrome sent with an object, or return undefined when only
 * its description should be used.
 */
function formatPreview(p: ObjectPreviewLike, clean: PreviewCleaner): string | undefined {
  const { type, subtype, description = '', properties = [], entries = [] } = p;
  const isArray = description === 'Proxy(Array)' || /^Array\(\d+\)$/.test(description);
  const isMapOrSet = subtype === 'map' || subtype === 'set';

  if (type !== 'object') return undefined;
  // DOM events carry what the user typed.
  if (properties.some((prop) => prop.name === 'isTrusted')) return undefined;
  if (subtype === undefined) {
    // Host objects such as Headers hide their contents; `Headers {}` would mislead.
    if (properties.length === 0 && description !== 'Object') return undefined;
  } else if (subtype === 'array' || subtype === 'proxy') {
    // NodeList and Arguments are also 'array'; Proxy(Map) and so on are 'proxy'.
    if (!isArray && description !== 'Proxy(Object)') return undefined;
  } else if (!isMapOrSet) {
    return undefined;
  }

  // A Map or Set lists only `size` as a property; its contents are entries.
  const items = isMapOrSet
    ? entries.map(({ key, value }) => {
        if (key === undefined) return formatNode(value, clean);
        const secret = key.type !== 'object' && clean.isSecretKey(key.description ?? '');
        return `${formatNode(key, clean)} => ${secret ? REDACTED : formatNode(value, clean)}`;
      })
    : properties.map((prop, i) => {
        const value = clean.isSecretKey(prop.name)
          ? REDACTED
          : formatValue(prop.type, prop.subtype, prop.value, prop.valuePreview, clean);
        return isArray && prop.name === String(i)
          ? value
          : `${formatKey(prop.name, clean)}: ${value}`;
      });
  if (p.overflow) items.push('…');

  const list = items.join(', ');
  const label = description === 'Object' || subtype === 'array' ? '' : `${clean.text(description)} `;
  // Cutting is safe here because every value is already masked.
  return cap(label + (isArray ? `[${list}]` : `{${list}}`), OBJECT_CAP);
}

/** Format a Map key, Map value or Set item, which Chrome sends as a preview. */
function formatNode(node: ObjectPreviewLike, clean: PreviewCleaner): string {
  return formatValue(node.type, node.subtype, node.description, node, clean);
}

/** Format one value: nested fields when Chrome sent them, else its short text. */
function formatValue(
  type: string | undefined,
  subtype: string | undefined,
  text = '',
  nested: ObjectPreviewLike | undefined,
  clean: PreviewCleaner,
): string {
  const object = nested && formatPreview(nested, clean);
  if (object !== undefined) return object;
  if (type === 'string') return JSON.stringify(clean.text(text));
  if (type === 'function') return 'ƒ';
  if (type === 'accessor') return '(...)';
  // The other lines of an error are its stack.
  return clean.text(subtype === 'error' ? text.split('\n', 1)[0]! : text);
}

/** Print names, `#private` and `Symbol(x)` keys as they are; quote the rest. */
function formatKey(name: string, clean: PreviewCleaner): string {
  const key = clean.text(name);
  return /^(?:#?[\w$]+|Symbol\([\w$.]*\))$/.test(key) ? key : JSON.stringify(key);
}

/** Mask by body key and header name, as the network capture does. */
function makePreviewCleaner(rules: RedactionRules): PreviewCleaner {
  const matchesKey = buildKeyMatcher(rules);
  const headers = new Set(
    [...DEFAULT_HEADER_BLOCKLIST, ...rules.headerNames].map((h) => h.toLowerCase()),
  );
  return {
    text: (text) => cleanPreviewString(text, rules),
    isSecretKey: (key) => {
      // `#x` and `Symbol(x)` count as `x`.
      const name = key.replace(/^#|^Symbol\((.*)\)$/s, '$1');
      return matchesKey(name) || headers.has(name.toLowerCase());
    },
  };
}

/** Mask secrets inside one string of a preview. */
function cleanPreviewString(text: string, rules: RedactionRules): string {
  const capped = capPreviewString(text);
  // Chrome shortens long strings with an ellipsis, often in the middle. What
  // follows it has lost its key, so only the text before it can be judged.
  const cut = capped.indexOf('…');
  const kept = cut === -1 ? capped : capped.slice(0, cut);
  // JSON cut short no longer parses, so its keys cannot be checked.
  if (cut !== -1 && /"\s*:/.test(kept)) return REDACTED;
  // Bodies before URLs: masking a URL first can break the JSON around it.
  const masked = redactUrlsInText(redactBody(kept, undefined, rules).text, rules);
  return cut === -1 ? masked : `${masked}…`;
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
  return cap(text, TEXT_CAP);
}

/** Cap one string or key of a preview. Map and Set strings arrive whole. */
function capPreviewString(text: string): string {
  return cap(text, PREVIEW_STRING_CAP);
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
