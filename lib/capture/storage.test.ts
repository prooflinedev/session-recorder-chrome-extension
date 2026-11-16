// @vitest-environment jsdom
/**
 * Storage snapshots: the in-page reader, value redaction, caps and keyed hashing.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { REDACTED } from './redaction';
import {
  STORAGE_MAX_ENTRIES_PER_AREA,
  STORAGE_TOO_LARGE,
  STORAGE_VALUE_CAP,
  buildStorageSnapshot,
  createStorageHasher,
  isRawPageStorage,
  newStorageHashSecret,
  parseStorageHashSecret,
  readPageStorage,
  redactStorageValue,
} from './storage';
import type { RawPageStorage, RawStorageItem, StorageHasher } from './storage';
import { makeDefaultSettings } from '@/lib/session/settings';

const settings = makeDefaultSettings();
const off = { ...settings, redactionEnabled: false };
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const SECRET = new Uint8Array(32).fill(7);

let hash: StorageHasher;
beforeAll(async () => {
  hash = await createStorageHasher(SECRET, 'ses_test');
});

/** A raw item as the page would send it (the digest only needs to differ per value). */
const item = (key: string, value: string, length = value.length, digest = `d:${value}`): RawStorageItem => [
  key,
  value,
  length,
  digest,
];

const raw = (over: Partial<RawPageStorage> = {}): RawPageStorage => ({
  origin: 'https://app.example.com',
  path: '/',
  localStorage: { total: 0, items: [] },
  sessionStorage: { total: 0, items: [] },
  cookies: { total: 0, items: [] },
  ...over,
});

const area = (...items: RawStorageItem[]) => ({ total: items.length, items });

