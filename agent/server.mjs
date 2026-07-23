import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { BlockList } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { load } from "cheerio";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import WebTorrent from "webtorrent";
import { createHlsPlaybackManager, streamHlsAsset } from "./hls-playback.mjs";
import { publicTranscoder, selectTranscodeRuntime } from "./hardware-acceleration.mjs";
import { createJsonStore } from "./job-store.mjs";
import { fingerprintPath } from "./media-fingerprint.mjs";
import { isSupportedMagnet } from "./torrent-input.mjs";
import { installTorrentPieceRecovery, installWebTorrentSafetyGuards, verifiedTorrentFileProgress } from "./webtorrent-safety.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WATCHPAIR_AGENT_PORT || 41735);
const REQUESTED_TORRENT_PORT = Number(process.env.WATCHPAIR_TORRENT_PORT || PORT + 1);
const DHT_PORT = Number(process.env.WATCHPAIR_DHT_PORT || 0);

async function availableTcpPort(preferredPort) {
  if (!preferredPort) return 0;
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(0));
    probe.listen(preferredPort, "0.0.0.0", () => {
      probe.close(() => resolve(preferredPort));
    });
  });
}

const TORRENT_PORT = await availableTcpPort(REQUESTED_TORRENT_PORT);
const DOWNLOAD_DIR = path.resolve(process.env.WATCHPAIR_DOWNLOAD_DIR || "./downloads");
const CONFIG_PATH = path.resolve(
  process.env.WATCHPAIR_CONFIG_PATH || path.join(homedir(), ".watchpair", "companion.json")
);
const JOBS_PATH = path.join(DOWNLOAD_DIR, ".watchpair-jobs.json");
const IMPORT_DIR = path.join(DOWNLOAD_DIR, ".watchpair-imports");
const LIBRARY_DIRS = Array.from(new Set([
  DOWNLOAD_DIR,
  ...(process.env.WATCHPAIR_LIBRARY_DIRS || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry)),
]));
const DEFAULT_TRACKERS = [
  "udp://open.stealth.si:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.webtorrent.dev",
];
const configuredTrackers = (process.env.WATCHPAIR_TRACKERS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const TRACKERS = configuredTrackers.length ? configuredTrackers : DEFAULT_TRACKERS;
const TRANSCODE_RUNTIME = await selectTranscodeRuntime({ bundledPath: ffmpegStaticPath });
const FFMPEG_PATH = TRANSCODE_RUNTIME.ffmpegPath;
const TRANSCODER = publicTranscoder(TRANSCODE_RUNTIME);
const ALLOW_PRIVATE_DOWNLOADS = process.env.WATCHPAIR_ALLOW_PRIVATE_DOWNLOADS === "1";
const FFPROBE_PATH = process.env.WATCHPAIR_FFPROBE_PATH || ffprobeStatic.path;
const runFile = promisify(execFile);
const ALLOWED_ORIGINS = new Set(
  (process.env.WATCHPAIR_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|ts)$/i;
const DIRECT_MEDIA_EXTENSIONS = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|ts)(?:$|[?#])/i;
const TEXT_SUBTITLE_CODECS = new Set(["ass", "mov_text", "ssa", "subrip", "text", "webvtt"]);
const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addAddress("::1", "ipv6");
PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NETWORKS.addSubnet("fe80::", 10, "ipv6");
const pairingNonces = new Map();
const jobs = new Map();
const libraryEntries = new Map();
const jobStore = createJsonStore(JOBS_PATH);
const preparationQueue = [];
let preparationWorker = null;
installWebTorrentSafetyGuards();
const client = new WebTorrent({
  utp: false,
  torrentPort: TORRENT_PORT,
  dhtPort: DHT_PORT,
  seedOutgoingConnections: true,
});
const hlsPlayback = createHlsPlaybackManager({
  ffmpegPath: FFMPEG_PATH,
  encoder: TRANSCODE_RUNTIME.encoder,
  cacheRoot: path.join(DOWNLOAD_DIR, ".watchpair-hls"),
});
client.on("error", (error) => console.error(`WebTorrent client error: ${error.message}`));
client.on("listening", () => {
  console.log(`Torrent listener ready on TCP ${client.torrentPort}; DHT uses UDP ${client.dhtPort}.`);
});

await mkdir(DOWNLOAD_DIR, { recursive: true });
await mkdir(IMPORT_DIR, { recursive: true });
await mkdir(path.dirname(CONFIG_PATH), { recursive: true });

try {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  for (const origin of config.allowedOrigins || []) ALLOWED_ORIGINS.add(origin);
} catch (error) {
  if (error?.code !== "ENOENT") console.warn(`Could not read ${CONFIG_PATH}: ${error.message}`);
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.has(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    vary: "origin",
  };
}

function sendJson(response, statusCode, value, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(html);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function normalizePairOrigin(value) {
  const url = new URL(String(value || ""));
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Only HTTPS websites and local development origins can be paired.");
  }
  return url.origin;
}

async function persistOrigins() {
  await writeFile(
    CONFIG_PATH,
    JSON.stringify({ allowedOrigins: Array.from(ALLOWED_ORIGINS).sort() }, null, 2),
    { mode: 0o600 }
  );
}

function pairingPage(origin, nonce, paired = false) {
  const safeOrigin = escapeHtml(origin);
  const content = paired
    ? "<h1>Companion connected</h1><p>" + safeOrigin + " can now start downloads and prepare browser-ready video.</p><p>This tab will close automatically.</p><button type=\"button\" onclick=\"window.close()\">Close tab</button><script>window.setTimeout(function(){window.close()},150)</script>"
    : "<p class=\"eyebrow\">WatchPair Companion</p><h1>Connect this website?</h1><p><strong>" + safeOrigin + "</strong> will be allowed to send download requests to this computer.</p><form method=\"post\" action=\"/pair\"><input type=\"hidden\" name=\"origin\" value=\"" + safeOrigin + "\"><input type=\"hidden\" name=\"nonce\" value=\"" + escapeHtml(nonce) + "\"><button type=\"submit\">Connect companion</button></form>";
  return "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>WatchPair Companion</title><style>body{margin:0;background:#10130f;color:#f4f3ed;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{width:min(520px,calc(100% - 40px));border-top:4px solid #c8ff32;padding:32px 0}h1{font-size:38px;margin:8px 0 16px}p{color:#b9bdb3;line-height:1.55}strong{color:#fff;word-break:break-all}.eyebrow{color:#c8ff32;text-transform:uppercase;font-size:12px;font-weight:800}button{display:inline-block;margin-top:20px;background:#c8ff32;color:#10130f;border:0;padding:13px 18px;font-weight:800;cursor:pointer}</style><main>" + content + "</main></html>";
}

function safeName(value) {
  return String(value || "video")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180) || "video";
}

async function assertPublicHttp(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS direct downloads are supported.");
  }
  if (ALLOW_PRIVATE_DOWNLOADS) return url;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Private network download targets are blocked.");
  }

  const addresses = await lookup(host, { all: true, verbatim: true });
  const isPrivate = addresses.some(({ address, family }) =>
    PRIVATE_NETWORKS.check(address, family === 6 ? "ipv6" : "ipv4")
  );
  if (isPrivate) throw new Error("Private network download targets are blocked.");
  return url;
}

