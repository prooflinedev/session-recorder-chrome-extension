import { decodePcm16 } from '@/lib/transcription/pcm';
import { elevenLabsLiveUrl, elevenLabsAudioMessage, parseElevenLabsMessage } from '@/lib/transcription/elevenlabs-live';
import { normalizeKeyterms } from '@/lib/transcription/keyterms';
/**
 * Offscreen media recorder (microphone audio + tab video).
 *
 * MV3 service workers cannot call `getUserMedia`/`MediaRecorder`, so all media
 * capture lives here. The background drives this document with `audio/start`,
 * `audio/pause`, `audio/resume`, `audio/stop` control messages; this module
 * cuts the microphone stream into complete 30-second WebM/Opus segments
 * (also on pause and stop) and streams them back as `audio/segment` messages
 * (Blob -> data URL, since Blobs can't cross runtime messaging). A parallel
 * AnalyserNode posts throttled `audio/level` RMS updates for the live meter.
 * Tab video capture lives in `./video` and is driven by the `video/*` control
 * messages dispatched at the bottom of this file.
 */
import { sendMessage } from '@/lib/messaging';
import type { RequestMessage, StreamTranscriptionConfig } from '@/lib/messaging';
import {
  handleVideoPause,
  handleVideoResume,
  handleVideoStart,
  handleVideoStop,
} from './video';
import {
  buildDeepgramLiveUrl,
  deepgramSubprotocols,
  parseDeepgramMessage,
  DEEPGRAM_CLOSE_MESSAGE,
  DEEPGRAM_SAMPLE_RATE,
} from '@/lib/transcription/deepgram-live';

const MIME_PREFERRED = 'audio/webm;codecs=opus';
const SEGMENT_MS = 30_000;
/** Managed transcription cuts short segments so narration appears promptly. */
const MANAGED_SEGMENT_MS = 5_000;
/** Cadence while a comment composer waits for dictated text. */
const DICTATION_SEGMENT_MS = 3_000;
const LEVEL_INTERVAL_MS = 100; // ~10 posts/sec

type RecState = 'idle' | 'recording' | 'paused';
type StopReason = 'segment' | 'pause' | 'stop';

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;

let chunks: Blob[] = [];
let sessionId = '';
let mimeType = MIME_PREFERRED;

/** performance.now() captured at audio start, for monotonic elapsed time. */
let perfStart = 0;
/** ms offset from the session's `startedAt` to audio start, so segment
 *  timestamps are expressed relative to `startedAt`. */
let baseOffset = 0;
/** Start-of-current-segment timestamp (ms relative to `startedAt`). */
let segStart = 0;

let state: RecState = 'idle';
let stopReason: StopReason | null = null;
let segmentTimer: ReturnType<typeof setInterval> | null = null;
/** Segment cadence for narration; dictation uses DICTATION_SEGMENT_MS. */
let narrationSegmentMs = SEGMENT_MS;
let dictating = false;
let levelTimer: ReturnType<typeof setInterval> | null = null;

// --- live streaming transcription (Deepgram) ---
let streamSocket: WebSocket | null = null;
let streamNode: AudioWorkletNode | ScriptProcessorNode | null = null;
let streamProvider = '';
let streaming = false;
let liveConfig: StreamTranscriptionConfig | undefined;
let pendingKeyterms: string[] | undefined;
let changingStream = false;
let pendingPcm: ArrayBuffer[] = [];
let bufferedBytes = 0;
let flushingStream = false;
let finishStreamFlush: (() => void) | undefined;

