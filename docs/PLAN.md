# Plan: session recorder Chrome extension — historical

> This is the original local-export design, retained as historical context. It predates one-click GitHub filing, live annotations, dictation and the optional Proofline services. Its “no backend” decision and phase-specific scope are superseded. Current product behavior is in [README](../README.md); development and ownership are in [DEVELOPMENT](../DEVELOPMENT.md).

This Chrome extension records a full session of someone using a web app, then exports it as a local zip. It captures interactions, network traffic, screenshots, voice narration, annotations, and files. The report is built for an LLM coding agent to read, so you can use it to reproduce bugs and analyse behaviour.

## 1. Decisions from the requirements interview

| Topic | Decision |
|---|---|
| Primary consumer | An LLM coding agent (Claude Code, Cursor, and similar). The output is structured for token-efficient machine reading |
| Output destination | Local zip download, with no backend |
| Voice narration | Recorded audio plus cloud transcription, with pluggable providers (an OpenAI-compatible endpoint, Deepgram, ElevenLabs Scribe) |
| Network capture | Full fidelity via `chrome.debugger` (request and response bodies, headers, timing, websockets). We accept the "tab is being debugged" banner |
| Screenshots | You choose the policy: every interaction, key moments, or on-demand only |
| Session scope | Multi-tab. Recording follows you across tabs, including popups, OAuth flows, and new tabs the app opens |
| Privacy | Redact by default (auth headers, cookies, token-like fields, password inputs), with a per-session toggle and custom rules |
| Report format | `report.md` (a chronological, LLM-first narrative), a `session.json` sidecar, and asset files |
| Trimming | Applied at export time. We capture at full fidelity, and you choose a verbosity level (with a token estimate) when exporting. You can re-export at any level |
| Tech stack | WXT, React, TypeScript, and Manifest V3 |

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Side Panel (React)                                              │
│  record / stop / pause · mic toggle · annotate toggle           │
│  attach file · add marker/note · live event ticker              │
│  export panel (verbosity level + token estimate → zip)          │
└──────────────┬──────────────────────────────────────────────────┘
               │ chrome.runtime messaging
┌──────────────▼──────────────────────────────────────────────────┐
│ Background service worker — Session Orchestrator                │
│  · session lifecycle & state machine                            │
│  · chrome.debugger attach/detach per recorded tab               │
│  · multi-tab tracker (tabs.onCreated w/ openerTabId)            │
│  · event bus → IndexedDB writer (batched)                       │
│  · screenshot scheduler (per capture knob)                      │
└───────┬───────────────────────┬─────────────────────────────────┘
        │                       │
┌───────▼─────────────┐  ┌──────▼───────────────────────────────┐
│ Content scripts     │  │ Offscreen document                   │
│ (all frames)        │  │  · MediaRecorder (mic audio)         │
│ · interaction       │  │  · zip assembly (fflate)             │
│   capture           │  └──────────────────────────────────────┘
│ · SPA route hook    │
│ · file-upload       │  ┌──────────────────────────────────────┐
│   interception      │  │ IndexedDB (idb)                      │
│ · annotation        │  │  sessions · events · blobs (assets)  │
│   overlay (canvas)  │  └──────────────────────────────────────┘
└─────────────────────┘
```

### Module layout (WXT conventions)

```
entrypoints/
  background.ts          # session orchestrator
  sidepanel/             # React app: recording UI + export UI
  options/               # React app: settings (STT providers, redaction, knobs)
  offscreen/             # audio recording + zip assembly
  content/
    interactions.ts      # clicks, scrolls, inputs, keys, SPA routes
    annotations.ts       # canvas overlay + floating toolbar
    file-capture.ts      # <input type=file> + drag-drop interception
    mic-permission/      # one-time page to grant getUserMedia to extension origin
