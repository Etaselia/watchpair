import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const root = fileURLToPath(new URL("../", import.meta.url));

test("keeps multiple downloads active and prepares completed jobs in the background", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-companion-queue-"));
  const inputs = [path.join(directory, "episode-1.mkv"), path.join(directory, "episode-2.mkv")];
  const mediaServer = createServer(async (request, response) => {
    const index = request.url === "/episode-2.mkv" ? 1 : 0;
    const info = await stat(inputs[index]);
    response.writeHead(200, {
      "content-type": "video/x-matroska",
      "content-length": info.size,
    });
    createReadStream(inputs[index]).pipe(response);
  });
  let companion;

  try {
    for (let index = 0; index < inputs.length; index += 1) {
      await run(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=24:duration=${3 + index}`,
        "-f", "lavfi", "-i", `sine=frequency=${440 + index * 220}:duration=${3 + index}`,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "mpeg4", "-q:v", "8", "-c:a", "aac", "-shortest",
        inputs[index],
      ]);
    }

    const mediaPort = await listen(mediaServer);
    const agentPort = await freePort();
    let output = "";
    companion = spawn(process.execPath, ["agent/server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        WATCHPAIR_AGENT_PORT: String(agentPort),
        WATCHPAIR_ALLOW_PRIVATE_DOWNLOADS: "1",
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
    const health = await waitForJson(
      base + "/health",
      10_000,
      (body) => Boolean(body?.ok),
      () => companion.exitCode !== null
    );
    assert.equal(health.version, "0.5.1");
    assert.equal(health.transcoder.encoder, "cpu");

    const ids = ["queuejob-one", "queuejob-two"];
    for (let index = 0; index < ids.length; index += 1) {
      const response = await fetch(base + "/downloads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: {
            id: ids[index],
            kind: "direct",
            value: `http://127.0.0.1:${mediaPort}/episode-${index + 1}.mkv`,
            label: `episode-${index + 1}.mkv`,
          },
        }),
      });
      assert.equal(response.status, 202);
    }

    const completed = await Promise.all(ids.map((id) => waitForJson(
      base + "/downloads/" + id,
      20_000,
      (body) => body?.job?.preparation?.status === "ready"
    )));
    for (const result of completed) {
      assert.equal(result.job.status, "ready");
      assert.equal(result.job.files[0].ready, true);
      assert.equal(result.job.preparation.status, "ready");
      assert.equal(result.job.preparation.encoder.id, "cpu");
    }
    assert.equal((await (await fetch(base + "/health")).json()).jobs, 2);
    assert.match(output, /Transcoder: CPU \(libx264\)/);
  } finally {
    if (companion && companion.exitCode === null) {
      companion.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => companion.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    await new Promise((resolve) => mediaServer.close(resolve));
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

async function waitForJson(url, timeout, ready = (body) => Boolean(body), exited = () => false) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      const body = response.ok ? await response.json() : null;
      if (response.ok && ready(body)) return body;
    } catch {
      // The service or requested job is still starting.
    }
    if (exited()) throw new Error("Companion exited before becoming ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