async function fetchPublic(value, options = {}) {
  let target = await assertPublicHttp(value);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(target, { ...options, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("A download redirect did not include a destination.");
    target = await assertPublicHttp(new URL(location, target).href);
  }
  throw new Error("The download redirected too many times.");
}

function sourceLabel(value) {
  if (value.startsWith("magnet:")) {
    const name = new URLSearchParams(value.slice(value.indexOf("?") + 1)).get("dn");
    return name ? decodeURIComponent(name.replace(/\+/g, " ")) : "Magnet download";
  }
  const url = new URL(value);
  return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || url.hostname);
}

function decodedCandidates(rawValue) {
  const value = String(rawValue || "")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replaceAll("&amp;", "&");
  const values = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) values.push(decoded);
  } catch {
    // The candidate was not URI encoded.
  }
  return values;
}

function magnetFromCandidate(rawValue) {
  for (const value of decodedCandidates(rawValue)) {
    const match = value.match(/magnet:\?[^\s"\x27<>]+/i);
    const magnet = match?.[0].replace(/[),.;]+$/, "");
    if (magnet && isSupportedMagnet(magnet)) return magnet;
  }
  return null;
}

function mediaFromCandidate(rawValue, baseUrl) {
  for (const value of decodedCandidates(rawValue)) {
    try {
      const target = new URL(value, baseUrl);
      if (DIRECT_MEDIA_EXTENSIONS.test(target.href)) return target.href;
    } catch {
      // Not a URL candidate.
    }
  }
  return null;
}

async function readLimitedResponse(response, limit = 2_000_000) {
  if (!response.body) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("The page is too large to inspect safely.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveSource(rawValue) {
  const value = String(rawValue || "").trim();
  if (/^magnet:\?/i.test(value)) {
    if (!isSupportedMagnet(value)) {
      throw new Error("Magnet link needs a valid BitTorrent v1 info hash (BTIH).");
    }
    return { kind: "magnet", value, label: sourceLabel(value) };
  }

  const initialUrl = await assertPublicHttp(value);
  if (DIRECT_MEDIA_EXTENSIONS.test(initialUrl.href)) {
    return { kind: "direct", value: initialUrl.href, label: sourceLabel(initialUrl.href) };
  }

  const response = await fetchPublic(initialUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/x-bittorrent,video/*;q=0.9,*/*;q=0.5",
      "accept-language": "en-US,en;q=0.8",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WatchPairCompanion/0.3",
    },
  });
  if (!response.ok) throw new Error("The page returned " + response.status + ".");

  const finalUrl = await assertPublicHttp(response.url || initialUrl.href);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("video/") || DIRECT_MEDIA_EXTENSIONS.test(finalUrl.href)) {
    return { kind: "direct", value: finalUrl.href, label: sourceLabel(finalUrl.href) };
  }
  if (contentType.includes("application/x-bittorrent") || /\.torrent(?:$|[?#])/i.test(finalUrl.href)) {
    return { kind: "magnet", value: finalUrl.href, label: sourceLabel(finalUrl.href) };
  }

  const html = await readLimitedResponse(response);
  const document = load(html);
  const candidates = [html];
  document("[href], [data-magnet], [data-url], [data-href]").each((index, element) => {
    for (const attribute of ["href", "data-magnet", "data-url", "data-href"]) {
      const candidate = document(element).attr(attribute);
      if (candidate) candidates.push(candidate);
    }
  });

  for (const candidate of candidates) {
    const magnet = magnetFromCandidate(candidate);
    if (magnet) return { kind: "magnet", value: magnet, label: sourceLabel(magnet) };
  }
  for (const candidate of candidates) {
    const media = mediaFromCandidate(candidate, finalUrl.href);
    if (media) return { kind: "direct", value: media, label: sourceLabel(media) };
  }

  throw new Error("No magnet or direct video link was found on that page.");
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request) {
  return JSON.parse((await readBody(request)) || "{}");
}

function torrentFileName(file) {
  return path.posix.basename(String(file?.path || file?.name || "video").replaceAll("\\", "/"));
}

function fileIdentityKey(index, file) {
  return String(index) + ":" + file.name + ":" + file.size;
}

function selectedFileKey(job) {
  const media = selectedJobFile(job);
  return fileIdentityKey(job.selectedIndex, media);
}

function fileIdentityFingerprint(job, index, file) {
  return job.identityFingerprintKey === fileIdentityKey(index, file)
    ? job.identityFingerprint
    : null;
}

async function identifySelectedFile(job, index = job.selectedIndex) {
  if (index === null || index !== job.selectedIndex) return null;
  const selectionKey = selectedFileKey(job);
  if (job.identityFingerprint && job.identityFingerprintKey === selectionKey) {
    return job.identityFingerprint;
  }
  if (job.identityFingerprintPromise && job.identityFingerprintPromiseKey === selectionKey) {
    return job.identityFingerprintPromise;
  }

  let promise;
  promise = fingerprintPath(jobFile(job, index).path)
    .then((fingerprint) => {
      if (job.selectedIndex === index && selectedFileKey(job) === selectionKey) {
        job.identityFingerprint = fingerprint;
        job.identityFingerprintKey = selectionKey;
        job.updatedAt = Date.now();
        persistJobs();
      }
      return fingerprint;
    })
    .finally(() => {
      if (job.identityFingerprintPromise === promise) {
        job.identityFingerprintPromise = null;
        job.identityFingerprintPromiseKey = null;
      }
    });
  job.identityFingerprintPromise = promise;
  job.identityFingerprintPromiseKey = selectionKey;
  return promise;
}

async function completeSelectedFile(job, index = job.selectedIndex) {
  if (index === null || index !== job.selectedIndex) return;
  try {
    await identifySelectedFile(job, index);
    if (index !== job.selectedIndex) return;
    job.status = "ready";
    job.updatedAt = Date.now();
    void queueSubtitleProbe(job);
    queueBackgroundPreparation(job);
  } catch (error) {
    if (index !== job.selectedIndex) return;
    job.status = "error";
    job.error = error instanceof Error ? error.message : "Could not identify the completed media file.";
    job.updatedAt = Date.now();
  }
}

function selectTorrentFile(job, index) {
  const file = job.torrent?.files[index];
  if (!file) throw new Error("Torrent file not found.");
  job.torrent.files.forEach((item) => {
    if (item === file) item.select(10);
    else if (VIDEO_EXTENSIONS.test(item.name)) item.select(1);
    else item.deselect();
  });
  job.selectedIndex = index;
  job.identityFingerprint = null;
  job.identityFingerprintKey = null;
  job.audioTracks = [];
  job.subtitleTracks = [];
  job.videoCodec = null;
  job.subtitleStatus = "waiting";
  job.subtitleError = null;
  job.subtitleProbeKey = null;
  job.preparation = { status: "waiting", error: null, encoder: null, fallback: false };
  job.status = "downloading";
  job.updatedAt = Date.now();
  if (file.done) void completeSelectedFile(job, index);
}

function jobFile(job, index) {
  if (job.kind === "magnet") {
    const file = job.torrent?.files[index];
    if (!file) throw new Error("Torrent file not found.");
    const root = path.resolve(job.torrent.path || path.join(DOWNLOAD_DIR, job.id));
    const filePath = path.resolve(root, file.path);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      throw new Error("Torrent file path escaped its download directory.");
    }
    return { path: filePath, name: torrentFileName(file), size: file.length };
  }
  if (!job.file || index !== 0) throw new Error("Downloaded file not found.");
  return job.file;
}

