/**
 * Pure redaction primitives for captured network traffic, URLs, console logs, and reports.
 *
 * Strips sensitive request/response headers, scrubs values under secret-looking keys
 * in JSON and form-urlencoded bodies, masks recognized value-based credentials
 * (JWTs, GitHub tokens, Stripe keys, private keys, AWS access keys), sanitizes
 * sensitive URL paths, and redacts console messages and exceptions.
 * Defaults ALWAYS apply; the per-session master switch (`settings.redactionEnabled`)
 * is handled by the caller — this module is a side-effect-free transform that
 * never touches chrome/DOM/network and never mutates its inputs.
 */

import type { NetHeader, RedactionRules, Session, SessionEvent } from '@/lib/session/types';

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
 * High-confidence structured secret value patterns recognized across payloads,
 * URLs, console logs, and stack traces.
 * Note: AKIA/ASIA identifies an AWS access key ID; we treat credential identifiers
 * as sensitive while distinguishing them from arbitrary text.
 */
export const VALUE_SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN [A-Z0-9_ -]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9_ -]*PRIVATE KEY-----/g,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    name: 'stripe-key',
    pattern: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{24,99}\b/g,
  },
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
];

/**
 * URL path segments known to precede authentication, reset, or invitation tokens.
 */
const SENSITIVE_PATH_SEGMENTS = new Set([
  'magic-link',
  'reset-password',
  'password-reset',
  'verify-email',
  'auth-token',
  'invite',
  'invitation',
  'callback',
  'auth-callback',
]);

/** Standard route action verbs or public endpoints that should never be masked. */
const NON_TOKEN_ROUTE_TERMS = new Set([
  'new',
  'edit',
  'confirm',
  'cancel',
  'request',
  'resend',
  'success',
  'error',
  'view',
  'accept',
  'decline',
  'verify',
  // Common OAuth identity providers in callback routes (e.g. /auth/callback/google)
  'google',
  'github',
  'gitlab',
  'apple',
  'slack',
  'okta',
  'microsoft',
  'auth0',
]);

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
 * Scan arbitrary text and replace high-confidence secret values with REDACTED.
 * Returns the sanitized string and the count of secrets replaced.
 * Never throws; returns original text if no patterns match.
 */
export function redactTextValues(text: string): { text: string; count: number } {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, count: 0 };
  }
  let out = text;
  let count = 0;
  for (const { pattern } of VALUE_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      count += 1;
      return REDACTED;
    });
  }
  return { text: out, count };
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

/** Recursively clone a parsed JSON value, masking values under matching keys or value secrets. */
function redactJsonValue(
  value: unknown,
  matcher: (key: string) => boolean,
): { value: unknown; redacted: boolean; count: number } {
  if (typeof value === 'string') {
    const v = redactTextValues(value);
    if (v.count > 0) {
      return { value: v.text, redacted: true, count: v.count };
    }
    return { value, redacted: false, count: 0 };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    let count = 0;
    const arr = value.map((item) => {
      if (typeof item === 'string') {
        const v = redactTextValues(item);
        if (v.count > 0) {
          redacted = true;
          count += v.count;
          return v.text;
        }
        return item;
      }
      const r = redactJsonValue(item, matcher);
      if (r.redacted) {
        redacted = true;
        count += r.count;
      }
      return r.value;
    });
    return { value: arr, redacted, count };
  }
  if (value !== null && typeof value === 'object') {
    let redacted = false;
    let count = 0;
    const obj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (matcher(key)) {
        obj[key] = REDACTED;
        redacted = true;
        count += 1;
      } else if (typeof val === 'string') {
        const v = redactTextValues(val);
        if (v.count > 0) {
          obj[key] = v.text;
          redacted = true;
          count += v.count;
        } else {
          obj[key] = val;
        }
      } else {
        const r = redactJsonValue(val, matcher);
        if (r.redacted) {
          redacted = true;
          count += r.count;
        }
        obj[key] = r.value;
      }
    }
    return { value: obj, redacted, count };
  }
  return { value, redacted: false, count: 0 };
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
): { text: string; redacted: boolean; count: number } {
  let redacted = false;
  let count = 0;
  const parts = text.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return part;
    const rawKey = part.slice(0, eq);
    const rawVal = part.slice(eq + 1);
    if (matcher(safeDecode(rawKey))) {
      redacted = true;
      count += 1;
      return `${rawKey}=${REDACTED}`;
    }
    const decodedVal = safeDecode(rawVal);
    const v = redactTextValues(decodedVal);
    if (v.count > 0) {
      redacted = true;
      count += v.count;
      return `${rawKey}=${REDACTED}`;
    }
    return part;
  });
  return redacted ? { text: parts.join('&'), redacted: true, count } : { text, redacted: false, count: 0 };
}

