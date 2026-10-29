# Native distribution record

The Windows SDK used for validation is MSYS2 UCRT64. Its FFmpeg 9.0.2 build explicitly enables `--enable-gpl --enable-version3`; libmpv 0.41.0 links that runtime. Treat the combined desktop distribution as GPLv3, include that license and dependency notices, and supply the exact corresponding source and build recipes with every public binary release. The WatchPair source's existing MIT notices remain in the source tree. Do not present the complete binary bundle as MIT-only. mpv documents its default GPL build and optional LGPL build separately; Qt documents its own LGPLv3/GPLv3 options. [mpv copyright](https://github.com/mpv-player/mpv/blob/master/Copyright), [Qt licensing](https://doc.qt.io/qt-6/licensing.html).

`scripts/bundle-windows.ps1` follows native DLL imports recursively, deploys Qt plugins, the matching OpenSSL providers and certificate roots, and records hashes and installed SDK package versions. `scripts/bundle-linux.sh` records distribution package versions and notices. These initial bundles are for internal validation and are marked accordingly. They are not public releases merely because their executables start.

For a public release, retain the WatchPair source revision, CMake/build scripts, compiler and SDK package manifest, complete source and patches for the distributed dependencies, the package build recipes, and all license notices. Publish the corresponding-source archive alongside installers and checksums, at the same durable download location. An upstream homepage or a list of package names is not the source archive. Keep dynamically linked Qt libraries replaceable; package signing checks downloaded releases and must not prevent running a user-modified application.

Release acceptance includes a clean environment launch without the development SDK on PATH, invite registration and single-instance handoff, storage/restart recovery, the media matrix, X11/Wayland rendering, signed update rejection and rollback, and the physical platform checks in `IMPLEMENTATION.md`. Preserve v1 source and media; v2 uses an independent profile and coordinator database.

## Build and release inputs

Use the build instructions in [README.md](README.md). Both shipping candidates use Qt 6.12; Windows uses MSYS2 UCRT64 and Linux uses the official Qt SDK with Ubuntu 24.04 native libraries. Do not mix Qt plugins from a different SDK. The Linux bundler takes the exact Qt tools from the configured build, includes Wayland decorations, and removes development RPATH/RUNPATH entries. Its `AppRun` chooses bundled libraries and plugins. System glibc and graphics driver libraries remain operating-system dependencies.

Every bundle includes `build-info.json`, `runtime-manifest.json`, the application license, this record and dependency notices. The manifest identifies all installed files by size and SHA-256. The Windows manifest also maps native files to their exact source package. Linux `runtime-sources.tsv` identifies exact Ubuntu source versions, and `runtime-sdk.tsv` identifies the Qt/ICU SDK libraries. Keep these inputs with the release.

1. Generate the production Ed25519 key once with `node scripts/sign-release.mjs keygen <new-private-directory>`. The script protects that directory before writing a key. Store the private PEM offline; build only the public hex value into the client with `WATCHPAIR_UPDATE_PUBLIC_KEY`. The local acceptance builds use a separate QA key and must not be presented as production-signed releases.
2. Build both platforms with the same supported version (`2.0.0-alpha.N`, `beta.N`, `rc.N` or a final three-component version), protocol and public key. Produce fresh bundle directories; do not merge files into an older bundle.
3. Run the native integration suites, graphical/media tests, standalone package launch and installer/update/rollback acceptance. A valid signature does not replace compatibility testing.
4. Run the exact-source collectors and create the source companion described below. Review its receipts and archive before publishing.
5. Archive each verified bundle with `python3 scripts/package-bundle.py <bundle> <new-platform-archive>`. Windows produces a ZIP and Linux a gzip tar archive. The adjacent `.json` records version, platform, size and SHA-256.
6. Sign the actual archive bytes using `node scripts/sign-release.mjs sign <offline-key.pem> https://host/downloads/ <new-feed.json> <windows.zip> <linux.tar.gz>`. Keep the adjacent archive metadata available for this command. It rejects changed archives and mismatched platform/version inputs. HTTP is accepted only for `127.0.0.1` acceptance fixtures; public feeds and packages use HTTPS.
7. Publish packages, corresponding source, checksums and signed feed together. The supplied download page uses `watchpair-windows-x64.zip`, `watchpair-linux-x64.tar.gz` and `watchpair-corresponding-source.tar.gz`; either use those names or update the page. Retain prior versions and source companions so users can recover and rebuild.

