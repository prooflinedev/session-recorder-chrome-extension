/**
 * Thin wrapper over `chrome.debugger` (CDP protocol `1.3`).
 *
 * Owns the debugger attachment for every session tab: attaching enables the
 * Network/Page/Runtime/Log domains, `send()` promisifies `sendCommand`, and a
 * single `onEvent`/`onDetach` pair (registered once in the constructor) fans out
 * to the capturers that register handlers. All the ugly `chrome.runtime.lastError`
 * plumbing and the human-readable error phrasing live here so the callers can
 * work in plain async/await.
 */

/**
 * A child debugger session inside a recorded tab: a cross-site iframe (which
 * Chrome runs in its own process) or a dedicated worker. Chrome attaches these
 * through `Target.setAutoAttach`, and their events carry the `sessionId`.
 */
export interface ChildTarget {
  sessionId: string;
  type: 'iframe' | 'worker';
  /** Unredacted target URL; redact before it enters a recording. */
  url: string;
  /** A cross-site iframe, or anything a cross-site iframe started. */
  crossSite: boolean;
}

/**
 * A CDP protocol event, routed to every registered handler. `child` is set when
 * the event came from an iframe or worker session rather than the tab's page.
 */
export type CdpEventHandler = (
  tabId: number,
  method: string,
  params: Record<string, unknown>,
  child?: ChildTarget,
) => void;

/** Fired when the debugger detaches from a tab (DevTools opened, tab closed, …). */
export type DetachHandler = (tabId: number, reason: string) => void;

/**
 * Fired when an iframe or worker could not be observed, so its network and
 * console activity is missing from the recording.
 */
export type ChildGapHandler = (
  tabId: number,
  /** Undefined when no iframe or worker in the tab can be followed at all. */
  child: Pick<ChildTarget, 'type' | 'url'> | undefined,
  reason: string,
) => void;

/** `chrome.debugger` accepts a child `sessionId` since Chrome 125; the bundled typings predate it. */
type Debuggee = chrome.debugger.Debuggee & { sessionId?: string };

const PROTOCOL_VERSION = '1.3';

/**
 * Pause each new iframe and worker until its domains are enabled, so its first
 * requests are not missed, and route its events over this connection.
 */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/**
 * Domains enabled on a child session; workers have no Page domain. Bodies from
 * a cross-site child are never read, so Chrome keeps none for it: a page with
 * many third-party frames must not hold a body buffer per frame.
 */
function childEnableSequence(crossSite: boolean): ReadonlyArray<{ method: string; params?: object }> {
  return [
    {
      method: 'Network.enable',
      params: crossSite
        ? { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }
        : { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 50_000_000 },
    },
    { method: 'Runtime.enable' },
    { method: 'Log.enable' },
  ];
}

/** Target types whose network and console activity we record. */
function childType(type: unknown): ChildTarget['type'] | undefined {
  return type === 'iframe' || type === 'worker' ? type : undefined;
}

/** Child sessions need `sessionId` in `chrome.debugger`, which Chrome 125 added. */
function supportsChildSessions(): boolean {
  const match = /Chrome\/(\d+)/.exec(globalThis.navigator?.userAgent ?? '');
  return !!match && Number(match[1]) >= 125;
}

/**
 * Domains enabled on every freshly attached tab, in order. `Network.enable`
 * carries large buffers so bodies aren't evicted before `getResponseBody`.
 */
const ENABLE_SEQUENCE: ReadonlyArray<{ method: string; params?: object }> = [
  {
    method: 'Network.enable',
    params: {
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 50_000_000,
    },
  },
  { method: 'Page.enable' },
  { method: 'Runtime.enable' },
  { method: 'Log.enable' },
];

/**
 * Translate a raw `chrome.runtime.lastError` message into an `Error` with a
 * message a human can act on. Falls back to the raw text when we don't recognize
 * the failure.
 */
