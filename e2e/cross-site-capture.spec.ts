/**
 * Network, console and exception capture inside a cross-site iframe and a
 * dedicated worker. Chrome reports both as separate debugger targets, so the
 * recorder only sees them by auto-attaching to the tab's child targets.
 *
 * demo/cross-site/index.html is served from localhost; its payment frame comes
 * from pay.example.test, another site, which the browser fixture maps to the
 * same loopback server. Pay makes the frame POST a card number (501), log a
 * console error and throw. Search makes the worker GET /api/search (404) and
 * throw. Pay also fetches /api/cart (404) from the page itself, the control.
 *
 * Set EVIDENCE_DIR to keep the recorded events, report.md and screenshots of
 * the page and the full timeline. They are written before any assertion, so a
 * build without child-target capture still leaves its evidence behind.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string } };
type Ev = { type: string; t: number; payload: any };

const evidenceDir = process.env.EVIDENCE_DIR;
function keep(name: string, data: string | Buffer): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, name), data);
}

async function downloadReport(timeline: Page): Promise<string> {
  await timeline.evaluate(() => {
    (window as any).__dl = null;
    chrome.downloads.download = (async (opts: { url: string; filename: string }) => {
      const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
      (window as any).__dl = { bytes: Array.from(new Uint8Array(buf)) };
      return 1;
    }) as typeof chrome.downloads.download;
  });
  await timeline.getByRole('button', { name: 'Full', exact: true }).click();
  await timeline.getByRole('button', { name: /Download .zip/i }).click();
  await timeline.waitForFunction(() => (window as any).__dl !== null, undefined, { timeout: 20_000 });
  const { bytes } = await timeline.evaluate(() => (window as any).__dl as { bytes: number[] });
  const files = unzipSync(Uint8Array.from(bytes));
  const key = Object.keys(files).find((k) => k.endsWith('/report.md'))!;
  return new TextDecoder().decode(files[key]);
}

test('captures requests, console errors and exceptions from a cross-site iframe and a worker', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 520 });
  await page.goto('/cross-site/index.html');
  await expect(page.frameLocator('#pay-frame').getByLabel('Card number')).toBeVisible();

  const tabId = await tabIdForUrl(background, 'http://localhost:5319/cross-site/');
  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(800);

  await page.click('#pay');
  await expect(page.locator('#status')).toHaveText('Payment failed');
  await page.click('#search');
  await expect(page.locator('#status')).toHaveText('Search returned 404');
  await page.waitForTimeout(1500); // console coalescing window and pending bodies
  keep('page.png', await page.screenshot());

  await dispatch(background, { kind: 'session/stop' });
  const { events } = await dispatch<{ events: Ev[] }>(background, { kind: 'events/get', sessionId });
  keep('events.json', JSON.stringify(events.filter((e) => e.type !== 'screenshot'), null, 2));

  const workspace = await context.newPage();
  await workspace.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  const opened = context.waitForEvent('page');
  await workspace.getByRole('link', { name: 'Full timeline' }).click();
  const timeline = await opened;
  await timeline.setViewportSize({ width: 1100, height: 900 });
  await expect(timeline.getByRole('button', { name: /Download .zip/i })).toBeVisible();
  const report = await downloadReport(timeline);
  keep('report.md', report);
  await timeline.locator('details').evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));
  keep('timeline.png', await timeline.screenshot({ fullPage: true }));

  const requests = events.filter((e) => e.type === 'net-request').map((e) => e.payload);
  const errors = events.filter((e) => e.type === 'error').map((e) => e.payload);
  const consoles = events.filter((e) => e.type === 'console').map((e) => e.payload);

  // Control: the page's own request was always captured, and stays unlabelled.
  const cart = requests.find((r) => r.url.endsWith('/api/cart'));
  expect(cart).toMatchObject({ method: 'GET', status: 404 });
  expect(cart.target).toBeUndefined();

  // The payment frame's request, with its outcome but none of its content.
  const charge = requests.find((r) => r.url === 'http://pay.example.test:5319/api/charge');
  expect(charge, 'the cross-site frame POST is recorded').toMatchObject({
    method: 'POST',
    status: 501,
    target: { type: 'iframe', url: 'http://pay.example.test:5319/cross-site/pay.html', crossSite: true },
    requestBody: { present: false, omitted: 'cross-site' },
    responseBody: { present: false, omitted: 'cross-site' },
  });
  expect(JSON.stringify(events)).not.toContain('4242');

  // The frame's console error and exception.
  expect(consoles).toContainEqual(
    expect.objectContaining({ level: 'error', text: 'Payment declined: charge returned 501', target: expect.objectContaining({ type: 'iframe' }) }),
  );
  expect(errors).toContainEqual(
    expect.objectContaining({ origin: 'exception', message: 'Error: Charge failed with HTTP 501', target: expect.objectContaining({ type: 'iframe' }) }),
  );

  // The worker's request, same-origin, so its body is kept as for the page.
  const search = requests.find((r) => r.url === 'http://localhost:5319/api/search?q=weekender');
  expect(search, 'the worker GET is recorded').toMatchObject({
    method: 'GET',
    status: 404,
    target: { type: 'worker', url: 'http://localhost:5319/cross-site/search-worker.js' },
    responseBody: { present: true },
  });

  // The worker's exception, once: the copy Chrome forwards to the page is dropped.
  const searchErrors = errors.filter((e) => String(e.message).includes('Search index unavailable'));
  expect(searchErrors).toHaveLength(1);
  expect(searchErrors[0].target).toMatchObject({ type: 'worker' });

  // Every child was observed, so the recording reports no gap.
  expect(events.filter((e) => e.type === 'session-note' && /Could not observe/.test(e.payload.text))).toEqual([]);

  // report.md says where each event happened and why bodies are missing.
  expect(report).toMatch(/🌐 501 POST \/api\/charge · in cross-site iframe pay\.example\.test:5319/);
  expect(report).toContain('- Request: _(not captured from a cross-site frame)_');
  expect(report).toMatch(/🌐 404 GET \/api\/search\?q=weekender · in worker localhost:5319\/cross-site\/search-worker\.js/);
  expect(report).toMatch(/\(exception\) · in cross-site iframe pay\.example\.test:5319 Error: Charge failed with HTTP 501/);
  expect(report).toMatch(/🌐 404 GET \/api\/cart\n/);
  expect(report).not.toContain('4242');
});
