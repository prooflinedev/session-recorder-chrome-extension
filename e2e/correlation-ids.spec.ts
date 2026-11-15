/**
 * A failed request's correlation IDs reach the exported report.
 *
 * Playwright can keep the extension's chrome.debugger from attaching (see
 * record-export.spec.ts), so this test does not depend on capturing a real
 * request. Two requests enter through the background's real message
 * dispatcher, the way a capture source hands an event to the funnel. After
 * that everything is the real path: the funnel, IndexedDB, the report page,
 * its Download button and the zip. The unit tests cover the capture of the
 * headers themselves.
 */
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

test('a failed request lists its correlation IDs in the exported report', async ({
  context,
  background,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ ok: boolean; session?: { id: string } }>(
    background,
    { kind: 'session/start', tabId },
  );
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;

  const request = (path: string, status: number, serverId: string) => ({
    kind: 'capture/event',
    event: {
      type: 'net-request',
      tabId,
      payload: {
        requestId: `req${path}`,
        method: 'POST',
        url: `http://localhost:5319${path}`,
        resourceType: 'Fetch',
        status,
        requestHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'traceparent', value: TRACEPARENT },
        ],
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'X-Request-Id', value: serverId },
        ],
        requestBody: { present: true, mime: 'application/json', text: '{"cart":"c1"}' },
        responseBody: { present: true, mime: 'application/json', text: '{"ok":false}' },
      },
    },
  });
  await dispatch(
    background,
    request('/api/cart', 200, 'id-of-the-request-that-worked'),
  );
  await dispatch(background, request('/api/orders', 500, '5f1c0a52'));
  await dispatch(background, { kind: 'session/stop' });

  // Minimal is the level that trims hardest; the IDs must survive it.
  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `report.html?session=${sessionId}&level=L3`));
  await expect(report.getByRole('button', { name: /Download .zip/i })).toBeVisible();
  await report.evaluate(() => {
    (window as any).__dl = null;
    chrome.downloads.download = (async (opts: { url: string; filename: string }) => {
      const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
      (window as any).__dl = Array.from(new Uint8Array(buf));
      return 1;
    }) as typeof chrome.downloads.download;
  });
  await report.getByRole('button', { name: /Download .zip/i }).click();
  await report.waitForFunction(() => (window as any).__dl !== null, undefined, {
    timeout: 20_000,
  });
  const files = unzipSync(
    Uint8Array.from((await report.evaluate(() => (window as any).__dl)) as number[]),
  );
  const text = (suffix: string) => {
    const key = Object.keys(files).find((k) => k.endsWith(suffix));
    expect(key, `zip contains ${suffix}`).toBeTruthy();
    return new TextDecoder().decode(files[key!]);
  };
  const md = text('/report.md');

  expect(md).toContain('**Verbosity level:** L3');
  expect(md).toContain(
    [
      '🌐 500 POST /api/orders',
      '- response correlation IDs: `x-request-id: 5f1c0a52`',
      `- request correlation IDs: \`traceparent: ${TRACEPARENT}\``,
    ].join('\n'),
  );
  // Only the failed request is annotated; the one that worked keeps its line.
  expect(md).toContain('🌐 200 POST /api/cart');
  expect(md).not.toContain('id-of-the-request-that-worked');
  expect(md.match(/correlation IDs/g)).toHaveLength(2);
  // session.json is unchanged: it held every header before, and still does.
  const session = text('/session.json');
  expect(session).toContain('id-of-the-request-that-worked');
  expect(session).toContain('5f1c0a52');
});
