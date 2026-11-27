/** Unit tests for capture-detail presets and slider index mapping. */
import { describe, it, expect } from 'vitest';
import {
  CAPTURE_DETAIL_LEVELS,
  DEFAULT_SETTINGS,
  detailIndexFromSettings,
  normalizeCaptureSettings,
  settingsForDetail,
} from './settings';
import type { CaptureSettings } from './types';

describe('CAPTURE_DETAIL_LEVELS body caps', () => {
  it('scale monotonically from Minimal to Maximum, inline <= asset per level', () => {
    for (let i = 0; i < CAPTURE_DETAIL_LEVELS.length; i++) {
      const level = CAPTURE_DETAIL_LEVELS[i]!;
      expect(level.inlineBodyCapBytes).toBeLessThanOrEqual(level.assetBodyCapBytes);
      const prev = CAPTURE_DETAIL_LEVELS[i - 1];
      if (prev) {
        expect(level.inlineBodyCapBytes).toBeGreaterThanOrEqual(prev.inlineBodyCapBytes);
        expect(level.assetBodyCapBytes).toBeGreaterThanOrEqual(prev.assetBodyCapBytes);
      }
    }
  });

  it('Maximum is much larger than the defaults, Minimal smaller', () => {
    const max = CAPTURE_DETAIL_LEVELS[CAPTURE_DETAIL_LEVELS.length - 1]!;
    const min = CAPTURE_DETAIL_LEVELS[0]!;
    expect(max.inlineBodyCapBytes).toBeGreaterThanOrEqual(2 * DEFAULT_SETTINGS.inlineBodyCapBytes);
    expect(max.assetBodyCapBytes).toBeGreaterThanOrEqual(2 * DEFAULT_SETTINGS.assetBodyCapBytes);
    expect(min.inlineBodyCapBytes).toBeLessThan(DEFAULT_SETTINGS.inlineBodyCapBytes);
    expect(min.assetBodyCapBytes).toBeLessThan(DEFAULT_SETTINGS.assetBodyCapBytes);
  });

  it('Detailed mirrors DEFAULT_SETTINGS so stock settings restore the slider', () => {
    const detailed = CAPTURE_DETAIL_LEVELS[2]!;
    expect(detailed.label).toBe('Detailed');
    expect(detailed.inlineBodyCapBytes).toBe(DEFAULT_SETTINGS.inlineBodyCapBytes);
    expect(detailed.assetBodyCapBytes).toBe(DEFAULT_SETTINGS.assetBodyCapBytes);
    expect(detailIndexFromSettings(DEFAULT_SETTINGS)).toBe(2);
  });
});

describe('settingsForDetail', () => {
  it('returns exactly the knob-controlled fields', () => {
    const overrides = settingsForDetail(2);
    expect(Object.keys(overrides ?? {}).sort()).toEqual([
      'assetBodyCapBytes',
      'hoverDwellMs',
      'inlineBodyCapBytes',
      'screenshotPolicy',
    ]);
  });

  it('clamps out-of-range indices to the nearest preset', () => {
    const first = CAPTURE_DETAIL_LEVELS[0]!;
    const last = CAPTURE_DETAIL_LEVELS[CAPTURE_DETAIL_LEVELS.length - 1]!;
    expect(settingsForDetail(-1)).toEqual({
      screenshotPolicy: first.screenshotPolicy,
      hoverDwellMs: first.hoverDwellMs,
      inlineBodyCapBytes: first.inlineBodyCapBytes,
      assetBodyCapBytes: first.assetBodyCapBytes,
    });
    expect(settingsForDetail(99)).toEqual({
      screenshotPolicy: last.screenshotPolicy,
      hoverDwellMs: last.hoverDwellMs,
      inlineBodyCapBytes: last.inlineBodyCapBytes,
      assetBodyCapBytes: last.assetBodyCapBytes,
    });
  });
});

describe('detailIndexFromSettings', () => {
  it('round-trips every preset applied over the defaults', () => {
    for (let i = 0; i < CAPTURE_DETAIL_LEVELS.length; i++) {
      const s: CaptureSettings = { ...DEFAULT_SETTINGS, ...settingsForDetail(i) };
      expect(detailIndexFromSettings(s)).toBe(i);
    }
  });

  it('keeps the slider position when body caps were hand-tuned', () => {
    const s: CaptureSettings = {
      ...DEFAULT_SETTINGS,
      ...settingsForDetail(3),
      inlineBodyCapBytes: 12345,
    };
    expect(detailIndexFromSettings(s)).toBe(3);
  });

  it('falls back by screenshot policy for unrecognized hover dwell values', () => {
    const base: CaptureSettings = { ...DEFAULT_SETTINGS, hoverDwellMs: 999 };
    expect(detailIndexFromSettings({ ...base, screenshotPolicy: 'on-demand' })).toBe(0);
    expect(detailIndexFromSettings({ ...base, screenshotPolicy: 'key-moments' })).toBe(1);
    expect(detailIndexFromSettings({ ...base, screenshotPolicy: 'every-interaction' })).toBe(2);
  });
});

describe('cursor effect settings and backward compatibility', () => {
  it('disables cursor spotlight and click highlight by default', () => {
    expect(DEFAULT_SETTINGS.cursorSpotlight).toBe(false);
    expect(DEFAULT_SETTINGS.clickHighlight).toBe(false);
  });

  it('normalizes legacy stored settings missing cursor effect fields', () => {
    const legacy = {
      screenshotPolicy: 'key-moments',
      redactionEnabled: false,
    } as Partial<CaptureSettings>;
    const normalized = normalizeCaptureSettings(legacy);
    expect(normalized.screenshotPolicy).toBe('key-moments');
    expect(normalized.redactionEnabled).toBe(false);
    expect(normalized.cursorSpotlight).toBe(false);
    expect(normalized.clickHighlight).toBe(false);
  });

  it('coerces non-boolean cursor effect values safely and preserves independent toggles', () => {
    const malformed = {
      cursorSpotlight: 'yes' as unknown as boolean,
      clickHighlight: 1 as unknown as boolean,
    };
    expect(normalizeCaptureSettings(malformed)).toMatchObject({
      cursorSpotlight: false,
      clickHighlight: false,
    });

    const spotlightOnly = normalizeCaptureSettings({ cursorSpotlight: true });
    expect(spotlightOnly.cursorSpotlight).toBe(true);
    expect(spotlightOnly.clickHighlight).toBe(false);

    const clicksOnly = normalizeCaptureSettings({ clickHighlight: true });
    expect(clicksOnly.cursorSpotlight).toBe(false);
    expect(clicksOnly.clickHighlight).toBe(true);
  });

  it('keeps capture-detail presets independent of cursor effect toggles', () => {
    const overrides = settingsForDetail(0) ?? {};
    expect(overrides).not.toHaveProperty('cursorSpotlight');
    expect(overrides).not.toHaveProperty('clickHighlight');
    const merged: CaptureSettings = {
      ...normalizeCaptureSettings({ cursorSpotlight: true, clickHighlight: true }),
      ...overrides,
    };
    expect(merged.cursorSpotlight).toBe(true);
    expect(merged.clickHighlight).toBe(true);
    expect(detailIndexFromSettings(merged)).toBe(0);
  });
});
