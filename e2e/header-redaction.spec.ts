/**
 * Secret-bearing request headers (here X-CSRF-Token) must not reach the export.
 * Records the demo page, fetches with a fake CSRF header, then downloads the Full
 * ZIP and checks network.har and report.md.
 */
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string }; error?: string };
type EventsRes = { events: Array<{ type: string; payload: any }> };

const FAKE_CSRF = 'FAKE-csrf-9d41c7e2';

test('masks X-CSRF-Token in the exported HAR and report', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(800);

  await page.evaluate(
    (token) =>
      fetch(`/csrf-probe-${Date.now()}`, { headers: { 'X-CSRF-Token': token } }).catch(() => {}),
    FAKE_CSRF,
  );
  await page.waitForTimeout(1000);
  await dispatch(background, { kind: 'session/stop' });

  const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });
  const captured = events.filter(
    (e) => e.type === 'net-request' && String(e.payload?.url).includes('/csrf-probe-'),
  );
  // Guard against a vacuous pass: the request really was captured, header included.
  expect(captured).toHaveLength(1);
  const sent = captured[0]!.payload.requestHeaders as Array<{ name: string; value: string }>;
  expect(sent.find((h) => h.name.toLowerCase() === 'x-csrf-token')?.value).toBe('«redacted»');

  // Export the Full ZIP through the real UI and check every file it contains.
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
  await sp.waitForFunction(() => (window as any).__dl !== null, undefined, { timeout: 20_000 });
  const dl = (await sp.evaluate(() => (window as any).__dl)) as { bytes: number[] };

  const files = unzipSync(Uint8Array.from(dl.bytes));
  const text = (suffix: string): string => {
    const key = Object.keys(files).find((k) => k.endsWith(suffix));
    expect(key, `zip contains ${suffix}`).toBeTruthy();
    return new TextDecoder().decode(files[key!]);
  };
  const har = JSON.parse(text('/network.har'));
  const entry = har.log.entries.find((e: any) => e.request.url.includes('/csrf-probe-'));
  expect(entry, 'HAR has the probe request').toBeTruthy();
  const csrf = entry.request.headers.find((h: any) => h.name.toLowerCase() === 'x-csrf-token');
  expect(csrf?.value).toBe('«redacted»');

  for (const file of ['/network.har', '/session.json', '/report.md']) {
    expect(text(file), file).not.toContain(FAKE_CSRF);
  }
});
