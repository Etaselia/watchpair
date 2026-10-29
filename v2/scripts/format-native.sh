#!/usr/bin/env sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$task_root"
rg --files core desktop testing prototype/src prototype/tests -g '*.cpp' -g '*.h' -0 | xargs -0 clang-format -i
