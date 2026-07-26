import { spawn } from "node:child_process";
import { applyMediaProcessPriority } from "./media-governor.mjs";
import { attachFfmpegProgress } from "./process-registry.mjs";

function pipelineError(stage, code, stderr) {
  const detail = stderr.trim().split(/\r?\n/).slice(-4).join(" ").slice(0, 700);
  return new Error(
    `${stage} failed${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : "."}`
  );
}

export function createScheduledFfmpegRunner({ ffmpegPath, scheduler, processRegistry, spawnProcess = spawn }) {
  if (!ffmpegPath || !scheduler || !processRegistry) {
    throw new Error("Scheduled FFmpeg requires a binary, scheduler, and process registry.");
  }

  return function runScheduledFfmpeg({
    jobId,
    taskId,
    stage,
    trackId = null,
    encoder = null,
    decoder = null,
    hardware = false,
    inputPath = null,
    priority = 0,
    captureProgress = true,
    arguments: fixedArguments,
    argumentsForProfile,
  }) {
    return scheduler.enqueue({
      jobId,
      taskId,
      stage,
      priority,
      run: async (profile) => {
        const mediaArguments = argumentsForProfile
          ? argumentsForProfile(profile)
          : fixedArguments;
        const ffmpegArguments = captureProgress
          ? ["-progress", "pipe:1", "-nostats", ...mediaArguments]
          : mediaArguments;
        const child = spawnProcess(ffmpegPath, ffmpegArguments, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        applyMediaProcessPriority(child, profile);
        const tracker = child.pid ? processRegistry.track(child, {
          jobId,
          taskId,
          stage,
          trackId,
          encoder,
          decoder,
          hardware,
          profile: `${profile.mode}:${profile.kind}`,
          command: ffmpegPath,
          arguments: ffmpegArguments,
          privatePaths: [inputPath],
        }) : null;
        if (captureProgress) attachFfmpegProgress(child.stdout, tracker);
        else child.stdout.resume();
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk.toString()).slice(-16_384);
        });
        const completion = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => {
            if (code === 0) resolve();
            else reject(pipelineError(stage, code, stderr));
          });
        });
        return {
          value: completion,
          completion,
          interrupt: () => child.kill("SIGTERM"),
        };
      },
    });
  };
}
