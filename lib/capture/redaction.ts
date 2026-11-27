/**
 * Pure redaction primitives for captured network traffic.
 *
 * Strips sensitive request/response headers, recursively scrubs values under
 * secret-looking keys in JSON and form-urlencoded bodies, and masks matching
 * URL query-param values. Defaults ALWAYS apply; the per-session master switch
 * (`settings.redactionEnabled`) is handled by the caller — this module is a
 * side-effect-free transform that never touches chrome/DOM/network and never
 * mutates its inputs.
 */

import type { NetHeader, RedactionRules } from '@/lib/session/types';

/** Marker substituted for any redacted value. */
export const REDACTED = '«redacted»';

/**
 * Header names always stripped, lowercased for case-insensitive comparison.
 */
export const DEFAULT_HEADER_BLOCKLIST: string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
  'www-authenticate',
];

/**
 * Keys (JSON/form) whose values are considered sensitive by default.
 */
export const DEFAULT_KEY_PATTERN: RegExp =
  /token|secret|password|passwd|api[-_]?key|session|auth|credential|bearer/i;

/**
 * Compile a set of extra regex source strings into predicates. Invalid patterns
 * are skipped rather than throwing, keeping the module robust to bad user input.
 */
function compilePatterns(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src, 'i'));
    } catch {
      /* ignore malformed user-supplied pattern */
    }
  }
  return out;
}

/** Decode a URL/form component for matching, tolerating malformed encodings. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/**
 * Build a predicate that matches a body key against the default key pattern plus
 * any custom `bodyKeyPatterns` from the rules.
 */
export function buildKeyMatcher(rules: RedactionRules): (key: string) => boolean {
  const extra = compilePatterns(rules.bodyKeyPatterns);
  return (key: string): boolean =>
    DEFAULT_KEY_PATTERN.test(key) || extra.some((re) => re.test(key));
}

/** Build a predicate for URL query-param names (default pattern + urlParamPatterns). */
function buildUrlMatcher(rules: RedactionRules): (name: string) => boolean {
  const extra = compilePatterns(rules.urlParamPatterns);
  return (name: string): boolean =>
    DEFAULT_KEY_PATTERN.test(name) || extra.some((re) => re.test(name));
}

/**
 * Header-name segments that mark a credential. Matched against whole segments
 * (the name split on `-`, `_` and camelCase boundaries), never substrings, so
 * `:authority`, `author`, `monkey` and `x-idempotency-key` are left alone. This
 * is deliberately separate from DEFAULT_KEY_PATTERN, which is a substring regex
 * tuned for JSON/form keys.
 */
const SECRET_HEADER_SEGMENTS: ReadonlySet<string> = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwd',
  'credential', 'credentials', 'bearer', 'jwt', 'apikey',
  'session', 'auth', 'authorization', 'authentication',
]);

/** Segments that make a following `key` segment a credential (`x-goog-api-key`). */
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  'api', 'secret', 'private', 'access', 'subscription', 'app',
]);

/** A segment made only of digits, as in `x-hub-signature-256`. */
const NUMBER = /^\d+$/;

/**
 * Split a header name into lowercase segments on `-`, `_` and camelCase
 * boundaries. The camelCase split must run BEFORE lowercasing, which would
 * erase the boundaries: `xApiKey` -> x, api, key; `APIKey` -> api, key.
 */
function headerSegments(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean);
}

/**
 * True when a header NAME looks like it carries a credential
 * (`X-CSRF-Token`, `X-Amz-Security-Token`, `X-Goog-Api-Key`, `authToken`, ...).
 * Case-insensitive. Pseudo-headers (`:authority`) and `access-control-*` CORS
 * headers are never secret-bearing.
 *
 * `signature` counts only as the last segment of the name, optionally followed
 * by a number (`x-amz-signature`, `x-hub-signature-256`). Names that merely
 * describe a signature (`signature-input`, `signature-version-info`) stay readable.
 */
export function isSecretHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(':') || lower.startsWith('access-control-')) return false;
  const segments = headerSegments(name);
  return segments.some(
    (seg, i) =>
      SECRET_HEADER_SEGMENTS.has(seg) ||
      (seg === 'key' && i > 0 && KEY_QUALIFIERS.has(segments[i - 1]!)) ||
      (seg === 'signature' && segments.slice(i + 1).every((x) => NUMBER.test(x))),
  );
}

