/**
 * Export bundle assembly.
 *
 * Turns a stored session (+events+assets) into the flat list of files that make
 * up the exported zip: `report.md`, `session.json`, `MANIFEST.md`,
 * `transcript.json`, and every asset still referenced after trimming. Also
 * produces per-level token/size estimates for the export UI.
 *
 * Trimming and rendering are delegated to the (pure) trimmer/markdown modules;
 * this module owns the asset->path mapping and the file layout.
 */

import type {
  Asset,
  AssetMeta,
  Session,
  SessionEvent,
  VerbosityLevel,
} from '@/lib/session/types';
import type { TokenEstimate } from '@/lib/messaging';
import { applyLevel } from './trimmer';
import type { TrimContext } from './trimmer';
import { renderManifest, renderReport, type ReproSummary } from './markdown';
import { apiBodyAssetIds, buildOpenApiSpec } from './openapi';
import {
  buildReproPlan,
  describeSignals,
  renderReproSpec,
  REPRO_SPEC_PATH,
} from './repro/plan';
import { estimateTokens } from './tokens';

export interface ExportFile {
  path: string;
  text?: string;
  bytes?: Uint8Array;
}

export interface BuildBundleInput {
  session: Session;
  events: SessionEvent[];
  assets: Asset[];
  level: VerbosityLevel;
  /**
   * Add `repro.spec.ts`, a Playwright test generated from the recording.
   * Set by the ZIP downloads only; hosted reports leave it out.
   */
  includeReproTest?: boolean;
}

const ALL_LEVELS: VerbosityLevel[] = ['L0', 'L1', 'L2', 'L3'];

// ---------------------------------------------------------------------------
// Small path helpers
// ---------------------------------------------------------------------------

