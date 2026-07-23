import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import {
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

test("progressively prepares one HLS video rendition with separate audio tracks", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-hls-"));
  const input = path.join(directory, "input.mkv");
  const cacheRoot = path.join(directory, "cache");
  const descriptor = {
    jobId: "hls-test-job",
    fileIndex: 0,
    fileSize: 0,
    inputPath: input,
    videoCodec: "mpeg4",
    inputArguments: ["-readrate", "4"],
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

  try {
    await runFile(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=12",
      "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
      "-c:v", "mpeg4", "-q:v", "6",
      "-c:a", "aac", "-shortest",
      input,
    ]);

    descriptor.fileSize = (await stat(input)).size;

    const manager = createHlsPlaybackManager({
      ffmpegPath,
      cacheRoot,
      encoder: {
        id: "test-gpu",
        codec: "test_gpu",
        label: "Test GPU",
        hardware: true,
        arguments: ["-c:v", "watchpair_missing_encoder"],
      },
      segmentSeconds: 2,
      playableSeconds: 4,
      playlistWaitMs: 15_000,
    });

    const masterAsset = await manager.getAsset(descriptor, "master.m3u8");
    const master = await readPlaylist(masterAsset.filePath);
    assert.match(master, /TYPE=AUDIO.*NAME="Japanese".*DEFAULT=YES/);
    assert.match(master, /TYPE=AUDIO.*NAME="English".*DEFAULT=NO/);
    assert.match(master, /URI="audio\/1\/index\.m3u8"/);
    assert.match(master, /URI="audio\/2\/index\.m3u8"/);
    assert.equal((master.match(/EXT-X-STREAM-INF/g) || []).length, 1);

    const [videoAsset, japaneseAsset, englishAsset] = await Promise.all([
      manager.getAsset(descriptor, "video/index.m3u8"),
      manager.getAsset(descriptor, "audio/1/index.m3u8"),
      manager.getAsset(descriptor, "audio/2/index.m3u8"),
    ]);
    const initialPreparation = await manager.prepare(descriptor);
    assert.equal(initialPreparation.status, "ready");
    assert.equal(initialPreparation.encoder.id, "cpu");
    assert.equal(initialPreparation.hardwareDecode, false);
    assert.equal(initialPreparation.fallback, true);

    const [video, japanese, english] = await Promise.all([
      readPlaylist(videoAsset.filePath),
      readPlaylist(japaneseAsset.filePath),
      readPlaylist(englishAsset.filePath),
    ]);
    assert.match(video, /#EXT-X-PLAYLIST-TYPE:EVENT/);
    assert.match(video, /segment-000000\.m4s/);
    assert.match(video, /segment-000001\.m4s/);
    assert.doesNotMatch(video, /#EXT-X-ENDLIST/, "playback should unlock before conversion finishes");
    assert.match(japanese, /segment-000000\.m4s/);
    assert.match(japanese, /segment-000001\.m4s/);
    assert.match(english, /segment-000000\.m4s/);
    assert.match(english, /segment-000001\.m4s/);

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const playlists = await Promise.all([
        readPlaylist(videoAsset.filePath),
        readPlaylist(japaneseAsset.filePath),
        readPlaylist(englishAsset.filePath),
      ]);
      if (playlists.every((playlist) => playlist.includes("#EXT-X-ENDLIST"))) break;
      if (attempt === 199) assert.fail("HLS preparation did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
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
    manager.shutdown();

    const cachedManager = createHlsPlaybackManager({
      ffmpegPath: path.join(directory, "missing-ffmpeg"),
      cacheRoot,
      playlistWaitMs: 1_000,
    });
    const cachedVideo = await cachedManager.getAsset(descriptor, "video/index.m3u8");
    assert.match(await readPlaylist(cachedVideo.filePath), /#EXT-X-ENDLIST/);
    cachedManager.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
