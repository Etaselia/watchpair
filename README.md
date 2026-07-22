# WatchPair

WatchPair is a private two-person watch room for videos that remain on each
participant's own computer. A session keeps source selection, download
readiness, play/pause, seeks, playback speed, audio language, subtitles, and
subtitle timing synchronized.

## What works

- Short session tokens and shareable invite links
- Join-in-progress snapshots after refresh, reconnect, or late arrival
- Local video selection with sampled SHA-256 file matching
- Automatic direct downloads through the local companion, with an OPFS browser
  fallback for CORS-enabled URLs
- Automatic magnet downloads through the local companion using WebTorrent
- Torrent file selection and synchronized selected-file priority
- Per-device progress and a both-ready gate before shared playback
- Server-authoritative play, pause, seek, speed, language, subtitle, and offset
  state
- Drift correction and reconnect recovery in the player
- Local SRT and WebVTT subtitle parsing
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
after 24 hours.

## Local development

Requirements: Node.js 22.13 or newer. Node.js 24 LTS is recommended.

```bash
npm install
npm run dev
```

The coordinator opens at [http://localhost:3000](http://localhost:3000).

For automatic magnet downloads and unrestricted direct downloads, each watcher
also runs the companion in a second terminal:

```bash
npm run agent
```

The companion listens only on `127.0.0.1:41735` and downloads into
`./downloads`. Without it, users can still choose matching local videos and
CORS-enabled direct links can use the browser download fallback.

## Companion settings

```bash
WATCHPAIR_DOWNLOAD_DIR=/path/to/videos \
WATCHPAIR_ORIGINS=https://watch.example.com,http://localhost:3000 \
npm run agent
```

- `WATCHPAIR_DOWNLOAD_DIR` changes the local download folder.
- `WATCHPAIR_ORIGINS` is a comma-separated allowlist for coordinator origins.
- `WATCHPAIR_AGENT_PORT` changes the localhost port.

For a VPS-hosted coordinator, every participant runs the companion locally and
adds the public HTTPS origin to `WATCHPAIR_ORIGINS`. Current Chromium browsers
are the primary target because localhost private-network permissions and media
codec support vary between browsers.

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
- Embedded audio-track switching depends on the container and browser. The
  synchronized language preference is retained even when a particular browser
  cannot expose alternate tracks.
- MKV, HEVC, DTS, ASS, and PGS support varies. Remux or transcode incompatible
  releases to browser-friendly MP4/WebM for this version.
- Magnet use exposes each downloader to the torrent swarm. Use content you have
  the legal right to download and share.
- The companion blocks obvious private-network direct-download targets and
  accepts browser requests only from configured origins.
