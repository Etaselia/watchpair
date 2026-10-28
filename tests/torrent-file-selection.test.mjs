import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import TrackerServer from "bittorrent-tracker/server";
import WebTorrent from "webtorrent";
import { terminateChildProcess } from "./process-helpers.mjs";

test("companion downloads chosen nested seasons, preserves an empty selection on restart, and skips extras", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-folder-selection-"));
  const tracker = new TrackerServer({ udp: false, ws: false, stats: false });
  const seeder = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
  let child;
  let output = "";
  const id = "multifolder-selection";
  try {
    const inputs = ["Season 1/Episode 1.mkv", "Season 2/Episode 1.mkv", "Bonus/Interview.mkv",
      ...Array.from({ length: 45 }, (_, index) => `Other Seasons/Season ${index + 3}/Episode 1.mkv`)];
    const seedDirectory = path.join(directory, "Show");
    const bytes = inputs.map((_, index) => randomBytes(index < 3 ? 1024 * 1024 : 64 * 1024));
    for (let index = 0; index < inputs.length; index++) {
      const file = path.join(seedDirectory, inputs[index]);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes[index]);
    }
    await new Promise((resolve, reject) => { tracker.once("error", reject); tracker.listen(0, "127.0.0.1", resolve); });
    const torrent = await new Promise((resolve, reject) => {
      const seeded = seeder.seed(seedDirectory, {
        announce: [`http://127.0.0.1:${tracker.http.address().port}/announce`], pieceLength: 64 * 1024,
      }, resolve);
      seeded.once("error", reject);
    });
    const portServer = createServer();
    await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const start = async () => {
      child = spawn(process.execPath, ["agent/server.mjs"], {
        cwd: new URL("../", import.meta.url), windowsHide: true,
        env: { ...process.env, WATCHPAIR_AGENT_PORT: String(port), WATCHPAIR_TORRENT_PORT: "0",
          WATCHPAIR_DOWNLOAD_DIR: path.join(directory, "downloads"), WATCHPAIR_CONFIG_PATH: path.join(directory, "companion.json"),
          WATCHPAIR_CLEANUP_ENABLED: "0", WATCHPAIR_TRANSCODER: "cpu" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      await until(async () => (await fetch(base + "/health").then((response) => response.json())).ok);
    };
    const post = async (route, body) => {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const job = async () => (await fetch(base + "/downloads/" + id).then((response) => response.json())).job;
    const downloads = path.join(directory, "downloads");
    await mkdir(path.join(downloads, id), { recursive: true });
    await writeFile(path.join(downloads, id, "keep.txt"), "unrelated existing folder");
    await start();
    const source = { id, kind: "magnet", value: torrent.magnetURI, downloadFileIndexes: [] };
    await Promise.all(Array.from({ length: 8 }, () => post("/downloads", { source })));
    await until(async () => (await job())?.files?.length === inputs.length);
    let savedRecord;
    await until(async () => {
      savedRecord = JSON.parse(await readFile(path.join(downloads, ".watchpair-jobs.json"), "utf8"))
        .find((record) => record.id === id);
      return savedRecord?.storageId && savedRecord.storageId !== id;
    });
    const payloadDirectory = path.join(downloads, savedRecord.storageId);
    let snapshot = await job();
    const secondIndex = snapshot.files.find((file) => file.path.includes("Season 2/")).index;
    const firstIndex = snapshot.files.find((file) => file.path.includes("Season 1/")).index;
    const bonusIndex = snapshot.files.find((file) => file.path.includes("Bonus/")).index;
    assert.deepEqual(snapshot.downloadFileIndexes, []);
    assert.ok(snapshot.files.every((file) => file.downloaded === 0));
    await post(`/downloads/${id}/selection`, { fileIndexes: [secondIndex] });
    // A stale priority plan must not override the persisted allowlist.
    await post("/media-priority", { selected: { jobId: id, fileIndex: secondIndex },
      targets: snapshot.files.map((file) => ({ jobId: id, fileIndex: file.index })) });
    await until(async () => (await job()).files[secondIndex].downloadReady);
    snapshot = await job();
    assert.equal(snapshot.files[firstIndex].downloaded, 0);
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    assert.deepEqual(await readFile(path.join(payloadDirectory, snapshot.files[secondIndex].path)), bytes[1]);
    await post(`/downloads/${id}/selection`, { fileIndexes: [] });
    const watchedPriority = await post("/media-priority", {
      selected: { jobId: id, fileIndex: secondIndex },
      targets: snapshot.files.map((file) => ({ jobId: id, fileIndex: file.index })),
      selections: [{ jobId: id, fileIndexes: [] }],
    });
    assert.deepEqual(watchedPriority.targets.map((target) => target.fileIndex), [secondIndex]);
    snapshot = await job();
    assert.deepEqual(snapshot.downloadFileIndexes, []);
    assert.equal(snapshot.files[firstIndex].downloaded, 0);
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    await post("/media-priority", { selected: null, targets: [] });
    await post(`/downloads/${id}/retry`, {});
    await until(async () => (await job())?.files?.length === inputs.length);
    assert.deepEqual((await job()).downloadFileIndexes, [], "retry preserves the empty allowlist");
    await until(async () => {
      const saved = JSON.parse(await readFile(path.join(directory, "downloads", ".watchpair-jobs.json"), "utf8"));
      return saved.some((entry) => entry.id === id && Array.isArray(entry.downloadFileIndexes) && entry.downloadFileIndexes.length === 0);
    });
    await terminateChildProcess(child);
    await start();
    await until(async () => (await job())?.files?.length === inputs.length);
    snapshot = await job();
    assert.deepEqual(snapshot.downloadFileIndexes, []);
    assert.equal(snapshot.files[firstIndex].downloaded, 0);
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    // With no priority plan after restart, only the newly included season may run.
    await post(`/downloads/${id}/selection`, { fileIndexes: [firstIndex] });
    await until(async () => (await job()).files[firstIndex].downloadReady);
    snapshot = await job();
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    assert.deepEqual(await readFile(path.join(payloadDirectory, snapshot.files[firstIndex].path)), bytes[0]);
    // Losing the job record must not force a fresh tree or redownload of a season pack.
    const removed = await fetch(`${base}/downloads/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const reusedFile = path.join(payloadDirectory, snapshot.files[firstIndex].path);
    const reusedMtime = (await stat(reusedFile)).mtimeMs;
    const markerPath = path.join(payloadDirectory, ".watchpair-owned.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    delete marker.sourceIdentity; // Ownership marker from companions before this fix.
    await writeFile(markerPath, JSON.stringify(marker));
    await post("/downloads", { source });
    await until(async () => (await job())?.files?.length === inputs.length);
    await post(`/downloads/${id}/selection`, { fileIndexes: [firstIndex] });
    await until(async () => (await job()).files[firstIndex].downloadReady);
    snapshot = await job();
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    assert.deepEqual(await readFile(path.join(payloadDirectory, snapshot.files[firstIndex].path)), bytes[0]);
    assert.equal((await stat(reusedFile)).mtimeMs, reusedMtime, "recovery verifies existing bytes without rewriting them");
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).token, marker.token,
      "legacy recovery retains the original managed tree and ownership token");
    assert.match(JSON.parse(await readFile(markerPath, "utf8")).sourceIdentity, /^[a-f0-9]{64}$/);
    assert.equal((await fetch(`${base}/downloads/${id}?deleteFiles=1`, { method: "DELETE" })).status, 200);
    assert.equal(await readFile(path.join(downloads, id, "keep.txt"), "utf8"), "unrelated existing folder");
  } catch (error) {
    throw new Error(`${error.message}\n${output.slice(-6000)}`, { cause: error });
  } finally {
    await terminateChildProcess(child);
    await new Promise((resolve) => seeder.destroy(resolve));
    await new Promise((resolve) => tracker.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* The service or metadata is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for companion file selection.");
}
