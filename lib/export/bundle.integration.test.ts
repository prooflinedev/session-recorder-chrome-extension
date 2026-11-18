/**
 * End-to-end export pipeline check: fixture session -> trimmer -> markdown ->
 * bundle -> zip. Exercises every export module together with realistic data.
 */
import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';

import { SessionBuilder } from '@/lib/fixtures/session-builder';
import { ConsoleCapturer } from '@/lib/capture/console';
import { PROTECTED_TYPES, scoreEvent } from '@/lib/session/events';
import { makeDefaultSettings } from '@/lib/session/settings';
import { summaryEvidence } from '@/lib/sharing/summary';
import { buildBundle, estimateForLevels } from './bundle';
import { zipFiles } from './zip';
import type { RawEvent, SessionEvent, VerbosityLevel } from '@/lib/session/types';

function richSession() {
  const b = new SessionBuilder({ name: 'Checkout bug repro' })
    .nav('https://app.example.com/dashboard', 'Dashboard')
    .click('Open cart')
    .screenshot('interaction')
    .net('GET', 'https://api.example.com/cart', { status: 200, resBody: JSON.stringify({ items: [{ id: 1, name: 'Widget', price: 9.99 }, { id: 2, name: 'Gadget', price: 19.99 }], total: 29.98 }), mime: 'application/json' })
    .input('coupon', 'SAVE10')
    .marker('Bug happens here')
    .note('The total does not update after applying the coupon')
    .voice('So I click apply and you can see the total stays the same, that is the bug', 4000, 9000)
    .net('POST', 'https://api.example.com/cart/coupon', { status: 500, reqBody: JSON.stringify({ code: 'SAVE10' }), resBody: JSON.stringify({ error: 'internal error', trace: 'NullPointer at CouponService.apply' }), mime: 'application/json' })
    .consoleLog('error', 'Failed to apply coupon: 500')
    .error('Uncaught TypeError: cannot read property total of undefined')
    .annotation();
  // repeated polling to exercise request collapsing
  for (let i = 0; i < 8; i += 1) {
    b.net('GET', `https://api.example.com/cart/status?poll=${i}`, { status: 200, resBody: JSON.stringify({ ready: false }), mime: 'application/json' });
  }
  // static assets that should be dropped at higher levels
  b.net('GET', 'https://cdn.example.com/logo.png', { status: 200, mime: 'image/png' });
  b.net('GET', 'https://cdn.example.com/app.css', { status: 200, mime: 'text/css' });
  b.scroll().click('Checkout').screenshot('interaction').file('invoice.pdf', 24000);
  return b.build();
}

describe('export pipeline (integration)', () => {
  it('redacts browser diagnostic URLs before they reach storage, exports or summaries', async () => {
    const settings = makeDefaultSettings();
    settings.customRedaction.urlParamPatterns = ['ticket'];
    const fixture = new SessionBuilder({ settings }).build();
    const events: SessionEvent[] = [];
    const capture = new ConsoleCapturer((raw: RawEvent) => {
      events.push({
        ...raw,
        id: `evt_${events.length}`,
        sessionId: fixture.session.id,
        t: events.length * 100,
        importance: scoreEvent(raw),
        protected: PROTECTED_TYPES.has(raw.type),
      } as SessionEvent);
    }, () => settings);
    const url = 'https://api.example.test/data?token=secret-token&ticket=private-ticket&page=2';
    const stackTrace = {
      callFrames: [{ functionName: 'load', url, lineNumber: 5, columnNumber: 9 }],
    };
    capture.handle(1, 'Log.entryAdded', {
      entry: { level: 'error', text: `Access to fetch at '${url}' blocked by CORS policy`, stackTrace },
    });
    capture.handle(1, 'Log.entryAdded', {
      entry: { level: 'warning', text: 'Failed to load resource', url, lineNumber: 7, args: [{ value: url }] },
    });
    capture.handle(1, 'Runtime.consoleAPICalled', {
      type: 'warning', args: [{ value: { requestUrl: url } }], stackTrace,
    });
    capture.handle(1, 'Runtime.exceptionThrown', {
      exceptionDetails: { exception: { description: `Error: Request failed at ${url}` }, stackTrace },
    });
    capture.handle(1, 'Runtime.exceptionThrown', {
      exceptionDetails: { exception: { description: `Error: Request failed\n    at load (${url})` } },
    });
    capture.reset();

    const expectRedacted = (text: string) => {
      expect(text).not.toContain('secret-token');
      expect(text).not.toContain('private-ticket');
      expect(text).toContain('token=«redacted»&ticket=«redacted»&page=2');
    };
    expect(events).toHaveLength(5);
    // The callback is the background's storage boundary, before any exporter.
    expectRedacted(JSON.stringify(events));
    expect(JSON.stringify(events)).toContain('blocked by CORS policy');
    expect(events[0]!.payload).toMatchObject({
      stack: '    at load (https://api.example.test/data?token=«redacted»&ticket=«redacted»&page=2:5:9)',
    });
    expectRedacted(summaryEvidence(fixture.session, events, []));
    for (const level of ['L0', 'L1', 'L2', 'L3'] as VerbosityLevel[]) {
      const files = await buildBundle({ ...fixture, events, level });
      for (const file of ['report.md', 'session.json']) {
        expectRedacted(files.find((entry) => entry.path === file)!.text!);
      }
    }
  });

  it('produces a readable, shrinking report across all levels and a valid zip', async () => {
    const { session, events, assets } = richSession();
    const levels: VerbosityLevel[] = ['L0', 'L1', 'L2', 'L3'];

    const reportSizes: Record<string, number> = {};
    for (const level of levels) {
      const files = await buildBundle({ session, events, assets, level });
      const report = files.find((f) => f.path === 'report.md');
      const sessionJson = files.find((f) => f.path === 'session.json');
      expect(report?.text, `report.md exists at ${level}`).toBeTruthy();
      expect(sessionJson?.text, `session.json exists at ${level}`).toBeTruthy();

      const md = report!.text!;
      reportSizes[level] = md.length;

      // Protected signals must survive at EVERY level.
      expect(md, `${level} keeps marker`).toContain('Bug happens here');
      expect(md, `${level} keeps note`).toContain('does not update');
      expect(md, `${level} keeps transcript`).toContain('that is the bug');
      expect(md, `${level} keeps the error`).toContain('TypeError');
      // session.json must be valid JSON.
      JSON.parse(sessionJson!.text!);

      // Zip round-trips and contains report.md under the root dir.
      const bytes = await zipFiles(files, `session-${level}`);
      const unzipped = unzipSync(bytes);
      const keys = Object.keys(unzipped);
      expect(keys.some((k) => k === `session-${level}/report.md`), `${level} zip has report.md`).toBe(true);
    }

    // Verbosity should reduce size monotonically (L0 >= L1 >= L2 >= L3).
    expect(reportSizes.L0).toBeGreaterThan(reportSizes.L1!);
    expect(reportSizes.L1).toBeGreaterThan(reportSizes.L2!);
    // Minimal must be strictly more aggressive than Compact.
    expect(reportSizes.L2).toBeGreaterThan(reportSizes.L3!);

    // Token estimates should be present and decreasing.
    const meta = assets.map(({ blob, ...m }) => m);
    const estimates = estimateForLevels(events, meta, session);
    expect(estimates.length).toBe(4);
    expect(estimates[0]!.tokens).toBeGreaterThanOrEqual(estimates[3]!.tokens);
  });
});

