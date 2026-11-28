/**
 * Unit tests for the pure redaction primitives.
 */

import { describe, expect, it } from 'vitest';
import type { NetHeader, RedactionRules } from '@/lib/session/types';
import {
  DEFAULT_HEADER_BLOCKLIST,
  DEFAULT_KEY_PATTERN,
  REDACTED,
  buildKeyMatcher,
  isSecretValue,
  redactBody,
  redactHeaders,
  redactUrl,
  redactUrlsInText,
} from './redaction';

const EMPTY_RULES: RedactionRules = {
  headerNames: [],
  bodyKeyPatterns: [],
  urlParamPatterns: [],
};

function rules(over: Partial<RedactionRules>): RedactionRules {
  return { ...EMPTY_RULES, ...over };
}

describe('constants', () => {
  it('exposes the exact redaction marker', () => {
    expect(REDACTED).toBe('«redacted»');
  });

  it('default header blocklist is lowercased and complete', () => {
    expect(DEFAULT_HEADER_BLOCKLIST).toEqual([
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token',
      'proxy-authorization',
      'www-authenticate',
    ]);
    for (const h of DEFAULT_HEADER_BLOCKLIST) {
      expect(h).toBe(h.toLowerCase());
    }
  });

  it('default key pattern matches known sensitive keys and is case-insensitive', () => {
    for (const k of [
      'token',
      'secret',
      'password',
      'passwd',
      'api-key',
      'api_key',
      'apikey',
      'session',
      'auth',
      'credential',
      'bearer',
      'ACCESS_TOKEN',
      'X-Api-Key',
    ]) {
      expect(DEFAULT_KEY_PATTERN.test(k)).toBe(true);
    }
    for (const k of ['username', 'email', 'count', 'color']) {
      expect(DEFAULT_KEY_PATTERN.test(k)).toBe(false);
    }
  });
});

describe('redactUrlsInText', () => {
  it('redacts each URL in diagnostic text using default and custom rules', () => {
    const input = 'Fetch at "https://api.test/data?token=secret&page=2" failed; retry wss://api.test/socket?ticket=private&mode=live';
    expect(redactUrlsInText(input, rules({ urlParamPatterns: ['ticket'] }))).toBe(
      `Fetch at "https://api.test/data?token=${REDACTED}&page=2" failed; retry wss://api.test/socket?ticket=${REDACTED}&mode=live`,
    );
  });

  it('preserves ordinary diagnostics and non-sensitive URL parameters', () => {
    const input = 'Load failed at https://example.test/app.js?page=2#section';
    expect(redactUrlsInText(input, EMPTY_RULES)).toBe(input);
  });

  it('preserves text stack coordinates while redacting the whole query value', () => {
    const input = [
      '    at load (https://api.test/app.js?token=secret):123:456:5:9)',
      '    at https://api.test/app.js?ticket=private:12:34',
      '    at next (https://api.test/app.js?page=2:7:8)\r',
    ].join('\n');
    expect(redactUrlsInText(input, rules({ urlParamPatterns: ['ticket'] }))).toBe([
      `    at load (https://api.test/app.js?token=${REDACTED}:5:9)`,
      `    at https://api.test/app.js?ticket=${REDACTED}:12:34`,
      '    at next (https://api.test/app.js?page=2:7:8)\r',
    ].join('\n'));
  });

  it('does not treat punctuation in an ordinary URL value as a stack location', () => {
    expect(redactUrlsInText(
      'Request failed at https://api.test/app.js?token=secret):123:456',
      EMPTY_RULES,
    )).toBe(`Request failed at https://api.test/app.js?token=${REDACTED}`);
  });
});

describe('buildKeyMatcher', () => {
  it('matches defaults', () => {
    const m = buildKeyMatcher(EMPTY_RULES);
    expect(m('authToken')).toBe(true);
    expect(m('nickname')).toBe(false);
  });

  it('honors custom body key patterns (case-insensitive)', () => {
    const m = buildKeyMatcher(rules({ bodyKeyPatterns: ['ssn', 'pin'] }));
    expect(m('SSN')).toBe(true);
    expect(m('user_pin')).toBe(true);
    expect(m('email')).toBe(false);
  });

  it('ignores malformed custom patterns instead of throwing', () => {
    const m = buildKeyMatcher(rules({ bodyKeyPatterns: ['([', 'ssn'] }));
    expect(m('ssn')).toBe(true);
    expect(m('token')).toBe(true);
  });
});

