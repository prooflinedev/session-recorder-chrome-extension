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
 * ONE shared definition of sensitive names, used for URL params, form-body keys
 * and JSON keys. Anchoring matters: adding `code`, `sig` or `state` to the
 * unanchored DEFAULT_KEY_PATTERN would match benign names such as `postalCode`,
 * `design` and `statement`. DEFAULT_KEY_PATTERN itself is deliberately left
 * unchanged (including its accepted `token_type` false positive).
 */
const SENSITIVE_EXACT_NAMES: RegExp =
  /^(?:code|state|nonce|assertion|ticket|sig|code_verifier|code_challenge|client_assertion|samlresponse|saml_response)$/i;
const SENSITIVE_COMPOUND_NAMES: RegExp =
  /^(?:[a-z0-9]+[._])?(?:access[._]?code|openid[._]?nonce|saml[._]?assertion|client[._]?assertion|saml[._]?response)$/i;

/** Non-blocklisted headers whose values are URLs or contain URLs. */
const URL_VALUED_HEADERS = new Set(['location', 'referer', 'content-location']);

/** Payload keys whose string values are URLs — scanned on every event type. */
const URL_CARRIER_KEYS = new Set([
  'url',
  'toUrl',
  'urlHint',
  'next',
  'redirect',
  'href',
  'location',
]);

/**
 * Free-text keys whose values may embed URLs. `value`/`note`/`contextText` are
 * page- or user-controlled fields on input, file, screenshot and video payloads;
 * `title`/`toTitle` come from document.title on tab events; `args` is an array
 * of strings handled by the array branch of `redactValue`.
 */
const TEXT_URL_KEYS = new Set([
  'text',
  'args',
  'source',
  'stack',
  'message',
  'value',
  'note',
  'contextText',
  'title',
  'toTitle',
]);

/** Maximum depth for nested encoded URL/form values and payload objects. */
const MAX_NESTING = 3;

/** Bounded work allowance for one top-level URL/header/text transform. */
const CARRIER_DEPTH_CAP = MAX_NESTING;
const CARRIER_ENCODED_BYTE_CAP = 4096;
const CARRIER_DECODED_BYTE_CAP = 4096;
const CARRIER_OP_CAP = 65536;

/** Encoded form of the marker, used when a nested value cannot be inspected. */
const ENCODED_REDACTED = encodeURIComponent(REDACTED);

type NameMatcher = (name: string) => boolean;

/**
 * Internal scratch budget for one transform. Created fresh at public entry
 * points and threaded by reference through every recursive URL operation, so
 * nested carriers and fragments share the same limits. It is never exposed to
 * callers and never stored in caller-owned objects (the module stays pure).
 */
interface RedactionBudget {
  carrierDepth: number;
  ops: number;
}

function freshBudget(): RedactionBudget {
  return { carrierDepth: 0, ops: CARRIER_OP_CAP };
}

