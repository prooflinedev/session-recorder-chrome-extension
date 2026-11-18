/**
 * A failed request's correlation IDs reach the exported report.
 *
 * The first test does not need the recorder's debugger, which may not attach
 * under Playwright (record-export.spec.ts allows for both). Two requests enter
 * through the background's real message dispatcher, the way a capture source
 * hands an event to the funnel. After that everything is the real path: the
 * funnel, IndexedDB, the report page, its Download button and the zip.
 *
 * The second test records real traffic on the demo page and needs the debugger.
 * The page sends two requests with a `traceparent`; a route fixture answers one
 * with 200 and one with 503, each with an `x-request-id`. Set E2E_PROOF_DIR to a
 * folder to save a 1280×720 screenshot of the exported report.md there; without
 * it the test writes no file.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** Click Download .zip on a report page and return the files of that zip. */
async function downloadZip(report: Page): Promise<Record<string, Uint8Array>> {
  await expect(report.getByRole('button', { name: /Download .zip/i })).toBeVisible();
  await report.evaluate(() => {
    (window as any).__dl = null;
    chrome.downloads.download = (async (opts: { url: string; filename: string }) => {
      const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
      (window as any).__dl = Array.from(new Uint8Array(buf));
      return 1;
    }) as typeof chrome.downloads.download;
  });
  await report.getByRole('button', { name: /Download .zip/i }).click();
  await report.waitForFunction(() => (window as any).__dl !== null, undefined, {
    timeout: 20_000,
  });
  return unzipSync(
    Uint8Array.from((await report.evaluate(() => (window as any).__dl)) as number[]),
  );
}

/** The bytes of the file in the zip whose path ends with `suffix`. */
function zipEntry(files: Record<string, Uint8Array>, suffix: string): Uint8Array {
  const key = Object.keys(files).find((k) => k.endsWith(suffix));
  expect(key, `zip contains ${suffix}`).toBeTruthy();
  return files[key!]!;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test('a failed request lists its correlation IDs in the exported report', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ ok: boolean; session?: { id: string } }>(
    background,
    { kind: 'session/start', tabId },
  );
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;

  const request = (path: string, status: number, serverId: string) => ({
    kind: 'capture/event',
    event: {
      type: 'net-request',
      tabId,
      payload: {
        requestId: `req${path}`,
        method: 'POST',
        url: `http://localhost:5319${path}`,
        resourceType: 'Fetch',
        status,
        requestHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'traceparent', value: TRACEPARENT },
        ],
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'X-Request-Id', value: serverId },
        ],
        requestBody: { present: true, mime: 'application/json', text: '{"cart":"c1"}' },
        responseBody: { present: true, mime: 'application/json', text: '{"ok":false}' },
      },
    },
  });
  await dispatch(
    background,
    request('/api/cart', 200, 'id-of-the-request-that-worked'),
  );
  await dispatch(background, request('/api/orders', 500, '5f1c0a52'));
  await dispatch(background, { kind: 'session/stop' });

  // Minimal is the level that trims hardest; the IDs must survive it.
  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `report.html?session=${sessionId}&level=L3`));
  const files = await downloadZip(report);
  const md = decode(zipEntry(files, '/report.md'));

  expect(md).toContain('**Verbosity level:** L3');
  expect(md).toContain(
    [
      '🌐 500 POST /api/orders',
      '- response correlation IDs: `x-request-id: 5f1c0a52`',
      `- request correlation IDs: \`traceparent: ${TRACEPARENT}\``,
    ].join('\n'),
  );
  // Only the failed request is annotated; the one that worked keeps its line.
  expect(md).toContain('🌐 200 POST /api/cart');
  expect(md).not.toContain('id-of-the-request-that-worked');
  expect(md.match(/correlation IDs/g)).toHaveLength(2);
  // session.json is unchanged: it held every header before, and still does.
  const session = decode(zipEntry(files, '/session.json'));
  expect(session).toContain('id-of-the-request-that-worked');
  expect(session).toContain('5f1c0a52');
});

/** The IDs of the recorded requests: the page's trace context and the server's name. */
const CART = {
  traceparent: '00-5b8aa5a2d2c872e8321cf37308d69df2-051581bf3cb55c13-01',
  requestId: 'c3e1f0a8-4d2b-4f6e-9a17-2b5d8c0e6f41',
};
const ORDER = {
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  requestId: '7d9f2c61-0b3e-4a58-8f24-e61c5a9b3d07',
};

