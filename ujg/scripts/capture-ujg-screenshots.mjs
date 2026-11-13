/**
 * Deterministic production-extension evidence for UJG Surface contracts.
 * See ujg-screenshot-contracts.mjs for framing and required state evidence.
 */
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCaptureBook, viewports } from './ujg-screenshot-capture.mjs';

const bundleRoot = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const extensionPath = resolve(root, '.output/chrome-mv3');
const fixedNow = Date.parse('2026-11-03T10:30:00.000Z');
const execFileAsync = promisify(execFile);
const book = await createCaptureBook(root, bundleRoot);
if (book.checkOnly) process.exit(0);
const capture = book.capture;
const needsAppGroup = (group) => [...book.selected].some((id) => {
  const contract = book.contracts.get(id);
  return contract.group === group && contract.frame !== 'native';
});


const fixture = await readFile(resolve(root, 'demo/checkout.html'));
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture server did not bind.');
const origin = `http://127.0.0.1:${address.port}`;

const profile = await mkdtemp(resolve(bundleRoot, '.output/ujg-browser-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  deviceScaleFactor: 1,
  viewport: viewports.page,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-color-profile=srgb',
  ],
});

const consoleFailures = [];
const expectedConsoleFailure = (message) =>
  /The recorder view could not render|Failed to load resource: the server responded with a status of (401|403)/.test(
    message,
  );
const watchConsole = (page) => {
  page.on('console', (message) => {
    if (message.type() === 'error' && !expectedConsoleFailure(message.text()))
      consoleFailures.push(`${page.url() || 'about:blank'}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    if (!expectedConsoleFailure(error.message))
      consoleFailures.push(`${page.url() || 'about:blank'}: ${error.message}`);
  });
};
for (const page of context.pages()) watchConsole(page);
context.on('page', watchConsole);

function deterministicBrowserEnvironment(now) {
  const NativeDate = Date;
  class FixedDate extends NativeDate {
    constructor(...values) {
      super(...(values.length ? values : [now]));
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = FixedDate;
  // Storage estimates describe the disposable fixture, not this host's disk.
  if (navigator.storage) navigator.storage.estimate = async () => ({ usage: 262_144, quota: 1_073_741_824 });
}
await context.addInitScript(deterministicBrowserEnvironment, fixedNow);

let background = context.serviceWorkers()[0];
if (!background) background = await context.waitForEvent('serviceworker');
await background.evaluate((now) => {
  Date.now = () => now;
}, fixedNow);
const extensionId = new URL(background.url()).host;
const extUrl = (path) => `chrome-extension://${extensionId}/${path}`;
const dispatch = (message, senderTabId) =>
  background.evaluate(
    ({ message: value, senderTabId: tabId }) =>
      globalThis.__srTest(value, tabId),
    { message, senderTabId },
  );
const tabIdFor = (prefix) =>
  background.evaluate(async (value) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url?.startsWith(value));
    if (tab?.id === undefined) throw new Error(`No tab starts with ${value}.`);
    return tab.id;
  }, prefix);

const unknownRequests = [];
let captureStage = 'startup';
async function guardWorkerNetwork(worker, allowTitleFixture = false) {
  await worker.evaluate(({ fixtureOrigin, allowTitle }) => {
    const original = fetch.bind(globalThis);
    globalThis.__ujgUnexpectedNetwork = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url ?? String(input);
      if (!/^https?:/.test(url) || url.startsWith(fixtureOrigin)) return original(input, init);
      if (allowTitle && url === 'https://api.openai.com/v1/chat/completions') {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Checkout discount investigation' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
      }
      globalThis.__ujgUnexpectedNetwork.push(url);
      throw new Error('Unexpected worker request blocked: ' + url);
    };
  }, { fixtureOrigin: origin, allowTitle: allowTitleFixture });
}
await guardWorkerNetwork(background, true);
await context.route(/^https?:\/\//, async (route) => {
  if (route.request().url().startsWith(origin)) return route.continue();
  let owner = 'non-page request';
  try {
    owner = route.request().frame().page().url();
  } catch {}
  unknownRequests.push(`${captureStage}: ${owner} -> ${route.request().url()}`);
  return route.abort();
});

function trackPendingCalls() {
  const calls = new Map();
  globalThis.__ujgPendingCalls = calls;
  let sequence = 0;
  const wrap = (owner, name, label) => {
    const original = owner?.[name];
    if (typeof original !== 'function') return;
    owner[name] = function (...args) {
      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') {
        const id = ++sequence;
        calls.set(id, label + (args[0]?.kind ? ':' + args[0].kind : ''));
        result.then(() => calls.delete(id), () => calls.delete(id));
      }
      return result;
    };
  };
  wrap(chrome.runtime, 'sendMessage', 'chrome.runtime.sendMessage');
  wrap(chrome.storage.local, 'get', 'chrome.storage.local.get');
  wrap(chrome.storage.local, 'set', 'chrome.storage.local.set');
  wrap(Blob.prototype, 'arrayBuffer', 'Blob.arrayBuffer');
  wrap(globalThis, 'fetch', 'fetch');
}
async function installScenarioScript(page, initScript) {
  await page.addInitScript(`${initScript ? '(' + initScript.toString() + ')();' : ''}(${trackPendingCalls.toString()})();`);
}

async function newPanel(initScript) {
  const page = await context.newPage();
  await page.setViewportSize(viewports.panel);
  await installScenarioScript(page, initScript);
  await page.goto(extUrl('sidepanel.html'));
  return page;
}

async function newOptions(section, initScript) {
  const page = await context.newPage();
  await page.setViewportSize(viewports.settings);
  await installScenarioScript(page, initScript);
  await page.goto(extUrl(`options.html#${section}`));
  await expect(page.locator('#settings-page')).toBeVisible();
  return page;
}

