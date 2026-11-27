/**
 * URL-bearing headers must not carry secret query values into the export.
 * Records a same-origin page whose URL has a secret in its query (sent back as
 * `Referer`), then fetches a redirect whose `Location` has one, then downloads
 * the Full ZIP and checks session.json, network.har (incl. `redirectURL`) and
 * report.md.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string }; error?: string };
type EventsRes = { events: Array<{ type: string; payload: any }> };

const REFERER_SECRET = 'FAKE-ref-5b2e91';
const LOCATION_SECRET = 'FAKE-loc-7d04a3';

test('masks secret query values in Referer and Location, in session.json and the HAR redirectURL', async ({
  context,
  background,
  extensionId,
}) => {
  // Same origin for the page and the redirect, so Chrome sends the full page URL
  // (query included) as Referer.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/start') {
      res.writeHead(302, { Location: `/landing?access_token=${LOCATION_SECRET}&page=2` }).end();
    } else if (url.pathname === '/landing') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    } else {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>url headers</title><h1>url headers</h1>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const page = await context.newPage();
    await page.goto(`${origin}/page?session_id=${REFERER_SECRET}&tab=2`);
    const tabId = await tabIdForUrl(background, origin);
    const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
    expect(started.ok).toBe(true);
    const sessionId = started.session!.id;
    await page.waitForTimeout(800);
    await page.evaluate(() => fetch('/start'));
    await page.waitForTimeout(1200);
    await dispatch(background, { kind: 'session/stop' });

    // Guard against a vacuous pass: the 302 hop was captured with both headers,
    // already masked, while the non-secret params survive.
    const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });
    const hop = events.find(
      (e) => e.type === 'net-request' && String(e.payload?.url).endsWith('/start'),
    );
    expect(hop, 'the /start redirect hop was captured').toBeTruthy();
    const header = (hs: Array<{ name: string; value: string }>, name: string) =>
      hs.find((h) => h.name.toLowerCase() === name)?.value;
    expect(header(hop!.payload.responseHeaders, 'location')).toBe(
      '/landing?access_token=«redacted»&page=2',
    );
    expect(header(hop!.payload.requestHeaders, 'referer')).toBe(
      `${origin}/page?session_id=«redacted»&tab=2`,
    );

    // Export the Full ZIP through the real UI.
    const workspace = await context.newPage();
    await workspace.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
    const opened = context.waitForEvent('page');
    await workspace.getByRole('link', { name: 'Full timeline' }).click();
    const sp = await opened;
    await sp.evaluate(() => {
      (window as any).__dl = null;
      chrome.downloads.download = (async (opts: { url: string; filename: string }) => {
        const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
        (window as any).__dl = { bytes: Array.from(new Uint8Array(buf)) };
        return 1;
      }) as typeof chrome.downloads.download;
    });
    await sp.getByRole('button', { name: 'Full', exact: true }).click();
    await sp.getByRole('button', { name: /Download .zip/i }).click();
    await sp.waitForFunction(() => (window as any).__dl !== null, undefined, {
      timeout: 20_000,
    });
    const dl = (await sp.evaluate(() => (window as any).__dl)) as { bytes: number[] };

    const files = unzipSync(Uint8Array.from(dl.bytes));
    const text = (suffix: string): string => {
      const key = Object.keys(files).find((k) => k.endsWith(suffix));
      expect(key, `zip contains ${suffix}`).toBeTruthy();
      return new TextDecoder().decode(files[key!]);
    };

    const har = JSON.parse(text('/network.har'));
    const entry = har.log.entries.find((e: any) => e.request.url.endsWith('/start'));
    expect(entry, 'HAR has the redirect request').toBeTruthy();
    expect(entry.response.redirectURL).toBe('/landing?access_token=«redacted»&page=2');

    for (const file of ['/network.har', '/session.json', '/report.md']) {
      expect(text(file), `${file} has no Location secret`).not.toContain(LOCATION_SECRET);
    }

    // The Referer secret is the page's own URL, which is also recorded as
    // session.initialUrl and in the Tabs table. This change does not touch those
    // (page URLs are open PR #37), so check where headers are stored: the HAR and
    // the events in session.json.
    expect(text('/network.har'), 'network.har has no Referer secret').not.toContain(
      REFERER_SECRET,
    );
    const exported = JSON.parse(text('/session.json'));
    expect(
      JSON.stringify(exported.events),
      'session.json events have no Referer secret',
    ).not.toContain(REFERER_SECRET);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
