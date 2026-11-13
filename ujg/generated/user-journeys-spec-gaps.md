# Specification gaps in the viewer-profile journeys

The [journey document](user-journeys.ujg.jsonld) uses only the Editor's Draft Core, Graph and Surface vocabulary.
This file lists what that vocabulary cannot express for the extension's topology, with the smallest honest
approximation used. Effects, conditions, observability, localisation and navigation links are outside the profile by
design (the viewer renders none of them) and are not gaps.

## G01 - An operation cannot return to the state it started from

**Example and evidence.** The voice-setup modal opens from the Ready view, recording, paused, page comments, markup and
paused markup, and closing it leaves the user exactly where they were
([`VoiceSetupModal.tsx`](../../entrypoints/sidepanel/components/VoiceSetupModal.tsx),
[`CaptureBar.tsx`](../../entrypoints/sidepanel/components/CaptureBar.tsx#L53)). The issue workspace's summary and publish
operations likewise settle back into whichever of six durable states they began in
([`useShareReport.ts`](../../entrypoints/share/useShareReport.ts)).

**Affected ids.** `CompositeState:recorder-voice-setup-idle-empty`, `-idle`, `-live`, `-paused`, `-comments`, `-markup`,
`-markup-paused`; `JourneyExit:recorder-voice-done`, `JourneyExit:recorder-voice-cancelled`;
`State:workspace-summary-running`, `State:workspace-publish-running`.

**Existing representation.** A child journey exports outcome exits and the parent continues from them. A child cannot know its
caller, so one composite per origin class opens the shared child journey and continues to that class's entry. For the
workspace, each operation has one outgoing edge per possible starting state.

**Information lost.** Return is exact only to the origin class's entry. Sub-state restoration (for example the comment
composer's position after voice setup) is lost, and the Ready view's start-error and capture-options variants return to the
Ready view. The workspace edges are correct but repeat the same label to six destinations.

**Smallest suggested addition.** An optional "return to the entering state" continuation on a parent transition out of a
composite, meaning the child outcome resumes the vertex from which the composite was entered, so one exit pair and one
continuation per composite replace the per-origin fan-out. It must not imply history inside the child.

## G02 - Hand-offs between independent journeys are not edges

**Example and evidence.** Stop opens the issue workspace in a new tab only when the session has at least one counted event or
`assetBytes > 0` ([`background.ts`](../../entrypoints/background.ts#L646)). Microphone permission opens a tab, times out after 120
seconds ([`background.ts`](../../entrypoints/background.ts#L1680)), and the Proofline approval opens a browser tab and later
continues in settings ([`useProoflineSettings.ts`](../../entrypoints/sidepanel/components/useProoflineSettings.ts#L108)).

**Affected ids.** `State:recorder-stopping`, `CompositeState:recorder-microphone-permission`,
`CompositeState:recorder-comment-microphone-permission`, `State:settings-proofline-connecting`, the root journeys
`recorder`, `workspace` and `settings`.

**Existing representation.** The microphone page is a reusable child journey with granted, denied and timeout exits, so its
parent continuations are modelled. The recorder-to-workspace and Proofline approval hand-offs are not: the viewer document
contains no edge between the independent root journeys, and no synthetic root journey connects them.

**Information lost.** That Stop leads to a workspace session, under which condition, in a new tab, carrying the session
identity; and the approval round trip through another browser tab.

**Smallest suggested addition.** A destination-journey-entry reference on a transition out of a state, with the retained
context and presentation mode kept as metadata, not as traversal.