async function captureRecorder() {
  const loading = await newPanel(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) =>
      message?.kind === 'session/getState'
        ? new Promise(() => {})
        : send(message, ...rest);
  });
  await expect(loading.getByText('Loading…', { exact: true })).toBeVisible();
  await capture('recorder-loading', loading);
  await loading.close();

  const idle = await newPanel();
  await expect(idle.getByRole('button', { name: 'Start recording' })).toBeVisible();
  await capture('recorder-idle-empty', idle);
  await idle.getByRole('button', { name: 'Capture options' }).click();
  await expect(idle.getByRole('dialog', { name: 'Capture options' })).toBeVisible();
  await capture('recorder-capture-options', idle);
  await idle.close();

  const starting = await newPanel(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) =>
      message?.kind === 'session/start'
        ? new Promise(() => {})
        : send(message, ...rest);
  });
  await starting.getByRole('button', { name: 'Start recording' }).click();
  await expect(starting.getByRole('button', { name: 'Start recording' })).toContainText('Starting');
  await capture('recorder-starting', starting);
  await starting.close();

  const startError = await newPanel(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) =>
      message?.kind === 'session/start'
        ? Promise.resolve({ ok: false, error: 'This page cannot be recorded.' })
        : send(message, ...rest);
  });
  await startError.getByRole('button', { name: 'Start recording' }).click();
  await expect(startError.getByText('This page cannot be recorded.')).toBeVisible();
  await capture('recorder-start-error', startError);
  await startError.close();

  await background.evaluate(() =>
    chrome.storage.local.set({ micFromStart: true, transcription: undefined }),
  );
  const voiceIdle = await newPanel();
  await voiceIdle.getByRole('button', { name: 'Start recording' }).click();
  await expect(voiceIdle.getByRole('dialog', { name: 'Voice setup' })).toBeVisible();
  await capture('recorder-voice-setup-idle', voiceIdle);
  await voiceIdle.close();
  await background.evaluate(() => chrome.storage.local.set({ micFromStart: false }));

  let demo = await context.newPage();
  await demo.setViewportSize(viewports.page);
  await demo.goto(origin);
  let tabId = await tabIdFor(origin);
  const started = await dispatch({ kind: 'session/start', tabId, settings: { screenshotPolicy: 'on-demand', hoverDwellMs: 0 } });
  if (!started?.ok || !started.session?.id)
    throw new Error(`Could not start screenshot session: ${JSON.stringify(started)}`);
  const sessionId = started.session.id;
  const panel = await newPanel();
  await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible();
  await capture('recorder-recording', panel);

  await panel.getByRole('button', { name: 'Annotate', exact: true }).click();
  const commentHost = demo.locator('#__session_recorder_point_annotation_host__');
  await expect(commentHost.getByRole('button', { name: 'Turn off annotations' })).toBeVisible();
  await capture('recorder-comments-picking', demo, panel);
  const button = await demo.locator('#buy').boundingBox().catch(() => null)
    ?? await demo.getByRole('button').first().boundingBox();
  await demo.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  const comment = commentHost.getByLabel('Comment', { exact: true });
  await comment.fill('The confirmed discount should update the total.');
  await capture('recorder-comments-editing', demo, panel);
  const save = commentHost.getByRole('button', { name: 'Add comment' });
  await background.evaluate(() => {
    const send = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (...args) => {
      if (args[1] !== 'Page.captureScreenshot') return send(...args);
      globalThis.__ujgCommentHold = { reached: true, released: false, boundary: 'chrome.debugger Page.captureScreenshot during comment save' };
      globalThis.__ujgReleaseComment = () => {
        chrome.debugger.sendCommand = send;
        globalThis.__ujgCommentHold.released = true;
        send(...args);
      };
    };
  });
  await save.click({ noWaitAfter: true });
  await expect.poll(() => background.evaluate(() => !!globalThis.__ujgCommentHold?.reached)).toBe(true);
  demo.__ujgHold = { assertHeld: async () => {
    const hold = await background.evaluate(() => globalThis.__ujgCommentHold);
    if (!hold?.reached || hold.released) throw new Error('Comment save dependency is not held.');
    return hold;
  } };
  await capture('recorder-comments-saving', demo, panel);
  await demo.bringToFront();
  await background.evaluate(() => globalThis.__ujgReleaseComment());
  await expect(commentHost.getByRole('status')).toContainText('Comment added');
  const errorTarget = await demo.getByRole('button').first().boundingBox();
  await demo.mouse.click(
    errorTarget.x + errorTarget.width / 2,
    errorTarget.y + errorTarget.height / 2,
  );
  await comment.fill('This control disappears before the comment can be saved.');
  await demo.getByRole('button').first().evaluate((element) => element.remove());
  await commentHost.getByRole('button', { name: 'Add comment' }).click();
  await expect(commentHost.getByRole('status')).toContainText('no longer on the page');
  await capture('recorder-comments-error', demo, panel);
  await dispatch({ kind: 'point-annotation/toggle', on: false });
  await expect(commentHost).toHaveCount(0);

  // Start markup with a clean recording rather than the page whose Apply
  // button was deliberately removed for the previous error scenario.
  await dispatch({ kind: 'session/stop' });
  await demo.close();
  demo = await context.newPage();
  await demo.setViewportSize(viewports.page);
  await demo.goto(origin);
  tabId = await tabIdFor(origin);
  await dispatch({ kind: 'session/start', tabId, settings: { screenshotPolicy: 'on-demand', hoverDwellMs: 0 } });
  await demo.bringToFront();
  await background.evaluate(() => {
    const send = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (...args) => {
      if (args[1] !== 'Page.captureScreenshot') return send(...args);
      globalThis.__ujgMarkupCapture = true;
      globalThis.__ujgReleaseMarkup = async () => {
        chrome.debugger.sendCommand = send;
        await new Promise((done) => send(args[0], 'Emulation.setDeviceMetricsOverride', { width: 1220, height: 844, deviceScaleFactor: 1, mobile: false }, done));
        // Bound the real CDP raster to the recorded page, independent of the
        // temporary test panel tab's physical browser-window dimensions.
        args[2] = { ...args[2], captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1220, height: 844, scale: 1 } };
        send(...args);
      };
    };
  });
  await panel.getByRole('button', { name: 'Markup', exact: true }).click();
  await expect.poll(() => background.evaluate(() => !!globalThis.__ujgMarkupCapture)).toBe(true);
  // A test panel is a regular tab. Restore the recorded tab before the real
  // screenshot dependency runs, matching the native side panel's active tab.
  await demo.bringToFront();
  await background.evaluate(() => globalThis.__ujgReleaseMarkup());
  const markupHost = demo.locator('#__session_recorder_annotation_host__');
  await expect(markupHost.getByTitle('Text')).toBeVisible();
  await capture('recorder-markup', demo, panel);
  const textTool = markupHost.getByTitle('Text');
  await textTool.click();
  await demo.mouse.click(520, 360);
  await demo.keyboard.type('Expected total: $96');
  await capture('recorder-markup-text', demo, panel);
  await dispatch({ kind: 'session/pause' });
  await expect(panel.getByRole('button', { name: 'Resume' })).toBeVisible();
  await capture('recorder-paused-markup-text', demo, panel);
  await demo.keyboard.press('Escape');
  await capture('recorder-paused-markup', demo, panel);
  await dispatch({ kind: 'session/resume' });
  await markupHost.getByTitle('Cancel').click().catch(() => {});

  await background.evaluate(() => chrome.storage.local.remove('transcription'));
  await panel.getByRole('button', { name: 'Mic', exact: true }).click();
  await expect(panel.getByRole('dialog', { name: 'Voice setup' })).toBeVisible();
  await capture('recorder-voice-setup-live', panel);
  await panel.getByRole('button', { name: 'Close' }).click();

  await dispatch({ kind: 'session/pause' });
  await expect(panel.getByRole('button', { name: 'Resume' })).toBeVisible();
  await capture('recorder-paused', panel);
  await dispatch({ kind: 'session/resume' });

  await background.evaluate(() => {
    const getContexts = chrome.runtime.getContexts.bind(chrome.runtime);
    chrome.runtime.getContexts = (filter) =>
      new Promise((resolveContexts, rejectContexts) => {
        globalThis.__ujgReleaseStop = () => {
          chrome.runtime.getContexts = getContexts;
          getContexts(filter).then(resolveContexts, rejectContexts);
        };
      });
  });
  const stopping = panel.getByRole('button', { name: /Stop/ });
  await stopping.click({ noWaitAfter: true });
  await expect(panel.getByText('Stopping…', { exact: true })).toBeVisible();
  await capture('recorder-stopping', panel);
  await background.evaluate(() => globalThis.__ujgReleaseStop());
  await expect.poll(async () => (await dispatch({ kind: 'session/getState' })).session?.status)
    .toBe('stopped');

  await panel.reload();
  await expect(panel.getByRole('button', { name: 'Start recording' })).toBeVisible();
  await capture('recorder-idle-list', panel);

  const crashed = await newPanel(() => {
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (name, options) {
      if (name === 'main') {
        throw new Error('The recorder view could not render.');
      }
      return create.call(this, name, options);
    };
  });
  await expect(crashed.getByRole('alert')).toBeVisible();
  await capture('recorder-crashed', crashed);
  await crashed.close();
  await panel.close();
  await demo.close();
  return sessionId;
}

