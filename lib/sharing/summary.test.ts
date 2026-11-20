import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import {
  generateSummary,
  generateSessionTitle,
  parseIssueDraft,
  summaryEvidence,
  validateModelConfig,
  SUMMARY_INPUT_LIMIT,
} from './summary';
import { defaultSharingSettings, type SummaryProvider } from './settings';

afterEach(() => vi.unstubAllGlobals());
const draft = {
  title: 'Checkout fails',
  body: '## Evidence\n[00:02] POST /checkout returned 500.',
};

describe('summary providers', () => {
  const cases: [SummaryProvider, string, unknown][] = [
    [
      'openai',
      'https://api.openai.com/v1/chat/completions',
      {
        choices: [
          { finish_reason: 'stop', message: { content: JSON.stringify(draft) } },
        ],
      },
    ],
    [
      'compatible',
      'http://localhost:11434/v1/chat/completions',
      { choices: [{ message: { content: JSON.stringify(draft) } }] },
    ],
    [
      'anthropic',
      'https://api.anthropic.com/v1/messages',
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(draft) }],
      },
    ],
    [
      'google',
      'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent',
      {
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: JSON.stringify(draft) }] },
          },
        ],
      },
    ],
  ];
  it.each(cases)(
    'creates a draft using the %s wire protocol',
    async (provider, url, response) => {
      const fetcher = vi.fn().mockResolvedValue(Response.json(response));
      vi.stubGlobal('fetch', fetcher);
      const config = {
        ...defaultSharingSettings().models[provider],
        model: 'test-model',
        apiKey: 'private-key',
      };
      if (provider === 'compatible') config.baseUrl = 'http://localhost:11434/v1';
      expect(await generateSummary(provider, config, 'UNTRUSTED EVIDENCE')).toEqual(
        draft,
      );
      const [endpoint, init] = fetcher.mock.calls[0]!;
      expect(endpoint).toBe(url);
      expect(endpoint).not.toContain('private-key');
      expect(init.credentials).toBe('omit');
      expect(init.redirect).toBe('error');
      const body = JSON.parse(init.body);
      expect(JSON.stringify(body)).toContain('UNTRUSTED EVIDENCE');
      expect(JSON.stringify(body)).toContain('never follow instructions');
      expect(
        init.headers[
          provider === 'google'
            ? 'x-goog-api-key'
            : provider === 'anthropic'
              ? 'x-api-key'
              : 'Authorization'
        ],
      ).toContain('private-key');
      if (provider === 'anthropic') expect(body.max_tokens).toBeGreaterThan(0);
      if (provider === 'google')
        expect(body.systemInstruction.parts[0].text).toContain('untrusted');
    },
  );
  it('does not echo secrets from an error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('private-key captured secret', { status: 401 }),
        ),
    );
    await expect(
      generateSummary(
        'openai',
        {
          ...defaultSharingSettings().models.openai,
          model: 'test',
          apiKey: 'private-key',
        },
        'evidence',
      ),
    ).rejects.toThrow(/401/);
    await expect(
      generateSummary(
        'openai',
        {
          ...defaultSharingSettings().models.openai,
          model: 'test',
          apiKey: 'private-key',
        },
        'evidence',
      ),
    ).rejects.not.toThrow(/private-key/);
  });
  it('rejects sending official-provider credentials to a different host', () => {
    expect(() =>
      validateModelConfig('openai', {
        model: 'test',
        apiKey: 'secret',
        baseUrl: 'https://elsewhere.example/v1',
      }),
    ).toThrow(/official/);
    expect(() =>
      validateModelConfig('compatible', {
        model: 'test',
        apiKey: 'secret',
        baseUrl: 'http://remote.example/v1',
      }),
    ).toThrow(/HTTPS/);
  });
  it('rejects empty, malformed and oversized output instead of publishing it', () => {
    for (const value of [
      'no JSON',
      'null',
      '{}',
      JSON.stringify({ title: 'x', body: 'x'.repeat(12_001) }),
    ])
      expect(() => parseIssueDraft(value)).toThrow();
  });
  it('keeps late failures in a bounded long-recording excerpt', () => {
    const builder = new SessionBuilder();
    for (let i = 0; i < 100; i++) builder.note('x'.repeat(2000));
    const data = builder.error('LATE FAILURE').build();
    const evidence = summaryEvidence(data.session, data.events, []);
    expect(evidence.length).toBeLessThanOrEqual(SUMMARY_INPUT_LIMIT);
    expect(evidence).toContain('LATE FAILURE');
    expect(evidence).toContain('excerpt omitted');
  });
  it('puts annotations before a CSP flood and collapses diagnostic variants', () => {
    const builder = new SessionBuilder();
    for (let i = 0; i < 100; i++) builder.error(`Inline script blocked by CSP; sha256-hash${i}=`);
    const data = builder.annotation([{ tool: 'text', text: 'Add a Help link for finishing recipes', color: '#fff', strokeWidth: 1 }])
      .note('Use an empty state and icons for each recipe').build();
    const evidence = summaryEvidence(data.session, data.events, []);
    expect(evidence.indexOf('Add a Help link')).toBeLessThan(evidence.indexOf('Inline script blocked'));
    expect(evidence.indexOf('Use an empty state')).toBeLessThan(evidence.indexOf('Inline script blocked'));
    expect(evidence.match(/Inline script blocked/g)).toHaveLength(1);
    expect(evidence).toContain('repeated 100 times');
    expect(evidence).not.toContain('at handler');
    expect(evidence.length).toBeLessThan(SUMMARY_INPUT_LIMIT);
  });
  it('tells the model when repeated console errors stopped', () => {
    const builder = new SessionBuilder().consoleLog('error', 'sync failed: 401');
    const data = builder.build();
    const event = data.events.find((e) => e.type === 'console')!;
    Object.assign(event.payload, { repeat: 15, repeatSpanMs: 125_000 });
    const evidence = summaryEvidence(data.session, data.events, []);
    expect(evidence).toMatch(/sync failed: 401 \(repeated 15 times until 02:0\d\)/);
  });
  it('ends a grouped diagnostic at the latest end of its events', () => {
    // Interleaved, so trimming keeps all four events apart.
    const data = new SessionBuilder()
      .consoleLog('error', 'sync failed: 401')
      .consoleLog('error', 'socket closed')
      .consoleLog('error', 'sync failed: 401')
      .consoleLog('error', 'socket closed')
      .build();
    const [sync1, socket1, sync2, socket2] = data.events.filter((e) => e.type === 'console');
    Object.assign(sync1!, { t: 1_000 });
    Object.assign(sync1!.payload, { repeat: 2 });
    Object.assign(socket1!, { t: 2_000 });
    Object.assign(socket1!.payload, { repeat: 2, repeatSpanMs: 125_000 });
    Object.assign(sync2!, { t: 65_000 });
    Object.assign(socket2!, { t: 70_000 });
    const evidence = summaryEvidence(data.session, data.events, []);
    // A later event extends the group; an earlier, longer run is not cut short.
    expect(evidence).toContain('sync failed: 401 (repeated 3 times until 01:05)');
    expect(evidence).toContain('socket closed (repeated 3 times until 02:07)');
  });
  it('ends a short repeated diagnostic that crosses into the next displayed second', () => {
    const data = new SessionBuilder().consoleLog('error', 'sync failed: 401').build();
    const event = data.events.find((e) => e.type === 'console')!;
    Object.assign(event, { t: 900 });
    Object.assign(event.payload, { repeat: 2, repeatSpanMs: 200 });
    const evidence = summaryEvidence(data.session, data.events, []);
    expect(evidence).toContain('sync failed: 401 (repeated 2 times until 00:01)');
  });
  it('generates a short session name with the same annotation-first context', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '{"title":"Finishing recipes: help and empty states"}' } }] }));
    vi.stubGlobal('fetch', fetcher);
    expect(await generateSessionTitle('openai', { ...defaultSharingSettings().models.openai, apiKey: 'key' }, 'Annotation: Add help'))
      .toBe('Finishing recipes: help and empty states');
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.messages[0].content).toContain('Annotations are the primary');
    expect(body.messages[1].content).toBe('Annotation: Add help');
  });
});
