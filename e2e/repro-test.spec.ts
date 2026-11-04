/**
 * The exported repro test, end to end: record a real session of a small app,
 * download the ZIP from the report page, then run its repro.spec.ts with
 * Playwright against versions of the app and check the reported outcome.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { test, expect, extUrl, dispatch, tabIdForUrl } from './support';

type Mode = 'buggy' | 'fixed' | 'moved' | 'swallowed' | 'hidden';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

/** A coupon form. The server and the page code change with `mode`. */
function page(mode: Mode): string {
  const button =
    mode === 'moved'
      ? '<button id="redeem" type="button">Redeem</button>'
      : `<button id="apply" data-testid="apply-coupon" type="button"${mode === 'hidden' ? ' hidden' : ''}>Apply</button>`;
  const show =
    mode === 'swallowed'
      ? "if (data.total !== undefined) total.textContent = data.total.toFixed(2);"
      : 'total.textContent = data.total.toFixed(2);';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Coupon</title></head><body>
<label>Coupon code <input id="code" aria-label="Coupon code"></label>
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

async function startApp(): Promise<{ origin: string; setMode: (m: Mode) => void; close: () => Promise<void> }> {
  let mode: Mode = 'buggy';
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/carts/4211/coupon') {
      const ok = mode === 'fixed' || mode === 'moved' || mode === 'hidden';
      res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { total: 96 } : { error: 'coupon service failed' }));
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
    setMode: (m) => {
      mode = m;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Run {
  status: number | null;
  output: string;
  outcome: string | undefined;
}

/**
 * Runs the exported test in its own Playwright process, as a developer would.
 * Asynchronous on purpose: the app server runs in this process.
 */
async function runExported(dir: string, env: Record<string, string>): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(TEST_|PW_|PLAYWRIGHT_)/.test(k)) childEnv[k] = v;
  }
  const child = spawn(process.execPath, [CLI, 'test', '--config', 'pw.config.mjs'], {
    cwd: dir,
    env: { ...childEnv, ...env },
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const report = path.join(dir, 'result.json');
  const json = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '';
  fs.rmSync(report, { force: true });
  const outcome = json.match(/"type": "repro-outcome",\s*"description": "([A-Z ]+)"/)?.[1];
  // The failure message, without the JSON report around it.
  const message = json.match(/"message": "((?:REPRODUCED|INCONCLUSIVE|Error)[^"]*)"/)?.[1] ?? '';
  return { status, output: `${log}\n${message}`, outcome };
}

test('the exported repro test reproduces, clears and stays honest', async ({
  context,
  background,
  extensionId,
}) => {
  test.setTimeout(300_000);
  const app = await startApp();
  // Unpacked outside the repository, like a developer's folder; it only borrows
  // this checkout's @playwright/test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-export-'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  try {
    // 1) Record: type a coupon, pause like a person, apply it. The API fails
    //    and the page throws.
    const tab = await context.newPage();
    await tab.goto(app.origin + '/');
    const tabId = await tabIdForUrl(background, app.origin);
    const started = await dispatch<{ ok: boolean; session?: { id: string } }>(background, {
      kind: 'session/start',
      tabId,
    });
    expect(started.ok).toBe(true);
    const sessionId = started.session!.id;
    await tab.waitForTimeout(800);
    await tab.fill('#code', 'SAVE20');
    await tab.waitForTimeout(1200);
    const failed = tab.waitForResponse('**/api/carts/4211/coupon');
    await tab.click('#apply');
    await failed;
    await tab.waitForTimeout(1500);
    await dispatch(background, { kind: 'session/stop' });

    // 2) Export through the report page's real Download button.
    const report = await context.newPage();
    await report.goto(extUrl(extensionId, `report.html?session=${sessionId}`));
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
    const zip = unzipSync(Uint8Array.from(await report.evaluate(() => (window as any).__dl as number[])));
    const name = (suffix: string) => Object.keys(zip).find((k) => k.endsWith(suffix));
    const specKey = name('/repro.spec.ts');
    expect(specKey, 'the ZIP contains repro.spec.ts').toBeTruthy();
    const reportMd = new TextDecoder().decode(zip[name('/report.md')!]);
    expect(reportMd).toContain('**Repro test:** `repro.spec.ts`');
    expect(reportMd).toContain('POST /api/carts/4211/coupon returned 500');

    // 3) Unpack it as a developer would, with a minimal Playwright config.
    fs.writeFileSync(path.join(dir, 'repro.spec.ts'), zip[specKey!]!);
    fs.writeFileSync(
      path.join(dir, 'pw.config.mjs'),
      "export default { testDir: '.', timeout: 60000, reporter: [['line'], ['json', { outputFile: 'result.json' }]] };\n",
    );

    // 4) The bug is still there.
    app.setMode('buggy');
    const buggy = await runExported(dir, { BASE_URL: app.origin });
    expect(buggy.status, buggy.output).not.toBe(0);
    expect(buggy.outcome, buggy.output).toBe('REPRODUCED');
    expect(buggy.output).toContain('POST /api/carts/4211/coupon');

    // 5) Fixed: every step ran, the request succeeded, no exception.
    app.setMode('fixed');
    const fixed = await runExported(dir, { BASE_URL: app.origin });
    expect(fixed.status, fixed.output).toBe(0);
    expect(fixed.outcome, fixed.output).toBe('NOT REPRODUCED');

    // 6) The page changed and the button is gone: not a fix, just unknown.
    app.setMode('moved');
    const moved = await runExported(dir, { BASE_URL: app.origin });
    expect(moved.status, moved.output).not.toBe(0);
    expect(moved.outcome, moved.output).toBe('INCONCLUSIVE');
    expect(moved.output).toContain('no single element matches');

    // 6b) The button is there but cannot be clicked: reported, not a timeout.
    app.setMode('hidden');
    const hidden = await runExported(dir, { BASE_URL: app.origin });
    expect(hidden.outcome, hidden.output).toBe('INCONCLUSIVE');
    expect(hidden.output).toContain('did not run');

    // 7) The page now hides the error, but the API still fails.
    app.setMode('swallowed');
    const swallowed = await runExported(dir, { BASE_URL: app.origin });
    expect(swallowed.outcome, swallowed.output).toBe('REPRODUCED');

    // 8) A non-local target is refused before anything runs.
    app.setMode('fixed');
    const remote = await runExported(dir, { BASE_URL: 'http://example.invalid' });
    expect(remote.outcome, remote.output).toBe('INCONCLUSIVE');
    expect(remote.output).toContain('is not a local address');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
