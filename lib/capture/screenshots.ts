/**
 * Screenshot scheduler: turns recorded events into de-duplicated screenshot
 * captures according to the session's `screenshotPolicy`.
 *
 * Runs in the background service worker. It asks the debugger for a JPEG, decodes
 * it to learn the dimensions, computes an average-hash to drop near-duplicates,
 * and (when the shot is novel) stores it and emits a `screenshot` event.
 */

import type {
  CaptureSettings,
  RawEvent,
  ScreenshotTrigger,
  SessionEvent,
} from '@/lib/session/types';
import { averageHashFromBlob, hammingHex } from '@/lib/util/hash';

export interface ScreenshotDeps {
  captureScreenshot: (
    tabId: number,
    quality: number,
  ) => Promise<{ data: string }>; // = DebuggerManager.captureScreenshot
  getSettings: () => CaptureSettings;
  emit: (raw: RawEvent) => void;
  storeScreenshot: (
    jpegBase64: string,
  ) => Promise<{ assetId: string; size: number }>;
}

/** Per-tab debounce window for the `every-interaction` policy. */
const DEBOUNCE_MS = 500;

/**
 * Longest-side cap for stored screenshots. Retina captures come in at ~2500px
 * and cost hundreds of KB each; anything above this is downscaled (aspect
 * preserved) and re-encoded before storage to keep the exported session small.
 */
const MAX_SHOT_DIM = 1400;

/** Event types that trigger a shot under the `every-interaction` policy. */
const EVERY_INTERACTION_TYPES: ReadonlySet<SessionEvent['type']> =
  new Set<SessionEvent['type']>([
    'click',
    'key',
    'scroll',
    'nav',
    'spa-route',
    'tab-switch',
  ]);

/** Tab-related event types that count as key moments. */
const TAB_TYPES: ReadonlySet<SessionEvent['type']> =
  new Set<SessionEvent['type']>(['tab-switch', 'tab-opened', 'tab-closed']);

/** Map an event type to the screenshot trigger it represents. */
function triggerForEvent(type: SessionEvent['type']): ScreenshotTrigger {
  if (type === 'nav' || type === 'spa-route') return 'nav';
  if (type === 'error' || type === 'net-request') return 'error';
  return 'interaction';
}

/** Decode a raw (non-prefixed) base64 string into a typed Blob. */
function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/** Encode a Blob's bytes as a raw (non-prefixed) base64 string. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class ScreenshotScheduler {
  private readonly deps: ScreenshotDeps;

  /** Pending debounce timer per tab (every-interaction policy). */
  private readonly debounceTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();

  /** Last stored screenshot's average-hash per tab, for dedup. */
  private readonly lastHashByTab = new Map<number, string>();

  /**
   * Advanced by `reset()`. A capture started before a reset belongs to the
   * session that has since ended, so it is dropped rather than stored or
   * emitted into whatever session is current when it finishes.
   */
  private generation = 0;

  constructor(deps: ScreenshotDeps) {
    this.deps = deps;
  }

  /** Apply the active policy to a just-recorded event. */
  onEvent(e: SessionEvent): void {
    try {
      const settings = this.deps.getSettings();
      const policy = settings.screenshotPolicy;
      if (policy === 'on-demand') return;

      const tabId = e.tabId;
      if (typeof tabId !== 'number') return;

      if (policy === 'every-interaction') {
        if (!EVERY_INTERACTION_TYPES.has(e.type)) return;
        const trigger = triggerForEvent(e.type);
        const existing = this.debounceTimers.get(tabId);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.debounceTimers.delete(tabId);
          void this.capture(tabId, trigger);
        }, DEBOUNCE_MS);
        this.debounceTimers.set(tabId, timer);
        return;
      }

      // policy === 'key-moments'
      let fire = false;
      if (
        e.type === 'nav' ||
        e.type === 'spa-route' ||
        e.type === 'error' ||
        TAB_TYPES.has(e.type)
      ) {
        fire = true;
      } else if (e.type === 'net-request') {
        // A pending request is flushed at stop: not a moment to capture now.
        const status = e.payload.status;
        if (typeof status === 'number' && status >= 400 && !e.payload.pending) fire = true;
      }
      if (!fire) return;

      void this.capture(tabId, triggerForEvent(e.type));
    } catch {
      /* never let scheduling break the capture funnel */
    }
  }

  /** Take an explicit/manual screenshot, applying dedup before storing. */
  async capture(
    tabId: number,
    trigger: ScreenshotTrigger,
    contextText?: string,
  ): Promise<void> {
    const generation = this.generation;
    try {
      const settings = this.deps.getSettings();
      const { data } = await this.deps.captureScreenshot(
        tabId,
        settings.screenshotQuality,
      );

      const originalBlob = base64ToBlob(data, 'image/jpeg');
      const bitmap = await createImageBitmap(originalBlob);
      const srcW = bitmap.width;
      const srcH = bitmap.height;

      // Downscale retina/oversized shots before storing: they dominate the
      // exported session size. Anything within MAX_SHOT_DIM is kept verbatim to
      // avoid a needless (and lossy) re-encode.
      let storeBase64 = data;
      let storeBlob = originalBlob;
      let width = srcW;
      let height = srcH;
      const longest = Math.max(srcW, srcH);
      if (longest > MAX_SHOT_DIM) {
        const scale = MAX_SHOT_DIM / longest;
        width = Math.max(1, Math.round(srcW * scale));
        height = Math.max(1, Math.round(srcH * scale));
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, width, height);
          const quality = Math.min(1, Math.max(0, settings.screenshotQuality / 100));
          storeBlob = await canvas.convertToBlob({
            type: 'image/jpeg',
            quality,
          });
          storeBase64 = await blobToBase64(storeBlob);
        } else {
          // No 2D context: fall back to the original, undownscaled dimensions.
          width = srcW;
          height = srcH;
        }
      }
      bitmap.close();

      // Hash the image we actually store so dedup compares like-for-like.
      const ahash = await averageHashFromBlob(storeBlob);

      // Explicit, user-driven captures are never deduped: a manual shot is
      // always wanted, and an annotation-exit shot MUST produce an asset so the
      // annotation event has a backing image. Only automatic capture (interaction
      // / nav / key-moment / error) is subject to near-duplicate suppression.
      const explicit = trigger === 'manual' || trigger === 'annotation';
      const last = this.lastHashByTab.get(tabId);
      if (
        !explicit &&
        last !== undefined &&
        hammingHex(ahash, last) <= settings.screenshotDedupThreshold
      ) {
        return; // near-duplicate — drop without storing or emitting
      }

      if (generation !== this.generation) return;
      const { assetId } = await this.deps.storeScreenshot(storeBase64);
      if (generation !== this.generation) return;
      this.deps.emit({
        type: 'screenshot',
        tabId,
        payload: {
          assetId,
          width,
          height,
          trigger,
          ahash,
          contextText,
        },
      });
      this.lastHashByTab.set(tabId, ahash);
    } catch {
      /* screenshot failures are non-fatal to the recording */
    }
  }

  /**
   * Clear pending timers and dedup state (session start and end), and drop
   * any capture still in flight.
   */
  reset(): void {
    this.generation += 1;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.lastHashByTab.clear();
  }
}
