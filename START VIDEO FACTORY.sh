#!/usr/bin/env bash
# ===================================================================
#  BuildTrack Video Factory - one-step launcher for macOS and Linux
#
#  Double-click (or run: ./START VIDEO FACTORY.sh). Installs on first
#  run, prepares the local renderer, checks the environment, then
#  starts the app and opens it in the default browser.
# ===================================================================
set -euo pipefail
cd "$(dirname "$0")"

echo
echo " =========================================================="
echo "  BuildTrack Video Factory"
echo " =========================================================="
echo

command -v node >/dev/null 2>&1 || {
  echo " [X] Node.js is not installed."
  echo
  echo "     Install the LTS build from https://nodejs.org/ then run this again."
  echo
  exit 1
}
echo " [ok] Node.js $(node -v)"

if [ ! -d node_modules ]; then
  echo
  echo " [..] First run: installing dependencies. This takes a few minutes."
  npm install
else
  echo " [ok] Dependencies already installed"
fi

if [ ! -x .browser/chrome ]; then
  echo
  echo " [..] First run: preparing the local video renderer."
  npm run provision
else
  echo " [ok] Video renderer already prepared"
fi

# `npm run build` compiles the core library *and* the interface. The API imports
# @buildtrack/core from its dist, so skipping the core build makes the server
# fail to start with ERR_MODULE_NOT_FOUND.
if [ ! -f packages/core/dist/index.js ] || [ ! -f apps/web/dist/index.html ]; then
  echo
  echo " [..] Building the core library and the interface."
  npm run build
fi

echo
echo " Checking the environment..."
npm run doctor
echo

echo " =========================================================="
echo "  Starting. Open http://localhost:3000 in your browser."
echo "  Press Ctrl+C to stop."
echo " =========================================================="
echo

# open the browser once the API is actually listening
( for _ in $(seq 1 60); do
    if curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; then
      (xdg-open http://localhost:3000 >/dev/null 2>&1 || open http://localhost:3000 >/dev/null 2>&1) || true
      break
    fi
    sleep 1
  done ) &

exec npm start
