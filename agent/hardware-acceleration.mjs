import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const PROBE_TIMEOUT_MS = 8_000;
export const ENCODER_PROBE_SOURCE = "color=c=black:s=640x360:r=24:d=0.2";

const ENCODERS = {
  nvenc: {
    id: "nvenc",
    codec: "h264_nvenc",
    label: "NVIDIA NVENC",
    platforms: new Set(["linux", "win32"]),
    arguments: ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
  },
  qsv: {
    id: "qsv",
    codec: "h264_qsv",
    label: "Intel Quick Sync",
    platforms: new Set(["linux", "win32"]),
    arguments: ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"],
  },
  vaapi: {
    id: "vaapi",
    codec: "h264_vaapi",
    label: "VAAPI",
    platforms: new Set(["linux"]),
    arguments: ["-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", "23"],
  },
  amf: {
    id: "amf",
    codec: "h264_amf",
    label: "AMD AMF",
    platforms: new Set(["win32"]),
    arguments: ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"],
  },
  videotoolbox: {
    id: "videotoolbox",
    codec: "h264_videotoolbox",
    label: "Apple VideoToolbox",
    platforms: new Set(["darwin"]),
    arguments: ["-c:v", "h264_videotoolbox", "-q:v", "60"],
  },
};

const CPU_ENCODER = {
  id: "cpu",
  codec: "libx264",
  label: "CPU (libx264)",
  hardware: false,
  arguments: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
};

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate.path || seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

export function encoderCandidates(platform = process.platform, preference = "auto") {
  const available = Object.values(ENCODERS).filter((encoder) => encoder.platforms.has(platform));
  if (preference === "cpu") return [];
  if (preference !== "auto") {
    const requested = ENCODERS[preference];
    return requested && requested.platforms.has(platform) ? [requested] : [];
  }
  return available;
}

export function videoEncoderArguments(encoder, segmentSeconds) {
  return [
    ...encoder.arguments,
    ...(encoder.id === "cpu" ? ["-sc_threshold", "0"] : []),
    "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`,
  ];
}

async function commandOutput(path, args) {
  const result = await runFile(path, args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

async function testEncoder(path, encoder) {
  try {
    await commandOutput(path, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", ENCODER_PROBE_SOURCE,
      "-an", ...encoder.arguments,
      "-frames:v", "2", "-f", "null", "-",
    ]);
    return true;
  } catch {
    return false;
  }
}

async function inspectCandidate(candidate, platform, preference) {
  let encoders;
  try {
    await commandOutput(candidate.path, ["-hide_banner", "-version"]);
    encoders = await commandOutput(candidate.path, ["-hide_banner", "-encoders"]);
  } catch {
    return null;
  }

  for (const encoder of encoderCandidates(platform, preference)) {
    if (!encoders.includes(encoder.codec)) continue;
    if (await testEncoder(candidate.path, encoder)) {
      return {
        ffmpegPath: candidate.path,
        ffmpegSource: candidate.source,
        encoder: { ...encoder, hardware: true },
      };
    }
  }

  if (encoders.includes(CPU_ENCODER.codec) && await testEncoder(candidate.path, CPU_ENCODER)) {
    return {
      ffmpegPath: candidate.path,
      ffmpegSource: candidate.source,
      encoder: CPU_ENCODER,
    };
  }
  return null;
}

export async function selectTranscodeRuntime({
  bundledPath,
  configuredPath = process.env.WATCHPAIR_FFMPEG_PATH,
  systemPath = "ffmpeg",
  preference = String(process.env.WATCHPAIR_TRANSCODER || "auto").toLowerCase(),
  platform = process.platform,
} = {}) {
  const normalizedPreference = preference in ENCODERS || preference === "cpu" ? preference : "auto";
  const candidates = uniqueCandidates([
    { path: configuredPath, source: "configured" },
    { path: systemPath, source: "system" },
    { path: bundledPath, source: "bundled" },
  ]);

  for (const candidate of candidates) {
    const runtime = await inspectCandidate(candidate, platform, normalizedPreference);
    if (runtime) {
      return {
        ...runtime,
        preference: normalizedPreference,
      };
    }
  }
  throw new Error("No usable FFmpeg installation was found.");
}

export function publicTranscoder(runtime) {
  return {
    encoder: runtime.encoder.id,
    label: runtime.encoder.label,
    hardware: runtime.encoder.hardware,
    ffmpegSource: runtime.ffmpegSource,
    preference: runtime.preference,
  };
}

export { CPU_ENCODER };