function toReadableError(rawMessage: string | undefined, tabId: number): Error {
  const raw = rawMessage ?? 'unknown error';
  const lower = raw.toLowerCase();

  if (lower.includes('cannot attach to this target')) {
    return new Error(
      `Cannot record this tab (${tabId}): the page can't be inspected ` +
        `(e.g. a chrome:// page, the Web Store, or another restricted URL).`,
    );
  }
  if (lower.includes('another debugger') || lower.includes('already attached')) {
    return new Error(
      `Cannot record tab ${tabId}: another debugger is already attached. ` +
        `Close DevTools (or any other extension using the debugger) for this tab and try again.`,
    );
  }
  if (lower.includes('devtools')) {
    return new Error(
      `Cannot record tab ${tabId}: DevTools is open on this tab. ` +
        `Close DevTools and try again.`,
    );
  }
  return new Error(`Debugger error on tab ${tabId}: ${raw}`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class DebuggerManager {
  private readonly attached = new Set<number>();
  /** Child sessions by `sessionId`, with the tab they belong to. */
  private readonly children = new Map<string, { tabId: number; child: ChildTarget }>();
  private readonly eventHandlers: CdpEventHandler[] = [];
  private readonly detachHandlers: DetachHandler[] = [];
  private readonly childGapHandlers: ChildGapHandler[] = [];
  private disposed = false;

  /** Bound listeners, kept so they can be removed in `dispose()`. */
  private readonly onEventListener = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): void => {
    if (source.tabId === undefined) return;
    const tabId = source.tabId;
    const sessionId = (source as Debuggee).sessionId;
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'Target.attachedToTarget') {
      void this.onChildAttached(tabId, sessionId, p);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      if (typeof p.sessionId === 'string') this.children.delete(p.sessionId);
      return;
    }
    let child: ChildTarget | undefined;
    if (sessionId) {
      child = this.children.get(sessionId)?.child;
      // A session we chose not to observe (or one that already ended).
      if (!child) return;
    }
    for (const h of this.eventHandlers) {
      h(tabId, method, p, child);
    }
  };

  private readonly onDetachListener = (
    source: chrome.debugger.Debuggee,
    reason: string,
  ): void => {
    if (source.tabId === undefined) return;
    const tabId = source.tabId;
    this.attached.delete(tabId);
    this.forgetChildren(tabId);
    for (const h of this.detachHandlers) {
      h(tabId, reason);
    }
  };

  constructor() {
    chrome.debugger.onEvent.addListener(this.onEventListener);
    chrome.debugger.onDetach.addListener(this.onDetachListener);
  }

  /**
   * Attach the debugger to a tab and enable the capture domains. Idempotent: a
   * no-op (resolves immediately) if the tab is already attached. Throws an
   * `Error` with a human-readable `.message` on failure.
   */
  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(toReadableError(err.message, tabId));
          return;
        }
        resolve();
      });
    });

    // Mark attached before enabling domains so a mid-sequence detach event can
    // clean up correctly and so `send()` won't reject on "not attached".
    this.attached.add(tabId);

    try {
      for (const { method, params } of ENABLE_SEQUENCE) {
        await this.send(tabId, method, params);
      }
    } catch (e) {
      // Enabling failed after a successful attach — roll back so the tab isn't
      // left half-initialized, then surface the error.
      await this.detach(tabId);
      throw e instanceof Error ? e : new Error(String(e));
    }

    // Cross-site iframes and workers are separate targets. Without this, their
    // requests, console messages and exceptions never reach the recording.
    // Chrome then reports every existing and future child as attachedToTarget.
    if (supportsChildSessions()) {
      await this.send(tabId, 'Target.setAutoAttach', AUTO_ATTACH).catch((e: unknown) => {
        this.reportChildGap(tabId, undefined, errorText(e));
      });
    }
  }

  /**
   * Set up one child session: enable its capture domains, follow its own
   * children, then let it run. Chrome holds a new child paused until
   * `Runtime.runIfWaitingForDebugger`, so the child is always resumed, or
   * released by detaching, even when setup fails.
   */
  private async onChildAttached(
    tabId: number,
    parentSessionId: string | undefined,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    if (!sessionId) return;
    const info = (params.targetInfo ?? {}) as Record<string, unknown>;
    const url = typeof info.url === 'string' ? info.url : '';
    const waiting = params.waitingForDebugger === true;
    const type = childType(info.type);

    if (!type || !this.attached.has(tabId)) {
      // Not something we record (a shared or service worker, say): let it go.
      await this.releaseChild(tabId, parentSessionId, sessionId, waiting);
      return;
    }

    const parent = parentSessionId ? this.children.get(parentSessionId)?.child : undefined;
    const child: ChildTarget = {
      sessionId,
      type,
      url,
      // Chrome only gives an iframe its own target when it is on another site.
      // A worker is same-origin with whatever started it.
      crossSite: type === 'iframe' || parent?.crossSite === true,
    };
    // Register before the first await so the child's earliest events route.
    this.children.set(sessionId, { tabId, child });

    try {
      for (const { method, params: p } of childEnableSequence(child.crossSite)) {
        await this.send(tabId, method, p, sessionId);
      }
      await this.send(tabId, 'Target.setAutoAttach', AUTO_ATTACH, sessionId);
    } catch (e) {
      this.children.delete(sessionId);
      this.reportChildGap(tabId, child, errorText(e));
      await this.releaseChild(tabId, parentSessionId, sessionId, waiting);
      return;
    }
    if (waiting) {
      await this.send(tabId, 'Runtime.runIfWaitingForDebugger', undefined, sessionId).catch(
        () => this.releaseChild(tabId, parentSessionId, sessionId, false),
      );
    }
  }

  /** Resume a paused child if possible, then detach from it. Never throws. */
  private async releaseChild(
    tabId: number,
    parentSessionId: string | undefined,
    sessionId: string,
    waiting: boolean,
  ): Promise<void> {
    if (waiting) {
      await this.send(tabId, 'Runtime.runIfWaitingForDebugger', undefined, sessionId).catch(() => {});
    }
    await this.send(tabId, 'Target.detachFromTarget', { sessionId }, parentSessionId).catch(() => {});
  }

  private reportChildGap(
    tabId: number,
    child: Pick<ChildTarget, 'type' | 'url'> | undefined,
    reason: string,
  ): void {
    if (!this.attached.has(tabId)) return; // tab already gone; its own detach is reported
    for (const h of this.childGapHandlers) h(tabId, child, reason);
  }

  private forgetChildren(tabId: number): void {
    for (const [sessionId, entry] of this.children) {
      if (entry.tabId === tabId) this.children.delete(sessionId);
    }
  }

  /**
   * Detach from a tab. Swallows the "not attached" error so callers can detach
   * unconditionally during teardown.
   */
  async detach(tabId: number): Promise<void> {
    this.attached.delete(tabId);
    this.forgetChildren(tabId);
    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        // Read lastError to consume it; "not attached" is expected and ignored.
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  /** Whether the tab has a child session of this type, such as a worker. */
  observes(tabId: number, type: ChildTarget['type']): boolean {
    for (const entry of this.children.values()) {
      if (entry.tabId === tabId && entry.child.type === type) return true;
    }
    return false;
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  attachedTabs(): number[] {
    return [...this.attached];
  }

  /**
   * Send a CDP command to a tab, or to one of its child sessions, and resolve
   * with its result. Rejects with a readable `Error` on `chrome.runtime.lastError`.
   */
  send<T = Record<string, unknown>>(
    tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<T> {
    const target: Debuggee = sessionId ? { tabId, sessionId } : { tabId };
    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(toReadableError(err.message, tabId));
          return;
        }
        resolve((result ?? {}) as T);
      });
    });
  }

  /** Register a handler for all CDP events (shares one underlying listener). */
  onEvent(h: CdpEventHandler): void {
    this.eventHandlers.push(h);
  }

  /** Register a handler for debugger detach (shares one underlying listener). */
  onDetach(h: DetachHandler): void {
    this.detachHandlers.push(h);
  }

  /** Register a handler for an iframe or worker that could not be observed. */
  onChildGap(h: ChildGapHandler): void {
    this.childGapHandlers.push(h);
  }

  /** Capture a JPEG screenshot of the tab. `data` is base64 (no `data:` prefix). */
  async captureScreenshot(
    tabId: number,
    quality: number,
  ): Promise<{ data: string }> {
    const result = await this.send<{ data: string }>(
      tabId,
      'Page.captureScreenshot',
      { format: 'jpeg', quality },
    );
    return { data: result.data };
  }

  /** Remove the shared listeners and detach from every attached tab. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    chrome.debugger.onEvent.removeListener(this.onEventListener);
    chrome.debugger.onDetach.removeListener(this.onDetachListener);

    const tabs = [...this.attached];
    this.attached.clear();
    this.children.clear();
    this.eventHandlers.length = 0;
    this.detachHandlers.length = 0;
    this.childGapHandlers.length = 0;

    for (const tabId of tabs) {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
      });
    }
  }
}
