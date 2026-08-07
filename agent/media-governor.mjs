import { availableParallelism, constants, cpus, setPriority } from "node:os";
import { performance } from "node:perf_hooks";

const MODES = Object.freeze({
  eco: Object.freeze({ foregroundShare: 0.6, backgroundShare: 0.2 }),
  balanced: Object.freeze({ foregroundShare: 0.85, backgroundShare: 0.3 }),
  fast: Object.freeze({ foregroundShare: 1, backgroundShare: 0.55 }),
});

export function normalizeResourceMode(value) {
  const mode = String(value || "").toLowerCase();
  return mode in MODES ? mode : "balanced";
}

export function mediaResourceProfile(kind, { mode = process.env.WATCHPAIR_RESOURCE_MODE, logicalCores = availableParallelism() } = {}) {
  const normalizedMode = normalizeResourceMode(mode);
  const settings = MODES[normalizedMode];
  const foreground = kind === "foreground";
  const cores = Math.max(1, Number(logicalCores) || 1);
  const systemTier = cores >= 16 ? "high" : cores >= 8 ? "standard" : "low";
  const tierBoost = systemTier === "high" ? (foreground ? 0.1 : 0.15) : 0;
  const share = Math.min(1, (foreground ? settings.foregroundShare : settings.backgroundShare) + tierBoost);
  const workerCeiling = Math.max(1, cores - 1);
  return {
    mode: normalizedMode,
    kind: foreground ? "foreground" : "background",
    systemTier,
    share,
    threads: Math.max(1, Math.min(workerCeiling, Math.floor(cores * share))),
    filterThreads: Math.max(1, Math.min(systemTier === "high" ? 4 : 2, Math.floor(cores * share))),
    inputRate: null,
    processPriority: foreground ? constants.priority.PRIORITY_BELOW_NORMAL : constants.priority.PRIORITY_LOW,
    gpuSurfaces: foreground ? (systemTier === "high" ? 20 : 8) : (systemTier === "high" ? 12 : 3),
    qsvAsyncDepth: foreground ? (systemTier === "high" ? 10 : 4) : (systemTier === "high" ? 6 : 1),
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
        eventLoopDelayMaxMs: Math.round((sorted.at(-1) || 0) * 10) / 10,
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

export function createMediaTaskScheduler({
  monitor = createResponsivenessMonitor(),
  retryDelayMs = 500,
  onEvent = () => {},
} = {}) {
  const pending = [];
  let activeTask = null;
  let foregroundJobId = null;
  let orderedJobIds = [];
  let jobOrder = new Map();
  let sequence = 0;
  let draining = false;
  let lastDeferredLogAt = 0;
  let deferredPreemptionKey = "";
  const emit = (event, data) => {
    try {
      onEvent(event, data);
    } catch {
      // Diagnostic reporting must never affect media scheduling.
    }
  };
  const rank = (jobId) => jobOrder.get(jobId) ?? Number.MAX_SAFE_INTEGER;
  const sort = () => pending.sort((left, right) =>
    Number(right.jobId === foregroundJobId) - Number(left.jobId === foregroundJobId) ||
    rank(left.jobId) - rank(right.jobId) ||
    Number(right.priority || 0) - Number(left.priority || 0) || left.sequence - right.sequence
  );
  const interruptForForeground = () => {
    const promoted = pending.find((task) => task.jobId === foregroundJobId);
    const restartPromotedActive = Boolean(
      activeTask?.restartOnPromotion &&
      activeTask.jobId === foregroundJobId &&
      activeTask.profile?.kind === "background"
    );
    if (
      !activeTask?.interrupt ||
      activeTask.interrupted ||
      (!promoted && !restartPromotedActive)
    ) return;
    if (!restartPromotedActive && activeTask.jobId === foregroundJobId &&
      Number(activeTask.priority || 0) >= Number(promoted.priority || 0)) return;
    if (activeTask.preemptible === false) {
      const promotedJobId = promoted?.jobId || foregroundJobId;
      const key = `${activeTask.jobId}:${promotedJobId}`;
      if (deferredPreemptionKey !== key) {
        deferredPreemptionKey = key;
        emit("media_task_preemption_deferred", {
          taskId: activeTask.taskId,
          jobId: activeTask.jobId,
          promotedJobId,
          stage: activeTask.stage,
        });
      }
      return;
    }
    deferredPreemptionKey = "";
    activeTask.interrupted = true;
    emit("media_task_preempted", {
      taskId: activeTask.taskId,
      jobId: activeTask.jobId,
      promotedJobId: foregroundJobId,
      reason: restartPromotedActive ? "foreground-profile" : "selected-work",
    });
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
          const now = Date.now();
          if (now - lastDeferredLogAt >= 5_000) {
            lastDeferredLogAt = now;
            emit("media_task_deferred", {
              taskId: task.taskId,
              jobId: task.jobId,
              responsiveness: monitor.snapshot(),
            });
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        pending.shift();
        const profile = mediaResourceProfile(foreground ? "foreground" : "background");
        const startedAt = Date.now();
        activeTask = { ...task, profile, interrupt: null, interrupted: false };
        emit("media_task_started", {
          taskId: task.taskId,
          jobId: task.jobId,
          stage: task.stage,
          profile: `${profile.mode}:${profile.kind}`,
          queuedMs: startedAt - task.queuedAt,
        });
        try {
          const result = await task.run(profile);
          activeTask.interrupt = result?.interrupt || null;
          task.resolve(result?.value);
          interruptForForeground();
          await result?.completion;
          emit("media_task_finished", {
            taskId: task.taskId,
            jobId: task.jobId,
            stage: task.stage,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          emit("media_task_failed", {
            taskId: task.taskId,
            jobId: task.jobId,
            stage: task.stage,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          task.reject(error);
        } finally {
          activeTask = null;
        }
      }
    } finally {
      draining = false;
      if (pending.length) void drain();
    }
  };
  return {
    enqueue({ taskId, jobId, stage, priority = 0, preemptible = true, restartOnPromotion = false, run }) {
      const queuedAt = Date.now();
      const promise = new Promise((resolve, reject) => {
        pending.push({
          taskId,
          jobId,
          stage,
          priority,
          preemptible,
          restartOnPromotion,
          run,
          resolve,
          reject,
          queuedAt,
          sequence: sequence++,
        });
        emit("media_task_queued", {
          taskId,
          jobId,
          stage,
          priority,
          preemptible,
          restartOnPromotion,
          queueDepth: pending.length,
        });
        sort(); interruptForForeground(); void drain();
      });
      void promise.catch(() => {});
      return promise;
    },
    prioritize(jobId) {
      const nextJobId = jobId || null;
      if (foregroundJobId === nextJobId) return false;
      foregroundJobId = nextJobId;
      emit("media_priority_changed", { foregroundJobId });
      sort();
      interruptForForeground();
      return true;
    },
    setJobOrder(jobIds = []) {
      const nextOrder = Array.from(new Set(jobIds.filter(Boolean)));
      if (
        nextOrder.length === orderedJobIds.length &&
        nextOrder.every((jobId, index) => jobId === orderedJobIds[index])
      ) return false;
      orderedJobIds = nextOrder;
      jobOrder = new Map(orderedJobIds.map((jobId, index) => [jobId, index]));
      emit("media_queue_order_changed", { jobIds: orderedJobIds });
      sort();
      interruptForForeground();
      return true;
    },
    cancelJob(jobId, error = new Error("Media work was cancelled.")) {
      const cancelled = pending.filter((task) => task.jobId === jobId);
      for (let index = pending.length - 1; index >= 0; index -= 1) if (pending[index].jobId === jobId) pending.splice(index, 1);
      for (const task of cancelled) task.reject(error);
      if (activeTask?.jobId === jobId && activeTask.interrupt && !activeTask.interrupted) {
        activeTask.interrupted = true; void activeTask.interrupt();
      }
      if (cancelled.length || activeTask?.jobId === jobId) {
        emit("media_job_cancelled", {
          jobId,
          queuedTasks: cancelled.length,
        });
      }
      return cancelled.length;
    },
    snapshot() {
      return {
        foregroundJobId,
        active: activeTask ? { taskId: activeTask.taskId, jobId: activeTask.jobId, stage: activeTask.stage, profile: activeTask.profile.kind, mode: activeTask.profile.mode } : null,
        orderedJobIds,
        queued: pending.map((task) => ({
          taskId: task.taskId,
          jobId: task.jobId,
          stage: task.stage,
          foreground: task.jobId === foregroundJobId,
          rank: jobOrder.get(task.jobId) ?? null,
        })),
        responsiveness: monitor.snapshot(),
      };
    },
    shutdown() {
      emit("media_scheduler_stopping", { queuedTasks: pending.length, activeTask: activeTask?.taskId || null });
      for (const task of pending.splice(0)) task.reject(new Error("Media scheduler stopped."));
      if (activeTask?.interrupt && !activeTask.interrupted) void activeTask.interrupt();
      monitor.stop();
    },
  };
}
