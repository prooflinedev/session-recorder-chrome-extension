import { dispatch, expect, extUrl, tabIdForUrl, test } from './support';

test('explores recorded console activity from the report charts', async ({ context, background, extensionId }) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const { session } = await dispatch<{ session: { id: string } }>(background, { kind: 'session/start', tabId });
  await dispatch(background, { kind: 'session/stop' });
  const fixtureId = `${session.id}-console-fixture`;

  // Seed stored console evidence directly because debugger attachment can be
  // unavailable under Playwright. The page still loads the actual report.
  await background.evaluate(async ({ sessionId, fixtureId }) => {
    const opened = indexedDB.open('session-recorder');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    try {
      const tx = db.transaction(['sessions', 'events'], 'readwrite');
      const sessions = tx.objectStore('sessions');
      const original = sessions.get(sessionId);
      original.onsuccess = () => sessions.put({ ...original.result, id: fixtureId });
      const store = tx.objectStore('events');
      const records = [
        { id: 'console-error-a', t: 100, level: 'error', text: 'Checkout failed', repeat: 2 },
        { id: 'console-error-b', t: 1100, level: 'error', text: 'Checkout failed' },
        { id: 'console-warning', t: 200, level: 'warn', text: '<img src=x onerror=alert(1)>' },
      ];
      for (const { id, t, ...payload } of records)
        store.put({ id, sessionId: fixtureId, t, type: 'console', payload });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, { sessionId: session.id, fixtureId });

  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `share.html?session=${fixtureId}`));
  const insights = report.getByRole('region', { name: 'Console Insights' });
  await expect(insights).toContainText('Error occurrences: 3. Distinct error groups: 1.');
  await insights.getByRole('button', { name: '0s to 1s: 2 errors' }).click();
  await expect(insights.getByText('console-error-a')).toBeVisible();
  await expect(insights.getByText('console-error-b')).toHaveCount(0);
  await insights.getByRole('button', { name: 'Checkout failed 3' }).click();
  await expect(insights.getByText('console-error-b')).toBeVisible();
  await insights.getByRole('button', { name: 'Warnings 1' }).click();
  await expect(insights.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(insights.locator('img')).toHaveCount(0);
  await insights.getByRole('button', { name: 'Clear selection' }).click();
  await expect(insights.getByRole('heading', { name: /Matching console events/ })).toHaveCount(0);

  await report.emulateMedia({ colorScheme: 'dark' });
  await report.setViewportSize({ width: 390, height: 844 });
  await expect(insights.getByRole('heading', { name: 'Severity distribution' })).toBeVisible();
  expect(await insights.evaluate((section) => section.scrollWidth <= section.clientWidth)).toBe(true);
});
