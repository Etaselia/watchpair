# Native prototype validation

Recorded on 28 October 2026. This is evidence for the first Qt/libmpv/libtorrent integration step, not a claim that the v2 release acceptance matrix is complete.

## Environments

| Environment | Versions and conditions |
| --- | --- |
| Windows | Windows 10 Pro x64 build 19045; Intel Core i7-12700F; NVIDIA RTX 4080 SUPER, driver 32.0.15.9621; MSYS2 UCRT64 GCC 16.2; Qt 6.12.0; libtorrent 2.1.2; mpv 0.41.0; RelWithDebInfo matching the release DLL ABI. |
| Linux | Ubuntu 24.04.2 x64 under WSL2, kernel 6.18.54.1-microsoft-standard-WSL2; Qt 6.4.2; libtorrent 2.0.10; mpv 0.37.0. Torrent data on the native Linux filesystem. |
| Linux comparison | Official Qt 6.12.0 SDK and official mpv v0.41.0 source, built into isolated cache directories; same libtorrent and FFmpeg distribution libraries. System Qt/mpv were retained. |
| Linux graphics | X11 through Xvfb and Wayland through an isolated Weston headless compositor; Mesa software OpenGL and CPU video decoding. Softpipe passes; llvmpipe is a failing path in this environment. WSLg is a separate graphics combination. |

The Linux process is a native ELF build linked against Ubuntu packages. WSL, Xvfb, and headless Weston do not substitute for physical Ubuntu GPU, window-management, or audio-device testing. Windows 11 has not been tested in this workspace.

## Core integration results

| Test run | Result | Duration |
| --- | --- | --- |
| Windows, `outputs/v2/windows-integration-image-check.txt` | 5 passed, 0 failed | 37.939 s |
| Ubuntu distribution packages, `outputs/v2-linux-final-distro-integration.log` | 5 passed, 0 failed | 44.541 s |
| Ubuntu current Qt/mpv comparison, `outputs/v2-linux-current-integration.log` | 5 passed, 0 failed | 39.546 s |

The five QtTest results include initialization, range parsing, MP4 integration, MKV integration, and cleanup. Both media cases exercise a real independent libtorrent seed and downloader, a real libmpv decoder, and generated three-minute H.264/AAC media. The seed's global upload cap is 256 KiB/s and applies to loopback peers. No public swarm, tracker, DHT, or discovery service is used.

| Selected episode downloaded when playback began | Windows | Ubuntu |
| --- | --- | --- |
| MP4 | 3.03% | 4.02% |
| MKV | 2.34% | 3.47% |

Assertions cover:

- No payload acquisition before explicit file selection.
- Two nested season folders and an excluded bonus file; the video uses original manifest index 1, not filtered video index 0.
- Byte-for-byte comparison of an unaligned range across torrent-piece boundaries.
- Unauthorized and excluded-file requests return 403; malformed multipart ranges return 416.
- Playback starts while the selected episode is incomplete.
- Seeking to 120 seconds observes a request for missing data in the middle of the selected file and then resumes actual player position beyond 120.2 seconds.
- Piece caching stays within its configured bound.
- Manual pause, native file priorities, manifest paths, selection, and engine resume data survive service destruction and recreation; resuming requires an explicit action.

Machine-readable case results are retained beneath `outputs/v2/windows-fixture-image-check/{mp4,mkv}/integration-result.json` and `/home/eta/.cache/watchpair-v2-prototype/fixture-final-distro/{mp4,mkv}/integration-result.json` on Ubuntu. The current Qt/mpv comparison uses `fixture-current`. Outputs are intentionally ignored by Git; source tests regenerate their own fixtures.

## Issues found during integration

