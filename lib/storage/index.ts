/**
 * IndexedDB persistence layer for recorded sessions.
 *
 * Owns the `session-recorder` database (via the `idb` wrapper) and exposes typed
 * CRUD for sessions, events, and assets plus the batched `EventWriter` used by
 * the background capture funnel. The DB handle is opened lazily and memoized.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Asset,
  AssetMeta,
  Session,
  SessionEvent,
} from '@/lib/session/types';
import { toAssetMeta } from '@/lib/session/asset-meta';
import type { RedactionRect } from '@/lib/session/types';

// ----------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------

const DB_NAME = 'session-recorder';
const DB_VERSION = 1;

interface RecorderDB extends DBSchema {
  sessions: {
    key: string;
    value: Session;
  };
  events: {
    key: string;
    value: SessionEvent;
    indexes: { 'by-session': [string, number] };
  };
  assets: {
    key: string;
    value: Asset;
    indexes: { 'by-session': string };
  };
}

let dbPromise: Promise<IDBPDatabase<RecorderDB>> | undefined;

/** Open (and memoize) the database, creating the object stores on first use. */
function db(): Promise<IDBPDatabase<RecorderDB>> {
  if (!dbPromise) {
    dbPromise = openDB<RecorderDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore('sessions', { keyPath: 'id' });

        const events = database.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('by-session', ['sessionId', 't']);

        const assets = database.createObjectStore('assets', { keyPath: 'id' });
        assets.createIndex('by-session', 'sessionId');
      },
    });
  }
  return dbPromise;
}

// ----------------------------------------------------------------------------
// Sessions
// ----------------------------------------------------------------------------

export async function createSession(s: Session): Promise<void> {
  await (await db()).put('sessions', s);
}

export async function updateSession(s: Session): Promise<void> {
  await (await db()).put('sessions', s);
}

export async function getSession(id: string): Promise<Session | undefined> {
  return (await db()).get('sessions', id);
}

/** Apply an asynchronous suggestion without reviving deleted sessions or replacing a manual rename. */
export async function renameSessionIfUnchanged(id: string, previousName: string, name: string): Promise<Session | undefined> {
  const tx = (await db()).transaction('sessions', 'readwrite');
  const session = await tx.store.get(id);
  if (!session || session.name !== previousName || session.status !== 'stopped') {
    await tx.done;
    return undefined;
  }
  const renamed = { ...session, name };
  await tx.store.put(renamed);
  await tx.done;
  return renamed;
}

