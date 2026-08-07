import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import TrackerServer from "bittorrent-tracker/server";
import WebTorrent from "webtorrent";
import { terminateChildProcess } from "./process-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("companion prioritizes one torrent while preserving ordered background progress", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-bandwidth-integration-"));
  const tracker = new TrackerServer({ udp: false, ws: false, stats: false });
  const seeder = new WebTorrent({
    dht: false,
    lsd: false,
    natUpnp: false,
    natPmp: false,
    utp: false,
  });
  let companion;
  let output = "";

  try {
    const files = [
      path.join(directory, "episode-one.mkv"),
      path.join(directory, "episode-two.mkv"),
    ];
    await Promise.all(files.map((file) => writeFile(file, randomBytes(6 * 1024 * 1024))));

    await new Promise((resolve, reject) => {
      tracker.once("error", reject);
      tracker.listen(0, "127.0.0.1", resolve);
    });
    const trackerUrl = `http://127.0.0.1:${tracker.http.address().port}/announce`;
    seeder.throttleUpload(384 * 1024);
    const torrents = await Promise.all(files.map((file) => seedFile(seeder, file, trackerUrl)));

    const agentPort = await freePort();
    companion = spawn(process.execPath, ["agent/server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        WATCHPAIR_AGENT_PORT: String(agentPort),
        WATCHPAIR_CONFIG_PATH: path.join(directory, "companion.json"),
        WATCHPAIR_TORRENT_PORT: "0",
        WATCHPAIR_DOWNLOAD_DIR: path.join(directory, "downloads"),
        WATCHPAIR_FFMPEG_PATH: ffmpegPath,
        WATCHPAIR_TRANSCODER: "cpu",
        WATCHPAIR_RESOURCE_MODE: "balanced",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    companion.stdout.on("data", (chunk) => { output += chunk.toString(); });
    companion.stderr.on("data", (chunk) => { output += chunk.toString(); });

    const base = `http://127.0.0.1:${agentPort}`;
    await waitForJson(base + "/health", 10_000, (body) => body?.ok, () => companion.exitCode !== null);

    const ids = ["bandwidth-one", "bandwidth-two"];
    const priorityResponse = await fetch(base + "/media-priority", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selected: { jobId: ids[0], fileIndex: 0 },
        targets: ids.map((jobId) => ({ jobId, fileIndex: 0 })),
      }),
    });
    assert.equal(priorityResponse.status, 200);

    for (let index = 0; index < ids.length; index += 1) {
      const response = await fetch(base + "/downloads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: {
            id: ids[index],
            kind: "magnet",
            value: torrents[index].magnetURI,
            label: path.basename(files[index]),
          },
        }),
      });
      assert.equal(response.status, 202);
    }

    const initial = await waitForPair(base, ids, 20_000, (jobs) =>
      jobs.every((job) => job.files?.[0]?.progress > 0 && job.files[0].progress < 100),
      () => companion.exitCode !== null
    );
    assert.ok(initial[1].files[0].downloaded > 0, "the second torrent should not be paused completely");

    const governed = await waitForJson(
      base + "/health",
      20_000,
      (body) => {
        const bandwidth = body?.torrent?.bandwidth;
        return bandwidth?.foregroundKey === ids[0] + ":0" &&
          bandwidth.sampleCount >= 2 && bandwidth.totalSpeed > 0;
      },
      () => companion.exitCode !== null
    );
    assert.ok(governed.torrent.bandwidth.backgroundSlots >= 1);
    assert.ok(governed.torrent.bandwidth.backgroundDuty > 0);
    assert.equal(governed.torrent.bandwidth.targetShare, 0.78);

    const reorderResponse = await fetch(base + "/media-priority", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selected: { jobId: ids[1], fileIndex: 0 },
        targets: [
          { jobId: ids[1], fileIndex: 0 },
          { jobId: ids[0], fileIndex: 0 },
        ],
      }),
    });
    assert.equal(reorderResponse.status, 200);
    const reordered = await waitForJson(
      base + "/health",
      5_000,
      (body) => body?.torrent?.bandwidth?.foregroundKey === ids[1] + ":0",
      () => companion.exitCode !== null
    );
    assert.deepEqual(reordered.torrent.bandwidth.backgroundKeys, [ids[0] + ":0"]);
    const afterReorder = await waitForPair(
      base,
      ids,
      5_000,
      () => true,
      () => companion.exitCode !== null
    );
    const firstAfterReorder = afterReorder[0].files[0].downloaded;

    const backgroundContinued = await waitForPair(base, ids, 12_000, (jobs) =>
      jobs[0].files?.[0]?.downloaded > firstAfterReorder,
      () => companion.exitCode !== null
    );
    assert.ok(backgroundContinued[0].files[0].downloaded > firstAfterReorder);
  } catch (error) {
    const log = await readFile(path.join(directory, "logs", "watchpair-agent.log"), "utf8").catch(() => "");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nCompanion output:\n${output.slice(-8_000)}\nAgent log:\n${log.slice(-16_000)}`,
      { cause: error }
    );
  } finally {
    await terminateChildProcess(companion);
    if (!seeder.destroyed) await new Promise((resolve) => seeder.destroy(resolve));
    await new Promise((resolve) => tracker.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function seedFile(client, file, trackerUrl) {
  return new Promise((resolve, reject) => {
    const torrent = client.seed(file, {
      announce: [trackerUrl],
      pieceLength: 64 * 1024,
    }, resolve);
    torrent.once("error", reject);
  });
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

async function waitForPair(base, ids, timeout, ready, exited) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeout) {
    try {
      const responses = await Promise.all(ids.map((id) => fetch(base + "/downloads/" + id)));
      if (responses.every((response) => response.ok)) {
        latest = await Promise.all(responses.map((response) => response.json().then((body) => body.job)));
        if (ready(latest)) return latest;
      }
    } catch {
      // Metadata and the first verified pieces are still arriving.
    }
    if (exited()) throw new Error("Companion exited during adaptive torrent scheduling");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for torrent pair: ${JSON.stringify(latest)}`);
}

async function waitForJson(url, timeout, ready, exited) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      latest = response.ok ? await response.json() : null;
      if (response.ok && ready(latest)) return latest;
    } catch {
      // The companion or requested state is still starting.
    }
    if (exited()) throw new Error("Companion exited before adaptive torrent scheduling became ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(latest)}`);
}
