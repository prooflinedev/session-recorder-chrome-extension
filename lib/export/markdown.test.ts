/**
 * Golden-ish tests for the pure Markdown renderer.
 *
 * NOTE: `lib/fixtures/session-builder.ts` is authored by a concurrent task and
 * did not exist when this test was written, so this file builds a small but
 * expressive synthetic session inline (mirroring the fixture shape) so it can
 * run in isolation. The assertions are the ones the task requires: the report
 * renders without throwing, contains the header, a known click's text and an
 * error marker; and `formatClock` formats both `mm:ss` and `h:mm:ss`.
 */

import { describe, expect, it } from 'vitest';
import type {
  AssetMeta,
  Session,
  SessionEvent,
} from '@/lib/session/types';
import { makeDefaultSettings } from '@/lib/session/settings';
import { scoreEvent } from '@/lib/session/events';
import { formatClock, renderManifest, renderReport } from './markdown';
import type { RenderInput } from './markdown';

const SESSION_ID = 'sess_test';
const SHOT_ASSET = 'asset_shot_1';
const BODY_ASSET = 'asset_body_1';

let seq = 0;
function ev<E extends SessionEvent>(
  partial: Omit<E, 'id' | 'sessionId' | 'importance'> & { importance?: number },
): SessionEvent {
  const base = {
    id: `evt_${seq++}`,
    sessionId: SESSION_ID,
    importance: scoreEvent({
      type: partial.type,
      tabId: partial.tabId,
      payload: partial.payload,
    } as Parameters<typeof scoreEvent>[0]),
    ...partial,
  };
  return base as SessionEvent;
}

function buildSession(): RenderInput {
  const session: Session = {
    id: SESSION_ID,
    name: 'Checkout flow',
    startedAt: Date.UTC(2026, 6, 5, 12, 0, 0),
    endedAt: Date.UTC(2026, 6, 5, 12, 5, 0),
    initialUrl: 'https://app.example.com/cart',
    tabs: [
      {
        tabId: 1,
        url: 'https://app.example.com/cart',
        title: 'Cart — Example',
        attachedAt: 0,
        role: 'primary',
        attached: true,
      },
    ],
    settings: makeDefaultSettings(),
    status: 'stopped',
    counts: {},
    assetBytes: 2048,
  };

  const events: SessionEvent[] = [
    ev({
      t: 500,
      tabId: 1,
      type: 'nav',
      payload: { url: 'https://app.example.com/cart', title: 'Cart' },
    }),
    ev({
      t: 2000,
      tabId: 1,
      type: 'click',
      payload: {
        descriptor: {
          tag: 'button',
          id: 'checkout',
          text: 'Submit order',
          selector: 'button#checkout',
        },
        modifiers: [],
      },
    }),
    ev({
      t: 2500,
      tabId: 1,
      type: 'input',
      payload: {
        descriptor: { tag: 'input', id: 'coupon', selector: 'input#coupon' },
        value: 'SAVE10',
        redacted: false,
      },
    }),
    ev({
      t: 3000,
      tabId: 1,
      type: 'net-request',
      payload: {
        requestId: 'req1',
        method: 'POST',
        url: 'https://api.example.com/v1/orders',
        status: 500,
        statusText: 'Internal Server Error',
        requestHeaders: [],
        responseHeaders: [],
        requestBody: {
          present: true,
          mime: 'application/json',
          text: '{"cart":"c1"}',
        },
        responseBody: {
          present: true,
          mime: 'application/json',
          text: '{"error":"boom"}',
          assetId: BODY_ASSET,
        },
      },
    }),
    ev({
      t: 3200,
      tabId: 1,
      type: 'error',
      payload: {
        message: 'Order failed: server returned 500',
        origin: 'network',
        stack: 'at submit (checkout.js:42)',
      },
    }),
    ev({
      t: 3500,
      tabId: 1,
      type: 'console',
      payload: { level: 'warn', text: 'retrying order submission', repeat: 3 },
    }),
    ev({
      t: 4000,
      tabId: 1,
      type: 'screenshot',
      payload: {
        assetId: SHOT_ASSET,
        width: 800,
        height: 600,
        trigger: 'error',
        contextText: 'error dialog visible',
      },
    }),
    ev({
      t: 4200,
      tabId: 1,
      type: 'marker',
      payload: { name: 'Bug reproduced here' },
    }),
    ev({
      t: 4500,
      tabId: 1,
      type: 'note',
      payload: { text: 'The 500 only happens with a coupon applied.' },
    }),
    ev({
      t: 5000,
      type: 'voice-segment',
      payload: {
        assetId: 'asset_audio_1',
        tStart: 4800,
        tEnd: 5200,
        transcript: 'And here it crashes.',
      },
    }),
    ev({
      t: 5500,
      tabId: 1,
      type: 'annotation',
      payload: {
        shapes: [
          {
            tool: 'arrow',
            color: '#ff0000',
            strokeWidth: 3,
            from: { x: 0, y: 0 },
            to: { x: 10, y: 10 },
            targetDescriptor: {
              tag: 'div',
              selector: 'div.error',
              text: 'Something went wrong',
            },
          },
          {
            tool: 'text',
            color: '#000',
            strokeWidth: 1,
            text: 'this button',
          },
        ],
        screenshotAssetId: SHOT_ASSET,
        viewport: { w: 800, h: 600 },
      },
    }),
  ];

  const assets: AssetMeta[] = [
    {
      id: SHOT_ASSET,
      sessionId: SESSION_ID,
      kind: 'screenshot',
      mime: 'image/jpeg',
      size: 1500,
    },
    {
      id: BODY_ASSET,
      sessionId: SESSION_ID,
      kind: 'net-body',
      mime: 'application/json',
      size: 42,
    },
  ];

  const paths: Record<string, string> = {
    [SHOT_ASSET]: 'screenshots/001-0004.jpg',
    [BODY_ASSET]: 'network/001-api.example.com-orders.json',
  };

  return {
    session,
    events,
    assets,
    level: 'L0',
    assetPath: (id) => paths[id],
  };
}

