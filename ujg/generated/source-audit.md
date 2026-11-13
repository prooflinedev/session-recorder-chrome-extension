# Source audit and reduction record

## Baseline

- Audited application revision: `c8e26fa` (the earlier full recalculation audited `0c35e4a`; there is no
  application-source difference between the two outside `ujg/`).
- Dirty source: none. `git status` showed changes only under `ujg/` at the time of this pass.
- Document target: the Journey Viewer profile (Core + Graph + Surface only; see [`../AGENTS.md`](../AGENTS.md)).
  The previous 1.1 MB graph also carried Commands, Conditions, Effects, Artifacts, Observability, Localization and
  other modules; the viewer renders none of them, so they were removed rather than maintained.

## How this pass differs from a full recalculation

This pass **reduced and corrected** the existing graph; it did not re-derive every journey from source. Only the
areas below were re-read in application source. Everything else keeps the topology audited at `0c35e4a`, projected
onto the profile by [`ujg-viewer-profile.mjs`](../scripts/ujg-viewer-profile.mjs). A full regeneration is the task in
[`../prompts/recalculate-model.md`](../prompts/recalculate-model.md).

### Re-verified in source in this pass

- Proofline settings: [`useProoflineSettings.ts`](../../entrypoints/sidepanel/components/useProoflineSettings.ts)
  (`perform()` defaults to status `'saving'`, L82; `patch` L102; `connect` L108; `refresh` L176) and
  [`ProoflineSettings.tsx`](../../entrypoints/sidepanel/components/ProoflineSettings.tsx) (buttons disabled while
  `status !== 'idle'`, L11 and L34-87; pending approval block L98; error banner L116).
- Services settings: [`ServicesSettings.tsx`](../../entrypoints/sidepanel/components/ServicesSettings.tsx) L5-7
  (the alert replaces the form when `state.error` is set).
- Settings page: [`SettingsForm.tsx`](../../entrypoints/sidepanel/components/SettingsForm.tsx) hooks `useSharingSettings`
  and `useCaptureSettings` in the parent (L45-46), `ProoflineSettings`/`ServicesSettings` mounted per section (L94-95),
  Storage section L410 onward (`busy` shows "Deleting…"; no saved/saving badge).
- Delete-all: [`useCaptureSettings.ts`](../../entrypoints/sidepanel/components/useCaptureSettings.ts) L231-246
  (native confirm inside the busy wrapper; refuses unless every session is stopped).
- Sharing settings follow `chrome.storage.onChanged`:
  [`useSharingSettings.ts`](../../entrypoints/sidepanel/components/useSharingSettings.ts) L154.
- Voice setup: [`VoiceSetupModal.tsx`](../../entrypoints/sidepanel/components/VoiceSetupModal.tsx) (`onDone` from both
  "Save and continue" and "Keep raw audio only"; `onCancel` from close, Escape and the scrim, L41-130 and L211-224);
  openers in [`RecordButton.tsx`](../../entrypoints/sidepanel/components/RecordButton.tsx),
  [`CaptureBar.tsx`](../../entrypoints/sidepanel/components/CaptureBar.tsx) L53-54 and
  [`useRecordSetup.ts`](../../entrypoints/sidepanel/components/useRecordSetup.ts) L94-95.
- Stop handoff: [`background.ts`](../../entrypoints/background.ts) L646 (opens the issue workspace only when the session
  has at least one counted event or `assetBytes > 0`); microphone-permission wait times out at 120 s, L1680.

### Inherited, not re-read

Recorder lifecycle states, page comments, screenshot markup, microphone-permission page, issue workspace and filing
(including partial upload and uncertain results), timeline/report, and the internals of the Capture, Privacy,
Transcription, Publishing, Summaries and GitHub settings sections.

## Decisions

### What the viewer document no longer contains
Dropped by the reducer: 163 Commands, 222 Conditions, 98 Effects, 9 Artifacts, 13 Entry Bindings, 192
Observation bindings and 192 locators, 166 Message/MessageMeta pairs, 24 OutgoingTransitions, 10 `external-*`
states (navigation targets owned by no journey), the JourneyEntryIndex, the Persona, 187 Surfaces bound to Commands
(the viewer attaches screenshots only to rendered nodes), and 29 transitions that were identical once guards were
gone. Nothing here is lost from source; it is out of scope for this document.

