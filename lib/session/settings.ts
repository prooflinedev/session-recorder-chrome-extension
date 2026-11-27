import type { CaptureSettings, RedactionRules } from './types';

export const DEFAULT_REDACTION_RULES: RedactionRules = {
  headerNames: [],
  bodyKeyPatterns: [],
  urlParamPatterns: [],
};

export const DEFAULT_SETTINGS: CaptureSettings = {
  screenshotPolicy: 'every-interaction',
  inlineBodyCapBytes: 256 * 1024,
  assetBodyCapBytes: 2 * 1024 * 1024,
  fileCapBytes: 25 * 1024 * 1024,
  redactionEnabled: true,
  customRedaction: DEFAULT_REDACTION_RULES,
  filterTelemetry: true,
  screenshotQuality: 80,
  screenshotDedupThreshold: 5,
  hoverDwellMs: 700,
  captureApiSpec: false,
  cursorSpotlight: false,
  clickHighlight: false,
};

/**
 * Stored-copy cap for full API bodies when `captureApiSpec` is on. Generous on
 * purpose: the OpenAPI compiler needs complete JSON to infer schemas, and the
 * body lives in IndexedDB as an asset, never inline in the report.
 */
export const API_SPEC_BODY_CAP_BYTES = 10 * 1024 * 1024;

/**
 * Capture-detail presets for the Record button's detail slider. Each maps the
 * one knob to a screenshot policy, pointer sensitivity (0 = no hover) and
 * network body-capture caps — the "Detailed" entry mirrors DEFAULT_SETTINGS so
 * stock settings restore the slider to index 2.
 */
export const CAPTURE_DETAIL_LEVELS: {
  label: string;
  hint: string;
  screenshotPolicy: CaptureSettings['screenshotPolicy'];
  hoverDwellMs: number;
  inlineBodyCapBytes: number;
  assetBodyCapBytes: number;
}[] = [
  { label: 'Minimal', hint: 'Screenshots on demand, no pointer tracking, small request bodies', screenshotPolicy: 'on-demand', hoverDwellMs: 0, inlineBodyCapBytes: 64 * 1024, assetBodyCapBytes: 512 * 1024 },
  { label: 'Standard', hint: 'Screenshots at key moments, standard request bodies', screenshotPolicy: 'key-moments', hoverDwellMs: 0, inlineBodyCapBytes: 128 * 1024, assetBodyCapBytes: 1024 * 1024 },
  { label: 'Detailed', hint: 'Screenshot every interaction, track hovers, request bodies up to 256 KB', screenshotPolicy: 'every-interaction', hoverDwellMs: 700, inlineBodyCapBytes: 256 * 1024, assetBodyCapBytes: 2 * 1024 * 1024 },
  { label: 'Maximum', hint: 'Every interaction, sensitive pointer tracking, request bodies up to 1 MB', screenshotPolicy: 'every-interaction', hoverDwellMs: 350, inlineBodyCapBytes: 1024 * 1024, assetBodyCapBytes: 8 * 1024 * 1024 },
];

/**
 * The settings override a capture-detail preset controls — the single source
 * of truth for which fields the Record button's slider writes. The index is
 * clamped into range; `undefined` only if the presets array were empty.
 */
export function settingsForDetail(index: number): Partial<CaptureSettings> | undefined {
  const preset =
    CAPTURE_DETAIL_LEVELS[
      Math.max(0, Math.min(CAPTURE_DETAIL_LEVELS.length - 1, index))
    ];
  if (!preset) return undefined;
  return {
    screenshotPolicy: preset.screenshotPolicy,
    hoverDwellMs: preset.hoverDwellMs,
    inlineBodyCapBytes: preset.inlineBodyCapBytes,
    assetBodyCapBytes: preset.assetBodyCapBytes,
  };
}

/** Map current settings to the closest capture-detail slider index. */
export function detailIndexFromSettings(s: CaptureSettings): number {
  // Match on screenshotPolicy+hoverDwellMs only — the pair is already unique
  // per level, and deliberately NOT matching on the body caps means a user who
  // hand-tuned inlineBodyCapBytes/assetBodyCapBytes in the settings form keeps
  // their slider position instead of dropping to the coarser policy fallback.
  const match = CAPTURE_DETAIL_LEVELS.findIndex(
    (l) => l.screenshotPolicy === s.screenshotPolicy && l.hoverDwellMs === s.hoverDwellMs,
  );
  if (match >= 0) return match;
  // Fall back by screenshot policy.
  if (s.screenshotPolicy === 'on-demand') return 0;
  if (s.screenshotPolicy === 'key-moments') return 1;
  return 2;
}

/** Deep-clone the defaults so a session gets its own settings snapshot. */
export function makeDefaultSettings(): CaptureSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

/**
 * Merge persisted or partial settings over defaults so older stored profiles
 * missing newer fields (such as cursor effects) remain backward compatible.
 */
export function normalizeCaptureSettings(
  raw?: Partial<CaptureSettings> | null,
): CaptureSettings {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    ...makeDefaultSettings(),
    ...input,
    cursorSpotlight: input.cursorSpotlight === true,
    clickHighlight: input.clickHighlight === true,
  };
}

// chrome.storage.local keys
export const STORAGE_KEYS = {
  /** Persisted global capture defaults (options page). */
  defaultSettings: 'defaultSettings',
  /** Transcription provider config. */
  transcription: 'transcription',
  /** Persisted "mic permission granted" flag. */
  micGranted: 'micGranted',
  /** Start tab-video capture automatically when a recording starts. */
  videoFromStart: 'videoFromStart',
  /** Turn the microphone on automatically when a recording starts. */
  micFromStart: 'micFromStart',
} as const;
