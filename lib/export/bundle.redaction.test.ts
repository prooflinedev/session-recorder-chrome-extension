// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { buildBundle } from './bundle';
import { buildHostedReport } from '@/lib/sharing/report';
import { buildReportHtml } from './report-html';
import { toAssetMeta } from '@/lib/session/asset-meta';
import { makeDefaultSettings } from '@/lib/session/settings';
import type { Asset, Session, SessionEvent } from '@/lib/session/types';

const session: Session = {
  id: 'redaction-session',
  name: 'Screenshot redaction',
  startedAt: 1_000,
  endedAt: 2_000,
  initialUrl: 'https://example.test',
  tabs: [{ tabId: 1, url: 'https://example.test', title: 'Example', attachedAt: 1_000, role: 'primary', attached: true }],
  settings: makeDefaultSettings(),
  status: 'stopped',
  counts: { screenshot: 1 },
  assetBytes: 10,
};
const event: SessionEvent = {
  id: 'redaction-shot',
  sessionId: session.id,
  t: 1_200,
  tabId: 1,
  type: 'screenshot',
  importance: 30,
  payload: { assetId: 'shot', width: 2, height: 2, trigger: 'manual' },
};

describe('redacted screenshot export privacy', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('exports only the flattened image and excludes local source data from metadata and reports', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const source = new Blob(['LOCAL-ORIGINAL-SECRET'], { type: 'image/jpeg' });
    const redactedBytes = new TextEncoder().encode('PNG-FLATTENED-REDACTED');
    const redacted = new Blob([redactedBytes], { type: 'image/png' });
    const asset: Asset = {
      id: 'shot',
      sessionId: session.id,
      kind: 'screenshot',
      mime: 'image/png',
      size: redacted.size,
      sha256: 'updated-hash',
      blob: redacted,
      localScreenshotRedaction: {
        originalBlob: source,
        originalMime: 'image/jpeg',
        rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
        revision: 1,
      },
    };

    expect(toAssetMeta(asset)).not.toHaveProperty('localScreenshotRedaction');
    expect(toAssetMeta(asset)).not.toHaveProperty('blob');
    const files = await buildBundle({ session, events: [event], assets: [asset], level: 'L0' });
    const image = files.find((file) => file.path.startsWith('screenshots/'))!;
    expect(image.path).toMatch(/\.png$/);
    expect(new TextDecoder().decode(image.bytes)).toBe('PNG-FLATTENED-REDACTED');
    const serialized = files.filter((file) => file.text).map((file) => file.text).join('\n');
    expect(serialized).not.toContain('LOCAL-ORIGINAL-SECRET');
    expect(serialized).not.toContain('localScreenshotRedaction');
    expect(serialized).not.toContain('originalBlob');

    const hosted = await buildHostedReport({ session, events: [event], assets: [asset], level: 'L0' });
    const hostedSerialized = hosted.filter((file) => file.text).map((file) => file.text).join('\n');
    expect(hostedSerialized).not.toContain('LOCAL-ORIGINAL-SECRET');
    expect(hostedSerialized).not.toContain('localScreenshotRedaction');
    expect(hosted.find((file) => file.path.startsWith('screenshots/'))?.path).toMatch(/\.png$/);

    const embedded = buildReportHtml({
      session,
      events: [event],
      assets: [toAssetMeta(asset)],
      level: 'L0',
      imageUrl: () => `data:image/png;base64,${Buffer.from(redactedBytes).toString('base64')}`,
      sanitize: (html) => html,
    });
    expect(embedded).toContain(Buffer.from(redactedBytes).toString('base64'));
    expect(embedded).not.toContain('LOCAL-ORIGINAL-SECRET');
    expect(embedded).not.toContain('originalBlob');
  });
});
