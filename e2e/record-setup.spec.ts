import { test, expect, dispatch, extUrl, tabIdForUrl } from './support';
import { CURSOR_OVERLAY_HOST_ID } from '../lib/dom/overlay';

test.describe('recording setup', () => {
  test.use({ allowTabCapture: true });

  test('Record starts real video with the selected options even before preferences finish saving', async ({ context, background, extensionId }, testInfo) => {
    const page = await context.newPage();
    await page.goto('/');
    const tabId = await tabIdForUrl(background, 'http://localhost:5319');
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 390, height: 844 });
    await panel.emulateMedia({ colorScheme: 'dark' });
    await panel.goto(extUrl(extensionId, 'sidepanel.html'));
    // The real side panel is not a tab. Pin only its active-tab query while
    // running its unchanged UI in an inspectable extension page.
    await panel.evaluate((tabId) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (async (info: chrome.tabs.QueryInfo) =>
        info.active && info.currentWindow ? [{ id: tabId }] : query(info)) as typeof chrome.tabs.query;
      const save = chrome.storage.local.set.bind(chrome.storage.local);
      (window as any).__releaseVideoPreference = undefined;
      chrome.storage.local.set = (async (items: Record<string, unknown>) => {
        if ('videoFromStart' in items) {
          await new Promise<void>((resolve) => { (window as any).__releaseVideoPreference = resolve; });
        }
        await save(items);
      }) as typeof chrome.storage.local.set;
    }, tabId);
    await panel.getByRole('button', { name: 'Capture options', exact: true }).click();
    const spotlight = panel.getByRole('switch', { name: /Cursor spotlight/ });
    const clicks = panel.getByRole('switch', { name: /Highlight clicks/ });
    await expect(spotlight).toBeDisabled();
    await expect(clicks).toBeDisabled();
    await panel.screenshot({ path: testInfo.outputPath('cursor-controls-video-off.png') });
    await panel.getByRole('switch', { name: /^Video/ }).click();
    await spotlight.click();
    await clicks.click();
    expect(await background.evaluate(async () => (await chrome.storage.local.get('videoFromStart')).videoFromStart)).not.toBe(true);
    await panel.screenshot({ path: testInfo.outputPath('cursor-controls-video-on.png') });
    await panel.getByRole('button', { name: 'Capture options', exact: true }).click();
    await panel.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Video on', exact: true })).toBeVisible();
    const state = await dispatch<{ videoOn: boolean; session: { id: string } }>(background, { kind: 'session/getState' });
    expect(state.videoOn).toBe(true);
    expect(await background.evaluate(async (id) => (await new Promise<chrome.tabCapture.CaptureInfo[]>((resolve) => chrome.tabCapture.getCapturedTabs(resolve)))
      .some((tab) => tab.tabId === id && tab.status === 'active'), tabId)).toBe(true);
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(1);
    // Finish persistence after proving that startup used the UI's actual choice.
    await panel.evaluate(() => (window as any).__releaseVideoPreference());
    await page.waitForTimeout(400);
    await panel.getByRole('button', { name: 'Video on', exact: true }).click();
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(0);
    await page.goto('/checkout.html');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(0);
    await panel.getByRole('button', { name: 'Video', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Video on', exact: true })).toBeVisible();
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(1);
    await dispatch(background, { kind: 'session/stop' });
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(0);
    const result = await dispatch<{ assets: Array<{ kind: string; size: number }> }>(background,
      { kind: 'assets/getMeta', sessionId: state.session.id });
    expect(result.assets.some((asset) => asset.kind === 'video' && asset.size > 0)).toBe(true);
  });

  test('recovers the actual video state after a service worker restart', async ({ context, background, extensionId }) => {
    const page = await context.newPage();
    await page.goto('/');
    const tabId = await tabIdForUrl(background, 'http://localhost:5319');
    await dispatch(background, { kind: 'session/start', tabId, media: { video: true, mic: false },
      settings: { cursorSpotlight: true, clickHighlight: true } });
    const panel = await context.newPage();
    await panel.goto(extUrl(extensionId, 'sidepanel.html'));
    await expect(panel.getByRole('button', { name: 'Video on', exact: true })).toBeVisible();
    const cdp = await context.newCDPSession(page);
    let versionId = '';
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const version = versions.find((worker) => worker.scriptURL.startsWith(`chrome-extension://${extensionId}/`) && worker.runningStatus === 'running');
      if (version) versionId = version.versionId;
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => versionId).not.toBe('');
    await cdp.send('ServiceWorker.stopWorker', { versionId });
    await panel.reload();
    await expect(panel.getByRole('button', { name: 'Video on', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Video on', exact: true }).click();
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(0);
    await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'session/stop' }));
    await cdp.detach();
  });

  test('failed automatic video startup reports the error and keeps effects off', async ({ context, background, extensionId }) => {
    const page = await context.newPage();
    await page.goto('/');
    const tabId = await tabIdForUrl(background, 'http://localhost:5319');
    const panel = await context.newPage();
    await panel.goto(extUrl(extensionId, 'sidepanel.html'));
    await background.evaluate(() => {
      chrome.tabCapture.getMediaStreamId = (() => { throw new Error('fixture video unavailable'); }) as typeof chrome.tabCapture.getMediaStreamId;
    });
    expect(await dispatch(background, { kind: 'session/start', tabId,
      settings: { cursorSpotlight: true, clickHighlight: true }, media: { video: true, mic: false } })).toMatchObject({ ok: true });
    await expect(panel.getByText(/Video capture could not start: fixture video unavailable/).first()).toBeVisible();
    expect(await dispatch(background, { kind: 'session/getState' })).toMatchObject({ recording: true, videoOn: false });
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(0);
    await page.goto('/checkout.html');
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(0);
    await dispatch(background, { kind: 'session/stop' });
  });
});
