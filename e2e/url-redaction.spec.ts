/**
 * Page URLs are redacted before they reach storage.
 *
 * Password-reset links, magic links, invite links and OAuth implicit-flow
 * redirects carry credentials in the query string or the fragment
 * (`#access_token=…`). The recorder stores page URLs on the session, on each
 * tab, and on nav / spa-route / tab events; every export, AI summary and
 * published report is built from that stored data. This drives real Chrome
 * navigation through each of those paths and asserts that no secret survives
 * in the stored session, its events or the exported report.md.
 */
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string }; error?: string };
type EventsRes = { events: Array<{ type: string; payload: Record<string, unknown> }> };

const SECRETS = [
  'START_SECRET',
  'NAV_SECRET',
  'SPA_SECRET',
  'HASH_SECRET',
  'REFRESH_SECRET',
  'ROUTE_SECRET',
  'TAB_SECRET',
];

test('page URLs are redacted in the session, events and report', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  // Session start URL (initialUrl + primary tab URL).
  await page.goto('/?view=demo&reset_token=START_SECRET');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Demo');

  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(800);

  // Full navigation (webNavigation.onCommitted → nav event).
  await page.goto('/checkout.html?step=2&token=NAV_SECRET');
  await page.waitForTimeout(500);
  // SPA route change (onHistoryStateUpdated → spa-route event).
  await page.evaluate(() =>
    history.pushState({}, '', '/checkout.html?step=3&api_key=SPA_SECRET'),
  );
  await page.waitForTimeout(300);
  // OAuth implicit-flow style fragment (onReferenceFragmentUpdated).
  await page.evaluate(() => {
    location.hash = 'access_token=HASH_SECRET&refresh_token=REFRESH_SECRET&expires_in=3600';
  });
  await page.waitForTimeout(300);
  // Hash-router route with its own query string.
  await page.evaluate(() => {
    location.hash = '/reset?password_token=ROUTE_SECRET&lang=en';
  });
  await page.waitForTimeout(300);
  // A tab the app opens is adopted with its URL (tab-opened event).
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate(() => {
      window.open(`${location.origin}/?invite=1&invite_token=TAB_SECRET`, '_blank', 'noopener');
    }),
  ]);
  await popup.waitForLoadState();
  await expect
    .poll(async () => {
      const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });
      return events.some((e) => e.type === 'tab-opened');
    })
    .toBe(true);

  await dispatch(background, { kind: 'session/stop' });

  const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });
  const session = await dispatch<Record<string, unknown>>(background, {
    kind: 'session/get',
    sessionId,
  });
  const types = events.map((e) => e.type);
  expect(types).toContain('nav');
  expect(types).toContain('spa-route');
  expect(types).toContain('tab-opened');

  // Page-URL events. (Console `source` URLs are browser diagnostics, redacted
  // separately; network URLs already pass through redactUrl in capture.)
  const pageEvents = events.filter((e) =>
    ['nav', 'spa-route', 'tab-opened', 'tab-switch', 'tab-closed'].includes(e.type),
  );
  const stored = JSON.stringify({ session, pageEvents });
  for (const secret of SECRETS) expect(stored).not.toContain(secret);
  // Redaction keeps the URLs useful: route and non-secret params survive.
  expect(stored).toContain('reset_token=«redacted»');
  expect(stored).toContain('step=2&token=«redacted»');
  expect(stored).toContain('#access_token=«redacted»&refresh_token=«redacted»&expires_in=3600');
  expect(stored).toContain('#/reset?password_token=«redacted»&lang=en');

  // The exported report is built from the same stored data.
  const sp = await context.newPage();
  await sp.goto(extUrl(extensionId, `report.html?session=${sessionId}`));
  await expect(sp.getByRole('button', { name: /Download .zip/i })).toBeVisible();
  await sp.evaluate(() => {
    (window as any).__dl = null;
    chrome.downloads.download = (async (opts: { url: string; filename: string }) => {
      const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
      (window as any).__dl = Array.from(new Uint8Array(buf));
      return 1;
    }) as typeof chrome.downloads.download;
  });
  await sp.getByRole('button', { name: 'Full', exact: true }).click();
  await sp.getByRole('button', { name: /Download .zip/i }).click();
  await sp.waitForFunction(() => (window as any).__dl !== null, undefined, {
    timeout: 20_000,
  });
  const bytes = (await sp.evaluate(() => (window as any).__dl)) as number[];
  const files = unzipSync(Uint8Array.from(bytes));
  const reportKey = Object.keys(files).find((k) => k.endsWith('/report.md'));
  expect(reportKey).toBeTruthy();
  const report = new TextDecoder().decode(files[reportKey!]);
  // Console source lines are browser diagnostics with their own redaction path.
  const pageLines = report
    .split('\n')
    .filter((line) => !/console\.\w+ @ /.test(line))
    .join('\n');
  expect(pageLines).toContain('NAV');
  expect(pageLines).toContain('token=«redacted»');
  for (const secret of SECRETS) expect(pageLines).not.toContain(secret);
});
