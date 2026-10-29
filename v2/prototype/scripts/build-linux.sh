#!/usr/bin/env bash
set -euo pipefail
task_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_build=${WATCHPAIR_NATIVE_BUILD_DIR:-"${XDG_CACHE_HOME:-$HOME/.cache}/watchpair-v2-prototype/build"}
cmake -S "$task_source" -B "$task_build" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build "$task_build" --parallel "${WATCHPAIR_BUILD_JOBS:-4}"
if [[ "${1:-}" == "--test" ]]; then
  ctest --test-dir "$task_build" --output-on-failure
fi
printf '%s\n' "$task_build/watchpair-v2-prototype"
