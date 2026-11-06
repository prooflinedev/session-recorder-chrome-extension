/**
 * The crown-jewel E2E: record a real session against the demo page, then export
 * it through the actual side-panel UI and validate the zip's report.md.
 *
 * Recording is started via the `__srTest` hook with an explicit tab id. This is
 * deterministic and, as a bonus, exercises the graceful DEGRADED path: under
 * Playwright the extension's chrome.debugger cannot attach (Playwright already
 * holds the tab's CDP session), so deep capture (network/console/screenshots) is
 * unavailable — but interaction capture and the whole export pipeline still work,
 * which is exactly what we assert.
 */
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type StartRes = { ok: boolean; session?: { id: string; name: string }; error?: string };
type EventsRes = { events: Array<{ type: string; payload: any }> };

test('records interactions and exports a readable, valid zip', async ({
  context,
  background,
  extensionId,
}) => {
  // 1) Open the demo page and let its content scripts load.
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Demo');

  // 2) Start recording against the demo tab (degraded-mode-safe).
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, {
    kind: 'session/start',
    tabId,
  });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;

  // 3) Give the background a beat to activate the content script.
  await page.waitForTimeout(800);

  // 4) Interact with the page — these flow through the content script → funnel.
  await page.click('#btn-get');
  await page.click('#btn-log');
  await page.fill('#f-user', 'ada lovelace');
  await page.click('#btn-post');
  await page.fill('#f-pass', 'hunter2'); // must be redacted
  // Same-origin request so a net-request is captured deterministically, without
  // depending on the demo page's external endpoints being reachable.
  await page.evaluate(() => fetch(`/probe-${Date.now()}`).catch(() => {}));
  // Let the input debounce (800ms) flush, plus a click to blur.
  await page.waitForTimeout(1000);
  await page.click('#btn-console-error');
  await page.waitForTimeout(400);
  // Select the heading text, let the selection debounce (500ms) settle, then
  // deselect so the single cleared event fires too.
  await page.locator('h1').selectText();
  await page.waitForTimeout(800);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.waitForTimeout(800);

  // 5) Drop a marker via the hook (explicit user signal).
  await dispatch(background, { kind: 'marker/add', name: 'BUG HERE' });

  // 6) Stop.
  await dispatch(background, { kind: 'session/stop' });

  // 7) Assert the captured events look right.
  const { events } = await dispatch<EventsRes>(background, {
    kind: 'events/get',
    sessionId,
  });
  const types = events.map((e) => e.type);
  expect(types).toContain('click');
  expect(types).toContain('marker');

  // Text selection: one settled selection of the heading, then one cleared.
  const selects = events.filter((e) => e.type === 'text-select');
  expect(
    selects.some(
      (e) =>
        e.payload?.cleared === false && String(e.payload?.text ?? '').includes('Demo'),
    ),
  ).toBe(true);
  expect(selects.some((e) => e.payload?.cleared === true)).toBe(true);

  const clickTexts = events
    .filter((e) => e.type === 'click')
    .map((e) => e.payload?.descriptor?.text)
    .filter(Boolean);
  expect(clickTexts).toContain('GET fetch');

  // Password input, if captured, must be redacted (never the raw value).
  const inputs = events.filter((e) => e.type === 'input');
  for (const ev of inputs) {
    if (ev.payload?.redacted) {
      expect(ev.payload.value).not.toContain('hunter2');
    }
  }
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain('hunter2'); // not in value, text, or anywhere

  // The recorder adapts to its environment: either the debugger attached and we
  // have deep capture (net-request events), or it degraded and left a note.
  // Exactly one must hold — the session is never silently empty of both.
  const hasNet = types.includes('net-request');
  const hasDegradedNote = events.some(
    (e) =>
      e.type === 'session-note' &&
      /Deep capture unavailable/.test(e.payload?.text ?? ''),
  );
  expect(hasNet || hasDegradedNote).toBe(true);

  // 8) Follow the report-first workspace into its full timeline/export tools.
  const workspace = await context.newPage();
  await workspace.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  const opened = context.waitForEvent('page');
  await workspace.getByRole('link', { name: 'Full timeline' }).click();
  const sp = await opened;
  await expect(sp.getByRole('button', { name: /Download .zip/i })).toBeVisible();

  // All four export levels remain reachable from the full timeline.
  await expect(sp.locator('.r-level')).toHaveCount(4);

  // 9) Capture the real Download-button output by intercepting chrome.downloads.
  await sp.evaluate(() => {
    (window as any).__dl = null;
    chrome.downloads.download = (async (opts: { url: string; filename: string }) => {
      const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
      (window as any).__dl = {
        name: opts.filename,
        bytes: Array.from(new Uint8Array(buf)),
      };
      return 1;
    }) as typeof chrome.downloads.download;
  });

  // Pick the Full (L0) level so bodies/labels are present, then download.
  await sp.getByRole('button', { name: 'Full', exact: true }).click();
  await sp.getByRole('button', { name: /Download .zip/i }).click();
  await sp.waitForFunction(() => (window as any).__dl !== null, undefined, {
    timeout: 20_000,
  });

  const dl = (await sp.evaluate(() => (window as any).__dl)) as {
    name: string;
    bytes: number[];
  };
  expect(dl.name).toMatch(/\.zip$/);

  // 10) Unzip and validate report.md.
  const files = unzipSync(Uint8Array.from(dl.bytes));
  const reportKey = Object.keys(files).find((k) => k.endsWith('/report.md'));
  expect(reportKey, 'zip contains report.md').toBeTruthy();
  const report = new TextDecoder().decode(files[reportKey!]);

  expect(report).toContain('# Session Report');
  expect(report).toContain('GET fetch'); // a click we performed
  expect(report).toContain('BUG HERE'); // our marker
  expect(report).toContain('SELECT'); // the text selection made it to L0
  expect(report).not.toContain('hunter2'); // redaction held
  // session.json is present and valid.
  const jsonKey = Object.keys(files).find((k) => k.endsWith('/session.json'));
  expect(jsonKey).toBeTruthy();
  JSON.parse(new TextDecoder().decode(files[jsonKey!]));
});

test('keeps a value the page clears on Enter, as TodoMVC does', async ({
  context,
  background,
}) => {
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Demo');
  // A field that clears itself on Enter in its own (bubble-phase) handler,
  // before the recorder's input debounce would fire.
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.id = 'f-todo';
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') field.value = '';
    });
    document.body.appendChild(field);
  });

  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, {
    kind: 'session/start',
    tabId,
  });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(800);

  await page.fill('#f-todo', 'buy milk');
  await page.press('#f-todo', 'Enter');
  await page.waitForTimeout(1000);

  await dispatch(background, { kind: 'session/stop' });

  const { events } = await dispatch<{
    events: Array<{ type: string; t: number; payload: any }>;
  }>(background, { kind: 'events/get', sessionId });
  const inputs = events.filter((e) => e.type === 'input');
  expect(inputs.map((e) => e.payload?.value)).toEqual(['buy milk']);
  // Both events can share a millisecond and their storage order varies, so
  // compare timestamps rather than positions.
  const enter = events.find((e) => e.type === 'key' && e.payload?.key === 'Enter');
  expect(enter).toBeTruthy();
  expect(inputs[0]!.t).toBeLessThanOrEqual(enter!.t);
});
