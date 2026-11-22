import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Start / Stop / pause / resume / rehydrate races in the background
 * orchestrator (entrypoints/background.ts), driven through its real message
 * dispatcher (`__srTest`). Storage, messaging and `chrome` are scripted so each
 * await the lifecycle makes can be held open and a Stop (or a second Start)
 * slipped into exactly that window.
 */

type Gate = { promise: Promise<void>; open: () => void };
const h = vi.hoisted(() => {
  const gate = (): Gate => {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  };
  const state = {
    /** Last write per session id, applied in call order like IndexedDB. */
    sessions: new Map<string, any>(),
    writes: [] as { op: 'create' | 'update'; id: string; status: string }[],
    liveSessions: [] as any[],
    listGate: null as Gate | null,
    createGate: null as Gate | null,
    /** Hold the write that marks a session 'stopped'. */
    stoppedWriteGate: null as Gate | null,
    events: [] as any[],
    assets: [] as { id: string; sessionId: string; kind: string }[],
    hashGate: null as Gate | null,
    broadcasts: [] as any[],
    storedEvents: [] as any[],
    transcribeGate: null as Gate | null,
    transcribed: 0,
    vocabGate: null as Gate | null,
    tabMessages: [] as { tabId: number; msg: any }[],
  };
  return { gate, state };
});

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  const write = async (op: 'create' | 'update', s: any, gate: Gate | null) => {
    // IndexedDB applies puts in the order they are issued; only the promise
    // resolution is delayed by a gate.
    h.state.sessions.set(s.id, structuredClone(s));
    h.state.writes.push({ op, id: s.id, status: s.status });
    if (gate) await gate.promise;
  };
  return {
    ...actual,
    createSession: (s: any) => write('create', s, h.state.createGate),
    updateSession: (s: any) =>
      write('update', s, s.status === 'stopped' ? h.state.stoppedWriteGate : null),
    listSessions: async () => {
      if (h.state.listGate) await h.state.listGate.promise;
      return h.state.liveSessions;
    },
    getSession: async (id: string) => h.state.sessions.get(id),
    getEvents: async (sessionId: string) => h.state.storedEvents.filter((e) => e.sessionId === sessionId),
    getAsset: async (id: string) => ({ id, sessionId: '', kind: 'audio', mime: 'audio/webm', size: 1, blob: new Blob(['x']) }),
    getAssetsMeta: async () => [],
    putAsset: async (a: any) => {
      h.state.assets.push({ id: a.id, sessionId: a.sessionId, kind: a.kind });
    },
    appendEvents: async () => {},
    EventWriter: class {
      add(e: any) {
        h.state.events.push(e);
      }
      flush() {
        return Promise.resolve();
      }
      dispose() {}
    },
  };
});

vi.mock('@/lib/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/messaging')>();
  return {
    ...actual,
    onMessage: () => {},
    broadcast: (evt: any) => {
      h.state.broadcasts.push(evt);
    },
    sendToTab: async (tabId: number, msg: any) => {
      h.state.tabMessages.push({ tabId, msg });
      return undefined;
    },
  };
});

vi.mock('@/lib/sharing/session-title', () => ({ nameRecordedSession: async () => null }));

vi.mock('@/lib/transcription/vocabulary', () => ({
  extractPageKeyterms: async () => {
    const g = h.state.vocabGate;
    if (g) await g.promise;
    return [];
  },
}));

vi.mock('@/lib/transcription', () => ({
  transcribe: async () => {
    h.state.transcribed++;
    const g = h.state.transcribeGate;
    if (g) await g.promise;
    return { text: 'late words', words: [] };
  },
}));

// The screenshot pipeline decodes and hashes images with browser APIs.
vi.mock('@/lib/util/hash', () => ({
  averageHashFromBlob: async () => {
    // One-shot: holds the next screenshot while it is being processed.
    const g = h.state.hashGate;
    h.state.hashGate = null;
    if (g) await g.promise;
    return 'hash';
  },
  hammingHex: () => 64,
}));
vi.stubGlobal('createImageBitmap', async () => ({ width: 10, height: 10, close() {} }));

// --------------------------------------------------------------------------
// A scripted `chrome`
// --------------------------------------------------------------------------

/** Any API not scripted below: callable (resolves undefined) and listenable. */
function autoApi(path: string, calls: string[]): any {
  const cache = new Map<PropertyKey, any>();
  const fn = (..._args: unknown[]) => {
    calls.push(path);
    return Promise.resolve(undefined);
  };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === 'then') return undefined;
      if (!cache.has(p)) cache.set(p, autoApi(`${path}.${String(p)}`, calls));
      return cache.get(p);
    },
  });
}