function spend(budget: RedactionBudget, units: number): boolean {
  if (budget.ops < units) return false;
  budget.ops -= units;
  return true;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Assign an own property explicitly so `__proto__` from parsed JSON survives. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Mask only the value of a `k=v` part, preserving its key and structure. */
function maskValue(part: string): string {
  const eq = part.indexOf('=');
  return eq === -1 ? part : `${part.slice(0, eq)}=${REDACTED}`;
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
 * Build a predicate that matches a body key (form or JSON) against the shared
 * sensitive-name sets, the default key pattern and custom `bodyKeyPatterns`.
 */
export function buildKeyMatcher(rules: RedactionRules): (key: string) => boolean {
  const extra = compilePatterns(rules.bodyKeyPatterns);
  return (key: string): boolean =>
    SENSITIVE_EXACT_NAMES.test(key) ||
    SENSITIVE_COMPOUND_NAMES.test(key) ||
    DEFAULT_KEY_PATTERN.test(key) ||
    extra.some((re) => re.test(key));
}

/** Build a predicate for URL param names using the same sensitive-name sets. */
function buildUrlMatcher(rules: RedactionRules): (name: string) => boolean {
  const extra = compilePatterns(rules.urlParamPatterns);
  return (name: string): boolean =>
    SENSITIVE_EXACT_NAMES.test(name) ||
    SENSITIVE_COMPOUND_NAMES.test(name) ||
    DEFAULT_KEY_PATTERN.test(name) ||
    extra.some((re) => re.test(name));
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
        setOwn(obj, key, REDACTED);
        redacted = true;
      } else {
        const r = redactJsonValue(val, matcher);
        if (r.redacted) redacted = true;
        setOwn(obj, key, r.value);
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
 * Mask `user:password@` (and credential-only `token@`) inside the authority
 * segment only. Never uses `new URL()`: relative URLs and escaping stay intact.
 */
function redactAuthority(url: string): string {
  let start = -1;
  if (url.startsWith('//')) start = 2;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    start = url.indexOf('://') + 3;
  }
  if (start === -1) return url;

  let end = url.length;
  for (let i = start; i < url.length; i++) {
    const c = url[i];
    if (c === '/' || c === '?' || c === '#') {
      end = i;
      break;
    }
  }
  const authority = url.slice(start, end);
  const at = authority.lastIndexOf('@');
  if (at === -1) return url;
  return url.slice(0, start) + `${REDACTED}@` + url.slice(start + at + 1);
}

/**
 * If a param value decodes to a URL or a form body, redact its sensitive parts
 * and re-encode. Re-encoding keeps the carrier inside its original param, so
 * HAR's `searchParams` decode cannot expose a new top-level secret.
 */
/**
 * Inspect one encoded nested carrier with the SHARED budget. Size limits are
 * checked before decoding and again after decoding; any value that cannot be
 * inspected is masked (fail closed) rather than returned as apparently clean.
 * Structure is split by string slicing only — no `new URL()`.
 */
function redactNestedCarrier(
  raw: string,
  matcher: NameMatcher,
  budget: RedactionBudget,
): string {
  if (raw === REDACTED || raw === ENCODED_REDACTED) return raw;
  if (budget.carrierDepth >= CARRIER_DEPTH_CAP || budget.ops <= 0) return ENCODED_REDACTED;
  if (raw.length > CARRIER_ENCODED_BYTE_CAP) return ENCODED_REDACTED;
  if (utf8Bytes(raw) > CARRIER_ENCODED_BYTE_CAP) return ENCODED_REDACTED;
  if (!spend(budget, 2)) return ENCODED_REDACTED;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return ENCODED_REDACTED; // malformed encoding cannot be inspected safely
  }
  if (decoded === REDACTED) return raw; // already redacted — keep fixed point
  if (utf8Bytes(decoded) > CARRIER_DECODED_BYTE_CAP) return ENCODED_REDACTED;
  if (!spend(budget, Math.max(1, Math.ceil(utf8Bytes(decoded) / 128)))) {
    return ENCODED_REDACTED;
  }

  // Split the literal fragment, then classify the head ONCE. A scheme-less
  // `path?query` carrier is handled even when no `#` was split off.
  const hashIdx = decoded.indexOf('#');
  const head = hashIdx === -1 ? decoded : decoded.slice(0, hashIdx);
  const tail = hashIdx === -1 ? '' : decoded.slice(hashIdx + 1);
  const isUrl =
    /^(?:https?|wss?):\/\//i.test(head) || head.startsWith('//') || head.startsWith('/');
  const hasQuery = head.includes('?');
  const headIsForm = looksLikeForm(head) || (head.includes('&') && head.includes('='));

  let redacted: string | undefined;
  budget.carrierDepth += 1;
  try {
    if (isUrl && hasQuery) {
      // Absolute/relative URL with a real query — the URL scrubber handles
      // both query and fragment with the same budget.
      redacted = redactUrlWithBudget(decoded, matcher, budget);
    } else {
      // Recognized nested URLs get authority/userinfo masking even without a
      // query — the outer URL scrubber only sees the encoded form otherwise.
      let newHead = isUrl ? redactAuthority(head) : head;
      if (isUrl && headIsForm) {
        // Path-form carrier such as `/cb&token=S#frag`.
        newHead = redactForm(newHead, matcher).text;
      } else if (hasQuery) {
        // Scheme-less relative carrier: `foo=bar?x=1#token=S`.
        const qIdx = head.indexOf('?');
        const prefix = redactPrefix(head.slice(0, qIdx), matcher, budget) + '?';
        const query = head.slice(qIdx + 1);
        const parts = query.split('&').map((p) => {
          if (!spend(budget, 1)) return maskValue(p);
          return redactParamPart(p, matcher, budget);
        });
        newHead = prefix + parts.join('&');
      } else if (headIsForm) {
        newHead = redactForm(newHead, matcher).text;
      }
      const newTail = tail ? `#${redactFragment(tail, matcher, budget)}` : '';
      redacted = newHead + newTail;
    }
  } finally {
    budget.carrierDepth -= 1;
  }

  if (redacted === undefined || redacted === decoded) return raw;
  try {
    return encodeURIComponent(redacted);
  } catch {
    // Lone UTF-16 surrogates cannot be encoded; fail closed on this value.
    return ENCODED_REDACTED;
  }
}

function redactParamPart(part: string, matcher: NameMatcher, budget: RedactionBudget): string {
  const eq = part.indexOf('=');
  if (eq === -1) return part; // flag param, no value to redact
  const rawKey = part.slice(0, eq);
  const rawVal = part.slice(eq + 1);
  // Sensitive names are always masked, even when the budget is exhausted.
  if (matcher(safeDecode(rawKey))) return `${rawKey}=${REDACTED}`;
  if (rawKey.length > CARRIER_ENCODED_BYTE_CAP || !spend(budget, 2)) {
    return `${rawKey}=${REDACTED}`; // smallest uninspectable value
  }
  const nested = redactNestedCarrier(rawVal, matcher, budget);
  return nested === rawVal ? part : `${rawKey}=${nested}`;
}

/** Scrub `k=v` pairs before the first `?`; plain router paths are untouched. */
function redactPrefix(prefix: string, matcher: NameMatcher, budget: RedactionBudget): string {
  if (!prefix) return prefix;
  return prefix
    .split('&')
    .map((part) => {
      if (!part.includes('=')) return part;
      if (!spend(budget, 1)) return maskValue(part);
      return redactParamPart(part, matcher, budget);
    })
    .join('&');
}

/**
 * Redact a fragment body without `new URL()`: directive keys are preserved,
 * every other `&`/`#`-separated value goes through `redactParamPart` with the
 * shared budget. Values past the budget are masked, never returned raw.
 */
function redactFragment(frag: string, matcher: NameMatcher, budget: RedactionBudget): string {
  // Split on fragment separators FIRST so a genuine scroll-to-text directive
  // is exempted before any `?` query parsing can rewrite its text value.
  const parts = frag.split(/([&#])/).map((part) => {
    if (part === '&' || part === '#') return part;
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    // Only genuine scroll-to-text directives are exempt, not a bare `text` key.
    if (key === ':~:text') return part;
    if (!spend(budget, 1)) return maskValue(part);
    const qIdx = part.indexOf('?');
    if (qIdx === -1) return redactParamPart(part, matcher, budget);
    const prefix = redactPrefix(part.slice(0, qIdx), matcher, budget) + '?';
    const query = part.slice(qIdx + 1);
    const params = query.split('&').map((p) => {
      if (!spend(budget, 1)) return maskValue(p);
      return redactParamPart(p, matcher, budget);
    });
    return prefix + params.join('&');
  });
  return parts.join('');
}

/**
 * Internal URL scrub. `matcher` and `budget` are created once by the public
 * wrapper or a fan-out helper and threaded through EVERY recursive call, so
 * nested carriers/fragments cannot reset depth or operation limits.
 */
function redactUrlWithBudget(url: string, matcher: NameMatcher, budget: RedactionBudget): string {
  const withAuthority = redactAuthority(url);

  const hashIdx = withAuthority.indexOf('#');
  const base = hashIdx === -1 ? withAuthority : withAuthority.slice(0, hashIdx);
  const hash = hashIdx === -1 ? '' : withAuthority.slice(hashIdx);

  let newBase = base;
  const qIdx = base.indexOf('?');
  if (qIdx !== -1) {
    const head = base.slice(0, qIdx);
    const query = base.slice(qIdx + 1);
    const parts = query.split('&').map((p) => {
      if (!spend(budget, 1)) return maskValue(p);
      return redactParamPart(p, matcher, budget);
    });
    newBase = `${head}?${parts.join('&')}`;
  }

  const newHash = hash.length > 1 ? `#${redactFragment(hash.slice(1), matcher, budget)}` : hash;

  const out = newBase + newHash;
  return out === url ? url : out;
}

/** Public API unchanged: one fresh budget per top-level URL value. */
export function redactUrl(url: string, rules: RedactionRules): string {
  return redactUrlWithBudget(url, buildUrlMatcher(rules), freshBudget());
}

/** URL-valued headers: scrub every `<url>` in a Link header with a shared budget. */
function redactLinkHeader(value: string, matcher: NameMatcher, budget: RedactionBudget): string {
  return value.replace(
    /<([^>]*)>/g,
    (_m, u: string) => `<${redactUrlWithBudget(u, matcher, budget)}>`,
  );
}

/** URL-valued headers: scrub the `url=` value in a Refresh header with a shared budget. */
function redactRefreshHeader(value: string, matcher: NameMatcher, budget: RedactionBudget): string {
  return value.replace(
    /(url\s*=\s*)("([^"]*)"|'([^']*)'|[^;\s]+)/i,
    (_m, prefix: string, raw: string) => {
      const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : '';
      const quoted = quote !== '' && raw.endsWith(quote) && raw.length >= 2;
      const inner = quoted ? raw.slice(1, -1) : raw;
      const scrubbed = redactUrlWithBudget(inner, matcher, budget);
      return `${prefix}${quoted ? `${quote}${scrubbed}${quote}` : scrubbed}`;
    },
  );
}

/**
 * Return a new header array with blocklisted (and custom) header values masked
 * in full. Non-blocklisted URL-valued headers additionally have their URL
 * structure scrubbed; a blocklisted name always wins with full-value masking.
 * All URL-valued headers in one call share a single matcher and budget.
 */
export function redactHeaders(
  headers: NetHeader[],
  rules: RedactionRules,
): NetHeader[] {
  const blocked = new Set<string>([
    ...DEFAULT_HEADER_BLOCKLIST,
    ...rules.headerNames.map((n) => n.toLowerCase()),
  ]);
  const hasUrlValues = headers.some(
    (h) => !blocked.has(h.name.toLowerCase()) &&
      (URL_VALUED_HEADERS.has(h.name.toLowerCase()) ||
        h.name.toLowerCase() === 'link' ||
        h.name.toLowerCase() === 'refresh'),
  );
  const matcher = hasUrlValues ? buildUrlMatcher(rules) : null;
  const budget = hasUrlValues ? freshBudget() : null;
  return headers.map((h) => {
    const name = h.name.toLowerCase();
    if (blocked.has(name)) return { name: h.name, value: REDACTED };
    if (matcher && budget && URL_VALUED_HEADERS.has(name)) {
      return { name: h.name, value: redactUrlWithBudget(h.value, matcher, budget) };
    }
    if (matcher && budget && name === 'link') {
      return { name: h.name, value: redactLinkHeader(h.value, matcher, budget) };
    }
    if (matcher && budget && name === 'refresh') {
      return { name: h.name, value: redactRefreshHeader(h.value, matcher, budget) };
    }
    return { name: h.name, value: h.value };
  });
}

/** Apply the same URL rules to web/socket URLs embedded in browser diagnostics. */
export function redactUrlsInText(text: string, rules: RedactionRules): string {
  // One matcher/budget for every URL found in this text, so many URLs cannot
  // each get a fresh operation allowance.
  const matcher = buildUrlMatcher(rules);
  const budget = freshBudget();
  const redactText = (value: string) =>
    value.replace(/\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi, (url) =>
      redactUrlWithBudget(url, matcher, budget),
    );

  return text.split('\n').map((line) => {
    // V8's text stack frames append coordinates outside the URL. Only split
    // that suffix in a stack frame: colons and parentheses elsewhere can be
    // part of a sensitive query value and must be redacted with that value.
    const frame = /^([ \t]*at (?:[^\r\n]* \()?)(https?:\/\/[^\r\n]+)(:\d+:\d+\)?)(\r?)$/.exec(line);
    if (!frame) return redactText(line);
    return `${redactText(frame[1]!)}${redactUrlWithBudget(frame[2]!, matcher, budget)}${frame[3]}${frame[4]}`;
  }).join('\n');
}

/** Collect string values that the key-based walk changed, without touching other tokens. */
function collectStringChanges(
  before: unknown,
  after: unknown,
  changes: Map<string, string>,
): void {
  if (typeof before === 'string' && typeof after === 'string') {
    if (before !== after) changes.set(before, after);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      collectStringChanges(before[i], after[i], changes);
    }
    return;
  }
  if (before !== null && after !== null &&
      typeof before === 'object' && typeof after === 'object') {
    for (const key of Object.keys(before as Record<string, unknown>)) {
      collectStringChanges(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        changes,
      );
    }
  }
}

