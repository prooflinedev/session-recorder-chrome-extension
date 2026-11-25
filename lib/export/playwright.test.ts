import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

import { SessionBuilder, buildSampleSession } from '@/lib/fixtures/session-builder';
import type {
  ElementDescriptor,
  EventPayloadMap,
  EventType,
  NetRequestPayload,
  Session,
  SessionEvent,
} from '@/lib/session/types';
import { buildBundle, estimateForLevels, type ExportFile } from './bundle';
import { buildPlaywrightRepro, type PlaywrightReproOptions } from './playwright';

let seq = 0;

/** An event at `t` ms, in the fixture's primary tab unless told otherwise. */
function ev<T extends EventType>(
  type: T,
  t: number,
  payload: EventPayloadMap[T],
  tabId = 1,
): SessionEvent {
  seq += 1;
  return {
    id: `evt_${seq}`,
    sessionId: 'sess_fixture',
    t,
    tabId,
    type,
    importance: 1,
    payload,
  } as SessionEvent;
}

function fixtureSession(overrides?: Partial<Session>): Session {
  return new SessionBuilder(overrides).build().session;
}

function repro(
  events: SessionEvent[],
  opts: Partial<PlaywrightReproOptions> = {},
  session: Session = fixtureSession(),
): string {
  const out = buildPlaywrightRepro(session, events, { level: 'L0', ...opts });
  if (out === null) throw new Error('expected a repro test');
  return out;
}

const button = (
  text: string,
  extra: Partial<ElementDescriptor> = {},
): ElementDescriptor => ({
  tag: 'button',
  text,
  ...extra,
});

const click = (
  t: number,
  descriptor: ElementDescriptor,
  extra: { modifiers?: string[]; button?: number; tabId?: number } = {},
) =>
  ev(
    'click',
    t,
    {
      descriptor,
      modifiers: extra.modifiers ?? [],
      ...(extra.button !== undefined ? { button: extra.button } : {}),
    },
    extra.tabId,
  );

const input = (
  t: number,
  descriptor: ElementDescriptor,
  value: string,
  extra: { redacted?: boolean; inputType?: string } = {},
) =>
  ev('input', t, {
    descriptor,
    value,
    redacted: extra.redacted ?? false,
    ...(extra.inputType !== undefined ? { inputType: extra.inputType } : {}),
  });

const nav = (t: number, url: string, transitionType = 'link') =>
  ev('nav', t, { url, transitionType });

const request = (
  t: number,
  method: string,
  url: string,
  extra: Partial<NetRequestPayload> = {},
) =>
  ev('net-request', t, {
    requestId: `req_${t}`,
    method,
    url,
    requestHeaders: [],
    responseHeaders: [],
    resourceType: 'Fetch',
    ...extra,
  });

/** The header comment as one line of prose. */
function header(code: string): string {
  return code
    .split('\n')
    .filter((line) => line.startsWith('//'))
    .map((line) => line.slice(2).trim())
    .join(' ');
}

/** Lines of the test body that do something, without their trailing timestamp. */
function steps(code: string): string[] {
  return code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('await '))
    .map((line) => line.replace(/ \/\/ \[.*$/, ''));
}

/** Assertions the test runs, leaving out the commented-out ones. */
function activeChecks(code: string): string[] {
  return code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('expect('));
}

/** Assertions left commented out for the developer to opt into. */
function commentedChecks(code: string): string[] {
  return code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('// expect('))
    .map((line) => line.slice('// '.length));
}

