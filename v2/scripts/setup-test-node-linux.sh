#!/usr/bin/env sh
# Isolated test dependency; does not replace a system Node installation.
set -eu
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
task_sdk=${WATCHPAIR_TEST_NODE_DIR:-"${XDG_CACHE_HOME:-$HOME/.cache}/watchpair-v2-prototype/node-sdk"}
mkdir -p "$task_sdk"
curl --fail --location https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt --output "$task_sdk/SHASUMS256.txt"
task_archive=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64.tar.xz$/ {print $2;exit}' "$task_sdk/SHASUMS256.txt")
test -n "$task_archive"
curl --fail --location "https://nodejs.org/dist/latest-v24.x/$task_archive" --output "$task_sdk/$task_archive"
cd "$task_sdk"
awk -v task_file="$task_archive" '$2 == task_file {print}' SHASUMS256.txt | sha256sum --check -
tar -xJf "$task_archive" --strip-components=1
./bin/node --version
