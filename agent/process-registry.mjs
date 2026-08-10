function publicArgument(value, privatePaths) {
  let argument = String(value);
  for (const privatePath of privatePaths) {
    if (!privatePath || !argument.includes(privatePath)) continue;
    argument = argument.split(privatePath).join("<media>");
  }
  if (/^(?:[a-zA-Z]:[\\/]|\/)/.test(argument)) return "<path>";
  return argument.length > 240 ? argument.slice(0, 237) + "..." : argument;
}
function publicCommand(value) {
  const parts = String(value || "").split(/[\\/]/);
  return parts.at(-1) || null;
}
function progressNumber(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
export function createProcessRegistry({ historyLimit = 30, onEvent = () => {} } = {}) {
  const active = new Map();
  const history = [];
  const emptyWaiters = new Set();
  let closing = false;

  function emit(event, data) {
    try {
      onEvent(event, data);
    } catch {
      // Diagnostic reporting must never affect media processing.
    }
  }

  function finish(pid, code, signal, error = null) {
    const entry = active.get(pid);
    if (!entry) return;
    active.delete(pid);
    const finishedAt = Date.now();
    const completed = {
      ...entry.record,
      status: error ? "error" : code === 0 ? "completed" : "stopped",
      code,
      signal,
      error: error ? String(error.message || error).slice(0, 500) : null,
      finishedAt,
      durationMs: finishedAt - entry.record.startedAt,
    };
    history.unshift(completed);
    if (history.length > historyLimit) history.length = historyLimit;
    emit("media_process_finished", completed);
    if (!active.size) {
      for (const resolve of emptyWaiters) resolve(true);
      emptyWaiters.clear();
    }
  }

  function waitForEmpty(timeoutMs = 0) {
    if (!active.size) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const finishWait = (empty) => {
        if (timer) clearTimeout(timer);
        emptyWaiters.delete(onEmpty);
        resolve(empty);
      };
      const onEmpty = () => finishWait(true);
      emptyWaiters.add(onEmpty);
      if (timeoutMs > 0) timer = setTimeout(() => finishWait(false), timeoutMs);
    });
  }

  function signalAll(signal) {
    let signalled = 0;
    for (const { child } of active.values()) {
      try {
        if (child.kill(signal)) signalled += 1;
      } catch {
        // The child may already have exited between the snapshot and signal.
      }
    }
    return signalled;
  }

  return {
    track(child, metadata = {}) {
      if (!child?.pid) throw new Error("Cannot track a media process without a PID.");
      const privatePaths = metadata.privatePaths || [];
      const record = {
        pid: child.pid,
        jobId: metadata.jobId || null,
        taskId: metadata.taskId || null,
        stage: metadata.stage || "media",
        trackId: metadata.trackId || null,
        encoder: metadata.encoder || null,
        decoder: metadata.decoder || null,
        hardware: Boolean(metadata.hardware),
        profile: metadata.profile || null,
        command: publicCommand(metadata.command),
        arguments: (metadata.arguments || []).map((value) => publicArgument(value, privatePaths)),
        startedAt: Date.now(),
        status: "running",
        progress: {},
      };
      active.set(child.pid, { child, record });
      emit("media_process_started", record);
      child.once("error", (error) => finish(child.pid, null, null, error));
      child.once("close", (code, signal) => finish(child.pid, code, signal));
      if (closing) {
        queueMicrotask(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // The process already exited.
          }
        });
      }
      return {
        update(values) {
          const current = active.get(child.pid)?.record;
          if (!current) return;
          current.progress = {
            frame: progressNumber(values.frame),
            fps: progressNumber(values.fps),
            speed: values.speed || null,
            outTimeMs: progressNumber(values.out_time_ms),
            progress: values.progress || null,
          };
        },
      };
    },
    snapshot() {
      return {
        closing,
        active: Array.from(active.values()).map(({ record }) => ({ ...record })),
        recent: history.map((record) => ({ ...record })),
      };
    },
    waitForEmpty,
    async terminateAll({ graceMs = 1_500, forceMs = 1_500 } = {}) {
      closing = true;
      const started = active.size;
      emit("media_process_shutdown_started", { activeProcesses: started });
      const terminated = signalAll("SIGTERM");
      let empty = await waitForEmpty(graceMs);
      let forced = 0;
      if (!empty) {
        forced = signalAll("SIGKILL");
        empty = await waitForEmpty(forceMs);
      }
      const result = {
        started,
        terminated,
        forced,
        remaining: active.size,
        empty,
      };
      emit("media_process_shutdown_finished", result);
      return result;
    },
  };
}
export function attachFfmpegProgress(stream, tracker) {
  if (!stream || !tracker) return;
  let buffer = "";
  let values = {};
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator);
      values[key] = line.slice(separator + 1);
      if (key === "progress") { tracker.update(values); values = {}; }
    }
  });
}
