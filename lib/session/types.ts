/**
 * Frozen shared contract for the whole extension.
 *
 * Every capture source, the storage layer, the trimmer, the markdown renderer,
 * and the UI all agree on the shapes defined here. Later phases may ADD event
 * types (extend `EventType` + `EventPayloadMap`) but must not change existing
 * payload shapes — see docs/event-schema.md.
 */

// ----------------------------------------------------------------------------
// Enums / unions
// ----------------------------------------------------------------------------

export type VerbosityLevel = 'L0' | 'L1' | 'L2' | 'L3';

export type ScreenshotPolicy = 'every-interaction' | 'key-moments' | 'on-demand';

export type SessionStatus =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'stopped';

export type AssetKind = 'screenshot' | 'audio' | 'video' | 'file' | 'net-body';

export type ConsoleLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace';

/**
 * Every event type the recorder can emit. The discriminated union `SessionEvent`
 * is derived from this via `EventPayloadMap`.
 */
export type EventType =
  // interactions
  | 'click'
  | 'input'
  | 'scroll'
  | 'key'
  | 'hover'
  | 'text-select'
  // navigation / tabs
  | 'nav'
  | 'spa-route'
  | 'tab-switch'
  | 'tab-opened'
  | 'tab-closed'
  // deep capture
  | 'net-request'
  | 'console'
  | 'error'
  // visual
  | 'screenshot'
  | 'annotation-start'
  | 'annotation'
  // voice
  | 'voice-segment'
  // video
  | 'video-segment'
  // files
  | 'file-captured'
  | 'file-attached'
  // user signals
  | 'marker'
  | 'note'
  // system
  | 'session-note';

// ----------------------------------------------------------------------------
// Shared value objects
// ----------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Best-effort description of a DOM element, produced in content scripts. */
export interface ElementDescriptor {
  tag: string;
  id?: string;
  role?: string;
  ariaLabel?: string;
  name?: string;
  /** Visible text, capped at ~80 chars. */
  text?: string;
  /** Best-effort CSS selector: id > data-testid > short ancestor path. */
  selector?: string;
  rect?: Rect;
}

export interface RedactionRules {
  /** Extra header names to redact (lowercased). Merged with defaults. */
  headerNames: string[];
  /** Extra regex source strings matched against JSON/form keys. */
  bodyKeyPatterns: string[];
  /** Extra regex source strings matched against URL query-param names. */
  urlParamPatterns: string[];
}

export interface CaptureSettings {
  screenshotPolicy: ScreenshotPolicy;
  /** Inline body cap; larger bodies are truncated in the event. */
  inlineBodyCapBytes: number;
  /** Bodies up to this size are also stored whole as a `net-body` asset. */
  assetBodyCapBytes: number;
  /** Files up to this size are captured whole; larger => metadata-only. */
  fileCapBytes: number;
  /** Master redaction switch; per-session. */
  redactionEnabled: boolean;
  customRedaction: RedactionRules;
  /**
   * When true (default), the exporter drops telemetry/analytics requests from
   * L1+ so reports stay focused. Capture always keeps everything; this only
   * affects what the export includes. Turn off to keep telemetry in exports.
   */
  filterTelemetry: boolean;
  /** JPEG quality 0..100 for screenshots. */
  screenshotQuality: number;
  /** Average-hash hamming distance under which a shot is a near-duplicate. */
  screenshotDedupThreshold: number;
  /**
   * Pointer dwell time (ms) before a hover is recorded, 0 to disable hover
   * capture entirely. Lower = more sensitive mouse capture. Driven by the
   * capture-detail knob alongside `screenshotPolicy`.
   */
  hoverDwellMs: number;
  /**
   * Opt-in (default false): store FULL request/response bodies of API-ish
   * requests (XHR/fetch/JSON, non-static, non-telemetry) as `net-body` assets
   * so the export can compile an OpenAPI spec (`openapi.json`). Inline
   * truncation for the report is unaffected; only the stored copy's cap is
   * raised (see `API_SPEC_BODY_CAP_BYTES`).
   */
  captureApiSpec: boolean;
}

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  openerTabId?: number;
  attachedAt: number; // ms epoch
  detachedAt?: number;
  role: 'primary' | 'adopted';
  /** True while the debugger is currently attached. */
  attached: boolean;
}

// ----------------------------------------------------------------------------
// Session
// ----------------------------------------------------------------------------

export interface Session {
  id: string;
  name: string;
  startedAt: number; // ms epoch
  endedAt?: number;
  initialUrl: string;
  tabs: TabInfo[];
  settings: CaptureSettings;
  status: SessionStatus;
  /** Per-type event counts, kept in sync for the summary UI. */
  counts: Partial<Record<EventType, number>>;
  /** Total bytes of assets, for the storage/summary UI. */
  assetBytes: number;
  /** Browser, OS and viewport at the start. Absent on older sessions. */
  environment?: SessionEnvironment;
}

