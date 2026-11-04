import { describe, expect, it } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import type { Asset, Session, SessionEvent, VerbosityLevel } from '@/lib/session/types';
import { buildBundle } from './bundle';

function recording(initialUrl = 'https://app.example.com/dashboard') {
  return new SessionBuilder({ name: 'Coupon bug', initialUrl })
    .click('Open cart')
    .input('coupon', 'SAVE10')
    .click('Apply')
    .net('POST', 'https://app.example.com/api/cart/coupon', { status: 500, mime: 'application/json' })
    .error('Uncaught TypeError: cannot read property total of undefined')
    .scroll()
    .file('invoice.pdf', 2400)
    .build();
}

const LEVELS: VerbosityLevel[] = ['L0', 'L1', 'L2', 'L3'];

/**
 * A settings export downloaded as a response body, then uploaded again: the two
 * assets have the same bytes, so the bundle stores them once at Full level.
 */
function reimport(): { session: Session; events: SessionEvent[]; assets: Asset[] } {
  const { session } = new SessionBuilder({ name: 'Re-import', initialUrl: 'https://app.example.com/' }).build();
  const json = '{"theme":"dark","beta":true}';
  const blob = () => new Blob([json], { type: 'application/json' });
  const base = { sessionId: session.id, importance: 1, tabId: session.tabs[0]!.tabId };
  const events = [
    {
      ...base,
      id: 'e1',
      t: 100,
      type: 'net-request',
      payload: {
        requestId: 'r1',
        method: 'GET',
        url: 'https://app.example.com/api/settings/export',
        status: 200,
        resourceType: 'Fetch',
        requestHeaders: [],
        responseHeaders: [],
        responseBody: { present: true, mime: 'application/json', text: json, assetId: 'body' },
      },
    },
    {
      ...base,
      id: 'e2',
      t: 2000,
      type: 'file-captured',
      payload: { assetId: 'file', fileName: 'settings.json', mime: 'application/json', size: json.length },
    },
    {
      ...base,
      id: 'e3',
      t: 2800,
      type: 'input',
      payload: {
        descriptor: { tag: 'input', id: 'import', selector: '#import' },
        value: 'C:\\fakepath\\settings.json',
        redacted: false,
        inputType: 'file',
      },
    },
    { ...base, id: 'e4', t: 2900, type: 'error', payload: { message: 'Error: import failed', origin: 'exception' } },
  ] as SessionEvent[];
  const assets: Asset[] = [
    { id: 'body', sessionId: session.id, kind: 'net-body', mime: 'application/json', size: json.length, sha256: 'same', blob: blob() },
    { id: 'file', sessionId: session.id, kind: 'file', mime: 'application/json', size: json.length, sha256: 'same', blob: blob() },
  ];
  return { session, events, assets };
}

describe('buildBundle repro test', () => {
  it('uploads a captured file from files/ at every level, even when its bytes are stored elsewhere', async () => {
    const { session, events, assets } = reimport();
    const specs = new Set<string>();
    for (const level of LEVELS) {
      const files = await buildBundle({ session, events, assets, level, includeReproTest: true });
      const spec = files.find((f) => f.path === 'repro.spec.ts')!.text!;
      specs.add(spec);
      expect(spec, level).toContain('"file": "files/settings.json"');
      expect(files.some((f) => f.path === 'files/settings.json'), level).toBe(true);
    }
    expect(specs.size).toBe(1);
  });

  it('adds repro.spec.ts when asked, with the same content at every level', async () => {
    const { session, events, assets } = recording();
    const specs: string[] = [];
    for (const level of LEVELS) {
      const files = await buildBundle({ session, events, assets, level, includeReproTest: true });
      const spec = files.find((f) => f.path === 'repro.spec.ts');
      expect(spec?.text, `repro.spec.ts at ${level}`).toBeTruthy();
      specs.push(spec!.text!);
      const report = files.find((f) => f.path === 'report.md')!.text!;
      expect(report).toContain('**Repro test:** `repro.spec.ts`');
      expect(report).toContain('## Repro test');
    }
    expect(new Set(specs).size).toBe(1);
    expect(specs[0]).toContain('"method": "POST"');
    expect(specs[0]).toContain('cannot read property total of undefined');
  });

  it('pins Playwright to the root test, so captured files never run as tests', async () => {
    const b = new SessionBuilder({ name: 'Planted', initialUrl: 'https://app.example.com/' })
      .click('Upload')
      .file('repro.spec.ts', 64)
      .error('Uncaught Error: x');
    const { session, events, assets } = b.build();
    const files = await buildBundle({ session, events, assets, level: 'L1', includeReproTest: true });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('repro.spec.ts');
    expect(paths).toContain('files/repro.spec.ts');
    const config = files.find((f) => f.path === 'playwright.config.mjs')?.text;
    expect(config).toContain('testMatch: new RegExp');
    expect(config).toContain("path.join(here, 'repro.spec.ts')");
    const report = files.find((f) => f.path === 'report.md')!.text!;
    expect(report).toContain('BASE_URL=http://localhost:3000 npx playwright test\n');
  });

  it('leaves the bundle unchanged when not asked', async () => {
    const { session, events, assets } = recording();
    const files = await buildBundle({ session, events, assets, level: 'L1' });
    expect(files.some((f) => f.path === 'repro.spec.ts')).toBe(false);
    expect(files.some((f) => f.path === 'playwright.config.mjs')).toBe(false);
    expect(files.find((f) => f.path === 'report.md')!.text).not.toContain('Repro test');
  });

  it('adds nothing for a session that did not start on a web page', async () => {
    const { session, events, assets } = recording('chrome://newtab/');
    const files = await buildBundle({ session, events, assets, level: 'L1', includeReproTest: true });
    expect(files.some((f) => f.path === 'repro.spec.ts')).toBe(false);
    expect(files.find((f) => f.path === 'report.md')!.text).not.toContain('Repro test');
  });
});
