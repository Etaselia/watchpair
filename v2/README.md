# WatchPair v2

WatchPair is a native Windows/Linux watch room and media transfer application. Each watcher keeps their own copy. Qt Widgets supplies the desktop, libmpv decodes the original media, libtorrent manages torrents, and a TypeScript/SQLite coordinator owns the shared room timeline and history. A separate relay forwards encrypted local-file transfers when direct connections fail.

The [integrated specification](../docs/watchpair-v2-plan.md) defines launch scope. [IMPLEMENTATION.md](IMPLEMENTATION.md) records stage reviews, test evidence and remaining platform gates. v2 has its own profile, database and protocol. It does not import v1 room links, history or transfer state; existing media can be scanned or re-added.

## Run a packaged desktop

Extract the complete platform archive. On Windows, open `watchpair.exe`. On Linux, run `./AppRun`; do not move `bin/watchpair` away from its libraries and plugins. The release targets Windows 10/11 x64 and Ubuntu 24.04+ x64. The current acceptance bundles are QA builds, not a public production rollout.

Open **Settings → Application and updates → Install this copy** for a private per-user installation. Restart using the offered action. The installed launcher remains stable across updates; the first installed start registers invite links and a Start menu/application entry. Portable use is also supported. Startup and notification-area behavior are opt-in settings.

1. Create a room on your coordinator, or paste an invite. Keep the host's separate recovery link private. Rooms persist until the host explicitly deletes them.
2. **Add media** accepts a torrent, magnet, Nyaa page, direct file URL, or local file/folder. Choose seasons and episodes in the nested file chooser. Extras start unchecked. The dialog labels shared queue changes and this device's download approval separately.
3. Use **Transfers** for file choices, pause/resume, ordering, rate and seeding limits, storage, trackers, peers and network settings. A manual pause or refusal always wins over automatic playback priority. Metadata retrieval itself does not select video payload.
4. Select an episode and press **Join watch**. Room membership alone never blocks playback. Required watchers pause the shared timeline when they disconnect or underrun; the host can explicitly continue without someone. Everyone can control playback and edit the queue.
5. Audio, subtitle and subtitle-delay choices are shared. Volume, audio output and subtitle size are local. An unavailable shared track pauses with an explanation.
6. Distinct shared viewing coverage reaches **90%** to move an episode to **Watched**, with a relative timestamp. Any member can mark watched/unwatched or watch again. Automatic marking does not stop the currently playing episode or its download.

Local publication hashes original files and transfers verified chunks into recipients' own copies. The original is never managed cleanup data. Torrent and shared-file playback can start before completion. Direct HTTP files wait for complete SHA-256 verification; the UI states this limitation. Releases with different edits are not automatically aligned.

Use **Storage** to preview cleanup, move owned copies, pin files and configure optional age/capacity policies. Pinned or active copies and external originals are protected. **Diagnostics** exports an allowlist of operational data without private paths, URLs, room credentials or recovery links.

## Build

Use CMake 3.22+, Ninja and a C++20 compiler. Dependencies are Qt Core/Gui/Widgets/OpenGLWidgets/Network/Sql/WebSockets/Concurrent/Test, libmpv, libtorrent-rasterbar, OpenSSL, curl and libarchive. Shipping builds use **Qt 6.12**. The code also compiles against older distribution Qt for comparison; that does not change the packaged platform target. Native DLLs and import libraries must use a matching toolchain and Release ABI.

Windows uses MSYS2 **UCRT64**. Install the toolchain, CMake, Ninja, pkgconf, Qt base/WebSockets/SVG, mpv, libtorrent-rasterbar, curl, OpenSSL, libarchive and FFmpeg packages, then run:

```powershell
./v2/scripts/build-libtorrent-matched.ps1 -MsysRoot C:/msys64 -SourceArchive C:/source-kit/dependencies/msys2/mingw-w64-libtorrent-rasterbar-2.1.2-1.src.tar.zst
./v2/scripts/build-windows.ps1 -MsysRoot C:/msys64 -RunTests
./v2/scripts/bundle-windows.ps1 -MsysRoot C:/msys64 -Destination ./outputs/v2/windows-bundle
```

The Windows libtorrent build uses the exact 2.1.2 source archive with `BOOST_ASIO_HAS_PTHREADS=1` applied to every library and application translation unit. The native build script requires a fresh output directory and leaves the SDK unchanged. Its prefix includes `watchpair-libtorrent-build.json`; application configuration and bundling verify this receipt and the selected DLL hash. Pass `-TorrentPrefix` to `build-windows.ps1` when using another output location. The source archive is retained in the complete corresponding-source kit; see [DISTRIBUTION.md](DISTRIBUTION.md).

For alpha.4 corresponding source, follow the release's versioned `SOURCE-README-alpha.4.txt`. It materializes a **new complete kit** from the pinned alpha.2 base and an explicitly verified dependency-delta overlay, including Ubuntu librsvg `2.58.0+dfsg-1ubuntu0.1`. This supersedes the older unchanged-only overlay procedure in DISTRIBUTION.md. The composite Linux receipt gives explicit source-kit-relative paths and identifies every active source version; unused older base archives may remain.

