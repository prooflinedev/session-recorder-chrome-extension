import { test, expect, extUrl } from './support';

test('copies a shell-escaped cURL command for HTTP requests and omits WebSockets', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(extUrl(extensionId, 'report.html'));

  const sessionId = 'sess_curl_e2e';
  const startedAt = Date.UTC(2026, 10, 16, 12, 0, 0);

  await page.evaluate(
    async ({ sid, ts }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('session-recorder', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('sessions')) {
            d.createObjectStore('sessions', { keyPath: 'id' });
          }
          if (!d.objectStoreNames.contains('events')) {
            const ev = d.createObjectStore('events', { keyPath: 'id' });
            ev.createIndex('by-session', ['sessionId', 't']);
          }
          if (!d.objectStoreNames.contains('assets')) {
            const as = d.createObjectStore('assets', { keyPath: 'id' });
            as.createIndex('by-session', 'sessionId');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const tx = db.transaction(['sessions', 'events'], 'readwrite');
      tx.objectStore('sessions').put({
        id: sid,
        name: 'Checkout failure',
        startedAt: ts,
        endedAt: ts + 2000,
        initialUrl: 'https://app.example.com/checkout',
        tabs: [
          {
            tabId: 1,
            url: 'https://app.example.com/checkout',
            title: 'Checkout',
            attachedAt: ts,
            role: 'primary',
            attached: true,
          },
        ],
        settings: {
          screenshotPolicy: 'key-moments',
          bodyCapBytes: 262144,
          fileCapBytes: 26214400,
          captureRaw: false,
          customRedaction: { headers: [], bodyKeys: [], urlParams: [] },
        },
        status: 'stopped',
        counts: { 'net-request': 2 },
        assetBytes: 0,
      });

      tx.objectStore('events').put({
        id: 'evt_http_1',
        sessionId: sid,
        t: 500,
        tabId: 1,
        type: 'net-request',
        importance: 80,
        payload: {
          requestId: 'req-http-1',
          method: 'POST',
          url: 'https://api.example.com/v1/checkout',
          status: 500,
          timing: { startedAt: ts + 500, durationMs: 142 },
          requestHeaders: [
            { name: ':method', value: 'POST' },
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Authorization', value: '«redacted»' },
          ],
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          requestBody: {
            present: true,
            mime: 'application/json',
            text: '{"plan":"pro","note":"O\'Connor"}',
          },
        },
      });

      tx.objectStore('events').put({
        id: 'evt_ws_1',
        sessionId: sid,
        t: 1000,
        tabId: 1,
        type: 'net-request',
        importance: 50,
        payload: {
          requestId: 'req-ws-1',
          method: 'GET',
          url: 'wss://api.example.com/ws',
          websocket: true,
          requestHeaders: [],
          responseHeaders: [],
        },
      });

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { sid: sessionId, ts: startedAt },
  );

  await page.goto(extUrl(extensionId, `report.html?session=${sessionId}`));

  // Capture clipboard writes deterministically across headless and headed Chromium.
  await page.evaluate(() => {
    (window as unknown as { __copiedCurl: string | null }).__copiedCurl = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __copiedCurl: string | null }).__copiedCurl = text;
        },
      },
    });
  });

  const copyBtn = page.getByRole('button', {
    name: 'Copy cURL for POST /v1/checkout',
  });
  await expect(copyBtn).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Copy cURL for .*\/ws/ }),
  ).toHaveCount(0);

  await copyBtn.click();
  await expect(copyBtn).toHaveText('Copied');

  const copied = await page.evaluate(
    () => (window as unknown as { __copiedCurl: string | null }).__copiedCurl,
  );
  expect(copied).toBe(
    [
      `curl -X 'POST' 'https://api.example.com/v1/checkout'`,
      `-H 'Content-Type: application/json'`,
      `-H 'Authorization: «redacted»'`,
      `--data-raw '{"plan":"pro","note":"O'\\''Connor"}'`,
    ].join(' \\\n  '),
  );
});
