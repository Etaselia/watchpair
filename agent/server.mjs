import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { BlockList } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { load } from "cheerio";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import WebTorrent from "webtorrent";
import { isSupportedMagnet } from "./torrent-input.mjs";
import { installTorrentPieceRecovery, installWebTorrentSafetyGuards, verifiedTorrentFileProgress } from "./webtorrent-safety.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WATCHPAIR_AGENT_PORT || 41735);
const DOWNLOAD_DIR = path.resolve(process.env.WATCHPAIR_DOWNLOAD_DIR || "./downloads");
const CONFIG_PATH = path.resolve(
  process.env.WATCHPAIR_CONFIG_PATH || path.join(homedir(), ".watchpair", "companion.json")
);
const FFMPEG_PATH = process.env.WATCHPAIR_FFMPEG_PATH || ffmpegStaticPath;
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
installWebTorrentSafetyGuards();
const client = new WebTorrent({ utp: false });
client.on("error", (error) => console.error(`WebTorrent client error: ${error.message}`));

await mkdir(DOWNLOAD_DIR, { recursive: true });
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
    "access-control-allow-methods": "GET,POST,OPTIONS",
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
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
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
    ? "<h1>Companion connected</h1><p>" + safeOrigin + " can now start downloads and read embedded subtitles.</p><a href=\"" + safeOrigin + "\">Return to WatchPair</a>"
    : "<p class=\"eyebrow\">WatchPair Companion</p><h1>Connect this website?</h1><p><strong>" + safeOrigin + "</strong> will be allowed to send download requests to this computer.</p><form method=\"post\" action=\"/pair\"><input type=\"hidden\" name=\"origin\" value=\"" + safeOrigin + "\"><input type=\"hidden\" name=\"nonce\" value=\"" + escapeHtml(nonce) + "\"><button type=\"submit\">Connect companion</button></form>";
  return "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>WatchPair Companion</title><style>body{margin:0;background:#10130f;color:#f4f3ed;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{width:min(520px,calc(100% - 40px));border-top:4px solid #c8ff32;padding:32px 0}h1{font-size:38px;margin:8px 0 16px}p{color:#b9bdb3;line-height:1.55}strong{color:#fff;word-break:break-all}.eyebrow{color:#c8ff32;text-transform:uppercase;font-size:12px;font-weight:800}button,a{display:inline-block;margin-top:20px;background:#c8ff32;color:#10130f;border:0;padding:13px 18px;font-weight:800;text-decoration:none;cursor:pointer}</style><main>" + content + "</main></html>";
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
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WatchPairCompanion/0.2",
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

function selectedFileKey(job) {
  const media = selectedJobFile(job);
  return String(job.selectedIndex) + ":" + media.name + ":" + media.size;
}

function selectTorrentFile(job, index) {
  const file = job.torrent?.files[index];
  if (!file) throw new Error("Torrent file not found.");
  job.torrent.files.forEach((item) => item.deselect());
  file.select(10);
  job.selectedIndex = index;
  job.audioTracks = [];
  job.subtitleTracks = [];
  job.videoCodec = null;
  job.subtitleStatus = "waiting";
  job.subtitleError = null;
  job.subtitleProbeKey = null;
  job.status = file.done ? "ready" : "downloading";
  job.updatedAt = Date.now();
  if (file.done) void queueSubtitleProbe(job);
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
    return { path: filePath, name: file.path || file.name, size: file.length };
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

function torrentFiles(job) {
  if (!job.torrent) return [];
  return job.torrent.files.map((file, index) => {
    const progress = verifiedTorrentFileProgress(file);
    return {
      index,
      name: file.path || file.name,
      size: file.length,
      downloaded: Math.round(file.length * progress),
      progress: Math.round(progress * 1000) / 10,
      ready: Boolean(file.done),
      selected: index === job.selectedIndex,
      streamUrl: `http://${HOST}:${PORT}/stream/${encodeURIComponent(job.id)}/${index}`,
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
            streamUrl: `http://${HOST}:${PORT}/stream/${encodeURIComponent(job.id)}/0`,
          }]
        : [];

  const selected = files.find((file) => file.selected);
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: selected?.progress || 0,
    infoHash: job.torrent?.infoHash || null,
    error: job.error || null,
    subtitleStatus: job.subtitleStatus,
    subtitleError: job.subtitleError,
    audioTracks: job.audioTracks || [],
    subtitles: job.subtitleTracks || [],
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
        job.status = "ready";
        job.updatedAt = Date.now();
        void queueSubtitleProbe(job);
      });
    });
    job.status = torrent.files[job.selectedIndex]?.done ? "ready" : "downloading";
    job.updatedAt = Date.now();
  });
  torrent.on("download", () => {
    if (job.status !== "ready") job.status = "downloading";
    job.updatedAt = Date.now();
  });
  torrent.on("done", () => {
    job.status = "ready";
    job.updatedAt = Date.now();
    void queueSubtitleProbe(job);
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
    job.status = "ready";
    job.updatedAt = Date.now();
    await queueSubtitleProbe(job);
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : "Direct download failed.";
    job.updatedAt = Date.now();
  }
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

  const job = {
    id,
    kind,
    value,
    label: String(source.label || "video").slice(0, 180),
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
    updatedAt: Date.now(),
  };
  jobs.set(id, job);

  if (kind === "magnet") startTorrent(job);
  else void startDirect(job);
  return job;
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
    createStream({ start: 0, end: size - 1 }).pipe(response);
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
  createStream({ start, end }).pipe(response);
}

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
        version: "0.2.6",
        downloadDirectory: DOWNLOAD_DIR,
        jobs: jobs.size,
      }, headers);
      return;
    }

    if (request.method === "POST" && url.pathname === "/resolve") {
      const body = await readJson(request);
      const source = await resolveSource(body.value);
      sendJson(response, 200, { source }, headers);
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
  console.log(`Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(", ")}`);
});

const shutdown = () => {
  server.close();
  client.destroy();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
