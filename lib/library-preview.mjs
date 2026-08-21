const HLS_FIRST_EXTENSIONS = new Set([".mkv", ".avi", ".ts"]);

/** Containers Chromium cannot reliably play directly should use Companion HLS immediately. */
export function libraryPreviewNeedsHls(fileName) {
  const normalized = String(fileName || "").trim().toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 && HLS_FIRST_EXTENSIONS.has(normalized.slice(dot));
}

/** Preview attachments are local-only implementation details, never library matches. */
export function isLibraryPreviewJobId(sourceId) {
  return /^preview-[a-f0-9-]{36}$/i.test(String(sourceId || ""));
}