async function captureMicrophone() {
  const granted = await context.newPage();
  await granted.setViewportSize({ width: 840, height: 680 });
  await granted.addInitScript(() => {
    window.close = () => {};
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
  });
  await granted.goto(extUrl('mic-permission.html'));
  await expect(granted.getByText('Microphone enabled — you can close this tab.')).toBeVisible();
  await capture('microphone-granted', granted);
  await granted.close();

  const blocked = await context.newPage();
  await blocked.setViewportSize({ width: 840, height: 680 });
  await blocked.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('Permission denied by the browser.');
    };
  });
  await blocked.goto(extUrl('mic-permission.html'));
  await expect(blocked.getByText(/Microphone access was blocked/)).toBeVisible();
  await capture('microphone-blocked', blocked);
  await blocked.close();
}

const settingsSections = [
  ['proofline', 'settings-proofline'],
  ['services', 'settings-services'],
  ['capture', 'settings-capture'],
  ['redaction', 'settings-redaction'],
  ['transcription', 'settings-transcription'],
  ['publishing', 'settings-publishing'],
  ['summaries', 'settings-summaries'],
  ['github', 'settings-github'],
  ['storage', 'settings-storage'],
];

async function captureSettings() {
  await background.evaluate(() =>
    chrome.storage.local.set({
      prooflineSettings: {
        aiMode: 'personal', github: 'personal', publishing: 'cloudflare', model: '',
      },
    }),
  );
  for (const [section, stateName] of settingsSections) {
    const page = await newOptions(section);
    const region = page.locator('#settings-page');
    await capture(stateName, page);
    await page.close();

    const loading = await newOptions(section, () => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = (keys) =>
        Array.isArray(keys) || typeof keys === 'string'
          ? new Promise(() => {})
          : get(keys);
    });
    await capture(`${stateName}-loading`, loading.locator('#settings-page'));
    await loading.close();

  }

  const account = {
    user: { id: 'u1', login: 'alex' },
    organization: { id: 'org-1', login: 'northstar', name: 'Northstar QA', is_personal: false },
    organizations: [
      { id: 'org-1', login: 'northstar', name: 'Northstar QA', is_personal: false },
    ],
    default_organization_id: 'org-1',
    credits: { balance_microcredits: 12500000, microcredits_per_credit: 1000000 },
    repositories: [{ id: 'repo-1', full_name: 'northstar/storefront', github_repository_id: 42 }],
  };
  const connection = {
    accessToken: 'fixture-token',
    organizationId: 'org-1',
    expiresAt: fixedNow + 3_600_000,
    account,
  };
  await background.evaluate(
    ({ connection: value }) =>
      chrome.storage.local.set({
        prooflineSettings: {
          aiMode: 'proofline',
          github: 'proofline',
          publishing: 'proofline',
          model: '',
          connection: value,
        },
      }),
    { connection },
  );
  let page = await newOptions('proofline');
  await expect(page.locator('span', { hasText: 'Northstar QA' }).first()).toBeVisible();
  await capture('settings-proofline-connected', page.locator('#settings-page'));
  await page.close();

  for (const [section, stateName, summary] of [
    ['services', 'settings-services-connected', 'Using Proofline for all AI services, private report hosting and GitHub issues.'],
    ['transcription', 'settings-transcription-proofline', 'Using Proofline credits for transcription.'],
    ['publishing', 'settings-publishing-proofline', 'Using Proofline for private report hosting.'],
    ['summaries', 'settings-summaries-proofline', 'Using Proofline for AI summaries.'],
    ['github', 'settings-github-proofline', 'Using Proofline for GitHub issues.'],
  ]) {
    page = await newOptions(section);
    await expect(page.getByText(summary, { exact: true })).toBeVisible();
    await capture(stateName, page.locator('#settings-page'));
    await page.close();
  }

  await background.evaluate(
    ({ connection: value }) =>
      chrome.storage.local.set({
        prooflineSettings: {
          aiMode: 'personal', github: 'personal', publishing: 'cloudflare', model: '',
          connection: { ...value, expiresAt: 0 },
        },
      }),
    { connection },
  );
  page = await newOptions('proofline');
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await capture('settings-proofline-expired', page.locator('#settings-page'));
  await page.close();

  await background.evaluate(() =>
    chrome.storage.local.set({
      prooflineSettings: { aiMode: 'proofline', github: 'personal', publishing: 'cloudflare', model: '' },
      sharingSettings: {
        provider: 'compatible',
        models: { compatible: { apiKey: '', model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1' } },
        repositories: [],
      },
    }),
  );
  page = await newOptions('summaries');
  await expect(page.getByLabel('API base URL')).toBeVisible();
  await capture('settings-summaries-compatible', page.locator('#settings-page'));
  await page.close();
  page = await newOptions('github');
  await capture('settings-github-empty', page.locator('#settings-page'));
  await page.close();
  page = await newOptions('storage');
  const restoreSessions = await page.evaluate(async () => {
    const request = indexedDB.open('session-recorder', 1);
    const db = await new Promise((done) => { request.onsuccess = () => done(request.result); });
    const tx = db.transaction('sessions', 'readwrite');
    const get = tx.objectStore('sessions').getAll();
    const sessions = await new Promise((done) => { get.onsuccess = () => done(get.result); });
    tx.objectStore('sessions').clear();
    await new Promise((done) => { tx.oncomplete = done; });
    db.close();
    return sessions;
  });
  await page.reload();
  await capture('settings-storage-empty', page.locator('#settings-page'));
  await page.evaluate(async (sessions) => {
    const request = indexedDB.open('session-recorder', 1);
    const db = await new Promise((done) => { request.onsuccess = () => done(request.result); });
    const tx = db.transaction('sessions', 'readwrite');
    for (const session of sessions) tx.objectStore('sessions').put(session);
    await new Promise((done) => { tx.oncomplete = done; });
    db.close();
  }, restoreSessions);
  await page.close();

  await background.evaluate(() =>
    chrome.storage.local.set({
      prooflineSettings: {
        aiMode: 'personal', github: 'personal', publishing: 'cloudflare', model: '',
      },
      transcription: { provider: 'openai', apiKey: 'fixture-key', model: 'whisper-1' },
    }),
  );
  page = await newOptions('transcription');
  let releaseTest;
  const testGate = new Promise((resolveGate) => {
    releaseTest = resolveGate;
  });
  await page.route('https://api.openai.com/**', async (route) => {
    await testGate;
    await route.fulfill({ json: { text: 'Provider connection verified.' } });
  });
  await page.getByRole('button', { name: /Test/ }).click();
  await expect(page.getByRole('button', { name: 'Testing…' })).toBeVisible();
  await capture('settings-transcription-testing', page.locator('#settings-page'));
  releaseTest();
  await expect(page.getByText(/Success:/)).toBeVisible();
  await capture('settings-transcription-test-ok', page.locator('#settings-page'));
  await page.close();
  page = await newOptions('transcription');
  await page.route('https://api.openai.com/**', (route) => route.fulfill({
    status: 401,
    json: { error: { message: 'Fixture provider rejected the key.' } },
  }));
  await page.getByRole('button', { name: /Test/ }).click();
  await expect(page.locator('.settings__result--error')).toBeVisible();
  await capture('settings-transcription-test-error', page.locator('#settings-page'));
  await page.close();

  for (const [section, stateName] of [
    ['capture', 'settings-capture'],
    ['redaction', 'settings-redaction'],
    ['transcription', 'settings-transcription'],
  ]) {
    page = await newOptions(section, () => {
      chrome.storage.local.set = () => new Promise(() => {});
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('fieldset.settings-fields')).toHaveAttribute('disabled', '');
    await capture(`${stateName}-saving`, page.locator('#settings-page'));
    await page.close();

    page = await newOptions(section);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await capture(`${stateName}-saved`, page.locator('#settings-page'));
    await page.close();

    page = await newOptions(section, () => {
      chrome.storage.local.set = () => Promise.reject(new Error('Fixture storage write failed.'));
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Fixture storage write failed');
    await capture(`${stateName}-error`, page.locator('#settings-page'));
    await page.close();
  }

  const seedConnectedProofline = () =>
    background.evaluate(
      ({ connection: value }) =>
        chrome.storage.local.set({
          prooflineSettings: {
            aiMode: 'proofline',
            github: 'proofline',
            publishing: 'proofline',
            model: '',
            connection: value,
          },
        }),
      { connection },
    );

  page = await newOptions('services', () => {
    chrome.storage.local.get = () => Promise.reject(new Error('Fixture service load failed.'));
  });
  await expect(page.getByText('Error: Fixture service load failed.', { exact: true })).toBeVisible();
  await capture('settings-services-error', page.locator('#settings-page'));
  await page.close();

  await seedConnectedProofline();
  page = await newOptions('proofline', () => {
    chrome.storage.local.set = () => new Promise(() => {});
  });
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
  await capture('settings-proofline-saving', page.locator('#settings-page'));
  await page.close();

  await seedConnectedProofline();
  page = await newOptions('proofline', () => {
    chrome.storage.local.set = () => Promise.reject(new Error('Fixture Proofline save failed.'));
  });
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('alert')).toContainText('Fixture Proofline save failed');
  await capture('settings-proofline-error', page.locator('#settings-page'));
  await page.close();

  await background.evaluate(() =>
    chrome.storage.local.set({
      prooflineSettings: {
        aiMode: 'personal', github: 'personal', publishing: 'cloudflare', model: '',
      },
    }),
  );
  page = await newOptions('proofline');
  await page.route('https://proofline.sh/auth/device/code', () => new Promise(() => {}));
  await page.getByRole('button', { name: 'Connect to Proofline' }).click();
  await expect(page.getByRole('status')).toContainText('Approve in your browser');
  await capture('settings-proofline-connecting', page.locator('#settings-page'));
  await page.close();

  await background.evaluate(
    ({ sharing }) =>
      chrome.storage.local.set({
        sharingSettings: sharing,
        prooflineSettings: {
          aiMode: 'personal', github: 'personal', publishing: 'cloudflare', model: '',
        },
      }),
    { sharing: personalSharingSettings },
  );

  page = await newOptions('summaries', () => {
    chrome.storage.local.set = () => new Promise(() => {});
  });
  await page.getByRole('button', { name: 'Save summary settings' }).click();
  await expect(page.getByRole('button', { name: 'Save summary settings' })).toBeDisabled();
  await capture('settings-summaries-saving', page.locator('#settings-page'));
  await page.close();

  page = await newOptions('summaries');
  await page.getByRole('button', { name: 'Save summary settings' }).click();
  await expect(page.getByRole('status')).toContainText('Sharing settings saved');
  await capture('settings-summaries-saved', page.locator('#settings-page'));
  await page.close();

  page = await newOptions('summaries', () => {
    chrome.storage.local.set = () => Promise.reject(new Error('Fixture summary save failed.'));
  });
  await page.getByRole('button', { name: 'Save summary settings' }).click();
  await expect(page.getByRole('alert')).toContainText('Fixture summary save failed');
  await capture('settings-summaries-error', page.locator('#settings-page'));
  await page.close();

  const publishingGate = dependencyGate();
  page = await newOptions('publishing');
  await installCloudflareRoutes(page, publishingGate);
  await page.getByRole('button', { name: 'Verify Access & save' }).click();
  await publishingGate.reached;
  page.__ujgHold = publishingGate;
  await expect(page.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  await capture('settings-publishing-saving', page.locator('#settings-page'));
  publishingGate.release();
  await expect(page.getByRole('status')).toContainText('Saved. Access application');
  await capture('settings-publishing-saved', page.locator('#settings-page'));
  await page.close();

  page = await newOptions('publishing');
  await page.route('https://api.cloudflare.com/client/v4/**', (route) =>
    route.fulfill({ status: 401, json: { success: false, result: null } }),
  );
  await page.getByRole('button', { name: 'Verify Access & save' }).click();
  await expect(page.getByRole('alert')).toContainText('Cloudflare request failed');
  await capture('settings-publishing-error', page.locator('#settings-page'));
  await page.close();

  const githubGate = dependencyGate();
  page = await newOptions('github');
  await page.route('https://api.github.com/**', async (route) => {
    githubGate.markReached();
    await githubGate.held;
    await route.fulfill({ json: { has_issues: true, archived: false } });
  });
  await page.getByRole('button', { name: 'Save GitHub settings' }).click();
  await githubGate.reached;
  page.__ujgHold = githubGate;
  await expect(page.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  await capture('settings-github-saving', page.locator('#settings-page'));
  githubGate.release();
  await expect(page.getByRole('status')).toContainText('Repositories verified and saved');
  await capture('settings-github-saved', page.locator('#settings-page'));
  await page.close();

  page = await newOptions('github');
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 403, json: { message: 'Fixture token rejected.' } }),
  );
  await page.getByRole('button', { name: 'Save GitHub settings' }).click();
  await expect(page.getByRole('alert')).toContainText('GitHub repository check failed');
  await capture('settings-github-error', page.locator('#settings-page'));
  await page.close();

  page = await newOptions('storage');
  await page.evaluate(() => {
    navigator.storage.estimate = () => {
      globalThis.__ujgHold = { reached: true, released: false, boundary: 'navigator.storage.estimate' };
      return new Promise(() => {});
    };
  });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('fieldset.settings-fields')).toHaveAttribute('disabled', '');
  await capture('settings-storage-saving', page.locator('#settings-page'));
  await page.close();

  page = await newOptions('storage');
  await page.evaluate(() => {
    IDBDatabase.prototype.transaction = function () {
      throw new Error('Fixture storage refresh failed.');
    };
  });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('alert')).toContainText('Fixture storage refresh failed');
  await capture('settings-storage-error', page.locator('#settings-page'));
  await page.close();
}

