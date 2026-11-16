/**
 * Browser storage snapshots (localStorage, sessionStorage, script-readable
 * cookies) for the recorded page.
 *
 * Many "works on my machine" bugs depend on persisted client state: a feature
 * flag, a cached profile, a half-finished draft. The recorder reads that state
 * once when recording starts and once when it stops, so a report shows the
 * state the bug ran in and what the session changed.
 *
 * Three parts:
 * - `readPageStorage` runs INSIDE the page via `chrome.scripting.executeScript`.
 *   It must stay self-contained (no imports, no outer references) because Chrome
 *   serializes the function source. It sorts every key, reads the first keys of
 *   each area, and clips each value so one huge value cannot stall the message
 *   channel. The full length and a digest of the full value travel with it, so
 *   change detection never depends on the clip.
 * - `createStorageHasher` turns that digest into a keyed hash (HMAC-SHA-256
 *   with a per-install secret that never leaves the browser). A stored or
 *   exported hash therefore cannot be checked against guessed values, which is
 *   what lets it cover the original value, secrets included.
 * - `buildStorageSnapshot` sorts, caps, redacts and hashes the raw read into the
 *   event payload. Redaction happens here, before `recordEvent`, so raw secrets
 *   never reach IndexedDB (same rule as network capture).
 *
 * HttpOnly cookies are invisible to `document.cookie` and are never read; they
 * usually hold the session credential, which is the one value a report must
 * not carry.
 */

import {
  REDACTED,
  buildKeyMatcher,
  redactBody,
  redactUrl,
} from '@/lib/capture/redaction';
import type {
  CaptureSettings,
  RedactionRules,
  StorageArea,
  StorageEntry,
  StorageSnapshotPayload,
} from '@/lib/session/types';

/** Entries kept per storage area; the rest are counted in `omitted`. */
export const STORAGE_MAX_ENTRIES_PER_AREA = 100;
/** Characters of each (redacted) value kept in the payload. */
export const STORAGE_VALUE_CAP = 500;
/**
 * Shown instead of a value that was clipped in the page. A cut value no longer
 * parses, so the secrets inside it cannot be found reliably.
 */
export const STORAGE_TOO_LARGE = '«too large to redact»';

/** `[key, value clipped for the channel, full length, digest of the full value]`. */
export type RawStorageItem = [key: string, value: string, length: number, digest: string];

export interface RawStorageArea {
  /** Keys the area held, before the cap. */
  total: number;
  /** The first keys in sort order. */
  items: RawStorageItem[];
}

/** What `readPageStorage` returns from the page. */
export interface RawPageStorage {
  origin: string;
  path: string;
  localStorage: RawStorageArea;
  sessionStorage: RawStorageArea;
  cookies: RawStorageArea;
}

/**
 * Read the page's storage. Injected into the recorded tab's top frame; must not
 * reference anything outside its own body. Never throws: an area that cannot be
 * read (sandboxed iframe, disabled storage) comes back empty.
 *
 * Every key name is read and sorted before `maxEntries` are kept, so start and
 * stop keep the same window of keys and the comparison knows where it ends.
 */
export function readPageStorage(maxEntries: number): RawPageStorage {
  // Values are clipped before they cross the channel; the length and digest
  // always describe the full value.
  const MAX_VALUE = 64 * 1024;
  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  // 64-bit non-cryptographic digest (two 32-bit lanes). Only a change detector:
  // the background turns it into a keyed hash and never stores it.
  const digest = (s: string): string => {
    let h1 = 0xdeadbeef ^ s.length;
    let h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  };
  const item = (key: string, value: string): RawStorageItem => [
    key,
    value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value,
    value.length,
    digest(value),
  ];
  const readArea = (get: () => Storage): RawStorageArea => {
    try {
      const store = get();
      const keys: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) keys.push(key);
      }
      keys.sort(byKey);
      return {
        total: keys.length,
        items: keys.slice(0, maxEntries).map((k) => item(k, store.getItem(k) ?? '')),
      };
    } catch {
      return { total: 0, items: [] }; // storage blocked for this document
    }
  };
  let cookies: RawStorageArea = { total: 0, items: [] };
  try {
    const pairs: [string, string][] = [];
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      pairs.push(eq === -1 ? [trimmed, ''] : [trimmed.slice(0, eq), trimmed.slice(eq + 1)]);
    }
    // Stable sort: same-name cookies keep their document.cookie order.
    pairs.sort((a, b) => byKey(a[0], b[0]));
    cookies = {
      total: pairs.length,
      items: pairs.slice(0, maxEntries).map((p) => item(p[0], p[1])),
    };
  } catch {
    /* cookies blocked for this document */
  }
  return {
    origin: location.origin,
    path: location.pathname,
    localStorage: readArea(() => window.localStorage),
    sessionStorage: readArea(() => window.sessionStorage),
    cookies,
  };
}

