import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  fontExtractionPlan,
  safeFontExtension,
  subtitleExtractionPlan,
} from "./subtitle-assets.mjs";

function validMediaKey(value) {
  const key = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{16,128}$/.test(key)) throw new Error("A valid media fingerprint is required for subtitle caching.");
  return key;
}

async function assetsReady(assets) {
  const states = await Promise.all(assets.map((asset) =>
    stat(typeof asset === "string" ? asset : asset.outputPath)
      .then((info) => info.size > 0).catch(() => false)
  ));
  return states.every(Boolean);
}

export function createSubtitleAssetPipeline({ cacheRoot, runScheduledFfmpeg }) {
  const pending = new Map();

  async function prepareContent(descriptor) {
    const mediaKey = validMediaKey(descriptor.mediaKey);
    const cacheIdentity = `${mediaKey}-${descriptor.fileSize}`;
    const directory = path.join(cacheRoot, "content", cacheIdentity);
    const schedulerJobId = descriptor.schedulerJobId || `content-${cacheIdentity}`;
    await mkdir(directory, { recursive: true });

    const fontPlan = fontExtractionPlan(
      descriptor.mediaPath,
      descriptor.streams,
      directory,
      {
        mediaKey,
        outputPathForStream: (stream) =>
          path.join(directory, `font-${stream.index}${safeFontExtension(stream.tags?.filename)}`),
      }
    );
    if (fontPlan.assets.length && !(await assetsReady(fontPlan.assets))) {
      await runScheduledFfmpeg({
        jobId: schedulerJobId,
        taskId: `subtitle-fonts:${mediaKey}`,
        stage: "subtitle-fonts",
        encoder: "attachment copy",
        decoder: "header-only",
        hardware: false,
        inputPath: descriptor.mediaPath,
        priority: 90,
        captureProgress: false,
        arguments: fontPlan.args,
      });
    }

    const subtitlePlan = subtitleExtractionPlan(
      descriptor.mediaPath,
      descriptor.streams,
      directory,
      {
        mediaKey,
        includeVttFallback: true,
        outputPathForStream: (stream, format) =>
          path.join(directory, `subtitle-${stream.index}.${format === "ass" ? "ass" : "vtt"}`),
      }
    );
    if (subtitlePlan.assets.length && !(await assetsReady(subtitlePlan.assets))) {
      await runScheduledFfmpeg({
        jobId: schedulerJobId,
        taskId: `subtitles:${mediaKey}`,
        stage: "subtitles",
        encoder: "subtitle text",
        decoder: "subtitle packets only",
        hardware: false,
        inputPath: descriptor.mediaPath,
        priority: 80,
        arguments: subtitlePlan.args,
      });
    }

    if (!(await assetsReady([...fontPlan.assets, ...subtitlePlan.assets]))) {
      throw new Error("FFmpeg did not produce every planned subtitle asset.");
    }
    return {
      cacheIdentity,
      directory,
      fonts: new Map(fontPlan.assets.map((asset) => [asset.id, asset.outputPath])),
      subtitles: new Map(subtitlePlan.assets.map((asset) => [`${asset.id}:${asset.format}`, asset.outputPath])),
    };
  }

  async function prepare(descriptor) {
    const mediaKey = validMediaKey(descriptor.mediaKey);
    const key = `${mediaKey}-${descriptor.fileSize}`;
    let promise = pending.get(key);
    if (promise) {
      const cached = await promise;
      if (await assetsReady([...cached.fonts.values(), ...cached.subtitles.values()])) return cached;
      const current = pending.get(key);
      if (current !== promise) return current;
      pending.delete(key);
      promise = null;
    }
    if (!promise) {
      promise = prepareContent(descriptor).catch((error) => {
        pending.delete(key);
        throw error;
      });
      pending.set(key, promise);
    }
    return promise;
  }

  return {
    prepare,
    snapshot() {
      return { cachedOrPreparing: pending.size, keys: Array.from(pending.keys()) };
    },
  };
}