/** ms elapsed relative to the session's `startedAt`. */
function elapsed(): number {
  return Math.max(0, Math.round(baseOffset + (performance.now() - perfStart)));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function emitSegment(blob: Blob, tStart: number, tEnd: number): Promise<void> {
  if (blob.size === 0) return;
  try {
    const dataUrl = await blobToDataUrl(blob);
    await sendMessage({
      kind: 'audio/segment',
      sessionId,
      tStart,
      tEnd,
      dataUrl,
      mime: mimeType,
    });
  } catch {
    /* background not listening (e.g. session torn down) — drop it */
  }
}

function startRecorder(): void {
  if (!stream) return;
  chunks = [];
  const rec = new MediaRecorder(stream, { mimeType });
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  rec.onstop = handleStop;
  recorder = rec;
  segStart = elapsed();
  rec.start(); // no timeslice: a single dataavailable with the whole segment
}

/**
 * Fires when a MediaRecorder stops (segment rotation, pause, or full stop).
 * Assembles the collected chunks into one complete WebM Blob, emits it, then
 * either restarts for the next segment or tears down.
 */
async function handleStop(): Promise<void> {
  const blob = new Blob(chunks, { type: mimeType });
  const tStart = segStart;
  const tEnd = elapsed();
  const reason = stopReason;
  stopReason = null;
  chunks = [];

  // Await delivery so a full stop only completes after the final segment has
  // actually been handed to the background (it tears this document down as soon
  // as we resolve, which would otherwise kill an in-flight segment).
  await emitSegment(blob, tStart, tEnd);

  if (reason === 'segment') {
    if (state === 'recording') startRecorder();
  } else if (reason === 'stop') {
    teardown();
    const resolve = stopFlushResolve;
    stopFlushResolve = null;
    if (resolve) resolve();
  }
  // 'pause': stay stopped; recorder is left inactive until resume.
}

/** Resolves the pending full-stop once its final segment has been delivered. */
let stopFlushResolve: (() => void) | null = null;

/** Restart the batch rotation timer at the cadence the current mode needs. */
function scheduleRotation(): void {
  if (segmentTimer !== null) clearInterval(segmentTimer);
  segmentTimer = setInterval(rotateSegment, dictating ? DICTATION_SEGMENT_MS : narrationSegmentMs);
}

/**
 * A comment composer opened or closed. In batch mode, end the current segment
 * at this boundary so dictated speech and narration land in separate segments,
 * then switch cadence. Streaming transcripts are already split by utterance.
 */
function handleDictation(on: boolean): void {
  if (dictating === on) return;
  dictating = on;
  if (streaming || state === 'idle' || segmentTimer === null) return;
  rotateSegment();
  scheduleRotation();
}

/** Rotate to a fresh segment on the current cadence. */
function rotateSegment(): void {
  if (state !== 'recording') return;
  if (!recorder || recorder.state !== 'recording') return;
  stopReason = 'segment';
  recorder.stop();
}

function startLevelLoop(): void {
  if (!analyser || levelTimer !== null) return;
  const buf = new Float32Array(analyser.fftSize);
  levelTimer = setInterval(() => {
    if (state !== 'recording' || !analyser) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const level = Math.min(1, Math.max(0, rms));
    void sendMessage({ kind: 'audio/level', level }).catch(() => {
      /* no listener — ignore */
    });
  }, LEVEL_INTERVAL_MS);
}

function stopLevelLoop(): void {
  if (levelTimer !== null) {
    clearInterval(levelTimer);
    levelTimer = null;
  }
}

function teardown(): void {
  if (segmentTimer !== null) {
    clearInterval(segmentTimer);
    segmentTimer = null;
  }
  stopStreaming();
  stopLevelLoop();

  if (recorder && recorder.state !== 'inactive') {
    try {
      recorder.stop();
    } catch {
      /* already stopping */
    }
  }
  recorder = null;

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {
      /* noop */
    }
    sourceNode = null;
  }
  analyser = null;

  if (audioCtx && audioCtx.state !== 'closed') {
    void audioCtx.close().catch(() => {
      /* noop */
    });
  }
  audioCtx = null;

  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  chunks = [];
  stopReason = null;
  state = 'idle';
}

/**
 * Open a Deepgram live stream and pipe linear16 PCM as the user speaks.
 * Interim results feed the ticker; final results become real-time voice-segment
 * events with word-level timings. Best-effort: any failure leaves `streaming`
 * false and the caller falls back to batch segments. Returns true if wired up.
 */
