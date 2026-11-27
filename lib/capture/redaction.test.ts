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
  redactEventPayload,
  redactSessionUrls,
  redactUrl,
  redactUrlsInText,
  redactWsText,
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

// Structural redaction matrix (design §6). Each row must be seen failing before T1.
describe('structural redaction matrix', () => {
  it('1: scrubs code/state from a Location header but keeps scope', () => {
    const out = redactHeaders(
      [{ name: 'Location', value: 'https://idp/cb?code=S&state=st&scope=read' }],
      EMPTY_RULES,
    );
    expect(out[0]!.value).toBe(`https://idp/cb?code=${REDACTED}&state=${REDACTED}&scope=read`);
  });

  it('2: scrubs fragment params without touching benign siblings', () => {
    // `token_type` contains the pre-existing `token` key pattern, so it is
    // masked too — that is unchanged DEFAULT_KEY_PATTERN behaviour, not a
    // regression. `scope` below is the benign control.
    expect(redactUrl('https://app/cb#access_token=JWT&token_type=bearer&scope=read', EMPTY_RULES)).toBe(
      `https://app/cb#access_token=${REDACTED}&token_type=${REDACTED}&scope=read`,
    );
  });

  it('3: scrubs hash-router callback params', () => {
    expect(redactUrl('https://app/#/cb?code=S', EMPTY_RULES)).toBe(
      `https://app/#/cb?code=${REDACTED}`,
    );
  });

  it('4: masks the whole authority userinfo, including credential-only forms', () => {
    expect(redactUrl('https://alice:hunter2@host/v1?q=1', EMPTY_RULES)).toBe(
      `https://${REDACTED}@host/v1?q=1`,
    );
    expect(redactUrl('https://token@host/', EMPTY_RULES)).toBe(`https://${REDACTED}@host/`);
  });

  it('5: preserves scroll-to-text fragments', () => {
    const url = 'https://x/p#:~:text=authentication';
    expect(redactUrl(url, EMPTY_RULES)).toBe(url);
  });

  it('6: scrubs a nested encoded URL before HAR decodes it', () => {
    const out = redactUrl('https://app/?next=https%3A%2F%2Fx%2F%3Ftoken%3Dabc', EMPTY_RULES);
    expect(decodeURIComponent(new URL('https://app/' + out.slice(out.indexOf('?'))).searchParams.get('next')!)).toContain(REDACTED);
  });

  it('8: is byte-identical when applied twice', () => {
    const input = 'https://app/?code=R&state=R#access_token=R';
    const once = redactUrl(input, EMPTY_RULES);
    expect(redactUrl(once, EMPTY_RULES)).toBe(once);
  });

  it('11: scrubs every URL in a multi-value Link header', () => {
    const out = redactHeaders(
      [
        {
          name: 'Link',
          value: '<https://x/?sig=S>; rel=next, <https://y/?code=C>; rel=last',
        },
      ],
      EMPTY_RULES,
    );
    expect(out[0]!.value).toBe(
      `<https://x/?sig=${REDACTED}>; rel=next, <https://y/?code=${REDACTED}>; rel=last`,
    );
  });

  it('12: scrubs the URL in a Refresh header and preserves the prefix', () => {
    const out = redactHeaders(
      [{ name: 'Refresh', value: '0; url=https://x/cb?code=S' }],
      EMPTY_RULES,
    );
    expect(out[0]!.value).toBe(`0; url=https://x/cb?code=${REDACTED}`);
  });

  it('13: uses anchored exact/compound names without matching benign names', () => {
    expect(redactUrl('https://x/p?design=a&postalCode=b&statement=c', EMPTY_RULES)).toBe(
      'https://x/p?design=a&postalCode=b&statement=c',
    );
    expect(redactUrl('https://x/p?code=S&openid.nonce=N&access_code=A&saml_assertion=Q', EMPTY_RULES)).toBe(
      `https://x/p?code=${REDACTED}&openid.nonce=${REDACTED}&access_code=${REDACTED}&saml_assertion=${REDACTED}`,
    );
  });

  it('17: scrubs a decoded form carrier', () => {
    const out = redactUrl('https://x/?q=a%26token%3Dsecret', EMPTY_RULES);
    expect(decodeURIComponent(new URL('https://x/' + out.slice(out.indexOf('?'))).searchParams.get('q')!)).toBe(
      `a&token=${REDACTED}`,
    );
  });

  it('18: preserves escaping byte-for-byte on a second pass', () => {
    const input = 'https://x/?next=a%2Bb%26code%3DS';
    const once = redactUrl(input, EMPTY_RULES);
    expect(once).not.toBe(input);
    expect(once).toBe(`https://x/?next=a%2Bb%26code%3D${encodeURIComponent(REDACTED)}`);
    expect(redactUrl(once, EMPTY_RULES)).toBe(once);
  });

  it('22: tolerates malformed percent-encoding and non-string carries', () => {
    expect(() => redactUrl('https://x/p?q=%ZZ&code=S', EMPTY_RULES)).not.toThrow();
    // N2: an uninspectable carrier is fail-closed, not returned as clean.
    expect(redactUrl('https://x/p?q=%ZZ&code=S', EMPTY_RULES)).toBe(
      `https://x/p?q=${encodeURIComponent(REDACTED)}&code=${REDACTED}`,
    );
    expect(() =>
      redactEventPayload('nav', { url: 42, nested: { code: 7 } }, EMPTY_RULES),
    ).not.toThrow();
  });

  it('23: does not mutate session or event inputs', () => {
    const session = {
      initialUrl: 'https://idp/cb?code=S',
      tabs: [{ tabId: 1, url: 'https://x/#access_token=T' }],
    };
    const out = redactSessionUrls(session, EMPTY_RULES) as typeof session;
    expect(out.initialUrl).toBe(`https://idp/cb?code=${REDACTED}`);
    expect(out.tabs[0]!.url).toBe(`https://x/#access_token=${REDACTED}`);
    expect(session.initialUrl).toBe('https://idp/cb?code=S');
    expect(session.tabs[0]!.url).toBe('https://x/#access_token=T');
  });

  it('19/20: scrubs a URL carrier on an unknown event type and skips undefined toUrl', () => {
    const out = redactEventPayload(
      'future-event',
      { url: 'https://idp/cb?code=S', toUrl: undefined },
      EMPTY_RULES,
    ) as { url: string; toUrl?: string };
    expect(out.url).toBe(`https://idp/cb?code=${REDACTED}`);
    expect(out.toUrl).toBeUndefined();
  });

  it('15: scrubs a scheme-less URL carrier inside WS text', () => {
    const out = redactEventPayload(
      'net-request',
      { wsFrames: [{ opcode: 1, text: '{"url":"/cb?code=S"}' }] },
      EMPTY_RULES,
    ) as { wsFrames: { text: string }[] };
    expect(out.wsFrames[0]!.text).toContain(REDACTED);
    expect(out.wsFrames[0]!.text).not.toContain('code=S');
  });

  it('F1: scrubs both JSON carriers and embedded URLs in one WS frame', () => {
    const out = redactWsText(
      '{"url":"/cb?code=A","payload":"https://x.test/cb?code=S3CR3T"}',
      EMPTY_RULES,
    );
    expect(out).toBe(
      `{"url":"/cb?code=${REDACTED}","payload":"https://x.test/cb?code=${REDACTED}"}`,
    );
  });

  it('F1b: preserves original WS JSON formatting when no carrier changes', () => {
    const input = '{ "a": 1, "b": 2 }';
    expect(redactWsText(input, EMPTY_RULES)).toBe(input);
  });

  it('F2: preserves scroll-to-text directives while scrubbing other fragment params', () => {
    expect(redactUrl('https://x/p#:~:text=hello&code=SECRET', EMPTY_RULES)).toBe(
      `https://x/p#:~:text=hello&code=${REDACTED}`,
    );
    expect(redactUrl('https://x/p#:~:text=first&text=second&token=S', EMPTY_RULES)).toBe(
      `https://x/p#:~:text=first&text=second&token=${REDACTED}`,
    );
    // Control from test 5 stays byte-identical.
    const control = 'https://x/p#:~:text=authentication';
    expect(redactUrl(control, EMPTY_RULES)).toBe(control);
  });

  it('F2: scrubs params after a second fragment separator', () => {
    expect(redactUrl('https://x/#frag#code=SECRET', EMPTY_RULES)).toBe(
      `https://x/#frag#code=${REDACTED}`,
    );
    expect(redactUrl('https://x/#a&code=S#b&token=T', EMPTY_RULES)).toBe(
      `https://x/#a&code=${REDACTED}#b&token=${REDACTED}`,
    );
    // Hash-router prefix through `?` is still preserved (control from test 3).
    expect(redactUrl('https://app/#/cb?code=S', EMPTY_RULES)).toBe(
      `https://app/#/cb?code=${REDACTED}`,
    );
  });

  it('F2b: redacts nested form carriers that begin with a slash', () => {
    const queryVector = 'https://x/?q=%2Fcb%26token%3DSECRET';
    const queryOut = redactUrl(queryVector, EMPTY_RULES);
    expect(decodeURIComponent(new URL(queryOut).searchParams.get('q')!)).toBe(
      `/cb&token=${REDACTED}`,
    );

    const fragmentVector = 'https://x/#q=%2Fcb%26token%3DS';
    const fragmentOut = redactUrl(fragmentVector, EMPTY_RULES);
    expect(decodeURIComponent(new URL(fragmentOut).hash.slice(3))).toBe(
      `/cb&token=${REDACTED}`,
    );
  });

  it('F3: masks client_assertion and SAMLResponse in URLs, bodies and JSON', () => {
    expect(redactUrl(
      'https://idp/cb?client_assertion=S3CR3T&SAMLResponse=X&saml_response=Y&keep=1',
      EMPTY_RULES,
    )).toBe(
      `https://idp/cb?client_assertion=${REDACTED}&SAMLResponse=${REDACTED}&saml_response=${REDACTED}&keep=1`,
    );

    const form = redactBody(
      'client_assertion=S3CR3T&SAMLResponse=X&keep=1',
      'application/x-www-form-urlencoded',
      EMPTY_RULES,
    );
    expect(form.redacted).toBe(true);
    expect(form.text).toBe(
      `client_assertion=${REDACTED}&SAMLResponse=${REDACTED}&keep=1`,
    );

    const json = redactBody('{"client_assertion":"S3CR3T"}', 'application/json', EMPTY_RULES);
    expect(json.redacted).toBe(true);
    expect(json.text).toBe(JSON.stringify({ client_assertion: REDACTED }, null, 2));
    expect(JSON.parse(redactBody(
      '{"client_assertion":"A","SAMLResponse":"B","keep":1}',
      'application/json',
      EMPTY_RULES,
    ).text)).toEqual({ client_assertion: REDACTED, SAMLResponse: REDACTED, keep: 1 });

    // The shared anchored sets must not widen bodies to benign names.
    expect(redactBody('design=a&postalCode=b&statement=c', undefined, EMPTY_RULES).text).toBe(
      'design=a&postalCode=b&statement=c',
    );
  });

  it('F3: masks code_verifier consistently in URLs and form bodies', () => {
    expect(redactUrl(
      'https://idp/token?code_verifier=S3CR3T&grant_type=authorization_code',
      EMPTY_RULES,
    )).toBe(
      `https://idp/token?code_verifier=${REDACTED}&grant_type=authorization_code`,
    );
    const form = redactBody(
      'grant_type=authorization_code&code_verifier=S3CR3T',
      'application/x-www-form-urlencoded',
      EMPTY_RULES,
    );
    expect(form.redacted).toBe(true);
    expect(form.text).toBe(`grant_type=authorization_code&code_verifier=${REDACTED}`);
  });

  it('F4: scrubs URL carriers in input values, file notes and string arrays', () => {
    const url = 'https://idp/cb?code=SECRET';
    const masked = `https://idp/cb?code=${REDACTED}`;

    const input = redactEventPayload(
      'input',
      { descriptor: { tag: 'input' }, value: url, redacted: false },
      EMPTY_RULES,
    ) as { descriptor: { tag: string }; value: string; redacted: boolean };
    expect(input.value).toBe(masked);
    expect(input).toEqual({ descriptor: { tag: 'input' }, value: masked, redacted: false });

    const file = redactEventPayload(
      'file-attached',
      { assetId: 'a', fileName: 'f.txt', mime: 'text/plain', size: 1, note: `see ${url}` },
      EMPTY_RULES,
    ) as { note: string; fileName: string; assetId: string };
    expect(file.note).toBe(`see ${masked}`);
    expect(file.fileName).toBe('f.txt');
    expect(Object.keys(file)).toEqual(['assetId', 'fileName', 'mime', 'size', 'note']);

    const shot = redactEventPayload(
      'screenshot',
      { contextText: `shot of ${url}` },
      EMPTY_RULES,
    ) as { contextText: string };
    expect(shot.contextText).toBe(`shot of ${masked}`);

    const consoleEvent = redactEventPayload(
      'console',
      { level: 'log', text: 'log', args: [url, 42, { nested: url }] },
      EMPTY_RULES,
    ) as { args: unknown[] };
    // String elements are scrubbed; non-strings keep their shape and recurse.
    expect(consoleEvent.args).toEqual([masked, 42, { nested: url }]);
  });

  it('F6b: scrubs URL credentials in tab titles, toTitle and session metadata', () => {
    const secret = 'https://idp/cb?code=SECRET';
    const masked = `https://idp/cb?code=${REDACTED}`;

    const switched = redactEventPayload(
      'tab-switch',
      { toTitle: secret, toUrl: 'https://x/', toTabId: 2 },
      EMPTY_RULES,
    ) as { toTitle: string; toUrl: string; toTabId: number };
    expect(switched.toTitle).toBe(masked);
    expect(switched.toUrl).toBe('https://x/');
    expect(switched.toTabId).toBe(2);

    const nav = redactEventPayload(
      'nav',
      { url: 'https://x/', title: secret },
      EMPTY_RULES,
    ) as { title: string };
    expect(nav.title).toBe(masked);

    const session = {
      initialUrl: 'https://x/',
      name: secret,
      tabs: [{ url: 'https://x/', title: secret }],
    };
    const out = redactSessionUrls(session, EMPTY_RULES) as typeof session;
    expect(out.tabs[0]!.title).toBe(masked);
    expect(out.tabs[0]!.url).toBe('https://x/');
    expect(out.name).toBe(masked);
    // No mutation of the caller's metadata.
    expect(session.tabs[0]!.title).toBe(secret);
    expect(session.name).toBe(secret);
  });
});

