import { addDeepgramKeyterms } from './keyterms';
/**
 * Deepgram speech-to-text provider.
 *
 * POSTs the raw audio bytes to Deepgram's pre-recorded `/listen` endpoint and
 * maps the first channel's first alternative (transcript + word timings) into
 * the shared `TranscriptionResult`.
 */

import type {
  TranscriptionConfig,
  TranscriptionProvider,
  TranscriptionResult,
} from './provider';

const DEFAULT_BASE_URL = 'https://api.deepgram.com/v1/listen';
const DEFAULT_MODEL = 'nova-3';

interface DeepgramWord {
  word?: unknown;
  start?: unknown;
}

interface DeepgramAlternative {
  transcript?: unknown;
  words?: unknown;
}

interface DeepgramResponse {
  results?: {
    channels?: {
      alternatives?: DeepgramAlternative[];
    }[];
  };
}

export class DeepgramProvider implements TranscriptionProvider {
  async transcribe(
    audio: Blob,
    config: TranscriptionConfig,
  ): Promise<TranscriptionResult> {
    const base = config.baseUrl || DEFAULT_BASE_URL;
    const model = config.model || DEFAULT_MODEL;
    const params = new URLSearchParams({
      model,
      smart_format: 'true',
      punctuate: 'true',
    });
    // Deepgram defaults to English; a blank language means auto-detect, which
    // Nova-2 and Nova-3 provide as `multi`. Older models keep Deepgram's default.
    const language = config.language || (/^nova-[23]/.test(model) ? 'multi' : undefined);
    if (language) params.set('language', language);
    addDeepgramKeyterms(params, model, config.keyterms);
    const url = `${base}?${params.toString()}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${config.apiKey}`,
        'Content-Type': 'audio/webm',
      },
      body: audio,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`deepgram STT failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as DeepgramResponse;
    const alt = json.results?.channels?.[0]?.alternatives?.[0];
    const text = typeof alt?.transcript === 'string' ? alt.transcript : '';

    let words: { word: string; t: number }[] | undefined;
    if (alt && Array.isArray(alt.words)) {
      const mapped: { word: string; t: number }[] = [];
      for (const raw of alt.words as DeepgramWord[]) {
        if (!raw || typeof raw.word !== 'string') continue;
        const t = typeof raw.start === 'number' ? raw.start : 0;
        mapped.push({ word: raw.word, t });
      }
      if (mapped.length > 0) words = mapped;
    }

    return words ? { text, words } : { text };
  }
}
