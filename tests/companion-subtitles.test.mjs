import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { terminateChildProcess } from "./process-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runFile = promisify(execFile);

test("companion serves original ASS, WebVTT fallback, and attached MKV fonts", { timeout: 30_000 }, async () => {
  if (!ffmpegPath) return;
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-subtitle-agent-"));
  const agentPort = await freePort();
  const assPath = path.join(directory, "input.ass");
  const mkvPath = path.join(directory, "fixture.mkv");
  const chaptersPath = path.join(directory, "chapters.txt");
  const fontPath = path.join(root, "node_modules", "jassub", "dist", "default.woff2");
  let companion;
  let output = "";

  try {
    await writeFile(assPath, [
      "[Script Info]",
      "ScriptType: v4.00+",
      "PlayResX: 640",
      "PlayResY: 360",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default,Liberation Sans,24,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,{\\pos(120,80)}First",
      "Dialogue: 1,0:00:00.50,0:00:02.00,Default,,0,0,0,,Second",
    ].join("\n"));
    await writeFile(chaptersPath, [
      ";FFMETADATA1",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=0",
      "END=1000",
      "title=Opening",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=1000",
      "END=2000",
      "title=Second half",
    ].join("\n"));
    await runFile(ffmpegPath, [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=black:s=640x360:d=2",
      "-i", assPath,
      "-i", chaptersPath,
      "-map", "0:v", "-map", "1:s",
      "-map_chapters", "2",
      "-c:v", "mpeg4", "-t", "2", "-c:s", "ass",
      "-attach", fontPath,
      "-metadata:s:t", "mimetype=font/woff2",
      "-metadata:s:t", "filename=default.woff2",
      mkvPath,
    ]);

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
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    companion.stdout.on("data", (chunk) => { output += chunk.toString(); });
    companion.stderr.on("data", (chunk) => { output += chunk.toString(); });
    await waitForJson(`http://127.0.0.1:${agentPort}/health`, 10_000, (body) => body?.ok);

    const bytes = await readFile(mkvPath);
    const sourceId = "subtitle-fixture";
    const base = `http://127.0.0.1:${agentPort}`;
    const uploaded = await fetch(`${base}/imports/${sourceId}?offset=0&total=${bytes.length}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    assert.equal(uploaded.status, 200);
    const seeded = await fetch(`${base}/imports/${sourceId}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fixture.mkv", size: bytes.length }),
    });
    assert.equal(seeded.status, 201);

    const snapshot = await waitForJson(
      `${base}/downloads/${sourceId}`,
      15_000,
      (body) => body?.job?.status === "ready" && body?.job?.subtitleStatus === "ready",
    );
    const track = snapshot.job.subtitles[0];
    assert.equal(track.styled, true);
    assert.match(track.assUrl, /\.ass\?v=/);
    assert.equal(track.fonts.length, 1);
    assert.deepEqual(snapshot.job.chapters.map(({ title, start, end }) => ({ title, start, end })), [
      { title: "Opening", start: 0, end: 1 },
      { title: "Second half", start: 1, end: 2 },
    ]);

    const assResponse = await fetch(track.assUrl);
    assert.equal(assResponse.status, 200);
    assert.match(assResponse.headers.get("content-type") || "", /^text\/x-ssa/);
    const ass = await assResponse.text();
    assert.match(ass, /pos\(120,80\)/);
    assert.equal((ass.match(/^Dialogue:/gm) || []).length, 2);

    const fallbackResponse = await fetch(track.url);
    assert.equal(fallbackResponse.status, 200);
    assert.match(await fallbackResponse.text(), /^WEBVTT/m);

    const fontResponse = await fetch(track.fonts[0].url);
    assert.equal(fontResponse.status, 200);
    assert.equal(fontResponse.headers.get("content-type"), "font/woff2");
    assert.deepEqual(Buffer.from(await fontResponse.arrayBuffer()), await readFile(fontPath));
  } catch (error) {
    throw new Error(`${error.message}\n${output}`, { cause: error });
  } finally {
    await terminateChildProcess(companion, { graceMs: 4_000 });
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

async function waitForJson(url, timeout, ready) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      const body = response.ok ? await response.json() : null;
      if (response.ok && ready(body)) return body;
    } catch {
      // The companion is still starting or preparing metadata.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