/**
 * The browser, OS and viewport a session was recorded in, captured once when
 * recording starts. Every field is optional: a restricted page refuses the
 * viewport probe, and a browser without User-Agent Client Hints only gives
 * its user-agent string.
 */
export interface SessionEnvironment {
  /** e.g. "Google Chrome 142.0.7444.59" */
  browser?: string;
  /** e.g. "Windows 15.0.0 x86", as Client Hints report it */
  os?: string;
  locale?: string;
  timeZone?: string;
  viewport?: { width: number; height: number; devicePixelRatio: number };
}

// ----------------------------------------------------------------------------
// Event payloads
// ----------------------------------------------------------------------------

export interface ClickPayload {
  descriptor: ElementDescriptor;
  modifiers: string[]; // e.g. ['ctrl','shift']
  button?: number;
}

export interface InputPayload {
  descriptor: ElementDescriptor;
  /** Recorded value, or the redaction marker for sensitive fields. */
  value: string;
  redacted: boolean;
  inputType?: string; // <input type=...>
}

export interface ScrollPayload {
  from: Point;
  to: Point;
  container?: string; // selector of scroll container, or 'window'
}

export interface KeyPayload {
  key: string; // 'Enter' | 'Escape' | 'Tab' | 'Ctrl+K' ...
  modifiers: string[];
  descriptor?: ElementDescriptor;
}

/**
 * The pointer dwelled over a meaningful element. Emitted only when the mouse
 * pauses (~500ms) over an interactive or text-bearing element different from the
 * last one, so it captures hover intent without pixel-by-pixel noise.
 */
export interface HoverPayload {
  descriptor: ElementDescriptor;
  /** How long the pointer rested here, in ms. */
  dwellMs: number;
}

/**
 * The user selected (or deselected) text on the page. Emitted after the
 * selection settles (~500ms debounce), so drag-selection produces one event.
 * A `cleared: true` event (no text) follows when a previously captured
 * selection becomes empty.
 */
export interface TextSelectPayload {
  /** Whitespace-normalized selection text, capped at 500 chars. Absent when `cleared`. */
  text?: string;
  /** True when `text` was cut at the cap. */
  truncated?: boolean;
  /** Common ancestor element of the selection, when resolvable. */
  descriptor?: ElementDescriptor;
  /** True for the single deselection event after a captured selection. */
  cleared: boolean;
}

export interface NavPayload {
  url: string;
  title?: string;
  transitionType?: string;
}

export interface SpaRoutePayload {
  url: string;
  title?: string;
  method: 'pushState' | 'replaceState' | 'popstate';
}

export interface TabSwitchPayload {
  fromTabId?: number;
  toTabId: number;
  toUrl?: string;
  toTitle?: string;
}

export interface TabOpenedPayload {
  url?: string;
  title?: string;
  openerTabId?: number;
}

export interface TabClosedPayload {
  url?: string;
  title?: string;
}

export interface NetHeader {
  name: string;
  value: string;
}

export interface NetBody {
  present: boolean;
  mime?: string;
  /** Possibly truncated and/or redacted body text. */
  text?: string;
  truncated?: boolean;
  /** Original (pre-truncation) size in bytes. */
  originalSize?: number;
  /** Full body stored separately when it overflows the inline cap. */
  assetId?: string;
  /** True when `text` is base64 (binary body). */
  base64?: boolean;
}

export interface WsFrame {
  dir: 'sent' | 'recv';
  opcode: number;
  ts: number; // ms from session start
  text?: string;
  truncated?: boolean;
}

export interface NetRequestPayload {
  requestId: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  requestHeaders: NetHeader[];
  responseHeaders: NetHeader[];
  requestBody?: NetBody;
  responseBody?: NetBody;
  timing?: { startedAt: number; durationMs?: number };
  initiator?: string;
  failed?: boolean;
  failureReason?: string;
  fromCache?: boolean;
  mime?: string;
  // websocket
  websocket?: boolean;
  wsFrames?: WsFrame[];
  /** Set by the trimmer when repeated calls are collapsed into this one. */
  collapsed?: { count: number; statuses: number[]; note?: string };
  /** Set by the trimmer when the body was reduced to a JSON shape summary. */
  bodyShape?: { request?: string; response?: string };
}

export interface ConsolePayload {
  level: ConsoleLevel;
  text: string;
  args?: string[];
  /** Consecutive-duplicate collapse count. */
  repeat?: number;
  stack?: string;
  source?: string; // url:line
}

export interface ErrorPayload {
  message: string;
  stack?: string;
  origin: 'exception' | 'console' | 'network' | 'log';
  linkedRequestId?: string;
  /** Consecutive-duplicate collapse count (set by the trimmer). */
  repeat?: number;
}

export type ScreenshotTrigger =
  | 'interaction'
  | 'nav'
  | 'error'
  | 'annotation'
  | 'manual'
  | 'key-moment';

