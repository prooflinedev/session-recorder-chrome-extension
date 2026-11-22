# Implementation plan — historical

> This is the original phased implementation plan, retained as historical context. Its spikes, estimates, dependency proposals and exit criteria are not current tasks. The implemented system has moved beyond these phases. Current product behavior is in [README](../README.md); development and ownership are in [DEVELOPMENT](../DEVELOPMENT.md).

This plan is the build companion to `PLAN.md`. It has 8 phases, and each phase ends in something you can demonstrate. There is no code here, only pseudocode where the logic is not obvious.

---

## Phase 0: de-risking spikes (half a day)

Run 3 throwaway experiments before you commit to the architecture. Each one is a minimal extension that proves a single risky assumption.

- spike A, debugger capture: attach `chrome.debugger` to a tab, enable the Network domain, and log one request's response body with `Network.getResponseBody`. This confirms the attach flow, the banner behavior, and body retrieval timing. You can only fetch a body after `loadingFinished`, and Chrome can evict it, so verify eviction behavior on a heavy page.
- spike B, mic in MV3: use an offscreen document plus `getUserMedia`. This confirms the permission-grant flow. We expect you must first grant permission through a visible extension page, and then the offscreen document works.
- spike C, background-tab screenshot: run CDP `Page.captureScreenshot` on a tab that is not focused. This confirms multi-tab screenshots work without stealing focus.

Exit criteria: all 3 spikes confirmed, with findings noted at the top of this file. Any failure changes the plan now, while it is still cheap.

---

## Phase 1: scaffold and session core

Goal: the record button captures interaction events, persists them, and shows them live. No debugger yet.

### 1.1 Project scaffold
- a WXT project using the React and TypeScript templates, with strict TypeScript and pnpm
- entrypoints: `background`, `sidepanel`, `options` (an empty shell), and `content/interactions`
- manifest permissions: `sidePanel`, `tabs`, `scripting`, `storage`, `unlimitedStorage`, and host `<all_urls>`. Add each remaining permission in the phase that needs it, which keeps the permission list easy to review during development.
- dependencies: `idb`, `fflate`, `zustand` (side panel state), and `nanoid`
- toolchain: vitest for `lib/`, plus ESLint and prettier

### 1.2 Domain types and message protocol
- `lib/session/types`: define `Session`, `Event` (a discriminated union on `type`), and `Asset`, exactly as specified in PLAN.md §4.
- `lib/messaging`: one typed request/response envelope for all runtime messaging (`{kind, payload}`), plus a broadcast channel from background to side panel for live event ticks. Every later phase adds message kinds here and nowhere else.

### 1.3 Storage layer (`lib/storage`)
- IndexedDB through `idb`, with stores `sessions`, `events` (index: `sessionId+t`), and `assets` (index: `sessionId`)
- batched writer: events buffer in memory and flush every 1 second or 50 events, whichever comes first. Assets (blobs) write immediately.
- API surface: `createSession`, `appendEvents`, `putAsset`, `getSession`, `iterateEvents(sessionId)`, `listSessions`, and `deleteSession` (which cascades)

### 1.4 Session orchestrator (background)
- state machine: `idle → recording ⇄ paused → stopping → stopped`. One owner function handles each transition. Capture modules subscribe to transitions rather than reading flags.
- on `start`: create the session record, inject content scripts into the active tab, and start accepting events
- central `recordEvent(event)` funnel: it stamps `t = now − sessionStart` and `tabId`, then forwards the event to the storage writer and the side panel ticker broadcast. All capture sources go through this one funnel, because trimming, redaction hooks, and the ticker all rely on it.

### 1.5 Side panel v1
- idle view: a Record button (targets the active tab) and a sessions list (name, date, duration, delete)
- recording view: an elapsed timer, Stop, Pause, and a live ticker (the last 30 or so events as human-readable one-liners)
- the panel syncs its state from the background through the broadcast plus a `getState` request when the panel opens, since you can open the panel mid-session

