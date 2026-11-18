import { describe, expect, it, vi } from 'vitest';
import type { CaptureSettings, NetRequestPayload, SessionEvent } from '@/lib/session/types';
import { ScreenshotScheduler } from './screenshots';

const SETTINGS: CaptureSettings = {
  screenshotPolicy: 'key-moments',
  inlineBodyCapBytes: 64 * 1024,
  assetBodyCapBytes: 512 * 1024,
  fileCapBytes: 1024 * 1024,
  redactionEnabled: true,
  customRedaction: { headerNames: [], bodyKeyPatterns: [], urlParamPatterns: [] },
  filterTelemetry: true,
  hoverDwellMs: 0,
  screenshotQuality: 70,
  screenshotDedupThreshold: 4,
  captureApiSpec: false,
};

function netEvent(extra: Partial<NetRequestPayload>): SessionEvent {
  return {
    id: 'evt_1',
    sessionId: 'sess_1',
    t: 1000,
    tabId: 3,
    type: 'net-request',
    importance: 50,
    payload: {
      requestId: 'req_1',
      method: 'GET',
      url: 'https://api.example.com/export',
      requestHeaders: [],
      responseHeaders: [],
      ...extra,
    },
  } as SessionEvent;
}

describe('ScreenshotScheduler key moments', () => {
  function scheduler() {
    // Rejecting keeps the test off the image pipeline; failures are swallowed.
    const captureScreenshot = vi.fn(async () => {
      throw new Error('not attached');
    });
    const s = new ScreenshotScheduler({
      captureScreenshot,
      getSettings: () => SETTINGS,
      emit: vi.fn(),
      storeScreenshot: vi.fn(async () => ({ assetId: 'a', size: 1 })),
    });
    return { s, captureScreenshot };
  }

  it('captures on a finished error response', () => {
    const { s, captureScreenshot } = scheduler();
    s.onEvent(netEvent({ status: 500 }));
    expect(captureScreenshot).toHaveBeenCalledWith(3, 70);
  });

  it('does not capture on a pending request flushed at stop', () => {
    const { s, captureScreenshot } = scheduler();
    s.onEvent(netEvent({ status: 500, pending: true }));
    s.onEvent(netEvent({ pending: true }));
    expect(captureScreenshot).not.toHaveBeenCalled();
  });
});