export interface ScreenshotPayload {
  assetId: string;
  width: number;
  height: number;
  trigger: ScreenshotTrigger;
  /** 64-bit average hash as hex, for dedup. */
  ahash?: string;
  /** Consecutive near-duplicate count folded into this shot. */
  repeat?: number;
  contextText?: string;
  hasAnnotations?: boolean;
}

export type AnnotationTool =
  | 'pen'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'highlighter'
  | 'redact';

export interface AnnotationShape {
  tool: AnnotationTool;
  color: string;
  strokeWidth: number;
  points?: Point[]; // pen / highlighter
  rect?: Rect; // rect / ellipse / redact
  from?: Point; // arrow
  to?: Point; // arrow
  text?: string; // text label
  /** Element under the shape's anchor, for text-only description to the LLM. */
  targetDescriptor?: ElementDescriptor;
}

export interface AnnotationPayload {
  shapes: AnnotationShape[];
  screenshotAssetId?: string;
  viewport: { w: number; h: number };
}

export interface AnnotationStartPayload {
  viewport: { w: number; h: number };
}

export interface VoiceSegmentPayload {
  /**
   * Audio asset backing this segment. Optional: real-time streaming produces
   * one voice-segment per spoken utterance (transcript only), and the full
   * session audio is attached to a single segment as one asset.
   */
  assetId?: string;
  tStart: number; // ms from session start
  tEnd: number;
  transcript: string | null;
  words?: { word: string; t: number }[];
  transcriptionError?: string;
  /** Managed request identity survives network failures without charging again. */
  transcriptionGeneration?: number;
  transcriptionTerminalFailure?: boolean;
  transcriptionRequest?: {
    id: string;
    organizationId: string;
    provider: 'deepgram' | 'elevenlabs';
    language?: string;
    keyterms: string[];
  };
  provider?: string;
  /** True when produced live by a streaming recognizer (vs post-hoc batch). */
  streamed?: boolean;
  /** Best-effort descriptor of what the user was doing/looking at while speaking. */
  anchorContext?: string;
}

export interface VideoSegmentPayload {
  /**
   * Video asset backing this segment. Optional: the L2+ trimmer keeps the
   * event line (what was recorded, and when) but clears the file reference so
   * multi-MB video files stay out of compact bundles.
   */
  assetId?: string;
  tStart: number; // ms from session start
  tEnd: number;
  note?: string;
}

export interface FilePayload {
  /** Undefined when metadata-only (oversized). */
  assetId?: string;
  fileName: string;
  mime: string;
  size: number;
  /** e.g. "uploaded to Import CSV dialog". */
  contextText?: string;
  metadataOnly?: boolean;
  note?: string;
}

export interface MarkerPayload {
  name: string;
}

export interface NotePayload {
  text: string;
}

export interface SessionNotePayload {
  text: string;
  kind: 'rehydrate' | 'detach' | 'info' | 'warning';
}

// ----------------------------------------------------------------------------
// Event union
// ----------------------------------------------------------------------------

export interface EventPayloadMap {
  click: ClickPayload;
  input: InputPayload;
  scroll: ScrollPayload;
  key: KeyPayload;
  hover: HoverPayload;
  'text-select': TextSelectPayload;
  nav: NavPayload;
  'spa-route': SpaRoutePayload;
  'tab-switch': TabSwitchPayload;
  'tab-opened': TabOpenedPayload;
  'tab-closed': TabClosedPayload;
  'net-request': NetRequestPayload;
  console: ConsolePayload;
  error: ErrorPayload;
  screenshot: ScreenshotPayload;
  'annotation-start': AnnotationStartPayload;
  annotation: AnnotationPayload;
  'voice-segment': VoiceSegmentPayload;
  'video-segment': VideoSegmentPayload;
  'file-captured': FilePayload;
  'file-attached': FilePayload;
  marker: MarkerPayload;
  note: NotePayload;
  'session-note': SessionNotePayload;
}

export interface BaseEvent<T extends EventType = EventType> {
  id: string;
  sessionId: string;
  /** Milliseconds from session start. */
  t: number;
  tabId?: number;
  type: T;
  /** Static importance score assigned at capture (see events.ts). */
  importance: number;
  /** When true, the trimmer never drops or compacts this event. */
  protected?: boolean;
  payload: EventPayloadMap[T];
}

export type SessionEvent = {
  [K in EventType]: BaseEvent<K>;
}[EventType];

/** An event as emitted by a capture source, before the funnel stamps it. */
export type RawEvent<T extends EventType = EventType> = {
  type: T;
  tabId?: number;
  /** Optional explicit timestamp (ms epoch); the funnel defaults to now. */
  at?: number;
  payload: EventPayloadMap[T];
};

// ----------------------------------------------------------------------------
// Assets
// ----------------------------------------------------------------------------

export interface Asset {
  id: string;
  sessionId: string;
  kind: AssetKind;
  mime: string;
  size: number;
  sha256?: string;
  blob: Blob;
}

/** Asset metadata without the blob, for listings/summaries. */
export type AssetMeta = Omit<Asset, 'blob'>;
