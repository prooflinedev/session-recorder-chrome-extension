/**
 * Pure Markdown renderer for exported sessions.
 *
 * Turns a (session, events, assets, level) tuple into the human- and
 * LLM-readable `report.md` plus the `MANIFEST.md` asset index. The report must
 * read well WITHOUT opening any asset: interactions become one-liners,
 * navigation/tab events become `##` section breaks, network/console/error and
 * annotations are rendered inline, and `[mm:ss]` timestamps anchor every line so
 * the transcript, screenshots and events all join on the same clock.
 *
 * This module is pure: no chrome/DOM/network access, no input mutation (events
 * are cloned before sorting), no global mutable state.
 */

import type {
  AnnotationShape,
  AssetMeta,
  ElementDescriptor,
  NetBody,
  Session,
  SessionEvent,
  VerbosityLevel,
} from '@/lib/session/types';
import { buildAnchorMap } from './anchor';

export interface RenderInput {
  session: Session;
  events: SessionEvent[];
  assets: AssetMeta[];
  level: VerbosityLevel;
  /** Zip-relative path for an asset, or undefined if it is not included. */
  assetPath: (assetId: string) => string | undefined;
  /** Set when the bundle includes a compiled OpenAPI spec (captureApiSpec). */
  openapi?: { path: string; endpointCount: number };
  /** Set when the bundle includes the generated repro test. */
  repro?: ReproSummary;
}

/** What the report says about the generated repro test (lib/export/repro). */
export interface ReproSummary {
  path: string;
  /** The Playwright config that runs only `path`. */
  configPath: string;
  steps: number;
  /** One line per checked signal. */
  signals: string[];
  /** What the replay leaves out. */
  gaps: string[];
  envVars: { name: string; label: string }[];
  /** Set when there is nothing to check. */
  fixme?: string;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/** Format milliseconds-from-start as `mm:ss`, or `h:mm:ss` past an hour. */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSec % 60;
  const minutes = Math.floor(totalSec / 60);
  const ss = String(seconds).padStart(2, '0');
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mm = String(minutes % 60).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${String(minutes).padStart(2, '0')}:${ss}`;
}

/** The full `report.md` for a session at the given verbosity level. */
export function renderReport(input: RenderInput): string {
  const events = sortedEvents(input.events);
  const lines: string[] = [];

  const anchors = buildAnchorMap(events);
  renderHeader(input, events, lines);
  if (input.repro) renderRepro(input.repro, lines);
  lines.push('');
  lines.push('## Timeline');
  lines.push('');
  // Stitch runs of consecutive voice segments into one narration line; render
  // everything else event-by-event.
  let i = 0;
  while (i < events.length) {
    const e = events[i] as SessionEvent;
    if (e.type === 'voice-segment') {
      let j = i;
      const run: Extract<SessionEvent, { type: 'voice-segment' }>[] = [];
      while (j < events.length && events[j]!.type === 'voice-segment') {
        run.push(events[j] as Extract<SessionEvent, { type: 'voice-segment' }>);
        j += 1;
      }
      if (run.length >= 2) renderVoiceGroup(run, lines);
      else renderEvent(e, input, lines, anchors);
      i = j;
    } else {
      renderEvent(e, input, lines, anchors);
      i += 1;
    }
  }

  renderAppendices(events, input, lines);

  return normalize(lines);
}

/** The `MANIFEST.md` index of every asset actually included in the bundle. */
export function renderManifest(input: RenderInput): string {
  const lines: string[] = [];
  lines.push('# Asset Manifest');
  lines.push('');
  lines.push(
    `Session: **${escapeInline(input.session.name)}** — level ${input.level}`,
  );
  lines.push('');

  const included = input.assets
    .map((a) => ({ asset: a, path: input.assetPath(a.id) }))
    .filter((x): x is { asset: AssetMeta; path: string } => x.path != null)
    .sort((a, b) => a.path.localeCompare(b.path));

  if (included.length === 0) {
    lines.push('_No assets included at this level._');
    return normalize(lines);
  }

  lines.push('| Path | Kind | Size | Description |');
  lines.push('| --- | --- | --- | --- |');
  for (const { asset, path } of included) {
    lines.push(
      `| \`${path}\` | ${asset.kind} | ${humanBytes(asset.size)} | ${escapeCell(
        describeAsset(asset),
      )} |`,
    );
  }
  lines.push('');
  lines.push(`**${included.length}** asset(s), ${humanBytes(
    included.reduce((sum, x) => sum + x.asset.size, 0),
  )} total.`);
  return normalize(lines);
}