/** Rewrite only changed JSON string tokens; numbers and escapes stay byte-identical. */
function rewriteChangedJsonStrings(
  text: string,
  changes: Map<string, string>,
  rules: RedactionRules,
): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      out += text[i++];
      continue;
    }
    let j = i + 1;
    let escaped = false;
    while (j < text.length) {
      const c = text[j]!;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        j++;
        break;
      }
      j++;
    }
    const token = text.slice(i, j);
    let lookahead = j;
    while (lookahead < text.length && /\s/.test(text[lookahead]!)) lookahead++;
    const isPropertyKey = text[lookahead] === ':';
    try {
      const value = JSON.parse(token);
      if (isPropertyKey || typeof value !== 'string') {
        out += token;
      } else {
        const replaced = changes.get(value) ?? redactUrlsInText(value, rules);
        out += replaced === value ? token : JSON.stringify(replaced);
      }
    } catch {
      out += token;
    }
    i = j;
  }
  return out;
}

/** Scan free text for absolute URLs without V8 stack-frame coordinate handling. */
export function redactUrlsInTitle(text: string, rules: RedactionRules): string {
  const matcher = buildUrlMatcher(rules);
  const budget = freshBudget();
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi, (url) =>
    redactUrlWithBudget(url, matcher, budget),
  );
}