// N1 — encoded URL carrier whose decoded form has a literal fragment.
describe('N1: encoded form carrier with a fragment', () => {
  const decodeQ = (url: string): string => new URL(url).searchParams.get('q')!;

  it('N1: masks the token and preserves the fragment in the exact reproduction', () => {
    const out = redactUrl('https://x/?q=%2Fcb%26token%3DS%23frag', EMPTY_RULES);
    expect(decodeQ(out)).toBe(`/cb&token=${REDACTED}#frag`);
    expect(out).toContain('%23frag');
  });

  it('N1: masks every sensitive parameter when multiple are encoded', () => {
    const out = redactUrl(
      'https://x/?q=%2Fcb%26code%3DC%26state%3DST%26nonce%3DN%26assertion%3DA%26client_assertion%3DCA%26SAMLResponse%3DSR%23frag',
      EMPTY_RULES,
    );
    expect(decodeQ(out)).toBe(
      `/cb&code=${REDACTED}&state=${REDACTED}&nonce=${REDACTED}&assertion=${REDACTED}&client_assertion=${REDACTED}&SAMLResponse=${REDACTED}#frag`,
    );
  });

  it('N1: scrubs sensitive params in both the form base and the fragment', () => {
    const out = redactUrl('https://x/?q=%2Fcb%26code%3DC%23token%3DT', EMPTY_RULES);
    expect(decodeQ(out)).toBe(`/cb&code=${REDACTED}#token=${REDACTED}`);
  });

  it('N1: preserves ordinary fragments and scroll-to-text directives', () => {
    // Sensitive fragment params are masked even when the form base is benign.
    const out = redactUrl('https://x/?q=%2Fcb%26page%3D1%23access_token%3DSEC', EMPTY_RULES);
    expect(decodeQ(out)).toBe(`/cb&page=1#access_token=${REDACTED}`);
    // Scroll-to-text directives survive both at top level and inside a carrier.
    const directive = redactUrl('https://x/p#:~:text=authentication', EMPTY_RULES);
    expect(directive).toBe('https://x/p#:~:text=authentication');
    const inCarrier = redactUrl(
      'https://x/?q=%2Fcb%26token%3DS%23:~:text=hello',
      EMPTY_RULES,
    );
    expect(decodeQ(inCarrier)).toBe(`/cb&token=${REDACTED}#:~:text=hello`);
  });

  it('N1: keeps encoded fragments and benign values intact', () => {
    const out = redactUrl('https://x/?q=%2Fcb%26page%3D1%23frag', EMPTY_RULES);
    expect(decodeQ(out)).toBe('/cb&page=1#frag');
  });

  it('N1: handles nested, protocol-relative and query-plus-fragment carriers', () => {
    const nested = redactUrl(
      'https://x/?next=%2Fcb%26token%3DS%23frag',
      EMPTY_RULES,
    );
    expect(decodeURIComponent(new URL(nested).searchParams.get('next')!)).toBe(
      `/cb&token=${REDACTED}#frag`,
    );
    const protocolRelative = redactUrl(
      'https://x/?q=%2F%2Fx%2Fcb%26token%3DS%23frag',
      EMPTY_RULES,
    );
    expect(decodeQ(protocolRelative)).toBe(`//x/cb&token=${REDACTED}#frag`);
    const withQuery = redactUrl(
      'https://x/?q=%2Fcb%3Fcode%3DC%23frag',
      EMPTY_RULES,
    );
    expect(decodeQ(withQuery)).toBe(`/cb?code=${REDACTED}#frag`);
  });

  it('N1: masks the carrier in URL-valued headers too', () => {
    const out = redactHeaders(
      [
        {
          name: 'Referer',
          value: 'https://x/?q=%2Fcb%26token%3DS%23frag',
        },
      ],
      EMPTY_RULES,
    );
    expect(decodeQ(out[0]!.value)).toBe(`/cb&token=${REDACTED}#frag`);
  });

  it('N1: is byte-identical on a second application after a real first-pass change', () => {
    const input = 'https://x/?q=%2Fcb%26token%3DS%23frag';
    const once = redactUrl(input, EMPTY_RULES);
    expect(once).not.toBe(input);
    expect(decodeQ(once)).toContain(REDACTED);
    expect(redactUrl(once, EMPTY_RULES)).toBe(once);
  });
});

