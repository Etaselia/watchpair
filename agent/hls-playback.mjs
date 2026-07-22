import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_VERSION = "hls-v1";
const DEFAULT_SEGMENT_SECONDS = 4;
const PLAYLIST_WAIT_MS = 60_000;

function quoted(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function trackDirectory(track) {
  const id = String(track.id);
  if (!/^\d+$/.test(id)) throw new Error("Invalid embedded audio track.");
  return id;
}

async function exists(filePath) {
  try {
    return (await stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

async function completePlaylist(filePath) {
  try {
    return (await readFile(filePath, "utf8")).includes("#EXT-X-ENDLIST");
  } catch {
    return false;
  }
}

function masterPlaylist(audioTracks) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  const defaultTrack = audioTracks.find((track) => track.default) || audioTracks[0];

  for (const track of audioTracks) {
    const id = trackDirectory(track);
    const isDefault = track === defaultTrack ? "YES" : "NO";
    const language = quoted(track.language === "und" ? "" : track.language);
    const languageAttribute = language ? `,LANGUAGE="${language}"` : "";
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="watchpair-audio",NAME="${quoted(track.label)}",DEFAULT=${isDefault},AUTOSELECT=YES${languageAttribute},URI="audio/${id}/index.m3u8"`
    );
  }

  lines.push(
    audioTracks.length
      ? '#EXT-X-STREAM-INF:BANDWIDTH=6500000,AUDIO="watchpair-audio"'
      : "#EXT-X-STREAM-INF:BANDWIDTH=6500000",
    "video/index.m3u8",
    ""
  );
  return lines.join("\n");
}

function playlistArguments(directory, segmentSeconds) {
  return [
    "-f", "hls",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", path.join(directory, "segment-%06d.m4s"),
    "-hls_flags", "independent_segments+temp_file",
    path.join(directory, "index.m3u8"),
  ];
}

function contentType(filePath) {
  if (filePath.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filePath.endsWith(".m4s")) return "video/iso.segment";
  if (filePath.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function pipelineError(label, code, stderr) {
  const detail = stderr.trim().split("\n").slice(-4).join(" ").slice(0, 700);
  return new Error(
    `${label} preparation failed${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : "."}`
  );
}

export function createHlsPlaybackManager({
  ffmpegPath,
  cacheRoot,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  playlistWaitMs = PLAYLIST_WAIT_MS,
}) {
  const sessions = new Map();

  function cacheKey(descriptor) {
    return [
      descriptor.jobId,
      descriptor.fileIndex,
      descriptor.fileSize,
      CACHE_VERSION,
    ].join(":");
  }

  function cacheDirectory(descriptor) {
    return path.join(
      cacheRoot,
      descriptor.jobId,
      `${descriptor.fileIndex}-${descriptor.fileSize}-${CACHE_VERSION}`
    );
  }

  async function cacheIsComplete(directory, audioTracks) {
    if (!(await completePlaylist(path.join(directory, "video", "index.m3u8")))) return false;
    return Promise.all(
      audioTracks.map((track) =>
        completePlaylist(path.join(directory, "audio", trackDirectory(track), "index.m3u8"))
      )
    ).then((values) => values.every(Boolean));
  }

  function launch(state, label, args, errorKey) {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    state.children.add(child);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });

    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        state.children.delete(child);
        if (code === 0) {
          resolve();
          return;
        }
        reject(pipelineError(label, code, stderr));
      });
    });

    void done.catch((error) => {
      state.errors.set(errorKey, error);
      console.error(`WatchPair ${error.message}`);
    });
    return done;
  }

  async function initialize(descriptor) {
    const directory = cacheDirectory(descriptor);
    const state = {
      directory,
      children: new Set(),
      errors: new Map(),
      done: null,
    };

    if (await cacheIsComplete(directory, descriptor.audioTracks)) {
      state.done = Promise.resolve();
      return state;
    }

    await rm(directory, { recursive: true, force: true });
    const videoDirectory = path.join(directory, "video");
    await mkdir(videoDirectory, { recursive: true });
    for (const track of descriptor.audioTracks) {
      await mkdir(path.join(directory, "audio", trackDirectory(track)), { recursive: true });
    }
    await writeFile(path.join(directory, "master.m3u8"), masterPlaylist(descriptor.audioTracks));

    const baseArguments = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", descriptor.inputPath,
    ];
    const videoCodecArguments = descriptor.videoCodec === "h264"
      ? ["-c:v", "copy"]
      : [
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "23",
          "-pix_fmt", "yuv420p",
          "-sc_threshold", "0",
          "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`,
        ];

    const tasks = [
      launch(
        state,
        "video",
        [
          ...baseArguments,
          "-map", "0:v:0",
          "-an", "-sn", "-dn",
          ...videoCodecArguments,
          "-max_muxing_queue_size", "4096",
          ...playlistArguments(videoDirectory, segmentSeconds),
        ],
        "video"
      ),
      ...descriptor.audioTracks.map((track) => {
        const id = trackDirectory(track);
        const audioDirectory = path.join(directory, "audio", id);
        return launch(
          state,
          `audio track ${track.label}`,
          [
            ...baseArguments,
            "-map", `0:${track.streamIndex}`,
            "-vn", "-sn", "-dn",
            "-c:a", "aac",
            "-b:a", "192k",
            "-af", "aresample=async=1:first_pts=0",
            ...playlistArguments(audioDirectory, segmentSeconds),
          ],
          `audio:${id}`
        );
      }),
    ];

    state.done = Promise.allSettled(tasks).then(() => undefined);
    return state;
  }

  async function ensure(descriptor) {
    const key = cacheKey(descriptor);
    let pending = sessions.get(key);
    if (!pending) {
      pending = initialize(descriptor).catch((error) => {
        sessions.delete(key);
        throw error;
      });
      sessions.set(key, pending);
    }
    return pending;
  }

  function assetErrorKey(relativePath) {
    if (relativePath.startsWith("video/")) return "video";
    const match = /^audio\/(\d+)\//.exec(relativePath);
    return match ? `audio:${match[1]}` : null;
  }

  async function waitForAsset(state, relativePath) {
    const target = path.resolve(state.directory, relativePath);
    if (target !== state.directory && !target.startsWith(state.directory + path.sep)) {
      throw new Error("Invalid HLS asset path.");
    }

    const started = Date.now();
    while (!(await exists(target))) {
      const errorKey = assetErrorKey(relativePath);
      const error = errorKey ? state.errors.get(errorKey) : null;
      if (error) throw error;
      if (Date.now() - started >= playlistWaitMs) {
        throw new Error("Timed out while preparing browser-ready video segments.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return target;
  }

  async function getAsset(descriptor, relativePath) {
    if (!/^(master\.m3u8|video\/(?:index\.m3u8|init\.mp4|segment-\d{6}\.m4s)|audio\/\d+\/(?:index\.m3u8|init\.mp4|segment-\d{6}\.m4s))$/.test(relativePath)) {
      throw new Error("Invalid HLS asset.");
    }
    const state = await ensure(descriptor);
    const filePath = await waitForAsset(state, relativePath);
    return {
      filePath,
      type: contentType(filePath),
      cacheControl: relativePath.endsWith(".m3u8")
        ? "no-store"
        : "private, max-age=31536000, immutable",
    };
  }

  function shutdown() {
    for (const pending of sessions.values()) {
      void pending.then((state) => {
        for (const child of state.children) child.kill("SIGTERM");
      });
    }
  }

  return { getAsset, shutdown };
}

async function readStableAsset(filePath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(filePath);
    } catch (error) {
      if (!["EAGAIN", "ENODATA", "ENOENT"].includes(error?.code) || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("HLS playlist could not be read.");
}

export async function streamHlsAsset(response, asset, headers = {}) {
  if (asset.filePath.endsWith(".m3u8")) {
    const contents = await readStableAsset(asset.filePath);
    response.writeHead(200, {
      ...headers,
      "content-type": asset.type,
      "content-length": contents.length,
      "cache-control": asset.cacheControl,
    });
    response.end(contents);
    return;
  }

  const info = await stat(asset.filePath);
  response.writeHead(200, {
    ...headers,
    "content-type": asset.type,
    "content-length": info.size,
    "cache-control": asset.cacheControl,
  });
  createReadStream(asset.filePath).pipe(response);
}
