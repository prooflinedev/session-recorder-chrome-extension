import { flattenRedactions, normalizeRedactionRect, sha256Blob } from '@/lib/capture/screenshot-redaction';
import { getAsset, saveScreenshotRedaction } from '@/lib/storage';
import { broadcast } from '@/lib/messaging';
import { screenshotRedactionLock } from '@/lib/capture/redaction-lock';
import type { Asset, RedactionRect } from '@/lib/session/types';

function button(text: string, className: string): HTMLButtonElement {
  const result = document.createElement('button');
  result.type = 'button';
  result.className = className;
  result.textContent = text;
  return result;
}

export async function openRedactionEditor(
  assetId: string,
  returnFocus: HTMLElement,
  onSaved: (asset: Asset) => void,
): Promise<void> {
  const asset = await getAsset(assetId);
  if (!asset || asset.kind !== 'screenshot') throw new Error('Screenshot unavailable. Reload the report and try again.');
  const expectedRevision = asset.localScreenshotRedaction?.revision ?? 0;
  const original = asset.localScreenshotRedaction?.originalBlob ?? asset.blob;
  let masks = structuredClone(asset.localScreenshotRedaction?.rectangles ?? []);
  let selected = masks.length - 1;
  let drawing = false;
  let saving = false;
  type Gesture =
    | { kind: 'draw'; pointerId: number; start: { x: number; y: number } }
    | { kind: 'move' | 'resize'; pointerId: number; index: number; start: { x: number; y: number }; original: RedactionRect; changed: boolean };
  let gesture: Gesture | undefined;
  let drawPreview: HTMLElement | undefined;
  let undo: RedactionRect[][] = [];
  const url = URL.createObjectURL(original);

  const dialog = document.createElement('dialog');
  dialog.className = 'r-redact';
  dialog.setAttribute('aria-labelledby', 'r-redact-title');
  dialog.setAttribute('aria-describedby', 'r-redact-scope');
  const panel = document.createElement('div');
  panel.className = 'r-redact__panel';
  const header = document.createElement('header');
  header.className = 'r-redact__header';
  const title = document.createElement('h2');
  title.id = 'r-redact-title';
  title.textContent = 'Redact screenshot';
  const close = button('×', 'r-redact__icon');
  close.setAttribute('aria-label', 'Close');
  header.append(title, close);
  const scope = document.createElement('p');
  scope.id = 'r-redact-scope';
  scope.className = 'r-redact__scope';
  scope.textContent = 'Covers this screenshot only. Video, audio, and captured text are unchanged.';
  const draftKey = `shareDraft:${asset.sessionId}`;
  const draftState = (await chrome.storage.local.get(draftKey))[draftKey] as { publication?: unknown } | undefined;
  const publishedNote = document.createElement('p');
  publishedNote.className = 'r-redact__scope';
  if (draftState?.publication) {
    publishedNote.textContent = 'An existing shared copy will not change. Remove it before publishing the updated screenshots.';
  }
  const stage = document.createElement('div');
  stage.className = 'r-redact__stage';
  const imageWrap = document.createElement('div');
  imageWrap.className = 'r-redact__image-wrap';
  const image = document.createElement('img');
  image.src = url;
  image.alt = 'Screenshot being edited';
  const overlay = document.createElement('div');
  overlay.className = 'r-redact__overlay';
  imageWrap.append(image, overlay);
  stage.appendChild(imageWrap);
  const toolRow = document.createElement('div');
  toolRow.className = 'r-redact__tools';
  const draw = button('Draw mask', 'btn');
  draw.setAttribute('aria-pressed', 'false');
  const undoButton = button('Undo', 'btn');
  const clear = button('Clear all', 'btn');
  toolRow.append(draw, undoButton, clear);
  const maskList = document.createElement('div');
  maskList.className = 'r-redact__list';
  maskList.setAttribute('role', 'group');
  maskList.setAttribute('aria-label', 'Screenshot masks');
  const hint = document.createElement('p');
  hint.className = 'r-redact__hint';
  const remove = button('Remove selected', 'btn');
  const message = document.createElement('p');
  message.className = 'r-redact__message';
  message.setAttribute('role', 'status');
  const footer = document.createElement('footer');
  footer.className = 'r-redact__footer';
  const cancel = button('Cancel', 'btn');
  const apply = button('Apply', 'btn btn--primary');
  footer.append(cancel, apply);
  panel.append(header, scope);
  if (publishedNote.textContent) panel.appendChild(publishedNote);
  panel.append(stage, toolRow, maskList, hint, remove, message, footer);
  dialog.appendChild(panel);
  document.body.appendChild(dialog);

  const cloneMasks = (): RedactionRect[] => masks.map((mask) => ({ ...mask }));
  const recordUndo = (): void => { undo.push(cloneMasks()); undoButton.disabled = false; };
  const closeDialog = (): void => {
    if (saving) return;
    dialog.close();
  };
  const sync = (): void => {
    const focusedMask = Array.from(maskList.children).indexOf(document.activeElement as HTMLElement);
    overlay.replaceChildren();
    drawPreview = undefined;
    masks.forEach((mask, index) => {
      const box = document.createElement('div');
      box.className = 'r-redact__mask' + (index === selected ? ' is-selected' : '');
      box.style.left = `${mask.x * 100}%`;
      box.style.top = `${mask.y * 100}%`;
      box.style.width = `${mask.width * 100}%`;
      box.style.height = `${mask.height * 100}%`;
      box.setAttribute('aria-hidden', 'true');
      box.addEventListener('pointerdown', (event) => {
        if (drawing || saving || !image.naturalWidth || !image.naturalHeight) return;
        const point = position(event);
        if (!point) return;
        const kind = (event.target as HTMLElement).closest('.r-redact__resize') ? 'resize' : 'move';
        selected = index;
        gesture = { kind, pointerId: event.pointerId, index, start: point, original: { ...masks[index]! }, changed: false };
        imageWrap.setPointerCapture(event.pointerId);
        imageWrap.classList.add('is-manipulating');
        message.textContent = '';
        sync();
        event.preventDefault();
      });
      if (index === selected) {
        const handle = document.createElement('span');
        handle.className = 'r-redact__resize';
        handle.setAttribute('aria-hidden', 'true');
        box.appendChild(handle);
      }
      overlay.appendChild(box);
    });
    maskList.replaceChildren();
    masks.forEach((mask, index) => {
      const item = button(`Mask ${index + 1}: ${Math.round(mask.x * 100)}% left, ${Math.round(mask.y * 100)}% top`, 'r-redact__mask-item');
      item.setAttribute('aria-pressed', String(index === selected));
      item.title = 'Arrow keys move this mask; Shift + arrow keys resize it.';
      item.addEventListener('click', () => {
        selected = index;
        drawing = false;
        message.textContent = '';
        draw.setAttribute('aria-pressed', 'false');
        sync();
      });
      item.addEventListener('keydown', (event) => {
        const stepX = 1 / image.naturalWidth;
        const stepY = 1 / image.naturalHeight;
        const deltaX = event.key === 'ArrowLeft' ? -stepX : event.key === 'ArrowRight' ? stepX : 0;
        const deltaY = event.key === 'ArrowUp' ? -stepY : event.key === 'ArrowDown' ? stepY : 0;
        if (!deltaX && !deltaY) return;
        event.preventDefault();
        const current = masks[index]!;
        const next = event.shiftKey
          ? {
              ...current,
              width: Math.min(1 - current.x, Math.max(stepX, current.width + deltaX)),
              height: Math.min(1 - current.y, Math.max(stepY, current.height + deltaY)),
            }
          : {
              ...current,
              x: Math.min(1 - current.width, Math.max(0, current.x + deltaX)),
              y: Math.min(1 - current.height, Math.max(0, current.y + deltaY)),
            };
        if (next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height) {
          changed(masks.map((mask, maskIndex) => maskIndex === index ? next : mask));
          selected = index;
          sync();
          (maskList.children[index] as HTMLButtonElement | undefined)?.focus();
        }
      });
      maskList.appendChild(item);
    });
    if (focusedMask >= 0 && masks.length) (maskList.children[Math.min(selected, masks.length - 1)] as HTMLButtonElement | undefined)?.focus();
    const current = masks[selected];
    hint.textContent = masks.length
      ? 'Drag a mask to move it. Pull its lower-right corner to resize. Arrow keys move; Shift + arrow keys resize.'
      : 'Choose Draw mask, then drag across the screenshot.';
    remove.disabled = !current || saving;
    undoButton.disabled = undo.length === 0 || saving;
    clear.disabled = masks.length === 0 || saving;
    draw.disabled = saving || image.naturalWidth === 0;
    apply.disabled = saving;
  };
  const changed = (next: RedactionRect[]): void => {
    recordUndo();
    masks = next;
    selected = masks.length - 1;
    sync();
  };
  const position = (event: PointerEvent): { x: number; y: number } | undefined => {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height || !image.naturalWidth || !image.naturalHeight) return undefined;
    return {
      x: ((event.clientX - rect.left) / rect.width) * image.naturalWidth,
      y: ((event.clientY - rect.top) / rect.height) * image.naturalHeight,
    };
  };

  const clampMask = (mask: RedactionRect): RedactionRect => ({
    x: Math.min(1 - mask.width, Math.max(0, mask.x)),
    y: Math.min(1 - mask.height, Math.max(0, mask.y)),
    width: Math.min(1, Math.max(0, mask.width)),
    height: Math.min(1, Math.max(0, mask.height)),
  });

  draw.addEventListener('click', () => {
    drawing = !drawing;
    draw.setAttribute('aria-pressed', String(drawing));
    imageWrap.classList.toggle('is-drawing', drawing);
    if (drawing) message.textContent = 'Drag across the screenshot to cover a sensitive area.';
    else message.textContent = '';
  });
  image.addEventListener('load', sync);
  imageWrap.addEventListener('pointerdown', (event) => {
    if (!drawing || saving) return;
    const point = position(event);
    if (!point) return;
    gesture = { kind: 'draw', pointerId: event.pointerId, start: point };
    imageWrap.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  imageWrap.addEventListener('pointermove', (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = position(event);
    if (!point) return;
    if (gesture.kind === 'draw') {
      const rect = normalizeRedactionRect(gesture.start.x, gesture.start.y, point.x, point.y, image.naturalWidth, image.naturalHeight);
      if (!rect) {
        drawPreview?.remove();
        drawPreview = undefined;
        return;
      }
      if (!drawPreview) {
        drawPreview = document.createElement('div');
        drawPreview.className = 'r-redact__mask r-redact__mask--preview';
        drawPreview.setAttribute('aria-hidden', 'true');
        overlay.appendChild(drawPreview);
      }
      drawPreview.style.left = `${rect.x * 100}%`;
      drawPreview.style.top = `${rect.y * 100}%`;
      drawPreview.style.width = `${rect.width * 100}%`;
      drawPreview.style.height = `${rect.height * 100}%`;
      return;
    }
    const dx = (point.x - gesture.start.x) / image.naturalWidth;
    const dy = (point.y - gesture.start.y) / image.naturalHeight;
    const minimumWidth = 1 / image.naturalWidth;
    const minimumHeight = 1 / image.naturalHeight;
    const next = gesture.kind === 'move'
      ? clampMask({ ...gesture.original, x: gesture.original.x + dx, y: gesture.original.y + dy })
      : clampMask({
          ...gesture.original,
          width: Math.min(1 - gesture.original.x, Math.max(minimumWidth, gesture.original.width + dx)),
          height: Math.min(1 - gesture.original.y, Math.max(minimumHeight, gesture.original.height + dy)),
        });
    gesture.changed ||= next.x !== gesture.original.x || next.y !== gesture.original.y || next.width !== gesture.original.width || next.height !== gesture.original.height;
    masks[gesture.index] = next;
    sync();
  });
  imageWrap.addEventListener('pointerup', (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const currentGesture = gesture;
    gesture = undefined;
    imageWrap.classList.remove('is-manipulating');
    if (currentGesture.kind === 'draw') {
      drawPreview?.remove();
      drawPreview = undefined;
      const end = position(event);
      if (end) {
        const mask = normalizeRedactionRect(currentGesture.start.x, currentGesture.start.y, end.x, end.y, image.naturalWidth, image.naturalHeight);
        if (mask) changed([...masks, mask]);
      }
      drawing = false;
      message.textContent = '';
      draw.setAttribute('aria-pressed', 'false');
      imageWrap.classList.remove('is-drawing');
    } else if (currentGesture.changed) {
      undo.push(masks.map((mask, index) => index === currentGesture.index ? { ...currentGesture.original } : { ...mask }));
      sync();
    }
  });
  imageWrap.addEventListener('pointercancel', (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind !== 'draw') masks[gesture.index] = gesture.original;
    drawPreview?.remove();
    drawPreview = undefined;
    gesture = undefined;
    imageWrap.classList.remove('is-manipulating');
    sync();
  });
  undoButton.addEventListener('click', () => {
    const previous = undo.pop();
    if (!previous) return;
    masks = previous;
    selected = Math.min(selected, masks.length - 1);
    sync();
  });
  clear.addEventListener('click', () => { if (masks.length) changed([]); });
  remove.addEventListener('click', () => {
    if (selected < 0) return;
    changed(masks.filter((_, index) => index !== selected));
  });
  cancel.addEventListener('click', closeDialog);
  close.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    URL.revokeObjectURL(url);
    dialog.remove();
    returnFocus.focus();
  }, { once: true });
  apply.addEventListener('click', () => {
    if (saving) return;
    saving = true;
    message.textContent = 'Saving redacted screenshot…';
    sync();
    void (async () => {
      try {
        const saved = await navigator.locks.request(screenshotRedactionLock(asset.sessionId), { mode: 'exclusive' }, async () => {
          const flattened = masks.length ? await flattenRedactions(original, masks) : original;
          const digest = await sha256Blob(flattened);
          return saveScreenshotRedaction(assetId, expectedRevision, flattened, cloneMasks(), digest);
        });
        onSaved(saved);
        broadcast({ kind: 'asset/redaction-updated', sessionId: saved.sessionId, assetId: saved.id, revision: saved.localScreenshotRedaction?.revision ?? 0 });
        saving = false;
        dialog.close();
      } catch (error) {
        saving = false;
        message.textContent = error instanceof Error ? error.message : 'Could not save this redaction. Keep your masks and try again.';
        sync();
      }
    })();
  });

  // Defer display until all controls and handlers are attached.
  sync();
  dialog.showModal();
  draw.focus();
}
