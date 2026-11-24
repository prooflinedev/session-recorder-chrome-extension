import { test, expect, dispatch, extUrl, tabIdForUrl } from './support';

async function makeScreenshotDataUrl(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#f00';
    context.fillRect(30, 20, 30, 20);
    return canvas.toDataURL('image/png');
  });
}

async function addScreenshotEvidence(
  page: import('@playwright/test').Page,
  sessionId: string,
  dataUrl: string,
): Promise<void> {
  await page.evaluate(async ({ sessionId, dataUrl }) => {
    const blob = await (await fetch(dataUrl)).blob();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('session-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['assets', 'events', 'sessions'], 'readwrite');
    tx.objectStore('assets').put({
      id: 'redaction-test-asset', sessionId, kind: 'screenshot', mime: 'image/png', size: blob.size, blob,
    });
    tx.objectStore('events').put({
      id: 'redaction-test-shot', sessionId, t: 500, type: 'screenshot', importance: 30, protected: true,
      payload: { assetId: 'redaction-test-asset', width: 120, height: 80, trigger: 'manual' },
    });
    const sessionStore = tx.objectStore('sessions');
    const session = await new Promise<any>((resolve, reject) => {
      const request = sessionStore.get(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    session.assetBytes += blob.size;
    sessionStore.put(session);
    tx.objectStore('events').put({
      id: 'redaction-test-annotation', sessionId, t: 600, type: 'annotation', importance: 90, protected: true,
      payload: { screenshotAssetId: 'redaction-test-asset', viewport: { w: 120, h: 80 }, shapes: [] },
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { sessionId, dataUrl });
}

async function screenshotPixels(page: import('@playwright/test').Page): Promise<{ inside: number[]; outside: number[] }> {
  return page.evaluate(async () => {
    const request = indexedDB.open('session-recorder');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const asset = await new Promise<any>((resolve, reject) => {
      const get = db.transaction('assets').objectStore('assets').get('redaction-test-asset');
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    const bitmap = await createImageBitmap(asset.blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const inside = Array.from(context.getImageData(35, 25, 1, 1).data);
    const outside = Array.from(context.getImageData(5, 5, 1, 1).data);
    bitmap.close();
    db.close();
    return { inside, outside };
  });
}

async function redactionState(page: import('@playwright/test').Page): Promise<{ mime: string; size: number; sha256: string; actualSha256: string; revision: number; masks: Array<{ x: number; y: number; width: number; height: number }>; hasOriginal: boolean }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('session-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const asset = await new Promise<any>((resolve, reject) => {
      const request = db.transaction('assets').objectStore('assets').get('redaction-test-asset');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const digest = await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer());
    const actualSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    db.close();
    return {
      mime: asset.mime,
      size: asset.size,
      sha256: asset.sha256,
      actualSha256,
      revision: asset.localScreenshotRedaction?.revision ?? 0,
      masks: asset.localScreenshotRedaction?.rectangles ?? [],
      hasOriginal: !!asset.localScreenshotRedaction?.originalBlob,
    };
  });
}

test('redacts screenshot pixels, keeps edits across reload, and can restore the original', async ({ context, background, extensionId }) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string } }>(background, { kind: 'session/start', tabId });
  await dispatch(background, { kind: 'session/stop' });
  const dataUrl = await makeScreenshotDataUrl(demo);
  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `report.html?session=${started.session.id}&level=L0`));
  await addScreenshotEvidence(report, started.session.id, dataUrl);
  await report.reload();

  const redact = report.getByRole('button', { name: 'Redact screenshot' });
  await expect(redact).toHaveCount(3);
  await redact.nth(1).click();
  const dialog = report.getByRole('dialog', { name: 'Redact screenshot' });
  await expect(dialog).toBeVisible();
  const image = dialog.getByAltText('Screenshot being edited');
  await expect(image).toHaveJSProperty('naturalWidth', 120);
  await dialog.getByRole('button', { name: 'Draw mask' }).click();
  const box = await image.boundingBox();
  if (!box) throw new Error('Screenshot editor image is not laid out.');
  await report.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.15);
  await report.mouse.down();
  await report.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 4 });
  const preview = dialog.locator('.r-redact__mask--preview');
  await expect(preview).toBeVisible();
  const previewBounds = await preview.boundingBox();
  expect(previewBounds?.width).toBeGreaterThan(0);
  expect(previewBounds?.height).toBeGreaterThan(0);
  await report.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Mask 1:/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Undo' }).click();
  await expect(dialog.getByRole('button', { name: /Mask [0-9]+:/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Draw mask' }).click();
  await report.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.15);
  await report.mouse.down();
  await report.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 4 });
  await report.mouse.up();
  await dialog.getByRole('button', { name: 'Draw mask' }).click();
  await report.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.65);
  await report.mouse.down();
  await report.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.25, { steps: 4 });
  await report.mouse.up();
  await expect(dialog.getByRole('spinbutton')).toHaveCount(0);
  const firstMask = dialog.getByRole('button', { name: /Mask 1:/ });
  await firstMask.click();
  await firstMask.press('ArrowRight');
  const firstMaskBox = dialog.locator('.r-redact__mask.is-selected');
  const firstMaskBounds = await firstMaskBox.boundingBox();
  if (!firstMaskBounds) throw new Error('Selected mask has no visible bounds.');
  await report.mouse.move(firstMaskBounds.x + firstMaskBounds.width / 2, firstMaskBounds.y + firstMaskBounds.height / 2);
  await report.mouse.down();
  await report.mouse.move(firstMaskBounds.x + firstMaskBounds.width / 2 + 6, firstMaskBounds.y + firstMaskBounds.height / 2 + 4, { steps: 3 });
  await report.mouse.up();

  await dialog.getByRole('button', { name: /Mask 2:/ }).click();
  const resizeHandle = dialog.locator('.r-redact__mask.is-selected .r-redact__resize');
  const handleBounds = await resizeHandle.boundingBox();
  if (!handleBounds) throw new Error('Selected mask resize handle is not visible.');
  await report.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
  await report.mouse.down();
  await report.mouse.move(handleBounds.x + handleBounds.width / 2 + 10, handleBounds.y + handleBounds.height / 2 + 8, { steps: 3 });
  await report.mouse.up();
  const before = await report.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('session-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const session = await new Promise<any>((resolve, reject) => {
      const request = db.transaction('sessions').objectStore('sessions').get(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const asset = await new Promise<any>((resolve, reject) => {
      const request = db.transaction('assets').objectStore('assets').get('redaction-test-asset');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { assetBytes: session.assetBytes, assetSize: asset.size };
  }, started.session.id);
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();

  const saved = await redactionState(report);
  expect(saved.mime).toBe('image/png');
  expect(saved.size).toBeGreaterThan(0);
  expect(saved.sha256).toBe(saved.actualSha256);
  const afterBytes = await report.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('session-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const session = await new Promise<any>((resolve, reject) => {
      const request = db.transaction('sessions').objectStore('sessions').get(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return session.assetBytes;
  }, started.session.id);
  expect(afterBytes - before.assetBytes).toBe(saved.size - before.assetSize);
  expect(saved.revision).toBe(1);
  expect(saved.hasOriginal).toBe(true);
  expect(saved.masks).toHaveLength(2);
  expect(saved.masks[0]!.x).toBeGreaterThan(0.24);
  expect(saved.masks[0]!.y).toBeGreaterThan(0.18);
  expect(saved.masks[1]!.width).toBeGreaterThan(0.48);
  expect(saved.masks[1]!.height).toBeGreaterThan(0.48);
  const redactedPixels = await screenshotPixels(report);
  expect(redactedPixels.inside).toEqual([0, 0, 0, 255]);
  expect(redactedPixels.outside).toEqual([255, 255, 255, 255]);
  await expect(report.locator('.r-shot img')).toHaveCount(3);

  await report.reload();
  await expect(report.locator('.r-shot img')).toHaveCount(3);
  expect((await screenshotPixels(report)).inside).toEqual([0, 0, 0, 255]);

  await report.getByRole('button', { name: 'Redact screenshot' }).nth(1).click();
  const reopened = report.getByRole('dialog', { name: 'Redact screenshot' });
  await expect(reopened.getByRole('button', { name: /Mask 1:/ })).toBeVisible();
  await reopened.getByRole('button', { name: 'Clear all' }).click();
  await reopened.getByRole('button', { name: 'Apply' }).click();
  await expect(reopened).toBeHidden();
  const restored = await screenshotPixels(report);
  expect(restored.inside).toEqual([255, 0, 0, 255]);
  expect(restored.outside).toEqual([255, 255, 255, 255]);
  const cleared = await redactionState(report);
  expect(cleared.revision).toBe(2);
  expect(cleared.masks).toHaveLength(0);
  expect(cleared.hasOriginal).toBe(false);
});

