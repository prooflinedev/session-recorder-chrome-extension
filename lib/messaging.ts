/**
 * The single typed messaging contract for the extension.
 *
 * Two channels:
 *  - Request/response: `sendMessage(msg)` -> a `MessageResponse`. Used for
 *    sidepanel/options/content -> background calls.
 *  - Broadcast: background -> all extension views via `broadcast(evt)`, received
 *    with `onBroadcast(cb)`. Used for live UI updates (ticker, state, progress).
 *
 * Every later phase adds message kinds HERE and nowhere else.
 */

import type {
  Asset,
  ElementDescriptor,
  CaptureSettings,
  EventType,
  RawEvent,
  Session,
  SessionEvent,
  VerbosityLevel,
} from './session/types';
import type { TranscriptionConfig } from './transcription/provider';

/** Transcription config handed to the offscreen doc for live streaming. */
export type StreamTranscriptionConfig = TranscriptionConfig;

// ----------------------------------------------------------------------------
// Request messages (X -> background)
// ----------------------------------------------------------------------------

export type RequestMessage =
  // --- session lifecycle (sidepanel -> bg) ---
  | { kind: 'session/start'; tabId: number; settings?: Partial<CaptureSettings> }
  | { kind: 'session/stop' }
  | { kind: 'session/pause' }
  | { kind: 'session/resume' }
  | { kind: 'session/getState' }
  | { kind: 'session/list' }
  | { kind: 'session/get'; sessionId: string }
  | { kind: 'session/delete'; sessionId: string }
  | { kind: 'session/rename'; sessionId: string; name: string }
  // --- capture (content -> bg) ---
  | { kind: 'capture/event'; event: RawEvent }
  | { kind: 'capture/fileBlob'; event: RawEvent; dataUrl: string }
  // --- content handshake / annotation results (content -> bg) ---
  | { kind: 'content/hello' }
  | { kind: 'dictation/focus'; id: string; context: string }
  | { kind: 'dictation/blur'; id: string }
  | { kind: 'dictation/mic'; on: boolean }
  | { kind: 'audio/keyterms'; keyterms: string[] }
  | {
      kind: 'annotation/exit';
      shapes: unknown;
      viewport: { w: number; h: number };
      /** The rendered annotated image (data URL) when finished, absent on cancel. */
      image?: string;
    }
  // --- manual capture actions (sidepanel -> bg) ---
  | { kind: 'screenshot/capture' }
  | { kind: 'marker/add'; name?: string }
  | { kind: 'note/add'; text: string }
  | { kind: 'annotation/toggle' }
  | { kind: 'point-annotation/toggle'; on?: boolean }
  | { kind: 'point-annotation/save'; descriptor?: ElementDescriptor; rect: {x:number;y:number;w:number;h:number}; text: string; viewport: {w:number;h:number} }
  | { kind: 'file/attach'; fileName: string; mime: string; dataUrl: string; note?: string }
  // --- voice (sidepanel -> bg) ---
  | { kind: 'mic/toggle'; on: boolean }
  | { kind: 'transcription/retry'; sessionId: string; eventId: string }
  // --- tab video (sidepanel -> bg) ---
  | { kind: 'video/toggle'; on: boolean }
  // --- data reads (sidepanel/options -> bg) ---
  | { kind: 'events/get'; sessionId: string }
  | { kind: 'assets/getMeta'; sessionId: string }
  // --- export (sidepanel -> bg or self-handled) ---
  | { kind: 'export/estimate'; sessionId: string }
  // --- offscreen lifecycle (bg <-> offscreen) ---
  | { kind: 'audio/start'; sessionId: string; startedAt: number; transcription?: StreamTranscriptionConfig | null; dictating?: boolean }
  // A comment composer opened or closed: segmented (batch) capture starts a new
  // segment at that boundary and uses a short cadence while dictating.
  | { kind: 'audio/dictation'; on: boolean }
  | { kind: 'audio/pause' }
  | { kind: 'audio/resume' }
  | { kind: 'audio/stop' }
  // Tab-video controls (bg -> offscreen). `video/resume` carries a FRESH
  // streamId: tabCapture stream ids are single-use and the paused stream is
  // dead once its recorder stopped.
  | { kind: 'video/start'; sessionId: string; startedAt: number; streamId: string; audio?: boolean }
  | { kind: 'video/pause' }
  | { kind: 'video/resume'; streamId: string; audio?: boolean }
  | { kind: 'video/stop' }
  // --- offscreen -> bg ---
  | { kind: 'audio/segment'; sessionId: string; tStart: number; tEnd: number; dataUrl: string; mime: string }
  | { kind: 'audio/level'; level: number }
  // A video take is unbounded in size, so the offscreen doc writes the blob to
  // IndexedDB itself and only announces the stored asset (a data URL would
  // exceed the runtime-message size limit after a few minutes of recording).
  | { kind: 'video/segment'; sessionId: string; tStart: number; tEnd: number; assetId: string; size: number }
  // --- live streaming transcription (offscreen -> bg) ---
  | { kind: 'transcript/final'; sessionId: string; tStart: number; tEnd: number; text: string; words?: { word: string; t: number }[]; provider: string }
  | { kind: 'transcript/interim'; sessionId: string; text: string; tStart?: number }
  | { kind: 'transcript/error'; sessionId: string; error: string }
  // --- storage ---
  | { kind: 'storage/estimate' };