function fakeChrome() {
  const calls: string[] = [];
  const attached = new Set<number>();
  const attachLog: number[] = [];
  const heldAttaches: (() => void)[] = [];
  const heldSends: { method: string; answer: (err?: string) => void }[] = [];
  const holdMethods = new Set<string>();
  /** Methods whose next command only is held. */
  const holdNextMethods = new Set<string>();
  const tabsGetGates = new Map<number, Gate>();
  const offscreenMsgs: string[] = [];
  let offscreenOpen = false;
  let offscreenCreated = 0;
  /** Identity of the open document; recorders live and die with it. */
  let docId = 0;
  const recorders = { audio: false, video: false, audioPaused: false, videoPaused: false };
  /** Document lifecycle and every message it received, in order. */
  const offscreenLog: string[] = [];
  let getContextsGate: Gate | null = null;
  let getContextsThrows = false;
  const tabCreatedListeners = new Set<(tab: any) => void>();
  let executeScriptGate: Gate | null = null;
  let streamIdGate: Gate | null = null;
  let streamIdFails = false;
  let optionalCapturesGate: Gate | null = null;
  const offscreenStartGates = new Map<string, Gate>();
  const storageKeyGates = new Map<string, Gate>();
  let createDocumentGate: Gate | null = null;
  let prefs: Record<string, unknown> = {};
  let holdAttach = false;
  let lastError: { message: string } | undefined;
  const callBack = (cb: (r?: unknown) => void, err?: string, result: unknown = {}) => {
    lastError = err ? { message: err } : undefined;
    cb(err ? undefined : result);
    lastError = undefined;
  };
  const debuggerListeners = { event: new Set<any>(), detach: new Set<any>() };

  const scripted: Record<string, any> = {
    runtime: {
      get lastError() {
        return lastError;
      },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      getContexts: async () => {
        calls.push('getContexts');
        const g = getContextsGate;
        getContextsGate = null;
        if (g) await g.promise;
        if (getContextsThrows) throw new Error('getContexts failed');
        return offscreenOpen ? [{}] : [];
      },
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      sendMessage: async (msg: any) => {
        if (!msg?.__sr_offscreen__) return undefined;
        offscreenMsgs.push(msg.kind);
        offscreenLog.push(msg.kind);
        // No document: nothing receives it (sendToOffscreen maps the rejection
        // to undefined).
        if (!offscreenOpen) return undefined;
        const doc = docId;
        const g = offscreenStartGates.get(msg.kind);
        if (g) {
          offscreenStartGates.delete(msg.kind); // holds the next message of this kind only
          await g.promise;
        }
        // Closed while handling it: the document, its recorders and the reply are gone.
        if (!offscreenOpen || docId !== doc) return undefined;
        switch (msg.kind) {
          case 'audio/start': recorders.audio = true; recorders.audioPaused = false; break;
          case 'audio/stop': recorders.audio = false; recorders.audioPaused = false; break;
          case 'audio/pause': if (recorders.audio) recorders.audioPaused = true; break;
          case 'audio/resume': recorders.audioPaused = false; break;
          case 'video/start': recorders.video = true; recorders.videoPaused = false; break;
          case 'video/stop': recorders.video = false; recorders.videoPaused = false; break;
          case 'video/pause': if (recorders.video) recorders.videoPaused = true; break;
          case 'video/resume':
            // Like the offscreen recorder: only a paused take can resume.
            if (!recorders.video || !recorders.videoPaused) return { ok: false, error: 'Video recorder is not paused.' };
            recorders.videoPaused = false;
            break;
        }
        offscreenLog.push(`${msg.kind}:done`);
        return { ok: true };
      },
      onStartup: autoApi('runtime.onStartup', calls),
      onInstalled: autoApi('runtime.onInstalled', calls),
      onMessage: autoApi('runtime.onMessage', calls),
    },
    storage: {
      local: {
        get: async (keys: unknown) => {
          // startOptionalCaptures reads the from-start switches as an array.
          if (Array.isArray(keys) && optionalCapturesGate) await optionalCapturesGate.promise;
          const kg = typeof keys === 'string' ? storageKeyGates.get(keys) : undefined;
          if (kg) {
            calls.push(`storage.get ${keys}`);
            await kg.promise;
          }
          return { ...prefs };
        },
        set: async () => {},
        setAccessLevel: async () => {},
      },
      onChanged: autoApi('storage.onChanged', calls),
    },
    tabs: {
      get: async (tabId: number) => {
        calls.push(`tabs.get ${tabId}`);
        const g = tabsGetGates.get(tabId);
        if (g) await g.promise;
        return { id: tabId, url: `https://app.test/${tabId}`, title: `Tab ${tabId}`, windowId: 1 };
      },
      query: async () => [],
      create: async (o: any) => {
        calls.push(`tabs.create ${o?.url ?? ''}`);
        return { id: 999 };
      },
      onActivated: autoApi('tabs.onActivated', calls),
      onCreated: {
        addListener: (f: any) => tabCreatedListeners.add(f),
        removeListener: (f: any) => tabCreatedListeners.delete(f),
      },
      captureVisibleTab: async () => {
        calls.push('tabs.captureVisibleTab');
        return 'data:image/jpeg;base64,VISIBLE';
      },
      onRemoved: autoApi('tabs.onRemoved', calls),
      onUpdated: autoApi('tabs.onUpdated', calls),
    },
    scripting: {
      executeScript: async () => {
        calls.push('scripting.executeScript');
        if (executeScriptGate) await executeScriptGate.promise;
        return [];
      },
    },
    alarms: {
      create: (name: string) => calls.push(`alarms.create ${name}`),
      clear: async (name: string) => {
        calls.push(`alarms.clear ${name}`);
        return true;
      },
      onAlarm: autoApi('alarms.onAlarm', calls),
    },
    offscreen: {
      Reason: { USER_MEDIA: 'USER_MEDIA' },
      createDocument: async () => {
        offscreenCreated++;
        if (createDocumentGate) await createDocumentGate.promise;
        docId++;
        offscreenOpen = true;
        offscreenLog.push('create');
      },
      closeDocument: async () => {
        if (!offscreenOpen) throw new Error('No current offscreen document.');
        offscreenOpen = false;
        Object.assign(recorders, { audio: false, video: false, audioPaused: false, videoPaused: false });
        offscreenLog.push('close');
      },
    },
    tabCapture: {
      getMediaStreamId: (_o: unknown, cb: (id: string) => void) => {
        calls.push('tabCapture.getMediaStreamId');
        const go = () =>
          streamIdFails ? callBack(cb as any, 'Cannot capture a tab with an active stream.') : callBack(cb as any, undefined, 'stream-1');
        if (streamIdGate) void streamIdGate.promise.then(go);
        else queueMicrotask(go);
      },
    },
    debugger: {
      attach: ({ tabId }: { tabId: number }, _v: string, cb: () => void) => {
        attachLog.push(tabId);
        const answer = () => {
          attached.add(tabId);
          callBack(cb);
        };
        if (holdAttach) heldAttaches.push(answer);
        else queueMicrotask(answer);
      },
      detach: ({ tabId }: { tabId: number }, cb: () => void) => {
        attached.delete(tabId);
        queueMicrotask(() => callBack(cb));
      },
      sendCommand: ({ tabId }: { tabId: number }, method: string, _p: unknown, cb: (r?: unknown) => void) => {
        calls.push(`send ${tabId} ${method}`);
        const result = method === 'Page.captureScreenshot' ? { data: 'AAAA' } : {};
        const answer = (err?: string) =>
          callBack(cb, err ?? (attached.has(tabId) ? undefined : `Debugger is not attached to the tab with id: ${tabId}.`), result);
        if (holdNextMethods.delete(method) || holdMethods.has(method)) heldSends.push({ method, answer });
        else queueMicrotask(() => answer());
      },
      onEvent: { addListener: (f: any) => debuggerListeners.event.add(f), removeListener: (f: any) => debuggerListeners.event.delete(f) },
      onDetach: { addListener: (f: any) => debuggerListeners.detach.add(f), removeListener: (f: any) => debuggerListeners.detach.delete(f) },
    },
  };

  const root = new Proxy(scripted, {
    get(t, p: string) {
      if (p in t) return t[p];
      t[p] = autoApi(p, calls);
      return t[p];
    },
  });

  return {
    root,
    calls,
    attached,
    attachLog,
    offscreenMsgs,
    holdMethods,
    /** Hold only the next command with this method. */
    holdNext(method: string) {
      holdNextMethods.add(method);
    },
    /** A CDP event from a recorded tab. */
    emitCdp(tabId: number, method: string, params: object) {
      for (const f of debuggerListeners.event) f({ tabId }, method, params);
    },
    count: (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length,
    offscreenCreated: () => offscreenCreated,
    offscreenOpen: () => offscreenOpen,
    offscreenLog,
    /** Which recorders are running in the open document. */
    recorders: () => ({ ...recorders }),
    /** Hold the next chrome.runtime.getContexts() call until the gate opens. */
    holdNextGetContexts() {
      getContextsGate = h.gate();
      return getContextsGate;
    },
    setGetContextsThrows(on: boolean) {
      getContextsThrows = on;
    },
    /** A tab was created (e.g. by a link with target=_blank). */
    emitTabCreated(tab: { id: number; openerTabId?: number; pendingUrl?: string }) {
      for (const f of tabCreatedListeners) f(tab);
    },
    /** Hold the document's handling of (and answer to) the next message of a kind. */
    holdOffscreen(kind: string) {
      const g = h.gate();
      offscreenStartGates.set(kind, g);
      return g;
    },
    holdCreateDocument() {
      createDocumentGate = h.gate();
      return createDocumentGate;
    },
    /** An offscreen document that outlived a service-worker restart, still recording. */
    openSurvivingDocument(running: { audio?: boolean; video?: boolean }) {
      docId++;
      offscreenOpen = true;
      Object.assign(recorders, running);
    },
    holdTabsGet(tabId: number) {
      const g = h.gate();
      tabsGetGates.set(tabId, g);
      return g;
    },
    holdExecuteScript() {
      executeScriptGate = h.gate();
      return executeScriptGate;
    },
    /** Make tabCapture.getMediaStreamId fail from now on. */
    setStreamIdFails(on: boolean) {
      streamIdFails = on;
    },
    holdStreamId() {
      streamIdGate = h.gate();
      return streamIdGate;
    },
    /** Hold chrome.storage.local.get(key) for a single string key. */
    holdStorageKey(key: string) {
      const g = h.gate();
      storageKeyGates.set(key, g);
      return g;
    },
    holdOptionalCaptures() {
      optionalCapturesGate = h.gate();
      return optionalCapturesGate;
    },
    setPrefs(p: Record<string, unknown>) {
      prefs = p;
    },
    setHoldAttach(on: boolean) {
      holdAttach = on;
    },
    answerAttach() {
      const a = heldAttaches.shift();
      if (!a) throw new Error('no held attach');
      a();
    },
    heldAttachCount: () => heldAttaches.length,
    releaseSend(err?: string) {
      const s = heldSends.shift();
      if (!s) throw new Error('no held command');
      s.answer(err);
    },
    heartbeatRunning() {
      const ops = calls.filter((c) => c.startsWith('alarms.'));
      return ops.at(-1)?.startsWith('alarms.create') === true;
    },
  };
}

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

let fake: ReturnType<typeof fakeChrome>;
type Call = (msg: any) => Promise<any>;
let call: Call;

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** Resolve with the promise's value, or 'blocked' if it hasn't settled by now. */
const raceSettle = <T,>(p: Promise<T>) =>
  Promise.race([p, tick().then(() => 'blocked' as const)]);

/** Let every queued continuation run to completion. */
async function drain() {
  for (let i = 0; i < 20; i++) await tick();
}

const start = (tabId: number) => call({ kind: 'session/start', tabId, settings: { screenshotPolicy: 'on-demand' } });
const stop = () => call({ kind: 'session/stop' });
const getState = () => call({ kind: 'session/getState' });
/** Dispatch as if sent by a content script in 	abId. */
const callFrom = (tabId: number, msg: any) => (globalThis as any).__srTest(msg, tabId);

/** setActive:true messages sent to a tab. */
const activations = (tabId: number) =>
  h.state.tabMessages.filter((m) => m.tabId === tabId && m.msg.kind === 'content/setActive' && m.msg.active === true).length;
const stoppedWrites = () => h.state.writes.filter((w) => w.status === 'stopped').length;

async function boot() {
  const bg = (await import('@/entrypoints/background')).default as { main: () => void };
  bg.main();
  call = (globalThis as any).__srTest;
}

beforeEach(() => {
  h.state.sessions.clear();
  h.state.writes.length = 0;
  h.state.liveSessions = [];
  h.state.listGate = null;
  h.state.createGate = null;
  h.state.stoppedWriteGate = null;
  h.state.events.length = 0;
  h.state.assets.length = 0;
  h.state.hashGate = null;
  h.state.broadcasts.length = 0;
  h.state.storedEvents.length = 0;
  h.state.transcribeGate = null;
  h.state.transcribed = 0;
  h.state.vocabGate = null;
  h.state.tabMessages.length = 0;
  fake = fakeChrome();
  (globalThis as any).chrome = fake.root;
});

afterEach(async () => {
  await drain();
  delete (globalThis as any).chrome;
  delete (globalThis as any).__srTest;
});

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('background lifecycle: Stop racing Start', () => {
  it('Stop before the session exists cancels the pending Start', async () => {
    await boot();
    const tabGate = fake.holdTabsGet(11);
    const started = start(11);
    await until(() => fake.count('tabs.get 11') === 1, 'start to read the tab');

    expect(await stop()).toEqual({ ok: true });
    tabGate.open();
    const res = await started;
    await drain();

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stopped before it started/);
    expect((await getState()).recording).toBe(false);
    expect(h.state.writes).toEqual([]); // no session was ever created
    expect(fake.attachLog).toEqual([]);
    expect(fake.count('alarms.create')).toBe(0);
    expect(activations(11)).toBe(0);
  });

  it('a second Start while one is starting is refused', async () => {
    await boot();
    const tabGate = fake.holdTabsGet(11);
    const first = start(11);
    await until(() => fake.count('tabs.get 11') === 1, 'first start to read the tab');
    const second = await start(12);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already/);

    tabGate.open();
    expect((await first).ok).toBe(true);
    await drain();
    expect(h.state.writes.filter((w) => w.op === 'create')).toHaveLength(1);
    expect(fake.attachLog).toEqual([11]);
    expect((await getState()).session.tabs[0].tabId).toBe(11);
    await stop();
  });

  it('Stop while the session is being created: nothing is attached or activated afterwards', async () => {
    await boot();
    h.state.createGate = h.gate();
    const started = start(11);
    await until(() => h.state.writes.some((w) => w.op === 'create'), 'createSession');

    expect((await stop()).ok).toBe(true);
    h.state.createGate.open();
    await started;
    await drain();

    expect(fake.attachLog).toEqual([]);
    expect(fake.attached.size).toBe(0);
    expect(fake.count('alarms.create')).toBe(0);
    expect(fake.count('scripting.executeScript')).toBe(0);
    expect(activations(11)).toBe(0);
    expect((await getState()).recording).toBe(false);
    // The last write left the session stopped, not recording.
    expect(h.state.sessions.values().next().value.status).toBe('stopped');
  });

  it('Stop while Chrome is still attaching for Start: released unused, no degraded note, nothing activated', async () => {
    await boot();
    fake.setHoldAttach(true);
    const started = start(11);
    await until(() => fake.heldAttachCount() === 1, 'the debugger attach');

    const stopped = stop();
    await tick();
    expect(await raceSettle(stopped)).toBe('blocked'); // waits for Chrome's answer
    fake.answerAttach(); // granted, then detached at once by the release
    expect(await stopped).toEqual({ ok: true });
    await started;
    await drain();

    expect(fake.attached.size).toBe(0);
    expect(fake.count('send 11 Network.enable')).toBe(0); // nothing sent to a released attachment
    expect(fake.count('alarms.create')).toBe(0);
    expect(fake.count('scripting.executeScript')).toBe(0);
    expect(activations(11)).toBe(0);
    const st = await getState();
    expect(st.error).toBeUndefined();
    expect(h.state.events.filter((e) => /Deep capture unavailable/.test(e.payload?.text ?? ''))).toEqual([]);
  });

  it('Stop while Start is enabling the domains: released, no degraded note, nothing activated', async () => {
    await boot();
    fake.holdMethods.add('Network.enable');
    const started = start(11);
    await until(() => fake.count('send 11 Network.enable') === 1, 'domain setup to start');

    expect(await stop()).toEqual({ ok: true }); // does not wait for the hung enable
    // The enable answers only after Stop finished, as Chrome does once detached.
    fake.releaseSend('Detached while handling command.');
    await started;
    await drain();

    expect(fake.attached.size).toBe(0);
    expect(fake.count('alarms.create')).toBe(0);
    expect(fake.count('scripting.executeScript')).toBe(0);
    expect(activations(11)).toBe(0);
    const st = await getState();
    expect(st.error).toBeUndefined();
    expect(h.state.events.filter((e) => /Deep capture unavailable/.test(e.payload?.text ?? ''))).toEqual([]);
  });

  it('Stop while content scripts are injected: the tab is not activated afterwards', async () => {
    await boot();
    const inject = fake.holdExecuteScript();
    const started = start(11);
    await until(() => fake.count('scripting.executeScript') === 1, 'content script injection');

    expect((await stop()).ok).toBe(true);
    inject.open();
    await started;
    await drain();

    expect(activations(11)).toBe(0);
    expect(fake.count('send 11 Page.captureScreenshot')).toBe(0);
    expect(fake.heartbeatRunning()).toBe(false);
    expect(fake.attached.size).toBe(0);
    expect(stoppedWrites()).toBe(1);
  });

  it('a normal Start still attaches, activates the tab and starts the heartbeat', async () => {
    await boot();
    const res = await start(11);
    await drain();
    expect(res.ok).toBe(true);
    expect([...fake.attached]).toEqual([11]);
    expect(activations(11)).toBe(1);
    expect(fake.heartbeatRunning()).toBe(true);
    expect((await getState()).recording).toBe(true);
    await stop();
    expect(fake.attached.size).toBe(0);
    expect(fake.heartbeatRunning()).toBe(false);
  });
});

