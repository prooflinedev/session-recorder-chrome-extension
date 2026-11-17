#!/usr/bin/env bash
set -euo pipefail

# The required GitHub Actions check already runs pnpm test. Include browser
# verification there, while keeping ordinary local unit runs lightweight.
if [[ -z "${CI:-}" ]]; then
  exit 0
fi

pnpm compile:e2e
pnpm build
pnpm exec playwright install --with-deps chromium

if [[ "$(uname -s)" == "Linux" ]]; then
  # A real Chromium with a display exercises MV3 extension and capture APIs.
  HEADED=1 xvfb-run -a pnpm exec playwright test
else
  pnpm exec playwright test
fi
