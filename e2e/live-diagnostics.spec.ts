import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

test('searches diagnostics captured from a real recording', async ({ context, background, extensionId }) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const start = await dispatch<{ok: boolean; session: {id: string}}>(background, {kind: 'session/start', tabId});
  expect(start.ok).toBe(true);
  await page.evaluate(async () => {
    console.warn('Live browser diagnostic zebra');
    try { await fetch('/live-diagnostic-probe-xyz'); } catch { /* request can fail */ }
  });
  let captureStatus = '';
  await expect.poll(async () => {
    const {events} = await dispatch<{events: Array<{type: string; payload: Record<string, unknown>}>}>(background, {kind: 'events/get', sessionId: start.session.id});
    if (events.some(e => e.type === 'session-note' && String(e.payload.text).includes('Deep capture unavailable'))) return (captureStatus = 'unavailable');
    const consoleSeen = events.some(e => e.type === 'console' && JSON.stringify(e.payload).includes('Live browser diagnostic zebra'));
    const requestSeen = events.some(e => e.type === 'net-request' && JSON.stringify(e.payload).includes('live-diagnostic-probe-xyz'));
    return (captureStatus = consoleSeen && requestSeen ? 'captured' : 'waiting');
  }, {timeout: 15000}).not.toBe('waiting');
  await dispatch(background, {kind: 'session/stop'});
  const recorded = await dispatch<{events: Array<{type: string; payload: Record<string, unknown>}>}>(background, {kind: 'events/get', sessionId: start.session.id});
  test.skip(captureStatus === 'unavailable', 'Chrome debugger is unavailable in this environment');
  expect(recorded.events.some(e => e.type === 'console' && JSON.stringify(e.payload).includes('Live browser diagnostic zebra'))).toBe(true);
  expect(recorded.events.some(e => e.type === 'net-request' && JSON.stringify(e.payload).includes('live-diagnostic-probe-xyz'))).toBe(true);
  const report = await context.newPage();
  await report.setViewportSize({width: 1280, height: 900});
  await report.goto(extUrl(extensionId, `share.html?session=${start.session.id}`));
  await report.getByText('Technical details', {exact: false}).click();
  const search = report.getByRole('searchbox', {name: 'Search diagnostics'});
  const filter = report.getByLabel('Event type');
  await search.fill('DIAGNOSTIC ZEBRA');
  await expect(report.locator('.diagnostic-event')).toContainText('Live browser diagnostic zebra');
  await filter.selectOption('console');
  await expect(report.locator('.diagnostic-event')).toHaveCount(1);
  await report.locator('.diagnostic-event summary').click();
  await expect(report.locator('.diagnostic-event pre')).toContainText('Live browser diagnostic zebra');
  await filter.selectOption('net-request');
  await search.fill('live-diagnostic-probe-xyz');
  await expect(report.locator('.diagnostic-event')).toHaveCount(1);
  await expect(report.locator('.diagnostic-event')).toContainText('404');
  await search.fill('no-such-diagnostic-value');
  await expect(report.getByText('No matching diagnostics.', {exact: false})).toBeVisible();
  await search.fill('');
  await filter.selectOption('all');
  await expect(report.locator('.diagnostic-event').first()).toBeVisible();
});