function selectedJobFile(job) {
  if (job.selectedIndex === null) throw new Error("Select a media file first.");
  return jobFile(job, job.selectedIndex);
}

function streamTrackLabel(stream, fallback) {
  const title = String(stream.tags?.title || "").trim();
  const language = String(stream.tags?.language || "und").toLowerCase();
  return title || (language === "und" ? fallback : language.toUpperCase());
}

async function probeSubtitleTracks(job) {
  const media = selectedJobFile(job);
  const selectionKey = selectedFileKey(job);
  if (job.subtitleProbeKey === selectionKey && job.subtitleStatus === "ready") return;

  job.subtitleProbeKey = selectionKey;
  job.subtitleStatus = "probing";
  job.subtitleError = null;
  job.audioTracks = [];
  job.subtitleTracks = [];
  job.updatedAt = Date.now();

  const isStillSelected = () => {
    try {
      return selectedFileKey(job) === selectionKey;
    } catch {
      return false;
    }
  };

  try {
    const result = await runFile(
      FFPROBE_PATH,
      ["-v", "error", "-print_format", "json", "-show_streams", media.path],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    if (!isStillSelected()) return;

    const metadata = JSON.parse(result.stdout || "{}");
    const videoStream = (metadata.streams || []).find((stream) => stream.codec_type === "video");
    job.videoCodec = String(videoStream?.codec_name || "unknown");
    job.audioTracks = (metadata.streams || [])
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        id: String(stream.index),
        streamIndex: Number(stream.index),
        language: String(stream.tags?.language || "und").toLowerCase(),
        label: streamTrackLabel(stream, "Audio track"),
        codec: String(stream.codec_name || "unknown"),
        channels: Number(stream.channels || 0),
        default: Boolean(stream.disposition?.default),
      }));
    job.subtitleTracks = (metadata.streams || [])
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream) => {
        const codec = String(stream.codec_name || "unknown");
        const language = String(stream.tags?.language || "und").toLowerCase();
        return {
          id: String(stream.index),
          streamIndex: Number(stream.index),
          language,
          label: streamTrackLabel(stream, "Embedded subtitles"),
          codec,
          supported: TEXT_SUBTITLE_CODECS.has(codec),
          default: Boolean(stream.disposition?.default),
          forced: Boolean(stream.disposition?.forced),
          url: "http://" + HOST + ":" + PORT + "/downloads/" + encodeURIComponent(job.id) + "/subtitles/" + stream.index + ".vtt",
        };
      });
    job.subtitleStatus = "ready";
  } catch (error) {
    if (!isStillSelected()) return;
    job.subtitleStatus = "error";
    job.subtitleError = error instanceof Error ? error.message : "Could not inspect embedded media tracks.";
  } finally {
    if (isStillSelected()) job.updatedAt = Date.now();
  }
}

function queueSubtitleProbe(job) {
  const selectionKey = selectedFileKey(job);
  if (job.subtitleProbeKey === selectionKey && job.subtitleStatus === "ready") {
    return Promise.resolve();
  }
  if (job.subtitleProbePromise && job.subtitleProbePromiseKey === selectionKey) {
    return job.subtitleProbePromise;
  }

  let promise;
  promise = probeSubtitleTracks(job).finally(() => {
    if (job.subtitleProbePromise === promise) {
      job.subtitleProbePromise = null;
      job.subtitleProbePromiseKey = null;
    }
  });
  job.subtitleProbePromise = promise;
  job.subtitleProbePromiseKey = selectionKey;
  return promise;
}

async function subtitleFile(job, trackId) {
  await queueSubtitleProbe(job);
  const track = job.subtitleTracks.find((item) => item.id === trackId);
  if (!track) throw new Error("Embedded subtitle track not found.");
  if (!track.supported) {
    throw new Error("This image-based subtitle track cannot be converted to browser text.");
  }

  const media = selectedJobFile(job);
  const directory = path.join(DOWNLOAD_DIR, ".watchpair-subtitles", job.id);
  const output = path.join(directory, String(job.selectedIndex) + "-" + track.id + ".vtt");
  await mkdir(directory, { recursive: true });
  try {
    await stat(output);
  } catch {
    await runFile(
      FFMPEG_PATH,
      ["-v", "error", "-y", "-i", media.path, "-map", "0:" + track.streamIndex, "-f", "webvtt", output],
      { maxBuffer: 8 * 1024 * 1024 }
    );
  }
  return output;
}

function needsHlsPlayback(job, fileName) {
  const extension = path.extname(fileName).toLowerCase();
  const audioTracks = job.audioTracks || [];
  if (
    [".mp4", ".m4v", ".mov"].includes(extension) &&
    job.videoCodec === "h264" &&
    audioTracks.length <= 1 &&
    (!audioTracks[0] || ["aac", "mp3", "opus"].includes(audioTracks[0].codec))
  ) {
    return false;
  }
  if (
    extension === ".webm" &&
    ["av1", "vp8", "vp9"].includes(job.videoCodec) &&
    audioTracks.length <= 1 &&
    (!audioTracks[0] || ["opus", "vorbis"].includes(audioTracks[0].codec))
  ) {
    return false;
  }
  return true;
}