/** All sessions, newest first (by `startedAt` descending). */
export async function listSessions(): Promise<Session[]> {
  const all = await (await db()).getAll('sessions');
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

/** Delete a session and cascade-delete all of its events and assets. */
export async function deleteSession(id: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(['sessions', 'events', 'assets'], 'readwrite');

  await tx.objectStore('sessions').delete(id);

  const eventIndex = tx.objectStore('events').index('by-session');
  const eventRange = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
  for await (const cursor of eventIndex.iterate(eventRange)) {
    await cursor.delete();
  }

  const assetIndex = tx.objectStore('assets').index('by-session');
  for await (const cursor of assetIndex.iterate(id)) {
    await cursor.delete();
  }

  await tx.done;
}

// ----------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------

/** Persist events. Uses `put`, so it doubles as an update-by-id. */
export async function appendEvents(events: SessionEvent[]): Promise<void> {
  if (events.length === 0) return;
  const database = await db();
  const tx = database.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  for (const e of events) {
    await store.put(e);
  }
  await tx.done;
}

/** Events for a session, ordered by `t` ascending. */
export async function getEvents(sessionId: string): Promise<SessionEvent[]> {
  const range = IDBKeyRange.bound(
    [sessionId, -Infinity],
    [sessionId, Infinity],
  );
  return (await db()).getAllFromIndex('events', 'by-session', range);
}

// ----------------------------------------------------------------------------
// Assets
// ----------------------------------------------------------------------------

export async function putAsset(a: Asset): Promise<void> {
  await (await db()).put('assets', a);
}

export async function getAsset(id: string): Promise<Asset | undefined> {
  return (await db()).get('assets', id);
}

export async function getAssets(sessionId: string): Promise<Asset[]> {
  return (await db()).getAllFromIndex('assets', 'by-session', sessionId);
}

/** Asset metadata for a session, with the heavy `.blob` stripped off. */
export async function getAssetsMeta(sessionId: string): Promise<AssetMeta[]> {
  const assets = await getAssets(sessionId);
  return assets.map(toAssetMeta);
}

/** Atomically save a flattened screenshot if no other editor changed it. */
export async function saveScreenshotRedaction(
  assetId: string,
  expectedRevision: number,
  redactedBlob: Blob,
  rectangles: RedactionRect[],
  sha256: string | undefined,
): Promise<Asset> {
  const database = await db();
  const tx = database.transaction(['assets', 'sessions'], 'readwrite');
  const store = tx.objectStore('assets');
  const current = await store.get(assetId);
  if (!current || current.kind !== 'screenshot') {
    await tx.done;
    throw new Error('This screenshot is no longer available. Reload the report and try again.');
  }
  const local = current.localScreenshotRedaction;
  const revision = local?.revision ?? 0;
  if (revision !== expectedRevision) {
    await tx.done;
    throw new Error('This screenshot changed in another window. Reopen Redact to load the latest version.');
  }
  const originalBlob = local?.originalBlob ?? current.blob;
  const originalMime = local?.originalMime ?? current.mime;
  const nextRevision = revision + 1;
  const next: Asset = {
    ...current,
    blob: redactedBlob,
    mime: rectangles.length > 0 ? 'image/png' : originalMime,
    size: redactedBlob.size,
    sha256,
    localScreenshotRedaction: rectangles.length > 0
      ? { originalBlob, originalMime, rectangles, revision: nextRevision }
      : { rectangles: [], revision: nextRevision },
  };
  await store.put(next);
  const sessions = tx.objectStore('sessions');
  const session = await sessions.get(current.sessionId);
  if (session) {
    session.assetBytes = Math.max(0, session.assetBytes - current.size + next.size);
    await sessions.put(session);
  }
  await tx.done;
  return next;
}

// ----------------------------------------------------------------------------
// Storage estimate
// ----------------------------------------------------------------------------

/** Wrap `navigator.storage.estimate()` with a `{usage:0,quota:0}` fallback. */
export async function storageEstimate(): Promise<{
  usage: number;
  quota: number;
}> {
  try {
    const est = await navigator.storage?.estimate?.();
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

// ----------------------------------------------------------------------------
// EventWriter
// ----------------------------------------------------------------------------

/**
 * In-memory buffer for events, flushed to IndexedDB in batches. Auto-flushes
 * when `maxBatch` events are buffered or after `flushMs` of inactivity, so the
 * background funnel never blocks on a write per event.
 */
export class EventWriter {
  private buffer: SessionEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly onFlush: ((n: number) => void) | undefined;
  /** Serializes flushes so batches are written in order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts?: {
    flushMs?: number;
    maxBatch?: number;
    onFlush?: (n: number) => void;
  }) {
    this.flushMs = opts?.flushMs ?? 1000;
    this.maxBatch = opts?.maxBatch ?? 50;
    this.onFlush = opts?.onFlush;
  }

  /** Buffer an event; auto-flush when full, else arm the idle timer. */
  add(e: SessionEvent): void {
    this.buffer.push(e);
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushMs);
    }
  }

  /** Force-write all buffered events now. */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return this.chain;

    const batch = this.buffer;
    this.buffer = [];

    this.chain = this.chain
      .then(() => appendEvents(batch))
      .then(() => {
        this.onFlush?.(batch.length);
      });
    return this.chain;
  }

  size(): number {
    return this.buffer.length;
  }

  /** Clear the timer and flush any pending events (best-effort). */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.flush();
  }
}
