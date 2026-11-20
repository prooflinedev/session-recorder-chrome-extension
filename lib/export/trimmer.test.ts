/**
 * Tests for the verbosity trimmer: monotonic size reduction across levels,
 * survival of protected events at every level, and collapse of repeated
 * requests. Built on the synthetic `SessionBuilder` fixture.
 */

import { describe, expect, it } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import { isProtected } from '@/lib/session/events';
import type {
  AssetMeta,
  SessionEvent,
  VerbosityLevel,
} from '@/lib/session/types';
import {
  applyLevel,
  collapseRepeatedRequests,
  dedupConsole,
  type TrimContext,
} from './trimmer';

/** Rendered-size proxy: serialized length of the event stream. */
const sizeOf = (events: SessionEvent[]): number =>
  JSON.stringify(events).length;

/** A moderate (<4KB) but valid JSON body so shape-summary can parse it. */
function jsonBody(n: number): string {
  return JSON.stringify({
    items: Array.from({ length: n }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      value: i * 7,
    })),
  });
}

function buildFixture(): {
  events: SessionEvent[];
  ctx: TrimContext;
} {
  const b = new SessionBuilder();

  b.nav('https://app.example.com/dashboard', 'Dashboard');
  b.screenshot('nav');

  // Rich interaction descriptors (stripped at L3).
  b.click('Open orders');
  b.input('search', 'widgets');

  // A settled text selection and its deselection: the selection survives
  // through L2, the cleared marker is dropped at L1+, both are gone at L3.
  b.textSelect('the quarterly revenue figure');
  b.textSelect('', { cleared: true });

  // Static assets + analytics noise → dropped at L1.
  b.net('GET', 'https://cdn.example.com/logo.png', {
    status: 200,
    mime: 'image/png',
  });
  b.net('GET', 'https://cdn.example.com/app.css', {
    status: 200,
    mime: 'text/css',
  });
  b.net('GET', 'https://www.google-analytics.com/collect?v=1', {
    status: 200,
  });

  // A mutating request with a JSON body → truncate/shape/drop across levels.
  b.net('POST', 'https://api.example.com/api/orders', {
    status: 201,
    reqBody: jsonBody(60),
    resBody: jsonBody(60),
    mime: 'application/json',
  });

  // Repeated GETs on the same templated path → collapsed at L2.
  for (const id of [1, 2, 3, 4]) {
    b.net('GET', `https://api.example.com/api/users/${id}`, {
      status: 200,
      resBody: '{"ok":true}',
      mime: 'application/json',
    });
  }

  // Consecutive duplicate console logs → deduped at L1.
  b.consoleLog('log', 'render tick');
  b.consoleLog('log', 'render tick');
  b.consoleLog('log', 'render tick');

  // A run of scrolls → coalesced at L1.
  b.scroll();
  b.scroll();
  b.scroll();
  b.scroll();

  // Plain interaction screenshots → dropped at L1.
  b.screenshot('interaction');
  b.screenshot('interaction');
  // Kept through L2 by annotation/error triggers, dropped at L3 (manifest-only).
  b.screenshot('annotation');
  b.screenshot('error');

  // A video take: the event line survives every level, the file only L0/L1.
  b.video(6000, 12000);

  // Protected signals — must survive every level verbatim.
  b.marker('Checkpoint');
  b.note('remember this step');
  b.error('Boom: something failed');
  b.annotation([{ tool: 'rect' }]);
  b.voice('spoken walkthrough', 1000, 4000);
  b.file('import.csv', 2048);

  const { session, events, assets } = b.build();
  const assetsById = new Map<string, AssetMeta>(
    assets.map((a) => {
      const { blob: _blob, ...meta } = a;
      return [a.id, meta];
    }),
  );
  return { events, ctx: { assetsById, settings: session.settings } };
}

