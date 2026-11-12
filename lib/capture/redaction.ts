/**
 * Pure redaction primitives for captured network traffic.
 *
 * Strips sensitive request/response headers, recursively scrubs values under
 * secret-looking keys in JSON and form-urlencoded bodies, and masks matching
 * URL query-param and fragment-param values. Defaults ALWAYS apply; the per-session master switch
 * (`settings.redactionEnabled`) is handled by the caller — this module is a
 * side-effect-free transform that never touches chrome/DOM/network and never
 * mutates its inputs.
 */

import type { CaptureSettings, NetHeader, RedactionRules } from '@/lib/session/types';

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
 * Return a new header array with blocklisted (and custom) header values masked.
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
  return headers.map((h) =>
    blocked.has(h.name.toLowerCase())
      ? { name: h.name, value: REDACTED }
      : { name: h.name, value: h.value },
  );
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

/** True if `text` plausibly looks like a JSON object or array. */
function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
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
 * - anything else, or unparseable JSON: return the text unchanged.
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
      return { text, redacted: false };
    }
    const r = redactJsonValue(parsed, matcher);
    if (!r.redacted) return { text, redacted: false };
    return { text: JSON.stringify(r.value, null, 2), redacted: true };
  }

  return { text, redacted: false };
}

/** Mask matching values in a `k=v&k=v` string; `null` when nothing matched. */
function redactParams(
  query: string,
  matcher: (name: string) => boolean,
): string | null {
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
  return changed ? parts.join('&') : null;
}

/**
 * Redact parameters carried in a URL fragment (without its `#`). Two shapes
 * hold credentials in practice:
 * - OAuth implicit / magic-link redirects put params directly in the fragment
 *   (`#access_token=…&expires_in=…`).
 * - Hash routers put a query after the route (`#/reset?token=…`).
 * Plain anchors (`#section`) and routes without a query are left alone.
 */
function redactFragment(
  fragment: string,
  matcher: (name: string) => boolean,
): string | null {
  const qIdx = fragment.indexOf('?');
  if (qIdx !== -1) {
    const params = redactParams(fragment.slice(qIdx + 1), matcher);
    return params === null ? null : `${fragment.slice(0, qIdx + 1)}${params}`;
  }
  if (!/^[^/=&]+=/.test(fragment)) return null;
  return redactParams(fragment, matcher);
}

/**
 * Redact matching parameter VALUES in a URL's query string and fragment while
 * preserving the rest of its structure (scheme/host/path/param order/encoding).
 * Works on absolute and relative URLs; a URL with nothing to redact is returned
 * unchanged.
 */
export function redactUrl(url: string, rules: RedactionRules): string {
  const matcher = buildUrlMatcher(rules);

  const hashIdx = url.indexOf('#');
  const base = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? null : url.slice(hashIdx + 1);

  const qIdx = base.indexOf('?');
  const head = qIdx === -1 ? base : base.slice(0, qIdx);
  const query = qIdx === -1 ? '' : base.slice(qIdx + 1);

  const redactedQuery = query.length > 0 ? redactParams(query, matcher) : null;
  const redactedFragment =
    fragment !== null && fragment.length > 0 ? redactFragment(fragment, matcher) : null;
  if (redactedQuery === null && redactedFragment === null) return url;

  const search = qIdx === -1 ? '' : `?${redactedQuery ?? query}`;
  const hash = fragment === null ? '' : `#${redactedFragment ?? fragment}`;
  return `${head}${search}${hash}`;
}

/**
 * Apply a session's URL rules to a page URL (navigation, SPA route, tab) before
 * it is stored. Honors the per-session master switch, like network capture.
 */
export function redactPageUrl(
  url: string,
  settings: Pick<CaptureSettings, 'redactionEnabled' | 'customRedaction'>,
): string {
  if (!settings.redactionEnabled || !url) return url;
  return redactUrl(url, settings.customRedaction);
}
