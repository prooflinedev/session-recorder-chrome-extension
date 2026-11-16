/**
 * Pure comparison of `storage-snapshot` events (see lib/capture/storage.ts).
 *
 * Pairs each origin's first start snapshot with its last stop snapshot and
 * lists what the session added, changed or removed. Changes are detected by the
 * entry hash, so they survive truncated values and keys-only export levels.
 * Never mutates its inputs.
 *
 * A key missing from one snapshot is only reported as added or removed when
 * that snapshot would have listed it. Three things limit that:
 * - the per-area cap: a capped area covers keys up to its last kept key;
 * - cookie paths: `document.cookie` lists only cookies whose path matches the
 *   page, so cookie lists read at different paths are not compared key by key;
 * - sessionStorage belongs to one tab, so it is compared only when start and
 *   stop were read in the same tab.
 */

import type {
  SessionEvent,
  StorageArea,
  StorageEntry,
  StorageSnapshotPayload,
} from '@/lib/session/types';

export type StorageSnapshotEvent = Extract<SessionEvent, { type: 'storage-snapshot' }>;

export interface StorageChange {
  kind: 'added' | 'changed' | 'removed';
  area: StorageArea;
  key: string;
  before?: StorageEntry;
  after?: StorageEntry;
  /** Entries sharing this area and key in the larger snapshot, when more than one (same-name cookies). */
  sameName?: number;
}

export interface OriginStorage {
  origin: string;
  start?: StorageSnapshotEvent;
  stop?: StorageSnapshotEvent;
  /** Present only when both snapshots exist. */
  changes?: StorageChange[];
  /** True when either snapshot hit the per-area cap, so keys past it were not compared. */
  partial: boolean;
  /** True when start and stop were read in different tabs, so sessionStorage was not compared. */
  sessionStorageSkipped?: boolean;
  /** Set when cookies were read at different page paths, so cookies seen at only one were not compared. */
  cookiePaths?: { start: string; stop: string };
}

/** Whether a snapshot would have listed every entry with this area and key. */
export type Coverage = (area: StorageArea, key: string) => boolean;

const AREA_ORDER: Record<StorageArea, number> = {
  localStorage: 0,
  sessionStorage: 1,
  cookie: 2,
};

const entryKey = (e: Pick<StorageEntry, 'area' | 'key'>): string => `${e.area}\n${e.key}`;

interface Group {
  area: StorageArea;
  key: string;
  before: StorageEntry[];
  after: StorageEntry[];
}

/**
 * Added, changed and removed entries between two snapshots, sorted by area then
 * key. Entries sharing an area and key (same-name cookies) are compared as a
 * multiset: equal values cancel out and the rest pair up in order. A key absent
 * from one side is reported only when that side's coverage includes it.
 */
export function diffStorageEntries(
  before: readonly StorageEntry[],
  after: readonly StorageEntry[],
  coverage: { before?: Coverage; after?: Coverage } = {},
): StorageChange[] {
  const groups = new Map<string, Group>();
  const group = (e: StorageEntry): Group => {
    const k = entryKey(e);
    let g = groups.get(k);
    if (!g) {
      g = { area: e.area, key: e.key, before: [], after: [] };
      groups.set(k, g);
    }
    return g;
  };
  for (const e of before) group(e).before.push(e);
  for (const e of after) group(e).after.push(e);

  const changes: StorageChange[] = [];
  for (const g of groups.values()) {
    const { area, key } = g;
    const b = [...g.before];
    const a = [...g.after];
    for (let i = b.length - 1; i >= 0; i -= 1) {
      const j = a.findIndex((x) => x.hash === b[i]!.hash);
      if (j !== -1) {
        b.splice(i, 1);
        a.splice(j, 1);
      }
    }
    const count = Math.max(g.before.length, g.after.length);
    const same = count > 1 ? { sameName: count } : {};
    const paired = Math.min(a.length, b.length);
    for (let i = 0; i < paired; i += 1) {
      changes.push({ kind: 'changed', area, key, before: b[i], after: a[i], ...same });
    }
    if (coverage.before?.(area, key) ?? true) {
      for (const x of a.slice(paired)) changes.push({ kind: 'added', area, key, after: x, ...same });
    }
    if (coverage.after?.(area, key) ?? true) {
      for (const x of b.slice(paired)) changes.push({ kind: 'removed', area, key, before: x, ...same });
    }
  }
  return changes.sort(
    (x, y) =>
      AREA_ORDER[x.area] - AREA_ORDER[y.area] ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );
}

/**
 * Which keys a snapshot can speak for. A capped area covers keys up to its last
 * kept key (the page sorts every key before capping); cookies are not covered
 * when the two snapshots were read at different paths.
 */
export function snapshotCoverage(p: StorageSnapshotPayload, cookiesComparable: boolean): Coverage {
  const last = new Map<StorageArea, string>();
  for (const e of p.entries) {
    const prev = last.get(e.area);
    if (prev === undefined || e.key > prev) last.set(e.area, e.key);
  }
  return (area, key) => {
    if (area === 'cookie' && !cookiesComparable) return false;
    if (!p.omitted?.[area]) return true;
    const edge = last.get(area);
    return edge !== undefined && key <= edge;
  };
}

const hasArea = (p: StorageSnapshotPayload, area: StorageArea): boolean =>
  p.entries.some((e) => e.area === area) || Boolean(p.omitted?.[area]);

/**
 * Group storage snapshots by origin, in order of first appearance. Uses the
 * first start snapshot and the last stop snapshot of each origin.
 */
export function storageByOrigin(events: readonly SessionEvent[]): OriginStorage[] {
  const byOrigin = new Map<string, OriginStorage>();
  const sorted = events
    .filter((e): e is StorageSnapshotEvent => e.type === 'storage-snapshot')
    .sort((a, b) => a.t - b.t);
  for (const e of sorted) {
    const origin = e.payload.origin;
    let row = byOrigin.get(origin);
    if (!row) {
      row = { origin, partial: false };
      byOrigin.set(origin, row);
    }
    if (e.payload.phase === 'start') row.start ??= e;
    else row.stop = e;
  }
  for (const row of byOrigin.values()) {
    const omitted = (s?: StorageSnapshotEvent) =>
      Object.values(s?.payload.omitted ?? {}).some((n) => (n ?? 0) > 0);
    row.partial = omitted(row.start) || omitted(row.stop);
    if (!row.start || !row.stop) continue;

    const start = row.start.payload;
    const stop = row.stop.payload;
    const sameTab = row.start.tabId === row.stop.tabId;
    const samePath = start.path === stop.path;
    if (!sameTab && (hasArea(start, 'sessionStorage') || hasArea(stop, 'sessionStorage'))) {
      row.sessionStorageSkipped = true;
    }
    if (!samePath && (hasArea(start, 'cookie') || hasArea(stop, 'cookie'))) {
      row.cookiePaths = { start: start.path, stop: stop.path };
    }
    const keep = (e: StorageEntry) => sameTab || e.area !== 'sessionStorage';
    row.changes = diffStorageEntries(start.entries.filter(keep), stop.entries.filter(keep), {
      before: snapshotCoverage(start, samePath),
      after: snapshotCoverage(stop, samePath),
    });
  }
  return [...byOrigin.values()];
}