async function startStreaming(
  config: StreamTranscriptionConfig,
): Promise<boolean> {
  if (!stream || !audioCtx) return false;
  try {
    const isEleven = config.provider === 'elevenlabs';
    let streamOffset = elapsed();
    let elevenSegmentStart: number | undefined;
    const url = isEleven ? await elevenLabsLiveUrl(config) : buildDeepgramLiveUrl(config, {
      sampleRate: DEEPGRAM_SAMPLE_RATE,
      interim: true,
    });
    const sock = isEleven ? new WebSocket(url) : new WebSocket(url, deepgramSubprotocols(config.apiKey));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { sock.close(); reject(new Error('Dictation connection timed out.')); }, 8000);
      sock.onopen = () => { clearTimeout(timer); resolve(); };
      sock.onerror = () => { clearTimeout(timer); reject(new Error('Dictation could not connect.')); };
    });
    if (state === 'idle') { sock.close(); return false; }
    streamOffset = Math.max(0, elapsed() - Math.round(bufferedBytes / 32));
    sock.binaryType = 'arraybuffer';
    const inRate = audioCtx.sampleRate;

    const pushPcm = (input: Float32Array) => {
      if (state !== 'recording' || flushingStream) return;
      const pcm = downsampleToPcm16(input, inRate, DEEPGRAM_SAMPLE_RATE);
      if (!pcm.byteLength) return;
      if (changingStream || sock.readyState !== WebSocket.OPEN) {
        if (bufferedBytes < 256000) { pendingPcm.push(pcm); bufferedBytes += pcm.byteLength; }
        return;
      }
      for (const buffered of pendingPcm) sock.send(isEleven ? elevenLabsAudioMessage(buffered) : buffered);
      pendingPcm = []; bufferedBytes = 0;
      sock.send(isEleven ? elevenLabsAudioMessage(pcm) : pcm);
    };

    // PCM tap: AudioWorklet (batched Float32 posts from public/pcm-tap.worklet.js),
    // falling back to the deprecated ScriptProcessorNode if the module fails to
    // load. The context is created fresh per capture, so addModule runs once each.
    let node: AudioWorkletNode | ScriptProcessorNode;
    try {
      await audioCtx.audioWorklet.addModule(
        chrome.runtime.getURL('pcm-tap.worklet.js'),
      );
      const worklet = new AudioWorkletNode(audioCtx, 'pcm-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
        pushPcm(e.data);
      };
      sourceNode?.connect(worklet);
      node = worklet;
    } catch {
      const sp = audioCtx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => {
        pushPcm(e.inputBuffer.getChannelData(0));
      };
      sourceNode?.connect(sp);
      sp.connect(audioCtx.destination);
      node = sp;
    }

    sock.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const now = (elapsed() - streamOffset) / 1000;
      const p = isEleven ? parseElevenLabsMessage(ev.data, elevenSegmentStart ?? now, now) : parseDeepgramMessage(ev.data);
      if (isEleven && p.kind !== 'other' && elevenSegmentStart === undefined) elevenSegmentStart = p.start;
      if (p.kind === 'other') {
        if (isEleven && ev.data.includes('"committed_transcript"')) {
          finishStreamFlush?.();
          if (pendingKeyterms && !flushingStream) void refreshElevenVocabulary();
        }
        return;
      }
      if (p.kind === 'interim') {
        void sendMessage({ kind: 'transcript/interim', sessionId, text: p.text, tStart: Math.round(streamOffset + p.start * 1000) }).catch(
          () => {},
        );
        return;
      }
      // final
      const tStart = Math.round(streamOffset + p.start * 1000);
      const tEnd = Math.round(streamOffset + (p.start + p.duration) * 1000);
      const words = p.words.map((w) => ({
        word: w.word,
        t: Math.round(streamOffset + w.t * 1000),
      }));
      void sendMessage({
        kind: 'transcript/final',
        sessionId,
        tStart,
        tEnd,
        text: p.text,
        words,
        provider: config.provider,
      }).catch(() => {});
      finishStreamFlush?.();
      if (isEleven) elevenSegmentStart = undefined;
      if (pendingKeyterms && isEleven && !flushingStream) void refreshElevenVocabulary();
    };
    sock.onerror = () => {
      // Keep recording audio; the open composer shows that dictation stopped.
      void sendMessage({ kind: 'transcript/error', sessionId, error: 'Live transcription disconnected.' }).catch(() => {});
    };

    streamSocket = sock;
    liveConfig = config;
    streamNode = node;
    streamProvider = config.provider;
    streaming = true;
    return true;
  } catch {
    streaming = false;
    return false;
  }
}

