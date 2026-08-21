import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { terminateChildProcess } from "./process-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("agent restores more than 100 jobs and preserves failed records", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-restore-many-"));
  const downloads = path.join(temporary, "downloads");
  const manifestPath = path.join(downloads, ".watchpair-jobs.json");
  const port = await freePort();
  const paused = Array.from({ length: 105 }, (_, index) => ({
    id: `paused-job-${String(index).padStart(3, "0")}`,
    kind: "magnet",
    value: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    label: `Paused ${index}`,
    managed: true,
    paused: true,
    pinned: index === 104,
    createdAt: 1,
    updatedAt: 1,
    retentionMetadataVersion: 1,
  }));
  const failed = {
    id: "failed-record-001",
    kind: "direct",
    value: "https://example.invalid/video.mp4",
    label: "Unavailable partial",
    managed: true,
    paused: true,
    file: {
      name: "video.mp4",
      path: path.join(downloads, "failed-record-001", "video.mp4"),
      size: 10,
      type: "video/mp4",
    },
  };
  const legacyTransientBinding = {
    id: "local-binding-001",
    kind: "direct",
    value: path.join(temporary, "external.mp4"),
    label: "Old local binding",
    managed: false,
    file: { name: "external.mp4", path: path.join(temporary, "external.mp4"), size: 1 },
  };
  await mkdir(downloads, { recursive: true });
  await writeFile(manifestPath, JSON.stringify([...paused, failed, legacyTransientBinding], null, 2));
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
        WATCHPAIR_CONFIG_PATH: path.join(temporary, "companion.json"),
        WATCHPAIR_CLEANUP_ENABLED: "0",
        WATCHPAIR_TRANSCODER: "cpu",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    await waitForJson(`http://127.0.0.1:${port}/health`, 15_000, (body) => body?.ok,
      () => child.exitCode !== null);
    const downloadsResponse = await localFetch(`http://127.0.0.1:${port}/downloads`);
    assert.equal(downloadsResponse.status, 200);
    const restored = (await downloadsResponse.json()).jobs;
    assert.equal(restored.length, 105);
    assert.equal(restored.every((job) => job.paused && job.status === "paused"), true);
    assert.equal(restored.at(-1).pinned, true);

    await terminateChildProcess(child, { graceMs: 4_000 });
    child = null;
    const persisted = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(persisted.length, 106);
    assert.ok(persisted.some((record) => record.id === failed.id && record.file.path === failed.file.path));
    assert.equal(persisted.some((record) => record.id === legacyTransientBinding.id), false);
  } catch (error) {
    throw new Error(`${error.message}\nAgent output:\n${output}`, { cause: error });
  } finally {
    await terminateChildProcess(child, { graceMs: 2_000 });
    await rm(temporary, { recursive: true, force: true });
  }
});

function localFetch(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return fetch(url, { ...init, headers });
}

async function freePort() {
  const server = createServer();
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url, timeout, ready, exited) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await localFetch(url);
      const body = response.ok ? await response.json() : null;
      if (response.ok && ready(body)) return body;
    } catch {
      // Agent is still starting.
    }
    if (exited()) throw new Error("Agent exited before becoming ready.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
