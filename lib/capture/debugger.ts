/**
 * Thin wrapper over `chrome.debugger` (CDP protocol `1.3`).
 *
 * Owns the debugger attachment for every session tab: attaching enables the
 * Network/Page/Runtime/Log domains, `send()` promisifies `sendCommand`, and a
 * single `onEvent`/`onDetach` pair (registered once in the constructor) fans out
 * to the capturers that register handlers. All the ugly `chrome.runtime.lastError`
 * plumbing and the human-readable error phrasing live here so the callers can
 * work in plain async/await.
 *
 * Every attachment belongs to one owner (a recording session id). Only the
 * owner can detach it, and a different owner attaching the same tab first
 * releases the old attachment and makes its own. So work left over from an
 * ended session (a late adoption, an enable rollback) can never detach or reuse
 * a newer session's attachment.
 *
 * Releasing waits only for Chrome to confirm the attach, never for the capture
 * domains to finish enabling (an enable can hang, e.g. after a renderer crash).
 * An enable that answers after its attachment was released sends nothing
 * further and changes nothing.
 *
 * `onDetach` names only a tab, not which attachment ended, so a detach event is
 * checked before it is believed: see `onDetachListener`.
 */

/** A CDP protocol event, routed to every registered handler. */
export type CdpEventHandler = (
  tabId: number,
  method: string,
  params: Record<string, unknown>,
) => void;

/** Fired when the debugger detaches from a tab (DevTools opened, tab closed, …). */
export type DetachHandler = (tabId: number, reason: string) => void;

/** The recording session that owns an attachment (its session id). */
export type AttachOwner = string;

/** One tab's attachment, from the moment `attach()` is called. */
interface Attachment {
  owner: AttachOwner;
  /** Chrome confirmed the attach; the capture domains may still be enabling. */
  connected: boolean;
  /** Settles when Chrome answers the attach (rejects if it failed or was cancelled). */
  confirmed: Promise<void>;
  /** Settles once the attach, including enabling the domains, has finished. */
  ready: Promise<void>;
}

const PROTOCOL_VERSION = '1.3';

/**
 * Probe sent to check whether a detach event is about the current attachment.
 * Chrome answers it in the browser process, so it stays fast even when the
 * page's renderer is busy or has crashed (unlike `Runtime.evaluate` or
 * `Page.getFrameTree`).
 */
const DETACH_PROBE = 'Target.getTargetInfo';

/**
 * The probe errors Chrome was observed to return once this extension's session
 * on the tab is gone. Any other error proves nothing, so the attachment is kept.
 */
const DETACHED_ERRORS = [
  'debugger is not attached', // detached (by us or by Chrome)
  'no tab with given id', // tab closed
  'cannot access a chrome://', // navigated to an undebuggable page
  'detached while handling command', // detached while the probe was pending
];

function cancelled(tabId: number): Error {
  return new Error(`Debugger attach to tab ${tabId} was cancelled.`);
}

