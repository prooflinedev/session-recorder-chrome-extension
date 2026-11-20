/**
 * OpenAPI 3 compilation from captured network traffic (the opt-in
 * `captureApiSpec` setting).
 *
 * Pure functions: `isApiIsh` decides which requests count as API traffic
 * (XHR/fetch or JSON-ish, never websockets/static assets/telemetry — reusing
 * the trimmer's heuristics so capture and export agree), and
 * `buildOpenApiSpec` folds the UNTRIMMED event list into an OpenAPI 3.1.0
 * document (3.1 Schema Objects are JSON Schema, so genson's `type` arrays —
 * e.g. `["null","string"]` for a nullable field — are valid as emitted; they
 * would be illegal under 3.0.x): paths are templated (numeric/uuid/hex
 * segments become named
 * `{param}`s), operations are grouped by method + templated path, and
 * request/response JSON schemas are inferred per status with genson-js,
 * merging across samples. Deterministic and side-effect free.
 *
 * Caveats (v1, by design): bodies are post-redaction, so a redacted number
 * infers as `string`; same-shaped paths from different origins merge into one
 * entry (the `servers` list carries every origin).
 */

import { createSchema, mergeSchemas } from 'genson-js';
import type { Schema } from 'genson-js';
import { isStaticAsset, isTelemetry, normalizePath } from './trimmer';
import type {
  NetBody,
  NetRequestPayload,
  SessionEvent,
} from '@/lib/session/types';

/** The request metadata `isApiIsh` needs — a Pick so capture-side partial data qualifies. */
export type ApiRequestMeta = Pick<
  NetRequestPayload,
  'url' | 'resourceType' | 'mime' | 'websocket' | 'responseBody'
>;

const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

/**
 * Is this request worth describing in an API spec? XHR/fetch resource types or
 * a JSON-ish mime, excluding websockets, static assets, and telemetry.
 */
export function isApiIsh(p: ApiRequestMeta): boolean {
  if (p.websocket === true) return false;
  const rt = (p.resourceType ?? '').toLowerCase();
  const mime = (p.mime ?? p.responseBody?.mime ?? '').toLowerCase();
  if (!API_RESOURCE_TYPES.has(rt) && !mime.includes('json')) return false;
  if (isStaticAsset(p)) return false;
  if (isTelemetry(p)) return false;
  return true;
}

/**
 * Asset ids of full stored bodies the spec compiler would want resolved.
 * `buildBundle` prefetches exactly these blob texts (base64 bodies are binary
 * and never contribute a schema, so they are skipped).
 */
export function apiBodyAssetIds(events: SessionEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== 'net-request') continue;
    const p = e.payload;
    if (!isApiIsh(p)) continue;
    for (const body of [p.requestBody, p.responseBody]) {
      if (body?.assetId !== undefined && body.base64 !== true) {
        ids.add(body.assetId);
      }
    }
  }
  return [...ids];
}

// ----------------------------------------------------------------------------
// Path templating
// ----------------------------------------------------------------------------

/** True when a path segment is an id-like value (numeric / uuid / long hex). */
function isIdSegment(seg: string): boolean {
  // normalizePath is the single source of truth for id-shaped segments.
  return seg !== '' && normalizePath(seg) === ':id';
}

