#!/usr/bin/env bash
# ===========================================================================
#  GrayCode Desktop - quick launcher (macOS / Linux)
#  Run `./start.sh` to start the app. Dependencies are installed and the
#  frontend/main process are built only when needed, so subsequent launches
#  are fast.
#
#  Usage:  ./start.sh [--rebuild]
#          --rebuild  force a full rebuild (frontend + patch + main process)
# ===========================================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/.bin ]; then
  echo "[GrayCode] Dependencies not found. Installing..."
  npm install
fi

needs_build=0
if [ "${1:-}" = "--rebuild" ]; then needs_build=1; fi
if [ ! -f dist/main.js ]; then needs_build=1; fi
if [ ! -f ../frontend/dist/index.html ]; then needs_build=1; fi

if [ "$needs_build" = "1" ]; then
  echo "[GrayCode] Building frontend + main process (first launch or sources changed)..."
  npm run build:all
fi

echo "[GrayCode] Starting GrayCode Desktop..."
exec node_modules/.bin/electron .
