#!/usr/bin/env bash
set -euo pipefail
task_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_build=${WATCHPAIR_NATIVE_BUILD_DIR:-"$task_source/../outputs/v2/app-linux"}
task_configure=(-S "$task_source" -B "$task_build" -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo)
[[ -z "${WATCHPAIR_QT_PREFIX:-}" ]] || task_configure+=("-DCMAKE_PREFIX_PATH=$WATCHPAIR_QT_PREFIX")
[[ -z "${WATCHPAIR_APP_VERSION:-}" ]] || task_configure+=("-DWATCHPAIR_APP_VERSION=$WATCHPAIR_APP_VERSION")
[[ -z "${WATCHPAIR_UPDATE_PUBLIC_KEY:-}" ]] || task_configure+=("-DWATCHPAIR_UPDATE_PUBLIC_KEY=$WATCHPAIR_UPDATE_PUBLIC_KEY")
cmake "${task_configure[@]}"
cmake --build "$task_build" --parallel "${WATCHPAIR_BUILD_JOBS:-4}"
if [[ "${1:-}" == "--test" || "${1:-}" == "--desktop-tests" ]]; then
  npm run build --prefix "$task_source/coordinator"
  ctest --test-dir "$task_build" --output-on-failure -LE render
fi
if [[ "${1:-}" == "--desktop-tests" ]]; then
  [[ -f "${WATCHPAIR_MEDIA_FIXTURES:-}/tracks.mkv" ]] || { printf '%s\n' 'Set WATCHPAIR_MEDIA_FIXTURES to generated fixtures; see generate-media-fixtures.py.' >&2; exit 1; }
  export WATCHPAIR_MEDIA_OUTPUT=${WATCHPAIR_MEDIA_OUTPUT:-"$task_build/media-validation"}
  ctest --test-dir "$task_build" --output-on-failure -L render
fi
printf '%s\n' "$task_build/desktop/watchpair"
