import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { BlockList } from "node:net";
import { availableParallelism, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { load } from "cheerio";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import WebTorrent from "webtorrent";

function unpackedExecutablePath(value) {
  return process.versions.electron && String(value).includes("app.asar")
    ? String(value).replace("app.asar", "app.asar.unpacked")
    : value;
}
import {
  canCopyH264Video,
  createHlsPlaybackManager,
  startsAtBrowserZero,
  streamHlsAsset,
} from "./hls-playback.mjs";
import {
  createMediaTaskScheduler,
  createResponsivenessMonitor,
  mediaResourceProfile,
} from "./media-governor.mjs";
import { createProcessRegistry } from "./process-registry.mjs";
import {
  CPU_ENCODER,
  publicTranscoder,
  selectTranscodeRuntime,
  videoPipeline,
} from "./hardware-acceleration.mjs";
import { renderEncoderArguments, renderInputArguments } from "./render-queue.mjs";
import { createScheduledFfmpegRunner } from "./scheduled-ffmpeg.mjs";
import {
  mediaTargetKey,
  normalizeMediaTargets,
  replaceTorrentSelections,
} from "./media-priority.mjs";
import { createTorrentBandwidthGovernor } from "./torrent-bandwidth-governor.mjs";
import { createJsonStore } from "./job-store.mjs";
import {
  RETENTION_METADATA_VERSION,
  RECENT_PLAYBACK_PROTECTION_MS,
  cacheExpired,
  cleanupSettingsFromEnvironment,
  jobCanBeCleaned,
  jobCleanupReason,
  prepareAutomaticJobDeletion,
  retentionMetadataReliable,
} from "./cleanup-policy.mjs";
import { createSubtitleAssetPipeline } from "./subtitle-pipeline.mjs";
import {
  chapterProbeArguments,
  mediaDurationFromProbe,
  normalizeMediaChapters,
} from "./media-chapters.mjs";
import { fingerprintPath } from "./media-fingerprint.mjs";
import {
  createSingleFlightOperation,
  createSingleFlightCache,
  pathLatestMtime,
  pathSize,
  pruneExpiredChildren,
} from "./storage-cleanup.mjs";
import {
  STYLED_SUBTITLE_CODECS,
  TEXT_SUBTITLE_CODECS,
  fontAttachmentMetadata,
} from "./subtitle-assets.mjs";
import { isSupportedMagnet } from "./torrent-input.mjs";
import { installTorrentPieceRecovery, installWebTorrentSafetyGuards, verifiedTorrentFileProgress, verifyTorrentFilePieces } from "./webtorrent-safety.mjs";
import {
  applyTorrentConnectionPlan,
  torrentConnectionPlan,
  torrentRoleConnectionLimits,
} from "./torrent-pressure.mjs";
import { createPersistentLogger, installProcessDiagnostics } from "./persistent-log.mjs";
import { createTorrentRecoveryTelemetry } from "./recovery-telemetry.mjs";
import { createLibraryCatalog } from "./library-catalog.mjs";
import {
  classifyTrackerError,
  createTorrentTelemetry,
  sanitizeTrackerEndpoint,
} from "./torrent-telemetry.mjs";
import { magnetInfoHash } from "../lib/magnet-identity.mjs";
import { parseByteRange } from "./http-range.mjs";
import {
  normalizeNetworkSettings,
  restoreTorrentNetworking,
  silenceTorrentNetworking,
  torrentSelectedFilesComplete,
} from "./network-control.mjs";
import {
  applyRestoredTorrentState,
  fileIdentityKey,
  persistedTorrentState,
  shouldSkipTorrentVerification,
} from "./torrent-state.mjs";

const HOST = "127.0.0.1";
const APP_VERSION = process.env.WATCHPAIR_APP_VERSION || "0.12.7"; // x-release-please-version
const PROTOCOL_VERSION = 2;
const CONTROL_TOKEN = String(process.env.WATCHPAIR_CONTROL_TOKEN || "");
const PORT = Number(process.env.WATCHPAIR_AGENT_PORT || 41735);
const REQUESTED_TORRENT_PORT = Number(process.env.WATCHPAIR_TORRENT_PORT || PORT + 1);
const DHT_PORT = Number(process.env.WATCHPAIR_DHT_PORT || 0);
const RESOURCE_MODE = String(process.env.WATCHPAIR_RESOURCE_MODE || "balanced");
const TORRENT_CONNECTION_BUDGET = process.env.WATCHPAIR_TORRENT_CONNECTION_BUDGET;
const INITIAL_TORRENT_PRESSURE = torrentConnectionPlan(
  RESOURCE_MODE, 0, { totalBudget: TORRENT_CONNECTION_BUDGET });

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
const LOG_DIRECTORY = path.resolve(
  process.env.WATCHPAIR_LOG_DIR || path.join(path.dirname(CONFIG_PATH), "logs")
);
const agentLogger = createPersistentLogger({
  directory: LOG_DIRECTORY,
  fileName: process.env.WATCHPAIR_LOG_FILE || "watchpair-agent.log",
  component: "agent",
});
agentLogger.captureConsole();
installProcessDiagnostics(agentLogger);
agentLogger.info("agent_process_started", {
  version: APP_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  electron: process.versions.electron || null,
  packaged: Boolean(process.versions.electron),
  log: agentLogger.details(),
});
const torrentRecoveryTelemetry = createTorrentRecoveryTelemetry({
  onFlush: (summary) => {
    const level = summary.peerFailures ? "warn" : "info";
    agentLogger[level]("torrent_piece_recovery_summary", summary);
  },
});

const JOBS_PATH = path.join(DOWNLOAD_DIR, ".watchpair-jobs.json");
const IMPORT_DIR = path.join(DOWNLOAD_DIR, ".watchpair-imports");
const HLS_DIR = path.join(DOWNLOAD_DIR, ".watchpair-hls");
const SUBTITLE_DIR = path.join(DOWNLOAD_DIR, ".watchpair-subtitles");
const MEDIA_DIR = path.join(DOWNLOAD_DIR, ".watchpair-media");
const LIBRARY_CATALOG_PATH = path.join(DOWNLOAD_DIR, ".watchpair-library.json");
const OWNERSHIP_MARKER_NAME = ".watchpair-owned.json";
const OWNERSHIP_MARKER_VERSION = 1;
const OWNERSHIP_TOKEN_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
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
const TRANSCODE_RUNTIME = await selectTranscodeRuntime({ bundledPath: unpackedExecutablePath(ffmpegStaticPath) });
const FFMPEG_PATH = TRANSCODE_RUNTIME.ffmpegPath;
const TRANSCODER = publicTranscoder(TRANSCODE_RUNTIME);
agentLogger.info("transcoder_selected", {
  transcoder: TRANSCODER,
  configuredPreference: process.env.WATCHPAIR_TRANSCODER || "auto",
});
const ALLOW_PRIVATE_DOWNLOADS = process.env.WATCHPAIR_ALLOW_PRIVATE_DOWNLOADS === "1";
const CLEANUP_SETTINGS = cleanupSettingsFromEnvironment();
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SEED_LEASE_DEFAULT_TTL_MS = Math.max(1_000, Math.min(
  10 * 60_000,
  Number(process.env.WATCHPAIR_SEED_LEASE_TTL_MS) || 120_000
));
const SEED_LEASE_GRACE_MS = Math.max(100, Math.min(
  10 * 60_000,
  Number(process.env.WATCHPAIR_SEED_LEASE_GRACE_MS) || 60_000
));
const SEED_LEASE_SWEEP_MS = Math.max(50, Math.min(
  60_000,
  Number(process.env.WATCHPAIR_SEED_LEASE_SWEEP_MS) || 5_000
));
const SEED_LEASE_PATTERN = /^lease-[a-zA-Z0-9_-]{16,128}$/;
const FFPROBE_PATH = process.env.WATCHPAIR_FFPROBE_PATH || unpackedExecutablePath(ffprobeStatic.path);
const runFile = promisify(execFile);
const ALLOWED_ORIGINS = new Set(
  (process.env.WATCHPAIR_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|ts)$/i;
const DIRECT_MEDIA_EXTENSIONS = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|ts)(?:$|[?#])/i;
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
const jobStore = createJsonStore(JOBS_PATH);
let restoringJobs = false;
let failedRestoreRecords = [];
const libraryCatalog = createLibraryCatalog({
  roots: () => LIBRARY_DIRS,
  catalogPath: LIBRARY_CATALOG_PATH,
  getManagedJobs: () => Array.from(jobs.values())
    .filter((job) => job.managed)
    .map((job) => ({
      id: job.id,
      label: job.label,
      pinned: job.pinned,
      identity: job.torrent?.infoHash || magnetInfoHash(job.value) || job.id,
      root: path.join(DOWNLOAD_DIR, job.id),
      files: managedLibraryFiles(job),
    })),
  async onSetManagedPins(jobIds, pinned, collectionId) {
    const managedIds = new Set(jobIds);
    const targets = Array.from(jobs.values()).filter((job) =>
      managedIds.has(job.id) || job.libraryCollectionId === collectionId);
    if (pinned && targets.some((job) => job.cleanupCommit)) {
      throw new Error("This download is already being removed; refresh the library and try again.");
    }
    for (const job of targets) {
      job.pinned = Boolean(pinned);
      job.updatedAt = Date.now();
    }
    persistJobs();
    await jobStore.flush();
  },
});

let libraryRescanTimer = null;
function scheduleLibraryRescan() {
  if (libraryRescanTimer) return;
  libraryRescanTimer = setTimeout(() => {
    libraryRescanTimer = null;
    try {
      libraryCatalog.startScan();
    } catch (error) {
      agentLogger.warn("library_rescan_failed", { error });
    }
  }, 1_000);
  libraryRescanTimer.unref?.();
}

const preparationQueue = [];
let preparationWorker = null;
const selectedPreparationKeys = new Set();
let activePreparationTargetKey = null;
let mediaPriorityTargets = [];
let preparationOrderTargetKeys = [];
function mediaDiagnosticEvent(event, data) {
  if (event.endsWith("_failed")) {
    agentLogger.error(event, data);
  } else if (event.endsWith("_deferred") || event.endsWith("_preempted")) {
    agentLogger.warn(event, data);
  } else {
    agentLogger.info(event, data);
  }
}
const mediaScheduler = createMediaTaskScheduler({ onEvent: mediaDiagnosticEvent });
const subtitleResponsiveness = createResponsivenessMonitor();
const subtitleScheduler = createMediaTaskScheduler({
  monitor: {
    snapshot: () => subtitleResponsiveness.snapshot(),
    shouldDeferBackground: () =>
      subtitleResponsiveness.snapshot().eventLoopDelayP95Ms > 100,
    stop: () => subtitleResponsiveness.stop(),
  },
  onEvent: (event, data) => mediaDiagnosticEvent(event, {
    ...data,
    lane: "subtitles",
  }),
});
const mediaProcessRegistry = createProcessRegistry({ onEvent: mediaDiagnosticEvent });
const runScheduledFfmpeg = createScheduledFfmpegRunner({
  ffmpegPath: FFMPEG_PATH,
  scheduler: mediaScheduler,
  processRegistry: mediaProcessRegistry,
});
const runSubtitleFfmpeg = createScheduledFfmpegRunner({
  ffmpegPath: FFMPEG_PATH,
  scheduler: subtitleScheduler,
  processRegistry: mediaProcessRegistry,
});
const subtitleAssetPipeline = createSubtitleAssetPipeline({
  cacheRoot: SUBTITLE_DIR,
  runScheduledFfmpeg: runSubtitleFfmpeg,
});
const torrentBandwidthGovernor = createTorrentBandwidthGovernor();
let torrentBandwidth = torrentBandwidthGovernor.snapshot();
let torrentDownloadRoles = new Map();
installWebTorrentSafetyGuards();
const client = new WebTorrent({
  maxConns: INITIAL_TORRENT_PRESSURE.perTorrentLimit,
  utp: false,
  torrentPort: TORRENT_PORT,
  dhtPort: DHT_PORT,
  seedOutgoingConnections: true,
});
let torrentPressure = { ...INITIAL_TORRENT_PRESSURE, trimmedPeers: 0, pausedTorrents: 0 };
let lastTorrentPressurePlanKey = "";
let lastTorrentPressureLogAt = 0;
function refreshTorrentPressure(reason) {
  const basePlan = torrentConnectionPlan(RESOURCE_MODE, client.torrents.length, {
    totalBudget: TORRENT_CONNECTION_BUDGET,
  });
  const jobsByTorrent = new Map(Array.from(jobs.values())
    .filter((job) => job.torrent)
    .map((job) => [job.torrent, job]));
  const roles = client.torrents.map((torrent) => {
    const job = jobsByTorrent.get(torrent);
    if (job?.seed) return "seed";
    if (!torrent.files?.length) return "metadata";
    return torrentDownloadRoles.get(job?.id) || "idle";
  });
  const limits = torrentRoleConnectionLimits(roles, {
    totalBudget: basePlan.totalBudget,
    foregroundShare: torrentBandwidth.targetShare,
  });
  torrentPressure = applyTorrentConnectionPlan(client, {
    mode: RESOURCE_MODE,
    totalBudget: basePlan.totalBudget,
    limitForTorrent: (_torrent, index) => limits[index],
    skipTorrent: (torrent) => Boolean(jobsByTorrent.get(torrent)?.torrentSilenced),
  });
  const planKey = JSON.stringify({ roles, limits });
  const now = Date.now();
  if (
    planKey !== lastTorrentPressurePlanKey ||
    (torrentPressure.trimmedPeers > 0 && now - lastTorrentPressureLogAt >= 10_000)
  ) {
    lastTorrentPressurePlanKey = planKey;
    lastTorrentPressureLogAt = now;
    agentLogger.info("torrent_pressure_adjusted", {
      reason,
      torrentCount: torrentPressure.torrentCount,
      totalBudget: torrentPressure.totalBudget,
      perTorrentLimit: torrentPressure.perTorrentLimit,
      maxPerTorrentLimit: torrentPressure.maxPerTorrentLimit,
      roles,
      limits,
      trimmedPeers: torrentPressure.trimmedPeers,
      pausedTorrents: torrentPressure.pausedTorrents,
    });
  }
}
client.on("add", () => queueMicrotask(() => refreshTorrentPressure("torrent-added")));
client.on("remove", () => queueMicrotask(() => refreshTorrentPressure("torrent-removed")));
client.on("torrent", () => refreshTorrentPressure("torrent-ready"));
const hlsPlayback = createHlsPlaybackManager({
  ffmpegPath: FFMPEG_PATH,
  ffprobePath: FFPROBE_PATH,
  encoder: TRANSCODE_RUNTIME.encoder,
  cacheRoot: HLS_DIR,
  scheduler: mediaScheduler,
  processRegistry: mediaProcessRegistry,
  onEvent: mediaDiagnosticEvent,
});
client.on("error", (error) => {
  const category = classifyTrackerError(error);
  agentLogger.error("webtorrent_client_error", { category, code: String(error?.code || "") });
  console.error(`WebTorrent client error (${category}).`);
});
client.on("warning", (warning) => agentLogger.warn("webtorrent_client_warning", {
  category: classifyTrackerError(warning),
}));
client.on("listening", () => {
  agentLogger.info("torrent_listener_ready", { torrentPort: client.torrentPort, dhtPort: client.dhtPort });
  console.log(`Torrent listener ready on TCP ${client.torrentPort}; DHT uses UDP ${client.dhtPort}.`);
});

await mkdir(DOWNLOAD_DIR, { recursive: true });
await mkdir(IMPORT_DIR, { recursive: true });
await mkdir(path.dirname(CONFIG_PATH), { recursive: true });

let agentConfig = {};
async function loadAgentConfig() {
  try {
    agentConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`Could not read ${CONFIG_PATH}: ${error.message}`);
  }
  if (!agentConfig || typeof agentConfig !== "object") agentConfig = {};
  for (const origin of agentConfig.allowedOrigins || []) ALLOWED_ORIGINS.add(origin);
  return agentConfig;
}
const networkState = normalizeNetworkSettings((await loadAgentConfig()).network);

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.has(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-watchpair-control",
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

async function persistAgentConfig() {
  await writeFile(
    CONFIG_PATH,
    JSON.stringify({
      allowedOrigins: Array.from(ALLOWED_ORIGINS).sort(),
      network: { ...networkState },
    }, null, 2),
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
  if (networkState.offline) {
    const error = new Error("Offline mode is enabled; outbound downloads are paused until it is turned off.");
    error.code = "EROFFLINE";
    throw error;
  }
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
      // Match any of the three targets in a single pass
      .replace(/\\u0026|\\u003d|&amp;/gi, (match) => {
        switch (match.toLowerCase()) {
          case "\\u0026": return "&";
          case "\\u003d": return "=";
          case "&amp;": return "&";
          default: return match;
        }
      });

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

function torrentFilePath(file) {
  return String(file?.path || file?.name || "video")
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 500);
}

function defaultPreparation() {
  return { status: "waiting", error: null, encoder: null, fallback: false };
}

function createMediaAsset(index) {
  return {
    index,
    status: "waiting",
    identityFingerprint: null,
    identityFingerprintKey: null,
    identityFingerprintPromise: null,
    identityFingerprintPromiseKey: null,
    torrentVerifiedKey: null,
    torrentVerificationPromise: null,
    torrentVerificationPromiseKey: null,
    audioTracks: [],
    chapters: [],
    subtitleTracks: [],
    mediaStreams: [],
    subtitleAssetStatus: "waiting",
    subtitleAssetError: null,
    subtitleAssetResult: null,
    subtitleAssetResultKey: null,
    subtitleAssetPromise: null,
    subtitleAssetPromiseKey: null,
    videoCodec: null,
    videoPixelFormat: null,
    duration: null,
    videoStartTime: null,
    videoProfile: null,
    subtitleStatus: "waiting",
    subtitleError: null,
    subtitleProbeKey: null,
    subtitleProbePromise: null,
    subtitleProbePromiseKey: null,
    audioRenderPromises: new Map(),
    preparation: defaultPreparation(),
    updatedAt: Date.now(),
  };
}

function mediaAsset(job, index = job.selectedIndex) {
  if (!Number.isInteger(index) || index < 0) throw new Error("Select a media file first.");
  job.assets ||= new Map();
  let asset = job.assets.get(index);
  if (!asset) {
    asset = createMediaAsset(index);
    job.assets.set(index, asset);
  }
  return asset;
}

const MEDIA_ASSET_FIELDS = [
  "identityFingerprint", "identityFingerprintKey", "torrentVerifiedKey",
  "audioTracks", "chapters", "subtitleTracks", "mediaStreams",
  "subtitleAssetStatus", "subtitleAssetError", "videoCodec", "videoPixelFormat",
  "duration", "videoStartTime",
  "videoProfile", "subtitleStatus", "subtitleError", "preparation",
];

function syncSelectedAsset(job) {
  if (!Number.isInteger(job.selectedIndex)) return null;
  const asset = mediaAsset(job, job.selectedIndex);
  for (const field of MEDIA_ASSET_FIELDS) job[field] = asset[field];
  return asset;
}

function fileIdentityFingerprint(job, index, file) {
  const asset = mediaAsset(job, index);
  return asset.identityFingerprintKey === fileIdentityKey(index, file)
    ? asset.identityFingerprint
    : null;
}

async function identifySelectedFile(job, index = job.selectedIndex) {
  if (!Number.isInteger(index)) return null;
  const asset = mediaAsset(job, index);
  const selectionKey = fileIdentityKey(index, jobFile(job, index));
  if (asset.identityFingerprint && asset.identityFingerprintKey === selectionKey) {
    return asset.identityFingerprint;
  }
  if (asset.identityFingerprintPromise && asset.identityFingerprintPromiseKey === selectionKey) {
    return asset.identityFingerprintPromise;
  }

  let promise;
  promise = fingerprintPath(jobFile(job, index).path)
    .then((fingerprint) => {
      if (fileIdentityKey(index, jobFile(job, index)) === selectionKey) {
        asset.identityFingerprint = fingerprint;
        asset.identityFingerprintKey = selectionKey;
        asset.updatedAt = Date.now();
        if (job.selectedIndex === index) syncSelectedAsset(job);
        job.updatedAt = Date.now();
        persistJobs();
      }
      return fingerprint;
    })
    .finally(() => {
      if (asset.identityFingerprintPromise === promise) {
        asset.identityFingerprintPromise = null;
        asset.identityFingerprintPromiseKey = null;
      }
    });
  asset.identityFingerprintPromise = promise;
  asset.identityFingerprintPromiseKey = selectionKey;
  return promise;
}

async function verifySelectedTorrentFile(job, index) {
  if (job.kind !== "magnet") return true;
  if (!Number.isInteger(index)) return false;

  const file = job.torrent?.files[index];
  if (!file) throw new Error("Torrent file not found.");
  const asset = mediaAsset(job, index);
  const verificationKey = fileIdentityKey(index, jobFile(job, index));
  if (shouldSkipTorrentVerification(asset.torrentVerifiedKey, verificationKey, file.done)) {
    // The file was fully verified before (persisted key still matches the
    // current name+size) and WebTorrent re-verified the store contents on
    // restore (`file.done` is only set after its own piece hashing). Trusting
    // both avoids re-hashing every piece after every agent restart.
    return true;
  }
  if (
    asset.torrentVerificationPromise &&
    asset.torrentVerificationPromiseKey === verificationKey
  ) {
    return asset.torrentVerificationPromise;
  }

  asset.status = "verifying";
  if (job.selectedIndex === index) {
    job.status = "downloading";
    job.warning = "Verifying every torrent piece before playback.";
  }
  job.updatedAt = Date.now();
  const verificationStartedAt = Date.now();
  agentLogger.info("torrent_verification_started", {
    jobId: job.id,
    fileIndex: index,
    fileSize: file.length,
    pieceLength: job.torrent.pieceLength,
    pieceCount: file._endPiece - file._startPiece + 1,
  });

  let promise;
  promise = verifyTorrentFilePieces(file)
    .then(({ verified, invalidPieces }) => {
      agentLogger.info("torrent_verification_finished", {
        jobId: job.id,
        fileIndex: index,
        durationMs: Date.now() - verificationStartedAt,
        verified,
        invalidPieces: invalidPieces.length,
      });
      if (fileIdentityKey(index, jobFile(job, index)) !== verificationKey) return false;
      if (!verified) {
        file.deselect();
        asset.torrentVerifiedKey = null;
        asset.status = "downloading";
        job.warning =
          `Found ${invalidPieces.length} incomplete or corrupt torrent piece${invalidPieces.length === 1 ? "" : "s"}; downloading them again.`;
        if (job.selectedIndex === index) job.status = "downloading";
        refreshTorrentSelections("verification-retry");
        job.updatedAt = Date.now();
        return false;
      }
      asset.torrentVerifiedKey = verificationKey;
      asset.status = "ready";
      if (job.selectedIndex === index) job.warning = null;
      job.updatedAt = Date.now();
      return true;
    })
    .catch((error) => {
      agentLogger.error("torrent_verification_failed", {
        jobId: job.id,
        fileIndex: index,
        durationMs: Date.now() - verificationStartedAt,
        error,
      });
      throw error;
    })
    .finally(() => {
      if (asset.torrentVerificationPromise === promise) {
        asset.torrentVerificationPromise = null;
        asset.torrentVerificationPromiseKey = null;
      }
    });
  asset.torrentVerificationPromise = promise;
  asset.torrentVerificationPromiseKey = verificationKey;
  return promise;
}

async function completeSelectedFile(job, index = job.selectedIndex) {
  if (!Number.isInteger(index)) return;
  const asset = mediaAsset(job, index);
  try {
    if (!(await verifySelectedTorrentFile(job, index))) return;
    await identifySelectedFile(job, index);
    asset.status = "ready";
    asset.updatedAt = Date.now();
    if (index === job.selectedIndex) {
      job.status = "ready";
      syncSelectedAsset(job);
    }
    markJobCompleted(job);
    agentLogger.info("media_file_ready", {
      jobId: job.id,
      fileIndex: index,
      fingerprint: asset.identityFingerprint,
    });
    refreshPreparationScheduling();
    queueMediaPreparation(job, index);
    scheduleLibraryRescan();
  } catch (error) {
    agentLogger.error("media_file_completion_failed", { jobId: job.id, fileIndex: index, error });
    asset.status = "error";
    asset.preparation = {
      ...defaultPreparation(),
      status: "error",
      error: error instanceof Error ? error.message : "Could not identify the completed media file.",
    };
    if (index === job.selectedIndex) {
      job.status = "error";
      job.error = asset.preparation.error;
      syncSelectedAsset(job);
    }
    job.updatedAt = Date.now();
  }
}

function selectTorrentFile(job, index, { recordAccess = true } = {}) {
  const localFile = index === 0 ? job.file : null;
  const file = job.torrent?.files[index] || localFile;
  if (!file) throw new Error("Torrent file not found.");
  job.selectedIndex = index;
  const asset = syncSelectedAsset(job);
  job.status = asset.status === "ready" ? "ready" : "downloading";
  job.error = asset.preparation.error || null;
  if (recordAccess) touchJob(job);
  if (localFile) {
    if (asset.status === "ready") queueMediaPreparation(job, index);
  } else if (file.done) {
    void completeSelectedFile(job, index);
  }
  refreshPreparationScheduling();
}

function jobFile(job, index) {
  if (job.seed && job.file && index === 0) return job.file;
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

function managedLibraryFiles(job) {
  const indexes = job.kind === "magnet" && !job.seed
    ? job.torrent?.files?.map((_, index) => index) || Array.from(job.assets?.keys?.() || [])
    : job.file ? [0] : [];
  const infoHash = String(job.torrent?.infoHash || magnetInfoHash(job.value) || "")
    .toLowerCase();
  const files = [];
  for (const index of indexes) {
    try {
      const media = jobFile(job, index);
      const usable = torrentFileIsFullyVerified(job, index);
      files.push({
        path: media.path,
        fingerprint: usable ? fileIdentityFingerprint(job, index, media) : null,
        infoHash: usable && /^[a-f0-9]{40}$/.test(infoHash) ? infoHash : null,
        fileIndex: index,
        usable,
      });
    } catch {
      // Metadata-only and paused torrents have no resolvable local file yet.
    }
  }
  return files;
}

function streamTrackLabel(stream, fallback) {
  const title = String(stream.tags?.title || "").trim();
  const language = String(stream.tags?.language || "und").toLowerCase();
  return title || (language === "und" ? fallback : language.toUpperCase());
}

async function probeSubtitleTracks(job, index = job.selectedIndex) {
  const media = jobFile(job, index);
  const asset = mediaAsset(job, index);
  const selectionKey = fileIdentityKey(index, media);
  if (asset.subtitleProbeKey === selectionKey && asset.subtitleStatus === "ready") return;

  asset.subtitleProbeKey = selectionKey;
  asset.subtitleStatus = "probing";
  asset.subtitleError = null;
  asset.audioTracks = [];
  asset.subtitleTracks = [];
  asset.mediaStreams = [];
  asset.subtitleAssetStatus = "waiting";
  asset.subtitleAssetError = null;
  asset.subtitleAssetResult = null;
  asset.subtitleAssetResultKey = null;
  asset.subtitleAssetPromise = null;
  asset.subtitleAssetPromiseKey = null;
  asset.chapters = [];
  asset.updatedAt = Date.now();
  if (job.selectedIndex === index) syncSelectedAsset(job);
  job.updatedAt = Date.now();
  const probeStartedAt = Date.now();
  agentLogger.info("media_probe_started", {
    jobId: job.id,
    fileIndex: index,
    fileSize: media.size,
    extension: path.extname(media.name).toLowerCase(),
  });

  const isStillCurrent = () => {
    try {
      return fileIdentityKey(index, jobFile(job, index)) === selectionKey;
    } catch {
      return false;
    }
  };

  try {
    const result = await runFile(
      FFPROBE_PATH,
      chapterProbeArguments(media.path),
      { maxBuffer: 8 * 1024 * 1024 }
    );
    if (!isStillCurrent()) return;

    const metadata = JSON.parse(result.stdout || "{}");
    const videoStream = (metadata.streams || []).find((stream) => stream.codec_type === "video");
    asset.videoCodec = String(videoStream?.codec_name || "unknown");
    asset.videoPixelFormat = String(videoStream?.pix_fmt || "unknown");
    asset.videoProfile = String(videoStream?.profile || "unknown");
    asset.duration = mediaDurationFromProbe(metadata);
    const rawVideoStart = Number(videoStream?.start_time ?? metadata.format?.start_time);
    asset.videoStartTime = Number.isFinite(rawVideoStart) ? rawVideoStart : null;
    asset.chapters = normalizeMediaChapters(metadata.chapters);
    asset.audioTracks = (metadata.streams || [])
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        id: String(stream.index),
        streamIndex: Number(stream.index),
        language: String(stream.tags?.language || "und").toLowerCase(),
        label: streamTrackLabel(stream, "Audio track"),
        codec: String(stream.codec_name || "unknown"),
        channels: Number(stream.channels || 0),
        channelLayout: String(stream.channel_layout || ""),
        default: Boolean(stream.disposition?.default),
      }));
    const streams = metadata.streams || [];
    asset.mediaStreams = streams;
    const selectionVersion = encodeURIComponent(asset.identityFingerprint || selectionKey);
    const subtitleFonts = fontAttachmentMetadata(
      streams,
      (stream) =>
        "http://" + HOST + ":" + PORT +
        "/downloads/" + encodeURIComponent(job.id) +
        "/media/" + index + "/subtitle-fonts/" + stream.index +
        "?v=" + selectionVersion
    );
    asset.subtitleTracks = streams
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream) => {
        const codec = String(stream.codec_name || "unknown");
        const language = String(stream.tags?.language || "und").toLowerCase();
        const styled = STYLED_SUBTITLE_CODECS.has(codec);
        const subtitleBase =
          "http://" + HOST + ":" + PORT +
          "/downloads/" + encodeURIComponent(job.id) +
          "/media/" + index + "/subtitles/" + stream.index;
        return {
          id: String(stream.index),
          streamIndex: Number(stream.index),
          language,
          label: streamTrackLabel(stream, "Embedded subtitles"),
          codec,
          supported: TEXT_SUBTITLE_CODECS.has(codec),
          styled,
          default: Boolean(stream.disposition?.default),
          forced: Boolean(stream.disposition?.forced),
          url: subtitleBase + ".vtt?v=" + selectionVersion,
          assUrl: styled ? subtitleBase + ".ass?v=" + selectionVersion : null,
          fonts: styled ? subtitleFonts : [],
        };
      });
    agentLogger.info("media_probe_finished", {
      jobId: job.id,
      fileIndex: index,
      durationMs: Date.now() - probeStartedAt,
      video: {
        codec: asset.videoCodec,
        pixelFormat: asset.videoPixelFormat,
        profile: asset.videoProfile,
        duration: asset.duration,
      },
      audioTracks: asset.audioTracks.length,
      subtitleTracks: asset.subtitleTracks.length,
      fontAttachments: subtitleFonts.length,
      chapters: asset.chapters.length,
    });
    asset.subtitleStatus = "ready";
  } catch (error) {
    if (!isStillCurrent()) return;
    agentLogger.error("media_probe_failed", {
      jobId: job.id,
      fileIndex: index,
      durationMs: Date.now() - probeStartedAt,
      error,
    });
    asset.subtitleStatus = "error";
    asset.subtitleError = error instanceof Error ? error.message : "Could not inspect embedded media tracks.";
  } finally {
    if (isStillCurrent()) {
      asset.updatedAt = Date.now();
      if (job.selectedIndex === index) syncSelectedAsset(job);
      job.updatedAt = Date.now();
    }
  }
}

