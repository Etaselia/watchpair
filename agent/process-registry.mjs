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
export function createProcessRegistry({ historyLimit = 30 } = {}) {
  const active = new Map();
  const history = [];
  function finish(pid, code, signal, error = null) {
    const record = active.get(pid);
    if (!record) return;
    active.delete(pid);
    history.unshift({ ...record, status: error ? "error" : code === 0 ? "completed" : "stopped", code, signal, error: error ? String(error.message || error).slice(0, 500) : null, finishedAt: Date.now() });
    if (history.length > historyLimit) history.length = historyLimit;
  }
  return {
    track(child, metadata = {}) {
      if (!child?.pid) throw new Error("Cannot track a media process without a PID.");
      const privatePaths = metadata.privatePaths || [];
      const record = {
        pid: child.pid, jobId: metadata.jobId || null, taskId: metadata.taskId || null,
        stage: metadata.stage || "media", trackId: metadata.trackId || null,
        encoder: metadata.encoder || null, decoder: metadata.decoder || null,
        hardware: Boolean(metadata.hardware), profile: metadata.profile || null,
        command: publicCommand(metadata.command),
        arguments: (metadata.arguments || []).map((value) => publicArgument(value, privatePaths)),
        startedAt: Date.now(), status: "running", progress: {},
      };
      active.set(child.pid, record);
      child.once("error", (error) => finish(child.pid, null, null, error));
      child.once("close", (code, signal) => finish(child.pid, code, signal));
      return { update(values) {
        const current = active.get(child.pid);
        if (!current) return;
        current.progress = { frame: progressNumber(values.frame), fps: progressNumber(values.fps), speed: values.speed || null, outTimeMs: progressNumber(values.out_time_ms), progress: values.progress || null };
      } };
    },
    snapshot() { return { active: Array.from(active.values()).map((record) => ({ ...record })), recent: history.map((record) => ({ ...record })) }; },
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
