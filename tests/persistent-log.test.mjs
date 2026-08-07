import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPersistentLogger,
  installProcessDiagnostics,
  sanitizeDiagnosticValue,
} from "../agent/persistent-log.mjs";

test("persistent logger redacts secrets and magnet links", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logger = createPersistentLogger({ directory });

  logger.info("sample", {
    controlToken: "top-secret-control-token",
    magnetURI: "magnet:?xt=urn:btih:1234567890&tr=https://tracker.example",
    message: "Resolving magnet:?xt=urn:btih:abcdef&tr=https://tracker.example",
    nested: { authorization: "Bearer top-secret-authorization" },
  });

  logger.flush();
  const contents = await readFile(path.join(directory, "watchpair-agent.log"), "utf8");
  assert.doesNotMatch(contents, /top-secret/);
  assert.doesNotMatch(contents, /btih:/);
  const record = JSON.parse(contents.trim());
  assert.equal(record.controlToken, "<redacted>");
  assert.equal(record.magnetURI, "<redacted>");
  assert.match(record.message, /magnet:<redacted>/);
  assert.equal(record.nested.authorization, "<redacted>");
});

test("persistent logger rotates within its configured file count", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-rotation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logger = createPersistentLogger({
    directory,
    maxBytes: 300,
    maxFiles: 3,
  });

  for (let index = 0; index < 20; index += 1) {
    logger.info("rotation_sample", { index, message: "x".repeat(80) });
  }

  logger.flush();
  await access(path.join(directory, "watchpair-agent.log"));
  await access(path.join(directory, "watchpair-agent.log.1"));
  await access(path.join(directory, "watchpair-agent.log.2"));
  await assert.rejects(access(path.join(directory, "watchpair-agent.log.3")));
});

test("process diagnostics observe fatal events without handling rejections", () => {
  const target = new EventEmitter();
  const events = [];
  const logger = {
    info: (event, data) => events.push({ level: "info", event, data }),
    warn: (event, data) => events.push({ level: "warn", event, data }),
    error: (event, data) => events.push({ level: "error", event, data }),
  };
  const uninstall = installProcessDiagnostics(logger, target);

  target.emit("warning", new Error("warning"));
  target.emit("uncaughtExceptionMonitor", new Error("fatal"), "unhandledRejection");
  target.emit("beforeExit", 0);
  target.emit("exit", 1);

  assert.deepEqual(events.map((entry) => entry.event), [
    "process_warning",
    "uncaught_exception",
    "process_before_exit",
    "process_exit",
  ]);
  assert.equal(target.listenerCount("unhandledRejection"), 0);
  uninstall();
  assert.equal(target.listenerCount("warning"), 0);
});

test("diagnostic sanitization handles cycles", () => {
  const value = { token: "secret" };
  value.self = value;
  assert.deepEqual(sanitizeDiagnosticValue(value), {
    token: "<redacted>",
    self: "<circular>",
  });
});
