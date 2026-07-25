import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { terminateChildProcess } from "./process-helpers.mjs";

test("forces a child process down after graceful shutdown stalls", async () => {
  const child = spawn(process.execPath, ["-e", "process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  await terminateChildProcess(child, { graceMs: 100, forceMs: 1_000 });
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.ok(Date.now() - started < 1_500);
});