- Windows TCP ephemeral ports can overlap UDP exclusion ranges created by the OS. libtorrent first bound TCP and then failed to bind UDP on the same port, leaving a transfer with no usable listener. The prototype now probes an OS-assigned UDP port and checks TCP availability before starting the engine. OS exclusions and firewall configuration were unchanged. A startup-listener assertion prevents the integration test from silently accepting this state. There is still a normal close-and-bind race; production network configuration needs bounded retries and explicit user-port semantics.
- OpenSSL providers are runtime-loaded modules and are absent from ordinary DLL import tables. The Windows build and portable bundle include the matching legacy provider and configure an application-local module path, unless the caller explicitly supplies `OPENSSL_MODULES`.
- A Debug consumer with the packaged release libtorrent DLL produced an incompatible public ABI. Windows CMake now rejects that combination; build scripts select RelWithDebInfo.
- Windows-native manifest separators broke an episode lookup. Paths presented to the application now use normalized separators while preserving original file indexes.
- Automatically closing a redundant peer during metadata-only selection discarded the test's sole seed. Isolated fixtures retain that peer; this is not a public-swarm configuration change.
- Socket callbacks during destruction could outlive the reader's request map. Reader teardown disconnects all server child sockets before destroying the map.
- Linux tests using torrent data under `/mnt/c` produced corrupt-piece failures. Native Linux filesystem data passed. Windows-mounted WSL data locations remain unsupported by this prototype until that disk behavior is diagnosed.
- An advancing libmpv clock and a valid GL context did not reliably imply visible video. An early color-count check also accepted a corrupted striped image. The final graphical check requires more than eight colors and over 40% nonblack samples from the known test pattern; its full images are visually inspected. The striped image had only 6.3% nonblack samples and is rejected by the stronger check. Earlier black/corrupt runs remain in `outputs/v2/` as failed evidence.

## Graphical and package results

| Combination | Result | Evidence |
| --- | --- | --- |
| Standalone Windows bundle, toolchain removed from PATH | **Passed:** 31 frame updates, 357 colors, 70.5% nonblack samples, player position 1.15 s, incomplete torrent, empty player error; full pattern inspected | `outputs/v2/windows-final.json` and `.png` |
| Ubuntu packages, X11, softpipe | **Passed:** 371 colors, 73.8% nonblack samples, player position 1.35 s; full pattern inspected | `outputs/v2/linux-softpipe-distro-x11.json` and `.png` |
| Ubuntu packages, Wayland/Weston, softpipe | **Passed:** 371 colors, 73.8% nonblack samples, player position 1.35 s | `outputs/v2/wayland-softpipe-distro/result.json` and `window.png` |
| Current Qt/mpv, X11, softpipe | **Passed:** 412 colors, 73.8% nonblack samples, player position 2.05 s; full pattern inspected | `outputs/v2/linux-softpipe-x11.json` and `.png` |
| Current Qt/mpv, Wayland/Weston, softpipe | **Passed:** 413 colors, 73.8% nonblack samples, player position 2.2 s; full pattern inspected | `outputs/v2/wayland-softpipe/result.json` and `window.png` |
| Ubuntu X11 and Wayland, llvmpipe | **Failed/inconsistent:** black or corrupted frames, despite advancing player time. Current Qt and current mpv did not resolve this path. | `outputs/v2/linux-current-x11.json`, `linux-x11-reviewed.json`, `wayland-state-repeat/result.json` |
| Ubuntu Wayland, WSLg | **Failed:** advancing position but 2 sampled colors | `outputs/v2/linux-wslg-state.json` |

The supported prototype workaround is explicit, process-local `GALLIUM_DRIVER=softpipe LIBGL_ALWAYS_SOFTWARE=1`. Do not silently treat llvmpipe's earlier individual passes as driver sign-off. This isolates a failing render path; it does not prove which layer causes that failure. Softpipe rendering is slow and does not establish acceptable real-media performance.

The renderer resets sampler, upload, clipping, and other relevant GL state before libmpv initialization/rendering. The experimental extra FBO and debugging option changes were removed. Optional swap reporting outside a current GL context was removed, and render teardown makes the widget context current first. Physical GPU validation remains open. Both Windows and Linux libmpv emitted nonfatal `INVALID_ENUM` texture warnings in some successful runs; these remain part of the broader driver investigation.

## Remaining release gates

- Actual Windows 11 and physical Ubuntu X11/Wayland desktops, GPU decoding and driver combinations, fullscreen, focus, display scaling, suspend/resume, and audio devices.
- HEVC, AV1, high-resolution media, multichannel output, ASS/font attachments, image subtitles, external subtitle distribution, chapters, and HDR tone mapping. H.264 fixtures establish none of those by themselves.
- Two-client synchronization, measured drift and clock offset, readiness barriers, disconnect/rejoin, conflicting queue edits, watched reporting, and persistence. The single-player prototype contains no room protocol.
- Local file/folder publishing, restrictive NAT, encrypted relay fallback, backpressure, resumed transfers, and operator bandwidth limits.
- Thousands of manifest entries, long/Unicode paths, unavailable pieces, disk full, storage moves, malicious manifests, and crash/power-loss recovery beyond the exercised clean checkpoint.
- Complete transfer controls, library reuse, retention, installers, updates, dependency pinning, and a production distribution/license manifest.
- Numeric startup/seek latency, resident memory, UI responsiveness, and steady-state drift budgets on reference machines. The test durations and sampled positions above are not substitutes for those measurements.
