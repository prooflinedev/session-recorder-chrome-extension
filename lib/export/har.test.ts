import { describe, it, expect } from 'vitest';

import { redactHeaders, redactUrl } from '@/lib/capture/redaction';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import type { NetRequestPayload, SessionEvent } from '@/lib/session/types';
import { buildBundle, type ExportFile } from './bundle';
import { buildHar } from './har';

function firstRequest(events: SessionEvent[]): NetRequestPayload {
  const e = events.find((ev) => ev.type === 'net-request');
  return e!.payload as NetRequestPayload;
}

function harFile(files: ExportFile[]): any {
  const file = files.find((f) => f.path === 'network.har');
  return file ? JSON.parse(file.text!) : undefined;
}

describe('buildHar', () => {
  it('returns null when no request was captured', () => {
    const { session, events } = new SessionBuilder().click('Save').build();
    expect(buildHar(session, events)).toBeNull();
  });

  it('maps a captured request to a HAR 1.2 entry', () => {
    const { session, events } = new SessionBuilder()
      .net('POST', 'https://api.example.com/cart/coupon?dry=1&x=a%20b', {
        status: 500,
        reqBody: '{"code":"SAVE10"}',
        resBody: '{"error":"internal"}',
      })
      .build();
    const har = buildHar(session, events) as any;

    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(har.log.entries).toHaveLength(1);
    const [entry] = har.log.entries;
    expect(entry.startedDateTime).toBe(
      new Date(firstRequest(events).timing!.startedAt).toISOString(),
    );
    expect(entry.time).toBe(42);
    expect(entry.timings).toEqual({ send: 0, wait: 42, receive: 0 });
    expect(entry.request).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/cart/coupon?dry=1&x=a%20b',
      queryString: [
        { name: 'dry', value: '1' },
        { name: 'x', value: 'a b' },
      ],
      postData: { mimeType: 'application/json', text: '{"code":"SAVE10"}' },
      bodySize: 17,
    });
    expect(entry.response).toMatchObject({
      status: 500,
      statusText: 'Error',
      content: {
        size: 20,
        mimeType: 'application/json',
        text: '{"error":"internal"}',
      },
    });
    expect(entry.response.content.comment).toBeUndefined();
    expect(entry.comment).toBeUndefined();
  });

  it('keeps binary bodies base64 with their decoded size', () => {
    const { session, events } = new SessionBuilder()
      .net('GET', 'https://cdn.example.com/pixel.png', { mime: 'image/png' })
      .build();
    firstRequest(events).responseBody = {
      present: true,
      mime: 'image/png',
      text: 'AAEC/w==',
      base64: true,
    };
    const har = buildHar(session, events) as any;

    expect(har.log.entries[0].response.content).toEqual({
      size: 4,
      mimeType: 'image/png',
      text: 'AAEC/w==',
      encoding: 'base64',
    });
  });

  it('flags partial bodies and network failures', () => {
    const { session, events } = new SessionBuilder()
      .net('GET', 'https://api.example.com/report')
      .build();
    const p = firstRequest(events);
    delete p.status;
    delete p.statusText;
    p.failed = true;
    p.failureReason = 'net::ERR_CONNECTION_RESET';
    p.responseBody = {
      present: true,
      text: '{"rows":[',
      truncated: true,
      originalSize: 5000,
    };
    const [entry] = (buildHar(session, events) as any).log.entries;

    expect(entry.response.status).toBe(0);
    expect(entry.response._error).toBe('net::ERR_CONNECTION_RESET');
    expect(entry.response.content.size).toBe(5000);
    expect(entry.response.content.comment).toMatch(/cut short/);
  });
});