async function seedDraft(sessionId, value) {
  await background.evaluate(
    ({ key, value: draft }) => chrome.storage.local.set({ [key]: draft }),
    { key: `shareDraft:${sessionId}`, value },
  );
}

const draft = {
  title: 'Discount confirmation leaves the total unchanged',
  body: '## Summary\n\nThe checkout accepts **SAVE20** but keeps the original total.\n\n## Expected\n\nThe total updates before payment.',
};
const destination = {
  accountId: 'a'.repeat(32),
  projectName: 'northstar-reports',
  accessAppId: '12345678-1234-1234-1234-123456789abc',
  teamDomain: 'northstar.cloudflareaccess.com',
};
const pendingPublication = {
  deployment: {
    id: 'deployment-pending',
    url: 'https://discount-fixture.northstar-reports.pages.dev',
    environment: 'preview',
    latest_stage: { name: 'deploy', status: 'queued' },
  },
  destination,
  level: 'L1',
};
const readyPublication = {
  ...pendingPublication,
  deployment: {
    ...pendingPublication.deployment,
    id: 'deployment-ready',
    latest_stage: { name: 'deploy', status: 'success' },
  },
};
const attempt = {
  id: 'attempt-fixture',
  repository: 'northstar/storefront',
  startedAt: '2026-11-03T10:29:00.000Z',
};
const issue = {
  number: 42,
  url: 'https://github.com/northstar/storefront/issues/42',
  repository: 'northstar/storefront',
};

