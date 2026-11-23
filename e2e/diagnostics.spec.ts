import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

test('searches and filters all saved diagnostics without changing the recording', async ({ context, background, extensionId }) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ session: { id: string } }>(background, { kind: 'session/start', tabId });
  const sessionId = started.session.id;
  await dispatch(background, { kind: 'marker/add', name: 'test' });
  await dispatch(background, { kind: 'session/stop' });

  // Playwright owns the debugger connection, so seed realistic diagnostic events
  // through the extension's IndexedDB instead of pretending CDP captured them.
  const workspace = await context.newPage();
  await workspace.goto(extUrl(extensionId, 'options.html'));
  await workspace.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('session-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      const store = tx.objectStore('events');
      for (let i = 0; i < 120; i++) {
        store.put({ id: `diagnostic-${i}`, sessionId: id, t: 10000 + i, importance: 1, type: 'net-request', payload: { requestId: `req-${i}`, method: 'GET', url: `https://api.example.test/items/${i}`, status: i === 119 ? 503 : 200, requestHeaders: [], responseHeaders: [], responseBody: {present: true, text: i === 119 ? 'Unique response needle' : 'ok'} } });
      }
      store.put({id: 'diagnostic-error', sessionId: id, t: 12000, importance: 10, type: 'error', payload: {message: 'Checkout crashed', origin: 'exception'}});
      store.put({id: 'diagnostic-console', sessionId: id, t: 13000, importance: 1, type: 'console', payload: {level: 'warn', text: 'Retrying "checkout"'}});
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, sessionId);
  await workspace.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  await expect(workspace.getByRole('searchbox', {name: 'Search diagnostics'})).toHaveCount(0);
  await workspace.getByText('Technical details', { exact: false }).click();
  const search = workspace.getByRole('searchbox', {name: 'Search diagnostics'});
  const type = workspace.getByLabel('Event type');
  const count = workspace.locator('.diagnostics-count');
  await expect(count).toContainText(/\d+ of \d+ events match/);
  const total = Number((await count.textContent())?.match(/of (\d+)/)?.[1]);
  expect(total).toBeGreaterThanOrEqual(122);
  await expect(workspace.getByRole('button', {name: 'Show more events'})).toBeVisible();
  await search.fill('UNIQUE RESPONSE NEEDLE');
  await expect(count).toContainText(`1 of ${total} events match`);
  const event = workspace.locator('.diagnostic-event').filter({hasText: '/items/119'});
  await expect(event).toBeVisible();
  await event.locator('summary').click();
  await expect(event.locator('pre')).toContainText('Unique response needle');
  await type.selectOption('console');
  await expect(workspace.getByText('No matching diagnostics.')).toBeVisible();
  await search.fill('"checkout"');
  await expect(workspace.locator('.diagnostic-event')).toHaveCount(1);
  await expect(workspace.locator('.diagnostic-event')).toContainText('Retrying "checkout"');
  await search.fill('checkout');
  await type.selectOption('error');
  await expect(workspace.locator('.diagnostic-event')).toContainText('Checkout crashed');
  await type.selectOption('all');
  await search.fill('');
  await workspace.getByRole('button', {name: 'Show more events'}).click();
  await expect(workspace.locator('.diagnostic-event')).toHaveCount(100);
  await workspace.getByRole('button', {name: 'Show more events'}).click();
  await expect(workspace.locator('.diagnostic-event')).toHaveCount(total);
  await workspace.reload();
  await workspace.getByText('Technical details', {exact: false}).click();
  await expect(workspace.locator('.diagnostics-count')).toContainText(`${total} of ${total} events match`);
  await workspace.getByRole('searchbox', {name: 'Search diagnostics'}).fill('Unique response needle');
  const savedEvent = workspace.locator('.diagnostic-event').filter({hasText: '/items/119'});
  await savedEvent.locator('summary').click();
  await expect(savedEvent.locator('pre')).toContainText('Unique response needle');
});
