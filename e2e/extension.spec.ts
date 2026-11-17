/**
 * Smoke tests: the extension loads with a live service worker, a sane manifest,
 * and its React pages render.
 */
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

test('loads with a service worker and the expected manifest', async ({
  background,
  extensionId,
}) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);

  const manifest = await background.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.name).toBe('Session Recorder by Proofline');
  expect(manifest.permissions).toEqual(
    expect.arrayContaining(['debugger', 'sidePanel', 'downloads', 'offscreen']),
  );
  // Side panel + all keyboard commands wired.
  expect((manifest as Record<string, any>).side_panel?.default_path).toBe(
    'sidepanel.html',
  );
  expect(Object.keys((manifest as Record<string, any>).commands ?? {})).toEqual(
    expect.arrayContaining([
      'toggle-annotation',
      'add-marker',
      'capture-screenshot',
      'toggle-pause',
    ]),
  );

  // The test hook is installed on the SW global.
  const hasHook = await background.evaluate(
    () => typeof (globalThis as any).__srTest === 'function',
  );
  expect(hasHook).toBe(true);
});

test('side panel renders the Record button', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'sidepanel.html'));
  await expect(page.getByRole('button', { name: /record/i })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '.impeccable/review/panel-idle.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Capture options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Capture options' });
  await expect(options).toBeInViewport();
  const bounds = await options.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: '.impeccable/review/panel-options.png',
    animations: 'disabled',
  });
  const settingsTab = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = await settingsTab;
  await expect(settings).toHaveURL(extUrl(extensionId, 'options.html'));
  await expect(
    settings.getByRole('heading', { name: 'Capture', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeVisible();
});

test('video toggle degrades cleanly when tab capture is unavailable', async ({
  context,
  background,
}) => {
  // Under the __srTest hook the extension was never user-invoked on the tab,
  // so chrome.tabCapture.getMediaStreamId is expected to fail — the toggle must
  // answer with a clean error and the session must keep working.
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');

  const started = await dispatch<{ ok: boolean; session?: { id: string } }>(
    background,
    { kind: 'session/start', tabId },
  );
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;

  const toggled = await dispatch<{ ok: boolean; videoOn: boolean; error?: string }>(
    background,
    { kind: 'video/toggle', on: true },
  );
  if (toggled.ok) {
    // Environments where tab capture works: the button reflects it.
    expect(toggled.videoOn).toBe(true);
  } else {
    // The degraded path: a readable error, video stays off, nothing crashed.
    expect(typeof toggled.error).toBe('string');
    expect(toggled.error!.length).toBeGreaterThan(0);
    expect(toggled.videoOn).toBe(false);
  }

  // The session survives the failed (or successful) toggle end to end.
  const stopped = await dispatch<{ ok: boolean }>(background, {
    kind: 'session/stop',
  });
  expect(stopped.ok).toBe(true);
  const { events } = await dispatch<{ events: Array<{ type: string }> }>(background, {
    kind: 'events/get',
    sessionId,
  });
  expect(Array.isArray(events)).toBe(true);
  expect(events.length).toBeGreaterThan(0);
});

test('options page renders its settings sections', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'options.html'));
  await expect(
    page.getByRole('heading', { name: 'Capture', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Transcription', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Transcription', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Redaction', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Transcription', exact: true }),
  ).toBeVisible();
  for (const width of [320, 390, 600, 960]) {
    await page.setViewportSize({ width, height: 900 });
    const tabBounds = () => page.locator('.settings-nav a').evaluateAll((links) =>
      links.map((link) => {
        const rect = link.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
      }),
    );
    const before = await tabBounds();
    for (const name of ['Capture', 'Publishing', 'GitHub', 'Storage']) {
      await page.getByRole('link', { name, exact: true }).click();
      expect(await tabBounds()).toEqual(before);
    }
  }
});
