import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("agent exits cleanly when its port is already occupied", { timeout: 20_000 }, async () => {
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const port = occupied.address().port;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "watchpair-port-conflict-"));
  const child = spawn(process.execPath, ["agent/server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      WATCHPAIR_AGENT_HOST: "127.0.0.1",
      WATCHPAIR_AGENT_PORT: String(port),
      WATCHPAIR_DOWNLOAD_DIR: tempDir,
      WATCHPAIR_ALLOWED_ORIGINS: "http://localhost:3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 72, output);
    assert.match(output, /Another WatchPair companion is already using/);
    assert.doesNotMatch(output, /Unhandled 'error' event/);
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => occupied.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