function queueSubtitleProbe(job, index = job.selectedIndex) {
  const asset = mediaAsset(job, index);
  const selectionKey = fileIdentityKey(index, jobFile(job, index));
  if (asset.subtitleProbeKey === selectionKey && asset.subtitleStatus === "ready") {
    return Promise.resolve();
  }
  if (asset.subtitleProbePromise && asset.subtitleProbePromiseKey === selectionKey) {
    return asset.subtitleProbePromise;
  }

  let promise;
  promise = probeSubtitleTracks(job, index).finally(() => {
    if (asset.subtitleProbePromise === promise) {
      asset.subtitleProbePromise = null;
      asset.subtitleProbePromiseKey = null;
    }
  });
  asset.subtitleProbePromise = promise;
  asset.subtitleProbePromiseKey = selectionKey;
  return promise;
}

async function prepareSubtitleAssetsForSelection(job, index, selectionKey) {
  const asset = mediaAsset(job, index);
  await queueSubtitleProbe(job, index);
  if (fileIdentityKey(index, jobFile(job, index)) !== selectionKey) {
    throw new Error("The media file changed during subtitle preparation.");
  }

  const media = jobFile(job, index);
  const mediaKey = await identifySelectedFile(job, index);
  const schedulerJobId = `content-${mediaKey}-${media.size}`;
  asset.subtitleAssetStatus = "preparing";
  asset.subtitleAssetError = null;
  asset.subtitleAssetResult = null;
  asset.subtitleAssetResultKey = null;
  asset.updatedAt = Date.now();
  job.updatedAt = Date.now();
  if (job.selectedIndex === index) syncSelectedAsset(job);
  const subtitleStartedAt = Date.now();
  agentLogger.info("subtitle_assets_started", {
    jobId: job.id,
    fileIndex: index,
    subtitleTracks: asset.subtitleTracks.length,
    attachments: asset.mediaStreams.filter((stream) => stream.codec_type === "attachment").length,
  });

  try {
    const result = await subtitleAssetPipeline.prepare({
      mediaPath: media.path,
      mediaKey,
      fileSize: media.size,
      streams: asset.mediaStreams,
      schedulerJobId,
    });
    agentLogger.info("subtitle_assets_finished", {
      jobId: job.id,
      fileIndex: index,
      durationMs: Date.now() - subtitleStartedAt,
      subtitleAssets: result.subtitles.size,
      fontAssets: result.fonts.size,
    });
    if (asset.subtitleProbeKey === selectionKey) {
      asset.subtitleAssetStatus = "ready";
      asset.subtitleAssetError = null;
      asset.subtitleAssetResult = result;
      asset.subtitleAssetResultKey = selectionKey;
      asset.updatedAt = Date.now();
      job.updatedAt = Date.now();
      if (job.selectedIndex === index) syncSelectedAsset(job);
    }
    return result;
  } catch (error) {
    agentLogger.error("subtitle_assets_failed", {
      jobId: job.id,
      fileIndex: index,
      durationMs: Date.now() - subtitleStartedAt,
      error,
    });
    if (asset.subtitleProbeKey === selectionKey) {
      asset.subtitleAssetStatus = "error";
      asset.subtitleAssetError = error instanceof Error ? error.message : "Subtitle preparation failed.";
      asset.subtitleAssetResult = null;
      asset.subtitleAssetResultKey = null;
      asset.updatedAt = Date.now();
      job.updatedAt = Date.now();
      if (job.selectedIndex === index) syncSelectedAsset(job);
    }
    throw error;
  }
}

function preparedSubtitleAssets(job, index = job.selectedIndex) {
  const asset = mediaAsset(job, index);
  const selectionKey = fileIdentityKey(index, jobFile(job, index));
  if (
    asset.subtitleAssetStatus === "ready" &&
    asset.subtitleAssetResultKey === selectionKey &&
    asset.subtitleAssetResult
  ) return Promise.resolve(asset.subtitleAssetResult);
  if (asset.subtitleAssetPromise && asset.subtitleAssetPromiseKey === selectionKey) {
    return asset.subtitleAssetPromise;
  }

  let promise;
  promise = prepareSubtitleAssetsForSelection(job, index, selectionKey).finally(() => {
    if (asset.subtitleAssetPromise === promise) {
      asset.subtitleAssetPromise = null;
      asset.subtitleAssetPromiseKey = null;
    }
  });
  asset.subtitleAssetPromise = promise;
  asset.subtitleAssetPromiseKey = selectionKey;
  return promise;
}

function requestSubtitleAssetPreparation(job, index = job.selectedIndex) {
  const asset = mediaAsset(job, index);
  const selectionKey = fileIdentityKey(index, jobFile(job, index));
  if (
    asset.subtitleAssetStatus === "ready" &&
    asset.subtitleAssetResultKey === selectionKey &&
    asset.subtitleAssetResult
  ) {
    return { status: "ready", assets: asset.subtitleAssetResult };
  }

  if (asset.subtitleAssetStatus === "error" && asset.subtitleProbeKey === selectionKey) {
    const error = asset.subtitleAssetError || "Subtitle preparation failed.";
    asset.subtitleAssetStatus = "waiting";
    asset.subtitleAssetError = null;
    if (job.selectedIndex === index) syncSelectedAsset(job);
    return { status: "error", error };
  }

  void preparedSubtitleAssets(job, index).catch(() => {
    // The polling request observes the stored failure on its next short response.
  });
  return { status: "preparing", retryAfterMs: 750 };
}

function queueMediaPreparation(job, index = job.selectedIndex) {
  void queueSubtitleProbe(job, index)
    .then(() => {
      if (jobs.get(job.id) !== job) return;
      const asset = mediaAsset(job, index);
      if (asset.subtitleTracks.some((track) => track.supported)) {
        void preparedSubtitleAssets(job, index).catch(() => {
          // The stored subtitle asset state is surfaced by the regular job poll.
        });
      }
      const key = mediaTargetKey(job.id, index);
      if (key === activePreparationTargetKey) queueSelectedPreparation(job, index);
      else queueBackgroundPreparation(job, index);
    })
    .catch((error) => {
      const asset = mediaAsset(job, index);
      asset.preparation = {
        ...defaultPreparation(),
        status: "error",
        error: error instanceof Error ? error.message : "Could not inspect the media file.",
      };
      if (job.selectedIndex === index) syncSelectedAsset(job);
    });
}

function subtitleFile(job, index, trackId, format, prepared) {
  const asset = mediaAsset(job, index);
  const track = asset.subtitleTracks.find((item) => item.id === trackId);
  if (!track) throw new Error("Embedded subtitle track not found.");
  if (!track.supported) {
    throw new Error("This image-based subtitle track cannot be converted to browser text.");
  }
  if (format === "ass" && !track.styled) {
    throw new Error("This subtitle track does not contain ASS/SSA styling.");
  }

  const output = prepared.subtitles.get(`${track.id}:${format === "ass" ? "ass" : "webvtt"}`);
  if (!output) throw new Error("The requested subtitle asset was not prepared.");
  return output;
}

function subtitleFontFile(job, index, fontId, prepared) {
  const asset = mediaAsset(job, index);
  const font = asset.subtitleTracks
    .flatMap((track) => track.fonts || [])
    .find((item) => item.id === fontId);
  if (!font) throw new Error("Embedded subtitle font not found.");

  const output = prepared.fonts.get(font.id);
  if (!output) throw new Error("The requested embedded font was not prepared.");
  return { path: output, mimeType: font.mimeType };
}

function needsHlsPlayback(asset, fileName) {
  const extension = path.extname(fileName).toLowerCase();
  const audioTracks = asset.audioTracks || [];
  if (
    [".mp4", ".m4v", ".mov"].includes(extension) &&
    canCopyH264Video(asset) &&
    audioTracks.length <= 1 &&
    (!audioTracks[0] || ["aac", "mp3", "opus"].includes(audioTracks[0].codec))
  ) {
    return false;
  }
  if (
    extension === ".webm" &&
    ["av1", "vp8", "vp9"].includes(asset.videoCodec) &&
    startsAtBrowserZero(asset) &&
    audioTracks.length <= 1 &&
    (!audioTracks[0] || ["opus", "vorbis"].includes(audioTracks[0].codec))
  ) {
    return false;
  }
  return true;
}

