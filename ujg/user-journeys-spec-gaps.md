# Specification gaps encountered in the extension journeys

The [canonical journey document](user-journeys.ujg.jsonld) uses the current
[UJG Editor’s Draft](https://ujg.specs.openuji.org/ed) vocabulary. Its Conditions
are human-readable eligibility declarations, its Effects declare side effects,
and its Observability bindings describe accessible recognition. These do not
constitute an executable application state machine. The following entries
describe only the remaining information that the standard representation does
not preserve interoperably; proposed additions are not used in the document.

## G01 — Recognition contracts cannot be conditioned on journey state

**Concrete example and evidence.** The issue workspace disables report detail
after any publication checkpoint, locks repository editing after an uncertain
attempt, and replaces File issue with View issue after filing. A second workspace
can still display editable controls after another tab changes the durable draft.
See [the control conditions](../entrypoints/share/App.tsx#L122) and
[the local-edit and submission handlers](../entrypoints/share/useShareReport.ts#L138).

**Affected IDs.** `urn:proofline:session-recorder:Command:report-level`,
`urn:proofline:session-recorder:Command:edit-repository`,
`urn:proofline:session-recorder:Surface:command-report-level-disabled-true`, and
`urn:proofline:session-recorder:State:workspace-published`.

**Existing representation.** Separate observable workspace states and guarded
local transitions preserve the action/outcome differences. Accessible locators
describe the actual disabled, pressed, checked, and expanded variants. The
[Observability module](https://ujg.specs.openuji.org/ed/modules/observability)
can express exact match counts, including absence, and accessibility context;
it does not attach a binding to a source Graph state or select a binding by a
Condition. Alternative binding variants must not be interpreted as simultaneous
assertions that every variant is present.

**Information lost.** There is no portable assertion that one particular binding
is required only while a particular journey state and contextual eligibility
hold. Accessible hiding and visual hiding are also different facts. Recognition
must not be mistaken for submission eligibility or authorization.

**Smallest suggested addition.** Optional applicability references from an
ObservationBinding to Graph states and, where needed, a Condition, with explicit
conditional cardinality semantics. This should select recognition contracts,
without changing Graph traversal or evaluating business authorization.

## G02 — Input modalities do not describe exact invocation gestures

**Concrete example and evidence.** Alt+Shift+A is the suggested **markup**
shortcut, Alt+Shift+M adds a marker, and markup Enter/Escape/history shortcuts
are not intercepted while a Fabric text object is editing. A page comment saves
on Enter only without Shift or IME composition; its pointer selection can be an
element or a dragged region. See [manifest shortcuts](../wxt.config.ts#L42),
[markup keyboard handling](../entrypoints/annotations.content.ts#L395), and
[comment keyboard handling](../lib/annotations/point-overlay.ts#L165).

**Affected IDs.** `urn:proofline:session-recorder:Command:markup-shortcut`,
`urn:proofline:session-recorder:Command:marker`,
`urn:proofline:session-recorder:Command:save-comment`, and
`urn:proofline:session-recorder:InputModalityProfile:keyboard`.

**Existing representation.** Commands retain semantic invocation identities and
human-readable input requirements. ObservationEvents reference the standard
keyboard/pointer modality profiles; Conditions declare contextual eligibility.
The [Condition module](https://ujg.specs.openuji.org/ed/modules/condition)
deliberately supplies no predicate language. The
[Data Contract module](https://ujg.specs.openuji.org/ed/modules/data-contract)
already supports external JSON Schemas for visible Surface data; ordinary value
constraints are not claimed to be a missing UJG capability here.

**Information lost.** A modality profile alone does not specify a key chord,
suggested versus actual browser assignment, modifier/IME handling, focus target,
or ordered pointer gesture. Labels are prose, not a private runner protocol.

**Smallest suggested addition.** An optional invocation-pattern contract for
Command surfaces, covering key/modifier patterns, focus/composition constraints,
and ordered pointer gestures, while keeping browser assignment and execution
outside Graph.

## G03 — Browser presentation and independent-journey handoff context are external to Graph

**Concrete example and evidence.** Stop opens a new issue-workspace tab only if
the session counts object has at least one key or asset bytes exceed zero. Mic
permission opens a new tab, retains the originating action, handles tab closure,
and times out after 120 seconds. Proofline authorization opens a browser
approval tab and later continues account configuration. See
[stop](../entrypoints/background.ts#L646),
[permission waiting](../entrypoints/background.ts#L1666), and
[account approval](../entrypoints/sidepanel/components/useProoflineSettings.ts#L106).

**Affected IDs.** `urn:proofline:session-recorder:State:recorder-stopping`,
`urn:proofline:session-recorder:JourneyEntry:workspace-open`,
`urn:proofline:session-recorder:CompositeState:recorder-microphone-permission`,
`urn:proofline:session-recorder:CompositeState:recorder-comment-microphone-permission`,
`urn:proofline:session-recorder:JourneyEntry:microphone-open`,
`urn:proofline:session-recorder:JourneyExit:microphone-granted`,
`urn:proofline:session-recorder:JourneyExit:microphone-denied`,
`urn:proofline:session-recorder:JourneyExit:microphone-timeout`, and
`urn:proofline:session-recorder:State:settings-proofline-connecting`.

**Existing representation.** The microphone permission page is a reusable child
Journey. Parent transitions enter the recording or comment-dictation
CompositeState with `toEntryRef`; the child exports granted, denied, and timed-out
outcomes; and parent-local transitions use `fromExitRef` to continue in the
originating workflow. Actual user navigation uses OutgoingTransition, while
Effects declare the browser-page handoff and EntryBindings provide opaque
entry-selection values. The recorder-to-workspace and Proofline-approval flows
remain independent-journey handoffs. The
[Graph](https://ujg.specs.openuji.org/ed/graph),
[Effect](https://ujg.specs.openuji.org/ed/modules/effect), and
[Entry Binding](https://ujg.specs.openuji.org/ed/modules/entry-binding) modules
do not schedule those browser or independent-journey actions. No synthetic root
journey or cross-journey local edge is introduced.

**Information lost.** Graph represents the permission topology and parent
continuation, but it does not execute an exact 120-second timer, open or close a
browser tab, retain an invocation token, or correlate a leftover permission page
after the parent has continued. It also does not automatically open the
independent issue-workspace or Proofline approval journey with retained context,
nor represent same-tab versus new-tab presentation or best-effort browser
navigation failure. Human-readable Conditions describe these constraints without
becoming an execution language.

**Smallest suggested addition.** A materialization-level handoff contract
associating a declared Effect with a destination JourneyEntry, retained invocation
context, browser presentation mode, and timeout/closure outcomes. It should not
reinterpret an ordinary navigation affordance as an instruction to execute.

## G04 — Declared effects do not define durable checkpoint and concurrency semantics

**Concrete example and evidence.** Filing serializes edits/submission under a
draft lock, reloads saved metadata, and checkpoints before external side effects.
An uncertain attempt keeps its identity and repository; partial Proofline uploads
resume from their durable checkpoint through the visible Resume upload action
and when filing continues. During worker recovery, displayed media flags reset even though an
offscreen recorder may survive. See
[draft locking](../entrypoints/share/useShareReport.ts#L138),
[filing checkpoints](../lib/sharing/file-issue.ts#L35),
[deployment checks](../entrypoints/share/useShareReport.ts#L263),
[managed upload checkpoints](../lib/proofline/reports.ts#L43), and
[rehydration](../entrypoints/background.ts#L1952).

**Affected IDs.** `urn:proofline:session-recorder:State:workspace-managed-partial`,
`urn:proofline:session-recorder:Transition:workspace-resume-managed-upload`,
`urn:proofline:session-recorder:State:workspace-uncertain`, and
`urn:proofline:session-recorder:Transition:workspace-stale-already-filed-draft`.

**Existing representation.** Observable publication/attempt states remain
distinct, including filed/uncertain states whose publication was removed.
Conditions distinguish current visible metadata from newer stored metadata.
Effects declare persistence, submission, cancellation, and deletion; Artifacts
identify portable outputs. The
[Effect](https://ujg.specs.openuji.org/ed/modules/effect) and
[Artifact](https://ujg.specs.openuji.org/ed/modules/artifact) modules deliberately
do not define transaction or resource lifecycle semantics. Shared Command identity
does not supply deduplication or idempotency.

**Information lost.** The portable graph does not encode the draft-lock scope,
checkpoint durability/order, per-attempt idempotency, abort observation point,
cross-tab visibility delay, or reconciliation of surviving media capture. These
are contextual guard/effect prose, not machine-verifiable guarantees. Generic
Graph reachability without understanding Conditions overapproximates paths.

**Smallest suggested addition.** Optional execution-context and effect-checkpoint
contracts for identity, durability, ordering, cancellation, and reconciliation.
They should keep local visible state separate from durable shared state and
should not assume a global domain model or immediate cross-tab synchronization.

## G05 — Accessible recognition does not supply geometry or dynamic instance keys

**Concrete example and evidence.** The markup canvas is drawn with Fabric rather
than exposing each shape as an accessible control. The page picker resolves
pointer geometry and connected elements; saved pins and session/repository rows
have data-dependent names, without an explicitly exposed stable identity feature.
See [canvas gestures](../entrypoints/annotations.content.ts#L420),
[page selection](../lib/annotations/point-overlay.ts#L78), and
[session rows](../entrypoints/sidepanel/components/SessionList.tsx#L29).

**Affected IDs.** `urn:proofline:session-recorder:Command:markup-draw`,
`urn:proofline:session-recorder:Command:select-comment-region`,
`urn:proofline:session-recorder:Command:inspect-comment-pin`, and
`urn:proofline:session-recorder:Command:open-session`.

**Existing representation.** Commands and Surfaces identify the actual
interaction boundaries; locators use source-supported accessible roles/names
where available and avoid unsupported exact cardinalities. Localization supplies
copy identities, not a dynamic-name matching language. SurfaceInstanceResolver
could derive keys from an exposed accessible feature, but a React key or hidden
session ID is not such a feature. Observability's CustomLocator escape hatch
would require the private extensions explicitly excluded from this deliverable.

**Information lost.** There is no portable accessible-object description of canvas
shapes, region hit testing, dynamic string matching, or a stable instance key
that the implementation does not expose. No fictional keyboard strategy, selector,
AX feature, or exact-one match is asserted to conceal that loss.

**Smallest suggested addition.** A standard geometry/region recognition contract
and an explicitly defined dynamic-name/instance-key contract for applicable
observation adapters. Where the application exposes no stable identity, its
absence must remain an implementation limitation rather than be fabricated by
the model.
