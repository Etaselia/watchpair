import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import TrackerServer from "bittorrent-tracker/server";
import WebTorrent from "webtorrent";

const root = fileURLToPath(new URL("../", import.meta.url));

test("waits for a verified torrent before probing and preparing initial HLS segments", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-progressive-"));
  const input = path.join(directory, "progressive.mkv");
  const seeder = new WebTorrent({
    dht: false,
    lsd: false,
    natUpnp: false,
    natPmp: false,
  });
  const tracker = new TrackerServer({ udp: false, ws: false, stats: false });
  let companion;
  let output = "";

  try {
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=20",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "mpeg4", "-q:v", "2", "-c:a", "aac", "-shortest",
      input,
    ]);
    assert.ok((await stat(input)).size > 2_000_000);

    await new Promise((resolve, reject) => {
      tracker.once("error", reject);
      tracker.listen(0, "127.0.0.1", resolve);
    });
    const trackerUrl = `http://127.0.0.1:${tracker.http.address().port}/announce`;

    seeder.throttleUpload(512 * 1024);
    const torrent = await new Promise((resolve, reject) => {
      const pending = seeder.seed(input, { announce: [trackerUrl] }, resolve);
      pending.once("error", reject);
    });
    const magnet = torrent.magnetURI;

    const agentPort = await freePort();
    companion = spawn(process.execPath, ["agent/server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        WATCHPAIR_AGENT_PORT: String(agentPort),
        WATCHPAIR_CONFIG_PATH: path.join(directory, "companion.json"),
        WATCHPAIR_DOWNLOAD_DIR: path.join(directory, "downloads"),
        WATCHPAIR_FFMPEG_PATH: ffmpegPath,
        WATCHPAIR_TRANSCODER: "cpu",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    companion.stdout.on("data", (chunk) => { output += chunk.toString(); });
    companion.stderr.on("data", (chunk) => { output += chunk.toString(); });

    const base = `http://127.0.0.1:${agentPort}`;
    await waitForJson(base + "/health", 10_000, (body) => Boolean(body?.ok), () => companion.exitCode !== null);

    const response = await fetch(base + "/downloads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          id: "progressive-torrent",
          kind: "magnet",
          value: magnet,
          label: "progressive.mkv",
        },
      }),
    });
    assert.equal(response.status, 202);

    const downloading = await waitForJson(
      base + "/downloads/progressive-torrent",
      15_000,
      (body) => {
        const progress = body?.job?.files?.[0]?.progress || 0;
        return progress > 0 && progress < 100;
      },
      () => companion.exitCode !== null
    );
    assert.equal(downloading.job.files[0].ready, false);
    assert.equal(downloading.job.subtitleStatus, "waiting");
    assert.equal(downloading.job.preparation.status, "waiting");

    seeder.throttleUpload(-1);
    const prepared = await waitForJson(
      base + "/downloads/progressive-torrent",
      35_000,
      (body) =>
        body?.job?.files?.[0]?.ready === true &&
        body?.job?.preparation?.status === "ready",
      () => companion.exitCode !== null
    );
    assert.equal(prepared.job.files[0].progress, 100);
    assert.equal(prepared.job.subtitleStatus, "ready");
    assert.equal(prepared.job.preparation.status, "ready");
  } catch (error) {
    throw new Error(`${error.message}\nCompanion output:\n${output}`);
  } finally {
    if (companion && companion.exitCode === null) {
      companion.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => companion.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    if (!seeder.destroyed) {
      await new Promise((resolve) => seeder.destroy(resolve));
    }
    await new Promise((resolve) => tracker.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
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

async function waitForJson(url, timeout, ready, exited) {
  const started = Date.now();
  let lastBody = null;
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      const body = response.ok ? await response.json() : null;
      lastBody = body;
      if (response.ok && ready(body)) return body;
    } catch {
      // The service, verified download, or opening HLS window is still pending.
    }
    if (exited()) throw new Error("Companion exited before post-download preparation became ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(lastBody)}`);
}
