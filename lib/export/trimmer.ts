/**
 * Pure verbosity-reduction pipeline for the exporter.
 *
 * A `Transform` maps a list of events to a smaller/lighter list. Transforms are
 * composed into per-level plans (`planFor`) and run by `applyLevel`. Every
 * transform CLONES its input (never mutates) and SKIPS protected events
 * (`isProtected`) — the user's explicit signals and errors always survive
 * verbatim. Purely cosmetic transforms (`coalesceScrolls`, `dedupConsole`) only
 * touch never-protected event types. Deterministic and side-effect free: no
 * `chrome`, DOM, network, randomness, or global mutable state.
 */

import { isProtected } from '@/lib/session/events';
import { jsonShapeFromText } from '@/lib/export/shape-summary';
import type {
  AssetMeta,
  CaptureSettings,
  NetBody,
  NetRequestPayload,
  SessionEvent,
  VerbosityLevel,
} from '@/lib/session/types';

export interface TrimContext {
  assetsById: Map<string, AssetMeta>;
  settings: CaptureSettings;
}

export type Transform = (
  events: SessionEvent[],
  ctx: TrimContext,
) => SessionEvent[];

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;

/** Hosts whose traffic is noise for a walkthrough: analytics/telemetry/ads. */
const ANALYTICS_HOST_RE =
  /(^|\.)(google-analytics|googletagmanager|doubleclick|googlesyndication|google\.com\/(ads|pagead)|segment\.(io|com)|mixpanel|amplitude|heap(analytics)?|hotjar|fullstory|mouseflow|clarity\.ms|sentry|bugsnag|datadoghq|newrelic|nr-data|intercom|drift|optimizely|launchdarkly|facebook\.com\/tr|connect\.facebook|analytics|telemetry|metrics|track(ing)?|stats?)\b/i;

/**
 * URL *path* signatures of analytics/telemetry ingest endpoints. These catch
 * first-party / self-hosted collectors (e.g. an app POSTing to `/ingest/i/v0/e`)
 * that `ANALYTICS_HOST_RE` misses because the host is the app's own domain.
 * Matched per path segment so `e` only fires on `/e`, not inside `/version`.
 */
const ANALYTICS_PATH_RE =
  /(^|\/)(ingest|collect|track|batch|amplitude|segment|mixpanel|posthog|rudderstack|sentry|datadog|fullstory|hotjar|clarity|intercom|google-analytics|gtag|gtm|doubleclick|e)(\/|$)/i;

const STATIC_RESOURCE_TYPES = new Set([
  'image',
  'font',
  'stylesheet',
  'media',
]);

/** UTF-8 byte length of a string. */
const byteLen = (text: string): number => new TextEncoder().encode(text).length;

/** True if a net-request should never be dropped/collapsed (error-ish). */
function isAnomalous(p: NetRequestPayload): boolean {
  return p.failed === true || (typeof p.status === 'number' && p.status >= 400);
}

/** Deep clone one event; the standard way each transform avoids mutation. */
function cloneEvent(e: SessionEvent): SessionEvent {
  return structuredClone(e);
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes (drops partial code units). */
function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalSize: number } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) {
    return { text, truncated: false, originalSize: bytes.length };
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.slice(0, maxBytes),
  );
  return { text: decoded, truncated: true, originalSize: bytes.length };
}

/**
 * Normalize a URL path: numeric / uuid / long-hex segments become `:id`.
 * Exported for reuse by the OpenAPI compiler's path templating.
 */
export function normalizePath(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    const q = url.indexOf('?');
    path = q >= 0 ? url.slice(0, q) : url;
  }
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (UUID_RE.test(seg)) return ':id';
      if (LONG_HEX_RE.test(seg)) return ':id';
      return seg;
    })
    .join('/');
}

/** Type guard narrowing a `SessionEvent` to the net-request variant. */
function isNetRequest(
  e: SessionEvent,
): e is Extract<SessionEvent, { type: 'net-request' }> {
  return e.type === 'net-request';
}

