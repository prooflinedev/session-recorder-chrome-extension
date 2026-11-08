/**
 * Rendered report viewer.
 *
 * Opened in a new tab when a recording stops (report.html?session=<id>). Loads
 * the session from IndexedDB and renders a clean, readable document: a timeline
 * with screenshots inline, consecutive network calls folded into a <details>,
 * and loud blocks for markers, notes, voice, and errors.
 *
 * Rendered natively into the DOM (all captured text goes through textContent, so
 * untrusted page content can never execute here). A verbosity selector re-renders
 * the report, and changing the level in the side panel re-renders it too.
 */
import { getSession, getEvents, getAssets } from '@/lib/storage';
import { formatClock } from '@/lib/export/markdown';
import { describeEnvironment } from '@/lib/session/environment';
import {
  applyLevel,
  collapseRepeatedRequests,
  dropStaticAssets,
} from '@/lib/export/trimmer';
import type { TrimContext } from '@/lib/export/trimmer';
import { buildBundle } from '@/lib/export/bundle';
import { zipFiles } from '@/lib/export/zip';
import { sessionFolderName } from '@/lib/util/naming';
import { broadcast, onBroadcast } from '@/lib/messaging';
import type {
  AssetMeta,
  AnnotationShape,
  NetRequestPayload,
  SessionEvent,
  VerbosityLevel,
} from '@/lib/session/types';

const params = new URLSearchParams(location.search);
const sessionId = params.get('session');
document.getElementById('share')?.addEventListener('click', () => {
  if (sessionId) void chrome.tabs.create({ url: `${chrome.runtime.getURL('share.html')}?session=${encodeURIComponent(sessionId)}&level=${level}` });
});

const reportEl = document.getElementById('report') as HTMLElement;
const titleEl = document.getElementById('bar-title') as HTMLElement;
const metaEl = document.getElementById('bar-meta') as HTMLElement;
const levelsEl = document.getElementById('bar-levels') as HTMLElement;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;

// Start at Standard — the same default as the side panel's export chooser, so
// the two surfaces agree the moment a session stops. Selections sync both ways
// via the report/level broadcast.
let level: VerbosityLevel = ['L0', 'L1', 'L2', 'L3'].includes(params.get('level') ?? '') ? params.get('level') as VerbosityLevel : 'L1';
let loaded: {
  session: Awaited<ReturnType<typeof getSession>>;
  events: SessionEvent[];
  assetsMeta: AssetMeta[];
  mediaUrls: Map<string, string>;
} | null = null;