### 1.6 Interaction capture content script
Listeners (capture phase, `all_frames: true`):
- `click`: build an element descriptor with `buildDescriptor(el)`: tag, id, `aria-label` or role, visible text (up to 80 chars), a best-effort CSS selector (id, then data-testid, then a short ancestor path), and the bounding box
- `input` and `change`: debounce 800 ms per element. Redact password fields and sensitive-named fields to `«redacted»`, but always keep the field's label, name, and placeholder.
- `scroll`: coalesce, recording only after 300 ms of idle, as `{from, to, container}`
- `keydown`: capture only Enter, Escape, Tab, and modifier-chords
- SPA routes: wrap `history.pushState` and `replaceState`, and listen to `popstate`, emitting a `spa-route` event with the URL and title

Then:
- events post to the background through runtime messaging. The content script is stateless, so it is safe to re-inject after navigation.
- re-injection: the background listens to `webNavigation.onCommitted` for recorded tabs and re-injects

### 1.7 On-demand screenshot (temporary implementation)
- a side panel button calls `tabs.captureVisibleTab` to produce a JPEG asset and a `screenshot` event. CDP replaces this in Phase 2, and the event shape stays identical.

Exit criteria: record on a demo SPA. Clicks, typing, routes, and scrolls appear in the ticker and survive a full page reload of the target tab. Sessions are listed after you stop. You can inspect storage in DevTools.

---

## Phase 2: deep capture

Goal: capture network bodies, console, errors, multiple tabs, redaction, and screenshot policies. This is the riskiest phase, so it follows the spikes directly.