/**
 * Redact secret-looking values inside a body.
 * - JSON (mime includes `json`, or the text looks like JSON): parse, recursively
 *   mask values under matching keys and value secrets, re-stringify pretty (2-space).
 * - form-urlencoded (mime includes `x-www-form-urlencoded`, or `k=v&k=v` shape):
 *   mask matching keys' values in place.
 * - textual / plain bodies: scan and mask recognizable value-based secrets.
 * - unparseable JSON: return the text unchanged.
 * Never throws. `redacted` is true iff a replacement actually happened.
 */
export function redactBody(
  text: string,
  mime: string | undefined,
  rules: RedactionRules,
): { text: string; redacted: boolean; count?: number } {
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
    return { text: JSON.stringify(r.value, null, 2), redacted: true, count: r.count };
  }

  // Textual bodies: check for recognizable structured secrets (PEM keys, JWTs, etc.)
  const v = redactTextValues(text);
  if (v.count > 0) {
    return { text: v.text, redacted: true, count: v.count };
  }

  return { text, redacted: false };
}

/**
 * Redact path segments in a URL that contain recognizable tokens or follow
 * known sensitive auth routes. Avoids over-broad masking of ordinary resource IDs.
 */
function redactPathSegments(pathname: string): { pathname: string; changed: boolean } {
  if (!pathname || pathname.length <= 1) return { pathname, changed: false };
  const segments = pathname.split('/');
  let changed = false;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const decoded = safeDecode(seg);

    // 1. Direct value secret pattern match (JWT, GitHub token, Stripe key, AWS key)
    const v = redactTextValues(decoded);
    if (v.count > 0) {
      segments[i] = REDACTED;
      changed = true;
      continue;
    }

    // 2. Sensitive route follower check (e.g. /magic-link/<token>, /auth/callback/<token>, /invite/<token>)
    const prev = (segments[i - 1] ?? '').toLowerCase();
    const prev2 = (segments[i - 2] ?? '').toLowerCase();
    const isSensitiveRoute =
      SENSITIVE_PATH_SEGMENTS.has(prev) ||
      (prev === 'callback' && prev2 === 'auth');

    if (isSensitiveRoute) {
      // Don't redact pure numeric IDs (e.g. /invite/123 or /reset-password/42)
      if (/^\d+$/.test(decoded)) continue;
      // Don't redact standard non-token route terms (e.g. /auth/callback/google, /invite/confirm)
      if (NON_TOKEN_ROUTE_TERMS.has(decoded.toLowerCase())) continue;
      // Don't redact human-readable hyphenated slugs with words (e.g. /invite/team-lead-invitation)
      if (/^[a-z]+(-[a-z]+)+$/i.test(decoded)) continue;

      // Redact high-entropy tokens: UUIDs, hex strings >= 16 chars, base64url >= 16 chars
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded);
      const isHighEntropyToken =
        decoded.length >= 16 && /^[0-9a-zA-Z_-]+$/.test(decoded) && !decoded.includes('.');
      if (isUuid || isHighEntropyToken) {
        segments[i] = REDACTED;
        changed = true;
      }
    }
  }

  return changed ? { pathname: segments.join('/'), changed: true } : { pathname, changed: false };
}

/**
 * Redact matching query-param VALUES and sensitive path tokens in a URL while
 * preserving the rest of its structure (scheme/host/path/hash/param order/encoding).
 * Works on absolute and relative URLs.
 */
