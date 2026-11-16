import { describe, expect, it } from 'vitest';
import { buildCurlCommand, shellQuote } from './curl';
import type { NetRequestPayload } from '@/lib/session/types';

function makeReq(overrides: Partial<NetRequestPayload> = {}): NetRequestPayload {
  return {
    requestId: 'req-1',
    method: 'GET',
    url: 'https://api.example.com/v1/items',
    requestHeaders: [],
    responseHeaders: [],
    ...overrides,
  };
}

describe('shellQuote', () => {
  it('wraps values in single quotes and escapes internal single quotes', () => {
    expect(shellQuote("it's $(rm -rf /) `whoami`")).toBe(
      `'it'\\''s $(rm -rf /) \`whoami\`'`,
    );
  });

  it('strips NUL bytes to prevent shell argument truncation', () => {
    expect(shellQuote('hello\0world')).toBe("'helloworld'");
  });
});

describe('buildCurlCommand', () => {
  it('builds a clean GET command without -X flag', () => {
    const cmd = buildCurlCommand(makeReq());
    expect(cmd).toBe("curl 'https://api.example.com/v1/items'");
  });

  it('includes -X method, filtered headers, and --data-raw for POST requests', () => {
    const cmd = buildCurlCommand(
      makeReq({
        method: 'POST',
        url: 'https://api.example.com/v1/checkout',
        requestHeaders: [
          { name: ':method', value: 'POST' },
          { name: ':path', value: '/v1/checkout' },
          { name: 'Host', value: 'api.example.com' },
          { name: 'Content-Length', value: '24' },
          { name: 'Connection', value: 'keep-alive' },
          { name: 'Accept-Encoding', value: 'gzip, deflate, br' },
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Authorization', value: '«redacted»' },
        ],
        requestBody: {
          present: true,
          mime: 'application/json',
          text: '{"plan":"pro","note":"O\'Connor"}',
        },
      }),
    );

    expect(cmd).toBe(
      [
        `curl -X 'POST' 'https://api.example.com/v1/checkout'`,
        `-H 'Content-Type: application/json'`,
        `-H 'Authorization: «redacted»'`,
        `--data-raw '{"plan":"pro","note":"O'\\''Connor"}'`,
      ].join(' \\\n  '),
    );
  });

  it('does not emit --data-raw when only a compacted bodyShape summary exists', () => {
    const cmd = buildCurlCommand(
      makeReq({
        method: 'POST',
        bodyShape: { request: '{ items: Array(5) }' },
      }),
    );

    expect(cmd).toBe("curl -X 'POST' 'https://api.example.com/v1/items'");
  });

  it('returns null for websocket entries', () => {
    const cmd = buildCurlCommand(makeReq({ websocket: true }));
    expect(cmd).toBeNull();
  });
});
