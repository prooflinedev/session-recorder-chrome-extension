import {
  prepareTranscriptionRetry,
  transcriptionFailure,
  transcriptionRequestId,
} from '@/lib/transcription/retry';
import { loadProoflineSettings, requireConnection } from '@/lib/proofline/settings';
import { extractPageKeyterms } from '@/lib/transcription/vocabulary';
/**
 * Background service worker — the session orchestrator.
 *
 * This is the central integration point of the extension: it owns the session
 * state machine, wires every capture source (debugger / network / console /
 * screenshots / multi-tab) into a single `recordEvent` funnel, persists through
 * the storage layer, drives audio + transcription, and answers every typed
 * request from the side panel, options page, content scripts, and offscreen doc.
 *
 * Every captured event — from any source — flows through `recordEvent`, the one
 * place that stamps `t`, importance, and `protected`, updates counts, feeds the
 * live ticker, and lets the screenshot scheduler react. Nothing bypasses it.
 */

import { defineBackground } from 'wxt/utils/define-background';

import {
  broadcast,
  onMessage,
  OFFSCREEN_MARKER,
  sendToTab,
  type AppState,
  type RequestMessage,
} from '@/lib/messaging';
import type {
  AnnotationPayload,
  AnnotationShape,
  Asset,
  AssetKind,
  CaptureSettings,
  EventType,
  FilePayload,
  RawEvent,
  ScreenshotPayload,
  Session,
  SessionEvent,
  TabInfo,
  VoiceSegmentPayload,
} from '@/lib/session/types';
import { PROTECTED_TYPES, scoreEvent } from '@/lib/session/events';
import {
  makeDefaultSettings,
  STORAGE_KEYS,
} from '@/lib/session/settings';
import {
  appendEvents,
  createSession,
  deleteSession,
  EventWriter,
  getAsset,
  getAssetsMeta,
  getEvents,
  getSession,
  listSessions,
  putAsset,
  storageEstimate,
  updateSession,
} from '@/lib/storage';
import { DebuggerManager } from '@/lib/capture/debugger';
import { NetworkCapturer } from '@/lib/capture/network';
import { ConsoleCapturer } from '@/lib/capture/console';
import { ScreenshotScheduler } from '@/lib/capture/screenshots';
import { MultiTabTracker } from '@/lib/capture/multitab';
import { newId } from '@/lib/util/ids';
import { transcribe } from '@/lib/transcription';
import type { TranscriptionConfig } from '@/lib/transcription/provider';
import { estimateForLevels } from '@/lib/export/bundle';
import { nameRecordedSession } from '@/lib/sharing/session-title';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const HEARTBEAT_ALARM = 'sr-heartbeat';
const OFFSCREEN_PATH = 'offscreen.html';
const MIC_PERMISSION_PATH = 'mic-permission.html';

/**
 * Event types still accepted while paused: the user's explicit signals, plus
 * every asset-backed event. The latter is important because these events are
 * only emitted AFTER their blob has already been persisted (a manual screenshot,
 * an annotation-exit shot, a file the user attached, or the final voice segment
 * flushed as the recorder pauses). Dropping them here would orphan the stored
 * asset and inflate `assetBytes` with bytes nothing references.
 */
const ALLOWED_WHILE_PAUSED: ReadonlySet<EventType> = new Set<EventType>([
  'marker',
  'note',
  'session-note',
  'voice-segment',
  // Pausing the session pauses video capture, and the paused recorder flushes
  // its segment AFTER `paused` is already set — dropping it here would orphan
  // the just-stored video asset (same rationale as voice-segment above).
  'video-segment',
  'screenshot',
  'annotation',
  'annotation-start',
  'file-captured',
  'file-attached',
]);

/** Console methods routed to the console capturer (everything else is Network.*). */
const CONSOLE_METHODS = new Set<string>([
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Log.entryAdded',
]);

// ----------------------------------------------------------------------------
// Small pure helpers (module scope)
// ----------------------------------------------------------------------------

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  const m = (e as { message?: unknown })?.message;
  return typeof m === 'string' ? m : String(e);
}

/** Decode a base64 (no data: prefix) string to bytes, in a service worker. */
function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Convert a `data:` URL to a Blob. `fetch` handles data URLs in workers. */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** Name a session after the page it started on: the tab title, else its host. */
function sessionNameFor(tab: chrome.tabs.Tab, now: number): string {
  const title = (tab.title ?? '').replace(/\s+/g, ' ').trim();
  if (title) return title.length > 70 ? `${title.slice(0, 69)}…` : title;
  try {
    const host = new URL(tab.url ?? '').hostname.replace(/^www\./, '');
    if (host) return host;
  } catch {
    /* fall through */
  }
  return `Session ${new Date(now).toLocaleDateString()}`;
}

// ----------------------------------------------------------------------------
// Orchestrator
// ----------------------------------------------------------------------------

class Orchestrator {
  // --- session state ---
  private current: Session | null = null;
  private sessionStartEpoch = 0;
  private paused = false;
  private micOn = false;
  private videoOn = false;
  private annotating = false;
  private pointing = false;

  private writer: EventWriter | null = null;
  /** Last ~30 materialized events for the live ticker. */
  private recent: SessionEvent[] = [];

  /** Most recently activated session tab, for resolving "the active tab". */
  private lastActiveSessionTab: number | undefined;
  /** assetId of the last stored annotation-triggered screenshot. */
  private lastAnnotationShot: string | undefined;
  /** Set only on the last error, surfaced in broadcast state. */
  private lastError: string | undefined;
  /** The most recently stopped session, kept in state until dismissed/replaced. */
  private lastStopped: Session | null = null;
  /** Synchronous guard so concurrent rehydrate() calls don't double-run. */
  private rehydrating = false;
  /** True while the mic is streaming live transcripts (vs batch segments). */
  private micStreaming = false;
  private dictationTarget?: { tabId: number; id: string; since: number; sessionId: string };
  private pageKeyterms: string[] = [];
  private vocabularyReady: Promise<void> = Promise.resolve();
  private vocabularyCache = new Map<string, Promise<string[]>>();

  // --- navigation listeners (bound refs so we can unregister) ---
  private navRegistered = false;

  // --- transcription queue ---
  private readonly transcribing = new Set<string>();
  private readonly transQueue: { sessionId: string; event: SessionEvent }[] = [];
  private transRunning = false;
  private transDone = 0;
  private transTotal = 0;

  // --- capture modules ---
  private readonly dbg: DebuggerManager;
  private readonly network: NetworkCapturer;
  private readonly console: ConsoleCapturer;
  private readonly screenshots: ScreenshotScheduler;
  private readonly multitab: MultiTabTracker;

  constructor() {
    this.dbg = new DebuggerManager();

    this.network = new NetworkCapturer({
      send: (tabId, method, params) => this.dbg.send(tabId, method, params),
      getSettings: () => this.activeSettings(),
      emit: (raw) => this.recordEvent(raw),
      storeBodyAsset: this.storeBodyAsset,
      sessionStart: () => this.sessionStartEpoch,
    });

    this.console = new ConsoleCapturer(
      (raw) => this.recordEvent(raw),
      () => this.activeSettings(),
    );

    this.screenshots = new ScreenshotScheduler({
      captureScreenshot: (tabId, quality) =>
        this.dbg.captureScreenshot(tabId, quality),
      getSettings: () => this.activeSettings(),
      emit: (raw) => this.recordEvent(raw),
      storeScreenshot: this.storeScreenshot,
    });

    this.multitab = new MultiTabTracker({
      isSessionTab: (tabId) => this.isSessionTab(tabId),
      adopt: (tabId, openerTabId, urlHint) => this.adopt(tabId, openerTabId, urlHint),
      onActivated: (tabId) => this.onTabActivated(tabId),
      onClosed: (tabId) => this.onTabClosed(tabId),
    });
  }

  // --------------------------------------------------------------------------
  // Boot — register the always-on chrome listeners exactly once.
  // --------------------------------------------------------------------------

