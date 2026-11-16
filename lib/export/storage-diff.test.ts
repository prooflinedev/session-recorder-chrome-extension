/**
 * Storage start/stop comparison, its trimming and its report rendering.
 */

import { describe, expect, it } from 'vitest';
import { SessionBuilder } from '@/lib/fixtures/session-builder';
import type { SessionEvent, StorageEntry } from '@/lib/session/types';
import { renderReport } from './markdown';
import { buildReportHtml } from './report-html';
import { diffStorageEntries, storageByOrigin } from './storage-diff';
import { applyLevel } from './trimmer';

/** Fixture entry; any string that differs per value works as its hash. */
const entry = (
  area: StorageEntry['area'],
  key: string,
  value: string,
  over: Partial<StorageEntry> = {},
): StorageEntry => ({
  area,
  key,
  value,
  size: value.length,
  hash: `h:${value}`,
  ...over,
});

const ORIGIN = 'https://app.example.com';

function fixture() {
  return new SessionBuilder()
    .storage('start', ORIGIN, [
      entry('localStorage', 'flags', '{"newCheckout":false}'),
      entry('localStorage', 'theme', 'dark'),
      entry('sessionStorage', 'draft', 'hello'),
    ])
    .click('Place order')
    .storage('stop', ORIGIN, [
      entry('localStorage', 'cart', '[1]'),
      entry('localStorage', 'flags', '{"newCheckout":true}'),
      entry('localStorage', 'theme', 'dark'),
    ])
    .build();
}

const kinds = (events: SessionEvent[]) =>
  storageByOrigin(events)[0]!.changes?.map((c) => `${c.kind} ${c.area}:${c.key}`);

const report = (built: ReturnType<SessionBuilder['build']>, level: 'L0' | 'L2' | 'L3' = 'L0') =>
  renderReport({ ...built, level, assetPath: () => undefined });

describe('diffStorageEntries', () => {
  it('lists added, changed and removed entries in area/key order', () => {
    const { events } = fixture();
    const [start, stop] = events.filter((e) => e.type === 'storage-snapshot');
    if (start?.type !== 'storage-snapshot' || stop?.type !== 'storage-snapshot') throw new Error();
    const changes = diffStorageEntries(start.payload.entries, stop.payload.entries);
    expect(changes.map((c) => `${c.kind} ${c.area}:${c.key}`)).toEqual([
      'added localStorage:cart',
      'changed localStorage:flags',
      'removed sessionStorage:draft',
    ]);
  });

  it('treats the same key in different areas as different entries', () => {
    const changes = diffStorageEntries(
      [entry('localStorage', 'x', '1')],
      [entry('cookie', 'x', '1')],
    );
    // localStorage sorts before cookie.
    expect(changes.map((c) => `${c.kind} ${c.area}`)).toEqual(['removed localStorage', 'added cookie']);
  });

  it('compares same-name cookies as a multiset instead of keeping only the last', () => {
    const changes = diffStorageEntries(
      [entry('cookie', 'pref', 'a'), entry('cookie', 'pref', 'b')],
      [entry('cookie', 'pref', 'c'), entry('cookie', 'pref', 'b')],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'changed', sameName: 2 });
    expect(changes[0]!.before?.value).toBe('a');
    expect(changes[0]!.after?.value).toBe('c');
    // Reordering alone is not a change.
    expect(
      diffStorageEntries(
        [entry('cookie', 'pref', 'a'), entry('cookie', 'pref', 'b')],
        [entry('cookie', 'pref', 'b'), entry('cookie', 'pref', 'a')],
      ),
    ).toEqual([]);
  });
});

