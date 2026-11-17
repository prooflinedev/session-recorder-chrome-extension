// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildDescriptor,
  bestSelector,
  visibleText,
  isSensitiveInput,
  nearestHeading,
} from './descriptor';

function frag(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe('bestSelector', () => {
  it('prefers id', () => {
    frag('<button id="save me">x</button>');
    const el = document.querySelector('button')!;
    expect(bestSelector(el)).toBe('#save\\ me');
  });

  it('uses data-testid when no id', () => {
    frag('<button data-testid="submit-btn">x</button>');
    const el = document.querySelector('button')!;
    expect(bestSelector(el)).toBe('[data-testid="submit-btn"]');
  });

  it('uses tag.class for the target segment', () => {
    frag('<div class="panel"><button class="btn primary">x</button></div>');
    const el = document.querySelector('button')!;
    expect(bestSelector(el)).toContain('button.btn.primary');
  });

  it('anchors on an ancestor id and builds a path', () => {
    frag('<div id="root"><section><button class="go">x</button></section></div>');
    const el = document.querySelector('button')!;
    const sel = bestSelector(el);
    expect(sel.startsWith('#root')).toBe(true);
    expect(sel.endsWith('button.go')).toBe(true);
    // resolvable
    expect(document.querySelector(sel)).toBe(el);
  });

  it('uses nth-of-type when siblings share a tag and no class', () => {
    frag('<ul><li>a</li><li>b</li><li>c</li></ul>');
    const el = document.querySelectorAll('li')[2]!;
    const sel = bestSelector(el);
    expect(sel).toContain('li:nth-of-type(3)');
    expect(document.querySelector(sel)).toBe(el);
  });
});

describe('visibleText', () => {
  it('collapses whitespace and trims', () => {
    frag('<div>  hello   \n  world  </div>');
    expect(visibleText(document.querySelector('div')!)).toBe('hello world');
  });

  it('caps at the default 80', () => {
    frag(`<div>${'a'.repeat(200)}</div>`);
    expect(visibleText(document.querySelector('div')!).length).toBe(80);
  });

  it('respects a custom cap', () => {
    frag('<div>abcdef</div>');
    expect(visibleText(document.querySelector('div')!, 3)).toBe('abc');
  });

  it('falls back to input value/placeholder', () => {
    frag('<input placeholder="Search here">');
    expect(visibleText(document.querySelector('input')!)).toBe('Search here');
  });
});

describe('isSensitiveInput', () => {
  it('detects type=password', () => {
    frag('<input type="password">');
    expect(isSensitiveInput(document.querySelector('input')!)).toBe(true);
  });

  it('detects sensitive name/autocomplete/placeholder', () => {
    frag('<input name="cc-number"><input autocomplete="cc-csc"><input placeholder="SSN">');
    const inputs = document.querySelectorAll('input');
    expect(isSensitiveInput(inputs[0]!)).toBe(true);
    expect(isSensitiveInput(inputs[1]!)).toBe(true);
    expect(isSensitiveInput(inputs[2]!)).toBe(true);
  });

  it('is false for a plain field', () => {
    frag('<input name="city">');
    expect(isSensitiveInput(document.querySelector('input')!)).toBe(false);
  });

  it.each([
    'name="apiKey"',
    'name="api_key"',
    'name="api-key"',
    'name="apikey"',
    'name="APIKey"',
    'name="key"',
    'name="secretKey"',
    'name="private_key"',
    'name="accessKey"',
    'aria-label="Secret key"',
    'autocomplete="one-time-code"',
    'name="otp"',
    'name="otpCode"',
    'name="pin"',
    'name="pinCode"',
    'name="cvc"',
    'name="mnemonic"',
    'name="seed_phrase"',
    'aria-label="Seed phrase"',
    'name="auth"',
    'name="authCode"',
    'name="authorization"',
    'name="credentials"',
  ])('detects %s', (attrs) => {
    frag(`<input ${attrs}>`);
    expect(isSensitiveInput(document.querySelector('input')!)).toBe(true);
  });

  it('detects a field inside a sensitive wrapping label', () => {
    frag('<label>API key <input name="field1"></label>');
    expect(isSensitiveInput(document.querySelector('input')!)).toBe(true);
  });

  it('detects a field named by a sensitive label[for]', () => {
    frag('<label for="f1">One-time code</label><input id="f1">');
    expect(isSensitiveInput(document.querySelector('input')!)).toBe(true);
  });

  it.each([
    'name="keyword"',
    'name="search_keywords"',
    'name="monkey"',
    'name="keyboard_layout"',
    'name="hotkey"',
    'name="spinner"',
    'name="shipping"',
    'name="opinion"',
    'name="author"',
    'name="authorName"',
    'name="hotpot"',
    'name="random_seed"',
    'aria-label="One time fee"',
    'name="username"',
    'name="email"',
  ])('stays unredacted for %s', (attrs) => {
    frag(`<input ${attrs}>`);
    expect(isSensitiveInput(document.querySelector('input')!)).toBe(false);
  });

  it('stays unredacted inside a plain label', () => {
    frag('<label>Search keywords <input name="q"></label>');
    expect(isSensitiveInput(document.querySelector('input')!)).toBe(false);
  });
});

describe('nearestHeading', () => {
  it('finds a preceding heading', () => {
    frag('<section><h2>Billing</h2><div><button>Pay</button></div></section>');
    expect(nearestHeading(document.querySelector('button')!)).toBe('Billing');
  });

  it('uses a legend inside a fieldset', () => {
    frag('<fieldset><legend>Address</legend><input name="street"></fieldset>');
    expect(nearestHeading(document.querySelector('input')!)).toBe('Address');
  });

  it('uses aria-label on a dialog', () => {
    frag('<div role="dialog" aria-label="Confirm delete"><button>OK</button></div>');
    expect(nearestHeading(document.querySelector('button')!)).toBe('Confirm delete');
  });

  it('returns undefined when nothing found', () => {
    frag('<div><span>x</span></div>');
    expect(nearestHeading(document.querySelector('span')!)).toBeUndefined();
  });
});

describe('buildDescriptor', () => {
  it('captures core fields', () => {
    frag('<button id="go" name="action" role="button" aria-label="Go now">Click me</button>');
    const d = buildDescriptor(document.querySelector('button')!);
    expect(d.tag).toBe('button');
    expect(d.id).toBe('go');
    expect(d.name).toBe('action');
    expect(d.role).toBe('button');
    expect(d.ariaLabel).toBe('Go now');
    expect(d.text).toBe('Click me');
    expect(d.selector).toBe('#go');
    expect(d.rect).toBeDefined();
  });

  it('never leaks a sensitive field value into descriptor text', () => {
    frag(
      '<input type="password" id="pw" name="password" placeholder="password" value="hunter2" />',
    );
    const el = document.querySelector('input')!;
    const d = buildDescriptor(el);
    expect(visibleText(el)).not.toContain('hunter2');
    expect(d.text ?? '').not.toContain('hunter2');
    // Placeholder is a safe fallback.
    expect(d.text).toBe('password');
  });

  it('does surface a non-sensitive input value as text', () => {
    frag('<input type="text" id="city" value="London" />');
    expect(visibleText(document.querySelector('input')!)).toBe('London');
  });
});
