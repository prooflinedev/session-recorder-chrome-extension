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
 * Candidate JWT/JWE: three or more dot-separated base64url segments whose
 * first segment starts with `e` (every base64url-encoded JSON object does,
 * because `{` encodes to `e`). Candidates are confirmed by decoding.
 */
const JWT_CANDIDATE_PATTERN = /(?<![A-Za-z0-9_-])e[A-Za-z0-9_-]+={0,2}(?:\.[A-Za-z0-9_-]*={0,2}){2,}/g;

/** Decode one base64url segment and parse it as a JSON object, or null. */
function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const b64 = segment.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json: unknown = JSON.parse(atob(padded));
    return json !== null && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * True if the token is a JWS or JWE (RFC 7515/7516/7519): the header decodes
 * to a JSON object with a string `alg`. A JWE (header has `enc`, five
 * segments) is accepted on its header alone, since its payload is encrypted.
 * A JWS also needs a payload that decodes to a JSON object, empty `{}`
 * (`e30`) included. The signature may be empty (`alg: none`). The candidate
 * pattern guarantees at least three segments.
 */
function isJwt(token: string): boolean {
  const segments = token.split('.');
  const header = decodeJsonSegment(segments[0] ?? '');
  if (!header || typeof header.alg !== 'string') return false;
  // Extra trailing segments are tolerated, e.g. a sentence-ending `.`.
  if (typeof header.enc === 'string') return segments.length >= 5;
  return decodeJsonSegment(segments[1] ?? '') !== null;
}

/** True if the value contains a JWT or JWE anywhere, e.g. after `Bearer `. */
function containsJwt(value: string): boolean {
  for (const match of value.matchAll(JWT_CANDIDATE_PATTERN)) {
    if (isJwt(match[0])) return true;
  }
  return false;
}

/** A whole value that is 13–19 digits, optionally grouped by spaces or dashes. */
const CARD_VALUE_PATTERN = /^\d(?:[ -]?\d){12,18}$/;

/** Luhn checksum, the check digit every payment card number carries. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * True if a string value is itself a secret, whatever key it sits under:
 * it contains a JWT or JWE, or it is a payment card number (13–19 digits
 * that pass the Luhn check). Key-based matching misses these when the key is
 * generic, e.g. `{"data": "eyJ…"}` or `{"number": "4111 1111 1111 1111"}`.
 */
export function isSecretValue(value: string): boolean {
  if (containsJwt(value)) return true;
  const trimmed = value.trim();
  if (!CARD_VALUE_PATTERN.test(trimmed)) return false;
  return passesLuhn(trimmed.replace(/[ -]/g, ''));
}

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
  if (typeof value === 'string' && isSecretValue(value)) {
    return { value: REDACTED, redacted: true };
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
    if (matcher(safeDecode(rawKey)) || isSecretValue(safeDecode(part.slice(eq + 1)))) {
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
    if (matcher(safeDecode(rawKey)) || isSecretValue(safeDecode(part.slice(eq + 1)))) {
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
