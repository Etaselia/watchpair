# WatchPair

WatchPair is a private two-person watch room for videos that remain on each
participant's own computer. A session keeps an ordered download queue, active
file selection, per-item readiness, play/pause, seeks, playback speed, audio language, subtitles, and
subtitle timing synchronized.

## What works

- Short session tokens and shareable invite links
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
- Per-file audio and subtitle discovery for MKV and other containers with FFprobe
- Progressive torrent-to-HLS preparation that unlocks playback before the download finishes
- Automatic NVENC, Quick Sync, VAAPI, AMF, and VideoToolbox detection with CPU fallback
- NVIDIA CUDA hardware decoding plus NVENC encoding, including 10-bit HEVC input
- Byte-range streaming from the companion so the browser can seek efficiently

## Architecture

```text
Browser A ---- polling/JIP ---- Coordinator + D1 / memory ---- polling/JIP ---- Browser B
   |                                                                  |
localhost companion                                              localhost companion
   |                                                                  |
HTTP / magnet download                                           HTTP / magnet download
   |                                                                  |
local file + range stream                                        local file + range stream
```

The coordinator stores only session metadata and playback state. Video bytes
stay on participant machines. A session token is a bearer secret and expires
seven days after its last participant heartbeat.

## Local development

Requirements: Node.js 22.13 or newer. Node.js 24 LTS is recommended.

```bash
npm install
npm run dev
```

The coordinator opens at [http://localhost:3000](http://localhost:3000).

For magnet pages, torrent downloads, and embedded MKV subtitles, each watcher
also runs the companion. During development it can be started in a second terminal:

```bash
npm run agent
```

The companion listens only on `127.0.0.1:41735` and downloads into
`./downloads`. The website offers `watchpair-companion.zip`; on Windows, extract
it and double-click `install-and-start.cmd`, then press **Connect** in WatchPair
and approve the displayed website. No port forwarding is needed. Without the
companion, users can still choose matching local videos and CORS-enabled direct
links can use the browser download fallback.

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
- `WATCHPAIR_LIBRARY_DIRS` adds external-client download folders, separated by
  the platform path delimiter (`;` on Windows and `:` on macOS/Linux).
- `WATCHPAIR_TRACKERS` sets comma-separated trackers for locally published torrents.
  With no override, WebTorrent's standard discovery settings are used.
- `WATCHPAIR_FFMPEG_PATH` selects a specific GPU-capable FFmpeg executable.
- `WATCHPAIR_TRANSCODER` accepts `auto`, `cpu`, `nvenc`, `qsv`, `vaapi`,
  `amf`, or `videotoolbox`. The companion validates the requested encoder with
  a tiny real encode and falls back to CPU when it is unavailable.

For a VPS-hosted coordinator, every participant runs the companion locally and
uses the website **Connect** action to approve that public HTTPS origin. Current
Chromium browsers are the primary target because localhost private-network
permissions and media codec support vary between browsers.

## VPS / Docker

```bash
docker compose up --build
```

The coordinator is then available on port 3000. Put it behind Caddy, Traefik, or
Nginx with HTTPS before exposing it publicly. Standalone sessions are kept in memory, so restarting the coordinator invalidates active tokens.
Hosted Sites deployments use D1 for durable session state.

A hosted Sites deployment uses the `DB` D1 binding declared in
`.openai/hosting.json`. The Docker path uses the same Worker-compatible build
and its local persistent runtime state.

## Verification

```bash
npm run typecheck
npm test
npm run lint
```

## Operational notes

- Browsers may require one click before a remote play command can start media.
- Browser-incompatible files are prepared as progressive HLS. Playback starts from the first
  four-second segments while the remaining video is encoded in the background.
- Selected torrent files are prepared one at a time while downloading; the room unlocks after
  every participant has initial verified HLS segments rather than waiting for 100%.
- Video is encoded once and embedded audio languages are exposed as separate AAC renditions.
  NVIDIA systems use CUDA decoding and NVENC encoding when both work for the selected file.
  Other supported GPU encoders accelerate encoding; the bundled FFmpeg is the universal CPU fallback.
  Prepared segments are cached under `downloads/.watchpair-hls` for later watches.
- MKV text subtitles such as SRT, ASS, and WebVTT are extracted by the companion.
  Image-based PGS/VobSub tracks cannot be rendered as browser text. Video and
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