async function workspacePage(sessionId, saved, initScript) {
  if (saved) await seedDraft(sessionId, saved);
  const page = await context.newPage();
  await page.setViewportSize(viewports.workspace);
  await installScenarioScript(page, initScript);
  await page.goto(extUrl(`share.html?session=${sessionId}`));
  await expect(page.locator('.report-workspace')).toBeVisible();
  return page;
}

async function seedSmallRecording(id) {
  await background.evaluate(async ({ id, now }) => {
    const request = indexedDB.open('session-recorder', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      db.createObjectStore('events', { keyPath: 'id' }).createIndex('by-session', ['sessionId', 't']);
      db.createObjectStore('assets', { keyPath: 'id' }).createIndex('by-session', 'sessionId');
    };
    const db = await new Promise((done, fail) => { request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
    const tx = db.transaction(['sessions', 'events', 'assets'], 'readwrite');
    for (const store of ['sessions', 'events', 'assets']) tx.objectStore(store).clear();
    tx.objectStore('sessions').put({
      id, name: 'Northstar · Checkout', status: 'stopped', startedAt: now - 62_000, endedAt: now,
      initialUrl: 'https://example.test/checkout', tabs: [], counts: { note: 1, 'file-attached': 1 }, assetBytes: 29,
      settings: { screenshotPolicy: 'on-demand', inlineBodyCapBytes: 262144, assetBodyCapBytes: 2097152, fileCapBytes: 26214400,
        redactionEnabled: true, customRedaction: { headerNames: [], bodyKeyPatterns: [], urlParamPatterns: [] },
        filterTelemetry: true, screenshotQuality: 80, screenshotDedupThreshold: 5, hoverDwellMs: 700, captureApiSpec: false },
    });
    tx.objectStore('events').put({ id: `${id}-note`, sessionId: id, type: 'note', t: 14000, at: now - 48000, importance: 80, protected: true, payload: { text: 'The discount was accepted; the total remained $120 instead of $96.' } });
    const blob = new Blob(['Fictional checkout diagnostic.'], { type: 'text/plain' });
    tx.objectStore('assets').put({ id: `${id}-file`, sessionId: id, kind: 'file', mime: 'text/plain', size: blob.size, blob });
    tx.objectStore('events').put({ id: `${id}-attached`, sessionId: id, type: 'file-attached', t: 15000, at: now - 47000, importance: 80, protected: true, payload: { assetId: `${id}-file`, fileName: 'diagnostic.txt', mime: 'text/plain', size: blob.size } });
    await new Promise((done, fail) => { tx.oncomplete = done; tx.onerror = () => fail(tx.error); });
    db.close();
  }, { id, now: fixedNow });
  return id;
}

function dependencyGate() {
  let markReached;
  let release;
  const reached = new Promise((resolveReached) => {
    markReached = resolveReached;
  });
  const held = new Promise((resolveHeld) => {
    release = resolveHeld;
  });
  let arrived = false, released = false;
  return {
    get reached() {
      let timeout;
      return Promise.race([reached, new Promise((_, fail) => { timeout = setTimeout(() => fail(new Error('Expected dependency was not reached within 30 seconds.')), 30000); })]).finally(() => clearTimeout(timeout));
    },
    held, markReached: () => { arrived = true; markReached(); }, release: () => { released = true; release(); },
    assertHeld: async () => { if (!arrived || released) throw new Error('Dependency was not reached or is no longer held.'); return { reached: true, released: false, boundary: 'Intercepted production request' }; },
  };
}

function holdDatabaseRead() {
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => {
    const request = open(...args);
    request.addEventListener('success', (event) => {
      event.stopImmediatePropagation();
      globalThis.__ujgHold = { reached: true, released: false, boundary: 'IndexedDB open success' };
      globalThis.__ujgReleaseLoad = () => {
        globalThis.__ujgHold.released = true;
        request.dispatchEvent(new Event('success'));
      };
    }, { once: true });
    return request;
  };
}

const personalSharingSettings = {
  cloudflare: {
    apiToken: 'cloudflare-fixture-key',
    ...destination,
  },
  repository: 'northstar/storefront',
  githubToken: 'github-fixture-key',
  repositories: [
    {
      id: 'repository-fixture',
      repository: 'northstar/storefront',
      token: 'github-fixture-key',
    },
  ],
  lastRepository: 'northstar/storefront',
  provider: 'openai',
  models: {
    openai: {
      apiKey: 'model-fixture-key',
      model: 'gpt-6.1-sol',
      baseUrl: 'https://api.openai.com/v1',
    },
  },
};

const summaryResponse = {
  choices: [
    {
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          title: 'Checkout total does not reflect the discount',
          body: '## Summary\n\nThe checkout accepts SAVE20 but keeps the original total.',
        }),
      },
    },
  ],
};

// A request whose initiating page closes can be re-parented by Chromium before
// routing completes. Keep the deterministic AI fixture at context scope as the
// final safety net; page-level routes still take priority for held states.
await context.route('https://api.openai.com/v1/chat/completions', (route) =>
  route.fulfill({ json: summaryResponse }),
);