// N1b — scheme-less carriers containing '?' and '#'.
describe('N1b: scheme-less URL carriers', () => {
  const decoded = (url: string, key = 'q'): string =>
    decodeURIComponent(new URL(url).searchParams.get(key)!);

  it('N1b: masks the exact reproduction and keeps the benign head query', () => {
    const out = redactUrl('https://x/?q=foo%3Dbar%3Fx%3D1%23token%3DS', EMPTY_RULES);
    expect(decoded(out)).toBe(`foo=bar?x=1#token=${REDACTED}`);
  });

  it('N1b: masks the exact redirect payload', () => {
    const out = redactUrl(
      'https://x/?redirect=checkout%3Fstep%3D1%23access_token%3DS',
      EMPTY_RULES,
    );
    expect(decoded(out, 'redirect')).toBe(`checkout?step=1#access_token=${REDACTED}`);
  });

  it('N1b: masks a head-query token without a leading slash', () => {
    const out = redactUrl('https://x/?q=checkout%3Ftoken%3DS%23frag', EMPTY_RULES);
    expect(decoded(out)).toBe(`checkout?token=${REDACTED}#frag`);
  });

  it('N1b: masks multiple fragment separators and several sensitive params', () => {
    const out = redactUrl(
      'https://x/?q=foo%3Dbar%3Fx%3D1%23code%3DC%23token%3DT%26state%3Dst',
      EMPTY_RULES,
    );
    expect(decoded(out)).toBe(
      `foo=bar?x=1#code=${REDACTED}#token=${REDACTED}&state=${REDACTED}`,
    );
  });

  it('N1b: handles encoded and literal fragments and fragment-position carriers', () => {
    const encodedHash = redactUrl('https://x/?q=%2Fcb%26token%3DS%23frag', EMPTY_RULES);
    expect(decoded(encodedHash)).toBe(`/cb&token=${REDACTED}#frag`);
    const fragmentCarrier = redactUrl(
      'https://x/#q=foo%3Dbar%3Fx%3D1%23token%3DS',
      EMPTY_RULES,
    );
    expect(decodeURIComponent(new URL(fragmentCarrier).hash.slice(3))).toBe(
      `foo=bar?x=1#token=${REDACTED}`,
    );
  });

  it('N1b: never treats whitespace-bearing diagnostic text as a carrier', () => {
    const text = 'The error was: token=S at checkout#frag';
    expect(redactUrlsInText(text, EMPTY_RULES)).toBe(text);
  });

  it('N1b: is idempotent after a real first-pass change', () => {
    const input = 'https://x/?q=foo%3Dbar%3Fx%3D1%23token%3DS';
    const once = redactUrl(input, EMPTY_RULES);
    expect(once).not.toBe(input);
    expect(redactUrl(once, EMPTY_RULES)).toBe(once);
  });

  it('N1b: masks sensitive pairs before the first ? in a fragment', () => {
    const out = redactUrl('https://x/?q=foo%3Dbar%23token%3DS%3Fx%3D1', EMPTY_RULES);
    expect(decoded(out)).toBe(`foo=bar#token=${REDACTED}?x=1`);
  });

  it('N1b: masks credentials in carriers containing whitespace', () => {
    const out = redactUrl('https://x/?q=checkout%3Ftoken%3DS%20', EMPTY_RULES);
    expect(decoded(out)).toBe(`checkout?token=${REDACTED}`);
  });

  it('N1b: bare text keys are not scroll-to-text directives', () => {
    const secret = redactUrl('https://x/#text=token=S', EMPTY_RULES);
    expect(decodeURIComponent(new URL(secret).hash.slice(1))).toBe(`text=token=${REDACTED}`);
    const directive = redactUrl('https://x/p#:~:text=authentication', EMPTY_RULES);
    expect(directive).toBe('https://x/p#:~:text=authentication');
    const pseudo = redactUrl('https://x/#:text=token=S', EMPTY_RULES);
    expect(decodeURIComponent(new URL(pseudo).hash.slice(1))).toBe(`:text=token=${REDACTED}`);
  });
});

