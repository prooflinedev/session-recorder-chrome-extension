# Report format and LLM handoff

This document describes the exported zip a recorded session produces. It also shows how to hand `report.md` to an LLM coding agent so the agent can diagnose what you did and what went wrong.

We assemble the zip in [`lib/export/bundle.ts`](../lib/export/bundle.ts) and [`lib/export/zip.ts`](../lib/export/zip.ts). We render the human-readable report in [`lib/export/markdown.ts`](../lib/export/markdown.ts). The trimming that decides what each verbosity level contains lives in [`lib/export/trimmer.ts`](../lib/export/trimmer.ts).

## Zip layout

We prefix every path with a single root directory named after the session, so the archive unpacks into one folder:

```
<session-name>/
  report.md            # the LLM entry point; text summary at every level
  session.json         # trimmed event stream + session meta, asset refs → zip paths
  MANIFEST.md          # index of every included asset (path, kind, size)
  transcript.json      # voice segments; an empty array when there are none
  openapi.json         # inferred API description, when capture is enabled and endpoints exist
  repro.spec.ts        # Playwright test that replays the recording (ZIP download only)
  playwright.config.mjs  # runs only repro.spec.ts, never files captured from the page
  screenshots/
    001-0004.jpg       # {seq}-{mmss}.jpg: seq order, timestamp in the name
    002-0011.jpg
    …
  network/
    001-api.example.com-todos.json   # {seq}-{host}-{path-slug}.json: full request/response
    …
  files/
    import.csv         # {original-name}: files the user uploaded/attached
    …
  video/
    001-0000.webm      # clips at Full and Standard levels
    …
  audio/
    001.webm           # {seq}.webm: recorded voice segments
    …
```

Note the following:

- `report.md` is the primary artifact. It is a single chronological narrative with `[mm:ss]` timestamps, section breaks at navigations and tab switches, fenced network bodies and console or error output, screenshot references, and blockquotes for your markers and notes. At Compact and Minimal it retains the main text evidence. Visual details may still require the referenced screenshots or other assets.
- `session.json` is the machine-readable mirror. It holds the trimmed event stream (the same events, in the same order as the report) plus session metadata, with all asset references rewritten to their zip-relative paths. Use it when you want to program against the events rather than read prose.
- `MANIFEST.md` lists every asset actually included in the zip. Some assets are dropped at higher verbosity levels (see below), so the report never points at a file that is not there.
- Asset naming embeds the sequence and timestamp (`{seq}-{mmss}`) so files sort in capture order and cross-reference the `[mm:ss]` marks in `report.md`.
- We include only assets still referenced by a surviving event. The exceptions are annotation screenshots, audio, and file assets, which we always include regardless of level because they are protected signal.

## Verbosity levels

Levels are cumulative transform pipelines, not budget solvers. Each higher level runs the previous level's transforms plus a few more, so the output is deterministic and explainable. The token figures below are calibration targets (a chars/4 estimate), not hard runtime limits.

| Level | Target | What it contains |
| ----- | ------ | ---------------- |
| L0 (full) | everything | No trimming. Full request and response bodies up to the capture cap, every screenshot, every event. The complete fidelity that lives in IndexedDB. |
| L1 (standard) | about 150k tokens | Static-asset requests (images, fonts, css, and analytics hosts) collapsed to one summary line; response bodies truncated to the first 4 KB (original size noted); consecutive scrolls coalesced; consecutive duplicate console lines deduped with counts; screenshots thinned to key moments; near-duplicate screenshots already folded. |
| L2 (compact) | about 50k tokens | Everything in L1, plus JSON bodies reduced to a shape summary (keys, types, and array lengths, for example `{ users: Array(50) of { id, name, email } }`); repeated calls to the same endpoint collapsed to the first occurrence plus a `×N similar` marker (requests with a differing status stay full, because anomalies are signal); screenshots kept only for annotations and errors; video bytes omitted while clip times remain. |
| L3 (minimal) | about 15k tokens | Everything in L2, plus network bodies dropped except those linked to an error or `status >= 400`; interactions reduced to element tag and text; text-selection events omitted; screenshots reduced to a filename manifest. The result is a narrative skeleton: navigations, clicks, transcript, markers and notes, annotations, and errors with request and response one-liners. |

Pick the lowest level that fits the target model's context window while still containing the bodies and screenshots the question needs. For most debugging, L2 works best: it stays readable and self-sufficient while fitting comfortably in a large context. Drop to L3 only when the session is very long or the model's window is tight. Go to L1 or L0 when you specifically need full response bodies.

### What we never trim at any level

The trimmer skips any event where `isProtected(e)` is true. That covers the following, at every level including L3:

- markers and notes, your explicit signals
- errors (`error` events) and the network requests they link to through `linkedRequestId`, whose bodies stay full
- annotations and their screenshots
- voice segments and transcript
- file captures and attachments (metadata always; we always include the file asset in the zip)
- session notes (rehydrate, detach, info, and warning)

We likewise preserve any event explicitly flagged `protected: true`. So no matter how aggressively you trim for token budget, your intent and every error survive.

## Handing `report.md` to an LLM coding agent

