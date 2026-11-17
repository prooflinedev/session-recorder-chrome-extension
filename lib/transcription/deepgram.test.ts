import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepgramProvider } from './deepgram';
import type { TranscriptionConfig } from './provider';

const cfg: TranscriptionConfig = { provider: 'deepgram', apiKey: 'k', model: 'nova-3' };

async function requestedLanguage(config: TranscriptionConfig): Promise<string | null> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: { channels: [] } })));
  vi.stubGlobal('fetch', fetchMock);
  await new DeepgramProvider().transcribe(new Blob(['audio']), config);
  const [url] = fetchMock.mock.calls[0] as unknown as [string];
  return new URL(url).searchParams.get('language');
}

describe('deepgram', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends language=multi when no language is set, so non-English speech is detected', async () => {
    expect(await requestedLanguage(cfg)).toBe('multi');
    expect(await requestedLanguage({ ...cfg, model: undefined })).toBe('multi');
    expect(await requestedLanguage({ ...cfg, language: 'es' })).toBe('es');
    expect(await requestedLanguage({ ...cfg, model: 'enhanced' })).toBeNull();
  });
});
