# WatchPair

[![CI](https://github.com/Etaselia/watchpair/actions/workflows/ci.yml/badge.svg)](https://github.com/Etaselia/watchpair/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

WatchPair is a private two-person watch room for videos that remain on each
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
- Per-file audio and subtitle discovery for MKV and other containers with FFprobe
- Post-download HLS preparation that unlocks playback before conversion finishes
- Automatic NVENC, Quick Sync, VAAPI, AMF, and VideoToolbox detection with CPU fallback
- NVIDIA CUDA hardware decoding plus NVENC encoding, including 10-bit HEVC input
- Byte-range streaming from the companion so the browser can seek efficiently

## Architecture

```text
Browser A ---- polling/JIP + WebRTC signaling ---- Coordinator + D1 / memory ---- Browser B
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

Or deploy a released image from the private GitHub Container Registry package:

```bash
docker login ghcr.io
WATCHPAIR_IMAGE=ghcr.io/etaselia/watchpair:latest docker compose pull
WATCHPAIR_IMAGE=ghcr.io/etaselia/watchpair:latest docker compose up -d --no-build
```

The coordinator listens on port 3000 and exposes `GET /api/health`. Set
`WATCHPAIR_ICE_SERVERS` to the JSON configuration shown above. Put the service behind HTTPS using
Caddy, Traefik, Nginx, or the hosting provider's managed proxy.

Docker sessions are held in memory. Run exactly one coordinator replica; restarts invalidate active
room tokens. Cloudflare Workers deployments use D1 for durable session state and can scale
independently.

### Automated site deployment

The CI workflow publishes the tested `main` commit to Cloudflare Workers only after the application
and Docker jobs pass. Configure the repository's `production` environment with:

- Secret `CLOUDFLARE_ACCOUNT_ID`
- Secret `CLOUDFLARE_API_TOKEN` using Cloudflare's **Edit Cloudflare Workers** template with D1 edit access
- Optional secret `WATCHPAIR_ICE_SERVERS` containing the voice relay JSON shown above
- Repository variable `CLOUDFLARE_DEPLOY_ENABLED=true`
- Optional repository variable `WATCHPAIR_WORKER_NAME` (defaults to `watchpair`)

On its first run, CI creates a Western Europe D1 database named `watchpair`; later deploys discover
and reuse it. The generated Wrangler configuration is deliberately ignored so account resource IDs
do not enter source control.

The managed `chatgpt.site` deployment remains separate because it uses short-lived publishing
credentials that cannot be stored safely in GitHub Actions. Use the Worker URL or attach a custom
domain after enabling automated deployment.

The Docker path uses the same Worker-compatible build with its in-memory fallback store.

## Development and releases

`npm install` configures tracked pre-commit and pre-push hooks. See [CONTRIBUTING.md](CONTRIBUTING.md)
for checks and Conventional Commit guidance. Pull requests must pass lint, type checking, all tests,
and a production Docker build. Release Please prepares semantic-version release pull requests;
merging one publishes the companion ZIP, checksum, and multi-platform GHCR image.

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

## License

WatchPair is licensed under the [MIT License](LICENSE).
