#!/usr/bin/env bash
# Static checks: type check and lint.
# Usage: ./verify.sh

set -Eeuo pipefail
cd "$(dirname "$0")"

echo ":: typecheck"
npm run typecheck

echo ":: lint"
npm run lint

if [ -d .github/workflows ] && ls .github/workflows/*.yml >/dev/null 2>&1; then
  if command -v act >/dev/null 2>&1; then
    echo "GHA: PARTIAL -- act is installed but workflows are not run here; CI runs them on push"
  else
    echo "GHA: PARTIAL -- act not installed, workflow steps not replayed locally"
  fi
else
  echo "GHA: N/A -- no workflows in .github/workflows"
fi