// ----------------------------------------------------------------------------
// Response
// ----------------------------------------------------------------------------

export interface AppState {
  session: Session | null;
  /** Recent events for the ticker (materialized). */
  recentEvents: SessionEvent[];
  recording: boolean;
  paused: boolean;
  micOn: boolean;
  videoOn: boolean;
  annotating: boolean;
  pointing: boolean;
  attachedTabIds: number[];
  error?: string;
}

export interface TokenEstimate {
  level: VerbosityLevel;
  tokens: number;
  approxBytes: number;
  omitted: string[];
}

export type ResponseFor = {
  'session/start': { ok: boolean; session?: Session; error?: string };
  'session/stop': { ok: boolean };
  'session/pause': { ok: boolean };
  'session/resume': { ok: boolean };
  'session/getState': AppState;
  'session/list': { sessions: Session[] };
  'session/get': { session: Session | null };
  'session/delete': { ok: boolean };
  'session/rename': { ok: boolean };
  'capture/event': { ok: boolean };
  'capture/fileBlob': { ok: boolean };
  'content/hello': { active: boolean; annotating: boolean; pointing: boolean; micOn: boolean };
  'dictation/focus': { ok: boolean; micOn: boolean };
  'dictation/blur': { ok: boolean };
  'dictation/mic': { ok: boolean; micOn: boolean; error?: string };
  'audio/keyterms': { ok: boolean };
  'point-annotation/toggle': {ok: boolean; pointing: boolean; error?: string};
  'point-annotation/save': {ok: boolean; error?: string};
  'annotation/exit': { ok: boolean };
  'screenshot/capture': { ok: boolean };
  'marker/add': { ok: boolean };
  'note/add': { ok: boolean };
  'annotation/toggle': { ok: boolean; annotating: boolean };
  'file/attach': { ok: boolean };
  'mic/toggle': { ok: boolean; micOn: boolean; error?: string };
  'video/toggle': { ok: boolean; videoOn: boolean; error?: string };
  'transcription/retry': { ok: boolean };
  'events/get': { events: SessionEvent[] };
  'assets/getMeta': { assets: Array<Omit<Asset, 'blob'>> };
  'export/estimate': { estimates: TokenEstimate[] };
  'audio/start': { ok: boolean };
  'audio/pause': { ok: boolean };
  'audio/resume': { ok: boolean };
  'audio/stop': { ok: boolean };
  'audio/dictation': { ok: boolean };
  'video/start': { ok: boolean; error?: string };
  'video/pause': { ok: boolean };
  'video/resume': { ok: boolean; error?: string };
  'video/stop': { ok: boolean };
  'audio/segment': { ok: boolean };
  'audio/level': { ok: boolean };
  'video/segment': { ok: boolean };
  'transcript/final': { ok: boolean };
  'transcript/interim': { ok: boolean };
  'transcript/error': { ok: boolean };
  'storage/estimate': { usage: number; quota: number };
};

// ----------------------------------------------------------------------------
// Broadcast messages (background -> views)
// ----------------------------------------------------------------------------

