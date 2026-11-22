import type { CaptureTarget } from './types';

/**
 * Where an event came from when it was not the recorded page itself, for
 * reports: "cross-site iframe pay.example.com" or "worker
 * app.example.com/search-worker.js". The URL is already redacted; only its
 * host and, for a worker, its script path are shown.
 */
export function describeTarget(target: CaptureTarget): string {
  let host = target.url;
  let path = '';
  try {
    const u = new URL(target.url);
    host = u.host || target.url;
    path = u.pathname;
  } catch {
    /* keep the raw (redacted) text */
  }
  if (target.type === 'iframe') {
    return `${target.crossSite ? 'cross-site ' : ''}iframe ${host}`;
  }
  return `${target.crossSite ? 'cross-site ' : ''}worker ${host}${path}`;
}

/** Shown in place of a body the recorder deliberately did not read. */
export const CROSS_SITE_BODY_NOTE = 'not captured from a cross-site frame';
