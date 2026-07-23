WATCHPAIR COMPANION

Windows
1. Extract this ZIP to a folder you control.
2. Double-click install-and-start.cmd.
3. Leave its terminal window open while watching.
4. Return to WatchPair and press Connect.
5. Approve the website shown in the local pairing page.

The first launch downloads a private Node.js 24 runtime from nodejs.org when
Node is not already installed. Its SHA-256 checksum is verified before use.
It then installs the companion dependencies into this folder.

macOS / Linux
Install Node.js 22.13 or newer, then run:
  chmod +x install-and-start.sh
  ./install-and-start.sh

GPU TRANSCODING

At startup the companion checks a system FFmpeg first, then uses its bundled
CPU-only FFmpeg as a fallback. Install a GPU-enabled FFmpeg in PATH, or set
WATCHPAIR_FFMPEG_PATH to its full path before launching the companion.

Supported encoders:
- NVIDIA: h264_nvenc
- Intel: h264_qsv
- AMD on Linux: h264_vaapi
- AMD on Windows: h264_amf
- macOS: h264_videotoolbox

The companion runs a tiny test encode before selecting an encoder. Its startup
log and the WatchPair queue show the selected transcoder. Set
WATCHPAIR_TRANSCODER to auto, cpu, nvenc, qsv, vaapi, amf, or videotoolbox to
override automatic selection. A failed GPU encode retries with CPU encoding.

Downloads are saved in the downloads folder by default. Queued downloads run
concurrently; completed videos are prepared for browser playback one at a time
in the background. Jobs and local seeds resume after restart. WatchPair can also
publish a selected local file as a torrent; its bytes remain between participant
computers, while torrent peers and trackers can see their IP addresses.

Set WATCHPAIR_LIBRARY_DIRS to additional external-client download folders,
separated by ; on Windows or : on macOS/Linux. Set WATCHPAIR_TRACKERS to a
comma-separated tracker list for locally published torrents.

The companion listens only on 127.0.0.1:41735. Websites cannot use it until you
explicitly approve their origin on the local pairing page. Approved origins are
stored in ~/.watchpair/companion.json.
