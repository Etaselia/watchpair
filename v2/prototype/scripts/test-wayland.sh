#!/usr/bin/env bash
set -euo pipefail
task_binary=$(realpath -- "${1:?Pass the prototype executable}")
task_fixture=$(realpath -- "${2:?Pass a retained container fixture directory}")
task_output=$(realpath -m -- "${3:?Pass an output directory}")
mkdir -p -- "$task_output"
task_runtime=$(mktemp -d /tmp/watchpair-v2-wayland.XXXXXX)
mkdir -- "$task_runtime/runtime"
chmod 700 -- "$task_runtime/runtime"
export XDG_RUNTIME_DIR="$task_runtime/runtime"
export WAYLAND_DISPLAY=watchpair-test
export QT_QPA_PLATFORM=wayland
export LIBGL_ALWAYS_SOFTWARE=1
weston --backend=headless --renderer=gl --no-config --socket="$WAYLAND_DISPLAY" \
  --width=1440 --height=1000 --idle-time=0 --log="$task_output/weston.log" >/dev/null 2>&1 &
task_weston=$!
trap 'kill "$task_weston" 2>/dev/null || true; wait "$task_weston" 2>/dev/null || true' EXIT
for task_attempt in {1..50}; do
  if [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]]; then break; fi
  if ! kill -0 "$task_weston" 2>/dev/null; then cat "$task_output/weston.log"; exit 1; fi
  sleep 0.1
done
"$task_binary" --profile "$task_runtime/profile" --torrent "$task_fixture/fixture.torrent" \
  --test-seed-directory "$task_fixture/seed" --test-timeout 30000 \
  --test-screenshot "$task_output/window.png" --test-report "$task_output/result.json"
cat "$task_output/result.json"
