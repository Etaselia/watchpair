import assert from "node:assert/strict";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import {
  CPU_ENCODER,
  ENCODER_PROBE_SOURCE,
  encoderCandidates,
  publicTranscoder,
  selectTranscodeRuntime,
  validateVideoPipeline,
  videoDecoderArguments,
  videoDecoderFilterArguments,
  videoEncoderArguments,
  videoPipeline,
} from "../agent/hardware-acceleration.mjs";

test("orders platform hardware encoders and builds segment-aligned arguments", () => {
  assert.deepEqual(
    encoderCandidates("linux").map((encoder) => encoder.id),
    ["nvenc", "qsv", "vaapi"]
  );
  assert.deepEqual(
    encoderCandidates("win32").map((encoder) => encoder.id),
    ["nvenc", "qsv", "amf"]
  );
  assert.deepEqual(
    encoderCandidates("darwin").map((encoder) => encoder.id),
    ["videotoolbox"]
  );
  assert.deepEqual(encoderCandidates("linux", "cpu"), []);
  assert.match(ENCODER_PROBE_SOURCE, /s=640x360/);
  const nvenc = encoderCandidates("win32", "nvenc")[0];
  assert.deepEqual(
    videoDecoderArguments({ ...nvenc, hardware: true }),
    ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
  );
  assert.deepEqual(
    videoDecoderFilterArguments({ ...nvenc, hardware: true }),
    ["-vf", "scale_cuda=format=yuv420p"]
  );
  assert.deepEqual(videoDecoderArguments(CPU_ENCODER), []);

  const argumentsList = videoEncoderArguments(CPU_ENCODER, 4);
  assert.ok(argumentsList.includes("libx264"));
  assert.ok(argumentsList.includes("expr:gte(t,n_forced*4)"));
});

test("falls back to the bundled CPU encoder when no platform GPU encoder exists", async () => {
  const runtime = await selectTranscodeRuntime({
    bundledPath: ffmpegPath,
    configuredPath: null,
    systemPath: null,
    preference: "auto",
    platform: "unsupported",
  });

  assert.equal(runtime.encoder.id, "cpu");
  assert.equal(runtime.encoder.hardware, false);
  assert.equal(runtime.encoder.codec, "libx264");
});

test("continues past a CPU-only system FFmpeg to a bundled GPU runtime", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("-version")) return { stdout: "ffmpeg mock", stderr: "" };
    if (args.includes("-encoders")) {
      return {
        stdout: command === "system-ffmpeg" ? "libx264" : "h264_nvenc libx264",
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = await selectTranscodeRuntime({
    bundledPath: "bundled-ffmpeg",
    configuredPath: null,
    systemPath: "system-ffmpeg",
    platform: "win32",
    run,
  });

  assert.equal(runtime.ffmpegSource, "bundled");
  assert.equal(runtime.encoder.id, "nvenc");
  assert.ok(calls.some((call) => call[0] === "system-ffmpeg" && call.includes("-encoders")));
  assert.ok(calls.some((call) => call[0] === "bundled-ffmpeg" && call.includes("-encoders")));
});