export function redactUrl(url: string, rules: RedactionRules): string {
  const matcher = buildUrlMatcher(rules);

  const hashIdx = url.indexOf('#');
  const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
  const base = hashIdx === -1 ? url : url.slice(0, hashIdx);

  const qIdx = base.indexOf('?');
  const head = qIdx === -1 ? base : base.slice(0, qIdx);
  const query = qIdx === -1 ? '' : base.slice(qIdx + 1);

  // Sanitize path segments in head
  const schemeMatch = head.match(/^([a-zA-Z]+:\/\/[^/]+)(\/.*)?$/);
  const origin = schemeMatch ? schemeMatch[1] : '';
  const pathname = schemeMatch ? (schemeMatch[2] ?? '') : head;

  const pathResult = redactPathSegments(pathname);
  const cleanHead = origin ? `${origin}${pathResult.pathname}` : pathResult.pathname;
  let changed = pathResult.changed;

  if (query.length === 0) {
    return changed ? `${cleanHead}${hash}` : url;
  }

  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return part; // flag param, no value to redact
    const rawKey = part.slice(0, eq);
    const rawVal = part.slice(eq + 1);
    if (matcher(safeDecode(rawKey))) {
      changed = true;
      return `${rawKey}=${REDACTED}`;
    }
    const valResult = redactTextValues(safeDecode(rawVal));
    if (valResult.count > 0) {
      changed = true;
      return `${rawKey}=${REDACTED}`;
    }
    return part;
  });

  return changed ? `${cleanHead}?${parts.join('&')}${hash}` : url;
}

/**
 * Pure privacy audit summarizing redaction activity across captured evidence streams.
 */
export interface PrivacyAudit {
  enabled: boolean;
  affectedEvents: number;
  byStream: {
    networkRequests: number;
    consoleLogs: number;
    exceptions: number;
    navigationUrls: number;
    formInputs: number;
  };
}

/**
 * Compute an aggregate privacy audit from a session and its events.
 * Reports exact unique events affected across each evidence stream.
 * Deterministic and side-effect free.
 */
export function auditSessionRedactions(
  session: Session,
  events: readonly SessionEvent[],
): PrivacyAudit {
  const enabled = session.settings?.redactionEnabled !== false;
  const byStream = {
    networkRequests: 0,
    consoleLogs: 0,
    exceptions: 0,
    navigationUrls: 0,
    formInputs: 0,
  };

  for (const event of events) {
    switch (event.type) {
      case 'net-request': {
        const p = event.payload;
        const hasRedactedUrl = Boolean(p.url && p.url.includes(REDACTED));
        const hasRedactedHeader =
          (p.requestHeaders ?? []).some((h) => h.value === REDACTED) ||
          (p.responseHeaders ?? []).some((h) => h.value === REDACTED);
        const hasRedactedBody = Boolean(
          (p.requestBody?.text && p.requestBody.text.includes(REDACTED)) ||
          (p.responseBody?.text && p.responseBody.text.includes(REDACTED)),
        );
        if (hasRedactedUrl || hasRedactedHeader || hasRedactedBody) {
          byStream.networkRequests += 1;
        }
        break;
      }
      case 'nav':
      case 'spa-route': {
        const p = event.payload;
        if (p.url && p.url.includes(REDACTED)) {
          byStream.navigationUrls += 1;
        }
        break;
      }
      case 'console': {
        const p = event.payload;
        const inText = Boolean(p.text && p.text.includes(REDACTED));
        const inArgs = (p.args ?? []).some((a) => a.includes(REDACTED));
        const inSource = Boolean(p.source && p.source.includes(REDACTED));
        if (inText || inArgs || inSource) {
          byStream.consoleLogs += 1;
        }
        break;
      }
      case 'error': {
        const p = event.payload;
        const inMsg = Boolean(p.message && p.message.includes(REDACTED));
        const inStack = Boolean(p.stack && p.stack.includes(REDACTED));
        if (inMsg || inStack) {
          byStream.exceptions += 1;
        }
        break;
      }
      case 'input': {
        const p = event.payload;
        if (p.redacted || p.value === REDACTED) {
          byStream.formInputs += 1;
        }
        break;
      }
    }
  }

  const affectedEvents =
    byStream.networkRequests +
    byStream.consoleLogs +
    byStream.exceptions +
    byStream.navigationUrls +
    byStream.formInputs;

  return { enabled, affectedEvents, byStream };
}