function isDetachedError(message: string): boolean {
  const lower = message.toLowerCase();
  return DETACHED_ERRORS.some((e) => lower.includes(e));
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

export class DebuggerManager {
  private readonly attachments = new Map<number, Attachment>();
  private readonly eventHandlers: CdpEventHandler[] = [];
  private readonly detachHandlers: DetachHandler[] = [];
  private disposed = false;

  /** Bound listeners, kept so they can be removed in `dispose()`. */
  private readonly onEventListener = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): void => {
    if (source.tabId === undefined) return;
    const tabId = source.tabId;
    const p = (params ?? {}) as Record<string, unknown>;
    for (const h of this.eventHandlers) {
      h(tabId, method, p);
    }
  };

  private readonly onDetachListener = (
    source: chrome.debugger.Debuggee,
    reason: string,
  ): void => {
    if (source.tabId === undefined) return;
    const tabId = source.tabId;
    const attachment = this.attachments.get(tabId);
    // No record: nothing of ours to forget. Not confirmed yet: the event is
    // about an earlier session on the tab (Chrome reports that detach before it
    // confirms a new attach); if this attach dies too, enabling its domains
    // fails and rolls it back.
    if (!attachment || !attachment.connected) return;

    // The event carries no attachment identity, so ask Chrome whether our
    // session on the tab is still alive before believing it. Each event gets
    // its own probe; the first to prove a detach forgets the record, which
    // turns every later answer into a no-op.
    chrome.debugger.sendCommand({ tabId }, DETACH_PROBE, {}, () => {
      const message = chrome.runtime.lastError?.message;
      // Released, replaced or disposed meanwhile: the answer is about an
      // attachment we no longer hold, so it must not touch the current one.
      if (this.disposed || this.attachments.get(tabId) !== attachment) return;
      // Alive (a stale event), or an error that doesn't prove a detach: keep it.
      if (message === undefined || !isDetachedError(message)) return;

      // Chrome really ended it (tab closed, DevTools opened, …). Forgetting the
      // record first means a repeat event finds nothing, so handlers hear once.
      this.forget(tabId, attachment);
      attachment.connected = false;
      for (const h of this.detachHandlers) {
        h(tabId, reason);
      }
    });
  };

  constructor() {
    chrome.debugger.onEvent.addListener(this.onEventListener);
    chrome.debugger.onDetach.addListener(this.onDetachListener);
  }

  /**
   * Attach the debugger to a tab for `owner` and enable the capture domains.
   * Throws an `Error` with a human-readable `.message` on failure.
   *
   * The attachment is registered synchronously, before any await, so a
   * `detachAll(owner)` that runs while the attach is in flight still sees it.
   * The same owner attaching again shares the existing attempt. A different
   * owner waits for Chrome to answer the existing attempt, releases it, and
   * attaches fresh: an attachment is never shared across owners.
   *
   * Rejects if the attachment is released (Stop, a takeover) before its
   * domains finished enabling, since it then isn't capturing.
   */
  async attach(tabId: number, owner: AttachOwner): Promise<void> {
    for (;;) {
      const existing = this.attachments.get(tabId);
      if (!existing) break;
      if (existing.owner === owner) return existing.ready;
      await existing.confirmed.catch(() => {});
      if (this.attachments.get(tabId) === existing) {
        await this.release(tabId, existing);
      }
    }
    const attachment: Attachment = {
      owner,
      connected: false,
      confirmed: Promise.resolve(),
      ready: Promise.resolve(),
    };
    this.attachments.set(tabId, attachment);
    attachment.confirmed = this.connect(tabId, attachment);
    attachment.ready = attachment.confirmed.then(() => this.enableDomains(tabId, attachment));
    return attachment.ready;
  }

  /**
   * Detach `owner`'s attachment to a tab, after Chrome has answered an attach
   * still in flight (but without waiting for its domains to enable). Does
   * nothing, and resolves `false`, when the tab isn't attached or belongs to
   * another owner, so a stale caller can never detach a newer session's tab.
   * Never rejects.
   */
  async detach(tabId: number, owner: AttachOwner): Promise<boolean> {
    const attachment = this.attachments.get(tabId);
    if (!attachment || attachment.owner !== owner) return false;
    await attachment.confirmed.catch(() => {});
    if (this.attachments.get(tabId) !== attachment) return false;
    await this.release(tabId, attachment);
    return true;
  }

  /**
   * Detach every attachment `owner` holds, including attaches still in flight
   * (each waits for Chrome's answer first). Returns the tabs detached. Never
   * rejects.
   */
  async detachAll(owner: AttachOwner): Promise<number[]> {
    const tabs = [...this.attachments]
      .filter(([, a]) => a.owner === owner)
      .map(([tabId]) => tabId);
    const detached: number[] = [];
    for (const tabId of tabs) {
      if (await this.detach(tabId, owner)) detached.push(tabId);
    }
    return detached;
  }

  /** True once Chrome has confirmed an attachment to the tab (any owner). */
  isAttached(tabId: number): boolean {
    return this.attachments.get(tabId)?.connected === true;
  }

  /** The owner of the tab's attachment, attached or still attaching. */
  ownerOf(tabId: number): AttachOwner | undefined {
    return this.attachments.get(tabId)?.owner;
  }

  attachedTabs(): number[] {
    return [...this.attachments]
      .filter(([, a]) => a.connected)
      .map(([tabId]) => tabId);
  }

  /** Attach in Chrome for one registered attachment; resolves once confirmed. */
  private async connect(tabId: number, attachment: Attachment): Promise<void> {
    try {
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
    } catch (e) {
      this.forget(tabId, attachment);
      throw e;
    }

    if (this.attachments.get(tabId) !== attachment) {
      // Dropped while Chrome was attaching (the manager was disposed). Nobody
      // owns this attachment any more, so undo it rather than leak it.
      await this.chromeDetach(tabId);
      throw cancelled(tabId);
    }
    attachment.connected = true;
  }

  /**
   * Enable the capture domains on a confirmed attachment. Commands go to the
   * tab, not to an attachment, so before each one the record is checked: once
   * this attachment is released, nothing more is sent (it would reach whoever
   * holds the tab now) and nothing is rolled back.
   */
  private async enableDomains(tabId: number, attachment: Attachment): Promise<void> {
    for (const { method, params } of ENABLE_SEQUENCE) {
      if (this.attachments.get(tabId) !== attachment) throw cancelled(tabId);
      try {
        await this.send(tabId, method, params);
      } catch (e) {
        // Enabling failed after a successful attach: roll back this attachment
        // only (never one that has since replaced it), then surface the error.
        if (this.attachments.get(tabId) === attachment) {
          await this.release(tabId, attachment);
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
    }
    if (this.attachments.get(tabId) !== attachment) throw cancelled(tabId);
  }

  /** Remove an attachment's record and, if Chrome attached it, detach it. */
  private async release(tabId: number, attachment: Attachment): Promise<void> {
    this.forget(tabId, attachment);
    if (attachment.connected) {
      attachment.connected = false;
      await this.chromeDetach(tabId);
    }
  }

  /** Drop the record only if it is still this attachment. */
  private forget(tabId: number, attachment: Attachment): void {
    if (this.attachments.get(tabId) === attachment) this.attachments.delete(tabId);
  }

  /**
   * Detach in Chrome. Chrome's error is read and ignored: for an
   * extension-owned attachment it can only mean the target is already gone
   * (tab closed or detached by Chrome), so nothing is left attached either way.
   */
  private chromeDetach(tabId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  /**
   * Send a CDP command to a tab and resolve with its result. Rejects with a
   * readable `Error` on `chrome.runtime.lastError`.
   */
  send<T = Record<string, unknown>>(
    tabId: number,
    method: string,
    params?: object,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
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

    // Attaches still in flight see their record gone and undo themselves.
    const tabs = this.attachedTabs();
    this.attachments.clear();
    this.eventHandlers.length = 0;
    this.detachHandlers.length = 0;

    for (const tabId of tabs) {
      void this.chromeDetach(tabId);
    }
  }
}
