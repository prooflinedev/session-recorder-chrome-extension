/**
 * Unit tests for the pure redaction primitives.
 */

import { describe, expect, it } from 'vitest';
import type { NetHeader, RedactionRules, Session, SessionEvent } from '@/lib/session/types';
import {
  DEFAULT_HEADER_BLOCKLIST,
  DEFAULT_KEY_PATTERN,
  REDACTED,
  VALUE_SECRET_PATTERNS,
  auditSessionRedactions,
  buildKeyMatcher,
  redactBody,
  redactHeaders,
  redactTextValues,
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

  describe('URL path sanitization (route-aware)', () => {
    it('redacts recognizable JWTs in path segments', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const out = redactUrl(`https://api.example.com/auth/callback/${jwt}`, EMPTY_RULES);
      expect(out).toBe(`https://api.example.com/auth/callback/${REDACTED}`);
    });

    it('redacts high-entropy tokens following sensitive routes including invite and callback', () => {
      const token = '4a8f9c1b2d3e4f5a6b7c8d9e0f1a2b3c';
      expect(redactUrl(`https://app.com/reset-password/${token}`, EMPTY_RULES)).toBe(
        `https://app.com/reset-password/${REDACTED}`,
      );
      expect(redactUrl(`https://app.com/magic-link/${token}`, EMPTY_RULES)).toBe(
        `https://app.com/magic-link/${REDACTED}`,
      );
      expect(redactUrl(`https://app.com/verify-email/${token}`, EMPTY_RULES)).toBe(
        `https://app.com/verify-email/${REDACTED}`,
      );
      expect(redactUrl(`https://app.com/invite/${token}`, EMPTY_RULES)).toBe(
        `https://app.com/invite/${REDACTED}`,
      );
      expect(redactUrl(`https://app.com/auth/callback/${token}`, EMPTY_RULES)).toBe(
        `https://app.com/auth/callback/${REDACTED}`,
      );
    });

    it('redacts UUID tokens on sensitive auth routes', () => {
      const uuid = 'c9b0e352-78d1-4f91-89d2-7c3852ef72a9';
      expect(redactUrl(`https://app.com/magic-link/${uuid}`, EMPTY_RULES)).toBe(
        `https://app.com/magic-link/${REDACTED}`,
      );
      expect(redactUrl(`https://app.com/invite/${uuid}`, EMPTY_RULES)).toBe(
        `https://app.com/invite/${REDACTED}`,
      );
      // Non-sensitive routes preserve standard UUID identifiers
      expect(redactUrl(`https://app.com/users/${uuid}`, EMPTY_RULES)).toBe(
        `https://app.com/users/${uuid}`,
      );
    });

    it('preserves ordinary resource IDs, slugs, and OAuth providers (negative test)', () => {
      // Ordinary numeric IDs
      expect(redactUrl('https://app.com/invite/123', EMPTY_RULES)).toBe(
        'https://app.com/invite/123',
      );
      expect(redactUrl('https://app.com/users/42/profile', EMPTY_RULES)).toBe(
        'https://app.com/users/42/profile',
      );
      expect(redactUrl('https://app.com/reset-password/42', EMPTY_RULES)).toBe(
        'https://app.com/reset-password/42',
      );

      // Ordinary action verbs
      expect(redactUrl('https://app.com/reset-password/confirm', EMPTY_RULES)).toBe(
        'https://app.com/reset-password/confirm',
      );
      expect(redactUrl('https://app.com/magic-link/request', EMPTY_RULES)).toBe(
        'https://app.com/magic-link/request',
      );
      expect(redactUrl('https://app.com/invite/accept', EMPTY_RULES)).toBe(
        'https://app.com/invite/accept',
      );

      // Known OAuth identity providers in callbacks
      expect(redactUrl('https://app.com/auth/callback/google', EMPTY_RULES)).toBe(
        'https://app.com/auth/callback/google',
      );
      expect(redactUrl('https://app.com/auth/callback/github', EMPTY_RULES)).toBe(
        'https://app.com/auth/callback/github',
      );

      // Human-readable hyphenated slug identifiers
      expect(redactUrl('https://app.com/invite/team-lead-invitation', EMPTY_RULES)).toBe(
        'https://app.com/invite/team-lead-invitation',
      );
      expect(redactUrl('https://app.com/projects/my-cool-app', EMPTY_RULES)).toBe(
        'https://app.com/projects/my-cool-app',
      );
    });

    it('redacts recognized secrets in query param values even under generic names', () => {
      const out = redactUrl(
        'https://api.com/v1/webhook?redirect=https://foo.bar&data=AKIAIOSFODNN7EXAMPLE',
        EMPTY_RULES,
      );
      expect(out).toBe(`https://api.com/v1/webhook?redirect=https://foo.bar&data=${REDACTED}`);
    });
  });
});