describe('redactHeaders', () => {
  const headers: NetHeader[] = [
    { name: 'Authorization', value: 'Bearer abc' },
    { name: 'Cookie', value: 'sid=1' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'X-Custom', value: 'keep-me' },
  ];

  it('redacts blocklisted headers case-insensitively, preserves others', () => {
    const out = redactHeaders(headers, EMPTY_RULES);
    expect(out).toEqual([
      { name: 'Authorization', value: REDACTED },
      { name: 'Cookie', value: REDACTED },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Custom', value: 'keep-me' },
    ]);
  });

  it('redacts custom header names (case-insensitive)', () => {
    const out = redactHeaders(headers, rules({ headerNames: ['X-Custom'] }));
    expect(out.find((h) => h.name === 'X-Custom')?.value).toBe(REDACTED);
  });

  it('does not mutate the input array or objects', () => {
    const snapshot = structuredClone(headers);
    redactHeaders(headers, rules({ headerNames: ['x-custom'] }));
    expect(headers).toEqual(snapshot);
  });
});

describe('redactBody — JSON', () => {
  it('redacts top-level matching keys and re-stringifies pretty', () => {
    const input = JSON.stringify({ username: 'joe', password: 'hunter2' });
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ username: 'joe', password: REDACTED });
    // pretty-printed with 2-space indent
    expect(text).toContain('\n  ');
  });

  it('recurses into nested objects and arrays', () => {
    const input = JSON.stringify({
      user: { name: 'joe', apiKey: 'k1' },
      items: [{ token: 't1' }, { token: 't2' }],
      list: [1, 2, 3],
    });
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(JSON.parse(text)).toEqual({
      user: { name: 'joe', apiKey: REDACTED },
      items: [{ token: REDACTED }, { token: REDACTED }],
      list: [1, 2, 3],
    });
  });

  it('redacts an entire array/subtree when the container key itself matches', () => {
    const input = JSON.stringify({ tokens: [{ token: 't1' }], name: 'joe' });
    const { text } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(JSON.parse(text)).toEqual({ tokens: REDACTED, name: 'joe' });
  });

  it('redacts an entire subtree when the key itself matches', () => {
    const input = JSON.stringify({ credentials: { user: 'a', pass: 'b' } });
    const { text } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(JSON.parse(text)).toEqual({ credentials: REDACTED });
  });

  it('applies custom body key patterns', () => {
    const input = JSON.stringify({ ssn: '111', name: 'joe' });
    const { text, redacted } = redactBody(
      input,
      'application/json',
      rules({ bodyKeyPatterns: ['ssn'] }),
    );
    expect(redacted).toBe(true);
    expect(JSON.parse(text)).toEqual({ ssn: REDACTED, name: 'joe' });
  });

  it('detects JSON without a mime type via shape sniffing', () => {
    const input = JSON.stringify({ token: 'abc' });
    const { text, redacted } = redactBody(input, undefined, EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(JSON.parse(text)).toEqual({ token: REDACTED });
  });

  it('reports redacted=false and leaves text unchanged when nothing matches', () => {
    const input = JSON.stringify({ name: 'joe', count: 3 });
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(false);
    expect(text).toBe(input);
  });

  it('returns malformed JSON unchanged without throwing', () => {
    const input = '{ this is not: valid json, password: ';
    expect(() => redactBody(input, 'application/json', EMPTY_RULES)).not.toThrow();
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(false);
    expect(text).toBe(input);
  });

  it("redacts JSON behind a )]}' prefix and keeps the prefix", () => {
    const input = `)]}'\n{"token":"SECRET","ok":1}`;
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(text.startsWith(")]}'\n")).toBe(true);
    expect(text).not.toContain('SECRET');
    expect(JSON.parse(text.slice(5))).toEqual({ token: REDACTED, ok: 1 });
  });

  it('redacts newline-delimited JSON line by line', () => {
    const input = '{"token":"A1","i":1}\n{"i":2}\n{"password":"B2"}\n';
    const { text, redacted } = redactBody(input, 'application/x-ndjson', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(text).not.toMatch(/A1|B2/);
    expect(text.split('\n').filter(Boolean).map((l) => JSON.parse(l))).toEqual([
      { token: REDACTED, i: 1 },
      { i: 2 },
      { password: REDACTED },
    ]);
  });

  it('handles JSON arrays at the top level', () => {
    const input = JSON.stringify([{ secret: 's' }, { ok: 1 }]);
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(JSON.parse(text)).toEqual([{ secret: REDACTED }, { ok: 1 }]);
  });
});