/** Headers whose value is a URL, or a list of URLs, that can carry a query string. */
const URL_HEADER_NAMES: ReadonlySet<string> = new Set([
  'referer', 'location', 'content-location', 'link', 'refresh', ':path',
]);

/** Those headers, plus any name with a whole `url` or `uri` segment (`x-original-url`). */
function isUrlHeaderName(name: string): boolean {
  if (URL_HEADER_NAMES.has(name.toLowerCase())) return true;
  return headerSegments(name).some((seg) => seg === 'url' || seg === 'uri');
}

/**
 * Mask secret query values inside a URL-bearing header's value with the same
 * rules as the request URL (`redactUrl`). `Link` holds `<url>; rel=...` entries
 * and `Refresh` holds `seconds; url=...`, so those two are parsed first.
 */
function redactUrlHeaderValue(
  name: string,
  value: string,
  rules: RedactionRules,
): string {
  const lower = name.toLowerCase();
  if (lower === 'link') {
    return value.replace(
      /<([^>]*)>/g,
      (_m, url: string) => `<${redactUrl(url, rules)}>`,
    );
  }
  if (lower === 'refresh') {
    return value.replace(
      /(url\s*=\s*['"]?)([^'"]*)/i,
      (_m, lead: string, url: string) => `${lead}${redactUrl(url, rules)}`,
    );
  }
  return redactUrl(value, rules);
}

/**
 * Return a new header array with secret-bearing header values masked: the
 * default blocklist, custom names from the rules, and any name that
 * `isSecretHeaderName` recognises. Values of URL-bearing headers (`Referer`,
 * `Location`, `:path`, ...) keep their shape but have secret query values masked.
 * Comparison is case-insensitive on the header name. Input is never mutated.
 */
export function redactHeaders(
  headers: NetHeader[],
  rules: RedactionRules,
): NetHeader[] {
  const blocked = new Set<string>([
    ...DEFAULT_HEADER_BLOCKLIST,
    ...rules.headerNames.map((n) => n.toLowerCase()),
  ]);
  return headers.map((h) => {
    if (blocked.has(h.name.toLowerCase()) || isSecretHeaderName(h.name)) {
      return { name: h.name, value: REDACTED };
    }
    const value = isUrlHeaderName(h.name)
      ? redactUrlHeaderValue(h.name, h.value, rules)
      : h.value;
    return { name: h.name, value };
  });
}

/** Recursively clone a parsed JSON value, masking values under matching keys. */
function redactJsonValue(
  value: unknown,
  matcher: (key: string) => boolean,
): { value: unknown; redacted: boolean } {
  if (Array.isArray(value)) {
    let redacted = false;
    const arr = value.map((item) => {
      const r = redactJsonValue(item, matcher);
      if (r.redacted) redacted = true;
      return r.value;
    });
    return { value: arr, redacted };
  }
  if (value !== null && typeof value === 'object') {
    let redacted = false;
    const obj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (matcher(key)) {
        obj[key] = REDACTED;
        redacted = true;
      } else {
        const r = redactJsonValue(val, matcher);
        if (r.redacted) redacted = true;
        obj[key] = r.value;
      }
    }
    return { value: obj, redacted };
  }
  return { value, redacted: false };
}

/** True if `text` plausibly looks like a `k=v&k=v` form-urlencoded body. */
function looksLikeForm(text: string): boolean {
  if (text.length === 0) return false;
  return /^[^=&#\s]+=[^&#\s]*(?:&[^=&#\s]+=[^&#\s]*)*$/.test(text);
}

/** The `)]}'` anti-hijacking prefix some servers put before a JSON reply. */
const XSSI_PREFIX = /^\s*\)\]\}',?\s*/;

