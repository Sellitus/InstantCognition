#!/usr/bin/env bash
# Fast unit + integration suite. The Electron and local-LLM smoke tests are
# gated behind RUN_APP_SMOKE / RUN_LLM_SMOKE and stay out of this run.
# Usage: ./test.sh [jest args...]

set -Eeuo pipefail
cd "$(dirname "$0")"

exec npx --no-install jest --watchman=false "$@"
