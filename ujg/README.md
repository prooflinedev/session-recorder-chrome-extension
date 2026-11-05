# Session Recorder User Journey Graph

This directory is a self-contained User Journey Graph (UJG) bundle for the extension, built to be read by the
[Journey Viewer](https://github.com/openuji/journey-viewer) with a screenshot on each screen. A manually deployed
[rendering of this bundle](https://session-recorder-journey-viewer.netlify.app/) is available for review. The document
contains **only what the viewer renders**: journeys, states, composites, transitions, state Surfaces and touchpoints.
The audited revision and every modelling decision are in [`generated/source-audit.md`](generated/source-audit.md);
what the portable vocabulary cannot express is in
[`generated/user-journeys-spec-gaps.md`](generated/user-journeys-spec-gaps.md). The standing rules for anyone (or any
agent) editing the bundle are in [`AGENTS.md`](AGENTS.md).

## Contents

- `generated/user-journeys.ujg.jsonld` - the document (Editor's Draft Core + Graph + Surface).
- `generated/user-journeys.touchpoints.json` - touchpoint short labels and colours for the viewer filter.
- `generated/source-audit.md`, `generated/user-journeys-spec-gaps.md` - audit record and residual gaps.
- `generated/screenshots/`, `generated/user-journeys.screenshots.json`, `generated/user-journeys.screenshots.audit.json` -
  one light-theme PNG per state Surface, its exact map, and capture receipts.
- `generated/journey-viewer/index.html` - self-contained Journey Viewer build used for the manual deployment above.
- `generated/review/index.html` - local visual-review gallery of the canonical PNGs.
- `AGENTS.md` / `CLAUDE.md` - the rules both Codex and Claude Code read (`CLAUDE.md` imports `AGENTS.md`).
- `prompts/recalculate-model.md` - the agent-neutral regeneration task.
- `scripts/` - the profile reducer, validator, viewer gate, agent runner, capture runner, contracts and tests.

## Commands

```sh
pnpm --dir ujg install --frozen-lockfile        # isolated dependencies (capture/tests only)

# The viewer commands need a built journey-viewer checkout (pnpm build inside it):
export JOURNEY_VIEWER_DIR=/path/to/journey-viewer

pnpm --dir ujg view          # open the document in the real Journey Viewer, with screenshots and touchpoints
pnpm --dir ujg view:check    # the viewer's own document policy + `journey-viewer generate`, no browser
pnpm --dir ujg validate      # profile projection is a no-op, then structure, reachability, budgets, Surfaces
pnpm --dir ujg test          # validator, reducer and capture-contract tests
pnpm --dir ujg profile       # project a richer document onto the viewer profile (rewrites in place)
pnpm --dir ujg verify        # validate + test + view:check + check

pnpm --dir ujg generate:model:codex    # regenerate with Codex, then run the gates
pnpm --dir ujg generate:model:claude   # regenerate with Claude Code, then run the gates
AGENT=claude pnpm --dir ujg generate:model          # same, selected by environment (default: codex)
node ujg/scripts/ujg-generate.mjs claude --dry-run  # print the exact command without running it

pnpm --dir ujg capture       # build the extension, recapture every Surface, refresh receipts and gallery
pnpm --dir ujg check         # validate the committed map, PNGs, evidence bounds and hashes
```

The gates are complementary. `validate` enforces the profile (the viewer itself accepts extra node types and
long transition lists, so `view:check` alone would pass them); `view:check` proves the real viewer opens the
document, its screenshot map and its touchpoints. Run both.

`generate:model:*` is a bounded agent workflow, not a deterministic compiler. Both agents get the same
`AGENTS.md` and the same task; the run passes only if the same gates pass (profile, validation, tests, the viewer's own
check). Review the diff, then run `capture` whenever the Surface set or visible evidence changes. Codex needs an
authenticated CLI; Claude Code runs headless (`claude -p`) with edits and the bundle's tooling allowed and commits,
pushes and branch changes denied.

`capture` uses the production extension build and deterministic fictional data. Most captures run in headless
Chromium; native browser-dialog evidence uses the included macOS helper and therefore requires macOS with Chromium
available. No live provider credentials or network services are used.

## Coverage invariant

The capture registry derives its required set from every `Surface` bound to a `State` or `CompositeState`. Validation
fails when a contract, map entry, audit receipt or PNG is missing or extra. The graph's Surface ids
(`Surface:state-<state slug>`) are the join key between the document, the screenshot map and the capture contracts.
