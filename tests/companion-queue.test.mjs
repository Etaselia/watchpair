import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { terminateChildProcess } from "./process-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

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
        WATCHPAIR_TORRENT_PORT: "0",
        WATCHPAIR_CONFIG_PATH: path.join(directory, "companion.json"),
        WATCHPAIR_DOWNLOAD_DIR: path.join(directory, "downloads"),
        WATCHPAIR_FFMPEG_PATH: ffmpegPath,
        WATCHPAIR_TRANSCODER: "cpu",
        WATCHPAIR_CONTROL_TOKEN: "test-control-token",
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
    assert.equal(health.version, packageVersion);
    assert.equal(health.transcoder.encoder, "cpu");
    assert.equal(health.protocolVersion, 1);
    assert.equal(health.logging.enabled, true);
    assert.equal(health.logging.fileName, "watchpair-agent.log");
    const rejectedPair = await fetch(base + "/control/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-watchpair-control": "wrong" },
      body: JSON.stringify({ origin: "https://watch.example" }),
    });
    assert.equal(rejectedPair.status, 403);
    const acceptedPair = await fetch(base + "/control/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-watchpair-control": "test-control-token" },
      body: JSON.stringify({ origin: "https://watch.example" }),
    });
    assert.equal(acceptedPair.status, 200);
    const pairedHealth = await fetch(base + "/health", { headers: { origin: "https://watch.example" } });
    assert.equal(pairedHealth.headers.get("access-control-allow-origin"), "https://watch.example");
    const browserDiagnostic = await fetch(base + "/diagnostics/client", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://watch.example" },
      body: JSON.stringify({
        event: "hls_fatal_error",
        level: "error",
        readyState: 0,
        networkState: 2,
        currentTime: 0.15,
        duration: 24,
        paused: true,
        seekableStart: 0,
        seekableEnd: 8,
        bufferedStart: 0,
        bufferedEnd: 4,
        seekTarget: 18,
        seekSource: "keyboard",
        roomPosition: 8,
        roomActorId: "device-2",
      }),
    });
    assert.equal(browserDiagnostic.status, 202);

    const ids = ["queuejob-one", "queuejob-two"];
    const priorityResponse = await fetch(base + "/preparation-priority", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: ids[1], sourceIds: [ids[1], ids[0]] }),
    });
    assert.equal(priorityResponse.status, 200);
    assert.deepEqual(await priorityResponse.json(), {
      ok: true,
      sourceId: ids[1],
      sourceIds: [ids[1], ids[0]],
      foregroundLoad: 0.75,
      backgroundLoad: 0.2,
    });

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

    const activeHealth = await waitForJson(
      base + "/health",
      20_000,
      (body) => body?.media?.activeProcesses === 1
    );
    assert.ok(activeHealth.media.scheduler.active);
    assert.equal(activeHealth.media.scheduler.orderedJobIds.length, 2);
    const healthStarted = performance.now();
    const responsiveHealth = await fetch(base + "/health");
    assert.equal(responsiveHealth.status, 200);
    assert.ok(performance.now() - healthStarted < 250);

    const diagnosticsResponse = await fetch(base + "/diagnostics/media");
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.processes.active.length, 1);
    assert.ok(Array.isArray(diagnostics.hls.generations));
    assert.equal(JSON.stringify(diagnostics).includes(directory), false);

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
    assert.equal(completed[0].job.preparation.resourceProfile, "background");
    assert.equal(completed[1].job.preparation.resourceProfile, "foreground");
    assert.equal((await (await fetch(base + "/health")).json()).jobs, 2);
    assert.match(output, /Transcoder: CPU \(libx264\)/);
    const logContents = await readFile(path.join(directory, "logs", "watchpair-agent.log"), "utf8");
    assert.match(logContents, /"event":"agent_process_started"/);
    assert.match(logContents, /"event":"media_process_started"/);
    assert.match(logContents, /"event":"media_process_finished"/);
    const mediaStarts = logContents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.event === "media_process_started" && record.stage === "video+audio");
    assert.equal(mediaStarts[0]?.jobId, ids[1], JSON.stringify(mediaStarts));
    const browserRecord = logContents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.event === "browser_playback_event");
    assert.ok(browserRecord);
    assert.equal(browserRecord.clientEvent, "hls_fatal_error");
    assert.equal(browserRecord.currentTime, 0.15);
    assert.equal(browserRecord.paused, true);
    assert.equal(browserRecord.seekableEnd, 8);
    assert.equal(browserRecord.bufferedEnd, 4);
    assert.equal(browserRecord.seekTarget, 18);
    assert.equal(browserRecord.seekSource, "keyboard");
    assert.equal(browserRecord.roomPosition, 8);
    assert.equal(browserRecord.roomActorId, "device-2");
    assert.match(logContents, /"event":"browser_playback_event"/);
    assert.doesNotMatch(logContents, /test-control-token/);
  } finally {
    await terminateChildProcess(companion);
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