describe('background lifecycle: from-start captures', () => {
  it("a stopped session's pending from-start video never starts in the next session", async () => {
    await boot();
    fake.setPrefs({ [(await import('@/lib/session/settings')).STORAGE_KEYS.videoFromStart]: true });
    const prefsGate = fake.holdOptionalCaptures();
    expect((await start(11)).ok).toBe(true); // A: from-start captures wait on storage
    expect((await stop()).ok).toBe(true);
    expect((await start(12)).ok).toBe(true); // B: its own from-start capture waits too
    prefsGate.open();
    await drain();
    // Only B's own from-start video starts, once.
    expect(fake.offscreenMsgs.filter((k) => k === 'video/start')).toHaveLength(1);
    await stop();
  });

  it('a from-start video that is still starting when Stop runs never starts recording', async () => {
    await boot();
    fake.setPrefs({ [(await import('@/lib/session/settings')).STORAGE_KEYS.videoFromStart]: true });
    const streamGate = fake.holdStreamId();
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.count('tabCapture.getMediaStreamId') === 1, 'video start');

    expect((await stop()).ok).toBe(true);
    streamGate.open();
    await drain();

    expect(fake.offscreenMsgs.filter((k) => k === 'video/start')).toHaveLength(0);
    expect(fake.offscreenCreated()).toBe(0);
    expect(h.state.events.filter((e) => /Video capture could not start/.test(e.payload?.text ?? ''))).toEqual([]);
  });

  it('Stop while the offscreen document is being created: nothing is left open or recording', async () => {
    await boot();
    fake.setPrefs({ [(await import('@/lib/session/settings')).STORAGE_KEYS.videoFromStart]: true });
    const docGate = fake.holdCreateDocument();
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.offscreenCreated() === 1, 'offscreen creation');

    // Stop checks for the document before it exists, so it closes nothing.
    expect((await stop()).ok).toBe(true);
    docGate.open();
    await drain();

    expect(fake.offscreenMsgs.filter((k) => k === 'video/start')).toHaveLength(0);
    expect(fake.offscreenOpen()).toBe(false);
  });

  describe.each([
    ['video', 'videoFromStart', 'video/start', 'video/stop', 'videoOn'],
    ['microphone', 'micFromStart', 'audio/start', 'audio/stop', 'micOn'],
  ] as const)('a %s start whose reply arrives after Stop', (_what, pref, startKind, stopKind, flag) => {
    const recorder = startKind === 'video/start' ? 'video' : 'audio';
    async function startAndHoldReply() {
      const { STORAGE_KEYS } = await import('@/lib/session/settings');
      fake.setPrefs({ [STORAGE_KEYS[pref]]: true, [STORAGE_KEYS.micGranted]: true });
      const reply = fake.holdOffscreen(startKind);
      expect((await start(11)).ok).toBe(true);
      await until(() => fake.offscreenMsgs.includes(startKind), 'the recorder start');
      return reply;
    }

    it('Stop that sees the document leaves nothing recording', async () => {
      await boot();
      const reply = await startAndHoldReply();
      expect((await stop()).ok).toBe(true);
      reply.open();
      await drain();
      expect(fake.recorders()[recorder]).toBe(false);
      expect(fake.offscreenOpen()).toBe(false);
      expect((await getState())[flag]).toBe(false);
    });

    it.each([false, true])(
      'Stop that cannot see the document: the late start stops its own recorder (newer session current: %s)',
      async (newerSession) => {
        await boot();
        const reply = await startAndHoldReply();
        fake.setGetContextsThrows(true); // Stop can't tell the document exists
        expect((await stop()).ok).toBe(true);
        fake.setGetContextsThrows(false);
        expect(fake.offscreenOpen()).toBe(true); // Stop skipped the teardown
        if (newerSession) {
          fake.setPrefs({});
          expect((await start(12)).ok).toBe(true);
        }
        const before = fake.offscreenLog.length;
        reply.open(); // the recorder starts, after Stop
        await drain();

        // The late start's own cleanup, not Stop, stopped it and closed the document.
        const after = fake.offscreenLog.slice(before);
        expect(after).toContain(stopKind);
        expect(after.indexOf('close')).toBeGreaterThan(after.indexOf(stopKind));
        expect(fake.recorders()[recorder]).toBe(false);
        expect(fake.offscreenOpen()).toBe(false);
        const st = await getState();
        expect(st[flag]).toBe(false);
        expect(st.recording).toBe(newerSession);
        // The ended start reports nothing into the newer session either.
        expect(h.state.events.filter((e) => /could not start/.test(e.payload?.text ?? ''))).toEqual([]);
        if (newerSession) await stop();
      },
    );
  });
  it.each([
    ['reading the microphone grant', 'micGranted', 0],
    ['loading the transcription config', 'transcription', 1],
  ] as const)('Stop while %s: the microphone never starts and nothing is left open', async (_what, key, docs) => {
    await boot();
    const { STORAGE_KEYS } = await import('@/lib/session/settings');
    fake.setPrefs({ [STORAGE_KEYS.micFromStart]: true, [STORAGE_KEYS.micGranted]: true });
    const gate = fake.holdStorageKey(STORAGE_KEYS[key]);
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.count(`storage.get ${STORAGE_KEYS[key]}`) === 1, key);

    expect((await stop()).ok).toBe(true);
    gate.open();
    await drain();

    expect(fake.offscreenMsgs.filter((k) => k === 'audio/start')).toHaveLength(0);
    expect(fake.offscreenCreated()).toBe(docs); // the config is read after the document exists
    expect(fake.offscreenOpen()).toBe(false);
    expect((await getState()).micOn).toBe(false);
  });
});

