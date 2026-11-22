export type ConsoleSeverity = 'error' | 'warning' | 'diagnostic';

export interface ConsoleOccurrence {
  id: string;
  time: number;
  severity: ConsoleSeverity;
  origin: string;
  message: string;
  stack: string;
  source: string;
  count: number;
}

const consoleLevels: Record<string, ConsoleSeverity> = {
  error: 'error', warn: 'warning', warning: 'warning',
  log: 'diagnostic', info: 'diagnostic', debug: 'diagnostic', trace: 'diagnostic',
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeConsoleEvents(events: readonly unknown[]): ConsoleOccurrence[] {
  const occurrences: ConsoleOccurrence[] = [];
  const seen = new Set<string>();
  for (const value of events) {
    const { id, t, type, payload } = record(value);
    if (typeof id !== 'string' || !id || seen.has(id) ||
        typeof t !== 'number' || !Number.isFinite(t) || t < 0) continue;
    const details = record(payload);
    const level = string(details.level);
    const origin = string(details.origin);
    let severity: ConsoleSeverity;
    let message: string;
    if (type === 'console' && Object.hasOwn(consoleLevels, level)) {
      severity = consoleLevels[level]!;
      message = string(details.text);
    } else if (type === 'error' && ['exception', 'console', 'log'].includes(origin)) {
      severity = 'error';
      message = string(details.message);
    } else {
      continue;
    }
    const repeat = details.repeat;
    occurrences.push({
      id, time: t, severity, origin: type === 'console' ? level : origin,
      message, stack: string(details.stack), source: string(details.source),
      count: typeof repeat === 'number' && Number.isSafeInteger(repeat) && repeat > 0 ? repeat : 1,
    });
    seen.add(id);
  }
  return occurrences.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1));
}

export function groupConsoleEvents(events: readonly ConsoleOccurrence[]) {
  const groups = new Map<string, { events: ConsoleOccurrence[]; count: number }>();
  for (const event of events) {
    // Keep numbers, source locations and stack frames. Missing messages cannot establish a match.
    const key = event.message.trim()
      ? JSON.stringify([event.severity, event.origin, event.message.trim(), event.source, event.stack])
      : JSON.stringify([event.id]);
    let group = groups.get(key);
    if (!group) {
      group = { events: [], count: 0 };
      groups.set(key, group);
    }
    group.events.push(event);
    group.count += event.count;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function consoleSeverityCounts(events: readonly ConsoleOccurrence[]) {
  const counts = { error: 0, warning: 0, diagnostic: 0 };
  for (const event of events) counts[event.severity] += event.count;
  return counts;
}

export function consoleBucketSize(duration: number): number {
  if (!Number.isFinite(duration) || duration < 0) return 1000;
  const minimum = Math.max(1000, duration / 24);
  const magnitude = 10 ** Math.floor(Math.log10(minimum));
  return ([1, 2, 5, 10].find((step) => step * magnitude >= minimum) ?? 10) * magnitude;
}

export function consoleTimeline(events: readonly ConsoleOccurrence[], duration: number, bucketSize: number) {
  if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(bucketSize) || bucketSize <= 0)
    return [];
  const buckets = Array.from(
    { length: Math.floor(duration / bucketSize) + 1 },
    (_, index) => ({ start: index * bucketSize, end: (index + 1) * bucketSize, count: 0 }),
  );
  for (const event of events) {
    const bucket = buckets[Math.floor(event.time / bucketSize)];
    if (bucket && event.severity === 'error') bucket.count += event.count;
  }
  return buckets;
}
