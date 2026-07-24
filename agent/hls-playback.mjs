import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CPU_ENCODER,
  VP9_ENCODER,
  videoDecoderArguments,
  videoDecoderFilterArguments,
  videoEncoderArguments,
} from "./hardware-acceleration.mjs";

const CACHE_VERSION = "hls-v5";
const DEFAULT_SEGMENT_SECONDS = 4;
const DEFAULT_PLAYABLE_SECONDS = 120;
const PLAYLIST_WAIT_MS = 15 * 60_000;

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

function playlistArguments(segmentSeconds) {
  return [
    "-f", "hls",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", "segment-%06d.m4s",
    "-hls_flags", "independent_segments+temp_file",
    "index.m3u8",
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

const COPYABLE_H264_PROFILES = new Set([
  "baseline",
  "constrained baseline",
  "main",
  "high",
]);

export function canCopyH264Video(descriptor) {
  return (
    descriptor.videoCodec === "h264" &&
    ["yuv420p", "yuvj420p"].includes(descriptor.videoPixelFormat) &&
    COPYABLE_H264_PROFILES.has(String(descriptor.videoProfile || "").toLowerCase())
  );
}

export function createHlsPlaybackManager({
  ffmpegPath,
  cacheRoot,
  encoder = CPU_ENCODER,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  playableSeconds = DEFAULT_PLAYABLE_SECONDS,
  playlistWaitMs = PLAYLIST_WAIT_MS,
}) {
  const sessions = new Map();

  function cacheKey(descriptor) {
    return [
      descriptor.jobId,
      descriptor.fileIndex,
      descriptor.fileSize,
      descriptor.rendition || "h264",
      CACHE_VERSION,
    ].join(":");
  }

  function cacheDirectory(descriptor) {
    return path.join(
      cacheRoot,
      descriptor.jobId,
      `${descriptor.fileIndex}-${descriptor.fileSize}-${descriptor.rendition || "h264"}-${CACHE_VERSION}`
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

  function launch(state, label, args, cwd) {
    const child = spawn(ffmpegPath, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    state.children.add(child);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });

    return new Promise((resolve, reject) => {
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
  }

  async function initialize(descriptor) {
    const directory = cacheDirectory(descriptor);
    const state = {
      directory,
      children: new Set(),
      errors: new Map(),
      done: null,
      playable: null,
      status: "preparing",
      encoder: descriptor.rendition === "vp9"
        ? VP9_ENCODER
        : canCopyH264Video(descriptor)
          ? { id: "copy", label: "Direct stream copy", hardware: false }
          : encoder,
      hardwareDecode:
        descriptor.rendition !== "vp9" &&
        !canCopyH264Video(descriptor) &&
        videoDecoderArguments(encoder).length > 0,
      fallback: false,
      stopping: false,
    };

    if (await cacheIsComplete(directory, descriptor.audioTracks)) {
      state.status = "ready";
      state.done = Promise.resolve();
      state.playable = Promise.resolve();
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
    ];

    const launchVideo = async () => {
      const argumentsFor = (selectedEncoder) => selectedEncoder.id === "copy"
        ? ["-c:v", "copy"]
        : videoEncoderArguments(selectedEncoder, segmentSeconds);
      const run = () => launch(
        state,
        "video",
        [
          ...baseArguments,
          ...(state.hardwareDecode ? videoDecoderArguments(state.encoder) : []),
          ...(descriptor.inputArguments || []),
          "-i", descriptor.inputPath,
          "-map", "0:v:0",
          "-an", "-sn", "-dn",
          ...(state.hardwareDecode
            ? videoDecoderFilterArguments(state.encoder)
            : state.encoder.hardware
              ? ["-vf", "format=yuv420p"]
              : []),
          ...argumentsFor(state.encoder),
          "-max_muxing_queue_size", "4096",
          ...playlistArguments(segmentSeconds),
        ],
        videoDirectory
      );

      try {
        await run();
      } catch (error) {
        if (state.stopping || state.encoder.id === "copy" || !state.encoder.hardware) throw error;
        if (state.hardwareDecode) {
          console.warn(`WatchPair ${state.encoder.label} hardware decoding failed for this file; retrying GPU encoding with CPU decoding.`);
          state.hardwareDecode = false;
          await rm(videoDirectory, { recursive: true, force: true });
          await mkdir(videoDirectory, { recursive: true });
          try {
            await run();
            return;
          } catch (retryError) {
            if (state.stopping) throw retryError;
            // Fall through to a complete CPU fallback.
          }
        }
        console.warn(`WatchPair ${state.encoder.label} encoding failed for this file; retrying with CPU encoding.`);
        state.encoder = CPU_ENCODER;
        state.hardwareDecode = false;
        state.fallback = true;
        await rm(videoDirectory, { recursive: true, force: true });
        await mkdir(videoDirectory, { recursive: true });
        await run();
      }
    };

    const tasks = [
      launchVideo().catch((error) => {
        state.errors.set("video", error);
        throw error;
      }),
      ...descriptor.audioTracks.map((track) => {
        const id = trackDirectory(track);
        const audioDirectory = path.join(directory, "audio", id);
        return launch(
          state,
          `audio track ${track.label}`,
          [
            ...baseArguments,
            ...(descriptor.inputArguments || []),
            "-i", descriptor.inputPath,
            "-map", `0:${track.streamIndex}`,
            "-vn", "-sn", "-dn",
            "-c:a", "aac",
            "-b:a", "192k",
            "-af", "aresample=async=1:first_pts=0",
            ...playlistArguments(segmentSeconds),
          ],
          audioDirectory
        ).catch((error) => {
          state.errors.set(`audio:${id}`, error);
          throw error;
        });
      }),
    ];

    state.done = Promise.all(tasks)
      .then(() => {
        state.status = "ready";
      })
      .catch((error) => {
        if (state.stopping) return;
        state.status = "error";
        console.error(`WatchPair ${error.message}`);
        throw error;
      });
    void state.done.catch(() => {});
    const playableAssets = [
      "video/init.mp4",
      ...descriptor.audioTracks.map((track) =>
        `audio/${trackDirectory(track)}/init.mp4`
      ),
    ];
    const playablePlaylists = [
      "video/index.m3u8",
      ...descriptor.audioTracks.map((track) =>
        `audio/${trackDirectory(track)}/index.m3u8`
      ),
    ];
    state.playable = Promise.all(playableAssets.map((asset) => waitForAsset(state, asset)))
      .then(() => Promise.all(
        playablePlaylists.map((playlist) =>
          waitForPlaylistWindow(state, playlist, playableSeconds)
        )
      ))
      .then(() => {
        if (state.status === "preparing") state.status = "ready";
      });
    void state.playable.catch(() => {});
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

  async function waitForPlaylistWindow(state, relativePath, requiredSeconds) {
    const filePath = await waitForAsset(state, relativePath);
    const started = Date.now();
    while (true) {
      const playlist = await readFile(filePath, "utf8").catch(() => "");
      const duration = Array.from(playlist.matchAll(/^#EXTINF:([\d.]+)/gm))
        .reduce((total, match) => total + Number(match[1] || 0), 0);
      if (duration >= requiredSeconds || playlist.includes("#EXT-X-ENDLIST")) return filePath;

      const errorKey = assetErrorKey(relativePath);
      const error = errorKey ? state.errors.get(errorKey) : null;
      if (error) throw error;
      if (Date.now() - started >= playlistWaitMs) {
        throw new Error(`Timed out while preparing the first ${requiredSeconds} seconds for playback.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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

  async function prepare(descriptor) {
    const state = await ensure(descriptor);
    await state.playable;
    return preparationState(state);
  }

  async function getPreparation(descriptor) {
    const pending = sessions.get(cacheKey(descriptor));
    if (!pending) return { status: "waiting", encoder: null, fallback: false };
    return preparationState(await pending);
  }

  function preparationState(state) {
    return {
      status: state.status,
      encoder: {
        id: state.encoder.id,
        label: state.encoder.label,
        hardware: Boolean(state.encoder.hardware),
      },
      hardwareDecode: Boolean(state.hardwareDecode),
      fallback: state.fallback,
    };
  }

  function shutdown() {
    for (const pending of sessions.values()) {
      void pending.then((state) => {
        state.stopping = true;
        for (const child of state.children) child.kill("SIGTERM");
      });
    }
  }

  return { getAsset, getPreparation, prepare, shutdown };
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