describe('background lifecycle: Stop, pause and resume', () => {
  it('concurrent Stop calls share one teardown', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    h.state.stoppedWriteGate = h.gate();
    const first = stop();
    await until(() => stoppedWrites() === 1, 'the stopped write');
    const second = stop();
    await drain();
    // The second caller doesn't get an answer before the first Stop has
    // written the session and published the stopped state.
    expect(await raceSettle(second)).toBe('blocked');
    expect((await getState()).session.status).toBe('stopped');
    expect((await getState()).recording).toBe(false);
    h.state.stoppedWriteGate.open();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ ok: true });
    expect(b).toBe(a); // the same answer, from the same teardown
    await drain();
    expect(stoppedWrites()).toBe(1);
    expect(fake.count('alarms.clear')).toBe(1);
    expect(fake.count('tabs.create')).toBeLessThanOrEqual(1);
  });

  it.each([false, true])('Resume while Stop is finishing is refused and cannot revive the session (paused before Stop: %s)', async (pausedFirst) => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    if (pausedFirst) expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    h.state.stoppedWriteGate = h.gate();
    const stopped = stop();
    await until(() => stoppedWrites() === 1, 'the stopped write');

    expect(await call({ kind: 'session/resume' })).toEqual({ ok: false });
    h.state.stoppedWriteGate.open();
    await stopped;
    await drain();

    const [stored] = [...h.state.sessions.values()];
    expect(stored.status).toBe('stopped');
    expect((await getState()).session.status).toBe('stopped');
  });

  it('Pause while Stop is running is refused and keeps the session ending', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    h.state.stoppedWriteGate = h.gate();
    const stopped = stop();
    await until(() => stoppedWrites() === 1, 'the stopped write');
    const before = h.state.tabMessages.length;
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: false });
    expect((await getState()).session.status).toBe('stopped');
    // Refused outright: it doesn't touch the tabs (annotation off) or pause flags.
    expect(h.state.tabMessages.slice(before).filter((m) => m.msg.kind === 'content/point-annotate')).toEqual([]);
    expect((await getState()).paused).toBe(false);
    h.state.stoppedWriteGate.open();
    await stopped;
  });

  it('Stop while Pause is turning annotation off: the session ends, not paused', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    const paused = call({ kind: 'session/pause' }); // awaits setPointing(false)
    const stopped = stop(); // marks the session stopping meanwhile
    expect(await paused).toEqual({ ok: false });
    expect(await stopped).toEqual({ ok: true });
    expect((await getState()).session.status).toBe('stopped');
    expect([...h.state.sessions.values()][0].status).toBe('stopped');
  });

  it('Pause early in Stop is refused and does not reopen the session', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    fake.setHoldAttach(false);
    const stopped = stop(); // first await: the offscreen check
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: false });
    expect((await getState()).session.status).not.toBe('paused');
    await stopped;
    expect((await getState()).session.status).toBe('stopped');
  });
});

