# Development

Session Recorder is a Chrome Manifest V3 extension built with WXT, React and TypeScript. User setup is in the [README](README.md) and [sharing guide](docs/sharing.md).

## Build and load

Use Node.js 22 and the pnpm version declared in `package.json`.

```sh
git clone https://github.com/prooflinedev/session-recorder-chrome-extension.git
cd session-recorder-chrome-extension
pnpm install --frozen-lockfile
pnpm build
```

In `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose `.output/chrome-mv3`. Pin the extension and select its toolbar icon to open the recorder.

For subsequent builds, keep the same unpacked directory and use **Reload** on its extension card. Chrome derives an unpacked extension's identity from its path; loading another directory can give it separate settings and recordings. Reloading closes extension pages, so stop any active recording first.

```sh
pnpm dev       # WXT development server
pnpm build     # Production files in .output/chrome-mv3
pnpm zip       # WXT ZIP package
```

The `dev:firefox` script is a WXT development entry point, not a supported Firefox release. Capture relies on Chrome APIs including `debugger`, `sidePanel`, `offscreen` and `tabCapture`.

## Check changes

```sh
pnpm compile        # Extension TypeScript
pnpm compile:e2e    # Browser-test TypeScript
pnpm test           # Vitest
pnpm exec playwright install chromium
pnpm test:e2e       # Build, then Playwright
pnpm test:e2e:headed
```

Run focused suites while editing, then the checks affected by the change. Playwright loads the built extension into an isolated Chromium profile and serves `demo/` on port 5319. It uses synthetic audio/video devices. Tests cover capture and export, redaction, annotation, publishing, managed connection, permissions and failure recovery; network fixtures keep automated sharing tests from creating real issues or reports.

To run a focused browser test after building:

```sh
pnpm exec playwright test e2e/proofline.spec.ts
```

Personal credentials belong in the extension settings. Local `.env*` and `local.env` files are ignored; do not commit keys or embed them in the browser bundle. Managed credentials belong on the Proofline server. The extension stores only its expiring, workspace-scoped connection token.

## Code map

| Path | Responsibility |
| --- | --- |
| `entrypoints/background.ts` | Session lifecycle, event ingestion, capture coordination and runtime messages |
| `entrypoints/*.content.ts` | Interactions, files, live annotations and screenshot annotation |
| `entrypoints/sidepanel/` | Recording controls, session list and shared settings components |
| `entrypoints/options/` | Full-page settings |
| `entrypoints/share/` | Issue draft, evidence, repository picker and filing progress |
| `entrypoints/report/` | Full local report and export |
| `entrypoints/offscreen/` | Microphone and tab-video recording |
| `entrypoints/mic-permission/` | Visible microphone-permission flow |
| `lib/session/` | Session/event types, defaults, importance and protected signals |
| `lib/capture/` | CDP, console, network, screenshots, tabs and redaction |
| `lib/annotations/` | Annotation state, overlay, dictation and page vocabulary |
| `lib/storage/` | IndexedDB and batched event writes |
| `lib/export/` | Trimming, Markdown/HTML, token estimates, OpenAPI and ZIP bundles |
| `lib/sharing/` | Personal-key summaries, Cloudflare publishing and GitHub issues |
| `lib/proofline/` | Device authorization, managed AI, reports and service settings |
| `lib/transcription/` | Provider adapters, streaming, keyterms and PCM conversion |
| `e2e/`, `demo/` | Browser fixtures and capture test page |

## Architectural rules

Capture sources feed the background event funnel, which assigns event identity and timestamps before storing them in IndexedDB. Content scripts use typed messages from `lib/messaging.ts`; they do not receive provider credentials. Large assets live in IndexedDB rather than Chrome messages.

Keep UI state in focused hooks and reducers. Effects synchronize browser lifecycle and external storage; button handlers own user-requested work. Pure export transforms clone their inputs. `lib/session/types.ts` and `lib/session/events.ts` define the event contract and protected signals.

AI summaries prioritize annotations and narration. Filing persists operation identities and checkpoints so retries do not blindly duplicate uploads or GitHub issues. Personal keys are an explicit mode, never an automatic fallback from exhausted Proofline credits.

Changes to the Proofline API span this repository and [prooflinedev/proofline](https://github.com/prooflinedev/proofline). Keep workspace approval, credit accounting, report access, idempotency and cancellation contracts aligned. The server owns provider secrets and permission checks; client checks are not authorization.

See [internal modules](docs/internal-api.md), [event schema](docs/event-schema.md) and [report format](docs/report-format.md).

## Chrome permissions

The manifest is generated from `wxt.config.ts`.

| Permission | Use |
| --- | --- |
| `debugger` | CDP network, console, exception and screenshot capture |
| `sidePanel` | Recorder UI |
| `tabs`, `webNavigation` | Recorded tabs and navigation |
| `scripting` | Activate content scripts; read page storage (localStorage, sessionStorage, readable cookies) at start and stop |
| `storage`, `unlimitedStorage` | Settings and local recording persistence |
| `offscreen` | Microphone and tab-video recording |
| `tabCapture` | Capture tab video and sound |
| `downloads` | Save report ZIPs |
| `alarms` | Flush capture buffers while recording |
| `<all_urls>` | Record the web application selected by the user |

## Proofline connection

Browser approval uses the existing device authorization flow. After the approved
connection and account have been saved, the extension returns to
`options.html#proofline` and closes only the matching approval tab. Starting from
the side panel opens settings in a tab. Cancellation or approval of a different
workspace preserves the current connection and does not trigger the return.
Reconnecting an expired connection requests its existing workspace and rejects
approval of another workspace. Saved report destinations and upload checkpoints
remain unchanged.

Connecting enables Proofline for all AI, private reports and GitHub issue filing.
The shared settings load/save boundary applies this rule to existing connected
profiles too. Expired connections remain on managed services and require reconnect;
they never fall back to personal keys. Disconnect explicitly restores standalone
service modes without removing saved personal credentials. Connected settings hide
manual setup forms and provider/model overrides.

## Website and release ownership

The Proofline marketing site and help center are implemented in `apps/marketing` in the Proofline repository. The destination is `https://proofline.sh/session-recorder-chrome-extension/`, with help under `/help/session-recorder/`. Deployment is separate from publishing this extension.

This repository retains the legacy static site in `website/` and its source generator in `scripts/website/` during cutover. Do not treat old campaign documents as instructions to deploy the former host.

```sh
node scripts/website/build.mjs
node scripts/website/check.mjs
```

A stable GitHub release tagged `vMAJOR.MINOR.PATCH` runs the release workflow. The tag must match `package.json` and the built manifest. The workflow checks and packages that revision, attaches the ZIP and checksum, then submits the same ZIP to Chrome Web Store review using a short-lived Google token. See [publishing setup and recovery](docs/chrome-store-publishing.md). Store authorization must be configured before the first submission. The workflow does not deploy Proofline. Do not advertise the latest-release ZIP until a release asset exists.

Store metadata and publication requirements are in [store-listing.md](docs/store-listing.md). Preserve Chrome Web Store item ID `dboiheheijgmfpfhbmjggiijpgondghh`; moving GitHub ownership does not transfer the store publisher.

## Product screenshots

After `pnpm build` and installing Playwright Chromium, run
`node scripts/capture-screenshots.mjs`. It captures the actual extension in an
isolated profile against `demo/checkout.html`, using fictional sample evidence
and no provider calls. Outputs are in `docs/screenshots/`; copy the matching
images to Proofline marketing when the UI changes.