test('cancelling edits leaves the saved screenshot untouched', async ({ context, background, extensionId }) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string } }>(background, { kind: 'session/start', tabId });
  await dispatch(background, { kind: 'session/stop' });
  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `report.html?session=${started.session.id}&level=L0`));
  await addScreenshotEvidence(report, started.session.id, await makeScreenshotDataUrl(demo));
  await report.reload();
  await report.getByRole('button', { name: 'Redact screenshot' }).nth(1).click();
  const dialog = report.getByRole('dialog', { name: 'Redact screenshot' });
  await report.setViewportSize({ width: 430, height: 900 });
  await expect(dialog).toBeVisible();
  const dialogFitsNarrowViewport = await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(dialogFitsNarrowViewport).toBe(true);
  await dialog.getByRole('button', { name: 'Draw mask' }).click();
  const box = await dialog.getByAltText('Screenshot being edited').boundingBox();
  if (!box) throw new Error('Screenshot editor image is not laid out.');
  await report.mouse.move(box.x + 10, box.y + 10);
  await report.mouse.down();
  await report.mouse.move(box.x + 40, box.y + 30);
  await report.mouse.up();
  await report.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(report.getByRole('button', { name: 'Redact screenshot' }).nth(1)).toBeFocused();
  const pixels = await screenshotPixels(report);
  expect(pixels.inside).toEqual([255, 0, 0, 255]);
  expect(pixels.outside).toEqual([255, 255, 255, 255]);
});

