import { createHash } from "node:crypto";
import path from "node:path";

export const TEXT_SUBTITLE_CODECS = new Set([
  "ass",
  "mov_text",
  "ssa",
  "subrip",
  "text",
  "webvtt",
]);

export const STYLED_SUBTITLE_CODECS = new Set(["ass", "ssa"]);

const FONT_EXTENSIONS = new Set([".otf", ".ttf", ".woff", ".woff2"]);
const FONT_MIME_TYPES = new Set([
  "application/font-sfnt",
  "application/vnd.ms-opentype",
  "application/x-font-opentype",
  "application/x-font-ttf",
  "application/x-font-woff",
  "application/x-font-woff2",
  "font/otf",
  "font/sfnt",
  "font/ttf",
  "font/woff",
  "font/woff2",
]);

function numericIndex(stream) {
  const index = Number(stream.index);
  return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
}

function attachmentName(stream) {
  return String(stream.tags?.filename || `font-${stream.index}`).trim();
}

function subtitleCodec(stream) {
  return String(stream.codec_name || stream.codec || "").toLowerCase();
}

function subtitleFormat(stream) {
  return STYLED_SUBTITLE_CODECS.has(subtitleCodec(stream)) ? "ass" : "webvtt";
}

function stableKey(kind, mediaKey, stream, format = "") {
  const identity = {
    kind,
    mediaKey: String(mediaKey || "media"),
    streamIndex: numericIndex(stream),
    codec: subtitleCodec(stream),
    format,
    name: attachmentName(stream),
    mimeType: String(stream.tags?.mimetype || "").toLowerCase(),
    language: String(stream.tags?.language || "").toLowerCase(),
    title: String(stream.tags?.title || ""),
  };
  return `${kind}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}`;
}

function defaultSubtitlePath(outputDirectory, stream, format) {
  return path.join(outputDirectory, `subtitle-${numericIndex(stream)}.${format === "ass" ? "ass" : "vtt"}`);
}

function defaultFontPath(outputDirectory, stream) {
  return path.join(outputDirectory, `font-${numericIndex(stream)}${safeFontExtension(attachmentName(stream))}`);
}

export function isTextSubtitle(stream) {
  return stream?.codec_type === "subtitle" && TEXT_SUBTITLE_CODECS.has(subtitleCodec(stream));
}

export function textSubtitleStreams(streams) {
  return [...(streams || [])].filter(isTextSubtitle).sort((left, right) => numericIndex(left) - numericIndex(right));
}

export function isFontAttachment(stream) {
  if (stream.codec_type !== "attachment") return false;
  const mimeType = String(stream.tags?.mimetype || "").toLowerCase();
  const extension = path.extname(attachmentName(stream)).toLowerCase();
  return FONT_MIME_TYPES.has(mimeType) || FONT_EXTENSIONS.has(extension);
}

export function fontAttachmentMetadata(streams, urlForStream) {
  return [...(streams || [])]
    .filter(isFontAttachment)
    .sort((left, right) => numericIndex(left) - numericIndex(right))
    .map((stream) => {
      const mimeType = String(stream.tags?.mimetype || "").toLowerCase();
      return {
        id: String(stream.index),
        streamIndex: numericIndex(stream),
        name: attachmentName(stream),
        mimeType: FONT_MIME_TYPES.has(mimeType) ? mimeType : "application/octet-stream",
        url: urlForStream(stream),
      };
    });
}

export function subtitleAssetMetadata(streams, urlForStream, options = {}) {
  return textSubtitleStreams(streams).map((stream) => {
    const format = subtitleFormat(stream);
    return {
      id: String(stream.index),
      streamIndex: numericIndex(stream),
      codec: subtitleCodec(stream),
      format,
      language: String(stream.tags?.language || ""),
      title: String(stream.tags?.title || ""),
      default: Boolean(stream.disposition?.default),
      forced: Boolean(stream.disposition?.forced),
      styled: STYLED_SUBTITLE_CODECS.has(subtitleCodec(stream)),
      cacheKey: stableKey("subtitle", options.mediaKey, stream, format),
      url: urlForStream(stream),
    };
  });
}

export function fontAssetMetadata(streams, urlForStream, options = {}) {
  const attachmentOrdinals = new Map([...(streams || [])]
    .filter((stream) => stream.codec_type === "attachment")
    .sort((left, right) => numericIndex(left) - numericIndex(right))
    .map((stream, ordinal) => [numericIndex(stream), ordinal]));
  return fontAttachmentMetadata(streams, urlForStream).map((metadata) => {
    const stream = (streams || []).find((candidate) => numericIndex(candidate) === metadata.streamIndex);
    return {
      ...metadata,
      ordinal: attachmentOrdinals.get(metadata.streamIndex),
      cacheKey: stableKey("font", options.mediaKey, stream || { index: metadata.streamIndex, tags: { filename: metadata.name } }),
    };
  });
}