function agentFileSnapshot(job, index, file, downloaded, progress, downloadReady) {
  const asset = mediaAsset(job, index);
  const name = file.name;
  const relativePath = job.kind === "magnet" && !job.seed
    ? torrentFilePath(file)
    : torrentFileName(file);
  const fingerprint = fileIdentityFingerprint(job, index, file);
  return {
    index,
    itemId: `${job.id}-f${index}`,
    path: relativePath,
    name,
    size: file.size,
    duration: asset.duration,
    downloaded,
    progress,
    downloadReady,
    ready: downloadReady && asset.status === "ready" && Boolean(fingerprint),
    selected: index === job.selectedIndex,
    fingerprint,
    status: asset.status,
    subtitleStatus: asset.subtitleStatus,
    subtitleError: asset.subtitleError,
    subtitleAssetStatus: asset.subtitleAssetStatus,
    subtitleAssetError: asset.subtitleAssetError,
    audioTracks: asset.audioTracks,
    chapters: asset.chapters,
    subtitles: asset.subtitleTracks,
    preparation: asset.preparation,
    streamUrl: `http://${HOST}:${PORT}/stream/${encodeURIComponent(job.id)}/${index}`,
    hlsUrl: needsHlsPlayback(asset, relativePath)
      ? `http://${HOST}:${PORT}/hls/${encodeURIComponent(job.id)}/${index}/h264/master.m3u8`
      : null,
  };
}

function torrentFiles(job) {
  if (job.seed && job.file) {
    return [agentFileSnapshot(job, 0, job.file, job.file.size, 100, job.status === "ready")];
  }
  if (!job.torrent) return [];
  return job.torrent.files.map((file, index) => {
    const progress = verifiedTorrentFileProgress(file);
    return agentFileSnapshot(
      job,
      index,
      { name: torrentFileName(file), path: torrentFilePath(file), size: file.length },
      Math.round(file.length * progress),
      Math.round(progress * 1000) / 10,
      Boolean(file.done)
    );
  });
}

function snapshot(job) {
  syncSelectedAsset(job);
  const files =
    job.kind === "magnet"
      ? torrentFiles(job)
      : job.file
        ? [agentFileSnapshot(
            job,
            0,
            job.file,
            job.downloaded,
            job.file.size ? Math.round((job.downloaded / job.file.size) * 1000) / 10 : 0,
            job.status === "ready" && job.downloaded === job.file.size
          )]
        : [];

  const selected = files.find((file) => file.selected);
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    paused: Boolean(job.paused),
    torrentSilenced: Boolean(job.torrentSilenced),
    progress: selected?.progress || 0,
    infoHash: job.torrent?.infoHash || null,
    // Magnet URLs can carry private tracker credentials. Publication is an
    // explicit seed/share operation, never part of routine job snapshots.
    magnetURI: null,
    sourceIdentity: sourceIdentity(job.kind, job.value),
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
    seedLeaseCount: job.seed && job.seedLeases instanceof Map
      ? Array.from(job.seedLeases.values()).filter((expiresAt) => expiresAt > Date.now()).length
      : 0,
    peers: job.torrent?.numPeers || 0,
    uploadSpeed: job.torrent?.uploadSpeed || 0,
    uploaded: job.torrent?.uploaded || 0,
    creationProgress: job.torrentCreationProgress || 0,
    trackerAnnounces: job.trackerAnnounces || 0,
    torrent: job.torrentTelemetry?.summary() || null,
    seedStartedAt: job.seedStartedAt,
    platform: process.platform,
    torrentPort: client.torrentPort || TORRENT_PORT,
    dhtPort: client.dhtPort || DHT_PORT,
    webRtcSupported: WebTorrent.WEBRTC_SUPPORT,
    identityFingerprint: job.identityFingerprint || null,
    error: job.error || null,
    subtitleStatus: job.subtitleStatus,
    subtitleError: job.subtitleError,
    subtitleAssetStatus: job.subtitleAssetStatus,
    subtitleAssetError: job.subtitleAssetError,
    audioTracks: job.audioTracks || [],
    chapters: job.chapters || [],
    subtitles: job.subtitleTracks || [],
    preparation: job.preparation,
    managed: Boolean(job.managed),
    pinned: Boolean(job.pinned),
    libraryCollectionId: job.libraryCollectionId || null,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    lastAccessedAt: job.lastAccessedAt,
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

function orderedTorrentVideoIndexes(torrent) {
  return torrent.files
    .map((file, index) => ({ index, path: torrentFilePath(file) }))
    .filter((item) => VIDEO_EXTENSIONS.test(item.path))
    .sort((left, right) =>
      left.path.localeCompare(right.path, "en", { numeric: true, sensitivity: "base" }) ||
      left.index - right.index
    )
    .map((item) => item.index);
}

const MAX_BANDWIDTH_TARGETS = 16;
let lastTorrentBandwidthPlanKey = "";

function pendingTorrentTargets() {
  const targets = [];
  if (mediaPriorityTargets.length) {
    for (const target of mediaPriorityTargets) {
      const job = jobs.get(target.jobId);
      const file = job?.torrent?.files?.[target.fileIndex];
      if (job?.kind !== "magnet" || job.seed || !file || file.done) continue;
      targets.push({ jobId: job.id, fileIndex: target.fileIndex });
      if (targets.length >= MAX_BANDWIDTH_TARGETS) break;
    }
    return targets;
  }

  for (const job of jobs.values()) {
    if (job.kind !== "magnet" || job.seed || !job.torrent?.files?.length) continue;
    for (const fileIndex of orderedTorrentVideoIndexes(job.torrent)) {
      if (job.torrent.files[fileIndex].done) continue;
      targets.push({ jobId: job.id, fileIndex });
      if (targets.length >= MAX_BANDWIDTH_TARGETS) return targets;
    }
  }
  return targets;
}

function productiveTorrentPeers(torrent) {
  return (torrent?.wires || []).filter((wire) =>
    !wire.destroyed && wire.peerChoking === false
  ).length;
}

function bandwidthTargetSnapshot(target) {
  const job = jobs.get(target.jobId);
  const file = job?.torrent?.files?.[target.fileIndex];
  if (!job || !file) return null;
  return {
    ...target,
    key: mediaTargetKey(target.jobId, target.fileIndex),
    downloaded: Math.round(file.length * verifiedTorrentFileProgress(file)),
    done: file.done,
    peers: job.torrent.numPeers,
    productivePeers: productiveTorrentPeers(job.torrent),
  };
}

function refreshTorrentSelections(reason = "priority-plan") {
  const targets = pendingTorrentTargets()
    .map(bandwidthTargetSnapshot)
    .filter(Boolean);
  torrentBandwidth = torrentBandwidthGovernor.update({
    targets,
    totalDownloadSpeed: client.downloadSpeed,
    resourceMode: RESOURCE_MODE,
    sampledAt: Date.now(),
  });

  const targetsByKey = new Map(targets.map((target) => [target.key, target]));
  const activeTargets = [];
  const foreground = targetsByKey.get(torrentBandwidth.foregroundKey);
  if (foreground) activeTargets.push({ ...foreground, priority: 100 });
  torrentBandwidth.backgroundKeys.forEach((key, index) => {
    const target = targetsByKey.get(key);
    if (target) activeTargets.push({
      ...target,
      priority: Math.max(1, 20 - index),
    });
  });

  const selectionsByJob = new Map();
  torrentDownloadRoles = new Map();
  for (const target of activeTargets) {
    let selections = selectionsByJob.get(target.jobId);
    if (!selections) selectionsByJob.set(target.jobId, selections = []);
    selections.push({ fileIndex: target.fileIndex, priority: target.priority });
    if (target.key === torrentBandwidth.foregroundKey) {
      torrentDownloadRoles.set(target.jobId, "foreground");
    } else if (!torrentDownloadRoles.has(target.jobId)) {
      torrentDownloadRoles.set(target.jobId, "background");
    }
  }

  const force = reason === "verification-retry";
  for (const job of jobs.values()) {
    if (job.kind !== "magnet" || job.seed || !job.torrent?.files?.length) continue;
    const selections = selectionsByJob.get(job.id) || [];
    const selectionKey = selections
      .map((selection) => selection.fileIndex + ":" + selection.priority)
      .join(",");
    if (!force && job.lastTorrentSelectionKey === selectionKey) continue;
    if (job.torrentSilenced && selections.length > 0) restoreLiveTorrentNetworking(job);
    replaceTorrentSelections(job.torrent, selections);
    job.lastTorrentSelectionKey = selectionKey;
    agentLogger.info("torrent_download_priority_changed", {
      reason,
      jobId: job.id,
      fileIndexes: selections.map((selection) => selection.fileIndex),
      priorities: selections.map((selection) => selection.priority),
    });
  }

  const planKey = JSON.stringify({
    mode: torrentBandwidth.mode,
    foregroundKey: torrentBandwidth.foregroundKey,
    backgroundKeys: torrentBandwidth.backgroundKeys,
  });
  if (planKey !== lastTorrentBandwidthPlanKey) {
    lastTorrentBandwidthPlanKey = planKey;
    agentLogger.info("torrent_bandwidth_plan_changed", {
      reason,
      ...torrentBandwidth,
    });
  }
  refreshTorrentPressure(reason);
  return torrentBandwidth;
}

function liveTorrentPeerCount(torrent) {
  if (!torrent || !Array.isArray(torrent.wires)) return 0;
  let count = 0;
  for (const wire of torrent.wires) {
    if (wire && !wire.destroyed) count += 1;
  }
  return count;
}

function stopSeedReannounceTimer(job) {
  if (job.seedReannounceTimer) {
    clearInterval(job.seedReannounceTimer);
    job.seedReannounceTimer = null;
  }
}

function startSeedReannounceTimer(job, torrent) {
  stopSeedReannounceTimer(job);
  if (!job.seed || !torrent || torrent.destroyed) return;
  if (!networkState.torrentEnabled || networkState.offline) return;
  job.seedReannounceTimer = setInterval(() => {
    if (torrent.destroyed || liveTorrentPeerCount(torrent) > 0) return;
    torrent.discovery?.tracker?.update({ numwant: 50 });
  }, 25_000);
  job.seedReannounceTimer.unref?.();
}

function silenceLiveTorrentNetworking(job) {
  const torrent = job.torrent;
  if (!torrent || torrent.destroyed) return false;
  const changed = silenceTorrentNetworking(torrent);
  job.torrentSilenced = true;
  stopSeedReannounceTimer(job);
  return changed;
}

function restoreLiveTorrentNetworking(job) {
  if (!networkState.torrentEnabled || networkState.offline) return false;
  const torrent = job.torrent;
  if (!torrent || torrent.destroyed) return false;
  const changed = restoreTorrentNetworking(torrent);
  job.torrentSilenced = false;
  if (job.seed) startSeedReannounceTimer(job, torrent);
  return changed;
}

/**
 * Silence a finished magnet download that is not actively shared, so it stops
 * announcing to trackers/DHT. "Finished" uses the files this job actually
 * needs (media-priority plan, or every video file when no plan exists), not
 * `torrent.done`, which only fires when every file of the torrent is complete.
 * "Not actively shared" means no live peer wires remain; while peers are
 * connected the torrent keeps announcing, and the periodic sweep silences it
 * once the last peer disconnects.
 */
function maybeSilenceCompletedTorrent(job) {
  if (job.seed || job.kind !== "magnet") return false;
  if (!networkState.torrentEnabled || networkState.offline) return false;
  const torrent = job.torrent;
  if (!torrent || torrent.destroyed || !torrent.files?.length) return false;
  if (torrent.discovery && torrent.discovery.destroyed) return false;
  const indexes = requiredTorrentMediaIndexes(job);
  if (!torrentSelectedFilesComplete(torrent, indexes)) return false;
  if (liveTorrentPeerCount(torrent) > 0) return false;
  silenceLiveTorrentNetworking(job);
  agentLogger.info("torrent_networking_silenced", {
    jobId: job.id,
    infoHash: torrent.infoHash,
    reason: "download-complete",
  });
  return true;
}

/**
 * Apply the runtime network policy to every live torrent. With the kill switch
 * off (or offline mode on) every torrent is silenced and seed re-announce
 * timers stop; re-enabling restores every torrent and then re-silences only
 * finished downloads that are not shared (feature #1).
 */
let networkPolicyApplied = false;
function applyNetworkPolicy(reason) {
  const silenceAll = !networkState.torrentEnabled || networkState.offline;
  let silenced = 0;
  let restored = 0;
  if (networkState.offline) {
    for (const job of jobs.values()) {
      if (job.kind === "direct" && job.abortController) job.abortController.abort();
    }
  }
  for (const job of jobs.values()) {
    const torrent = job.torrent;
    if (!torrent || torrent.destroyed) continue;
    if (silenceAll) {
      if (silenceLiveTorrentNetworking(job)) silenced += 1;
    } else {
      // Only restore networking on a policy transition within this process
      // (e.g. the kill switch being re-enabled). On the very first, startup
      // application a `torrentSilenced` flag can only mean a persisted
      // download-complete silence (or a persisted kill-switch silence, which
      // the silenceAll branch already re-applied); restoring it here would
      // make fully-downloaded torrents announce again until a re-completion
      // event re-silenced them.
      if (networkPolicyApplied && job.torrentSilenced && restoreLiveTorrentNetworking(job)) restored += 1;
      if (job.kind === "magnet" && !job.seed) {
        if (maybeSilenceCompletedTorrent(job)) silenced += 1;
      }
    }
  }
  networkPolicyApplied = true;
  agentLogger.info("network_policy_applied", {
    reason,
    torrentEnabled: networkState.torrentEnabled,
    offline: networkState.offline,
    silenced,
    restored,
  });
  void persistAgentConfig().catch((error) => {
    agentLogger.warn("network_policy_persist_failed", { error });
  });
}

/**
 * Background consistency sweep: torrents whose discovery started after they
 * were added (metadata/seeding) are silenced while the policy is off, and
 * finished non-shared downloads are silenced as soon as their last peer leaves.
 */
function enforceNetworkPolicy() {
  const silenceAll = !networkState.torrentEnabled || networkState.offline;
  for (const job of jobs.values()) {
    const torrent = job.torrent;
    if (!torrent || torrent.destroyed) continue;
    if (silenceAll) {
      if (!torrent.discovery || !torrent.discovery.destroyed) silenceLiveTorrentNetworking(job);
    } else if (job.kind === "magnet" && !job.seed && !job.torrentSilenced) {
      maybeSilenceCompletedTorrent(job);
    }
  }
}

function startTorrent(job, { restoreMetadata = false } = {}) {
  job.paused = false;
  job.error = null;
  job.status = "metadata";
  agentLogger.info("torrent_start_requested", { jobId: job.id, managed: Boolean(job.managed) });
  let torrent;
  try {
    torrent = client.add(job.value, {
      path: path.join(DOWNLOAD_DIR, job.id),
      deselect: true,
    });
  } catch (error) {
    job.status = "error";
    const category = classifyTrackerError(error);
    job.error = `Torrent could not be started (${category}).`;
    agentLogger.error("torrent_start_failed", { jobId: job.id, category });
    job.updatedAt = Date.now();
    return;
  }
  job.torrentTelemetry?.dispose();
  job.torrent = torrent;
  job.torrentSilenced = false;
  job.torrentTelemetry = createTorrentTelemetry(torrent);
  if (!networkState.torrentEnabled || networkState.offline) {
    // The kill switch / offline mode must also cover newly started torrents:
    // silence them as soon as their discovery exists.
    queueMicrotask(() => {
      if (job.torrent === torrent && !torrent.destroyed) silenceLiveTorrentNetworking(job);
    });
  }
  // A persisted "download-complete" silence is deliberately NOT re-applied here.
  // Re-silencing before WebTorrent starts discovery would permanently block the
  // magnet's metadata fetch and strand the restored job at "metadata" with an
  // empty file list. Once metadata loads and the on-disk files verify,
  // maybeSilenceCompletedTorrent (invoked from the metadata/file-done/torrent-done
  // handlers and the periodic network sweep) re-silences the finished download.
  torrent.on("wire", () => refreshTorrentPressure("wire-connected"));
  installTorrentPieceRecovery(
    torrent,
    () => {
      const planned = mediaPriorityTargets.find((target) =>
        target.jobId === job.id && !torrent.files?.[target.fileIndex]?.done
      );
      return torrent.files?.[planned?.fileIndex] || torrent.files?.[job.selectedIndex];
    },
    (event) => {
      const { reason, disconnected } = event;
      torrentRecoveryTelemetry.record(job.id, event);
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
    if (job.paused) return;
    // A torrent that was replaced (re-added) can still emit its metadata event
    // after job.torrent has moved on to a new torrent object. Its file list may
    // differ, so selectTorrentFile would throw "Torrent file not found." (and
    // WebTorrent's async _onMetadata turns that into an unhandled rejection).
    // Ignore metadata events from a torrent that is no longer the job's current
    // torrent.
    if (job.torrent !== torrent) return;
    agentLogger.info("torrent_metadata_ready", {
      jobId: job.id,
      infoHash: torrent.infoHash,
      length: torrent.length,
      pieceLength: torrent.pieceLength,
      pieceCount: torrent.pieces?.length || 0,
      files: torrent.files.map((file, index) => ({ index, name: torrentFileName(file), size: file.length })),
    });
    const videos = orderedTorrentVideoIndexes(torrent);
    for (const index of videos) {
      const asset = mediaAsset(job, index);
      asset.status = torrent.files[index].done ? "verifying" : "downloading";
    }
    if (videos[0] !== undefined) {
      selectTorrentFile(job, videos[0], { recordAccess: !restoreMetadata });
    }
    torrent.files.forEach((file, index) => {
      file.on("done", () => {
        agentLogger.info("torrent_file_downloaded", { jobId: job.id, fileIndex: index, size: file.length });
        refreshTorrentSelections("file-downloaded");
        if (VIDEO_EXTENSIONS.test(file.path || file.name)) void completeSelectedFile(job, index);
        maybeSilenceCompletedTorrent(job);
      });
    });
    job.status = "downloading";
    if (torrent.files[job.selectedIndex]?.done) void completeSelectedFile(job);
    refreshTorrentSelections("metadata-ready");
    maybeSilenceCompletedTorrent(job);
    job.updatedAt = Date.now();
  });
  torrent.on("download", () => {
    if (job.paused) return;
    if (job.status !== "ready") job.status = "downloading";
    job.updatedAt = Date.now();
  });
  torrent.on("done", () => {
    if (job.paused) return;
    agentLogger.info("torrent_download_complete", { jobId: job.id, infoHash: torrent.infoHash });
    for (const index of orderedTorrentVideoIndexes(torrent)) {
      if (torrent.files[index].done) void completeSelectedFile(job, index);
    }
    refreshTorrentSelections("torrent-complete");
    maybeSilenceCompletedTorrent(job);
  });
  torrent.on("warning", (error) => {
    const category = classifyTrackerError(error);
    agentLogger.warn("torrent_warning", { jobId: job.id, category });
    job.warning = `Torrent tracker ${category}.`;
    job.updatedAt = Date.now();
  });
  torrent.on("error", (error) => {
    if (job.paused) return;
    agentLogger.error("torrent_error", { jobId: job.id, category: classifyTrackerError(error) });
    job.status = "error";
    job.error = `Torrent failed (${classifyTrackerError(error)}).`;
    job.updatedAt = Date.now();
  });
}

async function startDirect(job) {
  let writable = null;
  try {
    job.paused = false;
    job.error = null;
    job.status = "downloading";
    const controller = new AbortController();
    job.abortController = controller;
    const target = await assertPublicHttp(job.value);
    if (job.paused || controller.signal.aborted) throw new DOMException("Download paused.", "AbortError");
    const fileName = safeName(job.file?.name || job.label ||
      decodeURIComponent(target.pathname.split("/").pop() || "video.mp4"));
    const directory = path.join(DOWNLOAD_DIR, job.id);
    if (job.managed) {
      const claim = await claimManagedDirectory(job.id, {
        ownershipToken: job.ownershipToken,
        restoreMetadata: !job.ownershipToken,
      });
      job.ownershipToken = claim.ownershipToken;
    }
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    const existing = await stat(filePath)
      .then((info) => info.isFile() ? info.size : 0)
      .catch((error) => error?.code === "ENOENT" ? 0 : Promise.reject(error));
    const response = await fetchPublic(target, {
      signal: controller.signal,
      headers: existing > 0 ? { range: `bytes=${existing}-` } : {},
    });
    await assertPublicHttp(response.url || target.href);
    const completeSize = Number(/^bytes \*\/(\d+)$/.exec(
      response.headers.get("content-range") || "")?.[1]);
    if (response.status === 416 && existing > 0 && completeSize === existing) {
      job.file = {
        name: fileName,
        size: existing,
        path: filePath,
        type: contentType(fileName),
      };
      job.downloaded = existing;
    } else {
      if (!response.ok || !response.body) {
        throw new Error(`Download failed with status ${response.status}.`);
      }

      const contentRange = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
        response.headers.get("content-range") || "");
      const appending = response.status === 206 && existing > 0 && Number(contentRange?.[1]) === existing;
      const responseSize = Number(response.headers.get("content-length")) || 0;
      const size = contentRange?.[3] && contentRange[3] !== "*"
        ? Number(contentRange[3])
        : (appending ? existing : 0) + responseSize;
      job.downloaded = appending ? existing : 0;
      job.file = {
        name: fileName,
        size,
        path: filePath,
        type: response.headers.get("content-type") || "application/octet-stream",
      };
      writable = createWriteStream(filePath, { flags: appending ? "a" : "w" });

      for await (const chunk of response.body) {
        if (job.paused) throw new DOMException("Download paused.", "AbortError");
        job.downloaded += chunk.length;
        job.updatedAt = Date.now();
        if (!writable.write(chunk)) await once(writable, "drain");
      }
      writable.end();
      await once(writable, "finish");
      writable = null;
    }

    const completed = await stat(filePath);
    job.file.size = completed.size;
    job.downloaded = completed.size;
    job.selectedIndex = 0;
    const asset = mediaAsset(job, 0);
    asset.status = "ready";
    await identifySelectedFile(job, 0);
    syncSelectedAsset(job);
    job.status = "ready";
    markJobCompleted(job);
    refreshPreparationScheduling();
    queueMediaPreparation(job, 0);
  } catch (error) {
    writable?.destroy();
    if (job.paused || error?.name === "AbortError" || error?.code === "EROFFLINE") {
      job.paused = true;
      job.status = "paused";
      job.error = null;
    } else {
      job.status = "error";
      job.error = error instanceof Error ? error.message : "Direct download failed.";
    }
    job.updatedAt = Date.now();
  } finally {
    job.abortController = null;
    persistJobs();
  }
}