describe('storageByOrigin', () => {
  it('pairs the first start and last stop snapshot per origin', () => {
    const { events } = new SessionBuilder()
      .storage('start', ORIGIN, [entry('localStorage', 'a', '1')])
      .storage('start', ORIGIN, [entry('localStorage', 'a', 'ignored')])
      .storage('stop', 'https://auth.example.com', [], { omitted: { localStorage: 3 } })
      .storage('stop', ORIGIN, [entry('localStorage', 'a', '2')])
      .build();
    const rows = storageByOrigin(events);
    expect(rows.map((r) => r.origin)).toEqual([ORIGIN, 'https://auth.example.com']);
    expect(rows[0]!.changes?.map((c) => c.kind)).toEqual(['changed']);
    expect(rows[0]!.changes?.[0]?.before?.value).toBe('1');
    expect(rows[1]!.partial).toBe(true);
    expect(rows[1]!.changes).toBeUndefined();
  });

  it('does not report keys pushed out of a capped window as removed', () => {
    // Start keeps k001..k100 of 150; the app adds `a_new`, which sorts first,
    // so stop keeps a_new and k001..k099. k100 still exists.
    const keys = Array.from({ length: 100 }, (_, i) => `k${String(i + 1).padStart(3, '0')}`);
    const { events } = new SessionBuilder()
      .storage('start', ORIGIN, keys.map((k) => entry('localStorage', k, 'v')), {
        omitted: { localStorage: 50 },
      })
      .storage(
        'stop',
        ORIGIN,
        [entry('localStorage', 'a_new', '1'), ...keys.slice(0, 99).map((k) => entry('localStorage', k, 'v'))],
        { omitted: { localStorage: 51 } },
      )
      .build();
    expect(kinds(events)).toEqual(['added localStorage:a_new']);
    expect(storageByOrigin(events)[0]!.partial).toBe(true);
  });

  it('compares sessionStorage only when start and stop come from the same tab', () => {
    const { events } = new SessionBuilder()
      .storage('start', ORIGIN, [
        entry('localStorage', 'theme', 'dark'),
        entry('sessionStorage', 'draft', 'hello'),
      ], { tabId: 1 })
      .storage('stop', ORIGIN, [entry('localStorage', 'theme', 'light')], { tabId: 2 })
      .build();
    const [row] = storageByOrigin(events);
    expect(row!.sessionStorageSkipped).toBe(true);
    expect(kinds(events)).toEqual(['changed localStorage:theme']);
  });

  it('does not list cookies as added or removed when read at different paths', () => {
    const { events } = new SessionBuilder()
      .storage('start', ORIGIN, [
        entry('cookie', 'cart_id', 'c1'),
        entry('cookie', 'lang', 'en'),
      ], { path: '/app/checkout' })
      .storage('stop', ORIGIN, [entry('cookie', 'lang', 'fr'), entry('cookie', 'root_only', '1')], {
        path: '/',
      })
      .build();
    const [row] = storageByOrigin(events);
    expect(row!.cookiePaths).toEqual({ start: '/app/checkout', stop: '/' });
    expect(kinds(events)).toEqual(['changed cookie:lang']);
  });
});

