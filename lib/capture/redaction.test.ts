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

describe('redactUrl — credential carriers (issues #61, #83)', () => {
  it('redacts Azure SAS signature params, keeps the rest of the SAS intact', () => {
    const out = redactUrl(
      'https://acct.blob.core.windows.net/c/file.txt?sv=2021-06-08&ss=b&srt=sco&sp=r&se=2026-01-01T00:00:00Z&sig=abcDEF123',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://acct.blob.core.windows.net/c/file.txt?sv=2021-06-08&ss=b&srt=sco&sp=r&se=2026-01-01T00:00:00Z&sig=${REDACTED}`,
    );
  });

  it('redacts bare key= API keys in URLs', () => {
    const out = redactUrl(
      'https://maps.googleapis.com/maps/api/geocode/json?address=paris&key=AIzaSySecret',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://maps.googleapis.com/maps/api/geocode/json?address=paris&key=${REDACTED}`,
    );
  });

  it('masks the password in user:password@ URLs, keeping the username', () => {
    const out = redactUrl(
      'https://deploy:hunter2@internal.example.com/logs?page=1',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://deploy:${REDACTED}@internal.example.com/logs?page=1`,
    );
  });

  it('masks userinfo passwords without a query string, and in scheme-less URLs', () => {
    expect(redactUrl('https://u:p@example.com/a', EMPTY_RULES)).toBe(
      `https://u:${REDACTED}@example.com/a`,
    );
    expect(redactUrl('//u:p@example.com/a?x=1', EMPTY_RULES)).toBe(
      `//u:${REDACTED}@example.com/a?x=1`,
    );
  });

  it('follows absolute nested URL carriers and redacts their secrets', () => {
    const out = redactUrl(
      'https://app.example.com/callback?redirect=https://inner.example.com/auth?token=sekret&next=/home',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://app.example.com/callback?redirect=https://inner.example.com/auth?token=${REDACTED}&next=/home`,
    );
  });

  it('follows scheme-less nested URL carriers', () => {
    const out = redactUrl(
      'https://app.example.com/go?next=//inner.example.com/a?session=abc&q=1',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://app.example.com/go?next=//inner.example.com/a?session=${REDACTED}&q=1`,
    );
  });

  it('follows percent-encoded nested carriers', () => {
    const inner = 'https://inner.example.com/a?api_key=topsecret';
    const out = redactUrl(
      `https://app.example.com/go?return=${encodeURIComponent(inner)}`,
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://app.example.com/go?return=https://inner.example.com/a?api_key=${REDACTED}`,
    );
  });

  it('redacts through carrier chains up to the depth cap', () => {
    const l2 = 'https://l2.example.com/deep?token=found';
    const l1 = 'https://l1.example.com/mid?next=' + encodeURIComponent(l2);
    const l0 = 'https://l0.example.com/start?go=' + encodeURIComponent(l1);
    const out = redactUrl(l0, EMPTY_RULES);
    expect(out).toBe(
      `https://l0.example.com/start?go=https://l1.example.com/mid?next=https://l2.example.com/deep?token=${REDACTED}`,
    );
  });

  it('bounds recursion on pathologically nested carriers and fails closed', () => {
    let u = 'https://deep.example.com/end?token=toodeep';
    for (let i = 0; i < 10; i += 1) {
      u = 'https://app.example.com/go?next=' + encodeURIComponent(u);
    }
    const started = Date.now();
    const out = redactUrl(u, EMPTY_RULES);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(typeof out).toBe('string');
    // Past the depth cap the carrier is masked whole: the deep secret must not
    // survive, and the chain must not recurse forever.
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('toodeep');
  });

  it('masks deep carriers in raw (unencoded) nesting past the depth cap', () => {
    const u =
      'https://a.example.com/0?go=https://b.example.com/1?go=https://c.example.com/2?go=https://d.example.com/3?go=https://e.example.com/4?token=buried';
    const out = redactUrl(u, EMPTY_RULES);
    expect(out).not.toContain('buried');
    expect(out).toContain(REDACTED);
  });

  it('redacts secrets at every level within the depth cap', () => {
    const l3 = 'https://l3.example.com/deep?session=within';
    const l2 = 'https://l2.example.com/mid?next=' + encodeURIComponent(l3);
    const l1 = 'https://l1.example.com/start?go=' + encodeURIComponent(l2) + '&token=top';
    const out = redactUrl(l1, EMPTY_RULES);
    expect(out).toBe(
      `https://l1.example.com/start?go=https://l2.example.com/mid?next=https://l3.example.com/deep?session=${REDACTED}&token=${REDACTED}`,
    );
    expect(out).not.toContain('within');
  });

  it('leaves ordinary non-URL param values alone', () => {
    const url = 'https://x.com/p?next=home&return=/dashboard';
    expect(redactUrl(url, EMPTY_RULES)).toBe(url);
  });
});

describe('redactHeaders — URL-valued headers (issue #63)', () => {
  it('masks secret query params inside Location, preserving the URL', () => {
    const out = redactHeaders(
      [
        {
          name: 'Location',
          value: 'https://app.example.com/oauth/callback?code=abc&token=xyz&state=ok',
        },
      ],
      EMPTY_RULES,
    );
    expect(out).toEqual([
      {
        name: 'Location',
        value: `https://app.example.com/oauth/callback?code=abc&token=${REDACTED}&state=ok`,
      },
    ]);
  });

  it('masks secret query params inside Referer', () => {
    const out = redactHeaders(
      [{ name: 'referer', value: 'https://docs.example.com/p?api_key=k1&page=2' }],
      EMPTY_RULES,
    );
    expect(out).toEqual([
      { name: 'referer', value: `https://docs.example.com/p?api_key=${REDACTED}&page=2` },
    ]);
  });

  it('leaves non-sensitive Location and Referer values unchanged', () => {
    const headers = [
      { name: 'Location', value: 'https://app.example.com/welcome?page=1' },
      { name: 'Referer', value: 'https://app.example.com/start' },
    ];
    expect(redactHeaders(headers, EMPTY_RULES)).toEqual(headers);
  });
});
