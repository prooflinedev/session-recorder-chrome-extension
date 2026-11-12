# Event schema

This document describes the recorder's stored event stream. The renderer and
trimmer read events by `type`; source declarations remain authoritative when
adding a field or event.

The runtime source of truth is [`lib/session/types.ts`](../lib/session/types.ts).
Changes may add new `EventType`s by extending `EventType` and
`EventPayloadMap`, but they must never change the shape of an existing payload. To
change a field's meaning, add a new field instead.

## Envelope

Every event is a `BaseEvent<T>`, a discriminated union member keyed on `type`:

| Field        | Type                        | Meaning |
| ------------ | --------------------------- | ------- |
| `id`         | `string`                    | Unique event id (`newId`). |
| `sessionId`  | `string`                    | Owning session id. |
| `t`          | `number`                    | Milliseconds from session start, not epoch. This is the join key across events, screenshots, and the voice transcript. The renderer prints it as `[mm:ss]`. |
| `tabId`      | `number` (optional)         | Source tab, when the event belongs to a specific tab. |
| `type`       | `EventType`                 | Discriminant that selects the payload shape. |
| `importance` | `number`                    | Static importance score, assigned once at capture by `scoreEvent` (see [`lib/session/events.ts`](../lib/session/events.ts)). A higher score survives trimming longer. |
| `protected`  | `boolean` (optional)        | When `true`, the trimmer never drops or compacts this event. The `PROTECTED_TYPES` set also implies protection even when this flag is unset, so the trimmer must consult `isProtected(e)`, not just this flag. |
| `payload`    | `EventPayloadMap[type]`     | Per-type body, documented below. |

A `RawEvent` is what a capture source emits before the background funnel stamps
`id`, `sessionId`, `t`, and `importance`. It carries only `type`, optional `tabId`,
optional `at` (an explicit ms-epoch timestamp; the funnel defaults to now), and
`payload`.

### Shared value objects

- `Rect` is `{ x, y, w, h }` (numbers)
- `Point` is `{ x, y }` (numbers)
- `ElementDescriptor` is a best-effort description of a DOM element, built in a
  content script: `tag` (required), optional `id`, `role`, `ariaLabel`, `name`,
  `text` (visible text, capped at about 80 characters), `selector` (best-effort CSS
  selector: id, then `[data-testid]`, then a short ancestor path), and `rect`
