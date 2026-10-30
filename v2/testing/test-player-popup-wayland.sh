#!/usr/bin/env bash
# Real compositor input is required for Wayland grabbing popup serials.
set -euo pipefail
if [[ ${WATCHPAIR_POPUP_XVFB_CHILD:-0} != 1 ]]; then
  export WATCHPAIR_POPUP_XVFB_CHILD=1
  exec xvfb-run -a -s '-screen 0 1600x1100x24' bash "$0" "$@"
fi
task_binary=$(realpath -- "${1:?Pass player-surface-tests or player-presentation-tests}")
task_output=$(realpath -m -- "${2:?Pass an output directory}")
task_testing=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p -- "$task_output"
task_runtime=$(mktemp -d /tmp/watchpair-popup-wayland.XXXXXX)
mkdir -- "$task_runtime/runtime"
chmod 700 -- "$task_runtime/runtime"
export XDG_RUNTIME_DIR="$task_runtime/runtime" WAYLAND_DISPLAY=watchpair-popup
export QT_QPA_PLATFORM=wayland QT_WAYLAND_DISABLE_WINDOWDECORATION=1
export LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=softpipe
export WATCHPAIR_UI_OUTPUT="$task_output"
export WATCHPAIR_WAYLAND_POPUP_INPUT="$task_testing/wayland_popup_input.py"
if [[ ${WATCHPAIR_POPUP_WAYLAND_DEBUG:-0} == 1 ]]; then export WAYLAND_DEBUG=client; fi
cat >"$task_runtime/weston.ini" <<'CONFIG'
[shell]
animation=none
startup-animation=none
close-animation=none
CONFIG
weston --backend=x11 --renderer=gl --debug --config="$task_runtime/weston.ini" --socket="$WAYLAND_DISPLAY" \
  --width=1480 --height=1000 --idle-time=0 --log="$task_output/weston.log" >/dev/null 2>&1 &
task_weston=$!
trap 'kill "$task_weston" 2>/dev/null || true; wait "$task_weston" 2>/dev/null || true' EXIT
for task_attempt in {1..50}; do
  [[ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]] || break
  if ! kill -0 "$task_weston" 2>/dev/null; then cat "$task_output/weston.log"; exit 1; fi
  sleep 0.1
done
timeout -k 5s 150s "$task_binary" "${@:3}" -v2 -o "$task_output/results.txt,txt" 2>"$task_output/native-stderr.txt"
