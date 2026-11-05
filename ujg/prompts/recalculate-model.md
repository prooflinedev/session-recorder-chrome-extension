# Recalculate the Session Recorder UJG model

Work from the `ujg/` directory. Regenerate the source-derived User Journey Graph and its two reports from the
current application source and tests. The standing rules (profile, topology rules, label budgets, composition
map, safety, gates, handoff report) are in `AGENTS.md`; follow them exactly. Do not treat the existing graph as
authoritative: it and the screenshots are evidence only.

## Reference material

The Editor's Draft is at https://ujg.specs.openuji.org/ed (it moves; do not mix it with a dated snapshot). If your
agent has the UJG skills (`ujg-ed-modeling`, `ujg-ed-core-modeling`, `ujg-ed-graph-modeling`), load them: Codex
with `$name`, Claude Code with the Skill tool. Otherwise read the Graph and Surface modules from the spec. The
skills are an aid, not a requirement; the gates decide whether the result conforms.

## Steps

1. **Preflight (read-only).** Read `AGENTS.md` here and at the repository root. Run `git status`; record `HEAD` and
   whether relevant application source is dirty. Read `README.md`, `scripts/ujg-composition-validate.mjs`,
   `scripts/ujg-viewer-profile.mjs`, `scripts/ujg-screenshot-contracts.mjs` and the files under `generated/`.
2. **Audit source and tests independently.** Inventory the screens a user can actually reach and what each user
   action does: side panel (recorder, voice setup, live timeline), page overlays (comments, markup), the
   microphone-permission tab, the issue workspace and filing, the timeline report, and the settings page with its
   nine sections. Follow handlers into background orchestration and service branches. Cover connected and
   disconnected Proofline behaviour, partial-upload resume, repository fallback, cancellation, deletion and
   uncertain results. A test that dispatches a message does not prove a user can reach it. For each screen note the
   host context it renders in and how the user gets there; the touchpoints are derived from that, not from a list.
3. **Regenerate** `generated/user-journeys.ujg.jsonld`, `generated/source-audit.md`,
   `generated/user-journeys-spec-gaps.md` and the touchpoint presentation `generated/user-journeys.touchpoints.json`.
   - Re-derive journeys, entries, states, composites, transitions, exits, state Surfaces and touchpoints. Keep a URN
     only if its meaning is unchanged; remove obsolete nodes and repair every reference.
   - Where an operation returns to whichever state it started from and the Editor's Draft cannot say so, model
     the smallest honest approximation and list it in the gaps report.
   - The audit states: audited revision, dirty-source limits, source and test areas reviewed, topology decisions,
     exclusions, uncertainties, final counts, and the states over the soft transition limit with reasons. Links from
     Markdown in `generated/` to application source start with `../../`.
   - The gaps report lists only semantics the portable Graph/Surface vocabulary cannot express. A gap never excuses
     modelling something it can express.
4. **Run the gates** listed in `AGENTS.md`. Fix the graph, not the validator, until they pass. If
   `JOURNEY_VIEWER_DIR` is unset, say so and report the viewer gate as not run.
5. **Check the diff.** `git diff --check`; confirm every change is under `ujg/`.
6. **Report** in the handoff shape from `AGENTS.md`, including whether `pnpm --dir ujg capture` is required.

Do not commit, push, open a pull request or change branches.
