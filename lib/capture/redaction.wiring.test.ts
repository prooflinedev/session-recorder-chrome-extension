/**
 * Behavioural guard for the capture funnel wiring: a raw event sent through the
 * real background orchestrator must reach persistence and broadcast redacted.
 *
 * The test lives under lib/** (vitest.config.ts include pattern) but imports the
 * background entrypoint; the include pattern restricts collection, not imports.
 * Browser APIs are stubbed — these are not self-mocks of the code under test.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CaptureSettings, SessionEvent } from '@/lib/session/types';
import { createSession } from '@/lib/storage';

const stored: SessionEvent[] = [];
const broadcastMessages: unknown[] = [];

vi.mock('wxt/utils/define-background', () => ({
  defineBackground: (factory: () => void) => {
    factory();
    return {};
  },
}));

vi.mock('@/lib/messaging', () => ({
  broadcast: (msg: unknown) => broadcastMessages.push(msg),
  onMessage: vi.fn(),
  OFFSCREEN_MARKER: 'sr-offscreen',
  sendToTab: vi.fn(async () => {}),
}));

vi.mock('@/lib/storage', () => ({
  EventWriter: class {
    add(e: SessionEvent) {
      stored.push(e);
    }
    async flush() {}
    dispose() {}
    size() {
      return stored.length;
    }
  },
  appendEvents: vi.fn(async () => {}),
  createSession: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  getAsset: vi.fn(async () => undefined),
  getAssetsMeta: vi.fn(async () => []),
  getEvents: vi.fn(async () => []),
  getSession: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => []),
  putAsset: vi.fn(async () => ({ id: 'a', size: 0 })),
  storageEstimate: vi.fn(async () => ({ usage: 0, quota: 0 })),
  updateSession: vi.fn(async () => {}),
}));

vi.mock('@/lib/capture/debugger', () => ({
  DebuggerManager: class {
    onEvent() {}
    onDetach() {}
    async attach() {}
    async detach() {}
    async send() {
      return {};
    }
    attachedTabs() {
      return [];
    }
    async captureScreenshot() {
      return undefined;
    }
  },
}));

vi.mock('@/lib/capture/network', () => ({
  NetworkCapturer: class {
    handle() {}
    flushOpen() {}
    reset() {}
  },
}));

vi.mock('@/lib/capture/console', () => ({
  ConsoleCapturer: class {
    handle() {}
    reset() {}
  },
}));

vi.mock('@/lib/capture/screenshots', () => ({
  ScreenshotScheduler: class {
    onEvent() {}
    async capture() {}
    reset() {}
  },
}));

vi.mock('@/lib/capture/multitab', () => ({
  MultiTabTracker: class {
    start() {}
    stop() {}
    reset() {}
  },
}));

vi.mock('@/lib/proofline/settings', () => ({
  loadProoflineSettings: vi.fn(async () => ({})),
  requireConnection: vi.fn(() => {
    throw new Error('not connected');
  }),
}));

vi.mock('@/lib/transcription/retry', () => ({
  prepareTranscriptionRetry: vi.fn(),
  transcriptionFailure: vi.fn(),
  transcriptionRequestId: vi.fn(() => ''),
}));

vi.mock('@/lib/transcription/vocabulary', () => ({
  extractPageKeyterms: vi.fn(async () => []),
}));

vi.mock('@/lib/transcription', () => ({
  transcribe: vi.fn(async () => ({ text: '' })),
}));

vi.mock('@/lib/export/bundle', () => ({
  estimateForLevels: vi.fn(() => []),
}));

vi.mock('@/lib/sharing/session-title', () => ({
  nameRecordedSession: vi.fn(() => 'Session'),
}));

const listenerApi = { addListener: vi.fn(), removeListener: vi.fn() };

vi.stubGlobal('chrome', {
  storage: {
    local: { setAccessLevel: vi.fn(), get: vi.fn(async () => ({})) },
  },
  runtime: {
    onMessage: listenerApi,
    onStartup: listenerApi,
    onInstalled: listenerApi,
    getURL: (p: string) => p,
    getManifest: () => ({}),
  },
  tabs: {
    get: vi.fn(async () => ({ id: 1, url: 'https://app.example.com/', title: 'App' })),
    query: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
    remove: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    onActivated: listenerApi,
    onRemoved: listenerApi,
    onUpdated: listenerApi,
  },
  webNavigation: {
    onCommitted: listenerApi,
    onHistoryStateUpdated: listenerApi,
    onReferenceFragmentUpdated: listenerApi,
  },
  commands: { onCommand: listenerApi },
  alarms: {
    onAlarm: listenerApi,
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
  action: { onClicked: listenerApi },
  sidePanel: { open: vi.fn(async () => {}) },
  debugger: { onEvent: listenerApi, onDetach: listenerApi },
});

const SETTINGS: CaptureSettings = {
  screenshotPolicy: 'on-demand',
  inlineBodyCapBytes: 1024,
  assetBodyCapBytes: 1024,
  fileCapBytes: 1024,
  redactionEnabled: true,
  customRedaction: { headerNames: [], bodyKeyPatterns: [], urlParamPatterns: [] },
  filterTelemetry: true,
  hoverDwellMs: 0,
  screenshotQuality: 70,
  screenshotDedupThreshold: 4,
  captureApiSpec: false,
};

describe('capture funnel wiring', () => {
  it('redacts a raw event before it reaches persistence and broadcast', async () => {
    stored.length = 0;
    broadcastMessages.length = 0;
    await import('../../entrypoints/background');
    const testHook = (globalThis as Record<string, unknown>).__srTest as (
      msg: unknown,
      tabId?: number,
    ) => Promise<unknown>;

    await testHook({ kind: 'session/start', tabId: 1, settings: SETTINGS }, 1);
    await testHook({
      kind: 'capture/event',
      event: { type: 'nav', tabId: 1, payload: { url: 'https://idp/cb?code=SECRET' } },
    }, 1);

    expect(stored.length).toBeGreaterThan(0);
    const nav = stored.find((e) => e.type === 'nav')!;
    expect(nav.payload).toEqual({ url: 'https://idp/cb?code=«redacted»' });

    const tick = broadcastMessages.find(
      (m) => (m as { kind?: string }).kind === 'event/tick',
    ) as { event?: SessionEvent } | undefined;
    expect(tick?.event?.payload).toEqual({ url: 'https://idp/cb?code=«redacted»' });
  });

  it('N1b: masks a scheme-less carrier before persistence and broadcast', async () => {
    stored.length = 0;
    broadcastMessages.length = 0;
    await import('../../entrypoints/background');
    const testHook = (globalThis as Record<string, unknown>).__srTest as (
      msg: unknown,
      tabId?: number,
    ) => Promise<unknown>;
    const raw = 'https://x/?q=foo%3Dbar%3Fx%3D1%23token%3DSECRET';

    await testHook({ kind: 'session/start', tabId: 1, settings: SETTINGS }, 1);
    await testHook(
      {
        kind: 'capture/event',
        event: { type: 'nav', tabId: 1, payload: { url: raw } },
      },
      1,
    );

    const nav = stored.find((e) => e.type === 'nav')!;
    expect(decodeURIComponent(new URL((nav.payload as { url: string }).url).searchParams.get('q')!)).toBe(
      'foo=bar?x=1#token=«redacted»',
    );
    const tick = broadcastMessages.find(
      (m) => (m as { kind?: string }).kind === 'event/tick',
    ) as { event?: SessionEvent } | undefined;
    expect(
      decodeURIComponent(
        new URL((tick?.event?.payload as { url: string }).url).searchParams.get('q')!,
      ),
    ).toBe('foo=bar?x=1#token=«redacted»');
  });

  it('leaves raw URLs untouched when redactionEnabled is false', async () => {
    stored.length = 0;
    broadcastMessages.length = 0;
    await import('../../entrypoints/background');
    const testHook = (globalThis as Record<string, unknown>).__srTest as (
      msg: unknown,
      tabId?: number,
    ) => Promise<unknown>;

    await testHook({ kind: 'session/stop' }, 1);
    await testHook(
      { kind: 'session/start', tabId: 1, settings: { ...SETTINGS, redactionEnabled: false } },
      1,
    );
    await testHook({
      kind: 'capture/event',
      event: { type: 'nav', tabId: 1, payload: { url: 'https://idp/cb?code=SECRET' } },
    }, 1);

    const nav = stored.find((e) => e.type === 'nav')!;
    expect(nav.payload).toEqual({ url: 'https://idp/cb?code=SECRET' });
  });

  it('F6: redacts URLs in a page-controlled session title before persistence and broadcast', async () => {
    stored.length = 0;
    broadcastMessages.length = 0;
    await import('../../entrypoints/background');
    const testHook = (globalThis as Record<string, unknown>).__srTest as (
      msg: unknown,
      tabId?: number,
    ) => Promise<unknown>;

    // End any session left by the previous test. stop() schedules a delayed
    // state re-broadcast, so let it land before clearing; the assertion below
    // then reads only the state/update emitted by THIS start.
    await testHook({ kind: 'session/stop' }, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    broadcastMessages.length = 0;

    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    // The module-scope chrome stub is created with a default implementation.
    const originalGet = tabsGet.getMockImplementation()!;
    tabsGet.mockImplementation(async () => ({
      id: 1,
      url: 'https://app.example.com/',
      title: 'https://idp/cb?code=TITLE_SECRET',
    }));

    try {
      await testHook({ kind: 'session/start', tabId: 1, settings: SETTINGS }, 1);

      const update = broadcastMessages
        .filter((m) => (m as { kind?: string }).kind === 'state/update')
        .at(-1) as {
        state?: { session?: { name?: string; tabs?: { title?: string }[] } };
      } | undefined;
      expect(update?.state?.session?.name).toContain('code=«redacted»');
      expect(update?.state?.session?.name).not.toContain('TITLE_SECRET');
      const tabTitle = update?.state?.session?.tabs?.[0]?.title;
      expect(tabTitle).toContain('code=«redacted»');
      expect(tabTitle).not.toContain('TITLE_SECRET');

      const persisted = vi.mocked(createSession).mock.calls.at(-1)?.[0] as
        | { name?: string; tabs?: { title?: string }[] }
        | undefined;
      expect(persisted?.name).toContain('code=«redacted»');
      expect(persisted?.name).not.toContain('TITLE_SECRET');
      expect(persisted?.tabs?.[0]?.title).toContain('code=«redacted»');
      expect(persisted?.tabs?.[0]?.title).not.toContain('TITLE_SECRET');

      // Page-controlled titles on tab events go through the same recordEvent
      // funnel as every other payload, so they are masked before persistence.
      await testHook({
        kind: 'capture/event',
        event: {
          type: 'tab-opened',
          tabId: 1,
          payload: { url: 'https://x/', title: 'https://idp/cb?code=TITLE_SECRET' },
        },
      }, 1);
      await testHook({
        kind: 'capture/event',
        event: {
          type: 'tab-switch',
          tabId: 1,
          payload: {
            toTabId: 2,
            toUrl: 'https://x/',
            toTitle: 'https://idp/cb?code=TITLE_SECRET',
          },
        },
      }, 1);

      const opened = stored.find((e) => e.type === 'tab-opened') as
        | { payload: { title: string } }
        | undefined;
      expect(opened?.payload.title).toContain('code=«redacted»');
      expect(opened?.payload.title).not.toContain('TITLE_SECRET');
      const switched = stored.find((e) => e.type === 'tab-switch') as
        | { payload: { toTitle: string } }
        | undefined;
      expect(switched?.payload.toTitle).toContain('code=«redacted»');
      expect(switched?.payload.toTitle).not.toContain('TITLE_SECRET');
    } finally {
      tabsGet.mockImplementation(originalGet);
      await testHook({ kind: 'session/stop' }, 1);
    }
  });
});
