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

function attachmentName(stream) {
  return String(stream.tags?.filename || `font-${stream.index}`).trim();
}

export function isFontAttachment(stream) {
  if (stream.codec_type !== "attachment") return false;
  const mimeType = String(stream.tags?.mimetype || "").toLowerCase();
  const extension = path.extname(attachmentName(stream)).toLowerCase();
  return FONT_MIME_TYPES.has(mimeType) || FONT_EXTENSIONS.has(extension);
}

export function fontAttachmentMetadata(streams, urlForStream) {
  return streams
    .filter(isFontAttachment)
    .map((stream) => {
      const mimeType = String(stream.tags?.mimetype || "").toLowerCase();
      return {
        id: String(stream.index),
        streamIndex: Number(stream.index),
        name: attachmentName(stream),
        mimeType: FONT_MIME_TYPES.has(mimeType) ? mimeType : "application/octet-stream",
        url: urlForStream(stream),
      };
    });
}

export function subtitleExtractionArgs(mediaPath, streamIndex, format, outputPath) {
  if (format === "ass") {
    return [
      "-v", "error",
      "-y",
      "-i", mediaPath,
      "-map", `0:${streamIndex}`,
      "-c:s", "ass",
      "-f", "ass",
      outputPath,
    ];
  }

  return [
    "-v", "error",
    "-y",
    "-i", mediaPath,
    "-map", `0:${streamIndex}`,
    "-f", "webvtt",
    outputPath,
  ];
}

export function fontExtractionArgs(mediaPath, streamIndex, outputPath, nullDevice) {
  return [
    "-v", "error",
    "-y",
    `-dump_attachment:${streamIndex}`,
    outputPath,
    "-i", mediaPath,
    "-f", "null",
    nullDevice,
  ];
}

export function safeFontExtension(name) {
  const extension = path.extname(name).toLowerCase();
  return FONT_EXTENSIONS.has(extension) ? extension : ".font";
}
