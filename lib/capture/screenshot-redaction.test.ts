import { describe, expect, it } from 'vitest';
import { normalizeRedactionRect, screenshotRevision, validateRedactionRect } from './screenshot-redaction';
import type { Asset, RedactionRect } from '@/lib/session/types';

describe('screenshot redaction geometry', () => {
  it('normalizes reverse-direction drags and clips them to image bounds', () => {
    expect(normalizeRedactionRect(90, 80, -5, 20, 100, 100)).toEqual({
      x: 0,
      y: 0.2,
      width: 0.9,
      height: 0.6,
    });
  });

  it('ignores zero-area or invalid image coordinates', () => {
    expect(normalizeRedactionRect(2, 2, 2, 8, 100, 100)).toBeUndefined();
    expect(normalizeRedactionRect(1, 1, 10, 10, 0, 100)).toBeUndefined();
    expect(normalizeRedactionRect(Number.NaN, 1, 10, 10, 100, 100)).toBeUndefined();
  });

  it('rejects malformed saved rectangles', () => {
    const invalid: RedactionRect[] = [
      { x: -0.01, y: 0, width: 0.1, height: 0.1 },
      { x: 0.8, y: 0, width: 0.3, height: 0.1 },
      { x: 0, y: 0, width: 0, height: 0.1 },
      { x: Number.NaN, y: 0, width: 0.1, height: 0.1 },
    ];
    for (const rect of invalid) expect(() => validateRedactionRect(rect)).toThrow();
  });
});

describe('screenshot revision', () => {
  it('is stable, ignores untouched assets, and changes even when all masks are cleared', () => {
    const asset = (id: string, revision?: number): Asset => ({
      id,
      sessionId: 'session',
      kind: 'screenshot',
      mime: 'image/jpeg',
      size: 1,
      blob: new Blob(['original'], { type: 'image/jpeg' }),
      ...(revision === undefined ? {} : { localScreenshotRedaction: { rectangles: [], revision } }),
    });
    expect(screenshotRevision([asset('b'), asset('a')])).toBe('');
    expect(screenshotRevision([asset('b', 2), asset('a', 1)])).toBe('a:1|b:2');
    expect(screenshotRevision([asset('a', 3), asset('b', 2)])).not.toBe('a:1|b:2');
  });
});
