/**
 * Console evidence keeps its real time and survives stopping.
 *
 * The page logs a repeating failure, an error right after one click, and
 * another error just before the recording stops. The recording must place
 * each line where it happened, keep the last one, and record how long the
 * repeated failure lasted.
 *
 * Console capture needs the extension's debugger. Where it cannot attach (the
 * test browser may already hold the tab), the recorder degrades and says so;
 * this test then has nothing to check and skips with that reason.
 */
import { test, expect, dispatch, tabIdForUrl } from './support';

type Ev = { type: string; t: number; payload: any };

test('places console lines at their real time and keeps the last one at stop', async ({
  context,
  background,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Demo');
  await page.evaluate(() => {
    const add = (id: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.id = id;
      b.textContent = id;
      b.addEventListener('click', onClick);
      document.body.appendChild(b);
    };
    add('t-pay', () => console.error('payment rejected: 500'));
    add('t-retry', () => console.error('retry failed: card token expired'));
    add('t-poll', () => {
      let n = 0;
      const timer = setInterval(() => {
        console.warn('sync failed: 401');
        if (++n === 5) clearInterval(timer);
      }, 300);
    });
  });

  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{ ok: boolean; session?: { id: string } }>(background, {
    kind: 'session/start',
    tabId,
  });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(800);

  // A failure repeats five times over ~1.2 s, inside the 1 s coalescing window.
  await page.click('#t-poll');
  await page.waitForTimeout(1_800);
  // An error right after one click, then the next click 400 ms later.
  await page.click('#t-pay');
  await page.waitForTimeout(400);
  await page.click('#t-retry');
  // Stop well inside the 1 s window that holds the last message.
  await page.waitForTimeout(200);
  await dispatch(background, { kind: 'session/stop' });
  await page.waitForTimeout(1_500);

  const { events } = await dispatch<{ events: Ev[] }>(background, {
    kind: 'events/get',
    sessionId,
  });
  const degraded = events.some(
    (e) => e.type === 'session-note' && /Deep capture unavailable/.test(e.payload?.text ?? ''),
  );
  test.skip(degraded, 'deep capture is unavailable in this browser, so no console is recorded');

  const consoleText = (text: string) =>
    events.find((e) => e.type === 'console' && e.payload.text === text);
  const click = (id: string) =>
    events.find((e) => e.type === 'click' && e.payload.descriptor?.id === id)!;

  const paid = consoleText('payment rejected: 500');
  expect(paid, 'the error after Pay is recorded').toBeTruthy();
  expect(paid!.t).toBeGreaterThanOrEqual(click('t-pay').t);
  expect(paid!.t, 'and placed before the next click').toBeLessThan(click('t-retry').t);

  const last = consoleText('retry failed: card token expired');
  expect(last, 'the error logged just before stop is kept').toBeTruthy();
  expect(last!.t).toBeGreaterThanOrEqual(click('t-retry').t);

  const poll = consoleText('sync failed: 401');
  expect(poll?.payload.repeat).toBe(5);
  expect(poll!.t).toBeLessThan(click('t-pay').t);
  expect(poll!.payload.repeatSpanMs).toBeGreaterThanOrEqual(1_000);
  expect(poll!.payload.repeatSpanMs).toBeLessThan(2_000);
});
