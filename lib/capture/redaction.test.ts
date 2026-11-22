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

describe('default rules for cloud signed URLs, API keys and URL passwords', () => {
  it('masks the signature of an Azure storage (SAS) link', () => {
    const out = redactUrl(
      'https://acct.blob.core.windows.net/c/report.pdf?sv=2022-11-02&se=2026-12-01&sr=b&sp=rw&sig=FAKE%2Bsas%3D',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://acct.blob.core.windows.net/c/report.pdf?sv=2022-11-02&se=2026-12-01&sr=b&sp=rw&sig=${REDACTED}`,
    );
  });

  it('masks a Google API key passed as key=', () => {
    const out = redactUrl(
      'https://maps.googleapis.com/maps/api/geocode/json?address=Berlin&key=AIzaSyFAKEKEY',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `https://maps.googleapis.com/maps/api/geocode/json?address=Berlin&key=${REDACTED}`,
    );
  });

  it('masks Signature= in CloudFront and older S3 signed links', () => {
    expect(
      redactUrl(
        'https://d111.cloudfront.net/v.mp4?Expires=1700000000&Signature=FAKE~cf&Key-Pair-Id=K2JCJMDEHXQW5F',
        EMPTY_RULES,
      ),
    ).toBe(
      `https://d111.cloudfront.net/v.mp4?Expires=1700000000&Signature=${REDACTED}&Key-Pair-Id=K2JCJMDEHXQW5F`,
    );
    expect(
      redactUrl(
        'https://b.s3.amazonaws.com/k?AWSAccessKeyId=AKIAFAKE&Expires=1700000000&Signature=FAKEv2',
        EMPTY_RULES,
      ),
    ).toBe(
      `https://b.s3.amazonaws.com/k?AWSAccessKeyId=AKIAFAKE&Expires=1700000000&Signature=${REDACTED}`,
    );
  });

  it('matches these names only as whole parameter names', () => {
    const url = 'https://x.com/p?keyword=shoes&monkey=1&hotkey=k&sigma=2&signature_version=4';
    expect(redactUrl(url, EMPTY_RULES)).toBe(url);
  });

  it('masks the password in user:password@ and keeps the user name', () => {
    expect(redactUrl('https://admin:hunter2@internal.example.com/api', EMPTY_RULES)).toBe(
      `https://admin:${REDACTED}@internal.example.com/api`,
    );
    expect(redactUrl('wss://bot:p%40ss@chat.example.com:8443/ws?room=1', EMPTY_RULES)).toBe(
      `wss://bot:${REDACTED}@chat.example.com:8443/ws?room=1`,
    );
  });

  it('masks the password and the query secrets in the same URL', () => {
    expect(redactUrl('https://u:pw@x.com/p?token=t&page=2#top', EMPTY_RULES)).toBe(
      `https://u:${REDACTED}@x.com/p?token=${REDACTED}&page=2#top`,
    );
  });

  it('leaves URLs without a password unchanged', () => {
    for (const url of [
      'https://admin@internal.example.com/api',
      'https://x.com:8080/users/@ada?q=1',
      'https://x.com/p?next=https://a:b@c.com', // not this URL's user info
      'mailto:ada@example.com',
    ]) {
      expect(redactUrl(url, EMPTY_RULES)).toBe(url);
    }
  });

  it('masks a URL password that Chrome echoes in a console error', () => {
    const input =
      "TypeError: Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: https://admin:hunter2@internal.example.com/api";
    expect(redactUrlsInText(input, EMPTY_RULES)).toBe(
      `TypeError: Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: https://admin:${REDACTED}@internal.example.com/api`,
    );
  });

  it('masks a URL password that contains an apostrophe in a console error', () => {
    const input =
      "TypeError: Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: https://admin:hun'ter2@internal.example.com/api";
    expect(redactUrlsInText(input, EMPTY_RULES)).toBe(
      `TypeError: Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: https://admin:${REDACTED}@internal.example.com/api`,
    );
  });

  it('masks the whole key= value in console text when it contains an apostrophe', () => {
    expect(
      redactUrlsInText("GET https://maps.example.com/geo?key=AIza'FAKE&address=Berlin 403", EMPTY_RULES),
    ).toBe(`GET https://maps.example.com/geo?key=${REDACTED}&address=Berlin 403`);
  });

  it("still ends a URL quoted with ' at its closing quote", () => {
    expect(
      redactUrlsInText(
        "Access to fetch at 'https://api.test/d?token=s' from origin 'http://localhost:5319' has been blocked; ['https://a.test/?token=1','https://b.test/?token=2']",
        EMPTY_RULES,
      ),
    ).toBe(
      `Access to fetch at 'https://api.test/d?token=${REDACTED}' from origin 'http://localhost:5319' has been blocked; ['https://a.test/?token=${REDACTED}','https://b.test/?token=${REDACTED}']`,
    );
  });

  it('does not mistake a backslash path with @ for a password', () => {
    // Browsers read \ as / in http(s) and ws(s) URLs, so 8443\team is port + path.
    const url = 'https://example.com:8443\\team@docs';
    expect(redactUrl(url, EMPTY_RULES)).toBe(url);
    expect(redactUrlsInText(`see ${url}`, EMPTY_RULES)).toBe(`see ${url}`);
  });

  it('masks a one-time code passed as otp= in a URL', () => {
    expect(redactUrl('https://x.com/verify?otp=123456&next=%2Fhome', EMPTY_RULES)).toBe(
      `https://x.com/verify?otp=${REDACTED}&next=%2Fhome`,
    );
  });

  it('masks private keys and one-time codes in JSON bodies', () => {
    const input = JSON.stringify({
      type: 'service_account',
      client_email: 'bot@proj.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
      privateKey: 'FAKE',
      otp: '123456',
    });
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(JSON.parse(text)).toEqual({
      type: 'service_account',
      client_email: 'bot@proj.iam.gserviceaccount.com',
      private_key: REDACTED,
      privateKey: REDACTED,
      otp: REDACTED,
    });
  });

  it('masks a one-time code in a form body', () => {
    const { text } = redactBody('otp=123456&remember=1', undefined, EMPTY_RULES);
    expect(text).toBe(`otp=${REDACTED}&remember=1`);
  });

  it('keeps ordinary "key", "sig" and "Signature" fields in bodies', () => {
    const input = '{"key":"PROJ-123","sig":"v2","Signature":"Ada Lovelace","keyword":"login"}';
    expect(redactBody(input, 'application/json', EMPTY_RULES)).toEqual({
      text: input,
      redacted: false,
    });
  });
});
