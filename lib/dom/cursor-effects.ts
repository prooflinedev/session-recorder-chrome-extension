/**
 * Lightweight, isolated live-page overlay for optional cursor spotlight and
 * click ripple visualization during recording.
 *
 * Uses a single Shadow DOM host with `pointer-events: none` and `aria-hidden`
 * so page interactions, layout, focus, and accessibility are unaffected.
 * Performs zero DOM or listener work when both options are disabled.
 */

import { CURSOR_OVERLAY_HOST_ID, isRecorderOverlay } from './overlay';

export const SPOTLIGHT_RADIUS = 28;
export const MAX_ACTIVE_RIPPLES = 8;
export const RIPPLE_DURATION_MS = 420;
export const REDUCED_MOTION_RIPPLE_MS = 220;
const CLEANUP_BUFFER_MS = 80;

export interface CursorEffectsOptions {
  spotlight: boolean;
  clickHighlight: boolean;
}

interface ActiveRipple {
  el: HTMLDivElement;
  timer: ReturnType<typeof setTimeout>;
}

const OVERLAY_STYLES = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  overflow: hidden !important;
  pointer-events: none !important;
  user-select: none !important;
  z-index: 2147483647 !important;
  display: block !important;
  contain: layout style !important;
}
:host::backdrop {
  display: none !important;
  pointer-events: none !important;
}
.layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  contain: strict;
}
.spotlight {
  position: fixed;
  left: 0;
  top: 0;
  width: ${SPOTLIGHT_RADIUS * 2}px;
  height: ${SPOTLIGHT_RADIUS * 2}px;
  border-radius: 9999px;
  pointer-events: none;
  will-change: transform;
  transform: translate3d(-9999px, -9999px, 0);
  background: radial-gradient(
    circle,
    rgba(59, 130, 246, 0.2) 0%,
    rgba(59, 130, 246, 0.09) 52%,
    rgba(59, 130, 246, 0) 74%
  );
  box-shadow:
    inset 0 0 0 1.5px rgba(37, 99, 235, 0.42),
    0 0 0 1px rgba(255, 255, 255, 0.58),
    0 0 18px rgba(15, 23, 42, 0.14);
}
.spotlight[hidden] {
  display: none;
}
.ripples {
  position: fixed;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.ripple {
  box-sizing: border-box;
  position: fixed;
  left: 0;
  top: 0;
  width: 48px;
  height: 48px;
  margin-left: -24px;
  margin-top: -24px;
  border-radius: 9999px;
  pointer-events: none;
  will-change: transform, opacity;
  border: 2px solid rgba(37, 99, 235, 0.9);
  background: rgba(59, 130, 246, 0.16);
  box-shadow:
    0 0 0 1.5px rgba(255, 255, 255, 0.72),
    0 0 12px rgba(37, 99, 235, 0.25);
  animation: sr-click-ripple ${RIPPLE_DURATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
@keyframes sr-click-ripple {
  0% {
    transform: translate3d(var(--sr-x), var(--sr-y), 0) scale(0.32);
    opacity: 0.95;
  }
  40% {
    opacity: 0.72;
  }
  100% {
    transform: translate3d(var(--sr-x), var(--sr-y), 0) scale(1.15);
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ripple {
    animation: sr-click-static ${REDUCED_MOTION_RIPPLE_MS}ms ease-out forwards;
  }
  @keyframes sr-click-static {
    0% {
      transform: translate3d(var(--sr-x), var(--sr-y), 0) scale(0.75);
      opacity: 0.9;
    }
    45% {
      opacity: 0.65;
    }
    100% {
      transform: translate3d(var(--sr-x), var(--sr-y), 0) scale(0.75);
      opacity: 0;
    }
  }
}
`;

/**
 * Manages the Shadow DOM cursor spotlight and bounded click ripple elements
 * for a single document frame.
 */
export class CursorEffectsOverlay {
  private spotlightEnabled = false;
  private clickEnabled = false;

  private host: HTMLDivElement | null = null;
  private spotlightEl: HTMLDivElement | null = null;
  private ripplesEl: HTMLDivElement | null = null;

  private abort: AbortController | null = null;
  private listenersAttached = false;
  private domWaiterAttached = false;

  private rafId = 0;
  private pendingX = 0;
  private pendingY = 0;
  private pointerVisible = false;
  private activeRipples: ActiveRipple[] = [];

  configure(options: CursorEffectsOptions): void {
    const wantSpotlight = options.spotlight === true;
    const wantClick = options.clickHighlight === true;

    if (!wantSpotlight && !wantClick) {
      this.dispose();
      return;
    }

    this.spotlightEnabled = wantSpotlight;
    this.clickEnabled = wantClick;

    if (!this.abort) {
      this.abort = new AbortController();
    }
    this.ensureMounted();
    this.ensureListeners();

    if (!this.spotlightEnabled) {
      this.hideSpotlight();
    }
    if (!this.clickEnabled) {
      this.clearRipples();
    }
  }

  dispose(): void {
    this.spotlightEnabled = false;
    this.clickEnabled = false;
    this.cancelPendingFrame();
    this.pointerVisible = false;
    this.clearRipples();

    this.abort?.abort();
    this.abort = null;
    this.listenersAttached = false;
    this.domWaiterAttached = false;

    if (this.host) {
      this.safeHidePopover(this.host);
      this.host.remove();
    }
    this.host = null;
    this.spotlightEl = null;
    this.ripplesEl = null;
  }

  private ensureMounted(): void {
    if (!this.spotlightEnabled && !this.clickEnabled) return;

    const rootEl = document.documentElement;
    if (!rootEl) {
      if (!this.domWaiterAttached && this.abort) {
        this.domWaiterAttached = true;
        document.addEventListener(
          'DOMContentLoaded',
          () => {
            this.domWaiterAttached = false;
            this.ensureMounted();
          },
          { once: true, signal: this.abort.signal },
        );
      }
      return;
    }

    if (!this.host) {
      const host = document.createElement('div');
      host.id = CURSOR_OVERLAY_HOST_ID;
      host.setAttribute('aria-hidden', 'true');
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = OVERLAY_STYLES;

      const layer = document.createElement('div');
      layer.className = 'layer';

      const spotlight = document.createElement('div');
      spotlight.className = 'spotlight';
      spotlight.hidden = true;

      const ripples = document.createElement('div');
      ripples.className = 'ripples';

      layer.append(spotlight, ripples);
      root.append(style, layer);

      this.host = host;
      this.spotlightEl = spotlight;
      this.ripplesEl = ripples;
    }

    if (!this.host.isConnected) {
      rootEl.append(this.host);
      this.promoteToTopLayer();
    }
  }

  private promoteToTopLayer(): void {
    const host = this.host;
    if (!host || !host.isConnected) return;
    if (typeof host.showPopover !== 'function') return;
    try {
      host.setAttribute('popover', 'manual');
      if (typeof host.matches === 'function' && host.matches(':popover-open')) {
        host.hidePopover();
      }
      host.showPopover();
    } catch {
      host.removeAttribute('popover');
    }
  }

  private safeHidePopover(host: HTMLDivElement): void {
    if (typeof host.hidePopover !== 'function') return;
    try {
      if (typeof host.matches === 'function' && host.matches(':popover-open')) {
        host.hidePopover();
      }
    } catch {
      /* ignore teardown errors */
    }
  }

  private ensureListeners(): void {
    if (this.listenersAttached || !this.abort) return;
    this.listenersAttached = true;
    const signal = this.abort.signal;

    const onPointerMove = (e: Event): void => {
      if (!this.spotlightEnabled || !e.isTrusted) return;
      const pe = e as PointerEvent;
      if (pe.pointerType === 'touch') {
        this.hideSpotlight();
        return;
      }
      const me = e as MouseEvent;
      if (!Number.isFinite(me.clientX) || !Number.isFinite(me.clientY)) return;
      this.scheduleSpotlight(me.clientX, me.clientY);
    };

    const onPointerDown = (e: Event): void => {
      const pe = e as PointerEvent;
      if (pe.pointerType === 'touch') {
        this.hideSpotlight();
      }
    };

    const onMouseOut = (e: MouseEvent): void => {
      if (e.relatedTarget === null) this.hideSpotlight();
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') this.hideSpotlight();
    };

    const onResize = (): void => {
      if (
        this.pointerVisible &&
        (this.pendingX < 0 ||
          this.pendingY < 0 ||
          this.pendingX > window.innerWidth ||
          this.pendingY > window.innerHeight)
      ) {
        this.hideSpotlight();
      }
    };

    const onClick = (e: MouseEvent): void => {
      if (!this.clickEnabled || !e.isTrusted) return;
      if (isRecorderOverlay(e.target)) return;
      // Keyboard activation on buttons/links dispatches click at (0, 0) with detail === 0.
      if (e.detail === 0 && e.clientX === 0 && e.clientY === 0) return;
      if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
      this.spawnRipple(e.clientX, e.clientY);
    };

    const onFullscreenChange = (): void => {
      this.ensureMounted();
      this.promoteToTopLayer();
    };

    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true, signal });
    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true, signal });
    document.addEventListener('pointerleave', () => this.hideSpotlight(), { signal });
    document.addEventListener('mouseout', onMouseOut, { capture: true, passive: true, signal });
    document.addEventListener('visibilitychange', onVisibilityChange, { signal });
    document.addEventListener('fullscreenchange', onFullscreenChange, { signal });
    // A newly opened dialog/popover otherwise paints above our existing top-layer entry.
    document.addEventListener('toggle', (e) => {
      if (e.target instanceof HTMLElement && e.target !== this.host &&
          e.target.matches('dialog[open], :popover-open')) this.promoteToTopLayer();
    }, { capture: true, signal });
    // Native drag-and-drop stops pointermove delivery; do not leave a stale halo behind.
    document.addEventListener('dragstart', () => this.hideSpotlight(), { capture: true, signal });
    document.addEventListener('click', onClick, { capture: true, passive: true, signal });
    window.addEventListener('blur', () => this.hideSpotlight(), { signal });
    window.addEventListener('resize', onResize, { passive: true, signal });
  }

  private scheduleSpotlight(x: number, y: number): void {
    this.pendingX = x;
    this.pendingY = y;
    this.pointerVisible = true;
    if (this.rafId !== 0) return;

    const raf =
      typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;

    this.rafId = raf(() => {
      this.rafId = 0;
      if (!this.spotlightEnabled || !this.pointerVisible) return;
      this.ensureMounted();
      const el = this.spotlightEl;
      if (!el) return;
      if (el.hidden) el.hidden = false;
      el.style.transform = `translate3d(${this.pendingX - SPOTLIGHT_RADIUS}px, ${this.pendingY - SPOTLIGHT_RADIUS}px, 0)`;
    });
  }

  private hideSpotlight(): void {
    this.pointerVisible = false;
    this.cancelPendingFrame();
    if (this.spotlightEl && !this.spotlightEl.hidden) {
      this.spotlightEl.hidden = true;
    }
  }

  private cancelPendingFrame(): void {
    if (this.rafId === 0) return;
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.rafId);
    } else {
      clearTimeout(this.rafId);
    }
    this.rafId = 0;
  }

  private isReducedMotion(): boolean {
    try {
      return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch {
      return false;
    }
  }

  private spawnRipple(x: number, y: number): void {
    this.ensureMounted();
    const container = this.ripplesEl;
    if (!container) return;

    while (this.activeRipples.length >= MAX_ACTIVE_RIPPLES) {
      const oldest = this.activeRipples.shift()!;
      clearTimeout(oldest.timer);
      oldest.el.remove();
    }

    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.setProperty('--sr-x', `${x}px`);
    el.style.setProperty('--sr-y', `${y}px`);

    const duration = this.isReducedMotion()
      ? REDUCED_MOTION_RIPPLE_MS
      : RIPPLE_DURATION_MS;

    const entry: ActiveRipple = {
      el,
      timer: setTimeout(() => this.removeRipple(entry), duration + CLEANUP_BUFFER_MS),
    };
    this.activeRipples.push(entry);

    el.addEventListener('animationend', () => this.removeRipple(entry), { once: true });
    el.addEventListener('animationcancel', () => this.removeRipple(entry), { once: true });
    container.append(el);
  }

  private removeRipple(entry: ActiveRipple): void {
    clearTimeout(entry.timer);
    const idx = this.activeRipples.indexOf(entry);
    if (idx >= 0) this.activeRipples.splice(idx, 1);
    entry.el.remove();
  }

  private clearRipples(): void {
    for (const entry of this.activeRipples) {
      clearTimeout(entry.timer);
      entry.el.remove();
    }
    this.activeRipples = [];
  }
}
