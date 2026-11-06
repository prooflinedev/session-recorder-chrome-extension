/**
 * Best-effort DOM element description, produced inside ISOLATED-world content
 * scripts. Turns a live `Element` into a serializable `ElementDescriptor` plus
 * the small helpers (selector synthesis, visible-text extraction, sensitive
 * input detection, nearest-heading lookup) the interaction/annotation capture
 * scripts rely on. Pure DOM: no `chrome`, no network, no global mutable state.
 */

import type { ElementDescriptor, Rect } from '@/lib/session/types';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/** Matches names/ids/autocomplete tokens/placeholders of secret-bearing fields. */
const SENSITIVE_RE = /pass|secret|token|cc-|card|cvv|ssn/i;

/**
 * Secret-bearing hints that must be whole words of the normalized hint (see
 * `hintWords`), so "keyword", "monkey", "spinner" and "author" stay unredacted.
 */
const SENSITIVE_WORD_RE =
  /\b(?:(?:api|secret|private|access)\s?)?key\b|\bone\s?time\s?(?:code|pin)\b|\botp\b|\bpin(?:\s?code)?\b|\bcvc\b|\bmnemonic|\bseed\s?phrase\b|\bauth(?:orization)?\b|\bcredentials?\b/i;

/** Selector for heading-like elements used by `nearestHeading`. */
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"],legend';

/** Containers that commonly carry a labelling heading for their contents. */
const LABELLED_CONTAINER_SELECTOR =
  'dialog,form,fieldset,section,article,aside,[role="dialog"],[role="region"],[role="group"]';

/** Max ancestors to include in a synthesized selector path. */
const MAX_SELECTOR_DEPTH = 4;

/** Default cap for `visibleText`. */
const DEFAULT_TEXT_CAP = 80;

// ----------------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------------

/** Escape a string for safe use in a CSS selector, with a manual fallback. */
function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (css && typeof css.escape === 'function') return css.escape(value);
  // Conservative fallback: escape anything that is not an identifier char.
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/** Collapse all runs of whitespace to single spaces and trim. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function capText(text: string, cap: number): string {
  const collapsed = collapseWhitespace(text);
  return collapsed.length > cap ? collapsed.slice(0, cap) : collapsed;
}

function isElement(node: Node | null): node is Element {
  return node != null && node.nodeType === 1;
}

// ----------------------------------------------------------------------------
// visibleText
// ----------------------------------------------------------------------------

/**
 * Human-visible text for an element: its rendered text content with whitespace
 * collapsed and trimmed, capped at `cap` (default 80). Falls back to form-control
 * value/placeholder and image alt text when there is no text content.
 */
export function visibleText(el: Element, cap: number = DEFAULT_TEXT_CAP): string {
  const html = el as HTMLElement & {
    value?: string;
    placeholder?: string;
    alt?: string;
  };

  // Prefer rendered text; textContent is used as a jsdom-friendly fallback.
  const raw =
    (typeof html.innerText === 'string' && html.innerText) ||
    el.textContent ||
    '';
  const collapsed = collapseWhitespace(raw);
  if (collapsed) return capText(collapsed, cap);

  // Form controls / images carry no text content but still show something.
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    // Never surface the value of a sensitive field as "text" — that would leak
    // a password/token into the descriptor even though the captured value is
    // redacted elsewhere. Fall through to placeholder / aria-label / name.
    const val =
      !isSensitiveInput(el) && typeof html.value === 'string' ? html.value : '';
    if (val) return capText(val, cap);
    const ph = typeof html.placeholder === 'string' ? html.placeholder : '';
    if (ph) return capText(ph, cap);
  }
  if (tag === 'img') {
    const alt = typeof html.alt === 'string' ? html.alt : el.getAttribute('alt') ?? '';
    if (alt) return capText(alt, cap);
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return capText(ariaLabel, cap);

  return '';
}

// ----------------------------------------------------------------------------
// isSensitiveInput
// ----------------------------------------------------------------------------

/** Split camelCase, snake_case and kebab-case into space-separated words. */
function hintWords(hint: string): string {
  return hint
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z\d]+/g, ' ');
}

function isSensitiveHint(hint: string): boolean {
  return SENSITIVE_RE.test(hint) || SENSITIVE_WORD_RE.test(hintWords(hint));
}

/** Text of the labels associated with a field (wrapping label or label[for]). */
function labelTexts(el: Element): string[] {
  const labels = (el as Partial<HTMLInputElement>).labels;
  return labels ? Array.from(labels, (label) => label.textContent ?? '') : [];
}

/**
 * True when an element is likely to hold a secret: `type=password`, or any of
 * its name/id/autocomplete/placeholder/aria-label attributes or associated
 * label text matching the sensitive patterns.
 */
export function isSensitiveInput(el: Element): boolean {
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'password') return true;

  for (const attr of ['name', 'id', 'autocomplete', 'placeholder', 'aria-label'] as const) {
    const value = el.getAttribute(attr);
    if (value && isSensitiveHint(value)) return true;
  }
  return labelTexts(el).some(isSensitiveHint);
}

// ----------------------------------------------------------------------------
// bestSelector
// ----------------------------------------------------------------------------

/** Meaningful class tokens for a `tag.class` segment (skip empties). */
function classSegment(el: Element): string {
  const classes: string[] = [];
  for (const cls of Array.from(el.classList)) {
    if (cls) classes.push(`.${cssEscape(cls)}`);
    if (classes.length >= 3) break; // keep segments short
  }
  return classes.join('');
}