/** True if `text` plausibly looks like a JSON object or array. */
function looksLikeJson(text: string): boolean {
  const t = text.replace(XSSI_PREFIX, '').trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

/**
 * Redact JSON that doesn't parse as a whole: a reply behind the `)]}'` prefix,
 * or newline-delimited JSON (one value per line). The prefix is kept, and lines
 * that still don't parse are left as they are.
 */
function redactLooseJson(
  text: string,
  matcher: (key: string) => boolean,
): { text: string; redacted: boolean } {
  const prefix = XSSI_PREFIX.exec(text)?.[0] ?? '';
  const rest = text.slice(prefix.length);
  const chunks = prefix && isJson(rest) ? [rest] : rest.split('\n');
  let redacted = false;
  const out = chunks.map((chunk) => {
    if (!isJson(chunk)) return chunk;
    const r = redactJsonValue(JSON.parse(chunk), matcher);
    if (!r.redacted) return chunk;
    redacted = true;
    return chunks.length === 1 ? JSON.stringify(r.value, null, 2) : JSON.stringify(r.value);
  });
  return redacted ? { text: prefix + out.join('\n'), redacted: true } : { text, redacted: false };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Redact matching keys' values in a form-urlencoded body, preserving structure. */
function redactForm(
  text: string,
  matcher: (key: string) => boolean,
): { text: string; redacted: boolean } {
  let redacted = false;
  const parts = text.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return part;
    const rawKey = part.slice(0, eq);
    if (matcher(safeDecode(rawKey))) {
      redacted = true;
      return `${rawKey}=${REDACTED}`;
    }
    return part;
  });
  return redacted ? { text: parts.join('&'), redacted: true } : { text, redacted: false };
}

/**
 * Redact secret-looking values inside a body.
 * - JSON (mime includes `json`, or the text looks like JSON): parse, recursively
 *   mask values under matching keys, re-stringify pretty (2-space).
 * - form-urlencoded (mime includes `x-www-form-urlencoded`, or `k=v&k=v` shape):
 *   mask matching keys' values in place.
 * - JSON that doesn't parse whole: strip a `)]}'` prefix or go line by line.
 * - anything else: return the text unchanged.
 * Never throws. `redacted` is true iff a replacement actually happened.
 */
export function redactBody(
  text: string,
  mime: string | undefined,
  rules: RedactionRules,
): { text: string; redacted: boolean } {
  const matcher = buildKeyMatcher(rules);
  const m = (mime ?? '').toLowerCase();

  const isJsonMime = m.includes('json');
  const isFormMime = m.includes('x-www-form-urlencoded');

  if (isFormMime || (!isJsonMime && !looksLikeJson(text) && looksLikeForm(text))) {
    return redactForm(text, matcher);
  }

  if (isJsonMime || looksLikeJson(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return redactLooseJson(text, matcher);
    }
    const r = redactJsonValue(parsed, matcher);
    if (!r.redacted) return { text, redacted: false };
    return { text: JSON.stringify(r.value, null, 2), redacted: true };
  }

  return { text, redacted: false };
}

/**
 * Redact matching query-param VALUES in a URL while preserving the rest of its
 * structure (scheme/host/path/hash/param order/encoding). Works on absolute and
 * relative URLs; a URL without a query string is returned unchanged.
 */
export function redactUrl(url: string, rules: RedactionRules): string {
  const matcher = buildUrlMatcher(rules);

  const hashIdx = url.indexOf('#');
  const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
  const base = hashIdx === -1 ? url : url.slice(0, hashIdx);

  const qIdx = base.indexOf('?');
  if (qIdx === -1) return url;

  const head = base.slice(0, qIdx);
  const query = base.slice(qIdx + 1);
  if (query.length === 0) return url;

  let changed = false;
  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return part; // flag param, no value to redact
    const rawKey = part.slice(0, eq);
    if (matcher(safeDecode(rawKey))) {
      changed = true;
      return `${rawKey}=${REDACTED}`;
    }
    return part;
  });

  return changed ? `${head}?${parts.join('&')}${hash}` : url;
}

/** Apply the same URL rules to web/socket URLs embedded in browser diagnostics. */
export function redactUrlsInText(text: string, rules: RedactionRules): string {
  const redactText = (value: string) =>
    value.replace(/\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi, (url) => redactUrl(url, rules));

  return text.split('\n').map((line) => {
    // V8's text stack frames append coordinates outside the URL. Only split
    // that suffix in a stack frame: colons and parentheses elsewhere can be
    // part of a sensitive query value and must be redacted with that value.
    const frame = /^([ \t]*at (?:[^\r\n]* \()?)(https?:\/\/[^\r\n]+)(:\d+:\d+\)?)(\r?)$/.exec(line);
    if (!frame) return redactText(line);
    return `${redactText(frame[1]!)}${redactUrl(frame[2]!, rules)}${frame[3]}${frame[4]}`;
  }).join('\n');
}