describe('background lifecycle: rehydrate', () => {
  const live = () => ({
    id: 'ses_live',
    name: 'live',
    startedAt: Date.now() - 1000,
    initialUrl: 'https://app.test/21',
    tabs: [
      { tabId: 21, url: 'https://app.test/21', title: '', role: 'primary', attached: true, attachedAt: 0 },
      { tabId: 22, url: 'https://app.test/22', title: '', role: 'adopted', attached: true, attachedAt: 0 },
    ],
    settings: { ...{} },
    status: 'recording',
    counts: {},
    assetBytes: 0,
  });

  beforeEach(async () => {
    const { makeDefaultSettings } = await import('@/lib/session/settings');
    h.state.liveSessions = [{ ...live(), settings: makeDefaultSettings() }];
  });

  it('Stop during the re-attach loop: no later attach, listeners or heartbeat', async () => {
    const tab22 = fake.holdTabsGet(22);
    await boot();
    await until(() => fake.count('tabs.get 22') === 1, 'rehydrate to reach the second tab');
    expect(fake.attachLog).toEqual([21]);

    expect((await stop()).ok).toBe(true);
    tab22.open();
    await drain();

    expect(fake.attachLog).toEqual([21]);
    expect(fake.attached.size).toBe(0);
    expect(fake.count('alarms.create')).toBe(0);
    expect(activations(22)).toBe(0);
    expect(h.state.events.filter((e) => e.payload?.kind === 'rehydrate')).toEqual([]);
    expect(h.state.sessions.get('ses_live').status).toBe('stopped');
  });

  it("Stop while rehydrate's last re-attach is in flight: no listeners, heartbeat or note afterwards", async () => {
    fake.setHoldAttach(true);
    await boot();
    await until(() => fake.heldAttachCount() === 1, 'the first re-attach');
    fake.answerAttach(); // tab 21
    await until(() => fake.attachLog.includes(22) && fake.heldAttachCount() === 1, 'the second re-attach');

    const stopped = stop();
    await tick();
    fake.answerAttach(); // tab 22: granted, then released by Stop
    expect(await stopped).toEqual({ ok: true });
    await drain();

    expect(fake.attached.size).toBe(0);
    expect(fake.count('alarms.create')).toBe(0);
    expect(h.state.events.filter((e) => e.payload?.kind === 'rehydrate')).toEqual([]);
    expect(h.state.sessions.get('ses_live').status).toBe('stopped');
  });

  it('rehydrate does not replace a session started while it was reading storage', async () => {
    h.state.listGate = h.gate();
    await boot();
    expect((await start(11)).ok).toBe(true);
    h.state.listGate.open();
    await drain();
    const st = await getState();
    expect(st.session.tabs[0].tabId).toBe(11);
    expect(fake.attachLog).toEqual([11]); // the old session's tabs were not re-attached
    await stop();
  });

  it('a Start that finishes reading the tab after rehydrate recovered a session is refused', async () => {
    h.state.listGate = h.gate();
    await boot();
    const tabGate = fake.holdTabsGet(11);
    const started = start(11);
    await until(() => fake.count('tabs.get 11') === 1, 'start to read the tab');
    h.state.listGate.open();
    await until(() => fake.attachLog.includes(22), 'rehydrate to re-attach');
    tabGate.open();
    const res = await started;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already recording/);
    expect((await getState()).session.id).toBe('ses_live');
    expect(fake.attachLog).not.toContain(11);
    await stop();
  });

  it("a mic start abandoned during Stop doesn't close the document under Stop's video flush", async () => {
    // The offscreen document outlived the service worker and is still
    // recording video, while rehydrate() starts with both recorder flags off.
    fake.openSurvivingDocument({ video: true });
    await boot();
    await until(() => fake.attachLog.includes(22), 'rehydrate to re-attach');
    const { STORAGE_KEYS: K } = await import('@/lib/session/settings');
    fake.setPrefs({ [K.micGranted]: true });
    const micReply = fake.holdOffscreen('audio/start');
    const toggled = call({ kind: 'mic/toggle', on: true });
    await until(() => fake.offscreenMsgs.includes('audio/start'), 'the mic start');

    const videoFlush = fake.holdOffscreen('video/stop'); // Stop's video handshake
    const stopped = stop();
    await until(() => fake.offscreenMsgs.includes('video/stop'), "Stop's video flush");
    micReply.open(); // the mic start answers while Stop is flushing the video
    await drain();
    videoFlush.open();
    expect(await stopped).toEqual({ ok: true });
    await toggled;
    await drain();

    const log = fake.offscreenLog;
    // The video's stop handshake completed before anything closed the document.
    expect(log).toContain('video/stop:done');
    expect(log.indexOf('video/stop:done')).toBeLessThan(log.indexOf('close'));
    expect(fake.recorders()).toMatchObject({ audio: false, video: false });
    expect(fake.offscreenOpen()).toBe(false);
  });
});

