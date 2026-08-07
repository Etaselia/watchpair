import { applyMediaProcessPriority, mediaResourceProfile } from "./media-governor.mjs";

export function renderResourceProfile(kind, logicalCores) {
  return mediaResourceProfile(kind, { logicalCores });
}

export function renderInputArguments(profile) {
  return [
    ...(profile.inputRate ? ["-readrate", String(profile.inputRate)] : []),
    "-threads:v", String(profile.threads),
  ];
}

export function renderEncoderArguments(encoder, profile) {
  if (!encoder || encoder.id === "copy") return [];
  const args = ["-threads", String(profile.threads)];
  if (encoder.id === "nvenc") args.push("-surfaces", String(profile.gpuSurfaces));
  if (encoder.id === "qsv") args.push("-async_depth", String(profile.qsvAsyncDepth));
  return args;
}

export function applyRenderProcessPriority(child, profile) {
  return applyMediaProcessPriority(child, profile);
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
