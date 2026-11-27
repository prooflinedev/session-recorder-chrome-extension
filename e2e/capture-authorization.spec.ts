import { chromium } from '@playwright/test';
import { test, expect, dispatch, extUrl, tabIdForUrl, EXT_PATH } from './support';
import { CURSOR_OVERLAY_HOST_ID } from '../lib/dom/overlay';

test('real toolbar invocation authorizes Record without a capture allowlist', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`,
      // This enables driving the toolbar action, not bypassing capture permission.
      '--enable-unsafe-extension-debugging',
      '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      '--disable-background-networking', '--disable-sync', '--no-pings',
    ],
  });
  try {
    const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;
    const page = await context.newPage();
    await page.goto('http://localhost:5319/');
    const tabId = await tabIdForUrl(background, 'http://localhost:5319');
    await background.evaluate(async () => chrome.storage.local.set({
      videoFromStart: true,
      defaultSettings: { cursorSpotlight: true, clickHighlight: true },
    }));
    const panel = await context.newPage();
    await panel.goto(extUrl(extensionId, 'sidepanel.html'));
    await panel.evaluate((id) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (async (info: chrome.tabs.QueryInfo) =>
        info.active && info.currentWindow ? [{ id }] : query(info)) as typeof chrome.tabs.query;
    }, tabId);

    // Opening/clicking a side-panel page alone does not authorize this tab.
    await panel.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText(/click the Session Recorder icon in Chrome's toolbar, then click Video/);
    expect(await dispatch(background, { kind: 'session/getState' })).toMatchObject({ videoOn: false });
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(0);

    const browserCDP = await context.browser()!.newBrowserCDPSession();
    await page.bringToFront();
    const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const targetInfo = targetInfos.find((target) => target.url === page.url());
    expect(targetInfo, JSON.stringify(targetInfos)).toBeTruthy();
    await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfo!.targetId });

    // The recovery instructions work in the current session, without restarting it.
    await panel.getByRole('button', { name: 'Video', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Video on', exact: true })).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(1);
    await page.waitForTimeout(500);
    await dispatch(background, { kind: 'session/stop' });

    // A fresh recording on the authorized site starts video with Record itself.
    await panel.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Video on', exact: true })).toBeVisible();
    const state = await dispatch<{ session: { id: string }; videoOn: boolean }>(background, { kind: 'session/getState' });
    expect(state.videoOn).toBe(true);
    await page.waitForTimeout(500);
    await dispatch(background, { kind: 'session/stop' });
    const { assets } = await dispatch<{ assets: Array<{ kind: string; size: number }> }>(background,
      { kind: 'assets/getMeta', sessionId: state.session.id });
    expect(assets.some((asset) => asset.kind === 'video' && asset.size > 0)).toBe(true);

    // Cross-origin navigation revokes Chrome's grant even though the panel stays open.
    await page.goto('http://127.0.0.1:5319/');
    await panel.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText(/click the Session Recorder icon/);
    expect(await dispatch(background, { kind: 'session/getState' })).toMatchObject({ videoOn: false });
    await expect(page.locator(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveCount(0);
    await dispatch(background, { kind: 'session/stop' });
    await browserCDP.detach();
  } finally {
    await context.close();
  }
});

test('browser pages report an unsupported context rather than a toolbar recovery', async ({ context, background, extensionId }) => {
  const page = await context.newPage();
  await page.goto('chrome://version/');
  const tabId = await tabIdForUrl(background, 'chrome://version');
  const panel = await context.newPage();
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));
  await dispatch(background, { kind: 'session/start', tabId, media: { video: true, mic: false } });
  await expect(panel.getByRole('alert')).toContainText('Video recording is unavailable on this browser page');
  expect(await dispatch(background, { kind: 'session/getState' })).toMatchObject({ videoOn: false });
  await dispatch(background, { kind: 'session/stop' });
});

test('successful microphone startup preserves the video authorization error', async ({ context, background, extensionId }) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  // This fixture uses synthetic microphone input; tab capture remains uninvoked.
  await background.evaluate(async () => chrome.storage.local.set({ micGranted: true }));
  const panel = await context.newPage();
  await panel.goto(extUrl(extensionId, 'sidepanel.html'));
  await dispatch(background, { kind: 'session/start', tabId, media: { video: true, mic: true } });
  expect(await dispatch(background, { kind: 'session/getState' })).toMatchObject({ micOn: true, videoOn: false });
  await expect(panel.getByRole('alert')).toContainText(/click the Session Recorder icon/);
  await dispatch(background, { kind: 'session/stop' });
});
