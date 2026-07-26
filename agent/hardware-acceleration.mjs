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
    arguments: ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-forced-idr", "1"],
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
    arguments: ["-c:v", "h264_vaapi", "-qp", "23"],
    probeArguments: [
      "-vaapi_device", "/dev/dri/renderD128",
      "-vf", "format=nv12,hwupload",
      "-c:v", "h264_vaapi", "-qp", "23",
    ],
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

const VP9_ENCODER = {
  id: "vp9",
  codec: "libvpx-vp9",
  label: "VP9 compatibility (CPU)",
  hardware: false,
  arguments: [
    "-c:v", "libvpx-vp9",
    "-deadline", "realtime",
    "-cpu-used", "6",
    "-crf", "32",
    "-b:v", "0",
    "-pix_fmt", "yuv420p",
    "-row-mt", "1",
  ],
};

const CPU_ENCODER = {
  id: "cpu",
  codec: "libx264",
  label: "CPU (libx264)",
  hardware: false,
  arguments: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
};

const COMMON_HARDWARE_CODECS = new Set([
  "h264", "hevc", "vp8", "vp9", "av1", "mpeg2video", "mpeg4", "vc1", "mjpeg",
]);
const TEN_BIT_PIXEL_FORMATS = new Set(["p010le", "p010be", "yuv420p10le", "yuv420p10be"]);
const COMMON_PIXEL_FORMATS = new Set([
  "yuv420p", "yuvj420p", "nv12", "p010le", "p010be", "yuv420p10le", "yuv420p10be",
]);