/** `mmss` (or `hhmmss` past an hour) form of a ms offset, for filenames. */
function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}${pad(m)}${pad(s)}` : `${pad(m)}${pad(s)}`;
}

/** Zero-padded sequence number, stable for lexical sorting. */
function seq(n: number): string {
  return String(n).padStart(3, '0');
}

/** Collapse an arbitrary string into a filesystem-safe segment. */
function sanitizeSeg(s: string, cap = 40): string {
  const cleaned = s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  return (cleaned || 'x').slice(0, cap);
}

/** Filesystem-safe version of an uploaded file's name, keeping its extension. */
function safeFileName(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '');
  return cleaned || 'file';
}

function hostOf(url: string): string {
  try {
    return sanitizeSeg(new URL(url).host || 'host', 32);
  } catch {
    return 'host';
  }
}

function slugOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return sanitizeSeg(path.replace(/^\/+/, '') || 'root');
  } catch {
    return sanitizeSeg(url || 'req');
  }
}

/**
 * Deterministic content key for a blob's bytes. Used to collapse byte-identical
 * assets to a single zip file. FNV-1a 32-bit salted with the byte length so a
 * collision would need both the same length and the same hash.
 */
function contentHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `fnv:${bytes.length}:${(h >>> 0).toString(16)}`;
}

/** Ensure a path is unique within the archive by suffixing `-2`, `-3`, ... */
function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const stem = dot >= 0 ? path.slice(0, dot) : path;
  const ext = dot >= 0 ? path.slice(dot) : '';
  let i = 2;
  let candidate = `${stem}-${i}${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${stem}-${i}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Asset path assignment
// ---------------------------------------------------------------------------

interface AssetPlan {
  /** assetId -> zip-relative path for every included asset. */
  pathById: Map<string, string>;
}

/**
 * Walk the surviving events and assign a zip-relative path to every asset they
 * still reference. Annotation screenshots, voice audio, and captured files ride
 * on protected events, so they are always included regardless of level.
 */
function planAssetPaths(events: SessionEvent[], assets: Asset[]): AssetPlan {
  const known = new Set(assets.map((a) => a.id));
  const pathById = new Map<string, string>();
  const used = new Set<string>();

  let shotSeq = 0;
  let audioSeq = 0;
  let videoSeq = 0;
  let netSeq = 0;

  const assign = (id: string | undefined, make: () => string): void => {
    if (!id || !known.has(id) || pathById.has(id)) return;
    pathById.set(id, uniquePath(make(), used));
  };

  for (const e of events) {
    switch (e.type) {
      case 'screenshot':
        assign(e.payload.assetId, () => {
          shotSeq += 1;
          return `screenshots/${seq(shotSeq)}-${mmss(e.t)}.jpg`;
        });
        break;
      case 'annotation':
        // Annotation screenshots are always kept.
        assign(e.payload.screenshotAssetId, () => {
          shotSeq += 1;
          return `screenshots/${seq(shotSeq)}-${mmss(e.t)}.jpg`;
        });
        break;
      case 'voice-segment':
        assign(e.payload.assetId, () => {
          audioSeq += 1;
          return `audio/${seq(audioSeq)}-${mmss(e.t)}.webm`;
        });
        break;
      case 'video-segment':
        assign(e.payload.assetId, () => {
          videoSeq += 1;
          return `video/${seq(videoSeq)}-${mmss(e.t)}.webm`;
        });
        break;
      case 'file-captured':
      case 'file-attached':
        assign(
          e.payload.assetId,
          () => `files/${safeFileName(e.payload.fileName)}`,
        );
        break;
      case 'net-request': {
        const p = e.payload;
        const host = hostOf(p.url);
        const slug = slugOf(p.url);
        assign(p.requestBody?.assetId, () => {
          netSeq += 1;
          return `network/${seq(netSeq)}-${host}-${slug}-request.json`;
        });
        assign(p.responseBody?.assetId, () => {
          netSeq += 1;
          return `network/${seq(netSeq)}-${host}-${slug}.json`;
        });
        break;
      }
      default:
        break;
    }
  }

  return { pathById };
}

/** Rewrite an event's asset-id references to their zip-relative paths. */
function mapEventAssets(
  e: SessionEvent,
  pathById: Map<string, string>,
): SessionEvent {
  const clone = structuredClone(e);
  const map = (id: string | undefined): string | undefined =>
    id !== undefined ? (pathById.get(id) ?? id) : id;

  switch (clone.type) {
    case 'screenshot':
      clone.payload.assetId = map(clone.payload.assetId) as string;
      break;
    case 'annotation':
      clone.payload.screenshotAssetId = map(clone.payload.screenshotAssetId);
      break;
    case 'voice-segment':
      delete clone.payload.transcriptionRequest;
      delete clone.payload.transcriptionGeneration;
      delete clone.payload.transcriptionTerminalFailure;
      clone.payload.assetId = map(clone.payload.assetId) as string;
      break;
    case 'video-segment':
      clone.payload.assetId = map(clone.payload.assetId);
      break;
    case 'file-captured':
    case 'file-attached':
      clone.payload.assetId = map(clone.payload.assetId);
      break;
    case 'net-request': {
      const req = clone.payload.requestBody;
      if (req && req.assetId !== undefined) req.assetId = map(req.assetId);
      const res = clone.payload.responseBody;
      if (res && res.assetId !== undefined) res.assetId = map(res.assetId);
      break;
    }
    default:
      break;
  }
  return clone;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function toMeta(a: Asset): AssetMeta {
  const { blob: _blob, ...meta } = a;
  return meta;
}

function trimContext(
  assets: AssetMeta[],
  session: Session,
): TrimContext {
  return {
    assetsById: new Map(assets.map((a) => [a.id, a])),
    settings: session.settings,
  };
}

export async function buildBundle(
  input: BuildBundleInput,
): Promise<ExportFile[]> {
  const { session, events, assets, level } = input;
  const assetsMeta = assets.map(toMeta);

  // 1) Trim events for the requested level.
  const trimmed = applyLevel(events, level, trimContext(assetsMeta, session));

  // 2) Assign zip-relative paths to still-referenced assets.
  const { pathById } = planAssetPaths(trimmed, assets);

  // 2b) Dedupe byte-identical asset blobs. Assets sharing a content key (its
  // sha256 when known, else a hash of the bytes we must read for the zip) are
  // written to the archive exactly once — the first assigned path wins — and
  // every event/link referencing any asset in the group resolves to that one
  // path. This kills the common case of the same large response body being
  // captured several times over a session.
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const bytesByPath = new Map<string, Uint8Array>();
  const pathByKey = new Map<string, string>();
  const dedupById = new Map<string, string>();
  for (const [id, path] of pathById) {
    const asset = assetById.get(id);
    if (!asset) continue;
    const bytes = new Uint8Array(await asset.blob.arrayBuffer());
    const key = asset.sha256 ?? contentHash(bytes);
    const survivor = pathByKey.get(key);
    if (survivor === undefined) {
      pathByKey.set(key, path);
      bytesByPath.set(path, bytes);
      dedupById.set(id, path);
    } else {
      dedupById.set(id, survivor);
    }
  }

  const assetPath = (id: string): string | undefined => dedupById.get(id);

  // 2c) Compile the OpenAPI spec from the UNTRIMMED events (opt-in). Using the
  // full event list keeps the spec identical at every level — L2/L3 body
  // stripping must not starve it. Full stored bodies are read straight from
  // the asset blobs; they need not survive into the zip themselves.
  let openapiFile: ExportFile | undefined;
  let openapi: { path: string; endpointCount: number } | undefined;
  if (session.settings.captureApiSpec) {
    const bodyTextById = new Map<string, string>();
    for (const id of apiBodyAssetIds(events)) {
      const asset = assetById.get(id);
      if (!asset || asset.kind !== 'net-body') continue;
      try {
        bodyTextById.set(id, await asset.blob.text());
      } catch {
        /* unreadable blob — the inline (possibly truncated) copy is skipped */
      }
    }
    const compiled = buildOpenApiSpec(events, (id) => bodyTextById.get(id), {
      name: session.name,
      startedAt: session.startedAt,
    });
    if (compiled) {
      openapiFile = {
        path: 'openapi.json',
        text: JSON.stringify(compiled.spec, null, 2),
      };
      openapi = { path: 'openapi.json', endpointCount: compiled.endpointCount };
    }
  }

  // 2d) The repro test, also from the UNTRIMMED events, so every level gives
  // the same steps. Uploaded files resolve to their zip paths.
  let reproFile: ExportFile | undefined;
  let repro: ReproSummary | undefined;
  if (input.includeReproTest) {
    const built = buildReproPlan({ session, events, assetPath });
    if (built) {
      reproFile = { path: REPRO_SPEC_PATH, text: renderReproSpec(built.plan) };
      repro = {
        path: REPRO_SPEC_PATH,
        steps: built.plan.steps.length,
        signals: describeSignals(built.plan),
        gaps: built.gaps,
        envVars: built.envVars,
        ...(built.plan.fixme !== undefined ? { fixme: built.plan.fixme } : {}),
      };
    }
  }

  // 3) Text artifacts.
  const report = renderReport({
    session,
    events: trimmed,
    assets: assetsMeta,
    level,
    assetPath,
    ...(openapi ? { openapi } : {}),
    ...(repro ? { repro } : {}),
  });
  const manifest = renderManifest({
    session,
    events: trimmed,
    assets: assetsMeta,
    level,
    assetPath,
  });

  const mappedEvents = trimmed.map((e) => mapEventAssets(e, dedupById));
  const sessionJson = JSON.stringify(
    { session, events: mappedEvents },
    null,
    2,
  );

  const transcript = trimmed
    .filter(
      (e): e is Extract<SessionEvent, { type: 'voice-segment' }> =>
        e.type === 'voice-segment',
    )
    .map((e) => ({
      t: e.payload.tStart,
      tEnd: e.payload.tEnd,
      text: e.payload.transcript,
    }));

  const files: ExportFile[] = [
    { path: 'report.md', text: report },
    { path: 'session.json', text: sessionJson },
    { path: 'MANIFEST.md', text: manifest },
    { path: 'transcript.json', text: JSON.stringify(transcript, null, 2) },
  ];
  if (openapiFile) files.push(openapiFile);
  if (reproFile) files.push(reproFile);

  // 4) Every surviving (deduped) asset as raw bytes, written once.
  for (const [path, bytes] of bytesByPath) {
    files.push({ path, bytes });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

const OMIT_ORDER: [SessionEvent['type'], string][] = [
  ['scroll', 'scroll events'],
  ['console', 'console logs'],
  ['key', 'keystrokes'],
  ['text-select', 'text selections'],
  ['input', 'form input values'],
  ['click', 'clicks'],
  ['screenshot', 'screenshots'],
  ['net-request', 'network requests'],
  ['nav', 'navigations'],
  ['tab-switch', 'tab switches'],
];

function countByType(
  events: SessionEvent[],
): Map<SessionEvent['type'], number> {
  const m = new Map<SessionEvent['type'], number>();
  for (const e of events) m.set(e.type, (m.get(e.type) ?? 0) + 1);
  return m;
}

/** Categories that shrank or were compacted going from full -> trimmed. */
function omittedCategories(
  full: SessionEvent[],
  trimmed: SessionEvent[],
): string[] {
  const before = countByType(full);
  const after = countByType(trimmed);
  const out: string[] = [];

  for (const [type, label] of OMIT_ORDER) {
    if ((after.get(type) ?? 0) < (before.get(type) ?? 0)) out.push(label);
  }

  // Body reductions leave the net-request event in place but strip/summarize it.
  let shapeReduced = false;
  let collapsed = false;
  for (const e of trimmed) {
    if (e.type !== 'net-request') continue;
    if (e.payload.bodyShape) shapeReduced = true;
    if (e.payload.collapsed) collapsed = true;
  }
  if (shapeReduced && !out.includes('network requests')) {
    out.push('network response bodies');
  }
  if (collapsed) out.push('repeated requests');

  // thinVideo keeps the video-segment event but drops its file at L2+.
  const hasVideoFile = (evts: SessionEvent[]): boolean =>
    evts.some((e) => e.type === 'video-segment' && e.payload.assetId != null);
  if (hasVideoFile(full) && !hasVideoFile(trimmed)) out.push('video files');

  return out;
}

export function estimateForLevels(
  events: SessionEvent[],
  assets: AssetMeta[],
  session: Session,
): TokenEstimate[] {
  const enc = new TextEncoder();
  const ctx = trimContext(assets, session);
  const metaById = new Map(assets.map((a) => [a.id, a]));

  // Stub path: return a plausible planned path for any known asset so the
  // report renders its links (which contribute to the token count).
  const stubPath = (id: string): string | undefined => {
    const a = metaById.get(id);
    if (!a) return undefined;
    switch (a.kind) {
      case 'screenshot':
        return `screenshots/${id}.jpg`;
      case 'audio':
        return `audio/${id}.webm`;
      case 'video':
        return `video/${id}.webm`;
      case 'file':
        return `files/${id}`;
      case 'net-body':
        return `network/${id}.json`;
      default:
        return `assets/${id}`;
    }
  };

  return ALL_LEVELS.map((level) => {
    const trimmed = applyLevel(events, level, ctx);
    const report = renderReport({
      session,
      events: trimmed,
      assets,
      level,
      assetPath: stubPath,
    });
    return {
      level,
      tokens: estimateTokens(report),
      approxBytes: enc.encode(report).length,
      omitted: omittedCategories(events, trimmed),
    };
  });
}
