import { availableParallelism, constants, cpus, setPriority } from "node:os";
import { performance } from "node:perf_hooks";

const MODES = Object.freeze({
  eco: Object.freeze({ foregroundShare: 0.55, backgroundShare: 0.2, foregroundReadRate: 1.5, backgroundReadRate: 0.5 }),
  balanced: Object.freeze({ foregroundShare: 0.75, backgroundShare: 0.2, foregroundReadRate: 3, backgroundReadRate: 0.75 }),
  fast: Object.freeze({ foregroundShare: 0.9, backgroundShare: 0.35, foregroundReadRate: 6, backgroundReadRate: 1.25 }),
});

export function normalizeResourceMode(value) {
  const mode = String(value || "").toLowerCase();
  return mode in MODES ? mode : "balanced";
}

export function mediaResourceProfile(kind, { mode = process.env.WATCHPAIR_RESOURCE_MODE, logicalCores = availableParallelism() } = {}) {
  const normalizedMode = normalizeResourceMode(mode);
  const settings = MODES[normalizedMode];
  const foreground = kind === "foreground";
  const share = foreground ? settings.foregroundShare : settings.backgroundShare;
  const cores = Math.max(1, Number(logicalCores) || 1);
  const workerCeiling = Math.max(1, cores - 1);
  return {
    mode: normalizedMode,
    kind: foreground ? "foreground" : "background",
    share,
    threads: Math.max(1, Math.min(workerCeiling, Math.floor(cores * share))),
    filterThreads: Math.max(1, Math.min(2, Math.floor(cores * share))),
    inputRate: foreground ? settings.foregroundReadRate : settings.backgroundReadRate,
    processPriority: foreground ? constants.priority.PRIORITY_BELOW_NORMAL : constants.priority.PRIORITY_LOW,
    gpuSurfaces: foreground ? 6 : 2,
    qsvAsyncDepth: foreground ? 3 : 1,
  };
}

export function applyMediaProcessPriority(child, profile) {
  if (!child?.pid) return false;
  try { setPriority(child.pid, profile.processPriority); return true; } catch { return false; }
}

function cpuTimes() {
  return cpus().reduce((total, cpu) => {
    const idle = cpu.times.idle;
    const all = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: total.idle + idle, all: total.all + all };
  }, { idle: 0, all: 0 });
}

export function createResponsivenessMonitor({ intervalMs = 250, sampleCount = 120 } = {}) {
  const delays = [];
  let previousCpu = cpuTimes();
  let systemCpuPercent = 0;
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - expected));
    if (delays.length > sampleCount) delays.shift();
    expected = now + intervalMs;
    const currentCpu = cpuTimes();
    const allDelta = currentCpu.all - previousCpu.all;
    const idleDelta = currentCpu.idle - previousCpu.idle;
    if (allDelta > 0) systemCpuPercent = Math.max(0, Math.min(100, ((allDelta - idleDelta) / allDelta) * 100));
    previousCpu = currentCpu;
  }, intervalMs);
  timer.unref?.();
  return {
    snapshot() {
      const sorted = [...delays].sort((left, right) => left - right);
      const percentile = (value) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] : 0;
      return {
        eventLoopDelayP50Ms: Math.round(percentile(0.5) * 10) / 10,
        eventLoopDelayP95Ms: Math.round(percentile(0.95) * 10) / 10,
        systemCpuPercent: Math.round(systemCpuPercent * 10) / 10,
      };
    },
    shouldDeferBackground() {
      const current = this.snapshot();
      return current.eventLoopDelayP95Ms > 100 || current.systemCpuPercent > 85;
    },
    stop() { clearInterval(timer); },
  };
}

export function createMediaTaskScheduler({ monitor = createResponsivenessMonitor(), retryDelayMs = 500 } = {}) {
  const pending = [];
  let activeTask = null;
  let foregroundJobId = null;
  let sequence = 0;
  let draining = false;
  const sort = () => pending.sort((left, right) =>
    Number(right.jobId === foregroundJobId) - Number(left.jobId === foregroundJobId) ||
    Number(right.priority || 0) - Number(left.priority || 0) || left.sequence - right.sequence
  );
  const interruptForForeground = () => {
    const promoted = pending.find((task) => task.jobId === foregroundJobId);
    if (!activeTask?.interrupt || activeTask.interrupted || !promoted) return;
    if (activeTask.jobId === foregroundJobId &&
      Number(activeTask.priority || 0) >= Number(promoted.priority || 0)) return;
    activeTask.interrupted = true;
    void activeTask.interrupt();
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) {
        sort();
        const task = pending[0];
        const foreground = task.jobId === foregroundJobId;
        if (!foreground && monitor.shouldDeferBackground()) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        pending.shift();
        const profile = mediaResourceProfile(foreground ? "foreground" : "background");
        activeTask = { ...task, profile, interrupt: null, interrupted: false };
        try {
          const result = await task.run(profile);
          activeTask.interrupt = result?.interrupt || null;
          task.resolve(result?.value);
          interruptForForeground();
          await result?.completion;
        } catch (error) { task.reject(error); } finally { activeTask = null; }
      }
    } finally {
      draining = false;
      if (pending.length) void drain();
    }
  };
  return {
    enqueue({ taskId, jobId, stage, priority = 0, run }) {
      const promise = new Promise((resolve, reject) => {
        pending.push({ taskId, jobId, stage, priority, run, resolve, reject, sequence: sequence++ });
        sort(); interruptForForeground(); void drain();
      });
      void promise.catch(() => {});
      return promise;
    },
    prioritize(jobId) { foregroundJobId = jobId || null; sort(); interruptForForeground(); },
    cancelJob(jobId, error = new Error("Media work was cancelled.")) {
      const cancelled = pending.filter((task) => task.jobId === jobId);
      for (let index = pending.length - 1; index >= 0; index -= 1) if (pending[index].jobId === jobId) pending.splice(index, 1);
      for (const task of cancelled) task.reject(error);
      if (activeTask?.jobId === jobId && activeTask.interrupt && !activeTask.interrupted) {
        activeTask.interrupted = true; void activeTask.interrupt();
      }
      return cancelled.length;
    },
    snapshot() {
      return {
        foregroundJobId,
        active: activeTask ? { taskId: activeTask.taskId, jobId: activeTask.jobId, stage: activeTask.stage, profile: activeTask.profile.kind, mode: activeTask.profile.mode } : null,
        queued: pending.map((task) => ({ taskId: task.taskId, jobId: task.jobId, stage: task.stage, foreground: task.jobId === foregroundJobId })),
        responsiveness: monitor.snapshot(),
      };
    },
    shutdown() {
      for (const task of pending.splice(0)) task.reject(new Error("Media scheduler stopped."));
      if (activeTask?.interrupt && !activeTask.interrupted) void activeTask.interrupt();
      monitor.stop();
    },
  };
}
