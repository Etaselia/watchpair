# WatchPair

[![CI](https://github.com/Etaselia/watchpair/actions/workflows/ci.yml/badge.svg)](https://github.com/Etaselia/watchpair/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

WatchPair is a self-hosted watch room for videos that remain on each
participant's own computer. A session keeps an ordered download queue, active
file selection, per-item readiness, play/pause, seeks, playback speed, audio language, subtitles, and
subtitle timing synchronized.

## What works

- Short session tokens and shareable invite links
- Peer-to-peer room voice with mute, deafen, device selection, input gain, speaking indicators,
  echo cancellation, automatic gain control, and browser noise suppression
- Join-in-progress snapshots after refresh, reconnect, or late arrival
- Local video selection with sampled SHA-256 file matching
- Automatic direct downloads through the local companion, with an OPFS browser
  fallback for CORS-enabled URLs
- Magnet-first page resolution through the local companion, including encoded links
- Concurrent queued magnet, `.torrent`, and direct downloads through the local companion
- Synchronized queue and torrent file selection with remove, rename, reorder, retry, and auto-advance
- Per-device automatic, manual, or external-client download policy
- Resumable local-file imports that publish a room-only magnet and seed from the companion
- Persistent companion jobs and configurable external download-library folders
- Per-device progress and a both-ready gate before shared playback
- Server-authoritative play, pause, seek, speed, language, subtitle, and offset
  state
- Drift correction and reconnect recovery in the player
- Local SRT and WebVTT subtitle parsing
- Faithful ASS/SSA rendering with libass, overlapping cues, authored placement, and embedded MKV fonts
- Per-file audio, subtitle, and chapter discovery for MKV and other containers with FFprobe
- Chapter markers plus synchronized previous, next, and chapter selection controls
- Post-download HLS preparation that unlocks playback before conversion finishes
- Automatic NVENC, Quick Sync, VAAPI, AMF, and VideoToolbox detection with CPU fallback
- NVIDIA CUDA hardware decoding plus NVENC encoding, including 10-bit HEVC input
- Byte-range streaming from the companion so the browser can seek efficiently
- Automatic age, cache, storage-limit, and free-space cleanup with per-download pins

## Architecture

```text
Browser A ---- polling/JIP + WebRTC signaling ---- Coordinator (state + snapshot file) ---- Browser B
   |                                                                  |
localhost companion                                              localhost companion
   |                                                                  |
HTTP / magnet download                                           HTTP / magnet download
   |                                                                  |
local file + range stream                                        local file + range stream
   \---------------- peer-to-peer WebRTC room audio ----------------/
```

The coordinator stores session metadata, playback state, and short-lived recipient-only WebRTC
signaling messages. Video bytes and room audio stay between participant machines, except when a
configured TURN server must relay encrypted WebRTC audio. A session token is a bearer secret and expires
seven days after its last participant heartbeat.

## Local development

Requirements: Node.js 24 or newer.

```bash
npm install
npm run dev
```

The coordinator opens at [http://localhost:3000](http://localhost:3000).

For magnet pages, torrent downloads, embedded MKV subtitles, chapters, and browser-ready
video preparation, each watcher installs **WatchPair Companion** from the latest GitHub release:

- Windows: `WatchPair-Companion-Windows-x64-Setup.exe`
- Linux portable: `WatchPair-Companion-Linux-x64.AppImage`
- Debian/Ubuntu: `WatchPair-Companion-Linux-x64.deb`

The app bundles Electron, Node.js, FFmpeg, and FFprobe, manages its own updates, and needs no
separate runtime dependencies. Press **Connect** on the website; the native app opens, asks for
approval, and leaves the room page in place. The companion listens only on `127.0.0.1:41735`; no
port forwarding is needed. Its settings window controls the download folder, retention, storage
limits, startup behavior, hardware transcoder, cleanup, and automatic or manual updates.

During development, start the desktop app with `npm run desktop:dev`, or run only the agent in a
second terminal with `npm run agent`. Without the companion, users can still choose matching local
videos and CORS-enabled direct links can use the browser download fallback.

## Companion settings

```bash
WATCHPAIR_DOWNLOAD_DIR=/path/to/videos \
WATCHPAIR_ORIGINS=https://watch.example.com,http://localhost:3000 \
npm run agent
```

- `WATCHPAIR_DOWNLOAD_DIR` changes the local download folder.
- `WATCHPAIR_ORIGINS` pre-approves a comma-separated list of coordinator origins.
  Normal users approve the current website through the local pairing page instead.
- `WATCHPAIR_AGENT_PORT` changes the localhost port.
- `WATCHPAIR_TORRENT_PORT` and `WATCHPAIR_DHT_PORT` change the peer listener ports
  (TCP 41736 when available; DHT chooses an available UDP port). On Windows, allow the bundled private Node
  runtime through Windows Firewall so participant-shared seeds are reachable.
- `WATCHPAIR_LIBRARY_DIRS` adds external-client download folders, separated by
  the platform path delimiter (`;` on Windows and `:` on macOS/Linux).
- `WATCHPAIR_TRACKERS` overrides the built-in UDP and WebRTC tracker list for locally published torrents.
  With no override, WebTorrent's standard discovery settings are used.
- `WATCHPAIR_FFMPEG_PATH` selects a specific GPU-capable FFmpeg executable.
- `WATCHPAIR_TRANSCODER` accepts `auto`, `cpu`, `nvenc`, `qsv`, `vaapi`,
  `amf`, or `videotoolbox`. The companion validates the requested encoder with
  a tiny real encode and falls back to CPU when it is unavailable.

Room voice works without the companion. The browser requests a microphone only after **Join voice**
is pressed and enables echo cancellation, automatic gain control, noise suppression, and voice
isolation where the browser and operating system expose it. For reliable voice on restrictive or
symmetric-NAT networks, configure STUN/TURN servers on the coordinator:

```bash
WATCHPAIR_ICE_SERVERS='{"iceServers":[{"urls":["stun:stun.example.com:3478"]},{"urls":["turns:turn.example.com:5349"],"username":"watchpair","credential":"secret"}]}'
```

For a VPS-hosted coordinator, every participant runs the companion locally and
uses the website **Connect** action to approve that public HTTPS origin. Current
Chromium browsers are the primary target because localhost private-network
permissions and media codec support vary between browsers.

## Docker and external hosting

The image runs the coordinator website. Participants still run the companion locally so torrent
traffic, media files, FFmpeg, and GPU access remain on their own machines.

Build and run locally:

```bash
docker compose up --build
```

Or deploy a released image from GitHub Container Registry:

```bash
docker login ghcr.io
WATCHPAIR_IMAGE=ghcr.io/etaselia/watchpair:latest docker compose pull
WATCHPAIR_IMAGE=ghcr.io/etaselia/watchpair:latest docker compose up -d --no-build
```

The coordinator listens on port 3000 and exposes `GET /api/health`. Set
`WATCHPAIR_ICE_SERVERS` to the JSON configuration shown above. Put the service behind HTTPS using
Caddy, Traefik, Nginx, or the hosting provider's managed proxy.

Run exactly one coordinator replica. Sessions are held in memory on the coordinator and mirrored to
a JSON snapshot file, so active rooms survive restarts and deploys. Set `WATCHPAIR_SESSION_FILE` to
a writable path inside the container and mount a persistent volume there. The image runs as the
non-root `node` user (UID 1000), so the mounted directory must be writable by UID 1000. Writes are
debounced (about once per second) and atomic (a `.tmp` file is renamed into place), so the on-disk
state stays recent and consistent even when the container is force-killed; only changes from the
final second before a kill can be lost. If the path is unset or unwritable, the coordinator falls
back to in-memory sessions (with an error logged) so the site still works.

With `docker compose`, sessions persist to `./data/sessions.json` (a bind mount). Before the first
`docker compose up`, create that directory owned by UID 1000:

```bash
mkdir -p ./data && sudo chown 1000:1000 ./data
```

## Development and releases

`npm install` configures tracked pre-commit and pre-push hooks. See [CONTRIBUTING.md](CONTRIBUTING.md)
for checks and Conventional Commit guidance. Pull requests must pass lint, type checking, all tests,
and a production Docker build. Release Please prepares semantic-version release pull requests;
merging one publishes tested Windows and Linux desktop installers, updater metadata, the transitional companion ZIP, checksum, and multi-platform GHCR image. Published major
and minor releases deploy to the VPS at 04:07 Europe/Vienna if they are not already live. The
`Deploy VPS` workflow can deploy any published semantic version earlier when its manual approval
checkbox is selected.

## Verification

```bash
npm run typecheck
npm test
npm run lint
```

## Operational notes

- Browsers may require one click before a remote play command can start media.
- Browser-incompatible files are prepared as progressive HLS. Playback unlocks when a contiguous
  two-minute window from the start is ready (or the whole file for shorter videos), while the
  remaining video continues encoding in the background.
- Torrent files are fully downloaded and verified before FFprobe, subtitle discovery, or FFmpeg
  preparation begins. Local torrent creation runs in the background and reports hashing progress.
  A seed is marked ready only after WebTorrent's file store is serving; UDP, DHT, and WebRTC trackers
  provide peer discovery, with WebRTC available for peers behind restrictive NAT.
- Video is encoded once and embedded audio languages are exposed as separate AAC renditions.
  NVIDIA systems use CUDA decoding and NVENC encoding when both work for the selected file.
  Other supported GPU encoders accelerate encoding; the bundled FFmpeg is the universal CPU fallback.
  Prepared segments are cached under `downloads/.watchpair-hls` for later watches.
- MKV text subtitles such as SRT, ASS, and WebVTT are extracted by the companion.
  ASS/SSA tracks use browser-side libass rendering to preserve simultaneous cues, layers,
  coordinates, styles, karaoke effects, and attached fonts. Viewers can disable original ASS
  styling to use WatchPair's accessible caption appearance controls instead. Image-based
  PGS/VobSub tracks still require a separate bitmap renderer and are not supported. Video and
  audio codec support still depends on the browser; remux or transcode releases
  that use unsupported codecs.
- Magnet use exposes each downloader to the torrent swarm. Locally published files
  never pass through the coordinator, but peers and configured trackers can see IP
  addresses and anyone holding the magnet can join the swarm. Use content you have
  the legal right to download and share.
- Companion jobs, local seeds, and direct-download records are restored from
  `downloads/.watchpair-jobs.json` after restart.
- The companion blocks obvious private-network direct-download targets and
  accepts browser requests only from configured origins.

## License

WatchPair is licensed under the [MIT License](LICENSE).