async function installCloudflareRoutes(page, gate) {
  let held = false;
  await page.route('https://api.cloudflare.com/client/v4/**', async (route) => {
    if (gate && !held) {
      held = true;
      gate.markReached();
      await gate.held;
    }
    const request = route.request();
    const url = request.url();
    let result;
    if (url.endsWith(`/pages/projects/${destination.projectName}`)) {
      result = {
        name: destination.projectName,
        subdomain: `${destination.projectName}.pages.dev`,
        production_branch: 'main',
        deployment_configs: { preview: { fail_open: false } },
      };
    } else if (url.endsWith(`/access/apps/${destination.accessAppId}`)) {
      result = {
        type: 'self_hosted',
        domain: `*.${destination.projectName}.pages.dev`,
        aud: 'b'.repeat(64),
      };
    } else if (url.includes('/policies?')) {
      result = [{ decision: 'allow' }];
    } else if (url.endsWith('/upload-token')) {
      result = { jwt: 'upload-fixture-token' };
    } else if (
      url.endsWith('/pages/assets/upload') ||
      url.endsWith('/pages/assets/upsert-hashes')
    ) {
      result = null;
    } else if (url.endsWith('/deployments') && request.method() === 'POST') {
      result = readyPublication.deployment;
    } else if (url.includes('/deployments/')) {
      result = request.method() === 'DELETE' ? null : readyPublication.deployment;
    } else {
      throw new Error(`Unexpected Cloudflare fixture request: ${request.method()} ${url}`);
    }
    await route.fulfill({ json: { success: true, result } });
  });
  await page.route(
    `https://${destination.teamDomain}/cdn-cgi/access/certs`,
    (route) => route.fulfill({ json: { keys: [] } }),
  );
}

async function captureWorkspaceAndTimeline(sessionId) {
  await background.evaluate(
    ({ sharing }) =>
      chrome.storage.local.set({
        sharingSettings: sharing,
        prooflineSettings: {
          aiMode: 'personal',
          github: 'personal',
          publishing: 'cloudflare',
          model: '',
        },
      }),
    { sharing: personalSharingSettings },
  );

  let page = await context.newPage();
  await page.setViewportSize(viewports.workspace);
  await page.goto(extUrl('share.html'));
  await expect(page.getByRole('alert')).toBeVisible();
  await capture('workspace-unavailable', page);
  await page.close();

  page = await context.newPage();
  await page.setViewportSize(viewports.workspace);
  await page.addInitScript(holdDatabaseRead);
  const loadingPromise = page.goto(extUrl(`share.html?session=${sessionId}`));
  await page.waitForSelector('.report-workspace');
  await page.waitForFunction(() => globalThis.__ujgHold?.reached);
  await capture('workspace-loading', page);
  await loadingPromise;
  await page.close();

  const baseDraft = { draft, repository: 'northstar/storefront', draftSource: 'edited' };

  const liveDemo = await context.newPage();
  await liveDemo.goto(`${origin}/checkout.html`);
  const liveSession = await dispatch({
    kind: 'session/start',
    tabId: await tabIdFor(`${origin}/checkout.html`),
  });
  if (!liveSession.ok) throw new Error(`Could not create live-session fixture: ${liveSession.error}`);
  page = await context.newPage();
  await page.setViewportSize(viewports.workspace);
  await page.goto(extUrl(`share.html?session=${liveSession.session.id}`));
  await expect(page.getByRole('alert')).toContainText('Stop the recording');
  await capture('workspace-still-live', page);
  await page.close();
  await dispatch({ kind: 'session/stop' });
  await liveDemo.close();

  page = await workspacePage(sessionId, baseDraft, () => {
    Blob.prototype.arrayBuffer = () => {
      globalThis.__ujgHold = { reached: true, released: false, boundary: 'Report asset Blob.arrayBuffer' };
      return new Promise(() => {});
    };
  });
  await page.waitForFunction(() => globalThis.__ujgHold?.reached);
  await expect(page.getByText('Loading recording…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'File GitHub issue', exact: true })).toBeDisabled();
  await capture('workspace-preparing', page);
  await page.close();

  page = await workspacePage(sessionId, baseDraft);
  await expect(page.getByLabel('Issue title')).toHaveValue(draft.title);
  await capture('workspace-draft', page);
  await page.getByRole('button', { name: 'Edit draft' }).click();
  await expect(page.getByLabel('Issue summary · Markdown')).toBeVisible();
  await capture('workspace-editing', page);
  await page.close();

  const variants = [
    ['workspace-cloudflare-pending', { ...baseDraft, publication: pendingPublication }],
    ['workspace-published', { ...baseDraft, publication: readyPublication }],
    ['workspace-uncertain', { ...baseDraft, publication: readyPublication, attempt }],
    ['workspace-filed', { ...baseDraft, publication: readyPublication, issue }],
    ['workspace-filed-unpublished', { ...baseDraft, issue }],
    ['workspace-uncertain-unpublished', { ...baseDraft, attempt }],
    ['workspace-managed-partial', {
      ...baseDraft,
      publication: {
        provider: 'proofline',
        id: 'report-fixture',
        organizationId: 'org-fixture',
        url: 'https://proofline.sh/recorder/reports/org-fixture/report-fixture',
        level: 'L1',
        requestId: 'request-fixture',
        attachments: [{ path: 'screens/evidence.png', requestId: 'asset-fixture', uploaded: false }],
      },
    }],
  ];
  for (const [stateName, saved] of variants) {
    page = await workspacePage(sessionId, saved);
    await capture(stateName, page);
    await page.close();
  }

  page = await workspacePage(sessionId, { ...baseDraft, publication: readyPublication });
  await page.getByText('Report options').click();
  await page.getByRole('button', { name: 'Copy issue Markdown' }).click();
  await page.getByText('Unpublish report…').click();
  await expect(page.getByText(/Delete this deployment/)).toBeVisible();
  await capture('workspace-delete-confirm', page);
  await page.close();

  const summaryGate = dependencyGate();
  page = await workspacePage(sessionId, baseDraft);
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    summaryGate.markReached();
    await summaryGate.held;
    await route.fulfill({ json: summaryResponse });
  });
  await page.getByText('Report options').click();
  await page.getByRole('button', { name: 'Regenerate summary' }).click();
  await summaryGate.reached;
  page.__ujgHold = summaryGate;
  await expect(page.getByRole('status')).toContainText('Generating issue summary');
  await capture('workspace-summary-running', page);
  summaryGate.release();
  await expect(page.getByRole('status')).toContainText('Summary ready');
  await page.close();

  const publishGate = dependencyGate();
  page = await workspacePage(sessionId, baseDraft);
  await installCloudflareRoutes(page, publishGate);
  await page.getByText('Report options').click();
  await page.getByRole('button', { name: 'Publish report only' }).click();
  await publishGate.reached;
  page.__ujgHold = publishGate;
  await capture('workspace-publish-running', page);
  publishGate.release();
  await expect(page.getByRole('status')).toContainText('Report published');
  await page.close();

  const checkGate = dependencyGate();
  page = await workspacePage(sessionId, { ...baseDraft, publication: pendingPublication });
  await installCloudflareRoutes(page, checkGate);
  await page.getByRole('button', { name: 'Check deployment' }).click();
  await checkGate.reached;
  page.__ujgHold = checkGate;
  await capture('workspace-deployment-checking', page);
  checkGate.release();
  await expect(page.getByRole('status')).toContainText('Report published');
  await page.close();

  page = await workspacePage(
    sessionId,
    { ...baseDraft, publication: readyPublication },
    () => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => {
          globalThis.__ujgHold = { reached: true, released: false, boundary: 'navigator.clipboard.writeText' };
          return new Promise(() => {});
        } },
      });
    },
  );
  await page.getByText('Report options').click();
  await page.getByRole('button', { name: 'Copy issue Markdown' }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await capture('workspace-copying', page);
  await page.close();

  const deleteGate = dependencyGate();
  page = await workspacePage(sessionId, { ...baseDraft, publication: readyPublication });
  await installCloudflareRoutes(page, deleteGate);
  await page.getByText('Report options').click();
  await page.getByText('Unpublish report…').click();
  await page.getByRole('button', { name: 'Delete deployment' }).click();
  await deleteGate.reached;
  page.__ujgHold = deleteGate;
  await capture('workspace-delete-running', page);
  deleteGate.release();
  await expect(page.getByRole('status')).toContainText('Report unpublished');
  await page.close();

  const cancelGate = dependencyGate();
  page = await workspacePage(sessionId, baseDraft, () => {
    AbortController.prototype.abort = function () {};
  });
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    cancelGate.markReached();
    await cancelGate.held;
    await route.fulfill({ json: summaryResponse });
  });
  await page.getByText('Report options').click();
  await page.getByRole('button', { name: 'Regenerate summary' }).click();
  await cancelGate.reached;
  page.__ujgHold = cancelGate;
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Cancelling');
  await capture('workspace-cancelling', page);
  await page.close();

  const connectionGate = dependencyGate();
  const filingSummaryGate = dependencyGate();
  const filingPublishGate = dependencyGate();
  const filingIssueGate = dependencyGate();
  page = await workspacePage(
    sessionId,
    { ...baseDraft, draftSource: 'initial' },
    () => {
      AbortController.prototype.abort = function () {};
    },
  );
  await page.route('https://api.github.com/**', async (route) => {
    if (route.request().method() === 'POST') {
      filingIssueGate.markReached();
      await filingIssueGate.held;
      await route.fulfill({
        status: 201,
        json: {
          number: 42,
          html_url: 'https://github.com/northstar/storefront/issues/42',
        },
      });
      return;
    }
    connectionGate.markReached();
    await connectionGate.held;
    await route.fulfill({ json: { has_issues: true } });
  });
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    filingSummaryGate.markReached();
    await filingSummaryGate.held;
    await route.fulfill({ json: summaryResponse });
  });
  await installCloudflareRoutes(page, filingPublishGate);
  await expect(page.getByRole('button', { name: 'File GitHub issue', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'File GitHub issue', exact: true }).click();
  await connectionGate.reached;
  page.__ujgHold = connectionGate;
  await expect(page.getByRole('status')).toContainText('Checking GitHub connection');
  await capture('workspace-filing-connection', page.locator('.filing-progress'));
  connectionGate.release();
  await filingSummaryGate.reached;
  page.__ujgHold = filingSummaryGate;
  await expect(page.locator('li[data-state="active"]')).toContainText('Prepare issue summary');
  await capture('workspace-filing-summary', page.locator('.filing-progress'));
  filingSummaryGate.release();
  await filingPublishGate.reached;
  page.__ujgHold = filingPublishGate;
  await expect(page.locator('li[data-state="active"]')).toContainText('Publish protected report');
  await capture('workspace-filing-publish', page.locator('.filing-progress'));
  filingPublishGate.release();
  await filingIssueGate.reached;
  page.__ujgHold = filingIssueGate;
  await expect(page.locator('li[data-state="active"]')).toContainText('Create GitHub issue');
  await capture('workspace-filing-issue', page.locator('.filing-progress'));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cancelling…' })).toBeVisible();
  await capture('workspace-filing-cancelling', page.locator('.filing-progress'));
  filingIssueGate.release();
  await page.close();

  const timelineMissing = await context.newPage();
  await timelineMissing.setViewportSize(viewports.timeline);
  await timelineMissing.goto(extUrl('report.html'));
  await expect(timelineMissing.getByText('No session specified.')).toBeVisible();
  await capture('timeline-missing', timelineMissing);
  await timelineMissing.close();

  const timeline = await context.newPage();
  await timeline.setViewportSize(viewports.timeline);
  await timeline.addInitScript(holdDatabaseRead);
  const navigation = timeline.goto(extUrl(`report.html?session=${sessionId}`));
  await timeline.waitForSelector('#report');
  await timeline.waitForFunction(() => globalThis.__ujgHold?.reached);
  await capture('timeline-loading', timeline);
  await timeline.evaluate(() => globalThis.__ujgReleaseLoad());
  await navigation;
  await expect(timeline.getByRole('button', { name: /Download .zip/ })).toBeVisible();
  await capture('timeline-ready', timeline);
  await timeline.evaluate(() => {
    chrome.downloads.download = async () => {
      globalThis.__ujgHold = { reached: true, released: false, boundary: 'chrome.downloads.download' };
      return new Promise(() => {});
    };
  });
  await timeline.getByRole('button', { name: /Download .zip/ }).click();
  await expect(timeline.getByRole('button', { name: /Preparing|Downloading/ })).toBeVisible();
  await timeline.waitForFunction(() => globalThis.__ujgHold?.boundary === 'chrome.downloads.download');
  await capture('timeline-preparing-zip', timeline);
  await timeline.close();

}

