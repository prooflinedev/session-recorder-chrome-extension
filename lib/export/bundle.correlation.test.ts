/**
 * Bundle-level tests for correlation IDs: a failed request captured by the real
 * NetworkCapturer lists its request and trace IDs in report.md at every level,
 * a header the user redacts is never printed, and the IDs stay out of the text
 * sent to the AI model.
 */
import { describe, expect, it, vi } from 'vitest';
import { NetworkCapturer } from '@/lib/capture/network';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import { PROTECTED_TYPES, scoreEvent } from '@/lib/session/events';
import { makeDefaultSettings } from '@/lib/session/settings';
import { summaryEvidence } from '@/lib/sharing/summary';
import type {
  CaptureSettings,
  RawEvent,
  SessionEvent,
  VerbosityLevel,
} from '@/lib/session/types';
import { buildBundle } from './bundle';

const LEVELS: VerbosityLevel[] = ['L0', 'L1', 'L2', 'L3'];
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const AMZN_TRACE = 'Root=1-67891233-abcdef012345678912345678';

/** One failed order request, fed through capture as CDP delivers it. */
async function failedOrderSession(settings: CaptureSettings = makeDefaultSettings()) {
  const fixture = new SessionBuilder({ name: 'Checkout fails', settings })
    .nav('https://shop.example.com/checkout', 'Checkout')
    .click('Place order')
    .build();
  const events: SessionEvent[] = [...fixture.events];
  const capture = new NetworkCapturer({
    send: vi.fn(async () => ({
      body: '{"error":"payment service unavailable"}',
      base64Encoded: false,
    })),
    getSettings: () => settings,
    // Stamp the event the way the background funnel does before it stores it.
    emit: (raw: RawEvent) => {
      events.push({
        ...raw,
        id: `evt_net_${events.length}`,
        sessionId: fixture.session.id,
        t: 12_000,
        importance: scoreEvent(raw),
        protected: PROTECTED_TYPES.has(raw.type),
      } as SessionEvent);
    },
    storeBodyAsset: vi.fn(async () => 'asset-1'),
    sessionStart: () => fixture.session.startedAt,
  });
  capture.handle(1, 'Network.requestWillBeSent', {
    requestId: 'r-order',
    request: {
      method: 'POST',
      url: 'https://shop.example.com/api/orders',
      headers: { 'content-type': 'application/json', traceparent: TRACEPARENT },
      postData: '{"cart":"c1"}',
    },
    type: 'Fetch',
  });
  capture.handle(1, 'Network.responseReceived', {
    requestId: 'r-order',
    response: {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'content-type': 'application/json',
        'X-Request-Id': '5f1c0a52',
        'x-amzn-trace-id': AMZN_TRACE,
      },
      mimeType: 'application/json',
    },
    type: 'Fetch',
  });
  capture.handle(1, 'Network.loadingFinished', { requestId: 'r-order' });
  await vi.waitFor(() =>
    expect(events.some((e) => e.type === 'net-request')).toBe(true),
  );
  return { ...fixture, events };
}

async function reportAt(
  session: Awaited<ReturnType<typeof failedOrderSession>>,
  level: VerbosityLevel,
): Promise<{ report: string; sessionJson: string }> {
  const files = await buildBundle({ ...session, level });
  return {
    report: files.find((f) => f.path === 'report.md')!.text!,
    sessionJson: files.find((f) => f.path === 'session.json')!.text!,
  };
}

describe('bundle correlation IDs', () => {
  it('lists the IDs of a captured failed request in report.md at every level', async () => {
    const session = await failedOrderSession();
    for (const level of LEVELS) {
      const { report, sessionJson } = await reportAt(session, level);
      expect(report, level).toContain(
        [
          '🌐 503 POST /api/orders',
          `- response correlation IDs: \`x-request-id: 5f1c0a52\`, \`x-amzn-trace-id: ${AMZN_TRACE}\``,
          `- request correlation IDs: \`traceparent: ${TRACEPARENT}\``,
        ].join('\n'),
      );
      // The report adds nothing the bundle did not already hold.
      expect(sessionJson, level).toContain('5f1c0a52');
      expect(sessionJson, level).toContain(TRACEPARENT);
    }
  });

  it('never prints a header the user chose to redact', async () => {
    const settings = makeDefaultSettings();
    settings.customRedaction.headerNames = ['x-request-id'];
    const session = await failedOrderSession(settings);
    for (const level of LEVELS) {
      const { report, sessionJson } = await reportAt(session, level);
      expect(report, level).not.toContain('5f1c0a52');
      expect(sessionJson, level).not.toContain('5f1c0a52');
      expect(report, level).not.toContain('x-request-id');
      expect(report, level).toContain(
        `- response correlation IDs: \`x-amzn-trace-id: ${AMZN_TRACE}\``,
      );
    }
  });

  it('keeps the IDs out of the text sent to the AI model', async () => {
    const session = await failedOrderSession();
    const evidence = summaryEvidence(session.session, session.events, []);
    expect(evidence).toContain('POST https://shop.example.com/api/orders: 503');
    expect(evidence).not.toContain('correlation IDs');
    expect(evidence).not.toContain('5f1c0a52');
    expect(evidence).not.toContain(AMZN_TRACE);
    expect(evidence).not.toContain(TRACEPARENT);
  });
});
