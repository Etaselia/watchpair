import { availableParallelism, constants, setPriority } from "node:os";

const FOREGROUND_SHARE = 0.85;
const BACKGROUND_SHARE = 0.25;

export function renderResourceProfile(kind, logicalCores = availableParallelism()) {
  const foreground = kind === "foreground";
  const share = foreground ? FOREGROUND_SHARE : BACKGROUND_SHARE;
  const cores = Math.max(1, Number(logicalCores) || 1);
  return {
    kind: foreground ? "foreground" : "background",
    share,
    threads: Math.max(1, Math.min(cores, Math.round(cores * share))),
    filterThreads: Math.max(1, Math.min(4, Math.round(cores * share))),
    inputRate: foreground ? 8 : 1.5,
    processPriority: foreground
      ? constants.priority.PRIORITY_BELOW_NORMAL
      : constants.priority.PRIORITY_LOW,
    gpuSurfaces: foreground ? 8 : 2,
    qsvAsyncDepth: foreground ? 4 : 1,
  };
}

export function renderInputArguments(profile) {
  return ["-readrate", String(profile.inputRate)];
}

export function renderEncoderArguments(encoder, profile) {
  if (!encoder || encoder.id === "copy") return [];
  const args = ["-threads", String(profile.threads)];
  if (encoder.id === "nvenc") args.push("-surfaces", String(profile.gpuSurfaces));
  if (encoder.id === "qsv") args.push("-async_depth", String(profile.qsvAsyncDepth));
  return args;
}

export function applyRenderProcessPriority(child, profile) {
  if (!child?.pid) return false;
  try {
    setPriority(child.pid, profile.processPriority);
    return true;
  } catch {
    return false;
  }
}

export function createSerialRenderQueue() {
  const pending = [];
  let active = false;
  let activeJobId = null;
  let activeProfile = null;
  let activeResult = null;
  let activeInterrupted = false;
  let foregroundJobId = null;
  let sequence = 0;

  const sort = () => {
    pending.sort((left, right) =>
      Number(right.jobId === foregroundJobId) - Number(left.jobId === foregroundJobId) ||
      left.sequence - right.sequence
    );
  };

  const interruptBackground = () => {
    if (
      activeInterrupted ||
      !activeResult?.interrupt ||
      !foregroundJobId ||
      activeJobId === foregroundJobId ||
      !pending.some((task) => task.jobId === foregroundJobId)
    ) return;
    activeInterrupted = true;
    void activeResult.interrupt();
  };

  const drain = async () => {
    if (active) return;
    active = true;
    try {
      while (pending.length) {
        sort();
        const task = pending.shift();
        activeJobId = task.jobId;
        try {
          activeProfile = task.jobId === foregroundJobId ? "foreground" : "background";
          activeResult = await task.run(activeProfile);
          task.resolve(activeResult.value);
          interruptBackground();
          await activeResult.completion?.catch(() => {});
        } catch (error) {
          task.reject(error);
        } finally {
          activeJobId = null;
          activeProfile = null;
          activeResult = null;
          activeInterrupted = false;
        }
      }
    } finally {
      active = false;
      if (pending.length) void drain();
    }
  };

  return {
    enqueue(jobId, run) {
      const promise = new Promise((resolve, reject) => {
        pending.push({ jobId, run, resolve, reject, sequence: sequence++ });
        sort();
        interruptBackground();
        void drain();
      });
      void promise.catch(() => {});
      return promise;
    },
    prioritize(jobId) {
      foregroundJobId = jobId || null;
      sort();
      interruptBackground();
    },
    cancel(jobId, error = new Error("Render was cancelled.")) {
      const cancelled = pending.filter((task) => task.jobId === jobId);
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (pending[index].jobId === jobId) pending.splice(index, 1);
      }
      for (const task of cancelled) task.reject(error);
      return cancelled.length;
    },
    status() {
      return { activeJobId, activeProfile, foregroundJobId, queuedJobIds: pending.map((task) => task.jobId) };
    },
  };
}
