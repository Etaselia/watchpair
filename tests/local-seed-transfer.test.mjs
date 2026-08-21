import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import TrackerServer from "bittorrent-tracker/server";
import WebTorrent from "webtorrent";
import { terminateChildProcess } from "./process-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("a companion-published local file is discoverable and serves every byte", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-local-seed-"));
  const tracker = new TrackerServer({ http: true, udp: false, ws: false });
  const trackerPort = await listen(tracker.http);
  const trackerUrl = `http://127.0.0.1:${trackerPort}/announce`;
  const agentPort = await freePort();
  const sourceId = "local-seed-transfer";
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 137, 0x5a);
  const companion = spawn(process.execPath, ["agent/server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      WATCHPAIR_AGENT_PORT: String(agentPort),
      WATCHPAIR_CONFIG_PATH: path.join(directory, "companion.json"),
      WATCHPAIR_TORRENT_PORT: "0",
      WATCHPAIR_DOWNLOAD_DIR: path.join(directory, "downloads"),
      WATCHPAIR_TRACKERS: trackerUrl,
      WATCHPAIR_TRANSCODER: "cpu",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  companion.stdout.on("data", (chunk) => { output += chunk.toString(); });
  companion.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const leecher = new WebTorrent({ dht: false, utp: false });

  try {
    const base = `http://127.0.0.1:${agentPort}`;
    await waitForJson(base + "/health", 10_000, (body) => body?.ok, () => companion.exitCode !== null);
    const upload = await fetch(
      `${base}/imports/${sourceId}?offset=0&total=${bytes.length}`,
      { method: "PUT", body: bytes, headers: { "content-type": "application/octet-stream" } },
    );
    assert.equal(upload.status, 200);
    const seed = await fetch(`${base}/imports/${sourceId}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "shared.bin", size: bytes.length }),
    });
    assert.equal(seed.status, 201);
    const published = await waitForJson(
      base + "/downloads/" + sourceId,
      10_000,
      (body) => body?.job?.status === "ready",
      () => companion.exitCode !== null,
    );
    const publication = await waitForJson(
      base + "/downloads/" + sourceId + "/publication",
      10_000,
      (body) => Boolean(body?.magnetURI),
      () => companion.exitCode !== null,
    );
    const leaseA = "lease-" + "a".repeat(64);
    const leaseB = "lease-" + "b".repeat(64);
    for (const leaseId of [leaseA, leaseB]) {
      const lease = await fetch(`${base}/downloads/${sourceId}/leases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseId, ttlMs: 30_000 }),
      });
      assert.equal(lease.status, 200);
    }
    const releasedB = await fetch(`${base}/downloads/${sourceId}/leases/${leaseB}`, {
      method: "DELETE",
    });
    assert.deepEqual(await releasedB.json(), { released: true, lastLease: false });
    assert.equal((await fetch(`${base}/downloads/${sourceId}?deleteFiles=1`, {
      method: "DELETE",
    })).status, 409, "an active room lease prevents stopping its seed");

    assert.equal(published.job.seedState, "seeding");
    assert.ok(published.job.torrentPort > 0);
    assert.ok(published.job.dhtPort > 0);
    assert.equal(published.job.webRtcSupported, true);
    assert.equal(published.job.files[0].name, "shared.bin");
    assert.equal(published.job.magnetURI, null);
    assert.match(publication.magnetURI, new RegExp(encodeURIComponent(trackerUrl).replaceAll(".", "\\.")));
    const announced = await waitForJson(
      base + "/downloads/" + sourceId,
      5_000,
      (body) => body?.job?.trackerAnnounces > 0,
      () => companion.exitCode !== null,
    );
    assert.ok(announced.job.trackerAnnounces > 0);

    const downloadDirectory = path.join(directory, "leecher");
    const downloaded = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Leecher did not finish")), 15_000);
      const torrent = leecher.add(publication.magnetURI, { path: downloadDirectory });
      torrent.once("done", () => {
        clearTimeout(timeout);
        resolve(torrent);
      });
      torrent.once("error", reject);
    });
    assert.ok(downloaded.numPeers > 0);
    assert.deepEqual(await readFile(path.join(downloadDirectory, "shared.bin")), bytes);
    const serving = await waitForJson(
      base + "/downloads/" + sourceId,
      5_000,
      (body) => body?.job?.uploaded >= bytes.length,
      () => companion.exitCode !== null,
    );
    assert.ok(["seeding", "uploading"].includes(serving.job.seedState));
    const releasedA = await fetch(`${base}/downloads/${sourceId}/leases/${leaseA}`, {
      method: "DELETE",
    });
    assert.deepEqual(await releasedA.json(), { released: true, lastLease: true });
    const paused = await waitForJson(
      base + "/downloads/" + sourceId,
      5_000,
      (body) => body?.job?.paused === true,
      () => companion.exitCode !== null,
    );
    assert.equal(paused.job.seedLeaseCount, 0);
    assert.equal((await stat(path.join(directory, "downloads", sourceId, "shared.bin"))).isFile(), true,
      "ending the final room lease preserves the imported payload");
  } catch (error) {
    throw new Error(`${error.message}\n${output}`);
  } finally {
    await terminateChildProcess(companion, { graceMs: 4_000 });
    if (!leecher.destroyed) await new Promise((resolve) => leecher.destroy(resolve));
    await new Promise((resolve) => tracker.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url, timeout, ready, exited) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      const body = response.ok ? await response.json() : null;
      if (response.ok && ready(body)) return body;
    } catch {
      // Companion is still starting or creating torrent metadata.
    }
    if (exited()) throw new Error("Companion exited before becoming ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