describe('readPageStorage', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = 'theme=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('reads both storage areas, script-readable cookies and the page path', () => {
    localStorage.setItem('flags', '{"newCheckout":true}');
    sessionStorage.setItem('draft', 'hello');
    document.cookie = 'theme=dark';
    const out = readPageStorage(100);
    expect(out.origin).toBe(location.origin);
    expect(out.path).toBe(location.pathname);
    expect(out.localStorage.total).toBe(1);
    expect(out.localStorage.items[0]).toEqual([
      'flags',
      '{"newCheckout":true}',
      20,
      expect.stringMatching(/^[0-9a-f]{16}$/),
    ]);
    expect(out.sessionStorage.items.map((i) => i.slice(0, 2))).toEqual([['draft', 'hello']]);
    expect(out.cookies.items.map((i) => i.slice(0, 2))).toContainEqual(['theme', 'dark']);
    expect(isRawPageStorage(out)).toBe(true);
  });

  it('clips very large values but describes the full value', () => {
    const big = 'x'.repeat(100 * 1024);
    localStorage.setItem('big', big);
    const [[, value, length, first]] = readPageStorage(100).localStorage.items as [RawStorageItem];
    expect(value.length).toBe(64 * 1024);
    expect(length).toBe(big.length);
    // A change past the clip still changes the digest.
    localStorage.setItem('big', `${big.slice(0, -1)}y`);
    const [[, , , second]] = readPageStorage(100).localStorage.items as [RawStorageItem];
    expect(second).not.toBe(first);
  });

  it('sorts every key before capping, so the kept window is stable', () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k${String(i).padStart(2, '0')}`);
    for (const k of [...keys].reverse()) localStorage.setItem(k, 'v');
    const out = readPageStorage(10);
    expect(out.localStorage.total).toBe(30);
    expect(out.localStorage.items.map(([k]) => k)).toEqual(keys.slice(0, 10));
  });
});

describe('isRawPageStorage', () => {
  it('rejects malformed results from the scripting channel', () => {
    expect(isRawPageStorage(null)).toBe(false);
    expect(isRawPageStorage({ origin: 'x' })).toBe(false);
    expect(isRawPageStorage({ ...raw(), path: undefined })).toBe(false);
    expect(isRawPageStorage({ ...raw(), cookies: [['a', '1']] })).toBe(false);
    expect(isRawPageStorage({ ...raw(), cookies: { total: 1, items: [['a', '1', '1', 'd']] } })).toBe(false);
    expect(isRawPageStorage(raw({ cookies: area(item('a', '1')) }))).toBe(true);
  });
});

describe('redactStorageValue', () => {
  it('masks the whole value under a secret-looking key', () => {
    expect(redactStorageValue('sb-abc-auth-token', '{"a":1}', settings)).toEqual({
      value: REDACTED,
      redacted: true,
    });
    expect(redactStorageValue('sessionid', 'abc', settings).value).toBe(REDACTED);
  });

  it('scrubs secret keys inside JSON values and keeps it on one line', () => {
    const r = redactStorageValue(
      'user',
      JSON.stringify({ name: 'Ada', accessToken: 'tok_123', prefs: { lang: 'en' } }),
      settings,
    );
    expect(r.redacted).toBe(true);
    expect(r.value).toBe(`{"name":"Ada","accessToken":"${REDACTED}","prefs":{"lang":"en"}}`);
  });

  it('scrubs JSON stored as a string inside JSON (redux-persist)', () => {
    const persisted = JSON.stringify({
      user: JSON.stringify({ name: 'Ada', apiKey: 'sk_live_x' }),
      _persist: JSON.stringify({ version: -1 }),
    });
    const r = redactStorageValue('persist:root', persisted, settings);
    expect(r.redacted).toBe(true);
    expect(r.value).not.toContain('sk_live_x');
    expect(JSON.parse(JSON.parse(r.value).user)).toEqual({ name: 'Ada', apiKey: REDACTED });
    expect(JSON.parse(r.value)._persist).toBe('{"version":-1}');
  });

  it('scrubs a JSON string literal that holds JSON', () => {
    const r = redactStorageValue('state', JSON.stringify(JSON.stringify({ token: 'abc' })), settings);
    expect(r.value).not.toContain('abc');
    expect(JSON.parse(JSON.parse(r.value))).toEqual({ token: REDACTED });
  });

  it('masks URL parameters in URL strings inside JSON', () => {
    const r = redactStorageValue('nav', JSON.stringify({ back: 'https://x.test/cb?token=abc' }), settings);
    expect(r.value).toBe(`{"back":"https://x.test/cb?token=${REDACTED}"}`);
  });

  it('masks JWTs under keys the name rules miss', () => {
    const r = redactStorageValue('profile', JSON.stringify({ jwt: JWT, id: 7 }), settings);
    expect(r.redacted).toBe(true);
    expect(r.value).not.toContain('eyJ');
    expect(r.value).toContain('"id":7');
  });

  it('masks JWTs that follow a word character, as in URL-encoded values', () => {
    for (const value of [`cb%3Fid_token%3D${JWT}`, `Bearer%20${JWT}`, `x${JWT}`]) {
      const r = redactStorageValue('redirect', value, settings);
      expect(r.redacted).toBe(true);
      expect(r.value).not.toContain('eyJ');
    }
  });

  it('scrubs percent-encoded URLs and JSON, as cookies often hold them', () => {
    const url = redactStorageValue(
      'redirect',
      encodeURIComponent('https://app/cb?access_token=opaque123&x=1'),
      settings,
    );
    expect(url).toEqual({ value: `https://app/cb?access_token=${REDACTED}&x=1`, redacted: true });
    const json = redactStorageValue('prefs', encodeURIComponent('{"secret":"s1","a":1}'), settings);
    expect(json).toEqual({ value: `{"secret":"${REDACTED}","a":1}`, redacted: true });
  });

  it('masks secret query parameters in URL values', () => {
    const r = redactStorageValue('returnTo', 'https://x.test/cb?code=1&token=abc', settings);
    expect(r.value).toBe(`https://x.test/cb?code=1&token=${REDACTED}`);
  });

  it('honors custom body-key rules', () => {
    const custom = {
      ...settings,
      customRedaction: { ...settings.customRedaction, bodyKeyPatterns: ['^email$'] },
    };
    expect(redactStorageValue('email', 'ada@example.com', custom).value).toBe(REDACTED);
  });

  it('leaves ordinary values alone', () => {
    expect(redactStorageValue('theme', 'dark', settings)).toEqual({ value: 'dark', redacted: false });
    expect(redactStorageValue('cart', '[1,2,3]', settings)).toEqual({ value: '[1,2,3]', redacted: false });
    expect(redactStorageValue('q', 'a%20b', settings)).toEqual({ value: 'a%20b', redacted: false });
  });

  it('changes nothing when redaction is off', () => {
    expect(redactStorageValue('authToken', JWT, off)).toEqual({ value: JWT, redacted: false });
  });
});

