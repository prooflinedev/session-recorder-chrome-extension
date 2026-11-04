# Source audit and recalculation record

## Baseline and method

- Rebuild baseline: `zavalit/session-recorder-chrome-extension:main` at
  `0c35e4a`.
- The application source, storage reducers, background orchestration, hooks,
  components, and relevant tests were audited before the graph was changed.
- Existing URNs were retained only when current behavior kept the same semantic
  identity. Obsolete states, commands, transitions, Surfaces, conditions,
  effects, recognition leaves, and references were removed together.
- Transient error copy remains observable on the stable state that owns it; no
  extra Graph topology was invented solely for a toast or policy-refusal string.

## Source areas reviewed

- Recorder and recovery: `entrypoints/sidepanel/App.tsx`, recorder hooks,
  `entrypoints/background.ts`, microphone permission, comments, and markup.
- Proofline ownership: `ProoflineSettings.tsx`, `ServicesSettings.tsx`,
  `useProoflineSettings.ts`, `lib/proofline/settings.ts`, and account/report
  helpers.
- Personal and managed settings: `SettingsForm.tsx`, `SharingSettings.tsx`,
  transcription tests, provider/model selection, Cloudflare publishing,
  summaries, repositories, GitHub, and storage.
- Voice setup: `VoiceSetupModal.tsx` and the recorder's
  `isTranscriptionConfigured` guard.
- Workspace and filing: `entrypoints/share/App.tsx`, `useShareReport.ts`,
  reducers, `lib/sharing/file-issue.ts`, Proofline reports, Cloudflare reports,
  cancellation, deletion, and durable draft/checkpoint restoration.
- Existing unit tests and the prior UJG capture fixtures were used as corroborating
  evidence, not as substitutes for current source behavior.

## Recalculated behavior

### Proofline and automatic service ownership

- The disconnected Proofline state offers **Connect to Proofline**.
- Connecting, cancellation, approval failure, current connection, expiry,
  reconnect/change-account, refresh, and disconnect remain distinct where the
  UI or continuation semantics differ.
- Successful connection automatically owns transcription, summaries, private
  report hosting, and GitHub filing. The obsolete independent service selectors,
  managed-AI choice, and their saving/saved topology were removed.
- Disconnect restores personal transcription and GitHub behavior plus Cloudflare
  publishing defaults.
- Services, transcription, publishing, summaries, and GitHub each branch after
  settings load to either personal/disconnected configuration or the current
  Proofline-managed summary Surface.

### Voice setup

- A current Proofline connection already satisfies transcription configuration,
  so recorder actions bypass the voice-setup modal and continue directly.
- The two material voice-setup states apply only while disconnected and expose a
  personal provider/API-key path or **Keep raw audio only**. Connected modal
  variants were deliberately not invented from unreachable component markup.

### Workspace, upload recovery, and repository fallback

- A saved Proofline report with incomplete attachments restores to the partial
  upload state with **Upload incomplete**, **Open partial report**, and
  **Resume upload**.
- Resume enters the real publishing operation and retains uploaded attachment
  identifiers and the durable checkpoint. The obsolete managed
  `Check deployment` no-op transition was removed; Cloudflare deployment polling
  remains separate.
- Filing from a partial upload continues from the saved checkpoint. Connection
  expiry or provider failure returns to the partial state with its durable
  progress intact.
- Restored drafts use the saved repository when nonempty and otherwise fall back
  to the preferred configured repository. No synthetic fallback state was added.
- Workspace operation failures and provider-policy refusals are feedback on the
  owning stable/pending state unless they change durable journey semantics.

## Structural result

- 18 Journeys, 122 States, 17 CompositeStates, and 1,059 local Transitions.
- 109 material state-bound Surfaces, each with exactly one capture contract,
  screenshot-map entry, audit receipt, and PNG.
- Structural validation covers Editor's Draft contexts/vocabulary, unique IDs,
  typed references, ownership, local endpoints, child-journey entry/exit
  boundaries, Surface targets, localization pairing, observability contracts,
  and orphan Commands/Conditions/Effects/locators/messages.
