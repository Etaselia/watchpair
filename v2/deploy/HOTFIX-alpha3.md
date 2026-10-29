# Desktop alpha.3 hotfix — 2026-10-29

This application-only hotfix uses the same Qt, libmpv, libtorrent, FFmpeg and other native dependency versions as alpha.2. The coordinator, relay, room database and server container image are unchanged.

## Reported failures and fixes

- Linux startup: QApplication adopts regional C numeric formatting; libmpv 0.37 rejects decimal-comma locales in `mpv_create`. Set only `LC_NUMERIC=C` immediately after application creation, before workers start. QLocale and the remaining locale categories retain user formatting. The original alpha.2 package reproduces the reported dialog with `de_DE.UTF-8`, but starts under `C.UTF-8`.
- Missing audio: `ao=auto` names a nonexistent output driver. Leave the normal audio-driver list unset so mpv selects the system backend. Silent/headless test players still explicitly use the null sink. A zero-volume test now verifies a real backend rather than masking audio initialization failures.
- Torrent restart: protocol paths come from the original manifest, but disk paths may already be renamed in resume data. Compare against the current mapped storage before requesting a rename. Keep payload paused while outstanding renames complete, then checkpoint their native mapping. This supports libtorrent 2.0 on Linux and 2.1 on Windows without changing manifest indices, deleting files or discarding verified pieces.
- Update feed: the previous UI suggested `stable.json`, while deployment supplied only `release.json`. Restore the former as a compatibility alias and use the latter for new settings. Report HTTP status or transport errors. A trusted current/older feed now reports that the application is up to date; package staging still requires a newer version and retains signature/hash checks.

## Regression evidence

- The populated portable-name restart fixture failed with the exact `File exists` error before the fix. It now passes repeated restarts, including an interrupted mapping checkpoint, while preserving file contents and verified pieces.
- The real Windows audio fixture failed before the fix and now opens WASAPI successfully, including with the SDK removed from PATH. Volume remains zero throughout the test.
- Linux's new native-runtime tests require a real decimal-comma locale precondition, create libmpv successfully, parse fractional playback speed and verify unchanged QLocale/time/character formatting. German-locale graphical startup passes on X11 and Wayland.
- The Windows full native CTest run passes all 11 suites. Platform reports and packaged acceptance logs are retained under `outputs/v2-hotfix-*` and `outputs/v2/linux-startup-qa`.
- Updater coverage includes HTTP 404 reporting, signature/key/version checks and a real signed package transport/staging test followed by a current-version check.

The first Linux full run passed 11/12 suites but failed the automatic watched-history assertion: native playback reached EOF while recorded coverage stopped at 16.75/24.02 seconds, with eight additional readiness invalidations. Both an isolated traced run and a complete traced playback-suite rerun subsequently passed unchanged, with continuous coverage through 90% and reports no more than 204 ms apart. The eight-player check retained 41.7 ms p95/max spread. The original triggering transition was not captured, so concurrent load is a hypothesis, not a proven cause. Keep the original failed report and treat history under heavy load as a remaining acceptance risk; no assertion or coverage rule was relaxed.

Physical Linux graphics/audio devices and Windows 11 remain the hardware coverage limits recorded in [IMPLEMENTATION.md](../IMPLEMENTATION.md). WSL/X11/Wayland checks do not establish physical device qualification.

## Release artifacts

| Archive | Bytes | SHA-256 |
| --- | ---: | --- |
| `watchpair-windows-x64-alpha.3.zip` | 136563901 | `9aa4051c3115ec16354b92c0b9596581c71cb50013588ccfe1973b76d4655f1e` |
| `watchpair-linux-x64-alpha.3.tar.gz` | 165099064 | `8eed05aba0d89ae97866ed44264e959dfffdbd47c30581b845a741974189b37e` |

Publish immutable versioned archives before replacing the signed feed and landing page. `stable.json` and `release.json` must identify the same release. Keep archive checksums and the source reconstruction instructions linked from the download page. The source overlay supplies the entire new application snapshot and exact build inputs over the verified, unchanged alpha.2 dependency kit; retain both alpha.2 source parts on GitHub. No signing private key is included or uploaded.
