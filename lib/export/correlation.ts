/**
 * Correlation IDs of a captured request (pure).
 *
 * When a request fails on the server, whoever picks up the report has to find
 * that one request in the server's logs or traces. The key for that search is a
 * request or trace ID, and it travels in the headers: the server or its edge
 * names the request in a response header (`x-request-id`, `cf-ray`,
 * `x-amzn-requestid`, …), and an instrumented page sends its trace context in a
 * request header (`traceparent`, `sentry-trace`, …). Capture already stores
 * every header; this module picks the IDs out so the report can print them.
 *
 * Redaction is assumed to have already happened upstream: a header the user
 * redacts carries the marker instead of its value, and is left out here.
 */

import { REDACTED } from '@/lib/capture/redaction';
import type { NetHeader } from '@/lib/session/types';

/**
 * Names ending in a request, trace or correlation ID as a whole word, e.g.
 * `x-request-id`, `x-amzn-requestid`, `x-b3-traceid`. Plain hyphenated names
 * only, so a matched name is always safe to print.
 */
const ID_SUFFIX_RE = /^(?:[a-z0-9]+-)*(?:request|trace|correlation)-?id$/;

/** Well-known ID headers that the suffix rule does not cover. */
const ID_HEADERS: ReadonlySet<string> = new Set([
  'traceparent', // W3C Trace Context
  'sentry-trace', // Sentry
  'b3', // Zipkin, single-header form
  'cf-ray', // Cloudflare
  'x-vercel-id', // Vercel
  'x-cloud-trace-context', // Google Cloud
  'x-amz-cf-id', // Amazon CloudFront
  'x-amz-id-2', // Amazon S3
  'x-amz-apigw-id', // Amazon API Gateway
  'x-azure-ref', // Azure Front Door
]);

/** Longest value kept; real IDs are well under this. */
const VALUE_CAP = 200;

/**
 * The request and trace IDs among `headers`, in captured order. Names are
 * lower-cased; values are put on one line and capped. Never mutates its input.
 */
export function correlationIds(headers: NetHeader[]): NetHeader[] {
  const out: NetHeader[] = [];
  const seen = new Set<string>();
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (!ID_HEADERS.has(name) && !ID_SUFFIX_RE.test(name)) continue;
    const text = h.value.replace(/\s+/g, ' ').trim();
    if (text.length === 0 || text === REDACTED) continue;
    const value = text.length > VALUE_CAP ? `${text.slice(0, VALUE_CAP)}…` : text;
    // Header names are case-insensitive: two spellings of one header are one ID.
    const key = `${name}\n${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, value });
  }
  return out;
}
