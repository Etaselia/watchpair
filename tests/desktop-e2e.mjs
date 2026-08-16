import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForReport(reportPath, runId, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      if (report.runId === runId) return report;
    } catch {
      // The Electron process is still running the test.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Electron self-test timed out.");
}

function terminateProcessTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

const root = process.cwd();
const packageVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const temporary = await mkdtemp(path.join(os.tmpdir(), "watchpair-desktop-"));
const downloads = path.join(temporary, "downloads");
const userData = path.join(temporary, "user-data");
const reportPath = path.join(root, "test-results", "desktop-report.json");
const runId = randomUUID();
await Promise.all([
  mkdir(downloads, { recursive: true }),
  mkdir(userData, { recursive: true }),
  rm(reportPath, { force: true }),
]);
const output = [];
const executable = process.env.WATCHPAIR_DESKTOP_EXECUTABLE || electronPath;
const runtimeArguments = process.platform === "linux" && process.env.CI
  ? ["--no-sandbox"]
  : [];
const applicationArguments = process.env.WATCHPAIR_DESKTOP_EXECUTABLE
  ? runtimeArguments
  : [root, ...runtimeArguments];
const child = spawn(executable, applicationArguments, {
  cwd: root,
  env: {
    ...process.env,
    WATCHPAIR_TEST_MODE: "1",
    WATCHPAIR_TEST_USER_DATA: userData,
    WATCHPAIR_TEST_DOWNLOAD_DIR: downloads,
    WATCHPAIR_SELF_TEST_REPORT: reportPath,
    WATCHPAIR_SELF_TEST_RUN_ID: runId,
    WATCHPAIR_AGENT_PORT: String(await availablePort()),
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { output.push(String(chunk)); process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => { output.push(String(chunk)); process.stderr.write(chunk); });

let report;
try {
  report = await waitForReport(reportPath, runId);
} catch (error) {
  terminateProcessTree(child);
  error.message += `\n${output.join("")}`;
  throw error;
}
assert.equal(report.error, undefined, report.error || output.join(""));
assert.equal(report.initial.agent.health.ok, true);
assert.equal(report.initial.agent.health.protocolVersion, 1);
assert.equal(report.initial.agent.health.version, report.initial.version);
assert.equal(report.initial.version, packageVersion);
assert.equal(report.initial.agent.health.logging.enabled, true);
assert.equal(report.initial.logging.directory, path.join(userData, "logs"));
assert.equal(report.initial.logging.mainFile, "watchpair-main.log");
assert.equal(report.initial.logging.agentFile, "watchpair-agent.log");
assert.equal(report.saved.settings.downloadDirectory, downloads);
assert.equal(report.saved.settings.resourceMode, "eco");
assert.equal(report.saved.settings.cleanup.downloadRetentionDays, 14);
assert.equal(report.saved.settings.cleanup.cacheRetentionDays, 3);
assert.equal(report.saved.agent.health.downloadDirectory, downloads);
assert.equal(report.saved.agent.health.transcoder.preference, "cpu");
assert.equal(report.saved.agent.health.media.mode, "eco");
assert.equal(report.cleaned.agent.storage.directory, downloads);
assert.equal(typeof report.cleaned.agent.storage.usage.bytes, "number");
assert.equal(report.cleanupMessage, "Cleanup complete — nothing eligible");
assert.deepEqual(report.dom, {
  title: "WatchPair Companion",
  status: "Running",
  transcoder: "CPU (libx264)",
  resourceMode: "eco",
  mediaWork: true,
  update: "Updates are disabled in development",
  downloadDirectory: downloads,
  logs: "watchpair-main.log · watchpair-agent.log",
  openLogs: true,
  sections: 4,
});
assert.ok(report.screenshotSize.width >= 650);
assert.ok(report.screenshotSize.height >= 620);
assert.ok(report.screenshotBytes > 10_000);
assert.equal((await stat(report.screenshotPath)).size, report.screenshotBytes);
assert.ok((await stat(path.join(report.initial.logging.directory, report.initial.logging.mainFile))).size > 0);
assert.ok((await stat(path.join(report.initial.logging.directory, report.initial.logging.agentFile))).size > 0);
await new Promise((resolve) => setTimeout(resolve, 1_000));
terminateProcessTree(child);
console.log(`Desktop self-test passed (${report.screenshotSize.width}x${report.screenshotSize.height}, ${report.screenshotBytes} bytes).`);