const LEVELS: { id: VerbosityLevel; label: string }[] = [
  { id: 'L0', label: 'Full' },
  { id: 'L1', label: 'Standard' },
  { id: 'L2', label: 'Compact' },
  { id: 'L3', label: 'Minimal' },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function fail(message: string): void {
  reportEl.replaceChildren(el('p', 'loading', message));
}

/** Trim events for a level, always keeping the report screenshot-rich at L0. */
function trimForLevel(
  events: SessionEvent[],
  lvl: VerbosityLevel,
  ctx: TrimContext,
): SessionEvent[] {
  // L0 in the viewer means "everything meaningful": keep all screenshots and
  // bodies, but drop static/telemetry noise and fold exact-duplicate polling
  // requests (one kept + an "N more collapsed" marker) so a chatty app doesn't
  // render megabytes of identical responses. The Full-level *download* stays
  // truly full — this only tames the on-screen view.
  if (lvl === 'L0') {
    return collapseRepeatedRequests()(dropStaticAssets()(events, ctx), ctx);
  }
  return applyLevel(events, lvl, ctx);
}

async function load(): Promise<void> {
  if (!sessionId) return fail('No session specified.');
  const session = await getSession(sessionId);
  if (!session) return fail('Session not found.');
  const [events, assets] = await Promise.all([
    getEvents(sessionId),
    getAssets(sessionId),
  ]);

  titleEl.textContent = session.name;
  document.title = `${session.name} — Session report`;
  const duration = Math.max(
    0,
    (session.endedAt ?? session.startedAt) - session.startedAt,
  );
  const total = Object.values(session.counts).reduce((a, n) => a + (n ?? 0), 0);
  metaEl.textContent = `${formatClock(duration)} · ${total} events`;

  // Object URLs for every renderable media asset (images inline as <img>,
  // video segments as <video>).
  const mediaUrls = new Map<string, string>();
  for (const a of assets) {
    if (
      a.kind === 'screenshot' ||
      a.kind === 'video' ||
      a.mime.startsWith('image/') ||
      a.mime.startsWith('video/')
    ) {
      mediaUrls.set(a.id, URL.createObjectURL(a.blob));
    }
  }
  const assetsMeta: AssetMeta[] = assets.map(({ blob: _b, ...m }) => m);
  loaded = { session, events, assetsMeta, mediaUrls };
  renderLevels();
  render();
}

/** Level selector in the sticky header. */
function renderLevels(): void {
  const seg = el('div', 'r-levels');
  for (const lv of LEVELS) {
    const b = el(
      'button',
      'r-level' + (lv.id === level ? ' r-level--on' : ''),
      lv.label,
    );
    b.title = lv.label;
    b.addEventListener('click', () => {
      setLevel(lv.id);
      // Mirror the choice into the side panel's export chooser.
      if (sessionId) broadcast({ kind: 'report/level', sessionId, level: lv.id });
    });
    seg.appendChild(b);
  }
  levelsEl.replaceChildren(seg);
}

function render(): void {
  if (!loaded || !loaded.session) return;
  const { session, events, assetsMeta, mediaUrls } = loaded;
  const ctx: TrimContext = {
    assetsById: new Map(assetsMeta.map((m) => [m.id, m])),
    settings: session.settings,
  };
  const trimmed = trimForLevel(events, level, ctx);

  const root = el('div');

  // Header
  const appUrls = [...new Set(session.tabs.map((t) => t.url).filter(Boolean))];
  const h = el('div', 'r-head');
  h.appendChild(el('h1', undefined, session.name));
  const meta = el('div', 'r-headmeta');
  meta.appendChild(
    el('span', undefined, appUrls[0] ? new URL(appUrls[0]).host : 'session'),
  );
  meta.appendChild(el('span', 'dot', '·'));
  meta.appendChild(
    el(
      'span',
      undefined,
      formatClock(
        (session.endedAt ?? session.startedAt) - session.startedAt,
      ),
    ),
  );
  meta.appendChild(el('span', 'dot', '·'));
  meta.appendChild(el('span', undefined, new Date(session.startedAt).toLocaleString()));
  const environment = session.environment && describeEnvironment(session.environment);
  if (environment) {
    meta.appendChild(el('span', 'dot', '·'));
    meta.appendChild(el('span', undefined, environment));
  }
  h.appendChild(meta);
  root.appendChild(h);

  // Timeline (group consecutive net-requests into <details>)
  const tl = el('div', 'r-tl');
  let i = 0;
  while (i < trimmed.length) {
    const e = trimmed[i]!;
    if (e.type === 'net-request') {
      let j = i;
      const run: SessionEvent[] = [];
      while (j < trimmed.length && trimmed[j]!.type === 'net-request') {
        run.push(trimmed[j]!);
        j += 1;
      }
      if (run.length >= 3) {
        tl.appendChild(netGroup(run));
      } else {
        for (const r of run) tl.appendChild(eventNode(r, mediaUrls));
      }
      i = j;
    } else if (e.type === 'voice-segment') {
      // Stitch a run of consecutive voice segments into one paragraph.
      let j = i;
      const run: Extract<SessionEvent, { type: 'voice-segment' }>[] = [];
      while (j < trimmed.length && trimmed[j]!.type === 'voice-segment') {
        run.push(trimmed[j]! as Extract<SessionEvent, { type: 'voice-segment' }>);
        j += 1;
      }
      tl.appendChild(run.length >= 2 ? voiceGroup(run) : eventNode(e, mediaUrls));
      i = j;
    } else {
      tl.appendChild(eventNode(e, mediaUrls));
      i += 1;
    }
  }
  root.appendChild(tl);

  reportEl.replaceChildren(root);
}

function setLevel(lv: VerbosityLevel): void {
  if (lv === level) return;
  level = lv;
  renderLevels();
  render();
}

// ---- event nodes ----------------------------------------------------------

function clockOf(e: SessionEvent): HTMLElement {
  return el('span', 'r-time', formatClock(e.t));
}

function eventNode(e: SessionEvent, mediaUrls: Map<string, string>): HTMLElement {
  const row = el('div', 'r-row');
  switch (e.type) {
    case 'nav':
    case 'spa-route': {
      row.className = 'r-nav';
      row.append(clockOf(e), el('span', 'r-navlabel', pathTitle(e)));
      return row;
    }
    case 'click': {
      const d = e.payload.descriptor;
      row.append(clockOf(e), tag('click'), el('span', 'r-txt', `Clicked ${label(d.text || d.ariaLabel || d.selector || d.tag)}`));
      return row;
    }
    case 'input': {
      const val = e.payload.redacted ? '«redacted»' : e.payload.value;
      row.append(clockOf(e), tag('type'), el('span', 'r-txt', label(val)));
      return row;
    }
    case 'key':
      row.append(clockOf(e), tag('key'), el('span', 'r-txt', e.payload.key));
      return row;
    case 'hover': {
      const d = e.payload.descriptor;
      const noun = d.role || d.tag || 'element';
      const lbl = d.text || d.ariaLabel || d.name;
      row.className = 'r-row r-muted';
      row.append(
        clockOf(e),
        tag('hover'),
        el('span', 'r-txt', `Hovered ${noun}${lbl ? ` ${label(lbl)}` : ''}`),
      );
      return row;
    }
    case 'scroll':
      row.className = 'r-row r-muted';
      row.append(clockOf(e), tag('scroll'), el('span', 'r-txt', 'Scrolled'));
      return row;
    case 'text-select': {
      row.className = 'r-row r-muted';
      const txt = e.payload.cleared
        ? 'Selection cleared'
        : `Selected ${label(e.payload.text)}`;
      row.append(clockOf(e), tag('select'), el('span', 'r-txt', txt));
      return row;
    }
    case 'net-request':
      return netRow(e.payload, e);
    case 'console': {
      const p = e.payload;
      row.className = 'r-row' + (p.level === 'error' ? ' r-err' : ' r-muted');
      row.append(clockOf(e), tag(p.level === 'error' ? 'error' : 'log'), el('span', 'r-txt', p.text));
      return row;
    }
    case 'error': {
      const rep = e.payload.repeat && e.payload.repeat > 1 ? ` (×${e.payload.repeat})` : '';
      row.className = 'r-row r-err';
      row.append(clockOf(e), tag('error'), el('span', 'r-txt', e.payload.message + rep));
      return row;
    }
    case 'screenshot':
      return shotBlock(e.t, mediaUrls.get(e.payload.assetId ?? ''), e.payload.contextText);
    case 'annotation':
      return annotationBlock(e.t, mediaUrls.get(e.payload.screenshotAssetId ?? ''), e.payload.shapes);
    case 'video-segment':
      return videoBlock(
        e.t,
        mediaUrls.get(e.payload.assetId ?? ''),
        e.payload.tStart,
        e.payload.tEnd,
      );
    case 'voice-segment': {
      const p = e.payload;
      const b = el('div', 'r-signal r-voice');
      b.append(clockOf(e), tag('voice'));
      const body = el('div');
      body.appendChild(el('div', 'r-signal__text', p.transcript ?? '(audio)'));
      if (p.anchorContext) body.appendChild(el('div', 'r-signal__sub', `while ${p.anchorContext}`));
      b.appendChild(body);
      return b;
    }
    case 'marker': {
      const b = el('div', 'r-signal r-marker');
      b.append(clockOf(e), tag('marker'), el('span', 'r-signal__text', e.payload.name));
      return b;
    }
    case 'note': {
      const b = el('div', 'r-signal r-note');
      b.append(clockOf(e), tag('note'), el('span', 'r-signal__text', e.payload.text));
      return b;
    }
    case 'file-captured':
    case 'file-attached': {
      const b = el('div', 'r-signal r-file');
      b.append(clockOf(e), tag('file'), el('span', 'r-signal__text', e.payload.fileName));
      return b;
    }
    default:
      row.className = 'r-row r-muted';
      row.append(clockOf(e), el('span', 'r-txt', descOf(e)));
      return row;
  }
}

function netRow(p: NetRequestPayload, e: SessionEvent): HTMLElement {
  const bad = p.failed || (typeof p.status === 'number' && p.status >= 400);
  const row = el('div', 'r-net' + (bad ? ' r-err' : ''));
  const line = el('div', 'r-netline');
  line.append(clockOf(e), tag('net'));
  line.appendChild(el('span', 'r-net__meth', `${p.method} ${pathOf(p.url)}`));
  const status = p.failed ? 'failed' : netMeta(p.status, p.timing?.durationMs);
  if (status) line.appendChild(el('span', 'r-net__status', status));
  row.appendChild(line);
  if (p.collapsed) {
    row.appendChild(el('div', 'r-net__note', `(×${p.collapsed.count} similar, statuses ${p.collapsed.statuses.join(', ')})`));
  } else if (p.bodyShape) {
    if (p.bodyShape.request) row.appendChild(bodyPre('request shape', p.bodyShape.request));
    if (p.bodyShape.response) row.appendChild(bodyPre('response shape', p.bodyShape.response));
  } else {
    if (p.requestBody?.text) row.appendChild(bodyPre('request', p.requestBody.text));
    if (p.responseBody?.text) row.appendChild(bodyPre('response', p.responseBody.text));
  }
  return row;
}

function netGroup(run: SessionEvent[]): HTMLElement {
  const errors = run.filter(
    (e) => e.type === 'net-request' && (e.payload.failed || (typeof e.payload.status === 'number' && e.payload.status >= 400)),
  ).length;
  const wrap = el('div', 'r-netgroup');
  const details = el('details');
  const summary = el('summary', 'r-net');
  const line = el('div', 'r-netline');
  line.append(clockOf(run[0]!), tag('net'));
  line.appendChild(el('span', 'r-net__meth', `${run.length} network requests`));
  if (errors > 0) line.appendChild(el('span', 'r-net__status r-err', `${errors} failed`));
  summary.appendChild(line);
  details.appendChild(summary);
  const inner = el('div', 'r-netgroup__list');
  for (const e of run) {
    if (e.type === 'net-request') inner.appendChild(netRow(e.payload, e));
  }
  details.appendChild(inner);
  wrap.appendChild(details);
  return wrap;
}

/** Stitch a run of consecutive voice segments into one narration block. */
function voiceGroup(
  run: Extract<SessionEvent, { type: 'voice-segment' }>[],
): HTMLElement {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const text = run
    .map((e) => e.payload.transcript)
    .filter((t): t is string => !!t && t.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const start = first.payload.tStart ?? first.t;
  const end = last.payload.tEnd ?? last.t;
  const dur = Math.max(0, end - start);

  const b = el('div', 'r-signal r-voice');
  b.append(clockOf(first), tag('voice'));
  const body = el('div', 'r-voice__body');
  body.appendChild(el('div', 'r-signal__text', text || '(audio)'));
  const meta = el('div', 'r-voice__meta');
  meta.textContent = `${formatClock(start)}–${formatClock(end)} · ${formatDuration(dur)}`;
  body.appendChild(meta);
  b.appendChild(body);
  return b;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function shotBlock(t: number, url: string | undefined, ctx?: string): HTMLElement {
  const b = el('div', 'r-shot');
  const head = el('div', 'r-shot__head');
  head.append(el('span', 'r-time', formatClock(t)), tag('shot'), el('span', 'r-txt', ctx || 'Screenshot'));
  b.appendChild(head);
  if (url) {
    const img = el('img');
    img.src = url;
    img.alt = 'screenshot';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(url, '_blank'));
    b.appendChild(img);
  }
  return b;
}

function annotationBlock(t: number, url: string | undefined, shapes: AnnotationShape[]): HTMLElement {
  const b = el('div', 'r-shot');
  const head = el('div', 'r-shot__head');
  head.append(el('span', 'r-time', formatClock(t)), tag('annotate'), el('span', 'r-txt', `Annotation (${shapes.length} shape${shapes.length === 1 ? '' : 's'})`));
  b.appendChild(head);
  for (const shape of shapes) {
    if (!shape.text) continue;
    b.appendChild(el('p', 'r-annotation-comment', shape.text));
    if (shape.targetDescriptor?.selector) b.appendChild(el('code', 'r-annotation-target', shape.targetDescriptor.selector));
  }
  if (url) {
    const img = el('img');
    img.src = url;
    img.alt = 'annotation';
    img.addEventListener('click', () => window.open(url, '_blank'));
    b.appendChild(img);
  }
  return b;
}

/** Inline playable video segment, styled like a screenshot block. */
function videoBlock(
  t: number,
  url: string | undefined,
  tStart: number,
  tEnd: number,
): HTMLElement {
  const b = el('div', 'r-shot');
  const head = el('div', 'r-shot__head');
  head.append(
    el('span', 'r-time', formatClock(t)),
    tag('video'),
    el('span', 'r-txt', `Video segment ${formatClock(tStart)}–${formatClock(tEnd)}`),
  );
  b.appendChild(head);
  if (url) {
    const video = el('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = url;
    b.appendChild(video);
  }
  return b;
}

function bodyPre(label: string, text: string): HTMLElement {
  const wrap = el('div', 'r-body');
  wrap.appendChild(el('div', 'r-body__label', label));
  const pre = el('pre');
  pre.appendChild(el('code', undefined, text));
  wrap.appendChild(pre);
  return wrap;
}

function tag(name: string): HTMLElement {
  return el('span', `r-tag r-tag--${name}`, name);
}

// ---- helpers --------------------------------------------------------------

function label(s: string | undefined): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `"${t.slice(0, 79)}…"` : `"${t}"`;
}
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search.length > 1 ? u.search.slice(0, 40) : '');
  } catch {
    return url.slice(0, 60);
  }
}
function pathTitle(e: SessionEvent): string {
  if (e.type === 'nav' || e.type === 'spa-route') {
    return e.payload.title || pathOf(e.payload.url);
  }
  return '';
}
function netMeta(status?: number, ms?: number): string {
  return [typeof status === 'number' ? String(status) : '', typeof ms === 'number' ? `${Math.round(ms)}ms` : '']
    .filter(Boolean)
    .join(' · ');
}
function descOf(e: SessionEvent): string {
  if (e.type === 'session-note') return e.payload.text;
  return e.type;
}

// ---- download + live level sync -------------------------------------------

downloadBtn.addEventListener('click', async () => {
  if (!sessionId) return;
  downloadBtn.disabled = true;
  const label = downloadBtn.textContent;
  downloadBtn.textContent = 'Preparing…';
  try {
    const [session, events, assets] = await Promise.all([
      getSession(sessionId),
      getEvents(sessionId),
      getAssets(sessionId),
    ]);
    if (!session) return;
    const files = await buildBundle({ session, events, assets, level });
    const folder = sessionFolderName(session);
    const bytes = await zipFiles(files, folder);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    await chrome.downloads.download({ url, filename: `${folder}.zip` });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = label;
  }
});

// Re-render when the side panel changes the export level for this session.
onBroadcast((evt) => {
  if (evt.kind === 'report/level' && evt.sessionId === sessionId) {
    setLevel(evt.level);
  }
});

void load().catch((e) => fail(String((e as Error)?.message ?? e)));
