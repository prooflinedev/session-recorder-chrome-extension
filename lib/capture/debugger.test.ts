import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DebuggerManager } from './debugger';

/**
 * A scripted `chrome.debugger`. Attach answers are held until the test calls
 * `answerAttach()`, and selected commands can be held too, so every
 * interleaving between sessions can be forced deterministically. Like Chrome
 * (measured on Chrome 158), attaching a tab the extension already holds fails
 * with "already attached", a command to a tab it doesn't hold fails with
 * "Debugger is not attached…", and one to a closed tab with "No tab with given
 * id…".
 */
function fakeChrome() {
  const eventListeners = new Set<(s: { tabId?: number }, m: string, p?: object) => void>();
  const detachListeners = new Set<(s: { tabId?: number }, r: string) => void>();
  const chromeAttached = new Set<number>();
  const closedTabs = new Set<number>();
  const pendingAttaches: { tabId: number; answer: (err?: string) => void }[] = [];
  const heldSends: { tabId: number; method: string; answer: (err?: string) => void }[] = [];
  const holdMethods = new Set<string>();
  const failMethods = new Map<string, string>();
  const log: string[] = [];
  let lastError: { message: string } | undefined;

  const callBack = (cb: (r?: unknown) => void, err?: string) => {
    lastError = err ? { message: err } : undefined;
    cb(err ? undefined : {});
    lastError = undefined;
  };
  const stateError = (tabId: number) =>
    closedTabs.has(tabId)
      ? `No tab with given id ${tabId}.`
      : chromeAttached.has(tabId)
        ? undefined
        : `Debugger is not attached to the tab with id: ${tabId}.`;

  (globalThis as any).chrome = {
    runtime: {
      get lastError() {
        return lastError;
      },
    },
    debugger: {
      attach: ({ tabId }: { tabId: number }, _v: string, cb: () => void) => {
        log.push(`attach ${tabId}`);
        pendingAttaches.push({
          tabId,
          answer: (err?: string) => {
            const e = err ?? (chromeAttached.has(tabId)
              ? `Another debugger is already attached to the tab with id: ${tabId}.`
              : undefined);
            if (!e) chromeAttached.add(tabId);
            callBack(cb, e);
          },
        });
      },
      detach: ({ tabId }: { tabId: number }, cb: () => void) => {
        log.push(`detach ${tabId}`);
        const was = chromeAttached.delete(tabId);
        queueMicrotask(() => callBack(cb, was ? undefined : `Debugger is not attached to the tab with id: ${tabId}.`));
      },
      sendCommand: (
        { tabId }: { tabId: number },
        method: string,
        _params: object | undefined,
        cb: (r?: unknown) => void,
      ) => {
        log.push(`send ${tabId} ${method}`);
        const answer = (err?: string) => callBack(cb, err ?? stateError(tabId));
        if (holdMethods.has(method)) heldSends.push({ tabId, method, answer });
        else queueMicrotask(() => answer(failMethods.get(method)));
      },
      onEvent: {
        addListener: (f: any) => eventListeners.add(f),
        removeListener: (f: any) => eventListeners.delete(f),
      },
      onDetach: {
        addListener: (f: any) => detachListeners.add(f),
        removeListener: (f: any) => detachListeners.delete(f),
      },
    },
  };

  const fireDetach = (tabId: number, reason: string) => {
    for (const f of detachListeners) f({ tabId }, reason);
  };

  return {
    log,
    chromeAttached,
    holdMethods,
    failMethods,
    /** Answer the oldest pending attach (success unless `err`). */
    answerAttach(err?: string) {
      const next = pendingAttaches.shift();
      if (!next) throw new Error('no pending attach');
      next.answer(err);
    },
    pendingAttachCount: () => pendingAttaches.length,
    /** Release the oldest held command (success unless `err`). */
    releaseSend(err?: string) {
      const next = heldSends.shift();
      if (!next) throw new Error('no held command');
      next.answer(err);
    },
    heldSendCount: () => heldSends.length,
    emitEvent(tabId: number, method: string, params: object = {}) {
      for (const f of eventListeners) f({ tabId }, method, params);
    },
    /** Chrome ended the attachment itself (DevTools opened, chrome:// page). */
    emitDetach(tabId: number, reason: string) {
      chromeAttached.delete(tabId);
      fireDetach(tabId, reason);
    },
    /** The tab was closed: Chrome detaches it and later commands find no tab. */
    closeTab(tabId: number) {
      closedTabs.add(tabId);
      chromeAttached.delete(tabId);
      fireDetach(tabId, 'target_closed');
    },
    /**
     * A detach event about an earlier attachment, arriving while the tab is
     * attached again. `onDetach` carries only the tab id, so it looks the same.
     */
    emitStaleDetach(tabId: number, reason: string) {
      fireDetach(tabId, reason);
    },
    count: (prefix: string) => log.filter((l) => l.startsWith(prefix)).length,
  };
}