function runDirect(job) {
  if (job.directPromise) return job.directPromise;
  const directPromise = startDirect(job);
  const trackedPromise = directPromise.finally(() => {
    if (job.directPromise === trackedPromise) job.directPromise = null;
  });
  job.directPromise = trackedPromise;
  return trackedPromise;
}

function createJob(source) {
  const kind = source.kind === "magnet" ? "magnet" : "direct";
  const now = Date.now();
  const job = {
    id: String(source.id),
    kind,
    value: String(source.value || "").trim(),
    label: String(source.label || "video").slice(0, 180),
    managed: source.managed === undefined ? !source.seed : Boolean(source.managed),
    pinned: Boolean(source.pinned) ||
      (source.libraryCollectionId
        ? libraryCatalog.isCollectionPinned(source.libraryCollectionId)
        : libraryCatalog.isManagedJobPinned(source.id)),
    libraryCollectionId: /^[a-f0-9]{24}$/.test(String(source.libraryCollectionId || ""))
      ? String(source.libraryCollectionId)
      : null,
    transient: Boolean(source.transient),
    ownershipToken: OWNERSHIP_TOKEN_PATTERN.test(String(source.ownershipToken || ""))
      ? String(source.ownershipToken)
      : null,
    cleanupCommit: false,
    restoredFromManifest: Boolean(source.restoredFromManifest),
    legacyUnowned: Boolean(source.legacyUnowned),
    paused: Boolean(source.paused),
    createdAt: Number(source.createdAt) || now,
    completedAt: Number(source.completedAt) || null,
    lastAccessedAt: Number(source.lastAccessedAt) || now,
    retentionMetadataVersion: source.retentionMetadataVersion === undefined
      ? RETENTION_METADATA_VERSION
      : Number(source.retentionMetadataVersion) === RETENTION_METADATA_VERSION
        ? RETENTION_METADATA_VERSION
        : 0,
    seed: Boolean(source.seed),
    seedLeases: new Map(),
    seedLeaseGraceUntil: null,
    seedPath: source.seedPath || null,
    identityFingerprint: source.identityFingerprint || null,
    identityFingerprintKey: source.identityFingerprintKey || null,
    torrentVerifiedKey: source.torrentVerifiedKey || null,
    status: "queued",
    error: null,
    downloaded: Math.max(0, Number(source.downloaded) || 0),
    selectedIndex: null,
    assets: new Map(),
    lastTorrentSelectionKey: null,
    torrent: null,
    torrentSilenced: false,
    torrentTelemetry: null,
    file: null,
    audioTracks: [],
    chapters: [],
    subtitleTracks: [],
    mediaStreams: [],
    subtitleAssetStatus: "waiting",
    subtitleAssetError: null,
    videoCodec: null,
    videoPixelFormat: null,
    videoProfile: null,
    videoStartTime: null,
    subtitleStatus: "waiting",
    subtitleError: null,
    diskInvalidations: 0,
    peerFailures: 0,
    peersRejected: 0,
    torrentCreationProgress: 0,
    trackerAnnounces: 0,
    trackerWarnings: [],
    seedStartedAt: null,
    seedReannounceTimer: null,
    abortController: null,
    directPromise: null,
    preparation: { status: "waiting", error: null, encoder: null, fallback: false },
    updatedAt: Number(source.updatedAt) || now,
  };
  jobs.set(job.id, job);
  applyRestoredTorrentState(job, source, mediaAsset);
  return job;
}

function persistedJobs() {
  const live = Array.from(jobs.values()).filter((job) => !job.transient).map((job) => ({
    id: job.id,
    kind: job.kind,
    value: job.value,
    label: job.label,
    managed: Boolean(job.managed),
    pinned: Boolean(job.pinned),
    libraryCollectionId: job.libraryCollectionId,
    ownershipToken: job.ownershipToken,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    lastAccessedAt: job.lastAccessedAt,
    retentionMetadataVersion: job.retentionMetadataVersion,
    updatedAt: job.updatedAt,
    seed: Boolean(job.seed),
    paused: Boolean(job.paused),
    seedPath: job.seedPath,
    downloaded: job.downloaded,
    identityFingerprint: job.identityFingerprint,
    identityFingerprintKey: job.identityFingerprintKey,
    torrentVerifiedKey: job.torrentVerifiedKey || null,
    ...persistedTorrentState(job),
    selectedIndex: job.selectedIndex,
    file: job.file
      ? { name: job.file.name, size: job.file.size, path: job.file.path, type: job.file.type }
      : null,
  }));
  const liveIds = new Set(live.map((record) => record.id));
  return [
    ...live,
    ...failedRestoreRecords.filter((record) =>
      !record?.id || !liveIds.has(String(record.id))),
  ];
}

function persistJobs() {
  if (restoringJobs) return;
  jobStore.schedule(persistedJobs());
}

function touchJob(job) {
  const now = Date.now();
  job.lastAccessedAt = now;
  job.retentionMetadataVersion = RETENTION_METADATA_VERSION;
  job.updatedAt = now;
  persistJobs();
}

function requiredTorrentMediaIndexes(job) {
  const planned = mediaPriorityTargets
    .filter((target) => target.jobId === job.id)
    .map((target) => target.fileIndex)
    .filter((index) => job.torrent?.files?.[index]);
  return planned.length ? planned : orderedTorrentVideoIndexes(job.torrent);
}

function markJobCompleted(job) {
  if (job.kind === "magnet" && !job.seed && job.torrent?.files?.length) {
    const requiredIndexes = requiredTorrentMediaIndexes(job);
    if (
      !requiredIndexes.length ||
      requiredIndexes.some((index) => mediaAsset(job, index).status !== "ready")
    ) {
      return false;
    }
  }
  const now = Date.now();
  job.completedAt ||= now;
  job.lastAccessedAt ||= now;
  job.updatedAt = now;
  return true;
}

async function addDownload(source, { restoreMetadata = false, ownershipToken = null } = {}) {
  const id = String(source?.id || "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error("Invalid source id.");
  const kind = source.kind === "magnet" ? "magnet" : "direct";
  const value = String(source.value || "").trim();
  const existing = jobs.get(id);
  if (existing) {
    if (!existingJobMatchesSource(existing, kind, value)) {
      throw new Error("This source id is already bound to different media.");
    }
    return existing;
  }
  if (kind === "magnet") {
    if (/^magnet:\?/i.test(value) && !isSupportedMagnet(value)) {
      throw new Error("Magnet link needs a valid BitTorrent v1 info hash (BTIH).");
    }
    if (!/^magnet:\?/i.test(value) && !/^https?:\/\//i.test(value)) {
      throw new Error("Invalid magnet or torrent source.");
    }
  }

  const restoredMetadata = restoreMetadata
    ? {
        managed: source.managed,
        pinned: source.pinned,
        libraryCollectionId: source.libraryCollectionId,
        paused: source.paused,
        downloaded: source.downloaded,
        createdAt: source.createdAt,
        completedAt: source.completedAt,
        lastAccessedAt: source.lastAccessedAt,
        retentionMetadataVersion: kind === "magnet" && !source.seed &&
          Number(source.retentionMetadataVersion) !== RETENTION_METADATA_VERSION
          ? 0
          : RETENTION_METADATA_VERSION,
        updatedAt: source.updatedAt,
        identityFingerprint: source.identityFingerprint,
        identityFingerprintKey: source.identityFingerprintKey,
        torrentVerifiedKey: source.torrentVerifiedKey || null,
        torrentSilenced: Boolean(source.torrentSilenced),
        torrentVerifiedKeys: source.torrentVerifiedKeys,
        ownershipToken: source.ownershipToken,
      }
    : {};
  const managed = restoredMetadata.managed === undefined ? true : Boolean(restoredMetadata.managed);
  const claim = managed
    ? await claimManagedDirectory(id, {
        ownershipToken: restoreMetadata ? restoredMetadata.ownershipToken : ownershipToken,
        restoreMetadata,
      })
    : null;
  const job = createJob({
    id,
    kind,
    value,
    label: source.label,
    ...restoredMetadata,
    managed,
    ownershipToken: claim?.ownershipToken || null,
    legacyUnowned: Boolean(claim?.legacyUnowned),
    restoredFromManifest: restoreMetadata,
  });
  if (kind === "magnet") startTorrent(job, { restoreMetadata });
  else void runDirect(job);
  persistJobs();
  return job;
}

function validJobId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error("Invalid source id.");
  return id;
}

function managedJobDirectory(id) {
  return path.join(DOWNLOAD_DIR, validJobId(id));
}

function ownershipMarkerPath(directory) {
  return path.join(directory, OWNERSHIP_MARKER_NAME);
}

async function readManagedDirectoryOwnership(directory) {
  let markerInfo;
  try {
    markerInfo = await lstat(ownershipMarkerPath(directory));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) return null;
  try {
    const marker = JSON.parse(await readFile(ownershipMarkerPath(directory), "utf8"));
    if (
      Number(marker?.version) !== OWNERSHIP_MARKER_VERSION ||
      !/^[a-zA-Z0-9-]{8,80}$/.test(String(marker?.id || "")) ||
      !OWNERSHIP_TOKEN_PATTERN.test(String(marker?.token || ""))
    ) return null;
    return { id: String(marker.id), token: String(marker.token) };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function claimManagedDirectory(id, {
  ownershipToken = null,
  restoreMetadata = false,
} = {}) {
  const validId = validJobId(id);
  const expectedToken = OWNERSHIP_TOKEN_PATTERN.test(String(ownershipToken || ""))
    ? String(ownershipToken)
    : null;
  const directory = managedJobDirectory(validId);
  let directoryInfo = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!directoryInfo) {
    try {
      await mkdir(directory);
      directoryInfo = await lstat(directory);
      const token = expectedToken || randomUUID();
      await writeFile(ownershipMarkerPath(directory), JSON.stringify({
        version: OWNERSHIP_MARKER_VERSION,
        id: validId,
        token,
      }), { flag: "wx", mode: 0o600 });
      return { directory, ownershipToken: token, legacyUnowned: false };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      directoryInfo = await lstat(directory);
    }
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("The download id collides with an existing filesystem entry.");
  }
  const marker = await readManagedDirectoryOwnership(directory);
  if (marker?.id === validId && expectedToken && marker.token === expectedToken) {
    return { directory, ownershipToken: marker.token, legacyUnowned: false };
  }
  if (restoreMetadata && marker?.id === validId && !expectedToken) {
    return { directory, ownershipToken: marker.token, legacyUnowned: false };
  }
  if (restoreMetadata && !marker && !expectedToken) {
    // Older manifests predate ownership markers. They may keep using their payload,
    // but remain intentionally ineligible for recursive deletion.
    return { directory, ownershipToken: null, legacyUnowned: true };
  }
  throw new Error("The download id collides with an existing folder that WatchPair does not own.");
}

async function managedDirectoryIsOwned(job) {
  if (!job?.managed || !OWNERSHIP_TOKEN_PATTERN.test(String(job.ownershipToken || ""))) {
    return false;
  }
  const directory = managedJobDirectory(job.id);
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return false;
  const marker = await readManagedDirectoryOwnership(directory).catch(() => null);
  return marker?.id === job.id && marker.token === job.ownershipToken;
}

async function claimConfirmedLegacyDirectory(job) {
  // Claim any managed job that lacks an ownership token (not just restored
  // legacy manifests). Retention cleanup authorizes deletion for these jobs, and
  // the realpath-containment plus no-existing-marker checks below keep the claim
  // safe.
  if (!job?.managed || job.ownershipToken) {
    return false;
  }
  const directory = managedJobDirectory(job.id);
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return false;
  const resolved = await realpath(directory).catch(() => null);
  if (!resolved || comparableFilesystemPath(resolved) !== comparableFilesystemPath(directory)) {
    return false;
  }
  if (await readManagedDirectoryOwnership(directory)) return false;
  const token = randomUUID();
  try {
    await writeFile(ownershipMarkerPath(directory), JSON.stringify({
      version: OWNERSHIP_MARKER_VERSION,
      id: job.id,
      token,
    }), { flag: "wx", mode: 0o600 });
  } catch {
    return false;
  }
  job.ownershipToken = token;
  job.legacyUnowned = false;
  persistJobs();
  await jobStore.flush();
  return managedDirectoryIsOwned(job);
}

function normalizedSourceValue(kind, value) {
  const normalized = String(value || "").trim();
  if (kind === "magnet") return magnetInfoHash(normalized) || normalized;
  try {
    return new URL(normalized).href;
  } catch {
    return normalized;
  }
}

function existingJobMatchesSource(job, kind, value) {
  return !job.seed && job.kind === kind &&
    normalizedSourceValue(kind, job.value) === normalizedSourceValue(kind, value);
}

function sourceIdentity(kind, value) {
  const canonical = normalizedSourceValue(kind, value);
  if (!canonical) return null;
  return createHash("sha256").update(`${kind}\0${canonical}`).digest("hex");
}

function seedPublicationMagnet(job) {
  if (!job?.seed) return null;
  const value = String(job.value || "");
  return /^magnet:\?/i.test(value) && magnetInfoHash(value) ? value : null;
}

function normalizedSeedLeaseId(value, { create = false } = {}) {
  const leaseId = String(value || "").trim();
  if (!leaseId && create) return `lease-${randomUUID().replaceAll("-", "")}`;
  if (!SEED_LEASE_PATTERN.test(leaseId)) throw new Error("A valid opaque seed lease id is required.");
  return leaseId;
}

function seedLeaseTtl(value) {
  const ttl = Number(value);
  return Number.isFinite(ttl)
    ? Math.max(1_000, Math.min(10 * 60_000, Math.floor(ttl)))
    : SEED_LEASE_DEFAULT_TTL_MS;
}

function activeSeedLeaseCount(job, now = Date.now()) {
  if (!(job?.seedLeases instanceof Map)) return 0;
  for (const [leaseId, expiresAt] of job.seedLeases) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) job.seedLeases.delete(leaseId);
  }
  return job.seedLeases.size;
}

async function acquireSeedLease(id, body) {
  let job = jobs.get(validJobId(id));
  if (!job) return null;
  if (!job.seed) throw new Error("Only a local seed can hold a publication lease.");
  if (job.paused) job = await resumeJob(job.id);
  const leaseId = normalizedSeedLeaseId(body?.leaseId, { create: true });
  const expiresAt = Date.now() + seedLeaseTtl(body?.ttlMs);
  job.seedLeases.set(leaseId, expiresAt);
  job.seedLeaseGraceUntil = null;
  if (job.torrentSilenced) restoreLiveTorrentNetworking(job);
  return { job, leaseId, expiresAt };
}

async function endSeedSharing(job) {
  if (jobs.get(job.id) !== job || activeSeedLeaseCount(job) > 0) return false;
  job.seedLeaseGraceUntil = null;
  if (job.managed) {
    if (!job.paused) await pauseJob(job.id, { ignoreSeedLeases: true });
    return true;
  }
  return stopJob(job.id, { ignoreSeedLeases: true });
}

async function releaseSeedLease(id, leaseIdValue) {
  const validId = validJobId(id);
  const leaseId = normalizedSeedLeaseId(leaseIdValue);
  const job = jobs.get(validId);
  if (!job) return { released: false, lastLease: true };
  if (!job.seed) throw new Error("Only a local seed can hold a publication lease.");
  activeSeedLeaseCount(job);
  const released = job.seedLeases.delete(leaseId);
  const lastLease = activeSeedLeaseCount(job) === 0;
  if (lastLease) await endSeedSharing(job);
  return { released, lastLease };
}

let seedLeaseSweepPromise = null;
function sweepSeedLeases() {
  if (seedLeaseSweepPromise) return seedLeaseSweepPromise;
  seedLeaseSweepPromise = (async () => {
    const now = Date.now();
    for (const job of Array.from(jobs.values())) {
      if (!job.seed || job.paused) continue;
      const hadLeases = job.seedLeases?.size > 0;
      const leaseCount = activeSeedLeaseCount(job, now);
      const graceExpired = Number.isFinite(job.seedLeaseGraceUntil) &&
        job.seedLeaseGraceUntil <= now;
      if (!leaseCount && (hadLeases || graceExpired)) await endSeedSharing(job);
    }
  })().catch((error) => {
    agentLogger.warn("seed_lease_sweep_failed", {
      category: error?.code ? String(error.code) : "unavailable",
    });
  }).finally(() => {
    seedLeaseSweepPromise = null;
  });
  return seedLeaseSweepPromise;
}

function comparableFilesystemPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function validateLibraryEntry(entry) {
  const copies = entry.copies?.length ? entry.copies : [{
    path: entry.path,
    physicalKey: entry.physicalKey,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
  }];
  for (const copy of copies) {
    try {
      const resolved = await realpath(copy.path);
      if (comparableFilesystemPath(resolved) !== comparableFilesystemPath(copy.path)) continue;
      const info = await stat(resolved, { bigint: true });
      if (!info.isFile()) continue;
      const physicalKey = info.ino !== 0n
        ? `${info.dev}:${info.ino}`
        : comparableFilesystemPath(resolved);
      const size = Number(info.size);
      const modifiedAt = Number(info.mtimeMs);
      if (
        physicalKey === copy.physicalKey &&
        size === copy.size &&
        modifiedAt === Number(copy.modifiedAt)
      ) return { path: resolved, info: { size, mtimeMs: modifiedAt } };
    } catch {
      // Try another exact physical copy before requiring a rescan.
    }
  }
  throw new Error("The library file changed after it was scanned; scan the library again.");
}

async function requireVerifiedLibraryEntry(entry) {
  if (entry.usable !== false) return entry;
  // The catalog can be stale: a managed torrent file finished verifying after
  // the last scan. Re-scan once and re-read the entry before rejecting.
  const scan = libraryCatalog.startScan();
  await scan.completion;
  const refreshed = libraryCatalog.getFile(entry.id);
  return refreshed && refreshed.usable !== false ? refreshed : null;
}

