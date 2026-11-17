/**
 * Playwright fixtures for driving the loaded extension.
 *
 * `context` launches a persistent Chromium with the built extension; `background`
 * is its MV3 service worker (used to read the manifest and to drive the recorder
 * through the test-only `__srTest` hook); `extensionId` is derived from the SW URL.
 *
 * External hostnames are mapped to a local loopback HTTPS fixture so browser-process
 * `chrome.tabs.create({ url })` navigations that start before Playwright attaches
 * per-target `Fetch.enable` never reach production origins (`proofline.sh`,
 * `github.com`) or load live subresources (`/api/v1/me`, unauthenticated GitHub XHRs).
 */
import {
  test as base,
  chromium,
  expect as pwExpect,
  type BrowserContext,
  type Request,
  type Route,
  type Worker,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const EXT_PATH = path.resolve(dir, '..', '.output', 'chrome-mv3');

/** Disposable test certificate; OpenSSL owns its encoding, and no key is committed. */
function createEphemeralTlsCredentials(): { key: Buffer; cert: Buffer } {
  const directory = mkdtempSync(path.join(tmpdir(), 'recorder-e2e-tls-'));
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=offline.test',
    ], { stdio: 'ignore' });
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const OFFLINE_TLS = createEphemeralTlsCredentials();

async function startOfflineHttpsFixture(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = https.createServer(OFFLINE_TLS, (req, res) => {
    if (req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Offline approval fixture</title><p>Offline fixture</p>');
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ detail: 'Blocked unmocked external request in E2E fixture' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type Fixtures = {
  context: BrowserContext;
  background: Worker;
  extensionId: string;
};

export const test = base.extend<Fixtures>({
  context: async ({}, use) => {
    const headed = !!process.env.HEADED;
    const offline = await startOfflineHttpsFixture();
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !headed,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost, EXCLUDE 127.0.0.1',
        `--testing-fixed-https-port=${offline.port}`,
        '--disable-background-networking',
        '--disable-sync',
        '--disable-domain-reliability',
        '--no-pings',
        // Automated recordings use synthetic devices; never prompt for a real mic.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await offline.close();
    }
  },
  background: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },
  extensionId: async ({ background }, use) => {
    await use(new URL(background.url()).host);
  },
});

export const expect = pwExpect;

export function extUrl(extensionId: string, page: string): string {
  return `chrome-extension://${extensionId}/${page}`;
}

/** Drive the background's real message dispatcher via the test hook. */
export async function dispatch<T = unknown>(
  background: Worker,
  msg: Record<string, unknown>,
  senderTabId?: number,
): Promise<T> {
  return background.evaluate(
    (arg) =>
      (globalThis as unknown as { __srTest: (m: unknown, t?: number) => Promise<T> }).__srTest(
        arg.msg,
        arg.tabId,
      ),
    { msg, tabId: senderTabId },
  );
}

/** Resolve the chrome tab id of the first tab whose URL starts with `prefix`. */
export async function tabIdForUrl(
  background: Worker,
  prefix: string,
): Promise<number> {
  return background.evaluate(async (p) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((tab) => tab.url && tab.url.startsWith(p));
    if (!t || t.id === undefined) throw new Error(`No tab for ${p}`);
    return t.id;
  }, prefix);
}

/**
 * Whether a routed request was made by the extension itself (one of its pages or
 * its service worker) rather than by a website tab the extension opened, such as
 * the Proofline approval page or a filed GitHub issue. Chromium does not always
 * route the navigation of a tab created with `chrome.tabs.create`, so the loopback
 * fixture also contains navigations before their route is attached.
 */
export function fromExtension(request: Request): boolean {
  const worker = request.serviceWorker();
  if (worker) return worker.url().startsWith('chrome-extension://');
  try {
    return request.frame().url().startsWith('chrome-extension://');
  } catch {
    return false;
  }
}

/**
 * Answer a request made by a website tab without letting it reach the network,
 * and assert that none of the extension's credentials leaked into it.
 */
export async function fulfillWebsiteRequest(route: Route, secrets: string[]): Promise<void> {
  const request = route.request();
  const sent = [request.url(), JSON.stringify(request.headers()), request.postData() ?? ''].join('\n');
  for (const secret of secrets) pwExpect(sent).not.toContain(secret);
  if (request.isNavigationRequest())
    await route.fulfill({ contentType: 'text/html', body: '<p>Website fixture</p>' });
  else await route.fulfill({ status: 404, json: { message: 'Not Found' } });
}
