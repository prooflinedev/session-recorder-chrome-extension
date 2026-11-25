/**
 * Export a recording as a Playwright test, then run that test.
 *
 * Records a few steps on the demo page, captures the Full zip the export UI hands
 * to chrome.downloads (intercepted, as record-export.spec.ts does), and runs the
 * repro.spec.ts inside it with a separate Playwright process against the same
 * page, the way a developer would. Under Playwright the recorder runs degraded
 * (no debugger), so there are no errors to check here; this proves the generated
 * steps replay for real.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

const dir = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

type StartRes = { ok: boolean; session?: { id: string } };

test('exports a Playwright test that replays the recording', async ({
  context,
  background,
  extensionId,
}) => {
  test.setTimeout(180_000);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Demo');

  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<StartRes>(background, {
    kind: 'session/start',
    tabId,
  });
  expect(started.ok).toBe(true);
  const sessionId = started.session!.id;
  await page.waitForTimeout(800);

  await page.click('#btn-log');
  await page.fill('#f-user', 'ada lovelace');
  // Let this field's input debounce (800ms) flush on its own. Two fills flushed in
  // the same millisecond have no recorded order.
  await page.waitForTimeout(1000);
  await page.fill('#f-pass', 'hunter2'); // must not reach the test
  await page.press('#f-pass', 'Tab');
  await page.waitForTimeout(1000);
  await page.click('#btn-info');
  await page.waitForTimeout(400);
  await dispatch(background, { kind: 'session/stop' });

  // Capture the Full zip the export UI hands to chrome.downloads.
  const workspace = await context.newPage();
  await workspace.goto(extUrl(extensionId, `share.html?session=${sessionId}`));
  const opened = context.waitForEvent('page');
  await workspace.getByRole('link', { name: 'Full timeline' }).click();
  const sp = await opened;
  await expect(sp.getByRole('button', { name: /Download .zip/i })).toBeVisible();
  await sp.evaluate(() => {
    (window as any).__dl = null;
    chrome.downloads.download = (async (opts: { url: string; filename: string }) => {
      const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
      (window as any).__dl = Array.from(new Uint8Array(buf));
      return 1;
    }) as typeof chrome.downloads.download;
  });
  await sp.getByRole('button', { name: 'Full', exact: true }).click();
  await sp.getByRole('button', { name: /Download .zip/i }).click();
  await sp.waitForFunction(() => (window as any).__dl !== null, undefined, {
    timeout: 20_000,
  });
  const bytes = (await sp.evaluate(() => (window as any).__dl)) as number[];
  const files = unzipSync(Uint8Array.from(bytes));

  const specKey = Object.keys(files).find((k) => k.endsWith('/repro.spec.ts'));
  expect(specKey, 'zip contains repro.spec.ts').toBeTruthy();
  const spec = new TextDecoder().decode(files[specKey!]);
  const steps = spec
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('await '))
    .map((line) => line.replace(/ \/\/ \[.*$/, ''));
  // Pointer dwell and scrolling depend on timing, so only the deliberate steps are compared.
  expect(
    steps.filter((s) => !s.includes('.hover()') && !s.includes('window.scrollTo')),
  ).toEqual([
    "await page.goto(appUrl('/'));",
    "await page.locator('#btn-log').click();",
    "await page.locator('#f-user').fill('ada lovelace');",
    "await page.locator('#f-pass').fill(process.env.REPRO_PASSWORD ?? '');",
    "await page.locator('#f-pass').press('Tab');",
    "await page.locator('#btn-info').click();",
  ]);
  expect(spec).not.toContain('hunter2');

  const reportKey = Object.keys(files).find((k) => k.endsWith('/report.md'));
  expect(new TextDecoder().decode(files[reportKey!])).toContain('`repro.spec.ts`');

  // Run the exported test on its own, against the page it was recorded on.
  const results = path.join(dir, '..', 'test-results');
  mkdirSync(results, { recursive: true });
  const work = mkdtempSync(path.join(results, 'repro-export-'));
  try {
    writeFileSync(path.join(work, 'repro.spec.ts'), spec);
    const config = path.join(work, 'playwright.config.mjs');
    writeFileSync(
      config,
      "export default { testDir: '.', outputDir: './out', reporter: 'line', use: { channel: 'chromium' } };\n",
    );
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    // Leave out the outer run's worker variables so the inner run starts clean.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith('TEST_') && !k.startsWith('PW_'),
      ),
    );
    const result = await run(process.execPath, [cli, 'test', '--config', config], {
      cwd: work,
      env: { ...env, REPRO_PASSWORD: 'any-password' },
      timeout: 120_000,
    }).catch((err: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(
        `The exported test failed: ${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
        { cause: err },
      );
    });
    expect(result.stdout).toMatch(/1 passed/);
  } finally {
    // Neither step may hide the replay's own result, so both only warn.
    await test
      .info()
      .attach('repro.spec.ts', { body: spec, contentType: 'text/plain' })
      .catch((err: unknown) =>
        console.warn(`Could not attach the exported test: ${String(err)}`),
      );
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.warn(`Could not remove ${work}: ${String(err)}`);
    }
  }
});
