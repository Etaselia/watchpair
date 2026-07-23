import assert from "node:assert/strict";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import {
  CPU_ENCODER,
  ENCODER_PROBE_SOURCE,
  encoderCandidates,
  selectTranscodeRuntime,
  videoEncoderArguments,
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
