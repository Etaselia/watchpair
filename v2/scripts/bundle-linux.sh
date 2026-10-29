#!/usr/bin/env bash
set -euo pipefail
task_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_build=$(realpath -- "${1:?Pass the native build directory}")
task_destination=$(realpath -m -- "${2:?Pass a new package directory}")
[[ ! -e "$task_destination" ]] || { printf '%s\n' 'Use a new package directory.' >&2; exit 1; }
mkdir -p -- "$task_destination/bin" "$task_destination/lib" "$task_destination/plugins" "$task_destination/licenses"
touch -- "$task_destination/runtime-sources.tsv"
touch -- "$task_destination/runtime-sdk.tsv"
cp -- "$task_build/desktop/watchpair" "$task_destination/bin/watchpair"
cp -- "$task_build/desktop/watchpair-launcher" "$task_destination/watchpair-launcher"
cp -- "$task_build/build-info.json" "$task_destination/build-info.json"
task_qt_paths=$(cat -- "$task_build/qt-runtime-path.txt")
task_qt_plugins=$("$task_qt_paths" --query QT_INSTALL_PLUGINS)
task_qt_prefix=$("$task_qt_paths" --query QT_INSTALL_PREFIX)
if [[ -n "${WATCHPAIR_QT_SOURCE_DIR:-}" ]]; then
  mkdir -p -- "$task_destination/licenses/Qt"
  for task_module in qtbase qtwayland qtsvg qtwebsockets; do
    cp -a -- "$WATCHPAIR_QT_SOURCE_DIR/$task_module/LICENSES" "$task_destination/licenses/Qt/$task_module"
  done
fi
for task_type in platforms platformthemes platforminputcontexts xcbglintegrations wayland-graphics-integration-client wayland-shell-integration wayland-decoration-client imageformats iconengines tls sqldrivers; do
  [[ ! -d "$task_qt_plugins/$task_type" ]] || cp -a -- "$task_qt_plugins/$task_type" "$task_destination/plugins/"
done
while IFS= read -r -d '' task_binary; do
  while read -r task_dependency; do
    [[ -f "$task_dependency" ]] || continue
    task_name=$(basename -- "$task_dependency")
    if [[ "$task_name" == libQt6* && "$(realpath -- "$task_dependency")" != "$task_qt_prefix/lib/"* ]]; then
      printf 'A Qt dependency resolved outside the configured SDK: %s\n' "$task_dependency" >&2
      exit 1
    fi
    case "$task_name" in
      ld-linux*|libc.so*|libm.so*|libpthread.so*|librt.so*|libdl.so*|libresolv.so*|libnss_*|libGL*|libEGL*|libOpenGL*|libglapi*|libdrm*|libLLVM*|libgallium*) continue ;;
    esac
    [[ ! -e "$task_destination/lib/$task_name" ]] || continue
    cp -L -- "$task_dependency" "$task_destination/lib/$task_name"
    task_package=$(dpkg-query -S "$task_dependency" 2>/dev/null | head -1 | cut -d: -f1 || true)
    if [[ -z "$task_package" ]]; then task_package=$(dpkg-query -S "$(realpath -- "$task_dependency")" 2>/dev/null | head -1 | cut -d: -f1 || true); fi
    if [[ -n "$task_package" && -f "/usr/share/doc/$task_package/copyright" ]]; then cp -- "/usr/share/doc/$task_package/copyright" "$task_destination/licenses/$task_package.copyright"; fi
    if [[ -n "$task_package" ]]; then
      dpkg-query -W -f='${source:Package}\t${source:Version}\n' "$task_package" >> "$task_destination/runtime-sources.tsv"
    else
      printf '%s\t%s\n' "$task_name" "$(basename -- "$(realpath -- "$task_dependency")")" >> "$task_destination/runtime-sdk.tsv"
    fi
  done < <(LD_LIBRARY_PATH="$task_qt_prefix/lib" ldd "$task_binary" | awk '/=> \// {print $3} /^\// {print $1}')
done < <(find "$task_destination/bin" "$task_destination/plugins" -type f -print0)
# Never let a development SDK path satisfy an accidentally missing dependency.
# AppRun selects only this bundle's private libraries and plugins.
cmake "-DWATCHPAIR_BUNDLE_ROOT=$task_destination" -P "$task_source/cmake/StripRuntimePaths.cmake"
cat > "$task_destination/AppRun" <<'RUN'
#!/bin/sh
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LD_LIBRARY_PATH="$task_root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export QT_PLUGIN_PATH="$task_root/plugins"
exec "$task_root/bin/watchpair" "$@"
RUN
chmod +x -- "$task_destination/AppRun"
printf '%s\n' '[Paths]' 'Prefix=..' 'Plugins=plugins' > "$task_destination/bin/qt.conf"
cp -- "$task_source/assets/watchpair.svg" "$task_destination/watchpair.svg"
cp -- "$task_source/../LICENSE" "$task_destination/WatchPair-LICENSE.txt"
cp -- "$task_source/DISTRIBUTION.md" "$task_destination/DISTRIBUTION.md"
printf '%s\n' 'Internal validation bundle. Public distribution requires corresponding source, build recipes, notices and signed metadata. See v2/DISTRIBUTION.md.' > "$task_destination/PACKAGE-STATUS.txt"
dpkg-query -W -f='${binary:Package}\t${Version}\n' > "$task_destination/runtime-packages.tsv"
sort -u -o "$task_destination/runtime-sources.tsv" "$task_destination/runtime-sources.tsv"
sort -u -o "$task_destination/runtime-sdk.tsv" "$task_destination/runtime-sdk.tsv"
(cd -- "$task_destination" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
python3 - "$task_destination" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
build = json.loads((root / 'build-info.json').read_text())
files = [{'path': p.relative_to(root).as_posix(), 'size': p.stat().st_size,
          'sha256': hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()}
         for p in sorted(root.rglob('*')) if p.is_file()]
(root / 'runtime-manifest.json').write_text(json.dumps({'format': 1, 'version': build['version'],
    'protocol': 2, 'platform': 'linux-x64', 'files': files}, indent=2))
PY
printf '%s\n' "$task_destination/AppRun"
