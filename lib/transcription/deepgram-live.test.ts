import { describe, it, expect } from 'vitest';
import {
  buildDeepgramLiveUrl,
  deepgramSubprotocols,
  parseDeepgramMessage,
} from './deepgram-live';
import type { TranscriptionConfig } from './provider';

const cfg: TranscriptionConfig = {
  provider: 'deepgram',
  apiKey: 'k',
  model: 'nova-3',
};

describe('deepgram-live', () => {
  it('builds a streaming URL with the right params', () => {
    const url = buildDeepgramLiveUrl(cfg, { sampleRate: 16000 });
    expect(url).toContain('wss://api.deepgram.com/v1/listen?');
    expect(url).toContain('model=nova-3');
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('sample_rate=16000');
    expect(url).toContain('interim_results=true');
  });

  it('sends language=multi when no language is set, so non-English speech is detected', () => {
    const language = (config: TranscriptionConfig) =>
      new URL(buildDeepgramLiveUrl(config)).searchParams.get('language');
    expect(language(cfg)).toBe('multi');
    expect(language({ ...cfg, model: undefined })).toBe('multi');
    expect(language({ ...cfg, language: 'es' })).toBe('es');
    expect(language({ ...cfg, model: 'enhanced' })).toBeNull();
  });

  it('passes the api key as a subprotocol', () => {
    expect(deepgramSubprotocols('abc')).toEqual(['token', 'abc']);
  });

  it('parses a final result with word timings', () => {
    const raw = JSON.stringify({
      type: 'Results',
      is_final: true,
      start: 4.2,
      duration: 2.1,
      channel: {
        alternatives: [
          {
            transcript: 'hello world',
            words: [
              { word: 'hello', punctuated_word: 'Hello', start: 4.2 },
              { word: 'world', start: 5.0 },
            ],
          },
        ],
      },
    });
    const p = parseDeepgramMessage(raw);
    expect(p.kind).toBe('final');
    expect(p.text).toBe('hello world');
    expect(p.start).toBe(4.2);
    expect(p.words).toEqual([
      { word: 'Hello', t: 4.2 },
      { word: 'world', t: 5.0 },
    ]);
  });

  it('classifies interim results and ignores non-results / empties', () => {
    expect(
      parseDeepgramMessage(
        JSON.stringify({
          type: 'Results',
          is_final: false,
          channel: { alternatives: [{ transcript: 'partial' }] },
        }),
      ).kind,
    ).toBe('interim');
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Metadata' })).kind).toBe('other');
    expect(
      parseDeepgramMessage(
        JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: '' }] } }),
      ).kind,
    ).toBe('other');
    expect(parseDeepgramMessage('not json').kind).toBe('other');
  });
});