/** `users` -> `userId`, `order-items` -> `orderItemId`, no prev segment -> `id`. */
function paramNameFor(prev: string | undefined, used: Set<string>): string {
  let base = 'id';
  if (prev) {
    const words = prev
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (words.length > 0) {
      const joined = words
        .map((w, i) =>
          i === 0
            ? w.toLowerCase()
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
        )
        .join('');
      // Crude singularization: "users" -> "user".
      const singular =
        joined.length > 1 && joined.endsWith('s') ? joined.slice(0, -1) : joined;
      base = `${singular}Id`;
    }
  }
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}${n}`;
    n += 1;
  }
  used.add(name);
  return name;
}

/** Template a URL's path: id segments become uniquely named `{param}`s. */
function templatePath(url: string): { path: string; params: string[] } {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    const q = url.indexOf('?');
    pathname = q >= 0 ? url.slice(0, q) : url;
  }
  const segs = pathname.split('/');
  const used = new Set<string>();
  const params: string[] = [];
  const out = segs.map((seg, i) => {
    if (!isIdSegment(seg)) return seg;
    // Name the param after the nearest preceding static segment.
    let prev: string | undefined;
    for (let j = i - 1; j >= 0; j -= 1) {
      const s = segs[j];
      if (s && !isIdSegment(s)) {
        prev = s;
        break;
      }
    }
    const name = paramNameFor(prev, used);
    params.push(name);
    return `{${name}}`;
  });
  const path = out.join('/');
  return { path: path.startsWith('/') ? path : `/${path}`, params };
}

// ----------------------------------------------------------------------------
// Body recovery + JSON parsing
// ----------------------------------------------------------------------------

/**
 * Recover the most complete body text available: the full stored asset wins
 * over inline text; truncated inline text is useless (it cannot parse) and
 * base64 bodies are binary.
 */
function bodyTextOf(
  body: NetBody | undefined,
  resolveBody: (assetId: string) => string | undefined,
): string | undefined {
  if (!body || body.present !== true || body.base64 === true) return undefined;
  if (body.assetId !== undefined) {
    const full = resolveBody(body.assetId);
    if (full !== undefined) return full;
  }
  if (typeof body.text !== 'string' || body.truncated === true) return undefined;
  return body.text;
}

/** Parse a JSON sample; `null` when absent or malformed (never throws). */
function parseJsonSample(text: string | undefined): { value: unknown } | null {
  if (text === undefined) return null;
  const head = text.trimStart().charAt(0);
  if (head !== '{' && head !== '[' && head !== '"' && !/[\d\-tfn]/.test(head)) {
    return null;
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Merge inferred sample schemas; undefined when there are none. */
function mergedSchema(schemas: Schema[]): Schema | undefined {
  if (schemas.length === 0) return undefined;
  if (schemas.length === 1) return schemas[0];
  try {
    return mergeSchemas(schemas);
  } catch {
    return schemas[0];
  }
}

function canonicalMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const normalized = mime.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

// ----------------------------------------------------------------------------
// Spec assembly
// ----------------------------------------------------------------------------

interface ResponseAcc {
  schemasByMime: Map<string, Schema[]>;
  mimes: Set<string>;
  sawBody: boolean;
}

interface OperationAcc {
  method: string; // lowercase
  path: string;
  pathParams: string[];
  queryParams: Set<string>;
  requestSchemasByMime: Map<string, Schema[]>;
  requestMimes: Set<string>;
  sawRequestBody: boolean;
  responses: Map<string, ResponseAcc>;
  samples: number;
}

export interface OpenApiMeta {
  name?: string;
  startedAt?: number;
}

export interface OpenApiResult {
  spec: Record<string, unknown>;
  endpointCount: number;
}

/**
 * Compile an OpenAPI 3.1.0 document from captured events. `resolveBody` maps a
 * `net-body` asset id to its full text (see `apiBodyAssetIds`). Returns `null`
 * when no API requests were captured.
 */
export function buildOpenApiSpec(
  events: SessionEvent[],
  resolveBody: (assetId: string) => string | undefined,
  meta?: OpenApiMeta,
): OpenApiResult | null {
  const ops = new Map<string, OperationAcc>();
  const origins = new Set<string>();
  let requestCount = 0;

  for (const e of events) {
    if (e.type !== 'net-request') continue;
    const p = e.payload;
    if (!isApiIsh(p)) continue;
    // Trimmer-collapsed markers carry no bodies and duplicate the first
    // request of their group; callers pass untrimmed events, but stay safe.
    if (p.collapsed) continue;
    requestCount += 1;

    const { path, params } = templatePath(p.url);
    const method = (p.method || 'GET').toLowerCase();
    const key = `${method} ${path}`;
    let op = ops.get(key);
    if (!op) {
      op = {
        method,
        path,
        pathParams: params,
        queryParams: new Set(),
        requestSchemasByMime: new Map(),
        requestMimes: new Set(),
        sawRequestBody: false,
        responses: new Map(),
        samples: 0,
      };
      ops.set(key, op);
    }
    op.samples += 1;

    try {
      const u = new URL(p.url);
      origins.add(u.origin);
      for (const name of u.searchParams.keys()) op.queryParams.add(name);
    } catch {
      /* relative / malformed URL: no origin or query info */
    }

    // Request body.
    if (p.requestBody?.present === true) {
      op.sawRequestBody = true;
      const mime =
        canonicalMime(p.requestBody.mime) ?? 'application/json';
      op.requestMimes.add(mime);
      const parsed = parseJsonSample(bodyTextOf(p.requestBody, resolveBody));
      if (parsed) {
        const schemas = op.requestSchemasByMime.get(mime) ?? [];
        schemas.push(createSchema(parsed.value));
        op.requestSchemasByMime.set(mime, schemas);
      }
    }

    // Response, keyed by status.
    if (typeof p.status === 'number') {
      const statusKey = String(p.status);
      let res = op.responses.get(statusKey);
      if (!res) {
        res = { schemasByMime: new Map(), mimes: new Set(), sawBody: false };
        op.responses.set(statusKey, res);
      }
      if (p.responseBody?.present === true) {
        res.sawBody = true;
        const mime =
          canonicalMime(p.responseBody.mime ?? p.mime) ?? 'application/json';
        res.mimes.add(mime);
        const parsed = parseJsonSample(bodyTextOf(p.responseBody, resolveBody));
        if (parsed) {
          const schemas = res.schemasByMime.get(mime) ?? [];
          schemas.push(createSchema(parsed.value));
          res.schemasByMime.set(mime, schemas);
        }
      }
    }
  }

  if (ops.size === 0) return null;

  // Assemble deterministically: paths sorted, methods sorted within a path.
  const paths: Record<string, Record<string, unknown>> = {};
  const sorted = [...ops.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  for (const op of sorted) {
    const operation: Record<string, unknown> = {
      summary: `Observed ${op.samples} time(s) during the recorded session`,
    };

    const parameters: Record<string, unknown>[] = [
      ...op.pathParams.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      // Observed query params; capture cannot prove they are required.
      ...[...op.queryParams].sort().map((name) => ({
        name,
        in: 'query',
        required: false,
        schema: { type: 'string' },
      })),
    ];
    if (parameters.length > 0) operation.parameters = parameters;

    if (op.sawRequestBody) {
      const mimes =
        op.requestMimes.size > 0
          ? [...op.requestMimes].sort()
          : ['application/json'];
      const content: Record<string, unknown> = {};
      for (const mime of mimes) {
        const schema = mergedSchema(op.requestSchemasByMime.get(mime) ?? []);
        content[mime] = schema ? { schema } : {};
      }
      operation.requestBody = {
        content,
      };
    }

    const responses: Record<string, unknown> = {};
    const statuses = [...op.responses.keys()].sort();
    for (const status of statuses) {
      const res = op.responses.get(status) as ResponseAcc;
      const entry: Record<string, unknown> = {
        description: `Observed ${status} response`,
      };
      if (res.sawBody) {
        const mimes =
          res.mimes.size > 0 ? [...res.mimes].sort() : ['application/json'];
        const content: Record<string, unknown> = {};
        for (const mime of mimes) {
          const schema = mergedSchema(res.schemasByMime.get(mime) ?? []);
          content[mime] = schema ? { schema } : {};
        }
        entry.content = content;
      }
      responses[status] = entry;
    }
    if (statuses.length === 0) {
      responses.default = { description: 'No response captured' };
    }
    operation.responses = responses;

    (paths[op.path] ??= {})[op.method] = operation;
  }

  const info: Record<string, unknown> = {
    title: `${meta?.name ?? 'Captured session'} — inferred API`,
    version: '0.0.1',
    description:
      `Compiled from ${requestCount} captured API request(s)` +
      (meta?.startedAt !== undefined
        ? ` recorded ${new Date(meta.startedAt).toISOString()}`
        : '') +
      '. Schemas are inferred from observed (redacted) traffic and may be incomplete.',
  };

  const spec: Record<string, unknown> = {
    openapi: '3.1.0',
    info,
    servers: [...origins].sort().map((url) => ({ url })),
    paths,
  };

  return { spec, endpointCount: ops.size };
}
