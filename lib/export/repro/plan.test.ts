import { describe, expect, it } from 'vitest';
import { makeDefaultSettings } from '@/lib/session/settings';
import type {
  ElementDescriptor,
  EventPayloadMap,
  EventType,
  Session,
  SessionEvent,
} from '@/lib/session/types';
import template from './runner.template.ts?raw';
import { buildReproPlan, renderReproSpec, REPRO_SPEC_PATH } from './plan';

const PRIMARY = 7;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ses_1',
    name: 'Checkout discount',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    initialUrl: 'https://shop.example.com/checkout?step=2',
    tabs: [
      {
        tabId: PRIMARY,
        url: 'https://shop.example.com/checkout',
        title: 'Checkout',
        attachedAt: 1_700_000_000_000,
        role: 'primary',
        attached: true,
      },
    ],
    settings: makeDefaultSettings(),
    status: 'stopped',
    counts: {},
    assetBytes: 0,
    ...overrides,
  };
}

let seq = 0;
function ev<T extends EventType>(
  type: T,
  t: number,
  payload: EventPayloadMap[T],
  tabId: number = PRIMARY,
): SessionEvent {
  seq += 1;
  return { id: `evt_${seq}`, sessionId: 'ses_1', t, tabId, type, importance: 1, payload } as SessionEvent;
}

const el = (d: Partial<ElementDescriptor> & { tag: string }): ElementDescriptor => d;
const apply = el({ tag: 'button', id: 'apply', text: 'Apply', selector: '#apply' });
const promo = el({ tag: 'input', id: 'promo', ariaLabel: 'Discount code', text: 'SAVE20', selector: '#promo' });
const click = (t: number, d: ElementDescriptor, tabId?: number) =>
  ev('click', t, { descriptor: d, modifiers: [], button: 0 }, tabId);
const input = (t: number, d: ElementDescriptor, value: string, inputType = 'text', redacted = false) =>
  ev('input', t, { descriptor: d, value, redacted, inputType });
const exception = (t: number, message: string) => ev('error', t, { message, origin: 'exception' });
const request = (t: number, method: string, url: string, status: number, extra = {}) =>
  ev('net-request', t, {
    requestId: `r${t}`,
    method,
    url,
    status,
    requestHeaders: [],
    responseHeaders: [],
    resourceType: 'Fetch',
    ...extra,
  });

const noAssets = (_id: string): string | undefined => undefined;
function plan(
  events: SessionEvent[],
  s: Session = session(),
  assetPath: (id: string) => string | undefined = noAssets,
) {
  const built = buildReproPlan({ session: s, events, assetPath });
  if (!built) throw new Error('expected a plan');
  return built;
}