describe('redactBody — form-urlencoded', () => {
  it('redacts matching keys by mime type, preserving order and other params', () => {
    const input = 'username=joe&password=hunter2&remember=1';
    const { text, redacted } = redactBody(
      input,
      'application/x-www-form-urlencoded',
      EMPTY_RULES,
    );
    expect(redacted).toBe(true);
    expect(text).toBe(`username=joe&password=${REDACTED}&remember=1`);
  });

  it('detects form bodies without a mime type via shape sniffing', () => {
    const input = 'access_token=abc&scope=read';
    const { text, redacted } = redactBody(input, undefined, EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(text).toBe(`access_token=${REDACTED}&scope=read`);
  });

  it('matches keys after url-decoding', () => {
    const input = 'api%5Fkey=xyz&q=hi';
    const { text, redacted } = redactBody(
      input,
      'application/x-www-form-urlencoded',
      EMPTY_RULES,
    );
    expect(redacted).toBe(true);
    expect(text).toBe(`api%5Fkey=${REDACTED}&q=hi`);
  });

  it('leaves non-matching form bodies unchanged', () => {
    const input = 'name=joe&city=nyc';
    const { text, redacted } = redactBody(
      input,
      'application/x-www-form-urlencoded',
      EMPTY_RULES,
    );
    expect(redacted).toBe(false);
    expect(text).toBe(input);
  });
});

describe('redactBody — other', () => {
  it('returns plain text unchanged', () => {
    const input = 'just some plain text with a password in it';
    const { text, redacted } = redactBody(input, 'text/plain', EMPTY_RULES);
    expect(redacted).toBe(false);
    expect(text).toBe(input);
  });

  it('handles empty input', () => {
    const { text, redacted } = redactBody('', undefined, EMPTY_RULES);
    expect(redacted).toBe(false);
    expect(text).toBe('');
  });
});

describe('redactUrl', () => {
  it('redacts matching query-param values, keeps structure', () => {
    const out = redactUrl(
      'https://api.example.com/v1/data?token=abc123&page=2',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://api.example.com/v1/data?token=${REDACTED}&page=2`,
    );
  });

  it('preserves the fragment', () => {
    const out = redactUrl('https://x.com/p?auth=z&q=1#section', EMPTY_RULES);
    expect(out).toBe(`https://x.com/p?auth=${REDACTED}&q=1#section`);
  });

  it('applies custom url param patterns', () => {
    const out = redactUrl(
      'https://x.com/p?tracking_id=xyz&q=1',
      rules({ urlParamPatterns: ['tracking_id'] }),
    );
    expect(out).toBe(`https://x.com/p?tracking_id=${REDACTED}&q=1`);
  });

  it('returns URLs without a query string unchanged', () => {
    const url = 'https://x.com/path/to/thing';
    expect(redactUrl(url, EMPTY_RULES)).toBe(url);
  });

  it('returns unchanged when no param matches', () => {
    const url = 'https://x.com/p?page=1&size=20';
    expect(redactUrl(url, EMPTY_RULES)).toBe(url);
  });

  it('works on relative URLs', () => {
    const out = redactUrl('/search?session=deadbeef&q=hi', EMPTY_RULES);
    expect(out).toBe(`/search?session=${REDACTED}&q=hi`);
  });

  it('matches param names after url-decoding', () => {
    const out = redactUrl('https://x.com/p?api%5Fkey=v&z=1', EMPTY_RULES);
    expect(out).toBe(`https://x.com/p?api%5Fkey=${REDACTED}&z=1`);
  });
});

describe('isSecretValue', () => {
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

  it('detects a JWT on its own or inside a longer value', () => {
    expect(isSecretValue(JWT)).toBe(true);
    expect(isSecretValue(`Bearer ${JWT}`)).toBe(true);
  });

  it('detects card numbers that pass the Luhn check, with or without grouping', () => {
    expect(isSecretValue('4111111111111111')).toBe(true);
    expect(isSecretValue('4111 1111 1111 1111')).toBe(true);
    expect(isSecretValue('5500-0000-0000-0004')).toBe(true);
    expect(isSecretValue('378282246310005')).toBe(true);
  });

  it('leaves ordinary values alone', () => {
    expect(isSecretValue('4111111111111112')).toBe(false); // fails Luhn
    expect(isSecretValue('1234567890')).toBe(false); // too short
    expect(isSecretValue('order 4111111111111111 shipped')).toBe(false); // not the whole value
    expect(isSecretValue('2026-11-26')).toBe(false);
    expect(isSecretValue('eyJ-not-a-token')).toBe(false);
    expect(isSecretValue('hello world')).toBe(false);
  });
});

describe('value-based redaction', () => {
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

  it('masks secret values under generic JSON keys, at any depth', () => {
    const body = JSON.stringify({
      data: JWT,
      payment: { number: '4111 1111 1111 1111', holder: 'Jane Doe' },
      items: [{ id: 42, ref: '5500000000000004' }],
    });
    const out = redactBody(body, 'application/json', EMPTY_RULES);
    expect(out.redacted).toBe(true);
    const parsed = JSON.parse(out.text);
    expect(parsed.data).toBe(REDACTED);
    expect(parsed.payment.number).toBe(REDACTED);
    expect(parsed.payment.holder).toBe('Jane Doe');
    expect(parsed.items[0]).toEqual({ id: 42, ref: REDACTED });
  });

  it('does not touch numbers stored as JSON numbers', () => {
    const body = JSON.stringify({ id: 4111111111111111 });
    expect(redactBody(body, 'application/json', EMPTY_RULES).redacted).toBe(false);
  });

  it('masks secret values in form bodies', () => {
    const out = redactBody(
      `cc=4111+1111+1111+1111&name=Jane&t=${JWT}`,
      'application/x-www-form-urlencoded',
      EMPTY_RULES,
    );
    expect(out.text).toBe(`cc=${REDACTED}&name=Jane&t=${REDACTED}`);
  });

  it('masks secret values in URL query params', () => {
    expect(redactUrl(`https://x.com/cb?t=${JWT}&page=2`, EMPTY_RULES)).toBe(
      `https://x.com/cb?t=${REDACTED}&page=2`,
    );
  });
});

describe('isSecretValue JWT edge cases', () => {
  const seg = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  const json = (o: unknown) => seg(JSON.stringify(o));
  const HS256 = { alg: 'HS256', typ: 'JWT' };

  it('detects a valid JWT with an empty JSON payload (`e30`)', () => {
    const token = `${json(HS256)}.${json({})}.c2lnbmF0dXJl`;
    expect(token.split('.')[1]).toBe('e30');
    expect(isSecretValue(token)).toBe(true);
    expect(isSecretValue(`Bearer ${token}`)).toBe(true);
  });

  it('detects an unsigned (`alg: none`) JWT with an empty signature', () => {
    expect(isSecretValue(`${json({ alg: 'none' })}.${json({ sub: '1' })}.`)).toBe(true);
  });

  it('detects JWTs whose header or payload JSON contains whitespace', () => {
    const header = seg('{ "alg": "RS256" }'); // starts with `eyA`, not `eyJ`
    const payload = seg('{\n  "sub": "1"\n}'); // starts with `ewo`
    expect(header.startsWith('eyJ')).toBe(false);
    expect(isSecretValue(`${header}.${payload}.c2ln`)).toBe(true);
  });

  it('detects a JWT with non-ASCII claims and with base64 `=` padding', () => {
    expect(
      isSecretValue(`${json(HS256)}.${json({ name: 'Sarvar Шарипов' })}.c2ln`),
    ).toBe(true);
    const padded = Buffer.from(JSON.stringify({ a: 1 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(padded.endsWith('=')).toBe(true);
    expect(isSecretValue(`${json(HS256)}.${padded}.c2ln`)).toBe(true);
  });

  it('detects an encrypted JWE (five segments, header has `enc`)', () => {
    const header = json({ alg: 'RSA-OAEP', enc: 'A256GCM' });
    expect(isSecretValue(`${header}.a2V5.aXY.Y2lwaGVy.dGFn`)).toBe(true);
  });

  it('detects a JWT at the end of a sentence', () => {
    const token = `${json(HS256)}.${json({})}.c2ln`;
    expect(isSecretValue(`your token is ${token}.`)).toBe(true);
  });

  it('does not flag dotted values that are not JWTs', () => {
    expect(isSecretValue(`${json({})}.${json({})}.c2ln`)).toBe(false); // header has no alg
    expect(isSecretValue(`${json(HS256)}.${seg('[]')}.c2ln`)).toBe(false); // payload not an object
    expect(isSecretValue(`${json({ alg: 'RSA-OAEP', enc: 'A256GCM' })}.a2V5.aXY`)).toBe(
      false,
    ); // JWE too short
    expect(isSecretValue('example.co.uk')).toBe(false);
    expect(isSecretValue('e1.2.3')).toBe(false);
    expect(isSecretValue('eyJ-not-a-token')).toBe(false);
  });
});

describe('isSecretValue card edge cases', () => {
  it('accepts the 13–19 digit range only', () => {
    expect(isSecretValue('4222222222222')).toBe(true); // 13-digit Visa test number
    expect(isSecretValue('6011000990139424')).toBe(true); // 16-digit Discover
    expect(isSecretValue('4111111111111111110')).toBe(true); // 19 digits, Luhn-valid
    expect(isSecretValue('424242424242')).toBe(false); // 12 digits
    expect(isSecretValue('42424242424242424242')).toBe(false); // 20 digits
  });

  it('tolerates surrounding whitespace and mixed separators', () => {
    expect(isSecretValue('  4111 1111-1111 1111  ')).toBe(true);
  });

  it('rejects doubled separators, letters and other punctuation', () => {
    expect(isSecretValue('4111  1111 1111 1111')).toBe(false);
    expect(isSecretValue('4111.1111.1111.1111')).toBe(false);
    expect(isSecretValue('4111 1111 1111 111a')).toBe(false);
  });

  it('accepts card numbers from each major network', () => {
    expect(isSecretValue('2223003122003222')).toBe(true); // Mastercard 2-series
    expect(isSecretValue('5105105105105100')).toBe(true); // Mastercard 51–55
    expect(isSecretValue('371449635398431')).toBe(true); // Amex
    expect(isSecretValue('36227206271667')).toBe(true); // Diners
    expect(isSecretValue('3530111333300000')).toBe(true); // JCB
    expect(isSecretValue('6011 1111 1111 1117')).toBe(true); // Discover, grouped
    expect(isSecretValue('6200000000000005')).toBe(true); // UnionPay
  });

  it('leaves Luhn-valid timestamps and IDs without a card prefix alone', () => {
    expect(isSecretValue('1694736000000')).toBe(false); // epoch ms, passes Luhn
    expect(isSecretValue('1597449600000000')).toBe(false); // epoch µs, passes Luhn
    expect(isSecretValue('1234567812345670')).toBe(false); // Luhn-valid, no IIN
    expect(isSecretValue('2720999999999996')).toBe(true); // top of Mastercard 2-series
    expect(isSecretValue('2721000000000004')).toBe(false); // just past it
    expect(isSecretValue('2220999999999991')).toBe(false); // just below it
  });

  it('keeps Luhn-valid timestamps in bodies, forms and URLs', () => {
    const json = JSON.stringify({ createdAt: '1694736000000', ts: '1597449600000000' });
    expect(redactBody(json, 'application/json', EMPTY_RULES).redacted).toBe(false);
    const form = 'timestamp=1694736000000&name=Jane';
    expect(redactBody(form, 'application/x-www-form-urlencoded', EMPTY_RULES).text).toBe(form);
    const url = 'https://x.com/a?timestamp=1694736000000&page=2';
    expect(redactUrl(url, EMPTY_RULES)).toBe(url);
  });
});
