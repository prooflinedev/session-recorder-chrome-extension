import { addDeepgramKeyterms } from './keyterms';
/**
 * Deepgram live (streaming) transcription helpers — pure and unit-tested.
 *
 * The offscreen document opens a WebSocket to Deepgram's streaming endpoint,
 * pipes linear16 PCM as the user speaks, and receives interim + final results
 * with word-level timings. These helpers build the URL / auth and parse the
 * result frames; the socket plumbing lives in the offscreen document.
 *
 * Auth note: browser WebSockets can't set headers, so Deepgram accepts the API
 * key as a subprotocol pair `['token', <key>]`.
 */
import type { TranscriptionConfig } from './provider';

export const DEEPGRAM_SAMPLE_RATE = 16000;

export interface DeepgramLiveOptions {
  sampleRate?: number;
  interim?: boolean;
}

/** Build the Deepgram streaming websocket URL for the given config. */
export function buildDeepgramLiveUrl(
  config: TranscriptionConfig,
  opts: DeepgramLiveOptions = {},
): string {
  const base = config.baseUrl?.startsWith('wss')
    ? config.baseUrl
    : 'wss://api.deepgram.com/v1/listen';
  const model = config.model || 'nova-3';
  const params = new URLSearchParams({
    model,
    encoding: 'linear16',
    sample_rate: String(opts.sampleRate ?? DEEPGRAM_SAMPLE_RATE),
    channels: '1',
    interim_results: String(opts.interim ?? true),
    punctuate: 'true',
    smart_format: 'true',
  });
  // Deepgram defaults to English; a blank language means auto-detect, which
  // Nova-2 and Nova-3 provide as `multi`. Older models keep Deepgram's default.
  const language = config.language || (/^nova-[23]/.test(model) ? 'multi' : undefined);
  if (language) params.set('language', language);
  addDeepgramKeyterms(params, model, config.keyterms);
  return `${base}?${params.toString()}`;
}

/** Subprotocols carrying the API key (header-less browser auth). */
export function deepgramSubprotocols(apiKey: string): string[] {
  return ['token', apiKey];
}

export interface ParsedTranscript {
  kind: 'final' | 'interim' | 'other';
  text: string;
  /** Seconds from the start of the stream. */
  start: number;
  /** Segment duration in seconds. */
  duration: number;
  /** Word timings, seconds from stream start. */
  words: { word: string; t: number }[];
}

/**
 * Parse one Deepgram streaming message. Returns `kind:'other'` for anything
 * that isn't a Results frame (Metadata, SpeechStarted, UtteranceEnd, …) or an
 * empty transcript.
 */
export function parseDeepgramMessage(raw: string): ParsedTranscript {
  const empty: ParsedTranscript = {
    kind: 'other',
    text: '',
    start: 0,
    duration: 0,
    words: [],
  };
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!msg || typeof msg !== 'object') return empty;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'Results') return empty;

  const channel = m.channel as Record<string, unknown> | undefined;
  const alts = (channel?.alternatives as unknown[]) ?? [];
  const alt = (alts[0] as Record<string, unknown>) ?? {};
  const text = typeof alt.transcript === 'string' ? alt.transcript.trim() : '';
  if (!text) return empty;

  const start = typeof m.start === 'number' ? m.start : 0;
  const duration = typeof m.duration === 'number' ? m.duration : 0;
  const isFinal = m.is_final === true || m.speech_final === true;

  const rawWords = (alt.words as unknown[]) ?? [];
  const words: { word: string; t: number }[] = [];
  for (const w of rawWords) {
    const wr = w as Record<string, unknown>;
    const word =
      (typeof wr.punctuated_word === 'string' && wr.punctuated_word) ||
      (typeof wr.word === 'string' && wr.word) ||
      '';
    const t = typeof wr.start === 'number' ? wr.start : start;
    if (word) words.push({ word, t });
  }

  return { kind: isFinal ? 'final' : 'interim', text, start, duration, words };
}

/** The message that flushes + closes a Deepgram live stream. */
export const DEEPGRAM_CLOSE_MESSAGE = JSON.stringify({ type: 'CloseStream' });