// ----------------------------------------------------------------------------
// Transforms
// ----------------------------------------------------------------------------

/** Cap inline request/response body text to `maxBytes`. */
export function truncateBodies(maxBytes: number): Transform {
  return (events) =>
    events.map((e) => {
      const clone = cloneEvent(e);
      if (isProtected(clone) || !isNetRequest(clone)) return clone;
      for (const body of [clone.payload.requestBody, clone.payload.responseBody]) {
        if (!body || typeof body.text !== 'string') continue;
        const r = truncateToBytes(body.text, maxBytes);
        if (r.truncated) {
          body.text = r.text;
          body.truncated = true;
          body.originalSize = body.originalSize ?? r.originalSize;
        }
      }
      return clone;
    });
}

/**
 * Replace verbose JSON bodies with a structural shape summary
 * (`payload.bodyShape`) and shrink the retained body text to a short note.
 */
export function bodyToShapeSummary(): Transform {
  return (events) =>
    events.map((e) => {
      const clone = cloneEvent(e);
      if (isProtected(clone) || !isNetRequest(clone)) return clone;
      const p = clone.payload;
      const reqShape =
        p.requestBody && typeof p.requestBody.text === 'string'
          ? jsonShapeFromText(p.requestBody.text)
          : null;
      const resShape =
        p.responseBody && typeof p.responseBody.text === 'string'
          ? jsonShapeFromText(p.responseBody.text)
          : null;
      if (reqShape === null && resShape === null) return clone;
      const shape: NonNullable<NetRequestPayload['bodyShape']> = {};
      if (reqShape !== null && p.requestBody) {
        shape.request = reqShape;
        summarizeBody(p.requestBody);
      }
      if (resShape !== null && p.responseBody) {
        shape.response = resShape;
        summarizeBody(p.responseBody);
      }
      p.bodyShape = shape;
      return clone;
    });
}

/** Collapse a body to a short note once its shape has been captured. */
function summarizeBody(body: NetBody): void {
  body.text = '«body reduced to shape summary»';
  body.truncated = true;
  body.base64 = undefined;
}

/**
 * Group net-requests by `method + normalized-path`. The first request in each
 * group is kept verbatim; subsequent normal ones are replaced by a single
 * `net-request` carrying `payload.collapsed`. Anomalous requests (status>=400 /
 * failed) and pending requests (unfinished at stop) always stay as their own
 * events, so a pending request is never dropped or used as the marker.
 */
export function collapseRepeatedRequests(): Transform {
  return (events) => {
    // First pass: bucket the indices of collapsible net-requests per group.
    const groupIndices = new Map<string, number[]>();
    events.forEach((e, i) => {
      if (isProtected(e) || !isNetRequest(e)) return;
      const key = `${e.payload.method.toUpperCase()} ${normalizePath(
        e.payload.url,
      )}`;
      const arr = groupIndices.get(key);
      if (arr) arr.push(i);
      else groupIndices.set(key, [i]);
    });

    // For each group, decide which indices to drop and where the marker lands.
    const dropIndex = new Set<number>();
    const markerAtIndex = new Map<
      number,
      { count: number; statuses: number[]; note: string }
    >();
    for (const [key, indices] of groupIndices) {
      if (indices.length < 2) continue;
      const [firstIndex, ...rest] = indices;
      if (firstIndex === undefined) continue;
      const collapsible = rest.filter((i) => {
        const e = events[i];
        return (
          e !== undefined &&
          isNetRequest(e) &&
          !isAnomalous(e.payload) &&
          e.payload.pending !== true
        );
      });
      if (collapsible.length === 0) continue;
      const statusSet = new Set<number>();
      for (const i of collapsible) {
        const e = events[i];
        if (e !== undefined && isNetRequest(e)) {
          statusSet.add(e.payload.status ?? 0);
        }
      }
      const markerIndex = collapsible[0];
      if (markerIndex === undefined) continue;
      for (const i of collapsible) {
        if (i !== markerIndex) dropIndex.add(i);
      }
      markerAtIndex.set(markerIndex, {
        count: collapsible.length,
        statuses: [...statusSet].sort((a, b) => a - b),
        note: `${collapsible.length} more ${key} request(s) collapsed`,
      });
    }

    // Second pass: emit, substituting the marker and dropping the rest.
    const out: SessionEvent[] = [];
    events.forEach((e, i) => {
      if (dropIndex.has(i)) return;
      const clone = cloneEvent(e);
      const collapsed = markerAtIndex.get(i);
      if (collapsed && isNetRequest(clone)) {
        clone.payload.requestBody = undefined;
        clone.payload.responseBody = undefined;
        clone.payload.collapsed = collapsed;
      }
      out.push(clone);
    });
    return out;
  };
}

