#!/usr/bin/env bash
set -euo pipefail
task_binary=$(realpath -- "${1:?Pass ui-flow-tests}")
task_output=$(realpath -m -- "${2:?Pass an output directory}")
mkdir -p -- "$task_output"
task_runtime=$(mktemp -d /tmp/watchpair-desktop-wayland.XXXXXX)
mkdir -- "$task_runtime/runtime"
chmod 700 -- "$task_runtime/runtime"
export XDG_RUNTIME_DIR="$task_runtime/runtime"
export WAYLAND_DISPLAY=watchpair-ui-test QT_QPA_PLATFORM=wayland
export LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=softpipe
export WATCHPAIR_UI_OUTPUT="$task_output"
weston --backend=headless --renderer=gl --no-config --socket="$WAYLAND_DISPLAY" \
  --width=1480 --height=1000 --idle-time=0 --log="$task_output/weston.log" >/dev/null 2>&1 &
task_weston=$!
trap 'kill "$task_weston" 2>/dev/null || true; wait "$task_weston" 2>/dev/null || true' EXIT
for task_attempt in {1..50}; do
  if [[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]]; then break; fi
  if ! kill -0 "$task_weston" 2>/dev/null; then cat "$task_output/weston.log"; exit 1; fi
  sleep 0.1
done
if [[ "${WATCHPAIR_TEST_DEBUGGER:-0}" == 1 ]]; then
  if [[ -n "${WATCHPAIR_DEBUG_COMMANDS:-}" ]]; then
    timeout -k 5s 90s gdb -batch -x "$WATCHPAIR_DEBUG_COMMANDS" --args "$task_binary" -v2 -o "$task_output/results.txt,txt"
  else
    timeout -k 5s 90s gdb -batch -ex run -ex 'thread apply all bt' --args "$task_binary" -v2 -o "$task_output/results.txt,txt"
  fi
else
  timeout -k 5s 150s "$task_binary" -o "$task_output/results.txt,txt"
fi
cat "$task_output/results.txt"