function syntaxErrors(code: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

/** Type errors in `code` checked as a spec file against the installed @playwright/test. */
function typeErrors(code: string): string[] {
  const file = resolve('lib/export/__generated__.spec.ts');
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
  };
  const host = ts.createCompilerHost(options);
  const isGenerated = (name: string) => resolve(name) === file;
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, language, ...rest) =>
    isGenerated(name)
      ? ts.createSourceFile(name, code, language)
      : getSourceFile.call(host, name, language, ...rest);
  host.fileExists = (name) => isGenerated(name) || fileExists.call(host, name);
  host.readFile = (name) => (isGenerated(name) ? code : readFile.call(host, name));
  const program = ts.createProgram([file], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('buildPlaywrightRepro', () => {
  it('returns null when nothing would be replayed', () => {
    const onlyRequests = new SessionBuilder()
      .net('GET', 'https://api.example.com/me')
      .build();
    expect(
      buildPlaywrightRepro(onlyRequests.session, onlyRequests.events, { level: 'L0' }),
    ).toBeNull();

    const noPage = fixtureSession({ initialUrl: 'chrome://newtab/' });
    expect(
      buildPlaywrightRepro(noPage, [click(1000, button('Save'))], { level: 'L0' }),
    ).toBeNull();
  });

  it('opens the start page and clicks by role and accessible name', () => {
    const code = repro([click(1000, button('Save'))]);
    expect(code).toContain(
      "const baseURL = process.env.REPRO_BASE_URL ?? 'https://app.example.com';",
    );
    expect(steps(code)).toEqual([
      "await page.goto(appUrl('/dashboard'));",
      "await page.getByRole('button', { name: 'Save', exact: true }).click();",
    ]);
    expect(code).toContain("test('repro: Fixture session', async ({ page }) => {");
  });

  it('keeps replayed paths on the base URL', () => {
    const code = repro([
      nav(1000, 'https://app.example.com//assets/report', 'typed'),
      click(2000, button('Open')),
    ]);
    expect(steps(code)[1]).toBe("await page.goto(appUrl('//assets/report'));");
    const helper = code.split('\n').find((line) => line.startsWith('const appUrl'));
    const appUrl = new Function(
      'baseURL',
      `${helper!.replace(': string', '')} return appUrl;`,
    )('http://localhost:3000/app/') as (route: string) => string;
    // A path starting with // must not be read as another host.
    expect(appUrl('//assets/report')).toBe('http://localhost:3000/app//assets/report');
    expect(appUrl('/cart?step=2#pay')).toBe(
      'http://localhost:3000/app/cart?step=2#pay',
    );
  });

  it('prefers a test id, then a stable id, over role and text', () => {
    const code = repro([
      click(1000, button('Save', { selector: '[data-testid="save-btn"]' })),
      click(2000, button('Pay', { id: 'checkout', selector: '#checkout' })),
      click(3000, button('Pay', { id: ':r5:', selector: '#\\:r5\\:' })),
      click(4000, { tag: 'div', id: 'a.b', selector: '#a\\.b' }),
      click(5000, button('Go', { selector: '[data-testid="\\31 23"]' })),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.getByTestId('save-btn').click();",
      "await page.locator('#checkout').click();",
      // React useId values change on every load, so they are not used.
      "await page.getByRole('button', { name: 'Pay', exact: true }).click();",
      'await page.locator(\'[id="a.b"]\').click();',
      // CSS escapes in the recorded selector are undone.
      "await page.getByTestId('123').click();",
    ]);
  });

  it('takes element details the export level dropped from the full recording', () => {
    const full = click(1000, {
      tag: 'input',
      name: 'q',
      selector: 'input[name="q"]',
      text: 'Search',
    });
    const trimmed = {
      ...full,
      payload: { modifiers: [], descriptor: { tag: 'input', text: 'Search' } },
    } as SessionEvent;
    const code = repro([trimmed], { level: 'L3', fullEvents: [full] });
    expect(steps(code)[1]).toBe('await page.locator(\'input[name="q"]\').click();');
    expect(header(code)).not.toContain('Exported at L3');

    const alone = repro([trimmed], { level: 'L3' });
    expect(steps(alone)[1]).toBe("await page.locator('input').click();");
    expect(header(alone)).toContain('Exported at L3 (minimal)');
  });

  it('falls back to label, field name, text, the CSS path, then the tag', () => {
    const longText = 'x'.repeat(80);
    const code = repro([
      input(1000, { tag: 'input', ariaLabel: 'Email' }, 'a@example.com'),
      input(2000, { tag: 'input', name: 'q' }, 'shoes'),
      click(3000, { tag: 'span', text: 'Delete', selector: 'span.icon' }),
      click(4000, { tag: 'div', text: longText, selector: 'div.card:nth-of-type(2)' }),
      click(5000, { tag: 'a', text: longText }),
      click(6000, { tag: 'input' }),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.getByLabel('Email', { exact: true }).fill('a@example.com');",
      "await page.locator('input[name=\"q\"]').fill('shoes');",
      "await page.getByText('Delete', { exact: true }).click();",
      "await page.locator('div.card:nth-of-type(2)').click();",
      // Text cut at the capture cap is matched as a substring.
      `await page.getByRole('link', { name: '${longText}' }).click();`,
      "await page.locator('input').click();",
    ]);
    expect(code).toContain(
      "await page.locator('input').click(); // [00:06] weak locator, check it",
    );
    expect(header(code)).toContain(
      '1 step marked "weak locator" had only the tag name to go on.',
    );
  });

  it('keeps click modifiers and mouse buttons', () => {
    const code = repro([
      click(1000, button('Open'), { modifiers: ['ctrl', 'shift'] }),
      click(2000, button('Menu'), { button: 2 }),
      click(3000, button('Tab'), { button: 1 }),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.getByRole('button', { name: 'Open', exact: true }).click({ modifiers: ['Control', 'Shift'] });",
      "await page.getByRole('button', { name: 'Menu', exact: true }).click({ button: 'right' });",
      "await page.getByRole('button', { name: 'Tab', exact: true }).click({ button: 'middle' });",
    ]);
  });

  it('orders same-millisecond events by cause and effect', () => {
    // Storage returns events that share a millisecond in any order.
    const code = repro([
      ev('key', 1000, {
        key: 'Enter',
        modifiers: [],
        descriptor: { tag: 'input', id: 'new-todo' },
      }),
      input(1000, { tag: 'input', id: 'new-todo' }, 'buy milk'),
      ev('error', 2000, {
        message: 'TypeError: list is undefined',
        origin: 'exception',
      }),
      click(2000, button('Clear completed')),
    ]);
    const body = code.split('\n').map((line) => line.replace(/ \/\/ \[.*$/, '').trim());
    const at = (line: string) => body.indexOf(line);
    expect(at("await page.locator('#new-todo').fill('buy milk');")).toBeLessThan(
      at("await page.locator('#new-todo').press('Enter');"),
    );
    // The check must come after the click that caused the error, or it passes too early.
    expect(
      at(
        "await page.getByRole('button', { name: 'Clear completed', exact: true }).click();",
      ),
    ).toBeLessThan(
      at(
        "expect(pageErrors).not.toContainEqual(expect.stringContaining('list is undefined'));",
      ),
    );
  });

  it('drops the repeat a field logs when it loses focus', () => {
    const user = { tag: 'input', id: 'f-user' };
    const todo = { tag: 'input', id: 'new-todo' };
    const code = repro([
      input(1000, user, 'ada'),
      input(2000, { tag: 'input', id: 'f-email' }, 'ada@example.com'),
      // The change event when focus left #f-user.
      input(2000, user, 'ada'),
      input(3000, todo, 'buy milk'),
      ev('key', 3000, { key: 'Enter', modifiers: [], descriptor: todo }),
      // The page cleared the field on Enter and the same text was typed again.
      input(4000, todo, 'buy milk'),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.locator('#f-user').fill('ada');",
      "await page.locator('#f-email').fill('ada@example.com');",
      "await page.locator('#new-todo').fill('buy milk');",
      "await page.locator('#new-todo').press('Enter');",
      "await page.locator('#new-todo').fill('buy milk');",
    ]);
  });

  it('fills each edit once, with its final value', () => {
    const search = { tag: 'input', name: 'q' };
    const code = repro([
      input(1000, search, 'he'),
      input(2000, search, 'hello'),
      click(3000, button('Search')),
      input(4000, search, 'hello world'),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.locator('input[name=\"q\"]').fill('hello');",
      "await page.getByRole('button', { name: 'Search', exact: true }).click();",
      "await page.locator('input[name=\"q\"]').fill('hello world');",
    ]);
  });

  it('reads redacted values from the environment and never writes them', () => {
    const code = repro([
      // The recorder keeps a field's placeholder as its text.
      input(
        1000,
        { tag: 'input', id: 'f-pass', name: 'password', text: '••••••••' },
        '«redacted»',
        {
          redacted: true,
          inputType: 'password',
        },
      ),
      input(2000, { tag: 'input', name: 'card[number]' }, '«redacted»', {
        redacted: true,
      }),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.locator('#f-pass').fill(process.env.REPRO_PASSWORD ?? '');",
      "await page.locator('input[name=\"card[number]\"]').fill(process.env.REPRO_CARD_NUMBER ?? '');",
    ]);
    expect(code).toContain('//   REPRO_PASSWORD: input #f-pass');
    expect(code).toContain('//   REPRO_CARD_NUMBER: input named "card[number]"');
    expect(code).not.toContain('«redacted»');
  });

  it('selects options and does not toggle a checkbox twice', () => {
    const remember = { tag: 'input', name: 'remember' };
    const code = repro([
      input(1000, { tag: 'select', name: 'country' }, 'de', { inputType: 'select' }),
      // A label click is recorded as two clicks: the label, then the browser's
      // own click on its checkbox, followed by the change.
      click(2000, { tag: 'label', text: 'Remember me' }),
      click(2003, remember),
      input(2800, remember, 'on', { inputType: 'checkbox' }),
      input(9000, { tag: 'input', name: 'terms' }, 'on', { inputType: 'checkbox' }),
      input(10000, { tag: 'input', name: 'plan' }, 'pro', { inputType: 'radio' }),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.locator('select[name=\"country\"]').selectOption('de');",
      "await page.getByText('Remember me', { exact: true }).click();",
      'await page.locator(\'input[name="terms"]\').click();',
      'await page.locator(\'input[name="plan"]\').check();',
    ]);
  });

  it('does not let a click on another element hide a checkbox change', () => {
    const code = repro([
      click(1000, button('Save')),
      // Toggled by a key the recorder does not capture, such as a bare Space.
      input(1500, { tag: 'input', name: 'newsletter' }, 'on', {
        inputType: 'checkbox',
      }),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.getByRole('button', { name: 'Save', exact: true }).click();",
      'await page.locator(\'input[name="newsletter"]\').click();',
    ]);
  });

  it('leaves file choices to the developer', () => {
    const code = repro([
      click(1000, button('Upload')),
      input(2000, { tag: 'input', id: 'f-file' }, 'C:\\fakepath\\contacts.csv', {
        inputType: 'file',
      }),
    ]);
    expect(code).toContain(
      "// [00:02] Chose a file for page.locator('#f-file'). Not replayed: call setInputFiles on it with your own file.",
    );
    expect(code).not.toContain('fakepath');
    expect(header(code)).toContain(
      'Not replayed: 1 file upload. Comments mark where they happened.',
    );
  });

  it('presses keys with Playwright key names', () => {
    const code = repro([
      ev('key', 1000, { key: 'Ctrl+S', modifiers: ['ctrl'] }),
      ev('key', 2000, { key: 'Ctrl+Shift+K', modifiers: ['ctrl', 'shift'] }),
      ev('key', 3000, {
        key: 'Enter',
        modifiers: [],
        descriptor: { tag: 'input', name: 'q' },
      }),
      ev('key', 4000, { key: 'Escape', modifiers: [], descriptor: { tag: 'body' } }),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.keyboard.press('Control+s');",
      "await page.keyboard.press('Control+Shift+K');",
      "await page.locator('input[name=\"q\"]').press('Enter');",
      "await page.keyboard.press('Escape');",
    ]);
  });

  it('follows navigations, reloads and route changes', () => {
    const code = repro([
      nav(500, 'https://app.example.com/dashboard', 'reload'),
      nav(1000, 'https://app.example.com/settings', 'typed'),
      click(2000, { tag: 'a', text: 'Contacts' }),
      nav(3000, 'https://app.example.com/contacts?page=2'),
      click(4000, button('Refresh')),
      nav(5000, 'https://app.example.com/contacts?page=2', 'reload'),
      click(6000, button('Sign in')),
      nav(7000, 'https://auth.example.org/login'),
      ev('spa-route', 8000, {
        url: 'https://auth.example.org/#/mfa',
        method: 'pushState',
      }),
    ]);
    expect(steps(code)).toEqual([
      "await page.goto(appUrl('/dashboard'));",
      // The reload right after opening the page is skipped.
      "await page.goto(appUrl('/settings'));",
      "await page.getByRole('link', { name: 'Contacts', exact: true }).click();",
      "await page.waitForURL((url) => url.pathname === '/contacts');",
      "await page.getByRole('button', { name: 'Refresh', exact: true }).click();",
      'await page.reload();',
      "await page.getByRole('button', { name: 'Sign in', exact: true }).click();",
      "await page.waitForURL((url) => url.host === 'auth.example.org' && url.pathname === '/login');",
      "await page.waitForURL((url) => url.host === 'auth.example.org' && url.pathname === '/' && url.hash === '#/mfa');",
    ]);
  });

  it('presses Back after a page interaction unless the page went back itself', () => {
    const code = repro([
      click(1000, { tag: 'a', text: 'Orders' }),
      nav(2000, 'https://app.example.com/orders'),
      input(3000, { tag: 'input', name: 'q' }, 'boots'),
      // The browser's Back button, three seconds after typing.
      nav(6000, 'https://app.example.com/dashboard'),
      click(7000, { tag: 'a', text: 'Orders' }),
      nav(8000, 'https://app.example.com/orders'),
      click(9000, button('Cancel')),
      // The page called history.back() from the Cancel button.
      ev('spa-route', 9050, {
        url: 'https://app.example.com/dashboard',
        method: 'pushState',
      }),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.getByRole('link', { name: 'Orders', exact: true }).click();",
      "await page.waitForURL((url) => url.pathname === '/orders');",
      "await page.locator('input[name=\"q\"]').fill('boots');",
      "await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 3000 }).catch(() => page.goBack());",
      "await page.getByRole('link', { name: 'Orders', exact: true }).click();",
      "await page.waitForURL((url) => url.pathname === '/orders');",
      "await page.getByRole('button', { name: 'Cancel', exact: true }).click();",
      "await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 600 }).catch(() => page.goBack());",
    ]);
    expect(code).toContain(
      '// [00:06] Back to /dashboard, by the page itself or the browser button.',
    );
  });

  it('does not mistake a history replacement for Back', () => {
    const code = repro([
      nav(1000, 'https://app.example.com/docs#intro', 'typed'),
      click(2000, { tag: 'a', text: 'Setup' }),
      ev('spa-route', 2100, {
        url: 'https://app.example.com/docs#setup',
        method: 'pushState',
      }),
      // The page swapped its hash back without going back in history.
      ev('spa-route', 3000, {
        url: 'https://app.example.com/docs#intro',
        method: 'replaceState',
      }),
    ]);
    expect(steps(code).slice(-1)).toEqual([
      "await page.waitForURL((url) => url.pathname === '/docs' && url.hash === '#intro');",
    ]);
    expect(code).not.toContain('goBack');
  });

  it('waits for a query-only navigation to leave the old query', () => {
    const code = repro([
      nav(1000, 'https://app.example.com/contacts?page=1', 'typed'),
      click(2000, button('Next')),
      ev('spa-route', 2100, {
        url: 'https://app.example.com/contacts?page=2&t=1764064800',
        method: 'pushState',
      }),
    ]);
    expect(steps(code).slice(2)).toEqual([
      "await page.getByRole('button', { name: 'Next', exact: true }).click();",
      "await page.waitForURL((url) => url.pathname === '/contacts' && url.search !== '?page=1');",
    ]);
  });

  it('replays the browser back and forward buttons', () => {
    const code = repro([
      click(1000, { tag: 'a', text: 'Orders' }),
      nav(2000, 'https://app.example.com/orders'),
      nav(3000, 'https://app.example.com/dashboard'),
      ev('spa-route', 4000, {
        url: 'https://app.example.com/orders',
        method: 'popstate',
      }),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.getByRole('link', { name: 'Orders', exact: true }).click();",
      "await page.waitForURL((url) => url.pathname === '/orders');",
      'await page.goBack();',
      'await page.goForward();',
    ]);
  });

  it('comments on steps in other tabs instead of replaying them', () => {
    const code = repro([
      click(1000, button('Open report')),
      ev(
        'tab-opened',
        1500,
        { url: 'https://app.example.com/report', openerTabId: 1 },
        2,
      ),
      click(2000, button('Download'), { tabId: 2 }),
      ev('tab-switch', 3000, { fromTabId: 2, toTabId: 1 }),
      click(4000, button('Close')),
    ]);
    expect(steps(code).slice(1)).toEqual([
      "await page.getByRole('button', { name: 'Open report', exact: true }).click();",
      "await page.getByRole('button', { name: 'Close', exact: true }).click();",
    ]);
    expect(code).toContain(
      '// [00:01] Opened tab 2 (https://app.example.com/report). Steps in other tabs are not replayed.',
    );
    expect(code).toContain(
      '// [00:02] In tab 2: clicked button "Download". Not replayed, the test drives one tab.',
    );
    expect(code).toContain('// [00:03] Switched back to the recorded tab.');
    expect(header(code)).toContain('Not replayed: 1 step in other tabs.');
  });

  it('checks a recorded exception right where it happened', () => {
    const code = repro([
      click(1000, button('Pay')),
      ev('error', 1800, {
        message:
          "Uncaught TypeError: Cannot read properties of undefined (reading 'id')\n    at pay (app.js:1:2)",
        origin: 'exception',
      }),
      click(3000, button('Retry')),
    ]);
    const body = code.split('\n').map((line) => line.trim());
    const at = body.indexOf(
      "expect(pageErrors).not.toContainEqual(expect.stringContaining('Cannot read properties of undefined (reading \\'id\\')'));",
    );
    expect(body.slice(at - 3, at + 2)).toEqual([
      "await page.getByRole('button', { name: 'Pay', exact: true }).click(); // [00:01]",
      "// [00:01] The recording hit an uncaught error here: Uncaught TypeError: Cannot read properties of undefined (reading 'id')",
      // The error came 800 ms after the click; the check allows another 500 ms.
      'await page.waitForTimeout(1300);',
      body[at],
      "await page.getByRole('button', { name: 'Retry', exact: true }).click(); // [00:03]",
    ]);
    expect(code).toContain(
      "page.on('pageerror', (error) => pageErrors.push(String(error)));",
    );
    expect(header(code)).toContain(
      'red while the bug is present, green once it is fixed.',
    );
  });

  it('matches the part of an error message that survived redaction', () => {
    const code = repro([
      click(1000, button('Invite')),
      ev('error', 1500, {
        message: 'Error: No account for «redacted», cannot send the invite',
        origin: 'exception',
      }),
    ]);
    expect(activeChecks(code)).toEqual([
      "expect(pageErrors).not.toContainEqual(expect.stringContaining(', cannot send the invite'));",
    ]);
  });

  it('checks failing API calls, not missing images, aborts or expected client errors', () => {
    const code = repro([
      click(1000, button('Save')),
      request(1200, 'POST', 'https://api.example.com/v1/orders?draft=1', {
        status: 500,
      }),
      request(1300, 'GET', 'https://app.example.com/logo.png', {
        status: 404,
        resourceType: 'Image',
      }),
      request(1400, 'GET', 'https://api.example.com/v1/poll', {
        failed: true,
        failureReason: 'net::ERR_ABORTED',
      }),
      request(1500, 'GET', 'https://api.example.com/v1/me', { status: 401 }),
      request(1600, 'GET', 'https://api.example.com/v1/cart', { status: 404 }),
      ev('error', 1700, {
        message: 'Cart not found',
        origin: 'network',
        linkedRequestId: 'req_1600',
      }),
      request(1800, 'GET', 'https://api.example.com/v1/stock', {
        failed: true,
        failureReason: 'net::ERR_CONNECTION_REFUSED',
      }),
    ]);
    expect(activeChecks(code)).toEqual([
      "expect(failedRequests).not.toContain('POST /v1/orders 500');",
      "expect(failedRequests).not.toContain('GET /v1/cart 404');",
      "expect(failedRequests).not.toContain('GET /v1/stock failed');",
    ]);
    expect(commentedChecks(code)).toEqual([
      "expect(failedRequests).not.toContain('GET /v1/me 401');",
    ]);
    expect(code).not.toContain('logo.png');
    expect(code).not.toContain('/v1/poll');
    expect(code).toContain("page.on('requestfailed', (request) => {");
    // Canceled requests are left out on replay too, as they are when generating.
    expect(code).toContain(
      "if (/ABORTED|cancel/i.test(request.failure()?.errorText ?? '')) return;",
    );
  });

  it('checks an error again after each step that recorded it', () => {
    const boom = {
      message: 'TypeError: cart is undefined',
      origin: 'exception' as const,
    };
    const cartCheck =
      "expect(pageErrors).not.toContainEqual(expect.stringContaining('cart is undefined'));";
    const code = repro([
      click(1000, button('Add')),
      ev('error', 1200, boom),
      ev('error', 1300, boom),
      click(3000, button('Checkout')),
      ev('error', 3200, boom),
    ]);
    // One check after each step, so the Checkout one still fails if only Add gets fixed.
    const flow = code
      .split('\n')
      .map((line) => line.replace(/ \/\/ \[.*$/, '').trim())
      .filter((line) => line.startsWith('await page.') || line.startsWith('expect('));
    expect(flow.slice(1)).toEqual([
      "await page.getByRole('button', { name: 'Add', exact: true }).click();",
      'await page.waitForTimeout(700);',
      cartCheck,
      "await page.getByRole('button', { name: 'Checkout', exact: true }).click();",
      'await page.waitForTimeout(700);',
      cartCheck,
    ]);
  });

  it('does not let a commented check stand in for a required one', () => {
    const cartCheck = "expect(failedRequests).not.toContain('GET /v1/cart 404');";
    const code = repro([
      click(1000, button('Load cart')),
      request(1500, 'GET', 'https://api.example.com/v1/cart', { status: 404 }),
      click(2000, button('Retry')),
      request(2500, 'GET', 'https://api.example.com/v1/cart', { status: 404 }),
      ev('error', 2600, {
        message: 'Cart not found',
        origin: 'network',
        linkedRequestId: 'req_2500',
      }),
    ]);
    expect(commentedChecks(code)).toEqual([cartCheck]);
    expect(activeChecks(code)).toEqual([cartCheck]);
  });

  it('leaves console errors as checks to opt into', () => {
    const code = repro([
      click(1000, button('Save')),
      ev('error', 1500, { message: 'Failed to save draft', origin: 'console' }),
      ev('error', 1600, {
        message:
          'Failed to load resource: the server responded with a status of 500 ()',
        origin: 'log',
      }),
    ]);
    expect(activeChecks(code)).toEqual([]);
    expect(commentedChecks(code)).toEqual([
      "expect(consoleErrors).not.toContainEqual(expect.stringContaining('Failed to save draft'));",
    ]);
    expect(code).not.toContain('Failed to load resource');
    expect(code).toContain(
      "if (message.type() === 'error') consoleErrors.push(message.text());",
    );
    expect(code).toContain('// No uncaught error or failing API call was recorded');
  });

  it('suggests an assertion when no error was recorded', () => {
    const code = repro([click(1000, button('Save'))]);
    expect(code).toContain('No uncaught error or failing API call was recorded');
    expect(code).toContain("// await expect(page.getByText('Saved')).toBeVisible();");
    expect(code).not.toContain('pageErrors');
    expect(code).not.toContain('waitForTimeout');
  });

  it('offers HAR replay only when the recorded bodies are complete', () => {
    const events = [
      click(1000, button('Load')),
      request(1100, 'GET', 'https://api.example.com/v1/items', {
        status: 200,
        responseBody: { present: true, text: '[]' },
      }),
    ];
    const full = repro(events, { level: 'L0', harPath: 'network.har' });
    expect(full).toContain("import path from 'node:path';");
    expect(full).toContain("if (process.env.REPRO_REPLAY_NETWORK === '1') {");
    expect(full).toContain(
      "const har = path.join(path.dirname(test.info().file), 'network.har');",
    );
    expect(full).toContain("await page.routeFromHAR(har, { notFound: 'fallback' });");
    expect(full).toContain('// Leave it unset when checking a backend fix');

    const standard = repro(events, { level: 'L1', harPath: 'network.har' });
    expect(standard).not.toContain('routeFromHAR');
    expect(header(standard)).toContain('network.har is not replayed');

    const cut = repro(
      [
        ...events,
        request(1200, 'GET', 'https://api.example.com/v1/big', {
          status: 200,
          responseBody: { present: true, text: '[', truncated: true },
        }),
      ],
      { level: 'L0', harPath: 'network.har' },
    );
    expect(cut).not.toContain('routeFromHAR');

    // A successful API response recorded without its body would replay empty.
    const missing = repro(
      [
        ...events,
        request(1300, 'GET', 'https://api.example.com/v1/profile', { status: 200 }),
      ],
      { level: 'L0', harPath: 'network.har' },
    );
    expect(missing).not.toContain('routeFromHAR');
    expect(header(missing)).toContain(
      'some responses were cut at capture or never captured',
    );
    expect(full).toContain('// requests it does not have still go to the server.');

    expect(repro(events)).not.toContain('network.har');
  });

  it('escapes recorded text into valid TypeScript', () => {
    const hostile = "it's a \\ back`slash ${x} */ line\nbreak \u2028 sep";
    const session = fixtureSession({ name: `Bug: ${hostile}` });
    const code = repro(
      [
        click(1000, button(hostile, { selector: `[data-testid="${hostile}"]` })),
        click(2000, { tag: 'div', text: hostile }),
        input(3000, { tag: 'input', name: hostile }, hostile),
        ev('note', 4000, { text: hostile }),
        ev('error', 5000, {
          message: `Uncaught Error: ${hostile}`,
          origin: 'exception',
        }),
      ],
      {},
      session,
    );
    expect(syntaxErrors(code)).toEqual([]);
    for (const line of code.split('\n')) {
      expect(line).not.toMatch(/[\u2028\u2029\r]/);
    }
    // The replay must type exactly what was recorded, not just valid code.
    const fill = steps(code).find((line) => line.includes('.fill('))!;
    const literal = fill.slice(
      fill.lastIndexOf('.fill(') + '.fill('.length,
      fill.lastIndexOf(');'),
    );
    expect(new Function(`return ${literal};`)()).toBe(hostile);
  });

  it('type-checks against the Playwright test API', () => {
    const { session, events } = buildSampleSession();
    const extra = [
      ev('key', 20_000, {
        key: 'Ctrl+K',
        modifiers: ['ctrl'],
        descriptor: { tag: 'input', name: 'q' },
      }),
      ev('hover', 21_000, { descriptor: button('Help'), dwellMs: 600 }),
      ev('scroll', 22_000, {
        from: { x: 0, y: 0 },
        to: { x: 0, y: 300 },
        container: 'div.list',
      }),
      input(23_000, { tag: 'select', name: 'country' }, 'de', { inputType: 'select' }),
      input(24_000, { tag: 'input', name: 'password' }, '«redacted»', {
        redacted: true,
      }),
      input(30_000, { tag: 'input', name: 'terms' }, 'on', { inputType: 'checkbox' }),
      ev('error', 31_000, { message: 'Failed to save', origin: 'console' }),
      nav(32_000, 'https://app.example.com/contacts', 'reload'),
    ];
    const code = repro(
      [...events, ...extra],
      { level: 'L0', harPath: 'network.har' },
      session,
    );
    expect(code).toContain('routeFromHAR');
    expect(typeErrors(code)).toEqual([]);
  }, 60_000);
});

describe('repro.spec.ts in the export bundle', () => {
  function file(files: ExportFile[], path: string): string | undefined {
    return files.find((f) => f.path === path)?.text;
  }

  it('is added next to the HAR and named in the report', async () => {
    const { session, events, assets } = buildSampleSession();
    const files = await buildBundle({ session, events, assets, level: 'L0' });
    const spec = file(files, 'repro.spec.ts');
    expect(spec).toContain("import { test, expect } from '@playwright/test';");
    expect(spec).toContain('routeFromHAR');
    expect(file(files, 'report.md')).toContain('`repro.spec.ts`');
  });

  it('follows the export level but keeps full locators', async () => {
    const { session, events, assets } = buildSampleSession();
    const files = await buildBundle({ session, events, assets, level: 'L3' });
    const spec = file(files, 'repro.spec.ts') ?? '';
    // L3 strips element details from the report, but the test still finds the field.
    expect(spec).toContain(
      "page.locator('input[name=\"file-name\"]').fill('contacts.csv')",
    );
    expect(header(spec)).not.toContain('Exported at L3');
    expect(spec).not.toContain('routeFromHAR');
  });

  it('is counted in the size estimate for the report', async () => {
    const { session, events, assets } = new SessionBuilder()
      .click('Save')
      .error('TypeError: draft is undefined')
      .build();
    const files = await buildBundle({ session, events, assets, level: 'L0' });
    const report = file(files, 'report.md') ?? '';
    expect(report).toContain('`repro.spec.ts`');
    // With no assets the estimate renders exactly the report the bundle writes.
    const [l0] = estimateForLevels(events, [], session);
    expect(l0?.approxBytes).toBe(new TextEncoder().encode(report).length);
  });

  it('is left out when the session has nothing to replay', async () => {
    const { session, events, assets } = new SessionBuilder()
      .net('GET', 'https://api.example.com/me')
      .build();
    const files = await buildBundle({ session, events, assets, level: 'L0' });
    expect(file(files, 'repro.spec.ts')).toBeUndefined();
    expect(file(files, 'report.md')).not.toContain('repro.spec.ts');
  });
});
