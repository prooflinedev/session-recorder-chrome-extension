/**
 * An Azure storage (SAS) signature in a request URL and a password in a
 * `user:password@` URL echoed by a console error must not reach the export.
 * Records the demo page, triggers both, then downloads the Full ZIP and checks
 * network.har, session.json and report.md.
 */
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string }; error?: string };
type EventsRes = { events: Array<{ type: string; payload: any }> };

const FAKE_SIG = 'FAKEsasSig9d41c7e2';
const FAKE_PASSWORD = 'FAKEpw5b0e7a13';
const MASKED_URL = 'http://admin:«redacted»@localhost:5319/x';

test('masks a SAS sig and a URL password in the exported HAR, session and report', async ({
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
    ({ sig, password }) => {
      fetch(`/sas-probe-${Date.now()}?sv=2022-11-02&sr=b&sp=rw&sig=${sig}`).catch(() => {});
      // Chrome refuses a URL with credentials and repeats the URL in its error.
      fetch(`http://admin:${password}@localhost:5319/x`).catch((e: Error) =>
        console.error(e.message),
      );
    },
    { sig: FAKE_SIG, password: FAKE_PASSWORD },
  );
  await page.waitForTimeout(1000);
  await dispatch(background, { kind: 'session/stop' });

  const { events } = await dispatch<EventsRes>(background, { kind: 'events/get', sessionId });
  // Guard against a vacuous pass: both were really captured.
  const probe = events.filter(
    (e) => e.type === 'net-request' && String(e.payload?.url).includes('/sas-probe-'),
  );
  expect(probe).toHaveLength(1);
  expect(probe[0]!.payload.url).toMatch(/&sp=rw&sig=«redacted»$/);
  const logged = events.filter(
    (e) => e.type === 'console' && String(e.payload?.text).includes('includes credentials'),
  );
  expect(logged).toHaveLength(1);
  expect(logged[0]!.payload.text).toContain(MASKED_URL);

  // Export the Full ZIP through the real UI and check network.har, session.json and report.md.
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
  const entry = har.log.entries.find((e: any) => e.request.url.includes('/sas-probe-'));
  expect(entry, 'HAR has the probe request').toBeTruthy();
  expect(entry.request.url).toMatch(/&sig=«redacted»$/);
  expect(entry.request.queryString.find((q: any) => q.name === 'sig')?.value).toBe('«redacted»');
  const exported = JSON.parse(text('/session.json')).events.filter(
    (e: any) => e.type === 'net-request' && String(e.payload?.url).includes('/sas-probe-'),
  );
  expect(exported, 'session.json has the probe request').toHaveLength(1);
  expect(exported[0].payload.url).toMatch(/&sp=rw&sig=«redacted»$/);

  for (const file of ['/network.har', '/session.json', '/report.md']) {
    const body = text(file);
    expect(body, file).not.toContain(FAKE_SIG);
    expect(body, file).not.toContain(FAKE_PASSWORD);
  }
  // Guard against a vacuous pass: the console error itself was exported.
  for (const file of ['/session.json', '/report.md']) {
    expect(text(file), file).toContain(`includes credentials: ${MASKED_URL}`);
  }
});