Follow these steps in order:

1. Unzip the archive and start with `report.md`. Keep the assets available for visual or file-specific questions.
2. Paste `report.md` into the agent. If the agent can browse files, attach the whole unzipped folder instead, so it can also open the referenced screenshots and `network/*.json` bodies.
3. If the report is long, export at L2 first. Re-export at a lower or higher level only if the agent asks for more or less detail. Re-export is free and lossless from source, because we retain full fidelity in IndexedDB.

### Suggested prompt

> You are a debugging assistant. Below is `report.md`, a chronological recording
> of a user session in a web app, captured by a browser extension. Timestamps are
> `[mm:ss]` from the start of the session and are the join key across events,
> screenshots, and the voice transcript. Section headings (`##`) mark navigations
> and tab switches. Network requests show method, URL, status, and (depending on
> verbosity) bodies or a JSON shape summary; a `×N similar` marker means repeated
> identical calls were collapsed. Errors are prefixed with `⚠`. The user's own
> markers and notes appear as blockquotes and are the most important signal.
>
> Please:
> 1. Summarize what the user was trying to do, step by step.
> 2. Identify what went wrong: the first error and its likely root cause, citing
>    the `[mm:ss]` timestamps and the specific requests/console lines involved.
> 3. Suggest the concrete code change or investigation that would fix it.
>
> If a detail you need was trimmed (for example a full response body), say which
> `[mm:ss]` event you'd want re-exported at a higher verbosity level.
>
> ```
> <paste report.md here>
> ```

### Tips

- cite timestamps. Asking the agent to reference `[mm:ss]` keeps its answer verifiable against the report and the screenshots.
- trust the blockquotes. Markers and notes are you narrating your own intent. We never trim them, and they are the best anchor for what you expected.
- follow `linkedRequestId`. Errors point at the network request that caused them. At every level we preserve that request's body, so the agent can inspect the exact failing payload.
- escalate verbosity surgically. If the agent needs one full body, re-export at L1 or L0 rather than dumping the whole session at full fidelity.

## Checking a fix with `repro.spec.ts`

The ZIP download includes `repro.spec.ts`, a Playwright test generated from the
recording without an AI call. It is the same at every verbosity level. Hosted
reports do not include it. It replays the recorded steps and checks whether
the recorded errors happen again: uncaught exceptions, console errors, and
requests that failed or returned 400 or more. It ignores telemetry, static files and
the favicon. `report.md` lists the checked signals and anything not replayed.

```sh
npm install --no-save @playwright/test && npx playwright install chromium
BASE_URL=http://localhost:3000 npx playwright test
```

Run it in the unzipped folder. The bundled `playwright.config.mjs` runs only
`repro.spec.ts`: `files/` holds files captured from the page, and a page can
name one `repro.spec.ts`, so never point a test runner at the folder without
that config.

| Result | Test | Meaning |
| --- | --- | --- |
| `REPRODUCED` | fails | A recorded error happened again. |
| `INCONCLUSIVE` | fails | The replay did not reach the bug: a step failed, an element was not found, a variable was missing, a recorded failing request was never made, a step was skipped, or a request was blocked. |
| `NOT REPRODUCED` | passes | An earlier run reproduced the bug against the same server, every step ran, each failing request was sent again with the recorded fields and succeeded, nothing was left pending, and no recorded error happened again. It does not prove the bug is fixed. |

Run it once on the unfixed code. A run that says `REPRODUCED` writes
`.repro-baseline.json` next to the test, and `NOT REPRODUCED` is only possible
with that file for the same plan and server, so a replay that never reproduced
the bug here cannot report a fix. To run the test in CI, commit the baseline
file with it. A recording with no error or failed request gives a `fixme` test
that quotes your notes; add an assertion for what went wrong.

The recorder posts a typed value about 800 ms after the last keystroke, so a
value typed just before a click or Enter is recorded after that action. The
test moves such a value back in front of the action and replays it, but the
page may have changed the field by then (for example cleared it on submit),
so a replay that needed it ends `INCONCLUSIVE` rather than `NOT REPRODUCED`.
Pausing briefly after typing avoids this.

Recorded page text is data in the test, never code. The test refuses a
non-local `BASE_URL` and navigation to non-local hosts, and blocks requests
that change data (anything but GET, HEAD and OPTIONS) there, unless
`REPRO_ALLOW_REMOTE=1`. After the last step it waits up to `REPRO_WAIT_MS`
(30000) for pending requests; one still pending gives `INCONCLUSIVE`.
Redacted fields read `REPRO_INPUT_<n>`; `REPRO_STORAGE_STATE` names a Playwright
storage-state file to start signed in, since cookies are never recorded. Other
tabs, hover, scroll and drag are not replayed. Steps inside iframes are not
told apart from the page, so they usually end the replay as `INCONCLUSIVE`.

## Local and hosted reports

ZIP export and hosted report publication share the evidence bundle but have separate storage lifecycles. Internal managed-transcription request IDs and dictionaries are stripped from exported events. The local HTML viewer and hosted page render evidence from this bundle; neither includes API credentials. Deleting the local session does not delete a published report. See [sharing setup](sharing.md).
