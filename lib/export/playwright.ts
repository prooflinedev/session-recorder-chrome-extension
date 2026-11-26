/**
 * Playwright repro test for an exported session.
 *
 * Turns a recording into `repro.spec.ts`: a Playwright test that opens the page
 * the session started on, replays the clicks, typing, keys and navigations in
 * order, and checks at each point where the recording hit an uncaught error or
 * a failing API call that it does not happen again. While the bug is present
 * the test fails where the recording did; once it is fixed the test passes, so
 * a developer or a coding agent can use it to check the fix.
 *
 * Its steps come from the trimmed events, so they follow the export level the
 * same way the HAR does. Locators take element details from the full events
 * when the bundle passes them, since higher levels strip those only to save
 * report tokens. Values redacted at capture never reach the file; the test
 * reads them from environment variables instead.
 *
 * This module is pure: no chrome/DOM/network access, no input mutation, no
 * global mutable state.
 */

import { isDictatedSpeech } from '@/lib/session/events';
import type {
  ElementDescriptor,
  NetRequestPayload,
  Session,
  SessionEvent,
  VerbosityLevel,
} from '@/lib/session/types';
import { formatClock } from './markdown';

export interface PlaywrightReproOptions {
  level: VerbosityLevel;
  /** Zip-relative path of the HAR, when the bundle includes one. */
  harPath?: string;
  /**
   * The untrimmed events. Higher levels strip element details to save report
   * tokens; locators take them from here so steps stay findable at every level.
   */
  fullEvents?: SessionEvent[];
}

/**
 * The test for a session, or null when there is nothing to replay: no web page
 * was opened, or no step or check follows the first page load.
 */
export function buildPlaywrightRepro(
  session: Session,
  events: SessionEvent[],
  opts: PlaywrightReproOptions,
): string | null {
  const sorted = [...events].sort((a, b) => a.t - b.t || tieRank(a) - tieRank(b));
  const writer = new ReproWriter(session, sorted, opts);
  for (const e of sorted) writer.add(e);
  return writer.finish();
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

type EventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;

const REDACTION_MARKER = '«redacted»';

/** Descriptor text is cut at this many characters at capture. */
const TEXT_CAP = 80;

const LEVEL_NAMES: Record<VerbosityLevel, string> = {
  L0: 'full',
  L1: 'standard',
  L2: 'compact',
  L3: 'minimal',
};

/** Navigations started from the browser UI rather than from the page. */
const BROWSER_NAVIGATIONS = new Set([
  'typed',
  'auto_bookmark',
  'generated',
  'keyword',
  'keyword_generated',
  'start_page',
]);

/** Roles whose accessible name comes from their content or aria-label. */
const CONTENT_NAMED_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'heading',
]);

const FIELD_TAGS = new Set(['input', 'textarea', 'select']);

const MODIFIER_KEYS: Record<string, string> = {
  ctrl: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
};

/** Waits last as long as the recording took to get there, plus this. */
const WAIT_SLACK_MS = 500;
/** An error recorded later than this after its step is waited for this long. */
const MAX_CHECK_WAIT_MS = 30_000;
const MAX_HISTORY_WAIT_MS = 3000;
/** How long the end-of-test re-check gives late errors to surface. */
const FINAL_CHECK_WAIT_MS = 1000;

/** An input event this soon after a click on the same control is the change it caused. */
const CLICK_CHANGE_WINDOW_MS = 2000;

/** Clicking a label makes the browser click its control a few milliseconds later. */
const LABEL_FORWARD_MS = 100;
const LABELABLE_TAGS = new Set([
  'button',
  'input',
  'meter',
  'output',
  'progress',
  'select',
  'textarea',
]);

const DEFAULT_TEST_TIMEOUT_MS = 30_000;

/**
 * Events can share a millisecond, and storage returns ties in any order. Put them
 * in cause-and-effect order: typing is flushed just before the click or key that
 * flushed it, and errors and requests follow the step that caused them.
 */
function tieRank(e: SessionEvent): number {
  switch (e.type) {
    case 'input':
      return 0;
    case 'click':
    case 'key':
    case 'hover':
    case 'scroll':
      return 1;
    case 'nav':
    case 'spa-route':
      return 2;
    default:
      return 3;
  }
}

// ----------------------------------------------------------------------------
// Text helpers
// ----------------------------------------------------------------------------

function stamp(t: number): string {
  return `[${formatClock(t)}]`;
}

/** A single-quoted TypeScript string literal. */
function lit(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${escaped}'`;
}

/** Text that is safe inside a `//` comment: one line, capped. */
function oneLine(text: string, cap = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function clean(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim();
  return flat ? flat : undefined;
}

/** A paragraph as `//` comment lines no wider than `width`. */
function commentBlock(text: string, width = 88): string[] {
  const lines: string[] = [];
  let line = '//';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== '//' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = '//';
    }
    line += ` ${word}`;
  }
  if (line !== '//') lines.push(line);
  return lines;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isWebUrl(url: string): boolean {
  const u = parseUrl(url);
  return u?.protocol === 'http:' || u?.protocol === 'https:';
}

// ----------------------------------------------------------------------------
// Locators
// ----------------------------------------------------------------------------

interface Located {
  expr: string;
  /** True when nothing better than the tag name was recorded. */
  weak: boolean;
}

/**
 * Ids generated per render (React useId, Radix, Headless UI, Ember, MUI) change
 * between page loads, so a replay cannot rely on them.
 */
