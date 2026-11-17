import type { EventType, RawEvent, SessionEvent } from './types';

/** Speech dictated into a page comment; the annotation carries its text, so it is not narration. */
export function isDictatedSpeech(e: SessionEvent): boolean {
  return e.type === 'voice-segment' && e.payload.dictation === true;
}

/**
 * Static importance baseline per event type. Higher = more likely to survive
 * trimming. Payload-aware adjustments happen in `scoreEvent`.
 *
 * Ordering rationale (PLAN.md §5):
 *   user signals > errors > mutating requests > nav > clicks > GETs > assets > scroll
 */
export const IMPORTANCE_BASE: Record<EventType, number> = {
  marker: 100,
  note: 100,
  annotation: 95,
  'annotation-start': 40,
  'voice-segment': 90,
  error: 85,
  'file-captured': 80,
  'file-attached': 80,
  'session-note': 70,
  'video-segment': 60,
  nav: 60,
  'spa-route': 58,
  'tab-opened': 55,
  'tab-switch': 50,
  'tab-closed': 50,
  'net-request': 45, // adjusted by method/status below
  click: 40,
  key: 35,
  input: 38,
  'text-select': 30,
  screenshot: 30, // adjusted by trigger below
  console: 25, // adjusted by level below
  hover: 12,
  scroll: 10,
};

/**
 * Event types that are NEVER dropped or compacted by the trimmer. These are the
 * user's explicit signals plus errors — the whole point of the recording.
 */
export const PROTECTED_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'marker',
  'note',
  'annotation',
  'voice-segment',
  'error',
  'file-captured',
  'file-attached',
  'session-note',
]);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Compute the static importance score for a raw event, refining the per-type
 * baseline using the payload (request method/status, console level, screenshot
 * trigger). Called by the background funnel exactly once per event.
 */
export function scoreEvent(raw: RawEvent): number {
  let score = IMPORTANCE_BASE[raw.type];

  switch (raw.type) {
    case 'net-request': {
      const p = raw.payload as import('./types').NetRequestPayload;
      if (p.failed) score += 40;
      if (typeof p.status === 'number' && p.status >= 400) score += 35;
      if (MUTATING_METHODS.has((p.method || '').toUpperCase())) score += 15;
      if (p.websocket) score += 5;
      break;
    }
    case 'console': {
      const p = raw.payload as import('./types').ConsolePayload;
      if (p.level === 'error') score += 60;
      else if (p.level === 'warn') score += 20;
      break;
    }
    case 'screenshot': {
      const p = raw.payload as import('./types').ScreenshotPayload;
      if (p.trigger === 'annotation' || p.trigger === 'manual') score += 40;
      else if (p.trigger === 'error') score += 35;
      else if (p.trigger === 'nav') score += 15;
      break;
    }
    default:
      break;
  }
  return score;
}

/** Whether a fully-materialized event is protected from trimming. */
export function isProtected(e: SessionEvent): boolean {
  if (e.protected) return true;
  return PROTECTED_TYPES.has(e.type);
}

/**
 * Exhaustiveness guard. Referencing `assertNever(x)` in the `default` branch of a
 * switch over `EventType` turns a forgotten case into a compile error — this is
 * the "event funnel discipline" enforcement from IMPLEMENTATION.md.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled event variant: ${JSON.stringify(x)}`);
}

export const ALL_EVENT_TYPES: readonly EventType[] = Object.keys(
  IMPORTANCE_BASE,
) as EventType[];
