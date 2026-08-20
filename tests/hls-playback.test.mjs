import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
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
  hlsTerminalDurationTolerance,
  isPrivatePathCandidate,
  isWithinHlsTerminalDuration,
  manifestPreparedSeconds,
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
    "-c:a", "aac"
  );
  if (timestampOffset) {
    argumentsList.push("-output_ts_offset", String(timestampOffset));
  }
  argumentsList.push(filePath);
  await runFile(ffmpegPath, argumentsList);
}

async function createSurroundInput(filePath, {
  duration = 1.5,
  channelLayout = "5.1(side)",
  audioCodec = "ac3",
} = {}) {
  const argumentsList = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    "testsrc2=size=320x180:rate=24:duration=" + duration,
    "-f", "lavfi", "-i",
    "anullsrc=r=48000:cl=" + channelLayout,
    "-map", "0:v:0", "-map", "1:a:0", "-t", String(duration),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-g", "24", "-keyint_min", "24", "-sc_threshold", "0",
    "-c:a", audioCodec,
  ];
  if (audioCodec === "ac3") argumentsList.push("-b:a", "384k");
  argumentsList.push(filePath);
  await runFile(ffmpegPath, argumentsList);
}

async function probeAudioInit(manager, descriptor, trackId = "1") {
  const asset = await manager.getAsset(
    descriptor,
    "audio/" + trackId + "/epoch-000000-init.mp4"
  );
  const result = JSON.parse((await runFile(ffprobeStatic.path, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,channels,channel_layout,extradata",
    "-show_data",
    "-of", "json",
    asset.filePath,
  ])).stdout);
  const stream = result.streams?.[0];
  const firstWord = /00000000:\s*([0-9a-fA-F]{4})/.exec(stream?.extradata || "")?.[1];
  assert.ok(firstWord, JSON.stringify(stream));
  return {
    ...stream,
    channelConfiguration: (Number.parseInt(firstWord, 16) >> 3) & 0x0f,
  };
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

