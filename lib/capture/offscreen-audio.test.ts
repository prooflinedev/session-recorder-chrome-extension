import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The offscreen audio recorder (entrypoints/offscreen/main.ts), driven through
 * its real message listener with fake media APIs. Like the browser's, the fake
 * MediaRecorder becomes 'inactive' at stop() and delivers its data and `stop`
 * event asynchronously; segment delivery to the background can be held so a
 * test can tell whether a stop answered before its audio arrived.
 */

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};

const recs: FakeRec[] = [];
const sockets: FakeWS[] = [];
const delivered: { tStart: number; tEnd: number }[] = [];
const deliveryGates: Gate[] = [];
let holdDeliveries = false;
let listener: (msg: any, sender: any, respond: (r: any) => void) => boolean | void;

vi.mock('@/lib/messaging', () => ({
  sendMessage: async (m: any) => {
    if (m.kind !== 'audio/segment') return { ok: true };
    if (holdDeliveries) {
      const g = gate();
      deliveryGates.push(g);
      await g.promise;
    }
    delivered.push({ tStart: m.tStart, tEnd: m.tEnd });
    return { ok: true };
  },
}));
vi.mock('@/lib/storage', () => ({ putAsset: async () => {} }));

class FakeRec {
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    recs.push(this);
  }
  static isTypeSupported() {
    return true;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['audio']) });
      this.onstop?.();
    }, 5);
  }
}
class FakeWS {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: unknown = null;
  binaryType = '';
  constructor() {
    sockets.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}
class FakeAudioContext {
  state = 'running';
  sampleRate = 48000;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData() {} };
  }
  async close() {
    this.state = 'closed';
  }
}
class FakeWorklet {
  port: Record<string, unknown> = {};
  disconnect() {}
}
class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL() {
    setTimeout(() => {
      this.result = 'data:audio/webm;base64,AAAA';
      this.onload?.();
    }, 1);
  }
}

vi.stubGlobal('MediaRecorder', FakeRec);
vi.stubGlobal('WebSocket', FakeWS);
vi.stubGlobal('AudioContext', FakeAudioContext);
vi.stubGlobal('AudioWorkletNode', FakeWorklet);
vi.stubGlobal('FileReader', FakeFileReader);
vi.stubGlobal('navigator', {
  mediaDevices: {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{}] }),
  },
});
vi.stubGlobal('chrome', {
  runtime: {
    getURL: (p: string) => `chrome-extension://x/${p}`,
    onMessage: { addListener: (f: typeof listener) => (listener = f) },
  },
});