  init(): void {
    // CDP fan-out: one shared listener in DebuggerManager, routed here.
    this.dbg.onEvent((tabId, method, params) => {
      if (method.startsWith('Network.')) {
        this.network.handle(tabId, method, params);
      } else if (CONSOLE_METHODS.has(method)) {
        this.console.handle(tabId, method, params);
      }
    });
    this.dbg.onDetach((tabId, reason) => this.onDebuggerDetach(tabId, reason));

    // Typed request/response messaging.
    onMessage((msg, sender) => this.handleMessage(msg, sender));

    // Keyboard commands.
    chrome.commands.onCommand.addListener((command) => {
      void this.onCommand(command);
    });

    // Heartbeat: flush the event buffer + persist counts while recording.
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== HEARTBEAT_ALARM) return;
      void this.writer?.flush().catch(() => {});
      void this.persistSession();
    });

    // Toolbar click opens the side panel for that tab.
    chrome.action.onClicked.addListener((tab) => {
      if (tab.id === undefined) return;
      void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    });

    // Service-worker lifecycle: recover a live session.
    chrome.runtime.onStartup.addListener(() => void this.rehydrate());
    chrome.runtime.onInstalled.addListener(() => void this.rehydrate());

    // Also attempt recovery on plain SW wake (no onStartup fires then).
    void this.rehydrate();
  }

  // --------------------------------------------------------------------------
  // The one event funnel. Every capture source ends up here.
  // --------------------------------------------------------------------------

  private recordEvent(raw: RawEvent): SessionEvent | undefined {
    const session = this.current;
    if (!session) return undefined;

    const type = raw.type;
    // While paused, drop capture events but keep the user's explicit signals.
    if (this.paused && !ALLOWED_WHILE_PAUSED.has(type)) return undefined;

    const at = raw.at ?? Date.now();
    const event = {
      id: newId('evt'),
      sessionId: session.id,
      t: at - this.sessionStartEpoch,
      tabId: raw.tabId,
      type,
      payload: raw.payload,
      importance: scoreEvent(raw),
      protected: PROTECTED_TYPES.has(type),
    } as SessionEvent;

    // Persist (batched) + keep the summary counts current.
    this.writer?.add(event);
    session.counts[type] = (session.counts[type] ?? 0) + 1;

    // Remember an annotation screenshot's asset so annotation/exit can link it.
    if (type === 'screenshot') {
      const p = event.payload as ScreenshotPayload;
      if (p.trigger === 'annotation') this.lastAnnotationShot = p.assetId;
    }

    // Live ticker.
    this.pushRecent(event);
    broadcast({ kind: 'event/tick', event, counts: session.counts });

    // Let the screenshot policy react to the just-recorded event.
    this.screenshots.onEvent(event);

    return event;
  }

  private pushRecent(event: SessionEvent): void {
    this.recent.push(event);
    if (this.recent.length > 30) this.recent = this.recent.slice(-30);
  }

  private updateRecent(event: SessionEvent): void {
    const idx = this.recent.findIndex((e) => e.id === event.id);
    if (idx >= 0) this.recent[idx] = event;
    // Re-broadcast so the live timeline reflects the change (for example a
    // voice segment whose transcript just finished). The store upserts by id.
    if (this.current) {
      broadcast({
        kind: 'event/tick',
        event,
        counts: this.current.counts,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle: start / adopt / stop / pause / resume
  // --------------------------------------------------------------------------

  private async start(
    tabId: number,
    settingsOverride?: Partial<CaptureSettings>,
  ): Promise<{ ok: boolean; session?: Session; error?: string }> {
    if (this.current) {
      return { ok: false, error: 'A session is already recording.' };
    }

    const defaults = await this.loadDefaultSettings();
    const settings: CaptureSettings = {
      ...makeDefaultSettings(),
      ...defaults,
      ...(settingsOverride ?? {}),
    };

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      return { ok: false, error: `Cannot access tab ${tabId}: ${errMessage(e)}` };
    }

    const now = Date.now();
    const primary: TabInfo = {
      tabId,
      url: tab.url ?? '',
      title: tab.title ?? '',
      role: 'primary',
      attached: false,
      attachedAt: now,
    };
    const session: Session = {
      id: newId('ses'),
      name: sessionNameFor(tab, now),
      startedAt: now,
      initialUrl: tab.url ?? '',
      tabs: [primary],
      settings,
      status: 'recording',
      counts: {},
      assetBytes: 0,
    };

    // Prime in-memory state before capture can fire.
    this.current = session;
    this.lastStopped = null;
    this.sessionStartEpoch = now;
    this.paused = false;
    this.micOn = false;
    this.videoOn = false;
    this.annotating = false;
    this.pointing = false;
    this.recent = [];
    this.lastActiveSessionTab = tabId;
    this.lastAnnotationShot = undefined;
    this.lastError = undefined;
    this.writer = new EventWriter();
    this.network.reset();
    this.console.reset();
    this.screenshots.reset();

    await createSession(session);

    // Attach the debugger for deep capture (network / console / screenshots).
    // A failure here (DevTools open on the tab, another debugger such as an
    // automation harness already attached, or a restricted page) does NOT abort
    // the session — we degrade gracefully: interaction, navigation, marker,
    // note, voice, annotation and file capture all still work; only the
    // CDP-backed streams are unavailable. The gap is recorded as a loud
    // session-note so the report is honest about it.
    let degradedReason: string | undefined;
    try {
      await this.dbg.attach(tabId);
      primary.attached = true;
      primary.attachedAt = Date.now();
    } catch (e) {
      degradedReason = errMessage(e);
      this.lastError = degradedReason;
    }

    this.multitab.start();
    this.registerNavListeners();
    this.startHeartbeat();

    await this.ensureContentScripts(tabId);
    await sendToTab(tabId, { kind: 'content/setActive', active: true, hoverDwellMs: session.settings.hoverDwellMs });
    await this.persistSession();
    this.broadcastState();

    // Always begin with a screenshot of the starting page, regardless of the
    // screenshot policy. Best-effort: silently skipped if deep capture is
    // unavailable (no debugger attached).
    if (!degradedReason) {
      await this.screenshots.capture(tabId, 'nav', 'Session start');
    }

    if (degradedReason) {
      this.recordEvent({
        type: 'session-note',
        tabId,
        payload: {
          kind: 'warning',
          text: `Deep capture unavailable (network/console/screenshots off): ${degradedReason}. Interactions, navigation, voice, annotations and files are still being recorded.`,
        },
      });
    }

    // From-start captures (Record dropdown switches). Owned here rather than by
    // the panel: sequential (video, then mic) so the two never race offscreen
    // setup, state broadcasts stay authoritative, and it works even if the
    // panel goes away mid-start. Failures warn, never fail the session.
    void this.startOptionalCaptures();

    return { ok: true, session };
  }

  /** Turn on video and/or mic per the persisted from-start switches. */
  private async startOptionalCaptures(): Promise<void> {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = await chrome.storage.local.get([
        STORAGE_KEYS.videoFromStart,
        STORAGE_KEYS.micFromStart,
      ]);
    } catch {
      return;
    }
    if (prefs[STORAGE_KEYS.videoFromStart] === true && this.current) {
      try {
        await this.setVideo(true);
      } catch (e) {
        this.recordEvent({
          type: 'session-note',
          payload: {
            kind: 'warning',
            text: `Video capture could not start: ${errMessage(e)}`,
          },
        });
      }
    }
    if (prefs[STORAGE_KEYS.micFromStart] === true && this.current && !this.micOn) {
      try {
        await this.setMic(true);
      } catch (e) {
        this.recordEvent({
          type: 'session-note',
          payload: {
            kind: 'warning',
            text: `Microphone could not start: ${errMessage(e)}`,
          },
        });
      }
    }
  }

  /** Follow the user into a tab the app opened. Errors are swallowed w/ a note. */
  private async adopt(
    tabId: number,
    openerTabId?: number,
    urlHint?: string,
  ): Promise<void> {
    const session = this.current;
    if (!session) return;
    if (this.isSessionTab(tabId)) return;

    // Only follow into real web pages. chrome://, chrome-extension://, about:,
    // devtools:, view-source: and the like can't be debugged and aren't part of
    // the app being recorded — attaching there only produces a failed attach.
    // `||` (not `??`) on purpose: a brand-new tab reports url === '' while its
    // navigation is still pending, so fall through to pendingUrl and then to
    // the urlHint from onCreatedNavigationTarget (noopener tabs never learn
    // their opener, but the nav-target event carries the destination URL).
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = undefined;
    }
    const url = tab?.url || tab?.pendingUrl || urlHint || '';
    if (!/^https?:\/\//i.test(url)) return;

    try {
      const now = Date.now();
      const info: TabInfo = {
        tabId,
        url,
        title: tab?.title ?? '',
        openerTabId,
        role: 'adopted',
        attached: false,
        attachedAt: now,
      };

      // Deep capture is best-effort, mirroring start(): a failed attach (DevTools
      // open, automation CDP holding the tab, …) must not stop us following the
      // tab — interactions and navigation still record via content scripts.
      let degradedReason: string | undefined;
      try {
        await this.dbg.attach(tabId);
        info.attached = true;
        info.attachedAt = Date.now();
      } catch (e) {
        degradedReason = errMessage(e);
      }

      session.tabs.push(info);

      await this.ensureContentScripts(tabId);
      await sendToTab(tabId, { kind: 'content/setActive', active: true, hoverDwellMs: session.settings.hoverDwellMs });
      if (this.pointing) await sendToTab(tabId, {kind:'content/point-annotate',on:true});
      this.recordEvent({
        type: 'tab-opened',
        tabId,
        payload: { url: info.url, title: info.title, openerTabId },
      });
      if (degradedReason) {
        this.recordEvent({
          type: 'session-note',
          tabId,
          payload: {
            kind: 'warning',
            text: `Followed new tab ${tabId} but deep capture unavailable there: ${degradedReason}. Interactions and navigation are still being recorded.`,
          },
        });
      }
      await this.persistSession();
      this.broadcastState();
    } catch (e) {
      this.recordEvent({
        type: 'session-note',
        tabId,
        payload: { kind: 'warning', text: `Failed to adopt tab ${tabId}: ${errMessage(e)}` },
      });
    }
  }

  private async stop(): Promise<{ ok: boolean }> {
    const session = this.current;
    if (!session) return { ok: false };

    session.status = 'stopping';
    this.broadcastState();

    // Don't trust the in-memory flags: rehydrate() forces micOn/videoOn off
    // after a SW restart while the offscreen document (which survives
    // restarts) may still be recording. If it exists, flush both recorders
    // unconditionally — video BEFORE mic, and only close the document after
    // both stop handshakes, so no in-flight segment is killed.
    if (this.videoOn || this.micOn || (await this.hasOffscreen())) {
      await this.sendToOffscreen({ kind: 'video/stop' });
      await this.sendToOffscreen({ kind: 'audio/stop' });
      this.videoOn = false;
      this.micOn = false;
      this.micStreaming = false;
      await this.closeOffscreen().catch(() => {});
    }

    // Emit any still-open websockets (e.g. a chat socket) WITH their accumulated
    // frames before we detach — otherwise the conversation is lost.
    this.network.flushOpen();

    await this.writer?.flush().catch(() => {});
    this.writer?.dispose();

    for (const t of this.dbg.attachedTabs()) {
      await this.dbg.detach(t).catch(() => {});
    }
    this.multitab.stop();
    this.unregisterNavListeners();
    this.stopHeartbeat();

    for (const t of session.tabs) {
      await sendToTab(t.tabId, { kind: 'content/setActive', active: false });
      t.attached = false;
    }

    session.endedAt = Date.now();
    session.status = 'stopped';
    await updateSession(session);

    this.current = null;
    this.dictationTarget = undefined;
    this.pageKeyterms = [];
    this.vocabularyCache.clear();
    // Keep the just-stopped session visible in AppState so the side panel lands
    // on the post-stop review (summary + transcription + export) instead of the
    // idle screen. The panel drops it once the user hits "Done"; a new
    // recording clears it in start().
    this.lastStopped = session;
    this.writer = null;
    this.paused = false;
    this.micOn = false;
    this.videoOn = false;
    this.annotating = false;
    this.pointing = false;
    this.lastError = undefined;
    this.broadcastState();

    // Open the rendered report in a new tab so the user sees the result.
    if ((session.counts && Object.keys(session.counts).length > 0) || session.assetBytes > 0) {
      chrome.tabs.create({
        url: `${chrome.runtime.getURL('share.html')}?session=${session.id}`,
      }).catch(() => {});
    }

    // Queue missing transcripts and name from available evidence without delaying the report.
    void this.transcribePending(session.id).catch(() => {}).then(async () => {
      const renamed = await nameRecordedSession(session);
      if (!renamed) return;
      if (this.lastStopped?.id === renamed.id) this.lastStopped = renamed;
      broadcast({ kind: 'session/updated', session: renamed });
      this.broadcastState();
    }).catch(() => { /* The original page-based name remains usable offline. */ });

    return { ok: true };
  }

  private async pause(): Promise<{ ok: boolean }> {
    const session = this.current;
    if (!session) return { ok: false };
    this.paused = true;
    await this.setPointing(false);
    session.status = 'paused';
    // The offscreen doc may still be recording even when the flags are off
    // (rehydrate() resets them after a SW restart); pause/resume no-op when
    // the respective recorder is idle, so send unconditionally if it exists.
    if (this.micOn || this.videoOn || (await this.hasOffscreen())) {
      void this.sendToOffscreen({ kind: 'audio/pause' });
      void this.sendToOffscreen({ kind: 'video/pause' });
    }
    await this.persistSession();
    this.broadcastState();
    return { ok: true };
  }

  private async resume(): Promise<{ ok: boolean }> {
    const session = this.current;
    if (!session) return { ok: false };
    this.paused = false;
    session.status = 'recording';
    if (this.micOn) void this.sendToOffscreen({ kind: 'audio/resume' });
    if (this.videoOn) await this.resumeVideo();
    await this.persistSession();
    this.broadcastState();
    return { ok: true };
  }

  /**
   * Restart video capture after a session resume. The paused recorder's stream
   * is dead (tabCapture streams end when their recorder stops), so a FRESH
   * stream id must be minted right before the offscreen doc re-acquires it.
   * Failure degrades to "video off" with a loud session note, never an error.
   */
  private async resumeVideo(): Promise<void> {
    try {
      const tabId = await this.activeSessionTabId();
      if (tabId < 0) throw new Error('No session tab to capture.');
      const streamId = await this.getTabStreamId(tabId);
      const res = await this.sendToOffscreen({
        kind: 'video/resume',
        streamId,
        // Tab audio is captured by default; acquireStream falls back to
        // video-only when the tab has no capturable audio.
        audio: true,
      });
      if (!res || !res.ok) {
        throw new Error((res && res.error) || 'Video capture did not resume.');
      }
    } catch (e) {
      this.videoOn = false;
      this.recordEvent({
        type: 'session-note',
        payload: {
          kind: 'warning',
          text: `Video recording could not resume: ${errMessage(e)}`,
        },
      });
    }
  }

  // --------------------------------------------------------------------------
  // CDP detach + tab lifecycle
  // --------------------------------------------------------------------------

  private onDebuggerDetach(tabId: number, reason: string): void {
    const session = this.current;
    if (!session) return;

    const info = session.tabs.find((t) => t.tabId === tabId);
    if (info) {
      info.attached = false;
      info.detachedAt = Date.now();
    }
    this.recordEvent({
      type: 'session-note',
      tabId,
      payload: { kind: 'detach', text: `Debugger detached from tab ${tabId} (${reason}).` },
    });

    // Keep the session alive even if nothing is attached — just note it.
    if (!session.tabs.some((t) => t.attached)) {
      this.recordEvent({
        type: 'session-note',
        payload: {
          kind: 'warning',
          text: 'All tabs are detached; recording continues but capture is paused until re-attach.',
        },
      });
    }
    void this.persistSession();
    this.broadcastState();
  }

  private onTabActivated(tabId: number): void {
    const session = this.current;
    if (!session) return;
    if (!this.isSessionTab(tabId)) return;

    const from = this.lastActiveSessionTab;
    this.lastActiveSessionTab = tabId;

    // Only record a switch when moving between two session tabs.
    if (from !== undefined && from !== tabId && this.isSessionTab(from)) {
      const info = session.tabs.find((t) => t.tabId === tabId);
      this.recordEvent({
        type: 'tab-switch',
        tabId,
        payload: {
          fromTabId: from,
          toTabId: tabId,
          toUrl: info?.url,
          toTitle: info?.title,
        },
      });
    }
  }

  private onTabClosed(tabId: number): void {
    const session = this.current;
    if (!session) return;
    const info = session.tabs.find((t) => t.tabId === tabId);
    if (!info) return;

    info.attached = false;
    info.detachedAt = Date.now();
    this.recordEvent({
      type: 'tab-closed',
      tabId,
      payload: { url: info.url, title: info.title },
    });
    // Closing the tab manual actions target (screenshot/annotation) must re-point
    // that target, or those actions silently fail against a dead tab id.
    if (this.lastActiveSessionTab === tabId) {
      void this.switchBackAfterClose(tabId, info);
    }
    void this.persistSession();
    this.broadcastState();
  }

  /**
   * After the active session tab closes, re-point `lastActiveSessionTab` at the
   * tab Chrome revealed (recording the tab-switch if it is a session tab), or
   * silently at the opener/primary/any surviving session tab otherwise.
   *
   * Chrome does not guarantee onRemoved/onActivated ordering, so this is written
   * to be order-agnostic: if tabs.onActivated already re-pointed the target (and
   * recorded the switch), the re-check after the await bails out; if this method
   * wins the race instead, onTabActivated's `from !== tabId` guard suppresses
   * its duplicate event.
   */
  private async switchBackAfterClose(
    closedTabId: number,
    info: TabInfo,
  ): Promise<void> {
    const session = this.current;
    if (!session) return;

    let revealed: chrome.tabs.Tab | undefined;
    try {
      [revealed] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      revealed = undefined;
    }

    // onTabActivated handled the reveal while we awaited — nothing to do.
    if (this.lastActiveSessionTab !== closedTabId) return;

    const revealedId = revealed?.id;
    if (revealedId !== undefined && this.isSessionTab(revealedId)) {
      this.lastActiveSessionTab = revealedId;
      const to = session.tabs.find((t) => t.tabId === revealedId);
      this.recordEvent({
        type: 'tab-switch',
        tabId: revealedId,
        payload: {
          fromTabId: closedTabId,
          toTabId: revealedId,
          toUrl: to?.url,
          toTitle: to?.title,
        },
      });
      return;
    }

    // The user landed on a non-session tab (or nothing is focused, e.g. a whole
    // window closed). Re-point silently — no fake tab-switch event — to the
    // first still-existing candidate: opener, then primary, then any session tab.
    const primary = session.tabs.find((t) => t.role === 'primary');
    const candidates = [
      info.openerTabId,
      primary?.tabId,
      ...session.tabs.map((t) => t.tabId),
    ].filter(
      (id): id is number => id !== undefined && id !== closedTabId,
    );
    for (const id of candidates) {
      try {
        await chrome.tabs.get(id);
        this.lastActiveSessionTab = id;
        return;
      } catch {
        /* tab gone too — try the next candidate */
      }
    }
    this.lastActiveSessionTab = undefined;
  }

  // --------------------------------------------------------------------------
  // Navigation (chrome.webNavigation) — nav + spa-route capture
  // --------------------------------------------------------------------------

  private readonly onNavCommitted = (
    details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  ): void => {
    if (details.frameId !== 0) return;
    if (!this.isSessionTab(details.tabId)) return;
    // Keep the registry current so tab-switch/tab-closed events report where the
    // tab actually is, not where it was at adopt time (noopener tabs adopt with
    // only a hint URL, before the navigation commits).
    const info = this.current?.tabs.find((t) => t.tabId === details.tabId);
    if (info) info.url = details.url;
    this.recordEvent({
      type: 'nav',
      tabId: details.tabId,
      payload: { url: details.url, transitionType: details.transitionType },
    });
  };

  private readonly onHistoryStateUpdated = (
    details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  ): void => {
    if (details.frameId !== 0) return;
    if (!this.isSessionTab(details.tabId)) return;
    this.recordEvent({
      type: 'spa-route',
      tabId: details.tabId,
      payload: { url: details.url, method: 'pushState' },
    });
  };

  private readonly onReferenceFragmentUpdated = (
    details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  ): void => {
    if (details.frameId !== 0) return;
    if (!this.isSessionTab(details.tabId)) return;
    this.recordEvent({
      type: 'spa-route',
      tabId: details.tabId,
      payload: { url: details.url, method: 'replaceState' },
    });
  };

  private registerNavListeners(): void {
    if (this.navRegistered) return;
    this.navRegistered = true;
    chrome.webNavigation.onCommitted.addListener(this.onNavCommitted);
    chrome.webNavigation.onHistoryStateUpdated.addListener(this.onHistoryStateUpdated);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(
      this.onReferenceFragmentUpdated,
    );
  }

  private unregisterNavListeners(): void {
    if (!this.navRegistered) return;
    this.navRegistered = false;
    chrome.webNavigation.onCommitted.removeListener(this.onNavCommitted);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(this.onHistoryStateUpdated);
    chrome.webNavigation.onReferenceFragmentUpdated.removeListener(
      this.onReferenceFragmentUpdated,
    );
  }

  // --------------------------------------------------------------------------
  // Message dispatch
  // --------------------------------------------------------------------------

  /**
   * Test-only entry point: drive the real message dispatcher directly, without
   * a live extension view. Used by the Playwright E2E suite (via a service-worker
   * `evaluate`) so recording can be started against an explicit tab id — which
   * also sidesteps the chrome.debugger/automation-CDP conflict by exercising the
   * graceful degraded path. Not reachable from web pages.
   */
  dispatchForTest(msg: RequestMessage, senderTabId?: number): Promise<unknown> {
    const sender = {
      tab:
        senderTabId !== undefined
          ? ({ id: senderTabId } as chrome.tabs.Tab)
          : undefined,
    } as chrome.runtime.MessageSender;
    return Promise.resolve(this.handleMessage(msg, sender));
  }

  private async handleMessage(
    msg: RequestMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> {
    switch (msg.kind) {
      // --- session lifecycle ---
      case 'session/start':
        return this.start(msg.tabId, msg.settings);
      case 'session/stop':
        return this.stop();
      case 'session/pause':
        return this.pause();
      case 'session/resume':
        return this.resume();
      case 'session/getState':
        return this.buildState();

      // --- session data ---
      case 'session/list':
        return { sessions: await listSessions() };
      case 'session/get':
        return { session: (await getSession(msg.sessionId)) ?? null };
      case 'session/delete': {
        if (this.current?.id === msg.sessionId) await this.stop();
        await deleteSession(msg.sessionId);
        return { ok: true };
      }
      case 'session/rename': {
        const s = await getSession(msg.sessionId);
        if (s) {
          s.name = msg.name;
          await updateSession(s);
          if (this.lastStopped?.id === s.id) this.lastStopped = s;
          broadcast({ kind: 'session/updated', session: s });
          const cur = this.current;
          if (cur && cur.id === s.id) {
            cur.name = msg.name;
            this.broadcastState();
          }
        }
        return { ok: true };
      }

      // --- capture (content -> bg) ---
      case 'capture/event': {
        const raw = { ...msg.event, tabId: msg.event.tabId ?? sender.tab?.id };
        this.recordEvent(raw);
        return { ok: true };
      }
      case 'capture/fileBlob':
        return this.handleFileBlob(msg.event, msg.dataUrl, sender);

      // --- content handshake / annotation ---
      case 'content/hello': {
        const tabId = sender.tab?.id;
        const active =
          !!this.current && tabId !== undefined && this.isSessionTab(tabId);
        return { active: active && !this.paused, annotating: this.annotating, pointing: this.pointing && !this.paused, micOn: this.micOn };
      }
      case 'dictation/focus': {
        const tabId = sender.tab?.id;
        if (!this.current || this.paused || !this.pointing || tabId === undefined || !this.isSessionTab(tabId)) return { ok: false, micOn: this.micOn };
        const target = { tabId, id: msg.id, since: Date.now() - this.sessionStartEpoch, sessionId: this.current.id };
        this.dictationTarget = target;
        this.vocabularyReady = this.prepareVocabulary(msg.context, target).catch(() => {});
        return { ok: true, micOn: this.micOn };
      }
      case 'dictation/blur':
        if (this.dictationTarget?.id === msg.id && this.dictationTarget.tabId === sender.tab?.id) this.dictationTarget = undefined;
        return { ok: true };
      case 'dictation/mic': {
        if (!this.current || !this.pointing || sender.tab?.id !== this.dictationTarget?.tabId) return { ok: false, micOn: this.micOn };
        const config = await this.loadTranscriptionConfig();
        if (msg.on && !config) return { ok: false, micOn: this.micOn, error: 'Set up a transcription provider in Settings → Transcription to dictate comments.' };
        try { if (msg.on) await this.vocabularyReady; await this.setMic(msg.on); return { ok: this.micOn === msg.on, micOn: this.micOn, error: this.lastError }; }
        catch (error) { return { ok: false, micOn: this.micOn, error: errMessage(error) }; }
      }
      case 'annotation/exit':
        return this.handleAnnotationExit(
          msg.shapes,
          msg.viewport,
          msg.image,
          sender,
        );

      // --- manual capture actions ---
      case 'screenshot/capture': {
        const tabId = await this.activeSessionTabId();
        if (tabId >= 0) await this.screenshots.capture(tabId, 'manual');
        return { ok: true };
      }
      case 'marker/add':
        this.addMarker(msg.name);
        return { ok: true };
      case 'note/add':
        this.recordEvent({ type: 'note', payload: { text: msg.text } });
        return { ok: true };
      case 'point-annotation/toggle':
        return this.setPointing(msg.on ?? !this.pointing);
      case 'point-annotation/save':
        return this.savePointAnnotation(msg, sender);
      case 'annotation/toggle': {
        const annotating = await this.toggleAnnotation();
        return { ok: true, annotating };
      }
      case 'file/attach':
        return this.handleFileAttach(msg);

      // --- voice ---
      case 'mic/toggle': {
        try {
          await this.setMic(msg.on);
          return { ok: true, micOn: this.micOn };
        } catch (e) {
          return { ok: false, micOn: this.micOn, error: errMessage(e) };
        }
      }

      // --- tab video ---
      case 'video/toggle': {
        try {
          await this.setVideo(msg.on);
          return { ok: true, videoOn: this.videoOn };
        } catch (e) {
          return { ok: false, videoOn: this.videoOn, error: errMessage(e) };
        }
      }
      case 'transcription/retry': {
        const events = await getEvents(msg.sessionId);
        const ev = events.find(
          (e) => e.id === msg.eventId && e.type === 'voice-segment',
        );
        if (ev && !this.transcribing.has(`${msg.sessionId}/${ev.id}`)) {
          const payload = prepareTranscriptionRetry(ev.payload as VoiceSegmentPayload);
          const retry = { ...ev, payload } as SessionEvent;
          if (payload !== ev.payload) await appendEvents([retry]);
          this.enqueueTranscription(retry, msg.sessionId);
        }
        return { ok: true };
      }

      // --- audio / video segments (offscreen -> bg) ---
      case 'audio/segment':
        return this.handleAudioSegment(msg);
      case 'video/segment':
        return this.handleVideoSegment(msg);
      case 'audio/level':
        broadcast({ kind: 'mic/level', level: msg.level });
        return { ok: true };

      // --- live streaming transcription (offscreen -> bg) ---
      case 'transcript/final':
        return this.handleTranscriptFinal(msg);
      case 'transcript/interim':
        this.routeDictation(msg.sessionId, msg.text, false, msg.tStart);
        broadcast({ kind: 'transcript/live', text: msg.text, final: false });
        return { ok: true };

      // --- audio/video control echoes (bg -> offscreen); harmless no-op here ---
      case 'audio/keyterms':
      case 'audio/start':
      case 'audio/pause':
      case 'audio/resume':
      case 'audio/stop':
      case 'video/start':
      case 'video/pause':
      case 'video/resume':
      case 'video/stop':
        return { ok: true };

      // --- data reads ---
      case 'events/get':
        return { events: await getEvents(msg.sessionId) };
      case 'assets/getMeta':
        return { assets: await getAssetsMeta(msg.sessionId) };

      // --- export / storage ---
      case 'export/estimate': {
        const session = await getSession(msg.sessionId);
        if (!session) return { estimates: [] };
        const events = await getEvents(msg.sessionId);
        const assets = await getAssetsMeta(msg.sessionId);
        return { estimates: estimateForLevels(events, assets, session) };
      }
      case 'storage/estimate':
        return storageEstimate();

      default:
        return { ok: false, error: `Unhandled message: ${(msg as { kind: string }).kind}` };
    }
  }

  private async handleFileBlob(
    event: RawEvent,
    dataUrl: string,
    sender: chrome.runtime.MessageSender,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.current) return { ok: false, error: 'No active session.' };
    const p = event.payload as FilePayload;
    const blob = await dataUrlToBlob(dataUrl);

    // Enforce the session's configured file cap here (the content script only
    // applies a coarse client-side guard). Oversized files are recorded as
    // metadata only — no blob stored.
    const cap = this.current.settings.fileCapBytes;
    if (blob.size > cap) {
      this.recordEvent({
        type: 'file-captured',
        tabId: event.tabId ?? sender.tab?.id,
        payload: { ...p, size: blob.size, metadataOnly: true, assetId: undefined },
      });
      return { ok: true };
    }

    const asset = await this.putAssetBlob('file', blob, p.mime);
    this.recordEvent({
      type: 'file-captured',
      tabId: event.tabId ?? sender.tab?.id,
      payload: { ...p, assetId: asset.id, size: asset.size },
    });
    return { ok: true };
  }

  private async handleFileAttach(msg: {
    fileName: string;
    mime: string;
    dataUrl: string;
    note?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!this.current) return { ok: false, error: 'No active session.' };
    const blob = await dataUrlToBlob(msg.dataUrl);
    const asset = await this.putAssetBlob('file', blob, msg.mime);
    this.recordEvent({
      type: 'file-attached',
      payload: {
        assetId: asset.id,
        fileName: msg.fileName,
        mime: msg.mime,
        size: asset.size,
        note: msg.note,
      },
    });
    return { ok: true };
  }

  private async handleAnnotationExit(
    shapes: unknown,
    viewport: { w: number; h: number },
    image: string | undefined,
    sender: chrome.runtime.MessageSender,
  ): Promise<{ ok: boolean }> {
    this.annotating = false;
    broadcast({ kind: 'annotation/state', annotating: false });

    // Resume interaction capture in the tab (the editor tore itself down). Use
    // setActive, NOT content/annotate{on:false}: the latter is also handled by
    // the annotation script and, arriving asynchronously, would race with and
    // close the *next* annotation's editor.
    const st = sender.tab?.id;
    if (st !== undefined && this.isSessionTab(st)) {
      void sendToTab(st, {
        kind: 'content/setActive',
        active: true,
        hoverDwellMs: this.current?.settings.hoverDwellMs,
      });
    }

    const shapeList: AnnotationShape[] = Array.isArray(shapes)
      ? (shapes as AnnotationShape[])
      : [];

    // Cancel: the editor closed without an image. Just reset state, no event.
    if (!image) {
      this.broadcastState();
      return { ok: true };
    }

    const senderTab = sender.tab?.id;
    const tabId =
      senderTab !== undefined && this.isSessionTab(senderTab)
        ? senderTab
        : await this.activeSessionTabId();

    // The editor sends the finished annotated image; store it as the screenshot
    // asset for this annotation (no second capture needed).
    let screenshotAssetId: string | undefined;
    try {
      const blob = await dataUrlToBlob(image);
      const asset = await this.putAssetBlob('screenshot', blob, blob.type);
      screenshotAssetId = asset.id;
    } catch {
      /* if the image fails to decode, record the shapes without an image */
    }

    const payload: AnnotationPayload = {
      shapes: shapeList,
      screenshotAssetId,
      viewport,
    };
    this.recordEvent({
      type: 'annotation',
      tabId: tabId >= 0 ? tabId : undefined,
      payload,
    });
    this.broadcastState();
    return { ok: true };
  }

  private async handleAudioSegment(msg: {
    sessionId: string;
    tStart: number;
    tEnd: number;
    dataUrl: string;
    mime: string;
  }): Promise<{ ok: boolean }> {
    const session = this.current;
    if (!session) return { ok: false };
    const blob = await dataUrlToBlob(msg.dataUrl);
    const asset = await this.putAssetBlob('audio', blob, msg.mime);

    if (this.micStreaming) {
      // Streaming mode: transcripts already arrived live as their own
      // voice-segment events. This is the full-session audio file — attach it to
      // the first streamed segment so it lands in the export; if there were no
      // transcripts, keep a bare audio-only segment.
      const attached = await this.attachAudioToSegment(session.id, asset.id);
      if (!attached) {
        this.recordEvent({
          type: 'voice-segment',
          payload: {
            assetId: asset.id,
            tStart: msg.tStart,
            tEnd: msg.tEnd,
            transcript: null,
          },
        });
      }
      return { ok: true };
    }

    // Batch mode: create a voice-segment and transcribe it after the fact.
    const ev = this.recordEvent({
      type: 'voice-segment',
      payload: {
        assetId: asset.id,
        tStart: msg.tStart,
        tEnd: msg.tEnd,
        transcript: null,
      },
    });
    if (ev) this.enqueueTranscription(ev, session.id);
    return { ok: true };
  }

  /** Record a finished tab-video take as a video-segment event. */
  private async handleVideoSegment(msg: {
    sessionId: string;
    tStart: number;
    tEnd: number;
    assetId: string;
    size: number;
  }): Promise<{ ok: boolean }> {
    const session = this.current;
    if (!session) return { ok: false };
    // The offscreen document already wrote the blob to IndexedDB (a take is
    // unbounded in size and cannot cross runtime messaging); only book the
    // bytes and record the event here.
    session.assetBytes += msg.size;
    this.recordEvent({
      // Stamp the event at the moment the take BEGAN (like transcript/final)
      // so a minutes-long segment interleaves where it started, and the
      // exported video/NNN-mmss.webm name matches its report line.
      at: this.sessionStartEpoch + msg.tStart,
      type: 'video-segment',
      payload: { assetId: msg.assetId, tStart: msg.tStart, tEnd: msg.tEnd },
    });
    return { ok: true };
  }

  /** Record a live streaming transcript as a real-time voice-segment event. */
  private handleTranscriptFinal(msg: {
    sessionId: string;
    tStart: number;
    tEnd: number;
    text: string;
    words?: { word: string; t: number }[];
    provider: string;
  }): { ok: boolean } {
    const session = this.current;
    if (!session || session.id !== msg.sessionId) return { ok: false };
    this.routeDictation(msg.sessionId, msg.text, true, msg.tStart);
    this.recordEvent({
      // Stamp the event at the moment the utterance BEGAN so it interleaves into
      // the timeline next to what the user was doing/seeing as they said it.
      at: this.sessionStartEpoch + msg.tStart,
      type: 'voice-segment',
      payload: {
        tStart: msg.tStart,
        tEnd: msg.tEnd,
        transcript: msg.text,
        words: msg.words,
        streamed: true,
        provider: msg.provider,
      },
    });
    broadcast({ kind: 'transcript/live', text: msg.text, final: true });
    return { ok: true };
  }

  /** Attach an audio asset to the first voice-segment that lacks one. */
  private async attachAudioToSegment(
    sessionId: string,
    assetId: string,
  ): Promise<boolean> {
    await this.writer?.flush();
    const events = await getEvents(sessionId);
    const target = events.find(
      (e) => e.type === 'voice-segment' && !e.payload.assetId,
    );
    if (!target || target.type !== 'voice-segment') return false;
    target.payload.assetId = assetId;
    await appendEvents([target]);
    return true;
  }

  // --------------------------------------------------------------------------
  // Commands (keyboard shortcuts)
  // --------------------------------------------------------------------------

  private async onCommand(command: string): Promise<void> {
    if (!this.current) return;
    if (command === 'toggle-annotation') {
      await this.toggleAnnotation();
    } else if (command === 'add-marker') {
      this.addMarker();
    }
  }

  private addMarker(name?: string): void {
    const count = this.current?.counts.marker ?? 0;
    this.recordEvent({
      type: 'marker',
      payload: { name: name ?? `Marker ${count + 1}` },
    });
  }

  private async setPointing(on: boolean): Promise<{ok:boolean; pointing:boolean; error?:string}> {
    if (on && (!this.current || this.paused)) return {ok:false, pointing:false, error:'Resume recording to annotate the page.'};
    if (on && this.annotating) {
      for (const tab of this.current!.tabs) await sendToTab(tab.tabId, {kind:'content/annotate',on:false});
      this.annotating = false;
    }
    this.pointing = on;
    if (!on) this.dictationTarget = undefined;
    for (const tab of this.current?.tabs ?? []) await sendToTab(tab.tabId, {kind:'content/point-annotate',on});
    this.broadcastState();
    return {ok:true, pointing:on};
  }

  private async savePointAnnotation(msg: Extract<RequestMessage, {kind:'point-annotation/save'}>, sender: chrome.runtime.MessageSender): Promise<{ok:boolean;error?:string}> {
    const session = this.current;
    const tabId = sender.tab?.id;
    if (!session || this.paused || !this.pointing || tabId === undefined || !this.isSessionTab(tabId) || (sender.frameId ?? 0) !== 0) return {ok:false,error:'Resume recording and turn annotation on to add a comment.'};
    const text = msg.text?.trim().slice(0,4000);
    if (!text || !msg.rect || ![msg.rect.x,msg.rect.y,msg.rect.w,msg.rect.h,msg.viewport?.w,msg.viewport?.h].every(Number.isFinite) || msg.rect.w<=0 || msg.rect.h<=0 || msg.viewport.w<=0 || msg.viewport.h<=0) return {ok:false,error:'Select an element or area and enter a comment.'};
    const image = await this.captureTabImage(tabId).catch(()=>undefined);
    if (this.current !== session || this.paused) return {ok:false,error:'Recording ended before this comment was saved.'};
    let screenshotAssetId: string | undefined;
    if (image) {
      const blob = await dataUrlToBlob(image);
      if (this.current !== session || this.paused) return {ok:false,error:'Recording ended before this comment was saved.'};
      const asset = await this.putAssetBlob('screenshot',blob,blob.type);
      screenshotAssetId = asset.id;
    }
    if (this.current !== session || this.paused) return {ok:false,error:'Recording ended before this comment was saved.'};
    const payload: AnnotationPayload = {shapes:[{tool:'text', text, color:'#2f6df0', strokeWidth:2, rect:msg.rect, targetDescriptor:msg.descriptor}],screenshotAssetId,viewport:msg.viewport};
    this.recordEvent({type:'annotation',tabId,payload});
    await this.writer?.flush();
    this.broadcastState();
    return {ok:true};
  }

  private async toggleAnnotation(): Promise<boolean> {
    if (!this.current || this.paused) return false;
    if (this.pointing) await this.setPointing(false);
    this.annotating = !this.annotating;
    const tabId = await this.activeSessionTabId();
    if (tabId >= 0) {
      if (this.annotating) {
        // Freeze the current view and hand it to the editor to annotate. This
        // avoids drawing on a moving page and lets the editor work on a stable
        // image.
        const image = await this.captureTabImage(tabId).catch(() => undefined);
        await sendToTab(tabId, {
          kind: 'content/annotate',
          on: true,
          image,
        });
      } else {
        await sendToTab(tabId, { kind: 'content/annotate', on: false });
      }
    }
    broadcast({ kind: 'annotation/state', annotating: this.annotating });
    this.broadcastState();
    return this.annotating;
  }

  /** Grab the current tab view as a JPEG data URL (debugger, else tabs API). */
  private async captureTabImage(tabId: number): Promise<string | undefined> {
    if (this.dbg.isAttached(tabId)) {
      const { data } = await this.dbg.captureScreenshot(tabId, 90);
      return `data:image/jpeg;base64,${data}`;
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      return await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 90,
      });
    } catch {
      return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Audio / video / offscreen
  // --------------------------------------------------------------------------

  private async prepareVocabulary(context: string, target: NonNullable<Orchestrator['dictationTarget']>): Promise<void> {
    const key = `${target.sessionId}:${context.slice(0, 6000)}`;
    let pending = this.vocabularyCache.get(key);
    if (!pending) {
      if (this.vocabularyCache.size >= 8) this.vocabularyCache.delete(this.vocabularyCache.keys().next().value!);
      pending = extractPageKeyterms(context).catch(() => []);
      this.vocabularyCache.set(key, pending);
    }
    const terms = await pending;
    if (this.current?.id !== target.sessionId || this.dictationTarget !== target) return;
    this.pageKeyterms = terms;
    if (this.micOn) await this.sendToOffscreen({ kind: 'audio/keyterms', keyterms: terms });
  }

  private routeDictation(sessionId: string, text: string, final: boolean, tStart?: number): void {
    const target = this.dictationTarget;
    if (!target || this.paused || !this.pointing || target.sessionId !== sessionId || this.current?.id !== sessionId || tStart === undefined || tStart < target.since || !text.trim()) return;
    void sendToTab(target.tabId, { kind: 'content/dictation', id: target.id, segment: `${sessionId}:${tStart}`, text, final });
  }

  private async setMic(on: boolean): Promise<void> {
    if (on === this.micOn) return;
    if (on) {
      const session = this.current;
      if (!session) throw new Error('No active session to narrate.');
      if (!(await this.isMicGranted())) {
        await this.requestMicPermission();
      }
      await this.ensureOffscreen();
      // Hand the transcription config to the offscreen doc so it can stream live
      // (Deepgram). Await the getUserMedia result: only claim the mic is on if
      // recording actually started.
      const config = await this.loadTranscriptionConfig();
      const res = await this.sendToOffscreen({
        kind: 'audio/start',
        sessionId: session.id,
        startedAt: this.sessionStartEpoch,
        transcription: config ? { ...config, keyterms: this.pageKeyterms } : null,
      });
      if (res && res.ok) {
        this.micOn = true;
        this.micStreaming = res.streaming === true;
        this.lastError = undefined;
      } else {
        this.micOn = false;
        this.micStreaming = false;
        this.lastError =
          (res && res.error) || 'Could not start the microphone.';
        // The offscreen document is shared with video capture — only tear it
        // down when video isn't using it.
        if (!this.videoOn) await this.closeOffscreen().catch(() => {});
      }
    } else {
      // Await the stop handshake so the offscreen has emitted + delivered its
      // final segment BEFORE we tear the document down (otherwise the last
      // up-to-30s of narration is lost to the destroy-before-flush race).
      await this.sendToOffscreen({ kind: 'audio/stop' });
      this.micOn = false;
      this.micStreaming = false;
      if (!this.videoOn) await this.closeOffscreen().catch(() => {});
    }
    this.broadcastState();
  }

  /**
   * Toggle tab video capture, mirroring `setMic`. Turning on resolves the
   * active session tab, mints a tabCapture stream id in the SW, and hands it to
   * the shared offscreen document. Turning off awaits the stop handshake so the
   * final segment is delivered before the document may be torn down. Throws a
   * readable error on failure (surfaced by the `video/toggle` response) — a tab
   * that cannot be captured must not break the session.
   */
  private async setVideo(on: boolean): Promise<void> {
    if (on) {
      const session = this.current;
      if (!session) throw new Error('No active session to record video for.');
      const tabId = await this.activeSessionTabId();
      if (tabId < 0) throw new Error('No session tab to capture.');
      const streamId = await this.getTabStreamId(tabId);
      await this.ensureOffscreen();
      const res = await this.sendToOffscreen({
        kind: 'video/start',
        sessionId: session.id,
        startedAt: this.sessionStartEpoch,
        streamId,
        // Tab audio is captured by default; acquireStream falls back to
        // video-only when the tab has no capturable audio.
        audio: true,
      });
      if (res && res.ok) {
        this.videoOn = true;
        this.lastError = undefined;
      } else {
        this.videoOn = false;
        if (!this.micOn) await this.closeOffscreen().catch(() => {});
        throw new Error(
          (res && res.error) || 'Could not start tab video capture.',
        );
      }
    } else {
      // Await the stop handshake: the offscreen must deliver the final video
      // segment before the document may be destroyed.
      await this.sendToOffscreen({ kind: 'video/stop' });
      this.videoOn = false;
      if (!this.micOn) await this.closeOffscreen().catch(() => {});
    }
    this.broadcastState();
  }

  /**
   * Promise wrapper over `chrome.tabCapture.getMediaStreamId`. Stream ids are
   * single-use and expire in seconds, so callers mint one right before use.
   * Fails with a readable error when tab capture is unavailable (unsupported
   * browser/page, or the extension was never invoked on the tab — the E2E
   * degraded path).
   */
  private getTabStreamId(tabId: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const tabCapture = chrome.tabCapture;
      if (!tabCapture || typeof tabCapture.getMediaStreamId !== 'function') {
        reject(new Error('Tab capture is not available in this browser.'));
        return;
      }
      try {
        tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
          const err = chrome.runtime.lastError;
          if (err || !streamId) {
            reject(
              new Error(err?.message || 'Could not get a tab capture stream.'),
            );
          } else {
            resolve(streamId);
          }
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private sendToOffscreen(
    msg: Extract<
      RequestMessage,
      {
        kind:
          | 'audio/start'
          | 'audio/pause'
          | 'audio/resume'
          | 'audio/keyterms'
          | 'audio/stop'
          | 'video/start'
          | 'video/pause'
          | 'video/resume'
          | 'video/stop';
      }
    >,
  ): Promise<
    { ok: boolean; error?: string; streaming?: boolean } | undefined
  > {
    // Reaches the offscreen document's onMessage listener; the OFFSCREEN_MARKER
    // tells the background's own request handler to ignore it, so only the
    // offscreen document responds. Returns that response so callers can await
    // the start result / stop-flush completion.
    return chrome.runtime
      .sendMessage({ ...msg, [OFFSCREEN_MARKER]: true })
      .catch(() => undefined);
  }

  private async isMicGranted(): Promise<boolean> {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.micGranted);
      return got[STORAGE_KEYS.micGranted] === true;
    } catch {
      return false;
    }
  }

  /** Open the visible permission page and wait until the grant is recorded. */
  private async requestMicPermission(): Promise<void> {
    const url = chrome.runtime.getURL(MIC_PERMISSION_PATH);
    const tab = await chrome.tabs.create({ url });
    const openedTabId = tab.id;

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        chrome.storage.onChanged.removeListener(onChanged);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for microphone permission.'));
      }, 120_000);
      const onChanged = (
        changes: { [key: string]: chrome.storage.StorageChange },
        area: string,
      ): void => {
        if (area === 'local' && changes[STORAGE_KEYS.micGranted]?.newValue === true) {
          cleanup();
          resolve();
        }
      };
      const onRemoved = (closedTabId: number): void => {
        if (closedTabId !== openedTabId) return;
        void this.isMicGranted().then((granted) => {
          cleanup();
          if (granted) resolve();
          else reject(new Error('Microphone permission was not granted.'));
        });
      };
      chrome.storage.onChanged.addListener(onChanged);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  }

  /** In-flight creation, so concurrent callers (mic + video starting together)
   *  don't both call createDocument — the second would throw. */
  private offscreenCreating: Promise<void> | null = null;

  private async ensureOffscreen(): Promise<void> {
    if (this.offscreenCreating) return this.offscreenCreating;
    if (await this.hasOffscreen()) return;
    this.offscreenCreating = chrome.offscreen
      .createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_PATH),
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification:
          'Record microphone narration and tab video during a session.',
      })
      .finally(() => {
        this.offscreenCreating = null;
      });
    return this.offscreenCreating;
  }

  private async closeOffscreen(): Promise<void> {
    if (await this.hasOffscreen()) await chrome.offscreen.closeDocument();
  }

  private async hasOffscreen(): Promise<boolean> {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      return contexts.length > 0;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Transcription queue (sequential)
  // --------------------------------------------------------------------------

  private enqueueTranscription(event: SessionEvent, sessionId: string): void {
    const key = `${sessionId}/${event.id}`;
    if (this.transcribing.has(key)) return;
    this.transcribing.add(key);
    this.transTotal += 1;
    this.transQueue.push({ sessionId, event });
    void this.drainTranscription();
  }

  private async drainTranscription(): Promise<void> {
    if (this.transRunning) return;
    this.transRunning = true;
    try {
      for (;;) {
        const job = this.transQueue.shift();
        if (!job) break;
        try {
          await this.runTranscription(job.sessionId, job.event);
        } finally {
          this.transcribing.delete(`${job.sessionId}/${job.event.id}`);
        }
        this.transDone += 1;
        broadcast({
          kind: 'transcription/progress',
          sessionId: job.sessionId,
          done: this.transDone,
          total: this.transTotal,
        });
      }
    } finally {
      this.transRunning = false;
      // Reset counters once the queue is fully drained.
      this.transDone = 0;
      this.transTotal = 0;
    }
  }

  private async runTranscription(
    sessionId: string,
    event: SessionEvent,
  ): Promise<void> {
    let payload = event.payload as VoiceSegmentPayload;
    // Make sure the base event is durable before we overwrite it (put by id).
    await this.writer?.flush().catch(() => {});

    try {
      const config = await this.loadTranscriptionConfig();
      if (!config) return; // no provider configured — leave transcript null

      if (!payload.assetId) return; // streamed segment: no audio to batch-transcribe
      const asset = await getAsset(payload.assetId);
      if (!asset) return;

      if (config.managed) {
        await this.ensureOffscreen();
        const connection = requireConnection(await loadProoflineSettings());
        const request: NonNullable<VoiceSegmentPayload['transcriptionRequest']> = payload.transcriptionRequest ?? {
          id: await transcriptionRequestId(sessionId, event.id, payload.transcriptionGeneration),
          organizationId: connection.organizationId,
          provider: config.provider === 'elevenlabs' ? 'elevenlabs' : 'deepgram',
          language: config.language,
          keyterms: sessionId === this.current?.id ? [...this.pageKeyterms] : [],
        };
        payload = { ...payload, transcriptionRequest: request };
        await appendEvents([{ ...event, payload } as SessionEvent]);
        Object.assign(config, {
          requestId: request.id,
          organizationId: request.organizationId,
          provider: request.provider,
          language: request.language,
          keyterms: request.keyterms,
        });
      }
      const result = await transcribe(asset.blob, {
        ...config,
        keyterms: config.managed
          ? config.keyterms
          : sessionId === this.current?.id ? this.pageKeyterms : [],
      });
      this.routeDictation(sessionId, result.text, true, payload.tStart);
      const updated = {
        ...event,
        payload: {
          ...payload,
          transcript: result.text,
          words: result.words,
          provider: config.managed ? `proofline/${config.provider}` : config.provider,
          transcriptionError: undefined,
          transcriptionTerminalFailure: undefined,
        },
      } as SessionEvent;
      await appendEvents([updated]);
      this.updateRecent(updated);
    } catch (e) {
      const updated = {
        ...event,
        payload: transcriptionFailure(payload, e),
      } as SessionEvent;
      await appendEvents([updated]).catch(() => {});
      this.updateRecent(updated);
    }
  }

  private async transcribePending(sessionId: string): Promise<void> {
    try {
      const events = await getEvents(sessionId);
      for (const e of events) {
        if (e.type !== 'voice-segment') continue;
        const p = e.payload as VoiceSegmentPayload;
        if (!p.transcriptionError && (p.transcript === null || p.transcript === undefined)) {
          this.enqueueTranscription(e, sessionId);
        }
      }
    } catch {
      /* best-effort */
    }
  }

  private async loadTranscriptionConfig(): Promise<TranscriptionConfig | null> {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.transcription);
      const cfg = got[STORAGE_KEYS.transcription] as
        | Partial<TranscriptionConfig>
        | undefined;
      const proofline = await loadProoflineSettings();
      if (proofline.aiMode === 'proofline') {
        return { provider: 'deepgram', apiKey: '', managed: true };
      }
      if (!cfg || !cfg.provider || !cfg.apiKey) return null;
      return cfg as TranscriptionConfig;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Asset storage helpers
  // --------------------------------------------------------------------------

  private readonly storeScreenshot = async (
    jpegBase64: string,
  ): Promise<{ assetId: string; size: number }> => {
    const bytes = base64ToBytes(jpegBase64);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const asset = await this.putAssetBlob('screenshot', blob, 'image/jpeg');
    return { assetId: asset.id, size: asset.size };
  };

  private readonly storeBodyAsset = async (
    text: string,
    mime: string,
    base64: boolean,
  ): Promise<string> => {
    const type = mime || 'application/octet-stream';
    const blob = base64
      ? new Blob([base64ToBytes(text)], { type })
      : new Blob([text], { type });
    const asset = await this.putAssetBlob('net-body', blob, type);
    return asset.id;
  };

  private async putAssetBlob(
    kind: AssetKind,
    blob: Blob,
    mime?: string,
  ): Promise<Asset> {
    const asset: Asset = {
      id: newId('ast'),
      sessionId: this.current?.id ?? '',
      kind,
      mime: mime || blob.type || 'application/octet-stream',
      size: blob.size,
      blob,
    };
    await putAsset(asset);
    if (this.current) this.current.assetBytes += asset.size;
    return asset;
  }

  /**
   * Inject the content scripts into a tab that is being recorded.
   *
   * Manifest-declared content scripts only run when a page loads, so a tab that
   * was already open when recording starts has none. Without this, interaction
   * capture, file capture, and annotation silently do nothing on that tab (the
   * debugger-based network and console capture still works, which is why the bug
   * looks like "annotate does nothing" rather than "recording is dead"). We
   * inject into all frames; each script guards against double-injection, so a
   * later manifest load on navigation does not double-bind. Restricted pages
   * (chrome://, the web store) reject injection, which we ignore.
   */
  private async ensureContentScripts(tabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: [
          'content-scripts/interactions.js',
          'content-scripts/annotations.js',
          'content-scripts/point-annotations.js',
          'content-scripts/file-capture.js',
        ],
      });
    } catch {
      /* restricted page or no host access — capture degrades, not fatal */
    }
  }

  // --------------------------------------------------------------------------
  // Rehydration after a service-worker restart
  // --------------------------------------------------------------------------

  private async rehydrate(): Promise<void> {
    if (this.current || this.rehydrating) return;
    // Synchronous flag: init() and onStartup/onInstalled can all fire rehydrate
    // on cold start; without this guard they race past the `await listSessions()`
    // and double-attach / emit duplicate rehydrate notes.
    this.rehydrating = true;
    try {
      const sessions = await listSessions();
      const live = sessions.find(
        (s) => s.status === 'recording' || s.status === 'paused',
      );
      if (!live) return;

      this.current = live;
      this.sessionStartEpoch = live.startedAt;
      this.paused = live.status === 'paused';
      this.micOn = false;
      // The offscreen doc survives SW restarts and may still be recording; its
      // next video/segment still lands correctly, but the UI shows video off
      // (mirrors micOn — the user re-toggles to resume control).
      this.videoOn = false;
      this.annotating = false;
    this.pointing = false;
      this.recent = [];
      this.lastError = undefined;
      this.lastAnnotationShot = undefined;
      this.writer = new EventWriter();
      this.network.reset();
      this.console.reset();
      this.screenshots.reset();

      const primary =
        live.tabs.find((t) => t.role === 'primary') ?? live.tabs[0];
      this.lastActiveSessionTab = primary?.tabId;

      // Best-effort re-attach to any surviving tab.
      for (const t of live.tabs) {
        try {
          await chrome.tabs.get(t.tabId);
          await this.dbg.attach(t.tabId);
          t.attached = true;
          t.attachedAt = Date.now();
          delete t.detachedAt;
          await this.ensureContentScripts(t.tabId);
          await sendToTab(t.tabId, { kind: 'content/setActive', active: true, hoverDwellMs: live.settings.hoverDwellMs });
        } catch {
          t.attached = false;
        }
      }

      this.multitab.start();
      this.registerNavListeners();
      this.startHeartbeat();

      this.recordEvent({
        type: 'session-note',
        payload: {
          kind: 'rehydrate',
          text: 'Recorder restarted; a brief capture gap may have occurred.',
        },
      });
      await this.persistSession();
      this.broadcastState();
    } catch {
      /* nothing to recover */
    } finally {
      this.rehydrating = false;
    }
  }

  // --------------------------------------------------------------------------
  // Small utilities
  // --------------------------------------------------------------------------

  private isSessionTab(tabId: number): boolean {
    if (!this.current) return false;
    return this.current.tabs.some((t) => t.tabId === tabId);
  }

  private activeSettings(): CaptureSettings {
    return this.current?.settings ?? makeDefaultSettings();
  }

  /** Resolve the session tab a manual action should target. */
  private async activeSessionTabId(): Promise<number> {
    const session = this.current;
    if (!session) return -1;

    try {
      const [active] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (active?.id !== undefined && this.isSessionTab(active.id)) {
        return active.id;
      }
    } catch {
      /* fall through */
    }

    if (
      this.lastActiveSessionTab !== undefined &&
      this.isSessionTab(this.lastActiveSessionTab)
    ) {
      return this.lastActiveSessionTab;
    }

    const primary =
      session.tabs.find((t) => t.role === 'primary') ?? session.tabs[0];
    return primary ? primary.tabId : -1;
  }

  private async loadDefaultSettings(): Promise<Partial<CaptureSettings>> {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.defaultSettings);
      const stored = got[STORAGE_KEYS.defaultSettings] as
        | Partial<CaptureSettings>
        | undefined;
      return stored ?? {};
    } catch {
      return {};
    }
  }

  private startHeartbeat(): void {
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.4 });
  }

  private stopHeartbeat(): void {
    void chrome.alarms.clear(HEARTBEAT_ALARM);
  }

  private async persistSession(): Promise<void> {
    if (!this.current) return;
    try {
      await updateSession(this.current);
    } catch {
      /* transient — the next heartbeat retries */
    }
  }

  private buildState(): AppState {
    // Fall back to the just-stopped session so the panel can show its review.
    const session = this.current ?? this.lastStopped;
    return {
      session,
      recentEvents: [...this.recent],
      recording:
        !!session &&
        (session.status === 'recording' || session.status === 'paused'),
      paused: this.paused,
      micOn: this.micOn,
      videoOn: this.videoOn,
      annotating: this.annotating,
      pointing: this.pointing,
      attachedTabIds: this.dbg.attachedTabs(),
      error: this.lastError,
    };
  }

  private broadcastState(): void {
    broadcast({ kind: 'state/update', state: this.buildState() });
    for (const tab of this.current?.tabs ?? []) void sendToTab(tab.tabId, { kind: 'content/mic', on: this.micOn && !this.paused });
  }
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

export default defineBackground(() => {
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const orchestrator = new Orchestrator();
  orchestrator.init();
  // Test hook for the E2E suite (service-worker global only; not web-exposed).
  (globalThis as Record<string, unknown>).__srTest = (
    msg: RequestMessage,
    senderTabId?: number,
  ) => orchestrator.dispatchForTest(msg, senderTabId);
});
