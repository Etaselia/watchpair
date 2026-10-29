#!/usr/bin/env bash
set -euo pipefail

task_binary=$(realpath -- "${1:?Pass native-runtime-tests}")
task_locales=$(realpath -m -- "${2:?Pass a private locale fixture directory}")
task_localedef=${3:-localedef}
mkdir -p -- "$task_locales"
"$task_localedef" --no-archive -i de_DE -f UTF-8 "$task_locales/de_DE.UTF-8"

exec env LOCPATH="$task_locales" LANG=de_DE.UTF-8 LC_ALL=de_DE.UTF-8 \
  WATCHPAIR_TEST_COMMA_LOCALE=1 "$task_binary"
