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
import { mediaDurationFromProbe } from "./media-chapters.mjs";

const CACHE_VERSION = "hls-v12";
const DEFAULT_SEGMENT_SECONDS = 4;
const DEFAULT_PLAYABLE_SECONDS = 120;
const DEFAULT_EPOCH_SECONDS = 30;
const FRAGMENT_VALIDATION_TIMEOUT_MS = 15_000;
const PLAYABLE_WINDOW_TOLERANCE_SECONDS = 0.25;
const VIDEO_END_TOLERANCE_SECONDS = 0.025;
const GENERATION_POINTER = "current.json";
const WORKING_POINTER = "working.json";
const MANIFEST_FILE = "manifest.json";
const WRITER_FILE = "writer.json";
const COMPLETE_MARKER = "complete.json";
const COPYABLE_H264_PROFILES = new Set([
  "baseline",
  "constrained baseline",
  "main",
  "high",
]);

function rounded(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function timelineRounded(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function createDeferred() {
  let resolve;
  let reject;
  let settled = false;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  void promise.catch(() => {});
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

async function exists(filePath) {
  try {
    return (await stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
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

function sourceAudioTracks(descriptor) {
  return Array.isArray(descriptor.audioTracks) ? descriptor.audioTracks : [];
}

function primaryAudioTrack(audioTracks) {
  return audioTracks.find((track) => track.default) || audioTracks[0] || null;
}

function mediaPlaylistSegments(playlist) {
  const map = /^#EXT-X-MAP:URI="([^"]+)"$/m.exec(playlist)?.[1] || null;
  const segments = [];
  let duration = null;
  for (const rawLine of String(playlist || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const durationMatch = /^#EXTINF:([\d.]+)/.exec(line);
    if (durationMatch) {
      duration = Number(durationMatch[1]);
      continue;
    }
    if (duration === null || !line || line.startsWith("#")) continue;
    segments.push({ duration, uri: line });
    duration = null;
  }
  return {
    map,
    segments,
    complete: String(playlist || "").includes("#EXT-X-ENDLIST"),
    duration: segments.reduce((total, segment) => total + segment.duration, 0),
  };
}

async function readEpochPlaylist(directory, relativePath) {
  const playlistPath = path.join(directory, relativePath);
  const playlist = mediaPlaylistSegments(await readFile(playlistPath, "utf8"));
  if (!playlist.complete || !playlist.map || !playlist.segments.length) {
    throw new Error("FFmpeg did not finish an epoch playlist.");
  }
  const playlistDirectory = path.dirname(playlistPath);
  const names = [playlist.map, ...playlist.segments.map((segment) => segment.uri)];
  for (const name of names) {
    const cleanName = name.split(/[?#]/, 1)[0];
    const target = path.resolve(playlistDirectory, cleanName);
    if (
      path.basename(cleanName) !== cleanName ||
      (target !== playlistDirectory && !target.startsWith(playlistDirectory + path.sep)) ||
      !(await exists(target))
    ) {
      throw new Error("FFmpeg produced an invalid epoch asset reference.");
    }
  }
  return playlist;
}

function masterPlaylist(audioTracks) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  const defaultTrack = primaryAudioTrack(audioTracks);
  for (const track of audioTracks) {
    const id = trackDirectory(track);
    const language = quoted(track.language === "und" ? "" : track.language);
    const languageAttribute = language ? ',LANGUAGE="' + language + '"' : "";
    lines.push(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="watchpair-audio",NAME="' +
      quoted(track.label) + '",DEFAULT=' + (track === defaultTrack ? "YES" : "NO") +
      ",AUTOSELECT=YES" + languageAttribute + ',URI="audio/' + id + '/index.m3u8"'
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
    "-hls_playlist_type", "vod",
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

function normalizedVideoFilterArguments(argumentsList) {
  const result = [...argumentsList];
  const filterIndex = result.indexOf("-vf");
  if (filterIndex >= 0 && result[filterIndex + 1]) {
    result[filterIndex + 1] += ",setpts=PTS-STARTPTS";
  } else {
    result.push("-vf", "setpts=PTS-STARTPTS");
  }
  return result;
}

function normalizedAudioFilter() {
  return "aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS";
}

export function isPrivatePathCandidate(value) {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate || /^[a-zA-Z]:$/.test(candidate)) return false;
  const segments = candidate.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!segments.length || segments.every((segment) => [".", ".."].includes(segment))) {
    return false;
  }
  return ![path.posix, path.win32].some((implementation) => {
    const normalized = implementation.normalize(candidate);
    const root = implementation.parse(normalized).root;
    return root &&
      normalized.toLowerCase() === implementation.normalize(root).toLowerCase();
  });
}

function redactPrivatePaths(value, privatePaths = []) {
  let redacted = String(value || "");
  const variants = new Set();
  for (const privatePath of privatePaths) {
    const exact = String(privatePath || "").trim();
    if (!isPrivatePathCandidate(exact)) continue;
    variants.add(exact);
    variants.add(exact.replaceAll("\\", "/"));
    variants.add(exact.replaceAll("/", "\\"));
  }
  for (const privatePath of [...variants].sort((left, right) => right.length - left.length)) {
    const escaped = privatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(escaped, "gi"), () => "[private path]");
  }
  return redacted;
}

function sanitizePublicValue(value, privatePaths, seen = new WeakMap()) {
  if (typeof value === "string") return redactPrivatePaths(value, privatePaths);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Error) return sanitizePublicError(value, privatePaths, seen);

  const sanitized = Array.isArray(value) ? [] : {};
  seen.set(value, sanitized);
  for (const [key, nested] of Object.entries(value)) {
    sanitized[key] = sanitizePublicValue(nested, privatePaths, seen);
  }
  return sanitized;
}

function sanitizePublicError(error, privatePaths, seen = new WeakMap()) {
  const source = error instanceof Error ? error : new Error(String(error));
  if (seen.has(source)) return seen.get(source);
  const sanitized = new Error(redactPrivatePaths(source.message, privatePaths));
  sanitized.name = redactPrivatePaths(source.name || "Error", privatePaths);
  sanitized.stack = redactPrivatePaths(
    source.stack || sanitized.name + ": " + sanitized.message,
    privatePaths
  );
  seen.set(source, sanitized);
  for (const [key, value] of Object.entries(source)) {
    if (["message", "name", "stack"].includes(key)) continue;
    sanitized[key] = sanitizePublicValue(value, privatePaths, seen);
  }
  return sanitized;
}

function pipelineError(label, code, stderr, privatePaths = []) {
  const detail = redactPrivatePaths(stderr, privatePaths)
    .trim()
    .split("\n")
    .slice(-4)
    .join(" ")
    .slice(0, 700);
  const error = new Error(
    label + " preparation failed" +
    (code === null ? "" : " with code " + code) +
    (detail ? ": " + detail : ".")
  );
  error.code = "WATCHPAIR_HLS_PIPELINE_FAILED";
  if (code !== null) error.exitCode = code;
  return error;
}

function stoppedError(message = "Browser playback preparation stopped.") {
  const error = new Error(message);
  error.code = "WATCHPAIR_HLS_STOPPED";
  return error;
}

async function atomicWrite(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + "." + process.pid + "." + randomUUID() + ".tmp";
  await writeFile(temporary, contents);
  try {
    await rename(temporary, filePath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await rm(filePath, { force: true });
    await rename(temporary, filePath);
  }
}

function atomicWriteJson(filePath, value) {
  return atomicWrite(filePath, JSON.stringify(value));
}

function validContentFingerprint(descriptor) {
  const value = String(descriptor.contentFingerprint || "").toLowerCase();
  return /^[a-f0-9]{16,128}$/.test(value) ? value : null;
}

function descriptorSchedulerJobId(descriptor) {
  const fingerprint = validContentFingerprint(descriptor);
  return fingerprint
    ? "content-" + fingerprint + "-" + descriptor.fileSize
    : "job-" + descriptor.jobId + "-" + descriptor.fileIndex + "-" + descriptor.fileSize;
}

function descriptorCacheKey(descriptor) {
  return [
    descriptorSchedulerJobId(descriptor),
    descriptor.fileSize,
    descriptor.rendition || "h264",
    CACHE_VERSION,
  ].join(":");
}

function descriptorCacheDirectory(cacheRoot, descriptor) {
  const fingerprint = validContentFingerprint(descriptor);
  if (fingerprint) {
    return path.join(
      cacheRoot,
      "content",
      fingerprint + "-" + descriptor.fileSize,
      (descriptor.rendition || "h264") + "-" + CACHE_VERSION
    );
  }
  return path.join(
    cacheRoot,
    "jobs",
    descriptor.jobId,
    descriptor.fileIndex + "-" + descriptor.fileSize + "-" +
      (descriptor.rendition || "h264") + "-" + CACHE_VERSION
  );
}

function generationDirectory(baseDirectory, generationId) {
  return path.join(baseDirectory, "generations", generationId);
}

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

function streamForEpoch(epoch, kind, trackId = null) {
  return kind === "video"
    ? epoch.streams?.video
    : epoch.streams?.audio?.[String(trackId)];
}

function publicMediaPlaylist(manifest, kind, trackId = null) {
  const streams = manifest.epochs
    .map((epoch) => ({ epoch, stream: streamForEpoch(epoch, kind, trackId) }))
    .filter(({ stream }) => stream?.segments?.length);
  const maximumSegment = streams.flatMap(({ stream }) =>
    stream.segments.map((segment) => Number(segment.duration) || 0)
  ).reduce((maximum, duration) => Math.max(maximum, duration), 1);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:" + Math.max(1, Math.ceil(maximumSegment)),
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
  ];
  if (kind === "video") lines.push("#EXT-X-INDEPENDENT-SEGMENTS");
  streams.forEach(({ stream }, index) => {
    if (index > 0) lines.push("#EXT-X-DISCONTINUITY");
    lines.push('#EXT-X-MAP:URI="' + stream.init + '"');
    for (const segment of stream.segments) {
      lines.push("#EXTINF:" + Number(segment.duration).toFixed(6) + ",");
      lines.push(segment.uri);
    }
  });
  if (manifest.complete) lines.push("#EXT-X-ENDLIST");
  lines.push("");
  return lines.join("\n");
}

function streamPresentationDuration(stream) {
  const recorded = Number(stream?.presentationDuration);
  if (Number.isFinite(recorded) && recorded > 0) return recorded;
  return Array.isArray(stream?.segments)
    ? stream.segments.reduce((total, segment) => total + Number(segment.duration || 0), 0)
    : 0;
}

export function manifestPreparedSeconds(manifest) {
  const last = manifest.epochs.at(-1);
  return last
    ? timelineRounded(
        Number(last.sourceStart) + streamPresentationDuration(streamForEpoch(last, "video"))
      )
    : 0;
}

export function hlsTerminalDurationTolerance(segmentSeconds = DEFAULT_SEGMENT_SECONDS) {
  const supplied = Number(segmentSeconds);
  const duration = Number.isFinite(supplied) && supplied > 0
    ? supplied
    : DEFAULT_SEGMENT_SECONDS;
  return Math.max(0.25, duration * 0.1);
}

export function isWithinHlsTerminalDuration(
  sourceDuration,
  presentationDuration,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS
) {
  const source = Number(sourceDuration);
  const presentation = Number(presentationDuration);
  return Number.isFinite(source) && source > 0 && Number.isFinite(presentation) &&
    Math.abs(presentation - source) <= hlsTerminalDurationTolerance(segmentSeconds);
}

function expectedAudioIds(audioTracks) {
  return audioTracks.map((track) => trackDirectory(track)).sort();
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validGenerationId(value) {
  return /^[a-f0-9-]{16,80}$/.test(String(value || ""));
}

async function readPointer(baseDirectory, pointerName) {
  try {
    const value = JSON.parse(await readFile(path.join(baseDirectory, pointerName), "utf8"));
    return validGenerationId(value.generationId) ? String(value.generationId) : null;
  } catch {
    return null;
  }
}

async function persistPointer(baseDirectory, pointerName, generationId) {
  await atomicWriteJson(path.join(baseDirectory, pointerName), { generationId });
}

async function clearPointer(baseDirectory, pointerName, generationId) {
  const pointerPath = path.join(baseDirectory, pointerName);
  try {
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    if (String(pointer.generationId || "") === generationId) {
      await rm(pointerPath, { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

async function referencedAssetExists(generationPath, relativePath) {
  if (
    typeof relativePath !== "string" ||
    path.basename(relativePath) !== relativePath ||
    !/^(?:epoch-\d{6}-init\.mp4|epoch-\d{6}-segment-\d{6}\.m4s)$/.test(relativePath)
  ) return false;
  return exists(path.join(generationPath, relativePath));
}

async function validateManifestAssets(
  generationPath,
  manifest,
  descriptor,
  epochSeconds,
  segmentSeconds
) {
  if (
    manifest?.cacheVersion !== CACHE_VERSION ||
    !validGenerationId(manifest.generationId) ||
    Number(manifest.fileSize) !== Number(descriptor.fileSize) ||
    manifest.contentFingerprint !== validContentFingerprint(descriptor) ||
    String(manifest.rendition || "") !== String(descriptor.rendition || "h264") ||
    !Number.isFinite(Number(manifest.epochSeconds)) ||
    Math.abs(Number(manifest.epochSeconds) - epochSeconds) > 0.001 ||
    !Number.isFinite(Number(manifest.segmentSeconds)) ||
    Math.abs(Number(manifest.segmentSeconds) - segmentSeconds) > 0.001 ||
    !Number.isFinite(Number(manifest.sourceDuration)) ||
    Number(manifest.sourceDuration) <= 0 ||
    !Array.isArray(manifest.epochs)
  ) return false;

  const descriptorIds = expectedAudioIds(sourceAudioTracks(descriptor));
  const manifestIds = Array.isArray(manifest.audioTrackIds)
    ? manifest.audioTrackIds.map(String).sort()
    : [];
  if (!sameStringArray(descriptorIds, manifestIds)) return false;

  let expectedSourceStart = 0;
  for (const [index, epoch] of manifest.epochs.entries()) {
    if (
      Number(epoch.index) !== index ||
      !Number.isFinite(Number(epoch.sourceStart)) ||
      Math.abs(Number(epoch.sourceStart) - expectedSourceStart) > 0.001 ||
      !Number.isFinite(Number(epoch.sourceDuration)) ||
      Number(epoch.sourceDuration) <= 0 ||
      Number(epoch.sourceDuration) > epochSeconds + 0.001 ||
      epoch.validatedStart !== true
    ) return false;
    const requiredStreams = [
      {
        stream: streamForEpoch(epoch, "video"),
        directory: path.join(generationPath, "video"),
      },
      ...descriptorIds.map((id) => ({
        stream: streamForEpoch(epoch, "audio", id),
        directory: path.join(generationPath, "audio", id),
      })),
    ];
    for (const { stream, directory } of requiredStreams) {
      if (
        !stream ||
        !(await referencedAssetExists(directory, stream.init)) ||
        !Array.isArray(stream.segments) ||
        !stream.segments.length ||
        !Number.isFinite(Number(stream.presentationDuration)) ||
        Number(stream.presentationDuration) <= 0
      ) return false;
      let segmentDuration = 0;
      for (const segment of stream.segments) {
        if (
          !Number.isFinite(Number(segment.duration)) ||
          Number(segment.duration) <= 0 ||
          !(await referencedAssetExists(directory, segment.uri))
        ) return false;
        segmentDuration += Number(segment.duration);
      }
      if (Math.abs(Number(stream.presentationDuration) - segmentDuration) > 0.001) {
        return false;
      }
    }
    expectedSourceStart = timelineRounded(
      Number(epoch.sourceStart) +
      streamPresentationDuration(streamForEpoch(epoch, "video"))
    );
  }

  const prepared = manifestPreparedSeconds(manifest);
  const terminalDurationTolerance = hlsTerminalDurationTolerance(segmentSeconds);
  if (prepared > Number(manifest.sourceDuration) + terminalDurationTolerance) return false;
  if (
    manifest.complete &&
    !isWithinHlsTerminalDuration(manifest.sourceDuration, prepared, segmentSeconds)
  ) return false;
  return true;
}

async function publishGeneration(generationPath, manifest, audioTracks) {
  await mkdir(path.join(generationPath, "video"), { recursive: true });
  await atomicWrite(
    path.join(generationPath, "master.m3u8"),
    masterPlaylist(audioTracks)
  );
  await atomicWrite(
    path.join(generationPath, "video", "index.m3u8"),
    publicMediaPlaylist(manifest, "video")
  );
  for (const track of audioTracks) {
    const id = trackDirectory(track);
    const audioDirectory = path.join(generationPath, "audio", id);
    await mkdir(audioDirectory, { recursive: true });
    await atomicWrite(
      path.join(audioDirectory, "index.m3u8"),
      publicMediaPlaylist(manifest, "audio", id)
    );
  }
}

async function cleanupInactiveGenerations(baseDirectory, keep) {
  const root = path.join(baseDirectory, "generations");
  const entries = await readdir(root, { withFileTypes: true }).catch((error) =>
    error?.code === "ENOENT" ? [] : Promise.reject(error)
  );
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !keep.has(entry.name))
      .map((entry) => rm(path.join(root, entry.name), { recursive: true, force: true }))
  );
}

export function createHlsPlaybackManager({
  ffmpegPath,
  ffprobePath = null,
  cacheRoot,
  encoder = CPU_ENCODER,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  playableSeconds = DEFAULT_PLAYABLE_SECONDS,
  epochSeconds = DEFAULT_EPOCH_SECONDS,
  playlistWaitMs = 15 * 60_000,
  scheduler,
  processRegistry,
  onEvent = () => {},
}) {
  const sessions = new Map();
  const activeStates = new Map();
  const jobSchedulerIds = new Map();
  const targetSchedulerIds = new Map();
  const ownsScheduler = !scheduler;
  const mediaScheduler = scheduler || createMediaTaskScheduler({ onEvent });
  const registry = processRegistry || createProcessRegistry({ onEvent });
  const privateToolPaths = [ffmpegPath, ffprobePath].filter(
    (candidate) =>
      typeof candidate === "string" &&
      path.isAbsolute(candidate) &&
      isPrivatePathCandidate(candidate)
  );
  let shuttingDown = false;
  let priorityOwnerJobId = null;
  let priorityTargetKey = null;
  let prioritySchedulerJobId = null;

  const epochLength = Math.max(segmentSeconds, Number(epochSeconds) || DEFAULT_EPOCH_SECONDS);
  const playableWindow = Math.max(segmentSeconds, Number(playableSeconds) || DEFAULT_PLAYABLE_SECONDS);
  const playableThreshold = Math.max(
    segmentSeconds,
    playableWindow - PLAYABLE_WINDOW_TOLERANCE_SECONDS
  );

  const emit = (event, data) => {
    try {
      onEvent(event, data);
    } catch {
      // Diagnostics must not affect preparation.
    }
  };

  function statePrivatePaths(state, extraPaths = []) {
    return [
      state?.inputPath,
      state?.baseDirectory,
      state?.generationPath,
      state?.servingDirectory,
      state?.currentWorkingDirectory,
      cacheRoot,
      process.cwd(),
      ...privateToolPaths,
      ...extraPaths,
    ];
  }

  function publicStateValue(state, value, extraPaths = []) {
    return sanitizePublicValue(value, statePrivatePaths(state, extraPaths));
  }

  function publicStateError(state, error, extraPaths = []) {
    return sanitizePublicError(error, statePrivatePaths(state, extraPaths));
  }

  function capture(executable, argumentsList, {
    state = null,
    taskContext = null,
    label = "media validation",
    timeoutMs = FRAGMENT_VALIDATION_TIMEOUT_MS,
    privatePaths = [],
  } = {}) {
    const child = spawn(executable, argumentsList, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    state?.children.add(child);
    if (state?.resourceProfile) applyMediaProcessPriority(child, state.resourceProfile);
    const tracker = registry.track(child, {
      jobId: state?.jobId || "hls-validation",
      taskId: state?.taskId || "hls-validation",
      stage: label,
      command: executable,
      arguments: argumentsList,
      privatePaths: [state?.inputPath, ...privateToolPaths].filter(Boolean),
    });
    taskContext?.registerInterrupt?.(() => child.kill("SIGTERM"));
    if (taskContext?.signal?.aborted || shuttingDown) child.kill("SIGTERM");

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => {
      stdout = (stdout + value.toString()).slice(-2_000_000);
    });
    child.stderr.on("data", (value) => {
      stderr = (stderr + value.toString()).slice(-16_384);
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state?.children.delete(child);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(stoppedError(label + " timed out.")));
      }, timeoutMs);
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => finish(() => {
        if (taskContext?.signal?.aborted) {
          reject(taskContext.signal.reason || stoppedError());
        } else if (code === 0) {
          resolve(stdout);
        } else {
          reject(pipelineError(label, code, stderr, [
            state?.inputPath,
            state?.generationPath,
            ...privateToolPaths,
            ...privatePaths,
          ]));
        }
      }));
      tracker.setDetail?.({ validation: true });
    });
  }

  async function sourceDuration(descriptor) {
    const supplied = Number(descriptor.sourceDuration);
    if (Number.isFinite(supplied) && supplied > 0) return supplied;
    if (!ffprobePath) {
      throw new Error("The source duration is required for browser playback preparation.");
    }
    const output = await capture(ffprobePath, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_type,duration,start_time:format=duration,start_time",
      "-of", "json",
      descriptor.inputPath,
    ], {
      label: "source-duration probe",
      privatePaths: [descriptor.inputPath],
    });
    const duration = mediaDurationFromProbe(JSON.parse(output));
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Could not determine the source video duration.");
    }
    return duration;
  }

  async function validateFirstVideoFragment(state, videoDirectory, taskContext) {
    if (!ffprobePath) return;
    const initPath = path.join(videoDirectory, "init.mp4");
    const segmentPath = path.join(videoDirectory, "segment-000000.m4s");
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
      ], {
        state,
        taskContext,
        label: "epoch-start validation",
        privatePaths: [temporaryPath, videoDirectory],
      }));
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
          "A browser-playback epoch does not begin with a keyframe at time zero."
        );
        error.code = "WATCHPAIR_INVALID_HLS_EPOCH_START";
        error.details = { pts, dts, flags: packet?.flags || null };
        throw error;
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  function preparationState(state) {
    const publicError = state.error ? publicStateError(state, state.error) : null;
    return {
      status: state.status,
      error: publicError?.message || null,
      encoder: {
        id: state.encoder.id,
        label: state.encoder.label,
        hardware: Boolean(state.encoder.hardware),
      },
      hardwareDecode: Boolean(state.hardwareDecode),
      fallback: state.fallback,
      bufferedSeconds: state.contiguousReadySeconds,
      contiguousReadySeconds: state.contiguousReadySeconds,
      sourceDuration: state.sourceDuration,
      committedEpochs: state.manifest.epochs.length,
      epochSeconds: epochLength,
      complete: state.complete,
      generationId: state.servingGenerationId,
      resumed: state.resumed,
      resumeSeconds: state.resumeSeconds,
      resumeSegments: state.manifest.epochs.reduce(
        (total, epoch) => total + (epoch.streams?.video?.segments?.length || 0),
        0
      ),
      rendering: Boolean(state.rendering && !state.complete && !state.stopping),
      resourceProfile: state.resourceProfile?.kind || "background",
      pipeline: state.pipeline,
      diagnostics: publicStateValue(state, state.pipelineDiagnostics),
    };
  }

  function observeState(state, descriptor) {
    if (typeof descriptor.onState !== "function") return;
    state.observers.set(descriptor.jobId, descriptor.onState);
    try {
      descriptor.onState(preparationState(state), { event: "observed" });
    } catch {
      // A stale observer must not affect shared preparation.
    }
  }

  function notifyState(state, event, detail = {}) {
    const snapshot = preparationState(state);
    for (const observer of state.observers.values()) {
      try {
        observer(snapshot, { event, ...detail });
      } catch {
        // State reporting is best effort.
      }
    }
  }

  async function readGeneration(baseDirectory, generationId, descriptor) {
    if (!validGenerationId(generationId)) return null;
    const generationPath = generationDirectory(baseDirectory, generationId);
    if (!(await directoryExists(generationPath))) return null;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(generationPath, MANIFEST_FILE), "utf8")
      );
      if (
        manifest.generationId !== generationId ||
        !(await validateManifestAssets(
          generationPath,
          manifest,
          descriptor,
          epochLength,
          segmentSeconds
        ))
      ) return null;
      await publishGeneration(generationPath, manifest, sourceAudioTracks(descriptor));
      if (manifest.complete && !(await exists(path.join(generationPath, COMPLETE_MARKER)))) {
        await atomicWriteJson(path.join(generationPath, COMPLETE_MARKER), {
          completedAt: Date.now(),
          cacheVersion: CACHE_VERSION,
          recovered: true,
        });
      }
      return { generationId, generationPath, manifest };
    } catch {
      return null;
    }
  }

  async function recoverWriterLease(generationPath, descriptor, manifest) {
    const writerPath = path.join(generationPath, WRITER_FILE);
    if (!(await exists(writerPath))) return false;
    let lease = null;
    try {
      lease = JSON.parse(await readFile(writerPath, "utf8"));
    } catch {
      // An unreadable lease is stale too.
    }
    await rm(path.join(generationPath, ".working"), { recursive: true, force: true });
    await rm(writerPath, { force: true });
    emit("hls_stale_writer_recovered", {
      jobId: descriptor.jobId,
      generationId: manifest.generationId,
      epochIndex: Number.isInteger(lease?.epochIndex) ? lease.epochIndex : null,
      writerPid: Number.isInteger(lease?.pid) ? lease.pid : null,
      committedEpochs: manifest.epochs.length,
    });
    return true;
  }

  async function createGeneration(baseDirectory, descriptor, duration) {
    const generationId = randomUUID();
    const generationPath = generationDirectory(baseDirectory, generationId);
    const manifest = {
      cacheVersion: CACHE_VERSION,
      generationId,
      fileSize: Number(descriptor.fileSize),
      contentFingerprint: validContentFingerprint(descriptor),
      rendition: descriptor.rendition || "h264",
      sourceDuration: rounded(duration),
      epochSeconds: epochLength,
      segmentSeconds,
      audioTrackIds: expectedAudioIds(sourceAudioTracks(descriptor)),
      epochs: [],
      complete: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await mkdir(path.join(generationPath, "video"), { recursive: true });
    for (const track of sourceAudioTracks(descriptor)) {
      await mkdir(path.join(generationPath, "audio", trackDirectory(track)), {
        recursive: true,
      });
    }
    await atomicWriteJson(path.join(generationPath, MANIFEST_FILE), manifest);
    await publishGeneration(generationPath, manifest, sourceAudioTracks(descriptor));
    await persistPointer(baseDirectory, WORKING_POINTER, generationId);
    return { generationId, generationPath, manifest };
  }

  async function initializeState(descriptor, schedulingId) {
    const baseDirectory = descriptorCacheDirectory(cacheRoot, descriptor);
    await mkdir(path.join(baseDirectory, "generations"), { recursive: true });
    const duration = await sourceDuration(descriptor);
    const [activeId, workingId] = await Promise.all([
      readPointer(baseDirectory, GENERATION_POINTER),
      readPointer(baseDirectory, WORKING_POINTER),
    ]);

    let active = await readGeneration(baseDirectory, activeId, descriptor);
    let working = workingId === activeId
      ? active
      : await readGeneration(baseDirectory, workingId, descriptor);
    if (active && Math.abs(Number(active.manifest.sourceDuration) - duration) > 0.25) {
      active = null;
    }
    if (working && Math.abs(Number(working.manifest.sourceDuration) - duration) > 0.25) {
      working = null;
    }

    let selected;
    if (active?.manifest.complete) {
      selected = active;
    } else {
      selected = working || active;
      if (!selected) selected = await createGeneration(baseDirectory, descriptor, duration);
    }
    await recoverWriterLease(selected.generationPath, descriptor, selected.manifest);
    await cleanupInactiveGenerations(
      baseDirectory,
      new Set([active?.generationId, selected.generationId].filter(Boolean))
    );

    const selectedEncoder = descriptor.rendition === "vp9"
      ? VP9_ENCODER
      : canCopyH264Video(descriptor) && duration <= epochLength + 0.25
        ? { id: "copy", label: "Direct stream copy", hardware: false }
        : encoder;
    const pipeline = selectedEncoder.id === "copy"
      ? null
      : videoPipeline(selectedEncoder, { disableFrameReordering: true });
    const contiguousReadySeconds = manifestPreparedSeconds(selected.manifest);
    const playable = selected.manifest.complete || contiguousReadySeconds >= playableThreshold;
    const playableDeferred = createDeferred();
    if (playable) playableDeferred.resolve();

    const state = {
      key: descriptorCacheKey(descriptor),
      jobId: descriptor.jobId,
      schedulerJobId: schedulingId,
      ownerJobIds: new Set([descriptor.jobId]),
      taskId: "hls:" + descriptor.fileIndex + ":" + (descriptor.rendition || "h264"),
      descriptor,
      inputPath: descriptor.inputPath,
      baseDirectory,
      generationId: selected.generationId,
      generationPath: selected.generationPath,
      servingGenerationId: playable ? selected.generationId : null,
      servingDirectory: playable ? selected.generationPath : null,
      sourceDuration: duration,
      audioTracks: sourceAudioTracks(descriptor),
      manifest: selected.manifest,
      contiguousReadySeconds,
      complete: Boolean(selected.manifest.complete),
      resumed: selected.manifest.epochs.length > 0 && !selected.manifest.complete,
      resumeSeconds: contiguousReadySeconds,
      status: playable ? "ready" : "preparing",
      encoder: selectedEncoder,
      pipeline,
      pipelineValidated: selectedEncoder.id === "copy",
      hardwareDecode: Boolean(pipeline?.hardwareDecode),
      pipelineDiagnostics: [],
      fallback: false,
      observers: new Map(),
      children: new Set(),
      currentTask: null,
      currentEpoch: null,
      currentWorkingDirectory: null,
      resourceProfile: null,
      rendering: false,
      stopping: false,
      cancelled: false,
      error: null,
      playableDeferred,
    };

    if (playable && active?.generationId !== selected.generationId) {
      await persistPointer(baseDirectory, GENERATION_POINTER, selected.generationId);
    }
    if (state.complete) {
      await clearPointer(baseDirectory, WORKING_POINTER, selected.generationId);
    }
    emit("hls_generation_started", {
      jobId: state.jobId,
      schedulerJobId: schedulingId,
      generationId: state.generationId,
      resumed: state.resumed,
      resumeSeconds: state.resumeSeconds,
      committedEpochs: state.manifest.epochs.length,
      sourceDuration: state.sourceDuration,
      epochSeconds: epochLength,
      cacheVersion: CACHE_VERSION,
    });
    activeStates.set(state.key, state);
    return state;
  }

  async function promoteGeneration(state, reason) {
    if (state.servingGenerationId !== state.generationId) {
      await persistPointer(state.baseDirectory, GENERATION_POINTER, state.generationId);
      state.servingGenerationId = state.generationId;
      state.servingDirectory = state.generationPath;
      emit("hls_generation_promoted", {
        jobId: state.jobId,
        schedulerJobId: state.schedulerJobId,
        generationId: state.generationId,
        reason,
        contiguousReadySeconds: state.contiguousReadySeconds,
        committedEpochs: state.manifest.epochs.length,
      });
    }
    state.status = "ready";
    state.playableDeferred.resolve();
    notifyState(state, "generation-promoted", { reason });
  }

  async function writeWriterLease(state, token, epochIndex) {
    await atomicWriteJson(path.join(state.generationPath, WRITER_FILE), {
      cacheVersion: CACHE_VERSION,
      generationId: state.generationId,
      token,
      epochIndex,
      pid: process.pid,
      startedAt: Date.now(),
    });
  }

  async function clearWriterLease(state, token) {
    const writerPath = path.join(state.generationPath, WRITER_FILE);
    try {
      const lease = JSON.parse(await readFile(writerPath, "utf8"));
      if (lease.token === token) await rm(writerPath, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  async function ensurePipeline(state, profile) {
    if (state.pipelineValidated) return;
    state.pipelineValidated = true;
    if (!state.encoder.hardware) {
      state.pipeline = videoPipeline(state.encoder, {
        segmentSeconds,
        disableFrameReordering: true,
      });
      state.hardwareDecode = false;
      return;
    }
    const validation = await validateVideoPipeline(
      ffmpegPath,
      state.encoder,
      {
        path: state.inputPath,
        codec: state.descriptor.videoCodec,
        pixelFormat: state.descriptor.videoPixelFormat,
      },
      {
        threadLimit: profile.threads,
        disableFrameReordering: true,
      }
    );
    state.pipeline = videoPipeline(state.encoder, {
      segmentSeconds,
      hardwareDecode: validation.pipeline.hardwareDecode,
      disableFrameReordering: true,
    });
    state.hardwareDecode = Boolean(state.pipeline.hardwareDecode);
    if (!validation.ok) {
      state.pipelineDiagnostics.push(publicStateValue(state, validation.reason));
    }
  }

  function launchEpochProcess(state, argumentsList, workingDirectory, taskContext, epochIndex) {
    const processArguments = ["-progress", "pipe:1", "-nostats", ...argumentsList];
    const child = spawn(ffmpegPath, processArguments, {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.children.add(child);
    applyMediaProcessPriority(child, state.resourceProfile);
    const tracker = registry.track(child, {
      jobId: state.jobId,
      taskId: state.taskId + ":epoch:" + epochIndex,
      stage: "browser-playback-epoch",
      encoder: state.encoder.label,
      decoder: state.pipeline?.decode.name || "stream copy",
      hardware: state.encoder.hardware,
      profile: state.resourceProfile.mode + ":" + state.resourceProfile.kind,
      command: ffmpegPath,
      arguments: processArguments,
      privatePaths: [
        state.inputPath,
        state.generationPath,
        workingDirectory,
        ...privateToolPaths,
      ],
    });
    attachFfmpegProgress(child.stdout, tracker);
    taskContext.registerInterrupt?.(() => child.kill("SIGTERM"));
    if (taskContext.signal?.aborted || state.stopping || shuttingDown) child.kill("SIGTERM");

    let stderr = "";
    child.stderr.on("data", (value) => {
      stderr = (stderr + value.toString()).slice(-16_384);
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        state.children.delete(child);
        callback();
      };
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => finish(() => {
        if (taskContext.signal?.aborted || state.stopping || shuttingDown) {
          reject(taskContext.signal?.reason || stoppedError());
        } else if (code === 0) {
          resolve();
        } else {
          reject(pipelineError("HLS epoch " + (epochIndex + 1), code, stderr, [
            state.inputPath,
            state.generationPath,
            workingDirectory,
            ...privateToolPaths,
          ]));
        }
      }));
    });
  }

  function epochArguments(state, epochStart, requestedDuration) {
    const descriptor = state.descriptor;
    const profile = state.resourceProfile;
    const inputArguments = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-filter_threads", String(profile.filterThreads),
      ...(state.pipeline?.arguments.decode || []),
      ...renderInputArguments(profile),
      ...(descriptor.inputArguments || []),
      "-ss", epochStart.toFixed(6),
      "-fflags", "+genpts+discardcorrupt",
      "-i", state.inputPath,
    ];
    const videoArguments = [
      "-map", "0:v:0",
      "-an", "-sn", "-dn",
      "-t", requestedDuration.toFixed(6),
      ...(state.pipeline
        ? [
            ...normalizedVideoFilterArguments(state.pipeline.arguments.filter),
            ...state.pipeline.arguments.upload,
            ...state.pipeline.arguments.encode,
          ]
        : ["-c:v", "copy"]),
      ...renderEncoderArguments(state.encoder, profile),
      "-max_muxing_queue_size", "4096",
      ...playlistArguments(segmentSeconds, {
        playlist: "video/index.m3u8",
        segment: "video/segment-%06d.m4s",
      }),
    ];
    const audioArguments = state.audioTracks.flatMap((track) => {
      const id = trackDirectory(track);
      return [
        "-map", "0:" + track.streamIndex,
        "-vn", "-sn", "-dn",
        "-t", requestedDuration.toFixed(6),
        "-c:a", "aac",
        "-threads", "1",
        "-b:a", "192k",
        "-af", normalizedAudioFilter(),
        ...playlistArguments(segmentSeconds, {
          playlist: "audio/" + id + "/index.m3u8",
          segment: "audio/" + id + "/segment-%06d.m4s",
        }),
      ];
    });
    return [...inputArguments, ...videoArguments, ...audioArguments];
  }

  async function prepareEpochDirectory(workingDirectory, audioTracks) {
    await rm(workingDirectory, { recursive: true, force: true });
    await mkdir(path.join(workingDirectory, "video"), { recursive: true });
    for (const track of audioTracks) {
      await mkdir(path.join(workingDirectory, "audio", trackDirectory(track)), {
        recursive: true,
      });
    }
  }

  async function runEpochAttempt(
    state,
    workingDirectory,
    epochIndex,
    epochStart,
    requestedDuration,
    taskContext
  ) {
    await prepareEpochDirectory(workingDirectory, state.audioTracks);
    await launchEpochProcess(
      state,
      epochArguments(state, epochStart, requestedDuration),
      workingDirectory,
      taskContext,
      epochIndex
    );
    const videoPlaylist = await readEpochPlaylist(workingDirectory, "video/index.m3u8");
    const audioPlaylists = {};
    for (const track of state.audioTracks) {
      const id = trackDirectory(track);
      audioPlaylists[id] = await readEpochPlaylist(
        workingDirectory,
        "audio/" + id + "/index.m3u8"
      );
    }
    await validateFirstVideoFragment(
      state,
      path.join(workingDirectory, "video"),
      taskContext
    );
    const durations = [
      videoPlaylist.duration,
      ...Object.values(audioPlaylists).map((playlist) => playlist.duration),
    ];
    const minimumDuration = Math.min(...durations);
    const tolerance = Math.max(0.35, segmentSeconds * 0.2);
    if (
      minimumDuration + tolerance < requestedDuration &&
      epochStart + requestedDuration < state.sourceDuration - tolerance
    ) {
      throw new Error(
        "FFmpeg produced only " + rounded(minimumDuration) + " seconds for a " +
        rounded(requestedDuration) + "-second HLS epoch."
      );
    }
    return { videoPlaylist, audioPlaylists };
  }

  async function moveEpochStream(
    sourceDirectory,
    destinationDirectory,
    playlist,
    epochIndex
  ) {
    const prefix = "epoch-" + String(epochIndex).padStart(6, "0");
    await mkdir(destinationDirectory, { recursive: true });
    const initName = prefix + "-init.mp4";
    const initSource = path.join(sourceDirectory, playlist.map);
    const initDestination = path.join(destinationDirectory, initName);
    await rm(initDestination, { force: true });
    await rename(initSource, initDestination);

    const segments = [];
    for (const [segmentIndex, segment] of playlist.segments.entries()) {
      const name = prefix + "-segment-" + String(segmentIndex).padStart(6, "0") + ".m4s";
      const source = path.join(sourceDirectory, segment.uri);
      const destination = path.join(destinationDirectory, name);
      await rm(destination, { force: true });
      await rename(source, destination);
      segments.push({ uri: name, duration: timelineRounded(segment.duration) });
    }
    return {
      init: initName,
      segments,
      presentationDuration: timelineRounded(playlist.duration),
    };
  }

  async function commitEpoch(
    state,
    workingDirectory,
    epochIndex,
    epochStart,
    requestedDuration,
    outputs
  ) {
    if (state.manifest.epochs.length !== epochIndex) {
      throw new Error("The HLS epoch commit order changed while rendering.");
    }
    const video = await moveEpochStream(
      path.join(workingDirectory, "video"),
      path.join(state.generationPath, "video"),
      outputs.videoPlaylist,
      epochIndex
    );
    const audio = {};
    for (const track of state.audioTracks) {
      const id = trackDirectory(track);
      audio[id] = await moveEpochStream(
        path.join(workingDirectory, "audio", id),
        path.join(state.generationPath, "audio", id),
        outputs.audioPlaylists[id],
        epochIndex
      );
    }

    const presentedEnd = epochStart + video.presentationDuration;
    const requestedEnd = epochStart + requestedDuration;
    const reachesEnd =
      presentedEnd >= state.sourceDuration - VIDEO_END_TOLERANCE_SECONDS ||
      (
        requestedEnd >= state.sourceDuration - 0.001 &&
        isWithinHlsTerminalDuration(state.sourceDuration, presentedEnd, segmentSeconds)
      );
    const epoch = {
      index: epochIndex,
      sourceStart: timelineRounded(epochStart),
      sourceDuration: timelineRounded(requestedDuration),
      validatedStart: true,
      streams: { video, audio },
      committedAt: Date.now(),
    };
    const manifest = {
      ...state.manifest,
      epochs: [...state.manifest.epochs, epoch],
      complete: reachesEnd,
      updatedAt: Date.now(),
    };
    if (!(await validateManifestAssets(
      state.generationPath,
      manifest,
      state.descriptor,
      epochLength,
      segmentSeconds
    ))) {
      throw new Error("The committed HLS epoch failed cache validation.");
    }
    await atomicWriteJson(path.join(state.generationPath, MANIFEST_FILE), manifest);
    await publishGeneration(state.generationPath, manifest, state.audioTracks);
    state.manifest = manifest;
    state.contiguousReadySeconds = manifestPreparedSeconds(manifest);
    state.complete = manifest.complete;

    if (state.complete) {
      await atomicWriteJson(path.join(state.generationPath, COMPLETE_MARKER), {
        completedAt: Date.now(),
        cacheVersion: CACHE_VERSION,
        sourceDuration: state.sourceDuration,
        committedEpochs: manifest.epochs.length,
      });
      await persistPointer(state.baseDirectory, GENERATION_POINTER, state.generationId);
      await clearPointer(state.baseDirectory, WORKING_POINTER, state.generationId);
      state.servingGenerationId = state.generationId;
      state.servingDirectory = state.generationPath;
      state.status = "ready";
      state.playableDeferred.resolve();
    } else {
      await persistPointer(state.baseDirectory, WORKING_POINTER, state.generationId);
      if (state.contiguousReadySeconds >= playableThreshold) {
        await promoteGeneration(state, "contiguous-window");
      }
    }

    emit("hls_epoch_committed", {
      jobId: state.jobId,
      schedulerJobId: state.schedulerJobId,
      generationId: state.generationId,
      epochIndex,
      sourceStart: epoch.sourceStart,
      sourceDuration: epoch.sourceDuration,
      presentationDuration: video.presentationDuration,
      contiguousReadySeconds: state.contiguousReadySeconds,
      complete: state.complete,
    });
    notifyState(state, state.complete ? "generation-completed" : "epoch-committed", {
      epochIndex,
    });
  }

  async function renderEpoch(state, epochIndex, profile, taskContext) {
    if (state.stopping || state.cancelled || shuttingDown || taskContext.signal?.aborted) {
      throw taskContext.signal?.reason || stoppedError();
    }
    state.resourceProfile = profile;
    state.currentEpoch = epochIndex;
    state.rendering = true;
    await ensurePipeline(state, profile);
    const epochStart = manifestPreparedSeconds(state.manifest);
    const requestedDuration = Math.min(epochLength, state.sourceDuration - epochStart);
    if (!(requestedDuration > 0)) {
      throw new Error("The HLS epoch begins beyond the source duration.");
    }
    const token = randomUUID();
    const workingDirectory = path.join(
      state.generationPath,
      ".working",
      String(epochIndex).padStart(6, "0") + "-" + token
    );
    state.currentWorkingDirectory = workingDirectory;
    await writeWriterLease(state, token, epochIndex);

    try {
      let outputs;
      try {
        outputs = await runEpochAttempt(
          state,
          workingDirectory,
          epochIndex,
          epochStart,
          requestedDuration,
          taskContext
        );
      } catch (error) {
        if (taskContext.signal?.aborted || state.stopping || shuttingDown) throw error;
        if (state.encoder.hardware && state.hardwareDecode) {
          state.hardwareDecode = false;
          state.pipeline = videoPipeline(state.encoder, {
            segmentSeconds,
            hardwareDecode: false,
            disableFrameReordering: true,
          });
          state.pipelineDiagnostics.push({
            code: "runtime_hardware_decode_failed",
            stage: "decode/filter/upload",
            backend: state.encoder.id,
            message: state.encoder.label +
              " failed for this source; retrying GPU encoding with software decode.",
          });
          try {
            outputs = await runEpochAttempt(
              state,
              workingDirectory,
              epochIndex,
              epochStart,
              requestedDuration,
              taskContext
            );
          } catch (retryError) {
            if (taskContext.signal?.aborted || state.stopping || shuttingDown) {
              throw retryError;
            }
          }
        }
        if (!outputs) {
          if (state.encoder.id === "copy" || state.encoder.hardware) {
            const failedEncoder = state.encoder;
            state.encoder = CPU_ENCODER;
            state.hardwareDecode = false;
            state.pipeline = videoPipeline(CPU_ENCODER, {
              segmentSeconds,
              disableFrameReordering: true,
            });
            state.pipelineDiagnostics.push({
              code: "runtime_hardware_encode_failed",
              stage: "encode",
              backend: failedEncoder.id,
              message: failedEncoder.label +
                " failed for this source; using constrained CPU encoding.",
            });
            state.fallback = true;
            outputs = await runEpochAttempt(
              state,
              workingDirectory,
              epochIndex,
              epochStart,
              requestedDuration,
              taskContext
            );
          } else {
            throw error;
          }
        }
      }
      await commitEpoch(
        state,
        workingDirectory,
        epochIndex,
        epochStart,
        requestedDuration,
        outputs
      );
    } finally {
      await clearWriterLease(state, token).catch(() => {});
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
      state.currentEpoch = null;
      state.rendering = false;
    }
  }

  function scheduleNextEpoch(state) {
    if (
      state.complete ||
      state.currentTask ||
      state.cancelled ||
      state.stopping ||
      shuttingDown
    ) return;
    const epochIndex = state.manifest.epochs.length;
    const taskId = state.taskId + ":epoch:" + epochIndex;
    const task = mediaScheduler.enqueue({
      taskId,
      jobId: state.schedulerJobId,
      stage: "browser-playback-epoch",
      priority: 50,
      preemptible: false,
      restartOnPromotion: false,
      run: async (resourceProfile, taskContext = {}) => {
        try {
          await renderEpoch(state, epochIndex, resourceProfile, taskContext);
          return { value: true };
        } catch (error) {
          throw publicStateError(state, error);
        }
      },
    });
    state.currentTask = task;
    notifyState(state, "epoch-queued", { epochIndex });
    void task
      .then(async () => {
        if (state.currentTask === task) state.currentTask = null;
        state.currentWorkingDirectory = null;
        if (state.complete) {
          state.status = "ready";
          await cleanupInactiveGenerations(
            state.baseDirectory,
            new Set([state.generationId])
          ).catch((error) => emit("hls_generation_cleanup_failed", {
            jobId: state.jobId,
            generationId: state.generationId,
            error: publicStateError(state, error),
          }));
          emit("hls_generation_completed", {
            jobId: state.jobId,
            schedulerJobId: state.schedulerJobId,
            generationId: state.generationId,
            contiguousReadySeconds: state.contiguousReadySeconds,
            sourceDuration: state.sourceDuration,
            committedEpochs: state.manifest.epochs.length,
          });
          return;
        }
        scheduleNextEpoch(state);
      })
      .catch((error) => {
        if (state.currentTask === task) state.currentTask = null;
        state.rendering = false;
        const publicError = publicStateError(state, error);
        state.currentWorkingDirectory = null;
        if (state.cancelled || state.stopping || shuttingDown) {
          emit("hls_epoch_stopped", {
            jobId: state.jobId,
            schedulerJobId: state.schedulerJobId,
            generationId: state.generationId,
            epochIndex,
          });
          return;
        }
        const message = publicError.message;
        state.error = publicError;
        state.pipelineDiagnostics.push({
          code: "hls_epoch_failed",
          stage: "browser-playback",
          backend: state.encoder.id,
          message,
        });
        state.status = state.servingDirectory ? "ready" : "error";
        if (!state.servingDirectory) state.playableDeferred.reject(publicError);
        emit("hls_generation_failed", {
          jobId: state.jobId,
          schedulerJobId: state.schedulerJobId,
          generationId: state.generationId,
          epochIndex,
          servingGenerationId: state.servingGenerationId,
          error: message,
          errorCode: publicError.code || null,
        });
        notifyState(state, "generation-failed", { epochIndex });
      });
  }

  async function ensure(descriptor) {
    if (shuttingDown) {
      const error = stoppedError("Browser playback is shutting down.");
      error.code = "WATCHPAIR_HLS_SHUTTING_DOWN";
      throw error;
    }
    const key = descriptorCacheKey(descriptor);
    const schedulingId = descriptorSchedulerJobId(descriptor);
    let schedulingIds = jobSchedulerIds.get(descriptor.jobId);
    if (!schedulingIds) {
      schedulingIds = new Set();
      jobSchedulerIds.set(descriptor.jobId, schedulingIds);
    }
    schedulingIds.add(schedulingId);
    const targetKey = descriptor.jobId + ":" + descriptor.fileIndex;
    targetSchedulerIds.set(targetKey, schedulingId);
    if (
      prioritySchedulerJobId === schedulingId ||
      priorityTargetKey === targetKey ||
      (!priorityTargetKey && priorityOwnerJobId === descriptor.jobId)
    ) {
      mediaScheduler.prioritize(schedulingId);
    }

    let pending = sessions.get(key);
    if (!pending) {
      pending = initializeState(descriptor, schedulingId)
        .then((state) => {
          if (!state.complete) scheduleNextEpoch(state);
          return state;
        })
        .catch((error) => {
          sessions.delete(key);
          activeStates.delete(key);
          throw sanitizePublicError(error, [
            descriptor.inputPath,
            cacheRoot,
            process.cwd(),
            ...privateToolPaths,
          ]);
        });
      sessions.set(key, pending);
    }
    const state = await pending;
    state.ownerJobIds.add(descriptor.jobId);
    observeState(state, descriptor);
    return state;
  }

  async function waitForAsset(state, relativePath, directory) {
    if (!directory) throw new Error("No playable HLS generation is available.");
    const target = path.resolve(directory, relativePath);
    if (target !== directory && !target.startsWith(directory + path.sep)) {
      throw new Error("Invalid HLS asset path.");
    }
    const startedAt = Date.now();
    while (!(await exists(target))) {
      if (state.cancelled || state.stopping || shuttingDown) throw stoppedError();
      if (state.error && !state.servingDirectory) throw state.error;
      if (Date.now() - startedAt >= playlistWaitMs) {
        throw new Error("Timed out while waiting for a committed browser-playback asset.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return target;
  }

  async function getAsset(descriptor, relativePath) {
    if (!/^(master\.m3u8|video\/(?:index\.m3u8|epoch-\d{6}-(?:init\.mp4|segment-\d{6}\.m4s))|audio\/\d+\/(?:index\.m3u8|epoch-\d{6}-(?:init\.mp4|segment-\d{6}\.m4s)))$/.test(relativePath)) {
      throw new Error("Invalid HLS asset.");
    }
    const state = await ensure(descriptor);
    await state.playableDeferred.promise;
    const filePath = await waitForAsset(state, relativePath, state.servingDirectory);
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
    await state.playableDeferred.promise;
    return preparationState(state);
  }

  async function getPreparation(descriptor) {
    const pending = sessions.get(descriptorCacheKey(descriptor));
    if (!pending) return { status: "waiting", encoder: null, fallback: false };
    return preparationState(await pending);
  }

  async function removeJob(jobId) {
    const schedulingIds = jobSchedulerIds.get(jobId) || new Set();
    jobSchedulerIds.delete(jobId);
    for (const key of targetSchedulerIds.keys()) {
      if (key.startsWith(jobId + ":")) targetSchedulerIds.delete(key);
    }

    const stopping = [];
    for (const [key, pending] of sessions) {
      stopping.push(pending.then(async (state) => {
        if (!state.ownerJobIds.has(jobId)) return;
        state.ownerJobIds.delete(jobId);
        state.observers.delete(jobId);
        if (state.ownerJobIds.size) return;
        sessions.delete(key);
        activeStates.delete(key);
        state.cancelled = true;
        state.stopping = true;
        mediaScheduler.cancelJob(state.schedulerJobId);
        for (const child of state.children) child.kill("SIGTERM");
        await state.currentTask?.catch(() => {});
      }).catch(() => {}));
    }
    await Promise.allSettled(stopping);
    await Promise.all([
      rm(path.join(cacheRoot, "jobs", jobId), { recursive: true, force: true }),
      rm(path.join(cacheRoot, jobId), { recursive: true, force: true }),
    ]);

    for (const schedulingId of schedulingIds) {
      const stillOwned = Array.from(jobSchedulerIds.values()).some((ids) =>
        ids.has(schedulingId)
      );
      if (!stillOwned) mediaScheduler.cancelJob(schedulingId);
    }
  }

  function setPriorityJob(jobId) {
    priorityOwnerJobId = jobId || null;
    priorityTargetKey = null;
    prioritySchedulerJobId = null;
    const schedulingId = jobId
      ? jobSchedulerIds.get(jobId)?.values().next().value
      : null;
    mediaScheduler.prioritize(schedulingId || jobId || null);
  }

  function setPriorityTarget(jobId, fileIndex, schedulingId = null) {
    priorityOwnerJobId = jobId || null;
    priorityTargetKey = jobId && Number.isInteger(fileIndex)
      ? jobId + ":" + fileIndex
      : null;
    prioritySchedulerJobId = schedulingId || (
      priorityTargetKey ? targetSchedulerIds.get(priorityTargetKey) : null
    ) || null;
    mediaScheduler.prioritize(prioritySchedulerJobId || null);
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const schedulingIds = new Set(
      Array.from(activeStates.values()).map((state) => state.schedulerJobId)
    );
    for (const schedulingId of schedulingIds) mediaScheduler.cancelJob(schedulingId);
    const stopping = Array.from(activeStates.values()).map(async (state) => {
      state.cancelled = true;
      state.stopping = true;
      for (const child of state.children) child.kill("SIGTERM");
      state.playableDeferred.reject(stoppedError());
      await state.currentTask?.catch(() => {});
    });
    await Promise.allSettled(stopping);
    if (ownsScheduler) {
      mediaScheduler.beginShutdown?.();
      await mediaScheduler.shutdown();
    }
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
        bufferedSeconds: state.contiguousReadySeconds,
        contiguousReadySeconds: state.contiguousReadySeconds,
        sourceDuration: state.sourceDuration,
        committedEpochs: state.manifest.epochs.length,
        epochSeconds: epochLength,
        complete: state.complete,
        currentEpoch: state.currentEpoch,
        childProcesses: state.children.size,
        resumed: state.resumed,
        resumeSeconds: state.resumeSeconds,
        resourceProfile: state.resourceProfile
          ? state.resourceProfile.mode + ":" + state.resourceProfile.kind
          : null,
      })),
    }),
  };
}

async function readStableAsset(filePath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(filePath);
    } catch (error) {
      if (!["EAGAIN", "ENODATA", "ENOENT"].includes(error?.code) || attempt === 49) {
        throw error;
      }
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
