/**
 * Annotation editor content script (ISOLATED world).
 *
 * Dormant until the background sends `{kind:'content/annotate', on:true, image}`.
 * Rather than draw on the live (moving) page, we annotate a frozen screenshot the
 * background captured: we open a modal inside a shadow root with a fabric.js
 * canvas showing that image, a clean toolbar (pen, arrow, rectangle, ellipse,
 * text, highlight, redact, plus colour, stroke, undo/redo, clear), and Done /
 * Cancel. fabric handles selection, moving, and resizing of every shape.
 *
 * On Done we export the annotated image (fabric canvas -> JPEG) and a plain shape
 * list, and send both to the background. On Cancel we close with no image.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import * as fabric from 'fabric';
import { onContentMessage, sendMessage } from '@/lib/messaging';
import { ANNOTATION_HOST_ID } from '@/lib/dom/overlay';
import type { AnnotationShape, AnnotationTool } from '@/lib/session/types';

const MAX_Z = 2147483647;
const HOST_ID = ANNOTATION_HOST_ID;
const DEFAULT_COLOR = '#ff5a4d';
const COLORS = ['#ff5a4d', '#16181d', '#2f9e6f', '#2f6df0', '#f5c518', '#ffffff'];

type Tool =
  | 'select'
  | 'pen'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'highlight'
  | 'redact';

// Small Lucide-style inline icons for the toolbar (24x24, currentColor stroke).
const ICON: Record<string, string> = {
  select:
    '<path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/>',
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  arrow: '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  text: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  highlight:
    '<path d="M9 11l-6 6v3h3l6-6"/><path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-4.2-4.2a2 2 0 0 1 0-2.8L15 5"/>',
  redact: '<rect x="3" y="6" width="18" height="12" rx="1" fill="currentColor"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
  clear: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
  done: '<polyline points="20 6 9 17 4 12"/>',
  cancel: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
};

function svg(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="17" height="17">${ICON[name]}</svg>`;
}

const TOOLBAR_TOOLS: { tool: Tool; icon: string; title: string }[] = [
  { tool: 'select', icon: 'select', title: 'Select' },
  { tool: 'pen', icon: 'pen', title: 'Pen' },
  { tool: 'arrow', icon: 'arrow', title: 'Arrow' },
  { tool: 'rect', icon: 'rect', title: 'Rectangle' },
  { tool: 'ellipse', icon: 'ellipse', title: 'Ellipse' },
  { tool: 'text', icon: 'text', title: 'Text' },
  { tool: 'highlight', icon: 'highlight', title: 'Highlight' },
  { tool: 'redact', icon: 'redact', title: 'Redact' },
];

const STYLES = `
:host { all: initial; }
.wrap {
  position: fixed; inset: 0; z-index: ${MAX_Z};
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(12,14,18,0.55); backdrop-filter: blur(2px);
  font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, system-ui, sans-serif;
}
.stage { box-shadow: 0 12px 40px rgba(0,0,0,0.4); border-radius: 8px; overflow: hidden; background: #fff; }
.canvas-wrap { display: block; line-height: 0; }
.bar {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 4px;
  /* Wrap within the viewport on narrow windows so every control (including
     Done/Cancel) stays reachable instead of clipping off both edges. */
  flex-wrap: wrap; justify-content: center; row-gap: 4px;
  box-sizing: border-box; max-width: calc(100vw - 16px);
  padding: 6px; border-radius: 12px;
  background: #16181d; color: #ececea;
  box-shadow: 0 8px 30px rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.08);
}
.bar button {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border: none; border-radius: 8px;
  background: transparent; color: #c8ccd2; cursor: pointer;
}
.bar button:hover { background: rgba(255,255,255,0.09); color: #fff; }
.bar button.on { background: ${DEFAULT_COLOR}; color: #fff; }
.grip {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 32px; color: #6d727b; cursor: grab;
  touch-action: none; user-select: none; border-radius: 6px;
}
.grip:hover { color: #c8ccd2; background: rgba(255,255,255,0.07); }
.grip:active { cursor: grabbing; }
.sep { width: 1px; height: 22px; background: rgba(255,255,255,0.12); margin: 0 4px; }
.swatches { display: flex; gap: 4px; align-items: center; padding: 0 2px; }
.sw { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.sw.on { border-color: #fff; }
.stroke { -webkit-appearance: none; appearance: none; width: 70px; height: 4px; border-radius: 999px; background: #3a3f47; outline: none; }
.stroke::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff; cursor: pointer; }
.bar .done { color: #7ee2b8; }
.bar .cancel { color: #ff7a6e; }
.hint { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,0.7); font-size: 12px; }
`;

// ---------------------------------------------------------------------------

class AnnotationEditor {
  private readonly host: HTMLDivElement;
  private readonly root: ShadowRoot;
  private readonly canvasEl: HTMLCanvasElement;
  private readonly canvas: fabric.Canvas;
  private readonly onClose: () => void;

  private tool: Tool = 'select';
  private color = DEFAULT_COLOR;
  private stroke = 4;
  private disposed = false;

  // in-progress shape while dragging
  private draft: fabric.FabricObject | null = null;
  private start = { x: 0, y: 0 };
  private drawing = false;

  // undo/redo history of serialized canvas states
  private history: string[] = [];
  private histIndex = -1;
  private restoring = false;

  // native<->display scale, for exporting at full resolution
  private multiplier = 1;

  constructor(imageUrl: string, onClose: () => void) {
    this.onClose = onClose;

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    this.root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const stage = document.createElement('div');
    stage.className = 'stage';
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'canvas-wrap';
    this.canvasEl = document.createElement('canvas');
    canvasWrap.appendChild(this.canvasEl);
    stage.appendChild(canvasWrap);
    wrap.appendChild(stage);
    this.root.appendChild(wrap);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Draw to annotate · Enter to finish · Esc to cancel';
    wrap.appendChild(hint);

    // lock page scroll while editing
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.appendChild(this.host);

    this.canvas = new fabric.Canvas(this.canvasEl, {
      preserveObjectStacking: true,
      selection: true,
    });

    this.buildToolbar(wrap);
    this.wireEvents();
    void this.loadImage(imageUrl);
  }

  private async loadImage(url: string): Promise<void> {
    let img: fabric.FabricImage;
    try {
      img = await fabric.FabricImage.fromURL(url);
    } catch {
      // Without an image there is nothing to annotate; bail cleanly.
      this.cancel();
      return;
    }
    if (this.disposed) return;

    const natW = img.width ?? window.innerWidth;
    const natH = img.height ?? window.innerHeight;
    const margin = 120;
    const maxW = Math.max(320, window.innerWidth - margin);
    const maxH = Math.max(240, window.innerHeight - margin);
    const scale = Math.min(maxW / natW, maxH / natH, 1);
    const dispW = Math.round(natW * scale);
    const dispH = Math.round(natH * scale);
    this.multiplier = natW / dispW;

    this.canvas.setDimensions({ width: dispW, height: dispH });
    img.set({ selectable: false, evented: false });
    img.scaleX = dispW / natW;
    img.scaleY = dispH / natH;
    this.canvas.backgroundImage = img;
    this.canvas.requestRenderAll();

    this.pushHistory();
  }

  // -- toolbar --------------------------------------------------------------

  private buildToolbar(wrap: HTMLElement): void {
    const bar = document.createElement('div');
    bar.className = 'bar';

    // Drag handle: the toolbar floats over the page and can cover the exact
    // spot the user wants to annotate — grab the grip to move it anywhere.
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to move the toolbar';
    grip.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">' +
      '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>' +
      '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>' +
      '<circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
    grip.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      const rect = bar.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      // Switch from the centered default to explicit coordinates once dragged.
      bar.style.transform = 'none';
      const move = (ev: PointerEvent) => {
        const w = bar.offsetWidth;
        const h = bar.offsetHeight;
        const x = Math.min(Math.max(ev.clientX - dx, 4), window.innerWidth - w - 4);
        const y = Math.min(Math.max(ev.clientY - dy, 4), window.innerHeight - h - 4);
        bar.style.left = `${x}px`;
        bar.style.top = `${y}px`;
      };
      move(e);
      grip.setPointerCapture(e.pointerId);
      grip.addEventListener('pointermove', move);
      grip.addEventListener(
        'pointerup',
        () => grip.removeEventListener('pointermove', move),
        { once: true },
      );
    });
    bar.appendChild(grip);

    for (const t of TOOLBAR_TOOLS) {
      const b = this.iconBtn(t.icon, t.title, () => this.setTool(t.tool));
      b.dataset.tool = t.tool;
      if (t.tool === this.tool) b.classList.add('on');
      bar.appendChild(b);
    }

    bar.appendChild(this.sep());

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    for (const c of COLORS) {
      const sw = document.createElement('button');
      sw.className = 'sw' + (c === this.color ? ' on' : '');
      sw.style.background = c;
      sw.title = c;
      sw.dataset.color = c;
      sw.addEventListener('click', () => this.setColor(c));
      swatches.appendChild(sw);
    }
    bar.appendChild(swatches);

    const stroke = document.createElement('input');
    stroke.type = 'range';
    stroke.className = 'stroke';
    stroke.min = '1';
    stroke.max = '18';
    stroke.value = String(this.stroke);
    stroke.addEventListener('input', () => {
      this.stroke = Number(stroke.value);
      const active = this.canvas.getActiveObject();
      if (active && 'strokeWidth' in active) {
        active.set('strokeWidth', this.stroke);
        this.canvas.requestRenderAll();
        this.pushHistory();
      }
      if (this.canvas.freeDrawingBrush) {
        this.canvas.freeDrawingBrush.width = this.brushWidth();
      }
    });
    bar.appendChild(stroke);

    bar.appendChild(this.sep());
    bar.appendChild(this.iconBtn('undo', 'Undo', () => this.undo()));
    bar.appendChild(this.iconBtn('redo', 'Redo', () => this.redo()));
    bar.appendChild(this.iconBtn('clear', 'Clear all', () => this.clear()));
    bar.appendChild(this.sep());

    const done = this.iconBtn('done', 'Done', () => void this.done());
    done.classList.add('done');
    bar.appendChild(done);
    const cancel = this.iconBtn('cancel', 'Cancel', () => this.cancel());
    cancel.classList.add('cancel');
    bar.appendChild(cancel);

    wrap.appendChild(bar);
  }

  private iconBtn(icon: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.innerHTML = svg(icon);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  private sep(): HTMLElement {
    const s = document.createElement('div');
    s.className = 'sep';
    return s;
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.canvas.isDrawingMode = tool === 'pen' || tool === 'highlight';
    if (this.canvas.isDrawingMode) {
      const brush = new fabric.PencilBrush(this.canvas);
      brush.color = tool === 'highlight' ? this.highlightColor() : this.color;
      brush.width = this.brushWidth();
      this.canvas.freeDrawingBrush = brush;
    }
    this.canvas.selection = tool === 'select';
    for (const obj of this.canvas.getObjects()) obj.selectable = tool === 'select';
    this.root
      .querySelectorAll('.bar button[data-tool]')
      .forEach((el) =>
        el.classList.toggle('on', (el as HTMLElement).dataset.tool === tool),
      );
    this.canvas.requestRenderAll();
  }

  private setColor(c: string): void {
    this.color = c;
    this.root
      .querySelectorAll('.sw')
      .forEach((el) =>
        el.classList.toggle('on', (el as HTMLElement).dataset.color === c),
      );
    const active = this.canvas.getActiveObject();
    if (active) {
      if (active.type === 'i-text') active.set('fill', c);
      else active.set('stroke', c);
      this.canvas.requestRenderAll();
      this.pushHistory();
    }
    if (this.canvas.freeDrawingBrush) {
      this.canvas.freeDrawingBrush.color =
        this.tool === 'highlight' ? this.highlightColor() : c;
    }
  }

  private brushWidth(): number {
    return this.tool === 'highlight' ? this.stroke * 4 : this.stroke;
  }

  private highlightColor(): string {
    // translucent version of the current colour
    const hex = this.color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},0.35)`;
  }

  // -- drawing --------------------------------------------------------------

  private wireEvents(): void {
    this.canvas.on('mouse:down', (o) => this.onDown(o));
    this.canvas.on('mouse:move', (o) => this.onMove(o));
    this.canvas.on('mouse:up', () => this.onUp());
    this.canvas.on('object:modified', () => this.pushHistory());
    this.canvas.on('path:created', () => this.pushHistory());

    document.addEventListener('keydown', this.onKey, true);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    // Do not steal keys while editing a text label.
    const active = this.canvas.getActiveObject();
    const editing =
      active && active.type === 'i-text' && (active as fabric.IText).isEditing;
    if (editing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void this.done();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    }
  };

  private pointer(o: fabric.TPointerEventInfo): { x: number; y: number } {
    const p = this.canvas.getScenePoint(o.e);
    return { x: p.x, y: p.y };
  }

  private onDown(o: fabric.TPointerEventInfo): void {
    if (this.tool === 'select' || this.canvas.isDrawingMode) return;
    if (this.canvas.getActiveObject()) return; // interacting with a shape
    const p = this.pointer(o);
    this.start = p;
    this.drawing = true;

    if (this.tool === 'text') {
      const t = new fabric.IText('Text', {
        left: p.x,
        top: p.y,
        fill: this.color,
        fontSize: Math.max(16, this.stroke * 5),
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      });
      this.canvas.add(t);
      this.canvas.setActiveObject(t);
      t.enterEditing();
      t.selectAll();
      this.drawing = false;
      this.pushHistory();
      return;
    }

    if (this.tool === 'rect') {
      this.draft = new fabric.Rect({
        left: p.x,
        top: p.y,
        width: 1,
        height: 1,
        fill: 'transparent',
        stroke: this.color,
        strokeWidth: this.stroke,
        strokeUniform: true,
      });
    } else if (this.tool === 'redact') {
      this.draft = new fabric.Rect({
        left: p.x,
        top: p.y,
        width: 1,
        height: 1,
        fill: 'rgba(15,17,20,0.96)',
        stroke: 'transparent',
      });
    } else if (this.tool === 'ellipse') {
      this.draft = new fabric.Ellipse({
        left: p.x,
        top: p.y,
        rx: 1,
        ry: 1,
        fill: 'transparent',
        stroke: this.color,
        strokeWidth: this.stroke,
        strokeUniform: true,
      });
    } else if (this.tool === 'arrow') {
      this.draft = new fabric.Line([p.x, p.y, p.x, p.y], {
        stroke: this.color,
        strokeWidth: this.stroke,
      });
    }
    if (this.draft) {
      this.draft.selectable = false;
      this.canvas.add(this.draft);
    }
  }

  private onMove(o: fabric.TPointerEventInfo): void {
    if (!this.drawing || !this.draft) return;
    const p = this.pointer(o);
    const d = this.draft;
    if (d instanceof fabric.Line) {
      d.set({ x2: p.x, y2: p.y });
    } else if (d instanceof fabric.Ellipse) {
      const rx = Math.abs(p.x - this.start.x) / 2;
      const ry = Math.abs(p.y - this.start.y) / 2;
      d.set({
        rx,
        ry,
        left: Math.min(p.x, this.start.x),
        top: Math.min(p.y, this.start.y),
      });
    } else if (d instanceof fabric.Rect) {
      d.set({
        width: Math.abs(p.x - this.start.x),
        height: Math.abs(p.y - this.start.y),
        left: Math.min(p.x, this.start.x),
        top: Math.min(p.y, this.start.y),
      });
    }
    this.canvas.requestRenderAll();
  }

  private onUp(): void {
    if (!this.drawing || !this.draft) {
      this.drawing = false;
      return;
    }
    const d = this.draft;
    this.draft = null;
    this.drawing = false;

    // Discard zero-size shapes.
    const tiny =
      (d instanceof fabric.Rect && (d.width! < 3 || d.height! < 3)) ||
      (d instanceof fabric.Ellipse && (d.rx! < 2 || d.ry! < 2)) ||
      (d instanceof fabric.Line &&
        Math.hypot(d.x2! - d.x1!, d.y2! - d.y1!) < 4);
    if (tiny) {
      this.canvas.remove(d);
      this.canvas.requestRenderAll();
      return;
    }

    if (d instanceof fabric.Line) {
      // Replace the bare line with a line + arrowhead group.
      this.canvas.remove(d);
      const arrow = this.makeArrow(d.x1!, d.y1!, d.x2!, d.y2!);
      this.canvas.add(arrow);
    } else {
      d.selectable = this.tool === 'select';
    }
    this.canvas.requestRenderAll();
    this.pushHistory();
  }

  private makeArrow(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): fabric.Group {
    const line = new fabric.Line([x1, y1, x2, y2], {
      stroke: this.color,
      strokeWidth: this.stroke,
    });
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = new fabric.Triangle({
      left: x2,
      top: y2,
      originX: 'center',
      originY: 'center',
      pointType: 'arrow_start',
      angle: (angle * 180) / Math.PI + 90,
      width: this.stroke * 3.2,
      height: this.stroke * 3.2,
      fill: this.color,
    });
    const g = new fabric.Group([line, head]);
    g.set({ selectable: this.tool === 'select' });
    (g as unknown as { srTool: AnnotationTool }).srTool = 'arrow';
    return g;
  }

  // -- history --------------------------------------------------------------

  private pushHistory(): void {
    if (this.restoring) return;
    const json = JSON.stringify(this.canvas.toJSON());
    // drop any redo tail
    this.history = this.history.slice(0, this.histIndex + 1);
    this.history.push(json);
    this.histIndex = this.history.length - 1;
  }

  private async restore(index: number): Promise<void> {
    const json = this.history[index];
    if (!json) return;
    this.restoring = true;
    await this.canvas.loadFromJSON(JSON.parse(json));
    this.canvas.requestRenderAll();
    this.restoring = false;
  }

  private undo(): void {
    if (this.histIndex <= 0) return;
    this.histIndex -= 1;
    void this.restore(this.histIndex);
  }

  private redo(): void {
    if (this.histIndex >= this.history.length - 1) return;
    this.histIndex += 1;
    void this.restore(this.histIndex);
  }

  private clear(): void {
    for (const obj of this.canvas.getObjects()) this.canvas.remove(obj);
    this.canvas.requestRenderAll();
    this.pushHistory();
  }

  // -- finish ---------------------------------------------------------------

  private toShapes(): AnnotationShape[] {
    const out: AnnotationShape[] = [];
    for (const obj of this.canvas.getObjects()) {
      const tool = this.toolOf(obj);
      const shape: AnnotationShape = {
        tool,
        color: this.color,
        strokeWidth: this.stroke,
      };
      if (obj.type === 'i-text') shape.text = (obj as fabric.IText).text ?? '';
      out.push(shape);
    }
    return out;
  }

  private toolOf(obj: fabric.FabricObject): AnnotationTool {
    const tagged = (obj as unknown as { srTool?: AnnotationTool }).srTool;
    if (tagged) return tagged;
    switch (obj.type) {
      case 'rect':
        return (obj.fill as string)?.includes('15,17,20') ? 'redact' : 'rect';
      case 'ellipse':
        return 'ellipse';
      case 'i-text':
        return 'text';
      case 'path':
        return 'pen';
      case 'group':
        return 'arrow';
      default:
        return 'pen';
    }
  }

  private async done(): Promise<void> {
    if (this.disposed) return;
    const active = this.canvas.getActiveObject();
    if (active && active.type === 'i-text' && (active as fabric.IText).isEditing) {
      (active as fabric.IText).exitEditing();
    }
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();

    const shapes = this.toShapes();
    const image = this.canvas.toDataURL({
      format: 'jpeg',
      quality: 0.85,
      multiplier: this.multiplier,
    });
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    try {
      await sendMessage({ kind: 'annotation/exit', shapes, viewport, image });
    } catch {
      /* background gone — still clean up */
    }
    this.teardown();
  }

  cancel(): void {
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    void sendMessage({ kind: 'annotation/exit', shapes: [], viewport }).catch(
      () => {},
    );
    this.teardown();
  }

  private teardown(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('keydown', this.onKey, true);
    document.documentElement.style.overflow = '';
    try {
      this.canvas.dispose();
    } catch {
      /* ignore */
    }
    this.host.remove();
    this.onClose();
  }
}

// ---------------------------------------------------------------------------

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: false,
  runAt: 'document_idle',
  main() {
    const w = window as unknown as { __srAnnotate?: boolean };
    if (w.__srAnnotate) return;
    w.__srAnnotate = true;

    let editor: AnnotationEditor | null = null;

    onContentMessage((msg) => {
      if (msg.kind !== 'content/annotate') return;
      try {
        if (msg.on && msg.image) {
          if (!editor) {
            editor = new AnnotationEditor(msg.image, () => {
              editor = null;
            });
          }
        } else if (!msg.on && editor) {
          editor.cancel();
          editor = null;
        }
      } catch {
        editor = null;
      }
    });
  },
});