/** Shape check for the value that comes back across the scripting channel. */
export function isRawPageStorage(x: unknown): x is RawPageStorage {
  if (x === null || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  const isItem = (p: unknown): boolean =>
    Array.isArray(p) &&
    p.length === 4 &&
    typeof p[0] === 'string' &&
    typeof p[1] === 'string' &&
    typeof p[2] === 'number' &&
    typeof p[3] === 'string';
  const isArea = (v: unknown): boolean => {
    if (v === null || typeof v !== 'object') return false;
    const a = v as Record<string, unknown>;
    return typeof a.total === 'number' && Array.isArray(a.items) && a.items.every(isItem);
  };
  return (
    typeof r.origin === 'string' &&
    typeof r.path === 'string' &&
    isArea(r.localStorage) &&
    isArea(r.sessionStorage) &&
    isArea(r.cookies)
  );
}

// ----------------------------------------------------------------------------
// Redaction
// ----------------------------------------------------------------------------

/**
 * JWT-shaped tokens (header.payload.signature, base64url). Masked wherever they
 * appear in a value, because apps often keep them under keys such as `jwt` or
 * `user` that the key-name rules do not match. No leading word boundary: a JWT
 * often follows a word character, as in `id_token%3DeyJ…` or `Bearer%20eyJ…`.
 */
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** Levels of JSON-inside-a-string and percent-encoding that redaction unwraps. */
const MAX_NESTING = 4;

type KeyMatcher = (key: string) => boolean;
type Scrubbed = { text: string; redacted: boolean };

/**
 * Redact one storage value. The key-name rules mask the whole value; otherwise
 * JSON and form values are scrubbed by their inner keys, URL values by their
 * parameters, and JWT-shaped tokens anywhere in the text. JSON stored as a
 * string inside JSON (redux-persist and similar) and percent-encoded values
 * are unwrapped and scrubbed the same way.
 */
export function redactStorageValue(
  key: string,
  value: string,
  settings: Pick<CaptureSettings, 'redactionEnabled' | 'customRedaction'>,
): { value: string; redacted: boolean } {
  if (!settings.redactionEnabled) return { value, redacted: false };
  const rules = settings.customRedaction;
  return redactWith(key, value, rules, buildKeyMatcher(rules));
}

function redactWith(
  key: string,
  value: string,
  rules: RedactionRules,
  matchKey: KeyMatcher,
): { value: string; redacted: boolean } {
  if (matchKey(key)) return { value: REDACTED, redacted: true };
  const scrubbed = redactText(value, rules, matchKey, 0);
  const masked = scrubbed.text.replace(JWT_RE, REDACTED);
  return { value: masked, redacted: scrubbed.redacted || masked !== scrubbed.text };
}

function redactText(
  text: string,
  rules: RedactionRules,
  matchKey: KeyMatcher,
  depth: number,
): Scrubbed {
  const same = { text, redacted: false };
  if (depth > MAX_NESTING) return same;
  const t = text.trim();

  // JSON, including a JSON string that holds JSON (`"{\"apiKey\":…}"`).
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
    const parsed = parseJson(t);
    if (parsed !== NOT_JSON) {
      const r = redactJson(parsed, rules, matchKey, depth);
      return r.redacted ? { text: JSON.stringify(r.value), redacted: true } : same;
    }
  }
  if (/^(?:https?|wss?):\/\//i.test(t)) {
    const url = redactUrl(text, rules);
    return url === text ? same : { text: url, redacted: true };
  }
  const form = redactBody(text, undefined, rules);
  if (form.redacted) return form;

  // Percent-encoded values (common in cookies). Shown decoded when something
  // inside was masked.
  if (text.includes('%')) {
    const decoded = percentDecode(text);
    if (decoded !== text) {
      const r = redactText(decoded, rules, matchKey, depth + 1);
      if (r.redacted) return r;
    }
  }
  return same;
}

/** Clone a parsed JSON value, masking values under matching keys and scrubbing nested strings. */
function redactJson(
  value: unknown,
  rules: RedactionRules,
  matchKey: KeyMatcher,
  depth: number,
): { value: unknown; redacted: boolean } {
  if (typeof value === 'string') {
    const r = redactText(value, rules, matchKey, depth + 1);
    return r.redacted ? { value: r.text, redacted: true } : { value, redacted: false };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const out = value.map((item) => {
      const r = redactJson(item, rules, matchKey, depth);
      redacted ||= r.redacted;
      return r.value;
    });
    return { value: out, redacted };
  }
  if (value !== null && typeof value === 'object') {
    let redacted = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (matchKey(k)) {
        out[k] = REDACTED;
        redacted = true;
      } else {
        const r = redactJson(v, rules, matchKey, depth);
        redacted ||= r.redacted;
        out[k] = r.value;
      }
    }
    return { value: out, redacted };
  }
  return { value, redacted: false };
}