function torrentFiles(job) {
  if (!job.torrent) return [];
  return job.torrent.files.map((file, index) => {
    const progress = verifiedTorrentFileProgress(file);
    return {
      index,
      name: torrentFileName(file),
      size: file.length,
      downloaded: Math.round(file.length * progress),
      progress: Math.round(progress * 1000) / 10,
      ready: Boolean(file.done),
      selected: index === job.selectedIndex,
      fingerprint: fileIdentityFingerprint(job, index, { name: torrentFileName(file), size: file.length }),
      streamUrl: `http://${HOST}:${PORT}/stream/${encodeURIComponent(job.id)}/${index}`,
      hlsUrl: needsHlsPlayback(job, file.path || file.name)
        ? `http://${HOST}:${PORT}/hls/${encodeURIComponent(job.id)}/${index}/master.m3u8`
        : null,
    };
  });
}

function snapshot(job) {
  const files =
    job.kind === "magnet"
      ? torrentFiles(job)
      : job.file
        ? [{
            index: 0,
            name: job.file.name,
            size: job.file.size,
            downloaded: job.downloaded,
            progress: job.file.size ? Math.round((job.downloaded / job.file.size) * 1000) / 10 : 0,
            ready: job.status === "ready" && job.downloaded === job.file.size,
            selected: true,
            fingerprint: fileIdentityFingerprint(job, 0, job.file),
            streamUrl: `http://${HOST}:${PORT}/stream/${encodeURIComponent(job.id)}/0`,
            hlsUrl: needsHlsPlayback(job, job.file.name)
              ? `http://${HOST}:${PORT}/hls/${encodeURIComponent(job.id)}/0/master.m3u8`
              : null,
          }]
        : [];

  const selected = files.find((file) => file.selected);
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: selected?.progress || 0,
    infoHash: job.torrent?.infoHash || null,
    magnetURI: job.torrent?.magnetURI || job.value || null,
    seed: Boolean(job.seed),
    seedState: job.seed
      ? job.status === "error"
        ? "error"
        : !job.value
          ? "creating"
          : !job.torrent?.ready
            ? "starting"
            : job.torrent.numPeers > 0
              ? "uploading"
              : "seeding"
      : null,
    peers: job.torrent?.numPeers || 0,
    uploadSpeed: job.torrent?.uploadSpeed || 0,
    uploaded: job.torrent?.uploaded || 0,
    creationProgress: job.torrentCreationProgress || 0,
    trackerAnnounces: job.trackerAnnounces || 0,
    trackerWarnings: job.trackerWarnings || [],
    seedStartedAt: job.seedStartedAt,
    platform: process.platform,
    torrentPort: client.torrentPort || TORRENT_PORT,
    dhtPort: client.dhtPort || DHT_PORT,
    webRtcSupported: WebTorrent.WEBRTC_SUPPORT,
    identityFingerprint: job.identityFingerprint || null,
    error: job.error || null,
    subtitleStatus: job.subtitleStatus,
    subtitleError: job.subtitleError,
    audioTracks: job.audioTracks || [],
    subtitles: job.subtitleTracks || [],
    preparation: job.preparation,
    transcoder: TRANSCODER,
    verification: {
      diskInvalidations: job.diskInvalidations,
      peerFailures: job.peerFailures,
      peersRejected: job.peersRejected,
    },
    files,
    updatedAt: job.updatedAt,
  };
}

function startTorrent(job) {
  job.status = "metadata";
  let torrent;
  try {
    torrent = client.add(job.value, { path: path.join(DOWNLOAD_DIR, job.id) });
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : "Torrent could not be started.";
    job.updatedAt = Date.now();
    return;
  }
  job.torrent = torrent;
  installTorrentPieceRecovery(
    torrent,
    () => torrent.files?.[job.selectedIndex],
    ({ reason, disconnected }) => {
      job.status = "downloading";
      if (reason === "disk-verification") job.diskInvalidations += 1;
      if (reason === "peer-verification") {
        job.peerFailures += 1;
        job.peersRejected += disconnected;
        job.warning = disconnected
          ? "Rejected a peer that supplied corrupt torrent data; retrying the piece."
          : "A torrent piece failed verification; retrying it from another peer.";
      }
      job.updatedAt = Date.now();
    }
  );

  torrent.on("metadata", () => {
    const videos = torrent.files
      .map((file, index) => ({ index, size: file.length, video: VIDEO_EXTENSIONS.test(file.name) }))
      .sort((a, b) => Number(b.video) - Number(a.video) || b.size - a.size);
    if (videos[0]) selectTorrentFile(job, videos[0].index);
    torrent.files.forEach((file, index) => {
      file.on("done", () => {
        if (job.selectedIndex !== index) return;
        void completeSelectedFile(job, index);
      });
    });
    job.status = "downloading";
    if (torrent.files[job.selectedIndex]?.done) void completeSelectedFile(job);
    job.updatedAt = Date.now();
  });
  torrent.on("download", () => {
    if (job.status !== "ready") job.status = "downloading";
    job.updatedAt = Date.now();
  });
  torrent.on("done", () => {
    void completeSelectedFile(job);
  });
  torrent.on("warning", (error) => {
    job.warning = error.message;
    job.updatedAt = Date.now();
  });
  torrent.on("error", (error) => {
    job.status = "error";
    job.error = error.message;
    job.updatedAt = Date.now();
  });
}

