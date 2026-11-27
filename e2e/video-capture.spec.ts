import { chromium } from '@playwright/test';
import { unzipSync } from 'fflate';
import { test, expect, dispatch, extUrl, tabIdForUrl, EXT_PATH } from './support';

test('from-start video is finalized, playable, and included in the full export', async ({}, testInfo) => {
  const probe = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  const probeSw = probe.serviceWorkers()[0] || await probe.waitForEvent('serviceworker');
  const extensionId = new URL(probeSw.url()).host;
  await probe.close();

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      // The test drives the service worker without clicking Chrome's toolbar,
      // so allowlist this test extension while exercising real tabCapture.
      `--allowlisted-extension-id=${extensionId}`,
    ],
  });

  try {
    const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;
    const page = await context.newPage();
    await page.goto('http://localhost:5319/');
    const tabId = await tabIdForUrl(background, 'http://localhost:5319');
    const panel = await context.newPage();
    await panel.goto(extUrl(extensionId, 'sidepanel.html'));
    await panel.evaluate((targetTabId) => {
      const tabs = chrome.tabs as typeof chrome.tabs & { query: (...args: any[]) => Promise<chrome.tabs.Tab[]> };
      const query = tabs.query.bind(chrome.tabs);
      Object.defineProperty(tabs, 'query', {
        configurable: true,
        value: async (queryInfo: chrome.tabs.QueryInfo) =>
          queryInfo.active && queryInfo.currentWindow
            ? [{ id: targetTabId } as chrome.tabs.Tab]
            : query(queryInfo),
      });
    }, tabId);

    for (const effects of [false, true]) {
      await panel.getByRole('button', { name: 'Capture options', exact: true }).click();
      const videoSwitch = panel.getByRole('switch', { name: /Video/ });
      if ((await videoSwitch.getAttribute('aria-checked')) !== 'true') await videoSwitch.click();
      const spotlightSwitch = panel.getByRole('switch', { name: /Cursor spotlight/ });
      if ((await spotlightSwitch.getAttribute('aria-checked')) !== String(effects)) await spotlightSwitch.click();
      const clickSwitch = panel.getByRole('switch', { name: /Highlight clicks/ });
      if ((await clickSwitch.getAttribute('aria-checked')) !== String(effects)) await clickSwitch.click();
      await panel.getByRole('button', { name: 'Capture options', exact: true }).click();
      await panel.getByRole('button', { name: 'Start recording', exact: true }).click();

      await expect.poll(async () => {
        const state = await dispatch<{ videoOn: boolean }>(background, { kind: 'session/getState' });
        return state.videoOn;
      }).toBe(true);
      const started = await dispatch<{
        session?: {
          id: string;
          settings: { cursorSpotlight: boolean; clickHighlight: boolean };
        };
      }>(background, { kind: 'session/getState' });
      expect(started.session?.settings.cursorSpotlight).toBe(effects);
      expect(started.session?.settings.clickHighlight).toBe(effects);

      await page.mouse.move(300, 230);
      await page.mouse.click(300, 230);
      await page.waitForTimeout(900);
      await dispatch(background, { kind: 'session/stop' });

      const viewer = await context.newPage();
      await viewer.goto(extUrl(extensionId, `report.html?session=${started.session!.id}`));
      const media = await viewer.evaluate(async (sessionId) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('session-recorder');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const assets = await new Promise<any[]>((resolve, reject) => {
          const request = db.transaction('assets', 'readonly').objectStore('assets')
            .index('by-session').getAll(sessionId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const events = await new Promise<any[]>((resolve, reject) => {
          const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
          const request = db.transaction('events', 'readonly').objectStore('events')
            .index('by-session').getAll(range);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        const segment = events.find((event) => event.type === 'video-segment');
        const asset = assets.find((item) => item.id === segment?.payload.assetId);
        if (!asset?.blob || asset.blob.size === 0) throw new Error('Finalized video asset is missing');

        const video = document.createElement('video');
        video.muted = true;
        video.src = URL.createObjectURL(asset.blob);
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error('Finalized WebM is not playable'));
        });
        const advanced = new Promise<void>((resolve) => {
          video.addEventListener('timeupdate', () => resolve(), { once: true });
        });
        await video.play();
        await advanced;
        const result = {
          assetId: asset.id,
          size: asset.blob.size,
          mime: asset.blob.type,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          bytes: Array.from(new Uint8Array(await asset.blob.arrayBuffer())),
        };
        video.pause();
        URL.revokeObjectURL(video.src);
        return result;
      }, started.session!.id);
      expect(media.mime).toContain('video/webm');
      expect(media.size).toBeGreaterThan(0);
      expect(media.duration).toBeGreaterThan(0);
      expect(media.width).toBeGreaterThan(0);
      expect(media.height).toBeGreaterThan(0);

      await viewer.evaluate(() => {
        (window as any).__videoZip = null;
        chrome.downloads.download = (async (options: { url: string }) => {
          (window as any).__videoZip = Array.from(new Uint8Array(await (await fetch(options.url)).arrayBuffer()));
          return 1;
        }) as typeof chrome.downloads.download;
      });
      await viewer.getByRole('button', { name: 'Full', exact: true }).click();
      await viewer.getByRole('button', { name: /Download .zip/i }).click();
      await viewer.waitForFunction(() => (window as any).__videoZip !== null);
      const files = unzipSync(new Uint8Array(await viewer.evaluate(() => (window as any).__videoZip)));
      const exportedVideos = Object.entries(files).filter(([name]) => name.endsWith('.webm'));
      expect(exportedVideos.length).toBeGreaterThan(0);
      expect(exportedVideos.some(([, bytes]) => Buffer.from(bytes).equals(Buffer.from(media.bytes)))).toBe(true);

      await testInfo.attach(`from-start-effects-${effects ? 'enabled' : 'disabled'}`, {
        body: Buffer.from(media.bytes),
        contentType: 'video/webm',
      });
      await viewer.close();
    }
  } finally {
    await context.close();
  }
});