// ----------------------------------------------------------------------------
// Header
// ----------------------------------------------------------------------------

function renderHeader(
  input: RenderInput,
  events: SessionEvent[],
  lines: string[],
): void {
  const { session } = input;
  lines.push(`# Session Report: ${escapeInline(session.name)}`);
  lines.push('');

  const appUrls = collectAppUrls(session);
  const lastT = events.length > 0 ? (events[events.length - 1] as SessionEvent).t : 0;
  const durationMs =
    session.endedAt != null ? session.endedAt - session.startedAt : lastT;

  lines.push(`- **App:** ${appUrls.length > 0 ? appUrls.join(', ') : '(none)'}`);
  lines.push(`- **Date:** ${new Date(session.startedAt).toISOString()}`);
  lines.push(`- **Duration:** ${formatClock(durationMs)}`);
  lines.push(`- **Verbosity level:** ${input.level}`);
  lines.push(`- **Events:** ${events.length}`);
  if (input.openapi) {
    lines.push(
      `- **API spec:** \`${input.openapi.path}\` (${input.openapi.endpointCount} endpoint(s) compiled from captured requests)`,
    );
  }
  if (input.repro) {
    const n = input.repro.signals.length;
    const checks = n === 0 ? 'nothing to check' : `${n} checked signal${n === 1 ? '' : 's'}`;
    lines.push(
      `- **Repro test:** \`${input.repro.path}\` (${input.repro.steps} steps, ${checks})`,
    );
  }
  lines.push('');

  // Tab registry.
  lines.push('### Tabs');
  lines.push('');
  if (session.tabs.length === 0) {
    lines.push('_No tabs recorded._');
  } else {
    lines.push('| Tab | Role | URL | Title |');
    lines.push('| --- | --- | --- | --- |');
    for (const tab of session.tabs) {
      lines.push(
        `| ${tab.tabId} | ${tab.role} | ${escapeCell(tab.url)} | ${escapeCell(
          tab.title,
        )} |`,
      );
    }
  }
}

/** How to run the generated repro test and what its result means. */
function renderRepro(repro: ReproSummary, lines: string[]): void {
  lines.push('');
  lines.push('## Repro test');
  lines.push('');
  lines.push(
    `\`${repro.path}\` replays this recording with Playwright and checks whether the recorded errors happen again. Run it before you change any code, and use it as a fix check only if that run fails with \`REPRODUCED\`.`,
  );
  lines.push('');
  lines.push('```sh');
  lines.push('npm install --no-save @playwright/test && npx playwright install chromium');
  lines.push('BASE_URL=http://localhost:3000 npx playwright test');
  lines.push('```');
  lines.push('');
  lines.push(
    `Run it in the unzipped folder: \`${repro.configPath}\` runs only \`${repro.path}\`, so files captured from the page never run as tests.`,
  );
  lines.push('');
  if (repro.fixme) {
    lines.push(`> ${escapeInline(oneLine(repro.fixme))}`);
    lines.push('');
    lines.push('The test is marked `fixme` until you add an assertion.');
  } else {
    lines.push('- `REPRODUCED` (fails): a recorded error happened again.');
    lines.push(
      '- `INCONCLUSIVE` (fails): the replay did not reach the bug, so it shows nothing about a fix.',
    );
    lines.push(
      '- `NOT REPRODUCED` (passes): every step ran and no recorded error happened again. It does not prove the bug is fixed.',
    );
  }
  lines.push('');
  lines.push(
    '`BASE_URL` is the server to test. The test refuses a non-local address and blocks requests that change data on non-local hosts unless `REPRO_ALLOW_REMOTE=1`. `REPRO_STORAGE_STATE` names a Playwright storage-state file to start signed in.',
  );
  // Items are recorded text: one line each, with backticks neutralised.
  const list = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(title);
    lines.push('');
    for (const item of items) lines.push(`- ${item}`);
  };
  const text = (s: string) => escapeInline(oneLine(s));
  list('Checked signals:', repro.signals.map(text));
  list(
    'Values to set (redacted when recorded):',
    repro.envVars.map((v) => `\`${v.name}\`: ${text(v.label)}`),
  );
  list('Not replayed or not checked:', repro.gaps.map(text));
}

/**
 * Stitch a run of consecutive voice segments into one narration blockquote:
 * the transcript reads as prose, with the time span + total duration at the end.
 */