/**
 * Redact a WebSocket text frame. Valid JSON is rewritten at the string-token
 * level so unrelated numbers and escapes survive exactly; only text that is
 * not JSON gets the free-text absolute-URL scan.
 */
export function redactWsText(text: string, rules: RedactionRules): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      const keyed = redactJsonValue(parsed, buildKeyMatcher(rules)).value;
      const after = redactValue(keyed, rules, 0, true);
      const changes = new Map<string, string>();
      collectStringChanges(parsed, after, changes);
      return rewriteChangedJsonStrings(text, changes, rules);
    }
  } catch {
    /* not JSON — fall through to text URL scanning */
  }
  return redactUrlsInText(text, rules);
}

/**
 * Pure recursive walk over an event payload; carrier keys are masked down to
 * MAX_NESTING levels (deeper objects are returned unchanged).
 */
function redactValue(
  value: unknown,
  rules: RedactionRules,
  depth: number,
  scanAllStrings = false,
): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_NESTING) return value;
  // Strings get a flat URL scrub (no recursion, so no extra depth); everything
  // else recurses under the same MAX_NESTING guard at the top of this function.
  if (Array.isArray(value)) {
    return value.map((v) =>
      typeof v === 'string'
        ? redactUrlsInText(v, rules)
        : redactValue(v, rules, depth + 1, scanAllStrings),
    );
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string') {
      if (URL_CARRIER_KEYS.has(key)) setOwn(out, key, redactUrl(val, rules));
      else if (TEXT_URL_KEYS.has(key) || scanAllStrings) {
        setOwn(out, key, redactUrlsInText(val, rules));
      } else setOwn(out, key, val);
    } else if (key === 'wsFrames' && Array.isArray(val)) {
      setOwn(out, key, val.map((f) => {
        if (f !== null && typeof f === 'object' && typeof (f as { text?: unknown }).text === 'string') {
          const frame = f as { text: string };
          return { ...frame, text: redactWsText(frame.text, rules) };
        }
        return redactValue(f, rules, depth + 1, scanAllStrings);
      }));
    } else if ((key === 'requestHeaders' || key === 'responseHeaders') && Array.isArray(val)) {
      setOwn(out, key, redactHeaders(val as NetHeader[], rules));
    } else {
      setOwn(out, key, redactValue(val, rules, depth + 1, scanAllStrings));
    }
  }
  return out;
}