describe('background lifecycle: an ended session never touches a newer one', () => {
  const keys = async () => (await import('@/lib/session/settings')).STORAGE_KEYS;

  it("an older session's late mic cleanup cannot close the newer session's document", async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.micFromStart]: true, [K.micGranted]: true });
    const config = fake.holdStorageKey(K.transcription);
    expect((await start(11)).ok).toBe(true); // A's mic start waits on its config
    await until(() => fake.count(`storage.get ${K.transcription}`) === 1, "A's config read");
    expect((await stop()).ok).toBe(true); // A ends; its document is closed

    // A's start resumes into its cleanup, which looks the document up...
    const lookup = fake.holdNextGetContexts();
    config.open();
    await drain();
    // ...while B starts and turns its own mic on.
    expect((await start(12)).ok).toBe(true);
    await drain();
    lookup.open();
    await drain();

    const st = await getState();
    expect(st.recording).toBe(true);
    expect(st.micOn).toBe(true);
    expect(fake.recorders().audio).toBe(true); // B's recorder is still running
    expect(fake.offscreenOpen()).toBe(true);
    const log = fake.offscreenLog;
    expect(log.lastIndexOf('close')).toBeLessThan(log.lastIndexOf('audio/start'));
    await stop();
  });

  it('Stop waits for a mic toggle-off already flushing, and the next session’s mic is unaffected', async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.micFromStart]: true, [K.micGranted]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders().audio, "A's mic");
    const flush = fake.holdOffscreen('audio/stop'); // the toggle's handshake
    const toggled = call({ kind: 'mic/toggle', on: false });
    await until(() => fake.offscreenMsgs.filter((k) => k === 'audio/stop').length === 1, 'the toggle');

    const stopped = stop();
    await drain();
    // Stop neither stops the recorder a second time nor closes the document
    // while the toggle is still delivering its final segment.
    expect(await raceSettle(stopped)).toBe('blocked');
    expect(fake.offscreenMsgs.filter((k) => k === 'audio/stop')).toHaveLength(1);
    expect(fake.offscreenLog).not.toContain('close');
    flush.open();
    expect(await stopped).toEqual({ ok: true });
    await toggled;
    const log = fake.offscreenLog;
    expect(log.indexOf('audio/stop:done')).toBeLessThan(log.indexOf('close'));
    expect(fake.offscreenMsgs.filter((k) => k === 'audio/stop')).toHaveLength(1);

    expect((await start(12)).ok).toBe(true); // B: mic from the start
    await drain();
    const st = await getState();
    expect(st.micOn).toBe(true);
    expect(fake.recorders().audio).toBe(true);
    expect(fake.offscreenOpen()).toBe(true);
    await stop();
  });

  it.each([
    ['mic', 'micFromStart', 'audio/stop', 'mic/toggle', 'audio'],
    ['video', 'videoFromStart', 'video/stop', 'video/toggle', 'video'],
  ] as const)('a %s toggle-off during Stop leaves the teardown to Stop', async (_what, pref, stopKind, toggleKind, recorder) => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K[pref]]: true, [K.micGranted]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders()[recorder], 'the recorder');
    const flush = fake.holdOffscreen(stopKind); // Stop's own handshake
    const stopped = stop();
    await until(() => fake.offscreenMsgs.includes(stopKind), "Stop's flush");
    const toggled = call({ kind: toggleKind, on: false }); // the panel still shows it on
    await drain();
    expect(fake.offscreenMsgs.filter((k) => k === stopKind)).toHaveLength(1);
    flush.open();
    expect(await stopped).toEqual({ ok: true });
    await toggled;
    await drain();
    const log = fake.offscreenLog;
    expect(fake.offscreenMsgs.filter((k) => k === stopKind)).toHaveLength(1);
    expect(log.indexOf(`${stopKind}:done`)).toBeLessThan(log.indexOf('close'));
  });

  it("a video resume still minting its stream when Stop runs never resumes into the next session", async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.videoFromStart]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders().video, "A's video");
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    const stream = fake.holdStreamId();
    const resumed = call({ kind: 'session/resume' });
    await until(() => fake.count('tabCapture.getMediaStreamId') === 2, 'the resume');
    expect((await stop()).ok).toBe(true);
    fake.setPrefs({});
    expect((await start(12)).ok).toBe(true);
    stream.open();
    await resumed;
    await drain();

    expect(fake.offscreenMsgs).not.toContain('video/resume');
    expect(h.state.events.filter((e) => /could not resume/.test(e.payload?.text ?? ''))).toEqual([]);
    expect((await getState()).recording).toBe(true);
    await stop();
  });

  it("a start screenshot still being taken at Stop is not stored or recorded in the next session", async () => {
    await boot();
    // Chrome has returned A's start screenshot; it is still being processed.
    const processing = h.gate();
    h.state.hashGate = processing;
    const started = start(11);
    await until(() => fake.count('send 11 Page.captureScreenshot') === 1, 'the start screenshot');
    await drain();
    expect(h.state.hashGate).toBeNull(); // A's screenshot is held mid-processing
    expect((await stop()).ok).toBe(true);
    expect((await start(12)).ok).toBe(true); // B takes its own start screenshot
    processing.open(); // A's screenshot finishes now
    await started;
    await drain();

    const shots = h.state.events.filter((e) => e.type === 'screenshot');
    expect(shots.map((e) => e.tabId)).toEqual([12]);
    expect(h.state.assets.filter((a) => a.kind === 'screenshot')).toHaveLength(1);
    await stop();
  });

  it('a screenshot for annotation falls back to the tabs API when the debugger capture fails', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    // Chrome has just ended the session; the detach isn't confirmed yet.
    fake.attached.delete(11);
    const res = await call({ kind: 'annotation/toggle' });
    expect(res).toEqual({ ok: true, annotating: true });
    const annotate = h.state.tabMessages.filter((m) => m.tabId === 11 && m.msg.kind === 'content/annotate');
    expect(annotate.at(-1)?.msg.image).toBe('data:image/jpeg;base64,VISIBLE');
    await stop();
  });

  it("a late adoption from a stopped session cannot detach the next session's tab", async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    fake.setHoldAttach(true);
    fake.emitTabCreated({ id: 31, openerTabId: 11, pendingUrl: 'https://app.test/31' });
    await until(() => fake.heldAttachCount() === 1, "A's adoption attach");

    const stopped = stop();
    await tick();
    fake.answerAttach(); // Stop's detachAll waited for it, then released it
    expect(await stopped).toEqual({ ok: true });
    fake.setHoldAttach(false);
    expect((await start(31)).ok).toBe(true); // B records the adopted tab
    await drain(); // A's adoption resumes and cleans up

    expect(fake.attached.has(31)).toBe(true);
    const st = await getState();
    expect(st.attachedTabIds).toEqual([31]);
    expect(st.session.tabs.map((t: any) => t.tabId)).toEqual([31]);
    await stop();
  });

  it("Stop releases a pending Start's reservation, and a cancelled Start never releases a newer one", async () => {
    await boot();
    const aGate = fake.holdTabsGet(11);
    const a = start(11);
    await until(() => fake.count('tabs.get 11') === 1, "A's tab read");
    expect(await stop()).toEqual({ ok: true }); // cancels A

    const cGate = fake.holdTabsGet(12);
    const c = start(12); // not refused: A's reservation is gone
    await until(() => fake.count('tabs.get 12') === 1, "C's tab read");
    aGate.open();
    const aRes = await a;
    expect(aRes.ok).toBe(false);
    expect(aRes.error).toMatch(/stopped before it started/);
    // A's cleanup didn't release C's reservation.
    const d = await start(13);
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/already starting/);

    cGate.open();
    expect((await c).ok).toBe(true);
    expect(h.state.writes.filter((w) => w.op === 'create')).toHaveLength(1);
    expect((await getState()).session.tabs[0].tabId).toBe(12);
    await stop();
  });

  it('a start screenshot still being processed when Stop finishes is neither stored nor recorded', async () => {
    await boot();
    const processing = h.gate();
    h.state.hashGate = processing;
    const started = start(11);
    await until(() => fake.count('send 11 Page.captureScreenshot') === 1, 'the start screenshot');
    await drain();
    expect(h.state.hashGate).toBeNull(); // held mid-processing
    expect((await stop()).ok).toBe(true); // no later session resets the scheduler
    processing.open();
    await started;
    await drain();

    expect(h.state.assets).toEqual([]);
    expect(h.state.events.filter((e) => e.type === 'screenshot')).toEqual([]);
  });

  it("a video start abandoned during Stop doesn't close the document under Stop's mic flush", async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.micFromStart]: true, [K.micGranted]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders().audio, "A's mic");
    const videoReply = fake.holdOffscreen('video/start');
    const toggled = call({ kind: 'video/toggle', on: true });
    await until(() => fake.offscreenMsgs.includes('video/start'), 'the video start');

    const micFlush = fake.holdOffscreen('audio/stop'); // Stop's mic handshake
    const stopped = stop();
    await until(() => fake.offscreenMsgs.includes('audio/stop'), "Stop's mic flush");
    videoReply.open(); // the video recorder starts while Stop is flushing the mic
    await drain();
    micFlush.open();
    expect(await stopped).toEqual({ ok: true });
    await toggled;
    await drain();

    const log = fake.offscreenLog;
    // The mic's stop handshake completed before anything closed the document.
    expect(log).toContain('audio/stop:done');
    expect(log.indexOf('audio/stop:done')).toBeLessThan(log.indexOf('close'));
    expect(fake.recorders()).toMatchObject({ audio: false, video: false });
    expect(fake.offscreenOpen()).toBe(false);
  });

  it('a video resume that fails after Stop reports nothing into the next session', async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.videoFromStart]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders().video, "A's video");
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    const stream = fake.holdStreamId();
    fake.setStreamIdFails(true);
    const resumed = call({ kind: 'session/resume' });
    await until(() => fake.count('tabCapture.getMediaStreamId') === 2, 'the resume');
    expect((await stop()).ok).toBe(true);
    fake.setPrefs({});
    expect((await start(12)).ok).toBe(true);
    stream.open(); // A's stream id fails now
    await resumed;
    await drain();

    expect(h.state.events.filter((e) => /could not resume/.test(e.payload?.text ?? ''))).toEqual([]);
    expect((await getState()).recording).toBe(true);
    await stop();
  });

  it("an older session's queued video start mints no stream for the next session's tab", async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.micFromStart]: true, [K.micGranted]: true });
    const config = fake.holdStorageKey(K.transcription);
    expect((await start(11)).ok).toBe(true); // A's mic start holds the offscreen turn
    await until(() => fake.count(`storage.get ${K.transcription}`) === 1, "A's config read");
    const toggled = call({ kind: 'video/toggle', on: true }); // queued behind it
    expect((await stop()).ok).toBe(true);
    fake.setPrefs({});
    expect((await start(12)).ok).toBe(true);
    config.open();
    const res = await toggled;
    await drain();

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Recording ended before video capture started/);
    expect(fake.count('tabCapture.getMediaStreamId')).toBe(0);
    expect(fake.offscreenMsgs).not.toContain('video/start');
    await stop();
  });
});

