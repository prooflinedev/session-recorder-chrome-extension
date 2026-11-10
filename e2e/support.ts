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
  type Worker,
} from '@playwright/test';
import crypto from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const EXT_PATH = path.resolve(dir, '..', '.output', 'chrome-mv3');

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);
  const hex = length.toString(16).padStart(length > 255 ? 4 : 2, '0');
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
}

function derTag(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const derSeq = (...parts: Buffer[]) => derTag(0x30, Buffer.concat(parts));
const derSet = (...parts: Buffer[]) => derTag(0x31, Buffer.concat(parts));
const derOid = (bytes: number[]) => derTag(0x06, Buffer.from(bytes));
const derUtf8 = (text: string) => derTag(0x0c, Buffer.from(text, 'utf8'));
const derUtcTime = (text: string) => derTag(0x17, Buffer.from(text, 'ascii'));
const derBitString = (body: Buffer) =>
  derTag(0x03, Buffer.concat([Buffer.from([0x00]), body]));

function createEphemeralTlsCredentials(): { key: string | Buffer; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // ecdsa-with-SHA256 (1.2.840.10045.4.3.2) and CN=offline.test (2.5.4.3).
  const sigAlg = derSeq(derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const subject = derSeq(derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8('offline.test'))));
  const validity = derSeq(derUtcTime('250101000000Z'), derUtcTime('350101000000Z'));
  const version = derTag(0xa0, Buffer.from([0x02, 0x01, 0x02]));
  const serial = derTag(0x02, Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(8)]));
  const tbs = derSeq(version, serial, sigAlg, subject, validity, subject, spki);
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = derSeq(tbs, sigAlg, derBitString(signature));
  const lines = certDer.toString('base64').match(/.{1,64}/g) ?? [];
  const header = ['-----BEGIN', 'CERTIFICATE-----'].join(' ');
  const footer = ['-----END', 'CERTIFICATE-----'].join(' ');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `${header}\n${lines.join('\n')}\n${footer}\n`,
  };
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
