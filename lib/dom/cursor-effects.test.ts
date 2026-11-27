// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CursorEffectsOverlay,
  MAX_ACTIVE_RIPPLES,
  REDUCED_MOTION_RIPPLE_MS,
  RIPPLE_DURATION_MS,
  SPOTLIGHT_RADIUS,
} from './cursor-effects';
import { CURSOR_OVERLAY_HOST_ID, isRecorderOverlay } from './overlay';

function hostEl(): HTMLElement | null {
  return document.getElementById(CURSOR_OVERLAY_HOST_ID);
}

describe('CursorEffectsOverlay', () => {
  let overlay: CursorEffectsOverlay;
  let rafQueue: FrameRequestCallback[];
  let origRaf: typeof globalThis.requestAnimationFrame;
  let origCancelRaf: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="btn">Go</button>';
    rafQueue = [];
    origRaf = globalThis.requestAnimationFrame;
    origCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    globalThis.cancelAnimationFrame = (id: number) => {
      const idx = id - 1;
      if (idx >= 0 && idx < rafQueue.length) {
        rafQueue[idx] = () => {};
      }
    };
    // jsdom cannot create trusted events. Model browser delivery through the
    // real listeners; the E2E suite checks that page-dispatched events are ignored.
    const add = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener && ['pointermove', 'click'].includes(type)) {
        add(type, (event) => {
          const trusted = new Proxy(event, {
            get: (target, key) => key === 'isTrusted' ? true : Reflect.get(target, key, target),
          });
          if (typeof listener === 'function') listener.call(document, trusted);
          else listener.handleEvent(trusted);
        }, options);
      } else add(type, listener, options);
    });
    overlay = new CursorEffectsOverlay();
  });

  afterEach(() => {
    overlay.dispose();
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancelRaf;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function flushRaf(): void {
    const queue = rafQueue.splice(0);
    for (const cb of queue) cb(performance.now());
  }

  it('mounts nothing when both options are disabled', () => {
    overlay.configure({ spotlight: false, clickHighlight: false });
    expect(hostEl()).toBeNull();

    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 60 }));
    document.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 60, detail: 1 }));
    flushRaf();
    expect(hostEl()).toBeNull();
  });

  it('isolates the overlay in shadow DOM with pointer-events none and aria-hidden', () => {
    overlay.configure({ spotlight: true, clickHighlight: false });
    const host = hostEl();
    expect(host).not.toBeNull();
    expect(host!.getAttribute('aria-hidden')).toBe('true');
    expect(isRecorderOverlay(host)).toBe(true);

    const root = host!.shadowRoot!;
    const css = root.querySelector('style')?.textContent ?? '';
    expect(css).toContain('all: initial !important');
    expect(css).toContain('pointer-events: none !important');
  });

  it('tracks pointer movements smoothly via a single coalesced rAF and hides on leave/blur', () => {
    overlay.configure({ spotlight: true, clickHighlight: false });
    const spotlight = hostEl()!.shadowRoot!.querySelector('.spotlight') as HTMLElement;
    expect(spotlight.hidden).toBe(true);

    // High-frequency consecutive moves coalesce into one rAF update at latest coords.
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 20 }));
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 150 }));
    expect(rafQueue).toHaveLength(1);
    flushRaf();

    expect(spotlight.hidden).toBe(false);
    expect(spotlight.style.transform).toBe(
      `translate3d(${100 - SPOTLIGHT_RADIUS}px, ${150 - SPOTLIGHT_RADIUS}px, 0)`,
    );

    // Leaving the viewport hides the spotlight.
    document.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null }));
    expect(spotlight.hidden).toBe(true);

    // Re-entering restores it at the new position.
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 240, clientY: 80 }));
    flushRaf();
    expect(spotlight.hidden).toBe(false);
    expect(spotlight.style.transform).toBe(
      `translate3d(${240 - SPOTLIGHT_RADIUS}px, ${80 - SPOTLIGHT_RADIUS}px, 0)`,
    );

    // Window blur also hides it.
    window.dispatchEvent(new Event('blur'));
    expect(spotlight.hidden).toBe(true);
  });

  it('supports independent toggles: click ripples only when clickHighlight is enabled', () => {
    overlay.configure({ spotlight: false, clickHighlight: true });
    const root = hostEl()!.shadowRoot!;
    const spotlight = root.querySelector('.spotlight') as HTMLElement;

    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 90 }));
    flushRaf();
    expect(spotlight.hidden).toBe(true);

    document.dispatchEvent(new MouseEvent('click', { clientX: 125, clientY: 230, detail: 1 }));
    const ripples = root.querySelectorAll('.ripple');
    expect(ripples).toHaveLength(1);
    const r = ripples[0] as HTMLElement;
    expect(r.style.getPropertyValue('--sr-x')).toBe('125px');
    expect(r.style.getPropertyValue('--sr-y')).toBe('230px');

    // Cleans up automatically after duration + buffer even without animationend.
    vi.advanceTimersByTime(RIPPLE_DURATION_MS + 100);
    expect(root.querySelectorAll('.ripple')).toHaveLength(0);
  });

  it('ignores keyboard-synthesized clicks at (0,0) with detail === 0', () => {
    overlay.configure({ spotlight: false, clickHighlight: true });
    const root = hostEl()!.shadowRoot!;

    document.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0, detail: 0 }));
    expect(root.querySelectorAll('.ripple')).toHaveLength(0);

    // Real pointer clicks at (0,0) have detail >= 1 and do render.
    document.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0, detail: 1 }));
    expect(root.querySelectorAll('.ripple')).toHaveLength(1);
  });

  it('bounds concurrent ripple elements during rapid consecutive clicks', () => {
    overlay.configure({ spotlight: false, clickHighlight: true });
    const root = hostEl()!.shadowRoot!;

    for (let i = 0; i < MAX_ACTIVE_RIPPLES + 5; i++) {
      document.dispatchEvent(
        new MouseEvent('click', { clientX: 10 + i, clientY: 20 + i, detail: 1 }),
      );
    }

    const ripples = root.querySelectorAll('.ripple');
    expect(ripples).toHaveLength(MAX_ACTIVE_RIPPLES);
    // Oldest ripples were evicted; latest coordinates remain.
    expect((ripples[ripples.length - 1] as HTMLElement).style.getPropertyValue('--sr-x')).toBe(
      `${10 + MAX_ACTIVE_RIPPLES + 4}px`,
    );

    // All remaining ripples clean up on animationend or timeout.
    ripples[0]!.dispatchEvent(new Event('animationend'));
    expect(root.querySelectorAll('.ripple')).toHaveLength(MAX_ACTIVE_RIPPLES - 1);

    vi.advanceTimersByTime(RIPPLE_DURATION_MS + 100);
    expect(root.querySelectorAll('.ripple')).toHaveLength(0);
  });

  it('uses shorter reduced-motion timing and static reduced-motion CSS rule', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    overlay.configure({ spotlight: false, clickHighlight: true });
    const root = hostEl()!.shadowRoot!;
    const cssText = root.querySelector('style')?.textContent ?? '';
    expect(cssText).toContain('prefers-reduced-motion: reduce');

    document.dispatchEvent(new MouseEvent('click', { clientX: 40, clientY: 50, detail: 1 }));
    expect(root.querySelectorAll('.ripple')).toHaveLength(1);

    vi.advanceTimersByTime(REDUCED_MOTION_RIPPLE_MS + 100);
    expect(root.querySelectorAll('.ripple')).toHaveLength(0);
  });

  it('fully cleans up DOM, timers, and listeners on dispose and supports repeated cycles', () => {
    overlay.configure({ spotlight: true, clickHighlight: true });
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }));
    document.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50, detail: 1 }));
    expect(hostEl()).not.toBeNull();

    overlay.dispose();
    expect(hostEl()).toBeNull();

    // Events after dispose do nothing.
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 80 }));
    document.dispatchEvent(new MouseEvent('click', { clientX: 80, clientY: 80, detail: 1 }));
    flushRaf();
    expect(hostEl()).toBeNull();

    // Re-enabling mounts cleanly without duplicate hosts.
    overlay.configure({ spotlight: true, clickHighlight: true });
    expect(document.querySelectorAll(`#${CURSOR_OVERLAY_HOST_ID}`)).toHaveLength(1);
  });

  it('hides spotlight on touch input, tab hidden, and out-of-bounds viewport resize', () => {
    overlay.configure({ spotlight: true, clickHighlight: false });
    const spotlight = hostEl()!.shadowRoot!.querySelector('.spotlight') as HTMLElement;

    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 600, clientY: 500 }));
    flushRaf();
    expect(spotlight.hidden).toBe(false);

    // Resizing viewport smaller than pointer position hides spotlight.
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(spotlight.hidden).toBe(true);

    // Move inside resized viewport, then hide document visibility.
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 120 }));
    flushRaf();
    expect(spotlight.hidden).toBe(false);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(spotlight.hidden).toBe(true);

    // Touch movement hides the halo; compatibility mouse events must not restore it.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const touchMove = new Event('pointermove') as Event & { pointerType: string };
    touchMove.pointerType = 'touch';
    document.dispatchEvent(touchMove);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50 }));
    flushRaf();
    expect(spotlight.hidden).toBe(true);
  });

  it('re-attaches host if detached from DOM before next interaction', () => {
    overlay.configure({ spotlight: true, clickHighlight: true });
    const host = hostEl()!;
    host.remove();
    expect(hostEl()).toBeNull();

    document.dispatchEvent(new MouseEvent('click', { clientX: 45, clientY: 55, detail: 1 }));
    expect(hostEl()).not.toBeNull();
    expect(hostEl()!.shadowRoot!.querySelectorAll('.ripple')).toHaveLength(1);
  });
});
