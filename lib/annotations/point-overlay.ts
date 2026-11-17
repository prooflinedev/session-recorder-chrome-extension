import { buildDescriptor, isSensitiveInput } from '@/lib/dom/descriptor';
import { POINT_ANNOTATION_HOST_ID } from '@/lib/dom/overlay';
import { sendMessage } from '@/lib/messaging';
import type { Point, Rect } from '@/lib/session/types';
import { dictationReducer, emptyDictationDraft } from './dictation';
import { pageVocabularyContext } from './page-vocabulary';
import type { ContentMessage } from '@/lib/messaging';
import {
  initialPointAnnotationState,
  pointAnnotationReducer,
  selectionRect,
  dragRect,
  type AnnotationSelection,
  type PointAnnotationAction,
} from './reducer';

const icons = {
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6"/>',
};
const icon = (name: keyof typeof icons) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
const styles = `
:host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;color-scheme:light dark;font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#202124}
*{box-sizing:border-box}[hidden]{display:none!important}button,textarea{font:inherit;color:inherit}button{cursor:pointer}svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.picker{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;touch-action:none}.outline{position:fixed;border:2px solid #1683ff;background:#1683ff08;pointer-events:none}.outline.region{border-style:dashed}
.composer{position:fixed;display:flex;align-items:center;gap:8px;width:min(360px,calc(100vw - 48px));min-height:48px;padding:6px 7px 6px 16px;border:1px solid #dddfe3;border-radius:26px;background:#fff;box-shadow:0 2px 8px #00000016;pointer-events:auto}
textarea{display:block;flex:1;min-width:0;min-height:24px;max-height:120px;padding:3px 0;border:0;outline:0;background:transparent;resize:none;line-height:20px;caret-color:#1683ff}textarea::placeholder{color:#737780}.composer:focus-within{border-color:#a5a9b2}
.icon{display:grid;place-items:center;width:32px;height:32px;flex:none;border:0;border-radius:50%;background:transparent;padding:7px}.icon:hover{background:#eceef1}.submit{background:#25272c;color:white}.submit:hover{background:#42454d}.submit:disabled{background:#e6e8ec;color:#888c95;cursor:default}.mic[aria-pressed=true]{color:#b83432;background:#fce9e8}
.pin{position:fixed;display:grid;place-items:center;width:28px;height:28px;background:#1269ca;color:#fff;border:2px solid white;border-radius:50% 50% 50% 5px;font-size:12px;font-weight:600;pointer-events:none}.pins .pin{pointer-events:auto;cursor:pointer}.exit{position:fixed;right:12px;top:12px;pointer-events:auto;background:#fff;border:1px solid #dddfe3}.status{position:fixed;max-width:min(360px,calc(100vw - 32px));padding:8px 12px;border-radius:8px;background:#fff;color:#ae302a;box-shadow:0 2px 6px #0002;font-size:12px;pointer-events:none}.status.pending{color:#4d5159}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
:focus-visible{outline:2px solid #1683ff;outline-offset:3px}textarea:focus-visible,.exit:focus{outline:none}.exit:focus-visible{border-color:currentColor}::selection{background:#1683ff33}:host(.saving) .exit,:host(.saving) .pins{visibility:hidden}
@media(prefers-color-scheme:dark){:host{color:#f2f2f3}.composer,.exit,.status{background:#2c2c2d;border-color:#424244}.composer:focus-within{border-color:#67676b}textarea::placeholder{color:#a3a3aa}.icon:hover{background:#414145}.submit{background:#e3e3e6;color:#242426}.submit:hover{background:#fff}.submit:disabled{background:#505054;color:#a3a3aa}.mic[aria-pressed=true]{color:#ffaba5;background:#59312f}.status{color:#ffb0aa}.status.pending{color:#c7c7cc}}
`;

/** Owns its shadow DOM and listeners; all UI transitions go through the reducer. */
export class PointAnnotationOverlay {
  private state = initialPointAnnotationState;
  private host = document.createElement('div');
  private root = this.host.attachShadow({ mode: 'open' });
  private abort = new AbortController();
  private disposed = false;
  private previousFocus = document.activeElement;
  private hovered?: Element;
  private gesture?: { start: Point; pointerId: number; rect?: Rect };
  private micOn = false;
  private dictationId?: string;
  private dictationDraft = emptyDictationDraft;
  private micPending = false;
  private outline: HTMLDivElement;
  private composer: HTMLElement;
  private input: HTMLTextAreaElement;
  private status: HTMLParagraphElement;
  private saveButton: HTMLButtonElement;
  private micButton: HTMLButtonElement;
  private picker: HTMLDivElement;
  private pin: HTMLDivElement;
  private pins: HTMLDivElement;
  private exit: HTMLButtonElement;

