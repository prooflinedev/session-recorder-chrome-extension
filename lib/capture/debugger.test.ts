/**
 * DebuggerManager's child sessions: cross-site iframes and workers that Chrome
 * auto-attaches once the tab has `Target.setAutoAttach`. A new child is paused
 * until we resume it, so every path, including failures, must resume it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebuggerManager, type ChildTarget } from './debugger';

type Debuggee = { tabId?: number; sessionId?: string };
type EventListener = (source: Debuggee, method: string, params?: object) => void;

interface Sent {
  target: Debuggee;
  method: string;
  params?: object;
}

function installChrome(fail: (sent: Sent) => string | undefined = () => undefined) {
  const sent: Sent[] = [];
  const listeners: EventListener[] = [];
  const runtime: { lastError?: { message: string } } = {};
  const reply = (error: string | undefined, cb: (result?: object) => void) => {
    runtime.lastError = error ? { message: error } : undefined;
    cb({});
    runtime.lastError = undefined;
  };
  (globalThis as Record<string, unknown>).chrome = {
    runtime,
    debugger: {
      onEvent: { addListener: (l: EventListener) => listeners.push(l), removeListener: () => {} },
      onDetach: { addListener: () => {}, removeListener: () => {} },
      attach: (_t: Debuggee, _v: string, cb: () => void) => reply(undefined, cb),
      detach: (_t: Debuggee, cb: () => void) => reply(undefined, cb),
      sendCommand: (target: Debuggee, method: string, params: object | undefined, cb: (r?: object) => void) => {
        const s = { target, method, params };
        sent.push(s);
        reply(fail(s), cb);
      },
    },
  };
  const fire = (source: Debuggee, method: string, params: object) => {
    for (const l of listeners) l(source, method, params);
  };
  return { sent, fire };
}

/** Let the async child setup run to completion. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const attached = (sessionId: string, type: string, url: string, waitingForDebugger = true) => ({
  sessionId,
  targetInfo: { targetId: `T-${sessionId}`, type, url },
  waitingForDebugger,
});

describe('DebuggerManager child sessions', () => {
  const userAgent = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent');
  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      value: 'Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36',
      configurable: true,
    });
  });
  afterEach(() => {
    if (userAgent) Object.defineProperty(globalThis.navigator, 'userAgent', userAgent);
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('asks Chrome to auto-attach paused children once the tab is attached', async () => {
    const { sent } = installChrome();
    const dbg = new DebuggerManager();
    await dbg.attach(7);
    expect(sent.at(-1)).toEqual({
      target: { tabId: 7 },
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    });
  });

  it('enables capture on a new iframe through its session, follows its children, then resumes it', async () => {
    const { sent, fire } = installChrome();
    const dbg = new DebuggerManager();
    await dbg.attach(7);
    sent.length = 0;

    fire({ tabId: 7 }, 'Target.attachedToTarget', attached('S1', 'iframe', 'https://pay.example.com/'));
    await settle();

    expect(sent.map((s) => [s.target.sessionId, s.method])).toEqual([
      ['S1', 'Network.enable'],
      ['S1', 'Runtime.enable'],
      ['S1', 'Log.enable'],
      ['S1', 'Target.setAutoAttach'],
      ['S1', 'Runtime.runIfWaitingForDebugger'],
    ]);
    expect(dbg.observes(7, 'iframe')).toBe(true);
  });

  it("routes a child's events with its target, and marks what a cross-site iframe starts as cross-site", async () => {
    const { fire } = installChrome();
    const dbg = new DebuggerManager();
    const seen: Array<[string, ChildTarget | undefined]> = [];
    dbg.onEvent((_tab, method, _p, child) => seen.push([method, child]));
    await dbg.attach(7);

    fire({ tabId: 7 }, 'Target.attachedToTarget', attached('S1', 'iframe', 'https://pay.example.com/'));
    fire({ tabId: 7, sessionId: 'S1' }, 'Target.attachedToTarget', attached('S2', 'worker', 'https://pay.example.com/w.js'));
    fire({ tabId: 7 }, 'Target.attachedToTarget', attached('S3', 'worker', 'https://app.example.com/w.js'));
    await settle();
    fire({ tabId: 7 }, 'Network.requestWillBeSent', {});
    fire({ tabId: 7, sessionId: 'S2' }, 'Network.requestWillBeSent', {});
    fire({ tabId: 7, sessionId: 'S3' }, 'Network.requestWillBeSent', {});

    expect(seen.map(([, c]) => c && [c.type, c.crossSite])).toEqual([
      undefined,
      ['worker', true], // started by the cross-site iframe
      ['worker', false], // started by the page: same-origin by definition
    ]);
  });

  it('resumes and releases a child whose setup fails, and reports the gap', async () => {
    const { sent, fire } = installChrome((s) =>
      s.target.sessionId === 'S1' && s.method === 'Network.enable' ? 'Target closed' : undefined,
    );
    const dbg = new DebuggerManager();
    const gaps: Array<[number, unknown, string]> = [];
    dbg.onChildGap((tab, child, reason) => gaps.push([tab, child, reason]));
    await dbg.attach(7);
    sent.length = 0;

    fire({ tabId: 7 }, 'Target.attachedToTarget', attached('S1', 'iframe', 'https://pay.example.com/'));
    await settle();

    expect(sent.map((s) => [s.target.sessionId, s.method])).toEqual([
      ['S1', 'Network.enable'],
      ['S1', 'Runtime.runIfWaitingForDebugger'],
      [undefined, 'Target.detachFromTarget'],
    ]);
    expect(gaps).toEqual([[7, expect.objectContaining({ type: 'iframe', url: 'https://pay.example.com/' }), expect.stringContaining('Target closed')]]);
    expect(dbg.observes(7, 'iframe')).toBe(false);
  });

  it('lets targets it does not record, such as service workers, run and detaches from them', async () => {
    const { sent, fire } = installChrome();
    const dbg = new DebuggerManager();
    await dbg.attach(7);
    sent.length = 0;

    fire({ tabId: 7 }, 'Target.attachedToTarget', attached('S9', 'service_worker', 'https://app.example.com/sw.js'));
    await settle();
    expect(sent.map((s) => [s.target.sessionId, s.method])).toEqual([
      ['S9', 'Runtime.runIfWaitingForDebugger'],
      [undefined, 'Target.detachFromTarget'],
    ]);
  });

  it('drops events from sessions it is not observing', async () => {
    const { fire } = installChrome();
    const dbg = new DebuggerManager();
    const seen: string[] = [];
    dbg.onEvent((_t, method) => seen.push(method));
    await dbg.attach(7);
    fire({ tabId: 7, sessionId: 'unknown' }, 'Network.requestWillBeSent', {});
    expect(seen).toEqual([]);
  });

  it('forgets a child when Chrome detaches it', async () => {
    const { fire } = installChrome();
    const dbg = new DebuggerManager();
    await dbg.attach(7);
    fire({ tabId: 7 }, 'Target.attachedToTarget', attached('S1', 'worker', 'https://app.example.com/w.js'));
    await settle();
    expect(dbg.observes(7, 'worker')).toBe(true);
    fire({ tabId: 7 }, 'Target.detachedFromTarget', { sessionId: 'S1' });
    expect(dbg.observes(7, 'worker')).toBe(false);
  });

  it('does not auto-attach on Chrome versions whose debugger API has no child sessions', async () => {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      value: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
      configurable: true,
    });
    const { sent } = installChrome();
    await new DebuggerManager().attach(7);
    expect(sent.map((s) => s.method)).not.toContain('Target.setAutoAttach');
  });
});

describe('DebuggerManager child body buffers', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('keeps no body buffer for a cross-site iframe, and the usual one for a same-origin worker', async () => {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      value: 'Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36',
      configurable: true,
    });
    const { sent, fire } = installChrome();
    const dbg = new DebuggerManager();
    await dbg.attach(7);
    fire({ tabId: 7 }, 'Target.attachedToTarget', attached('S1', 'iframe', 'https://pay.example.com/'));
    fire({ tabId: 7 }, 'Target.attachedToTarget', attached('S2', 'worker', 'https://app.example.com/w.js'));
    await settle();
    const enable = (sessionId: string) =>
      sent.find((s) => s.target.sessionId === sessionId && s.method === 'Network.enable')?.params;
    expect(enable('S1')).toEqual({ maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    expect(enable('S2')).toEqual({ maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 50_000_000 });
  });
});
