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
  redactBody,
  redactHeaders,
  redactPageUrl,
  redactUrl,
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

  it('redacts OAuth implicit-flow params in the fragment', () => {
    const out = redactUrl(
      'https://app.example.com/callback#access_token=eyJhbGci&token_type=bearer&expires_in=3600',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://app.example.com/callback#access_token=${REDACTED}&token_type=${REDACTED}&expires_in=3600`,
    );
  });

  it('redacts a hash-router query and keeps its route', () => {
    const out = redactUrl('https://x.com/#/reset?reset_token=abc&lang=en', EMPTY_RULES);
    expect(out).toBe(`https://x.com/#/reset?reset_token=${REDACTED}&lang=en`);
  });

  it('redacts the query and the fragment together', () => {
    const out = redactUrl('/p?token=a&q=1#refresh_token=b', EMPTY_RULES);
    expect(out).toBe(`/p?token=${REDACTED}&q=1#refresh_token=${REDACTED}`);
  });

  it('applies custom URL patterns to fragment params', () => {
    const out = redactUrl(
      'https://x.com/#invite=xyz&ref=home',
      rules({ urlParamPatterns: ['^invite$'] }),
    );
    expect(out).toBe(`https://x.com/#invite=${REDACTED}&ref=home`);
  });

  it('leaves anchors, plain routes and harmless fragments unchanged', () => {
    for (const url of [
      'https://x.com/p#section-2',
      'https://x.com/#/settings/profile',
      'https://x.com/#/search?q=hi',
      'https://x.com/p#:~:text=token',
      'https://x.com/p?q=1#',
      'https://x.com/p#',
    ]) {
      expect(redactUrl(url, EMPTY_RULES)).toBe(url);
    }
  });
});

describe('redactPageUrl', () => {
  const on = { redactionEnabled: true, customRedaction: EMPTY_RULES };

  it('redacts page URLs with the session rules', () => {
    expect(redactPageUrl('https://x.com/verify?token=t#access_token=a', on)).toBe(
      `https://x.com/verify?token=${REDACTED}#access_token=${REDACTED}`,
    );
    expect(
      redactPageUrl('https://x.com/?coupon=FREE', {
        ...on,
        customRedaction: rules({ urlParamPatterns: ['coupon'] }),
      }),
    ).toBe(`https://x.com/?coupon=${REDACTED}`);
  });

  it('keeps the URL when redaction is off for the session', () => {
    const url = 'https://x.com/verify?token=t';
    expect(redactPageUrl(url, { ...on, redactionEnabled: false })).toBe(url);
  });

  it('passes empty and non-web URLs through', () => {
    expect(redactPageUrl('', on)).toBe('');
    expect(redactPageUrl('about:blank', on)).toBe('about:blank');
  });
});