describe('buildReproPlan steps', () => {
  it('starts at the initial URL and maps clicks, fills, selects and keys', () => {
    // Values are posted 800 ms after the last edit, or just before the next action.
    const { plan: p } = plan([
      input(199, promo, 'SAVE20'),
      click(200, apply),
      input(1100, el({ tag: 'select', id: 'size', text: 'S M', selector: '#size' }), 'm', 'select'),
      ev('key', 1200, { key: 'Ctrl+K', modifiers: ['ctrl'] }),
      ev('key', 1250, { key: 'Enter', modifiers: [] }),
      exception(1300, 'TypeError: total is undefined'),
    ]);
    expect(p.steps.map((s) => s.kind)).toEqual(['goto', 'fill', 'click', 'select', 'press', 'press']);
    expect(p.steps[0]).toEqual({ kind: 'goto', url: 'https://shop.example.com/checkout?step=2', at: 0 });
    expect(p.steps[1]).toMatchObject({ kind: 'fill', value: 'SAVE20' });
    expect(p.steps[3]).toMatchObject({ kind: 'select', value: 'm' });
    // The recorder upper-cases chord letters; pages check e.key === 'k'.
    expect(p.steps[4]).toMatchObject({ kind: 'press', key: 'Control+k' });
    expect(p.steps[5]).toMatchObject({ kind: 'press', key: 'Enter' });
    expect(p.recordedOrigin).toBe('https://shop.example.com');
  });

  it('orders element candidates: test id, id, role and name, label, name, selector, text', () => {
    const { plan: p } = plan([
      click(100, el({
        tag: 'button',
        id: 'pay',
        role: 'button',
        ariaLabel: 'Pay now',
        name: 'pay',
        text: 'Pay',
        selector: '[data-testid="pay-btn"]',
      })),
      exception(200, 'Error: x'),
    ]);
    const step = p.steps[1];
    if (step?.kind !== 'click') throw new Error('expected click');
    expect(step.target.candidates).toEqual([
      { by: 'testid', value: 'pay-btn' },
      { by: 'css', value: '#pay' },
      { by: 'role', role: 'button', value: 'Pay now' },
      { by: 'label', value: 'Pay now' },
      { by: 'name', value: 'pay' },
      { by: 'css', value: '[data-testid="pay-btn"]' },
      { by: 'text', value: 'Pay' },
    ]);
  });

  it('uses the implicit role of buttons and links, skips generated ids and never uses a field value as text', () => {
    const { plan: p } = plan([
      click(100, el({ tag: 'a', id: ':r3:', text: 'Orders', selector: '#\\:r3\\:' })),
      click(150, el({ tag: 'input', id: 'radix-12', text: 'SAVE20', selector: 'form > input' })),
      exception(200, 'Error: x'),
    ]);
    const [, link, field] = p.steps;
    if (link?.kind !== 'click' || field?.kind !== 'click') throw new Error('expected clicks');
    expect(link.target.candidates).toEqual([
      { by: 'role', role: 'link', value: 'Orders' },
      { by: 'text', value: 'Orders' },
    ]);
    expect(field.target.candidates).toEqual([{ by: 'css', value: 'form > input' }]);
  });

  it('keeps an upper-case letter only when Shift was held', () => {
    const { plan: p } = plan([
      ev('key', 100, { key: 'Ctrl+Shift+P', modifiers: ['ctrl', 'shift'] }),
      ev('key', 200, { key: 'Meta+Enter', modifiers: ['meta'] }),
      exception(300, 'Error: x'),
    ]);
    expect(p.steps.slice(1)).toEqual([
      expect.objectContaining({ key: 'Control+Shift+P' }),
      expect.objectContaining({ key: 'Meta+Enter' }),
    ]);
  });

  it('keeps button and modifiers of a click', () => {
    const { plan: p } = plan([
      ev('click', 100, { descriptor: apply, modifiers: ['ctrl', 'shift'], button: 2 }),
      exception(200, 'Error: x'),
    ]);
    expect(p.steps[1]).toMatchObject({ kind: 'click', button: 'right', modifiers: ['Control', 'Shift'] });
  });

  it('skips checkbox and radio values, because the click toggles them', () => {
    const box = el({ tag: 'input', id: 'gift', text: 'on', selector: '#gift' });
    const { plan: p } = plan([click(100, box), input(900, box, 'on', 'checkbox'), exception(1000, 'Error: x')]);
    expect(p.steps.map((s) => s.kind)).toEqual(['goto', 'click']);
  });

  it('drops the synthetic click on a control that follows a click on its label', () => {
    const label = el({ tag: 'label', text: 'Gift wrap', selector: 'form > label' });
    const box = el({ tag: 'input', id: 'gift', text: 'on', selector: '#gift' });
    const { plan: p } = plan([click(100, label), click(101, box), click(900, box), exception(1000, 'Error: x')]);
    expect(p.steps.map((s) => (s.kind === 'click' ? s.target.label : s.kind))).toEqual([
      'goto',
      'label "Gift wrap"',
      'input #gift',
    ]);
  });

  it('replays typed and reloaded navigation but not link navigation or route changes', () => {
    const { plan: p } = plan([
      click(100, el({ tag: 'a', text: 'Cart', selector: 'nav > a' })),
      ev('nav', 120, { url: 'https://shop.example.com/cart', transitionType: 'link' }),
      ev('spa-route', 200, { url: 'https://shop.example.com/cart#x', method: 'pushState' }),
      ev('nav', 300, { url: 'https://shop.example.com/orders', transitionType: 'typed' }),
      ev('nav', 400, { url: 'https://shop.example.com/orders', transitionType: 'reload' }),
      exception(500, 'Error: x'),
    ]);
    expect(p.steps.map((s) => s.kind)).toEqual(['goto', 'click', 'goto', 'reload']);
    expect(p.steps[2]).toMatchObject({ url: 'https://shop.example.com/orders' });
  });

  it('reads redacted values from numbered environment variables', () => {
    const pass = el({ tag: 'input', name: 'password', selector: '#pw', id: 'pw' });
    const token = el({ tag: 'input', name: 'token', selector: '#tok', id: 'tok' });
    const built = plan([
      input(100, pass, '«redacted»', 'password', true),
      input(200, token, '«redacted»', 'text', true),
      exception(300, 'Error: x'),
    ]);
    expect(built.plan.steps[1]).toEqual(expect.objectContaining({ kind: 'fill', env: 'REPRO_INPUT_1' }));
    expect(built.plan.steps[1]).not.toHaveProperty('value');
    expect(built.plan.steps[2]).toEqual(expect.objectContaining({ env: 'REPRO_INPUT_2' }));
    expect(built.envVars).toEqual([
      { name: 'REPRO_INPUT_1', label: 'input #pw' },
      { name: 'REPRO_INPUT_2', label: 'input #tok' },
    ]);
  });

  it('moves an input recorded after the action that ended it, and flags it', () => {
    // Older recordings posted values 800 ms after the last edit.
    const { plan: p } = plan([click(1000, apply), input(1802, promo, 'SAVE20'), exception(2000, 'Error: x')]);
    expect(p.steps.map((s) => s.kind)).toEqual(['goto', 'fill', 'click']);
    expect(p.blockers).toEqual([
      expect.stringContaining('was recorded after the action that followed it'),
    ]);
  });

  it('keeps an input that was recorded well after the previous action', () => {
    const { plan: p } = plan([click(1000, apply), input(2000, promo, 'SAVE20'), exception(2100, 'Error: x')]);
    expect(p.steps.map((s) => s.kind)).toEqual(['goto', 'click', 'fill']);
    expect(p.blockers).toEqual([]);
  });

  it('uploads a captured file from the export, or flags it when the file is not there', () => {
    const picker = el({ tag: 'input', id: 'csv', selector: '#csv' });
    const events = [
      input(100, picker, 'C:\\fakepath\\orders.csv', 'file'),
      ev('file-captured', 110, { assetId: 'ast_1', fileName: 'orders.csv', mime: 'text/csv', size: 9 }),
      exception(500, 'Error: x'),
    ];
    const withFile = plan(events, session(), (id) => (id === 'ast_1' ? 'files/orders.csv' : undefined));
    expect(withFile.plan.steps[1]).toMatchObject({ kind: 'upload', file: 'files/orders.csv' });
    expect(withFile.plan.blockers).toEqual([]);
    const without = plan(events);
    expect(without.plan.steps.map((s) => s.kind)).toEqual(['goto']);
    expect(without.plan.blockers).toEqual([expect.stringContaining('orders.csv')]);
  });

  it('does not replay steps after the last signal', () => {
    const { plan: p } = plan([click(100, apply), exception(500, 'Error: x'), click(900, promo)]);
    expect(p.steps.map((s) => s.kind)).toEqual(['goto', 'click']);
  });

  it('flags steps in other tabs before the bug, and ignores them after it', () => {
    const { plan: p } = plan([
      click(100, apply, 99),
      exception(500, 'Error: x'),
      click(900, apply, 99),
    ]);
    expect(p.steps.map((s) => s.kind)).toEqual(['goto']);
    expect(p.blockers).toEqual([expect.stringContaining('another tab')]);
  });

  it('flags input types Playwright cannot fill', () => {
    const { plan: p } = plan([
      input(100, el({ tag: 'input', id: 'vol', selector: '#vol' }), '40', 'range'),
      exception(300, 'Error: x'),
    ]);
    expect(p.steps.map((s) => s.kind)).toEqual(['goto']);
    expect(p.blockers).toEqual([expect.stringContaining('range')]);
  });

  it('waits after the last step for as long as the recording did, within bounds', () => {
    expect(plan([click(100, apply), exception(2100, 'Error: x')]).plan.settleMs).toBe(3500);
    expect(plan([click(100, apply), exception(150, 'Error: x')]).plan.settleMs).toBe(1550);
    expect(plan([exception(0, 'Error: at load')]).plan.settleMs).toBe(1500);
    expect(plan([click(100, apply), exception(60_000, 'Error: x')]).plan.settleMs).toBe(15_000);
  });
});

