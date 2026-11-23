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
  return assets.map(({ blob: _blob, ...meta }) => meta);
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
 *
 * A failed write does not stop later writes: its events go back to the front
 * of the buffer and the next flush retries them. While writes keep failing,
 * at most `maxPending` events wait; the oldest beyond that are dropped and
 * counted in `dropped`.
 */
export class EventWriter {
  private buffer: SessionEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly maxPending: number;
  private readonly write: (events: SessionEvent[]) => Promise<void>;
  private readonly onFlush: ((n: number) => void) | undefined;
  private readonly onError: ((error: unknown, pending: number) => void) | undefined;
  /** Serializes flushes so batches are written in order. Never rejects. */
  private chain: Promise<void> = Promise.resolve();
  /** True after a failed write; retries then wait for the idle timer. */
  private failing = false;
  private droppedCount = 0;

  constructor(opts?: {
    flushMs?: number;
    maxBatch?: number;
    /** Most events kept while writes are failing (default 5000). */
    maxPending?: number;
    /** Persists a batch (default `appendEvents`). */
    write?: (events: SessionEvent[]) => Promise<void>;
    onFlush?: (n: number) => void;
    /** Called after a failed write with the number of events still waiting. */
    onError?: (error: unknown, pending: number) => void;
  }) {
    this.flushMs = opts?.flushMs ?? 1000;
    this.maxBatch = opts?.maxBatch ?? 50;
    this.maxPending = opts?.maxPending ?? 5000;
    this.write = opts?.write ?? appendEvents;
    this.onFlush = opts?.onFlush;
    this.onError = opts?.onError;
  }

  /** Events dropped because too many were waiting for storage to recover. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Buffer an event; auto-flush when full, else arm the idle timer. */
  add(e: SessionEvent): void {
    this.buffer.push(e);
    if (this.buffer.length >= this.maxBatch && !this.failing) {
      this.flushInBackground();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushInBackground();
      }, this.flushMs);
    }
  }

  /**
   * Write all buffered events after any earlier write settles. Rejects if
   * this write fails; the events stay buffered for the next flush.
   */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const run = this.chain.then(() => this.writeBuffered());
    this.chain = run.catch(() => {});
    return run;
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
    this.flushInBackground();
  }

  /** Flush without a caller to handle failure; `onError` reports it. */
  private flushInBackground(): void {
    this.flush().catch(() => {});
  }

  private async writeBuffered(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.write(batch);
    } catch (error) {
      this.failing = true;
      this.buffer = batch.concat(this.buffer);
      const excess = this.buffer.length - this.maxPending;
      if (excess > 0) {
        this.buffer.splice(0, excess);
        this.droppedCount += excess;
      }
      this.onError?.(error, this.buffer.length);
      throw error;
    }
    this.failing = false;
    this.onFlush?.(batch.length);
  }
}
