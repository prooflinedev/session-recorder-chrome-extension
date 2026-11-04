/**
 * The exported repro test, end to end: record a real session of a small app,
 * download the ZIP from the report page, unpack all of it as a developer would,
 * then run Playwright there against versions of the app and check the outcome.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type Mode = 'buggy' | 'fixed' | 'moved' | 'swallowed' | 'hidden';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const PLANTED_MARKER = 'PLANTED-RAN';

/** A coupon form. The server and the page code change with `mode`. */
function page(mode: Mode): string {
  const button =
    mode === 'moved'
      ? '<button id="redeem" type="button">Redeem</button>'
      : `<button id="apply" data-testid="apply-coupon" type="button"${mode === 'hidden' ? ' hidden' : ''}>Apply</button>`;
  const show =
    mode === 'swallowed'
      ? 'if (data.total !== undefined) total.textContent = data.total.toFixed(2);'
      : 'total.textContent = data.total.toFixed(2);';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Coupon</title></head><body>
<label>Coupon code <input id="code" aria-label="Coupon code"></label>
<label>Receipt <input id="receipt" type="file"></label>
${button}
<p>Total: $<span id="total">120.00</span></p>
<script>
  const total = document.getElementById('total');
  document.querySelector('button').addEventListener('click', async () => {
    const code = document.getElementById('code').value;
    const res = await fetch('/api/carts/4211/coupon', { method: 'POST', body: JSON.stringify({ code }) });
    const data = await res.json();
    ${show}
  });
</script></body></html>`;
}

async function startApp() {
  let mode: Mode = 'buggy';
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/carts/4211/coupon') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        // The bug needs the code: an empty coupon is a plain 200.
        const code = (JSON.parse(body || '{}') as { code?: string }).code ?? '';
        const fails = code !== '' && (mode === 'buggy' || mode === 'swallowed');
        res.writeHead(fails ? 500 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fails ? { error: 'coupon service failed' } : { total: code ? 96 : 120 }));
      });
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(mode));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    setMode: (m: Mode) => {
      mode = m;
    },
    // The extension's browser keeps connections alive; close() would wait for them.
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Records one session against the app and returns the report page's ZIP. */
async function recordAndExport(
  context: BrowserContext,
  background: Worker,
  extensionId: string,
  origin: string,
  act: (tab: Page) => Promise<void>,
): Promise<Record<string, Uint8Array>> {
  const tab = await context.newPage();
  await tab.goto(origin + '/');
  const tabId = await tabIdForUrl(background, origin);
  const started = await dispatch<{ ok: boolean; session?: { id: string } }>(background, {
    kind: 'session/start',
    tabId,
  });
  expect(started.ok).toBe(true);
  await tab.waitForTimeout(800);
  await act(tab);
  await dispatch(background, { kind: 'session/stop' });
  await tab.close();

  const report = await context.newPage();
  await report.goto(extUrl(extensionId, `report.html?session=${started.session!.id}`));
  await report.evaluate(() => {
    (window as any).__dl = null;
    chrome.downloads.download = (async (opts: { url: string }) => {
      const buf = await fetch(opts.url).then((r) => r.arrayBuffer());
      (window as any).__dl = Array.from(new Uint8Array(buf));
      return 1;
    }) as typeof chrome.downloads.download;
  });
  await report.getByRole('button', { name: /Download .zip/i }).click();
  await report.waitForFunction(() => (window as any).__dl !== null, undefined, { timeout: 20_000 });
  const bytes = await report.evaluate(() => (window as any).__dl as number[]);
  await report.close();
  return unzipSync(Uint8Array.from(bytes));
}

/** Writes every ZIP entry into a fresh folder outside the repository. */
function unpack(zip: Record<string, Uint8Array>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-export-'));
  for (const [name, data] of Object.entries(zip)) {
    const rel = name.split('/').slice(1).join('/'); // drop the session folder
    if (!rel || name.endsWith('/')) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  // Borrow this checkout's @playwright/test instead of installing one.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

interface Run {
  status: number | null;
  output: string;
  outcome: string | undefined;
}

/**
 * Runs `npx playwright test` in the unpacked folder with its own config, as
 * report.md says. Asynchronous on purpose: the app server runs in this process.
 */
async function runExported(dir: string, env: Record<string, string>): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(TEST_|PW_|PLAYWRIGHT_)/.test(k)) childEnv[k] = v;
  }
  const child = spawn(process.execPath, [CLI, 'test', '--reporter=line,json'], {
    cwd: dir,
    env: { ...childEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: 'result.json', ...env },
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const report = path.join(dir, 'result.json');
  const json = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '';
  fs.rmSync(report, { force: true });
  const outcome = json.match(/"type": "repro-outcome",\s*"description": "([A-Z ]+)"/)?.[1];
  const message = json.match(/"message": "((?:REPRODUCED|INCONCLUSIVE|Error)[^"]*)"/)?.[1] ?? '';
  expect(fs.existsSync(path.join(dir, PLANTED_MARKER)), 'a captured file ran as a test').toBe(false);
  return { status, output: `${log}\n${message}`, outcome };
}

/** A file the page uploads, named like the generated test, that must never run. */
const PLANTED = {
  name: 'repro.spec.ts',
  mimeType: 'text/plain',
  buffer: Buffer.from(
    `import fs from 'node:fs';\nfs.writeFileSync('${PLANTED_MARKER}', 'ran');\n`,
  ),
};

test('the exported repro test reproduces, clears and stays honest', async ({
  context,
  background,
  extensionId,
}) => {
  test.setTimeout(400_000);
  const app = await startApp();
  const dirs: string[] = [];
  try {
    // 1) Record: attach a file, type a coupon, pause like a person, apply it.
    //    The API fails and the page throws.
    const zip = await recordAndExport(context, background, extensionId, app.origin, async (tab) => {
      await tab.setInputFiles('#receipt', PLANTED);
      await tab.fill('#code', 'SAVE20');
      await tab.waitForTimeout(1200);
      const failed = tab.waitForResponse('**/api/carts/4211/coupon');
      await tab.click('#apply');
      await failed;
      await tab.waitForTimeout(1500);
    });
    const name = (suffix: string) => Object.keys(zip).find((k) => k.endsWith(suffix));
    expect(name('/repro.spec.ts'), 'the ZIP contains repro.spec.ts').toBeTruthy();
    expect(name('/playwright.config.mjs'), 'the ZIP pins Playwright to it').toBeTruthy();
    expect(name('/files/repro.spec.ts'), 'the captured file is in the ZIP').toBeTruthy();
    const reportMd = new TextDecoder().decode(zip[name('/report.md')!]);
    expect(reportMd).toContain('**Repro test:** `repro.spec.ts`');
    expect(reportMd).toContain('POST /api/carts/4211/coupon returned 500');

    const dir = unpack(zip);
    dirs.push(dir);

    // 2) The bug is still there.
    app.setMode('buggy');
    const buggy = await runExported(dir, { BASE_URL: app.origin });
    expect(buggy.status, buggy.output).not.toBe(0);
    expect(buggy.outcome, buggy.output).toBe('REPRODUCED');
    expect(buggy.output).toContain('POST /api/carts/4211/coupon');

    // 3) Fixed: every step ran, the request succeeded, no exception.
    app.setMode('fixed');
    const fixed = await runExported(dir, { BASE_URL: app.origin });
    expect(fixed.status, fixed.output).toBe(0);
    expect(fixed.outcome, fixed.output).toBe('NOT REPRODUCED');

    // 4) The page changed and the button is gone: not a fix, just unknown.
    app.setMode('moved');
    const moved = await runExported(dir, { BASE_URL: app.origin });
    expect(moved.outcome, moved.output).toBe('INCONCLUSIVE');
    expect(moved.output).toContain('no single element matches');

    // 5) The button is there but cannot be clicked: reported, not a timeout.
    app.setMode('hidden');
    const hidden = await runExported(dir, { BASE_URL: app.origin });
    expect(hidden.outcome, hidden.output).toBe('INCONCLUSIVE');
    expect(hidden.output).toContain('did not run');

    // 6) The page now hides the error, but the API still fails.
    app.setMode('swallowed');
    const swallowed = await runExported(dir, { BASE_URL: app.origin });
    expect(swallowed.outcome, swallowed.output).toBe('REPRODUCED');

    // 7) A non-local or malformed target is refused before anything runs.
    app.setMode('fixed');
    const remote = await runExported(dir, { BASE_URL: 'http://example.invalid' });
    expect(remote.outcome, remote.output).toBe('INCONCLUSIVE');
    expect(remote.output).toContain('is not a local address');
    const malformed = await runExported(dir, { BASE_URL: 'not a url' });
    expect(malformed.outcome, malformed.output).toBe('INCONCLUSIVE');
    expect(malformed.output).toContain('BASE_URL is not a valid URL');

    // 8) Typed and applied at once: the value is recorded after the click and
    //    the error. The replay still types it, so the bug reproduces; a fixed
    //    build cannot be confirmed (the value may be stale), never a false pass.
    app.setMode('buggy');
    const fastZip = await recordAndExport(context, background, extensionId, app.origin, async (tab) => {
      await tab.fill('#code', 'SAVE20');
      const failed = tab.waitForResponse('**/api/carts/4211/coupon');
      await tab.click('#apply');
      await failed;
      await tab.waitForTimeout(1500);
    });
    const fastDir = unpack(fastZip);
    dirs.push(fastDir);
    const fastBuggy = await runExported(fastDir, { BASE_URL: app.origin });
    expect(fastBuggy.outcome, fastBuggy.output).toBe('REPRODUCED');
    app.setMode('fixed');
    const fastFixed = await runExported(fastDir, { BASE_URL: app.origin });
    expect(fastFixed.outcome, fastFixed.output).toBe('INCONCLUSIVE');
    expect(fastFixed.output).toContain('was recorded after the action that followed it');
  } finally {
    await app.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});