try {
  if (book.needsGroup('recorder')) {
    captureStage = 'recorder';
    await captureRecorder();
  }
  if (needsAppGroup('microphone')) {
    captureStage = 'microphone';
    await captureMicrophone();
  }
  if (needsAppGroup('settings')) {
    captureStage = 'settings';
    await seedSmallRecording('settings-fixture');
    await captureSettings();
  }
  if (['workspace', 'filing', 'timeline'].some(book.needsGroup)) {
    captureStage = 'workspace';
    const sessionId = await seedSmallRecording('workspace-fixture');
    await captureWorkspaceAndTimeline(sessionId);
  }
} finally {
  unknownRequests.push(...await background.evaluate(() => globalThis.__ujgUnexpectedNetwork ?? []));
  await context.close();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  await rm(profile, { recursive: true, force: true });
}

async function chromeWindowId(title, processId) {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Capturing browser-owned confirmation UI currently requires macOS screencapture.',
    );
  }
  const swift = String.raw`
import CoreGraphics
import Foundation

let title = CommandLine.arguments.dropFirst().first ?? ""
let processId = Int(CommandLine.arguments.dropFirst(2).first ?? "") ?? -1
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
let candidates = windows.compactMap { window -> (Int, Double, String, String)? in
  guard
    let number = window[kCGWindowNumber as String] as? Int,
    let owner = window[kCGWindowOwnerName as String] as? String,
    let layer = window[kCGWindowLayer as String] as? Int,
    layer == 0,
    (window[kCGWindowOwnerPID as String] as? Int) == processId,
    owner.localizedCaseInsensitiveContains("Chromium") ||
      owner.localizedCaseInsensitiveContains("Chrome for Testing")
  else { return nil }
  let name = window[kCGWindowName as String] as? String ?? ""
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let width = bounds["Width"] as? Double ?? 0
  let height = bounds["Height"] as? Double ?? 0
  return (number, width * height, owner, name)
}
let titled = candidates.filter { $0.3.localizedCaseInsensitiveContains(title) }
guard let match = titled.max(by: { $0.1 < $1.1 }) else {
  fputs("No visible Chromium window found.\n", stderr)
  exit(2)
}
print(match.0)
`;
  const { stdout } = await execFileAsync('/usr/bin/swift', [
    '-e',
    swift,
    title,
    String(processId),
  ]);
  const id = stdout.trim();
  if (!/^\d+$/.test(id)) throw new Error(`Invalid Chromium window ID: ${id}`);
  return id;
}