function renderVoiceGroup(
  run: Extract<SessionEvent, { type: 'voice-segment' }>[],
  lines: string[],
): void {
  const first = run[0] as Extract<SessionEvent, { type: 'voice-segment' }>;
  const last = run[run.length - 1] as Extract<
    SessionEvent,
    { type: 'voice-segment' }
  >;
  const text = run
    .map((e) => e.payload.transcript)
    .filter((t): t is string => t != null && t.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const start = first.payload.tStart ?? first.t;
  const end = last.payload.tEnd ?? last.t;
  const span = `${formatClock(start)}–${formatClock(end)} · ${formatDuration(
    Math.max(0, end - start),
  )}`;
  const body = text.length > 0 ? escapeInline(text) : '(no transcript)';
  lines.push(`> 🎙️ [${formatClock(start)}] ${body} _(${span})_`);
}

/** Compact duration like `28s` or `1m 12s`. */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

// ----------------------------------------------------------------------------
// Per-event rendering
// ----------------------------------------------------------------------------

function renderEvent(
  e: SessionEvent,
  input: RenderInput,
  lines: string[],
  anchors?: Map<string, string>,
): void {
  const clock = `[${formatClock(e.t)}]`;
  const tab = tabSuffix(e.tabId);

  switch (e.type) {
    // --- interactions: one-liners ------------------------------------------
    case 'click': {
      const d = e.payload.descriptor;
      const mods =
        e.payload.modifiers.length > 0 ? ` +${e.payload.modifiers.join('+')}` : '';
      lines.push(
        `${clock} CLICK ${quoteLabel(labelOf(d))} (${selectorOf(d)}${tab})${mods}`,
      );
      break;
    }
    case 'input': {
      const d = e.payload.descriptor;
      const value = e.payload.redacted ? '«redacted»' : oneLine(e.payload.value);
      lines.push(
        `${clock} INPUT ${quoteLabel(value)} into (${selectorOf(d)}${tab})`,
      );
      break;
    }
    case 'key': {
      const where = e.payload.descriptor
        ? ` (${selectorOf(e.payload.descriptor)}${tab})`
        : tab
          ? ` (${tab.slice(2)})`
          : '';
      const mods =
        e.payload.modifiers.length > 0 ? `${e.payload.modifiers.join('+')}+` : '';
      lines.push(`${clock} KEY ${mods}${e.payload.key}${where}`);
      break;
    }
    case 'hover': {
      const d = e.payload.descriptor;
      const noun = d.role || d.tag || 'element';
      const lbl = labelOf(d);
      const dwell = e.payload.dwellMs ? ` for ${(e.payload.dwellMs / 1000).toFixed(1)}s` : '';
      lines.push(
        `${clock} HOVER ${noun}${lbl ? ` ${quoteLabel(lbl)}` : ''} (${selectorOf(d)}${tab})${dwell}`,
      );
      break;
    }
    case 'text-select': {
      if (e.payload.cleared) {
        lines.push(`${clock} SELECT cleared${tab ? ` (${tab.slice(2)})` : ''}`);
        break;
      }
      const d = e.payload.descriptor;
      const text = (e.payload.text ?? '') + (e.payload.truncated ? '…' : '');
      lines.push(
        `${clock} SELECT ${quoteLabel(text)}${d ? ` (${selectorOf(d)}${tab})` : ''}`,
      );
      break;
    }
    case 'scroll': {
      const p = e.payload;
      const where = p.container ?? 'window';
      lines.push(
        `${clock} SCROLL (${p.from.x},${p.from.y}) → (${p.to.x},${p.to.y}) [${where}${tab}]`,
      );
      break;
    }

    // --- navigation / tabs: section breaks ---------------------------------
    case 'nav': {
      lines.push('');
      lines.push(
        `## ${clock} NAV ${escapeInline(e.payload.url)}${titlePart(e.payload.title)}`,
      );
      lines.push('');
      break;
    }
    case 'spa-route': {
      lines.push('');
      lines.push(
        `## ${clock} ROUTE (${e.payload.method}) ${escapeInline(
          e.payload.url,
        )}${titlePart(e.payload.title)}`,
      );
      lines.push('');
      break;
    }
    case 'tab-switch': {
      lines.push('');
      lines.push(
        `## ${clock} TAB SWITCH → tab ${e.payload.toTabId}${
          e.payload.toUrl ? ` ${escapeInline(e.payload.toUrl)}` : ''
        }${titlePart(e.payload.toTitle)}`,
      );
      lines.push('');
      break;
    }
    case 'tab-opened': {
      lines.push('');
      lines.push(
        `## ${clock} TAB OPENED${
          e.payload.url ? ` ${escapeInline(e.payload.url)}` : ''
        }${titlePart(e.payload.title)}`,
      );
      lines.push('');
      break;
    }
    case 'tab-closed': {
      lines.push('');
      lines.push(
        `## ${clock} TAB CLOSED${
          e.payload.url ? ` ${escapeInline(e.payload.url)}` : ''
        }${titlePart(e.payload.title)}`,
      );
      lines.push('');
      break;
    }

    // --- network -----------------------------------------------------------
    case 'net-request': {
      renderNetRequest(e, input, lines);
      break;
    }

    // --- console / error ---------------------------------------------------
    case 'console': {
      const p = e.payload;
      const repeat = p.repeat && p.repeat > 1 ? ` (×${p.repeat})` : '';
      const src = p.source ? ` @ ${p.source}` : '';
      lines.push(`${clock} console.${p.level}${repeat}${src}`);
      lines.push('```');
      lines.push(p.text);
      lines.push('```');
      break;
    }
    case 'error': {
      const p = e.payload;
      const repeat = p.repeat && p.repeat > 1 ? ` (×${p.repeat})` : '';
      lines.push('');
      lines.push(`⚠ **ERROR ${clock}**${repeat} (${p.origin}) ${oneLine(p.message)}`);
      if (p.stack) {
        lines.push('```');
        lines.push(p.stack);
        lines.push('```');
      }
      lines.push('');
      break;
    }

    // --- visual ------------------------------------------------------------
    case 'screenshot': {
      const path = input.assetPath(e.payload.assetId);
      if (!path) break; // not included: skip entirely
      const ctx = e.payload.contextText
        ? oneLine(e.payload.contextText)
        : `screenshot (${e.payload.trigger})`;
      lines.push(`${clock} 📷 ${escapeInline(ctx)}`);
      lines.push(`![${escapeInline(ctx)}](${path})`);
      break;
    }
    case 'annotation-start': {
      // Marker only; the paired `annotation` event carries the content.
      break;
    }
    case 'annotation': {
      renderAnnotation(e, input, lines);
      break;
    }

    // --- voice -------------------------------------------------------------
    case 'voice-segment': {
      const p = e.payload;
      const text =
        p.transcript != null && p.transcript.trim().length > 0
          ? oneLine(p.transcript)
          : p.transcriptionError
            ? `(transcription failed: ${oneLine(p.transcriptionError)})`
            : '(no transcript)';
      // Smart anchoring: note what the user was doing as they spoke.
      const anchor = anchors?.get(e.id);
      const where = anchor ? ` _(while ${escapeInline(anchor)})_` : '';
      lines.push(`> 🎙️ ${clock}${where} ${escapeInline(text)}`);
      break;
    }

    // --- video -------------------------------------------------------------
    case 'video-segment': {
      const p = e.payload;
      const span = `${formatClock(p.tStart)}–${formatClock(p.tEnd)}`;
      const path = p.assetId ? input.assetPath(p.assetId) : undefined;
      const link = path ? ` → \`${path}\`` : '';
      const note = p.note ? ` — ${escapeInline(oneLine(p.note))}` : '';
      lines.push(`${clock} 🎬 VIDEO segment ${span}${link}${note}`);
      break;
    }

    // --- files -------------------------------------------------------------
    case 'file-captured':
    case 'file-attached': {
      const p = e.payload;
      const verb = e.type === 'file-attached' ? 'ATTACHED' : 'CAPTURED';
      const ctx = p.contextText ? ` — ${oneLine(p.contextText)}` : '';
      const meta = p.metadataOnly ? ', metadata-only' : '';
      const path = p.assetId ? input.assetPath(p.assetId) : undefined;
      const link = path ? ` → \`${path}\`` : '';
      lines.push(
        `${clock} 📎 FILE ${verb} "${escapeInline(p.fileName)}" (${p.mime}, ${humanBytes(
          p.size,
        )}${meta})${ctx}${link}`,
      );
      break;
    }

    // --- user signals ------------------------------------------------------
    case 'marker': {
      lines.push('');
      lines.push(`> ## 📌 MARKER ${clock}: ${escapeInline(e.payload.name)}`);
      lines.push('');
      break;
    }
    case 'note': {
      lines.push('');
      lines.push(`> ## 📝 NOTE ${clock}`);
      for (const ln of e.payload.text.split('\n')) lines.push(`> ${ln}`);
      lines.push('');
      break;
    }
    case 'session-note': {
      lines.push(`> ℹ️ ${clock} (${e.payload.kind}) ${escapeInline(e.payload.text)}`);
      break;
    }

    default:
      assertNever(e);
  }
}

function renderNetRequest(
  e: Extract<SessionEvent, { type: 'net-request' }>,
  input: RenderInput,
  lines: string[],
): void {
  const clock = `[${formatClock(e.t)}]`;
  const p = e.payload;
  const status = p.failed
    ? `FAILED${p.failureReason ? ` (${p.failureReason})` : ''}`
    : p.status != null
      ? String(p.status)
      : '—';
  const path = urlPath(p.url);
  const ws = p.websocket ? ' [ws]' : '';
  lines.push('');
  lines.push(`${clock} 🌐 ${status} ${p.method} ${escapeInline(path)}${ws}`);

  // Collapsed repeated requests take precedence — the body was thrown away.
  if (p.collapsed) {
    const statuses = p.collapsed.statuses.join(', ');
    const note = p.collapsed.note ? ` — ${p.collapsed.note}` : '';
    lines.push(
      `> (×${p.collapsed.count} similar…) statuses: ${statuses}${note}`,
    );
    lines.push('');
    return;
  }

  // Shape summary form.
  if (p.bodyShape) {
    if (p.bodyShape.request) {
      lines.push(`- request shape: \`${oneLine(p.bodyShape.request)}\``);
    }
    if (p.bodyShape.response) {
      lines.push(`- response shape: \`${oneLine(p.bodyShape.response)}\``);
    }
    lines.push('');
    return;
  }

  // Websocket frames instead of bodies.
  if (p.websocket && p.wsFrames && p.wsFrames.length > 0) {
    lines.push('```');
    for (const f of p.wsFrames) {
      const arrow = f.dir === 'sent' ? '→' : '←';
      const trunc = f.truncated ? ' …' : '';
      lines.push(`${arrow} [${formatClock(f.ts)}] ${oneLine(f.text ?? '')}${trunc}`);
    }
    lines.push('```');
    lines.push('');
    return;
  }

  // Full fenced request / response bodies.
  renderBody('Request', p.requestBody, input, lines);
  renderBody('Response', p.responseBody, input, lines);
  lines.push('');
}

function renderBody(
  label: string,
  body: NetBody | undefined,
  input: RenderInput,
  lines: string[],
): void {
  if (!body) return;
  if (!body.present) {
    lines.push(`- ${label}: _(body not captured)_`);
    return;
  }
  const notes: string[] = [];
  if (body.mime) notes.push(body.mime);
  if (body.base64) notes.push('base64');
  if (body.truncated) {
    notes.push(
      body.originalSize != null
        ? `truncated from ${humanBytes(body.originalSize)}`
        : 'truncated',
    );
  }
  const assetLink = body.assetId ? input.assetPath(body.assetId) : undefined;
  if (assetLink) notes.push(`full body: \`${assetLink}\``);
  const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';

  if (body.text == null || body.text.length === 0) {
    lines.push(`- ${label}${suffix}: _(empty)_`);
    return;
  }
  lines.push(`- ${label}${suffix}:`);
  lines.push('```' + fenceLang(body.mime));
  lines.push(body.text);
  lines.push('```');
}

function renderAnnotation(
  e: Extract<SessionEvent, { type: 'annotation' }>,
  input: RenderInput,
  lines: string[],
): void {
  const clock = `[${formatClock(e.t)}]`;
  const p = e.payload;
  lines.push('');
  lines.push(`### ${clock} Annotation`);
  if (p.shapes.length === 0) {
    lines.push('- _(no shapes)_');
  } else {
    for (const shape of p.shapes) lines.push(`- ${describeShape(shape)}`);
  }
  const path = p.screenshotAssetId
    ? input.assetPath(p.screenshotAssetId)
    : undefined;
  if (path) lines.push(`![](${path})`);
  lines.push('');
}

function describeShape(shape: AnnotationShape): string {
  const parts: string[] = [`**${shape.tool}**`];
  if (shape.color) parts.push(shape.color);
  if (shape.text) parts.push(`"${oneLine(shape.text)}"`);
  const target = shape.targetDescriptor;
  if (target) {
    const label = labelOf(target);
    parts.push(
      `on ${selectorOf(target)}${label ? ` (${quoteLabel(label)})` : ''}`,
    );
  }
  return parts.join(' ');
}

// ----------------------------------------------------------------------------
// Appendices
// ----------------------------------------------------------------------------

function renderAppendices(
  events: SessionEvent[],
  input: RenderInput,
  lines: string[],
): void {
  const nets = events.filter(
    (e): e is Extract<SessionEvent, { type: 'net-request' }> =>
      e.type === 'net-request',
  );
  const consoles = events.filter(
    (e): e is Extract<SessionEvent, { type: 'console' | 'error' }> =>
      e.type === 'console' || e.type === 'error',
  );

  if (nets.length > 0) {
    lines.push('');
    lines.push('## Appendix: Network Index');
    lines.push('');
    for (const e of nets) {
      const p = e.payload;
      const status = p.failed ? 'FAIL' : p.status != null ? String(p.status) : '—';
      lines.push(
        `- [${formatClock(e.t)}] ${status} ${p.method} ${escapeInline(p.url)}`,
      );
    }
  }

  if (consoles.length > 0) {
    lines.push('');
    lines.push('## Appendix: Console Dump');
    lines.push('');
    lines.push('```');
    for (const e of consoles) {
      const stamp = `[${formatClock(e.t)}]`;
      if (e.type === 'error') {
        lines.push(`${stamp} ERROR (${e.payload.origin}) ${oneLine(e.payload.message)}`);
      } else {
        const repeat =
          e.payload.repeat && e.payload.repeat > 1 ? ` (×${e.payload.repeat})` : '';
        lines.push(`${stamp} ${e.payload.level}${repeat}: ${oneLine(e.payload.text)}`);
      }
    }
    lines.push('```');
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function sortedEvents(events: SessionEvent[]): SessionEvent[] {
  // Clone before sorting — this module must not mutate its inputs.
  return [...events].sort((a, b) => a.t - b.t);
}


function collectAppUrls(session: Session): string[] {
  const origins = new Set<string>();
  const add = (url: string | undefined) => {
    if (!url) return;
    origins.add(originOf(url));
  };
  add(session.initialUrl);
  for (const tab of session.tabs) add(tab.url);
  return [...origins];
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function selectorOf(d?: ElementDescriptor): string {
  if (!d) return '?';
  if (d.selector) return d.selector;
  let s = d.tag || '?';
  if (d.id) s += `#${d.id}`;
  return s;
}

function labelOf(d?: ElementDescriptor): string {
  if (!d) return '';
  return d.text ?? d.ariaLabel ?? d.name ?? '';
}

function quoteLabel(label: string): string {
  return `"${escapeInline(oneLine(label))}"`;
}

function tabSuffix(tabId: number | undefined): string {
  return tabId != null ? `, tab ${tabId}` : '';
}

function titlePart(title: string | undefined): string {
  return title ? ` — ${escapeInline(oneLine(title))}` : '';
}

function fenceLang(mime: string | undefined): string {
  if (!mime) return '';
  if (mime.includes('json')) return 'json';
  if (mime.includes('html')) return 'html';
  if (mime.includes('xml')) return 'xml';
  if (mime.includes('javascript')) return 'js';
  return '';
}

function describeAsset(asset: AssetMeta): string {
  switch (asset.kind) {
    case 'screenshot':
      return `Screenshot (${asset.mime})`;
    case 'audio':
      return `Audio segment (${asset.mime})`;
    case 'video':
      return `Video segment (${asset.mime})`;
    case 'net-body':
      return `Network body (${asset.mime})`;
    case 'file':
      return `Captured file (${asset.mime})`;
    default:
      return asset.mime;
  }
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n}`;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Escape the pipe and backtick characters that would break inline/table cells. */
function escapeInline(s: string): string {
  return s.replace(/`/g, 'ˋ');
}

function escapeCell(s: string): string {
  return oneLine(s).replace(/\|/g, '\\|').replace(/`/g, 'ˋ');
}

/**
 * Collapse runs of blank lines to a single blank line, drop a leading blank
 * line, and end with exactly one trailing newline.
 */
function normalize(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

/** Compile-time exhaustiveness guard mirroring lib/session/events.ts. */
function assertNever(x: never): never {
  throw new Error(`Unhandled event variant: ${JSON.stringify(x)}`);
}
