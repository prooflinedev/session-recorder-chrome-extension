/**
 * Storage snapshots: the recorder reads the page's localStorage,
 * sessionStorage and script-readable cookies at start and stop, redacts them
 * before storage, and report.md lists what the session changed.
 *
 * Snapshots use chrome.scripting rather than CDP, so they work under
 * Playwright even though the extension's debugger cannot attach here.
 */
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string }; error?: string };
type Entry = { area: string; key: string; value?: string; redacted?: boolean };
type EventsRes = {
  events: Array<{ type: string; payload: { phase?: string; origin?: string; entries?: Entry[] } }>;
};

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJMRUFLX0pXVCJ9.c2lnbmF0dXJlLXZhbHVl';

test('snapshots page storage at start and stop and reports the changes', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Demo');
  await page.evaluate((jwt) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('flags', '{"newCheckout":false}');
    localStorage.setItem('authToken', 'LEAK_TOKEN');
    localStorage.setItem('profile', JSON.stringify({ name: 'Ada', jwt }));
    // Larger than the in-page clip: cut JSON cannot be scrubbed, so it is withheld.
    localStorage.setItem(
      'appState',
      JSON.stringify({ apiKey: 'LEAK_BIG', items: new Array(40_000).fill(1) }),
    );
    sessionStorage.setItem('draft', 'hello');
    document.cookie = 'ab_variant=A; path=/';
  }, JWT);

  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    localStorage.setItem('flags', '{"newCheckout":true}');
    localStorage.setItem('cart', '[1]');
    localStorage.setItem('authToken', 'LEAK_TOKEN_2');
    sessionStorage.removeItem('draft');
  });

  await dispatch(background, { kind: 'session/stop' });

  const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });
  const snaps = events.filter((e) => e.type === 'storage-snapshot');
  expect(snaps.map((e) => e.payload.phase)).toEqual(['start', 'stop']);
  expect(snaps[0]!.payload.origin).toBe('http://localhost:5319');
  const start = snaps[0]!.payload.entries!;
  expect(start).toContainEqual(expect.objectContaining({ area: 'cookie', key: 'ab_variant', value: 'A' }));
  expect(start).toContainEqual(
    expect.objectContaining({ key: 'authToken', value: '«redacted»', redacted: true }),
  );
  expect(start).toContainEqual(
    expect.objectContaining({ key: 'appState', value: '«too large to redact»', redacted: true }),
  );
  const stored = JSON.stringify(snaps);
  expect(stored).not.toContain('LEAK_TOKEN');
  expect(stored).not.toContain('LEAK_BIG');
  expect(stored).not.toContain('LEAK_JWT');
  expect(stored).not.toContain(JWT);

  // The exported report lists the changes.
  const sp = await context.newPage();
  await sp.goto(extUrl(extensionId, `report.html?session=${sessionId}`));
  await expect(sp.getByRole('button', { name: /Download .zip/i })).toBeVisible();
  await sp.evaluate(() => {
    (window as any).__dl = null;
    chrome.downloads.download = (async (opts: { url: string }) => {
      const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
      (window as any).__dl = Array.from(new Uint8Array(buf));
      return 1;
    }) as typeof chrome.downloads.download;
  });
  await sp.getByRole('button', { name: 'Full', exact: true }).click();
  await sp.getByRole('button', { name: /Download .zip/i }).click();
  await sp.waitForFunction(() => (window as any).__dl !== null, undefined, { timeout: 20_000 });
  const bytes = (await sp.evaluate(() => (window as any).__dl)) as number[];
  const files = unzipSync(Uint8Array.from(bytes));
  const reportKey = Object.keys(files).find((k) => k.endsWith('/report.md'))!;
  const report = new TextDecoder().decode(files[reportKey]);
  expect(report).toContain('## Appendix: Storage State');
  expect(report).toContain('- added localStorage `cart`');
  expect(report).toContain('- changed localStorage `flags`');
  expect(report).toContain('- removed sessionStorage `draft`');
  // The rotated token is reported as changed without showing either value.
  expect(report).toContain('- changed localStorage `authToken`: `«redacted»`');
  expect(report).not.toContain('LEAK_TOKEN');
});

test('records the stop snapshot when a paused session is stopped', async ({
  context,
  background,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('flags', '{"newCheckout":false}');
  });
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);
  await page.waitForTimeout(300);
  await page.evaluate(() => localStorage.setItem('flags', '{"newCheckout":true}'));
  await dispatch(background, { kind: 'session/pause' });
  await dispatch(background, { kind: 'session/stop' });
  const { events } = await dispatch<EventsRes>(background, {
    kind: 'events/get',
    sessionId: started.session!.id,
  });
  const snaps = events.filter((e) => e.type === 'storage-snapshot');
  expect(snaps.map((e) => e.payload.phase)).toEqual(['start', 'stop']);
});

test('records no storage when the setting is off', async ({ context, background }) => {
  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('flags', '{}'));
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, {
    kind: 'session/start',
    tabId,
    settings: { captureStorage: false },
  });
  expect(started.ok).toBe(true);
  await page.waitForTimeout(300);
  await dispatch(background, { kind: 'session/stop' });
  const { events } = await dispatch<EventsRes>(background, {
    kind: 'events/get',
    sessionId: started.session!.id,
  });
  expect(events.some((e) => e.type === 'storage-snapshot')).toBe(false);
});