// N2 — shared bounded recursion across URL/fragment processing.
describe('N2: shared resource budget', () => {
  it('N2: enforces the depth cap and fail-closes the uninspectable carrier', () => {
    let carrier = 'page=1';
    for (let i = 0; i < 4; i++) carrier = 'https://x/?q=' + encodeURIComponent(carrier);
    let current = redactUrl('https://x/?q=' + encodeURIComponent(carrier), EMPTY_RULES);
    for (let i = 0; i < 4; i++) {
      current = new URL(current).searchParams.get('q')!;
    }
    expect(current).toBe(REDACTED);
  });

  it('N2: masks an over-4096-byte encoded carrier before decoding', () => {
    const raw = 'p=1&'.repeat(1100) + 'token=SECRET';
    expect(raw.length).toBeGreaterThan(4096);
    const out = redactUrl('https://x/?q=' + encodeURIComponent(raw), EMPTY_RULES);
    expect(new URL(out).searchParams.get('q')).toBe(REDACTED);
    expect(out).not.toContain('SECRET');
  });

  it('N2: bounds a flat many-parameter URL without losing benign evidence', () => {
    const params = Array.from({ length: 1200 }, (_, i) =>
      i === 1199 ? 'token=SECRET' : `p${i}=${i}`,
    ).join('&');
    const out = redactUrl('https://x/?' + params, EMPTY_RULES);
    expect(out).toContain('token=' + REDACTED);
    expect(out).toContain('p0=0');
    expect(out).not.toContain('SECRET');
  });

  it('N2: keeps whole-value and URL-valued header behavior under pressure', () => {
    const out = redactHeaders(
      [
        { name: 'Authorization', value: 'Bearer ' + 'A'.repeat(5000) },
        {
          name: 'Referer',
          value: 'https://x/?q=foo%3Dbar%3Fx%3D1%23token%3DS',
        },
      ],
      EMPTY_RULES,
    );
    expect(out[0]!.value).toBe(REDACTED);
    expect(
      decodeURIComponent(new URL(out[1]!.value).searchParams.get('q')!),
    ).toBe(`foo=bar?x=1#token=${REDACTED}`);
  });

  it('N2: idempotence of a fail-closed mask', () => {
    const once = redactUrl(
      'https://x/?q=' + encodeURIComponent('p=1&'.repeat(1100) + 'token=SECRET'),
      EMPTY_RULES,
    );
    expect(redactUrl(once, EMPTY_RULES)).toBe(once);
  });
});

