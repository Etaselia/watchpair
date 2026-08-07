import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { format } from "node:util";

const CONSOLE_CAPTURE = Symbol.for("watchpair.persistent-log.console");
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 4;
const REDACTED = "<redacted>";

function serializedError(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code || null,
    stack: error.stack || null,
  };
}

function sanitizeString(value) {
  return String(value)
    .replace(/magnet:\?[^\s"'<>]+/gi, "magnet:<redacted>")
    .replace(/(authorization|x-watchpair-control)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1$2${REDACTED}`)
    .slice(0, 16_384);
}

function sanitizeValue(value, key = "", seen = new WeakSet(), depth = 0) {
  if (value instanceof Error) return sanitizeValue(serializedError(value), key, seen, depth);
  if (typeof value === "string") {
    if (/(?:token|secret|password|authorization|cookie|magnet(?:uri)?|control)$/i.test(key)) {
      return REDACTED;
    }
    return sanitizeString(value);
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return sanitizeString(value);
  if (depth >= 8) return "<truncated>";
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeValue(entry, key, seen, depth + 1));
  }
  const result = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 100)) {
    result[entryKey] = sanitizeValue(entryValue, entryKey, seen, depth + 1);
  }
  return result;
}

function rotateFiles(filePath, maxFiles) {
  if (maxFiles <= 1) {
    if (existsSync(filePath)) unlinkSync(filePath);
    return;
  }
  const oldest = `${filePath}.${maxFiles - 1}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    if (existsSync(source)) renameSync(source, `${filePath}.${index + 1}`);
  }
  if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
}

export function createPersistentLogger({
  directory,
  fileName = "watchpair-agent.log",
  component = "agent",
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  now = () => new Date(),
  flushIntervalMs = 50,
  maxBufferedBytes = 256 * 1024,
} = {}) {
  const resolvedDirectory = path.resolve(directory || ".");
  const filePath = path.join(resolvedDirectory, path.basename(fileName));
  let enabled = true;
  let writeFailureReported = false;
  let fileSize = 0;
  let pendingLines = [];
  let pendingBytes = 0;
  let flushTimer = null;

  try {
    mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
    fileSize = existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    enabled = false;
  }

  function reportWriteFailure(error) {
    enabled = false;
    pendingLines = [];
    pendingBytes = 0;
    if (!writeFailureReported) {
      writeFailureReported = true;
      process.stderr.write(`WatchPair could not write its persistent log: ${error.message}\n`);
    }
  }

  function flush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!enabled || !pendingLines.length) return enabled;

    const lines = pendingLines;
    pendingLines = [];
    pendingBytes = 0;
    try {
      let chunk = "";
      let chunkBytes = 0;
      const appendChunk = () => {
        if (!chunkBytes) return;
        appendFileSync(filePath, chunk, { encoding: "utf8", mode: 0o600 });
        fileSize += chunkBytes;
        chunk = "";
        chunkBytes = 0;
      };

      for (const entry of lines) {
        if (fileSize + chunkBytes > 0 && fileSize + chunkBytes + entry.bytes > maxBytes) {
          appendChunk();
          rotateFiles(filePath, maxFiles);
          fileSize = 0;
        }
        chunk += entry.line;
        chunkBytes += entry.bytes;
        if (chunkBytes >= maxBufferedBytes) appendChunk();
      }
      appendChunk();
      return true;
    } catch (error) {
      reportWriteFailure(error);
      return false;
    }
  }

  function scheduleFlush() {
    if (flushTimer || !enabled) return;
    flushTimer = setTimeout(flush, Math.max(0, flushIntervalMs));
    flushTimer.unref?.();
  }

  function write(level, event, data = {}) {
    if (!enabled) return false;
    try {
      const record = {
        ...sanitizeValue(data),
        timestamp: now().toISOString(),
        level,
        component,
        processId: process.pid,
        event,
      };
      const line = JSON.stringify(record) + "\n";
      const bytes = Buffer.byteLength(line);
      pendingLines.push({ line, bytes });
      pendingBytes += bytes;
      if (level === "error" || pendingBytes >= maxBufferedBytes) flush();
      else scheduleFlush();
      return enabled;
    } catch (error) {
      reportWriteFailure(error);
      return false;
    }
  }

  const logger = {
    debug: (event, data) => write("debug", event, data),
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
    write,
    flush,
    details: () => ({
      enabled,
      directory: resolvedDirectory,
      filePath,
      fileName: path.basename(filePath),
      maxBytes,
      maxFiles,
      flushIntervalMs,
      maxBufferedBytes,
      pendingBytes,
    }),
    captureConsole(target = console) {
      if (target[CONSOLE_CAPTURE]) return () => {};
      const originals = {};
      for (const [method, level] of [
        ["debug", "debug"],
        ["info", "info"],
        ["log", "info"],
        ["warn", "warn"],
        ["error", "error"],
      ]) {
        originals[method] = target[method].bind(target);
        target[method] = (...values) => {
          originals[method](...values);
          write(level, "console", { message: format(...values) });
        };
      }
      Object.defineProperty(target, CONSOLE_CAPTURE, { configurable: true, value: true });
      return () => {
        for (const [method, original] of Object.entries(originals)) target[method] = original;
        delete target[CONSOLE_CAPTURE];
      };
    },
  };
  return logger;
}

export function installProcessDiagnostics(logger, target = process) {
  const handlers = {
    warning: (warning) => logger.warn("process_warning", { warning }),
    uncaughtExceptionMonitor: (error, origin) => logger.error("uncaught_exception", { origin, error }),
    beforeExit: (code) => {
      logger.info("process_before_exit", { code });
      logger.flush?.();
    },
    exit: (code) => {
      logger.info("process_exit", { code });
      logger.flush?.();
    },
  };
  for (const [event, handler] of Object.entries(handlers)) target.on(event, handler);
  return () => {
    for (const [event, handler] of Object.entries(handlers)) target.off(event, handler);
  };
}

export function sanitizeDiagnosticValue(value) {
  return sanitizeValue(value);
}
