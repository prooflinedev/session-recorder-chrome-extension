/**
 * A redirect to a signed link must not keep the link's secret in the redirect's
 * `Location` header (or the HAR's `redirectURL`), and a page URL secret must not
 * survive in a `Referer` header. The next hop's URL was already masked; these
 * header copies were not. Records the demo page, triggers both, then downloads
 * the Full ZIP and checks network.har, session.json and report.md.
 */
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string }; error?: string };
type EventsRes = { events: Array<{ type: string; payload: any }> };

const LOC_SECRET = 'FAKElocTok3e91a7c0';
const REF_SECRET = 'FAKErefTok8b24d6f1';
const TARGET = `/landing-probe?id=7&token=${LOC_SECRET}`;
const MASKED_TARGET = 'http://localhost:5319/landing-probe?id=7&token=«redacted»';

const header = (headers: Array<{ name: string; value: string }>, name: string) =>
  headers.find((h) => h.name.toLowerCase() === name)?.value;

test('masks secrets in redirect Location and Referer headers in the export', async ({
  context,
  background,
  extensionId,
}) => {
  // The demo server is static, so fake the redirect hop in the browser.
  await context.route('**/redirect-probe', (route) =>
    route.fulfill({ status: 302, headers: { Location: `http://localhost:5319${TARGET}` } }),
  );
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(800);

  await page.evaluate(async (ref) => {
    await fetch('/redirect-probe').catch(() => {});
    await fetch('/referer-probe', { referrer: `/?session_token=${ref}` }).catch(() => {});
  }, REF_SECRET);
  await page.waitForTimeout(1000);
  await dispatch(background, { kind: 'session/stop' });

  const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });
  const nets = events.filter((e) => e.type === 'net-request').map((e) => e.payload);
  // Guard against a vacuous pass: the redirect hop and both requests were captured.
  const hop = nets.find((p) => String(p.url).endsWith('/redirect-probe'));
  expect(hop, 'redirect hop captured').toBeTruthy();
  expect(hop.status).toBe(302);
  expect(header(hop.responseHeaders, 'location')).toBe(MASKED_TARGET);
  expect(nets.some((p) => String(p.url).includes('/landing-probe?id=7&token=«redacted»'))).toBe(true);
  const ref = nets.find((p) => String(p.url).endsWith('/referer-probe'));
  expect(ref, 'referer probe captured').toBeTruthy();
  expect(header(ref.requestHeaders, 'referer')).toBe(
    'http://localhost:5319/?session_token=«redacted»',
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
  await sp.waitForFunction(() => (window as any).__dl !== null, undefined, { timeout: 20_000 });
  const dl = (await sp.evaluate(() => (window as any).__dl)) as { bytes: number[] };

  const files = unzipSync(Uint8Array.from(dl.bytes));
  const text = (suffix: string): string => {
    const key = Object.keys(files).find((k) => k.endsWith(suffix));
    expect(key, `zip contains ${suffix}`).toBeTruthy();
    return new TextDecoder().decode(files[key!]);
  };
  const har = JSON.parse(text('/network.har'));
  const entry = har.log.entries.find((e: any) => e.request.url.endsWith('/redirect-probe'));
  expect(entry, 'HAR has the redirect hop').toBeTruthy();
  expect(entry.response.redirectURL).toBe(MASKED_TARGET);
  const refEntry = har.log.entries.find((e: any) => e.request.url.endsWith('/referer-probe'));
  expect(refEntry, 'HAR has the referer probe').toBeTruthy();
  expect(header(refEntry.request.headers, 'referer')).toBe(
    'http://localhost:5319/?session_token=«redacted»',
  );

  for (const file of ['/network.har', '/session.json', '/report.md']) {
    const body = text(file);
    expect(body, file).not.toContain(LOC_SECRET);
    expect(body, file).not.toContain(REF_SECRET);
  }
});
