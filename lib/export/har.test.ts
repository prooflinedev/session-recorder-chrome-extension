import { describe, it, expect } from 'vitest';

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

  it('flags a request unfinished at stop as pending', () => {
    const { session, events } = new SessionBuilder()
      .net('GET', 'https://api.example.com/hang')
      .net('GET', 'https://api.example.com/stream', { status: 500 })
      .net('GET', 'https://api.example.com/done')
      .build();
    const nets = events.flatMap((e) => (e.type === 'net-request' ? [e.payload] : []));
    for (const p of nets.slice(0, 2)) {
      p.pending = true;
      delete p.timing!.durationMs;
      delete p.responseBody;
    }
    delete nets[0]!.status;
    delete nets[0]!.statusText;
    const [hang, stream, done] = (buildHar(session, events) as any).log.entries;

    expect(hang.response.status).toBe(0);
    expect(hang._pending).toBe(true);
    expect(hang.comment).toMatch(/^Pending: the request had not finished/);
    expect(hang.time).toBe(0);
    expect(hang.startedDateTime).toBe(new Date(nets[0]!.timing!.startedAt).toISOString());
    expect(stream.response.status).toBe(500);
    expect(stream._pending).toBe(true);
    expect(done._pending).toBeUndefined();
    expect(done.comment).toBeUndefined();
  });

  it('keeps the collapsed note alongside the pending note', () => {
    const { session, events } = new SessionBuilder()
      .net('GET', 'https://api.example.com/poll')
      .build();
    const p = firstRequest(events);
    p.pending = true;
    p.collapsed = { count: 3, statuses: [0, 200], note: '3 more requests collapsed' };
    const [entry] = (buildHar(session, events) as any).log.entries;

    expect(entry.comment).toMatch(/^Shown once for 3 similar requests/);
    expect(entry.comment).toMatch(/Pending: the request had not finished/);
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
