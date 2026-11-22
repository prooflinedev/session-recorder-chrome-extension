import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureSettings, NetRequestPayload, SessionEvent } from '@/lib/session/types';
import { ScreenshotScheduler } from './screenshots';

// The image pipeline decodes and hashes with browser APIs.
vi.mock('@/lib/util/hash', () => ({ averageHashFromBlob: async () => 'hash', hammingHex: () => 64 }));

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

describe('ScreenshotScheduler reset drops captures still in flight', () => {
  type Gate = { promise: Promise<void>; open: () => void };
  const gate = (): Gate => {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 10, height: 10, close() {} }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function scheduler(gates: { shot?: Gate; store?: Gate }) {
    const captureScreenshot = vi.fn(async () => {
      if (gates.shot) await gates.shot.promise;
      return { data: 'AAAA' };
    });
    const storeScreenshot = vi.fn(async () => {
      if (gates.store) await gates.store.promise;
      return { assetId: 'a1', size: 3 };
    });
    const emit = vi.fn();
    const s = new ScreenshotScheduler({ captureScreenshot, getSettings: () => SETTINGS, emit, storeScreenshot });
    return { s, storeScreenshot, emit };
  }

  it('stores and emits a capture when nothing resets it', async () => {
    const { s, storeScreenshot, emit } = scheduler({});
    await s.capture(3, 'manual');
    expect(storeScreenshot).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('a reset while the image is being taken drops it before it is stored', async () => {
    const shot = gate();
    const { s, storeScreenshot, emit } = scheduler({ shot });
    const done = s.capture(3, 'nav', 'Session start');
    await tick();
    s.reset();
    shot.open();
    await done;
    expect(storeScreenshot).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('a reset while the image is being stored keeps it from being emitted', async () => {
    const store = gate();
    const { s, storeScreenshot, emit } = scheduler({ store });
    const done = s.capture(3, 'manual');
    await vi.waitFor(() => expect(storeScreenshot).toHaveBeenCalledTimes(1));
    s.reset();
    store.open();
    await done;
    expect(emit).not.toHaveBeenCalled();
  });

  it('a capture started after a reset is kept', async () => {
    const { s, storeScreenshot, emit } = scheduler({});
    s.reset();
    await s.capture(3, 'manual');
    expect(storeScreenshot).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});