async function refreshElevenVocabulary(): Promise<void> {
  if (changingStream || flushingStream || !liveConfig || !pendingKeyterms || state !== 'recording') return;
  changingStream = true;
  const config = { ...liveConfig, keyterms: pendingKeyterms };
  pendingKeyterms = undefined;
  const oldSocket = streamSocket;
  const oldNode = streamNode;
  const success = await startStreaming(config);
  if (success) { oldNode?.disconnect(); oldSocket?.close(); }
  else streaming = oldSocket?.readyState === WebSocket.OPEN;
  changingStream = false;
}
function updateKeyterms(terms: string[]): void {
  if (!liveConfig) return;
  const keyterms = normalizeKeyterms(terms);
  if (JSON.stringify(keyterms) === JSON.stringify(liveConfig.keyterms ?? [])) return;
  if (streamProvider === 'deepgram' && (liveConfig.model || 'nova-3').startsWith('nova-3')) {
    liveConfig = { ...liveConfig, keyterms };
    if (streamSocket?.readyState === WebSocket.OPEN) streamSocket.send(JSON.stringify({ type: 'Configure', keyterms }));
  } else if (streamProvider === 'elevenlabs') {
    // Install the new dictionary at the next completed utterance. Audio capture
    // continues and PCM is buffered while the replacement socket connects.
    pendingKeyterms = keyterms;
    if (streamSocket?.readyState === WebSocket.OPEN) streamSocket.send(elevenLabsAudioMessage(new ArrayBuffer(0), true));
  }
}

function stopStreaming(): void {
  try {
    if (streamSocket && streamSocket.readyState === WebSocket.OPEN) {
      streamSocket.send(streamProvider === 'elevenlabs' ? elevenLabsAudioMessage(new ArrayBuffer(0), true) : DEEPGRAM_CLOSE_MESSAGE);
    }
  } catch {
    /* ignore */
  }
  try {
    streamNode?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    streamSocket?.close();
  } catch {
    /* ignore */
  }
  streamNode = null;
  streamSocket = null;
  streaming = false;
  liveConfig = undefined; pendingKeyterms = undefined;
  pendingPcm = []; bufferedBytes = 0; changingStream = false;
  finishStreamFlush?.(); flushingStream = false;
}

/** Linear-resample a Float32 mono buffer to 16-bit PCM at `outRate`. */
function downsampleToPcm16(
  input: Float32Array,
  inRate: number,
  outRate: number,
): ArrayBuffer {
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const s = input[Math.floor(i * ratio)] ?? 0;
    const clamped = Math.max(-1, Math.min(1, s));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out.buffer;
}

async function handleStart(
  id: string,
  startedAt: number,
  transcription?: StreamTranscriptionConfig | null,
  dictation = false,
): Promise<{ ok: boolean; error?: string; streaming?: boolean }> {
  // A start while already active replaces the prior recording cleanly.
  if (state !== 'idle') teardown();

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    stream = null;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  sessionId = id;
  mimeType = MediaRecorder.isTypeSupported(MIME_PREFERRED)
    ? MIME_PREFERRED
    : 'audio/webm';
  perfStart = performance.now();
  baseOffset = Math.max(0, Date.now() - startedAt);
  state = 'recording';

  // Level metering pipeline.
  try {
    audioCtx = new AudioContext();
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    sourceNode.connect(analyser);
    startLevelLoop();
  } catch {
    /* metering is best-effort; recording continues without it */
  }

  // Real-time streaming transcription (Deepgram). If it wires up, we record the
  // audio as ONE continuous file (no 30s rotation) since transcripts are already
  // persisted live; otherwise we keep the rotating-segment batch path.
  streaming = false;
  if (transcription && !transcription.managed && ['deepgram', 'elevenlabs'].includes(transcription.provider) && transcription.apiKey) {
    streaming = await startStreaming(transcription);
  }

  startRecorder();
  dictating = dictation;
  if (!streaming) {
    narrationSegmentMs = transcription?.managed ? MANAGED_SEGMENT_MS : SEGMENT_MS;
    scheduleRotation();
  }
  return { ok: true, streaming };
}