test('in recorded traffic, only the failed request lists its IDs in report.md', async ({
  context,
  background,
  extensionId,
}) => {
  // The fixture: the server names each request with an x-request-id, as most
  // back ends do. The cart loads; the order fails.
  const page = await context.newPage();
  await page.route('**/api/cart', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'x-request-id': CART.requestId },
      json: { items: [{ sku: 'weekender', qty: 1 }] },
    }),
  );
  await page.route('**/api/orders', (route) =>
    route.fulfill({
      status: 503,
      headers: { 'x-request-id': ORDER.requestId },
      json: { error: 'payment_unavailable' },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Demo');

  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ ok: boolean; session?: { id: string } }>(
    background,
    { kind: 'session/start', tabId },
  );
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  // Requests are captured through the recorder's debugger; without it this
  // test has nothing real to export.
  const state = await dispatch<{ attachedTabIds: number[]; error?: string }>(
    background,
    { kind: 'session/getState' },
  );
  expect(state.attachedTabIds, `debugger not attached: ${state.error}`).toContain(
    tabId,
  );

  // What an instrumented page does: it sends its trace context with each request.
  const statuses = await page.evaluate(async ({ cart, order }) => {
    const loaded = await fetch('/api/cart', { headers: { traceparent: cart } });
    const placed = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent: order },
      body: JSON.stringify({ cart: 'c1' }),
    });
    return [loaded.status, placed.status];
  }, { cart: CART.traceparent, order: ORDER.traceparent });
  expect(statuses).toEqual([200, 503]);

  // Both requests are in the recording before it stops.
  await expect
    .poll(async () => {
      const { events } = await dispatch<{
        events: Array<{ type: string; payload: any }>;
      }>(background, { kind: 'events/get', sessionId });
      return events
        .filter((e) => e.type === 'net-request')
        .map((e) => {
          const { status, method, url } = e.payload;
          return `${status} ${method} ${new URL(url).pathname}`;
        })
        .filter((line) => line.includes('/api/'))
        .sort();
    })
    .toEqual(['200 GET /api/cart', '503 POST /api/orders']);
  await dispatch(background, { kind: 'session/stop' });

  // Export as a user does: from the report, its Full timeline, then Download .zip.
  const workspace = await context.newPage();
  await workspace.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  const opened = context.waitForEvent('page');
  await workspace.getByRole('link', { name: 'Full timeline' }).click();
  const files = await downloadZip(await opened);
  const reportBytes = zipEntry(files, '/report.md');
  const md = decode(reportBytes);

  // The failed request names itself: the server's ID and the page's trace context.
  expect(md).toContain(
    [
      '🌐 503 POST /api/orders',
      `- response correlation IDs: \`x-request-id: ${ORDER.requestId}\``,
      `- request correlation IDs: \`traceparent: ${ORDER.traceparent}\``,
    ].join('\n'),
  );
  // The request that succeeded carried IDs too. It keeps its line, without them.
  const lines = md.split('\n');
  const cart = lines.findIndex((line) => line.endsWith('🌐 200 GET /api/cart'));
  expect(cart, 'report.md lists the request that succeeded').toBeGreaterThan(-1);
  expect(lines[cart + 1]).not.toContain('correlation IDs');
  expect(md).not.toContain(CART.requestId);
  expect(md).not.toContain(CART.traceparent);
  expect(md.match(/correlation IDs/g)).toHaveLength(2);
  // Capture kept every header of both requests in session.json.
  const session = decode(zipEntry(files, '/session.json'));
  for (const ids of [CART, ORDER]) {
    expect(session).toContain(ids.requestId);
    expect(session).toContain(ids.traceparent);
  }

  // E2E_PROOF_DIR=<folder> saves a screenshot of this report.md for review.
  const proofDir = process.env.E2E_PROOF_DIR;
  if (proofDir) {
    const proof = await context.newPage();
    await proof.setViewportSize({ width: 1280, height: 720 });
    // The bytes of report.md from the zip, shown as the browser shows a text file.
    await proof.route('**/report.md', (route) =>
      route.fulfill({
        contentType: 'text/plain; charset=utf-8',
        body: Buffer.from(reportBytes),
      }),
    );
    await proof.goto('/report.md');
    // From the top of the file, with the failed request's ID lines in view.
    const bottom = await proof.evaluate((needle) => {
      const node = document.querySelector('pre')!.firstChild as Text;
      const range = document.createRange();
      range.setStart(node, node.data.indexOf(needle));
      range.setEnd(node, node.data.indexOf(needle) + needle.length);
      return range.getBoundingClientRect().bottom;
    }, `traceparent: ${ORDER.traceparent}`);
    expect(bottom, 'the ID lines fit in the screenshot').toBeLessThanOrEqual(720);
    // Captured at once, headless Chromium can still show stale tiles in the
    // bottom rows of a new page; let it finish painting.
    await proof.waitForTimeout(1000);
    mkdirSync(proofDir, { recursive: true });
    await proof.screenshot({
      path: path.join(proofDir, 'report-md-failed-request-ids.png'),
    });
  }
});