const NOT_JSON = Symbol('not-json');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// ----------------------------------------------------------------------------
// Keyed hashing
// ----------------------------------------------------------------------------

/** Maps an entry's identity and digest to the hash stored in `StorageEntry.hash`. */
export type StorageHasher = (input: string) => Promise<string>;

/** Bytes in a storage-hash secret. */
const SECRET_BYTES = 32;

/** A new random per-install secret, hex-encoded for chrome.storage. */
export function newStorageHashSecret(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** Decode a stored secret; undefined when it is missing or malformed. */
export function parseStorageHashSecret(stored: unknown): Uint8Array | undefined {
  if (typeof stored !== 'string' || !/^[0-9a-f]+$/.test(stored)) return undefined;
  if (stored.length !== SECRET_BYTES * 2) return undefined;
  const bytes = new Uint8Array(SECRET_BYTES);
  for (let i = 0; i < SECRET_BYTES; i += 1) {
    bytes[i] = parseInt(stored.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * HMAC-SHA-256 keyed by the per-install secret, over the session id and the
 * input, cut to 64 bits. The session id keeps hashes from two sessions
 * unlinkable.
 */
export async function createStorageHasher(
  secret: Uint8Array,
  sessionId: string,
): Promise<StorageHasher> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const enc = new TextEncoder();
  return async (input) => {
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${sessionId}\n${input}`));
    return toHex(new Uint8Array(mac).subarray(0, 8));
  };
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// ----------------------------------------------------------------------------
// Snapshot
// ----------------------------------------------------------------------------

const AREAS: { area: StorageArea; field: 'localStorage' | 'sessionStorage' | 'cookies' }[] = [
  { area: 'localStorage', field: 'localStorage' },
  { area: 'sessionStorage', field: 'sessionStorage' },
  { area: 'cookie', field: 'cookies' },
];

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Turn a raw page read into a `storage-snapshot` payload: sorted by area then
 * key, capped per area, each value redacted, keyed-hashed and truncated. Never
 * mutates `raw`.
 */
export async function buildStorageSnapshot(
  raw: RawPageStorage,
  phase: StorageSnapshotPayload['phase'],
  settings: Pick<CaptureSettings, 'redactionEnabled' | 'customRedaction'>,
  hash: StorageHasher,
): Promise<StorageSnapshotPayload> {
  const rules = settings.customRedaction;
  const matchKey = buildKeyMatcher(rules);
  const entries: StorageEntry[] = [];
  const omitted: Partial<Record<StorageArea, number>> = {};

  for (const { area, field } of AREAS) {
    const { total, items } = raw[field];
    // The page already sorted and capped; repeat both so the payload holds to
    // its contract whatever came back. Stable, so same-name cookies keep order.
    const kept = [...items]
      .sort((a, b) => byKey(a[0], b[0]))
      .slice(0, STORAGE_MAX_ENTRIES_PER_AREA);
    const left = Math.max(total, items.length) - kept.length;
    if (left > 0) omitted[area] = left;

    for (const [key, rawValue, length, digest] of kept) {
      const { value, redacted, size } = settings.redactionEnabled
        ? redactedValue(key, rawValue, length, rules, matchKey)
        : { value: rawValue, redacted: false, size: length };
      const truncated = value.length > STORAGE_VALUE_CAP;
      entries.push({
        area,
        key,
        value: truncated ? value.slice(0, STORAGE_VALUE_CAP) : value,
        size,
        // The hash covers the full original value, so a rotated token or a
        // change past the clip still shows up as a change.
        hash: await hash(`${area}\n${key}\n${length}\n${digest}`),
        ...(truncated ? { truncated: true } : {}),
        ...(redacted ? { redacted: true } : {}),
      });
    }
  }

  return {
    phase,
    origin: raw.origin,
    path: raw.path,
    entries,
    ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
  };
}

/**
 * The value to store with redaction on. A value clipped in the page is
 * withheld: cut JSON no longer parses, so its secrets cannot be found.
 */
function redactedValue(
  key: string,
  rawValue: string,
  length: number,
  rules: RedactionRules,
  matchKey: KeyMatcher,
): { value: string; redacted: boolean; size: number } {
  if (length > rawValue.length && !matchKey(key)) {
    return { value: STORAGE_TOO_LARGE, redacted: true, size: length };
  }
  const r = redactWith(key, rawValue, rules, matchKey);
  return { ...r, size: r.value.length };
}