### 2.1 Debugger manager (`lib/capture/debugger`)
- it owns attach and detach per tab, and enables the `Network`, `Page`, `Runtime`, and `Log` domains on attach
- on attach failure (DevTools open, or another debugger attached), surface a typed error in the side panel with a plain-language explanation, and abort session start cleanly
- handle `chrome.debugger.onDetach` (the user clicked the banner's Cancel, or the tab closed): mark the tab detached, emit a session note event, keep the session alive on other tabs, and offer re-attach in the panel
- add the `debugger` permission to the manifest here

### 2.2 Network capture
- per-request assembly: CDP delivers a request across 3–4 events keyed by `requestId`:

```
pending: Map<requestId, PartialRequest>

on Network.requestWillBeSent(e):
    pending[e.requestId] = {method, url, reqHeaders, reqBody(postData),
                            initiator, resourceType, tsStart}
on Network.responseReceived(e):
    merge status, respHeaders, mime, timing into pending
on Network.loadingFinished(e):
    body = Network.getResponseBody(requestId)     # must happen NOW,
    if body.size > CAP: keep first CAP bytes,     # bodies get evicted
                        store full body as asset if < asset cap
    event = redact(assemble(pending[e.requestId], body))
    recordEvent(event); delete pending[...]
on Network.loadingFailed(e):
    record as net-request with failure reason (high importance)
```

- websockets: `webSocketCreated`, `FrameSent`, and `FrameReceived` produce one `net-request` event per socket with an appended frame log (frames capped)
- config knobs (on the options page later): the inline body cap (default 256 KB) and the overflow-to-asset cap (default 2 MB)

### 2.3 Redaction (`lib/capture/redaction`): pure functions, unit-tested
- `redactHeaders(headers)`: apply a case-insensitive blocklist, replacing matches with `«redacted»`
- `redactBody(text, mime)`: for JSON, walk it recursively:

```
walk(node):
    for key, value in node:
        if key matches /token|secret|password|api[-_]?key|session|auth/i:
            node[key] = "«redacted»"
        else recurse into objects/arrays
```

  for non-JSON, run a regex pass over `key=value` pairs with sensitive keys (form-urlencoded).
- `redactUrl(url)`: apply the same patterns over the query params, plus URL-only exact names (`sig`, `signature`, `x-amz-signature`, `x-goog-signature`, `key`) that bodies don't use, and mask the password in `user:password@`. See `docs/PRIVACY.md` for the full list.
- the network assembler applies redaction before `recordEvent`, so raw secrets never reach IndexedDB. Custom rules merge with the defaults (the Phase 8 options UI).

### 2.4 Console and exceptions
- `Runtime.consoleAPICalled` → a `console` event (level and formatted args; stringify with a depth cap of 3 and a length cap of 2 KB)
- `Runtime.exceptionThrown` → an `error` event with the message and stack
- `Log.entryAdded` → network and security warnings the console API misses
- dedup at capture: collapse identical consecutive console messages within 1 second into one event with a counter. This guards against log-spam loops flooding storage.

### 2.5 Multi-tab tracking

```
sessionTabs: Set<tabId>          # persisted in session record

on tabs.onCreated(tab):
    if tab.openerTabId in sessionTabs:
        adopt(tab)               # attach debugger, inject content scripts,
                                 # add to set, recordEvent(tab-opened)
on Page.windowOpen / target created via CDP:    # popups w/o openerTabId
    resolve to tabId, adopt(tab)
on tabs.onActivated:
    if both old & new tab in sessionTabs: recordEvent(tab-switch)
on tabs.onRemoved:
    remove from set, recordEvent(tab-closed); if set empty → auto-stop session
```

- every event already carries `tabId` (from the Phase 1 funnel), and report rendering resolves tab titles from the session's tab registry

### 2.6 Screenshot scheduler (`lib/capture/screenshots`)
- replace the Phase 1 implementation with CDP `Page.captureScreenshot` (JPEG q80), which works on unfocused tabs
- read a policy knob (`every-interaction`, `key-moments`, or `on-demand`) from the session settings:
  - every-interaction: subscribe to click, nav, spa-route, and scroll-end events from the funnel, and debounce 500 ms per tab
  - key-moments: subscribe to nav, spa-route, `error`, net-request with status ≥ 400, and annotation-exit
  - both policies also include the manual button
- dedup with an average-hash (8×8 grayscale) of each capture. If the hamming distance to the previous shot on that tab is ≤ the threshold, do not store it; increment a repeat counter on the prior screenshot event instead.

### 2.7 Service worker resilience
- rehydration: when the SW starts, check storage for a session in the `recording` state. If you find one, restore the in-memory state, re-attach the debugger to surviving tabs, re-inject content scripts, and emit a `note` event ("recorder restarted, gap of N seconds possible").
- keep-alive: rely on active debugger sessions plus a low-frequency `chrome.alarms` heartbeat that also flushes the event buffer

Exit criteria: record a session against a real SaaS app. API request and response bodies appear in the stored events with auth headers redacted. Console errors are captured. An OAuth-style popup gets adopted and captured. Killing the SW from `chrome://serviceworker-internals` mid-session recovers without data loss beyond the buffer window.

---

## Phase 3: export v1 (full fidelity)

Goal: produce a zip with `report.md`, `session.json`, and assets at L0. Doing this before trimming, annotations, and voice means every later feature is validated against real output.

### 3.1 Schema freeze
- review every event payload shape that Phases 1 and 2 produce, then write `docs/event-schema.md` (one section per event type, with field meanings). This document is the contract for the renderer and trimmer. Later phases may add event types but not change existing shapes.

### 3.2 Markdown renderer (`lib/export/markdown`): pure function: `(session, events, assets, level) → string`
- header block: app URLs, date, duration, tab registry, capture settings, the level used, and an event-count table
- body: a single chronological walk. Format each type by rule:
  - interactions → one-liners: `[00:42] CLICK "Submit order" (button#checkout, tab 1)`
  - nav, spa-route, and tab events → `##`-level section breaks, since they segment the story
  - net-request → a collapsed block: status, method, and path on one line, then the request and response bodies in fenced blocks (at L0, full up to the capture cap)
  - console and error → fenced and prefixed with the level. Errors get a `⚠` and blank-line isolation so they stand out to the LLM.
  - screenshot → `![desc](screenshots/NNN.jpg)` plus one line of context (what triggered it)
  - marker and note → a blockquote, rendered loud
- timestamps as `[mm:ss]` from session start, consistent everywhere. This is the join key across the transcript, screenshots, and events for the LLM.
- appendices: a network index (every request on one line), a console dump, and the `MANIFEST.md` content
- unit tests: golden-file tests with synthetic sessions (a fixture builder helper)

### 3.3 Zip assembly and download
- `session.json`: the event stream plus session meta, serialized after asset refs are rewritten to zip-relative paths
- assemble with `fflate` in the offscreen document, because zipping big blobs in the SW risks its lifetime. Add the `offscreen` permission here.
- naming: `screenshots/{seq}-{mmss}.jpg`, `network/{seq}-{host}-{path-slug}.json`, `files/{original-name}`, and `audio/{seq}.webm`
- call `chrome.downloads.download` with a generated blob URL, and add the `downloads` permission

### 3.4 Export UI (side panel, post-stop view)
- show a session summary (counts, sizes), then a level selector (only L0 enabled for now), then a Download button with progress

Exit criteria: a recorded session downloads as a zip. Pasting `report.md` into Claude and asking "what did the user do and what went wrong?" yields a correct answer. This is the real acceptance test, so run it every phase after this.

---

## Phase 4: trimming engine

Goal: L1–L3 levels with live token estimates. These are all pure functions in `lib/export/trimmer`, the most unit-testable code in the project.

### 4.1 Importance scoring
- a table assigns each event a static score (see PLAN.md §5): marker, annotation, and narration-adjacent events rank highest, then error, then mutating requests (POST/PUT/DELETE/PATCH), then nav, then click, then GET xhr/fetch, then static asset, then scroll
- narration-adjacent means any event within ±5 seconds of a voice segment gets a score boost, because the user was talking about it. Build it now; it activates when voice lands in Phase 6.

### 4.2 Compaction transforms: each a pure `(events) → events` pass
- `truncateBodies(maxBytes)`: keep the head and note the original size
- `bodyToShapeSummary`: turn JSON into a structural sketch:

```
shape(node, depth):
    object → { key: shape(value) for first ~10 keys }, note "+N more keys"
    array  → "Array(len) of " + shape(first element)
    leaf   → type name, plus the literal value if it's short & non-sensitive
```

- `collapseRepeatedRequests`: group by `method + normalized path` (path segments that look like ids or uuids become `:id`). Keep the first occurrence full, and replace the rest with one summary line: count, statuses seen, and a note of any that differ in status (those stay full, because anomalies are signal).
- `dropStaticAssets`: use mime and URL heuristics (images, fonts, css, and an analytics/telemetry domains list) to produce a single summary line per page-load
- `thinScreenshots(keepPolicy)`: keep nav, error, annotation, and manual shots; drop interaction-debounce shots. Already-deduped repeats stay as counters.
- `coalesceScrolls` and `dedupConsole`: tighter versions of the capture-time passes
- never-trim guard: transforms skip events flagged protected (transcript, annotations and their screenshots, markers, notes, errors and their linked requests, and file metadata)

### 4.3 Level executor

```
plan(level) = ordered list of transforms with parameters, e.g.
  L1: [dropStaticAssets, coalesceScrolls, truncateBodies(4KB),
       thinScreenshots(keep-key-moments), dedupConsole]
  L2: L1 then [bodyToShapeSummary, collapseRepeatedRequests,
       thinScreenshots(keep-annotation+error only)]
  L3: L2 then [dropBodiesEntirely-except-error-linked,
       interactionsToTextOnly, screenshotsToManifestOnly]

export(level):
    events' = apply plan(level) to full-fidelity events from IndexedDB
    estimate = tokens(render(events'))     # chars/4
    → renderer → zip
```

- levels are cumulative transform pipelines, not budget solvers, which makes them deterministic and explainable. The token targets (150k/50k/15k) are calibration goals for choosing transform parameters, verified against fixture sessions, not runtime constraints.

### 4.4 Export UI v2
- all 4 levels are selectable, each showing its estimated tokens (computed lazily on panel open, cached per session). A footnote lists what each level omits, because you should be able to see what trimming removed.

Exit criteria: a deliberately long fixture session (500 or more requests, log spam, repeated polling calls) renders at all 4 levels. L2 and L3 land within ±30% of the targets. Golden-file tests cover each transform. The Claude paste-test still answers correctly at L2.

---

## Phase 5: annotation mode

### 5.1 Overlay lifecycle (`content/annotations`)
- toggle it with a side panel button or a `chrome.commands` shortcut. It injects a full-viewport container in a shadow DOM (for style isolation), with `position: fixed` and a max z-index, and it swallows all pointer and key events, so the page is frozen while you annotate.
- it records an `annotation-start` event, and it locks page scroll so drawings stay registered to what is on screen

### 5.2 Drawing engine
- use a vector model, not raster: `shapes: [{tool, points/geometry, color, strokeWidth, text?}]`, rendered to a canvas on each change
- tools: pen (a point array), arrow (start and end), rect, ellipse, text label, highlighter (a translucent pen), and redact-box (a solid fill)
- tool state machine: pointerdown starts a draft shape, pointermove updates it, and pointerup commits it to the shape list. Undo and redo are an index into the shape history list.

### 5.3 Toolbar
- a floating, draggable toolbar inside the same shadow root: tool buttons, color swatches, stroke width, undo/redo, clear, ✓ Done, and ✗ Cancel

### 5.4 Exit flow
- Done → take a CDP screenshot (the overlay is in-DOM, so the drawings are captured) → store it as an asset. Store the shape list as the `annotation` event payload, remove the overlay, and unlock scroll.
- semantic enrichment: for each shape, hit-test the page at the shape's center or endpoint (`elementFromPoint`, temporarily ignoring the overlay) and attach the underlying element's descriptor. The renderer can then emit text like "user circled the region around button 'Submit order'", which the LLM can use without vision.

Exit criteria: annotate mid-recording. The zip contains the annotated screenshot. `report.md` describes each shape with its target element. Undo, redo, and cancel behave. It works on a page with aggressive CSS, so style isolation holds.

---

## Phase 6: voice narration

### 6.1 Permission flow
- on the first mic toggle, open the dedicated permission page (from Spike B), request `getUserMedia`, and close it on grant. Persist a "mic granted" flag, so later sessions skip straight to recording.

### 6.2 Recorder (offscreen document)
- use `MediaRecorder` (webm/opus) with `timeslice` chunking. Cut a segment every 30 seconds and on pause or stop. Store each segment as an asset immediately, plus a `voice-segment` event with `{tStart, tEnd, assetId, transcript: null}`.
- the side panel mic button shows a live level meter (an AnalyserNode with throttled level messages)

### 6.3 Transcription providers (`lib/transcription`)
- interface: `transcribe(audioBlob, config) → {text, words?: [{word, t}]}`
- implementations: OpenAI-compatible (configurable baseURL, model, and key; default OpenAI Whisper), Deepgram, and ElevenLabs Scribe. The options page has a provider picker, credential fields, and a "test with 2 second sample" button. Keys live in `chrome.storage.local` only.

### 6.4 Pipeline
- queue in the background: segments transcribe as they close (during recording), one at a time with retry and backoff. Failures leave `transcript: null` and note the error. The post-stop view shows progress ("7/9 segments transcribed") with per-segment retry.
- the renderer interleaves transcript text at segment timestamps as blockquoted narration, visually distinct and never trimmed. Word-level timestamps, when the provider gives them, let the renderer split a segment across events happening mid-segment.

Exit criteria: narrate while you click through a bug repro. The report interleaves speech with the actions being described at the right timestamps. Audio files are present in the zip. With no key configured, it degrades cleanly to audio-only with a report note.

---

## Phase 7: files, markers, and notes

### 7.1 Upload interception (`content/file-capture`)
- listen for `change` on `input[type=file]` (capture phase, which works for hidden inputs triggered by styled buttons) and for `drop` events with `dataTransfer.files`
- for each file at or under the cap (default 25 MB): read it into an asset plus a `file-captured` event, with context taken from the nearest form or dialog heading or `aria-label` (walk up the DOM for the first heading-ish text). Over the cap: emit a metadata-only event.

### 7.2 Manual attachments
- the side panel "Attach" button opens a file picker plus an optional note, producing a `file-attached` event. This works while recording and in post-stop review, so you can attach logs or specs after the fact.

### 7.3 Markers and notes
- the marker button and a `chrome.commands` shortcut produce a prompt-free instant `marker` event (auto-named "Marker 3"), renameable in post-stop review. A note field in the panel produces a `note` event. Both render loud in `report.md` and are never trimmed.

Exit criteria: uploading a CSV into a demo app lands the same CSV in the zip with the correct context text. A shortcut-dropped marker appears prominently in the report.

---

## Phase 8: hardening and polish

- edge-case matrix (a manual test checklist, run against 3–4 real SaaS apps): an SPA with client routing and a service worker; an OAuth popup flow; a page that navigates cross-origin mid-session; an iframe-heavy app; a page with a CSP that blocks inline styles (the annotation overlay); a 60-minute session with polling (storage and trimmer behavior); and DevTools-open conflict messaging
- performance: tune the event buffer, make sure blobs never pass through runtime messaging (write from the capturing context, or transfer via asset ids), and make sure exporting a 500 MB session does not run out of memory (stream the zip entries)
- storage management: an options-page usage view per session, a `navigator.storage.estimate()` warning at 80%, and an oldest-session cleanup prompt
- options page completion: a redaction custom-rules editor, capture knobs (screenshot policy default, body caps, file cap), STT config (from Phase 6), and a keyboard shortcut reference
- session browser polish: rename sessions, re-export at any level, and per-session size
- docs: a README (install steps and the rationale for each permission, especially the debugger banner) and `docs/report-format.md` for LLM-consumer guidance (how to prompt an agent with the zip)

Exit criteria: the full matrix passes. A stranger can install from the README, record a bug in their own app, and hand the zip to Claude Code with a working outcome.

---

## Cross-cutting practices

- testing: concentrate unit tests where the logic is pure and intricate: trimmer transforms, redaction, the markdown renderer, shape summary, and request collapsing (golden files with fixture sessions). Validate capture code through the per-phase manual checklists plus a bundled `demo/` test page (buttons that fire fetches, errors, file inputs, and log spam) served locally for repeatable manual runs.
- the paste-test as regression gate: from Phase 3 onward, every phase ends by pasting a fresh `report.md` into an LLM and asking it to reconstruct the session. If its answer degrades, the product has regressed, whatever the unit tests say.
- event funnel discipline: every new capture source goes through `recordEvent`. Every new event type gets a schema-doc entry, a renderer rule, a trimmer classification (protected, droppable, or compactable), and an importance score. An exhaustiveness check on the event-type union enforces this, so forgetting one is a compile error.
- permissions hygiene: add each permission in the phase that needs it, with a line in the README explaining why it is required

## Sequencing rationale

Phases 1 to 4 build the spine: capture, persist, export, then trim. Each of Phases 5, 6, and 7 is an independent capture source that plugs into the existing funnel and renderer, so after Phase 4 you can reorder or parallelize them if priorities shift. Export lands early, in Phase 3, because report quality is the product: every later feature is judged by what it does to `report.md`.