describe('buildReproPlan signals', () => {
  it('asserts exceptions, console errors, error logs and failing requests', () => {
    const { plan: p } = plan([
      click(100, apply),
      exception(200, 'TypeError: Cannot read properties of undefined (reading \'total\')'),
      ev('console', 210, { level: 'error', text: 'Order 4211 failed at https://shop.example.com/api' }),
      ev('error', 220, { message: 'Refused to load the script', origin: 'log' }),
      request(230, 'post', 'https://api.example.com/api/orders/4211/discount?code=1', 500),
      request(240, 'GET', 'https://shop.example.com/api/cart', 0, { failed: true, status: undefined }),
    ]);
    expect(p.signals).toEqual([
      expect.objectContaining({ kind: 'exception', text: "TypeError: Cannot read properties of undefined (reading 'total')" }),
      expect.objectContaining({ kind: 'console', text: 'Order 4211 failed at https://shop.example.com/api' }),
      expect.objectContaining({ kind: 'console', text: 'Refused to load the script' }),
      expect.objectContaining({ kind: 'request', method: 'POST', path: '/api/orders/4211/discount', status: 500 }),
      expect.objectContaining({ kind: 'request', method: 'GET', path: '/api/cart', status: 'failed' }),
    ]);
    const [exc, con, , orders] = p.signals;
    const re = (s: (typeof p.signals)[number] | undefined) => new RegExp((s as { pattern: string }).pattern);
    expect(re(exc).test("TypeError: Cannot read properties of undefined (reading 'total')")).toBe(true);
    expect(re(con).test('Order 98 failed at http://localhost:3000/api')).toBe(true);
    expect(re(con).test('Order 98 succeeded')).toBe(false);
    const path = new RegExp((orders as { pathPattern: string }).pathPattern);
    expect(path.test('/api/orders/77/discount')).toBe(true);
    expect(path.test('/api/orders/77/discount/extra')).toBe(false);
  });

  it('ignores noise: warnings, telemetry, static files, the favicon and resource-load logs', () => {
    const built = buildReproPlan({
      session: session(),
      events: [
        click(100, apply),
        ev('console', 200, { level: 'warn', text: 'deprecated' }),
        request(210, 'POST', 'https://api.segment.io/v1/t', 500),
        request(220, 'GET', 'https://shop.example.com/logo.png', 404, { resourceType: 'Image' }),
        request(230, 'GET', 'https://shop.example.com/favicon.ico', 404, { resourceType: 'Other' }),
        ev('error', 240, { message: 'Failed to load resource: the server responded with a status of 404', origin: 'log' }),
        ev('error', 250, { message: 'net::ERR_FAILED', origin: 'network' }),
        request(260, 'GET', 'https://shop.example.com/api/ok', 200),
      ],
      assetPath: noAssets,
    });
    expect(built?.plan.signals).toEqual([]);
  });

  it('asserts each signal once', () => {
    const { plan: p } = plan([
      exception(200, 'Error: boom'),
      exception(300, 'Error: boom'),
      request(400, 'GET', 'https://shop.example.com/api/items/1', 500),
      request(500, 'GET', 'https://shop.example.com/api/items/2', 502),
    ]);
    expect(p.signals.map((s) => s.kind)).toEqual(['exception', 'request']);
  });
});