export type BroadcastMessage =
  | { kind: 'state/update'; state: AppState }
  | { kind: 'session/updated'; session: Session }
  | { kind: 'event/tick'; event: SessionEvent; counts: Partial<Record<EventType, number>> }
  | { kind: 'export/progress'; sessionId: string; phase: string; pct: number }
  | { kind: 'transcription/progress'; sessionId: string; done: number; total: number }
  | { kind: 'mic/level'; level: number }
  | { kind: 'annotation/state'; annotating: boolean }
  // Live (interim) transcript for the recording ticker.
  | { kind: 'transcript/live'; text: string; final: boolean }
  // Ask an open report tab to re-render at a new verbosity level.
  | { kind: 'report/level'; sessionId: string; level: VerbosityLevel }
  | { kind: 'asset/redaction-updated'; sessionId: string; assetId: string; revision: number };

// ----------------------------------------------------------------------------
// Transport helpers
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Content-directed messages (background -> a specific tab's content scripts)
// ----------------------------------------------------------------------------

export type ContentMessage =
  | { kind: 'content/mic'; on: boolean }
  | { kind: 'content/dictation'; id: string; segment: string; text: string; final: boolean }
  /** Speech for this composer is awaiting transcription, or transcription failed. */
  | { kind: 'content/dictation-status'; id: string; pending: boolean; error?: string }
  | {kind: 'content/point-annotate'; on: boolean}
  | { kind: 'content/setActive'; active: boolean; hoverDwellMs?: number }
  | {
      kind: 'content/annotate';
      on: boolean;
      /** Frozen screenshot (data URL) to annotate, sent when turning on. */
      image?: string;
      viewport?: { w: number; h: number };
    };

const CONTENT_MARKER = '__sr_content__';

/**
 * Marks a message the background sends toward the offscreen document
 * (audio/* and video/* controls). It is broadcast on the shared runtime
 * channel, so this marker tells the background's OWN request handler to ignore
 * it (only the offscreen listener should act + respond).
 */
export const OFFSCREEN_MARKER = '__sr_offscreen__';

/** Send a content-directed message to a specific tab (all frames). */
export async function sendToTab(
  tabId: number,
  msg: ContentMessage,
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { ...msg, [CONTENT_MARKER]: true });
  } catch {
    /* no content script in that tab yet — fine */
  }
}

/** Subscribe to content-directed messages (content-script side). */
export function onContentMessage(
  cb: (msg: ContentMessage) => void,
): () => void {
  const listener = (msg: unknown) => {
    if (msg && (msg as Record<string, unknown>)[CONTENT_MARKER]) {
      cb(msg as ContentMessage);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

const BROADCAST_MARKER = '__sr_broadcast__';

/** Send a request to the background and await the typed response. */
export async function sendMessage<K extends RequestMessage['kind']>(
  msg: Extract<RequestMessage, { kind: K }>,
): Promise<ResponseFor[K]> {
  return (await chrome.runtime.sendMessage(msg)) as ResponseFor[K];
}

/** Register a typed handler for incoming requests (background side). */
export function onMessage(
  handler: (
    msg: RequestMessage,
    sender: chrome.runtime.MessageSender,
  ) => Promise<unknown> | unknown,
): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (
      msg &&
      (msg[BROADCAST_MARKER] || msg[CONTENT_MARKER] || msg[OFFSCREEN_MARKER])
    ) {
      return false; // not a request the background should answer
    }
    Promise.resolve(handler(msg as RequestMessage, sender))
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
    return true; // keep the channel open for the async response
  });
}

/** Broadcast an update from the background to all extension views. */
export function broadcast(evt: BroadcastMessage): void {
  chrome.runtime
    .sendMessage({ ...evt, [BROADCAST_MARKER]: true })
    .catch(() => {
      /* no views open — fine */
    });
}

/** Subscribe to broadcasts (sidepanel/options side). Returns an unsubscribe fn. */
export function onBroadcast(cb: (evt: BroadcastMessage) => void): () => void {
  const listener = (msg: unknown) => {
    if (msg && (msg as Record<string, unknown>)[BROADCAST_MARKER]) {
      cb(msg as BroadcastMessage);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