/** Let queued microtasks and callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Resolve with the promise's value, or 'blocked' if it hasn't settled by now. */
const raceSettle = <T>(p: Promise<T>) =>
  Promise.race([p, settle().then(() => 'blocked' as const)]);

const T = 7;
const ENABLES = ['Network.enable', 'Page.enable', 'Runtime.enable', 'Log.enable'];
const PROBE = 'Target.getTargetInfo';

let chromeFake: ReturnType<typeof fakeChrome>;
let dbg: DebuggerManager;
let events: string[];
let detaches: string[];

beforeEach(() => {
  chromeFake = fakeChrome();
  dbg = new DebuggerManager();
  events = [];
  detaches = [];
  dbg.onEvent((tabId, method) => events.push(`${tabId} ${method}`));
  dbg.onDetach((tabId, reason) => detaches.push(`${tabId} ${reason}`));
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

/** Session B's attachment is live: owned, attached in Chrome, and capturing. */
async function expectCapturing(tabId: number, owner: string) {
  expect(dbg.ownerOf(tabId)).toBe(owner);
  expect(dbg.isAttached(tabId)).toBe(true);
  expect(chromeFake.chromeAttached.has(tabId)).toBe(true);
  // CDP events from the tab still reach the capturers…
  chromeFake.emitEvent(tabId, 'Network.requestWillBeSent', { requestId: 'r1' });
  expect(events).toContain(`${tabId} Network.requestWillBeSent`);
  // …and commands (response bodies, screenshots) still reach Chrome.
  await expect(dbg.send(tabId, 'Network.getResponseBody', { requestId: 'r1' })).resolves.toEqual({});
  await expect(dbg.captureScreenshot(tabId, 80)).resolves.toBeDefined();
}

/** Attach `owner` to `tabId` and let the attach (and domain setup) finish. */
async function attachFully(tabId: number, owner: string) {
  const p = dbg.attach(tabId, owner);
  await settle();
  chromeFake.answerAttach();
  await p;
}

describe('DebuggerManager attachment ownership', () => {
  it('A → stop → B → old A resumes: A cannot detach B (attach still in flight at stop)', async () => {
    // A starts adopting tab T; Chrome hasn't answered the attach yet.
    chromeFake.holdMethods.add('Network.enable');
    const aAttach = dbg.attach(T, 'A');
    // A stops. Stop releases what A owns, waiting for Chrome's answer.
    const aStop = dbg.detachAll('A');
    await settle();
    chromeFake.answerAttach();
    expect(await aStop).toEqual([T]);
    expect(dbg.isAttached(T)).toBe(false);
    expect(chromeFake.chromeAttached.has(T)).toBe(false);
    // A's half-enabled attach ends as released, not as capturing.
    chromeFake.releaseSend();
    await expect(aAttach).rejects.toThrow(/not attached/);
    chromeFake.holdMethods.clear();

    // B starts on the same tab and gets its own, fresh attachment.
    await attachFully(T, 'B');

    // A's old adopt() now resumes and tries to clean up its attachment.
    expect(await dbg.detach(T, 'A')).toBe(false);
    expect(await dbg.detachAll('A')).toEqual([]);

    await expectCapturing(T, 'B');
    expect(chromeFake.count('detach')).toBe(1); // only A's own, during A's stop
  });

  it('B attaching while A is still waiting for Chrome takes over; old A cannot detach B', async () => {
    // Worst case, even without A's stop releasing it: A's attach is in flight…
    chromeFake.holdMethods.add('Network.enable');
    const aAttach = dbg.attach(T, 'A');
    // …and B attaches the same tab. B must not share A's attachment.
    const bAttach = dbg.attach(T, 'B');
    await settle();
    chromeFake.answerAttach(); // A's attach lands
    await settle();
    // B released A's attachment and asked Chrome for its own.
    expect(chromeFake.count('detach')).toBe(1);
    expect(dbg.ownerOf(T)).toBe('B');
    chromeFake.holdMethods.clear();
    chromeFake.answerAttach();
    await bAttach;
    chromeFake.releaseSend(); // A's Network.enable answers late
    await expect(aAttach).rejects.toThrow();

    expect(await dbg.detach(T, 'A')).toBe(false);
    await expectCapturing(T, 'B');
    expect(chromeFake.count('attach')).toBe(2);
    expect(chromeFake.count('detach')).toBe(1);
    // A sent only its first enable; B enabled every domain on its own attachment.
    expect(chromeFake.count(`send ${T} Network.enable`)).toBe(2);
    for (const m of ENABLES.slice(1)) expect(chromeFake.count(`send ${T} ${m}`)).toBe(1);
  });

  it('stop during attach waits for Chrome and leaves nothing attached', async () => {
    const aAttach = dbg.attach(T, 'A');
    const aStop = dbg.detachAll('A');
    await settle();
    expect(chromeFake.count('detach')).toBe(0); // not before Chrome answers
    chromeFake.answerAttach();
    expect(await aStop).toEqual([T]);
    await aAttach.catch(() => {});
    expect(dbg.isAttached(T)).toBe(false);
    expect(dbg.ownerOf(T)).toBeUndefined();
    expect(chromeFake.chromeAttached.size).toBe(0);
  });

  it('concurrent adoptions: stop releases every tab its session owns and none of another', async () => {
    const a1 = dbg.attach(1, 'A');
    const a2 = dbg.attach(2, 'A');
    const b3 = dbg.attach(3, 'B');
    await settle();
    chromeFake.answerAttach(); // tab 1
    await a1;
    const aStop = dbg.detachAll('A'); // tab 2 still in flight
    await settle();
    chromeFake.answerAttach(); // tab 2
    chromeFake.answerAttach(); // tab 3
    await Promise.all([a2.catch(() => {}), b3]);
    expect((await aStop).sort()).toEqual([1, 2]);
    expect(dbg.attachedTabs()).toEqual([3]);
    expect(await dbg.detach(3, 'A')).toBe(false);
    await expectCapturing(3, 'B');
  });

  it('the same session attaching a tab twice shares one attach', async () => {
    const first = dbg.attach(T, 'A');
    const second = dbg.attach(T, 'A');
    await settle();
    expect(chromeFake.pendingAttachCount()).toBe(1);
    chromeFake.answerAttach();
    await Promise.all([first, second]);
    expect(chromeFake.count('attach')).toBe(1);
    expect(await dbg.detach(T, 'A')).toBe(true);
    expect(chromeFake.chromeAttached.size).toBe(0);
  });

  it('tab closed: handlers hear once, the old owner cannot detach, a new one can attach', async () => {
    await attachFully(T, 'A');

    chromeFake.closeTab(T);
    await settle(); // the probe answers "No tab with given id"
    expect(detaches).toEqual([`${T} target_closed`]);
    expect(dbg.isAttached(T)).toBe(false);
    expect(dbg.ownerOf(T)).toBeUndefined();
    expect(await dbg.detach(T, 'A')).toBe(false);
    expect(chromeFake.count('detach')).toBe(0);

    await attachFully(T + 1, 'B');
    await expectCapturing(T + 1, 'B');
    expect(detaches).toEqual([`${T} target_closed`]);
  });

  it('tab closed while domains are enabling: the attach fails and leaves nothing behind', async () => {
    chromeFake.holdMethods.add('Network.enable');
    const aAttach = dbg.attach(T, 'A');
    await settle();
    chromeFake.answerAttach();
    await settle();
    chromeFake.closeTab(T);
    await settle();
    chromeFake.releaseSend(); // Chrome: no such tab any more
    await expect(aAttach).rejects.toThrow(/No tab with given id/);
    expect(dbg.ownerOf(T)).toBeUndefined();
    expect(detaches).toEqual([`${T} target_closed`]);
    expect(chromeFake.count('detach')).toBe(0); // nothing to undo in Chrome
  });

  it('attach failure leaves no ownership, and another session can attach afterwards', async () => {
    const aAttach = dbg.attach(T, 'A');
    await settle();
    chromeFake.answerAttach('Cannot attach to this target.');
    await expect(aAttach).rejects.toThrow(/Cannot record this tab/);
    expect(dbg.ownerOf(T)).toBeUndefined();
    expect(await dbg.detach(T, 'A')).toBe(false);

    await attachFully(T, 'B');
    await expectCapturing(T, 'B');
  });

  it('domain-enable failure rolls back its own attachment; another session then attaches', async () => {
    chromeFake.failMethods.set('Page.enable', 'Page.enable failed');
    const aAttach = dbg.attach(T, 'A');
    await settle();
    chromeFake.answerAttach();
    await expect(aAttach).rejects.toThrow(/Page.enable failed/);
    expect(chromeFake.count('detach')).toBe(1); // A's rollback
    expect(dbg.ownerOf(T)).toBeUndefined();
    expect(chromeFake.chromeAttached.size).toBe(0);
    chromeFake.failMethods.clear();

    await attachFully(T, 'B');
    expect(await dbg.detach(T, 'A')).toBe(false);
    await expectCapturing(T, 'B');
    expect(chromeFake.count('detach')).toBe(1);
  });

  it('rapid consecutive recordings: each stop releases only its own; late cleanups are ignored', async () => {
    for (const owner of ['A', 'B']) {
      await attachFully(T, owner);
      expect(await dbg.detachAll(owner)).toEqual([T]);
    }
    await attachFully(T, 'C');
    // Late cleanups from A's and B's sessions arrive after C started.
    expect(await dbg.detach(T, 'A')).toBe(false);
    expect(await dbg.detach(T, 'B')).toBe(false);
    expect(await dbg.detachAll('A')).toEqual([]);
    expect(await dbg.detachAll('B')).toEqual([]);
    await expectCapturing(T, 'C');
    expect(chromeFake.count('attach')).toBe(3);
    expect(chromeFake.count('detach')).toBe(2);
  });

  it('dispose during a pending enable, then the enable fails: no extra detach', async () => {
    chromeFake.holdMethods.add('Network.enable');
    const aAttach = dbg.attach(T, 'A');
    await settle();
    chromeFake.answerAttach();
    await settle();
    expect(chromeFake.heldSendCount()).toBe(1);
    dbg.dispose();
    await settle();
    expect(chromeFake.count('detach')).toBe(1); // dispose's own
    chromeFake.releaseSend('Network.enable failed');
    await expect(aAttach).rejects.toThrow(/Network.enable failed/);
    await settle();
    // The disposed attachment's failure must not detach the tab again: by
    // then the tab may belong to someone else.
    expect(chromeFake.count('detach')).toBe(1);
  });

  it('dispose during an in-flight attach undoes the late attach', async () => {
    const aAttach = dbg.attach(T, 'A');
    await settle();
    dbg.dispose();
    chromeFake.answerAttach();
    await expect(aAttach).rejects.toThrow(/cancelled/);
    expect(chromeFake.chromeAttached.size).toBe(0);
  });
});

describe('DebuggerManager: releasing never waits for domain setup', () => {
  /** A is attached in Chrome; its Network.enable never answers (e.g. a crashed renderer). */
  async function attachWithHungEnable() {
    chromeFake.holdMethods.add('Network.enable');
    const aAttach = dbg.attach(T, 'A');
    await settle();
    chromeFake.answerAttach();
    await settle();
    expect(chromeFake.heldSendCount()).toBe(1);
    expect(dbg.isAttached(T)).toBe(true);
    chromeFake.holdMethods.clear();
    // Wrapped: returning the promise itself would make callers await the hung attach.
    return { aAttach };
  }

  it('stop during a hung enable releases the tab without waiting for it', async () => {
    const { aAttach } = await attachWithHungEnable();
    expect(await raceSettle(dbg.detachAll('A'))).toEqual([T]);
    expect(dbg.ownerOf(T)).toBeUndefined();
    expect(dbg.isAttached(T)).toBe(false);
    expect(chromeFake.chromeAttached.size).toBe(0);

    // The hung command finally answers, as Chrome does for a detached session.
    chromeFake.releaseSend('Detached while handling command.');
    await expect(aAttach).rejects.toThrow(/Detached while handling command/);
    for (const m of ENABLES.slice(1)) expect(chromeFake.count(`send ${T} ${m}`)).toBe(0);
    expect(chromeFake.count('detach')).toBe(1);
  });

  it('a hung enable does not delay detach() of that tab', async () => {
    const { aAttach } = await attachWithHungEnable();
    expect(await raceSettle(dbg.detach(T, 'A'))).toBe(true);
    chromeFake.releaseSend('Detached while handling command.');
    await expect(aAttach).rejects.toThrow();
    expect(chromeFake.chromeAttached.size).toBe(0);
  });

  it('a new owner takes over a tab whose enable is hung, without waiting for it', async () => {
    const { aAttach } = await attachWithHungEnable();
    const bAttach = dbg.attach(T, 'B');
    await settle();
    expect(dbg.ownerOf(T)).toBe('B');
    expect(chromeFake.count('detach')).toBe(1);
    expect(chromeFake.pendingAttachCount()).toBe(1); // B's own attach, already asked
    chromeFake.answerAttach();
    await bAttach;
    await expectCapturing(T, 'B');
    chromeFake.releaseSend('Detached while handling command.');
    await expect(aAttach).rejects.toThrow();
    await expectCapturing(T, 'B');
  });

  it('late enable success after a takeover sends nothing more and leaves the new owner alone', async () => {
    const { aAttach } = await attachWithHungEnable();
    expect(await dbg.detachAll('A')).toEqual([T]); // A stops
    await attachFully(T, 'B'); // B starts on the same tab
    const sendsBefore = chromeFake.count(`send ${T}`);

    // Worst case: A's old Network.enable reports success, because B now holds the tab.
    chromeFake.releaseSend();
    await expect(aAttach).rejects.toThrow(/cancelled/);
    expect(chromeFake.count(`send ${T}`)).toBe(sendsBefore); // nothing sent to B's session
    expect(chromeFake.count('detach')).toBe(1); // only A's own release
    await expectCapturing(T, 'B');
  });

  it('stop during the last enable: a late success still reports the attach as released', async () => {
    chromeFake.holdMethods.add('Log.enable');
    const aAttach = dbg.attach(T, 'A');
    await settle();
    chromeFake.answerAttach();
    await settle();
    expect(chromeFake.heldSendCount()).toBe(1); // Network, Page, Runtime done
    chromeFake.holdMethods.clear();
    expect(await raceSettle(dbg.detachAll('A'))).toEqual([T]);
    await attachFully(T, 'B');
    chromeFake.releaseSend(); // succeeds, because B holds the tab now
    // A's caller must not believe it is capturing.
    await expect(aAttach).rejects.toThrow(/cancelled/);
    await expectCapturing(T, 'B');
  });

  it('late enable failure after a takeover does not roll back the new owner', async () => {
    const { aAttach } = await attachWithHungEnable();
    await attachFully(T, 'B'); // takes over directly
    chromeFake.releaseSend('Network.enable failed');
    await expect(aAttach).rejects.toThrow(/Network.enable failed/);
    expect(chromeFake.count('detach')).toBe(1); // A's release by the takeover only
    await expectCapturing(T, 'B');
  });

  it('the same owner attaching again still waits for domain setup', async () => {
    const { aAttach: first } = await attachWithHungEnable();
    const second = dbg.attach(T, 'A');
    expect(await raceSettle(second)).toBe('blocked');
    chromeFake.releaseSend();
    await Promise.all([first, second]);
    await expectCapturing(T, 'A');
  });
});

describe('DebuggerManager: a detach event is checked before it is believed', () => {
  it('a stale detach event while a newer session is attached keeps that attachment', async () => {
    await attachFully(T, 'A');
    expect(await dbg.detachAll('A')).toEqual([T]);
    await attachFully(T, 'B');

    // An event about A's old attachment arrives now: it names only the tab.
    chromeFake.emitStaleDetach(T, 'target_closed');
    await settle();
    expect(chromeFake.count(`send ${T} ${PROBE}`)).toBe(1);
    expect(detaches).toEqual([]);
    await expectCapturing(T, 'B');
  });

  it('a detach event before the attach is confirmed is ignored without a probe', async () => {
    const aAttach = dbg.attach(T, 'A');
    await settle();
    chromeFake.emitStaleDetach(T, 'target_closed');
    await settle();
    expect(chromeFake.count(`send ${T} ${PROBE}`)).toBe(0);
    expect(dbg.ownerOf(T)).toBe('A');
    chromeFake.answerAttach();
    await aAttach;
    expect(detaches).toEqual([]);
    await expectCapturing(T, 'A');
  });

  it.each([
    ['Debugger is not attached to the tab with id: 7.', 'canceled_by_user'],
    ['No tab with given id 7.', 'target_closed'],
    ['Cannot access a chrome:// URL', 'target_closed'],
    ['Detached while handling command.', 'target_closed'],
  ])('a genuine detach proven by "%s" forgets the attachment and notifies once', async (err, reason) => {
    await attachFully(T, 'A');
    chromeFake.failMethods.set(PROBE, err);
    chromeFake.emitDetach(T, reason);
    expect(detaches).toEqual([]); // not before Chrome answers the probe
    await settle();
    expect(detaches).toEqual([`${T} ${reason}`]);
    expect(dbg.ownerOf(T)).toBeUndefined();
    expect(dbg.isAttached(T)).toBe(false);
    expect(dbg.attachedTabs()).toEqual([]);
    expect(await dbg.detach(T, 'A')).toBe(false);
    expect(chromeFake.count('detach')).toBe(0);

    chromeFake.failMethods.clear();
    await attachFully(T, 'B');
    await expectCapturing(T, 'B');
    expect(detaches).toHaveLength(1);
  });

  it.each([
    "'Target.getTargetInfo' wasn't found",
    'Internal error',
    'Debugger error: something new',
  ])('an unrecognized probe error ("%s") keeps the attachment and notifies nobody', async (err) => {
    await attachFully(T, 'A');
    chromeFake.failMethods.set(PROBE, err);
    chromeFake.emitStaleDetach(T, 'target_closed');
    await settle();
    expect(chromeFake.count(`send ${T} ${PROBE}`)).toBe(1);
    expect(detaches).toEqual([]);
    chromeFake.failMethods.clear();
    await expectCapturing(T, 'A');
  });

  it('a genuine detach with an unrecognized probe error leaves a dead record that Stop still releases', async () => {
    // The honest limit of not trusting unknown errors: the record survives,
    // but releasing it ignores Chrome's "not attached" and never rejects.
    await attachFully(T, 'A');
    chromeFake.failMethods.set(PROBE, 'Internal error');
    chromeFake.emitDetach(T, 'target_closed');
    await settle();
    expect(detaches).toEqual([]);
    expect(dbg.ownerOf(T)).toBe('A');
    expect(await dbg.detachAll('A')).toEqual([T]);
    expect(dbg.ownerOf(T)).toBeUndefined();
  });

  it('a delayed probe answered after Stop and a new attachment cannot touch the new one', async () => {
    await attachFully(T, 'A');
    chromeFake.holdMethods.add(PROBE);
    chromeFake.emitDetach(T, 'target_closed'); // A's session really ends; probe pending
    chromeFake.holdMethods.clear();
    // Stop is not blocked by the pending probe.
    expect(await raceSettle(dbg.detachAll('A'))).toEqual([T]);
    await attachFully(T, 'B');

    // A's probe answers last, with a detached error.
    chromeFake.releaseSend(`Debugger is not attached to the tab with id: ${T}.`);
    await settle();
    expect(detaches).toEqual([]);
    await expectCapturing(T, 'B');
  });

  it('a delayed probe answered after a takeover cannot touch the new owner', async () => {
    await attachFully(T, 'A');
    chromeFake.holdMethods.add(PROBE);
    chromeFake.emitStaleDetach(T, 'target_closed');
    chromeFake.holdMethods.clear();
    await attachFully(T, 'B'); // releases A's record and replaces it
    chromeFake.releaseSend('No tab with given id 7.');
    await settle();
    expect(detaches).toEqual([]);
    await expectCapturing(T, 'B');
  });

  it('repeated detach events for one genuine detach notify handlers once', async () => {
    await attachFully(T, 'A');
    chromeFake.emitDetach(T, 'target_closed');
    chromeFake.emitDetach(T, 'target_closed');
    await settle();
    expect(chromeFake.count(`send ${T} ${PROBE}`)).toBe(2);
    expect(detaches).toEqual([`${T} target_closed`]);
    chromeFake.emitDetach(T, 'target_closed'); // after the record is gone
    await settle();
    expect(chromeFake.count(`send ${T} ${PROBE}`)).toBe(2);
    expect(detaches).toEqual([`${T} target_closed`]);
  });

  it('a detach event for a tab with no attachment is ignored', async () => {
    chromeFake.emitStaleDetach(99, 'target_closed');
    await settle();
    expect(chromeFake.count('send')).toBe(0);
    expect(detaches).toEqual([]);
  });
});