test('marks a previously published report stale after screenshot redaction', async ({ context, background, extensionId }) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string } }>(background, { kind: 'session/start', tabId });
  await dispatch(background, { kind: 'session/stop' });
  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `report.html?session=${started.session.id}&level=L0`));
  await addScreenshotEvidence(report, started.session.id, await makeScreenshotDataUrl(demo));
  await report.evaluate(async (sessionId) => {
    await chrome.storage.local.set({ [`shareDraft:${sessionId}`]: {
      draft: { title: 'Existing report', body: 'Saved issue draft' },
      repository: 'proofline/test',
      publicationRevision: '',
      publication: {
        deployment: { id: 'deployment-old', url: 'https://old-report.pages.dev', environment: 'production', latest_stage: { name: 'deploy', status: 'success' } },
        destination: { accountId: 'account', projectName: 'report', branch: 'main' },
        level: 'L0',
      },
    } });
  }, started.session.id);
  await report.reload();

  const share = await context.newPage();
  await share.goto(extUrl(extensionId, `share.html?session=${started.session.id}&level=L0`));
  const fileIssue = share.getByRole('button', { name: 'File GitHub issue' });
  await expect(fileIssue).toBeVisible();
  await expect(fileIssue).toBeEnabled();

  await report.getByRole('button', { name: 'Redact screenshot' }).nth(1).click();
  const dialog = report.getByRole('dialog', { name: 'Redact screenshot' });
  await expect(dialog.getByText(/An existing shared copy will not change/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Draw mask' }).click();
  const box = await dialog.getByAltText('Screenshot being edited').boundingBox();
  if (!box) throw new Error('Screenshot editor image is not laid out.');
  await report.mouse.move(box.x + 12, box.y + 10);
  await report.mouse.down();
  await report.mouse.move(box.x + 40, box.y + 30);
  await report.mouse.up();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();

  await expect(share.getByText(/Unpublish the existing report before publishing the updated screenshots/)).toBeVisible();
  await expect(share.getByText('Redaction changed')).toHaveCount(2);
  await expect(fileIssue).toBeDisabled();
  await expect(share.locator('.advanced-report')).toHaveJSProperty('open', true);
  await expect(share.getByRole('button', { name: 'Unpublish report…' })).toBeVisible();
});

test('rejects an editor that tries to overwrite a newer redaction from another tab', async ({ context, background, extensionId }) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string } }>(background, { kind: 'session/start', tabId });
  await dispatch(background, { kind: 'session/stop' });
  const dataUrl = await makeScreenshotDataUrl(demo);
  const first = await context.newPage();
  await first.goto(extUrl(extensionId, `report.html?session=${started.session.id}&level=L0`));
  await addScreenshotEvidence(first, started.session.id, dataUrl);
  await first.reload();
  const second = await context.newPage();
  await second.goto(extUrl(extensionId, `report.html?session=${started.session.id}&level=L0`));

  await first.getByRole('button', { name: 'Redact screenshot' }).nth(1).click();
  await second.getByRole('button', { name: 'Redact screenshot' }).nth(1).click();
  const firstDialog = first.getByRole('dialog', { name: 'Redact screenshot' });
  const secondDialog = second.getByRole('dialog', { name: 'Redact screenshot' });
  const drawOneMask = async (page: import('@playwright/test').Page, dialog: import('@playwright/test').Locator, start: number) => {
    await dialog.getByRole('button', { name: 'Draw mask' }).click();
    const box = await dialog.getByAltText('Screenshot being edited').boundingBox();
    if (!box) throw new Error('Screenshot editor image is not laid out.');
    await page.mouse.move(box.x + start, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + start + 20, box.y + 28);
    await page.mouse.up();
  };
  await drawOneMask(first, firstDialog, 10);
  await firstDialog.getByRole('button', { name: 'Apply' }).click();
  await expect(firstDialog).toBeHidden();

  await drawOneMask(second, secondDialog, 45);
  await secondDialog.getByRole('button', { name: 'Apply' }).click();
  await expect(secondDialog.getByRole('status')).toContainText('changed in another window');
  await expect(secondDialog).toBeVisible();
  await secondDialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await redactionState(first)).revision).toBe(1);
});