function confirmedLegacyJobIds(body) {
  if (!Array.isArray(body?.legacyJobs)) {
    throw new Error("Confirmed legacy cleanup jobs must be an array of ids.");
  }
  const confirmed = new Set();
  for (const value of body.legacyJobs) {
    if (typeof value !== "string") throw new Error("Invalid confirmed legacy cleanup job id.");
    confirmed.add(validJobId(value.trim()));
  }
  return Array.from(confirmed);
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

async function seedLocalFile({
  id,
  filePath,
  label,
  managed = false,
  restoreMetadata = false,
  ownershipToken = null,
  ...metadata
}) {
  validJobId(id);
  const resolvedPath = path.resolve(filePath);
  const existing = jobs.get(id);
  if (existing) {
    const existingSeedPath = existing.seedPath || existing.file?.path;
    if (existing.seed && existingSeedPath && comparableFilesystemPath(existingSeedPath) ===
      comparableFilesystemPath(resolvedPath)) {
      return existing.paused ? resumeJob(existing.id) : existing;
    }
    throw new Error("This source id is already bound to different media.");
  }
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error("The selected library entry is not a file.");
  const claim = managed
    ? await claimManagedDirectory(id, { ownershipToken, restoreMetadata })
    : null;

  const job = createJob({
    id,
    kind: "magnet",
    value: "",
    label: label || path.basename(resolvedPath),
    managed,
    ownershipToken: claim?.ownershipToken || null,
    ...metadata,
    legacyUnowned: Boolean(claim?.legacyUnowned),
    restoredFromManifest: restoreMetadata,
    seed: true,
    seedPath: resolvedPath,
  });
  job.seed = true;
  job.seedPath = resolvedPath;
  job.status = "metadata";
  job.selectedIndex = 0;
  job.downloaded = info.size;
  job.file = {
    name: path.basename(resolvedPath),
    size: info.size,
    path: resolvedPath,
    type: contentType(resolvedPath),
  };
  job.seedStartedAt = Date.now();
  const asset = mediaAsset(job, 0);
  asset.status = "ready";
  asset.identityFingerprint = await fingerprintPath(resolvedPath);
  asset.identityFingerprintKey = fileIdentityKey(0, job.file);
  syncSelectedAsset(job);

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
      markJobCompleted(job);
      if (activeSeedLeaseCount(job) === 0) {
        job.seedLeaseGraceUntil = Date.now() + SEED_LEASE_GRACE_MS;
      }
      queueMediaPreparation(job, 0);
      persistJobs();
    };
    const torrent = client.seed(resolvedPath, options, markServing);
    job.torrentTelemetry?.dispose();
    job.torrent = torrent;
    job.torrentSilenced = false;
    job.torrentTelemetry = createTorrentTelemetry(torrent);
    if (!networkState.torrentEnabled || networkState.offline) {
      queueMicrotask(() => {
        if (job.torrent === torrent && !torrent.destroyed) silenceLiveTorrentNetworking(job);
      });
    }
    torrent.once("metadata", () => publishMetadata(torrent));
    torrent.once("ready", () => markServing(torrent));
    torrent.on("trackerAnnounce", () => {
      job.trackerAnnounces += 1;
      job.updatedAt = Date.now();
    });
    torrent.on("wire", () => {
      refreshTorrentPressure("wire-connected");
      job.updatedAt = Date.now();
    });
    torrent.on("warning", (error) => {
      job.trackerWarnings = [classifyTrackerError(error)];
      job.updatedAt = Date.now();
    });
    torrent.once("error", (error) => {
      job.status = "error";
      job.error = `Torrent failed (${classifyTrackerError(error)}).`;
      job.updatedAt = Date.now();
    });
    startSeedReannounceTimer(job, torrent);
    torrent.on("upload", () => {
      job.updatedAt = Date.now();
    });
  } catch (error) {
    jobs.delete(id);
    throw error;
  }

  persistJobs();
  if (!restoringJobs) await jobStore.flush();
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

  const claim = await claimManagedDirectory(id);
  const directory = claim.directory;
  const target = path.join(directory, name);
  await rm(target, { force: true });
  await rename(partial, target);
  return seedLocalFile({
    id,
    filePath: target,
    label: name,
    managed: true,
    ownershipToken: claim.ownershipToken,
  });
}

async function scanLibrary(queryValue) {
  const files = libraryCatalog.listFiles({ query: queryValue, limit: 300 });
  if (!(await libraryCatalog.rootsReachable())) {
    // The configured folders are gone right now: keep serving the last-good
    // catalog, but mark the scan errored (so /library/match and friends also
    // refuse stale data) without making this request wait for a doomed scan.
    const scan = libraryCatalog.markScanError(
      "One or more configured library folders could not be scanned; the previous catalog was kept."
    );
    return { files, scan, stale: true };
  }
  // Refresh in the background; the listing itself never waits on the scan, so a
  // slow first scan (large library, cold fingerprint cache) cannot block the UI.
  const scan = libraryCatalog.startScan();
  return {
    files,
    scan: scan.operation,
    stale: false,
  };
}

async function attachLibraryFile({ id, entry, label }) {
  validJobId(id);
  if (jobs.has(id) && !(await stopJob(id))) {
    throw new Error("This source id is still in use by an active room.");
  }
  const validated = await validateLibraryEntry(entry);
  const info = validated.info;
  const job = createJob({
    id,
    kind: "direct",
    value: validated.path,
    label: label || entry.name,
    managed: false,
    libraryCollectionId: entry.collectionId,
    pinned: libraryCatalog.isCollectionPinned(entry.collectionId),
    transient: true,
  });
  job.file = {
    name: entry.name,
    size: info.size,
    path: validated.path,
    type: contentType(entry.name),
  };
  job.downloaded = info.size;
  job.selectedIndex = 0;
  const asset = mediaAsset(job, 0);
  asset.status = "ready";
  asset.identityFingerprint = await fingerprintPath(validated.path);
  asset.identityFingerprintKey = fileIdentityKey(0, job.file);
  syncSelectedAsset(job);
  await libraryCatalog.setFileFingerprint(entry.id, asset.identityFingerprint, info.size);
  job.status = "ready";
  markJobCompleted(job);
  queueMediaPreparation(job, 0);
  persistJobs();
  return job;
}

async function removeGeneratedArtifacts(jobId) {
  await hlsPlayback.removeJob(jobId);
  await Promise.all([
    rm(path.join(SUBTITLE_DIR, jobId), { recursive: true, force: true }),
    rm(path.join(MEDIA_DIR, jobId), { recursive: true, force: true }),
    rm(importPartPath(jobId), { force: true }),
  ]);
}

function generatedArtifactPaths(jobId) {
  const id = validJobId(jobId);
  return [
    path.join(HLS_DIR, "jobs", id),
    path.join(HLS_DIR, id),
    path.join(SUBTITLE_DIR, id),
    path.join(MEDIA_DIR, id),
    path.join(IMPORT_DIR, id + ".part"),
  ];
}

async function generatedArtifactBytes(jobId) {
  const sizes = await Promise.all(generatedArtifactPaths(jobId).map((target) => pathSize(target)));
  return sizes.reduce((total, bytes) => total + bytes, 0);
}

async function jobRemovalBytes(job) {
  const downloadBytes = job.managed
    ? await pathSize(path.join(DOWNLOAD_DIR, job.id))
    : 0;
  return downloadBytes + await generatedArtifactBytes(job.id);
}

async function legacyJobFilesystemExpired(job, settings, now) {
  if (
    retentionMetadataReliable(job) ||
    job.kind !== "magnet" ||
    job.seed ||
    !job.managed ||
    job.pinned
  ) return false;

  const latestMtimeMs = await pathLatestMtime(path.join(DOWNLOAD_DIR, job.id));
  return jobs.get(job.id) === job &&
    !retentionMetadataReliable(job) &&
    !job.pinned &&
    Number.isFinite(latestMtimeMs) &&
    now - latestMtimeMs >= settings.downloadRetentionDays * 24 * 60 * 60 * 1000;
}

function legacyDownloadSummary(job) {
  const label = String(job.label || "video")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
  return { id: job.id, label: safeName(label) };
}

async function destroyJobTransfer(job) {
  job.abortController?.abort();
  if (job.directPromise) await job.directPromise.catch(() => {});
  if (job.seedReannounceTimer) {
    clearInterval(job.seedReannounceTimer);
    job.seedReannounceTimer = null;
  }
  job.torrentTelemetry?.dispose();
  job.torrentTelemetry = null;
  if (job.torrent && !job.torrent.destroyed) {
    await new Promise((resolve) => job.torrent.destroy(resolve));
  }
  job.torrent = null;
  job.torrentSilenced = false;
}

async function restoreJobTransferAfterCleanup(job) {
  job.cleanupCommit = false;
  if (jobs.get(job.id) !== job) return;
  if (job.seed) {
    job.paused = true;
    job.status = "paused";
    await resumeJob(job.id);
    return;
  }
  if (job.kind === "magnet") {
    if (job.managed) {
      const claim = await claimManagedDirectory(job.id, {
        ownershipToken: job.ownershipToken,
        restoreMetadata: !job.ownershipToken,
      });
      job.ownershipToken = claim.ownershipToken;
    }
    startTorrent(job, { restoreMetadata: true });
  }
}

async function stopJob(id, {
  deleteFiles = false,
  automatic = false,
  expectedJob = null,
  ignoreSeedLeases = false,
} = {}) {
  const job = jobs.get(validJobId(id));
  if (!job || (expectedJob && job !== expectedJob)) return false;
  if (job.seed && !ignoreSeedLeases && activeSeedLeaseCount(job) > 0) return false;
  if (deleteFiles && job.managed && !(await managedDirectoryIsOwned(job))) return false;

  if (automatic) {
    const authorized = await prepareAutomaticJobDeletion(job, {
      isCurrent: () => jobs.get(job.id) === job,
      destroy: () => destroyJobTransfer(job),
      restore: () => restoreJobTransferAfterCleanup(job),
    });
    if (!authorized) return false;
    job.cleanupCommit = true;
  } else {
    await destroyJobTransfer(job);
  }

  if (deleteFiles && job.managed) {
    if (!(await managedDirectoryIsOwned(job))) {
      await restoreJobTransferAfterCleanup(job);
      return false;
    }
    try {
      // Ownership is deliberately checked immediately before recursive removal.
      await rm(managedJobDirectory(id), { recursive: true, force: true });
    } catch (error) {
      await restoreJobTransferAfterCleanup(job);
      throw error;
    }
  }
  jobs.delete(id);
  for (let index = preparationQueue.length - 1; index >= 0; index -= 1) {
    if (preparationQueue[index].job === job) preparationQueue.splice(index, 1);
  }
  refreshTorrentSelections("job-stopped");
  await removeGeneratedArtifacts(id);
  persistJobs();
  return true;
}

async function pauseJob(id, { ignoreSeedLeases = false } = {}) {
  const job = jobs.get(validJobId(id));
  if (!job) return null;
  if (job.seed && !ignoreSeedLeases && activeSeedLeaseCount(job) > 0) {
    throw new Error("This local seed is still shared by an active room.");
  }
  if (job.paused) return job;
  job.paused = true;
  job.status = "paused";
  job.error = null;
  job.updatedAt = Date.now();
  job.abortController?.abort();
  if (job.directPromise) await job.directPromise.catch(() => {});
  if (job.seedReannounceTimer) {
    clearInterval(job.seedReannounceTimer);
    job.seedReannounceTimer = null;
  }
  job.torrentTelemetry?.dispose();
  job.torrentTelemetry = null;
  if (job.torrent && !job.torrent.destroyed) {
    await new Promise((resolve) => job.torrent.destroy(resolve));
  }
  job.torrent = null;
  job.torrentSilenced = false;
  refreshTorrentSelections("job-paused");
  persistJobs();
  await jobStore.flush();
  return job;
}

async function resumeJob(id) {
  const job = jobs.get(validJobId(id));
  if (!job) return null;
  if (!job.paused) return job;
  job.paused = false;
  job.error = null;
  job.updatedAt = Date.now();
  if (job.seed) {
    const metadata = {
      id: job.id,
      filePath: job.seedPath || job.file?.path,
      label: job.label,
      managed: job.managed,
      pinned: job.pinned,
      libraryCollectionId: job.libraryCollectionId,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      lastAccessedAt: job.lastAccessedAt,
      retentionMetadataVersion: job.retentionMetadataVersion,
      updatedAt: job.updatedAt,
      ownershipToken: job.ownershipToken,
      restoreMetadata: true,
      transient: job.transient,
    };
    jobs.delete(job.id);
    try {
      const resumed = await seedLocalFile(metadata);
      persistJobs();
      await jobStore.flush();
      return resumed;
    } catch (error) {
      jobs.set(job.id, job);
      job.paused = true;
      job.status = "paused";
      throw error;
    }
  }
  if (job.kind === "magnet") {
    if (job.managed) {
      const claim = await claimManagedDirectory(job.id, {
        ownershipToken: job.ownershipToken,
        restoreMetadata: !job.ownershipToken,
      });
      job.ownershipToken = claim.ownershipToken;
    }
    startTorrent(job, { restoreMetadata: true });
  } else {
    void runDirect(job);
  }
  persistJobs();
  await jobStore.flush();
  return job;
}

async function retryJob(id) {
  const job = jobs.get(validJobId(id));
  if (!job) throw new Error("Download not found.");
  if (job.seed) throw new Error("A local seed does not need to be retried.");
  const source = { id: job.id, kind: job.kind, value: job.value, label: job.label };
  const ownershipToken = job.ownershipToken;
  await stopJob(id);
  return addDownload(source, { ownershipToken });
}

async function restoreJobs() {
  const records = await jobStore.load([]);
  if (!Array.isArray(records)) return;
  restoringJobs = true;
  failedRestoreRecords = [];
  try {
    for (const record of records) {
      try {
        if (record.transient || (record.managed === false && record.kind === "direct")) {
          continue;
        }
        if (record.paused) {
          const pausedInfo = record.file?.path ? await stat(record.file.path) : null;
          if (pausedInfo && !pausedInfo.isFile()) {
            throw new Error("Paused download payload is not a file.");
          }
          const claim = record.managed
            ? await claimManagedDirectory(record.id, {
                ownershipToken: record.ownershipToken,
                restoreMetadata: true,
              })
            : null;
          const job = createJob({
            ...record,
            paused: true,
            ownershipToken: claim?.ownershipToken || null,
            legacyUnowned: Boolean(claim?.legacyUnowned),
            restoredFromManifest: true,
            retentionMetadataVersion: Number(record.retentionMetadataVersion) || 0,
          });
          job.seed = Boolean(record.seed);
          job.seedPath = record.seedPath || null;
          if (record.file?.path) {
            job.file = { ...record.file, size: Number(record.file.size) || pausedInfo.size };
            job.downloaded = Math.min(pausedInfo.size, Math.max(0, Number(record.downloaded) || pausedInfo.size));
            job.selectedIndex = Number.isInteger(record.selectedIndex) ? record.selectedIndex : 0;
          }
          job.status = "paused";
          job.paused = true;
        } else if (record.seed && record.seedPath) {
          await seedLocalFile({
            id: record.id,
            filePath: record.seedPath,
            label: record.label,
            managed: Boolean(record.managed),
            pinned: Boolean(record.pinned),
            libraryCollectionId: record.libraryCollectionId,
            createdAt: record.createdAt,
            completedAt: record.completedAt,
            lastAccessedAt: record.lastAccessedAt,
            retentionMetadataVersion: RETENTION_METADATA_VERSION,
            updatedAt: record.updatedAt,
            ownershipToken: record.ownershipToken,
            restoreMetadata: true,
          });
        } else if (record.kind === "magnet") {
          await addDownload(record, { restoreMetadata: true });
        } else if (record.file?.path) {
          const info = await stat(record.file.path);
          const claim = record.managed
            ? await claimManagedDirectory(record.id, {
                ownershipToken: record.ownershipToken,
                restoreMetadata: true,
              })
            : null;
          const job = createJob({
            ...record,
            ownershipToken: claim?.ownershipToken || null,
            legacyUnowned: Boolean(claim?.legacyUnowned),
            restoredFromManifest: true,
            retentionMetadataVersion: RETENTION_METADATA_VERSION,
          });
          job.file = { ...record.file, size: info.size };
          job.downloaded = info.size;
          job.selectedIndex = 0;
          const asset = mediaAsset(job, 0);
          asset.status = "ready";
          await identifySelectedFile(job, 0);
          syncSelectedAsset(job);
          job.status = "ready";
          markJobCompleted(job);
          queueMediaPreparation(job, 0);
        } else {
          await addDownload(record, { restoreMetadata: true });
        }
      } catch (error) {
        failedRestoreRecords.push(record);
        console.warn(`Could not restore companion job ${record?.id || "unknown"}: ${error.message}`);
      }
    }
  } finally {
    restoringJobs = false;
  }
  persistJobs();
  await jobStore.flush();
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
  const asset = mediaAsset(job, fileIndex);
  const schedulerJobId = `content-${await identifySelectedFile(job, fileIndex)}-${media.size}`;
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
  const copyVideo = canCopyH264Video(asset);
  const runWithEncoder = async (selectedEncoder, hardwareDecode = Boolean(selectedEncoder.hardware)) => {
    const pipeline = copyVideo ? null : videoPipeline(selectedEncoder, { hardwareDecode });
    return runScheduledFfmpeg({
      jobId: schedulerJobId,
      taskId: `audio-file:${fileIndex}:${track.id}`,
      stage: "alternate-audio-file",
      trackId: track.id,
      encoder: copyVideo ? "Direct stream copy" : selectedEncoder.label,
      decoder: pipeline?.decode.name || "stream copy",
      hardware: Boolean(selectedEncoder.hardware),
      inputPath: media.path,
      priority: 40,
      argumentsForProfile: (profile) => [
        "-hide_banner", "-loglevel", "error", "-y",
        ...(pipeline?.arguments.decode || []),
        ...renderInputArguments(profile),
        "-i", media.path,
        "-map", "0:v:0", "-map", "0:" + track.streamIndex,
        "-sn", "-dn",
        ...(copyVideo ? ["-c:v", "copy"] : []),
        ...(pipeline ? [...pipeline.arguments.filter, ...pipeline.arguments.upload] : []),
        ...(!copyVideo ? selectedEncoder.arguments : []),
        ...(!copyVideo ? renderEncoderArguments(selectedEncoder, profile) : []),
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", partial,
      ],
    });
  };

  try {
    const initialEncoder = copyVideo
      ? { id: "copy", label: "Direct stream copy", hardware: false, arguments: [] }
      : TRANSCODE_RUNTIME.encoder;
    await runWithEncoder(initialEncoder);
    await rename(partial, output);
    return output;
  } catch (error) {
    if (!copyVideo && TRANSCODE_RUNTIME.encoder.hardware) {
      await rm(partial, { force: true });
      try {
        await runWithEncoder(TRANSCODE_RUNTIME.encoder, false);
        await rename(partial, output);
        return output;
      } catch {
        await rm(partial, { force: true });
      }
      try {
        await runWithEncoder(CPU_ENCODER);
        await rename(partial, output);
        return output;
      } catch (fallbackError) {
        await rm(partial, { force: true });
        throw fallbackError;
      }
    }
    await rm(partial, { force: true });
    throw error;
  }
}

function torrentFileIsFullyVerified(job, fileIndex) {
  const asset = mediaAsset(job, fileIndex);
  if (job.kind !== "magnet") return asset.status === "ready";
  if (job.seed) return fileIndex === 0 && Boolean(job.file) && asset.status === "ready";
  if (!job.torrent?.files[fileIndex]?.done) return false;
  return asset.torrentVerifiedKey === fileIdentityKey(fileIndex, jobFile(job, fileIndex));
}

async function preparedAudioFile(job, fileIndex, trackId) {
  if (!torrentFileIsFullyVerified(job, fileIndex)) {
    throw new Error("The media file has not passed full verification.");
  }
  const asset = mediaAsset(job, fileIndex);
  await queueSubtitleProbe(job, fileIndex);

  const track = asset.audioTracks.find((item) => item.id === trackId);
  if (!track) throw new Error("Embedded audio track not found.");
  const key = String(track.id);
  let promise = asset.audioRenderPromises.get(key);
  if (!promise) {
    promise = renderAudioPlayback(job, fileIndex, track);
    asset.audioRenderPromises.set(key, promise);
  }
  try {
    return await promise;
  } finally {
    if (asset.audioRenderPromises.get(key) === promise) asset.audioRenderPromises.delete(key);
  }
}