describe('formatClock', () => {
  it('formats mm:ss under an hour', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(42_000)).toBe('00:42');
    expect(formatClock(62_000)).toBe('01:02');
    expect(formatClock(59 * 60_000 + 59_000)).toBe('59:59');
  });

  it('formats h:mm:ss at or past an hour', () => {
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(3_661_000)).toBe('1:01:01');
    expect(formatClock(2 * 3_600_000 + 5 * 60_000 + 9_000)).toBe('2:05:09');
  });

  it('clamps negative input to zero', () => {
    expect(formatClock(-1000)).toBe('00:00');
  });
});

describe('renderReport', () => {
  it('renders a full report without throwing', () => {
    const input = buildSession();
    expect(() => renderReport(input)).not.toThrow();
  });

  it('includes the header block', () => {
    const md = renderReport(buildSession());
    expect(md).toContain('# Session Report: Checkout flow');
    expect(md).toContain('**App:**');
    expect(md).toContain('https://app.example.com');
    expect(md).toContain('**Duration:** 05:00');
    expect(md).toContain('### Tabs');
  });

  it('mentions the compiled API spec in the header when present', () => {
    const md = renderReport({
      ...buildSession(),
      openapi: { path: 'openapi.json', endpointCount: 3 },
    });
    expect(md).toContain('**API spec:** `openapi.json`');
    expect(md).toContain('3 endpoint(s)');
  });

  it('omits the API-spec header line when no spec was compiled', () => {
    const md = renderReport(buildSession());
    expect(md).not.toContain('API spec');
    expect(md).not.toContain('openapi.json');
  });

  it('describes an included repro test: how to run it, outcomes, signals and gaps', () => {
    const md = renderReport({
      ...buildSession(),
      repro: {
        path: 'repro.spec.ts',
        configPath: 'playwright.config.mjs',
        steps: 4,
        signals: ['[00:05] uncaught exception: TypeError: *total* is undefined'],
        gaps: ['1 step(s) in another tab were not replayed'],
        envVars: [{ name: 'REPRO_INPUT_1', label: 'input #password' }],
      },
    });
    expect(md).toContain('- **Repro test:** `repro.spec.ts` (4 steps, 1 checked signal)');
    const section = md.slice(md.indexOf('## Repro test'), md.indexOf('## Timeline'));
    expect(section).toContain('Run it before you change any code');
    expect(section).toContain('BASE_URL=http://localhost:3000 npx playwright test\n');
    expect(section).toContain('`playwright.config.mjs` runs only `repro.spec.ts`');
    expect(section).toContain('`REPRODUCED`');
    expect(section).toContain('`INCONCLUSIVE`');
    expect(section).toContain('`NOT REPRODUCED`');
    expect(section).toContain('- [00:05] uncaught exception: TypeError: *total* is undefined');
    expect(section).toContain('`REPRO_INPUT_1`: input #password');
    expect(section).toContain('1 step(s) in another tab were not replayed');
  });

  it('says when a repro test has nothing to check', () => {
    const md = renderReport({
      ...buildSession(),
      repro: {
        path: 'repro.spec.ts',
        configPath: 'playwright.config.mjs',
        steps: 2,
        signals: [],
        gaps: [],
        envVars: [],
        fixme: 'Nothing to check: the recording has no error or failed request.',
      },
    });
    expect(md).toContain('(2 steps, nothing to check)');
    expect(md).toContain('Nothing to check: the recording has no error or failed request.');
  });

  it('omits the repro test when none was generated', () => {
    expect(renderReport(buildSession())).not.toContain('Repro test');
  });

  it("contains a known click's text", () => {
    const md = renderReport(buildSession());
    expect(md).toContain('CLICK "Submit order" (button#checkout, tab 1)');
  });

  it('marks errors loudly with the warning glyph', () => {
    const md = renderReport(buildSession());
    expect(md).toContain('⚠');
    expect(md).toContain('Order failed: server returned 500');
  });

  it('renders nav as a section break with a timestamp', () => {
    const md = renderReport(buildSession());
    expect(md).toMatch(/## \[00:00\] NAV https:\/\/app\.example\.com\/cart/);
  });

  it('renders the network request with method, status and body', () => {
    const md = renderReport(buildSession());
    expect(md).toContain('500 POST /v1/orders');
    expect(md).toContain('{"error":"boom"}');
    expect(md).toContain('## Appendix: Network Index');
  });

  it('links included screenshots and annotations', () => {
    const md = renderReport(buildSession());
    expect(md).toContain('![error dialog visible](screenshots/001-0004.jpg)');
    expect(md).toContain('**arrow**');
  });

  it('renders voice segments and markers', () => {
    const md = renderReport(buildSession());
    expect(md).toContain('🎙️');
    expect(md).toContain('And here it crashes.');
    expect(md).toContain('MARKER');
    expect(md).toContain('Bug reproduced here');
  });

  it('renders text selections as SELECT lines with the selector', () => {
    const input = buildSession();
    const events: SessionEvent[] = [
      ev({
        t: 1000,
        tabId: 1,
        type: 'text-select',
        payload: {
          text: 'the selected words',
          descriptor: { tag: 'p', selector: 'p.intro' },
          cleared: false,
        },
      }),
    ];
    const md = renderReport({ ...input, events, assetPath: () => undefined });
    expect(md).toContain('[00:01] SELECT "the selected words" (p.intro, tab 1)');
  });

  it('one-lines multi-line selections and marks truncation', () => {
    const input = buildSession();
    const events: SessionEvent[] = [
      ev({
        t: 2000,
        tabId: 1,
        type: 'text-select',
        payload: {
          text: 'first line\nsecond   line',
          truncated: true,
          cleared: false,
        },
      }),
    ];
    const md = renderReport({ ...input, events, assetPath: () => undefined });
    // No descriptor: no selector parenthetical; whitespace collapsed; ellipsis
    // marks the 500-char cap.
    expect(md).toContain('[00:02] SELECT "first line second line…"\n');
  });

  it('renders a cleared selection without text or selector', () => {
    const input = buildSession();
    const events: SessionEvent[] = [
      ev({ t: 3000, tabId: 1, type: 'text-select', payload: { cleared: true } }),
      ev({ t: 4000, type: 'text-select', payload: { cleared: true } }),
    ];
    const md = renderReport({ ...input, events, assetPath: () => undefined });
    expect(md).toContain('[00:03] SELECT cleared (tab 1)');
    expect(md).toContain('[00:04] SELECT cleared\n');
  });

  it('renders video segments with their span and file link', () => {
    const input = buildSession();
    const events: SessionEvent[] = [
      ev({
        t: 6000,
        type: 'video-segment',
        payload: { assetId: 'asset_video_1', tStart: 6000, tEnd: 12000 },
      }),
    ];
    const md = renderReport({
      ...input,
      events,
      assetPath: (id) =>
        id === 'asset_video_1' ? 'video/001-0006.webm' : undefined,
    });
    expect(md).toContain('🎬 VIDEO segment 00:06–00:12');
    expect(md).toContain('`video/001-0006.webm`');
  });

  it('keeps the video-segment line without a link when its asset is dropped', () => {
    const input = buildSession();
    const events: SessionEvent[] = [
      ev({
        t: 6000,
        type: 'video-segment',
        payload: { tStart: 6000, tEnd: 12000 },
      }),
    ];
    const md = renderReport({ ...input, events, assetPath: () => undefined });
    expect(md).toContain('🎬 VIDEO segment 00:06–00:12');
    expect(md).not.toContain('.webm');
    expect(md).not.toContain('→');
  });

  it('skips screenshots whose asset is not included', () => {
    const input = buildSession();
    const md = renderReport({ ...input, assetPath: () => undefined });
    expect(md).not.toContain('screenshots/001-0004.jpg');
  });

  it('stitches consecutive voice segments into one line with the time span', () => {
    const input = buildSession();
    const events: SessionEvent[] = [
      ev({ t: 5000, type: 'voice-segment', payload: { tStart: 5000, tEnd: 8000, transcript: 'So in this page' } }),
      ev({ t: 8200, type: 'voice-segment', payload: { tStart: 8200, tEnd: 11000, transcript: 'we want a live feed' } }),
      ev({ t: 11200, type: 'voice-segment', payload: { tStart: 11200, tEnd: 33000, transcript: 'as they happen.' } }),
    ];
    const md = renderReport({ ...input, events, assetPath: () => undefined });
    // One stitched blockquote, not three.
    expect(md.match(/🎙️/g)?.length).toBe(1);
    expect(md).toContain('So in this page we want a live feed as they happen.');
    // Time span + total duration at the end.
    expect(md).toContain('(00:05–00:33 · 28s)');
  });

  it('keeps a lone voice segment as a single anchored line', () => {
    const input = buildSession();
    const events: SessionEvent[] = [
      ev({ t: 1000, tabId: 1, type: 'click', payload: { descriptor: { tag: 'button', text: 'Checkout' }, modifiers: [] } }),
      ev({ t: 5000, type: 'voice-segment', payload: { tStart: 5000, tEnd: 8000, transcript: 'A single remark.' } }),
    ];
    const md = renderReport({ ...input, events, assetPath: () => undefined });
    expect(md).toContain('A single remark.');
    // Not stitched: no time-span suffix on a singleton.
    expect(md).not.toContain('·');
  });
});

describe('renderManifest', () => {
  it('lists every included asset with path, kind and size', () => {
    const md = renderManifest(buildSession());
    expect(md).toContain('# Asset Manifest');
    expect(md).toContain('screenshots/001-0004.jpg');
    expect(md).toContain('screenshot');
    expect(md).toContain('1.5 KB');
    expect(md).toContain('network/001-api.example.com-orders.json');
  });

  it('reports no assets when none are included', () => {
    const input = buildSession();
    const md = renderManifest({ ...input, assetPath: () => undefined });
    expect(md).toContain('No assets included');
  });

  it('describes video assets', () => {
    const input = buildSession();
    const assets: AssetMeta[] = [
      {
        id: 'asset_video_1',
        sessionId: SESSION_ID,
        kind: 'video',
        mime: 'video/webm',
        size: 2048,
      },
    ];
    const md = renderManifest({
      ...input,
      assets,
      assetPath: (id) =>
        id === 'asset_video_1' ? 'video/001-0006.webm' : undefined,
    });
    expect(md).toContain('video/001-0006.webm');
    expect(md).toContain('Video segment (video/webm)');
  });
});
