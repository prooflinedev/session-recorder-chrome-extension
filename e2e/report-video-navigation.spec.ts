import { test, expect, dispatch, extUrl, tabIdForUrl } from './support';

async function makeWebmDataUrl(page: import('@playwright/test').Page): Promise<string> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(15);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start();
    const frameTimer = window.setInterval(() => {
      context.fillStyle = `hsl(${(Date.now() / 30) % 360} 70% 50%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, 30);
    await new Promise((resolve) => window.setTimeout(resolve, 2_500));
    window.clearInterval(frameTimer);
    recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();
    return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
  });
  return `data:video/webm;base64,${Buffer.from(bytes).toString('base64')}`;
}

test('event timestamps seek and play the video segment covering that moment', async ({ context, background, extensionId }) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string } }>(background, { kind: 'session/start', tabId });
  await dispatch(background, { kind: 'session/stop' });

  const dataUrl = await makeWebmDataUrl(demo);
  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `report.html?session=${started.session.id}&level=L0`));
  await report.evaluate(async ({ sessionId, dataUrl }) => {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('session-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['assets', 'events'], 'readwrite');
    const assets = tx.objectStore('assets');
    const events = tx.objectStore('events');
    for (const [index, [start, end]] of [[5_000, 10_000], [10_000, 15_000], [20_000, 25_000]].entries()) {
      const id = `video-test-asset-${index}`;
      assets.put({ id, sessionId, kind: 'video', mime: 'video/webm', size: blob.size, blob });
      events.put({
        id: `video-test-segment-${index}`, sessionId, t: start,
        type: 'video-segment', importance: 60, protected: true,
        payload: { assetId: id, tStart: start, tEnd: end },
      });
    }
    events.put({
      id: 'video-test-click', sessionId, t: 8_000,
      type: 'click', importance: 50, protected: false,
      payload: { descriptor: { tag: 'button', text: 'Save changes' } },
    });
    events.put({
      id: 'video-test-boundary', sessionId, t: 10_000,
      type: 'marker', importance: 90, protected: true, payload: { name: 'Video segment boundary' },
    });
    for (const [index, time] of [11_000, 12_000, 13_000].entries()) events.put({
      id: `video-test-network-${index}`, sessionId, t: time,
      type: 'net-request', importance: 30, protected: false,
      payload: { requestId: `request-${index}`, method: 'GET', url: `http://localhost:5319/api/item-${index}`, requestHeaders: [], responseHeaders: [], status: 200 },
    });
    events.put({
      id: 'video-test-gap-event', sessionId, t: 17_000,
      type: 'marker', importance: 90, protected: true,
      payload: { name: 'Video was paused' },
    });
    events.put({
      id: 'video-test-missing', sessionId, t: 30_000,
      type: 'video-segment', importance: 60, protected: true,
      payload: { assetId: 'missing-video-asset', tStart: 30_000, tEnd: 35_000 },
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { sessionId: started.session.id, dataUrl });
  await report.reload();

  const jump = report.getByRole('button', { name: 'Jump to video at 00:08' }).first();
  await expect(jump).toBeVisible();
  await jump.focus();
  await jump.press('Enter');
  const videos = report.locator('.r-shot video');
  await expect(videos).toHaveCount(3);
  await expect.poll(() => videos.nth(0).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(1.9);
  await expect(videos.nth(0)).toHaveJSProperty('paused', false);
  await report.getByRole('button', { name: 'Jump to video at 00:10' }).first().click();
  await expect.poll(() => videos.nth(1).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeLessThan(1);
  const networkJump = report.getByRole('button', { name: 'Jump to video at 00:11' });
  await expect(networkJump).toBeVisible();
  await networkJump.click();
  await expect.poll(() => videos.nth(1).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeLessThan(1.8);
  const requestDisclosure = report.locator('.r-netgroup__toggle');
  await expect(requestDisclosure).toHaveAttribute('aria-expanded', 'false');
  await requestDisclosure.focus();
  await requestDisclosure.press('Enter');
  await expect(requestDisclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(report.getByText('GET /api/item-0')).toBeVisible();
  await expect(report.getByRole('button', { name: 'Jump to video at 00:17' })).toHaveCount(0);
  await expect(report.getByRole('button', { name: 'Jump to video at 00:30' })).toHaveCount(0);

  await report.getByRole('button', { name: 'Full', exact: true }).click();
  await expect(report.getByRole('button', { name: 'Jump to video at 00:08' }).first()).toBeVisible();
  await report.getByRole('button', { name: 'Standard', exact: true }).click();
  await expect(report.getByRole('button', { name: 'Jump to video at 00:08' }).first()).toBeVisible();
  await report.getByRole('button', { name: 'Minimal', exact: true }).click();
  const minimalJump = report.getByRole('button', { name: 'Jump to video at 00:08' }).first();
  await expect(minimalJump).toBeVisible();
  await minimalJump.click();
  await expect.poll(() => videos.nth(0).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(1.9);
});