// Keep stages explicit so a caller can tell hardware decode from software conversion.
const PIPELINE_DEFINITIONS = {
  nvenc: {
    platform: "CUDA/NVDEC + NVENC",
    supportedCodecs: COMMON_HARDWARE_CODECS,
    decode: { name: "CUDA/NVDEC", hardware: true, arguments: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] },
    filter: { name: "scale_cuda", hardware: true, arguments: ["-vf", "scale_cuda=format=yuv420p"] },
    upload: { name: "none", hardware: false, arguments: [] },
    softwareDecodeArguments: [],
    softwareFilter: { name: "software format conversion", hardware: false, arguments: ["-vf", "format=yuv420p"] },
    softwareUpload: { name: "NVENC frame upload", hardware: true, arguments: [] },
  },
  qsv: {
    platform: "Intel QSV",
    supportedCodecs: COMMON_HARDWARE_CODECS,
    decode: { name: "QSV", hardware: true, arguments: ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"] },
    filter: { name: "scale_qsv", hardware: true, arguments: ["-vf", "scale_qsv=format=nv12"] },
    upload: { name: "none", hardware: false, arguments: [] },
    softwareDecodeArguments: [],
    softwareFilter: { name: "software NV12 conversion", hardware: false, arguments: ["-vf", "format=nv12"] },
    softwareUpload: { name: "QSV frame upload", hardware: true, arguments: [] },
  },
  vaapi: {
    platform: "VAAPI",
    supportedCodecs: COMMON_HARDWARE_CODECS,
    decode: {
      name: "VAAPI",
      hardware: true,
      arguments: [
        "-vaapi_device", "/dev/dri/renderD128",
        "-hwaccel", "vaapi",
        "-hwaccel_device", "/dev/dri/renderD128",
        "-hwaccel_output_format", "vaapi",
      ],
    },
    filter: { name: "scale_vaapi", hardware: true, arguments: ["-vf", "scale_vaapi=format=nv12"] },
    upload: { name: "none", hardware: false, arguments: [] },
    softwareDecodeArguments: ["-vaapi_device", "/dev/dri/renderD128"],
    softwareFilter: { name: "software NV12 conversion", hardware: false, arguments: ["-vf", "format=nv12,hwupload"] },
    softwareUpload: { name: "hwupload", hardware: true, arguments: [] },
  },
  amf: {
    platform: "D3D11VA + AMD AMF",
    supportedCodecs: COMMON_HARDWARE_CODECS,
    decode: { name: "D3D11VA", hardware: true, arguments: ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"] },
    filter: { name: "D3D11 surface passthrough", hardware: true, arguments: [] },
    upload: { name: "none", hardware: false, arguments: [] },
    softwareDecodeArguments: [],
    softwareFilter: { name: "software NV12 conversion", hardware: false, arguments: ["-vf", "format=nv12"] },
    softwareUpload: { name: "AMF frame upload", hardware: true, arguments: [] },
  },
  videotoolbox: {
    platform: "VideoToolbox",
    supportedCodecs: COMMON_HARDWARE_CODECS,
    decode: { name: "VideoToolbox", hardware: true, arguments: ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"] },
    filter: { name: "none", hardware: true, arguments: [] },
    upload: { name: "none", hardware: false, arguments: [] },
    softwareDecodeArguments: [],
    softwareFilter: { name: "software format conversion", hardware: false, arguments: ["-vf", "format=yuv420p"] },
    softwareUpload: { name: "VideoToolbox frame upload", hardware: true, arguments: [] },
  },
  cpu: {
    platform: "software",
    supportedCodecs: COMMON_HARDWARE_CODECS,
    decode: { name: "software", hardware: false, arguments: [] },
    filter: { name: "software format conversion", hardware: false, arguments: [] },
    upload: { name: "none", hardware: false, arguments: [] },
    softwareDecodeArguments: [],
    softwareFilter: { name: "software format conversion", hardware: false, arguments: [] },
    softwareUpload: { name: "none", hardware: false, arguments: [] },
  },
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

export function videoEncoderArguments(encoder, segmentSeconds, {
  disableFrameReordering = false,
} = {}) {
  return [
    ...encoder.arguments,
    ...(encoder.id === "cpu" ? ["-sc_threshold", "0"] : []),
    ...(disableFrameReordering && encoder.id !== "vp9" ? ["-bf", "0"] : []),
    "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`,
  ];
}

function isHardwareEncoder(encoder) {
  return Boolean(encoder?.hardware && PIPELINE_DEFINITIONS[encoder.id]?.decode.hardware);
}

function pipelineStage(name, hardware, argumentsList) {
  return { name, hardware, arguments: [...argumentsList] };
}

export function videoPipeline(encoder, {
  segmentSeconds = 4,
  hardwareDecode = isHardwareEncoder(encoder),
  disableFrameReordering = false,
} = {}) {
  const definition = PIPELINE_DEFINITIONS[encoder?.id] || PIPELINE_DEFINITIONS.cpu;
  const useHardwareDecode = Boolean(hardwareDecode && isHardwareEncoder(encoder));
  const decode = useHardwareDecode
    ? pipelineStage(definition.decode.name, true, definition.decode.arguments)
    : pipelineStage("software", false, definition.softwareDecodeArguments);
  const filter = useHardwareDecode
    ? pipelineStage(definition.filter.name, definition.filter.hardware, definition.filter.arguments)
    : pipelineStage(definition.softwareFilter.name, definition.softwareFilter.hardware, definition.softwareFilter.arguments);
  const upload = useHardwareDecode
    ? pipelineStage(definition.upload.name, definition.upload.hardware, definition.upload.arguments)
    : pipelineStage(definition.softwareUpload.name, definition.softwareUpload.hardware, definition.softwareUpload.arguments);
  const encode = pipelineStage(
    encoder?.label || "software",
    Boolean(encoder?.hardware),
    videoEncoderArguments(encoder || CPU_ENCODER, segmentSeconds, { disableFrameReordering })
  );
  return {
    id: useHardwareDecode ? encoder.id + "-hardware" : (encoder?.id || "cpu") + "-software-decode",
    backend: encoder?.id || "cpu",
    platform: definition.platform,
    hardwareDecode: useHardwareDecode,
    hardwareFilter: Boolean(filter.hardware),
    hardwareUpload: Boolean(upload.hardware),
    hardwareEncode: Boolean(encode.hardware),
    decode,
    filter,
    upload,
    encode,
    arguments: {
      decode: [...decode.arguments],
      filter: [...filter.arguments],
      upload: [...upload.arguments],
      encode: [...encode.arguments],
    },
  };
}

export function videoDecoderFilterArguments(encoder) {
  if (!isHardwareEncoder(encoder)) return [];
  const pipeline = videoPipeline(encoder);
  return [...pipeline.filter.arguments, ...pipeline.upload.arguments];
}

export function videoDecoderArguments(encoder) {
  return isHardwareEncoder(encoder)
    ? [...videoPipeline(encoder).decode.arguments]
    : [];
}

function outputText(result) {
  if (typeof result === "string") return result;
  return (result?.stdout || "") + "\n" + (result?.stderr || "");
}

async function commandOutput(path, args, run = runFile) {
  const result = await run(path, args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return outputText(result);
}

async function testEncoder(path, encoder, run) {
  try {
    await commandOutput(path, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", ENCODER_PROBE_SOURCE,
      "-an", ...(encoder.probeArguments || encoder.arguments),
      "-frames:v", "2", "-f", "null", "-",
    ], run);
    return true;
  } catch {
    return false;
  }
}

function normalizedSource(source, mediaPath, sourceCodec, sourcePixelFormat) {
  const supplied = typeof source === "string" ? { path: source } : (source || {});
  return {
    path: mediaPath || supplied.path || supplied.mediaPath || null,
    codec: String(sourceCodec || supplied.codec || supplied.videoCodec || "").toLowerCase().replace(/^video\//, ""),
    pixelFormat: String(sourcePixelFormat || supplied.pixelFormat || supplied.videoPixelFormat || "").toLowerCase(),
  };
}

function sourceCompatibility(encoder, source) {
  if (!source?.codec && !source?.pixelFormat) return null;
  const definition = PIPELINE_DEFINITIONS[encoder?.id];
  if (!definition || !isHardwareEncoder(encoder)) return null;
  if (source.codec && !definition.supportedCodecs.has(source.codec)) {
    return {
      code: "source_codec_not_supported_by_hardware_decoder",
      stage: "decode",
      backend: encoder.id,
      message: encoder.label + " cannot claim hardware decoding for source codec " + source.codec + ".",
    };
  }
  if (source.pixelFormat && !COMMON_PIXEL_FORMATS.has(source.pixelFormat)) {
    return {
      code: "source_pixel_format_not_supported_by_hardware_path",
      stage: "filter/upload",
      backend: encoder.id,
      message: encoder.label + " cannot safely claim a zero-copy path for source pixel format " + source.pixelFormat + ".",
    };
  }
  if (source.pixelFormat && TEN_BIT_PIXEL_FORMATS.has(source.pixelFormat) && ["amf", "videotoolbox"].includes(encoder.id)) {
    return {
      code: "source_pixel_format_requires_software_conversion",
      stage: "filter",
      backend: encoder.id,
      message: encoder.label + " is not treated as zero-copy for this 10-bit source.",
    };
  }
  return null;
}

export async function validateVideoPipeline(ffmpegPath, encoder, source, {
  run = runFile,
  threadLimit = 0,
  disableFrameReordering = false,
} = {}) {
  const normalized = normalizedSource(source);
  const staticReason = sourceCompatibility(encoder, normalized);
  if (staticReason) {
    return {
      ok: false,
      reason: staticReason,
      pipeline: videoPipeline(encoder, { hardwareDecode: false, disableFrameReordering }),
    };
  }
  if (!normalized.path) {
    return {
      ok: true,
      method: "static",
      pipeline: videoPipeline(encoder, { disableFrameReordering }),
    };
  }

  const pipeline = videoPipeline(encoder, { disableFrameReordering });
  try {
    await commandOutput(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      ...pipeline.arguments.decode,
      ...(threadLimit > 0 ? ["-threads:v", String(threadLimit)] : []),
      "-i", normalized.path,
      "-map", "0:v:0", "-an", "-sn", "-dn",
      ...pipeline.arguments.filter,
      ...pipeline.arguments.upload,
      "-frames:v", "1", "-f", "null", "-",
    ], run);
    return { ok: true, method: "source-probe", pipeline };
  } catch (error) {
    const detail = outputText(error).trim().split("\n").slice(-3).join(" ").slice(0, 500);
    return {
      ok: false,
      reason: {
        code: "hardware_pipeline_probe_failed",
        stage: "decode/filter/upload",
        backend: encoder.id,
        message: encoder.label + " hardware decode validation failed" + (detail ? ": " + detail : "."),
      },
      pipeline: videoPipeline(encoder, { hardwareDecode: false, disableFrameReordering }),
    };
  }
}

async function inspectCandidate(candidate, platform, preference, source, run) {
  const diagnostics = [];
  let encoders;
  try {
    await commandOutput(candidate.path, ["-hide_banner", "-version"], run);
    encoders = await commandOutput(candidate.path, ["-hide_banner", "-encoders"], run);
  } catch (error) {
    diagnostics.push({
      code: "ffmpeg_candidate_unusable",
      stage: "candidate",
      candidate: candidate.source,
      message: "Unable to inspect " + candidate.source + " FFmpeg candidate.",
      detail: outputText(error).slice(-500),
    });
    return { runtime: null, diagnostics };
  }

  for (const encoder of encoderCandidates(platform, preference)) {
    if (!encoders.includes(encoder.codec)) continue;
    if (!await testEncoder(candidate.path, encoder, run)) {
      diagnostics.push({
        code: "hardware_encoder_probe_failed",
        stage: "encode",
        candidate: candidate.source,
        backend: encoder.id,
        message: encoder.label + " is listed but its encode probe failed.",
      });
      continue;
    }
    const selectedEncoder = { ...encoder, hardware: true };
    const validation = await validateVideoPipeline(candidate.path, selectedEncoder, source, { run });
    return {
      runtime: {
        ffmpegPath: candidate.path,
        ffmpegSource: candidate.source,
        encoder: selectedEncoder,
        pipeline: validation.pipeline,
        hardwareDecode: validation.pipeline.hardwareDecode,
        diagnostics: validation.ok ? diagnostics : [...diagnostics, validation.reason],
      },
      diagnostics,
    };
  }

  if (encoders.includes(CPU_ENCODER.codec) && await testEncoder(candidate.path, CPU_ENCODER, run)) {
    const pipeline = videoPipeline(CPU_ENCODER);
    return {
      runtime: {
        ffmpegPath: candidate.path,
        ffmpegSource: candidate.source,
        encoder: CPU_ENCODER,
        pipeline,
        hardwareDecode: false,
        diagnostics,
      },
      diagnostics,
    };
  }
  return { runtime: null, diagnostics };
}

export async function selectTranscodeRuntime({
  bundledPath,
  configuredPath = process.env.WATCHPAIR_FFMPEG_PATH,
  systemPath = "ffmpeg",
  preference = String(process.env.WATCHPAIR_TRANSCODER || "auto").toLowerCase(),
  platform = process.platform,
  mediaPath = null,
  sourceCodec = "",
  sourcePixelFormat = "",
  source = null,
  run = runFile,
} = {}) {
  const normalizedPreference = preference in ENCODERS || preference === "cpu" ? preference : "auto";
  const mediaSource = normalizedSource(source, mediaPath, sourceCodec, sourcePixelFormat);
  const candidates = uniqueCandidates([
    { path: configuredPath, source: "configured" },
    { path: systemPath, source: "system" },
    { path: bundledPath, source: "bundled" },
  ]);
  const diagnostics = [];
  let cpuFallback = null;

  for (const candidate of candidates) {
    const previousDiagnostics = [...diagnostics];
    const inspected = await inspectCandidate(candidate, platform, normalizedPreference, mediaSource, run);
    diagnostics.push(...inspected.diagnostics);
    if (inspected.runtime) {
      const selected = {
        ...inspected.runtime,
        preference: normalizedPreference,
        source: mediaSource.path ? mediaSource : null,
        diagnostics: [
          ...previousDiagnostics,
          ...(inspected.runtime.diagnostics || inspected.diagnostics),
        ],
      };
      if (selected.encoder.hardware || normalizedPreference === "cpu") return selected;
      if (!cpuFallback) cpuFallback = selected;
    }
  }
  if (cpuFallback) return { ...cpuFallback, diagnostics };
  const error = new Error("No usable FFmpeg installation was found.");
  error.code = "NO_USABLE_FFMPEG";
  error.diagnostics = diagnostics;
  throw error;
}

export function publicTranscoder(runtime) {
  const pipeline = runtime.pipeline || videoPipeline(runtime.encoder, {
    hardwareDecode: runtime.hardwareDecode,
  });
  return {
    encoder: runtime.encoder.id,
    label: runtime.encoder.label,
    hardware: Boolean(runtime.encoder.hardware),
    hardwareDecode: Boolean(pipeline.hardwareDecode),
    ffmpegSource: runtime.ffmpegSource,
    preference: runtime.preference,
    pipeline,
    diagnostics: runtime.diagnostics || [],
  };
}

export { CPU_ENCODER, VP9_ENCODER };