/** Send a message to the offscreen listener; track whether it has answered. */
function send(msg: Record<string, unknown>) {
  let answered = false;
  const reply = new Promise<unknown>((resolve) => {
    const isAsync = listener(msg, {}, (r: unknown) => {
      answered = true;
      resolve(r);
    });
    if (!isAsync && !answered) resolve(undefined);
  });
  return { reply, answered: () => answered };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await wait(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const recording = () => recs.filter((r) => r.state === 'recording').length;
const startBatch = () => send({ kind: 'audio/start', sessionId: 's', startedAt: Date.now(), transcription: null });

beforeEach(async () => {
  vi.resetModules();
  recs.length = 0;
  sockets.length = 0;
  delivered.length = 0;
  deliveryGates.length = 0;
  holdDeliveries = false;
  await import('@/entrypoints/offscreen/main');
});

describe('offscreen audio: stops', () => {
  it('overlapping stops share one teardown: both answer, after the final segment is delivered', async () => {
    expect(await startBatch().reply).toMatchObject({ ok: true });
    holdDeliveries = true;
    const first = send({ kind: 'audio/stop' }); // e.g. Stop's teardown
    await wait(0);
    const second = send({ kind: 'audio/stop' }); // e.g. a late start's own cleanup
    await until(() => deliveryGates.length === 1, 'the final segment');
    await wait(20);
    // Neither answers while the final segment is still being delivered...
    expect(first.answered()).toBe(false);
    expect(second.answered()).toBe(false);
    deliveryGates[0]!.open();
    // ...and both answer once it has been.
    await expect(first.reply).resolves.toEqual({ ok: true });
    await expect(second.reply).resolves.toEqual({ ok: true });
    expect(delivered).toHaveLength(1);
    expect(recording()).toBe(0);
  });

  it('a stop during a segment rotation answers only after the rotated and final segments are delivered', async () => {
    expect(await startBatch().reply).toMatchObject({ ok: true });
    holdDeliveries = true;
    send({ kind: 'audio/dictation', on: true }); // rotates the segment (same path as the cadence timer)
    const stop = send({ kind: 'audio/stop' });
    await until(() => deliveryGates.length === 1, 'the rotated segment');
    await wait(20);
    expect(stop.answered()).toBe(false);
    deliveryGates[0]!.open(); // rotated segment delivered; the recorder restarted
    await until(() => deliveryGates.length === 2, 'the final segment');
    await wait(20);
    expect(stop.answered()).toBe(false);
    deliveryGates[1]!.open();
    await expect(stop.reply).resolves.toEqual({ ok: true });
    expect(delivered).toHaveLength(2);
    expect(recording()).toBe(0);
  });

  it('a stop right after Pause answers only after the pause segment is delivered', async () => {
    expect(await startBatch().reply).toMatchObject({ ok: true });
    holdDeliveries = true;
    send({ kind: 'audio/pause' });
    const stop = send({ kind: 'audio/stop' });
    await until(() => deliveryGates.length === 1, 'the pause segment');
    await wait(20);
    expect(stop.answered()).toBe(false);
    deliveryGates[0]!.open();
    await expect(stop.reply).resolves.toEqual({ ok: true });
    expect(delivered).toHaveLength(1);
    expect(recording()).toBe(0);
  });

  it('a normal stop still delivers the final segment and answers', async () => {
    expect(await startBatch().reply).toMatchObject({ ok: true });
    await expect(send({ kind: 'audio/stop' }).reply).resolves.toEqual({ ok: true });
    expect(delivered).toHaveLength(1);
    expect(recording()).toBe(0);
  });
});

describe('offscreen audio: a start still connecting its live stream', () => {
  const startStreaming = () =>
    send({
      kind: 'audio/start',
      sessionId: 's',
      startedAt: Date.now(),
      transcription: { provider: 'deepgram', apiKey: 'k', managed: false },
    });

  it('a Pause while connecting: nothing records until Resume, which starts exactly one recorder', async () => {
    const started = startStreaming();
    await until(() => sockets.length === 1, 'the live socket');
    send({ kind: 'audio/pause' });
    sockets[0]!.open();
    expect(await started.reply).toMatchObject({ ok: true, streaming: true });
    send({ kind: 'audio/pause' }); // the background re-pauses a start that completed while paused
    await wait(20);
    expect(recording()).toBe(0);

    send({ kind: 'audio/resume' });
    await wait(5);
    expect(recs).toHaveLength(1);
    expect(recording()).toBe(1);
  });

  it('overlapping stops with live transcription both answer when Deepgram finalizes, not on the timeout', async () => {
    const started = startStreaming();
    await until(() => sockets.length === 1, 'the live socket');
    sockets[0]!.open();
    expect(await started.reply).toMatchObject({ ok: true, streaming: true });
    const first = send({ kind: 'audio/stop' }); // sends Finalize and waits for the last transcript
    await wait(0);
    const second = send({ kind: 'audio/stop' });
    await wait(5);
    const final = {
      type: 'Results',
      is_final: true,
      start: 0,
      duration: 1,
      channel: { alternatives: [{ transcript: 'last words', words: [] }] },
    };
    (sockets[0]!.onmessage as (ev: { data: string }) => void)({ data: JSON.stringify(final) });
    await wait(200); // well under the 1500 ms Finalize timeout
    expect(first.answered()).toBe(true);
    expect(second.answered()).toBe(true);
  });

  it('a start that is not paused still records once connected', async () => {
    const started = startStreaming();
    await until(() => sockets.length === 1, 'the live socket');
    sockets[0]!.open();
    expect(await started.reply).toMatchObject({ ok: true, streaming: true });
    expect(recording()).toBe(1);
  });
});