// Regressions for findings recorded by Proofline on review 01a21eb7.
describe('Proofline review regressions', () => {
  it('PL: masks userinfo in a nested URL even without a query', () => {
    const raw = 'https://x/?q=' + encodeURIComponent('https://alice:hunter2@host/cb');
    const out = redactUrl(raw, EMPTY_RULES);
    expect(
      decodeURIComponent(new URL(out).searchParams.get('q')!),
    ).toBe(`https://${REDACTED}@host/cb`);
  });

  it('PL: keeps userinfo masked when a nested URL has path-form pairs', () => {
    const raw =
      'https://x/?q=' + encodeURIComponent('https://alice:hunter2@host/cb&token=SECRET');
    const out = redactUrl(raw, EMPTY_RULES);
    expect(decodeURIComponent(new URL(out).searchParams.get('q')!)).toBe(
      `https://${REDACTED}@host/cb&token=${REDACTED}`,
    );
  });

  it('PL: does not throw on a lone UTF-16 surrogate in a URL value', () => {
    const raw = 'https://x/?q=/cb\uD800%26token%3DS';
    expect(() => redactUrl(raw, EMPTY_RULES)).not.toThrow();
    expect(new URL(redactUrl(raw, EMPTY_RULES)).searchParams.get('q')).toBe(REDACTED);
  });

  it('PL: preserves an own __proto__ property in redacted JSON', () => {
    const input = '{"__proto__":{"hidden":"keep"},"code":"SECRET"}';
    const { text } = redactBody(input, 'application/json', EMPTY_RULES);
    const parsed = JSON.parse(text);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(parsed.__proto__).toEqual({ hidden: 'keep' });
    expect(parsed.code).toBe(REDACTED);
  });

  it('PL: keeps WebSocket JSON valid and numeric tokens byte-identical', () => {
    const input =
      '{"url":"/cb?code=S\\"tail","id":9007199254740993,"note":"a \\" quoted https://x/?code=S"}';
    const out = redactWsText(input, EMPTY_RULES);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toContain('"id":9007199254740993');
    expect(out).toContain('a \\" quoted');
    expect(out).not.toContain('code=S');
  });

  it('PL: never rewrites JSON property names while masking values', () => {
    const input = '{"https://x/?code=S":"keep-key","url":"/cb?code=S"}';
    const out = redactWsText(input, EMPTY_RULES);
    const parsed = JSON.parse(out);
    expect(Object.hasOwn(parsed, 'https://x/?code=S')).toBe(true);
    expect(parsed['https://x/?code=S']).toBe('keep-key');
    expect(parsed.url).toBe('/cb?code=«redacted»');
  });

  it('PL: leaves non-text WebSocket frames untouched', () => {
    const out = redactEventPayload(
      'net-request',
      { wsFrames: [{ opcode: 2, text: 'c2lnPQ==' }] },
      EMPTY_RULES,
    ) as { wsFrames: { text: string }[] };
    expect(out.wsFrames[0]!.text).toBe('c2lnPQ==');
  });

  it('PL: preserves structured values under a URL key and masks nested secrets', () => {
    const input = '{"url":{"label":"keep","token":"SECRET"}}';
    const out = redactWsText(input, EMPTY_RULES);
    const parsed = JSON.parse(out);
    expect(parsed.url.label).toBe('keep');
    expect(parsed.url.token).toBe(REDACTED);
  });

  it('PL: masks every duplicate JSON key occurrence', () => {
    const input = '{"token":"FIRST","token":"SECOND","url":"/cb?code=S"}';
    const out = redactWsText(input, EMPTY_RULES);
    expect(out).not.toContain('FIRST');
    expect(out).not.toContain('SECOND');
    expect(JSON.parse(out).token).toBe(REDACTED);
  });

  it('PL: masks form fields in non-JSON WebSocket frames', () => {
    expect(redactWsText('token=SECRET&page=1', EMPTY_RULES)).toBe(`token=${REDACTED}&page=1`);
  });

  it('PL: does not treat :// inside a relative URL as an authority', () => {
    const value = '/next?x=see://host&y=a@b';
    expect(redactHeaders([{ name: 'Location', value }], EMPTY_RULES)[0]!.value).toBe(value);
  });

  it('PL: distinguishes the encoded-size guard from the decoded-size guard', () => {
    const raw = '%20'.repeat(2500) + '&token=SECRET';
    expect(raw.length).toBeGreaterThan(4096);
    expect(decodeURIComponent(raw).length).toBeLessThan(4096);
    const out = redactUrl('https://x/?q=' + raw, EMPTY_RULES);
    expect(new URL(out).searchParams.get('q')).toBe(REDACTED);
    expect(out).not.toContain('SECRET');
  });

  it('PL: preserves a scroll-to-text directive containing ? verbatim', () => {
    const url = 'https://x/#:~:text=token%3Dexample?';
    expect(redactUrl(url, EMPTY_RULES)).toBe(url);
  });

  it('PL: shares one operation budget across all URL-valued headers in a list', () => {
    const filler =
      'https://x/?' +
      Array.from({ length: 700 }, (_, i) => `p${i}=${i}`).join('&');
    const headers = [
      { name: 'Location', value: 'https://x/?a=keep-me' },
      ...Array.from({ length: 100 }, () => ({ name: 'Content-Location', value: filler })),
      { name: 'Referer', value: 'https://x/?b=later-value' },
    ];
    const out = redactHeaders(headers, EMPTY_RULES);
    expect(out[0]!.value).toBe('https://x/?a=keep-me');
    expect(out[out.length - 1]!.value).toBe(`https://x/?b=${REDACTED}`);
  });
});
