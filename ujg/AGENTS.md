# UJG bundle: standing rules

These rules apply to every agent that edits `ujg/`. The task itself is in
[`prompts/recalculate-model.md`](prompts/recalculate-model.md). Acceptance is decided by the gates
below, not by which agent ran or by what it reports.

## What the document is for

`generated/user-journeys.ujg.jsonld` is read by the Journey Viewer (`pnpm --dir ujg view`) to show the
extension's topology with a screenshot on each screen. It contains **only what the viewer renders**:
journeys, states, composites, transitions, state Surfaces and touchpoints. Nothing else belongs in it.

## Profile (enforced by `scripts/ujg-composition-validate.mjs`)

- `@context`: the Editor's Draft Core, Graph and Surface contexts only.
- Node types: `Journey`, `JourneyEntry`, `JourneyExit`, `State`, `CompositeState`, `Transition`, `Surface`, `Touchpoint`.
- Properties: `@id @type label entryRefs stateRefs transitionRefs exitRefs defaultEntryRef stateRef subjourneyRefs from to toEntryRef fromExitRef graphNodeRef journeyRefs channel`.
- Do **not** model: Commands, Conditions, Effects, Artifacts, Entry Bindings, OutgoingTransitions or external
  destination states, JourneyEntryIndex, Personas, Observability, Localization, Runtime, Mapping, Metrics.
  Never widen the profile to make a graph pass; narrow the graph instead.
- Identifiers are `urn:proofline:session-recorder:<Type>:<slug>`. Keep a URN only while its meaning is unchanged.

## Topology rules

- A State is a stable, visibly distinct screen. Merge states only when actions, destinations and outcomes are equal.
- Every State is reachable from an entry of its own journey. Every child entry is selected (default entry or a
  parent's `toEntryRef`). Every `JourneyExit` is reached inside the child and continued by a parent `fromExitRef`.
- A parent never lists a child's states. A composite is used only for a real nested flow; a child journey exports
  outcomes (`done`, `cancelled`, `granted`...), not the parent's destinations.
- Self-loops are allowed only for a **user action whose outcome is visible on the same screen**, labelled by intent.
  Not allowed: background or lifecycle events, blocked/no-op invocations, transient error banners, and per-control
  repeats of one intent (aggregate them: "Choose a drawing tool", not eight tool loops).
- One transition per (from, to, entry, exit, label). The same label to different destinations is fine: the viewer
  groups a state's transitions by destination.
- At most 16 transitions leave one state (soft limit 12). Where a state genuinely exceeds 12, say why in the audit.
- A State has at most one Surface, named `Surface:state-<state slug>`. Composites and Commands get none. That
  Surface id is the join key to the screenshot map and the capture contracts; never rename it casually.
- Label budgets (viewer layout): State <= 60, Composite/Journey/Entry/Exit/Touchpoint <= 40, Transition <= 60
  characters. Labels are the viewer's visible text: say what is on screen or what the user does.
- Every Journey is named by at least one Touchpoint (the viewer inherits nothing). Name a shared child journey by the
  host where it is presented, not by where its parents are.
- A Touchpoint says **where** the experience is presented, not which screen, route or file: the host context the user
  is in (a docked panel, an overlay drawn on another party's page, a full tab of the product, a browser- or
  OS-owned prompt, another system's site or app). Derive the set from the source audit; never copy a list from this
  file or from a previous run. Screens that share a host and are reached the same way are one Touchpoint, however
  many entrypoints they have. Split only when the host differs, or when another system rather than the product owns
  the decisive UI. Do not split by purpose or to balance the viewer's filter.
- Each Touchpoint has a label and a `channel` that names its host. The audit records every Touchpoint, the host it
  stands for and what was merged into it. `generated/user-journeys.touchpoints.json` (viewer short label and colour)
  has exactly one entry per Touchpoint in the document: update it when a Touchpoint is added, merged or removed.

## Composition map (current)

- `recorder` (root): ready/recording/paused/stopping states; composites `page-comments`, `markup-recording`,
  `markup-paused`, seven `voice-setup-*` origin classes (all open the child `recorder-voice-setup`), and two
  microphone-permission composites (child `microphone`).
- `workspace` (root): composite `workspace-filing` (child journey). `timeline` (root): flat.
- `settings` (root): nine composites, one per section, each with its own child journey. Proofline and Services
  reload on every visit (their hook is inside the component); the other sections keep their hook in the parent form,
  so navigation lands on their loaded state.
- Return-to-origin: the Editor's Draft has no history construct. A modal that can interrupt many states returns
  coarsely, through one composite per origin class. Record any such loss in `generated/user-journeys-spec-gaps.md`.

## Gates (identical for every agent)

```sh
pnpm --dir ujg validate     # profile projection is a no-op, then structural + budget validation
pnpm --dir ujg test         # validator and reducer regression tests
JOURNEY_VIEWER_DIR=<built journey-viewer checkout> pnpm --dir ujg view:check   # the viewer's own policy
```

`ujg-viewer-profile.mjs` is idempotent. If the graph drifts out of profile, run it; do not hand-edit around it.
`pnpm --dir ujg check` and `capture` concern screenshots and are separate (see below).

## Safety

- Read this file and the repository's own `AGENTS.md` before changing anything.
- Run `git status` first and preserve unrelated changes. Record `HEAD` and whether application source is dirty;
  do not claim a commit describes dirty source.
- Edit only under `ujg/`. Never change application source, repository-root manifests or docs.
- Never commit, push, create branches or open pull requests.
- Do not edit screenshots, `user-journeys.screenshots*.json`, `generated/review/` or run `capture` unless asked.
  If the graph's Surface set changes, report that recapture and a contract update are required.
- Source is the authority. Audit application source and tests independently; use the existing graph and
  screenshots only as evidence. State what you verified in source and what you inferred.

## Handoff report (same shape from every agent)

Profile used and gate results; audited `HEAD` and dirty-source statement; counts (journeys, states, composites,
transitions, Surfaces, touchpoints); states over the soft limit with reasons; decisions and exclusions;
uncertainties; files changed; whether recapture is required.
