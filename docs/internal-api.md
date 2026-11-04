# Internal modules and contracts

This is a guide to the implementation, not a second set of TypeScript declarations. Follow the linked source for exact signatures. Public session/event shapes are in [`lib/session/types.ts`](../lib/session/types.ts); runtime request and broadcast messages are in [`lib/messaging.ts`](../lib/messaging.ts).

## Session and storage

[`entrypoints/background.ts`](../entrypoints/background.ts) owns session transitions, tab attachment and the event funnel. Capture sources emit `RawEvent`; the funnel produces a stored `SessionEvent` with an ID, session ID, relative timestamp and importance score.

[`lib/storage/index.ts`](../lib/storage/index.ts) owns the `session-recorder` IndexedDB database. It stores sessions, events and assets, with session indexes for event and asset retrieval. `EventWriter` batches events; blobs are stored as assets. Session deletion removes its local events and assets. It does not unpublish a hosted report.

[`lib/session/events.ts`](../lib/session/events.ts) owns event importance and `isProtected`. The trimmer consults this predicate rather than relying solely on an event's optional `protected` field. [`lib/session/settings.ts`](../lib/session/settings.ts) owns capture defaults and normalization.

Use [`lib/util/ids.ts`](../lib/util/ids.ts) for IDs and [`lib/util/hash.ts`](../lib/util/hash.ts) for content and screenshot hashes.

## Capture

| Module | Responsibility |
| --- | --- |
| [`lib/capture/debugger.ts`](../lib/capture/debugger.ts) | CDP attachment, command dispatch and detach handling |
| [`lib/capture/network.ts`](../lib/capture/network.ts) | Assemble request/response events, bounded bodies and WebSocket frames |
| [`lib/capture/console.ts`](../lib/capture/console.ts) | Console output and exceptions |
| [`lib/capture/screenshots.ts`](../lib/capture/screenshots.ts) | Screenshot scheduling and deduplication |
| [`lib/capture/multitab.ts`](../lib/capture/multitab.ts) | Recorded tabs and navigation |
| [`lib/capture/redaction.ts`](../lib/capture/redaction.ts) | Header, body and URL masking |
| [`lib/dom/descriptor.ts`](../lib/dom/descriptor.ts) | Element descriptions and sensitive-input detection |

Content scripts capture interactions, uploaded files and annotations. They send typed messages to the background, which validates the sender and active recording. Redaction is enabled by default, but screenshots, media, files and arbitrary text are not comprehensively scrubbed. Do not promise that no sensitive information can reach storage.

## Annotations and speech

[`lib/annotations/point-overlay.ts`](../lib/annotations/point-overlay.ts) implements page-element and freeform-rectangle selection. [`lib/annotations/reducer.ts`](../lib/annotations/reducer.ts) owns annotation state. [`lib/annotations/dictation.ts`](../lib/annotations/dictation.ts) merges speech with the active comment, while [`lib/annotations/page-vocabulary.ts`](../lib/annotations/page-vocabulary.ts) extracts bounded visible labels for optional vocabulary suggestions.

[`lib/transcription/index.ts`](../lib/transcription/index.ts) dispatches personal or managed transcription. Personal Deepgram and ElevenLabs adapters can stream results; OpenAI-compatible transcription uses recorded segments. Managed transcription converts audio to the server's PCM contract through [`lib/transcription/pcm.ts`](../lib/transcription/pcm.ts).

Voice events retain retry generation and request identity locally. Export removes internal transcription-request metadata. Annotation dictation uses the recording microphone; toggling its mic control affects that microphone, not a separate recording channel.

## Export

[`lib/export/trimmer.ts`](../lib/export/trimmer.ts) applies deterministic cumulative levels to cloned events. It uses protected signals and error-linked request IDs to preserve relevant evidence. It does not call an AI provider.

[`lib/export/bundle.ts`](../lib/export/bundle.ts) selects referenced assets, deduplicates bytes, assigns relative paths and rewrites exported asset references. [`lib/export/markdown.ts`](../lib/export/markdown.ts) renders the report and manifest. [`lib/export/zip.ts`](../lib/export/zip.ts) packages the files. [`lib/export/openapi.ts`](../lib/export/openapi.ts) infers an optional API description from untrimmed network events. [`lib/export/repro/plan.ts`](../lib/export/repro/plan.ts) builds the repro test's plan from untrimmed events and embeds it as JSON in the fixed runner [`lib/export/repro/runner.template.ts`](../lib/export/repro/runner.template.ts); recorded text never becomes code.

[`lib/export/report-html.ts`](../lib/export/report-html.ts) renders the shareable HTML report. Markdown and captured content are untrusted; keep sanitization and escaping at rendering boundaries. [Report format](report-format.md) describes the artifacts and trimming levels.

## Sharing and Proofline

[`lib/sharing/`](../lib/sharing/) contains personal-provider summaries, GitHub issue creation, Cloudflare publishing, settings and durable local draft state. [`entrypoints/share/useShareReport.ts`](../entrypoints/share/useShareReport.ts) orchestrates filing; [`entrypoints/share/reducer.ts`](../entrypoints/share/reducer.ts) owns its UI state. Annotations and narration take priority over diagnostics in the summary input.

[`lib/proofline/`](../lib/proofline/) owns the optional device authorization, authenticated requests, managed AI and private report client. A connection is bound to one paying organization. A new organization requires browser approval; the previous connection is retained if approval is canceled or mismatched. Connected settings always use Proofline for all AI, private hosting and GitHub issue filing, including older stored profiles. Provider/model overrides and manual credential forms are unavailable until disconnect. The shared settings boundary enforces the same behavior in the background and UI.

`Settings → Proofline` owns account/workspace connection. `Settings → Services` shows the active service routing without overrides. Connected summary, transcription, publishing and GitHub pages show their managed status. Disconnect restores standalone modes and their saved personal settings.

Keep these boundaries intact:

- Provider keys and Proofline tokens remain in trusted extension storage and are omitted from exports and published reports.
- Exhausted credits, revoked access or expired connections must not silently select personal keys.
- Persist operation IDs before sending managed AI, report or issue requests. Retried requests resume their original operation.
- Cancellation cannot undo a provider request or GitHub write already accepted. Preserve the checkpoint and resolve uncertain publication before sending another create request.
- The server independently checks membership, report ACLs, repository authority, credit reservations and quotas. UI state is not an authorization decision.

The backend contract is documented in [`apps/saas/docs/session-recorder.md`](https://github.com/prooflinedev/proofline/blob/codex/session-recorder-proofline/apps/saas/docs/session-recorder.md) in the companion Proofline change. Managed production rollout is separate from loading this extension.

## UI and tests

The recorder, full-page settings and issue draft are separate entrypoints. Keep user-action orchestration in handlers and state in hooks/reducers. Effects handle browser lifecycle and external subscriptions.

[`lib/fixtures/session-builder.ts`](../lib/fixtures/session-builder.ts) creates test sessions. [`e2e/support.ts`](../e2e/support.ts) launches an isolated extension profile with synthetic media devices and accesses test-only background hooks. Do not use those hooks as production APIs. Build and verification commands are in [DEVELOPMENT.md](../DEVELOPMENT.md).
