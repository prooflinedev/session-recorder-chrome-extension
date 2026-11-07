/**
 * File-capture content script.
 *
 * Dormant until the background activates it (same hello/setActive handshake as
 * the interactions content script). While active it delegates, in the capture
 * phase, on the document: `change` events from `input[type=file]` and `drop`
 * events carrying `dataTransfer.files`. For each dropped/selected File it reads
 * a small file (<= 25MB) as a data URL and ships it as `capture/fileBlob`, or
 * emits a metadata-only `file-captured` event for larger files. Every path is
 * wrapped so the page's own upload flow is never disrupted.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { nearestHeading } from '@/lib/dom/descriptor';
import { onContentMessage, sendMessage } from '@/lib/messaging';
import type { FilePayload } from '@/lib/session/types';

/** Client-side hard cap (background enforces the real per-session cap). */
const MAX_INLINE_FILE_BYTES = 25 * 1024 * 1024;

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    // Guard against double-injection (manifest load + record-start injection).
    const w = window as unknown as { __srFileCapture?: boolean };
    if (w.__srFileCapture) return;
    w.__srFileCapture = true;

    let active = false;

    /** Read a File as a data URL. */
    function readDataUrl(file: File): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result === 'string') resolve(result);
          else reject(new Error('FileReader did not return a string'));
        };
        reader.onerror = () =>
          reject(reader.error ?? new Error('FileReader failed'));
        reader.readAsDataURL(file);
      });
    }

    /** Derive human context for where the file was provided. */
    function contextFor(el: Element | null): string | undefined {
      if (!el) return undefined;
      try {
        const heading = nearestHeading(el);
        if (heading) return heading;
      } catch {
        /* descriptor failed — fall through to aria-label */
      }
      const aria = el.getAttribute?.('aria-label');
      return aria ? aria.trim() || undefined : undefined;
    }

    /** Process a single captured file: ship blob (small) or metadata (large). */
    async function handleFile(file: File, target: Element | null): Promise<void> {
      try {
        const contextText = contextFor(target);
        const base: FilePayload = {
          fileName: file.name,
          mime: file.type,
          size: file.size,
          contextText,
        };

        if (file.size <= MAX_INLINE_FILE_BYTES) {
          const dataUrl = await readDataUrl(file);
          await sendMessage({
            kind: 'capture/fileBlob',
            event: { type: 'file-captured', payload: base },
            dataUrl,
          });
        } else {
          await sendMessage({
            kind: 'capture/event',
            event: {
              type: 'file-captured',
              payload: { ...base, metadataOnly: true },
            },
          });
        }
      } catch {
        /* never disrupt the page's own upload */
      }
    }

    /** Extract Files from an event and dispatch each, guarded. */
    function processFiles(
      files: FileList | null | undefined,
      target: Element | null,
    ): void {
      if (!files || files.length === 0) return;
      for (let i = 0; i < files.length; i++) {
        const file = files.item(i);
        if (!file) continue;
        void handleFile(file, target);
      }
    }

    function onChange(e: Event): void {
      if (!active) return;
      try {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.type !== 'file') return;
        processFiles(target.files, target);
      } catch {
        /* swallow — never interfere */
      }
    }

    function onDrop(e: DragEvent): void {
      if (!active) return;
      try {
        const dt = e.dataTransfer;
        if (!dt || !dt.files || dt.files.length === 0) return;
        const target = e.target instanceof Element ? e.target : null;
        processFiles(dt.files, target);
      } catch {
        /* swallow — never interfere */
      }
    }

    document.addEventListener('change', onChange, true);
    document.addEventListener('drop', onDrop, true);

    onContentMessage((msg) => {
      if (msg.kind === 'content/setActive') {
        active = msg.active;
      }
    });

    // Handshake: ask the background whether this tab is already recording.
    sendMessage({ kind: 'content/hello' })
      .then((res) => {
        active = res.active;
      })
      .catch(() => {
        /* background not ready / not recording — stay dormant */
      });
  },
});