Client updates verify the pinned Ed25519 signature before trusting URLs, protocol, version or checksums. Download size and SHA-256 are checked before bounded archive extraction and per-file verification. Installation is private to the user and versioned. Restart leaves the watch, checkpoints the profile, creates a verified SQLite backup and switches the active version. A process that dies before its healthy checkpoint triggers the prior runtime's recovery helper on the next launch. Recovery preserves failed database state separately and restores the previous binary and compatible database together. Corrupt backups are refused without changing the live profile. A signed update is not applied during playback without the explicit restart action.

The stable launcher has no Qt dependency. The runtime remains dynamically linked, so source recipients can replace Qt or other shared libraries and run their modified application. Signature verification governs fetched release packages; it does not enforce signatures on each ordinary application launch. Do not lock users out of modified builds.

## Exact corresponding source

`collect-msys-sources.py <windows-bundle>/runtime-manifest.json <cache> --keyring <msys2-public-keyring>` downloads the exact source package versions from the official MSYS2 repository, verifies detached signatures using the SDK's public keyring, checks for their PKGBUILDs, and records archive/signature hashes. The receipt must say `complete: true` for every runtime source package. It does not copy signing private keys.

`collect-linux-sources.sh <linux-bundle> <cache>` uses an isolated source-package APT configuration derived from the machine's Ubuntu repositories, leaving system configuration unchanged. Exact superseded versions may be fetched from Canonical's HTTPS source archive. That fallback records the Canonical URL and `.dsc` digest; all payloads are checked against the `.dsc` SHA-256 list. Receipts distinguish repository authentication from archive provenance instead of claiming an unavailable APT signature check.

Download official matching Qt source modules using `aqt install-src linux 6.12.0 --outputdir <qt-sdk> --archives qtbase qtwayland qtsvg qtwebsockets`. The required module set is the same set selected for the binary SDK. Then assemble a fresh companion:

```sh
python3 scripts/create-source-kit.py \
  --windows-bundle /path/to/windows-bundle --msys-cache /path/to/msys-sources \
  --linux-bundle /path/to/linux-bundle --linux-cache /path/to/ubuntu-sources \
  --qt-sources /path/to/qt-sdk/6.12.0/Src --output /path/to/new-source-kit
tar -czf watchpair-corresponding-source.tar.gz -C /path/to/new-source-kit .
```

The assembler refuses incomplete receipts or a different dependency-version set. It copies the application/coordinator source snapshot, build scripts and plan, exact Windows source archives/recipes/signatures, exact Ubuntu source files, matching Qt modules and the ICU source version used by the official SDK. `source-kit.json` records every resulting file's SHA-256. User profiles, media, build output, dependency installations and private keys are excluded. Preserve the complete companion with the binaries; a dependency-name list alone is insufficient.

For an application-only hotfix with identical dependency versions, `scripts/create-source-overlay.py --base-source-kit <complete-kit> --windows-bundle <bundle> --linux-bundle <bundle> --output <new-overlay>` verifies every base source file and both platforms' dependency inputs. It publishes the complete new application snapshot, new build inputs and an assembled `source-kit.json`. Publish the overlay together with explicit links and hashes for the base kit; retain all base assets. Recipients remove the old `watchpair/` and `build-inputs/` from an extracted base kit and extract the overlay there, retaining dependency sources and receipts. Changed dependencies require a new complete kit.