On Ubuntu 24.04, install the native development libraries and tooling:

```sh
sudo apt-get install build-essential cmake ninja-build pkg-config libmpv-dev \
  libtorrent-rasterbar-dev libssl-dev libcurl4-openssl-dev libarchive-dev \
  ffmpeg xvfb xauth weston python3-venv
python3 -m venv ./outputs/v2/aqt-env
./outputs/v2/aqt-env/bin/pip install aqtinstall
./outputs/v2/aqt-env/bin/aqt install-qt linux desktop 6.12.0 linux_gcc_64 \
  --outputdir ./outputs/v2/qt-sdk --archives qtbase icu qtwayland qtsvg -m qtwebsockets
export WATCHPAIR_QT_PREFIX="$PWD/outputs/v2/qt-sdk/6.12.0/gcc_64"
bash v2/scripts/build-linux.sh --test
bash v2/scripts/bundle-linux.sh outputs/v2/app-linux outputs/v2/linux-bundle
```

The coordinator and native integration tests require Node 24+. End users do not need Node, Python or FFmpeg installed alongside the bundle. Install coordinator dependencies once with `npm ci --prefix v2/coordinator`. Use `WATCHPAIR_NODE` if the native tests should run a specific Node executable. `scripts/setup-test-node-linux.sh` installs a private test runtime without replacing system Node.

Release builds set `WATCHPAIR_APP_VERSION` and the 64-character lowercase hex `WATCHPAIR_UPDATE_PUBLIC_KEY` CMake cache variables. Quote complete `-D` arguments in PowerShell. Windows build-script parameters `-AppVersion` and `-UpdatePublicKey`, or the matching Linux environment variables, forward these values. Unpinned development builds disable update checks. Keep private signing keys outside the source tree and packages.

## Verify

```sh
npm test --prefix v2/coordinator
ctest --test-dir outputs/v2/app-linux --output-on-failure -LE render
python3 v2/scripts/generate-media-fixtures.py outputs/v2/media-fixtures
WATCHPAIR_MEDIA_FIXTURES="$PWD/outputs/v2/media-fixtures" \
  WATCHPAIR_MEDIA_OUTPUT="$PWD/outputs/v2/media-validation" \
  xvfb-run -a ctest --test-dir outputs/v2/app-linux --output-on-failure -L render
bash v2/scripts/test-ui-wayland.sh outputs/v2/app-linux/desktop/ui-flow-tests outputs/v2/wayland-validation
```

The fixture generator needs FFmpeg/ffprobe, libx264/libx265/libaom-av1, and a font; see `--help`. On Windows use `build-windows.ps1 -DesktopTests -MediaFixtures <generated-directory>`. On Linux use `build-linux.sh --desktop-tests` with the same fixture environment variables and a working display. The default `--test`/`-RunTests` excludes render tests so it does not silently depend on ungenerated fixtures or a display.

Under WSL, keep `TMPDIR` on the Linux filesystem for real torrent fixtures. Detected CPU renderers automatically use mpv's basic rendering path with bilinear scaling; no driver environment override is required. Tone mapping, subtitles, chapters and audio selection remain supported. Software preview rendering is capped at 640×360 and scaled to the window to preserve event-loop responsiveness. Physical GPU paths retain the full render surface. This is not a claim of physical Linux GPU validation.

Packaged delivery tests use `WATCHPAIR_PACKAGE` and `WATCHPAIR_PREVIOUS_PACKAGE` pointing to different-version complete bundles. They install into temporary directories, launch without the Windows SDK on PATH, simulate an executable crash, then verify automatic runtime and SQLite rollback. For the complete signed-feed/download/staging pass, use a QA build pinned to your QA key:

```sh
node v2/scripts/test-release-update.mjs /private/qa/release-private.pem \
  /path/to/candidate.tar.gz /path/to/desktop/delivery-tests \
  /path/to/baseline-bundle /path/to/candidate-bundle /path/to/results.txt
```

This fixture listens only on loopback. It never publishes the key or packages. Run Linux graphical package tests under `xvfb-run` or a real display. See [DISTRIBUTION.md](DISTRIBUTION.md) for archive, signature and exact-source procedures.

## Coordinator and relay

For a local room test, build with `npm run build --prefix v2/coordinator`, then run `node v2/coordinator/dist/src/main.js`. It binds to `127.0.0.1:8787` by default; the desktop permits loopback HTTP for local testing. Use HTTPS for remote servers. File sharing needs the separately configured relay secret/URL for fallback; direct local tests alone do not validate public NAT behavior.

The [self-host guide](deploy/README.md) covers Docker, Caddy TLS, relay ceilings, private backups, restore and hard cutover. `scripts/test-deployment.ps1` validates actual HTTPS/WSS, separate relay containers, restart and online backup restore with a local certificate authority. It creates isolated test resources and removes only those resources afterwards.

No public endpoint, v1 protocol registration or production service is switched by building or testing this tree. Keep the v1 release and its database backup until the physical platform gates and a small v2 release-candidate trial pass.
