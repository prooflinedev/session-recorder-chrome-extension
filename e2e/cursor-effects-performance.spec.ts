import { writeFile } from 'node:fs/promises';
import { test, expect, dispatch, tabIdForUrl } from './support';
import { CURSOR_OVERLAY_HOST_ID } from '../lib/dom/overlay';

test.use({ allowTabCapture: true });

test('measures pointer and click workload with effects disabled and enabled', async ({ context, background }, testInfo) => {
  const page = await context.newPage();
  await page.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => {
    const result = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
  };
  const samples = [];
  // Alternate modes to reduce warmup/order bias. CDP input is trusted browser input.
  for (const enabled of [false, true, true, false, false, true]) {
    await page.bringToFront();
    await dispatch(background, { kind: 'session/start', tabId,
      media: { video: true, mic: false },
      settings: { cursorSpotlight: enabled, clickHighlight: enabled, screenshotPolicy: 'on-demand' } });
    expect(await dispatch(background, { kind: 'session/getState' })).toMatchObject({ videoOn: true });
    await page.evaluate((hostId) => {
      const stats = { moves: 0, clicks: 0, peakRipples: 0 };
      const signal = new AbortController();
      document.addEventListener('pointermove', () => { stats.moves++; }, { signal: signal.signal });
      document.addEventListener('click', () => { stats.clicks++; }, { signal: signal.signal });
      const root = document.getElementById(hostId)?.shadowRoot;
      const observer = new MutationObserver(() => {
        stats.peakRipples = Math.max(stats.peakRipples, root?.querySelectorAll('.ripple').length ?? 0);
      });
      if (root) observer.observe(root, { childList: true, subtree: true });
      (window as any).__cursorBenchmark = { stats, cleanup: () => { signal.abort(); observer.disconnect(); } };
    }, CURSOR_OVERLAY_HOST_ID);
    await page.waitForTimeout(100);
    const before = await metrics();
    const began = performance.now();
    for (let i = 0; i < 240; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: 500 + (i % 40), y: 110 + Math.floor(i / 40),
      });
    }
    for (let i = 0; i < 60; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 600, y: 110 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 600, y: 110 });
    }
    await page.waitForTimeout(600);
    const elapsedMs = performance.now() - began;
    const after = await metrics();
    const stats = await page.evaluate(() => {
      const benchmark = (window as any).__cursorBenchmark;
      benchmark.cleanup();
      return benchmark.stats as { moves: number; clicks: number; peakRipples: number };
    });
    expect(stats.moves).toBe(240);
    expect(stats.clicks).toBe(60);
    expect(stats.peakRipples).toBeLessThanOrEqual(enabled ? 8 : 0);
    if (enabled) expect(stats.peakRipples).toBeGreaterThan(0);
    samples.push({ enabled, elapsedMs, ...stats,
      taskMs: (after.TaskDuration! - before.TaskDuration!) * 1000,
      scriptMs: (after.ScriptDuration! - before.ScriptDuration!) * 1000,
      layouts: after.LayoutCount! - before.LayoutCount!,
      styleRecalculations: after.RecalcStyleCount! - before.RecalcStyleCount!,
    });
    await dispatch(background, { kind: 'session/stop' });
    expect(await page.locator(`#${CURSOR_OVERLAY_HOST_ID}`).count()).toBe(0);
  }
  const result = { userAgent: await page.evaluate(() => navigator.userAgent),
    workload: '240 sequential trusted CDP mouse moves; 60 trusted clicks; 600 ms cleanup; three runs per mode, alternating order', samples };
  await writeFile(testInfo.outputPath('cursor-performance.json'), JSON.stringify(result, null, 2));
  console.log('Cursor performance: ' + JSON.stringify(result));
});
