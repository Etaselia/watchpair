#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 24 or newer, then run this file again."
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then
  echo "WatchPair Companion requires Node.js 24 or newer."
  exit 1
fi

if ! command -v corepack >/dev/null 2>&1; then
  echo "WatchPair Companion requires Corepack, which is included with official Node.js releases."
  exit 1
fi

if [ ! -d node_modules/webtorrent ]; then
  corepack pnpm install --prod --frozen-lockfile
fi

exec node server.mjs
