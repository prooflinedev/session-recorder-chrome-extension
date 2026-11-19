// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  closestComposed,
  composedTarget,
  deepActiveElement,
  shadowHosts,
} from './composed';
import { bestSelector, buildDescriptor, isSensitiveInput } from './descriptor';

/** A web component host with an open (or closed) shadow root holding `html`. */
function component(
  tag: string,
  html: string,
  mode: ShadowRootMode = 'open',
  parent: ParentNode = document.body,
): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  parent.append(host);
  const root = host.attachShadow({ mode });
  root.innerHTML = html;
  return { host, root };
}

/** Dispatch `event` on `el` and return what a capture listener on document sees. */
function seenFromDocument(el: Element, event: Event): { target: EventTarget | null; resolved: Element | null } {
  let seen: { target: EventTarget | null; resolved: Element | null } | undefined;
  const listener = (e: Event): void => {
    seen = { target: e.target, resolved: composedTarget(e) };
  };
  document.addEventListener(event.type, listener, true);
  el.dispatchEvent(event);
  document.removeEventListener(event.type, listener, true);
  if (!seen) throw new Error(`${event.type} never reached document`);
  return seen;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('composedTarget', () => {
  it('resolves a click inside an open shadow root to the real element', () => {
    const { host, root } = component('pay-button', '<button class="pay">Pay now</button>');
    const button = root.querySelector('button')!;

    const seen = seenFromDocument(button, new MouseEvent('click', { bubbles: true, composed: true }));

    // What the recorder used before: the retargeted host, with no text.
    expect(seen.target).toBe(host);
    expect(buildDescriptor(host).text).toBeUndefined();
    // What it records now.
    expect(seen.resolved).toBe(button);
    expect(buildDescriptor(seen.resolved!).text).toBe('Pay now');
  });

  it('resolves input events to the inner field, so its value is readable', () => {
    const { root } = component('email-field', '<input type="email" name="email" />');
    const input = root.querySelector('input')!;
    input.value = 'ada@example.com';

    const seen = seenFromDocument(input, new InputEvent('input', { bubbles: true, composed: true }));

    expect(seen.resolved).toBe(input);
    expect((seen.resolved as HTMLInputElement).value).toBe('ada@example.com');
  });

  it('follows nested open shadow roots', () => {
    const outer = component('app-shell', '<section></section>');
    const inner = component('app-card', '<a href="#x">Details</a>', 'open', outer.root.querySelector('section')!);
    const link = inner.root.querySelector('a')!;

    const seen = seenFromDocument(link, new MouseEvent('click', { bubbles: true, composed: true }));

    expect(seen.target).toBe(outer.host);
    expect(seen.resolved).toBe(link);
  });

  it('keeps a closed shadow root opaque', () => {
    const { host, root } = component('secret-widget', '<button>Hidden</button>', 'closed');

    const seen = seenFromDocument(root.querySelector('button')!, new MouseEvent('click', { bubbles: true, composed: true }));

    expect(seen.resolved).toBe(host);
  });

  it('matches e.target in the light DOM', () => {
    document.body.innerHTML = '<button id="plain">Plain</button>';
    const button = document.getElementById('plain')!;

    const seen = seenFromDocument(button, new MouseEvent('click', { bubbles: true, composed: true }));

    expect(seen.resolved).toBe(button);
  });
});

describe('deepActiveElement', () => {
  it('follows focus into open shadow roots', () => {
    const { host, root } = component('search-box', '<input id="q" />');
    const input = root.querySelector('input')!;
    input.focus();

    expect(document.activeElement).toBe(host);
    expect(deepActiveElement(document)).toBe(input);
  });

  it('returns the light-DOM focus unchanged', () => {
    document.body.innerHTML = '<input id="plain" />';
    const input = document.getElementById('plain')!;
    input.focus();

    expect(deepActiveElement(document)).toBe(input);
  });
});

describe('closestComposed', () => {
  it('crosses shadow boundaries to find an interactive ancestor', () => {
    document.body.innerHTML = '<a href="#card" id="card-link"></a>';
    const { root } = component('card-body', '<span>Open</span>', 'open', document.getElementById('card-link')!);
    const span = root.querySelector('span')!;

    expect(span.closest('a')).toBeNull();
    expect(closestComposed(span, 'a')).toBe(document.getElementById('card-link'));
  });
});

describe('shadowHosts', () => {
  it('lists enclosing hosts nearest first', () => {
    const outer = component('app-shell', '<div></div>');
    const inner = component('app-field', '<input />', 'open', outer.root.querySelector('div')!);

    expect(shadowHosts(inner.root.querySelector('input')!)).toEqual([inner.host, outer.host]);
    expect(shadowHosts(outer.host)).toEqual([]);
  });
});

describe('descriptors inside shadow roots', () => {
  it('prefixes the selector with the host so it stays unambiguous', () => {
    document.body.innerHTML = '<form id="checkout"></form>';
    const { root } = component('card-field', '<label>Card</label><input id="number" />', 'open', document.getElementById('checkout')!);

    expect(bestSelector(root.querySelector('input')!)).toBe('#checkout > card-field >> #number');
  });

  it('chains selectors through nested shadow roots', () => {
    const outer = component('app-shell', '<nav></nav>');
    outer.host.id = 'shell';
    const inner = component('app-menu', '<button class="open">Menu</button>', 'open', outer.root.querySelector('nav')!);

    expect(bestSelector(inner.root.querySelector('button')!)).toBe('#shell >> nav > app-menu >> button.open');
  });

  it('disambiguates same-tag siblings at the top of a shadow root', () => {
    const { host, root } = component('pager-buttons', '<button>Prev</button><button>Next</button>');
    host.id = 'pager';

    expect(bestSelector(root.querySelectorAll('button')[1]!)).toBe('#pager >> button:nth-of-type(2)');
  });

  it('treats an inner field as sensitive when its host is marked sensitive', () => {
    const { host, root } = component('secure-input', '<input />');
    host.setAttribute('type', 'password');
    const input = root.querySelector('input')!;
    input.value = 'hunter2';

    expect(isSensitiveInput(input)).toBe(true);
    expect(JSON.stringify(buildDescriptor(input))).not.toContain('hunter2');
  });

  it('still detects a password input inside a plain host', () => {
    const { root } = component('login-form', '<input type="password" />');

    expect(isSensitiveInput(root.querySelector('input')!)).toBe(true);
  });
});
