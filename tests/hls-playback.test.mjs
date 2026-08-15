import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import {
  canCopyH264Video,
  createHlsPlaybackManager,
  startsAtBrowserZero,
} from "../agent/hls-playback.mjs";

const runFile = promisify(execFile);

async function readPlaylist(filePath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!["EAGAIN", "ENODATA", "ENOENT"].includes(error?.code) || attempt === 49) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Playlist could not be read.");
}

async function waitFor(check, message, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function playlistAssetNames(playlist) {
  return Array.from(
    String(playlist).matchAll(/(?:URI="([^"]+)"|^(epoch-\d{6}-segment-\d{6}\.m4s)$)/gm),
    (match) => match[1] || match[2]
  );
}

function playlistDuration(playlist) {
  return Array.from(String(playlist).matchAll(/^#EXTINF:([\d.]+)/gm))
    .reduce((total, match) => total + Number(match[1]), 0);
}

async function createInput(filePath, {
  duration = 6,
  audioTracks = 1,
  timestampOffset = 0,
  frameRate = "24",
  videoSize = "320x180",
} = {}) {
  const argumentsList = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    "testsrc2=size=" + videoSize + ":rate=" + frameRate + ":duration=" + duration,
  ];
  for (let index = 0; index < audioTracks; index += 1) {
    argumentsList.push(
      "-f", "lavfi", "-i",
      "sine=frequency=" + (440 + index * 220) +
        ":sample_rate=48000:duration=" + duration
    );
  }
  argumentsList.push("-map", "0:v:0");
  for (let index = 0; index < audioTracks; index += 1) {
    argumentsList.push("-map", String(index + 1) + ":a:0");
  }
  argumentsList.push(
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-g", "24", "-keyint_min", "24", "-sc_threshold", "0",
    "-c:a", "aac", "-shortest"
  );
  if (timestampOffset) {
    argumentsList.push("-output_ts_offset", String(timestampOffset));
  }
  argumentsList.push(filePath);
  await runFile(ffmpegPath, argumentsList);
}

async function firstVideoPacket(manager, descriptor, playlist, directory, epochIndex) {
  const prefix = "epoch-" + String(epochIndex).padStart(6, "0");
  const initName = prefix + "-init.mp4";
  const segmentName = prefix + "-segment-000000.m4s";
  assert.match(playlist, new RegExp(initName.replaceAll(".", "\\.")));
  assert.match(playlist, new RegExp(segmentName.replaceAll(".", "\\.")));
  const [init, segment] = await Promise.all([
    manager.getAsset(descriptor, "video/" + initName),
    manager.getAsset(descriptor, "video/" + segmentName),
  ]);
  const fragment = path.join(directory, prefix + "-first.mp4");
  await writeFile(fragment, Buffer.concat([
    await readFile(init.filePath),
    await readFile(segment.filePath),
  ]));
  const result = JSON.parse((await runFile(ffprobeStatic.path, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "packet=pts_time,dts_time,flags",
    "-read_intervals", "%+#1",
    "-of", "json",
    fragment,
  ])).stdout);
  return result.packets?.[0];
}

function audioTrack(id, streamIndex, language, label, isDefault) {
  return {
    id: String(id),
    streamIndex,
    language,
    label,
    codec: "aac",
    channels: 1,
    default: isDefault,
  };
}

test("copies only browser-compatible eight-bit H.264 video", () => {
  assert.equal(startsAtBrowserZero({ videoStartTime: 0 }), true);
  assert.equal(startsAtBrowserZero({ videoStartTime: -0.25 }), true);
  assert.equal(startsAtBrowserZero({ videoStartTime: 0.05 }), true);
  assert.equal(startsAtBrowserZero({ videoStartTime: 0.051 }), false);
  assert.equal(startsAtBrowserZero({ videoStartTime: null }), false);
  assert.equal(startsAtBrowserZero({}), false);
  assert.equal(canCopyH264Video({
    videoCodec: "h264",
    videoPixelFormat: "yuv420p",
    videoProfile: "High",
    videoStartTime: 0,
  }), true);
  assert.equal(canCopyH264Video({
    videoCodec: "h264",
    videoPixelFormat: "yuv420p10le",
    videoProfile: "High 10",
    videoStartTime: 0,
  }), false);
  assert.equal(canCopyH264Video({
    videoCodec: "h264",
    videoPixelFormat: "yuv420p",
    videoProfile: "High",
  }), false);
  assert.equal(canCopyH264Video({
    videoCodec: "h264",
    videoPixelFormat: "yuv420p",
    videoProfile: "High",
    videoStartTime: 5,
  }), false);
});

test("publishes contiguous immutable epochs with every audio track", { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-epochs-"));
  const input = path.join(directory, "input.mkv");
  const cacheRoot = path.join(directory, "cache");
  const events = [];
  let manager;

  try {
    await createInput(input, { duration: 6, audioTracks: 2, timestampOffset: 5 });
    const descriptor = {
      jobId: "hls-epoch-test",
      fileIndex: 0,
      fileSize: (await stat(input)).size,
      contentFingerprint: "0123456789abcdef0123456789abcdef",
      inputPath: input,
      videoCodec: "h264",
      videoPixelFormat: "yuv420p",
      videoProfile: "High",
      videoStartTime: 5,
      inputArguments: ["-readrate", "1"],
      audioTracks: [
        audioTrack(1, 1, "jpn", "Japanese", true),
        audioTrack(2, 2, "eng", "English", false),
      ],
    };

    manager = createHlsPlaybackManager({
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      cacheRoot,
      encoder: {
        id: "test-gpu",
        codec: "test_gpu",
        label: "Test GPU",
        hardware: true,
        arguments: ["-c:v", "watchpair_missing_encoder"],
      },
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 2,
      playlistWaitMs: 15_000,
      onEvent: (event, data) => events.push({ event, data }),
    });

    const initial = await manager.prepare(descriptor);
    assert.equal(initial.status, "ready");
    assert.equal(initial.encoder.id, "cpu");
    assert.equal(initial.fallback, true);
    assert.ok(initial.contiguousReadySeconds >= 2);
    assert.ok(initial.sourceDuration >= 5.9 && initial.sourceDuration < 6.2);
    assert.equal(initial.committedEpochs, 1);
    assert.equal(initial.complete, false);

    const masterAsset = await manager.getAsset(descriptor, "master.m3u8");
    const master = await readPlaylist(masterAsset.filePath);
    assert.match(master, /TYPE=AUDIO.*NAME="Japanese".*DEFAULT=YES/);
    assert.match(master, /TYPE=AUDIO.*NAME="English".*DEFAULT=NO/);
    assert.match(master, /URI="audio\/1\/index\.m3u8"/);
    assert.match(master, /URI="audio\/2\/index\.m3u8"/);
    assert.equal((master.match(/EXT-X-STREAM-INF/g) || []).length, 1);

    const videoAsset = await manager.getAsset(descriptor, "video/index.m3u8");
    const japaneseAsset = await manager.getAsset(descriptor, "audio/1/index.m3u8");
    const englishAsset = await manager.getAsset(descriptor, "audio/2/index.m3u8");
    const earlyPlaylists = await Promise.all([
      readPlaylist(videoAsset.filePath),
      readPlaylist(japaneseAsset.filePath),
      readPlaylist(englishAsset.filePath),
    ]);
    for (const playlist of earlyPlaylists) {
      assert.match(playlist, /epoch-000000-init\.mp4/);
      assert.match(playlist, /epoch-000000-segment-000000\.m4s/);
    }
    assert.doesNotMatch(earlyPlaylists[0], /#EXT-X-ENDLIST/);

    await waitFor(async () => {
      const playlist = await readPlaylist(videoAsset.filePath);
      const preparation = await manager.getPreparation(descriptor);
      if (preparation.error) {
        assert.fail(preparation.error + "\n" + JSON.stringify(events));
      }
      return playlist.includes("#EXT-X-ENDLIST") ? playlist : null;
    }, "Epoch HLS preparation did not finish");

    const [video, japanese, english] = await Promise.all([
      readPlaylist(videoAsset.filePath),
      readPlaylist(japaneseAsset.filePath),
      readPlaylist(englishAsset.filePath),
    ]);
    for (const playlist of [video, japanese, english]) {
      assert.match(playlist, /#EXT-X-ENDLIST/);
      assert.equal((playlist.match(/#EXT-X-MAP/g) || []).length, 3);
      assert.equal((playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length, 2);
      const names = playlistAssetNames(playlist);
      assert.equal(new Set(names).size, names.length);
    }
    assert.ok(Math.abs(playlistDuration(video) - initial.sourceDuration) < 0.05);
    assert.ok(Math.abs(playlistDuration(japanese) - initial.sourceDuration) < 0.1);
    assert.ok(Math.abs(playlistDuration(english) - initial.sourceDuration) < 0.1);

    const manifest = JSON.parse(await readFile(
      path.join(path.dirname(videoAsset.filePath), "..", "manifest.json"),
      "utf8"
    ));
    let expectedSourceStart = 0;
    for (const epoch of manifest.epochs) {
      assert.ok(Math.abs(epoch.sourceStart - expectedSourceStart) <= 0.001);
      for (const stream of [
        epoch.streams.video,
        epoch.streams.audio["1"],
        epoch.streams.audio["2"],
      ]) {
        const segmentDuration = stream.segments.reduce(
          (total, segment) => total + segment.duration,
          0
        );
        assert.ok(Math.abs(stream.presentationDuration - segmentDuration) <= 0.001);
      }
      expectedSourceStart += epoch.streams.video.presentationDuration;
    }

    for (const name of playlistAssetNames(video)) {
      assert.ok(
        (await stat(path.join(path.dirname(videoAsset.filePath), name))).size > 0,
        "Published playlist references a missing asset: " + name
      );
    }
    for (let epochIndex = 0; epochIndex < 3; epochIndex += 1) {
      const packet = await firstVideoPacket(
        manager,
        descriptor,
        video,
        directory,
        epochIndex
      );
      assert.ok(packet, "Epoch " + epochIndex + " has no first video packet");
      assert.match(packet.flags, /K/);
      assert.ok(
        Math.abs(Number(packet.pts_time)) <= 0.001,
        "Epoch " + epochIndex + " starts at PTS " + packet.pts_time
      );
      assert.ok(Math.abs(Number(packet.dts_time)) <= 0.001);
    }

    const diagnostics = manager.diagnostics();
    assert.equal(diagnostics.generations[0].complete, true);
    assert.equal(diagnostics.generations[0].committedEpochs, 3);
    assert.ok(diagnostics.processes.active.length <= 1);
    const epochProcesses = diagnostics.processes.recent.filter(
      (record) => record.stage === "browser-playback-epoch"
    );
    assert.ok(epochProcesses.length >= 3);
    assert.ok(epochProcesses.every(
      (record) => !record.arguments.includes("append_list")
    ));
    assert.ok(events.some(({ event }) => event === "hls_epoch_committed"));

    const completed = await manager.prepare(descriptor);
    await manager.shutdown();
    manager = null;

    const cachedManager = createHlsPlaybackManager({
      ffmpegPath: path.join(directory, "missing-ffmpeg"),
      cacheRoot,
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 2,
      playlistWaitMs: 1_000,
    });
    try {
      const equivalent = {
        ...descriptor,
        jobId: "equivalent-job",
        sourceDuration: completed.sourceDuration,
      };
      const cachedVideo = await cachedManager.getAsset(
        equivalent,
        "video/index.m3u8"
      );
      assert.equal(cachedVideo.filePath, videoAsset.filePath);
      assert.match(await readPlaylist(cachedVideo.filePath), /#EXT-X-ENDLIST/);
      await cachedManager.removeJob(equivalent.jobId);
      assert.match(await readPlaylist(cachedVideo.filePath), /#EXT-X-ENDLIST/);
    } finally {
      await cachedManager.shutdown();
    }
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps fractional-rate AV timelines aligned across 30-second epochs", { timeout: 90_000 }, async (t) => {
  const cases = [
    { label: "23.976 fps", rate: "24000/1001", fps: 24000 / 1001 },
    { label: "29.97 fps", rate: "30000/1001", fps: 30000 / 1001 },
    { label: "25 fps", rate: "25", fps: 25 },
  ];

  for (const [caseIndex, frameRate] of cases.entries()) {
    await t.test(frameRate.label, { timeout: 30_000 }, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-rate-"));
      const input = path.join(directory, "input.mkv");
      const requestedInputDuration = 96;
      const sourceFrames = Math.ceil(requestedInputDuration * frameRate.fps - 1e-9);
      const sourceDuration = sourceFrames / frameRate.fps;
      let manager;

      try {
        await createInput(input, {
          duration: requestedInputDuration,
          audioTracks: 1,
          frameRate: frameRate.rate,
          videoSize: "160x90",
        });
        const descriptor = {
          jobId: "fractional-rate-" + caseIndex,
          fileIndex: 0,
          fileSize: (await stat(input)).size,
          contentFingerprint: String(caseIndex + 1).repeat(32),
          inputPath: input,
          sourceDuration,
          videoCodec: "mpeg4",
          videoPixelFormat: "yuv420p",
          videoProfile: "Simple Profile",
          videoStartTime: 0,
          audioTracks: [audioTrack(1, 1, "eng", "English", true)],
        };
        manager = createHlsPlaybackManager({
          ffmpegPath,
          ffprobePath: ffprobeStatic.path,
          cacheRoot: path.join(directory, "cache"),
          segmentSeconds: 4,
          epochSeconds: 30,
          playableSeconds: 30,
          playlistWaitMs: 10_000,
        });

        await manager.prepare(descriptor);
        await waitFor(
          () => manager.diagnostics().generations[0]?.complete,
          frameRate.label + " generation did not complete"
        );
        const videoAsset = await manager.getAsset(descriptor, "video/index.m3u8");
        const audioAsset = await manager.getAsset(descriptor, "audio/1/index.m3u8");
        const playlist = await readPlaylist(videoAsset.filePath);
        const audioPlaylist = await readPlaylist(audioAsset.filePath);
        const manifest = JSON.parse(await readFile(
          path.join(path.dirname(videoAsset.filePath), "..", "manifest.json"),
          "utf8"
        ));

        assert.ok(manifest.epochs.length >= 4, JSON.stringify(manifest));
        let presentationStart = 0;
        let audioPresentationDuration = 0;
        for (const epoch of manifest.epochs) {
          assert.ok(
            Math.abs(epoch.sourceStart - presentationStart) <= 0.001,
            frameRate.label + " epoch " + epoch.index +
              " starts at source " + epoch.sourceStart +
              " but begins at presentation time " + presentationStart
          );
          const segmentDuration = epoch.streams.video.segments.reduce(
            (total, segment) => total + segment.duration,
            0
          );
          assert.ok(
            Math.abs(epoch.streams.video.presentationDuration - segmentDuration) <= 0.001
          );
          const audio = epoch.streams.audio["1"];
          const audioSegmentDuration = audio.segments.reduce(
            (total, segment) => total + segment.duration,
            0
          );
          assert.ok(Math.abs(audio.presentationDuration - audioSegmentDuration) <= 0.001);
          audioPresentationDuration += audio.presentationDuration;
          assert.ok(epoch.sourceDuration <= 30.001);
          presentationStart += epoch.streams.video.presentationDuration;
        }

        const frameDuration = 1 / frameRate.fps;
        assert.ok(
          Math.abs(playlistDuration(playlist) - presentationStart) <= 0.001
        );
        assert.ok(
          Math.abs(playlistDuration(audioPlaylist) - audioPresentationDuration) <= 0.001
        );
        assert.ok(
          Math.abs(presentationStart - sourceDuration) <= frameDuration + 0.002,
          frameRate.label + " presentation differs from source by " +
            Math.abs(presentationStart - sourceDuration) + " seconds"
        );
        const maximumAvQuantization =
          manifest.epochs.length * (1024 / 48_000) + frameDuration + 0.002;
        assert.ok(
          Math.abs(audioPresentationDuration - presentationStart) <= maximumAvQuantization,
          frameRate.label + " audio and video timelines differ by " +
            Math.abs(audioPresentationDuration - presentationStart) + " seconds"
        );
        if (frameRate.rate.includes("/")) {
          const lastEpoch = manifest.epochs.at(-1);
          assert.ok(
            Math.abs(lastEpoch.sourceStart - lastEpoch.index * 30) > frameDuration,
            frameRate.label + " did not exercise accumulated frame-boundary compensation"
          );
        }
      } finally {
        await manager?.shutdown();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("reports a later epoch failure while preserving the committed playable prefix", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-late-failure-"));
  const input = path.join(directory, "input.mkv");
  let manager;
  let removedInput = false;

  try {
    await createInput(input, { duration: 4, audioTracks: 1 });
    const descriptor = {
      jobId: "hls-late-failure-test",
      fileIndex: 0,
      fileSize: (await stat(input)).size,
      contentFingerprint: "dddddddddddddddddddddddddddddddd",
      inputPath: input,
      sourceDuration: 4,
      videoCodec: "mpeg4",
      videoPixelFormat: "yuv420p",
      videoProfile: "Simple Profile",
      videoStartTime: 0,
      audioTracks: [audioTrack(1, 1, "eng", "English", true)],
    };
    manager = createHlsPlaybackManager({
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      cacheRoot: path.join(directory, "cache"),
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 2,
      playlistWaitMs: 5_000,
      onEvent: (event, details) => {
        if (event === "hls_epoch_committed" && details.epochIndex === 0 && !removedInput) {
          removedInput = true;
          rmSync(input, { force: true });
        }
      },
    });

    const initial = await manager.prepare(descriptor);
    assert.equal(initial.status, "ready");
    assert.equal(initial.complete, false);
    const failed = await waitFor(
      async () => {
        const preparation = await manager.getPreparation(descriptor);
        return preparation.error ? preparation : null;
      },
      "A failure after the first committed epoch was not reported"
    );
    assert.equal(failed.status, "ready");
    assert.equal(failed.complete, false);
    assert.equal(failed.committedEpochs, 1);
    assert.match(failed.error, /HLS epoch 2/i);

    const videoAsset = await manager.getAsset(descriptor, "video/index.m3u8");
    const playlist = await readPlaylist(videoAsset.filePath);
    assert.equal((playlist.match(/#EXT-X-MAP/g) || []).length, 1);
    assert.doesNotMatch(playlist, /#EXT-X-ENDLIST/);
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a complete v12 generation with an invalid terminal duration", { timeout: 8_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-invalid-"));
  const cacheRoot = path.join(directory, "cache");
  const fingerprint = "cccccccccccccccccccccccccccccccc";
  const fileSize = 12345;
  const invalidGenerationId = "11111111-1111-1111-1111-111111111111";
  const baseDirectory = path.join(
    cacheRoot,
    "content",
    fingerprint + "-" + fileSize,
    "h264-hls-v12"
  );
  const invalidDirectory = path.join(
    baseDirectory,
    "generations",
    invalidGenerationId
  );
  const events = [];
  let manager;

  try {
    await mkdir(path.join(invalidDirectory, "video"), { recursive: true });
    await writeFile(
      path.join(invalidDirectory, "video", "epoch-000000-init.mp4"),
      "fake-init"
    );
    await writeFile(
      path.join(invalidDirectory, "video", "epoch-000000-segment-000000.m4s"),
      "fake-segment"
    );
    await writeFile(path.join(invalidDirectory, "manifest.json"), JSON.stringify({
      cacheVersion: "hls-v12",
      generationId: invalidGenerationId,
      fileSize,
      contentFingerprint: fingerprint,
      rendition: "h264",
      sourceDuration: 4,
      epochSeconds: 2,
      segmentSeconds: 1,
      audioTrackIds: [],
      epochs: [{
        index: 0,
        sourceStart: 0,
        sourceDuration: 2,
        validatedStart: true,
        streams: {
          video: {
            init: "epoch-000000-init.mp4",
            presentationDuration: 5.5,
            segments: [{
              uri: "epoch-000000-segment-000000.m4s",
              duration: 5.5,
            }],
          },
          audio: {},
        },
      }],
      complete: true,
    }));
    await Promise.all([
      writeFile(
        path.join(baseDirectory, "current.json"),
        JSON.stringify({ generationId: invalidGenerationId })
      ),
      writeFile(
        path.join(baseDirectory, "working.json"),
        JSON.stringify({ generationId: invalidGenerationId })
      ),
    ]);

    manager = createHlsPlaybackManager({
      ffmpegPath,
      cacheRoot,
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 1,
      playlistWaitMs: 1_000,
      onEvent: (event, data) => events.push({ event, data }),
    });
    await assert.rejects(manager.prepare({
      jobId: "invalid-start-job",
      fileIndex: 0,
      fileSize,
      contentFingerprint: fingerprint,
      inputPath: path.join(directory, "missing-input.mkv"),
      sourceDuration: 4,
      videoCodec: "hevc",
      videoPixelFormat: "yuv420p10le",
      videoProfile: "Main 10",
      videoStartTime: 0,
      audioTracks: [],
    }));

    const started = events.find(({ event }) => event === "hls_generation_started");
    assert.ok(started, JSON.stringify(events));
    assert.notEqual(started.data.generationId, invalidGenerationId);
    assert.equal(
      events.some(({ event }) => event === "hls_generation_promoted"),
      false
    );
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("hands selected work over at an epoch boundary without mutating the background playlist", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-priority-"));
  const input = path.join(directory, "input.mkv");
  const cacheRoot = path.join(directory, "cache");
  const events = [];
  let manager;

  try {
    await createInput(input, { duration: 8, audioTracks: 1 });
    const fileSize = (await stat(input)).size;
    const common = {
      fileIndex: 0,
      fileSize,
      inputPath: input,
      sourceDuration: 8,
      videoCodec: "mpeg4",
      videoPixelFormat: "yuv420p",
      videoProfile: "Simple Profile",
      videoStartTime: 0,
      audioTracks: [audioTrack(1, 1, "eng", "English", true)],
    };
    const background = {
      ...common,
      jobId: "background-epoch-test",
      contentFingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      inputArguments: ["-readrate", "1"],
    };
    const foreground = {
      ...common,
      jobId: "foreground-epoch-test",
      contentFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      inputArguments: ["-readrate", "8"],
    };

    manager = createHlsPlaybackManager({
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      cacheRoot,
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 2,
      playlistWaitMs: 10_000,
      onEvent: (event, data) => events.push({ event, data }),
    });

    const firstBackgroundWindow = await manager.prepare(background);
    assert.equal(firstBackgroundWindow.committedEpochs, 1);
    const backgroundAsset = await manager.getAsset(
      background,
      "video/index.m3u8"
    );
    const stablePath = backgroundAsset.filePath;

    const foregroundPreparation = manager.prepare(foreground);
    manager.setPriorityJob(foreground.jobId);
    const firstForegroundWindow = await foregroundPreparation;
    assert.equal(firstForegroundWindow.status, "ready");
    assert.equal(firstForegroundWindow.committedEpochs, 1);

    const commits = events.filter(({ event }) => event === "hls_epoch_committed");
    const firstForegroundCommit = commits.findIndex(
      ({ data }) => data.jobId === foreground.jobId
    );
    const thirdBackgroundCommit = commits.findIndex(
      ({ data }) => data.jobId === background.jobId && data.epochIndex === 2
    );
    assert.ok(firstForegroundCommit >= 0, JSON.stringify(commits));
    assert.ok(
      thirdBackgroundCommit < 0 || firstForegroundCommit < thirdBackgroundCommit,
      JSON.stringify(commits)
    );
    assert.ok(
      events.some(({ event }) => event === "media_task_preemption_deferred"),
      JSON.stringify(events)
    );
    assert.equal(
      events.some(({ event }) => event === "media_task_preempted"),
      false
    );

    await waitFor(
      () => manager.diagnostics().generations.every(
        (generation) => generation.complete
      ),
      "Both epoch render queues did not finish",
      30_000
    );
    const retained = await manager.getAsset(background, "video/index.m3u8");
    assert.equal(retained.filePath, stablePath);
    const playlist = await readPlaylist(retained.filePath);
    assert.match(playlist, /#EXT-X-ENDLIST/);
    assert.ok((playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length >= 3);

    const processes = manager.diagnostics().processes.recent.filter(
      (record) => record.stage === "browser-playback-epoch"
    );
    assert.ok(processes.length >= 8, JSON.stringify(processes));
    assert.ok(processes.every(
      (record) => !record.arguments.includes("append_list")
    ));
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumes only committed epochs after restart and discards a stale writer workspace", { timeout: 35_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-restart-"));
  const input = path.join(directory, "input.mkv");
  const cacheRoot = path.join(directory, "cache");
  const fingerprint = "dddddddddddddddddddddddddddddddd";
  const events = [];
  let firstManager;
  let secondManager;

  try {
    await createInput(input, { duration: 6, audioTracks: 1 });
    const descriptor = {
      jobId: "restart-epoch-test",
      fileIndex: 0,
      fileSize: (await stat(input)).size,
      contentFingerprint: fingerprint,
      inputPath: input,
      sourceDuration: 6,
      videoCodec: "mpeg4",
      videoPixelFormat: "yuv420p",
      videoProfile: "Simple Profile",
      videoStartTime: 0,
      inputArguments: ["-readrate", "1"],
      audioTracks: [audioTrack(1, 1, "eng", "English", true)],
    };
    const options = {
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      cacheRoot,
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 2,
      playlistWaitMs: 10_000,
    };

    firstManager = createHlsPlaybackManager(options);
    const firstWindow = await firstManager.prepare(descriptor);
    assert.equal(firstWindow.committedEpochs, 1);
    const generationId = firstWindow.generationId;
    await firstManager.shutdown();
    firstManager = null;

    const generationPath = path.join(
      cacheRoot,
      "content",
      fingerprint + "-" + descriptor.fileSize,
      "h264-hls-v12",
      "generations",
      generationId
    );
    const manifestBefore = JSON.parse(
      await readFile(path.join(generationPath, "manifest.json"), "utf8")
    );
    assert.ok(manifestBefore.epochs.length >= 1);
    assert.equal(manifestBefore.complete, false);
    const staleDirectory = path.join(generationPath, ".working", "stale-attempt");
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(path.join(staleDirectory, "partial.m4s"), "partial");
    await writeFile(path.join(generationPath, "writer.json"), JSON.stringify({
      cacheVersion: "hls-v12",
      generationId,
      token: "stale-token",
      epochIndex: manifestBefore.epochs.length,
      pid: 999999,
      startedAt: Date.now() - 60_000,
    }));

    secondManager = createHlsPlaybackManager({
      ...options,
      onEvent: (event, data) => events.push({ event, data }),
    });
    const resumedDescriptor = {
      ...descriptor,
      inputArguments: ["-readrate", "8"],
    };
    const resumedWindow = await secondManager.prepare(resumedDescriptor);
    assert.equal(resumedWindow.generationId, generationId);
    assert.equal(resumedWindow.resumed, true);
    assert.ok(resumedWindow.resumeSeconds >= 2);
    assert.ok(events.some(
      ({ event, data }) =>
        event === "hls_stale_writer_recovered" &&
        data.generationId === generationId
    ));

    await waitFor(
      () => secondManager.diagnostics().generations[0]?.complete,
      "Restarted epoch generation did not complete"
    );
    const video = await secondManager.getAsset(
      resumedDescriptor,
      "video/index.m3u8"
    );
    const playlist = await readPlaylist(video.filePath);
    assert.match(playlist, /#EXT-X-ENDLIST/);
    assert.equal((playlist.match(/#EXT-X-MAP/g) || []).length, 3);
    assert.equal((playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length, 2);
    assert.equal(
      await stat(path.join(generationPath, "writer.json"))
        .then(() => "present", (error) => error.code),
      "ENOENT"
    );
  } finally {
    await firstManager?.shutdown();
    await secondManager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
