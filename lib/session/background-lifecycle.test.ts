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
    getEvents: async () => [],
    getAssetsMeta: async () => [],
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
    broadcast: () => {},
    sendToTab: async (tabId: number, msg: any) => {
      h.state.tabMessages.push({ tabId, msg });
      return undefined;
    },
  };
});

vi.mock('@/lib/sharing/session-title', () => ({ nameRecordedSession: async () => null }));

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
  const tabsGetGates = new Map<number, Gate>();
  const offscreenMsgs: string[] = [];
  let offscreenOpen = false;
  let offscreenCreated = 0;
  let executeScriptGate: Gate | null = null;
  let streamIdGate: Gate | null = null;
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
      getContexts: async () => (offscreenOpen ? [{}] : []),
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      sendMessage: async (msg: any) => {
        if (msg?.__sr_offscreen__) {
          offscreenMsgs.push(msg.kind);
          const g = offscreenStartGates.get(msg.kind);
          if (g) await g.promise;
          return { ok: true };
        }
        return undefined;
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
      onCreated: autoApi('tabs.onCreated', calls),
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
        offscreenOpen = true;
      },
      closeDocument: async () => {
        offscreenOpen = false;
      },
    },
    tabCapture: {
      getMediaStreamId: (_o: unknown, cb: (id: string) => void) => {
        calls.push('tabCapture.getMediaStreamId');
        const go = () => callBack(cb as any, undefined, 'stream-1');
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
        const answer = (err?: string) =>
          callBack(cb, err ?? (attached.has(tabId) ? undefined : `Debugger is not attached to the tab with id: ${tabId}.`));
        if (holdMethods.has(method)) heldSends.push({ method, answer });
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
    count: (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length,
    offscreenCreated: () => offscreenCreated,
    offscreenOpen: () => offscreenOpen,
    /** Hold the offscreen document's answer to 'video/start' or 'audio/start'. */
    holdOffscreen(kind: string) {
      const g = h.gate();
      offscreenStartGates.set(kind, g);
      return g;
    },
    holdCreateDocument() {
      createDocumentGate = h.gate();
      return createDocumentGate;
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
/** Let every queued continuation run to completion. */
async function drain() {
  for (let i = 0; i < 20; i++) await tick();
}

const start = (tabId: number) => call({ kind: 'session/start', tabId, settings: { screenshotPolicy: 'on-demand' } });
const stop = () => call({ kind: 'session/stop' });
const getState = () => call({ kind: 'session/getState' });

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

  it('Stop while Start is attaching: released, no degraded note, nothing activated', async () => {
    await boot();
    fake.setHoldAttach(true);
    fake.holdMethods.add('Network.enable');
    const started = start(11);
    await until(() => fake.heldAttachCount() === 1, 'the debugger attach');

    const stopped = stop();
    await tick();
    fake.answerAttach(); // Stop's detachAll waited for this, then released the tab
    await until(() => fake.count('send 11 Network.enable') === 1, 'domain setup to start');
    expect(await stopped).toEqual({ ok: true });
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

  it('Stop while the recorder is starting: the late start is undone and video is not reported on', async () => {
    await boot();
    fake.setPrefs({ [(await import('@/lib/session/settings')).STORAGE_KEYS.videoFromStart]: true });
    const startGate = fake.holdOffscreen('video/start');
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.offscreenMsgs.includes('video/start'), 'the recorder start');

    expect((await stop()).ok).toBe(true);
    startGate.open(); // the recorder reports it started, after Stop
    await drain();

    expect((await getState()).videoOn).toBe(false);
    expect(fake.offscreenOpen()).toBe(false);
    expect(fake.offscreenMsgs.lastIndexOf('video/stop')).toBeGreaterThan(fake.offscreenMsgs.indexOf('video/start'));
  });

  it('Stop while the microphone is starting: the late start is undone and the mic is not reported on', async () => {
    await boot();
    const { STORAGE_KEYS } = await import('@/lib/session/settings');
    fake.setPrefs({ [STORAGE_KEYS.micFromStart]: true, [STORAGE_KEYS.micGranted]: true });
    const startGate = fake.holdOffscreen('audio/start');
    expect((await start(11)).ok).toBe(true);
    await until(() => fake.offscreenMsgs.includes('audio/start'), 'the microphone start');

    expect((await stop()).ok).toBe(true);
    startGate.open(); // the recorder reports it started, after Stop
    await drain();

    expect((await getState()).micOn).toBe(false);
    expect(fake.offscreenOpen()).toBe(false);
    expect(fake.offscreenMsgs.lastIndexOf('audio/stop')).toBeGreaterThan(fake.offscreenMsgs.indexOf('audio/start'));
    expect(h.state.events.filter((e) => /Microphone could not start/.test(e.payload?.text ?? ''))).toEqual([]);
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
    h.state.stoppedWriteGate.open();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    await drain();
    expect(stoppedWrites()).toBe(1);
    expect(fake.count('alarms.clear')).toBe(1);
  });

  it('Resume while Stop is finishing is refused and cannot revive the session', async () => {
    await boot();
    expect((await start(11)).ok).toBe(true);
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
});