async function hlsDescriptor(job, fileIndex, rendition = "h264", audioMode = "surround") {
  if (!["h264", "vp9"].includes(rendition)) throw new Error("Unsupported video rendition.");
  if (!torrentFileIsFullyVerified(job, fileIndex)) {
    throw new Error("The media file has not passed full verification.");
  }
  const asset = mediaAsset(job, fileIndex);
  await queueSubtitleProbe(job, fileIndex);
  const media = jobFile(job, fileIndex);
  const contentFingerprint = await identifySelectedFile(job, fileIndex);
  return {
    jobId: job.id,
    fileIndex,
    fileSize: media.size,
    contentFingerprint,
    inputPath: media.path,
    videoCodec: asset.videoCodec,
    videoPixelFormat: asset.videoPixelFormat,
    videoProfile: asset.videoProfile,
    rendition,
    audioMode: audioMode === "stereo" ? "stereo" : "surround",
    audioTracks: asset.audioTracks,
    videoStartTime: asset.videoStartTime,
    sourceDuration: asset.duration,
  };
}

async function prepareQueuedTarget(target) {
  const { job, index } = target;
  const asset = mediaAsset(job, index);
  let selectionKey = null;
  const isStillCurrent = () => {
    if (selectionKey === null) return jobs.get(job.id) === job;
    try {
      return fileIdentityKey(index, jobFile(job, index)) === selectionKey;
    } catch {
      return false;
    }
  };

  try {
    selectionKey = fileIdentityKey(index, jobFile(job, index));
    await queueSubtitleProbe(job, index);
    if (!isStillCurrent()) return;
    const media = jobFile(job, index);
    if (!needsHlsPlayback(asset, media.name)) {
      asset.preparation = {
        status: "direct",
        error: null,
        encoder: { id: "copy", label: "Direct browser playback", hardware: false },
        fallback: false,
      };
      if (job.selectedIndex === index) syncSelectedAsset(job);
      return;
    }

    const descriptor = await hlsDescriptor(job, index);
    descriptor.onState = (state, transition) => {
      if (!isStillCurrent()) return;
      const diagnostic = state.diagnostics?.at(-1);
      asset.preparation = {
        ...state,
        error: state.error ||
          (state.status === "error" ? diagnostic?.message || "Browser preparation failed." : null),
      };
      asset.updatedAt = Date.now();
      if (job.selectedIndex === index) syncSelectedAsset(job);
      job.updatedAt = Date.now();
      agentLogger.info("media_preparation_state", {
        jobId: job.id,
        fileIndex: index,
        status: state.status,
        transition,
      });
    };
    const result = await hlsPlayback.prepare(descriptor);
    if (isStillCurrent()) asset.preparation = { ...result, error: null };
  } catch (error) {
    if (!isStillCurrent()) return;
    asset.preparation = {
      status: "error",
      error: error instanceof Error ? error.message : "Browser preparation failed.",
      encoder: null,
      fallback: false,
    };
  } finally {
    asset.updatedAt = Date.now();
    if (job.selectedIndex === index) syncSelectedAsset(job);
    job.updatedAt = Date.now();
  }
}

function prioritizePreparationQueue() {
  const order = new Map(preparationOrderTargetKeys.map((key, index) => [key, index]));
  preparationQueue.sort((left, right) =>
    Number(right.key === activePreparationTargetKey) -
      Number(left.key === activePreparationTargetKey) ||
    (order.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.key) ?? Number.MAX_SAFE_INTEGER) ||
    left.createdAt - right.createdAt
  );
}

function contentSchedulerIdForTarget(target) {
  const job = jobs.get(target?.jobId);
  if (!job || !Number.isInteger(target?.fileIndex)) return null;
  try {
    const media = jobFile(job, target.fileIndex);
    const asset = mediaAsset(job, target.fileIndex);
    if (asset.identityFingerprintKey !== fileIdentityKey(target.fileIndex, media)) return null;
    return asset.identityFingerprint
      ? `content-${asset.identityFingerprint}-${media.size}`
      : null;
  } catch {
    return null;
  }
}

function refreshPreparationScheduling() {
  prioritizePreparationQueue();
  const schedulerOrder = mediaPriorityTargets.map((target) =>
    contentSchedulerIdForTarget(target) || mediaTargetKey(target.jobId, target.fileIndex)
  );
  mediaScheduler.setJobOrder(schedulerOrder);
  subtitleScheduler.setJobOrder(schedulerOrder);
  const activeTarget = mediaPriorityTargets.find(
    (target) => mediaTargetKey(target.jobId, target.fileIndex) === activePreparationTargetKey
  ) || null;
  const activeSchedulerId = contentSchedulerIdForTarget(activeTarget);
  hlsPlayback.setPriorityTarget(
    activeTarget?.jobId || null,
    activeTarget?.fileIndex ?? null,
    activeSchedulerId
  );
  subtitleScheduler.prioritize(activeSchedulerId);
}

function setMediaPriority(selected, targets) {
  mediaPriorityTargets = normalizeMediaTargets(targets || []);
  for (const target of mediaPriorityTargets) {
    const job = jobs.get(target.jobId);
    if (!job) continue;
    if (
      (job.kind === "magnet" && job.torrent?.files?.length && !job.torrent.files[target.fileIndex]) ||
      (job.kind !== "magnet" && target.fileIndex !== 0)
    ) {
      continue;
    }
    const asset = mediaAsset(job, target.fileIndex);
    if (asset.status !== "ready") job.completedAt = null;
  }
  preparationOrderTargetKeys = mediaPriorityTargets.map((target) =>
    mediaTargetKey(target.jobId, target.fileIndex)
  );
  activePreparationTargetKey = selected
    ? mediaTargetKey(selected.jobId, selected.fileIndex)
    : null;

  if (selected) {
    const job = jobs.get(selected.jobId);
    if (job?.torrent?.files[selected.fileIndex] || (job?.file && selected.fileIndex === 0)) {
      selectTorrentFile(job, selected.fileIndex);
      const asset = mediaAsset(job, selected.fileIndex);
      if (asset.status === "ready") queueMediaPreparation(job, selected.fileIndex);
    }
  }
  refreshTorrentSelections("media-priority");
  refreshPreparationScheduling();
}

function setPreparationPriority(jobId, orderedJobIds) {
  const targets = (orderedJobIds || []).flatMap((id) => {
    const job = jobs.get(id);
    const fileIndex = job?.selectedIndex ?? orderedTorrentVideoIndexes(job?.torrent || { files: [] })[0];
    return Number.isInteger(fileIndex) ? [{ jobId: id, fileIndex }] : [];
  });
  const selected = targets.find((target) => target.jobId === jobId) || null;
  setMediaPriority(selected, targets);
}

function preparationBlockedByWatchOrder(target) {
  if (target.key === activePreparationTargetKey) return false;
  const rank = preparationOrderTargetKeys.indexOf(target.key);
  if (rank <= 0) return false;
  return mediaPriorityTargets.slice(0, rank).some((earlierTarget) => {
    const earlierJob = jobs.get(earlierTarget.jobId);
    if (!earlierJob) return true;
    try {
      if (
        (earlierJob.kind === "magnet" &&
          earlierJob.torrent?.files?.length &&
          !earlierJob.torrent.files[earlierTarget.fileIndex]) ||
        (earlierJob.kind !== "magnet" && earlierTarget.fileIndex !== 0)
      ) return false;
      const earlierAsset = mediaAsset(earlierJob, earlierTarget.fileIndex);
      if (earlierAsset.status === "error" || earlierAsset.preparation.status === "error") {
        return false;
      }
      if (earlierAsset.status !== "ready") return true;
      return !["ready", "direct"].includes(earlierAsset.preparation.status);
    } catch {
      return true;
    }
  });
}

async function drainPreparationQueue() {
  while (preparationQueue.length) {
    prioritizePreparationQueue();
    const target = preparationQueue[0];
    if (!target) break;
    if (jobs.get(target.job.id) !== target.job) {
      preparationQueue.shift();
      continue;
    }
    const asset = mediaAsset(target.job, target.index);
    if (asset.preparation.status !== "queued") {
      preparationQueue.shift();
      continue;
    }
    if (preparationBlockedByWatchOrder(target)) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    preparationQueue.shift();
    try {
      await prepareQueuedTarget(target);
    } catch (error) {
      agentLogger.error("media_preparation_unhandled", {
        jobId: target.job.id,
        fileIndex: target.index,
        error,
      });
      asset.preparation = {
        status: "error",
        error: error instanceof Error ? error.message : "Browser preparation failed.",
        encoder: null,
        fallback: false,
      };
      if (target.job.selectedIndex === target.index) syncSelectedAsset(target.job);
      target.job.updatedAt = Date.now();
    }
  }
}

function startPreparationWorker() {
  if (preparationWorker) return;
  preparationWorker = drainPreparationQueue().finally(() => {
    preparationWorker = null;
    if (preparationQueue.length) startPreparationWorker();
  });
}

function queueSelectedPreparation(job, index = job.selectedIndex) {
  if (!Number.isInteger(index)) return;
  const key = mediaTargetKey(job.id, index);
  const asset = mediaAsset(job, index);
  if (["ready", "direct", "preparing"].includes(asset.preparation.status)) return;
  if (selectedPreparationKeys.has(key)) return;
  if (key !== activePreparationTargetKey) {
    queueBackgroundPreparation(job, index);
    return;
  }

  for (let queueIndex = preparationQueue.length - 1; queueIndex >= 0; queueIndex -= 1) {
    if (preparationQueue[queueIndex].key === key) preparationQueue.splice(queueIndex, 1);
  }
  asset.preparation = { status: "queued", error: null, encoder: null, fallback: false };
  asset.updatedAt = Date.now();
  if (job.selectedIndex === index) syncSelectedAsset(job);
  job.updatedAt = Date.now();
  selectedPreparationKeys.add(key);
  void prepareQueuedTarget({ job, index, key, createdAt: Date.now() })
    .catch((error) => {
      agentLogger.error("selected_media_preparation_unhandled", {
        jobId: job.id,
        fileIndex: index,
        error,
      });
      asset.preparation = {
        status: "error",
        error: error instanceof Error ? error.message : "Browser preparation failed.",
        encoder: null,
        fallback: false,
      };
    })
    .finally(() => {
      selectedPreparationKeys.delete(key);
      if (job.selectedIndex === index) syncSelectedAsset(job);
      job.updatedAt = Date.now();
    });
}

