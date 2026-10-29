# WatchPair v2 Native Prototype

This is the first integration prototype for the [WatchPair v2 specification](../../docs/watchpair-v2-plan.md). It uses Qt Widgets, libmpv, and libtorrent. It has its own application profile and does not read the v1 room, download, or settings records.

## Implemented scope

- One physical torrent at a time with the original manifest file indexes and nested folder selection.
- Explicit metadata-only acquisition before applying a download choice.
- A private loopback range reader that reads only pieces verified by libtorrent, including pieces spanning file boundaries.
- Deadline priority for the current read window, cancellation when requests end, bounded piece caching, and socket backpressure.
- Native libmpv decoding and Qt OpenGL rendering; play, pause, seek, and actual video-frame validation in smoke tests.
- Persisted manual transfer pause, file selection, download location, and engine resume data.
- Local-only seeder/downloader integration tests with generated H.264 MP4 and MKV media.

The prototype does not yet implement room synchronization, the coordinator, all transfer-manager controls, the library, watched history, or encrypted relay fallback. These remain required v2 delivery gates. CPU decoding is deliberate for this integration step; hardware decoding and native display interop must pass their own platform tests before enabling them by default.

Current graphics limitation: Mesa's llvmpipe renderer produced black or corrupted video in the tested WSL environment. Both X11 and Wayland pass with an explicit softpipe workaround, using ordinary Ubuntu packages and the current Qt/mpv comparison build. This isolates a failing rendering path; it does not establish physical GPU support. See [validation evidence](VALIDATION.md).

## Windows build

Use MSYS2 UCRT64 with these packages:

```sh
pacman -Syu
pacman -S --needed mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake \
  mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-pkgconf \
  mingw-w64-ucrt-x86_64-qt6-base mingw-w64-ucrt-x86_64-mpv \
  mingw-w64-ucrt-x86_64-libtorrent-rasterbar mingw-w64-ucrt-x86_64-ffmpeg
```

From PowerShell:

```powershell
./v2/prototype/scripts/build-windows.ps1 -MsysRoot C:/msys64 -RunTests
./v2/prototype/scripts/bundle-windows.ps1 -MsysRoot C:/msys64
```

The build script selects RelWithDebInfo to match the packaged Release libtorrent DLL. CMake rejects an unsupported Debug/Release combination on Windows because it changes the public binary interface. Do not remove that check to make a build proceed; build matching dependencies when full Debug libraries are needed.

The bundle script collects Qt plugins, recursively resolves native DLL dependencies from the selected toolchain, includes OpenSSL's runtime-loaded providers, and copies upstream license notices. Its default output is `outputs/v2/windows-portable`. It is a prototype bundle, without the v2 production installer or updater. Keep the complete folder together when running or copying it.

## Ubuntu build

On Ubuntu 24.04:

```sh
sudo apt-get install build-essential cmake ninja-build pkg-config qt6-base-dev \
  libqt6opengl6-dev qt6-wayland libmpv-dev libtorrent-rasterbar-dev ffmpeg xvfb xauth
bash v2/prototype/scripts/build-linux.sh --test
```

Build output defaults to the user's native Linux cache directory. When testing under WSL, keep torrent fixture data on the Linux filesystem. Early tests on the Windows-mounted filesystem produced corrupt-piece failures; successful native-filesystem tests do not establish support for that mount's disk behavior.

## Run

Launch `watchpair-v2-prototype` or its Windows `.exe`. Choose a torrent and an empty prototype download directory. Check files in Content, apply the selection, select an episode row, and press Play selected episode. Use separate profiles to run independent prototype instances:

```sh
watchpair-v2-prototype --profile /path/to/new-profile
```

Reopen a profile without `--torrent` to restore its transfer. A new download requires an empty destination so this prototype cannot silently reuse or overwrite unrelated files. Adding further torrents, moving existing data, and managed-library reuse belong to subsequent implementation steps.

For the tested WSL software-rendering workaround:

```sh
GALLIUM_DRIVER=softpipe LIBGL_ALWAYS_SOFTWARE=1 QT_QPA_PLATFORM=xcb \
  /path/to/watchpair-v2-prototype
```

Use `QT_QPA_PLATFORM=wayland` for a Wayland session. These process-local settings do not change the system driver. Softpipe is a prototype validation route and may be too slow for real media; production GPU decoding/rendering remains a separate gate.

## Integration and graphical tests

`ctest --test-dir <build-directory> --output-on-failure` runs byte-range and real torrent-to-player tests. FFmpeg must be on PATH and include libx264. Set `WATCHPAIR_FFMPEG` to choose an explicit executable. Set `WATCHPAIR_FIXTURE_DIR` to retain generated fixtures and JSON results; each container receives a separate subdirectory. Use a fresh directory for each run.

The generated fixtures contain no trackers. Tests disable DHT, UPnP, and local discovery. A local seed serves freshly hashed fixture data, and the receiver still verifies downloaded pieces normally. Source seed mode verifies source pieces on first read. Explicit local peer retention prevents metadata-only selection from discarding the fixture's sole peer. Local peers are assigned to the global rate-limit class so a loopback transfer cannot bypass the test bandwidth cap.

Tests assert that the selected episode is incomplete when playback starts. They seek to 120 seconds and require an observed request for missing middle-of-file data, compare actual range bytes, reject excluded files and invalid authorization, then checkpoint and restore manual pause and file priorities.

For a graphical test, supply a retained fixture and a fresh profile:

```sh
watchpair-v2-prototype --profile /path/to/fresh-gui-profile \
  --torrent /path/to/fixtures/mp4/fixture.torrent \
  --test-seed-directory /path/to/fixtures/mp4/seed \
  --test-screenshot /path/to/window.png --test-report /path/to/result.json
```

On Linux use `QT_QPA_PLATFORM=xcb` or `QT_QPA_PLATFORM=wayland` for the intended display backend. X11 CI can use `xvfb-run -a`. Software tests can set `LIBGL_ALWAYS_SOFTWARE=1` and the tested WSL workaround above. The prototype permits software rendering; smoke mode additionally mutes physical audio. The known test pattern must produce more than eight sampled colors and over 40% nonblack samples. Visual inspection accompanies the numeric check: scattered corrupted pixels must not count as successful video. The report records these checks, frame count, playback position, and torrent progress. A separate `.frame.png` captures the video framebuffer.

For an isolated Wayland test, install `weston` and run:

```sh
bash v2/prototype/scripts/test-wayland.sh /path/to/watchpair-v2-prototype \
  /path/to/fixtures/mp4 /path/to/test-output
```

The script creates its own temporary runtime, compositor, and profile, then stops only that compositor. It retains screenshots, JSON results, and the Weston log in the requested output directory.

Prefix this command with `GALLIUM_DRIVER=softpipe` for the tested WSL route. Build scripts inherit `CMAKE_PREFIX_PATH` and `PKG_CONFIG_PATH` when comparing isolated Qt or mpv SDKs; the default Ubuntu dependency instructions use distribution packages.

## Remaining validation

The prototype's H.264 fixtures do not establish the entire agreed codec, subtitle, HDR, multichannel, GPU, or operating-system support matrix. Native Windows and Linux rendering, incomplete-file startup and seeking, and safe restart are the first gate. Keep actual test versions and results in `VALIDATION.md`; unsupported or failed combinations remain visible there.