### Self-loops
472 self-loops became 104. A self-loop is kept only for a user action with a visible outcome on the same screen.
Dropped: 82 automatic background events (tab adoption, service-worker recovery, upload capture, ...), 36 reviewed
blocked or error-banner loops (`DROPPED_SELF_LOOP_LABELS` in the reducer), 27 more in curation (blocked "while Stop is
pending", dismiss-banner, toolbar drag). The rest were aggregated by intent ("Choose a drawing tool", "Add a note,
file, screenshot or marker", "Edit capture options", ...). Loops that merely had no side effect (expand/inspect/undo)
were kept: the first plan's "drop if no Effect" rule was wrong for them.

### Settings
- Navigation 144 -> 72 edges. Proofline and Services call their hook inside the component, so every visit reloads and
  navigation enters at *loading*. Every other section keeps its hook in the parent form, so navigation enters at the
  loaded state; the "navigate while still loading" edges were a click race and were dropped.
- Proofline: `Refresh` and `Disconnect` now go through `settings-proofline-saving` (buttons disabled), which was
  previously unreachable; failure lands on `settings-proofline-error`; cancelled, declined and failed approval all end
  in that error banner because `perform()` catches the abort.
- Services: `settings-services-error` is reachable from loading (the alert replaces the form).
- Storage: `settings-storage-saved` deleted (no UI; the capture contract itself notes it renders identically to ready).
  `settings-storage-saving` is kept under its id and now means "Deleting all sessions; button disabled".
- Transcription, Publishing, Summaries, GitHub: the connected variant is reached from loading and swaps live with the
  personal variant on connection changes (+8 edges). Seven unselectable child entries were removed.

### Voice setup
The modal has two outcomes, so the child journey exports two exits (*done*, *cancelled*) instead of thirteen
per-destination exits. One composite per origin class opens the same child journey: Ready without sessions, Ready
with sessions (also used by start error and capture options), recording, paused, page comments, markup and paused
markup. Return is coarse (see gap G01). Three comment-entry points used only by the old returns were removed.

### Labels and touchpoints
52 labels rewritten and 16 settings entry labels normalised to the viewer's text budgets; Surface ids are unchanged.
Four touchpoints replace the single all-journeys one, one per host context the user is in (a Touchpoint says where
the experience is presented, not which screen or file):

| Touchpoint | Host | Journeys |
|---|---|---|
| Recorder side panel | Chrome side panel, docked beside the recorded page | `recorder`, `recorder-voice-setup` |
| Overlays on the recorded page | Content scripts drawing the comment picker and the markup editor over a third-party page | `recorder-page-comments`, `recorder-markup` |
| Full-page extension tabs | Extension pages opened with `chrome.tabs.create`: issue workspace, timeline report, settings | `workspace`, `workspace-filing`, `timeline`, `settings` and its nine section journeys |
| Microphone permission prompt | Chrome's native prompt, hosted by a transient extension tab | `microphone` |

The workspace, report and settings pages are one touchpoint: same host, same way in, and the workspace and report link
to each other. An earlier run split them into three; that split followed entrypoints, not places. The microphone page stays separate because Chrome, not the extension, owns the decisive UI and the user is
sent there from two different hosts. Presentation is in `user-journeys.touchpoints.json`.

## Final counts

| | Before | After |
|---|---|---|
| Nodes | 2,866 | 920 |
| Journeys (viewer roots) | 18 (4) | 18 (4) |
| States / composites | 122 / 17 | 111 / 22 |
| Entries / exits | 60 / 28 | 50 / 17 |
| Transitions (self-loops) | 1,059 (472) | 588 (104) |
| Surfaces | 296 | 108 |
| Touchpoints | 1 | 4 |
| File size | 1.1 MB | 356 KB |

Three States carry no Surface by design (`microphone-closed-granted`, `microphone-closed-ungranted`,
`microphone-timed-out` have no UI of their own).

## States over the soft limit of 12 transitions

- `recorder-comments-editing` (13): comment editing plus dictation, save, discard, close and mic-permission branches.
- `workspace-summary-running` (15) and `workspace-publish-running` (14): a running operation returns to whichever of six
  durable workspace states it started from, and the Editor's Draft cannot say "return to the origin" (gap G01), so each
  outcome has one edge per base state. These are real outcomes, not noise.

## Exclusions

Out of scope by design: runtime traces, recognition contracts, localisation, effects, artifacts, commands, entry bindings
and page-to-page navigation links (OutgoingTransition). Browser-owned UI (the microphone permission prompt and the
delete-all confirmation) appears only as states, not as modelled controls.

## Uncertainties

- Everything under "Inherited, not re-read" is as accurate as the `0c35e4a` audit, no more.
- That cancel and decline both show the error banner is inferred from `perform()` catching the abort, not observed.
- The Proofline error state stands for "a banner above the connected or disconnected content"; the graph gives it every
  action, which is slightly more than either variant offers.
- The loaded-versus-reloaded navigation rule follows from where each hook is called, not from running the page.
- The sharing sections' live swap relies on the `onChanged` listener existing (verified); that each section re-renders from
  it was not.

## Verification

- `pnpm --dir ujg validate` (profile projection is a no-op; structural, reachability, budget and Surface checks): passes with
  the three warnings above.
- `pnpm --dir ujg test` runs the validator and reducer tests (11 cases covering the profile, reachability, exit, duplicate,
  budget, label, Surface and touchpoint rules; the duplicate-state-label rule has no fixture yet). The existing capture
  test (`ujg-screenshot-capture.test.mjs`) passes once the stale Surface entry is removed (17 of 17 tests).
- `JOURNEY_VIEWER_DIR=… pnpm --dir ujg view:check` passes: the viewer's own `checkDocument` reports no findings, 4 roots,
  0 rootless, all 108 Surfaces attach to rendered nodes.
- Official SHACL shapes were not run (not installed, and the published shape files were not located).

## Screenshots

No recapture is required. The graph deleted `State:settings-storage-saved`, and its capture contract, capture scenario step,
map entry, audit receipt, PNG and gallery tile were removed by hand; nothing else was touched. All other Surface ids are
unchanged, so the other 108 screenshots still attach (`capture --check` validates 108 screenshots; the viewer gate reports no
unmapped Surfaces and no stale map entries).

Open mismatch: the `settings-storage-saving` screenshot is taken by clicking **Refresh** and holding it, so it shows the form
disabled during a storage *refresh*; the graph label ("Deleting all sessions; button disabled") and its only incoming edge
(delete-all) describe the delete path. Either relabel the state neutrally ("Storage working; controls disabled") and route
Refresh through it, or recapture it while deleting.
