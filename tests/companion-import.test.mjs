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
import { terminateChildProcess } from "./process-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("imports, seeds, restores, and stops a local companion file", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-companion-import-"));
  const agentPort = await freePort();
  const sourceId = "shared-local-video";
  const bytes = Buffer.alloc(1024 * 1024 + 37, 0x5a);
  let companion;
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
    assert.equal(storage.cleanup.downloadRetentionDays, 30);
    const pinnedResponse = await localFetch(base + "/downloads/" + sourceId + "/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(pinnedResponse.status, 200);
    assert.equal((await pinnedResponse.json()).job.pinned, true);

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
    const streamed = await localFetch(base + "/stream/" + sourceId + "/0");
    assert.equal(streamed.status, 200);
    assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), bytes);
    const stopped = await localFetch(base + "/downloads/" + sourceId, { method: "DELETE" });
    assert.equal(stopped.status, 200);
    const afterStop = await (await localFetch(base + "/downloads")).json();
    assert.equal(afterStop.jobs.length, 0);
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
    await rm(directory, { recursive: true, force: true });
  }
});

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