/**
 * Pure funnel transform. The caller must assign the result to `raw.payload`
 * before scoring, persistence and broadcast; otherwise this is a no-op.
 */
export function redactEventPayload(
  _type: string,
  payload: unknown,
  rules: RedactionRules,
): unknown {
  return redactValue(payload, rules, 0);
}

type SessionLike = {
  initialUrl?: string;
  name?: string;
  tabs?: { url?: string; title?: string }[];
};

/**
 * Apply URL redaction to session metadata at its write sites. Accepts either a
 * Session-like object (returns a new object) or a single URL string. Titles are
 * free text, so they go through `redactUrlsInText` rather than `redactUrl`.
 */
export function redactSessionUrls(url: string, rules: RedactionRules): string;
export function redactSessionUrls<T extends SessionLike>(session: T, rules: RedactionRules): T;
export function redactSessionUrls(input: unknown, rules: RedactionRules): unknown {
  if (typeof input === 'string') return redactUrl(input, rules);
  if (input === null || typeof input !== 'object') return input;

  const source = input as { initialUrl?: unknown; name?: unknown; tabs?: unknown };
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  if (typeof source.initialUrl === 'string') {
    out.initialUrl = redactUrl(source.initialUrl, rules);
  }
  // Defence in depth: callers scrub the name already, but any other writer of
  // session metadata gets the same protection from this helper.
  if (typeof source.name === 'string') {
    out.name = redactUrlsInTitle(source.name, rules);
  }
  if (Array.isArray(source.tabs)) {
    out.tabs = source.tabs.map((tab) => {
      if (tab === null || typeof tab !== 'object') return tab;
      const t = tab as { url?: unknown; title?: unknown };
      if (typeof t.url !== 'string' && typeof t.title !== 'string') return tab;
      const next: Record<string, unknown> = { ...t };
      if (typeof t.url === 'string') next.url = redactUrl(t.url, rules);
      if (typeof t.title === 'string') next.title = redactUrlsInTitle(t.title, rules);
      return next;
    });
  }
  return out;
}
