import { describe, expect, it } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import type { VerbosityLevel } from '@/lib/session/types';
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

describe('buildBundle repro test', () => {
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
    expect(config).toContain("testMatch: 'repro.spec.ts'");
    expect(config).toContain("'files/**'");
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
