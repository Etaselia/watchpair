import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

const CACHE_VERSION = "hls-v10";
const DEFAULT_SEGMENT_SECONDS = 4;
const DEFAULT_PLAYABLE_SECONDS = 120;
const PLAYLIST_WAIT_MS = 15 * 60_000;
const FRAGMENT_VALIDATION_TIMEOUT_MS = 15_000;
const GENERATION_POINTER = "current.json";
const WORKING_POINTER = "working.json";
const COMPLETE_MARKER = "complete.json";

function mediaPlaylistSegments(playlist) {
  const mediaSequence = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)$/m.exec(playlist)?.[1] || 0);
  const segments = [];
  let duration = null;
  let sequence = mediaSequence;
  for (const rawLine of playlist.split(/\r?\n/)) {
    const line = rawLine.trim();
    const durationMatch = /^#EXTINF:([\d.]+)/.exec(line);
    if (durationMatch) {
      duration = Number(durationMatch[1]);
      continue;
    }
    if (duration === null || !line || line.startsWith("#")) continue;
    segments.push({ sequence, duration, uri: line });
    sequence += 1;
    duration = null;
  }
  return { mediaSequence, segments, complete: playlist.includes("#EXT-X-ENDLIST") };
}

async function playlistWindow(directory, relativePath, playlist) {
  const parsed = mediaPlaylistSegments(playlist);
  if (parsed.mediaSequence !== 0 || !parsed.segments.length) {
    return { duration: 0, complete: false, segmentCount: 0 };
  }

  const playlistDirectory = path.dirname(path.join(directory, relativePath));
  let duration = 0;
  for (const [index, segment] of parsed.segments.entries()) {
    const expectedName = `segment-${String(index).padStart(6, "0")}.m4s`;
    const uriPath = segment.uri.split(/[?#]/, 1)[0];
    const segmentPath = path.resolve(playlistDirectory, uriPath);
    if (
      segment.sequence !== index ||
      path.basename(uriPath) !== expectedName ||
      (segmentPath !== playlistDirectory && !segmentPath.startsWith(playlistDirectory + path.sep))
    ) return { duration, complete: false, segmentCount: index };
    duration += segment.duration;
  }

  const firstPath = path.join(playlistDirectory, "segment-000000.m4s");
  const lastPath = path.join(
    playlistDirectory,
    `segment-${String(parsed.segments.length - 1).padStart(6, "0")}.m4s`
  );
  if (!(await exists(firstPath)) || !(await exists(lastPath))) {
    return { duration: 0, complete: false, segmentCount: 0 };

  }
  return {
    duration,
    complete: parsed.complete,
    segmentCount: parsed.segments.length,
  };
}

function resumeInputArguments(seconds) {
  return seconds > 0
    ? ["-ss", seconds.toFixed(3)]
    : [];
}

function normalizedVideoFilterArguments(argumentsList) {
  const result = [...argumentsList];
  const timestampFilter = "setpts=PTS-STARTPTS";
  const filterIndex = result.indexOf("-vf");
  if (filterIndex >= 0 && result[filterIndex + 1]) {
    result[filterIndex + 1] += "," + timestampFilter;
  } else {
    result.push("-vf", timestampFilter);
  }
  return result;
}

function normalizedAudioFilter() {
  return "aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS";
}

function timelineOutputArguments(seconds) {
  return [
    "-avoid_negative_ts", "make_zero",
    ...(seconds > 0
      ? ["-output_ts_offset", seconds.toFixed(3)]
      : []),
  ];
}

async function playlistCheckpoint(directory, relativePath) {
  try {
    const playlist = await readFile(path.join(directory, relativePath), "utf8");
    return playlistWindow(directory, relativePath, playlist);
  } catch {
    return { duration: 0, complete: false, segmentCount: 0 };
  }
}

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
  append = false,
} = {}) {
  return [
    "-f", "hls",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", init,
    "-hls_segment_filename", segment,
    "-hls_flags", "independent_segments+temp_file" + (append ? "+append_list" : ""),
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

export function startsAtBrowserZero(descriptor) {
  const hasStartTime =
    descriptor.videoStartTime !== null &&
    descriptor.videoStartTime !== undefined;
  const videoStartTime = Number(descriptor.videoStartTime);
  return (
    hasStartTime && Number.isFinite(videoStartTime) &&
    videoStartTime >= -0.25 && videoStartTime <= 0.05
  );
}

export function canCopyH264Video(descriptor) {
  return (
    descriptor.videoCodec === "h264" &&
    ["yuv420p", "yuvj420p"].includes(descriptor.videoPixelFormat) &&
    COPYABLE_H264_PROFILES.has(String(descriptor.videoProfile || "").toLowerCase()) &&
    startsAtBrowserZero(descriptor)
  );
}

export function createHlsPlaybackManager({
  ffmpegPath,
  ffprobePath = null,
  cacheRoot,
  encoder = CPU_ENCODER,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  playableSeconds = DEFAULT_PLAYABLE_SECONDS,
  playlistWaitMs = PLAYLIST_WAIT_MS,
  scheduler,
  processRegistry,
  onEvent = () => {},
}) {
  const sessions = new Map();
  const activeStates = new Map();
  let shuttingDown = false;
  let priorityOwnerJobId = null;
  let priorityTargetKey = null;
  let prioritySchedulerJobId = null;
  const ownsScheduler = !scheduler;
  const mediaScheduler = scheduler || createMediaTaskScheduler();
  const jobSchedulerIds = new Map();
  const targetSchedulerIds = new Map();
  const registry = processRegistry || createProcessRegistry();
  const validatedStarts = new Set();
  const emit = (event, data) => {
    try {
      onEvent(event, data);
    } catch {
      // Diagnostics must never affect media preparation.
    }
  };

  async function capture(executable, argumentsList) {
    const child = spawn(executable, argumentsList, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        finish(() => {
          const error = new Error("First-fragment validation timed out.");
          error.code = "WATCHPAIR_HLS_VALIDATION_TIMEOUT";
          child.kill("SIGKILL");
          reject(error);
        });
      }, FRAGMENT_VALIDATION_TIMEOUT_MS);
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => {
        finish(() => {
          if (code === 0) {
            resolve(stdout);
            return;
          }
          reject(pipelineError("first-fragment validation", code, stderr));
        });
      });
    });
  }

  async function validateFirstVideoFragment(directory) {
    if (!ffprobePath || validatedStarts.has(directory)) return;
    const initPath = path.join(directory, "video", "init.mp4");
    const segmentPath = path.join(directory, "video", "segment-000000.m4s");
    const validationDirectory = path.join(cacheRoot, ".validation");
    await mkdir(validationDirectory, { recursive: true });
    const temporaryPath = path.join(validationDirectory, randomUUID() + ".mp4");
    try {
      await writeFile(temporaryPath, Buffer.concat([
        await readFile(initPath),
        await readFile(segmentPath),
      ]));
      const result = JSON.parse(await capture(ffprobePath, [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,dts_time,flags",
        "-read_intervals", "%+#1",
        "-of", "json",
        temporaryPath,
      ]));
      const packet = result.packets?.[0];
      const pts = Number(packet?.pts_time);
      const dts = Number(packet?.dts_time);
      if (
        !packet ||
        !String(packet.flags || "").includes("K") ||
        !Number.isFinite(pts) ||
        !Number.isFinite(dts) ||
        pts < -0.01 ||
        pts > 0.25 ||
        dts < -0.25 ||
        dts > 0.05
      ) {
        const error = new Error(
          "The first browser-playback fragment is not a keyframe anchored at time zero."
        );
        error.code = "WATCHPAIR_INVALID_HLS_START";
        error.details = { pts, dts, flags: packet?.flags || null };
        throw error;
      }
      validatedStarts.add(directory);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

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

  function generationDirectory(directory, generationId) {
    return path.join(directory, "generations", generationId);
  }

  async function cacheIsComplete(directory, audioTracks) {
    if (!(await exists(path.join(directory, COMPLETE_MARKER)))) return false;
    if (!(await completePlaylist(path.join(directory, "video", "index.m3u8")))) return false;
    return Promise.all(
      audioTracks.map((track) =>
        completePlaylist(path.join(directory, "audio", trackDirectory(track), "index.m3u8"))
      )
    ).then((values) => values.every(Boolean));
  }

  async function generationState(directory, audioTracks) {
    const primaryAudioTrack = audioTracks.find((track) => track.default) || audioTracks[0] || null;
    const requiredAssets = [
      "master.m3u8",
      "video/init.mp4",
      "video/index.m3u8",
      ...(primaryAudioTrack
        ? [
            `audio/${trackDirectory(primaryAudioTrack)}/init.mp4`,
            `audio/${trackDirectory(primaryAudioTrack)}/index.m3u8`,
          ]
        : []),
    ];
    if (!(await Promise.all(requiredAssets.map((asset) => exists(path.join(directory, asset))))).every(Boolean)) {
      return {
        playable: false,
        complete: false,
        bufferedSeconds: 0,
        segmentCount: 0,
        invalidStart: null,
      };
    }

    const playablePlaylistPaths = [
      "video/index.m3u8",
      ...(primaryAudioTrack
        ? [`audio/${trackDirectory(primaryAudioTrack)}/index.m3u8`]
        : []),
    ];
    const playablePlaylists = await Promise.all(playablePlaylistPaths.map(async (relativePath) => ({
      relativePath,
      contents: await readFile(path.join(directory, relativePath), "utf8"),
    })));
    const playableWindows = await Promise.all(playablePlaylists.map(({ relativePath, contents }) =>
      playlistWindow(directory, relativePath, contents)
    ));
    const bufferedSeconds = Math.min(...playableWindows.map((window) => window.duration));
    const segmentCount = Math.min(...playableWindows.map((window) => window.segmentCount));
    let invalidStart = null;
    if (segmentCount > 0) {
      try {
        await validateFirstVideoFragment(directory);
      } catch (error) {
        invalidStart = {
          message: error instanceof Error ? error.message : String(error),
          details: error?.details || null,
        };
      }
    }
    let complete = false;
    if (await cacheIsComplete(directory, audioTracks)) {
      const completePlaylistPaths = [
        "video/index.m3u8",
        ...audioTracks.map((track) => `audio/${trackDirectory(track)}/index.m3u8`),
      ];
      const completeWindows = await Promise.all(completePlaylistPaths.map(async (relativePath) =>
        playlistWindow(
          directory,
          relativePath,
          await readFile(path.join(directory, relativePath), "utf8")
        )
      ));
      complete = !invalidStart && completeWindows.every((window) => window.complete);
    }
    return {
      playable: !invalidStart && (complete || bufferedSeconds >= playableSeconds),
      complete,
      bufferedSeconds: Math.round(bufferedSeconds * 1000) / 1000,
      segmentCount,
      invalidStart,
    };
  }

  async function pointedGeneration(directory, audioTracks, pointerName, requirePlayable) {
    try {
      const pointer = JSON.parse(await readFile(path.join(directory, pointerName), "utf8"));
      const generationId = String(pointer.generationId || "");
      if (!/^[a-f0-9-]{16,80}$/.test(generationId)) return null;
      const generationPath = generationDirectory(directory, generationId);
      if (!(await stat(generationPath)).isDirectory()) return null;
      const state = await generationState(generationPath, audioTracks);
      return !requirePlayable || state.playable
        ? { generationId, directory: generationPath, ...state }
        : null;
    } catch {
      return null;
    }
  }

  function activeGeneration(directory, audioTracks) {
    return pointedGeneration(directory, audioTracks, GENERATION_POINTER, true);
  }

  function workingGeneration(directory, audioTracks) {
    return pointedGeneration(directory, audioTracks, WORKING_POINTER, false);
  }

  async function persistGenerationPointer(directory, pointerName, generationId) {
    await mkdir(directory, { recursive: true });
    const pointer = path.join(directory, pointerName);
    const temporary = `${pointer}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ generationId }));
    try {
      await rename(temporary, pointer);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
      await rm(pointer, { force: true });
      await rename(temporary, pointer);
    }
  }

  function persistActiveGeneration(directory, generationId) {
    return persistGenerationPointer(directory, GENERATION_POINTER, generationId);
  }

  function persistWorkingGeneration(directory, generationId) {
    return persistGenerationPointer(directory, WORKING_POINTER, generationId);
  }

  async function clearWorkingGeneration(directory, generationId) {
    const pointer = path.join(directory, WORKING_POINTER);
    try {
      const contents = JSON.parse(await readFile(pointer, "utf8"));
      if (String(contents.generationId || "") !== generationId) return;
      await rm(pointer, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  async function cleanupInactiveGenerations(directory, keep = new Set()) {
    const root = path.join(directory, "generations");
    const entries = await readdir(root, { withFileTypes: true }).catch((error) =>
      error?.code === "ENOENT" ? [] : Promise.reject(error)
    );
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !keep.has(entry.name))
      .map((entry) => rm(path.join(root, entry.name), { recursive: true, force: true })));
  }

  function observeState(state, descriptor) {
    if (typeof descriptor.onState !== "function") return;
    state.observers.set(descriptor.jobId, descriptor.onState);
    try {
      descriptor.onState(preparationState(state), { event: "observed" });
    } catch {
      // A stale job observer must not affect preparation shared by another job.
    }
  }

  function notifyState(state, event, detail = {}) {
    const snapshot = preparationState(state);
    for (const observer of state.observers.values()) {
      try {
        observer(snapshot, { event, ...detail });
      } catch {
        // State reporting is best effort and must never interrupt FFmpeg.
      }
    }
  }

  async function promoteGeneration(state, reason) {
    if (state.servingGenerationId === state.generationId) {
      const rendered = await generationState(state.renderDirectory, state.audioTracks);
      state.bufferedSeconds = rendered.bufferedSeconds;
      state.complete = rendered.complete;
      state.status = "ready";
      notifyState(state, "generation-updated", { reason });
      return;
    }
    if (state.promotion) return state.promotion;
    state.promotion = (async () => {
      const rendered = await generationState(state.renderDirectory, state.audioTracks);
      if (!rendered.playable) {
        throw new Error(
          "The rendered HLS generation is not playable: " + JSON.stringify(rendered)
        );
      }
      await persistActiveGeneration(state.baseDirectory, state.generationId);
      state.servingGenerationId = state.generationId;
      state.servingDirectory = state.renderDirectory;
      state.bufferedSeconds = rendered.bufferedSeconds;
      state.complete = rendered.complete;
      state.status = "ready";
      emit("hls_generation_promoted", {
        jobId: state.jobId,
        schedulerJobId: state.schedulerJobId,
        generationId: state.generationId,
        reason,
        bufferedSeconds: rendered.bufferedSeconds,
        complete: rendered.complete,
      });
      notifyState(state, "generation-promoted", { reason });
    })().finally(() => {
      state.promotion = null;
    });
    return state.promotion;
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
    const baseDirectory = cacheDirectory(descriptor);
    const [active, working] = await Promise.all([
      activeGeneration(baseDirectory, descriptor.audioTracks),
      workingGeneration(baseDirectory, descriptor.audioTracks),
    ]);
    const resumable = active?.complete
      ? null
      : working && !working.invalidStart
        ? working
        : active && !active.invalidStart
          ? active
          : null;
    const keep = new Set([active?.generationId, resumable?.generationId].filter(Boolean));
    await cleanupInactiveGenerations(baseDirectory, keep);
    const generationId = active?.complete ? null : resumable?.generationId || randomUUID();
    let renderDirectory = generationId ? generationDirectory(baseDirectory, generationId) : null;
    const primaryAudioTrack = descriptor.audioTracks.find((track) => track.default)
      || descriptor.audioTracks[0]
      || null;
    const selectedEncoder = descriptor.rendition === "vp9"
      ? VP9_ENCODER
      : canCopyH264Video(descriptor)
        ? { id: "copy", label: "Direct stream copy", hardware: false }
        : encoder;
    const pipeline = selectedEncoder.id === "copy"
      ? null
      : videoPipeline(selectedEncoder, { disableFrameReordering: true });
    const state = {
      jobId: descriptor.jobId,
      schedulerJobId: descriptor.schedulerJobId,
      ownerJobIds: new Set([descriptor.jobId]),
      taskId: `hls:${descriptor.fileIndex}:${descriptor.rendition || "h264"}`,
      inputPath: descriptor.inputPath,
      baseDirectory,
      generationId,
      renderDirectory,
      servingGenerationId: active?.generationId || null,
      servingDirectory: active?.directory || null,
      audioTracks: descriptor.audioTracks,
      observers: new Map(),
      promotion: null,
      bufferedSeconds: active?.bufferedSeconds || 0,
      complete: Boolean(active?.complete),
      resumeSeconds: resumable?.bufferedSeconds || 0,
      resumeSegments: resumable?.segmentCount || 0,
      resumed: Boolean(resumable?.segmentCount),
      children: new Set(),
      errors: new Map(),
      done: null,
      playable: null,
      status: active?.playable ? "ready" : "preparing",
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

    if (active?.complete) {
      state.done = Promise.resolve();
      state.playable = Promise.resolve();
      return state;
    }

    if (selectedEncoder.hardware) {
      const pipelineValidation = await validateVideoPipeline(
        ffmpegPath,
        selectedEncoder,
        { path: descriptor.inputPath, codec: descriptor.videoCodec, pixelFormat: descriptor.videoPixelFormat },
        {
          threadLimit: descriptor.resourceProfile.threads,
          disableFrameReordering: true,
        }
      );
      state.pipeline = pipelineValidation.pipeline;
      state.hardwareDecode = Boolean(state.pipeline.hardwareDecode);
      if (!pipelineValidation.ok) state.pipelineDiagnostics.push(pipelineValidation.reason);
    }

    let videoDirectory;
    const initializeRenderDirectory = async (directory) => {
      videoDirectory = path.join(directory, "video");
      await mkdir(videoDirectory, { recursive: true });
      for (const track of descriptor.audioTracks) {
        await mkdir(path.join(directory, "audio", trackDirectory(track)), { recursive: true });
      }
      await writeFile(path.join(directory, "master.m3u8"), masterPlaylist(descriptor.audioTracks));
    };
    await initializeRenderDirectory(renderDirectory);
    await rm(path.join(renderDirectory, COMPLETE_MARKER), { force: true });
    await persistWorkingGeneration(baseDirectory, state.generationId);

    const baseArguments = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-filter_threads", String(state.resourceProfile.filterThreads),
    ];

    const clearPrimaryOutputs = async () => {
      if (state.servingGenerationId === state.generationId) {
        const replacedGenerationId = state.generationId;
        state.generationId = randomUUID();
        renderDirectory = generationDirectory(baseDirectory, state.generationId);
        state.renderDirectory = renderDirectory;
        state.complete = false;
        state.resumeSeconds = 0;
        state.resumeSegments = 0;
        state.resumed = false;
        await initializeRenderDirectory(renderDirectory);
        await rm(path.join(renderDirectory, COMPLETE_MARKER), { force: true });
        await persistWorkingGeneration(baseDirectory, state.generationId);
        emit("hls_generation_restarted", {
          jobId: state.jobId,
          schedulerJobId: state.schedulerJobId,
          generationId: state.generationId,
          replacingGenerationId: replacedGenerationId,
          reason: "pipeline-fallback",
        });
        void watchGenerationPlayable(renderDirectory, state.generationId);
        return;
      }
      await rm(videoDirectory, { recursive: true, force: true });
      await mkdir(videoDirectory, { recursive: true });
      validatedStarts.delete(renderDirectory);
      if (primaryAudioTrack) {
        const audioDirectory = path.join(renderDirectory, "audio", trackDirectory(primaryAudioTrack));
        await rm(audioDirectory, { recursive: true, force: true });
        await mkdir(audioDirectory, { recursive: true });
      }
      state.resumeSeconds = 0;
      state.resumeSegments = 0;
      state.resumed = false;
    };

    const launchPrimary = async () => {
      const primaryMarkerPath = () => path.join(renderDirectory, "primary-complete.json");
      const primaryOutputsComplete = await completePlaylist(
        path.join(renderDirectory, "video", "index.m3u8")
      ) && (!primaryAudioTrack || await completePlaylist(path.join(
        renderDirectory,
        "audio",
        trackDirectory(primaryAudioTrack),
        "index.m3u8"
      )));
      if (await exists(primaryMarkerPath()) && primaryOutputsComplete) return;
      await rm(primaryMarkerPath(), { force: true });
      let resumeSeconds = state.resumeSeconds;
      let append = state.resumeSegments > 0;
      const refreshCheckpoint = () => {
        resumeSeconds = state.resumeSeconds;
        append = state.resumeSegments > 0;
      };
      const videoArguments = () => state.encoder.id === "copy"
        ? ["-c:v", "copy"]
        : state.pipeline.arguments.encode;
      const primaryAudioArguments = () => primaryAudioTrack
        ? [
            "-map", `0:${primaryAudioTrack.streamIndex}`,
            "-vn", "-sn", "-dn",
            "-c:a", "aac",
            "-threads", "1",
            "-b:a", "192k",
            "-af", normalizedAudioFilter(),
            ...timelineOutputArguments(resumeSeconds),
            ...playlistArguments(segmentSeconds, {
              playlist: `audio/${trackDirectory(primaryAudioTrack)}/index.m3u8`,
              append,
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
          ...resumeInputArguments(resumeSeconds),
          "-fflags", "+genpts+discardcorrupt",
          ...(descriptor.inputArguments || []),
          "-i", descriptor.inputPath,
          "-map", "0:v:0",
          "-an", "-sn", "-dn",
          ...(state.pipeline
            ? [...normalizedVideoFilterArguments(state.pipeline.arguments.filter), ...state.pipeline.arguments.upload]
            : []),
          ...videoArguments(),
          ...renderEncoderArguments(state.encoder, state.resourceProfile),
          "-max_muxing_queue_size", "4096",
          ...timelineOutputArguments(resumeSeconds),
          ...playlistArguments(segmentSeconds, {
            playlist: "video/index.m3u8",
            segment: "video/segment-%06d.m4s",
            append,
          }),
          ...primaryAudioArguments(),
        ],
        renderDirectory,
        {
          stage: primaryAudioTrack ? "video+audio" : "video",
          trackId: primaryAudioTrack ? String(primaryAudioTrack.id) : null,
          encoder: state.encoder.label,
          decoder: state.pipeline?.decode.name || "stream copy",
          hardware: state.encoder.hardware,
        }
      );

      let recovered = false;
      try {
        await run();
      } catch (error) {
        if (state.stopping || state.encoder.id === "copy" || !state.encoder.hardware) throw error;
        if (state.hardwareDecode) {
          console.warn(`WatchPair ${state.encoder.label} hardware decoding failed for this file; retrying GPU encoding with CPU decoding.`);
          state.hardwareDecode = false;
          state.pipeline = videoPipeline(state.encoder, {
            hardwareDecode: false,
            disableFrameReordering: true,
          });
          state.pipelineDiagnostics.push({
            code: "runtime_hardware_decode_failed",
            stage: "decode/filter/upload",
            backend: state.encoder.id,
            message: `${state.encoder.label} failed on this source; retrying with software decode.`,
          });
          await clearPrimaryOutputs();
          refreshCheckpoint();
          try {
            await run();
            recovered = true;
          } catch (retryError) {
            if (state.stopping) throw retryError;
            // Fall through to a complete CPU fallback.
          }
        }
        if (recovered) {
          if (state.stopping) throw renderPreemptedError();
          await writeFile(primaryMarkerPath(), JSON.stringify({ completedAt: Date.now() }));
          return;
        }
        const failedEncoder = state.encoder;
        console.warn(`WatchPair ${state.encoder.label} encoding failed for this file; retrying with CPU encoding.`);
        state.encoder = CPU_ENCODER;
        state.hardwareDecode = false;
        state.pipeline = videoPipeline(CPU_ENCODER, { disableFrameReordering: true });
        state.pipelineDiagnostics.push({
          code: "runtime_hardware_encode_failed",
          stage: "encode",
          backend: failedEncoder.id,
          message: `${failedEncoder.label} failed on this source; using constrained CPU encoding.`,
        });
        state.fallback = true;
        await clearPrimaryOutputs();
        refreshCheckpoint();
        await run();
      }
      if (state.stopping) throw renderPreemptedError();
      await writeFile(primaryMarkerPath(), JSON.stringify({ completedAt: Date.now() }));
    };

    const launchAlternateAudio = async (track) => {
      const id = trackDirectory(track);
      const audioDirectory = path.join(renderDirectory, "audio", id);
      const markerPath = path.join(audioDirectory, "complete.json");
      if (
        await exists(markerPath) &&
        await completePlaylist(path.join(audioDirectory, "index.m3u8"))
      ) return;
      await rm(markerPath, { force: true });
      const checkpoint = await playlistCheckpoint(
        renderDirectory,
        "audio/" + id + "/index.m3u8"
      );
      await launch(
        state,
        `audio track ${track.label}`,
        [
          ...baseArguments,
          ...renderInputArguments(state.resourceProfile),
          ...resumeInputArguments(checkpoint.duration),
          "-fflags", "+genpts+discardcorrupt",
          ...(descriptor.inputArguments || []),
          "-i", descriptor.inputPath,
          "-map", `0:${track.streamIndex}`,
          "-vn", "-sn", "-dn",
          "-c:a", "aac",
          "-threads", "1",
          "-b:a", "192k",
          "-af", normalizedAudioFilter(),
          ...timelineOutputArguments(checkpoint.duration),
          ...playlistArguments(segmentSeconds, {
            append: checkpoint.segmentCount > 0,
          }),
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
      if (state.stopping) throw renderPreemptedError();
      await writeFile(markerPath, JSON.stringify({ completedAt: Date.now() }));
    };

    const backgroundAudioTracks = descriptor.audioTracks.filter((track) => track !== primaryAudioTrack);

    const playableAssets = [
      "video/init.mp4",
      ...(primaryAudioTrack ? [`audio/${trackDirectory(primaryAudioTrack)}/init.mp4`] : []),
    ];
    const playablePlaylists = [
      "video/index.m3u8",
      ...(primaryAudioTrack ? [`audio/${trackDirectory(primaryAudioTrack)}/index.m3u8`] : []),
    ];
    function watchGenerationPlayable(directory, generationId) {
      const requiredSeconds = Math.max(
        playableSeconds,
        state.bufferedSeconds + segmentSeconds
      );
      const waiting = Promise.all(
        playableAssets.map((asset) => waitForAsset(state, asset, directory))
      )
        .then(() => Promise.all(
          playablePlaylists.map((playlist) =>
            waitForPlaylistWindow(state, playlist, requiredSeconds, directory)
          )
        ))
        .then(() => {
          if (state.generationId !== generationId) return;
          return promoteGeneration(state, "playable-window");
        });
      void waiting.catch(() => {});
      return waiting;
    }
    const generationPlayable = watchGenerationPlayable(renderDirectory, state.generationId);

    state.playable = active?.playable ? Promise.resolve() : generationPlayable;
    emit("hls_generation_started", {
      jobId: state.jobId,
      schedulerJobId: state.schedulerJobId,
      generationId: state.generationId,
      resumed: state.resumed,
      resumeSeconds: state.resumeSeconds,
      resumeSegments: state.resumeSegments,
      replacingGenerationId: state.servingGenerationId,
      profile: `${state.resourceProfile.mode}:${state.resourceProfile.kind}`,
    });
    state.done = launchPrimary()
      .catch((error) => {
        state.errors.set("video", error);
        if (primaryAudioTrack) state.errors.set(`audio:${trackDirectory(primaryAudioTrack)}`, error);
        throw error;
      })
      .then(async () => {
        for (const track of backgroundAudioTracks) {
          if (state.stopping) throw renderPreemptedError();
          const id = trackDirectory(track);
          try {
            await launchAlternateAudio(track);
          } catch (error) {
            state.errors.set(`audio:${id}`, error);
            throw error;
          }
        }
      })
      .then(async () => {
        if (state.stopping) throw renderPreemptedError();
        await writeFile(
          path.join(renderDirectory, COMPLETE_MARKER),
          JSON.stringify({ completedAt: Date.now(), cacheVersion: CACHE_VERSION })
        );
        const rendered = await generationState(renderDirectory, descriptor.audioTracks);
        if (!rendered.complete) {
          await rm(path.join(renderDirectory, COMPLETE_MARKER), { force: true });
          throw new Error(rendered.invalidStart?.message || "FFmpeg exited without completing every HLS playlist.");
        }
        await promoteGeneration(state, "complete");
        await clearWorkingGeneration(baseDirectory, state.generationId);
        state.complete = true;
        await cleanupInactiveGenerations(
          baseDirectory,
          new Set([state.generationId])
        ).catch((error) => emit("hls_generation_cleanup_failed", {
          jobId: state.jobId,
          generationId: state.generationId,
          error,
        }));
        emit("hls_generation_completed", {
          jobId: state.jobId,
          schedulerJobId: state.schedulerJobId,
          generationId: state.generationId,
          bufferedSeconds: state.bufferedSeconds,
        });
        notifyState(state, "generation-completed");
      })
      .catch((error) => {
        if (state.stopping) {
          emit("hls_generation_preempted", {
            jobId: state.jobId,
            schedulerJobId: state.schedulerJobId,
            generationId: state.generationId,
            servingGenerationId: state.servingGenerationId,
          });
          if (state.servingDirectory) state.status = "ready";
          notifyState(state, "generation-preempted");
          return;
        }
        state.pipelineDiagnostics.push({
          code: "hls_generation_failed",
          stage: "browser-playback",
          backend: state.encoder.id,
          message: error instanceof Error ? error.message : String(error),
        });
        state.status = state.servingDirectory ? "ready" : "error";
        emit("hls_generation_failed", {
          jobId: state.jobId,
          schedulerJobId: state.schedulerJobId,
          generationId: state.generationId,
          servingGenerationId: state.servingGenerationId,
          error: error instanceof Error ? error.message : String(error),
        });
        notifyState(state, "generation-failed");
        console.error(`WatchPair ${error.message}`);
        if (!state.servingDirectory) throw error;
      });
    void state.done.catch(() => {});
    return state;
  }

  async function ensure(descriptor) {
    const key = cacheKey(descriptor);
    const schedulingId = schedulerJobId(descriptor);
    let schedulingIds = jobSchedulerIds.get(descriptor.jobId);
    if (!schedulingIds) jobSchedulerIds.set(descriptor.jobId, schedulingIds = new Set());
    schedulingIds.add(schedulingId);
    const targetKey = `${descriptor.jobId}:${descriptor.fileIndex}`;
    targetSchedulerIds.set(targetKey, schedulingId);
    if (
      prioritySchedulerJobId === schedulingId ||
      priorityTargetKey === targetKey ||
      (!priorityTargetKey && priorityOwnerJobId === descriptor.jobId)
    ) mediaScheduler.prioritize(schedulingId);
    let pending = sessions.get(key);
    if (!pending) {
      pending = mediaScheduler.enqueue({
        taskId: `hls:${descriptor.fileIndex}:${descriptor.rendition || "h264"}`,
        jobId: schedulingId,
        restartOnPromotion: true,
        stage: "browser-playback",
        priority: 50,
        preemptible: true,
        run: async (resourceProfile) => {
          const state = await initialize({
            ...descriptor,
            schedulerJobId: schedulingId,
            resourceProfile,
          });
          activeStates.set(key, state);
          return {
            value: state,
            completion: state.done,
            interrupt: () => {
              if (state.stopping) return;
              state.preempted = true;
              state.stopping = true;
              notifyState(state, "generation-preempting");
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
    observeState(state, descriptor);
    return state;
  }

  async function invalidatePreempted(descriptor, state) {
    const key = cacheKey(descriptor);
    const pending = sessions.get(key);
    if (pending && await pending.catch(() => null) === state) {
      sessions.delete(key);
      activeStates.delete(key);
      return true;
    }
    return false;
  }

  function assetErrorKey(relativePath) {
    if (relativePath.startsWith("video/")) return "video";
    const match = /^audio\/(\d+)\//.exec(relativePath);
    return match ? `audio:${match[1]}` : null;
  }

  async function waitForAsset(state, relativePath, directory = state.renderDirectory) {
    if (!directory) throw new Error("No playable HLS generation is available.");
    const target = path.resolve(directory, relativePath);
    if (target !== directory && !target.startsWith(directory + path.sep)) {
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

  async function waitForPlaylistWindow(state, relativePath, requiredSeconds, directory) {
    const filePath = await waitForAsset(state, relativePath, directory);
    const started = Date.now();
    while (true) {
      if (state.cancelled) throw new Error("Render was cancelled.");
      if (state.preempted) throw renderPreemptedError();
      const playlist = await readFile(filePath, "utf8").catch(() => "");
      const window = await playlistWindow(directory, relativePath, playlist);
      if (window.duration >= requiredSeconds || window.complete) return filePath;

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
        await state.playable;
        const servingDirectory = state.servingDirectory;
        if (!servingDirectory) throw new Error("No playable HLS generation is available.");
        const filePath = await waitForAsset(state, relativePath, servingDirectory);
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
      bufferedSeconds: state.bufferedSeconds,
      complete: state.complete,
      generationId: state.servingGenerationId,
      resumed: state.resumed,
      resumeSeconds: state.resumeSeconds,
      resumeSegments: state.resumeSegments,
      rendering: Boolean(state.renderDirectory && !state.complete && !state.stopping),
      resourceProfile: state.resourceProfile.kind,
      pipeline: state.pipeline,
      diagnostics: state.pipelineDiagnostics,
    };
  }

  async function removeJob(jobId) {
    const schedulingIds = jobSchedulerIds.get(jobId) || new Set();
    jobSchedulerIds.delete(jobId);
    for (const key of targetSchedulerIds.keys()) {
      if (key.startsWith(`${jobId}:`)) targetSchedulerIds.delete(key);
    }
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
        void pending.then((state) => {
          state.ownerJobIds.delete(jobId);
          state.observers.delete(jobId);
        }).catch(() => {});
        continue;
      }
      sessions.delete(key);
      activeStates.delete(key);
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
    priorityTargetKey = null;
    prioritySchedulerJobId = null;
    const schedulingId = jobId ? jobSchedulerIds.get(jobId)?.values().next().value : null;
    mediaScheduler.prioritize(schedulingId || jobId || null);
  }

  function setPriorityTarget(jobId, fileIndex, schedulingId = null) {
    priorityOwnerJobId = jobId || null;
    priorityTargetKey = jobId && Number.isInteger(fileIndex)
      ? `${jobId}:${fileIndex}`
      : null;
    prioritySchedulerJobId = schedulingId || (
      priorityTargetKey ? targetSchedulerIds.get(priorityTargetKey) : null
    ) || null;
    mediaScheduler.prioritize(prioritySchedulerJobId || null);
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
    activeStates.clear();
  }

  return {
    getAsset,
    getPreparation,
    prepare,
    removeJob,
    setPriorityJob,
    setPriorityTarget,
    shutdown,
    diagnostics: () => ({
      scheduler: mediaScheduler.snapshot(),
      processes: registry.snapshot(),
      generations: Array.from(activeStates.values()).map((state) => ({
        jobId: state.jobId,
        schedulerJobId: state.schedulerJobId,
        status: state.status,
        generationId: state.generationId,
        servingGenerationId: state.servingGenerationId,
        bufferedSeconds: state.bufferedSeconds,
        complete: state.complete,
        preempted: state.preempted,
        childProcesses: state.children.size,
        resumed: state.resumed,
        resumeSeconds: state.resumeSeconds,
        resumeSegments: state.resumeSegments,
        resourceProfile: `${state.resourceProfile.mode}:${state.resourceProfile.kind}`,
      })),
    }),
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
