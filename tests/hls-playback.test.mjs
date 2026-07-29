import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
} from "../agent/hls-playback.mjs";

const runFile = promisify(execFile);

async function readPlaylist(filePath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!["EAGAIN", "ENODATA", "ENOENT"].includes(error?.code) || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Playlist could not be read.");
}

test("copies only browser-compatible eight-bit H.264 video", () => {
  assert.equal(canCopyH264Video({
    videoCodec: "h264",
    videoPixelFormat: "yuv420p",
    videoProfile: "High",
  }), true);
  assert.equal(canCopyH264Video({
    videoCodec: "h264",
    videoPixelFormat: "yuv420p10le",
    videoProfile: "High 10",
  }), false);
});

test("progressively prepares one HLS video rendition with separate audio tracks", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-"));
  const input = path.join(directory, "input.mkv");
  const cacheRoot = path.join(directory, "cache");
  const descriptor = {
    jobId: "hls-test-job",
    fileIndex: 0,
    fileSize: 0,
    contentFingerprint: "0123456789abcdef0123456789abcdef",
    inputPath: input,
    videoCodec: "mpeg4",
    inputArguments: ["-readrate", "1"],
    audioTracks: [
      {
        id: "1",
        streamIndex: 1,
        language: "jpn",
        label: "Japanese",
        codec: "aac",
        channels: 1,
        default: true,
      },
      {
        id: "2",
        streamIndex: 2,
        language: "eng",
        label: "English",
        codec: "aac",
        channels: 1,
        default: false,
      },
    ],
  };

  let manager;
  try {
    await runFile(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=6",
      "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
      "-c:v", "mpeg4", "-q:v", "6",
      "-c:a", "aac", "-shortest",
      input,
    ]);

    descriptor.fileSize = (await stat(input)).size;

    manager = createHlsPlaybackManager({
      ffmpegPath,
      cacheRoot,
      encoder: {
        id: "test-gpu",
        codec: "test_gpu",
        label: "Test GPU",
        hardware: true,
        arguments: ["-c:v", "watchpair_missing_encoder"],
      },
      segmentSeconds: 1,
      playableSeconds: 2,
      playlistWaitMs: 15_000,
    });

    const masterAsset = await manager.getAsset(descriptor, "master.m3u8");
    const master = await readPlaylist(masterAsset.filePath);
    assert.match(master, /TYPE=AUDIO.*NAME="Japanese".*DEFAULT=YES/);
    assert.match(master, /TYPE=AUDIO.*NAME="English".*DEFAULT=NO/);
    assert.match(master, /URI="audio\/1\/index\.m3u8"/);
    assert.match(master, /URI="audio\/2\/index\.m3u8"/);
    assert.equal((master.match(/EXT-X-STREAM-INF/g) || []).length, 1);

    const initialPreparation = await manager.prepare(descriptor);
    assert.equal(initialPreparation.status, "ready");
    assert.equal(initialPreparation.encoder.id, "cpu");
    assert.equal(initialPreparation.hardwareDecode, false);
    assert.equal(initialPreparation.fallback, true);
    const initialDiagnostics = manager.diagnostics();
    assert.ok(initialDiagnostics.processes.active.length <= 1);
    assert.equal(initialDiagnostics.processes.active[0]?.stage, "video+audio", JSON.stringify(initialDiagnostics));

    const videoAsset = await manager.getAsset(descriptor, "video/index.m3u8");
    const earlyVideo = await readPlaylist(videoAsset.filePath);
    assert.doesNotMatch(earlyVideo, /#EXT-X-ENDLIST/, "playback should unlock before conversion finishes");
    const japaneseAsset = await manager.getAsset(descriptor, "audio/1/index.m3u8");
    const earlyJapanese = await readPlaylist(japaneseAsset.filePath);
    assert.match(earlyJapanese, /segment-000001\.m4s/);
    const englishAsset = await manager.getAsset(descriptor, "audio/2/index.m3u8");

    const [video, japanese, english] = await Promise.all([
      readPlaylist(videoAsset.filePath),
      readPlaylist(japaneseAsset.filePath),
      readPlaylist(englishAsset.filePath),
    ]);
    assert.match(video, /#EXT-X-PLAYLIST-TYPE:EVENT/);
    assert.match(video, /segment-000000\.m4s/);
    assert.match(video, /segment-000001\.m4s/);
    assert.match(japanese, /segment-000000\.m4s/);
    assert.match(english, /segment-000000\.m4s/);

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const playlists = await Promise.all([
        readPlaylist(videoAsset.filePath),
        readPlaylist(japaneseAsset.filePath),
        readPlaylist(englishAsset.filePath),
      ]);
      assert.ok(manager.diagnostics().processes.active.length <= 1);
      if (playlists.every((playlist) => playlist.includes("#EXT-X-ENDLIST"))) break;
      if (attempt === 199) assert.fail("HLS preparation did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const completedProcesses = manager.diagnostics().processes.recent
      .filter((record) => record.jobId === descriptor.jobId)
      .sort((left, right) => left.startedAt - right.startedAt);
    for (let index = 1; index < completedProcesses.length; index += 1) {
      assert.ok(completedProcesses[index - 1].finishedAt <= completedProcesses[index].startedAt);
    }

    const preparation = await manager.prepare(descriptor);
    assert.equal(preparation.status, "ready");
    assert.equal(preparation.encoder.id, "cpu");
    assert.equal(preparation.fallback, true);

    assert.ok((await stat(masterAsset.filePath)).size > 0);
    const probeAsset = async (filePath) => JSON.parse(
      (
        await runFile(ffprobeStatic.path, [
          "-v", "error",
          "-print_format", "json",
          "-show_streams",
          filePath,
        ])
      ).stdout
    );
    const [videoInit, audioInit] = await Promise.all([
      manager.getAsset(descriptor, "video/init.mp4"),
      manager.getAsset(descriptor, "audio/1/init.mp4"),
    ]);
    const [videoProbe, audioProbe] = await Promise.all([
      probeAsset(videoInit.filePath),
      probeAsset(audioInit.filePath),
    ]);
    assert.ok(videoProbe.streams.some((stream) => stream.codec_name === "h264"));
    assert.ok(audioProbe.streams.some((stream) => stream.codec_name === "aac"));
    const firstVideoSegment = await manager.getAsset(descriptor, "video/segment-000000.m4s");
    const firstVideoFragment = path.join(directory, "first-video-fragment.mp4");
    await writeFile(firstVideoFragment, Buffer.concat([
      await readFile(videoInit.filePath),
      await readFile(firstVideoSegment.filePath),
    ]));
    const firstPacketProbe = JSON.parse(
      (
        await runFile(ffprobeStatic.path, [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "packet=pts_time,dts_time,flags",
          "-of", "json",
          firstVideoFragment,
        ])
      ).stdout
    );
    const firstPacket = firstPacketProbe.packets?.[0];
    assert.ok(firstPacket, JSON.stringify(firstPacketProbe));
    assert.match(firstPacket.flags, /K/);
    assert.ok(
      Math.abs(Number(firstPacket.pts_time)) <= 0.001,
      `First HLS video packet starts at ${firstPacket.pts_time}s instead of zero.`
    );
    assert.ok(Math.abs(Number(firstPacket.dts_time)) <= 0.001);
    const vp9Descriptor = { ...descriptor, rendition: "vp9", inputArguments: ["-readrate", "4"] };
    const vp9Preparation = await manager.prepare(vp9Descriptor);
    assert.equal(vp9Preparation.encoder.id, "vp9");
    const vp9Init = await manager.getAsset(vp9Descriptor, "video/init.mp4");
    const vp9Probe = await probeAsset(vp9Init.filePath);
    assert.ok(vp9Probe.streams.some((stream) => stream.codec_name === "vp9"));

    await manager.shutdown();

    const cachedManager = createHlsPlaybackManager({
      ffmpegPath: path.join(directory, "missing-ffmpeg"),
      cacheRoot,
      playlistWaitMs: 1_000,
    });
    const equivalentDescriptor = { ...descriptor, jobId: "equivalent-job" };
    const cachedVideo = await cachedManager.getAsset(equivalentDescriptor, "video/index.m3u8");
    assert.match(await readPlaylist(cachedVideo.filePath), /#EXT-X-ENDLIST/);
    await cachedManager.removeJob(equivalentDescriptor.jobId);
    assert.match(await readPlaylist(cachedVideo.filePath), /#EXT-X-ENDLIST/);
    await assert.rejects(stat(path.join(cacheRoot, "jobs", equivalentDescriptor.jobId)), { code: "ENOENT" });
    await cachedManager.shutdown();
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not promote a cached HLS window whose first segment is missing", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-invalid-start-"));
  const cacheRoot = path.join(directory, "cache");
  const fingerprint = "cccccccccccccccccccccccccccccccc";
  const fileSize = 12345;
  const generationId = "11111111-1111-1111-1111-111111111111";
  const baseDirectory = path.join(
    cacheRoot,
    "content",
    `${fingerprint}-${fileSize}`,
    "h264-hls-v9"
  );
  const generationDirectory = path.join(baseDirectory, "generations", generationId);
  const videoDirectory = path.join(generationDirectory, "video");
  const audioDirectory = path.join(generationDirectory, "audio", "1");
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "#EXTINF:2.0,",
    "segment-000000.m4s",
    "#EXTINF:2.0,",
    "segment-000001.m4s",
    "",
  ].join("\n");
  const events = [];
  let manager;

  try {
    await Promise.all([
      mkdir(videoDirectory, { recursive: true }),
      mkdir(audioDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(generationDirectory, "master.m3u8"), "#EXTM3U\nvideo/index.m3u8\n"),
      writeFile(path.join(videoDirectory, "init.mp4"), "video-init"),
      writeFile(path.join(audioDirectory, "init.mp4"), "audio-init"),
      writeFile(path.join(videoDirectory, "index.m3u8"), playlist),
      writeFile(path.join(audioDirectory, "index.m3u8"), playlist),
      writeFile(path.join(videoDirectory, "segment-000001.m4s"), "late-video"),
      writeFile(path.join(audioDirectory, "segment-000001.m4s"), "late-audio"),
      writeFile(path.join(baseDirectory, "current.json"), JSON.stringify({ generationId })),
    ]);

    manager = createHlsPlaybackManager({
      ffmpegPath,
      cacheRoot,
      playableSeconds: 2,
      playlistWaitMs: 1_000,
      onEvent: (event, data) => events.push({ event, data }),
    });
    await assert.rejects(manager.prepare({
      jobId: "invalid-start-job",
      fileIndex: 0,
      fileSize,
      contentFingerprint: fingerprint,
      inputPath: path.join(directory, "missing-input.mkv"),
      videoCodec: "hevc",
      videoPixelFormat: "yuv420p10le",
      videoProfile: "Main 10",
      audioTracks: [{
        id: "1",
        streamIndex: 1,
        language: "eng",
        label: "English",
        codec: "aac",
        channels: 2,
        default: true,
      }],
    }));
    assert.ok(events.some(({ event }) => event === "hls_generation_started"));
    assert.equal(events.some(({ event }) => event === "hls_generation_promoted"), false);
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("finishes an active HLS generation before starting newly selected work", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-preempt-"));
  const input = path.join(directory, "input.mkv");
  const cacheRoot = path.join(directory, "cache");
  const events = [];
  const states = [];
  let manager;

  try {
    await runFile(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-shortest",
      input,
    ]);
    const fileSize = (await stat(input)).size;
    const common = {
      fileIndex: 0,
      fileSize,
      inputPath: input,
      videoCodec: "mpeg4",
      videoPixelFormat: "yuv420p",
      videoProfile: "Simple Profile",
      audioTracks: [{
        id: "1",
        streamIndex: 1,
        language: "eng",
        label: "English",
        codec: "aac",
        channels: 1,
        default: true,
      }],
    };
    const background = {
      ...common,
      jobId: "background-preempt-test",
      contentFingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      inputArguments: ["-readrate", "1"],
      onState: (preparation, transition) => states.push({ preparation, transition }),
    };
    const foreground = {
      ...common,
      jobId: "foreground-preempt-test",
      contentFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      inputArguments: ["-readrate", "8"],
    };

    manager = createHlsPlaybackManager({
      ffmpegPath,
      cacheRoot,
      segmentSeconds: 1,
      playableSeconds: 1,
      playlistWaitMs: 10_000,
      onEvent: (event, data) => events.push({ event, data }),
    });

    const initialPreparation = await manager.prepare(background);
    assert.equal(initialPreparation.status, "ready");
    assert.ok(initialPreparation.generationId);
    const initialAsset = await manager.getAsset(background, "video/index.m3u8");
    assert.doesNotMatch(await readPlaylist(initialAsset.filePath), /#EXT-X-ENDLIST/);

    const foregroundPreparation = manager.prepare(foreground);
    manager.setPriorityJob(foreground.jobId);
    assert.equal((await foregroundPreparation).status, "ready");

    const retainedAsset = await manager.getAsset(background, "video/index.m3u8");
    assert.equal(retainedAsset.filePath, initialAsset.filePath);
    assert.match(await readPlaylist(retainedAsset.filePath), /#EXT-X-ENDLIST/);
    const firstReady = states.findIndex(({ preparation }) => preparation.status === "ready");
    assert.ok(firstReady >= 0, JSON.stringify(states));
    assert.ok(states.slice(firstReady).every(({ preparation }) => preparation.status === "ready"), JSON.stringify(states));
    assert.equal(events.some(({ event }) => event === "hls_generation_preempted"), false, JSON.stringify(events));
    assert.ok(manager.diagnostics().generations.some((generation) =>
      generation.jobId === background.jobId && generation.complete
    ));
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