  constructor(private close: () => Promise<void>) {
    this.host.id = POINT_ANNOTATION_HOST_ID;
    this.root.innerHTML = `<style>${styles}</style><div class="picker" aria-label="Click an element or drag an area to annotate"></div><div class="outline" hidden></div><div class="pins"></div><div class="pin" hidden></div><section class="composer" role="dialog" aria-label="Annotate page" hidden><textarea rows="1" maxlength="4000" aria-label="Comment" placeholder="Add a comment…"></textarea><button class="icon mic" type="button" aria-label="Dictate comment" title="Turn on microphone to dictate" aria-pressed="false">${icon('mic')}</button><button class="icon submit" type="button" aria-label="Add comment" title="Add comment (Enter)">${icon('check')}</button></section><button class="icon exit" type="button" aria-label="Turn off annotations" title="Turn off annotations (Escape)">${icon('close')}</button><p class="status" role="status" aria-live="polite" hidden></p>`;
    const get = <T extends Element>(selector: string) =>
      this.root.querySelector<T>(selector)!;
    this.outline = get('.outline');
    this.composer = get('.composer');
    this.input = get('textarea');
    this.status = get('.status');
    this.saveButton = get('.submit');
    this.micButton = get('.mic');
    this.picker = get('.picker');
    this.pin = get('.pin');
    this.pins = get('.pins');
    this.exit = get('.exit');

    const options = { signal: this.abort.signal };
    this.picker.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 || this.state.status === 'saving') return;
        event.preventDefault();
        this.stopDictation();
        if (this.state.status === 'editing') this.dispatch({ type: 'pick' });
        this.gesture = {
          start: { x: event.clientX, y: event.clientY },
          pointerId: event.pointerId,
        };
        this.picker.setPointerCapture(event.pointerId);
      },
      options,
    );
    this.picker.addEventListener(
      'pointermove',
      (event) => {
        if (this.state.status !== 'picking') return;
        if (this.gesture) {
          const rect = dragRect(this.gesture.start, {
            x: event.clientX,
            y: event.clientY,
          });
          if (rect.w > 5 || rect.h > 5) {
            this.gesture.rect = rect;
            this.drawRect(rect, true);
          }
        } else {
          this.hovered = this.elementAt(event.clientX, event.clientY);
          this.drawElement(this.hovered);
        }
      },
      options,
    );
    this.picker.addEventListener(
      'pointerup',
      (event) => {
        const gesture = this.gesture;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        this.gesture = undefined;
        this.picker.releasePointerCapture(event.pointerId);
        if (gesture.rect && gesture.rect.w >= 5 && gesture.rect.h >= 5) {
          this.select({
            kind: 'region',
            rect: gesture.rect,
            scroll: { x: scrollX, y: scrollY },
          });
        } else {
          const element = this.elementAt(event.clientX, event.clientY);
          if (element)
            this.select({
              kind: 'element',
              target: element,
              descriptor: this.descriptor(element),
            });
        }
      },
      options,
    );
    this.picker.addEventListener(
      'pointercancel',
      () => {
        this.gesture = undefined;
        this.render();
      },
      options,
    );
    this.picker.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      options,
    );
    this.exit.addEventListener('click', () => void close(), options);
    this.saveButton.addEventListener('click', () => void this.save(), options);
    this.micButton.addEventListener('click', () => this.dictate(), options);
    this.input.addEventListener(
      'input',
      () => {
        this.dictationDraft = dictationReducer(this.dictationDraft, { type: 'edit', text: this.input.value });
        this.dispatch({ type: 'text', text: this.input.value });
      },
      options,
    );
    this.root.addEventListener(
      'keydown',
      (event) => {
        const key = event as KeyboardEvent;
        if (key.key === 'Escape') {
          key.preventDefault();
          key.stopPropagation();
          this.stopDictation();
          if (this.state.status === 'editing') {
            this.dispatch({ type: 'pick' });
            this.exit.focus();
          } else if (this.state.status !== 'saving') void close();
        }
        if (
          key.key === 'Enter' &&
          !key.shiftKey &&
          !key.isComposing &&
          this.root.activeElement === this.input
        ) {
          key.preventDefault();
          void this.save();
        }
        if (key.key === 'Tab') {
          const controls = Array.from(
            this.root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
              'button,textarea',
            ),
          ).filter((el) => !el.disabled && el.getClientRects().length);
          const index = controls.indexOf(this.root.activeElement as HTMLButtonElement);
          key.preventDefault();
          controls[
            (index + (key.shiftKey ? -1 : 1) + controls.length) % controls.length
          ]?.focus();
        }
      },
      options,
    );
    window.addEventListener('scroll', () => this.position(), {
      ...options,
      capture: true,
    });
    window.addEventListener('resize', () => this.position(), options);
    document.documentElement.append(this.host);
    this.exit.focus();
    this.render();
  }
  private descriptor(element: Element) {
    const d = buildDescriptor(element);
    if (isSensitiveInput(element)) {
      delete d.text;
      delete d.name;
    }
    return d;
  }
  private elementAt(x: number, y: number) {
    return document
      .elementsFromPoint(x, y)
      .find(
        (el) =>
          el !== this.host && el !== document.documentElement && el !== document.body,
      );
  }
  private select(selection: AnnotationSelection) {
    this.dispatch({ type: 'select', selection });
    this.input.focus({ preventScroll: true });
    this.openDictation();
  }
  private openDictation() {
    this.dictationDraft = { text: this.state.text, base: this.state.text };
    const id = crypto.randomUUID();
    this.dictationId = id;
    void sendMessage({ kind: 'dictation/focus', id, context: pageVocabularyContext() }).then(result => {
      if (this.dictationId === id && !this.disposed) this.setMicState(result.micOn);
    }).catch(() => {});
  }
  private dispatch(action: PointAnnotationAction) {
    if (this.disposed) return;
    this.state = pointAnnotationReducer(this.state, action);
    this.render();
  }
  private drawElement(element?: Element) {
    if (!element?.isConnected) {
      this.outline.hidden = true;
      return;
    }
    const r = element.getBoundingClientRect();
    this.drawRect({ x: r.x, y: r.y, w: r.width, h: r.height }, false);
  }
  private drawRect(rect: Rect, region: boolean) {
    this.outline.hidden = false;
    this.outline.classList.toggle('region', region);
    Object.assign(this.outline.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
    });
  }
  private placePin(pin: HTMLElement, rect: Rect) {
    Object.assign(pin.style, {
      left: `${Math.max(4, Math.min(innerWidth - 32, rect.x + rect.w - 14))}px`,
      top: `${Math.max(4, Math.min(innerHeight - 32, rect.y + rect.h - 14))}px`,
    });
  }
  private position() {
    const selection = this.state.selection;
    const rect = selection && selectionRect(selection);
    if (rect) {
      this.drawRect(rect, selection.kind === 'region');
      this.placePin(this.pin, rect);
      const width = this.composer.offsetWidth || Math.min(360, innerWidth - 48),
        height = this.composer.offsetHeight || 48;
      const left = Math.max(
        12,
        Math.min(innerWidth - width - 12, rect.x + rect.w + 16),
      );
      let top = rect.y + rect.h - 24;
      if (top + height > innerHeight - 12) top = rect.y - height - 12;
      top = Math.max(12, Math.min(innerHeight - height - 12, top));
      Object.assign(this.composer.style, { left: `${left}px`, top: `${top}px` });
      // Keep the numbered pin visible when the composer is clamped on a narrow page.
      if (left < rect.x + rect.w + 16) {
        Object.assign(this.pin.style, {
          left: `${left >= 40 ? left - 28 : left}px`,
          top: `${left >= 40 ? top + 10 : Math.max(4, top - 28)}px`,
        });
      }
      Object.assign(this.status.style, {
        left: `${left}px`,
        top: `${Math.min(innerHeight - 60, top + height + 8)}px`,
      });
    } else if (!this.gesture) this.drawElement(this.hovered);
    this.state.comments.forEach((comment, index) => {
      const r = selectionRect(comment.selection);
      const pin = this.pins.children[index] as HTMLElement | undefined;
      if (pin) {
        pin.hidden = !r;
        if (r) this.placePin(pin, r);
      }
    });
  }
  private render() {
    const { status, text, message, comments, transcribing } = this.state;
    this.host.classList.toggle('saving', status === 'saving');
    this.composer.hidden = status !== 'editing';
    this.pin.hidden = status === 'picking';
    this.pin.textContent = String(comments.length + 1);
    if (this.input.value !== text) this.input.value = text;
    this.input.style.height = '24px';
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
    this.saveButton.disabled = !text.trim() || status === 'saving';
    this.micButton.setAttribute('aria-pressed', String(this.micOn));
    this.micButton.disabled = this.micPending;
    this.micButton.setAttribute('aria-label', this.micOn ? 'Turn off dictation microphone' : 'Dictate comment');
    this.micButton.title = this.micOn ? 'Microphone on — speak to add your comment' : 'Turn on microphone to dictate';
    const notice = message || (transcribing ? 'Transcribing your speech…' : '');
    this.status.textContent = notice;
    this.status.hidden = !notice;
    this.status.classList.toggle('pending', !message && transcribing);
    this.status.classList.toggle('sr-only', status === 'picking');
    if (this.pins.childElementCount !== comments.length) {
      this.pins.replaceChildren(
        ...comments.map((comment, index) => {
          const pin = document.createElement('button');
          pin.className = 'pin';
          pin.textContent = String(index + 1);
          pin.title = comment.text;
          pin.setAttribute('aria-label', `Comment ${index + 1}: ${comment.text}`);
          pin.addEventListener(
            'click',
            () => {
              this.status.textContent = comment.text;
              this.status.hidden = false;
              this.status.classList.remove('sr-only');
              const r = selectionRect(comment.selection);
              if (r)
                Object.assign(this.status.style, {
                  left: `${Math.max(12, Math.min(innerWidth - 372, r.x))}px`,
                  top: `${Math.max(12, Math.min(innerHeight - 80, r.y + r.h + 20))}px`,
                });
            },
            { signal: this.abort.signal },
          );
          return pin;
        }),
      );
    }
    this.position();
  }
  setMicState(on: boolean) {
    this.micOn = on;
    this.dispatch({ type: 'dictate', active: on && this.state.status === 'editing' });
  }
  receiveTranscript(message: Extract<ContentMessage, { kind: 'content/dictation' }>) {
    if (message.id !== this.dictationId || this.state.status !== 'editing') return;
    this.dictationDraft = dictationReducer(this.dictationDraft, { type: 'transcript', ...message });
    this.dispatch({ type: 'text', text: this.dictationDraft.text });
  }
  receiveDictationStatus(message: Extract<ContentMessage, { kind: 'content/dictation-status' }>) {
    if (message.id !== this.dictationId || this.state.status !== 'editing') return;
    this.dispatch({ type: 'transcribing', pending: message.pending });
    // The typed and dictated text stays in the composer; only the notice changes.
    if (message.error) this.dispatch({ type: 'error', message: `Transcription failed: ${message.error.replace(/[.\s]+$/, '')}. Type the rest of your comment.` });
  }
  private stopDictation() {
    const id = this.dictationId;
    this.dictationId = undefined;
    this.dictationDraft = emptyDictationDraft;
    if (id) void sendMessage({ kind: 'dictation/blur', id }).catch(() => {});
  }
  private async dictate() {
    if (this.micPending) return;
    this.micPending = true;
    this.render();
    try {
      const result = await sendMessage({ kind: 'dictation/mic', on: !this.micOn });
      if (this.disposed) return;
      this.setMicState(result.micOn);
      if (!result.ok) this.dispatch({ type: 'error', message: result.error ?? 'Could not start dictation. Try again or type your comment.' });
    } catch {
      this.dispatch({ type: 'error', message: 'Could not connect to the recorder. Type your comment or reopen annotations.' });
    } finally {
      this.micPending = false;
      if (!this.disposed) this.render();
    }
  }
  private async save() {
    const { selection, text, status } = this.state;
    if (status !== 'editing' || !selection || !text.trim()) return;
    const rect = selectionRect(selection);
    if (!rect) {
      this.dispatch({
        type: 'error',
        message: 'This element is no longer on the page. Select another.',
      });
      return;
    }
    this.stopDictation();
    this.dispatch({ type: 'save' });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (this.disposed) return;
    try {
      const result = await sendMessage({
        kind: 'point-annotation/save',
        descriptor:
          selection.kind === 'element' ? this.descriptor(selection.target) : undefined,
        rect,
        text: text.trim(),
        viewport: { w: innerWidth, h: innerHeight },
      });
      if (!result.ok) throw new Error(result.error ?? 'Could not add the comment.');
      this.dispatch({ type: 'saved' });
      this.exit.focus({ preventScroll: true });
    } catch (error) {
      this.dispatch({
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not add the comment.',
      });
      this.input.focus({ preventScroll: true });
      this.openDictation();
    }
  }
  dispose() {
    this.disposed = true;
    this.stopDictation();
    this.abort.abort();
    this.host.remove();
    if (this.previousFocus instanceof HTMLElement && this.previousFocus.isConnected)
      this.previousFocus.focus({ preventScroll: true });
  }
}
