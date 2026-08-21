import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { terminateChildProcess } from "./process-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("library APIs deduplicate, preview ranges, hide paths, and propagate collection pins", {
  timeout: 30_000,
}, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-api-"));
  const downloads = path.join(temporary, "downloads");
  const libraryRoot = path.join(temporary, "library");
  const showRoot = path.join(libraryRoot, "Example Show");
  const videoPath = path.join(showRoot, "Episode 01.mp4");
  const hlsPreviewPath = path.join(showRoot, "Preview.mkv");
  const bytes = Buffer.alloc(1_000, 0x5a);
  const unrelatedFolder = path.join(downloads, "TV-Shows-2024");
  const port = await freePort();
  const controlToken = "library-test-control";
  await mkdir(downloads, { recursive: true });
  await mkdir(unrelatedFolder);
  await writeFile(path.join(unrelatedFolder, "keep.txt"), "not agent-owned");
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
  await utimes(path.join(unrelatedFolder, "keep.txt"), old, old);
  await utimes(unrelatedFolder, old, old);
  await mkdir(showRoot, { recursive: true });
  await writeFile(videoPath, bytes);
  await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=1.2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "mpeg4", "-q:v", "8", "-c:a", "aac", "-shortest",
    hlsPreviewPath,
  ]);
  let child;
  let output = "";

  try {
    child = spawn(process.execPath, ["agent/server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        WATCHPAIR_AGENT_PORT: String(port),
        WATCHPAIR_TORRENT_PORT: "0",
        WATCHPAIR_DOWNLOAD_DIR: downloads,
        WATCHPAIR_LIBRARY_DIRS: `${libraryRoot}${path.delimiter}${showRoot}`,
        WATCHPAIR_CONFIG_PATH: path.join(temporary, "companion.json"),
        WATCHPAIR_CONTROL_TOKEN: controlToken,
        WATCHPAIR_FFMPEG_PATH: ffmpegPath,
        WATCHPAIR_CLEANUP_ENABLED: "0",
        WATCHPAIR_TRANSCODER: "cpu",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    const base = `http://127.0.0.1:${port}`;
    await waitForJson(`${base}/health`, 15_000, (body) => body?.ok, () => child.exitCode !== null);
    assert.equal((await localFetch(`${base}/control/library`)).status, 403);

    const scanResponse = await localFetch(`${base}/control/library/scan`, {
      method: "POST",
      headers: { "x-watchpair-control": controlToken },
    });
    assert.equal(scanResponse.status, 202);
    const scan = await scanResponse.json();
    await waitForJson(
      `${base}/control/library/scan?id=${encodeURIComponent(scan.id)}`,
      10_000,
      (body) => ["complete", "error"].includes(body?.status),
      () => child.exitCode !== null,
      { "x-watchpair-control": controlToken },
    );
    const libraryResponse = await localFetch(`${base}/control/library?limit=50`, {
      headers: { "x-watchpair-control": controlToken },
    });
    assert.equal(libraryResponse.status, 200);
    const library = await libraryResponse.json();
    assert.equal(library.total, 1);
    assert.equal(library.collections[0].itemCount, 2);
    assert.doesNotMatch(JSON.stringify(library), new RegExp(escapeRegExp(temporary), "i"));

    const collectionId = library.collections[0].id;
    const detail = await (await localFetch(`${base}/control/library/${collectionId}`, {
      headers: { "x-watchpair-control": controlToken },
    })).json();
    const file = detail.collection.files.find((candidate) => candidate.name === "Episode 01.mp4");
    const hlsPreviewFile = detail.collection.files.find((candidate) => candidate.name === "Preview.mkv");
    assert.ok(file);
    assert.ok(hlsPreviewFile);
    assert.equal(file.usable, true);
    assert.equal((await localFetch(`${base}/library/${file.id}/preview`)).status, 403);

    const head = await localFetch(`${base}/library/${file.id}/preview`, {
      method: "HEAD",
      headers: { "x-watchpair-control": controlToken },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "1000");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const suffixHead = await localFetch(`${base}/library/${file.id}/preview`, {
      method: "HEAD",
      headers: { range: "bytes=-100", "x-watchpair-control": controlToken },
    });
    assert.equal(suffixHead.status, 206);
    assert.equal(suffixHead.headers.get("content-range"), "bytes 900-999/1000");
    assert.equal(suffixHead.headers.get("content-length"), "100");
    const suffix = await localFetch(`${base}/library/${file.id}/preview`, {
      headers: { range: "bytes=-100", "x-watchpair-control": controlToken },
    });
    assert.equal(suffix.status, 206);
    assert.equal((await suffix.arrayBuffer()).byteLength, 100);
    assert.equal((await localFetch(`${base}/library/${file.id}/preview`, {
      headers: { range: "bytes=0-1,4-5", "x-watchpair-control": controlToken },
    })).status, 416);

    const originalVideo = path.join(temporary, "original-video.mp4");
    const outsideVideo = path.join(temporary, "outside-video.mp4");
    await writeFile(outsideVideo, Buffer.alloc(bytes.length, 0x33));
    await rename(videoPath, originalVideo);
    let swappedLink = false;
    try {
      await symlink(outsideVideo, videoPath, "file");
      swappedLink = true;
      assert.equal((await localFetch(`${base}/library/${file.id}/preview`, {
        headers: { "x-watchpair-control": controlToken },
      })).status, 404, "a post-scan symlink swap cannot escape the library root");
    } catch (error) {
      if (!swappedLink && !["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
    } finally {
      if (swappedLink) await rm(videoPath, { force: true });
      await rename(originalVideo, videoPath);
    }

    const privateTracker = "https://tracker.example/announce?passkey=do-not-expose";
    const privateMagnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" +
      `&tr=${encodeURIComponent(privateTracker)}`;
    const privateJobResponse = await localFetch(`${base}/downloads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: {
        id: "privacy-room",
        kind: "magnet",
        value: privateMagnet,
        label: "Private tracker",
      } }),
    });
    assert.equal(privateJobResponse.status, 202);
    const privateJob = await privateJobResponse.json();
    assert.equal(privateJob.job.magnetURI, null);
    assert.equal(privateJob.job.sourceIdentity, createHash("sha256")
      .update("magnet\0" + "0123456789abcdef0123456789abcdef01234567")
      .digest("hex"));
    assert.doesNotMatch(JSON.stringify(privateJob), /do-not-expose|passkey/i);
    const privateDetail = await (await localFetch(`${base}/downloads/privacy-room`)).json();
    const privateList = await (await localFetch(`${base}/downloads`)).json();
    assert.doesNotMatch(JSON.stringify([privateDetail, privateList]), /do-not-expose|passkey/i);
    const conflictingSource = await localFetch(`${base}/downloads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: {
        id: "privacy-room",
        kind: "magnet",
        value: "magnet:?xt=urn:btih:89abcdef0123456789abcdef0123456789abcdef",
      } }),
    });
    assert.equal(conflictingSource.status, 400, "one room id cannot bind unrelated media");
    assert.equal((await localFetch(`${base}/downloads/privacy-room?deleteFiles=1`, {
      method: "DELETE",
    })).status, 200, "an owned directory can still be removed explicitly");

    const collidingFolder = await localFetch(`${base}/downloads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: {
        id: "TV-Shows-2024",
        kind: "magnet",
        value: "magnet:?xt=urn:btih:fedcba9876543210fedcba9876543210fedcba98",
      } }),
    });
    assert.equal(collidingFolder.status, 400,
      "a room id cannot claim a pre-existing unmarked user folder");
    assert.equal((await stat(path.join(unrelatedFolder, "keep.txt"))).isFile(), true);

    const sourceId = "local-api-file";
    const attachedResponse = await localFetch(`${base}/library/${file.id}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId, label: file.name }),
    });
    assert.equal(attachedResponse.status, 201);
    const attached = await attachedResponse.json();
    assert.equal(attached.job.magnetURI, null);
    assert.equal(attached.job.libraryCollectionId, collectionId);
    assert.doesNotMatch(JSON.stringify(attached), new RegExp(escapeRegExp(temporary), "i"));

    const previewSourceId = "preview-123e4567-e89b-12d3-a456-426614174000";
    const previewAttachment = await localFetch(`${base}/library/${hlsPreviewFile.id}/attach`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-watchpair-control": controlToken,
      },
      body: JSON.stringify({ sourceId: previewSourceId, label: `Preview · ${hlsPreviewFile.name}` }),
    });
    assert.equal(previewAttachment.status, 201);
    const previewJob = (await previewAttachment.json()).job;
    assert.equal(previewJob.id, previewSourceId);
    assert.match(previewJob.files[0].hlsUrl, /\/hls\/preview-/);
    assert.doesNotMatch(JSON.stringify(previewJob), new RegExp(escapeRegExp(temporary), "i"));
    assert.equal((await localFetch(previewJob.files[0].hlsUrl, {
      headers: { "x-watchpair-control": "wrong-preview-token" },
    })).status, 403, "the Desktop HLS proxy cannot use an invalid control token");
    const masterResponse = await localFetch(previewJob.files[0].hlsUrl, {
      headers: { "x-watchpair-control": controlToken },
    });
    assert.equal(masterResponse.status, 200);
    const master = await masterResponse.text();
    assert.match(master, /^#EXTM3U/m);
    const videoPlaylistName = master.split(/\r?\n/).find((line) => line.includes("video/index.m3u8"));
    assert.ok(videoPlaylistName);
    const videoPlaylistUrl = new URL(videoPlaylistName, previewJob.files[0].hlsUrl);
    const videoPlaylistResponse = await localFetch(videoPlaylistUrl, {
      headers: { "x-watchpair-control": controlToken },
    });
    assert.equal(videoPlaylistResponse.status, 200);
    assert.match(await videoPlaylistResponse.text(), /#EXT-X-MAP|#EXTINF/);
    assert.equal((await localFetch(`${base}/downloads/${previewSourceId}?deleteFiles=0`, {
      method: "DELETE",
      headers: { "x-watchpair-control": controlToken },
    })).status, 200);
    assert.equal((await localFetch(`${base}/downloads/${previewSourceId}`)).status, 404);
    assert.equal((await stat(videoPath)).size, bytes.length,
      "closing a transient preview never deletes its external source");
    assert.equal((await stat(hlsPreviewPath)).isFile(), true,
      "HLS preview cleanup never deletes its external source");

    const pinResponse = await localFetch(`${base}/control/library/${collectionId}/pin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-watchpair-control": controlToken,
      },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(pinResponse.status, 200);
    assert.equal((await pinResponse.json()).collection.pinned, true);
    const pinnedJob = await (await localFetch(`${base}/downloads/${sourceId}`)).json();
    assert.equal(pinnedJob.job.pinned, true);
    assert.equal(pinnedJob.job.libraryCollectionId, collectionId);
    assert.equal((await stat(videoPath)).size, bytes.length, "pinning never mutates an external source");
    const cleanup = await localFetch(`${base}/cleanup`, { method: "POST" });
    assert.equal(cleanup.status, 202);
    const cleanupOperation = await cleanup.json();
    await waitForJson(
      `${base}/cleanup?id=${encodeURIComponent(cleanupOperation.id)}`,
      10_000,
      (body) => ["complete", "error"].includes(body?.status),
      () => child.exitCode !== null,
    );
    assert.equal((await stat(path.join(unrelatedFolder, "keep.txt"))).isFile(), true,
      "cleanup never infers ownership from a UUID-like directory name");

    const offlineLibrary = libraryRoot + ".offline";
    await rename(libraryRoot, offlineLibrary);
    const staleLibraryResponse = await localFetch(`${base}/library`);
    assert.equal(staleLibraryResponse.status, 503);
    const staleLibrary = await staleLibraryResponse.json();
    assert.equal(staleLibrary.stale, true);
    assert.equal(staleLibrary.scan.status, "error");
    assert.ok(staleLibrary.files.length > 0, "the last-good catalog remains available as stale data");
    assert.equal((await localFetch(
      `${base}/library/match?fingerprint=${attached.job.identityFingerprint}&size=${bytes.length}`,
    )).status, 503, "automatic matching refuses a stale catalog");
    await rename(offlineLibrary, libraryRoot);

    await terminateChildProcess(child, { graceMs: 4_000 });
    child = null;
    const manifest = JSON.parse(await readFile(path.join(downloads, ".watchpair-jobs.json"), "utf8"));
    assert.deepEqual(manifest, [], "session-local library bindings never become restart jobs");
    const persistedCatalog = JSON.parse(await readFile(
      path.join(downloads, ".watchpair-library.json"), "utf8"));
    assert.ok(persistedCatalog.pins.includes(collectionId), "the durable collection pin remains persisted");
  } catch (error) {
    throw new Error(`${error.message}\nAgent output:\n${output}`, { cause: error });
  } finally {
    await terminateChildProcess(child, { graceMs: 2_000 });
    await rm(temporary, { recursive: true, force: true });
  }
});

test("external seed leases renew after restart and the final lease never deletes the source", {
  timeout: 30_000,
}, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-seed-lease-"));
  const downloads = path.join(temporary, "downloads");
  const libraryRoot = path.join(temporary, "library");
  const videoPath = path.join(libraryRoot, "Episode.mp4");
  const port = await freePort();
  const controlToken = "lease-test-control";
  await mkdir(downloads, { recursive: true });
  await mkdir(libraryRoot);
  await writeFile(videoPath, Buffer.alloc(4_096, 0x4c));
  const environment = {
    ...process.env,
    WATCHPAIR_AGENT_PORT: String(port),
    WATCHPAIR_TORRENT_PORT: "0",
    WATCHPAIR_DOWNLOAD_DIR: downloads,
    WATCHPAIR_LIBRARY_DIRS: libraryRoot,
    WATCHPAIR_CONFIG_PATH: path.join(temporary, "companion.json"),
    WATCHPAIR_CONTROL_TOKEN: controlToken,
    WATCHPAIR_CLEANUP_ENABLED: "0",
    WATCHPAIR_SEED_LEASE_GRACE_MS: "3000",
    WATCHPAIR_SEED_LEASE_SWEEP_MS: "50",
    WATCHPAIR_TRANSCODER: "cpu",
  };
  let child;
  let output = "";
  const start = async () => {
    const processChild = spawn(process.execPath, ["agent/server.mjs"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processChild.stdout.on("data", (chunk) => { output += chunk.toString(); });
    processChild.stderr.on("data", (chunk) => { output += chunk.toString(); });
    await waitForJson(`http://127.0.0.1:${port}/health`, 15_000,
      (body) => body?.ok, () => processChild.exitCode !== null);
    return processChild;
  };

  try {
    const base = `http://127.0.0.1:${port}`;
    child = await start();
    const scan = await (await localFetch(`${base}/control/library/scan`, {
      method: "POST",
      headers: { "x-watchpair-control": controlToken },
    })).json();
    await waitForJson(`${base}/control/library/scan?id=${scan.id}`, 10_000,
      (body) => body?.status === "complete", () => child.exitCode !== null,
      { "x-watchpair-control": controlToken });
    const library = await (await localFetch(`${base}/library`)).json();
    const fileId = library.files[0].id;
    const collectionId = library.files[0].collectionId;
    const cacheAttachment = await (await localFetch(`${base}/library/${fileId}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "cache-source" }),
    })).json();
    assert.equal((await localFetch(`${base}/control/library/${collectionId}/pin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-watchpair-control": controlToken,
      },
      body: JSON.stringify({ pinned: true }),
    })).status, 200);
    const contentKey = `${cacheAttachment.job.identityFingerprint}-4096`;
    const sharedCaches = [
      path.join(downloads, ".watchpair-hls", "content", contentKey, "segment.m4s"),
      path.join(downloads, ".watchpair-subtitles", "content", contentKey, "subtitle.vtt"),
    ];
    const oldCacheTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    for (const cachePath of sharedCaches) {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, "pinned cache");
      await utimes(cachePath, oldCacheTime, oldCacheTime);
      await utimes(path.dirname(cachePath), oldCacheTime, oldCacheTime);
    }
    assert.equal((await localFetch(`${base}/downloads/cache-source`, { method: "DELETE" })).status, 200);
    const sourceId = "lease-source";
    assert.equal((await localFetch(`${base}/library/${fileId}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId }),
    })).status, 201);
    const leaseId = "lease-" + "c".repeat(64);
    assert.equal((await localFetch(`${base}/downloads/${sourceId}/leases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId, ttlMs: 30_000 }),
    })).status, 200);

    await terminateChildProcess(child, { graceMs: 4_000 });
    child = await start();
    const cleanup = await (await localFetch(`${base}/cleanup`, { method: "POST" })).json();
    const cleanupResult = await waitForJson(`${base}/cleanup?id=${cleanup.id}`, 10_000,
      (body) => body?.status === "complete" || body?.status === "error",
      () => child.exitCode !== null);
    assert.equal(cleanupResult.status, "complete",
      cleanupResult.error || "cleanup operation did not complete");
    for (const cachePath of sharedCaches) {
      assert.equal((await stat(cachePath)).isFile(), true,
        "a durable external collection pin protects shared content cache after restart");
    }
    const renewed = await localFetch(`${base}/downloads/${sourceId}/leases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId, ttlMs: 30_000 }),
    });
    assert.equal(renewed.status, 200, "an active room can reacquire during restart grace");
    const released = await localFetch(`${base}/downloads/${sourceId}/leases/${leaseId}`, {
      method: "DELETE",
    });
    assert.deepEqual(await released.json(), { released: true, lastLease: true });
    await waitForStatus(`${base}/downloads/${sourceId}`, 404, 5_000,
      () => child.exitCode !== null);
    assert.deepEqual(await (await localFetch(
      `${base}/downloads/${sourceId}/leases/${leaseId}`,
      { method: "DELETE" },
    )).json(), { released: false, lastLease: true }, "release is idempotent after stop");
    assert.equal((await stat(videoPath)).isFile(), true);

    const expiringId = "expiry-source";
    assert.equal((await localFetch(`${base}/library/${fileId}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: expiringId }),
    })).status, 201);
    assert.equal((await localFetch(`${base}/downloads/${expiringId}/leases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: "lease-" + "d".repeat(64), ttlMs: 1_000 }),
    })).status, 200);
    await waitForStatus(`${base}/downloads/${expiringId}`, 404, 5_000,
      () => child.exitCode !== null);
    assert.equal((await stat(videoPath)).isFile(), true, "lease expiry never deletes external media");
  } catch (error) {
    throw new Error(`${error.message}\nAgent output:\n${output}`, { cause: error });
  } finally {
    await terminateChildProcess(child, { graceMs: 2_000 });
    await rm(temporary, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localFetch(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return fetch(url, { ...init, headers });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with ${code}.\n${output}`));
    });
  });
}

async function freePort() {
  const server = createServer();
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url, timeout, ready, exited, requestHeaders = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await localFetch(url, { headers: requestHeaders });
      const body = response.ok ? await response.json() : null;
      if (response.ok && ready(body)) return body;
    } catch {
      // Agent is still starting or scanning.
    }
    if (exited()) throw new Error("Agent exited before becoming ready.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForStatus(url, expectedStatus, timeout, exited) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await localFetch(url);
      if (response.status === expectedStatus) return response;
    } catch {
      // The companion may still be transitioning the seed.
    }
    if (exited()) throw new Error("Agent exited while waiting for a response status.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expectedStatus} from ${url}`);
}
