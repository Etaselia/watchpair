#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22.13 or newer, then run this file again."
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then
  echo "WatchPair Companion requires Node.js 22.13 or newer."
  exit 1
fi

if [ ! -d node_modules/webtorrent ]; then
  npm install --omit=dev
fi

exec node server.mjs