async function startDirect(job) {
  try {
    job.status = "downloading";
    const target = await assertPublicHttp(job.value);
    const response = await fetchPublic(target);
    await assertPublicHttp(response.url || target.href);
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with status ${response.status}.`);
    }

    const size = Number(response.headers.get("content-length")) || 0;
    const fileName = safeName(job.label || decodeURIComponent(target.pathname.split("/").pop() || "video.mp4"));
    const directory = path.join(DOWNLOAD_DIR, job.id);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    const writable = createWriteStream(filePath);
    job.file = {
      name: fileName,
      size,
      path: filePath,
      type: response.headers.get("content-type") || "application/octet-stream",
    };

    for await (const chunk of response.body) {
      job.downloaded += chunk.length;
      job.updatedAt = Date.now();
      if (!writable.write(chunk)) await once(writable, "drain");
    }
    writable.end();
    await once(writable, "finish");

    const completed = await stat(filePath);
    job.file.size = completed.size;
    job.downloaded = completed.size;
    job.selectedIndex = 0;
    job.identityFingerprint = null;
    job.identityFingerprintKey = null;
    await identifySelectedFile(job);
    job.status = "ready";
    job.updatedAt = Date.now();
    await queueSubtitleProbe(job);
    queueBackgroundPreparation(job);
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : "Direct download failed.";
    job.updatedAt = Date.now();
  }
}

function createJob(source) {
  const kind = source.kind === "magnet" ? "magnet" : "direct";
  const job = {
    id: String(source.id),
    kind,
    value: String(source.value || "").trim(),
    label: String(source.label || "video").slice(0, 180),
    seed: Boolean(source.seed),
    seedPath: source.seedPath || null,
    identityFingerprint: source.identityFingerprint || null,
    identityFingerprintKey: source.identityFingerprintKey || null,
    identityFingerprintPromise: null,
    identityFingerprintPromiseKey: null,
    status: "queued",
    error: null,
    downloaded: 0,
    selectedIndex: null,
    torrent: null,
    file: null,
    audioTracks: [],
    subtitleTracks: [],
    videoCodec: null,
    subtitleStatus: "waiting",
    subtitleError: null,
    subtitleProbeKey: null,
    subtitleProbePromise: null,
    subtitleProbePromiseKey: null,
    diskInvalidations: 0,
    peerFailures: 0,
    peersRejected: 0,
    audioRenderPromises: new Map(),
    torrentCreationProgress: 0,
    trackerAnnounces: 0,
    trackerWarnings: [],
    seedStartedAt: null,
    seedReannounceTimer: null,
    preparation: { status: "waiting", error: null, encoder: null, fallback: false },
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function persistedJobs() {
  return Array.from(jobs.values()).map((job) => ({
    id: job.id,
    kind: job.kind,
    value: job.value,
    label: job.label,
    seed: Boolean(job.seed),
    seedPath: job.seedPath,
    identityFingerprint: job.identityFingerprint,
    identityFingerprintKey: job.identityFingerprintKey,
    selectedIndex: job.selectedIndex,
    file: job.file
      ? { name: job.file.name, size: job.file.size, path: job.file.path, type: job.file.type }
      : null,
  }));
}

function persistJobs() {
  jobStore.schedule(persistedJobs());
}

async function addDownload(source) {
  const id = String(source?.id || "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error("Invalid source id.");
  if (jobs.has(id)) return jobs.get(id);

  const kind = source.kind === "magnet" ? "magnet" : "direct";
  const value = String(source.value || "").trim();
  if (kind === "magnet") {
    if (/^magnet:\?/i.test(value) && !isSupportedMagnet(value)) {
      throw new Error("Magnet link needs a valid BitTorrent v1 info hash (BTIH).");
    }
    if (!/^magnet:\?/i.test(value) && !/^https?:\/\//i.test(value)) {
      throw new Error("Invalid magnet or torrent source.");
    }
  }

  const job = createJob({ id, kind, value, label: source.label });
  if (kind === "magnet") startTorrent(job);
  else void startDirect(job);
  persistJobs();
  return job;
}

function validJobId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error("Invalid source id.");
  return id;
}

function importPartPath(id) {
  return path.join(IMPORT_DIR, validJobId(id) + ".part");
}

async function receiveImportChunk(request, id, url) {
  const offset = Number(url.searchParams.get("offset"));
  const total = Number(url.searchParams.get("total"));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total <= 0 || offset > total) {
    throw new Error("Invalid import range.");
  }

  const partial = importPartPath(id);
  if (offset === 0) await rm(partial, { force: true });
  const existing = await stat(partial).then((info) => info.size).catch((error) => {
    if (error?.code === "ENOENT") return 0;
    throw error;
  });
  if (existing !== offset) {
    const error = new Error(`Import offset mismatch; resume from ${existing}.`);
    error.resumeOffset = existing;
    throw error;
  }

  const writable = createWriteStream(partial, { flags: offset === 0 ? "w" : "a" });
  let received = 0;
  try {
    for await (const chunk of request) {
      received += chunk.length;
      if (offset + received > total) throw new Error("Import exceeded its declared size.");
      if (!writable.write(chunk)) await once(writable, "drain");
    }
    writable.end();
    await once(writable, "finish");
  } catch (error) {
    writable.destroy();
    throw error;
  }
  return { uploaded: offset + received, total };
}

async function seedLocalFile({ id, filePath, label }) {
  validJobId(id);
  if (jobs.has(id)) return jobs.get(id);

  const resolvedPath = path.resolve(filePath);
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error("The selected library entry is not a file.");

  const job = createJob({
    id,
    kind: "magnet",
    value: "",
    label: label || path.basename(resolvedPath),
    seed: true,
    seedPath: resolvedPath,
  });
  job.seed = true;
  job.seedPath = resolvedPath;
  job.status = "metadata";
  job.selectedIndex = 0;
  job.downloaded = info.size;
  job.seedStartedAt = Date.now();
  job.identityFingerprint = await fingerprintPath(resolvedPath);
  job.identityFingerprintKey = "0:" + path.basename(resolvedPath) + ":" + info.size;

  const options = {
    pieceLength: 1024 * 1024,
    onProgress(hashed, total) {
      job.torrentCreationProgress = total > 0
        ? Math.min(100, Math.round((hashed / total) * 1000) / 10)
        : 0;
      job.updatedAt = Date.now();
    },
  };
  if (TRACKERS.length) options.announce = TRACKERS;
  try {
    let metadataPublished = false;
    let serving = false;
    const publishMetadata = (readyTorrent) => {
      if (metadataPublished || !readyTorrent.infoHash || !readyTorrent.torrentFile) return;
      metadataPublished = true;
      job.torrent = readyTorrent;
      job.value = readyTorrent.magnetURI;
      job.torrentCreationProgress = 100;
      job.updatedAt = Date.now();
      const torrentPath = path.join(path.dirname(resolvedPath), ".watchpair-" + id + ".torrent");
      void writeFile(torrentPath, readyTorrent.torrentFile).catch((error) => {
        console.warn(`Could not persist torrent metadata for ${job.label}: ${error.message}`);
      });
      persistJobs();
    };
    const markServing = (readyTorrent) => {
      if (serving) return;
      publishMetadata(readyTorrent);
      serving = true;
      job.status = "ready";
      job.updatedAt = Date.now();
      void queueSubtitleProbe(job);
      queueBackgroundPreparation(job);
      persistJobs();
    };
    const torrent = client.seed(resolvedPath, options, markServing);
    job.torrent = torrent;
    torrent.once("metadata", () => publishMetadata(torrent));
    torrent.once("ready", () => markServing(torrent));
    torrent.on("trackerAnnounce", () => {
      job.trackerAnnounces += 1;
      job.updatedAt = Date.now();
    });
    torrent.on("wire", () => {
      job.updatedAt = Date.now();
    });
    torrent.on("warning", (error) => {
      const message = String(error?.message || error).slice(0, 240);
      job.trackerWarnings = [...job.trackerWarnings.filter((item) => item !== message), message].slice(-5);
      job.updatedAt = Date.now();
    });
    torrent.once("error", (error) => {
      job.status = "error";
      job.error = error.message;
      job.updatedAt = Date.now();
    });
    job.seedReannounceTimer = setInterval(() => {
      if (torrent.destroyed || torrent.numPeers > 0) return;
      torrent.discovery?.tracker?.update({ numwant: 50 });
    }, 25_000);
    job.seedReannounceTimer.unref?.();
    torrent.on("upload", () => {
      job.updatedAt = Date.now();
    });
  } catch (error) {
    jobs.delete(id);
    throw error;
  }

  return job;
}

async function finalizeImport(id, body) {
  validJobId(id);
  const name = safeName(body?.name || "video");
  const expectedSize = Number(body?.size);
  const partial = importPartPath(id);
  const info = await stat(partial);
  if (!Number.isSafeInteger(expectedSize) || info.size !== expectedSize) {
    throw new Error(`Import is incomplete; received ${info.size} of ${expectedSize || 0} bytes.`);
  }

  const directory = path.join(DOWNLOAD_DIR, id);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  await rm(target, { force: true });
  await rename(partial, target);
  return seedLocalFile({ id, filePath: target, label: name });
}

async function walkLibrary(root, directory, query, results, depth = 0) {
  if (depth > 6 || results.length >= 300) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= 300) return;
    if (entry.name.startsWith(".watchpair")) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkLibrary(root, candidate, query, results, depth + 1);
      continue;
    }
    if (!entry.isFile() || !VIDEO_EXTENSIONS.test(entry.name)) continue;
    if (query && !entry.name.toLowerCase().includes(query)) continue;
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved || (resolved !== root && !resolved.startsWith(root + path.sep))) continue;
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) continue;
    const libraryId = createHash("sha256").update(resolved).digest("hex").slice(0, 24);
    const item = { id: libraryId, name: entry.name, size: info.size };
    libraryEntries.set(libraryId, { ...item, path: resolved });
    results.push(item);
  }
}

async function scanLibrary(queryValue) {
  const query = String(queryValue || "").trim().toLowerCase();
  const results = [];
  libraryEntries.clear();
  for (const configuredRoot of LIBRARY_DIRS) {
    const root = await realpath(configuredRoot).catch(() => null);
    if (root) await walkLibrary(root, root, query, results);
  }
  return results.sort((left, right) => left.name.localeCompare(right.name));
}

async function attachLibraryFile({ id, entry, label }) {
  validJobId(id);
  if (jobs.has(id)) await stopJob(id);
  const info = await stat(entry.path);
  const job = createJob({
    id,
    kind: "direct",
    value: entry.path,
    label: label || entry.name,
  });
  job.file = {
    name: entry.name,
    size: info.size,
    path: entry.path,
    type: contentType(entry.name),
  };
  job.downloaded = info.size;
  job.selectedIndex = 0;
  job.identityFingerprint = await fingerprintPath(entry.path);
  job.identityFingerprintKey = selectedFileKey(job);
  job.status = "ready";
  job.updatedAt = Date.now();
  void queueSubtitleProbe(job);
  queueBackgroundPreparation(job);
  persistJobs();
  return job;
}

async function stopJob(id, { deleteFiles = false } = {}) {
  const job = jobs.get(validJobId(id));
  if (!job) return false;
  if (job.seedReannounceTimer) clearInterval(job.seedReannounceTimer);
  if (job.torrent && !job.torrent.destroyed) {
    await new Promise((resolve) => job.torrent.destroy(resolve));
  }
  jobs.delete(id);
  const queueIndex = preparationQueue.indexOf(job);
  if (queueIndex >= 0) preparationQueue.splice(queueIndex, 1);
  if (deleteFiles && !job.seedPath) {
    await rm(path.join(DOWNLOAD_DIR, id), { recursive: true, force: true });
  }
  persistJobs();
  return true;
}

async function retryJob(id) {
  const job = jobs.get(validJobId(id));
  if (!job) throw new Error("Download not found.");
  if (job.seed) throw new Error("A local seed does not need to be retried.");
  const source = { id: job.id, kind: job.kind, value: job.value, label: job.label };
  await stopJob(id);
  return addDownload(source);
}

async function restoreJobs() {
  const records = await jobStore.load([]);
  if (!Array.isArray(records)) return;
  for (const record of records.slice(0, 100)) {
    try {
      if (record.seed && record.seedPath) {
        await seedLocalFile({
          id: record.id,
          filePath: record.seedPath,
          label: record.label,
        });
      } else if (record.kind === "magnet") {
        await addDownload(record);
      } else if (record.file?.path) {
        const info = await stat(record.file.path);
        const job = createJob(record);
        job.file = { ...record.file, size: info.size };
        job.downloaded = info.size;
        job.selectedIndex = 0;
        job.identityFingerprint = null;
        job.identityFingerprintKey = null;
        await identifySelectedFile(job);
        job.status = "ready";
        void queueSubtitleProbe(job);
        queueBackgroundPreparation(job);
      } else {
        await addDownload(record);
      }
    } catch (error) {
      console.warn(`Could not restore companion job ${record?.id || "unknown"}: ${error.message}`);
    }
  }
  persistJobs();
}

function contentType(fileName, fallback = "application/octet-stream") {
  const extension = path.extname(fileName).toLowerCase();
  return {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
  }[extension] || fallback;
}

async function renderAudioPlayback(job, fileIndex, track) {
  const media = jobFile(job, fileIndex);
  const directory = path.join(DOWNLOAD_DIR, ".watchpair-media", job.id);
  const output = path.join(directory, String(fileIndex) + "-browser-v2-audio-" + track.id + ".mp4");
  const partial = output + ".partial.mp4";
  await mkdir(directory, { recursive: true });

  try {
    const existing = await stat(output);
    if (existing.size > 0) return output;
  } catch {
    // The selected audio variant has not been prepared yet.
  }

  await rm(partial, { force: true });
  try {
    const videoArgs = job.videoCodec === "h264"
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
    await runFile(
      FFMPEG_PATH,
      [
        "-v", "error", "-y", "-i", media.path,
        "-map", "0:v:0", "-map", "0:" + track.streamIndex,
        "-sn", "-dn", ...videoArgs, "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", partial,
      ],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    await rename(partial, output);
    return output;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function preparedAudioFile(job, fileIndex, trackId) {
  if (job.selectedIndex !== fileIndex) throw new Error("That media file is no longer selected.");
  const ready = job.kind === "magnet"
    ? Boolean(job.torrent?.files[fileIndex]?.done)
    : job.status === "ready";
  if (!ready) throw new Error("The selected media file is not ready.");
  await queueSubtitleProbe(job);

  const track = job.audioTracks.find((item) => item.id === trackId);
  if (!track) throw new Error("Embedded audio track not found.");
  const key = String(fileIndex) + ":" + track.id;
  let promise = job.audioRenderPromises.get(key);
  if (!promise) {
    promise = renderAudioPlayback(job, fileIndex, track);
    job.audioRenderPromises.set(key, promise);
  }
  try {
    return await promise;
  } finally {
    if (job.audioRenderPromises.get(key) === promise) job.audioRenderPromises.delete(key);
  }
}

async function hlsDescriptor(job, fileIndex) {
  if (job.selectedIndex !== fileIndex) throw new Error("That media file is no longer selected.");
  const ready = job.kind === "magnet"
    ? Boolean(job.torrent?.files[fileIndex]?.done)
    : job.status === "ready";
  if (!ready) throw new Error("The selected media file is not ready.");
  await queueSubtitleProbe(job);
  const media = jobFile(job, fileIndex);
  return {
    jobId: job.id,
    fileIndex,
    fileSize: media.size,
    inputPath: media.path,
    videoCodec: job.videoCodec,
    audioTracks: job.audioTracks,
  };
}

async function prepareQueuedJob(job) {
  if (job.selectedIndex === null) return;
  const selectionKey = selectedFileKey(job);
  const isStillSelected = () => {
    try {
      return selectedFileKey(job) === selectionKey;
    } catch {
      return false;
    }
  };

  try {
    job.preparation = { status: "preparing", error: null, encoder: null, fallback: false };
    job.updatedAt = Date.now();
    await queueSubtitleProbe(job);
    if (!isStillSelected()) return;
    const media = selectedJobFile(job);
    if (!needsHlsPlayback(job, media.name)) {
      job.preparation = {
        status: "direct",
        error: null,
        encoder: { id: "copy", label: "Direct browser playback", hardware: false },
        fallback: false,
      };
      return;
    }

    const result = await hlsPlayback.prepare(await hlsDescriptor(job, job.selectedIndex));
    if (isStillSelected()) job.preparation = { ...result, error: null };
  } catch (error) {
    if (!isStillSelected()) return;
    job.preparation = {
      status: "error",
      error: error instanceof Error ? error.message : "Browser preparation failed.",
      encoder: null,
      fallback: false,
    };
  } finally {
    job.updatedAt = Date.now();
  }
}

async function drainPreparationQueue() {
  while (preparationQueue.length) {
    const job = preparationQueue.shift();
    if (!job || job.preparation.status !== "queued") continue;
    await prepareQueuedJob(job);
  }
}

function startPreparationWorker() {
  if (preparationWorker) return;
  preparationWorker = drainPreparationQueue().finally(() => {
    preparationWorker = null;
    if (preparationQueue.length) startPreparationWorker();
  });
}

function queueBackgroundPreparation(job) {
  if (job.selectedIndex === null || !["waiting", "error"].includes(job.preparation.status)) return;
  job.preparation = { status: "queued", error: null, encoder: null, fallback: false };
  job.updatedAt = Date.now();
  preparationQueue.push(job);
  startPreparationWorker();
}

function pipeResponseStream(stream, response) {
  const onResponseClose = () => {
    if (!stream.destroyed) stream.destroy();
  };
  const onStreamError = (error) => {
    if (!response.destroyed) response.destroy(error);
  };

  stream.on("error", onStreamError);
  stream.once("close", () => response.off("close", onResponseClose));
  response.once("close", onResponseClose);
  stream.pipe(response);
}

async function streamFile(request, response, job, fileIndex, headers, audioTrackId) {
  let fileName;
  let size;
  let createStream;
  let fallbackType;

  if (audioTrackId) {
    if (!/^\d+$/.test(audioTrackId)) throw new Error("Invalid audio track.");
    const audioPath = await preparedAudioFile(job, fileIndex, audioTrackId);
    const info = await stat(audioPath);
    fileName = path.parse(jobFile(job, fileIndex).name).name + ".mp4";
    size = info.size;
    fallbackType = "video/mp4";
    createStream = (options) => createReadStream(audioPath, options);
  } else if (job.kind === "magnet") {
    const file = job.torrent?.files[fileIndex];
    if (!file) throw new Error("Torrent file not found.");
    fileName = file.name;
    size = file.length;
    createStream = (options) => file.createReadStream(options);
  } else {
    if (!job.file || fileIndex !== 0) throw new Error("Downloaded file not found.");
    fileName = job.file.name;
    size = job.file.size;
    fallbackType = job.file.type;
    createStream = (options) => createReadStream(job.file.path, options);
  }

  const range = request.headers.range;
  const baseHeaders = {
    ...headers,
    "accept-ranges": "bytes",
    "content-type": contentType(fileName, fallbackType),
    "content-disposition": "inline; filename=\"" + safeName(fileName) + "\"",
  };

  if (!range) {
    response.writeHead(200, { ...baseHeaders, "content-length": size });
    pipeResponseStream(createStream({ start: 0, end: size - 1 }), response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { ...baseHeaders, "content-range": "bytes */" + size });
    response.end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    response.writeHead(416, { ...baseHeaders, "content-range": "bytes */" + size });
    response.end();
    return;
  }

  response.writeHead(206, {
    ...baseHeaders,
    "content-length": end - start + 1,
    "content-range": "bytes " + start + "-" + end + "/" + size,
  });
  pipeResponseStream(createStream({ start, end }), response);
}

await restoreJobs();
const persistenceTimer = setInterval(persistJobs, 2_000);
persistenceTimer.unref?.();

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://" + HOST + ":" + PORT);

  if (request.method === "GET" && url.pathname === "/pair") {
    try {
      const origin = normalizePairOrigin(url.searchParams.get("origin"));
      const nonce = randomUUID();
      pairingNonces.set(nonce, { origin, expiresAt: Date.now() + 5 * 60_000 });
      sendHtml(response, 200, pairingPage(origin, nonce));
    } catch (error) {
      sendHtml(response, 400, "<!doctype html><title>WatchPair Companion</title><p>" + escapeHtml(error.message) + "</p>");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/pair") {
    try {
      const form = new URLSearchParams(await readBody(request));
      const origin = normalizePairOrigin(form.get("origin"));
      const nonce = String(form.get("nonce") || "");
      const pending = pairingNonces.get(nonce);
      pairingNonces.delete(nonce);
      if (!pending || pending.origin !== origin || pending.expiresAt < Date.now()) {
        throw new Error("This pairing request expired. Return to WatchPair and try again.");
      }
      ALLOWED_ORIGINS.add(origin);
      await persistOrigins();
      sendHtml(response, 200, pairingPage(origin, "", true));
    } catch (error) {
      sendHtml(response, 400, "<!doctype html><title>WatchPair Companion</title><p>" + escapeHtml(error.message) + "</p>");
    }
    return;
  }

  const headers = corsHeaders(request);
  if (!headers) {
    sendJson(response, 403, { error: "Origin is not allowed. Pair this website with the companion first." });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers);
    response.end();
    return;
  }

  try {

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        version: "0.5.3", // x-release-please-version
        downloadDirectory: DOWNLOAD_DIR,
        platform: process.platform,
        torrent: {
          port: client.torrentPort || TORRENT_PORT,
          dhtPort: client.dhtPort || DHT_PORT,
          webRtcSupported: WebTorrent.WEBRTC_SUPPORT,
          trackers: TRACKERS,
        },
        jobs: jobs.size,
        transcoder: TRANSCODER,
      }, headers);
      return;
    }

    if (request.method === "POST" && url.pathname === "/resolve") {
      const body = await readJson(request);
      const source = await resolveSource(body.value);
      sendJson(response, 200, { source }, headers);
      return;
    }

    const importMatch = /^\/imports\/([a-zA-Z0-9-]{8,80})$/.exec(url.pathname);
    if (request.method === "GET" && importMatch) {
      const uploaded = await stat(importPartPath(importMatch[1]))
        .then((info) => info.size)
        .catch((error) => error?.code === "ENOENT" ? 0 : Promise.reject(error));
      sendJson(response, 200, { uploaded }, headers);
      return;
    }
    if (request.method === "PUT" && importMatch) {
      const progress = await receiveImportChunk(request, importMatch[1], url);
      sendJson(response, 200, progress, headers);
      return;
    }
    if (request.method === "DELETE" && importMatch) {
      await rm(importPartPath(importMatch[1]), { force: true });
      sendJson(response, 200, { ok: true }, headers);
      return;
    }

    const seedImportMatch = /^\/imports\/([a-zA-Z0-9-]{8,80})\/seed$/.exec(url.pathname);
    if (request.method === "POST" && seedImportMatch) {
      const job = await finalizeImport(seedImportMatch[1], await readJson(request));
      sendJson(response, 201, { job: snapshot(job), magnetURI: job.value }, headers);
      return;
    }

    if (request.method === "GET" && url.pathname === "/library") {
      const files = await scanLibrary(url.searchParams.get("query"));
      sendJson(response, 200, { files }, headers);
      return;
    }

    const librarySeedMatch = /^\/library\/([a-f0-9]{24})\/seed$/.exec(url.pathname);
    if (request.method === "POST" && librarySeedMatch) {
      const entry = libraryEntries.get(librarySeedMatch[1]);
      if (!entry) throw new Error("Scan the companion library again before selecting that file.");
      const body = await readJson(request);
      const job = await seedLocalFile({
        id: validJobId(body.sourceId),
        filePath: entry.path,
        label: body.label || entry.name,
      });
      sendJson(response, 201, { job: snapshot(job), magnetURI: job.value }, headers);
      return;
    }

    const libraryAttachMatch = /^\/library\/([a-f0-9]{24})\/attach$/.exec(url.pathname);
    if (request.method === "POST" && libraryAttachMatch) {
      const entry = libraryEntries.get(libraryAttachMatch[1]);
      if (!entry) throw new Error("Scan the companion library again before selecting that file.");
      const body = await readJson(request);
      const job = await attachLibraryFile({
        id: validJobId(body.sourceId),
        entry,
        label: body.label || entry.name,
      });
      sendJson(response, 201, { job: snapshot(job) }, headers);
      return;
    }

    if (request.method === "GET" && url.pathname === "/downloads") {
      sendJson(response, 200, { jobs: Array.from(jobs.values(), snapshot) }, headers);
      return;
    }

    if (request.method === "POST" && url.pathname === "/downloads") {
      const body = await readJson(request);
      const job = await addDownload(body.source);
      sendJson(response, 202, { job: snapshot(job) }, headers);
      return;
    }

    const jobMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})$/.exec(url.pathname);
    if (request.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: "Download not found." }, headers);
        return;
      }
      sendJson(response, 200, { job: snapshot(job) }, headers);
      return;
    }

    if (request.method === "DELETE" && jobMatch) {
      const stopped = await stopJob(jobMatch[1], {
        deleteFiles: url.searchParams.get("deleteFiles") === "1",
      });
      sendJson(response, stopped ? 200 : 404, stopped ? { ok: true } : { error: "Download not found." }, headers);
      return;
    }

    const retryMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/retry$/.exec(url.pathname);
    if (request.method === "POST" && retryMatch) {
      const job = await retryJob(retryMatch[1]);
      sendJson(response, 202, { job: snapshot(job) }, headers);
      return;
    }

    const selectMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/select$/.exec(url.pathname);
    if (request.method === "POST" && selectMatch) {
      const job = jobs.get(selectMatch[1]);
      if (!job || job.kind !== "magnet") throw new Error("Torrent download not found.");
      const body = await readJson(request);
      selectTorrentFile(job, Number(body.fileIndex));
      sendJson(response, 200, { job: snapshot(job) }, headers);
      return;
    }

    const subtitleMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/subtitles\/(\d+)\.vtt$/.exec(url.pathname);
    if (request.method === "GET" && subtitleMatch) {
      const job = jobs.get(subtitleMatch[1]);
      if (!job || job.status !== "ready") throw new Error("Download is not ready for subtitle extraction.");
      const filePath = await subtitleFile(job, subtitleMatch[2]);
      const info = await stat(filePath);
      response.writeHead(200, {
        ...headers,
        "content-type": "text/vtt; charset=utf-8",
        "content-length": info.size,
        "cache-control": "private, max-age=3600",
      });
      createReadStream(filePath).pipe(response);
      return;
    }

    const hlsMatch = /^\/hls\/([a-zA-Z0-9-]{8,80})\/(\d+)\/(.+)$/.exec(url.pathname);
    if (request.method === "GET" && hlsMatch) {
      const job = jobs.get(hlsMatch[1]);
      if (!job) throw new Error("Download not found.");
      const descriptor = await hlsDescriptor(job, Number(hlsMatch[2]));
      const asset = await hlsPlayback.getAsset(descriptor, hlsMatch[3]);
      await streamHlsAsset(response, asset, headers);
      return;
    }

    const streamMatch = /^\/stream\/([a-zA-Z0-9-]{8,80})\/(\d+)$/.exec(url.pathname);
    if (request.method === "GET" && streamMatch) {
      const job = jobs.get(streamMatch[1]);
      if (!job) throw new Error("Download not found.");
      await streamFile(request, response, job, Number(streamMatch[2]), headers, url.searchParams.get("audio"));
      return;
    }

    sendJson(response, 404, { error: "Not found." }, headers);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Agent request failed.",
    }, headers);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WatchPair agent listening on http://${HOST}:${PORT}`);
  console.log(`Downloads: ${DOWNLOAD_DIR}`);
  console.log(`Transcoder: ${TRANSCODER.label} via ${TRANSCODER.ffmpegSource} FFmpeg`);
  console.log(`Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(", ")}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(persistenceTimer);
  hlsPlayback.shutdown();
  persistJobs();
  await Promise.all([
    jobStore.flush(),
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => {
      if (client.destroyed) resolve();
      else client.destroy(resolve);
    }),
  ]);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
