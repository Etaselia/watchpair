export function chapterProbeArguments(mediaPath) {
  return [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_chapters",
    "-show_format",
    mediaPath,
  ];
}

export function normalizeMediaChapters(chapters) {
  if (!Array.isArray(chapters)) return [];

  return chapters
    .map((chapter, index) => {
      const start = Number(chapter?.start_time);
      const end = Number(chapter?.end_time);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

      const title = String(chapter?.tags?.title || "").trim();
      const language = String(chapter?.tags?.language || "und").trim().toLowerCase() || "und";
      return {
        id: String(chapter?.id ?? index),
        index,
        title: title || `Chapter ${index + 1}`,
        start: Math.max(0, start),
        end,
        language,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start)
    .map((chapter, index) => ({ ...chapter, index }));
}

export function mediaDurationFromProbe(metadata) {
  const videoStream = (metadata?.streams || []).find(
    (stream) => stream.codec_type === "video"
  );
  const streamDuration = Number(videoStream?.duration);
  if (Number.isFinite(streamDuration) && streamDuration > 0) return streamDuration;

  const formatDuration = Number(metadata?.format?.duration);
  const rawStart = Number(videoStream?.start_time ?? metadata?.format?.start_time ?? 0);
  const start = Number.isFinite(rawStart) ? Math.max(0, rawStart) : 0;
  const duration = formatDuration - start;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}
