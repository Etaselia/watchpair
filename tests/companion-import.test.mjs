import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { pathSize } from "../agent/storage-cleanup.mjs";
import { terminateChildProcess } from "./process-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

test("imports, seeds, restores, and cleans an expired companion file", { timeout: 75_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-companion-import-"));
  const agentPort = await freePort();
  const sourceId = "shared-local-video";
  const omittedLegacyId = "omitted-legacy-video";
  const bytes = Buffer.alloc(1024 * 1024 + 37, 0x5a);
  let companion;
  let torrentMetadataServer;
  let output = "";

  const start = async () => {
    const child = spawn(process.execPath, ["agent/server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        WATCHPAIR_AGENT_PORT: String(agentPort),
        WATCHPAIR_CONFIG_PATH: path.join(directory, "companion.json"),
        WATCHPAIR_TORRENT_PORT: "0",
        WATCHPAIR_DOWNLOAD_DIR: path.join(directory, "downloads"),
        WATCHPAIR_CLEANUP_ENABLED: "0",
        WATCHPAIR_DOWNLOAD_RETENTION_DAYS: "1",
        WATCHPAIR_CONTROL_TOKEN: "test-control-token",
        WATCHPAIR_FFMPEG_PATH: ffmpegPath,
        WATCHPAIR_TRANSCODER: "cpu",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    await waitForJson(
      `http://127.0.0.1:${agentPort}/health`,
      10_000,
      (body) => Boolean(body?.ok),
      () => child.exitCode !== null,
    ).catch((error) => {
      throw new Error(`${error.message}\n${output}`);
    });
    return child;
  };

  const stop = async (child) => {
    await terminateChildProcess(child, { graceMs: 4_000 });
  };

  try {
    companion = await start();
    const base = `http://127.0.0.1:${agentPort}`;
    const untrustedStartedAt = Date.now();
    const untrustedResponse = await localFetch(base + "/downloads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          id: "untrusted-job-meta",
          kind: "magnet",
          value: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
          label: "Untrusted metadata",
          managed: false,
          pinned: true,
          createdAt: 1,
          completedAt: 1,
          lastAccessedAt: 1,
          updatedAt: 1,
          identityFingerprint: "forged",
        },
      }),
    });
    assert.equal(untrustedResponse.status, 202);
    const untrustedJob = (await untrustedResponse.json()).job;
    assert.equal(untrustedJob.managed, true);
    assert.equal(untrustedJob.pinned, false);
    assert.equal(untrustedJob.completedAt, null);
    assert.equal(untrustedJob.identityFingerprint, null);
    assert.ok(untrustedJob.createdAt >= untrustedStartedAt);
    assert.ok(untrustedJob.lastAccessedAt >= untrustedStartedAt);
    const removeUntrusted = await localFetch(
      base + "/downloads/untrusted-job-meta?deleteFiles=1",
      { method: "DELETE" },
    );
    assert.equal(removeUntrusted.status, 200);

    const split = 600_000;
    for (const [offset, chunk] of [[0, bytes.subarray(0, split)], [split, bytes.subarray(split)]]) {
      const response = await localFetch(
        `${base}/imports/${sourceId}?offset=${offset}&total=${bytes.length}`,
        { method: "PUT", body: chunk, headers: { "content-type": "application/octet-stream" } },
      );
      assert.equal(response.status, 200);
      const progress = await response.json();
      assert.equal(progress.uploaded, offset + chunk.length);
    }

    const seedStarted = Date.now();
    const seededResponse = await localFetch(`${base}/imports/${sourceId}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "shared-video.mkv", size: bytes.length }),
    });
    assert.equal(seededResponse.status, 201);
    assert.ok(Date.now() - seedStarted < 2_000, "seed request should return before network announce");
    const pendingSeed = await seededResponse.json();
    assert.ok(["metadata", "ready"].includes(pendingSeed.job.status));
    const seeded = await waitForJson(
      base + "/downloads/" + sourceId,
      10_000,
      (body) => body?.job?.status === "ready",
      () => companion.exitCode !== null,
    );
    assert.equal(seeded.job.seed, true);
    assert.equal(seeded.job.status, "ready");
    assert.equal(seeded.job.creationProgress, 100);
    assert.match(seeded.job.magnetURI, /^magnet:\?xt=urn:btih:/i);
    assert.equal(seeded.job.files[0].size, bytes.length);
    const expectedFingerprint = createHash("sha256")
      .update(bytes.subarray(0, 512 * 1024))
      .update(bytes.subarray(bytes.length - 512 * 1024))
      .update(String(bytes.length))
      .digest("hex")
      .slice(0, 32);
    assert.equal(seeded.job.identityFingerprint, expectedFingerprint);
    assert.equal(seeded.job.files[0].fingerprint, expectedFingerprint);
    assert.equal(seeded.job.managed, true);
    assert.equal(seeded.job.pinned, false);
    const storage = await (await localFetch(base + "/storage")).json();
    assert.equal(storage.usage.managedJobs, 1);
    assert.equal(storage.cleanup.downloadRetentionDays, 1);
    const pinnedResponse = await localFetch(base + "/downloads/" + sourceId + "/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(pinnedResponse.status, 200);
    assert.equal((await pinnedResponse.json()).job.pinned, true);

    const cleanupStartedAt = Date.now();
    const cleanupResponse = await localFetch(base + "/cleanup", { method: "POST" });
    assert.equal(cleanupResponse.status, 202);
    assert.ok(Date.now() - cleanupStartedAt < 2_000, "cleanup request should return before scanning storage");
    const cleanupStarted = await cleanupResponse.json();
    assert.equal(cleanupStarted.status, "running");
    assert.ok(cleanupStarted.id);
    const cleanupFinished = await waitForJson(
      `${base}/cleanup?id=${encodeURIComponent(cleanupStarted.id)}`,
      10_000,
      (body) => body?.status === "complete" || body?.status === "error",
      () => companion.exitCode !== null,
    );
    assert.equal(cleanupFinished.status, "complete", cleanupFinished.error);
    assert.deepEqual(cleanupFinished.result.removedJobs, []);

    const bulk = await (await localFetch(base + "/downloads")).json();
    assert.equal(bulk.jobs.length, 1);
    assert.equal(bulk.jobs[0].id, sourceId);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await stop(companion);
    companion = null;
    const manifest = JSON.parse(await readFile(path.join(directory, "downloads", ".watchpair-jobs.json"), "utf8"));
    assert.equal(manifest[0].seed, true);
    assert.equal(manifest[0].id, sourceId);
    assert.equal(manifest[0].managed, true);
    assert.equal(manifest[0].pinned, true);
    assert.equal(manifest[0].retentionMetadataVersion, 1);

    companion = await start();
    const restored = await waitForJson(
      base + "/downloads/" + sourceId,
      10_000,
      (body) => body?.job?.seed && body?.job?.status === "ready",
      () => companion.exitCode !== null,
    );
    assert.equal(restored.job.files[0].size, bytes.length);

    assert.equal(restored.job.identityFingerprint, expectedFingerprint);
    assert.equal(restored.job.files[0].fingerprint, expectedFingerprint);
    assert.equal(restored.job.files[0].ready, true);
    assert.equal(restored.job.pinned, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const selectedResponse = await localFetch(base + "/downloads/" + sourceId + "/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileIndex: 0 }),
    });
    assert.equal(selectedResponse.status, 200);
    assert.ok((await selectedResponse.json()).job.lastAccessedAt > restored.job.lastAccessedAt);
    const streamed = await localFetch(base + "/stream/" + sourceId + "/0");
    assert.equal(streamed.status, 200);
    assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), bytes);

    const unpinnedResponse = await localFetch(base + "/downloads/" + sourceId + "/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: false }),
    });
    assert.equal(unpinnedResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stop(companion);
    companion = null;

    const manifestPath = path.join(directory, "downloads", ".watchpair-jobs.json");
    const restoredManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const torrentBytes = await readFile(
      path.join(directory, "downloads", sourceId, `.watchpair-${sourceId}.torrent`),
    );
    torrentMetadataServer = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/x-bittorrent",
        "content-length": torrentBytes.length,
        "connection": "close",
      });
      response.end(torrentBytes);
    });
    const torrentMetadataPort = await listen(torrentMetadataServer);
    const oldTimestamp = Date.now() - 3 * DAY;
    restoredManifest[0] = {
      ...restoredManifest[0],
      value: `http://127.0.0.1:${torrentMetadataPort}/shared-video.torrent`,
      seed: false,
      seedPath: null,
      pinned: false,
      createdAt: oldTimestamp,
      completedAt: oldTimestamp,
      lastAccessedAt: oldTimestamp,
      updatedAt: oldTimestamp,
    };
    await writeFile(manifestPath, JSON.stringify(restoredManifest, null, 2));

    companion = await start();
    const restoredDownload = await waitForJson(
      base + "/downloads/" + sourceId,
      10_000,
      (body) => body?.job?.id === sourceId && body.job.files.some((file) => file.selected),
      () => companion.exitCode !== null,
    );
    assert.equal(restoredDownload.job.seed, false);
    assert.equal(restoredDownload.job.createdAt, oldTimestamp);
    assert.equal(restoredDownload.job.completedAt, oldTimestamp);
    assert.equal(restoredDownload.job.lastAccessedAt, oldTimestamp);
    assert.equal(restoredDownload.job.pinned, false);

    const expiredCleanupResponse = await localFetch(base + "/cleanup", { method: "POST" });
    assert.equal(expiredCleanupResponse.status, 202);
    const expiredCleanupStarted = await expiredCleanupResponse.json();
    const expiredCleanupFinished = await waitForJson(
      `${base}/cleanup?id=${encodeURIComponent(expiredCleanupStarted.id)}`,
      10_000,
      (body) => body?.status === "complete" || body?.status === "error",
      () => companion.exitCode !== null,
    );
    assert.equal(expiredCleanupFinished.status, "complete", expiredCleanupFinished.error);
    assert.deepEqual(expiredCleanupFinished.result.removedJobs, [sourceId]);
    assert.deepEqual(expiredCleanupFinished.result.legacyJobs, []);
    await assert.rejects(stat(path.join(directory, "downloads", sourceId)), { code: "ENOENT" });
    const afterCleanup = await localFetch(base + "/downloads/" + sourceId);
    assert.equal(afterCleanup.status, 404);

    for (const [offset, chunk] of [[0, bytes.subarray(0, split)], [split, bytes.subarray(split)]]) {
      const response = await localFetch(
        `${base}/imports/${sourceId}?offset=${offset}&total=${bytes.length}`,
        { method: "PUT", body: chunk, headers: { "content-type": "application/octet-stream" } },
      );
      assert.equal(response.status, 200);
    }
    const reseededResponse = await localFetch(`${base}/imports/${sourceId}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "shared-video.mkv", size: bytes.length }),
    });
    assert.equal(reseededResponse.status, 201);
    await waitForJson(
      base + "/downloads/" + sourceId,
      10_000,
      (body) => body?.job?.seed && body.job.status === "ready",
      () => companion.exitCode !== null,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stop(companion);
    companion = null;

    const legacyManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(legacyManifest[0].retentionMetadataVersion, 1);
    const resetTimestamp = Date.now();
    legacyManifest[0] = {
      ...legacyManifest[0],
      value: `http://127.0.0.1:${torrentMetadataPort}/shared-video.torrent`,
      seed: false,
      seedPath: null,
      pinned: false,
      createdAt: resetTimestamp,
      completedAt: null,
      lastAccessedAt: resetTimestamp,
      updatedAt: resetTimestamp,
    };
    delete legacyManifest[0].retentionMetadataVersion;
    legacyManifest.push({
      ...legacyManifest[0],
      id: omittedLegacyId,
      value: "magnet:?xt=urn:btih:89abcdef0123456789abcdef0123456789abcdef",
      label: "C:\\private\\second\u202E-legacy-video.mkv",
      pinned: true,
      file: null,
      identityFingerprint: null,
      identityFingerprintKey: null,
    });
    await writeFile(manifestPath, JSON.stringify(legacyManifest, null, 2));

    const downloadRoot = path.join(directory, "downloads");
    const jobDirectory = path.join(downloadRoot, sourceId);
    const omittedJobDirectory = path.join(downloadRoot, omittedLegacyId);
    await mkdir(omittedJobDirectory, { recursive: true });
    await writeFile(path.join(omittedJobDirectory, "old-data.bin"), Buffer.alloc(11, 0x4f));
    const artifactFiles = [
      path.join(downloadRoot, ".watchpair-hls", "jobs", sourceId, "segments.bin"),
      path.join(downloadRoot, ".watchpair-hls", sourceId, "legacy-segments.bin"),
      path.join(downloadRoot, ".watchpair-subtitles", sourceId, "subtitle.vtt"),
      path.join(downloadRoot, ".watchpair-media", sourceId, "audio.mp4"),
      path.join(downloadRoot, ".watchpair-imports", sourceId + ".part"),
    ];
    for (const [index, filePath] of artifactFiles.entries()) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.alloc(index + 2, index + 1));
    }
    const oldFilesystemTimestamp = new Date(Date.now() - 3 * DAY);
    await setTreeMtime(jobDirectory, oldFilesystemTimestamp);
    await setTreeMtime(omittedJobDirectory, oldFilesystemTimestamp);

    companion = await start();
    const legacyDownload = await waitForJson(
      base + "/downloads/" + sourceId,
      10_000,
      (body) => body?.job?.id === sourceId && body.job.files.some((file) => file.selected),
      () => companion.exitCode !== null,
    );
    assert.equal(legacyDownload.job.seed, false);
    assert.equal(legacyDownload.job.createdAt, resetTimestamp);
    assert.equal(legacyDownload.job.lastAccessedAt, resetTimestamp);
    assert.equal(legacyDownload.job.pinned, false);

    const legacyCleanupResponse = await localFetch(base + "/cleanup", { method: "POST" });
    assert.equal(legacyCleanupResponse.status, 202);
    const legacyCleanupStarted = await legacyCleanupResponse.json();
    const legacyCleanupFinished = await waitForJson(
      `${base}/cleanup?id=${encodeURIComponent(legacyCleanupStarted.id)}`,
      10_000,
      (body) => body?.status === "complete" || body?.status === "error",
      () => companion.exitCode !== null,
    );
    assert.equal(legacyCleanupFinished.status, "complete", legacyCleanupFinished.error);
    assert.deepEqual(legacyCleanupFinished.result.removedJobs, []);
    assert.deepEqual(legacyCleanupFinished.result.legacyJobs, [sourceId]);
    assert.deepEqual(legacyCleanupFinished.result.legacyDownloads, [
      { id: sourceId, label: "shared-video.mkv" },
    ]);
    assert.equal((await stat(jobDirectory)).isDirectory(), true);
    for (const filePath of artifactFiles) assert.equal((await stat(filePath)).isFile(), true);

    const unpinOmitted = await localFetch(base + "/downloads/" + omittedLegacyId + "/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: false }),
    });
    assert.equal(unpinOmitted.status, 200);
    assert.equal((await unpinOmitted.json()).job.pinned, false);

    const missingToken = await localFetch(base + "/cleanup?includeLegacy=1", { method: "POST" });
    assert.equal(missingToken.status, 403);
    const wrongToken = await localFetch(base + "/cleanup?includeLegacy=1", {
      method: "POST",
      headers: { "x-watchpair-control": "wrong-token" },
    });
    assert.equal(wrongToken.status, 403);
    const invalidConfirmedJob = await localFetch(base + "/cleanup?includeLegacy=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-watchpair-control": "test-control-token",
      },
      body: JSON.stringify({ legacyJobs: ["../not-a-job"] }),
    });
    assert.equal(invalidConfirmedJob.status, 400);

    const removalPaths = [
      jobDirectory,
      path.join(downloadRoot, ".watchpair-hls", "jobs", sourceId),
      path.join(downloadRoot, ".watchpair-hls", sourceId),
      path.join(downloadRoot, ".watchpair-subtitles", sourceId),
      path.join(downloadRoot, ".watchpair-media", sourceId),
      path.join(downloadRoot, ".watchpair-imports", sourceId + ".part"),
    ];
    const expectedRemovedBytes = (await Promise.all(removalPaths.map((target) => pathSize(target))))
      .reduce((total, size) => total + size, 0);
    const confirmedCleanupResponse = await localFetch(base + "/cleanup?includeLegacy=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-watchpair-control": "test-control-token",
      },
      body: JSON.stringify({ legacyJobs: [` ${sourceId} `, sourceId] }),
    });
    assert.equal(confirmedCleanupResponse.status, 202);
    const confirmedCleanupStarted = await confirmedCleanupResponse.json();
    const confirmedCleanupFinished = await waitForJson(
      `${base}/cleanup?id=${encodeURIComponent(confirmedCleanupStarted.id)}`,
      10_000,
      (body) => body?.status === "complete" || body?.status === "error",
      () => companion.exitCode !== null,
    );
    assert.equal(confirmedCleanupFinished.status, "complete", confirmedCleanupFinished.error);
    assert.deepEqual(confirmedCleanupFinished.result.removedJobs, [sourceId]);
    assert.deepEqual(confirmedCleanupFinished.result.legacyJobs, [omittedLegacyId]);
    assert.deepEqual(confirmedCleanupFinished.result.legacyDownloads, [
      { id: omittedLegacyId, label: "second-legacy-video.mkv" },
    ]);
    assert.equal(confirmedCleanupFinished.result.bytes, expectedRemovedBytes);
    for (const target of removalPaths) await assert.rejects(stat(target), { code: "ENOENT" });
    assert.equal((await localFetch(base + "/downloads/" + sourceId)).status, 404);
    assert.equal((await stat(omittedJobDirectory)).isDirectory(), true);
    assert.equal((await localFetch(base + "/downloads/" + omittedLegacyId)).status, 200);
  } catch (error) {
    const diagnosticLog = await readFile(
      path.join(directory, "logs", "watchpair-agent.log"),
      "utf8",
    ).catch(() => "");
    throw new Error(
      `${error.message}\nCompanion exit: ${companion?.exitCode ?? "running"}\n` +
      `Companion output:\n${output}\nAgent log:\n${diagnosticLog.slice(-20_000)}`,
      { cause: error },
    );
  } finally {
    await stop(companion);
    if (torrentMetadataServer?.listening) {
      await new Promise((resolve) => torrentMetadataServer.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function setTreeMtime(target, timestamp) {
  const info = await lstat(target);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    const entries = await readdir(target);
    for (const entry of entries) await setTreeMtime(path.join(target, entry), timestamp);
  }
  await utimes(target, timestamp, timestamp);
}

function localFetch(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return fetch(url, { ...init, headers });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url, timeout, ready = (body) => Boolean(body), exited = () => false) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await localFetch(url);
      const body = response.ok ? await response.json() : null;
      if (response.ok && ready(body)) return body;
    } catch {
      // The companion is still starting.
    }
    if (exited()) throw new Error("Companion exited before becoming ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