describe('redactTextValues', () => {
  it('redacts JSON Web Tokens (JWT)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const res = redactTextValues(`Bearer ${jwt}`);
    expect(res.count).toBe(1);
    expect(res.text).toBe(`Bearer ${REDACTED}`);
  });

  it('redacts GitHub Personal Access Tokens (classic and fine-grained)', () => {
    const classic = ['ghp', '123456789012345678901234567890123456'].join('_');
    const fineGrained = ['github', 'pat', '11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    const res = redactTextValues(`Tokens: ${classic} and ${fineGrained}`);
    expect(res.count).toBe(2);
    expect(res.text).toBe(`Tokens: ${REDACTED} and ${REDACTED}`);
  });

  it('redacts Stripe secret and restricted API keys', () => {
    // Constructed with join to prevent false positives in git secret scanners
    const stripeLive = ['sk', 'live', '51Abcdefghijklmnopqrstuv'].join('_');
    const stripeRestricted = ['rk', 'live', '51Abcdefghijklmnopqrstuv'].join('_');
    const res = redactTextValues(`Keys: ${stripeLive} and ${stripeRestricted}`);
    expect(res.count).toBe(2);
    expect(res.text).toBe(`Keys: ${REDACTED} and ${REDACTED}`);
  });

  it('redacts PEM private key blocks', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y...\n-----END RSA PRIVATE KEY-----';
    const res = redactTextValues(`Certificate payload:\n${pem}`);
    expect(res.count).toBe(1);
    expect(res.text).toBe(`Certificate payload:\n${REDACTED}`);
  });

  it('redacts AWS Access Key IDs as credential identifiers', () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const res = redactTextValues(`Access key: ${awsKey}`);
    expect(res.count).toBe(1);
    expect(res.text).toBe(`Access key: ${REDACTED}`);
  });

  it('redacts multiple mixed secrets in a single text string', () => {
    const stripe = ['sk', 'live', '51Abcdefghijklmnopqrstuv'].join('_');
    const text =
      `AWS: AKIAIOSFODNN7EXAMPLE, GitHub: ghp_123456789012345678901234567890123456, Stripe: ${stripe}`;
    const res = redactTextValues(text);
    expect(res.count).toBe(3);
    expect(res.text).toBe(`AWS: ${REDACTED}, GitHub: ${REDACTED}, Stripe: ${REDACTED}`);
  });

  it('is idempotent when run on already-sanitized text', () => {
    const first = redactTextValues('Token: ghp_123456789012345678901234567890123456');
    const second = redactTextValues(first.text);
    expect(second.text).toBe(first.text);
    expect(second.count).toBe(0);
  });

  it('does not redact benign text or numbers', () => {
    const input = 'Order #12345 shipped to user_987 on 2026-11-16';
    const res = redactTextValues(input);
    expect(res.count).toBe(0);
    expect(res.text).toBe(input);
  });
});

describe('redactBody — value-based detection', () => {
  it('redacts root-level JSON strings containing secret values (regression)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlF54m5dK_Zc';
    const input = JSON.stringify(jwt);
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(JSON.parse(text)).toBe(REDACTED);
  });

  it('redacts JWTs inside generic JSON property names', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlF54m5dK_Zc';
    const input = JSON.stringify({ data: jwt, timestamp: 123456 });
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(JSON.parse(text)).toEqual({ data: REDACTED, timestamp: 123456 });
  });

  it('redacts secrets inside JSON arrays', () => {
    const key = ['sk', 'live', '51Abcdefghijklmnopqrstuv'].join('_');
    const input = JSON.stringify({ items: ['normal', key, 'another'] });
    const { text, redacted } = redactBody(input, 'application/json', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(JSON.parse(text)).toEqual({ items: ['normal', REDACTED, 'another'] });
  });

  it('redacts secrets in form-urlencoded bodies under generic keys', () => {
    const key = ['sk', 'live', '51Abcdefghijklmnopqrstuv'].join('_');
    const input = `redirect_uri=https://app.com&state=${key}`;
    const { text, redacted } = redactBody(input, 'application/x-www-form-urlencoded', EMPTY_RULES);
    expect(redacted).toBe(true);
    expect(text).toBe(`redirect_uri=https://app.com&state=${REDACTED}`);
  });
});

describe('auditSessionRedactions', () => {
  const session = {
    id: 'sess_audit',
    name: 'Audit test',
    startedAt: 1000,
    initialUrl: 'https://app.com',
    tabs: [],
    settings: {
      redactionEnabled: true,
      customRedaction: EMPTY_RULES,
    } as any,
    status: 'stopped' as any,
    counts: {},
    assetBytes: 0,
  } as Session;

  it('reports affected events accurately by stream without false precision', () => {
    const events: SessionEvent[] = [
      {
        id: 'e1',
        sessionId: 'sess_audit',
        t: 10,
        type: 'net-request',
        payload: {
          requestId: 'r1',
          method: 'GET',
          url: `https://app.com/reset-password/${REDACTED}`,
          requestHeaders: [{ name: 'Authorization', value: REDACTED }],
          responseHeaders: [],
          responseBody: { present: true, text: `{"data":"${REDACTED}"}` },
        },
      } as any,
      {
        id: 'e2',
        sessionId: 'sess_audit',
        t: 20,
        type: 'console',
        payload: {
          level: 'error',
          text: `Stripe key failed: ${REDACTED}`,
        },
      } as any,
      {
        id: 'e3',
        sessionId: 'sess_audit',
        t: 30,
        type: 'error',
        payload: {
          origin: 'exception',
          message: `Uncaught Error with token ${REDACTED}`,
          stack: `at login (https://app.com/login.js:12:3)`,
        },
      } as any,
      {
        id: 'e4',
        sessionId: 'sess_audit',
        t: 40,
        type: 'input',
        payload: {
          descriptor: { tag: 'input' },
          value: REDACTED,
          redacted: true,
        },
      } as any,
    ];

    const audit = auditSessionRedactions(session, events);
    expect(audit.enabled).toBe(true);
    // e1 has multiple redacted fields, but counts as exactly 1 affected network request
    expect(audit.affectedEvents).toBe(4);
    expect(audit.byStream.networkRequests).toBe(1);
    expect(audit.byStream.consoleLogs).toBe(1);
    expect(audit.byStream.exceptions).toBe(1);
    expect(audit.byStream.formInputs).toBe(1);
  });

  it('reports disabled state when redaction was turned off', () => {
    const disabledSession = {
      ...session,
      settings: { ...session.settings, redactionEnabled: false },
    };
    const audit = auditSessionRedactions(disabledSession, []);
    expect(audit.enabled).toBe(false);
  });
});