lib/
  session/               # data model, event types, state machine
  capture/
    debugger.ts          # CDP domains: Network, Page, Runtime, Log
    screenshots.ts       # Page.captureScreenshot scheduling + dedupe
    redaction.ts         # header/body/input masking rules
  transcription/
    provider.ts          # interface
    openai-compatible.ts # configurable baseURL/model/key (default: OpenAI Whisper)
    deepgram.ts
    elevenlabs.ts
  export/
    trimmer.ts           # verbosity levels, importance scoring
    markdown.ts          # report.md renderer
    tokens.ts            # token estimator (~chars/4)
    zip.ts
  storage/               # IndexedDB access layer
```

## 3. Capture subsystems

### 3.1 Network and console (chrome.debugger / CDP)

- when a session starts, the background attaches the debugger to the active tab and enables the `Network`, `Page`, `Runtime`, and `Log` domains
- per request, we capture the method, URL, request headers and body, response status, headers, body (`Network.getResponseBody`, fetched on `loadingFinished`), timing, initiator, and resource type. We capture websocket frames via `Network.webSocketFrame*`
- we capture console logs, uncaught exceptions, and failed requests via `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, and `Log.entryAdded`. Errors matter most to an LLM debugging agent
- we cap body size at capture (configurable, default 256 KB per body). We store larger bodies truncated and note the original size
- multi-tab: when a recorded tab opens another (`tabs.onCreated` with an `openerTabId` in the session's tab set) or navigates via `window.open`, we auto-attach the debugger and inject content scripts there too. We tag every event with a `tabId`, and the report renders tab switches as explicit timeline entries. We detach on tab close, and the session continues on the remaining tabs
- known constraint: the debugger cannot attach while DevTools is open on that tab. We detect this and show a clear error in the side panel

### 3.2 Interactions (content script, all frames)

- clicks: we record an element descriptor (best-effort selector, tag, role or aria-label, visible text up to 80 characters, bounding box) and the modifier keys
- inputs: we debounce per field and record the value, except for password fields (always `«redacted»`) and fields matching redaction rules. We record the field label or name so the LLM knows what you typed even when the value is masked
- scrolls: we debounce and coalesce these (start-to-end position and container)
- keys: we record significant keys only (Enter, Escape, Tab, shortcuts), not full keylogging
- navigation: we capture full page loads via CDP `Page.frameNavigated`, and SPA routes by patching `history.pushState/replaceState` and `popstate`. We record the URL and document title

### 3.3 Screenshots

- we capture screenshots via CDP `Page.captureScreenshot`, which works per attached tab even when the tab is unfocused. This is needed for multi-tab, and it avoids `captureVisibleTab` rate limits
- the capture-knob policy is a per-session setting you can change in options:
  1. every interaction: after each click, navigation, or significant scroll, debounced by at least 500 ms
  2. key moments: navigations, errors (a console error or a 4xx/5xx response), annotation-mode exit, and the on-demand button
  3. on-demand: the button and annotation exits only
- near-duplicate suppression: we run a cheap perceptual hash. We store identical consecutive frames once with a repeat count
- we store screenshots as JPEG at about quality 80 to keep zips small

### 3.4 Annotation mode

- you toggle annotation mode from the side panel or a keyboard shortcut. It injects a full-viewport canvas overlay and a floating toolbar into the page
- the tools are pen (freehand), arrow, rectangle, ellipse or circle, text label, highlighter, and blur or redact box, plus a colour picker, stroke width, undo and redo, and clear
- page interaction is frozen while you annotate, because the overlay swallows events
- on exit, we capture a screenshot with the drawings, and we save the annotation vector data as JSON (shape types, coordinates, text). This gives the LLM a text description ("user circled the Submit button region") alongside the image

### 3.5 Voice narration

- the side panel has a mic toggle. MV3 service workers cannot use `getUserMedia`, so audio records in an offscreen document. The first use routes through a one-time mic-permission page for the extension origin
- `MediaRecorder` produces webm/opus chunks, segmented every 30 seconds and at pause boundaries so timestamps map to the event timeline
- on stop, or progressively during recording, we send segments to the configured STT provider. The provider abstraction is `transcribe(blob, opts) → {text, words?[]}`, with three implementations (OpenAI-compatible, Deepgram, ElevenLabs). Keys are stored in `chrome.storage.local`, entered on the options page, and the provider and model are selectable
- output: timestamped transcript segments interleaved into the timeline, plus the raw audio files in the zip. If no key is configured, we keep audio only and show a warning

### 3.6 Files

- auto-capture: the content script listens for `change` on `input[type=file]` and for drag-drop events, then copies file contents into the session with context ("uploaded to Import CSV dialog"). The cap is 25 MB per file and is configurable. We record oversized files as metadata only
- manual attach: a side panel button lets you add any file or image to the session, with an optional note

### 3.7 Markers and notes

- an "Add marker" button (with a shortcut) drops a named bookmark, and you can type text notes in the side panel mid-session. These are cheap, high-signal anchors for the report ("bug happens here")

## 4. Data model

```ts
Session { id, startedAt, endedAt, initialUrl, tabs: TabInfo[],
          settingsSnapshot, status }

Event  { id, sessionId, t /* ms from start */, tabId, type, payload }
// types: click | input | scroll | key | nav | spa-route |
//        net-request | console | error | screenshot | annotation |
//        voice-segment | file-captured | file-attached | marker | note | tab-switch

Asset  { id, sessionId, kind: screenshot|audio|file|net-body,
         mime, bytes(Blob), sha256, size }
```

Events reference assets by id. Everything persists to IndexedDB during recording, with batched writes about every one second, so a crash loses at most the last second. Full-fidelity sessions stay in IndexedDB until you delete them, and that is what makes re-export at different verbosity levels possible.

## 5. Export engine: deterministic trimming, no LLM

### Verbosity levels

| Level | Target | Strategy |
|---|---|---|
| L0 full | everything captured | complete bodies (up to the capture cap), all screenshots, all events |
| L1 standard | about 150k tokens | response bodies cut to the first 4 KB; static-asset requests (images, fonts, css, analytics, by mime and URL heuristics) collapsed to one summary line; scroll events coalesced; duplicate screenshots deduped |
| L2 compact | about 50k tokens | bodies reduced to a JSON shape summary (keys, types, and array lengths, for example `{users: Array(50) of {id, name, email}}`); repeated calls to the same endpoint reduced to the first occurrence plus `(×12 similar, 2 with differing status)`; screenshots only at key moments; console logs deduped with counts |
| L3 minimal | about 15k tokens | a narrative skeleton: navigations, clicks (element text only), transcript, markers and notes, annotations, and errors with request and response one-liners; the screenshot list as filenames only |

### Never trimmed, at any level

We never trim the voice transcript, annotations and their screenshots, markers and notes, errors (console errors, exceptions, and 4xx/5xx responses with their request context), or file-capture metadata. These are your explicit signals of what mattered.

### Importance scoring

Each event gets a static score at capture. The order, from highest to lowest, is user-explicit signals (marker, annotation, narration overlap), then errors, then state-changing requests (POST/PUT/DELETE), then navigations, then clicks, then GET/XHR, then static assets, then scrolls. Trimming drops from the bottom of the score order until the level's budget is met, then applies per-type compaction (body truncation, then shape summary, then status line). A `chars/4` token estimator drives a live per-level size preview in the export UI. The export panel shows all four levels with estimated tokens, and you pick one.

### Zip layout

```
session-2026-07-05-1432/
  report.md          # chronological narrative: events, transcript lines,
                     # ![screenshots], network summaries, annotations — with
                     # a header (app URL, duration, tab list, level used)
  session.json       # complete structured event data at the chosen level
  screenshots/…jpg
  audio/…webm  + transcript.json
  files/…            # captured/attached files
  network/…          # bodies that exceeded inline size, as separate files
  MANIFEST.md        # asset index with one-line descriptions
```

`report.md` is the LLM entry point, and it is self-sufficient at L2 and L3 without opening assets.

## 6. Redaction (on by default)

- request and response headers such as `authorization`, `cookie`, `set-cookie`, and `x-api-key` become `«redacted»`
- we redact body fields matching `/token|secret|password|api[-_]?key|session/i` in JSON (recursively) and in form data
- we never capture password input values, and we mask input fields matching sensitive-name rules
- we mask URL query params matching the same patterns, plus URL-only names such as `sig` and `key` (see `docs/PRIVACY.md`), and the password in `user:password@` URLs
- the options page lets you add custom rules (header names, JSON field regexes, URL patterns) on top of the defaults. A per-session "capture raw" toggle is available with a warning
- we apply redaction at capture time, so raw secrets never touch disk

## 7. UI flows

Side panel, idle: a large Record button, a target-tab indicator, a capture-knob quick setting, and a past-sessions list (open to the export panel, or delete).

Side panel, recording: an elapsed timer, pause and stop, a mic toggle with a level meter and a live "transcribing…" state, an Annotate button, an Attach file button, an Add marker button and a note field, a live ticker of recent events (which reassures you that capture is working), and per-tab chips showing which tabs are attached.

Side panel, after stop: a session summary (duration, counts per event type, total size), transcription progress and retry, and an export panel with a verbosity-level radio, token estimates, and a Download zip button (`chrome.downloads`).

In-page: a floating, draggable annotation toolbar and a subtle "● REC" badge.

Options page: STT provider config (provider, base URL, model, key, and a test button), redaction rules, capture knobs (screenshot policy, body cap, file cap), and storage usage with cleanup.

## 8. Permissions (manifest)

We request `debugger`, `sidePanel`, `tabs`, `scripting`, `storage`, `unlimitedStorage`, `offscreen`, and `downloads`, plus the host permission `<all_urls>`. We get the mic via a `getUserMedia` prompt on the extension's permission page.

## 9. Milestones

1. M1, skeleton and session core: the WXT scaffold, a side panel with record and stop, the session state machine, the IndexedDB layer, the interaction content script, and on-demand screenshots. Demo: record clicks on a page and see events in the ticker.
2. M2, deep capture: debugger attach, network and console and error capture, redaction defaults, multi-tab tracking, and the screenshot-knob policies.
3. M3, export v1: the data model freeze, the markdown renderer, and a zip download at L0. From here, every later feature is visible in real output.
4. M4, trimming engine: importance scoring, L1-L3 compaction (body shape summaries, request collapsing, screenshot thinning), and token estimates in the export UI.
5. M5, annotation mode: the overlay, the toolbar, the tools, and the vector JSON plus annotated screenshot on exit.
6. M6, voice: the offscreen recorder, the mic permission flow, the provider abstraction with three providers, and transcript interleaving.
7. M7, files and markers: upload interception, manual attach, and markers and notes.
8. M8, hardening: SPA edge cases, OAuth-popup flows, big-session performance (sessions over one hour), storage pressure handling, session-browser polish, and the README plus store-listing assets.

## 10. Risks and mitigations

- MV3 service worker suspension mid-session: active `chrome.debugger` sessions and event traffic keep it alive. On an unexpected restart, we rehydrate session state from IndexedDB and re-attach
- debugger conflicts: the debugger cannot attach when DevTools is open on the tab, and another extension may hold the debugger. We detect the `attach` failure and explain it in the UI
- storage blowups (bodies and screenshots on long sessions): we use capture-time caps, JPEG screenshots, `navigator.storage.estimate()` warnings, and a per-session size display
- cross-origin iframes: we use content scripts with `all_frames: true` and `match_origin_as_fallback`. Some frames (Chrome pages, other extensions) cannot be captured, so we note the gaps in the report rather than fail silently
- mic permission UX in the extension context: we use a dedicated one-time permission page and a graceful audio-off fallback
- transcription failures (a bad key, rate limits): we always preserve the audio, offer a retry button, and note untranscribed segments in the report

## 11. Out of scope for v1

We are not building video recording, backend upload or shareable links, LLM-powered summarization, live streaming to an agent, or Firefox and Safari ports. We are also not building DOM snapshot and replay (rrweb-style), though it is worth revisiting in v2 as an optional high-fidelity mode.
