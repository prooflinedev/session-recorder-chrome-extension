/**
 * Shadow-DOM-aware event and focus resolution for the capture content scripts.
 *
 * Listeners on `document` see events from inside a shadow root retargeted to the
 * shadow host, and `document.activeElement` stops at the host too. Pages built
 * from web components (Lit, Shoelace, Ionic, Material Web, Salesforce Lightning)
 * would otherwise record "clicked <my-field>" with no text, no value and no
 * usable selector. These helpers look through open shadow roots; closed roots
 * stay opaque, so their events still resolve to the host. Pure DOM.
 */

function shadowHostOf(node: Node): Element | null {
  const root = node.getRootNode();
  return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root.host : null;
}

/**
 * The element an event started on, looking through open shadow roots.
 *
 * Must be called while the event is being dispatched: `composedPath()` is empty
 * afterwards. Falls back to `e.target` when the path has no element.
 */
export function composedTarget(e: Event): Element | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const node of path) {
    if (node instanceof Element) return node;
  }
  return e.target instanceof Element ? e.target : null;
}

/** The focused element, following `activeElement` into open shadow roots. */
export function deepActiveElement(doc: Document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** `Element.closest` that continues from a shadow root to its host. */
export function closestComposed(el: Element, selector: string): Element | null {
  for (let cur: Element | null = el; cur; cur = shadowHostOf(cur)) {
    const hit = cur.closest(selector);
    if (hit) return hit;
  }
  return null;
}

/** The shadow hosts enclosing `el`, nearest first (empty in the light DOM). */
export function shadowHosts(el: Element): Element[] {
  const hosts: Element[] = [];
  for (let host = shadowHostOf(el); host; host = shadowHostOf(host)) hosts.push(host);
  return hosts;
}