/** 1-based index of `el` among same-tag siblings, for `:nth-of-type`. */
function nthOfType(el: Element): number {
  const tag = el.tagName;
  let index = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === tag) index++;
    sib = sib.previousElementSibling;
  }
  return index;
}

/** Selector segment identifying `el` relative to its siblings. */
function segmentFor(el: Element, preferClasses: boolean): string {
  const tag = el.tagName.toLowerCase();
  if (preferClasses) {
    const classes = classSegment(el);
    if (classes) return `${tag}${classes}`;
  }
  // Disambiguate by position when there is more than one same-tag sibling.
  const parent = el.parentElement;
  if (parent) {
    let sameTag = 0;
    for (const child of Array.from(parent.children)) {
      if (child.tagName === el.tagName) sameTag++;
      if (sameTag > 1) break;
    }
    if (sameTag > 1) return `${tag}:nth-of-type(${nthOfType(el)})`;
  }
  return tag;
}

/**
 * A best-effort CSS selector for `el`, in priority order:
 *   1. `#id` (when the id is present)
 *   2. `[data-testid="…"]`
 *   3. a short `tag.class` / `:nth-of-type` ancestor path (max depth ~4),
 *      anchored on an ancestor id when one is found along the way.
 */
export function bestSelector(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;

  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;

  const segments: string[] = [segmentFor(el, true)];
  let cur = el.parentElement;
  let depth = 0;

  while (cur && depth < MAX_SELECTOR_DEPTH) {
    if (cur.id) {
      segments.unshift(`#${cssEscape(cur.id)}`);
      return segments.join(' > ');
    }
    if (cur === cur.ownerDocument?.documentElement || cur.tagName === 'BODY') {
      break;
    }
    segments.unshift(segmentFor(cur, false));
    cur = cur.parentElement;
    depth++;
  }

  return segments.join(' > ');
}

// ----------------------------------------------------------------------------
// nearestHeading
// ----------------------------------------------------------------------------

/** Resolve `aria-labelledby` id references to their combined visible text. */
function resolveLabelledBy(el: Element): string | undefined {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return undefined;
  const doc = el.ownerDocument;
  if (!doc) return undefined;
  const parts: string[] = [];
  for (const id of ids.split(/\s+/)) {
    if (!id) continue;
    const ref = doc.getElementById(id);
    if (ref) {
      const text = collapseWhitespace(ref.textContent ?? '');
      if (text) parts.push(text);
    }
  }
  const joined = parts.join(' ');
  return joined ? capText(joined, DEFAULT_TEXT_CAP) : undefined;
}

/** A labelling string derived from a container element, if any. */
function containerLabel(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && collapseWhitespace(ariaLabel)) {
    return capText(ariaLabel, DEFAULT_TEXT_CAP);
  }

  const labelledBy = resolveLabelledBy(el);
  if (labelledBy) return labelledBy;

  if (el.matches(LABELLED_CONTAINER_SELECTOR)) {
    const heading = el.querySelector(HEADING_SELECTOR);
    if (heading) {
      const text = visibleText(heading);
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Nearest contextual heading for `el`: walk ancestors, and at each level prefer
 * a heading among the preceding siblings, then a labelling container (aria-label,
 * aria-labelledby, or a heading/legend within a dialog/form/section). Returns
 * the first match found, or `undefined`.
 */
export function nearestHeading(el: Element): string | undefined {
  for (let cur: Element | null = el; isElement(cur); cur = cur.parentElement) {
    // Headings typically precede the content they label.
    for (
      let sib = cur.previousElementSibling;
      sib;
      sib = sib.previousElementSibling
    ) {
      if (sib.matches(HEADING_SELECTOR)) {
        const text = visibleText(sib);
        if (text) return text;
      }
    }

    // The ancestor itself may be (or contain) the labelling element.
    if (cur !== el) {
      if (cur.matches(HEADING_SELECTOR)) {
        const text = visibleText(cur);
        if (text) return text;
      }
      const label = containerLabel(cur);
      if (label) return label;
    }
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// buildDescriptor
// ----------------------------------------------------------------------------

function boundingRect(el: Element): Rect | undefined {
  if (typeof el.getBoundingClientRect !== 'function') return undefined;
  const r = el.getBoundingClientRect();
  if (!r) return undefined;
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

/**
 * Build a serializable `ElementDescriptor` for a live element: tag, id, ARIA
 * role/label, form name, capped visible text, a best-effort selector, and the
 * on-screen rect. Does not mutate the element.
 */
export function buildDescriptor(el: Element): ElementDescriptor {
  const descriptor: ElementDescriptor = {
    tag: el.tagName.toLowerCase(),
  };

  if (el.id) descriptor.id = el.id;

  const role = el.getAttribute('role');
  if (role) descriptor.role = role;

  const ariaLabel = el.getAttribute('aria-label') ?? resolveLabelledBy(el);
  if (ariaLabel) descriptor.ariaLabel = ariaLabel;

  const name = el.getAttribute('name');
  if (name) descriptor.name = name;

  const text = visibleText(el);
  if (text) descriptor.text = text;

  const selector = bestSelector(el);
  if (selector) descriptor.selector = selector;

  const rect = boundingRect(el);
  if (rect) descriptor.rect = rect;

  return descriptor;
}