describe('buildReproPlan without signals', () => {
  it('marks the test fixme and quotes what the user noted', () => {
    const { plan: p } = plan([
      click(100, apply),
      ev('marker', 200, { name: 'Total not updated' }),
      ev('note', 300, { text: 'Expected $96.00' }),
    ]);
    expect(p.signals).toEqual([]);
    expect(p.fixme).toContain('Total not updated');
    expect(p.fixme).toContain('Expected $96.00');
  });

  it('says when deep capture was unavailable', () => {
    const { plan: p } = plan([
      click(100, apply),
      ev('session-note', 50, { kind: 'warning', text: 'Deep capture unavailable: Another debugger is already attached' }),
    ]);
    expect(p.fixme).toContain('deep capture was unavailable');
  });

  it('is not built for a session that did not start on a web page', () => {
    expect(
      buildReproPlan({ session: session({ initialUrl: 'chrome://newtab/' }), events: [], assetPath: noAssets }),
    ).toBeUndefined();
  });
});

describe('purity and determinism', () => {
  it('does not change its input and gives the same output for the same input', () => {
    const events = [input(100, promo, 'SAVE20'), click(200, apply), exception(300, 'Error: x')];
    const before = structuredClone(events);
    const a = renderReproSpec(plan(events).plan);
    const b = renderReproSpec(plan(structuredClone(events)).plan);
    expect(events).toEqual(before);
    expect(a).toBe(b);
  });
});

describe('renderReproSpec', () => {
  const MARKER = '/*@repro-plan*/ ({} as Plan)';
  const hostile = [
    '"; require("child_process").exec("x"); "',
    '`${process.exit(1)}`',
    '*/ throw 1; /*',
    'line\nbreak\r\n',
    'sep\u2028\u2029',
    '$& $1 $` $\'',
    '</script>',
  ];

  it('embeds the plan as data and leaves the runner code unchanged', () => {
    const events = [
      ...hostile.map((v, i) => input(100 + i, el({ tag: 'input', id: `f${i}`, selector: `#f${i}`, text: v }), v)),
      click(200, el({ tag: 'button', text: hostile[0], ariaLabel: hostile[1], selector: hostile[2] })),
      exception(300, hostile.join(' ')),
    ];
    const built = plan(events, session({ name: hostile.join(' ') }));
    const spec = renderReproSpec(built.plan);

    const [head, tail] = template.split(MARKER);
    expect(tail).toBeDefined();
    expect(spec.startsWith(head!)).toBe(true);
    expect(spec.endsWith(tail!)).toBe(true);
    const literal = spec.slice(head!.length, spec.length - tail!.length);
    expect(literal).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(literal)).toEqual(built.plan);
  });

  it('names the file at the bundle root', () => {
    expect(REPRO_SPEC_PATH).toBe('repro.spec.ts');
  });
});
