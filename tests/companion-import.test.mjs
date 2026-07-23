import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const root = fileURLToPath(new URL("../", import.meta.url));

test("imports, seeds, restores, and stops a local companion file", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-companion-import-"));
  const agentPort = await freePort();
  const sourceId = "shared-local-video";
  const bytes = Buffer.alloc(1024 * 1024 + 37, 0x5a);
  let companion;

  const start = async () => {
    const child = spawn(process.execPath, ["agent/server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        WATCHPAIR_AGENT_PORT: String(agentPort),
        WATCHPAIR_CONFIG_PATH: path.join(directory, "companion.json"),
        WATCHPAIR_TORRENT_PORT: "0",
        WATCHPAIR_DOWNLOAD_DIR: path.join(directory, "downloads"),
        WATCHPAIR_FFMPEG_PATH: ffmpegPath,
        WATCHPAIR_TRANSCODER: "cpu",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
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
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 4_000)),
    ]);
  };

  try {
    companion = await start();
    const base = `http://127.0.0.1:${agentPort}`;
    const split = 600_000;
    for (const [offset, chunk] of [[0, bytes.subarray(0, split)], [split, bytes.subarray(split)]]) {
      const response = await fetch(
        `${base}/imports/${sourceId}?offset=${offset}&total=${bytes.length}`,
        { method: "PUT", body: chunk, headers: { "content-type": "application/octet-stream" } },
      );
      assert.equal(response.status, 200);
      const progress = await response.json();
      assert.equal(progress.uploaded, offset + chunk.length);
    }

    const seedStarted = Date.now();
    const seededResponse = await fetch(`${base}/imports/${sourceId}/seed`, {
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

    const bulk = await (await fetch(base + "/downloads")).json();
    assert.equal(bulk.jobs.length, 1);
    assert.equal(bulk.jobs[0].id, sourceId);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await stop(companion);
    companion = null;
    const manifest = JSON.parse(await readFile(path.join(directory, "downloads", ".watchpair-jobs.json"), "utf8"));
    assert.equal(manifest[0].seed, true);
    assert.equal(manifest[0].id, sourceId);

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
    const stopped = await fetch(base + "/downloads/" + sourceId, { method: "DELETE" });
    assert.equal(stopped.status, 200);
    const afterStop = await (await fetch(base + "/downloads")).json();
    assert.equal(afterStop.jobs.length, 0);
  } finally {
    await stop(companion);
    await rm(directory, { recursive: true, force: true });
  }
});

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
      const response = await fetch(url);
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