describe('export pipeline OpenAPI compilation (captureApiSpec)', () => {
  function apiSpecSession() {
    const settings = { ...makeDefaultSettings(), captureApiSpec: true };
    const b = new SessionBuilder({ name: 'API walkthrough', settings })
      .nav('https://app.example.com/dashboard', 'Dashboard')
      .net('POST', 'https://api.example.com/api/users', {
        status: 200,
        reqBody: '{"name":"Ada"}',
        resBody: '{"id":1,"name":"Ada"}',
      })
      .net('GET', 'https://api.example.com/api/users/1', {
        status: 200,
        resBody: '{"id":1,"name":"Ada"}',
      })
      .net('GET', 'https://cdn.example.com/logo.png', { status: 200, mime: 'image/png' });
    return b.build();
  }

  it('adds a valid openapi.json at every level and mentions it in report.md', async () => {
    const { session, events, assets } = apiSpecSession();
    for (const level of ['L0', 'L3'] as VerbosityLevel[]) {
      const files = await buildBundle({ session, events, assets, level });
      const openapi = files.find((f) => f.path === 'openapi.json');
      expect(openapi?.text, `openapi.json exists at ${level}`).toBeTruthy();
      const spec = JSON.parse(openapi!.text!) as Record<string, any>;
      expect(spec.openapi).toBe('3.1.0');
      // Compiled from UNTRIMMED events: bodies stripped at L3 must not starve it.
      expect(spec.paths['/api/users'].post.responses['200']).toBeTruthy();
      expect(spec.paths['/api/users/{userId}'].get).toBeTruthy();
      expect(spec.paths['/logo.png']).toBeUndefined();

      const report = files.find((f) => f.path === 'report.md');
      expect(report!.text).toContain('openapi.json');
    }
  });

  it('resolves full stored bodies from net-body assets when inline text is truncated', async () => {
    const { session, events, assets } = apiSpecSession();
    const full = '{"id":1,"name":"Ada","email":"ada@example.com"}';
    assets.push({
      id: 'asset_full',
      sessionId: session.id,
      kind: 'net-body',
      mime: 'application/json',
      size: full.length,
      blob: new Blob([full], { type: 'application/json' }),
    });
    const net = events.find(
      (e) => e.type === 'net-request' && e.payload.method === 'GET' && e.payload.url.includes('/api/users/1'),
    ) as Extract<(typeof events)[number], { type: 'net-request' }>;
    net.payload.responseBody = {
      present: true,
      mime: 'application/json',
      text: '{"id":1,"na',
      truncated: true,
      originalSize: full.length,
      assetId: 'asset_full',
    };

    const files = await buildBundle({ session, events, assets, level: 'L0' });
    const spec = JSON.parse(files.find((f) => f.path === 'openapi.json')!.text!) as Record<string, any>;
    const schema = spec.paths['/api/users/{userId}'].get.responses['200'].content['application/json'].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['email', 'id', 'name']);
  });

  it('omits openapi.json when the setting is off or there is no API traffic', async () => {
    // Flag off: same traffic, no spec, no report mention.
    const off = richSession();
    expect(off.session.settings.captureApiSpec).toBe(false);
    const offFiles = await buildBundle({ ...off, level: 'L0' });
    expect(offFiles.find((f) => f.path === 'openapi.json')).toBeUndefined();
    expect(offFiles.find((f) => f.path === 'report.md')!.text).not.toContain('openapi.json');

    // Flag on but no API requests: no spec either.
    const settings = { ...makeDefaultSettings(), captureApiSpec: true };
    const quiet = new SessionBuilder({ name: 'No API', settings })
      .nav('https://app.example.com/', 'Home')
      .click('About')
      .build();
    const quietFiles = await buildBundle({ ...quiet, level: 'L0' });
    expect(quietFiles.find((f) => f.path === 'openapi.json')).toBeUndefined();
  });
});
