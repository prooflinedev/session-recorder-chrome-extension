/**
 * Analytics/telemetry noise dropping. First-party ingest endpoints (e.g. an app
 * POSTing to `/ingest/i/v0/e`) live on the app's own host, so the host-based
 * matcher misses them — the path matcher in `dropStaticAssets` must catch them.
 * Errors (status>=400) and protected events always survive.
 */

import { describe, expect, it } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import type { AssetMeta, SessionEvent } from '@/lib/session/types';
import { applyLevel, isTelemetry, type TrimContext } from './trimmer';

const netEvents = (events: SessionEvent[]) =>
  events.filter(
    (e): e is Extract<SessionEvent, { type: 'net-request' }> =>
      e.type === 'net-request',
  );

const urls = (events: SessionEvent[]) =>
  netEvents(events).map((e) => e.payload.url);

function buildFixture(): { events: SessionEvent[]; ctx: TrimContext } {
  const b = new SessionBuilder();

  b.nav('https://app.example.com/dashboard', 'Dashboard');

  // First-party amplitude-style ingest on the app's OWN host: several POSTs.
  for (let i = 0; i < 4; i++) {
    b.net('POST', 'https://app.example.com/ingest/i/v0/e', {
      status: 200,
      reqBody: `{"events":[{"n":${i}}]}`,
    });
  }

  // A normal API GET → must survive.
  b.net('GET', 'https://app.example.com/api/x', {
    status: 200,
    resBody: '{"ok":true}',
  });

  // A failing analytics ingest (500) → escape hatch keeps it.
  b.net('POST', 'https://app.example.com/ingest/i/v0/e', {
    status: 500,
    reqBody: '{"events":[{"boom":true}]}',
  });

  const { session, events, assets } = b.build();
  const assetsById = new Map<string, AssetMeta>(
    assets.map((a) => {
      const { blob: _blob, ...meta } = a;
      return [a.id, meta];
    }),
  );
  return { events, ctx: { assetsById, settings: session.settings } };
}

describe('trimmer analytics noise', () => {
  it('drops healthy /ingest analytics POSTs at L1 while /api/x survives', () => {
    const { events, ctx } = buildFixture();
    const out = applyLevel(events, 'L1', ctx);
    const outUrls = urls(out);

    // The healthy ingest POSTs are gone.
    const healthyIngest = netEvents(out).filter(
      (e) => e.payload.url.includes('/ingest') && e.payload.status !== 500,
    );
    expect(healthyIngest).toHaveLength(0);

    // The normal API request survives.
    expect(outUrls).toContain('https://app.example.com/api/x');
  });

  it('keeps a failing (500) /ingest request via the error escape hatch', () => {
    const { events, ctx } = buildFixture();
    const out = applyLevel(events, 'L1', ctx);
    const survivingIngest = netEvents(out).filter((e) =>
      e.payload.url.includes('/ingest'),
    );
    expect(survivingIngest).toHaveLength(1);
    expect(survivingIngest[0]?.payload.status).toBe(500);
  });

  it('also drops analytics at L2 and L3', () => {
    const { events, ctx } = buildFixture();
    for (const lvl of ['L2', 'L3'] as const) {
      const out = applyLevel(events, lvl, ctx);
      const healthyIngest = netEvents(out).filter(
        (e) => e.payload.url.includes('/ingest') && e.payload.status !== 500,
      );
      expect(healthyIngest).toHaveLength(0);
      expect(urls(out)).toContain('https://app.example.com/api/x');
    }
  });
});

describe('isTelemetry', () => {
  it.each([
    // Third-party analytics hosts.
    'https://www.google-analytics.com/g/collect?v=2',
    'https://api.segment.io/v1/batch',
    'https://api2.amplitude.com/2/httpapi',
    'https://o1.ingest.sentry.io/api/7/envelope/',
    'https://www.google.com/pagead/1p-conversion/123/',
    'https://www.facebook.com/tr?id=1&ev=PageView',
    'https://www.facebook.com/tr.php?id=1&ev=PageView',
    'https://www.google.com:8443/pagead/1p-conversion/123/',
    // First-party collectors on the app's own host.
    'https://app.example.com/ingest/i/v0/e',
    'https://app.example.com/ingest/decide?v=3',
    'https://app.example.com/e/',
    'https://app.example.com/g/collect?v=2',
    'https://app.example.com/batch/',
    'https://app.example.com/posthog/e/',
    // URLs that do not parse as absolute.
    'api.segment.io/v1/batch',
    '/ingest/e?ip=1',
    '/batch?x=1',
    '/batch#fragment',
  ])('treats %s as telemetry', (url) => {
    expect(isTelemetry({ url })).toBe(true);
  });

  it.each([
    // Generic words used as ordinary application routes.
    'https://shop.example.com/api/orders/batch',
    'https://music.example.com/api/playlists/12/track',
    'https://app.example.com/api/v2/collect',
    'https://www.googleapis.com/batch/drive/v3',
    'https://app.example.com/api/payments/e/confirm',
    'https://app.example.com/api/ingest/upload',
    // Host words in the query string or path are not the host.
    'https://app.example.com/graphql?fields=user.stats',
    'https://app.example.com/api/report.metrics',
    'https://app.example.com/api/search?q=google.com/ads',
    '/graphql?fields=user.stats',
    // Bare routes that are not exclusively analytics.
    'https://pay.example.com/capture',
    'https://flags.example.com/decide',
  ])('keeps the application request %s', (url) => {
    expect(isTelemetry({ url })).toBe(false);
  });
});

describe('trimmer keeps application requests named like collectors', () => {
  it('keeps a healthy POST /api/orders/batch at every trimmed level', () => {
    const b = new SessionBuilder();
    b.nav('https://shop.example.com/cart', 'Cart');
    b.net('POST', 'https://shop.example.com/api/orders/batch', {
      status: 200,
      reqBody: '{"items":[1,2]}',
      resBody: '{"orderIds":[]}',
    });
    b.net('POST', 'https://shop.example.com/ingest/e', { status: 200 });
    const { session, events } = b.build();
    const ctx: TrimContext = { assetsById: new Map(), settings: session.settings };
    for (const lvl of ['L1', 'L2', 'L3'] as const) {
      const out = urls(applyLevel(events, lvl, ctx));
      expect(out).toContain('https://shop.example.com/api/orders/batch');
      expect(out).not.toContain('https://shop.example.com/ingest/e');
    }
  });
});