function isStableId(id: string): boolean {
  return !/[:«»]|^_r_|^(?:ember\d|radix-|headlessui-|mui-\d|react-aria)|\d{5,}/i.test(
    id,
  );
}

function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function idSelector(id: string): string {
  return /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${cssString(id)}"]`;
}

function cssUnescape(value: string): string {
  return value.replace(
    /\\(?:([0-9a-fA-F]{1,6}) ?|(.))/g,
    (_, hex?: string, ch?: string) => {
      if (hex === undefined) return ch ?? '';
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    },
  );
}

/** The raw test id from a recorded `[data-testid="…"]` selector. */
function testIdFrom(selector: string | undefined): string | undefined {
  const m = selector ? /^\[data-testid="((?:[^"\\]|\\.)*)"\]$/.exec(selector) : null;
  return m?.[1] !== undefined ? cssUnescape(m[1]) : undefined;
}

function implicitRole(tag: string, inputType?: string): string | undefined {
  switch (tag) {
    case 'button':
      return 'button';
    case 'a':
      return 'link';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'input':
      return inputType === 'button' || inputType === 'submit' || inputType === 'reset'
        ? 'button'
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The sturdiest locator the descriptor supports, in the order Playwright
 * recommends: test id, a stable id, role and accessible name, label, visible
 * text, then the recorded CSS path.
 */
function locate(d: ElementDescriptor, inputType?: string): Located {
  const testId = testIdFrom(d.selector);
  if (testId) return { expr: `page.getByTestId(${lit(testId)})`, weak: false };
  if (d.id && isStableId(d.id)) {
    return { expr: `page.locator(${lit(idSelector(d.id))})`, weak: false };
  }

  const label = clean(d.ariaLabel);
  const text = clean(d.text);
  const isField = FIELD_TAGS.has(d.tag);
  const role = d.role ?? implicitRole(d.tag, inputType);
  if (role && CONTENT_NAMED_ROLES.has(role)) {
    const name = label ?? text;
    if (name) {
      const exact = name === label || name.length < TEXT_CAP ? ', exact: true' : '';
      return {
        expr: `page.getByRole(${lit(role)}, { name: ${lit(name)}${exact} })`,
        weak: false,
      };
    }
  }
  if (isField && label) {
    return { expr: `page.getByLabel(${lit(label)}, { exact: true })`, weak: false };
  }
  if (isField && d.name) {
    const selector = `${d.tag}[name="${cssString(d.name)}"]`;
    return { expr: `page.locator(${lit(selector)})`, weak: false };
  }
  if (text && !isField && text.length < TEXT_CAP) {
    return { expr: `page.getByText(${lit(text)}, { exact: true })`, weak: false };
  }
  if (d.selector && d.selector !== d.tag) {
    return { expr: `page.locator(${lit(d.selector)})`, weak: false };
  }
  if (text && !isField) return { expr: `page.getByText(${lit(text)})`, weak: false };
  return { expr: `page.locator(${lit(d.tag || 'body')})`, weak: true };
}

/** Identity of a recorded element, for matching a click with the change it caused. */
function elementKey(d: ElementDescriptor): string {
  if (d.selector) return d.selector;
  if (d.id) return `#${d.id}`;
  return d.name ? `${d.tag}[name="${d.name}"]` : `${d.tag}:${d.text ?? ''}`;
}

function describeElement(d: ElementDescriptor): string {
  const kind = d.role ?? d.tag;
  const byId = d.id ? `${kind} #${d.id}` : undefined;
  const byName = d.name ? `${kind} named "${d.name}"` : undefined;
  // A field's recorded text is usually its placeholder, which says little about it.
  const field = FIELD_TAGS.has(d.tag) ? (byId ?? byName) : undefined;
  if (field !== undefined) return field;
  const name = clean(d.ariaLabel) ?? clean(d.text);
  if (name) return `${kind} "${oneLine(name, 60)}"`;
  return byId ?? byName ?? (d.selector ? `${kind} ${d.selector}` : kind);
}

// ----------------------------------------------------------------------------
// Steps and checks
// ----------------------------------------------------------------------------

/** `Ctrl+Shift+K` as Playwright spells it: `Control+Shift+K`. */
function playwrightKey(key: string): string | undefined {
  const m = /^((?:(?:Ctrl|Alt|Shift|Meta)\+)*)(.+)$/.exec(key);
  if (!m) return undefined;
  const mods = (m[1] ?? '')
    .split('+')
    .filter(Boolean)
    .map((k) => (k === 'Ctrl' ? 'Control' : k));
  let main = m[2] ?? '';
  // The recorder upper-cases chord letters; without Shift the page saw them lower-case.
  if (main.length === 1 && !mods.includes('Shift')) main = main.toLowerCase();
  return [...mods, main].join('+');
}

function clickOptions(modifiers: string[], button: number | undefined): string {
  const parts: string[] = [];
  const mods = modifiers
    .map((m) => MODIFIER_KEYS[m.toLowerCase()])
    .filter((m): m is string => m !== undefined);
  if (mods.length > 0) parts.push(`modifiers: [${mods.map((m) => lit(m)).join(', ')}]`);
  if (button === 1) parts.push("button: 'middle'");
  if (button === 2) parts.push("button: 'right'");
  return parts.length > 0 ? `{ ${parts.join(', ')} }` : '';
}

/** The part of an exception message that both CDP and Playwright's `pageerror` report. */
function errorCore(message: string): string {
  const first = (message.split('\n')[0] ?? '').trim();
  const core = first
    .replace(/^Uncaught (?:\(in promise\) )?/, '')
    .replace(/^[A-Za-z]*(?:Error|Exception): /, '')
    .trim();
  // The page never says «redacted», so match the longest part redaction left alone.
  const kept = core
    .split(REDACTION_MARKER)
    .map((part) => part.trim())
    .sort((a, b) => b.length - a.length)[0];
  return (kept || core || first).slice(0, 150);
}

/** Requests whose failure can be the bug, as opposed to a missing favicon or font. */
function isApiCall(p: NetRequestPayload): boolean {
  const type = (p.resourceType ?? '').toLowerCase();
  return (
    type === 'xhr' ||
    type === 'fetch' ||
    type === 'document' ||
    p.method.toUpperCase() !== 'GET'
  );
}

/** Step-like events from other tabs, described for a "not replayed" comment. */
function describeStep(e: SessionEvent): string | undefined {
  switch (e.type) {
    case 'click':
      return `clicked ${describeElement(e.payload.descriptor)}`;
    case 'input':
      return `typed into ${describeElement(e.payload.descriptor)}`;
    case 'key':
      return `pressed ${e.payload.key}`;
    case 'nav':
      return `opened ${e.payload.url}`;
    case 'spa-route':
      return `moved to ${e.payload.url}`;
    case 'error':
      return `error "${e.payload.message}"`;
    default:
      return undefined;
  }
}

/** The step types that carry the element they acted on. */
function isInteraction(
  e: SessionEvent,
): e is EventOf<'click' | 'input' | 'hover' | 'key'> {
  return (
    e.type === 'click' || e.type === 'input' || e.type === 'hover' || e.type === 'key'
  );
}

type Collector = 'pageErrors' | 'failedRequests' | 'consoleErrors';

const COLLECTORS: Record<Collector, string[]> = {
  pageErrors: [
    'const pageErrors: string[] = [];',
    "page.on('pageerror', (error) => pageErrors.push(String(error)));",
  ],
  failedRequests: [
    'const failedRequests: string[] = [];',
    '// App requests go by path so REPRO_BASE_URL still matches; other sites keep their origin.',
    'const where = (url: string) => {',
    '  const { origin, pathname } = new URL(url);',
    '  return origin === appOrigin ? pathname : origin + pathname;',
    '};',
    "page.on('response', (response) => {",
    '  if (response.status() >= 400) {',
    '    failedRequests.push(`${response.request().method()} ${where(response.url())} ${response.status()}`);',
    '  }',
    '});',
    "page.on('requestfailed', (request) => {",
    '  // A canceled request (a navigation or an abort) is not a failure.',
    "  if (/ABORTED|cancel/i.test(request.failure()?.errorText ?? '')) return;",
    '  failedRequests.push(`${request.method()} ${where(request.url())} failed`);',
    '});',
  ],
  consoleErrors: [
    'const consoleErrors: string[] = [];',
    "page.on('console', (message) => {",
    "  if (message.type() === 'error') consoleErrors.push(message.text());",
    '});',
  ],
};

// ----------------------------------------------------------------------------
// Writer
// ----------------------------------------------------------------------------

class ReproWriter {
  private readonly session: Session;
  private readonly opts: PlaywrightReproOptions;
  private readonly primary: number | undefined;
  private readonly origin: string | undefined;
  private readonly linkedRequestIds = new Set<string>();
  private readonly harReplayable: boolean;
  private readonly fullDescriptors = new Map<string, ElementDescriptor>();

  private readonly steps: string[] = [];
  private readonly collectors = new Set<Collector>();
  private readonly activeChecks = new Set<string>();
  private readonly optionalChecks = new Set<string>();
  private readonly checkedSinceStep = new Set<string>();
  private readonly envByTarget = new Map<string, string>();
  private readonly envFields: { name: string; field: string }[] = [];
  /**
   * The value last filled into each field, with how many clicks, keys and
   * navigations had happened by then.
   */
  private readonly filled = new Map<string, { value: string; causes: number }>();
  private causes = 0;

  private usesAppUrl = false;
  private opened = false;
  private actions = 0;
  private checks = 0;
  private otherTabSteps = 0;
  private fileUploads = 0;
  private weakSteps = 0;
  private waitTotal = 0;

  private lastStepT = 0;
  private waited = 0;
  private lastClick: { tag: string; t: number } | undefined;
  private lastLinkClickT: number | undefined;
  /** The element the last recorded click landed on, replayed or not. */
  private lastActivated: { key: string; t: number } | undefined;
  private actedSinceNav = false;
  private currentUrl: string | undefined;
  private history: string[] = [];
  private historyIndex = -1;
  /** The last step, when the next one may replace it (repeated fills, scrolls). */
  private mergeable: { key: string; index: number } | undefined;

  constructor(session: Session, events: SessionEvent[], opts: PlaywrightReproOptions) {
    this.session = session;
    this.opts = opts;
    this.primary = session.tabs.find((t) => t.role === 'primary')?.tabId;
    for (const e of events) {
      if (e.type === 'error' && e.payload.linkedRequestId) {
        this.linkedRequestIds.add(e.payload.linkedRequestId);
      }
    }
    // Only the steps this export kept need their full element details.
    const kept = new Set(events.filter(isInteraction).map((e) => e.id));
    for (const e of kept.size > 0 ? (opts.fullEvents ?? []) : []) {
      if (kept.has(e.id) && isInteraction(e) && e.payload.descriptor) {
        this.fullDescriptors.set(e.id, e.payload.descriptor);
      }
    }
    // Below L0 the level trims bodies, so most responses could not be replayed.
    this.harReplayable = opts.harPath !== undefined && opts.level === 'L0';

    const firstNav = events.find(
      (e): e is EventOf<'nav'> =>
        e.type === 'nav' && this.inPrimary(e) && isWebUrl(e.payload.url),
    );
    const startUrl = isWebUrl(session.initialUrl)
      ? session.initialUrl
      : firstNav?.payload.url;
    this.origin = startUrl !== undefined ? parseUrl(startUrl)?.origin : undefined;
    if (isWebUrl(session.initialUrl)) this.goto(session.initialUrl, 0, false);
  }

  add(e: SessionEvent): void {
    if (e.type === 'tab-opened' && e.tabId !== undefined && e.tabId !== this.primary) {
      const where = e.payload.url ? ` (${e.payload.url})` : '';
      this.comment(
        e.t,
        `Opened tab ${e.tabId}${where}. Steps in other tabs are not replayed.`,
      );
      return;
    }
    if (e.type === 'tab-switch') {
      this.comment(
        e.t,
        e.payload.toTabId === this.primary
          ? 'Switched back to the recorded tab.'
          : `Switched to tab ${e.payload.toTabId}.`,
      );
      return;
    }
    if (!this.inPrimary(e)) {
      this.otherTab(e);
      return;
    }

    switch (e.type) {
      case 'nav':
        this.nav(e);
        break;
      case 'spa-route':
        this.spaRoute(e);
        break;
      case 'click':
        this.click(e);
        break;
      case 'input':
        this.input(e);
        break;
      case 'key':
        this.key(e);
        break;
      case 'hover': {
        const loc = locate(this.element(e) ?? e.payload.descriptor);
        this.action(`await ${loc.expr}.hover();`, e.t, loc.weak);
        break;
      }
      case 'scroll':
        this.scroll(e);
        break;
      case 'error':
        this.error(e);
        break;
      case 'net-request':
        this.request(e);
        break;
      case 'marker':
        this.comment(e.t, `Marker: ${e.payload.name}`);
        break;
      case 'note':
        this.comment(e.t, `Note: ${e.payload.text}`);
        break;
      case 'annotation': {
        const labels = e.payload.shapes
          .map((s) => clean(s.text))
          .filter((s): s is string => s !== undefined);
        this.comment(
          e.t,
          labels.length > 0
            ? `Annotation: ${labels.map((l) => `"${l}"`).join(', ')}`
            : 'Annotated the page (see the screenshots in this export).',
        );
        break;
      }
      case 'voice-segment': {
        const said = clean(e.payload.transcript ?? undefined);
        if (said && !isDictatedSpeech(e)) this.comment(e.t, `Said: "${said}"`);
        break;
      }
      case 'file-captured':
        this.comment(e.t, `The page received the file "${e.payload.fileName}".`);
        break;
      default:
        break;
    }
  }

  finish(): string | null {
    if (!this.opened || (this.actions === 0 && this.checks === 0)) return null;
    const replayHar = this.harReplayable && this.opts.harPath !== undefined;

    const out: string[] = [...this.header(), ''];
    out.push("import { test, expect } from '@playwright/test';");
    if (replayHar) {
      out.push("import { readFileSync, writeFileSync } from 'node:fs';");
      out.push("import path from 'node:path';");
    }
    out.push('');
    if (this.usesAppUrl && this.origin !== undefined) {
      out.push(`const baseURL = process.env.REPRO_BASE_URL ?? ${lit(this.origin)};`);
      out.push('const appOrigin = new URL(baseURL).origin;');
      out.push(
        "const appUrl = (route: string) => baseURL.replace(/\\/+$/, '') + route;",
      );
      out.push('');
    }

    const body: string[] = [];
    const budget = DEFAULT_TEST_TIMEOUT_MS + this.waitTotal + this.actions * 1000;
    if (this.waitTotal + this.actions * 1000 > DEFAULT_TEST_TIMEOUT_MS * 0.6) {
      body.push(`test.setTimeout(${Math.ceil(budget / 10_000) * 10_000});`);
    }
    for (const collector of [
      'pageErrors',
      'failedRequests',
      'consoleErrors',
    ] as const) {
      if (this.collectors.has(collector)) body.push(...COLLECTORS[collector]);
    }
    if (replayHar && this.opts.harPath !== undefined) {
      body.push(
        `// ${oneLine(this.opts.harPath)} holds the responses from the recording. REPRO_REPLAY_NETWORK=1`,
        '// answers requests with the ones recorded whole, for bugs that need the same data.',
        '// A request still goes to the server when its response body was cut or never captured',
        '// (only a 204 or a redirect with a target has none), when it sent a body that was not',
        '// recorded (only GET, HEAD and OPTIONS replay without one), or when the file lacks it.',
        '// Leave it unset when checking a backend fix: replayed responses keep the old failures.',
        "if (process.env.REPRO_REPLAY_NETWORK === '1') {",
        '  type HarEntry = {',
        '    request: { method: string; postData?: { comment?: string } };',
        '    response: {',
        '      status: number;',
        '      redirectURL: string;',
        '      content: { text?: string; comment?: string };',
        '    };',
        '  };',
        '  // A body cut at capture carries a comment; one never captured has no text.',
        '  const whole = (entry: HarEntry) =>',
        '    (entry.request.postData',
        '      ? !entry.request.postData.comment',
        "      : ['GET', 'HEAD', 'OPTIONS'].includes(entry.request.method)) &&",
        '    !entry.response.content.comment &&',
        '    (entry.response.content.text !== undefined ||',
        '      entry.response.status === 204 ||',
        "      (entry.response.status >= 300 && entry.response.status < 400 && entry.response.redirectURL !== ''));",
        `  const file = path.join(path.dirname(test.info().file), ${lit(this.opts.harPath)});`,
        "  const recorded = JSON.parse(readFileSync(file, 'utf8'));",
        '  recorded.log.entries = recorded.log.entries.filter(whole);',
        "  const har = test.info().outputPath('replay.har');",
        '  writeFileSync(har, JSON.stringify(recorded));',
        "  await page.routeFromHAR(har, { notFound: 'fallback' });",
        '}',
      );
    }
    if (body.length > 0) body.push('');
    body.push(...this.steps);
    if (this.activeChecks.size > 0) {
      body.push(
        '',
        '// Run every check again at the end, in case an error now comes a little later.',
        `await page.waitForTimeout(${FINAL_CHECK_WAIT_MS});`,
        ...this.activeChecks,
      );
    }
    if (this.checks === 0) {
      body.push(
        '',
        '// No uncaught error or failing API call was recorded, so nothing is checked yet.',
        '// Add an assertion for what should have happened, for example:',
        "// await expect(page.getByText('Saved')).toBeVisible();",
      );
    }

    out.push(
      `test(${lit(`repro: ${oneLine(this.session.name, 100)}`)}, async ({ page }) => {`,
    );
    out.push(...body.map((line) => (line ? `  ${line}` : '')));
    out.push('});');
    return `${out.join('\n')}\n`;
  }

  // --------------------------------------------------------------------------
  // Header
  // --------------------------------------------------------------------------

  private header(): string[] {
    const recorded = new Date(this.session.startedAt).toISOString();
    const h: string[] = [
      ...commentBlock(
        `Playwright test generated by Session Recorder from "${oneLine(this.session.name, 80)}", recorded ${recorded}.`,
      ),
      '//',
      ...commentBlock(
        this.checks > 0
          ? `It replays the recording in one tab and fails if an uncaught error or a failing API call from the recording happens again while it runs. Each check waits about as long as the recording took to hit it (at most ${MAX_CHECK_WAIT_MS / 1000} seconds), and all of them run again at the end, so an error that now comes a little later still fails the test, but one after the test ends does not. A pass means those failures did not come back in that time, not that the bug is fixed, so add an assertion for the outcome you expect.`
          : 'It replays the recording in one tab. No uncaught error or failing API call was recorded, so add an assertion for what you expected at the end of the test.',
      ),
      '//',
      '// Run it from a project that has @playwright/test installed:',
      '//   npx playwright test repro.spec.ts',
    ];
    if (this.usesAppUrl) {
      h.push('// REPRO_BASE_URL=http://localhost:3000 runs it against another server.');
    }
    if (this.envFields.length > 0) {
      h.push(
        '//',
        '// These fields were redacted while recording. Set the variables before running:',
      );
      for (const f of this.envFields)
        h.push(`//   ${f.name}: ${oneLine(f.field, 120)}`);
      h.push('// The test stops before typing them into a page on any other site.');
    }

    const notes: string[] = [];
    if (this.opts.level === 'L3' && this.opts.fullEvents === undefined) {
      notes.push(
        'Exported at L3 (minimal), which keeps only element tag and text, so steps find elements by role and text. Export at L0 or L1 for sturdier locators.',
      );
    }
    if (this.weakSteps > 0) {
      notes.push(
        `${plural(this.weakSteps, 'step')} marked "weak locator" had only the tag name to go on.`,
      );
    }
    const skipped: string[] = [];
    if (this.otherTabSteps > 0)
      skipped.push(`${plural(this.otherTabSteps, 'step')} in other tabs`);
    if (this.fileUploads > 0) skipped.push(plural(this.fileUploads, 'file upload'));
    if (skipped.length > 0) {
      notes.push(
        `Not replayed: ${skipped.join(', ')}. Comments mark where they happened.`,
      );
    }
    if (this.opts.harPath !== undefined && !this.harReplayable) {
      notes.push(
        `${oneLine(this.opts.harPath)} is not replayed: ${this.opts.level} (${LEVEL_NAMES[this.opts.level]}) trims response bodies. Export at L0 (full) to replay the recorded responses.`,
      );
    }
    for (const note of notes) h.push('//', ...commentBlock(note));
    return h;
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  /** The event's element, with any details its export level stripped. */
  private element(e: SessionEvent): ElementDescriptor | undefined {
    return (
      this.fullDescriptors.get(e.id) ??
      (isInteraction(e) ? e.payload.descriptor : undefined)
    );
  }

  private inPrimary(e: SessionEvent): boolean {
    return (
      this.primary === undefined || e.tabId === undefined || e.tabId === this.primary
    );
  }

  private otherTab(e: SessionEvent): void {
    const what = describeStep(e);
    if (what === undefined) return;
    this.comment(
      e.t,
      `In tab ${e.tabId}: ${what}. Not replayed, the test drives one tab.`,
    );
    this.otherTabSteps += 1;
  }

  private nav(e: EventOf<'nav'>): void {
    const { url, transitionQualifiers } = e.payload;
    if (!isWebUrl(url)) return;
    const type = e.payload.transitionType ?? 'link';
    // Chrome marks Back and Forward; older recordings lack the marks and are inferred.
    const traversal = transitionQualifiers?.includes('forward_back') === true;
    if (this.opened && traversal) {
      if (url === this.currentUrl || this.historyMove(url, e.t, true)) return;
      this.unplacedMove(url, e.t);
      return;
    }
    if (!this.opened || BROWSER_NAVIGATIONS.has(type)) {
      if (url !== this.currentUrl) this.goto(url, e.t, true);
      return;
    }
    if (type === 'reload') {
      // A reload before anything happened on the page adds nothing to a replay.
      if (this.actedSinceNav) this.navigation('await page.reload();', e.t);
      return;
    }
    if (url === this.currentUrl) return;
    if (transitionQualifiers === undefined && this.historyMove(url, e.t)) return;
    this.waitForUrl(url, e.t);
    this.pushHistory(url);
  }

  private spaRoute(e: EventOf<'spa-route'>): void {
    const { url, method } = e.payload;
    if (!this.opened || !isWebUrl(url) || url === this.currentUrl) return;
    if (method === 'popstate') {
      if (!this.historyMove(url, e.t, true)) this.unplacedMove(url, e.t);
      return;
    }
    if (e.payload.transitionQualifiers === undefined) {
      // Older recordings label Back and Forward as pushState, or replaceState on a
      // hash change, so infer them.
      if (this.historyMove(url, e.t)) return;
    }
    this.waitForUrl(url, e.t);
    // replaceState marks a fragment change, which adds an entry like a link does.
    this.pushHistory(url);
  }

  /**
   * A move to the neighbouring history entry. With no page interaction since the
   * last navigation it came from the browser buttons. After one, the page may have
   * done it itself (a Back link, `history.back()`), so the test waits as long as
   * the recording took and only then presses the browser button. `marked` is true
   * when Chrome flagged the navigation as Back or Forward.
   */
  private historyMove(url: string, t: number, marked = false): boolean {
    const back = this.history[this.historyIndex - 1] === url;
    const forward = !back && this.history[this.historyIndex + 1] === url;
    const u = parseUrl(url);
    // Right after a link click, the link is what navigated, unless Chrome says otherwise.
    const viaLink =
      !marked &&
      this.lastLinkClickT !== undefined &&
      this.lastLinkClickT === this.lastStepT;
    if ((!back && !forward) || !u || viaLink) return false;
    const button = back ? 'goBack' : 'goForward';
    if (!this.actedSinceNav) {
      this.navigation(`await page.${button}();`, t);
    } else {
      const elapsed = Math.ceil(Math.max(0, t - this.lastStepT) / 100) * 100;
      const timeout = Math.min(MAX_HISTORY_WAIT_MS, elapsed + WAIT_SLACK_MS);
      this.comment(
        t,
        `${back ? 'Back' : 'Forward'} to ${u.pathname}, by the page itself or the browser button.`,
      );
      this.navigation(
        `await page.waitForURL(${this.urlMatcher(u)}, { timeout: ${timeout} }).catch(() => page.${button}());`,
        t,
      );
    }
    this.historyIndex += back ? -1 : 1;
    this.currentUrl = url;
    return true;
  }

  /**
   * A Back or Forward to an entry that is not next to the current one in the test's
   * history: picked several entries away from the Back menu, or past a
   * `history.replaceState()`, which Chrome reports like a new entry. Opening the
   * page reaches the same URL instead of waiting for a move nothing makes.
   */
  private unplacedMove(url: string, t: number): void {
    const u = parseUrl(url);
    const where = u ? u.pathname + u.search + u.hash : url;
    this.comment(
      t,
      `Back or Forward to ${where}, an entry the test cannot place in its history, so it opens the page.`,
    );
    this.goto(url, t, true);
  }

  private click(e: EventOf<'click'>): void {
    const d = this.element(e) ?? e.payload.descriptor;
    this.causes += 1;
    this.lastActivated = { key: elementKey(d), t: e.t };
    // The browser's own click on a label's control; replaying it would undo the change.
    const forwarded =
      this.lastClick?.tag === 'label' &&
      LABELABLE_TAGS.has(d.tag) &&
      e.t - this.lastClick.t <= LABEL_FORWARD_MS;
    if (forwarded) {
      this.lastClick = undefined;
      return;
    }
    const loc = locate(d);
    const options = clickOptions(e.payload.modifiers, e.payload.button);
    this.action(`await ${loc.expr}.click(${options});`, e.t, loc.weak);
    this.lastClick = { tag: d.tag, t: e.t };
    this.lastLinkClickT = d.tag === 'a' || d.role === 'link' ? e.t : undefined;
  }

  private input(e: EventOf<'input'>): void {
    const p = e.payload;
    const d = this.element(e) ?? p.descriptor;
    const type = (p.inputType ?? '').toLowerCase();
    const loc = locate(d, type);
    if (type === 'checkbox' || type === 'radio') {
      // A replayed click on this control, or on its label, already changed it.
      const clicked =
        this.lastActivated?.key === elementKey(d) &&
        e.t - this.lastActivated.t <= CLICK_CHANGE_WINDOW_MS;
      if (clicked) return;
      this.action(
        `await ${loc.expr}.${type === 'radio' ? 'check' : 'click'}();`,
        e.t,
        loc.weak,
      );
      return;
    }
    if (type === 'file') {
      this.comment(
        e.t,
        `Chose a file for ${loc.expr}. Not replayed: call setInputFiles on it with your own file.`,
      );
      this.fileUploads += 1;
      return;
    }
    // The recorder can log one edit twice: as typed, and again on change when the field
    // loses focus. A repeat with no click, key or navigation since cannot be needed.
    const previous = this.filled.get(loc.expr);
    if (previous?.value === p.value && previous.causes === this.causes) return;
    this.filled.set(loc.expr, { value: p.value, causes: this.causes });
    const method = type.startsWith('select') ? 'selectOption' : 'fill';
    if (p.redacted || p.value === REDACTION_MARKER) {
      this.secretFill(loc, this.envFor(d, loc.expr), method, e.t);
      return;
    }
    // Pauses while typing split one edit into several input events; keep the last value.
    this.action(
      `await ${loc.expr}.${method}(${lit(p.value)});`,
      e.t,
      loc.weak,
      `${method}:${loc.expr}`,
    );
  }

  private key(e: EventOf<'key'>): void {
    const key = playwrightKey(e.payload.key);
    if (key === undefined) return;
    this.causes += 1;
    const d = this.element(e);
    const target = d && d.tag !== 'body' && d.tag !== 'html' ? locate(d) : undefined;
    const line = target
      ? `await ${target.expr}.press(${lit(key)});`
      : `await page.keyboard.press(${lit(key)});`;
    this.action(line, e.t, target?.weak ?? false);
  }

  private scroll(e: EventOf<'scroll'>): void {
    const { to, container } = e.payload;
    const x = Math.round(to.x);
    const y = Math.round(to.y);
    const line =
      !container || container === 'window'
        ? `await page.evaluate(() => window.scrollTo(${x}, ${y}));`
        : `await page.locator(${lit(container)}).evaluate((el) => el.scrollTo(${x}, ${y}));`;
    this.action(line, e.t, false, `scroll:${container ?? 'window'}`);
  }

  private error(e: EventOf<'error'>): void {
    const { message, origin } = e.payload;
    const expected = lit(errorCore(message));
    const firstLine = message.split('\n')[0] ?? message;
    if (origin === 'exception') {
      this.check(
        e.t,
        `The recording hit an uncaught error here: ${firstLine}`,
        'pageErrors',
        `expect(pageErrors).not.toContainEqual(expect.stringContaining(${expected}));`,
      );
      return;
    }
    // Failing requests are checked where they happened, from their net-request event.
    if (origin === 'network' || /^Failed to load resource\b/.test(message)) return;
    this.optionalCheck(
      e.t,
      `Console error in the recording, often noise, so not checked: ${firstLine}`,
      'consoleErrors',
      `expect(consoleErrors).not.toContainEqual(expect.stringContaining(${expected}));`,
    );
  }

  private request(e: EventOf<'net-request'>): void {
    const p = e.payload;
    const linked = this.linkedRequestIds.has(p.requestId);
    const failed = p.failed === true && !/ERR_ABORTED/.test(p.failureReason ?? '');
    const status = p.status ?? 0;
    if (!failed && status < 400) return;
    if (!linked && !isApiCall(p)) return;
    const u = parseUrl(p.url);
    if (!u) return;
    // Same key as the collector builds: path for the app, origin and path elsewhere.
    const where = u.origin === this.origin ? u.pathname : u.origin + u.pathname;
    const label = `${p.method.toUpperCase()} ${where} ${failed ? 'failed' : status}`;
    const assertion = `expect(failedRequests).not.toContain(${lit(label)});`;
    this.usesAppUrl = true;
    if (linked || failed || status >= 500) {
      this.check(e.t, `${label} in the recording.`, 'failedRequests', assertion);
    } else {
      this.optionalCheck(
        e.t,
        `${label} in the recording. Client errors are often expected; uncomment if this one is the bug.`,
        'failedRequests',
        assertion,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Output
  // --------------------------------------------------------------------------

  private goto(url: string, t: number, counts: boolean): void {
    this.navigation(`await page.goto(${this.urlExpr(url)});`, t, counts);
    this.opened = true;
    this.pushHistory(url);
  }

  private waitForUrl(url: string, t: number): void {
    const u = parseUrl(url);
    if (!u) return;
    this.navigation(`await page.waitForURL(${this.urlMatcher(u)});`, t);
  }

  /** A `waitForURL` predicate for a recorded URL, relative to where the replay is now. */
  private urlMatcher(u: URL): string {
    const from = this.currentUrl !== undefined ? parseUrl(this.currentUrl) : undefined;
    const conditions: string[] = [];
    // App pages follow REPRO_BASE_URL; other sites must match their recorded origin.
    if (u.origin === this.origin) {
      this.usesAppUrl = true;
      conditions.push('url.origin === appOrigin');
    } else {
      conditions.push(`url.origin === ${lit(u.origin)}`);
    }
    conditions.push(`url.pathname === ${lit(u.pathname)}`);
    if (u.hash || from?.hash) conditions.push(`url.hash === ${lit(u.hash)}`);
    const queryOnly =
      from !== undefined &&
      from.origin === u.origin &&
      from.pathname === u.pathname &&
      from.hash === u.hash &&
      from.search !== u.search;
    // The old URL would match too, so wait for the query to move on. Its new value is
    // not compared because recorded queries can hold redacted or per-run values.
    if (queryOnly) conditions.push(`url.search !== ${lit(from.search)}`);
    return `(url) => ${conditions.join(' && ')}`;
  }

  private pushHistory(url: string): void {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    this.currentUrl = url;
  }

  private urlExpr(url: string): string {
    const u = parseUrl(url);
    if (u && this.origin !== undefined && u.origin === this.origin) {
      this.usesAppUrl = true;
      return `appUrl(${lit(u.pathname + u.search + u.hash)})`;
    }
    return lit(url);
  }

  /**
   * Type a secret only into a field on the site the recording typed it into:
   * the app (or REPRO_BASE_URL), or that exact origin. The check reads the
   * origin of the field's own page and types into that same field, so a
   * navigation in between detaches it instead of sending the secret elsewhere.
   */
  private secretFill(loc: Located, env: string, method: string, t: number): void {
    const page = this.currentUrl !== undefined ? parseUrl(this.currentUrl) : undefined;
    let expected = page ? lit(page.origin) : undefined;
    if (page && page.origin === this.origin) {
      this.usesAppUrl = true;
      expected = 'appOrigin';
    }
    const message = lit(`${env} is only typed into the recorded site`);
    this.steps.push(
      '{',
      `  const field = (await ${loc.expr}.elementHandle())!; // ${stamp(t)}${loc.weak ? ' weak locator, check it' : ''}`,
      ...(expected
        ? [
            `  expect(await field.evaluate(() => location.origin), ${message}).toBe(${expected});`,
          ]
        : []),
      `  await field.${method}(process.env.${env} ?? '');`,
      '}',
    );
    this.actions += 1;
    if (loc.weak) this.weakSteps += 1;
    this.mergeable = undefined;
    this.stepped(t);
    this.actedSinceNav = true;
  }

  /**
   * The variable holding a redacted field's value. Fields on different sites get
   * different variables even when their locators match, so one site's secret is
   * never typed into another.
   */
  private envFor(d: ElementDescriptor, target: string): string {
    const page = this.currentUrl !== undefined ? parseUrl(this.currentUrl) : undefined;
    const site = page?.origin;
    const key = `${site ?? ''} ${target}`;
    const known = this.envByTarget.get(key);
    if (known !== undefined) return known;
    const slug = (d.name ?? d.id ?? d.ariaLabel ?? '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
      .slice(0, 40);
    const base = `REPRO_${slug || 'INPUT'}`;
    let name = base;
    for (let n = 2; this.envFields.some((f) => f.name === name); n += 1)
      name = `${base}_${n}`;
    this.envByTarget.set(key, name);
    const where =
      site === undefined || site === this.origin ? 'on the app' : `on ${site}`;
    this.envFields.push({ name, field: `${describeElement(d)} ${where}` });
    return name;
  }

  private action(line: string, t: number, weak: boolean, mergeKey?: string): void {
    const text = `${line} // ${stamp(t)}${weak ? ' weak locator, check it' : ''}`;
    const last = this.steps.length - 1;
    if (
      mergeKey !== undefined &&
      this.mergeable?.key === mergeKey &&
      this.mergeable.index === last
    ) {
      this.steps[last] = text;
    } else {
      this.steps.push(text);
      this.actions += 1;
      if (weak) this.weakSteps += 1;
    }
    this.mergeable =
      mergeKey !== undefined
        ? { key: mergeKey, index: this.steps.length - 1 }
        : undefined;
    this.stepped(t);
    this.actedSinceNav = true;
  }

  private navigation(line: string, t: number, counts = true): void {
    this.steps.push(`${line} // ${stamp(t)}`);
    this.causes += 1;
    if (counts) this.actions += 1;
    this.stepped(t);
    this.actedSinceNav = false;
  }

  private stepped(t: number): void {
    this.lastStepT = t;
    this.waited = 0;
    this.checkedSinceStep.clear();
  }

  private comment(t: number, text: string): void {
    this.steps.push(`// ${stamp(t)} ${oneLine(text)}`);
  }

  /**
   * Assert that an error from the recording does not happen again, after waiting
   * as long as the recording took to hit it since the step before.
   */
  private check(
    t: number,
    note: string,
    collector: Collector,
    assertion: string,
  ): void {
    // The same error after another step gets its own check, so fixing one trigger
    // cannot let the test pass while a later one still throws.
    if (this.checkedSinceStep.has(assertion)) return;
    this.checkedSinceStep.add(assertion);
    this.activeChecks.add(assertion);
    this.collectors.add(collector);
    this.comment(t, note);
    const elapsed = Math.ceil(Math.max(0, t - this.lastStepT) / 100) * 100;
    const wait = Math.min(MAX_CHECK_WAIT_MS, elapsed + WAIT_SLACK_MS);
    if (wait > this.waited) {
      this.steps.push(`await page.waitForTimeout(${wait - this.waited});`);
      this.waitTotal += wait - this.waited;
      this.waited = wait;
    }
    this.steps.push(assertion);
    this.checks += 1;
  }

  /** A check left commented out, for signals that are often unrelated noise. */
  private optionalCheck(
    t: number,
    note: string,
    collector: Collector,
    assertion: string,
  ): void {
    // A commented check never stands in for an active one, only the reverse.
    if (this.activeChecks.has(assertion) || this.optionalChecks.has(assertion)) return;
    this.optionalChecks.add(assertion);
    this.collectors.add(collector);
    this.comment(t, note);
    this.steps.push(`// ${assertion}`);
  }
}