- `NetHeader` is `{ name, value }` (both strings)
- `NetBody` is described under [net-request](#net-request)

### Protected types

`isProtected(e)` returns `true` for any event with `protected: true`, and for all
of these types whatever the flag says:
`marker`, `note`, `annotation`, `voice-segment`, `error`, `file-captured`,
`file-attached`, `session-note`. These are the user's explicit signals plus
errors, the reason the recording exists, so the trimmer must preserve them at
every verbosity level.

---

## Interaction events

### `click`
`ClickPayload` records a pointer click on an element.

| Field        | Type                 | Meaning |
| ------------ | -------------------- | ------- |
| `descriptor` | `ElementDescriptor`  | The clicked element. |
| `modifiers`  | `string[]`           | Held modifier keys, for example `['ctrl','shift']`. Empty array when none. |
| `button`     | `number` (optional)  | Mouse button (0 = primary), when not the default. |

### `input`
`InputPayload` records a committed value change on a form field.

| Field       | Type                | Meaning |
| ----------- | ------------------- | ------- |
| `descriptor`| `ElementDescriptor` | The field. |
| `value`     | `string`            | The recorded value, or the redaction marker when `redacted` is true. |
| `redacted`  | `boolean`           | True for sensitive fields, such as passwords or tokens, per `isSensitiveInput`. When true, `value` holds the marker, never the real input. |
| `inputType` | `string` (optional) | The `<input type=…>`, for example `password` or `email`. |

### `scroll`
`ScrollPayload` records a scroll gesture. It has the lowest importance, and the
trimmer coalesces runs of consecutive scrolls on the same tab.

| Field      | Type                | Meaning |
| ---------- | ------------------- | ------- |
| `from`     | `Point`             | Scroll offset before the gesture. |
| `to`       | `Point`             | Scroll offset after. |
| `container`| `string` (optional) | Selector of the scroll container, or `'window'`. |

### `key`
`KeyPayload` records a notable key press, such as Enter, Escape, Tab, or a
shortcut chord.

| Field       | Type                          | Meaning |
| ----------- | ----------------------------- | ------- |
| `key`       | `string`                      | Normalized key, for example `'Enter'`, `'Escape'`, or `'Ctrl+K'`. |
| `modifiers` | `string[]`                    | Held modifiers. |
| `descriptor`| `ElementDescriptor` (optional)| The focused element, when known. |

### `hover`

`HoverPayload` stores `descriptor: ElementDescriptor` and `dwellMs: number`. It records a sustained pointer hover. L1 and higher drop unprotected hover events.

### `text-select`
`TextSelectPayload` records a settled text selection (or its deselection). The
content script debounces `selectionchange` (~500ms) so a drag-selection emits a
single event once it settles. When a previously captured selection becomes
empty, exactly one `cleared: true` event follows (deselecting when nothing was
captured emits nothing). Selections inside sensitive fields (`isSensitiveInput`,
for example password inputs) or any `[data-sr-redact]` region are never
captured. The trimmer keeps selections through L2, drops `cleared` events at
L1+, and drops all `text-select` events at L3.

| Field       | Type                          | Meaning |
| ----------- | ----------------------------- | ------- |
| `text`      | `string` (optional)           | Selection text, whitespace-normalized and capped at 500 chars. Absent when `cleared` is true. |
| `truncated` | `boolean` (optional)          | True when `text` was cut at the 500-char cap. |
| `descriptor`| `ElementDescriptor` (optional)| Common ancestor element of the selection, when resolvable. |
| `cleared`   | `boolean`                     | True for the single deselection event after a captured selection. |

---

## Navigation and tab events

These events segment the story. The renderer turns them into `##` section breaks.

### `nav`
`NavPayload` records a full-page navigation. The background captures it through
`chrome.webNavigation.onCommitted`.

| Field           | Type                | Meaning |
| --------------- | ------------------- | ------- |
| `url`           | `string`            | Destination URL. Query and fragment parameter values may be redacted. |
| `title`         | `string` (optional) | Page title, when available. |
| `transitionType`| `string` (optional) | Chrome transition type, for example `link`, `typed`, or `reload`. |

### `spa-route`
`SpaRoutePayload` records a client-side route change through the History API or a
fragment. It is captured through `onHistoryStateUpdated` and
`onReferenceFragmentUpdated`.

| Field   | Type                                        | Meaning |
| ------- | ------------------------------------------- | ------- |
| `url`   | `string`                                    | New route URL. Query and fragment parameter values may be redacted. |
| `title` | `string` (optional)                         | Title, when available. |
| `method`| `'pushState' \| 'replaceState' \| 'popstate'`| How the route changed. |

Page URLs on `nav`, `spa-route` and tab events, `Session.initialUrl` and
`TabInfo.url` use the session's URL redaction rules when redaction is enabled.

### `tab-switch`
`TabSwitchPayload` records that the active tab changed within the session.

| Field       | Type                | Meaning |
| ----------- | ------------------- | ------- |
| `fromTabId` | `number` (optional) | Previously active tab. |
| `toTabId`   | `number`            | Newly active tab. |
| `toUrl`     | `string` (optional) | URL of the newly active tab. |
| `toTitle`   | `string` (optional) | Its title. |

### `tab-opened`
`TabOpenedPayload` records that the session adopted a new tab.

| Field        | Type                | Meaning |
| ------------ | ------------------- | ------- |
| `url`        | `string` (optional) | Initial URL, when known. |
| `title`      | `string` (optional) | Initial title. |
| `openerTabId`| `number` (optional) | The tab that opened it. It must be a session tab for the new tab to be adopted. |

### `tab-closed`
`TabClosedPayload` records that a session tab was closed.

| Field  | Type                | Meaning |
| ------ | ------------------- | ------- |
| `url`  | `string` (optional) | Last known URL. |
| `title`| `string` (optional) | Last known title. |

---

## Deep-capture events

### `net-request`
`NetRequestPayload` records one network request and response, assembled from CDP
`Network.*` events. When redaction is enabled, it applies to headers, URL, and
bodies before emit.

| Field            | Type                    | Meaning |
| ---------------- | ----------------------- | ------- |
| `requestId`      | `string`                | CDP request id, also the join key for `ErrorPayload.linkedRequestId`. |
| `method`         | `string`                | HTTP method. Mutating methods (POST, PUT, DELETE, PATCH) score higher. |
| `url`            | `string`                | Request URL. Query and fragment parameter values may be redacted. |
| `resourceType`   | `string` (optional)     | CDP resource type (`XHR`, `Fetch`, `Image`, `Font`, `Stylesheet`, and so on). `dropStaticAssets` uses it. |
| `status`         | `number` (optional)     | Response status. A status of `>= 400` scores higher and is never dropped as a static asset. |
| `statusText`     | `string` (optional)     | Response status text. |
| `requestHeaders` | `NetHeader[]`           | Request headers (redacted). |
| `responseHeaders`| `NetHeader[]`           | Response headers (redacted). |
| `requestBody`    | `NetBody` (optional)    | Request body (see below). |
| `responseBody`   | `NetBody` (optional)    | Response body (see below). |
| `timing`         | `{ startedAt: number; durationMs?: number }` (optional) | Timing. |
| `initiator`      | `string` (optional)     | Initiator type or description. |
| `failed`         | `boolean` (optional)    | True when the request failed with a network error. Scores highest. |
| `failureReason`  | `string` (optional)     | CDP failure reason when `failed`. |
| `fromCache`      | `boolean` (optional)    | Served from cache. |
| `mime`           | `string` (optional)     | Response MIME type. |
| `websocket`      | `boolean` (optional)    | True for WebSocket connections. |
| `wsFrames`       | `WsFrame[]` (optional)  | WebSocket frames, capped at about 100, each text capped at about 2 KB. |
| `collapsed`      | `{ count: number; statuses: number[]; note?: string }` (optional) | The trimmer sets this when it folds repeated calls to the same endpoint into this representative request. |
| `bodyShape`      | `{ request?: string; response?: string }` (optional) | The trimmer sets this when it reduces a body to a JSON shape summary. |

`NetBody` is `{ present, mime?, text?, truncated?, originalSize?, assetId?, base64? }`:
- `present` is whether a body exists. It is false when the CDP body was evicted.
- `mime` is the body MIME type
- `text` is the body text, possibly truncated or redacted
- `truncated` is true when `text` was cut to the inline cap
- `originalSize` is the original size in bytes, before truncation
- `assetId` is the id of the full body, stored as a `net-body` asset when it overflowed the inline cap
- `base64` is true when `text` is base64 (a binary body)

`WsFrame` is `{ dir: 'sent' | 'recv'; opcode: number; ts: number; text?: string; truncated?: boolean }`. `ts` is milliseconds from session start.

### `console`
`ConsolePayload` records a `console.*` call or a non-error `Log.entryAdded`.

| Field   | Type                  | Meaning |
| ------- | --------------------- | ------- |
| `level` | `ConsoleLevel`        | One of `log \| info \| warn \| error \| debug \| trace`. `error` and `warn` score higher. |
| `text`  | `string`              | Stringified, space-joined args, capped at about 2 KB. |
| `args`  | `string[]` (optional) | Individual stringified arguments. |
| `repeat`| `number` (optional)   | Count of collapsed consecutive duplicates (same level and text within 1000 ms). |
| `stack` | `string` (optional)   | Stack trace, when present. |
| `source`| `string` (optional)   | Origin as `url:line`, from the first stack frame. |

### `error`
`ErrorPayload` records an error surfaced from any source. It is protected, and the
renderer isolates these with a `⚠` prefix.

| Field            | Type                                             | Meaning |
| ---------------- | ------------------------------------------------ | ------- |
| `message`        | `string`                                         | Error message. |
| `stack`          | `string` (optional)                              | Stack trace. |
| `origin`         | `'exception' \| 'console' \| 'network' \| 'log'` | Where it came from: an uncaught exception, `console.error`, a network failure, or an error-level `Log.entryAdded`. |
| `linkedRequestId`| `string` (optional)                              | The `net-request` this error is tied to. Its captured body is preserved by trimming. |
| `repeat` | `number` (optional) | Number of consecutive duplicate errors collapsed by the trimmer. |

---

## Visual events

### `screenshot`
`ScreenshotPayload` records a captured viewport JPEG, stored as an asset.

| Field           | Type                 | Meaning |
| --------------- | -------------------- | ------- |
| `assetId`       | `string`             | Id of the stored JPEG asset. |
| `width`         | `number`             | Image width, from the decoded bitmap. |
| `height`        | `number`             | Image height. |
| `trigger`       | `ScreenshotTrigger`  | Why it was taken: `interaction \| nav \| error \| annotation \| manual \| key-moment`. `annotation` and `manual` score highest, then `error`, then `nav`. |
| `ahash`         | `string` (optional)  | 64-bit average hash as hex, for near-duplicate dedup. |
| `repeat`        | `number` (optional)  | Count of consecutive near-duplicates folded into this shot. |
| `contextText`   | `string` (optional)  | One-line description of what triggered it, used as the image alt text or caption. |
| `hasAnnotations`| `boolean` (optional) | True when annotation shapes were drawn over it. |

### `annotation-start`
`AnnotationStartPayload` records that the user entered annotation mode.

| Field     | Type                   | Meaning |
| --------- | ---------------------- | ------- |
| `viewport`| `{ w: number; h: number }` | Viewport size at entry, the annotation coordinate space. |

### `annotation`
`AnnotationPayload` records screenshot markup or a live page comment anchored to an element or rectangle. It is
protected. The renderer describes each shape and its target element in text, so
the report reads without opening the image.

| Field              | Type                       | Meaning |
| ------------------ | -------------------------- | ------- |
| `shapes`           | `AnnotationShape[]`        | The drawn shapes (see below). |
| `screenshotAssetId`| `string` (optional)        | The screenshot being annotated. |
| `viewport`         | `{ w: number; h: number }` | Coordinate space for the shapes. |

`AnnotationShape` is `{ tool, color, strokeWidth, points?, rect?, from?, to?, text?, targetDescriptor? }`:
- `tool` is one of `pen \| arrow \| rect \| ellipse \| text \| highlighter \| redact`
- `color` and `strokeWidth` set the stroke styling
- `points` is the path for `pen` and `highlighter`
- `rect` is the bounds for `rect`, `ellipse`, and `redact`
- `from` and `to` are the endpoints for `arrow`
- `text` contains a text label or the comment on an annotated element/rectangle
- `targetDescriptor` is the element under the shape's anchor, for a text-only description to the LLM

---

## Voice events

### `voice-segment`
`VoiceSegmentPayload` records a recorded audio segment plus its transcript. It is
protected.

| Field               | Type                                | Meaning |
| ------------------- | ----------------------------------- | ------- |
| `assetId`           | `string` (optional)                 | Id of the stored audio asset; absent for transcript-only streamed events. |
| `tStart`            | `number`                            | Segment start, milliseconds from session start. |
| `tEnd`              | `number`                            | Segment end, milliseconds from session start. |
| `transcript`        | `string \| null`                    | Transcribed text. It is `null` when not yet transcribed or when transcription failed. |
| `words`             | `{ word: string; t: number }[]` (optional) | Per-word timings (milliseconds from session start), when the provider supplies them. |
| `transcriptionError`| `string` (optional)                 | Error message when transcription failed. |
| `provider`          | `string` (optional)                 | Transcription provider used. |
| `streamed`          | `boolean` (optional)                | Transcript arrived through live streaming. |
| `anchorContext`     | `string` (optional)                 | Nearby interaction context for narration. |
| `transcriptionGeneration` | `number` (optional)           | Local retry generation. |
| `transcriptionTerminalFailure` | `boolean` (optional)      | Prevents automatic retry of a terminal failure. |
| `transcriptionRequest` | `{ id, organizationId, provider, language?, keyterms }` (optional) | Local managed request identity and dictionary; removed from exported and published events. |

## Video events

### `video-segment`

`VideoSegmentPayload` contains optional `assetId`, `tStart` and `tEnd` in milliseconds from session start, and optional `note`. Full and Standard exports include the clip. Compact and Minimal retain its time range and an omission note while dropping unprotected video bytes.

---

## File events

Both events use `FilePayload`. Both are protected.

### `file-captured`
A file the user selected or uploaded on a page, captured by the file-capture
content script.

### `file-attached`
A file the user attached directly through the extension UI.

`FilePayload`:

| Field         | Type                | Meaning |
| ------------- | ------------------- | ------- |
| `assetId`     | `string` (optional) | Id of the stored file asset. Undefined when metadata-only (oversized). |
| `fileName`    | `string`            | Original file name. |
| `mime`        | `string`            | MIME type. |
| `size`        | `number`            | File size in bytes. |
| `contextText` | `string` (optional) | Where it was used, for example `"uploaded to Import CSV dialog"`. |
| `metadataOnly`| `boolean` (optional)| True when the file exceeded `fileCapBytes` and only metadata was kept. |
| `note`        | `string` (optional) | Free-form note. |

---

## User-signal events

### `marker`
`MarkerPayload` records an explicit user marker. It is protected, and the renderer
shows it as a prominent blockquote.

| Field  | Type     | Meaning |
| ------ | -------- | ------- |
| `name` | `string` | Marker label. |

### `note`
`NotePayload` records a typed note from the user. It is protected, and the
renderer shows it as a prominent blockquote.

| Field  | Type     | Meaning |
| ------ | -------- | ------- |
| `text` | `string` | Note text. |

---

## System events

### `session-note`
`SessionNotePayload` records a note the system makes about the session itself,
covering rehydration, debugger detach, and info or warning messages. It is
protected.

| Field  | Type                                          | Meaning |
| ------ | --------------------------------------------- | ------- |
| `text` | `string`                                      | Note text. |
| `kind` | `'rehydrate' \| 'detach' \| 'info' \| 'warning'` | Category of system note. |