function audioTrack(
  id,
  streamIndex,
  language,
  label,
  isDefault,
  { codec = "aac", channels = 1, channelLayout = "mono" } = {}
) {
  return {
    id: String(id),
    streamIndex,
    language,
    label,
    codec,
    channels,
    channelLayout,
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

test("uses one bounded terminal-duration policy at the validation boundary", () => {
  const sourceDuration = 96;
  const segmentSeconds = 4;
  const tolerance = hlsTerminalDurationTolerance(segmentSeconds);
  const boundaryDelta = 0.000001;

  assert.equal(tolerance, 0.4);
  assert.equal(
    isWithinHlsTerminalDuration(
      sourceDuration,
      sourceDuration - tolerance + boundaryDelta,
      segmentSeconds
    ),
    true
  );
  assert.equal(
    isWithinHlsTerminalDuration(
      sourceDuration,
      sourceDuration + tolerance - boundaryDelta,
      segmentSeconds
    ),
    true
  );
  assert.equal(
    isWithinHlsTerminalDuration(
      sourceDuration,
      sourceDuration - tolerance - boundaryDelta,
      segmentSeconds
    ),
    false
  );
  assert.equal(
    isWithinHlsTerminalDuration(
      sourceDuration,
      sourceDuration + tolerance + boundaryDelta,
      segmentSeconds
    ),
    false
  );
});

test("ignores unsafe redaction roots while retaining media paths", () => {
  const filesystemRoot = path.parse(path.resolve(process.cwd())).root;

  for (const unsafe of [
    "",
    ".",
    "./",
    "..",
    "../",
    "../..",
    filesystemRoot,
    filesystemRoot.replaceAll("\\", "/"),
    "C:",
    "C:\\",
    "C:/",
    "\\\\server\\share",
    "\\\\server\\share\\",
  ]) {
    assert.equal(isPrivatePathCandidate(unsafe), false, JSON.stringify(unsafe));
  }

  for (const mediaPath of [
    path.join(filesystemRoot, "private-media", "video.mkv"),
    path.join("relative-media", "video.mkv"),
    path.join("..", "relative-media", "video.mkv"),
    "C:\\private-media\\video.mkv",
    "\\\\server\\share\\video.mkv",
  ]) {
    assert.equal(isPrivatePathCandidate(mediaPath), true, JSON.stringify(mediaPath));
  }
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
      videoCodec: input,
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
        id: "nvenc",
        codec: "test_gpu",
        label: "Test GPU",
        hardware: true,
        arguments: ["-c:v", "watchpair_missing_encoder"],
      },
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 2.05,
      playlistWaitMs: 15_000,
      onEvent: (event, data) => events.push({ event, data }),
    });

    const initial = await manager.prepare(descriptor);
    assert.equal(initial.status, "ready");
    assert.equal(initial.encoder.id, "cpu");
    assert.equal(initial.fallback, true);
    assert.ok(initial.contiguousReadySeconds >= 1.8);
    assert.ok(
      initial.contiguousReadySeconds < 2.05,
      "the first window should exercise bounded playable-duration tolerance"
    );
    assert.ok(initial.sourceDuration >= 5.9 && initial.sourceDuration < 6.2);
    assert.equal(initial.committedEpochs, 1);
    assert.equal(initial.complete, false);
    const validationDiagnostic = initial.diagnostics.find(
      ({ code }) => code === "source_codec_not_supported_by_hardware_decoder"
    );
    assert.ok(validationDiagnostic, JSON.stringify(initial.diagnostics));
    assert.equal(validationDiagnostic.stage, "decode");
    assert.equal(validationDiagnostic.backend, "nvenc");
    assert.match(validationDiagnostic.message, /source codec \[private path\]/);
    const publicDiagnostics = JSON.stringify(initial.diagnostics);
    for (const privatePath of [input, cacheRoot, process.cwd()]) {
      assert.equal(publicDiagnostics.includes(privatePath), false, publicDiagnostics);
      assert.equal(
        publicDiagnostics.includes(privatePath.replaceAll("\\", "/")),
        false,
        publicDiagnostics
      );
    }

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
      const playlists = await Promise.all([
        readPlaylist(videoAsset.filePath),
        readPlaylist(japaneseAsset.filePath),
        readPlaylist(englishAsset.filePath),
      ]);
      const preparation = await manager.getPreparation(descriptor);
      if (preparation.error) {
        assert.fail(preparation.error + "\n" + JSON.stringify(events));
      }
      return playlists.every((playlist) => playlist.includes("#EXT-X-ENDLIST"))
        ? playlists
        : null;
    }, "Epoch HLS preparation did not finish");

    const [video, japanese, english] = await Promise.all([
      readPlaylist(videoAsset.filePath),
      readPlaylist(japaneseAsset.filePath),
      readPlaylist(englishAsset.filePath),
    ]);
    const manifest = JSON.parse(await readFile(
      path.join(path.dirname(videoAsset.filePath), "..", "manifest.json"),
      "utf8"
    ));
    const committedEpochs = manifest.epochs.length;
    assert.ok(committedEpochs >= 3);
    for (const playlist of [video, japanese, english]) {
      assert.match(playlist, /#EXT-X-ENDLIST/);
      assert.equal((playlist.match(/#EXT-X-MAP/g) || []).length, committedEpochs);
      assert.equal(
        (playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length,
        committedEpochs - 1
      );
      const names = playlistAssetNames(playlist);
      assert.equal(new Set(names).size, names.length);
    }
    const terminalVideoDifference = Math.abs(
      playlistDuration(video) - initial.sourceDuration
    );
    assert.ok(terminalVideoDifference < 0.05);
    const japaneseDuration = playlistDuration(japanese);
    const englishDuration = playlistDuration(english);
    assert.ok(Math.abs(japaneseDuration - initial.sourceDuration) < 0.25);
    assert.ok(Math.abs(englishDuration - initial.sourceDuration) < 0.25);
    assert.ok(Math.abs(japaneseDuration - englishDuration) <= 0.001);

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
    for (let epochIndex = 0; epochIndex < committedEpochs; epochIndex += 1) {
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
    assert.equal(diagnostics.generations[0].committedEpochs, committedEpochs);
    assert.ok(diagnostics.processes.active.length <= 1);
    const epochProcesses = diagnostics.processes.recent.filter(
      (record) => record.stage === "browser-playback-epoch"
    );
    assert.ok(epochProcesses.length >= committedEpochs);
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

test("canonicalizes 5.1(side) AAC and keeps an isolated stereo fallback", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-surround-"));
  const input = path.join(directory, "input.mkv");
  const cacheRoot = path.join(directory, "cache");
  let manager;

  try {
    await createSurroundInput(input);
    const common = {
      jobId: "surround-audio-test",
      fileIndex: 0,
      fileSize: (await stat(input)).size,
      contentFingerprint: "51515151515151515151515151515151",
      inputPath: input,
      sourceDuration: 1.5,
      videoCodec: "h264",
      videoPixelFormat: "yuv420p",
      videoProfile: "Constrained Baseline",
      videoStartTime: 0,
      rendition: "vp9",
      audioTracks: [audioTrack(1, 1, "eng", "English", true, {
        codec: "ac3",
        channels: 6,
        channelLayout: "5.1(side)",
      })],
    };
    const surround = { ...common, audioMode: "surround" };
    const stereo = { ...common, audioMode: "stereo" };
    manager = createHlsPlaybackManager({
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      cacheRoot,
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 1,
      playlistWaitMs: 10_000,
    });

    await manager.prepare(surround);
    const surroundAudio = await probeAudioInit(manager, surround);
    assert.equal(surroundAudio.codec_name, "aac");
    assert.equal(surroundAudio.channels, 6);
    assert.equal(surroundAudio.channel_layout, "5.1");
    assert.equal(surroundAudio.channelConfiguration, 6);
    const surroundProcess = manager.diagnostics().processes.recent.find(
      (record) => record.stage === "browser-playback-epoch" &&
        record.arguments.includes("pan=5.1|FL=FL|FR=FR|FC=FC|LFE=LFE|BL=SL|BR=SR,aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS")
    );
    assert.ok(surroundProcess, JSON.stringify(manager.diagnostics().processes.recent));
    assert.ok(surroundProcess.arguments.includes("384k"));
    const surroundMasterAsset = await manager.getAsset(surround, "master.m3u8");
    const surroundMaster = await readPlaylist(surroundMasterAsset.filePath);
    assert.match(surroundMaster, /CHANNELS="6"/);
    assert.doesNotMatch(surroundMaster, /audio=stereo/);

    await manager.prepare(stereo);
    const stereoAudio = await probeAudioInit(manager, stereo);
    assert.equal(stereoAudio.codec_name, "aac");
    assert.equal(stereoAudio.channels, 2);
    assert.equal(stereoAudio.channel_layout, "stereo");
    assert.equal(stereoAudio.channelConfiguration, 2);
    const stereoMasterAsset = await manager.getAsset(stereo, "master.m3u8");
    const stereoMaster = await readPlaylist(stereoMasterAsset.filePath);
    assert.match(stereoMaster, /CHANNELS="2"/);
    assert.match(stereoMaster, /audio\/1\/index\.m3u8\?audio=stereo/);
    assert.match(stereoMaster, /video\/index\.m3u8\?audio=stereo/);
    assert.notEqual(stereoMasterAsset.filePath, surroundMasterAsset.filePath);

    const stereoAudioPlaylist = await manager.getAsset(stereo, "audio/1/index.m3u8");
    const stereoVideoPlaylist = await manager.getAsset(stereo, "video/index.m3u8");
    for (const playlist of await Promise.all([
      readPlaylist(stereoAudioPlaylist.filePath),
      readPlaylist(stereoVideoPlaylist.filePath),
    ])) {
      assert.match(playlist, /epoch-000000-init\.mp4\?audio=stereo/);
      assert.match(playlist, /epoch-000000-segment-000000\.m4s\?audio=stereo/);
    }
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves canonical 7.1 AAC with a browser-safe ASC", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-seven-one-"));
  const input = path.join(directory, "input.mkv");
  let manager;

  try {
    await createSurroundInput(input, { channelLayout: "7.1", audioCodec: "flac" });
    const common = {
      jobId: "seven-one-audio-test",
      fileIndex: 0,
      fileSize: (await stat(input)).size,
      contentFingerprint: "71717171717171717171717171717171",
      inputPath: input,
      sourceDuration: 1.5,
      videoCodec: "h264",
      videoPixelFormat: "yuv420p",
      videoProfile: "Constrained Baseline",
      videoStartTime: 0,
      audioTracks: [audioTrack(1, 1, "eng", "English", true, {
        codec: "flac",
        channels: 8,
        channelLayout: "7.1",
      })],
    };
    manager = createHlsPlaybackManager({
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      cacheRoot: path.join(directory, "cache"),
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 1,
      playlistWaitMs: 10_000,
    });

    const surround = { ...common, audioMode: "surround" };
    await manager.prepare(surround);
    const surroundAudio = await probeAudioInit(manager, surround);
    assert.equal(surroundAudio.channels, 8);
    assert.equal(surroundAudio.channel_layout, "7.1");
    assert.equal(surroundAudio.channelConfiguration, 7);
    const surroundProcess = manager.diagnostics().processes.recent.find(
      (record) => record.stage === "browser-playback-epoch" &&
        record.arguments.includes("aformat=channel_layouts=7.1,aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS")
    );
    assert.ok(surroundProcess, JSON.stringify(manager.diagnostics().processes.recent));
    assert.ok(surroundProcess.arguments.includes("512k"));
    const surroundMaster = await manager.getAsset(surround, "master.m3u8");
    assert.match(await readPlaylist(surroundMaster.filePath), /CHANNELS="8"/);

    const stereo = { ...common, audioMode: "stereo" };
    await manager.prepare(stereo);
    const stereoAudio = await probeAudioInit(manager, stereo);
    assert.equal(stereoAudio.channels, 2);
    assert.equal(stereoAudio.channel_layout, "stereo");
    assert.equal(stereoAudio.channelConfiguration, 2);
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
        const terminalDifference = Math.abs(
          presentationStart - Number(manifest.sourceDuration)
        );
        assert.ok(
          isWithinHlsTerminalDuration(
            manifest.sourceDuration,
            presentationStart,
            manifest.segmentSeconds
          ),
          frameRate.label + " presentation differs from the probed source by " +
            terminalDifference + " seconds; tolerance is " +
            hlsTerminalDurationTolerance(manifest.segmentSeconds) + " seconds"
        );
        const maximumAvQuantization =
          (manifest.epochs.length + 1) * (1024 / 48_000) +
          frameDuration + 0.002;
        assert.ok(
          Math.abs(audioPresentationDuration - presentationStart) <= maximumAvQuantization,
          frameRate.label + " audio and video timelines differ by " +
            Math.abs(audioPresentationDuration - presentationStart) + " seconds"
        );
      } finally {
        await manager?.shutdown();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("advances a 20-minute fractional-rate timeline by measured presentation time", () => {
  const nominalEpochSeconds = 30;
  const frameDuration = 1001 / 24_000;
  const presentationDuration =
    Math.floor(nominalEpochSeconds / frameDuration) * frameDuration;
  const manifest = { epochs: [] };
  let expectedStart = 0;

  for (let index = 0; index < 40; index += 1) {
    manifest.epochs.push({
      index,
      sourceStart: expectedStart,
      sourceDuration: nominalEpochSeconds,
      streams: {
        video: { presentationDuration, segments: [] },
        audio: {},
      },
    });
    expectedStart = Math.round((expectedStart + presentationDuration) * 1_000_000) /
      1_000_000;
    assert.equal(manifestPreparedSeconds(manifest), expectedStart);
  }

  assert.ok(
    nominalEpochSeconds * manifest.epochs.length - expectedStart > 0.45,
    "the fixture must reproduce the reported long-form drift if nominal starts are used"
  );
});

test("reports a later epoch failure while preserving the committed playable prefix", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-late-failure-"));
  const input = path.join(directory, "input.mkv");
  const cacheRoot = path.join(directory, "cache");
  const events = [];
  const stateEvents = [];
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
      onState: (state, event) => stateEvents.push({ state, event }),
    };
    manager = createHlsPlaybackManager({
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      cacheRoot,
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 1,
      playlistWaitMs: 5_000,
      onEvent: (event, details) => {
        events.push({ event, data: details });
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
    assert.match(failed.error, /\[private path\]/);
    assert.equal(failed.error.includes(input), false);
    const failureDiagnostic = failed.diagnostics.find(
      ({ code }) => code === "hls_epoch_failed"
    );
    assert.ok(failureDiagnostic, JSON.stringify(failed.diagnostics));
    assert.equal(failureDiagnostic.stage, "browser-playback");
    assert.equal(failureDiagnostic.backend, "cpu");
    assert.equal(failureDiagnostic.message, failed.error);
    const publicPreparation = JSON.stringify(failed);
    for (const privatePath of [input, cacheRoot, process.cwd()]) {
      assert.equal(publicPreparation.includes(privatePath), false, publicPreparation);
      assert.equal(
        publicPreparation.includes(privatePath.replaceAll("\\", "/")),
        false,
        publicPreparation
      );
    }
    const failureEvent = events.find(({ event }) => event === "hls_generation_failed");
    assert.ok(failureEvent);
    assert.equal(failureEvent.data.error.includes(input), false);
    assert.equal(failureEvent.data.error, failed.error);
    const observerFailure = stateEvents.find(
      ({ event }) => event.event === "generation-failed"
    );
    assert.ok(observerFailure, JSON.stringify(stateEvents));
    assert.equal(observerFailure.state.error, failed.error);
    assert.deepEqual(observerFailure.state.diagnostics, failed.diagnostics);

    const videoAsset = await manager.getAsset(descriptor, "video/index.m3u8");
    const playlist = await readPlaylist(videoAsset.filePath);
    assert.equal((playlist.match(/#EXT-X-MAP/g) || []).length, 1);
    assert.doesNotMatch(playlist, /#EXT-X-ENDLIST/);
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("redacts a private media path from source-probe failures", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-private-path-"));
  const input = path.join(directory, "private-video-title.mkv");
  const manager = createHlsPlaybackManager({
    ffmpegPath,
    ffprobePath: ffprobeStatic.path,
    cacheRoot: path.join(directory, "cache"),
  });

  try {
    const error = await manager.prepare({
      jobId: "private-path-test",
      fileIndex: 0,
      fileSize: 1,
      contentFingerprint: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      inputPath: input,
      videoCodec: "mpeg4",
      videoPixelFormat: "yuv420p",
      videoProfile: "Simple Profile",
      videoStartTime: 0,
      audioTracks: [],
    }).then(() => null, (failure) => failure);

    assert.ok(error instanceof Error);
    assert.equal(error.code, "WATCHPAIR_HLS_PIPELINE_FAILED");
    assert.notEqual(error.exitCode, 0);
    assert.match(error.message, /source-duration probe/i);
    assert.match(error.message, /\[private path\]/);
    assert.equal(error.message.includes(input), false);
    assert.equal(error.stack.includes(input), false);
    assert.equal(error.message.includes(ffprobeStatic.path), false);
    assert.equal(error.stack.includes(ffprobeStatic.path), false);
    assert.equal(error.stack.includes(process.cwd()), false);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sanitizes a task failure before shared scheduler telemetry", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-task-boundary-"));
  const input = path.join(directory, "private-input.mkv");
  const cacheRoot = path.join(directory, "private-cache");
  const fingerprint = "abababababababababababababababab";
  const privateCode = "WATCHPAIR_HLS_PRIVATE_BOUNDARY_TEST";
  const events = [];
  let generationPath;
  let workingDirectory;
  let manager;

  const descriptor = {
    jobId: "private-task-boundary-test",
    fileIndex: 0,
    fileSize: 1,
    contentFingerprint: fingerprint,
    inputPath: input,
    sourceDuration: 4,
    videoCodec: "mpeg4",
    videoPixelFormat: "yuv420p",
    videoProfile: "Simple Profile",
    videoStartTime: 0,
    audioTracks: [],
    inputArguments: {
      [Symbol.iterator]() {
        const workingRoot = path.join(generationPath, ".working");
        const attempt = readdirSync(workingRoot, { withFileTypes: true })
          .find((entry) => entry.isDirectory());
        assert.ok(attempt, "The task did not create its private working directory");
        workingDirectory = path.join(workingRoot, attempt.name);
        const error = new Error([
          privateCode,
          input,
          cacheRoot,
          generationPath,
          workingDirectory,
          ffmpegPath,
          ffprobeStatic.path,
          process.cwd(),
        ].join(" | "));
        error.code = privateCode;
        error.details = {
          input,
          cacheRoot,
          generationPath,
          workingDirectory,
          ffmpegPath,
          ffprobePath: ffprobeStatic.path,
        };
        throw error;
      },
    },
  };

  try {
    manager = createHlsPlaybackManager({
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      cacheRoot,
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 1,
      onEvent: (event, data) => {
        events.push({ event, data });
        if (event === "hls_generation_started") {
          generationPath = path.join(
            cacheRoot,
            "content",
            fingerprint + "-1",
            "h264-a-v13",
            "generations",
            data.generationId
          );
        }
      },
    });

    const preparationError = await manager.prepare(descriptor).then(
      () => null,
      (error) => error
    );
    assert.ok(preparationError instanceof Error);
    assert.equal(preparationError.code, privateCode);
    assert.match(preparationError.message, new RegExp(privateCode));

    const failedTask = events.find(({ event }) => event === "media_task_failed");
    assert.ok(failedTask, JSON.stringify(events));
    assert.match(failedTask.data.error, new RegExp(privateCode));
    const failedGeneration = events.find(
      ({ event }) => event === "hls_generation_failed"
    );
    assert.ok(failedGeneration, JSON.stringify(events));
    assert.equal(failedGeneration.data.errorCode, privateCode);

    const preparation = await manager.getPreparation(descriptor);
    assert.equal(preparation.error, preparationError.message);
    assert.equal(
      preparation.diagnostics.find(({ code }) => code === "hls_epoch_failed")?.message,
      preparationError.message
    );

    const publicValues = JSON.stringify({
      task: failedTask,
      generation: failedGeneration,
      preparation,
      error: {
        message: preparationError.message,
        stack: preparationError.stack,
        code: preparationError.code,
        details: preparationError.details,
      },
    });
    for (const privatePath of [
      input,
      cacheRoot,
      generationPath,
      workingDirectory,
      ffmpegPath,
      ffprobeStatic.path,
      process.cwd(),
    ]) {
      assert.equal(publicValues.includes(privatePath), false, publicValues);
      assert.equal(
        publicValues.includes(privatePath.replaceAll("\\", "/")),
        false,
        publicValues
      );
    }
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a complete v13 generation with an invalid terminal duration", { timeout: 8_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-invalid-"));
  const cacheRoot = path.join(directory, "cache");
  const fingerprint = "cccccccccccccccccccccccccccccccc";
  const fileSize = 12345;
  const invalidGenerationId = "11111111-1111-1111-1111-111111111111";
  const baseDirectory = path.join(
    cacheRoot,
    "content",
    fingerprint + "-" + fileSize,
    "h264-a-v13"
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
      cacheVersion: "hls-v13",
      generationId: invalidGenerationId,
      fileSize,
      contentFingerprint: fingerprint,
      rendition: "h264",
      audioMode: "surround",
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

    const missingInput = path.join(directory, "missing-input.mkv");
    manager = createHlsPlaybackManager({
      ffmpegPath,
      cacheRoot,
      segmentSeconds: 1,
      epochSeconds: 2,
      playableSeconds: 1,
      playlistWaitMs: 1_000,
      onEvent: (event, data) => events.push({ event, data }),
    });
    const descriptor = {
      jobId: "invalid-start-job",
      fileIndex: 0,
      fileSize,
      contentFingerprint: fingerprint,
      inputPath: missingInput,
      sourceDuration: 4,
      videoCodec: "hevc",
      videoPixelFormat: "yuv420p10le",
      videoProfile: "Main 10",
      videoStartTime: 0,
      audioTracks: [],
    };
    const preparationError = await manager.prepare(descriptor).then(
      () => null,
      (error) => error
    );
    assert.ok(preparationError instanceof Error);
    assert.equal(preparationError.code, "WATCHPAIR_HLS_PIPELINE_FAILED");
    assert.notEqual(preparationError.exitCode, 0);
    assert.match(preparationError.message, /\[private path\]/);
    assert.equal(preparationError.message.includes(missingInput), false);
    assert.equal(preparationError.stack.includes(process.cwd()), false);

    const failed = await manager.getPreparation(descriptor);
    assert.equal(failed.status, "error");
    assert.equal(failed.error, preparationError.message);
    const failureDiagnostic = failed.diagnostics.find(
      ({ code }) => code === "hls_epoch_failed"
    );
    assert.ok(failureDiagnostic, JSON.stringify(failed.diagnostics));
    assert.equal(failureDiagnostic.message, failed.error);
    const publicFailure = JSON.stringify({ failed, event: events.at(-1) });
    for (const privatePath of [missingInput, cacheRoot, process.cwd()]) {
      assert.equal(publicFailure.includes(privatePath), false, publicFailure);
      assert.equal(
        publicFailure.includes(privatePath.replaceAll("\\", "/")),
        false,
        publicFailure
      );
    }

    const started = events.find(({ event }) => event === "hls_generation_started");
    assert.ok(started, JSON.stringify(events));
    assert.notEqual(started.data.generationId, invalidGenerationId);
    assert.equal(
      events.some(({ event }) => event === "hls_generation_promoted"),
      false
    );
    const failureEvent = events.find(({ event }) => event === "hls_generation_failed");
    assert.ok(failureEvent, JSON.stringify(events));
    assert.equal(failureEvent.data.error, failed.error);
    assert.equal(failureEvent.data.errorCode, "WATCHPAIR_HLS_PIPELINE_FAILED");
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
      playableSeconds: 1,
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
      playableSeconds: 1,
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
      "h264-a-v13",
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
      cacheVersion: "hls-v13",
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
    assert.ok(
      resumedWindow.resumeSeconds >= firstWindow.contiguousReadySeconds - 0.001
    );
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
    const manifestAfter = JSON.parse(
      await readFile(path.join(generationPath, "manifest.json"), "utf8")
    );
    assert.match(playlist, /#EXT-X-ENDLIST/);
    assert.equal(
      (playlist.match(/#EXT-X-MAP/g) || []).length,
      manifestAfter.epochs.length
    );
    assert.equal(
      (playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length,
      manifestAfter.epochs.length - 1
    );
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
