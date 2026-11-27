// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { ContentMessage, ResponseFor } from '@/lib/messaging';
import { CURSOR_OVERLAY_HOST_ID } from './overlay';

const messaging = vi.hoisted(() => ({ send: vi.fn(), subscribe: vi.fn() }));
vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: (script: unknown) => script }));
vi.mock('@/lib/messaging', () => ({ sendMessage: messaging.send, onContentMessage: messaging.subscribe }));
import interactions from '../../entrypoints/interactions.content';

function context() {
  const abort = new AbortController();
  return {
    get isInvalid() { return abort.signal.aborted; },
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    addEventListener: (target: EventTarget, type: string, listener: EventListener) =>
      target.addEventListener(type, listener, { signal: abort.signal }),
    onInvalidated: (fn: () => void) => abort.signal.addEventListener('abort', fn),
    invalidate: () => abort.abort(),
  };
}
const hello: ResponseFor['content/hello'] = {
  active: true, annotating: false, pointing: false, micOn: false,
  cursorSpotlight: true, clickHighlight: true,
};
const contexts: ReturnType<typeof context>[] = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.invalidate();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('cursor recording lifecycle', () => {
  it('rechecks recording state after a persisted page is shown again', async () => {
    messaging.subscribe.mockReturnValueOnce(() => {});
    messaging.send.mockResolvedValue(hello);
    const ctx = context();
    contexts.push(ctx);
    interactions.main!(ctx as unknown as ContentScriptContext);
    await Promise.resolve();
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).not.toBeNull();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).toBeNull();
    messaging.send.mockResolvedValue({ ...hello, active: false });
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await Promise.resolve();
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).toBeNull();
    messaging.send.mockResolvedValue(hello);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await Promise.resolve();
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).not.toBeNull();
  });

  it('preserves pending input once across reinjection when effects are disabled', async () => {
    vi.useFakeTimers();
    messaging.subscribe.mockReturnValue(() => {});
    messaging.send.mockResolvedValue({ ...hello, cursorSpotlight: false, clickHighlight: false });
    document.body.innerHTML = '<input id="username" name="username">';
    const first = context();
    contexts.push(first);
    interactions.main!(first as unknown as ContentScriptContext);
    await Promise.resolve();
    const field = document.querySelector('input')!;
    field.value = 'pending edit';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    first.invalidate();
    const replacement = context();
    contexts.push(replacement);
    interactions.main!(replacement as unknown as ContentScriptContext);
    await Promise.resolve();
    field.dispatchEvent(new Event('change', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    const inputs = messaging.send.mock.calls.filter(([message]) => message.kind === 'capture/event' && message.event.type === 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]![0].event.payload.value).toBe('pending edit');
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).toBeNull();
  });

  it('keeps recording active when an annotation update overtakes hello', async () => {
    messaging.subscribe.mockReturnValueOnce(() => {});
    let resolve!: (reply: typeof hello) => void;
    messaging.send.mockReturnValueOnce(new Promise<typeof hello>((done) => { resolve = done; }));
    const ctx = context();
    contexts.push(ctx);
    interactions.main!(ctx as unknown as ContentScriptContext);
    const receive = messaging.subscribe.mock.calls[0]![0] as (msg: ContentMessage) => void;
    receive({ kind: 'content/point-annotate', on: true });
    resolve(hello);
    await Promise.resolve();
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).toBeNull();
    receive({ kind: 'content/point-annotate', on: false });
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).not.toBeNull();
  });

  it('does not let a delayed hello reactivate effects after stop', async () => {
    messaging.subscribe.mockReturnValueOnce(() => {});
    let resolve!: (reply: typeof hello) => void;
    messaging.send.mockReturnValueOnce(new Promise<typeof hello>((done) => { resolve = done; }));
    const ctx = context();
    contexts.push(ctx);
    interactions.main!(ctx as unknown as ContentScriptContext);
    const receive = messaging.subscribe.mock.calls[0]![0] as (msg: ContentMessage) => void;
    receive({ kind: 'content/setActive', active: false });
    resolve(hello);
    await Promise.resolve();
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).toBeNull();
  });

  it('cleans DOM, subscription and timers on invalidation', async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    messaging.subscribe.mockReturnValueOnce(unsubscribe);
    messaging.send.mockResolvedValue(hello);
    const ctx = context();
    contexts.push(ctx);
    interactions.main!(ctx as unknown as ContentScriptContext);
    await Promise.resolve();
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    ctx.invalidate();
    expect(document.getElementById(CURSOR_OVERLAY_HOST_ID)).toBeNull();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
