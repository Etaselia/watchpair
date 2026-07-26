import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CPU_ENCODER,
  VP9_ENCODER,
  validateVideoPipeline,
  videoPipeline,
} from "./hardware-acceleration.mjs";
import {
  renderEncoderArguments,
  renderInputArguments,
} from "./render-queue.mjs";
import {
  applyMediaProcessPriority,
  createMediaTaskScheduler,
} from "./media-governor.mjs";
import {
  attachFfmpegProgress,
  createProcessRegistry,
} from "./process-registry.mjs";

const CACHE_VERSION = "hls-v6";
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

function playlistArguments(segmentSeconds, {
  playlist = "index.m3u8",
  init = "init.mp4",
  segment = "segment-%06d.m4s",
} = {}) {
  return [
    "-f", "hls",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", init,
    "-hls_segment_filename", segment,
    "-hls_flags", "independent_segments+temp_file",
    playlist,
  ];
}

function contentType(filePath) {
  if (filePath.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filePath.endsWith(".m4s")) return "video/iso.segment";
  if (filePath.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function renderPreemptedError() {
  const error = new Error("Background render was preempted by the selected video.");
  error.code = "WATCHPAIR_RENDER_PREEMPTED";
  return error;
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
  scheduler,
  processRegistry,
}) {
  const sessions = new Map();
  let shuttingDown = false;
  let priorityOwnerJobId = null;
  const ownsScheduler = !scheduler;
  const mediaScheduler = scheduler || createMediaTaskScheduler();
  const jobSchedulerIds = new Map();
  const registry = processRegistry || createProcessRegistry();

  function validContentFingerprint(descriptor) {
    const value = String(descriptor.contentFingerprint || "").toLowerCase();
    return /^[a-f0-9]{16,128}$/.test(value) ? value : null;
  }

  function schedulerJobId(descriptor) {
    const fingerprint = validContentFingerprint(descriptor);
    return fingerprint ? `content-${fingerprint}-${descriptor.fileSize}` : `job-${descriptor.jobId}-${descriptor.fileIndex}-${descriptor.fileSize}`;
  }

  function cacheKey(descriptor) {
    return [
      schedulerJobId(descriptor),
      descriptor.fileSize,
      descriptor.rendition || "h264",
      CACHE_VERSION,
    ].join(":");
  }

  function cacheDirectory(descriptor) {
    const fingerprint = validContentFingerprint(descriptor);
    if (fingerprint) {
      return path.join(cacheRoot, "content", `${fingerprint}-${descriptor.fileSize}`, `${descriptor.rendition || "h264"}-${CACHE_VERSION}`);
    }
    return path.join(cacheRoot, "jobs", descriptor.jobId, `${descriptor.fileIndex}-${descriptor.fileSize}-${descriptor.rendition || "h264"}-${CACHE_VERSION}`);
  }

  async function cacheIsComplete(directory, audioTracks) {
    if (!(await completePlaylist(path.join(directory, "video", "index.m3u8")))) return false;
    return Promise.all(
      audioTracks.map((track) =>
        completePlaylist(path.join(directory, "audio", trackDirectory(track), "index.m3u8"))
      )
    ).then((values) => values.every(Boolean));
  }

  function launch(state, label, args, cwd, metadata = {}) {
    const processArguments = ["-progress", "pipe:1", "-nostats", ...args];
    const child = spawn(ffmpegPath, processArguments, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.children.add(child);
    applyMediaProcessPriority(child, state.resourceProfile);
    const tracker = registry.track(child, {
      jobId: state.jobId,
      taskId: state.taskId,
      stage: metadata.stage || label,
      trackId: metadata.trackId,
      encoder: metadata.encoder,
      decoder: metadata.decoder,
      hardware: metadata.hardware,
      profile: `${state.resourceProfile.mode}:${state.resourceProfile.kind}`,
      command: ffmpegPath,
      arguments: processArguments,
      privatePaths: [state.inputPath],
    });
    attachFfmpegProgress(child.stdout, tracker);
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
    const primaryAudioTrack = descriptor.audioTracks.find((track) => track.default)
      || descriptor.audioTracks[0]
      || null;
    const selectedEncoder = descriptor.rendition === "vp9"
      ? VP9_ENCODER
      : canCopyH264Video(descriptor)
        ? { id: "copy", label: "Direct stream copy", hardware: false }
        : encoder;
    const pipeline = selectedEncoder.id === "copy" ? null : videoPipeline(selectedEncoder);
    const state = {
      jobId: descriptor.jobId,
      schedulerJobId: descriptor.schedulerJobId,
      ownerJobIds: new Set([descriptor.jobId]),
      taskId: `hls:${descriptor.fileIndex}:${descriptor.rendition || "h264"}`,
      inputPath: descriptor.inputPath,
      directory,
      children: new Set(),
      errors: new Map(),
      done: null,
      playable: null,
      status: "preparing",
      encoder: selectedEncoder,
      hardwareDecode: Boolean(pipeline?.hardwareDecode),
      pipeline,
      pipelineDiagnostics: [],
      fallback: false,
      stopping: false,
      preempted: false,
      cancelled: false,
      primaryAudioTrack,
      resourceProfile: descriptor.resourceProfile,
    };

    if (await cacheIsComplete(directory, descriptor.audioTracks)) {
      state.status = "ready";
      state.done = Promise.resolve();
      state.playable = Promise.resolve();
      return state;
    }

    if (selectedEncoder.hardware) {
      const pipelineValidation = await validateVideoPipeline(
        ffmpegPath,
        selectedEncoder,
        { path: descriptor.inputPath, codec: descriptor.videoCodec, pixelFormat: descriptor.videoPixelFormat },
        { threadLimit: descriptor.resourceProfile.threads }
      );
      state.pipeline = pipelineValidation.pipeline;
      state.hardwareDecode = Boolean(state.pipeline.hardwareDecode);
      if (!pipelineValidation.ok) state.pipelineDiagnostics.push(pipelineValidation.reason);
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
      "-filter_threads", String(state.resourceProfile.filterThreads),
    ];

    const clearPrimaryOutputs = async () => {
      await rm(videoDirectory, { recursive: true, force: true });
      await mkdir(videoDirectory, { recursive: true });
      if (primaryAudioTrack) {
        const audioDirectory = path.join(directory, "audio", trackDirectory(primaryAudioTrack));
        await rm(audioDirectory, { recursive: true, force: true });
        await mkdir(audioDirectory, { recursive: true });
      }
    };

    const launchPrimary = async () => {
      const videoArguments = () => state.encoder.id === "copy"
        ? ["-c:v", "copy"]
        : state.pipeline.arguments.encode;
      const primaryAudioArguments = primaryAudioTrack
        ? [
            "-map", `0:${primaryAudioTrack.streamIndex}`,
            "-vn", "-sn", "-dn",
            "-c:a", "aac",
            "-threads", "1",
            "-b:a", "192k",
            "-af", "aresample=async=1:first_pts=0",
            ...playlistArguments(segmentSeconds, {
              playlist: `audio/${trackDirectory(primaryAudioTrack)}/index.m3u8`,
              segment: `audio/${trackDirectory(primaryAudioTrack)}/segment-%06d.m4s`,
            }),
          ]
        : [];
      const run = () => launch(
        state,
        primaryAudioTrack ? "video and primary audio" : "video",
        [
          ...baseArguments,
          ...(state.pipeline?.arguments.decode || []),
          ...renderInputArguments(state.resourceProfile),
          ...(descriptor.inputArguments || []),
          "-i", descriptor.inputPath,
          "-map", "0:v:0",
          "-an", "-sn", "-dn",
          ...(state.pipeline ? [...state.pipeline.arguments.filter, ...state.pipeline.arguments.upload] : []),
          ...videoArguments(),
          ...renderEncoderArguments(state.encoder, state.resourceProfile),
          "-max_muxing_queue_size", "4096",
          ...playlistArguments(segmentSeconds, {
            playlist: "video/index.m3u8",
            segment: "video/segment-%06d.m4s",
          }),
          ...primaryAudioArguments,
        ],
        directory,
        {
          stage: primaryAudioTrack ? "video+audio" : "video",
          trackId: primaryAudioTrack ? String(primaryAudioTrack.id) : null,
          encoder: state.encoder.label,
          decoder: state.pipeline?.decode.name || "stream copy",
          hardware: state.encoder.hardware,
        }
      );

      try {
        await run();
      } catch (error) {
        if (state.stopping || state.encoder.id === "copy" || !state.encoder.hardware) throw error;
        if (state.hardwareDecode) {
          console.warn(`WatchPair ${state.encoder.label} hardware decoding failed for this file; retrying GPU encoding with CPU decoding.`);
          state.hardwareDecode = false;
          state.pipeline = videoPipeline(state.encoder, { hardwareDecode: false });
          state.pipelineDiagnostics.push({
            code: "runtime_hardware_decode_failed",
            stage: "decode/filter/upload",
            backend: state.encoder.id,
            message: `${state.encoder.label} failed on this source; retrying with software decode.`,
          });
          await clearPrimaryOutputs();
          try {
            await run();
            return;
          } catch (retryError) {
            if (state.stopping) throw retryError;
            // Fall through to a complete CPU fallback.
          }
        }
        const failedEncoder = state.encoder;
        console.warn(`WatchPair ${state.encoder.label} encoding failed for this file; retrying with CPU encoding.`);
        state.encoder = CPU_ENCODER;
        state.hardwareDecode = false;
        state.pipeline = videoPipeline(CPU_ENCODER);
        state.pipelineDiagnostics.push({
          code: "runtime_hardware_encode_failed",
          stage: "encode",
          backend: failedEncoder.id,
          message: `${failedEncoder.label} failed on this source; using constrained CPU encoding.`,
        });
        state.fallback = true;
        await clearPrimaryOutputs();
        await run();
      }
    };

    const launchAlternateAudio = async (track) => {
      const id = trackDirectory(track);
      const audioDirectory = path.join(directory, "audio", id);
      await launch(
        state,
        `audio track ${track.label}`,
        [
          ...baseArguments,
          ...renderInputArguments(state.resourceProfile),
          ...(descriptor.inputArguments || []),
          "-i", descriptor.inputPath,
          "-map", `0:${track.streamIndex}`,
          "-vn", "-sn", "-dn",
          "-c:a", "aac",
          "-threads", "1",
          "-b:a", "192k",
          "-af", "aresample=async=1:first_pts=0",
          ...playlistArguments(segmentSeconds),
        ],
        audioDirectory,
        {
          stage: "audio",
          trackId: id,
          encoder: "AAC",
          decoder: "software/default",
          hardware: false,
        }
      );
    };

    const backgroundAudioTracks = descriptor.audioTracks.filter((track) => track !== primaryAudioTrack);

    state.done = launchPrimary()
      .catch((error) => {
        state.errors.set("video", error);
        if (primaryAudioTrack) state.errors.set(`audio:${trackDirectory(primaryAudioTrack)}`, error);
        throw error;
      })
      .then(async () => {
        for (const track of backgroundAudioTracks) {
          if (state.stopping) return;
          const id = trackDirectory(track);
          try {
            await launchAlternateAudio(track);
          } catch (error) {
            state.errors.set(`audio:${id}`, error);
            throw error;
          }
        }
      })
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
      ...(primaryAudioTrack ? [`audio/${trackDirectory(primaryAudioTrack)}/init.mp4`] : []),
    ];
    const playablePlaylists = [
      "video/index.m3u8",
      ...(primaryAudioTrack ? [`audio/${trackDirectory(primaryAudioTrack)}/index.m3u8`] : []),
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
    const schedulingId = schedulerJobId(descriptor);
    let schedulingIds = jobSchedulerIds.get(descriptor.jobId);
    if (!schedulingIds) jobSchedulerIds.set(descriptor.jobId, schedulingIds = new Set());
    schedulingIds.add(schedulingId);
    if (priorityOwnerJobId === descriptor.jobId) mediaScheduler.prioritize(schedulingId);
    let pending = sessions.get(key);
    if (!pending) {
      pending = mediaScheduler.enqueue({
        taskId: `hls:${descriptor.fileIndex}:${descriptor.rendition || "h264"}`,
        jobId: schedulingId,
        stage: "browser-playback",
        priority: 50,
        run: async (resourceProfile) => {
          descriptor.onStart?.();
          const state = await initialize({
            ...descriptor,
            schedulerJobId: schedulingId,
            resourceProfile,
          });
          return {
            value: state,
            completion: state.done,
            interrupt: () => {
              if (state.stopping) return;
              state.preempted = true;
              state.stopping = true;
              for (const child of state.children) child.kill("SIGTERM");
              void state.done.finally(async () => {
                if (await invalidatePreempted(descriptor, state) && !state.cancelled && !shuttingDown) await ensure(descriptor);
              }).catch(() => {});
            },
          };
          },
      }).catch((error) => {
        sessions.delete(key);
        throw error;
      });
      sessions.set(key, pending);
    }
    const state = await pending;
    state.ownerJobIds.add(descriptor.jobId);
    return state;
  }

  async function invalidatePreempted(descriptor, state) {
    const key = cacheKey(descriptor);
    const pending = sessions.get(key);
    if (pending && await pending.catch(() => null) === state) {
      sessions.delete(key);
      return true;
    }
    return false;
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
      if (state.cancelled) throw new Error("Render was cancelled.");
      if (state.preempted) throw renderPreemptedError();
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
      if (state.cancelled) throw new Error("Render was cancelled.");
      if (state.preempted) throw renderPreemptedError();
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
    while (true) {
      const state = await ensure(descriptor);
      try {
        const filePath = await waitForAsset(state, relativePath);
        return {
          filePath,
          type: contentType(filePath),
          cacheControl: relativePath.endsWith(".m3u8")
            ? "no-store"
            : "private, max-age=31536000, immutable",
        };
      } catch (error) {
        if (error?.code !== "WATCHPAIR_RENDER_PREEMPTED") throw error;
        await invalidatePreempted(descriptor, state);
      }
    }
  }

  async function prepare(descriptor) {
    while (true) {
      const state = await ensure(descriptor);
      try {
        await state.playable;
        return preparationState(state);
      } catch (error) {
        if (error?.code !== "WATCHPAIR_RENDER_PREEMPTED") throw error;
        await invalidatePreempted(descriptor, state);
      }
    }
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
      resourceProfile: state.resourceProfile.kind,
      pipeline: state.pipeline,
      diagnostics: state.pipelineDiagnostics,
    };
  }

  async function removeJob(jobId) {
    const schedulingIds = jobSchedulerIds.get(jobId) || new Set();
    jobSchedulerIds.delete(jobId);
    const stillOwned = (schedulingId) => Array.from(jobSchedulerIds.values())
      .some((ids) => ids.has(schedulingId));
    const orphaned = new Set(Array.from(schedulingIds).filter((id) => !stillOwned(id)));
    for (const schedulingId of orphaned) mediaScheduler.cancelJob(schedulingId);

    const matching = Array.from(sessions.entries()).filter(([key]) =>
      Array.from(schedulingIds).some((id) => key.startsWith(`${id}:`))
    );
    const stopping = [];
    for (const [key, pending] of matching) {
      const schedulingId = key.split(":", 1)[0];
      if (!orphaned.has(schedulingId)) {
        void pending.then((state) => state.ownerJobIds.delete(jobId)).catch(() => {});
        continue;
      }
      sessions.delete(key);
      stopping.push(pending.then(async (state) => {
        state.cancelled = true;
        state.stopping = true;
        for (const child of state.children) child.kill("SIGTERM");
        await state.done?.catch(() => {});
      }));
    }
    await Promise.allSettled(stopping);
    await Promise.all([
      rm(path.join(cacheRoot, "jobs", jobId), { recursive: true, force: true }),
      rm(path.join(cacheRoot, jobId), { recursive: true, force: true }),
    ]);
  }

  function setPriorityJob(jobId) {
    priorityOwnerJobId = jobId || null;
    const schedulingId = jobId ? jobSchedulerIds.get(jobId)?.values().next().value : null;
    mediaScheduler.prioritize(schedulingId || jobId || null);
  }

  async function shutdown() {
    const jobIds = new Set();
    shuttingDown = true;
    for (const key of sessions.keys()) jobIds.add(key.split(":", 1)[0]);
    for (const jobId of jobIds) mediaScheduler.cancelJob(jobId);
    const stopping = Array.from(sessions.values());
    await Promise.allSettled(stopping.map((pending) => pending.then(async (state) => {
      state.cancelled = true;
      state.stopping = true;
      for (const child of state.children) child.kill("SIGTERM");
      await state.done?.catch(() => {});
    })));
    if (ownsScheduler) mediaScheduler.shutdown();
  }

  return {
    getAsset,
    getPreparation,
    prepare,
    removeJob,
    setPriorityJob,
    shutdown,
    diagnostics: () => ({ scheduler: mediaScheduler.snapshot(), processes: registry.snapshot() }),
  };
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
