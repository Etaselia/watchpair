import assert from "node:assert/strict";
import test from "node:test";
import {
  hlsAudioPreference,
  resolveHlsAudioChannelCount,
  shouldRetryHlsWithStereo,
  withStereoHlsAudio,
} from "../lib/hls-audio-fallback.mjs";

test("retries multichannel HLS MediaError code 4 once with stereo", () => {
  assert.equal(shouldRetryHlsWithStereo({
    isHlsPlayback: true,
    mediaErrorCode: 4,
    sourceChannels: 6,
    audioMode: "surround",
  }), true);
  assert.equal(shouldRetryHlsWithStereo({
    isHlsPlayback: true,
    mediaErrorCode: 4,
    sourceChannels: 8,
    audioMode: "stereo",
  }), false);
});

test("retries a fatal HLS media failure before native MediaError is available", () => {
  assert.equal(shouldRetryHlsWithStereo({
    isHlsPlayback: true,
    fatalHlsMediaError: true,
    sourceChannels: 6,
    audioMode: "surround",
  }), true);
  assert.equal(shouldRetryHlsWithStereo({
    isHlsPlayback: true,
    fatalHlsMediaError: true,
    sourceChannels: 6,
    audioMode: "stereo",
  }), false);
});

test("does not mask unrelated or non-surround playback failures", () => {
  for (const options of [
    { isHlsPlayback: false, mediaErrorCode: 4, sourceChannels: 6, audioMode: "surround" },
    { isHlsPlayback: true, mediaErrorCode: 3, sourceChannels: 6, audioMode: "surround" },
    { isHlsPlayback: true, mediaErrorCode: 4, sourceChannels: 2, audioMode: "surround" },
    { isHlsPlayback: true, fatalHlsMediaError: true, sourceChannels: 2, audioMode: "surround" },
  ]) {
    assert.equal(shouldRetryHlsWithStereo(options), false);
  }
});

test("adds the local stereo rendition without discarding existing URL state", () => {
  const url = withStereoHlsAudio(
    "https://companion.invalid/hls/job/0/h264/master.m3u8?token=example#playback"
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("audio"), "stereo");
  assert.equal(parsed.searchParams.get("token"), "example");
  assert.equal(parsed.hash, "#playback");
});

test("builds an initial HLS preference for the requested source track", () => {
  assert.deepEqual(
    hlsAudioPreference({ label: "English commentary", language: "ENG" }),
    { name: "English commentary", lang: "eng" }
  );
  assert.deepEqual(
    hlsAudioPreference({ label: "Original", language: "und" }),
    { name: "Original" }
  );
});

test("prefers the active HLS rendition channel count over source metadata", () => {
  assert.equal(resolveHlsAudioChannelCount("2", 6), 2);
  assert.equal(resolveHlsAudioChannelCount("8/JOC", 2), 8);
  assert.equal(resolveHlsAudioChannelCount(undefined, 6), 6);
  assert.equal(resolveHlsAudioChannelCount(undefined, undefined), 0);
});