function handlePause(): void {
  if (state !== 'recording') return;
  state = 'paused';
  stopLevelLoop();
  if (recorder && recorder.state === 'recording') {
    stopReason = 'pause';
    recorder.stop();
  }
}

function handleResume(): void {
  if (state !== 'paused' || !stream) return;
  state = 'recording';
  startRecorder();
  startLevelLoop();
}

async function handleStopControl(): Promise<void> {
  if (streamSocket?.readyState === WebSocket.OPEN) {
    flushingStream = true;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); finishStreamFlush = undefined; resolve(); };
      const timer = setTimeout(finish, 1500);
      finishStreamFlush = finish;
      try { streamSocket!.send(streamProvider === 'elevenlabs' ? elevenLabsAudioMessage(new ArrayBuffer(0), true) : JSON.stringify({ type: 'Finalize' })); }
      catch { finish(); }
    });
  }
  if (state === 'idle') {
    teardown();
    return Promise.resolve();
  }
  // Prevent the cadence timer from racing the shutdown.
  if (segmentTimer !== null) {
    clearInterval(segmentTimer);
    segmentTimer = null;
  }
  stopLevelLoop();

  const rec = recorder;
  if (rec && rec.state === 'recording') {
    // Resolve only once handleStop has emitted + delivered the final segment.
    return new Promise<void>((resolve) => {
      stopFlushResolve = resolve;
      state = 'idle';
      stopReason = 'stop';
      rec.stop();
    });
  }
  // Paused: recorder is already inactive, nothing left to flush.
  teardown();
  return Promise.resolve();
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as { kind?: unknown };
  if (!msg || typeof msg.kind !== 'string') return false;

  switch (msg.kind) {
    case 'audio/decode-pcm': {
      const dataUrl = (raw as { dataUrl: string }).dataUrl;
      void decodePcm16(dataUrl).then(pcmBase64 => sendResponse({ pcmBase64 })).catch(() => sendResponse({ error: 'Recorded audio could not be decoded.' }));
      return true;
    }
    case 'audio/keyterms':
      updateKeyterms((raw as Extract<RequestMessage, { kind: 'audio/keyterms' }>).keyterms);
      sendResponse({ ok: true });
      return false;
    case 'audio/start': {
      const m = raw as Extract<RequestMessage, { kind: 'audio/start' }>;
      void handleStart(m.sessionId, m.startedAt, m.transcription, m.dictating === true).then((res) =>
        sendResponse(res),
      );
      return true; // async response
    }
    case 'audio/dictation':
      handleDictation((raw as Extract<RequestMessage, { kind: 'audio/dictation' }>).on);
      sendResponse({ ok: true });
      return false;
    case 'audio/pause':
      handlePause();
      sendResponse({ ok: true });
      return false;
    case 'audio/resume':
      handleResume();
      sendResponse({ ok: true });
      return false;
    case 'audio/stop':
      // Respond only after the final segment has been flushed + delivered, so
      // the background can safely tear down the offscreen document.
      void handleStopControl().then(() => sendResponse({ ok: true }));
      return true; // async response
    case 'video/start': {
      const m = raw as Extract<RequestMessage, { kind: 'video/start' }>;
      void handleVideoStart(m.sessionId, m.startedAt, m.streamId, m.audio === true).then((res) =>
        sendResponse(res),
      );
      return true; // async response
    }
    case 'video/pause':
      handleVideoPause();
      sendResponse({ ok: true });
      return false;
    case 'video/resume': {
      const m = raw as Extract<RequestMessage, { kind: 'video/resume' }>;
      void handleVideoResume(m.streamId, m.audio === true).then((res) => sendResponse(res));
      return true; // async response
    }
    case 'video/stop':
      // Same flush handshake as audio/stop: respond only after the final
      // segment has been delivered.
      void handleVideoStop().then(() => sendResponse({ ok: true }));
      return true; // async response
    default:
      return false; // not ours (broadcasts, other requests)
  }
});