describe('network.har in the export bundle', () => {
  function session() {
    return new SessionBuilder()
      .net('GET', 'https://api.example.com/dashboard', {
        resBody: '{"widgets":["revenue"]}',
      })
      .net('POST', 'https://api.example.com/cart/coupon', {
        status: 500,
        reqBody: '{"code":"SAVE10"}',
        resBody: '{"error":"NullPointer"}',
      })
      .build();
  }

  it('carries every captured request at Full', async () => {
    const files = await buildBundle({ ...session(), level: 'L0' });
    const entries = harFile(files).log.entries;
    expect(entries.map((e: any) => e.response.status)).toEqual([200, 500]);
    expect(entries[0].response.content.text).toBe('{"widgets":["revenue"]}');
  });

  it('leaves out bodies that the export level drops', async () => {
    const files = await buildBundle({ ...session(), level: 'L3' });
    const report = files.find((f) => f.path === 'report.md')!.text!;
    const har = files.find((f) => f.path === 'network.har')!.text!;
    const statuses = JSON.parse(har).log.entries.map((e: any) => e.response.status);
    expect(statuses).toEqual([200, 500]);
    expect(report).not.toContain('revenue');
    expect(har).not.toContain('revenue');
  });

  it('notes requests that the export level collapsed', async () => {
    const b = new SessionBuilder();
    for (let i = 0; i < 6; i += 1)
      b.net('GET', 'https://api.example.com/status', { resBody: '{"ready":false}' });
    const files = await buildBundle({ ...b.build(), level: 'L2' });
    const entries = harFile(files).log.entries;
    expect(entries.length).toBeLessThan(6);
    expect(entries.some((e: any) => /Shown once for/.test(e.comment))).toBe(true);
  });

  it('is omitted when no request was captured', async () => {
    const quiet = new SessionBuilder().click('Save').build();
    const files = await buildBundle({ ...quiet, level: 'L0' });
    expect(harFile(files)).toBeUndefined();
  });
});

describe('HAR inherits capture-time redaction', () => {
  it('exports a redacted redirectURL from a scrubbed Location header', () => {
    const { session, events } = new SessionBuilder().net('GET', 'https://app/cb').build();
    firstRequest(events).responseHeaders = redactHeaders(
      [{ name: 'Location', value: 'https://idp/cb?code=S' }],
      { headerNames: [], bodyKeyPatterns: [], urlParamPatterns: [] },
    );
    const har = buildHar(session, events) as any;
    expect(har.log.entries[0].response.redirectURL).toBe('https://idp/cb?code=«redacted»');
  });

  it('exports a redacted decoded queryString for an encoded N1 carrier', () => {
    const rules = { headerNames: [], bodyKeyPatterns: [], urlParamPatterns: [] };
    const scrubbed = redactUrl('https://x/?q=%2Fcb%26token%3DS%23frag', rules);
    const { session, events } = new SessionBuilder().net('GET', scrubbed).build();
    const har = buildHar(session, events) as any;
    const q = har.log.entries[0].request.queryString.find(
      (h: { name: string }) => h.name === 'q',
    );
    expect(q.value).toBe('/cb&token=«redacted»#frag');
  });

  it('exports a redacted decoded queryString for an N1b scheme-less carrier', () => {
    const rules = { headerNames: [], bodyKeyPatterns: [], urlParamPatterns: [] };
    const scrubbed = redactUrl(
      'https://x/?q=foo%3Dbar%3Fx%3D1%23token%3DS',
      rules,
    );
    const { session, events } = new SessionBuilder().net('GET', scrubbed).build();
    const har = buildHar(session, events) as any;
    const q = har.log.entries[0].request.queryString.find(
      (h: { name: string }) => h.name === 'q',
    );
    expect(q.value).toBe('foo=bar?x=1#token=«redacted»');
  });

  it('does not rewrite raw values captured with redaction disabled', () => {
    const { session, events } = new SessionBuilder()
      .net('GET', 'https://x/?q=raw-value')
      .build();
    firstRequest(events).responseHeaders = [
      { name: 'Location', value: 'https://idp/cb?code=RAW_SECRET' },
    ];
    const har = buildHar(session, events) as any;
    expect(har.log.entries[0].request.queryString.find((h: any) => h.name === 'q').value)
      .toBe('raw-value');
    expect(har.log.entries[0].response.redirectURL).toBe('https://idp/cb?code=RAW_SECRET');
  });
});