describe('storage snapshots in report.md', () => {
  it('summarizes the snapshots in the timeline and details them in an appendix', () => {
    const md = report(fixture());
    expect(md).toContain(`🗄️ STORAGE at start (${ORIGIN}): 2 localStorage, 1 sessionStorage key(s)`);
    expect(md).toContain(`🗄️ STORAGE at stop (${ORIGIN}): 1 added, 1 changed, 1 removed since start`);
    expect(md).toContain('## Appendix: Storage State');
    expect(md).toContain('- added localStorage `cart`: `[1]`');
    expect(md).toContain(
      '- changed localStorage `flags`: `{"newCheckout":false}` → `{"newCheckout":true}`',
    );
    expect(md).toContain('- removed sessionStorage `draft` (was `hello`)');
    expect(md).toContain('| localStorage | `theme` | `dark` |');
  });

  it('reports an unchanged origin plainly', () => {
    const same = [entry('localStorage', 'theme', 'dark')];
    const md = report(new SessionBuilder().storage('start', ORIGIN, same).storage('stop', ORIGIN, same).build());
    expect(md).toContain('unchanged since start');
    expect(md).toContain('- No changes.');
  });

  it('says when only a redacted part changed', () => {
    const md = report(
      new SessionBuilder()
        .storage('start', ORIGIN, [entry('localStorage', 'authToken', '«redacted»', { hash: 'h1', redacted: true })])
        .storage('stop', ORIGIN, [entry('localStorage', 'authToken', '«redacted»', { hash: 'h2', redacted: true })])
        .build(),
    );
    expect(md).toContain(
      '- changed localStorage `authToken`: `«redacted»` (the difference is in a redacted or cut part)',
    );
  });

  it('explains what the comparison left out', () => {
    const md = report(
      new SessionBuilder()
        .storage('start', ORIGIN, [entry('sessionStorage', 'draft', 'x'), entry('cookie', 'a', '1')], {
          tabId: 1,
          path: '/app',
        })
        .storage('stop', ORIGIN, [entry('cookie', 'a', '1')], { tabId: 2, path: '/' })
        .build(),
    );
    expect(md).toContain('sessionStorage belongs to one tab, so it was not compared.');
    expect(md).toContain('Cookies were read at different paths (`/app` at start, `/` at stop).');
  });

  it('keeps page-controlled keys and values inert in report.html', () => {
    const built = new SessionBuilder()
      .storage('start', ORIGIN, [
        entry('localStorage', 'draft', '<h1>Title</h1><img src=https://tracker.test/x.png>'),
        entry('localStorage', 'md', '![](https://tracker.test/y.png) | **bold**'),
        entry('localStorage', 'slash', 'x\\|<img src=https://tracker.test/z.png>'),
        entry('localStorage', '<b>key</b>', ''),
      ])
      .build();
    const md = report(built);
    expect(md).toContain('| localStorage | `draft` | `<h1>Title</h1><img src=https://tracker.test/x.png>` |');
    expect(md).toContain('| localStorage | `<b>key</b>` | _(empty)_ |');
    const html = buildReportHtml({
      ...built,
      level: 'L0',
      imageUrl: () => undefined,
      sanitize: (s) => s, // no DOMPurify: the Markdown alone must stay inert
    });
    expect(html).not.toMatch(/<img[^>]*tracker/);
    expect(html).not.toContain('<h1>Title');
    expect(html).not.toContain('<strong>bold');
    expect(html).not.toContain('<b>key');
    expect(html).toContain('&lt;h1&gt;Title&lt;/h1&gt;');
  });

  it('omits the appendix when nothing was captured', () => {
    expect(report(new SessionBuilder().click('Go').build())).not.toContain('Storage State');
  });
});

describe('storage snapshots across export levels', () => {
  const ctx = (session: ReturnType<typeof fixture>['session']) => ({
    settings: session.settings,
    assetsById: new Map(),
  });

  it('L2 shortens values but keeps exact change detection', () => {
    const long = 'v'.repeat(300);
    const built = new SessionBuilder()
      .storage('start', ORIGIN, [entry('localStorage', 'blob', long)])
      .storage('stop', ORIGIN, [entry('localStorage', 'blob', `${long}!`)])
      .build();
    const trimmed = applyLevel(built.events, 'L2', ctx(built.session));
    const snap = trimmed.find((e) => e.type === 'storage-snapshot');
    if (snap?.type !== 'storage-snapshot') throw new Error();
    expect(snap.payload.entries[0]).toMatchObject({ truncated: true });
    expect(snap.payload.entries[0]!.value).toHaveLength(120);
    expect(storageByOrigin(trimmed)[0]!.changes?.map((c) => c.kind)).toEqual(['changed']);
    expect(report({ ...built, events: trimmed }, 'L2')).toContain('(300 chars)');
  });

  it('L3 keeps keys and changes, drops values, and never mutates the input', () => {
    const built = fixture();
    const before = structuredClone(built.events);
    const trimmed = applyLevel(built.events, 'L3', ctx(built.session));
    expect(built.events).toEqual(before);
    const md = report({ ...built, events: trimmed }, 'L3');
    expect(md).toContain('1 added, 1 changed, 1 removed since start');
    expect(md).toContain('- changed localStorage `flags`: _(value omitted at this level)_');
    expect(md).not.toContain('newCheckout');
  });
});