function queueBackgroundPreparation(job, index = job.selectedIndex) {
  if (!Number.isInteger(index)) return;
  const asset = mediaAsset(job, index);
  if (!["waiting", "error"].includes(asset.preparation.status)) return;
  asset.preparation = { status: "queued", error: null, encoder: null, fallback: false };
  asset.updatedAt = Date.now();
  if (job.selectedIndex === index) syncSelectedAsset(job);
  job.updatedAt = Date.now();
  const key = mediaTargetKey(job.id, index);
  if (!preparationQueue.some((target) => target.key === key)) {
    preparationQueue.push({ job, index, key, createdAt: Date.now() });
  }
  prioritizePreparationQueue();
  refreshPreparationScheduling();
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
  touchJob(job);
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
  } else if (job.seed && job.file && fileIndex === 0) {
    fileName = job.file.name;
    size = job.file.size;
    fallbackType = job.file.type;
    createStream = (options) => createReadStream(job.file.path, options);
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

async function streamLibraryPreview(request, response, entry, headers) {
  const info = await stat(entry.path);
  if (!info.isFile()) throw new Error("Library file is no longer available.");
  const size = info.size;
  const baseHeaders = {
    ...headers,
    "accept-ranges": "bytes",
    "content-type": contentType(entry.name),
    "content-disposition": `inline; filename="${safeName(entry.name)}"`,
  };
  const range = parseByteRange(request.headers.range, size);
  if (range === false) {
    response.writeHead(416, { ...baseHeaders, "content-range": `bytes */${size}` });
    response.end();
    return;
  }
  if (range === null) {
    response.writeHead(200, { ...baseHeaders, "content-length": size });
    if (size > 0) {
      if (request.method !== "HEAD") {
        pipeResponseStream(createReadStream(entry.path, { start: 0, end: size - 1 }), response);
        return;
      }
    }
    response.end();
    return;
  }
  response.writeHead(206, {
    ...baseHeaders,
    "content-length": range.end - range.start + 1,
    "content-range": `bytes ${range.start}-${range.end}/${size}`,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  pipeResponseStream(createReadStream(entry.path, { start: range.start, end: range.end }), response);
}


const CACHE_DIRECTORY_BASENAMES = new Set([
  path.basename(IMPORT_DIR),
  path.basename(HLS_DIR),
  path.basename(SUBTITLE_DIR),
  path.basename(MEDIA_DIR),
]);

// The regenerable cache directories (HLS segments, subtitles, media, partial
// imports) contain many small files, so walking them dominates the storage
// scan. Measure them on a longer cadence and skip them from the per-minute
// walk so the /storage endpoint stays fast even on a large library.
const storageCacheDiskUsage = createSingleFlightCache({
  ttlMs: 5 * 60_000,
  retryDelayMs: 60_000,
  async load() {
    const targets = [IMPORT_DIR, HLS_DIR, SUBTITLE_DIR, MEDIA_DIR];
    const sizes = await Promise.all(targets.map((target) =>
      pathSize(target, { concurrency: 8 })
    ));
    return sizes.reduce((total, size) => total + size, 0);
  },
});

const storageDiskUsage = createSingleFlightCache({
  ttlMs: 60_000,
  retryDelayMs: 60_000,
  async load() {
    const startedAt = Date.now();
    agentLogger.info("storage_scan_started", { concurrency: 8 });
    const filesystem = await statfs(DOWNLOAD_DIR).catch(() => null);
    const [downloadBytes, cacheBytes] = await Promise.all([
      pathSize(DOWNLOAD_DIR, {
        concurrency: 8,
        exclude: (candidate) => CACHE_DIRECTORY_BASENAMES.has(path.basename(candidate)),
      }),
      storageCacheDiskUsage.get(),
    ]);
    const usage = {
      bytes: downloadBytes + cacheBytes,
      availableBytes: filesystem ? filesystem.bavail * filesystem.bsize : null,
      totalBytes: filesystem ? filesystem.blocks * filesystem.bsize : null,
    };
    agentLogger.info("storage_scan_finished", {
      durationMs: Date.now() - startedAt,
      bytes: usage.bytes,
    });
    return usage;
  },
});

async function storageUsage({ fresh = false } = {}) {
  const disk = await storageDiskUsage.get({ fresh });
  return {
    ...disk,
    managedJobs: Array.from(jobs.values()).filter((job) => job.managed).length,
    pinnedJobs: Array.from(jobs.values()).filter((job) => job.pinned).length,
  };
}

let cleanupPromise = null;
function jobCanBeRemovedForStoragePressure(job, settings, now = Date.now()) {
  return jobCanBeCleaned(job, settings, {
    now,
    recentAccessMs: RECENT_PLAYBACK_PROTECTION_MS,
    active: mediaPriorityTargets.some((target) => target.jobId === job?.id),
  });
}

async function runStorageCleanup({
  force = false,
  includeLegacy = false,
  confirmedLegacyJobs = [],
} = {}) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const settings = force ? { ...CLEANUP_SETTINGS, enabled: true } : CLEANUP_SETTINGS;
    if (!settings.enabled) {
      return {
        removedJobs: [], removedEntries: [], legacyJobs: [], legacyDownloads: [], bytes: 0,
      };
    }

    const now = Date.now();
    const confirmedLegacyJobSet = new Set(confirmedLegacyJobs);
    const result = {
      removedJobs: [], removedEntries: [], legacyJobs: [], legacyDownloads: [], bytes: 0,
    };
    if (!libraryCatalog.readyForCleanup()) {
      await libraryCatalog.startScan().completion;
      if (!libraryCatalog.readyForCleanup()) {
        return { ...result, deferred: "library-scan" };
      }
    }
    for (const job of Array.from(jobs.values())) {
      if (!retentionMetadataReliable(job)) {
        if (!(await legacyJobFilesystemExpired(job, settings, now))) continue;
        if (!includeLegacy || !confirmedLegacyJobSet.has(job.id)) {
          result.legacyJobs.push(job.id);
          result.legacyDownloads.push(legacyDownloadSummary(job));
          continue;
        }
        const removedBytes = await jobRemovalBytes(job);
        if (!(await legacyJobFilesystemExpired(job, settings, now))) continue;
        if (!(await managedDirectoryIsOwned(job)) && !(await claimConfirmedLegacyDirectory(job))) {
          result.legacyJobs.push(job.id);
          result.legacyDownloads.push(legacyDownloadSummary(job));
          continue;
        }
        if (!(await stopJob(job.id, {
          deleteFiles: true,
          automatic: true,
          expectedJob: job,
        }))) {
          result.legacyJobs.push(job.id);
          result.legacyDownloads.push(legacyDownloadSummary(job));
          continue;
        }
        result.bytes += removedBytes;
        result.removedJobs.push(job.id);
        continue;
      }
      if (!jobCleanupReason(job, settings, now)) continue;
      // Managed downloads restored before the ownership-marker feature carry no
      // ownership token. They already passed the retention gate, so claim their
      // directory (a real, contained path with no existing marker) before
      // deleting — otherwise stopJob silently bails on the ownership check and
      // these jobs survive cleanup forever.
      if (!(await managedDirectoryIsOwned(job)) && !(await claimConfirmedLegacyDirectory(job))) {
        continue;
      }
      const removedBytes = await jobRemovalBytes(job);
      if (jobs.get(job.id) !== job || !jobCleanupReason(job, settings, Date.now())) continue;
      if (!(await stopJob(job.id, {
        deleteFiles: true,
        automatic: true,
        expectedJob: job,
      }))) continue;
      result.bytes += removedBytes;
      result.removedJobs.push(job.id);
    }

    for (const job of jobs.values()) {
      const assets = Array.from(job.assets?.values?.() || []);
      if (
        !retentionMetadataReliable(job) ||
        job.pinned ||
        !cacheExpired(job.lastAccessedAt, settings, now) ||
        assets.some((asset) => ["queued", "preparing"].includes(asset.preparation.status))
      ) continue;
      const removedBytes = await generatedArtifactBytes(job.id);
      const currentAssets = Array.from(job.assets?.values?.() || []);
      if (
        jobs.get(job.id) !== job ||
        !retentionMetadataReliable(job) ||
        job.pinned ||
        !cacheExpired(job.lastAccessedAt, settings, Date.now()) ||
        currentAssets.some((asset) => ["queued", "preparing"].includes(asset.preparation.status))
      ) continue;
      job.cleanupCommit = true;
      try {
        await removeGeneratedArtifacts(job.id);
      } finally {
        job.cleanupCommit = false;
      }
      result.bytes += removedBytes;
      for (const asset of currentAssets) asset.preparation = defaultPreparation();
      syncSelectedAsset(job);
      result.removedEntries.push(`cache:${job.id}`);
    }

    const gibibyte = 1024 ** 3;
    const hasStorageLimit = settings.maxStorageGb > 0 || settings.minFreeSpaceGb > 0;
    let usage = hasStorageLimit ? await storageUsage({ fresh: true }) : null;
    const overLimit = () => {
      if (!usage) return false;
      return (settings.maxStorageGb > 0 && usage.bytes > settings.maxStorageGb * gibibyte) ||
        (settings.minFreeSpaceGb > 0 && usage.availableBytes !== null &&
          usage.availableBytes < settings.minFreeSpaceGb * gibibyte);
    };
    const accountForRemoval = (bytes) => {
      if (!usage) return;
      usage = {
        ...usage,
        bytes: Math.max(0, usage.bytes - bytes),
        availableBytes: usage.availableBytes === null ? null : usage.availableBytes + bytes,
      };
    };
    const cleanupCandidates = Array.from(jobs.values())
      .filter((job) => jobCanBeRemovedForStoragePressure(job, settings, now))
      .sort((left, right) =>
        Number(left.lastAccessedAt || left.completedAt || left.updatedAt || 0) -
        Number(right.lastAccessedAt || right.completedAt || right.updatedAt || 0)
      );
    for (const job of cleanupCandidates) {
      if (!overLimit()) break;
      const removedBytes = await jobRemovalBytes(job);
      if (jobs.get(job.id) !== job ||
        !jobCanBeRemovedForStoragePressure(job, settings) || !overLimit()) continue;
      if (!(await stopJob(job.id, {
        deleteFiles: true,
        automatic: true,
        expectedJob: job,
      }))) continue;
      result.bytes += removedBytes;
      result.removedJobs.push(job.id);
      accountForRemoval(removedBytes);
    }

    // Directory names are user-controlled and are not proof of WatchPair ownership.
    // Live/manifest jobs are removed through stopJob above; unknown top-level folders
    // are deliberately left alone rather than risking an external library payload.
    const expiredOwned = [];
    const failedRestoreIds = failedRestoreRecords
      .map((record) => String(record?.id || ""))
      .filter((id) => /^[a-zA-Z0-9-]{8,80}$/.test(id));
    const expiredPartials = await pruneExpiredChildren(IMPORT_DIR, {
      now,
      maxAgeMs: settings.partialRetentionHours * 60 * 60 * 1000,
      include: (entry) => entry.isFile() && /^[a-zA-Z0-9-]{8,80}\.part$/.test(entry.name),
      protectedNames: new Set(Array.from(jobs.values())
        .filter((job) => job.pinned)
        .map((job) => `${job.id}.part`)
        .concat(failedRestoreIds.map((id) => `${id}.part`))),
      isProtected: (entry) => Boolean(jobs.get(entry.name.slice(0, -5))?.pinned) ||
        failedRestoreIds.includes(entry.name.slice(0, -5)),
    });
    const mediaWork = [
      mediaScheduler.snapshot(),
      subtitleScheduler.snapshot(),
    ];
    const protectedContentNames = new Set([
      ...libraryCatalog.pinnedContentKeys(),
      ...mediaWork
        .flatMap((work) => [work.active, ...work.queued])
        .map((task) => task?.jobId)
        .filter((jobId) => String(jobId || "").startsWith("content-"))
        .map((jobId) => jobId.slice("content-".length)),
    ]);
    for (const record of failedRestoreRecords) {
      if (!/^[a-f0-9]{16,128}$/.test(String(record?.identityFingerprint || ""))) continue;
      const size = Number(record?.file?.size);
      if (Number.isSafeInteger(size) && size >= 0) {
        protectedContentNames.add(`${record.identityFingerprint}-${size}`);
      }
    }
    for (const job of jobs.values()) {
      if (!job.pinned && retentionMetadataReliable(job) &&
        cacheExpired(job.lastAccessedAt, settings, now)) continue;
      for (const [index, asset] of job.assets?.entries?.() || []) {
        if (!asset.identityFingerprint) continue;
        try {
          const media = jobFile(job, index);
          if (asset.identityFingerprintKey !== fileIdentityKey(index, media)) continue;
          protectedContentNames.add(`${asset.identityFingerprint}-${media.size}`);
        } catch {
          // A stale file asset no longer protects generated content.
        }
      }
    }
    const newlyPinnedContentIsProtected = (entry) => {
      if (libraryCatalog.isContentKeyPinned(entry.name)) return true;
      for (const job of jobs.values()) {
        if (!job.pinned) continue;
        for (const [index, asset] of job.assets?.entries?.() || []) {
          if (!asset.identityFingerprint) continue;
          try {
            const media = jobFile(job, index);
            if (
              asset.identityFingerprintKey === fileIdentityKey(index, media) &&
              `${asset.identityFingerprint}-${media.size}` === entry.name
            ) return true;
          } catch {
            // A stale file asset cannot protect content.
          }
        }
      }
      return false;
    };
    const expiredHlsContent = await pruneExpiredChildren(path.join(HLS_DIR, "content"), {
      now,
      maxAgeMs: settings.cacheRetentionDays * 24 * 60 * 60 * 1000,
      include: (entry) => entry.isDirectory() && /^[a-f0-9]{16,128}-\d+$/.test(entry.name),
      protectedNames: protectedContentNames,
      isProtected: newlyPinnedContentIsProtected,
    });
    const expiredSubtitleContent = await pruneExpiredChildren(path.join(SUBTITLE_DIR, "content"), {
      now,
      maxAgeMs: settings.cacheRetentionDays * 24 * 60 * 60 * 1000,
      include: (entry) => entry.isDirectory() && /^[a-f0-9]{16,128}-\d+$/.test(entry.name),
      protectedNames: protectedContentNames,
      isProtected: newlyPinnedContentIsProtected,
    });
    for (const entry of [...expiredOwned, ...expiredPartials, ...expiredHlsContent, ...expiredSubtitleContent]) {
      result.removedEntries.push(entry.name);
      result.bytes += entry.bytes;
      accountForRemoval(entry.bytes);
    }
    if (usage) storageDiskUsage.set({
      bytes: usage.bytes, availableBytes: usage.availableBytes, totalBytes: usage.totalBytes,
    });
    else storageDiskUsage.invalidate();
    persistJobs();
    return result;
  })()
    .catch((error) => {
      agentLogger.error("storage_cleanup_failed", { error });
      return {
        removedJobs: [], removedEntries: [], legacyJobs: [], legacyDownloads: [], bytes: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    })
    .finally(() => {
      cleanupPromise = null;
    });
  return cleanupPromise;
}

const storageCleanupOperation = createSingleFlightOperation({
  createId: randomUUID,
  run: ({ force, includeLegacy, confirmedLegacyJobs }) =>
    runStorageCleanup({ force, includeLegacy, confirmedLegacyJobs }),
});

function startStorageCleanup({
  force = false,
  includeLegacy = false,
  confirmedLegacyJobs = [],
  source = "automatic",
} = {}) {
  const started = storageCleanupOperation.start({ force, includeLegacy, confirmedLegacyJobs });
  if (started.started) {
    agentLogger.info("storage_cleanup_started", {
      operationId: started.operation.id,
      force,
      includeLegacy,
      source,
    });
    void started.completion.then((operation) => {
      if (operation.status === "complete") {
        agentLogger.info("storage_cleanup_finished", {
          operationId: operation.id,
          durationMs: operation.finishedAt - operation.startedAt,
          removedJobs: operation.result?.removedJobs?.length || 0,
          removedEntries: operation.result?.removedEntries?.length || 0,
          legacyJobs: operation.result?.legacyJobs?.length || 0,
          bytes: operation.result?.bytes || 0,
        });
      } else {
        agentLogger.error("storage_cleanup_failed", {
          operationId: operation.id,
          durationMs: operation.finishedAt - operation.startedAt,
          error: operation.error,
        });
      }
    });
  }
  return started.operation;
}

let previousProcessCpu = process.cpuUsage();
let previousProcessCpuAt = process.hrtime.bigint();
let idleDiagnosticTicks = 0;

function sampleProcessCpu() {
  const now = process.hrtime.bigint();
  const current = process.cpuUsage();
  const elapsedMicros = Math.max(1, Number(now - previousProcessCpuAt) / 1_000);
  const usedMicros = Math.max(
    0,
    current.user - previousProcessCpu.user + current.system - previousProcessCpu.system
  );
  const oneCorePercent = (usedMicros / elapsedMicros) * 100;
  previousProcessCpu = current;
  previousProcessCpuAt = now;
  return {
    oneCorePercent: Math.round(oneCorePercent * 10) / 10,
    machinePercent: Math.round((oneCorePercent / availableParallelism()) * 10) / 10,
    userMs: Math.round(current.user / 1_000),
    systemMs: Math.round(current.system / 1_000),
  };
}

function agentResourceSnapshot() {
  const scheduler = mediaScheduler.snapshot();
  const subtitleWork = subtitleScheduler.snapshot();
  const processes = mediaProcessRegistry.snapshot();
  const memory = process.memoryUsage();
  const jobStatuses = {};
  for (const job of jobs.values()) {
    jobStatuses[job.status] = (jobStatuses[job.status] || 0) + 1;
  }
  const activeResources = {};
  for (const resource of process.getActiveResourcesInfo?.() || []) {
    activeResources[resource] = (activeResources[resource] || 0) + 1;
  }
  return {
    uptimeSeconds: Math.round(process.uptime()),
    cpu: sampleProcessCpu(),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    responsiveness: scheduler.responsiveness,
    scheduler: {
      foregroundJobId: scheduler.foregroundJobId,
      active: scheduler.active,
      queuedTasks: scheduler.queued.length,
      subtitles: {
        active: subtitleWork.active,
        queuedTasks: subtitleWork.queued.length,
      },
    },
    processes: processes.active.map((entry) => ({
      pid: entry.pid,
      jobId: entry.jobId,
      taskId: entry.taskId,
      stage: entry.stage,
      encoder: entry.encoder,
      decoder: entry.decoder,
      hardware: entry.hardware,
      profile: entry.profile,
      runningMs: Date.now() - entry.startedAt,
      progress: entry.progress,
    })),
    torrents: {
      count: client.torrents.length,
      peers: client.torrents.reduce((total, torrent) => total + torrent.numPeers, 0),
      downloadSpeed: client.downloadSpeed,
      uploadSpeed: client.uploadSpeed,
      pendingVerifications: Array.from(jobs.values()).reduce(
        (total, job) => total + Array.from(job.assets?.values?.() || [])
          .filter((asset) => Boolean(asset.torrentVerificationPromise)).length,
        0
      ),
      connectionBudget: torrentPressure.totalBudget,
      perTorrentLimit: torrentPressure.perTorrentLimit,
      maxPerTorrentLimit: torrentPressure.maxPerTorrentLimit,
      trimmedPeers: torrentPressure.trimmedPeers,
      pausedTorrents: torrentPressure.pausedTorrents,
      bandwidth: torrentBandwidth,
    },
    jobs: jobStatuses,
    activeResources,
  };
}

function writeResourceSnapshot() {
  const snapshot = agentResourceSnapshot();
  const busy = Boolean(snapshot.scheduler.active) || snapshot.scheduler.queuedTasks > 0 ||
    snapshot.processes.length > 0 || Object.entries(snapshot.jobs)
      .some(([status, count]) => count > 0 && ["metadata", "downloading", "probing", "preparing"].includes(status));
  const pressure = snapshot.responsiveness.systemCpuPercent > 85 ||
    snapshot.responsiveness.eventLoopDelayMaxMs > 250;
  idleDiagnosticTicks += 1;
  if (!busy && !pressure && idleDiagnosticTicks < 12) return;
  idleDiagnosticTicks = 0;
  agentLogger.info("resource_snapshot", snapshot);
}

await libraryCatalog.load().catch((error) => {
  agentLogger.warn("library_catalog_load_failed", { error });
});
await restoreJobs();
applyNetworkPolicy("startup");
for (const job of jobs.values()) {
  if (job.seed && !job.paused && job.status === "ready" && activeSeedLeaseCount(job) === 0) {
    job.seedLeaseGraceUntil = Date.now() + SEED_LEASE_GRACE_MS;
  }
}
const startupLibraryScan = libraryCatalog.startScan();
void startupLibraryScan.completion.then((scan) => {
  const level = scan.status === "complete" ? "info" : "warn";
  agentLogger[level]("library_scan_finished", scan);
});
const torrentBandwidthTimer = setInterval(() => {
  try {
    refreshTorrentSelections("bandwidth-sample");
    enforceNetworkPolicy();
  } catch (error) {
    agentLogger.warn("torrent_bandwidth_sample_failed", { error });
  }
}, 1_000);
torrentBandwidthTimer.unref?.();
refreshTorrentSelections("startup");
const persistenceTimer = setInterval(persistJobs, 2_000);
persistenceTimer.unref?.();
const resourceDiagnosticTimer = setInterval(writeResourceSnapshot, 5_000);
resourceDiagnosticTimer.unref?.();
writeResourceSnapshot();
const cleanupTimer = setInterval(() => {
  startStorageCleanup({ source: "automatic" });
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();
const seedLeaseTimer = setInterval(() => {
  void sweepSeedLeases();
}, SEED_LEASE_SWEEP_MS);
seedLeaseTimer.unref?.();
setTimeout(() => {
  startStorageCleanup({ source: "startup" });
}, 10_000).unref?.();

let activeAgentRequests = 0;
let peakAgentRequests = 0;

function diagnosticRequestPath(pathname) {
  return pathname
    .replace(/^\/downloads\/[^/]+/, "/downloads/:job")
    .replace(/^\/imports\/[^/]+/, "/imports/:import")
    .replace(/^\/library\/[^/]+/, "/library/:entry");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://" + HOST + ":" + PORT);
  const requestStartedAt = Date.now();
  const requestPath = diagnosticRequestPath(url.pathname);
  let requestSettled = false;
  activeAgentRequests += 1;
  peakAgentRequests = Math.max(peakAgentRequests, activeAgentRequests);
  const settleRequest = () => {
    if (requestSettled) return;
    requestSettled = true;
    activeAgentRequests = Math.max(0, activeAgentRequests - 1);
  };
  response.once("finish", () => {
    settleRequest();
    const durationMs = Date.now() - requestStartedAt;
    if (durationMs < 2_000 || url.pathname.startsWith("/stream/") || url.pathname.startsWith("/hls/")) return;
    agentLogger.warn("slow_agent_request", {
      method: request.method,
      path: requestPath,
      statusCode: response.statusCode,
      durationMs,
    });
  });
  response.once("close", () => {
    settleRequest();
    const durationMs = Date.now() - requestStartedAt;
    if (response.writableFinished || durationMs < 500 || url.pathname.startsWith("/stream/") || url.pathname.startsWith("/hls/")) return;
    agentLogger.warn("aborted_agent_request", {
      method: request.method,
      path: requestPath,
      durationMs,
    });
  });

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
      await persistAgentConfig();
      sendHtml(response, 200, pairingPage(origin, "", true));
    } catch (error) {
      sendHtml(response, 400, "<!doctype html><title>WatchPair Companion</title><p>" + escapeHtml(error.message) + "</p>");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/control/pair") {
    try {
      if (!CONTROL_TOKEN || request.headers["x-watchpair-control"] !== CONTROL_TOKEN) {
        sendJson(response, 403, { error: "Invalid companion control token." });
        return;
      }
      const body = await readJson(request);
      const origin = normalizePairOrigin(body.origin);
      ALLOWED_ORIGINS.add(origin);
      await persistAgentConfig();
      sendJson(response, 200, { ok: true, origin });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  // Desktop preview requests carry the control token in the main process.
  // Reject a supplied-but-invalid token before any catalog, attachment, or HLS
  // route can treat the request as an ordinary browser request.
  const suppliedControlToken = request.headers["x-watchpair-control"];
  if (suppliedControlToken && (!CONTROL_TOKEN || suppliedControlToken !== CONTROL_TOKEN)) {
    sendJson(response, 403, { error: "Invalid companion control token." });
    return;
  }

  const localLibraryPreviewMatch = /^\/library\/([a-f0-9]{24})\/preview$/.exec(url.pathname);
  if (["GET", "HEAD"].includes(request.method) && localLibraryPreviewMatch) {
    try {
      const controlAuthorized = Boolean(CONTROL_TOKEN) &&
        request.headers["x-watchpair-control"] === CONTROL_TOKEN;
      const originHeaders = request.headers.origin ? corsHeaders(request) : null;
      if (!controlAuthorized && !originHeaders) {
        sendJson(response, 403, { error: "Library preview is not authorized." });
        return;
      }
      const rawEntry = libraryCatalog.getFile(localLibraryPreviewMatch[1]);
      if (!rawEntry) {
        sendJson(response, 404, { error: "Library file not found." });
        return;
      }
      const entry = await requireVerifiedLibraryEntry(rawEntry);
      if (!entry) {
        sendJson(response, 409, { error: "Library file has not completed verification." });
        return;
      }
      const validated = await validateLibraryEntry(entry);
      await streamLibraryPreview(
        request,
        response,
        { ...entry, path: validated.path },
        originHeaders || {}
      );
    } catch {
      if (!response.headersSent) sendJson(response, 404, { error: "Library file is no longer available." });
      else response.destroy();
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

    if (url.pathname.startsWith("/control/library")) {
      if (!CONTROL_TOKEN || request.headers["x-watchpair-control"] !== CONTROL_TOKEN) {
        sendJson(response, 403, { error: "Invalid companion control token." }, headers);
        return;
      }

      if (request.method === "POST" && url.pathname === "/control/library/scan") {
        const scan = libraryCatalog.startScan();
        sendJson(response, 202, { ...scan.operation, started: scan.started }, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/control/library/scan") {
        const operation = libraryCatalog.scanStatus(url.searchParams.get("id"));
        if (!operation) {
          sendJson(response, 404, { error: "Library scan not found." }, headers);
          return;
        }
        sendJson(response, 200, operation, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/control/library") {
        sendJson(response, 200, libraryCatalog.list({
          query: url.searchParams.get("query"),
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        }), headers);
        return;
      }
      const controlLibraryMatch = /^\/control\/library\/([a-f0-9]{24})$/.exec(url.pathname);
      if (request.method === "GET" && controlLibraryMatch) {
        const collection = libraryCatalog.getCollection(controlLibraryMatch[1]);
        sendJson(response, collection ? 200 : 404,
          collection ? { collection } : { error: "Library collection not found." }, headers);
        return;
      }
      const controlLibraryPinMatch = /^\/control\/library\/([a-f0-9]{24})\/pin$/.exec(url.pathname);
      if (request.method === "POST" && controlLibraryPinMatch) {
        const body = await readJson(request);
        const collection = await libraryCatalog.setPinned(controlLibraryPinMatch[1], body.pinned);
        sendJson(response, collection ? 200 : 404,
          collection ? { collection } : { error: "Library collection not found." }, headers);
        return;
      }
    }

    if (url.pathname.startsWith("/control/network")) {
      if (!CONTROL_TOKEN || request.headers["x-watchpair-control"] !== CONTROL_TOKEN) {
        sendJson(response, 403, { error: "Invalid companion control token." }, headers);
        return;
      }
      if (request.method === "GET") {
        sendJson(response, 200, { network: { ...networkState } }, headers);
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        if (body && typeof body === "object") {
          if (body.torrentEnabled !== undefined && typeof body.torrentEnabled !== "boolean") {
            throw new Error("torrentEnabled must be a boolean.");
          }
          if (body.offline !== undefined && typeof body.offline !== "boolean") {
            throw new Error("offline must be a boolean.");
          }
        }
        networkState.torrentEnabled = body?.torrentEnabled === undefined
          ? networkState.torrentEnabled
          : Boolean(body.torrentEnabled);
        networkState.offline = body?.offline === undefined
          ? networkState.offline
          : Boolean(body.offline);
        applyNetworkPolicy("control-network");
        sendJson(response, 200, { network: { ...networkState } }, headers);
        return;
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const scheduler = mediaScheduler.snapshot();
      const subtitleWork = subtitleScheduler.snapshot();
      const processes = mediaProcessRegistry.snapshot();
      const activeProcess = processes.active[0] || null;
      const logDetails = agentLogger.details();
      sendJson(response, 200, {
        ok: true,
        version: APP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        downloadDirectory: DOWNLOAD_DIR,
        logging: {
          enabled: logDetails.enabled,
          fileName: logDetails.fileName,
          maxBytes: logDetails.maxBytes,
          maxFiles: logDetails.maxFiles,
        },
        platform: process.platform,
        network: {
          torrentEnabled: networkState.torrentEnabled,
          offline: networkState.offline,
        },
        torrent: {
          port: client.torrentPort || TORRENT_PORT,
          dhtPort: client.dhtPort || DHT_PORT,
          webRtcSupported: WebTorrent.WEBRTC_SUPPORT,
          trackers: Array.from(new Set(TRACKERS.map(sanitizeTrackerEndpoint).filter(Boolean))),
          connectionBudget: torrentPressure.totalBudget,
          perTorrentLimit: torrentPressure.perTorrentLimit,
          maxPerTorrentLimit: torrentPressure.maxPerTorrentLimit,
          trimmedPeers: torrentPressure.trimmedPeers,
          pausedTorrents: torrentPressure.pausedTorrents,
          bandwidth: torrentBandwidth,
        },
        jobs: jobs.size,
        requests: {
          active: activeAgentRequests,
          peak: peakAgentRequests,
        },
        cleanup: CLEANUP_SETTINGS,
        transcoder: TRANSCODER,
        media: {
          mode: mediaResourceProfile("foreground").mode,
          scheduler,
          subtitleScheduler: subtitleWork,
          activeProcesses: processes.active.length,
          activeProcess: activeProcess
            ? {
                stage: activeProcess.stage,
                encoder: activeProcess.encoder,
                decoder: activeProcess.decoder,
                hardware: activeProcess.hardware,
                profile: activeProcess.profile,
                progress: activeProcess.progress,
              }
            : null,
        },
      }, headers);
      return;
    }

    if (request.method === "GET" && url.pathname === "/diagnostics/media") {
      sendJson(response, 200, {
        transcoder: TRANSCODER,
        scheduler: mediaScheduler.snapshot(),
        subtitleScheduler: subtitleScheduler.snapshot(),
        subtitleAssets: subtitleAssetPipeline.snapshot(),
        processes: mediaProcessRegistry.snapshot(),
        hls: hlsPlayback.diagnostics(),
        resources: agentResourceSnapshot(),
      }, headers);
      return;
    }
    if (request.method === "POST" && url.pathname === "/diagnostics/client") {
      const body = await readJson(request);
      const level = ["info", "warn", "error"].includes(body.level) ? body.level : "warn";
      const playbackPath = String(body.playbackPath || "").slice(0, 300);
      agentLogger[level]("browser_playback_event", {
        clientEvent: String(body.event || "unknown").slice(0, 80),
        message: String(body.message || "").slice(0, 700),
        playbackPath: playbackPath.startsWith("/") ? playbackPath : "",
        readyState: Number.isFinite(body.readyState) ? body.readyState : null,
        networkState: Number.isFinite(body.networkState) ? body.networkState : null,
        mediaErrorCode: Number.isFinite(body.mediaErrorCode) ? body.mediaErrorCode : null,
        currentTime: Number.isFinite(body.currentTime) ? body.currentTime : null,
        duration: Number.isFinite(body.duration) ? body.duration : null,
        paused: typeof body.paused === "boolean" ? body.paused : null,
        seekableStart: Number.isFinite(body.seekableStart) ? body.seekableStart : null,
        seekableEnd: Number.isFinite(body.seekableEnd) ? body.seekableEnd : null,
        bufferedStart: Number.isFinite(body.bufferedStart) ? body.bufferedStart : null,
        bufferedEnd: Number.isFinite(body.bufferedEnd) ? body.bufferedEnd : null,
        seekTarget: Number.isFinite(body.seekTarget) ? body.seekTarget : null,
        seekSource: String(body.seekSource || "").slice(0, 40),
        roomPosition: Number.isFinite(body.roomPosition) ? body.roomPosition : null,
        roomActorId: String(body.roomActorId || "").slice(0, 80),
        hlsType: String(body.hlsType || "").slice(0, 100),
        hlsDetails: String(body.hlsDetails || "").slice(0, 200),
        fatal: Boolean(body.fatal),
        consecutiveFailures: Number.isFinite(body.consecutiveFailures) ? body.consecutiveFailures : null,
        healthCheckDurationMs: Number.isFinite(body.healthCheckDurationMs) ? body.healthCheckDurationMs : null,
        recentActivityAgeMs: Number.isFinite(body.recentActivityAgeMs) ? body.recentActivityAgeMs : null,
        userAgent: String(body.userAgent || "").slice(0, 300),
      });
      sendJson(response, 202, { ok: true }, headers);
      return;
    }

    if (request.method === "GET" && url.pathname === "/storage") {
      sendJson(response, 200, {
        directory: DOWNLOAD_DIR,
        cleanup: CLEANUP_SETTINGS,
        usage: await storageUsage(),
        measurement: storageDiskUsage.details(),
      }, headers);
      return;
    }

    if (request.method === "GET" && url.pathname === "/cleanup") {
      const operationId = url.searchParams.get("id");
      const operation = storageCleanupOperation.get(operationId);
      if (!operation) {
        sendJson(response, 404, { error: "Cleanup operation not found." }, headers);
        return;
      }
      sendJson(response, 200, operation, headers);
      return;
    }

    if (request.method === "POST" && url.pathname === "/cleanup") {
      const includeLegacy = url.searchParams.get("includeLegacy") === "1";
      if (
        includeLegacy &&
        (!CONTROL_TOKEN || request.headers["x-watchpair-control"] !== CONTROL_TOKEN)
      ) {
        sendJson(response, 403, { error: "Invalid companion control token." }, headers);
        return;
      }
      const confirmedLegacyJobs = includeLegacy
        ? confirmedLegacyJobIds(await readJson(request))
        : [];
      const operation = startStorageCleanup({
        force: true,
        includeLegacy,
        confirmedLegacyJobs,
        source: "manual",
      });
      sendJson(response, 202, operation, headers);
      return;
    }

    if (request.method === "POST" && url.pathname === "/media-priority") {
      const body = await readJson(request);
      let targets = normalizeMediaTargets(body.targets || []);
      const selected = body.selected
        ? normalizeMediaTargets([body.selected], 1)[0]
        : null;
      if (
        selected &&
        !targets.some((target) =>
          target.jobId === selected.jobId && target.fileIndex === selected.fileIndex
        )
      ) {
        targets = [selected, ...targets];
      }
      setMediaPriority(selected, targets);
      const foreground = mediaResourceProfile("foreground");
      const background = mediaResourceProfile("background");
      sendJson(response, 200, {
        ok: true,
        selected,
        targets: mediaPriorityTargets,
        foregroundLoad: foreground.share,
        backgroundLoad: background.share,
        systemTier: foreground.systemTier,
        foregroundThreads: foreground.threads,
        backgroundThreads: background.threads,
        download: torrentBandwidth,
      }, headers);
      return;
    }

    if (request.method === "POST" && url.pathname === "/preparation-priority") {
      const body = await readJson(request);
      const validSourceId = (value) => /^[a-zA-Z0-9-]{8,80}$/.test(value);
      const sourceId = body.sourceId === null || body.sourceId === undefined
        ? null
        : String(body.sourceId);
      if (sourceId && !validSourceId(sourceId)) {
        throw new Error("A valid priority source id is required.");
      }
      let sourceIds;
      if (body.sourceIds !== undefined) {
        if (!Array.isArray(body.sourceIds) || body.sourceIds.length > 200) {
          throw new Error("A valid preparation order is required.");
        }
        sourceIds = body.sourceIds.map(String);
        if (sourceIds.some((id) => !validSourceId(id))) {
          throw new Error("Every preparation source id must be valid.");
        }
      }
      setPreparationPriority(sourceId, sourceIds);
      sendJson(response, 200, {
        ok: true,
        sourceId: mediaPriorityTargets.find((target) =>
          mediaTargetKey(target.jobId, target.fileIndex) === activePreparationTargetKey
        )?.jobId || null,
        sourceIds: Array.from(new Set(mediaPriorityTargets.map((target) => target.jobId))),
        foregroundLoad: mediaResourceProfile("foreground").share,
        backgroundLoad: mediaResourceProfile("background").share,
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
      sendJson(response, 201, { job: snapshot(job), magnetURI: seedPublicationMagnet(job) }, headers);
      return;
    }

    if (request.method === "GET" && url.pathname === "/library") {
      const result = await scanLibrary(url.searchParams.get("query"));
      sendJson(response, result.stale ? 503 : 200, result.stale
        ? {
            error: result.scan.error || "The library scan failed; the last-good catalog was kept.",
            ...result,
          }
        : result, headers);
      return;
    }

    if (request.method === "GET" && url.pathname === "/library/match") {
      const currentScan = libraryCatalog.scanStatus();
      if (currentScan.status === "error") {
        sendJson(response, 503, {
          error: currentScan.error || "The library scan failed; automatic matching is unavailable.",
          scan: currentScan,
          stale: true,
        }, headers);
        return;
      }
      const fingerprint = url.searchParams.get("fingerprint");
      const file = fingerprint
        ? libraryCatalog.matchFile(fingerprint, Number(url.searchParams.get("size")))
        : libraryCatalog.matchTorrent(url.searchParams.get("infoHash"), {
            fileIndex: url.searchParams.get("fileIndex"),
            relativePath: url.searchParams.get("relativePath"),
            size: url.searchParams.get("size"),
          });
      sendJson(response, file ? 200 : 404,
        file ? { file } : { error: "Matching library file not found." }, headers);
      return;
    }

    const librarySeedMatch = /^\/library\/([a-f0-9]{24})\/seed$/.exec(url.pathname);
    if (request.method === "POST" && librarySeedMatch) {
      const rawEntry = libraryCatalog.getFile(librarySeedMatch[1]);
      if (!rawEntry) throw new Error("Scan the companion library again before selecting that file.");
      const entry = await requireVerifiedLibraryEntry(rawEntry);
      if (!entry) throw new Error("Library file has not completed verification.");
      const body = await readJson(request);
      const validated = await validateLibraryEntry(entry);
      const job = await seedLocalFile({
        id: validJobId(body.sourceId),
        filePath: validated.path,
        label: body.label || entry.name,
        libraryCollectionId: entry.collectionId,
        pinned: libraryCatalog.isCollectionPinned(entry.collectionId),
      });
      await libraryCatalog.setFileFingerprint(entry.id, job.identityFingerprint, entry.size);
      sendJson(response, 201, { job: snapshot(job), magnetURI: seedPublicationMagnet(job) }, headers);
      return;
    }

    const libraryAttachMatch = /^\/library\/([a-f0-9]{24})\/attach$/.exec(url.pathname);
    if (request.method === "POST" && libraryAttachMatch) {
      const rawEntry = libraryCatalog.getFile(libraryAttachMatch[1]);
      if (!rawEntry) throw new Error("Scan the companion library again before selecting that file.");
      const entry = await requireVerifiedLibraryEntry(rawEntry);
      if (!entry) throw new Error("Library file has not completed verification.");
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

    const leaseCollectionMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/leases$/.exec(url.pathname);
    if (request.method === "POST" && leaseCollectionMatch) {
      const lease = await acquireSeedLease(leaseCollectionMatch[1], await readJson(request));
      sendJson(response, lease ? 200 : 404, lease
        ? {
            leaseId: lease.leaseId,
            expiresAt: lease.expiresAt,
            job: snapshot(lease.job),
          }
        : { error: "Download not found." }, headers);
      return;
    }

    const leaseReleaseMatch =
      /^\/downloads\/([a-zA-Z0-9-]{8,80})\/leases\/(lease-[a-zA-Z0-9_-]{16,128})$/.exec(url.pathname);
    if (request.method === "DELETE" && leaseReleaseMatch) {
      sendJson(response, 200,
        await releaseSeedLease(leaseReleaseMatch[1], leaseReleaseMatch[2]), headers);
      return;
    }

    const publicationMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/publication$/.exec(url.pathname);
    if (request.method === "GET" && publicationMatch) {
      const job = jobs.get(publicationMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: "Download not found." }, headers);
        return;
      }
      if (!job.seed) {
        sendJson(response, 409, { error: "This download is not a local seed publication." }, headers);
        return;
      }
      const magnetURI = seedPublicationMagnet(job);
      sendJson(response, magnetURI ? 200 : 202, { magnetURI }, headers);
      return;
    }

    const torrentDetailsMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/torrent$/.exec(url.pathname);
    if (request.method === "GET" && torrentDetailsMatch) {
      if (!CONTROL_TOKEN || request.headers["x-watchpair-control"] !== CONTROL_TOKEN) {
        sendJson(response, 403, { error: "Invalid companion control token." }, headers);
        return;
      }
      const job = jobs.get(torrentDetailsMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: "Download not found." }, headers);
        return;
      }
      if (!job.torrentTelemetry) {
        sendJson(response, 409, { error: "Torrent telemetry is not active." }, headers);
        return;
      }
      sendJson(response, 200, { torrent: job.torrentTelemetry.snapshot() }, headers);
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
      const activeJob = jobs.get(jobMatch[1]);
      if (activeJob?.seed && activeSeedLeaseCount(activeJob) > 0) {
        sendJson(response, 409, { error: "This local seed is still shared by an active room." }, headers);
        return;
      }
      const stopped = await stopJob(jobMatch[1], {
        deleteFiles: url.searchParams.get("deleteFiles") === "1",
      });
      sendJson(response, stopped ? 200 : 404, stopped ? { ok: true } : { error: "Download not found." }, headers);
      return;
    }

    const pinMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/pin$/.exec(url.pathname);
    if (request.method === "POST" && pinMatch) {
      const job = jobs.get(pinMatch[1]);
      if (!job) throw new Error("Download not found.");
      const body = await readJson(request);
      const pinned = Boolean(body.pinned);
      if (job.libraryCollectionId) {
        await libraryCatalog.setPinned(job.libraryCollectionId, pinned);
      } else {
        await libraryCatalog.setManagedJobPinned(job.id, pinned);
      }
      persistJobs();
      await jobStore.flush();
      sendJson(response, 200, { job: snapshot(job) }, headers);
      return;
    }

    const pauseMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/pause$/.exec(url.pathname);
    if (request.method === "POST" && pauseMatch) {
      const job = await pauseJob(pauseMatch[1]);
      sendJson(response, job ? 200 : 404,
        job ? { job: snapshot(job) } : { error: "Download not found." }, headers);
      return;
    }

    const resumeMatch = /^\/downloads\/([a-zA-Z0-9-]{8,80})\/resume$/.exec(url.pathname);
    if (request.method === "POST" && resumeMatch) {
      const job = await resumeJob(resumeMatch[1]);
      sendJson(response, job ? 202 : 404,
        job ? { job: snapshot(job) } : { error: "Download not found." }, headers);
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

    const mediaSubtitleMatch =
      /^\/downloads\/([a-zA-Z0-9-]{8,80})\/media\/(\d+)\/subtitles\/(\d+)\.(vtt|ass)$/.exec(url.pathname);
    const legacySubtitleMatch =
      /^\/downloads\/([a-zA-Z0-9-]{8,80})\/subtitles\/(\d+)\.(vtt|ass)$/.exec(url.pathname);
    const subtitleMatch = mediaSubtitleMatch || legacySubtitleMatch;
    if (request.method === "GET" && subtitleMatch) {
      const job = jobs.get(subtitleMatch[1]);
      const fileIndex = mediaSubtitleMatch ? Number(subtitleMatch[2]) : job?.selectedIndex;
      const trackId = mediaSubtitleMatch ? subtitleMatch[3] : subtitleMatch[2];
      const format = mediaSubtitleMatch ? subtitleMatch[4] : subtitleMatch[3];
      if (!job || !Number.isInteger(fileIndex) || !torrentFileIsFullyVerified(job, fileIndex)) {
        throw new Error("Download is not ready for subtitle extraction.");
      }
      touchJob(job);
      const preparation = requestSubtitleAssetPreparation(job, fileIndex);
      if (preparation.status === "preparing") {
        sendJson(response, 202, preparation, { ...headers, "retry-after": "1" });
        return;
      }
      if (preparation.status === "error") {
        sendJson(response, 422, { error: preparation.error }, headers);
        return;
      }
      const filePath = subtitleFile(job, fileIndex, trackId, format, preparation.assets);
      const info = await stat(filePath);
      response.writeHead(200, {
        ...headers,
        "content-type": format === "ass" ? "text/x-ssa; charset=utf-8" : "text/vtt; charset=utf-8",
        "content-length": info.size,
        "cache-control": "private, max-age=31536000, immutable",
      });
      createReadStream(filePath).pipe(response);
      return;
    }

    const mediaSubtitleFontMatch =
      /^\/downloads\/([a-zA-Z0-9-]{8,80})\/media\/(\d+)\/subtitle-fonts\/(\d+)$/.exec(url.pathname);
    const legacySubtitleFontMatch =
      /^\/downloads\/([a-zA-Z0-9-]{8,80})\/subtitle-fonts\/(\d+)$/.exec(url.pathname);
    const subtitleFontMatch = mediaSubtitleFontMatch || legacySubtitleFontMatch;
    if (request.method === "GET" && subtitleFontMatch) {
      const job = jobs.get(subtitleFontMatch[1]);
      const fileIndex = mediaSubtitleFontMatch ? Number(subtitleFontMatch[2]) : job?.selectedIndex;
      const fontId = mediaSubtitleFontMatch ? subtitleFontMatch[3] : subtitleFontMatch[2];
      if (!job || !Number.isInteger(fileIndex) || !torrentFileIsFullyVerified(job, fileIndex)) {
        throw new Error("Download is not ready for font extraction.");
      }
      touchJob(job);
      const preparation = requestSubtitleAssetPreparation(job, fileIndex);
      if (preparation.status === "preparing") {
        sendJson(response, 202, preparation, { ...headers, "retry-after": "1" });
        return;
      }
      if (preparation.status === "error") {
        sendJson(response, 422, { error: preparation.error }, headers);
        return;
      }
      const font = subtitleFontFile(job, fileIndex, fontId, preparation.assets);
      const info = await stat(font.path);
      response.writeHead(200, {
        ...headers,
        "content-type": font.mimeType,
        "content-length": info.size,
        "cache-control": "private, max-age=31536000, immutable",
      });
      createReadStream(font.path).pipe(response);
      return;
    }

    const hlsMatch = /^\/hls\/([a-zA-Z0-9-]{8,80})\/(\d+)\/(?:(h264|vp9)\/)?(.+)$/.exec(url.pathname);
    if (request.method === "GET" && hlsMatch) {
      const job = jobs.get(hlsMatch[1]);
      if (!job) throw new Error("Download not found.");
      touchJob(job);
      const descriptor = await hlsDescriptor(
        job,
        Number(hlsMatch[2]),
        hlsMatch[3] || "h264",
        url.searchParams.get("audio") || "surround"
      );
      const asset = await hlsPlayback.getAsset(descriptor, hlsMatch[4]);
      await streamHlsAsset(response, asset, headers);
      return;
    }

    const streamMatch = /^\/stream\/([a-zA-Z0-9-]{8,80})\/(\d+)$/.exec(url.pathname);
    if (request.method === "GET" && streamMatch) {
      const job = jobs.get(streamMatch[1]);
      if (!job) throw new Error("Download not found.");
      touchJob(job);
      await streamFile(request, response, job, Number(streamMatch[2]), headers, url.searchParams.get("audio"));
      return;
    }

    sendJson(response, 404, { error: "Not found." }, headers);
  } catch (error) {
    agentLogger.warn("agent_request_failed", {
      method: request.method,
      path: requestPath,
      durationMs: Date.now() - requestStartedAt,
      error,
    });
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Agent request failed.",
    }, headers);
  }
});

server.once("error", (error) => {
  const message = error?.code === "EADDRINUSE"
    ? `Another WatchPair companion is already using http://${HOST}:${PORT}.`
    : `WatchPair agent could not listen on http://${HOST}:${PORT}: ${error.message}`;
  agentLogger.error("agent_listen_failed", { host: HOST, port: PORT, error });
  console.error(message);
  process.exitCode = error?.code === "EADDRINUSE" ? 72 : 1;
  void shutdown().finally(() => process.exit(process.exitCode || 1));
});

server.listen(PORT, HOST, () => {
  agentLogger.info("agent_listening", {
    host: HOST,
    port: PORT,
    downloadDirectory: DOWNLOAD_DIR,
    allowedOrigins: ALLOWED_ORIGINS.size,
    transcoder: TRANSCODER,
    logging: agentLogger.details(),
  });
  console.log(`WatchPair agent listening on http://${HOST}:${PORT}`);
  console.log(`Downloads: ${DOWNLOAD_DIR}`);
  console.log(`Logs: ${agentLogger.details().filePath}`);
  console.log(`Transcoder: ${TRANSCODER.label} via ${TRANSCODER.ffmpegSource} FFmpeg`);
  console.log(`Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(", ")}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  agentLogger.info("agent_shutdown_started", agentResourceSnapshot());
  torrentRecoveryTelemetry.close();
  clearInterval(torrentBandwidthTimer);
  clearInterval(persistenceTimer);
  clearInterval(resourceDiagnosticTimer);
  clearInterval(cleanupTimer);
  clearInterval(seedLeaseTimer);
  const serverClosed = new Promise((resolve) => server.close(resolve));
  mediaScheduler.beginShutdown();
  subtitleScheduler.beginShutdown();
  await Promise.allSettled([
    hlsPlayback.shutdown(),
    mediaProcessRegistry.terminateAll(),
  ]);
  await Promise.all([
    mediaScheduler.shutdown(),
    subtitleScheduler.shutdown(),
  ]);
  persistJobs();
  await Promise.all([
    jobStore.flush(),
    persistAgentConfig(),
    serverClosed,
    new Promise((resolve) => {
      if (client.destroyed) resolve();
      else client.destroy(resolve);
    }),
  ]);
  agentLogger.info("agent_shutdown_finished", { uptimeSeconds: Math.round(process.uptime()) });
  agentLogger.flush();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.parentPort?.on("message", (event) => {
  if (event.data === "shutdown") void shutdown().then(() => process.exit(0));
});