async function captureNativeBrowserSurfaces() {
  const nativeProfile = await mkdtemp(resolve(bundleRoot, '.output/ujg-native-browser-'));
  const nativeContext = await chromium.launchPersistentContext(nativeProfile, {
    channel: 'chromium',
    headless: false,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    viewport: { width: 1200, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-position=40,40',
      '--window-size=1200,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-color-profile=srgb',
    ],
  });
  let nativeWorker;
  try {
    await nativeContext.addInitScript(deterministicBrowserEnvironment, fixedNow);
    let worker = nativeContext.serviceWorkers()[0];
    if (!worker) worker = await nativeContext.waitForEvent('serviceworker');
    nativeWorker = worker;
    await guardWorkerNetwork(worker);
    const nativeExtensionId = new URL(worker.url()).host;
    nativeContext.on('page', watchConsole);
    await nativeContext.route(/^https?:/, (route) => {
      unknownRequests.push('native: ' + route.request().url());
      return route.abort();
    });
    const cdp = await nativeContext.browser().newBrowserCDPSession();
    const processes = await cdp.send('SystemInfo.getProcessInfo');
    const processId = processes.processInfo.find((info) => info.type === 'browser')?.id;
    if (!processId) throw new Error('Cannot resolve native Chromium process.');
    const { stdout: appearance } = await execFileAsync('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle']).catch(() => ({ stdout: 'Light' }));
    const hostAppearance = appearance.trim() || 'Light';
    async function raster(name, page, title, expectedText) {
      const windowId = await chromeWindowId(title, processId);
      const destination = resolve(nativeProfile, name + '.png');
      await execFileAsync('/usr/sbin/screencapture', ['-x', '-o', '-l', windowId, destination]);
      const swift = String.raw`
import Foundation
import Vision
import ImageIO
let url = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first!)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
let handler = VNImageRequestHandler(url: url, options: [:])
try handler.perform([request])
print((request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n"))
`;
      const { stdout } = await execFileAsync('/usr/bin/swift', ['-e', swift, destination]);
      if (!expectedText.test(stdout)) throw new Error('Required native dialog text missing: ' + stdout);
      await book.captureNative(name, page, await readFile(destination), { processId, windowId, title, hostAppearance, browserVersion: nativeContext.browser().version(), recognizedText: stdout.trim(), confirmedDialog: true });
    }

    if (book.wants('microphone-requesting')) {
      const microphone = await nativeContext.newPage();
      await microphone.setViewportSize({ width: 1200, height: 900 });
      await microphone.bringToFront();
      await microphone.goto(`chrome-extension://${nativeExtensionId}/mic-permission.html`);
      const title = await microphone.title();
      await expect(microphone.getByText('Requesting microphone permission…')).toBeVisible();
      await microphone.waitForTimeout(500);
      await raster('microphone-requesting', microphone, title, /Allow this time|Use available microphones/i);
      await microphone.close();
    }
    if (!book.wants('settings-storage-confirm')) return;
    const page = await nativeContext.newPage();
    await page.bringToFront();
    await page.goto(
      `chrome-extension://${nativeExtensionId}/options.html#storage`,
    );
    await expect(page.locator('#settings-page')).toBeVisible();
    await page.evaluate(
      ({ now }) =>
        new Promise((resolveSeed, rejectSeed) => {
          const request = indexedDB.open('session-recorder', 1);
          request.onerror = () => rejectSeed(request.error);
          request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('sessions'))
              database.createObjectStore('sessions', { keyPath: 'id' });
            if (!database.objectStoreNames.contains('events')) {
              const events = database.createObjectStore('events', { keyPath: 'id' });
              events.createIndex('by-session', ['sessionId', 't']);
            }
            if (!database.objectStoreNames.contains('assets')) {
              const assets = database.createObjectStore('assets', { keyPath: 'id' });
              assets.createIndex('by-session', 'sessionId');
            }
          };
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('sessions', 'readwrite');
            transaction.objectStore('sessions').put({
              id: 'session-native-confirmation',
              name: 'Checkout discount investigation',
              status: 'stopped',
              startedAt: now - 60_000,
              endedAt: now,
              initialUrl: 'https://example.test/checkout',
              tabs: [],
              settings: {},
              counts: { click: 8, input: 4 },
              assetBytes: 245_760,
            });
            transaction.oncomplete = () => {
              database.close();
              resolveSeed();
            };
            transaction.onerror = () => rejectSeed(transaction.error);
          };
        }),
      { now: fixedNow },
    );
    await page.reload();
    await expect(page.locator('#settings-page')).toBeVisible();
    const deleteAll = page.getByRole('button', { name: 'Delete all sessions' });
    await expect(deleteAll).toBeEnabled();
    const windowTitle = await page.title();
    const dialogPromise = page.waitForEvent('dialog');
    let clickFailure;
    // The native dialog deliberately remains open through OS capture and OCR.
    // Attach rejection handling immediately and avoid the ordinary 30s click
    // timeout while that dialog blocks Chromium's input acknowledgement.
    const clickPromise = deleteAll.click({ timeout: 0 }).catch((error) => { clickFailure = error; });
    const dialog = await dialogPromise;
    if (
      dialog.type() !== 'confirm' ||
      !dialog.message().includes('Delete all 1 recorded session')
    ) {
      throw new Error(
        `Unexpected storage confirmation: ${dialog.type()} ${dialog.message()}`,
      );
    }
    await page.waitForTimeout(300);
    await raster('settings-storage-confirm', page, windowTitle, /Delete all 1 recorded session/i);
    await dialog.dismiss().catch((error) => {
      // macOS can cancel a JavaScript dialog when window focus changes during
      // the OS screenshot/OCR handoff. The captured modal was already verified.
      if (!error.message.includes('No dialog is showing')) throw error;
    });
    await clickPromise;
    if (clickFailure) throw clickFailure;
  } finally {
    try {
      if (nativeWorker) unknownRequests.push(...await nativeWorker.evaluate(() => globalThis.__ujgUnexpectedNetwork ?? []));
    } finally {
      await nativeContext.close();
      await rm(nativeProfile, { recursive: true, force: true });
    }
  }
}

if (book.wants('microphone-requesting') || book.wants('settings-storage-confirm')) await captureNativeBrowserSurfaces();

if (unknownRequests.length) {
  throw new Error(
    `Unexpected external request(s): ${[...new Set(unknownRequests)].slice(0, 8).join(', ')}`,
  );
}
if (consoleFailures.length) {
  throw new Error(
    `Unexpected console error(s): ${[...new Set(consoleFailures)].slice(0, 8).join('\n')}`,
  );
}
await book.finish();