export function subtitleExtractionPlan(mediaPath, streams, outputDirectory, options = {}) {
  const tracks = textSubtitleStreams(streams);
  const assets = tracks.flatMap((stream) => {
    const defaultFormat = subtitleFormat(stream);
    const requestedFormats = options.formatsForStream
      ? options.formatsForStream(stream, defaultFormat)
      : options.includeVttFallback && defaultFormat === "ass" ? ["ass", "webvtt"] : [defaultFormat];
    const formats = [...new Set(requestedFormats)]
      .map((format) => format === "ass" ? "ass" : "webvtt")
      .filter((format, index, values) => values.indexOf(format) === index);
    return formats.map((format) => {
      const outputPath = options.outputPathForStream
        ? options.outputPathForStream(stream, format)
        : defaultSubtitlePath(outputDirectory, stream, format);
      return {
        id: String(stream.index),
        streamIndex: numericIndex(stream),
        codec: subtitleCodec(stream),
        format,
        outputPath,
        cacheKey: stableKey("subtitle", options.mediaKey, stream, format),
      };
    });
  });

  const args = ["-v", "error", "-y", "-threads", "1", "-i", mediaPath];
  for (const asset of assets) {
    args.push("-map", `0:${asset.streamIndex}`, "-c:s", asset.format, "-f", asset.format, asset.outputPath);
  }

  return {
    kind: "subtitle-extraction",
    mediaPath,
    assets,
    args,
    decodesVideo: false,
    decodesAudio: false,
    outputsFrames: false,
  };
}

export function batchSubtitleExtractionArgs(mediaPath, streams, outputDirectory, options = {}) {
  return subtitleExtractionPlan(mediaPath, streams, outputDirectory, options).args;
}

export function fontExtractionPlan(mediaPath, streams, outputDirectory, options = {}) {
  const attachments = [...(streams || [])]
    .filter((stream) => stream.codec_type === "attachment")
    .sort((left, right) => numericIndex(left) - numericIndex(right));
  const attachmentOrdinals = new Map(attachments.map((stream, ordinal) => [numericIndex(stream), ordinal]));
  const assets = attachments.filter(isFontAttachment).map((stream) => ({
    id: String(stream.index),
    streamIndex: numericIndex(stream),
    ordinal: attachmentOrdinals.get(numericIndex(stream)),
    name: attachmentName(stream),
    outputPath: options.outputPathForStream
      ? options.outputPathForStream(stream, attachmentOrdinals.get(numericIndex(stream)))
      : defaultFontPath(outputDirectory, stream),
    cacheKey: stableKey("font", options.mediaKey, stream),
  }));

  const args = ["-v", "error", "-y"];
  for (const asset of assets) {
    args.push("-dump_attachment:t:" + asset.ordinal, asset.outputPath);
  }
  args.push("-i", mediaPath, "-map", "0:t?", "-c", "copy", "-t", "0", "-f", "matroska", "pipe:1");

  return {
    kind: "font-extraction",
    mediaPath,
    assets,
    args,
    headerOnly: true,
    decodesVideo: false,
    decodesAudio: false,
    outputsFrames: false,
  };
}

export function batchFontExtractionArgs(mediaPath, streams, outputDirectory, options = {}) {
  return fontExtractionPlan(mediaPath, streams, outputDirectory, options).args;
}

export function subtitleExtractionArgs(mediaPath, streamIndex, format, outputPath) {
  return subtitleExtractionPlan(
    mediaPath,
    [{ codec_type: "subtitle", codec_name: format, index: streamIndex }],
    path.dirname(outputPath),
    { outputPathForStream: () => outputPath },
  ).args;
}

export function fontExtractionArgs(mediaPath, streamIndex, outputPath, _nullDevice) {
  void _nullDevice;
  return fontExtractionPlan(
    mediaPath,
    [{ codec_type: "attachment", codec_name: "attachment", index: streamIndex, tags: { filename: path.basename(outputPath) } }],
    path.dirname(outputPath),
    { outputPathForStream: () => outputPath },
  ).args;
}

export function safeFontExtension(name) {
  const extension = path.extname(name).toLowerCase();
  return FONT_EXTENSIONS.has(extension) ? extension : ".font";
}