/**
 * Drop net-requests for static assets (image/font/css/media) and analytics
 * hosts, unless the response is an error (status>=400 / failed).
 */
/**
 * Drop static-asset requests (images, fonts, css, media) always, and
 * telemetry/analytics requests only when `settings.filterTelemetry` is on
 * (the default). Capturing telemetry is fine; whether to keep it in the export
 * is the user's choice, set in the options. Anomalous (failed / >=400) requests
 * always survive.
 */
export function dropStaticAssets(): Transform {
  return (events, ctx) => {
    const dropTelemetry = ctx.settings.filterTelemetry !== false;
    const out: SessionEvent[] = [];
    for (const e of events) {
      if (!isProtected(e) && isNetRequest(e)) {
        const p = e.payload;
        if (!isAnomalous(p)) {
          if (isStaticAsset(p)) continue;
          if (dropTelemetry && isTelemetry(p)) continue;
        }
      }
      out.push(cloneEvent(e));
    }
    return out;
  };
}

/**
 * Static resources (images, fonts, css, media) that carry no debug signal.
 * The param is a Pick so the capture side can call it on partial request data.
 */
export function isStaticAsset(
  p: Pick<NetRequestPayload, 'resourceType' | 'mime' | 'responseBody'>,
): boolean {
  const rt = (p.resourceType ?? '').toLowerCase();
  if (STATIC_RESOURCE_TYPES.has(rt)) return true;
  const mime = (p.mime ?? p.responseBody?.mime ?? '').toLowerCase();
  return (
    mime.startsWith('image/') ||
    mime.startsWith('font/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'text/css' ||
    mime === 'application/font-woff' ||
    mime === 'application/font-woff2'
  );
}

/** Analytics / telemetry / tracking requests, by host or ingest-path shape. */
export function isTelemetry(p: Pick<NetRequestPayload, 'url'>): boolean {
  let host = '';
  let path = p.url;
  try {
    const u = new URL(p.url);
    host = u.host;
    path = u.pathname;
  } catch {
    host = p.url;
    const q = p.url.indexOf('?');
    path = q >= 0 ? p.url.slice(0, q) : p.url;
  }
  if (ANALYTICS_HOST_RE.test(host) || ANALYTICS_HOST_RE.test(p.url)) return true;
  return ANALYTICS_PATH_RE.test(path);
}

/**
 * Thin screenshot events by trigger:
 *  - `key-moments`: drop plain interaction shots, keep nav/error/annotation/…;
 *  - `annotation-error`: keep only annotation- and error-triggered shots;
 *  - `manifest-only`: drop every screenshot event (they live in the manifest).
 */
export function thinScreenshots(
  keep: 'key-moments' | 'annotation-error' | 'manifest-only',
): Transform {
  return (events) => {
    const out: SessionEvent[] = [];
    for (const e of events) {
      if (!isProtected(e) && e.type === 'screenshot') {
        const trigger = e.payload.trigger;
        if (keep === 'manifest-only') continue;
        if (keep === 'annotation-error') {
          if (trigger !== 'annotation' && trigger !== 'error') continue;
        } else {
          // key-moments: only plain interaction shots are noise.
          if (trigger === 'interaction') continue;
        }
      }
      out.push(cloneEvent(e));
    }
    return out;
  };
}

/** Merge runs of consecutive same-tab scroll events into a single scroll. */
export function coalesceScrolls(): Transform {
  return (events) => {
    const out: SessionEvent[] = [];
    let run: SessionEvent[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const merged = cloneEvent(run[0] as SessionEvent);
      const last = run[run.length - 1];
      if (merged.type === 'scroll' && last && last.type === 'scroll') {
        merged.payload.to = structuredClone(last.payload.to);
      }
      out.push(merged);
      run = [];
    };
    for (const e of events) {
      if (e.type === 'scroll' && !isProtected(e)) {
        const head = run[0];
        if (run.length > 0 && head && head.tabId === e.tabId) {
          run.push(e);
        } else {
          flush();
          run = [e];
        }
      } else {
        flush();
        out.push(cloneEvent(e));
      }
    }
    flush();
    return out;
  };
}

/** Drop hover events. They are a Full-fidelity-only signal; L1+ omits them. */
export function dropHovers(): Transform {
  return (events) => events.filter((e) => e.type !== 'hover').map(cloneEvent);
}

/**
 * Drop `cleared: true` text-select events. The selection itself is user
 * reading-intent worth keeping through L2, but the deselection marker is
 * Full-fidelity-only noise; L1+ omits it.
 */
export function dropClearedTextSelections(): Transform {
  return (events) =>
    events
      .filter((e) => !(e.type === 'text-select' && e.payload.cleared))
      .map(cloneEvent);
}

/** Drop ALL text-select events. Minimal (L3) keeps interactions only. */
export function dropTextSelections(): Transform {
  return (events) =>
    events.filter((e) => e.type !== 'text-select').map(cloneEvent);
}

/** Merge consecutive identical console events, summing their `repeat` counts. */
export function dedupConsole(): Transform {
  return (events) => {
    const out: SessionEvent[] = [];
    let pending: Extract<SessionEvent, { type: 'console' }> | null = null;
    let count = 0;
    const flush = () => {
      if (!pending) return;
      if (count > 1) pending.payload.repeat = count;
      out.push(pending);
      pending = null;
      count = 0;
    };
    for (const e of events) {
      if (e.type === 'console' && !isProtected(e)) {
        if (
          pending &&
          pending.payload.level === e.payload.level &&
          pending.payload.text === e.payload.text
        ) {
          count += e.payload.repeat ?? 1;
          continue;
        }
        flush();
        pending = cloneEvent(e) as Extract<SessionEvent, { type: 'console' }>;
        count = e.payload.repeat ?? 1;
      } else {
        flush();
        out.push(cloneEvent(e));
      }
    }
    flush();
    return out;
  };
}

/**
 * Merge consecutive identical error events (same message + origin), summing
 * their `repeat` counts. Page loads often fire the same "Failed to load
 * resource: 404" line many times in a row; one entry with a count reads better.
 */
export function dedupErrors(): Transform {
  return (events) => {
    const out: SessionEvent[] = [];
    let pending: Extract<SessionEvent, { type: 'error' }> | null = null;
    let count = 0;
    const flush = () => {
      if (!pending) return;
      if (count > 1) pending.payload.repeat = count;
      out.push(pending);
      pending = null;
      count = 0;
    };
    for (const e of events) {
      if (e.type === 'error' && !isProtected(e)) {
        if (
          pending &&
          pending.payload.origin === e.payload.origin &&
          pending.payload.message === e.payload.message
        ) {
          count += e.payload.repeat ?? 1;
          continue;
        }
        flush();
        pending = cloneEvent(e) as Extract<SessionEvent, { type: 'error' }>;
        count = e.payload.repeat ?? 1;
      } else {
        flush();
        out.push(cloneEvent(e));
      }
    }
    flush();
    return out;
  };
}

/**
 * Clear net-request bodies unless the request errored (status>=400 / failed) or
 * is linked to a captured error event via `linkedRequestId`.
 */
export function dropBodiesExceptErrors(): Transform {
  return (events) => {
    const errorLinkedIds = new Set<string>();
    for (const e of events) {
      if (e.type === 'error' && e.payload.linkedRequestId) {
        errorLinkedIds.add(e.payload.linkedRequestId);
      }
    }
    return events.map((e) => {
      const clone = cloneEvent(e);
      if (isProtected(clone) || !isNetRequest(clone)) return clone;
      const p = clone.payload;
      if (isAnomalous(p) || errorLinkedIds.has(p.requestId)) return clone;
      clearBody(p.requestBody);
      clearBody(p.responseBody);
      // A prior bodyToShapeSummary pass may have stashed the body as a shape
      // sketch; drop that too so the body is truly gone at this level.
      p.bodyShape = undefined;
      return clone;
    });
  };
}

function clearBody(body: NetBody | undefined): void {
  if (!body) return;
  body.present = false;
  body.text = undefined;
  body.base64 = undefined;
  body.assetId = undefined;
}

/**
 * Keep video-segment events (the report line records that a take exists and
 * its time span) but clear their file reference so multi-MB video files stay
 * out of L2+ bundles — the same "keep the event, drop the bytes" treatment
 * screenshots get via `thinScreenshots` and bodies get via `clearBody`.
 */
export function thinVideo(): Transform {
  return (events) =>
    events.map((e) => {
      const clone = cloneEvent(e);
      if (isProtected(clone) || clone.type !== 'video-segment') return clone;
      clone.payload.assetId = undefined;
      return clone;
    });
}

/** Reduce interaction descriptors to tag/text/selector only. */
export function interactionsToTextOnly(): Transform {
  return (events) =>
    events.map((e) => {
      const clone = cloneEvent(e);
      if (isProtected(clone)) return clone;
      if (
        clone.type === 'click' ||
        clone.type === 'input' ||
        clone.type === 'key'
      ) {
        const d = clone.payload.descriptor;
        if (d) {
          // Minimal level: element text only (renderer falls back to the tag
          // name when no selector is present).
          clone.payload.descriptor = {
            tag: d.tag,
            ...(d.text !== undefined ? { text: d.text } : {}),
          };
        }
      }
      return clone;
    });
}

// ----------------------------------------------------------------------------
// Level plans (IMPLEMENTATION.md §4.3)
// ----------------------------------------------------------------------------

// Text selections survive L0–L2 (they signal what the user was reading);
// deselection markers are L0-only; L3 drops selections entirely.
const L1_TRANSFORMS: Transform[] = [
  dropStaticAssets(),
  dropHovers(),
  dropClearedTextSelections(),
  coalesceScrolls(),
  truncateBodies(4 * 1024),
  thinScreenshots('key-moments'),
  dedupConsole(),
  dedupErrors(),
];

const L2_TRANSFORMS: Transform[] = [
  ...L1_TRANSFORMS,
  bodyToShapeSummary(),
  collapseRepeatedRequests(),
  thinScreenshots('annotation-error'),
  thinVideo(),
];

const L3_TRANSFORMS: Transform[] = [
  ...L2_TRANSFORMS,
  dropBodiesExceptErrors(),
  dropTextSelections(),
  interactionsToTextOnly(),
  thinScreenshots('manifest-only'),
];

/** The ordered, cumulative transform plan for a verbosity level. */
export function planFor(level: VerbosityLevel): Transform[] {
  switch (level) {
    case 'L0':
      return [];
    case 'L1':
      return [...L1_TRANSFORMS];
    case 'L2':
      return [...L2_TRANSFORMS];
    case 'L3':
      return [...L3_TRANSFORMS];
  }
}

/** Run the plan for `level` over `events`, threading `ctx`. Never mutates input. */
export function applyLevel(
  events: SessionEvent[],
  level: VerbosityLevel,
  ctx: TrimContext,
): SessionEvent[] {
  return planFor(level).reduce((acc, transform) => transform(acc, ctx), events);
}