describe('buildStorageSnapshot', () => {
  it('sorts by area then key, and never stores an unredacted secret', async () => {
    const p = await buildStorageSnapshot(
      raw({
        path: '/app',
        localStorage: area(item('zeta', '1'), item('apiKey', 'sk-live-secret'), item('alpha', '2')),
        sessionStorage: area(item('step', '3')),
        cookies: area(item('ab_variant', 'B')),
      }),
      'start',
      settings,
      hash,
    );
    expect(p.phase).toBe('start');
    expect(p.path).toBe('/app');
    expect(p.entries.map((e) => `${e.area}:${e.key}`)).toEqual([
      'localStorage:alpha',
      'localStorage:apiKey',
      'localStorage:zeta',
      'sessionStorage:step',
      'cookie:ab_variant',
    ]);
    const key = p.entries.find((e) => e.key === 'apiKey')!;
    expect(key).toMatchObject({ value: REDACTED, redacted: true, size: REDACTED.length });
    expect(key.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(p)).not.toContain('sk-live-secret');
    expect(p.omitted).toBeUndefined();
  });

  it('withholds a value clipped in the page, since cut JSON cannot be scrubbed', async () => {
    const full = 100 * 1024;
    const clipped = `{"apiKey":"sk_live_abc","items":[${'1,'.repeat(40_000)}`.slice(0, 64 * 1024);
    const p = await buildStorageSnapshot(
      raw({ localStorage: area(item('appState', clipped, full)) }),
      'start',
      settings,
      hash,
    );
    expect(p.entries[0]).toMatchObject({ value: STORAGE_TOO_LARGE, redacted: true, size: full });
    expect(JSON.stringify(p)).not.toContain('sk_live_abc');
  });

  it('keeps the clipped prefix when redaction is off, with the full size', async () => {
    const p = await buildStorageSnapshot(
      raw({ localStorage: area(item('blob', 'a'.repeat(64 * 1024), 200_000)) }),
      'start',
      off,
      hash,
    );
    expect(p.entries[0]).toMatchObject({ truncated: true, size: 200_000 });
    expect(p.entries[0]!.value).toHaveLength(STORAGE_VALUE_CAP);
  });

  it('hashes the original value, so a rotated secret shows as changed', async () => {
    const before = await buildStorageSnapshot(
      raw({ localStorage: area(item('authToken', 'tok_1')) }),
      'start',
      settings,
      hash,
    );
    const after = await buildStorageSnapshot(
      raw({ localStorage: area(item('authToken', 'tok_2')) }),
      'stop',
      settings,
      hash,
    );
    expect(before.entries[0]!.value).toBe(after.entries[0]!.value);
    expect(before.entries[0]!.hash).not.toBe(after.entries[0]!.hash);
  });

  it('truncates long values for display', async () => {
    const long = 'a'.repeat(STORAGE_VALUE_CAP + 50);
    const [entry] = (
      await buildStorageSnapshot(raw({ localStorage: area(item('blob', long)) }), 'stop', settings, hash)
    ).entries;
    expect(entry!.value!.length).toBe(STORAGE_VALUE_CAP);
    expect(entry).toMatchObject({ truncated: true, size: long.length });
  });

  it('caps each area and counts what it left out per area', async () => {
    const many = Array.from({ length: STORAGE_MAX_ENTRIES_PER_AREA }, (_, i) =>
      item(`k${String(i).padStart(3, '0')}`, 'v'),
    );
    const p = await buildStorageSnapshot(
      raw({
        localStorage: { total: STORAGE_MAX_ENTRIES_PER_AREA + 7, items: many },
        cookies: area(item('c', '1')),
      }),
      'start',
      settings,
      hash,
    );
    expect(p.entries.filter((e) => e.area === 'localStorage')).toHaveLength(STORAGE_MAX_ENTRIES_PER_AREA);
    expect(p.entries.filter((e) => e.area === 'cookie')).toHaveLength(1);
    expect(p.omitted).toEqual({ localStorage: 7 });
  });

  it('does not mutate its input', async () => {
    const input = raw({ localStorage: area(item('b', '1'), item('a', '2')) });
    const copy = structuredClone(input);
    await buildStorageSnapshot(input, 'start', settings, hash);
    expect(input).toEqual(copy);
  });
});

describe('keyed storage hashes', () => {
  it('depend on the secret and the session, not only on the value', async () => {
    const other = await createStorageHasher(new Uint8Array(32).fill(8), 'ses_test');
    const later = await createStorageHasher(SECRET, 'ses_other');
    const h = await hash('localStorage\nemail\n15\nabc');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(await hash('localStorage\nemail\n15\nabc')).toBe(h);
    expect(await other('localStorage\nemail\n15\nabc')).not.toBe(h);
    expect(await later('localStorage\nemail\n15\nabc')).not.toBe(h);
  });

  it('round-trips a stored secret and rejects malformed ones', () => {
    const stored = newStorageHashSecret();
    expect(parseStorageHashSecret(stored)).toHaveLength(32);
    expect(parseStorageHashSecret(undefined)).toBeUndefined();
    expect(parseStorageHashSecret('abc')).toBeUndefined();
    expect(parseStorageHashSecret('zz'.repeat(32))).toBeUndefined();
  });
});