describe('background lifecycle: Pause, Resume and late work from an ended session', () => {
  const keys = async () => (await import('@/lib/session/settings')).STORAGE_KEYS;

  it.each([
    ['video', 'videoFromStart', 'video/start', 'videoPaused'],
    ['microphone', 'micFromStart', 'audio/start', 'audioPaused'],
  ] as const)('a %s start that completes after Pause leaves its recorder paused', async (_what, pref, startKind, pausedKey) => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K[pref]]: true, [K.micGranted]: true });
    const reply = fake.holdOffscreen(startKind);
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.offscreenMsgs.includes(startKind), 'the recorder start');
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true }); // nothing to pause yet
    reply.open();
    await drain();
    expect(fake.recorders()[pausedKey]).toBe(true);
    expect((await getState()).paused).toBe(true);
    expect(await call({ kind: 'session/resume' })).toEqual({ ok: true });
    await drain();
    expect(fake.recorders()[pausedKey]).toBe(false);
    await stop();
  });

  it('a second Resume while the first is still resuming video is refused, and video stays on', async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.videoFromStart]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders().video, 'the video');
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    const stream = fake.holdStreamId();
    const first = call({ kind: 'session/resume' });
    await until(() => fake.count('tabCapture.getMediaStreamId') === 2, 'the resume');
    expect(await call({ kind: 'session/resume' })).toEqual({ ok: false });
    stream.open();
    expect(await first).toEqual({ ok: true });
    await drain();
    const st = await getState();
    expect(st.videoOn).toBe(true);
    expect(fake.recorders()).toMatchObject({ video: true, videoPaused: false });
    expect(h.state.events.filter((e) => /could not resume/.test(e.payload?.text ?? ''))).toEqual([]);
    await stop();
  });

  it('a Pause while Resume is still minting its stream keeps the video paused', async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.videoFromStart]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders().video, 'the video');
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    const stream = fake.holdStreamId();
    const resumed = call({ kind: 'session/resume' });
    await until(() => fake.count('tabCapture.getMediaStreamId') === 2, 'the resume');
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    stream.open();
    await resumed;
    await drain();
    expect(fake.offscreenMsgs).not.toContain('video/resume');
    expect(fake.recorders()).toMatchObject({ video: true, videoPaused: true });
    expect((await getState()).paused).toBe(true);
    await stop();
  });

  it("a Pause that Stop refuses doesn't drop Stop's flush of requests still in flight", async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    fake.emitCdp(11, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { method: 'GET', url: 'https://app.test/api/slow', headers: {} },
      timestamp: 1,
      wallTime: Date.now() / 1000,
      type: 'XHR',
    });
    const paused = call({ kind: 'session/pause' });
    const stopped = stop();
    expect(await paused).toEqual({ ok: false });
    expect(await stopped).toEqual({ ok: true });
    const pending = h.state.events.filter((e) => e.type === 'net-request' && e.payload?.pending === true);
    expect(pending.map((e) => e.payload.url)).toEqual(['https://app.test/api/slow']);
  });

  it("a dictation mic request still preparing when Stop runs cannot turn on the next session's mic", async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.micGranted]: true, [K.transcription]: { provider: 'deepgram', apiKey: 'k' } });
    expect((await start(11)).ok).toBe(true);
    expect((await call({ kind: 'point-annotation/toggle', on: true })).ok).toBe(true);
    h.state.vocabGate = h.gate();
    expect((await callFrom(11, { kind: 'dictation/focus', id: 'c1', context: 'page words' })).ok).toBe(true);
    const micReq = callFrom(11, { kind: 'dictation/mic', on: true }); // waits for the vocabulary
    await drain();
    expect((await stop()).ok).toBe(true);
    expect((await start(12)).ok).toBe(true);
    h.state.vocabGate.open();
    const res = await micReq;
    await drain();
    expect(res.ok).toBe(false);
    expect((await getState()).micOn).toBe(false);
    expect(fake.offscreenMsgs).not.toContain('audio/start');
    await stop();
  });

  it('Stop closes an open annotation editor, and its cancel during Stop does not reactivate the tab', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    expect(await call({ kind: 'annotation/toggle' })).toEqual({ ok: true, annotating: true });
    h.state.stoppedWriteGate = h.gate();
    const before = h.state.tabMessages.length;
    const stopped = stop();
    await until(() => stoppedWrites() === 1, 'the stopped write');
    const sent = h.state.tabMessages.slice(before);
    expect(sent.some((m) => m.tabId === 11 && m.msg.kind === 'content/annotate' && m.msg.on === false)).toBe(true);
    // The editor's cancel (or a Done) arrives while Stop is finishing.
    const mark = h.state.tabMessages.length;
    const exit = await callFrom(11, { kind: 'annotation/exit', shapes: [], viewport: { w: 1, h: 1 }, image: 'data:image/jpeg;base64,AAAA' });
    expect(exit).toEqual({ ok: false });
    h.state.stoppedWriteGate.open();
    await stopped;
    await drain();
    const reactivations = h.state.tabMessages.slice(mark).filter((m) => m.msg.kind === 'content/setActive' && m.msg.active === true);
    expect(reactivations).toEqual([]);
    expect(h.state.events.filter((e) => e.type === 'annotation')).toEqual([]);
  });

  it.each([false, true])(
    'a file still decoding when Stop runs is neither stored nor recorded (next session started: %s)',
    async (newerSession) => {
      await boot();
      expect((await start(11)).ok).toBe(true);
      await drain();
      const decode = h.gate();
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: any) => {
        await decode.promise;
        return realFetch(input);
      }) as typeof fetch;
      try {
        const dataUrl = 'data:text/plain;base64,aGk=';
        const attached = call({ kind: 'file/attach', fileName: 'a.txt', mime: 'text/plain', dataUrl });
        const captured = callFrom(11, {
          kind: 'capture/fileBlob',
          event: { type: 'file-captured', payload: { fileName: 'b.txt', mime: 'text/plain', size: 2 } },
          dataUrl,
        });
        await tick();
        expect((await stop()).ok).toBe(true);
        if (newerSession) expect((await start(12)).ok).toBe(true);
        decode.open();
        await expect(attached).resolves.toMatchObject({ ok: false });
        await expect(captured).resolves.toMatchObject({ ok: false });
      } finally {
        globalThis.fetch = realFetch;
      }
      await drain();
      expect(h.state.events.filter((e) => e.type === 'file-attached' || e.type === 'file-captured')).toEqual([]);
      expect(h.state.assets.filter((a) => a.kind === 'file')).toEqual([]);
      if (newerSession) await stop();
    },
  );

  it("a late transcript for a stopped session is not broadcast into the next session's live timeline", async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.transcription]: { provider: 'deepgram', apiKey: 'k' } });
    const a = await start(11);
    expect((await stop()).ok).toBe(true);
    expect((await start(12)).ok).toBe(true);
    h.state.storedEvents.push({
      id: 'evt_v1',
      sessionId: a.session.id,
      t: 0,
      type: 'voice-segment',
      importance: 1,
      payload: { assetId: 'ast_1', tStart: 0, tEnd: 1000, transcript: null },
    });
    const before = h.state.broadcasts.length;
    expect(await call({ kind: 'transcription/retry', sessionId: a.session.id, eventId: 'evt_v1' })).toEqual({ ok: true });
    await until(() => h.state.transcribed === 1, 'the transcription');
    await drain();
    const ticks = h.state.broadcasts.slice(before).filter((b) => b.kind === 'event/tick');
    expect(ticks.filter((b) => b.event.sessionId === a.session.id)).toEqual([]);
    await stop();
  });

  it("a late adoption cleanup that runs after the next session attached the tab cannot detach it", async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    fake.holdNext('Network.enable'); // A's adoption: attach granted, domain setup hangs
    fake.emitTabCreated({ id: 31, openerTabId: 11, pendingUrl: 'https://app.test/31' });
    await until(() => fake.count('send 31 Network.enable') === 1, "A's adoption setup");
    expect((await stop()).ok).toBe(true); // releases 31 without waiting for the enable
    expect((await start(31)).ok).toBe(true); // B records the adopted tab
    await drain();
    expect(fake.attached.has(31)).toBe(true);
    fake.releaseSend('Detached while handling command.'); // A's adoption resumes only now
    await drain();
    expect(fake.attached.has(31)).toBe(true);
    expect((await getState()).attachedTabIds).toEqual([31]);
    await stop();
  });

  it('a Resume queued behind another offscreen turn and paused again before its turn mints nothing', async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.videoFromStart]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders().video, 'the video');
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    // A mic start holds the offscreen turn queue (its config read waits).
    fake.setPrefs({ [K.videoFromStart]: true, [K.micGranted]: true });
    const config = fake.holdStorageKey(K.transcription);
    const mic = call({ kind: 'mic/toggle', on: true });
    await until(() => fake.count(`storage.get ${K.transcription}`) === 1, 'the mic turn');
    const resumed = call({ kind: 'session/resume' }); // its video turn queues behind
    await drain();
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    const mints = fake.count('tabCapture.getMediaStreamId');
    config.open();
    await mic;
    await resumed;
    await drain();
    expect(fake.count('tabCapture.getMediaStreamId')).toBe(mints);
    expect(fake.offscreenMsgs).not.toContain('video/resume');
    expect(fake.recorders()).toMatchObject({ video: true, videoPaused: true });
    await stop();
  });

  it('a Pause while the video resume reply is in flight leaves the video paused', async () => {
    await boot();
    const K = await keys();
    fake.setPrefs({ [K.videoFromStart]: true });
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.recorders().video, 'the video');
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    const reply = fake.holdOffscreen('video/resume');
    const resumed = call({ kind: 'session/resume' });
    await until(() => fake.offscreenMsgs.includes('video/resume'), 'the resume');
    expect(await call({ kind: 'session/pause' })).toEqual({ ok: true });
    reply.open(); // the recorder resumes after the Pause
    await resumed;
    await drain();
    expect(fake.recorders()).toMatchObject({ video: true, videoPaused: true });
    expect((await getState()).paused).toBe(true);
    await stop();
  });

  it('a Resume while Pause is still turning annotation off wins, and the session is not left marked paused', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    const paused = call({ kind: 'session/pause' }); // awaits setPointing(false)
    const resumed = call({ kind: 'session/resume' });
    expect(await paused).toEqual({ ok: false });
    expect(await resumed).toEqual({ ok: true });
    const st = await getState();
    expect(st.paused).toBe(false);
    expect(st.session.status).toBe('recording');
    expect(st.recording).toBe(true);
    await stop();
  });

  it('an annotation image still decoding when Stop runs is neither stored nor recorded', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    expect(await call({ kind: 'annotation/toggle' })).toEqual({ ok: true, annotating: true });
    const assetsBefore = h.state.assets.length; // the start screenshot
    const decode = h.gate();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      await decode.promise;
      return realFetch(input);
    }) as typeof fetch;
    try {
      const exit = callFrom(11, { kind: 'annotation/exit', shapes: [], viewport: { w: 1, h: 1 }, image: 'data:image/jpeg;base64,AAAA' });
      await tick();
      expect((await stop()).ok).toBe(true);
      decode.open();
      expect(await exit).toEqual({ ok: false });
    } finally {
      globalThis.fetch = realFetch;
    }
    await drain();
    expect(h.state.assets.slice(assetsBefore)).toEqual([]);
    expect(h.state.events.filter((e) => e.type === 'annotation')).toEqual([]);
  });

  it('Markup clicked just before Stop never opens an editor once the session is ending', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    fake.holdNext('Page.captureScreenshot'); // the frozen-view capture is in flight
    const toggled = call({ kind: 'annotation/toggle' });
    await until(() => fake.count('send 11 Page.captureScreenshot') === 2, 'the freeze capture');
    const mark = h.state.tabMessages.length;
    const stopped = stop();
    await tick();
    fake.releaseSend(); // the capture answers after Stop began
    await stopped;
    expect((await toggled).annotating).toBe(false);
    await drain();
    const opened = h.state.tabMessages.slice(mark).filter((m) => m.msg.kind === 'content/annotate' && m.msg.on === true);
    expect(opened).toEqual([]);
    // No editor, so a later session gets nothing from it.
    expect((await start(12)).ok).toBe(true);
    expect((await getState()).annotating).toBe(false);
    await stop();
  });

  it('Stop closes an editor left open after annotation was toggled off', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    expect(await call({ kind: 'annotation/toggle' })).toEqual({ ok: true, annotating: true });
    // Toggled off elsewhere: the flag is off, but this tab's editor may still be open.
    expect(await call({ kind: 'annotation/toggle' })).toEqual({ ok: true, annotating: false });
    const mark = h.state.tabMessages.length;
    expect((await stop()).ok).toBe(true);
    const closed = h.state.tabMessages.slice(mark).filter((m) => m.tabId === 11 && m.msg.kind === 'content/annotate' && m.msg.on === false);
    expect(closed.length).toBeGreaterThan(0);
  });

  it("two Pauses that Stop refuses don't leave Stop's flush of requests in flight filtered", async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
    await drain();
    fake.emitCdp(11, 'Network.requestWillBeSent', {
      requestId: 'r2',
      request: { method: 'GET', url: 'https://app.test/api/slow2', headers: {} },
      timestamp: 1,
      wallTime: Date.now() / 1000,
      type: 'XHR',
    });
    const first = call({ kind: 'session/pause' });
    const second = call({ kind: 'session/pause' }); // a double click
    const stopped = stop();
    expect(await first).toEqual({ ok: false });
    expect(await second).toEqual({ ok: false });
    expect(await stopped).toEqual({ ok: true });
    const pending = h.state.events.filter((e) => e.type === 'net-request' && e.payload?.pending === true);
    expect(pending.map((e) => e.payload.url)).toEqual(['https://app.test/api/slow2']);
  });
});