test("models explicit hardware stages for every supported backend", () => {
  const backends = [
    ["nvenc", "win32"],
    ["qsv", "win32"],
    ["vaapi", "linux"],
    ["amf", "win32"],
    ["videotoolbox", "darwin"],
  ];

  for (const [id, platform] of backends) {
    const encoder = { ...encoderCandidates(platform, id)[0], hardware: true };
    const pipeline = videoPipeline(encoder);
    assert.equal(pipeline.backend, id);
    assert.equal(pipeline.hardwareDecode, true);
    assert.equal(pipeline.decode.hardware, true);
    assert.equal(pipeline.hardwareEncode, true);
    assert.ok(pipeline.decode.name);
    assert.ok(pipeline.filter.name);
    assert.ok(pipeline.upload.name);
    assert.ok(pipeline.encode.name);
  }

  const nvenc = videoPipeline({ ...encoderCandidates("win32", "nvenc")[0], hardware: true });
  assert.deepEqual(nvenc.decode.arguments, ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
  assert.deepEqual(nvenc.filter.arguments, ["-vf", "scale_cuda=format=yuv420p"]);
  assert.equal(nvenc.filter.hardware, true);
  assert.equal(nvenc.upload.arguments.length, 0);
  assert.notDeepEqual(nvenc.filter.arguments, ["-vf", "format=yuv420p"]);

  const vaapiEncoder = { ...encoderCandidates("linux", "vaapi")[0], hardware: true };
  const vaapi = videoPipeline(vaapiEncoder);
  assert.equal(vaapi.filter.hardware, true);
  assert.match(vaapi.filter.arguments.join(" "), /scale_vaapi/);
  assert.equal(vaapi.upload.hardware, false);
  assert.equal([...vaapi.filter.arguments, ...vaapi.encode.arguments]
    .filter((argument) => argument === "-vf").length, 1);

  const vaapiSoftwareDecode = videoPipeline(vaapiEncoder, { hardwareDecode: false });
  assert.equal(vaapiSoftwareDecode.hardwareDecode, false);
  assert.equal(vaapiSoftwareDecode.hardwareEncode, true);
  assert.equal(vaapiSoftwareDecode.upload.hardware, true);
  assert.match(vaapiSoftwareDecode.filter.arguments.join(" "), /format=nv12,hwupload/);

  const amf = videoPipeline({ ...encoderCandidates("win32", "amf")[0], hardware: true });
  assert.equal(amf.filter.arguments.includes("scale_d3d11=format=nv12"), false);

  const cpu = videoPipeline(CPU_ENCODER);
  assert.equal(cpu.hardwareDecode, false);
  assert.equal(cpu.decode.hardware, false);
  assert.equal(cpu.hardwareEncode, false);
});

function mockFfmpeg({ encoders = "h264_nvenc libx264", failHardwareProbe = false } = {}) {
  const calls = [];
  const run = async (_path, args) => {
    calls.push([...args]);
    if (args.includes("-version")) return { stdout: "ffmpeg version mock", stderr: "" };
    if (args.includes("-encoders")) return { stdout: encoders, stderr: "" };
    if (failHardwareProbe && args.includes("-hwaccel")) {
      const error = new Error("CUDA decoder unavailable");
      error.stderr = "No device available for decoder";
      throw error;
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

test("selects CUDA decode plus NVENC for a validated Windows NVIDIA source", async () => {
  const mock = mockFfmpeg();
  const runtime = await selectTranscodeRuntime({
    bundledPath: "mock-ffmpeg",
    configuredPath: null,
    systemPath: null,
    preference: "nvenc",
    platform: "win32",
    mediaPath: "C:\\\\WatchPair\\\\episode.mkv",
    sourceCodec: "hevc",
    sourcePixelFormat: "yuv420p10le",
    run: mock.run,
  });

  assert.equal(runtime.encoder.id, "nvenc");
  assert.equal(runtime.pipeline.hardwareDecode, true);
  assert.deepEqual(runtime.pipeline.decode.arguments, [
    "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
  ]);
  assert.equal(runtime.pipeline.filter.hardware, true);
  assert.equal(runtime.diagnostics.length, 0);
  const sourceProbe = mock.calls.find((args) => args.includes("C:\\\\WatchPair\\\\episode.mkv"));
  assert.ok(sourceProbe);
  assert.ok(sourceProbe.includes("scale_cuda=format=yuv420p"));
  assert.equal(sourceProbe.includes("format=yuv420p"), false);
});

test("reports source-aware fallback when hardware decode validation fails", async () => {
  const mock = mockFfmpeg({ failHardwareProbe: true });
  const runtime = await selectTranscodeRuntime({
    bundledPath: "mock-ffmpeg",
    configuredPath: null,
    systemPath: null,
    preference: "nvenc",
    platform: "win32",
    source: { path: "/media/episode.mkv", codec: "hevc", pixelFormat: "yuv420p" },
    run: mock.run,
  });

  assert.equal(runtime.encoder.id, "nvenc");
  assert.equal(runtime.encoder.hardware, true);
  assert.equal(runtime.hardwareDecode, false);
  assert.equal(runtime.pipeline.hardwareDecode, false);
  assert.deepEqual(runtime.pipeline.decode.arguments, []);
  assert.equal(runtime.diagnostics[0].code, "hardware_pipeline_probe_failed");
  assert.equal(publicTranscoder(runtime).hardwareDecode, false);
});

test("rejects a source format that cannot be claimed as zero-copy", async () => {
  const mock = mockFfmpeg();
  const result = await validateVideoPipeline(
    "mock-ffmpeg",
    { ...encoderCandidates("win32", "nvenc")[0], hardware: true },
    { path: "episode.mkv", codec: "hevc", pixelFormat: "yuv444p" },
    { run: mock.run }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason.code, "source_pixel_format_not_supported_by_hardware_path");
  assert.equal(result.pipeline.hardwareDecode, false);
  assert.equal(mock.calls.length, 0);
});
