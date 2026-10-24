#!/usr/bin/env bash
# Run InstantCognition from source in development mode.
# Usage: ./run.sh [electron args...]

set -Eeuo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo ":: node_modules missing — installing dependencies first"
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

node scripts/build-css.js
node scripts/build-renderer.js
node scripts/fetch-moonshine-model.js
exec npx --no-install electron . "$@"
