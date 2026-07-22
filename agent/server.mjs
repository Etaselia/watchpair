import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import WebTorrent from "webtorrent";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WATCHPAIR_AGENT_PORT || 41735);
const DOWNLOAD_DIR = path.resolve(process.env.WATCHPAIR_DOWNLOAD_DIR || "./downloads");
const ALLOWED_ORIGINS = new Set(
  (process.env.WATCHPAIR_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|ts)$/i;
const jobs = new Map();
const client = new WebTorrent();

await mkdir(DOWNLOAD_DIR, { recursive: true });

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

function safeName(value) {
  return String(value || "video")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180) || "video";
}

function assertPublicHttp(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS direct downloads are supported.");
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1";
  if (blocked) throw new Error("Private network download targets are blocked.");
  return url;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function selectTorrentFile(job, index) {
  if (!job.torrent?.files[index]) throw new Error("Torrent file not found.");
  job.torrent.files.forEach((file) => file.deselect());
  job.torrent.files[index].select(10);
  job.selectedIndex = index;
  job.updatedAt = Date.now();
}

function torrentFiles(job) {
  if (!job.torrent) return [];
  return job.torrent.files.map((file, index) => {
    const progress = Number(file.progress || 0);
    return {
      index,
      name: file.path || file.name,
      size: file.length,
      downloaded: Math.round(file.length * progress),
      progress: Math.round(progress * 1000) / 10,
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
    files,
    updatedAt: job.updatedAt,
  };
}

function startTorrent(job) {
  job.status = "metadata";
  const torrent = client.add(job.value, { path: path.join(DOWNLOAD_DIR, job.id) });
  job.torrent = torrent;

  torrent.on("metadata", () => {
    const videos = torrent.files
      .map((file, index) => ({ index, size: file.length, video: VIDEO_EXTENSIONS.test(file.name) }))
      .sort((a, b) => Number(b.video) - Number(a.video) || b.size - a.size);
    if (videos[0]) selectTorrentFile(job, videos[0].index);
    job.status = "downloading";
    job.updatedAt = Date.now();
  });
  torrent.on("download", () => {
    job.status = "downloading";
    job.updatedAt = Date.now();
  });
  torrent.on("done", () => {
    job.status = "ready";
    job.updatedAt = Date.now();
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
    const target = assertPublicHttp(job.value);
    const response = await fetch(target, { redirect: "follow" });
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
    job.status = "ready";
    job.updatedAt = Date.now();
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
  const value = String(source.value || "");
  if (kind === "magnet" && !value.startsWith("magnet:?")) throw new Error("Invalid magnet source.");

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

async function streamFile(request, response, job, fileIndex, headers) {
  let fileName;
  let size;
  let createStream;
  let fallbackType;

  if (job.kind === "magnet") {
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
    "content-disposition": `inline; filename="${safeName(fileName)}"`,
  };

  if (!range) {
    response.writeHead(200, { ...baseHeaders, "content-length": size });
    createStream({ start: 0, end: size - 1 }).pipe(response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { ...baseHeaders, "content-range": `bytes */${size}` });
    response.end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    response.writeHead(416, { ...baseHeaders, "content-range": `bytes */${size}` });
    response.end();
    return;
  }

  response.writeHead(206, {
    ...baseHeaders,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
  });
  createStream({ start, end }).pipe(response);
}

const server = createServer(async (request, response) => {
  const headers = corsHeaders(request);
  if (!headers) {
    sendJson(response, 403, { error: "Origin is not allowed." });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        version: "0.1.0",
        downloadDirectory: DOWNLOAD_DIR,
        jobs: jobs.size,
      }, headers);
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

    const streamMatch = /^\/stream\/([a-zA-Z0-9-]{8,80})\/(\d+)$/.exec(url.pathname);
    if (request.method === "GET" && streamMatch) {
      const job = jobs.get(streamMatch[1]);
      if (!job) throw new Error("Download not found.");
      await streamFile(request, response, job, Number(streamMatch[2]), headers);
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
