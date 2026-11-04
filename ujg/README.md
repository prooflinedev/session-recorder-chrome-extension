# Session Recorder User Journey Graph

This directory is a self-contained User Journey Graph (UJG) evidence bundle for
the extension at source commit `0c35e4a`. It intentionally leaves the repository
root manifests, scripts, and documentation structure unchanged.

The graph was recalculated from the application source and tests. The previous
graph and captures were treated as audit evidence, not as authoritative topology.
See [source-audit.md](source-audit.md) for the decisions made during that audit
and [user-journeys-spec-gaps.md](user-journeys-spec-gaps.md) for information the
portable Editor's Draft vocabulary cannot preserve exactly.

## Contents

- `user-journeys.ujg.jsonld` — Editor's Draft UJG document.
- `generated/screenshots/` — one light-theme PNG for every material state-bound
  Surface.
- `generated/user-journeys.screenshots.json` — exact Surface-to-PNG coverage map.
- `generated/user-journeys.screenshots.audit.json` — capture setup, evidence
  bounds, dimensions, and SHA-256 receipts.
- `generated/review/index.html` — local visual-review gallery that uses the
  canonical PNGs.
- `scripts/` — structural validation, contracts, capture runner, tests, and
  regression fixtures.
- `package.json` and `pnpm-lock.yaml` — isolated capture/validation dependencies.

## Commands

Install only the bundle dependencies:

```sh
pnpm --dir ujg install --frozen-lockfile
```

Then run any command from the repository root:

```sh
pnpm --dir ujg capture   # build the extension, recapture every Surface, and refresh receipts/gallery
pnpm --dir ujg check     # validate the committed map, PNGs, evidence bounds, and hashes
pnpm --dir ujg test      # run capture-regression and exact-contract tests
pnpm --dir ujg validate  # validate UJG vocabulary, references, ownership, and boundaries
pnpm --dir ujg verify    # validate + test + check
```

`capture` uses the production extension build and deterministic fictional data.
Most captures run in headless Chromium. Native browser-dialog evidence uses the
included macOS helper and therefore requires macOS with Chromium available.
No live provider credentials or network services are used.

All committed capture outputs are regenerated atomically under `generated/`.
The source model, audit notes, scripts, fixtures, and isolated dependency
manifest remain directly under `ujg/`.

## Coverage invariant

The capture registry derives its required set from all `Surface` nodes whose
`graphNodeRef` targets a `State` or `CompositeState`. Validation fails when a
contract, map entry, audit receipt, or PNG is missing or extra. The current
recalculation contains 109 such material Surfaces; that number is reported, not
hard-coded as the source of truth.