describe('trimmer', () => {
  it('reduces rendered size at each higher verbosity level', () => {
    const { events, ctx } = buildFixture();
    const levels: VerbosityLevel[] = ['L0', 'L1', 'L2', 'L3'];
    const sizes = levels.map((lvl) => sizeOf(applyLevel(events, lvl, ctx)));
    const [s0, s1, s2, s3] = sizes as [number, number, number, number];

    expect(s1).toBeLessThan(s0);
    expect(s2).toBeLessThan(s1);
    expect(s3).toBeLessThan(s2);
  });

  it('never mutates the input events', () => {
    const { events, ctx } = buildFixture();
    const snapshot = JSON.stringify(events);
    for (const lvl of ['L1', 'L2', 'L3'] as VerbosityLevel[]) {
      applyLevel(events, lvl, ctx);
    }
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it('keeps every protected event at all levels', () => {
    const { events, ctx } = buildFixture();
    const protectedIds = events.filter(isProtected).map((e) => e.id);
    // Sanity: fixture actually contains protected events.
    expect(protectedIds.length).toBeGreaterThanOrEqual(6);

    for (const lvl of ['L0', 'L1', 'L2', 'L3'] as VerbosityLevel[]) {
      const out = applyLevel(events, lvl, ctx);
      const ids = new Set(out.map((e) => e.id));
      for (const pid of protectedIds) {
        expect(ids.has(pid)).toBe(true);
      }
    }
  });

  it('keeps selections through L2, drops cleared at L1+, drops all at L3', () => {
    const { events, ctx } = buildFixture();
    const selections = (evts: SessionEvent[]) =>
      evts.filter((e) => e.type === 'text-select');

    // Sanity: fixture holds one selection + one cleared marker.
    const all = selections(events);
    expect(all.length).toBe(2);
    expect(all.filter((e) => e.type === 'text-select' && e.payload.cleared).length).toBe(1);

    const l0 = selections(applyLevel(events, 'L0', ctx));
    expect(l0.length).toBe(2);

    for (const lvl of ['L1', 'L2'] as VerbosityLevel[]) {
      const out = selections(applyLevel(events, lvl, ctx));
      expect(out.length).toBe(1);
      const only = out[0];
      expect(only && only.type === 'text-select' && only.payload.cleared).toBe(false);
      expect(
        only && only.type === 'text-select' ? only.payload.text : undefined,
      ).toBe('the quarterly revenue figure');
    }

    expect(selections(applyLevel(events, 'L3', ctx)).length).toBe(0);
  });

  it('text-select events are not protected', () => {
    const { events } = buildFixture();
    for (const e of events) {
      if (e.type === 'text-select') expect(isProtected(e)).toBe(false);
    }
  });

  it('keeps video segments at every level but drops the file at L2+', () => {
    const { events, ctx } = buildFixture();
    const vids = (evts: SessionEvent[]) =>
      evts.filter(
        (e): e is Extract<SessionEvent, { type: 'video-segment' }> =>
          e.type === 'video-segment',
      );
    expect(vids(events).length).toBe(1);

    for (const lvl of ['L0', 'L1'] as VerbosityLevel[]) {
      const out = vids(applyLevel(events, lvl, ctx));
      expect(out.length).toBe(1);
      expect(out[0]?.payload.assetId).toBeTruthy();
    }
    for (const lvl of ['L2', 'L3'] as VerbosityLevel[]) {
      const out = vids(applyLevel(events, lvl, ctx));
      expect(out.length).toBe(1);
      expect(out[0]?.payload.assetId).toBeUndefined();
      // The span survives so the report line still reads correctly.
      expect(out[0]?.payload.tStart).toBe(6000);
      expect(out[0]?.payload.tEnd).toBe(12000);
    }
  });

  it('collapses repeated requests into a single marker event', () => {
    const { events, ctx } = buildFixture();

    const isUsersReq = (e: SessionEvent): boolean =>
      e.type === 'net-request' && e.payload.url.includes('/api/users/');

    const before = events.filter(isUsersReq).length;
    expect(before).toBe(4);

    const out = collapseRepeatedRequests()(events, ctx);
    const after = out.filter(isUsersReq).length;
    expect(after).toBeLessThan(before);

    const collapsedMarkers = out.filter(
      (e) => e.type === 'net-request' && e.payload.collapsed !== undefined,
    );
    expect(collapsedMarkers.length).toBe(1);
    const marker = collapsedMarkers[0];
    if (marker && marker.type === 'net-request' && marker.payload.collapsed) {
      expect(marker.payload.collapsed.count).toBeGreaterThan(0);
      expect(Array.isArray(marker.payload.collapsed.statuses)).toBe(true);
    }
  });
});

describe('dedupConsole', () => {
  const { ctx } = buildFixture();
  const consoleEvent = (
    t: number,
    text: string,
    extra: { repeat?: number; repeatSpanMs?: number } = {},
  ): SessionEvent =>
    ({
      id: `evt-${t}`,
      sessionId: 's',
      t,
      type: 'console',
      payload: { level: 'error', text, ...extra },
      importance: 10,
      protected: false,
    }) as SessionEvent;

  it('merges runs into one event spanning all of them', () => {
    // The capturer flushed one run of 3 (spanning 400 ms), then two singles.
    const out = dedupConsole()([
      consoleEvent(1_000, 'sync failed', { repeat: 3, repeatSpanMs: 400 }),
      consoleEvent(2_500, 'sync failed'),
      consoleEvent(3_800, 'sync failed'),
    ], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.t).toBe(1_000);
    expect(out[0]!.payload).toMatchObject({ repeat: 5, repeatSpanMs: 2_800 });
  });

  it('keeps the span of a run that ends a merge', () => {
    const out = dedupConsole()([
      consoleEvent(1_000, 'x'),
      consoleEvent(2_000, 'x', { repeat: 4, repeatSpanMs: 1_500 }),
    ], ctx);
    expect(out[0]!.payload).toMatchObject({ repeat: 5, repeatSpanMs: 2_500 });
  });

  it('keeps an earlier run that ends after the event that follows it', () => {
    const out = dedupConsole()([
      consoleEvent(1_000, 'x', { repeat: 6, repeatSpanMs: 4_000 }),
      consoleEvent(2_000, 'x'),
    ], ctx);
    expect(out[0]!.payload).toMatchObject({ repeat: 7, repeatSpanMs: 4_000 });
  });

  it('does not invent a span for a lone event', () => {
    const out = dedupConsole()([consoleEvent(1_000, 'a'), consoleEvent(1_200, 'b')], ctx);
    expect(out.map((e) => (e.payload as { repeatSpanMs?: number }).repeatSpanMs)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
