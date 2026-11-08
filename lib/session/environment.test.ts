import { describe, expect, it } from 'vitest';
import { browserName, describeEnvironment } from './environment';

describe('browserName', () => {
  it('reports the product, not the engine or the placeholder brand', () => {
    expect(
      browserName([
        { brand: 'Not)A;Brand', version: '8.0.0.0' },
        { brand: 'Chromium', version: '142.0.7444.59' },
        { brand: 'Google Chrome', version: '142.0.7444.59' },
      ]),
    ).toBe('Google Chrome 142.0.7444.59');
    expect(
      browserName([
        { brand: 'Microsoft Edge', version: '142.0.3595.53' },
        { brand: 'Not_A Brand', version: '99.0.0.0' },
        { brand: 'Chromium', version: '142.0.7444.59' },
      ]),
    ).toBe('Microsoft Edge 142.0.3595.53');
  });

  it('falls back to Chromium, then to nothing', () => {
    expect(
      browserName([
        { brand: 'Not/A)Brand', version: '8' },
        { brand: 'Chromium', version: '142' },
      ]),
    ).toBe('Chromium 142');
    expect(browserName([{ brand: 'Not A(Brand', version: '99' }])).toBeUndefined();
    expect(browserName([])).toBeUndefined();
  });
});

describe('describeEnvironment', () => {
  it('joins the known fields on one line', () => {
    expect(
      describeEnvironment({
        browser: 'Google Chrome 142.0.7444.59',
        os: 'Windows 15.0.0 x86',
        viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
        locale: 'en-US',
        timeZone: 'Europe/Paris',
      }),
    ).toBe(
      'Google Chrome 142.0.7444.59 · Windows 15.0.0 x86 · viewport 1440×900 @2x · en-US · Europe/Paris',
    );
  });

  it('leaves out what could not be read', () => {
    expect(describeEnvironment({ locale: 'fr-FR', timeZone: 'Europe/Paris' })).toBe(
      'fr-FR · Europe/Paris',
    );
    expect(describeEnvironment({})).toBe('');
  });
});
