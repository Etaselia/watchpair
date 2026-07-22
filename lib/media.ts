import type { SharedSource, SourceKind } from "./session-types";

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export function normalizeToken(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .replace(/^(.{4})(.+)$/, "$1-$2")
    .slice(0, 9);
}

export function formatBytes(bytes: number | null | undefined) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00";
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export async function fingerprintFile(file: File) {
  const sampleSize = 512 * 1024;
  const first = file.slice(0, Math.min(file.size, sampleSize));
  const last = file.slice(Math.max(0, file.size - sampleSize), file.size);
  const payload = await new Blob([first, last, String(file.size)]).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function sourceLabel(value: string) {
  if (value.startsWith("magnet:")) {
    const displayName = new URLSearchParams(value.slice(value.indexOf("?") + 1)).get("dn");
    return displayName ? decodeURIComponent(displayName.replace(/\+/g, " ")) : "Magnet download";
  }

  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || url.hostname);
  } catch {
    return "Shared video";
  }
}

export async function resolveSharedSource(rawValue: string): Promise<Pick<SharedSource, "kind" | "value" | "label">> {
  const value = rawValue.trim();
  if (value.startsWith("magnet:?")) {
    return { kind: "magnet", value, label: sourceLabel(value) };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Paste a magnet link, direct video URL, or a public page URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only magnet, HTTP, and HTTPS sources are supported.");
  }

  const isDirectMedia = /\.(mp4|m4v|webm|ogv|mov|mkv)(?:$|[?#])/i.test(value);
  if (isDirectMedia) {
    return { kind: "direct", value, label: sourceLabel(value) };
  }

  try {
    const response = await fetch(value, { headers: { Accept: "text/html,video/*" } });
    if (!response.ok) throw new Error(`The page returned ${response.status}.`);

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.startsWith("video/")) {
      return { kind: "direct", value, label: sourceLabel(value) };
    }

    const html = (await response.text()).slice(0, 2_000_000);
    const magnetMatch = html.match(/magnet:\?[^"'<>\s]+/i);
    if (magnetMatch) {
      const magnet = magnetMatch[0].replaceAll("&amp;", "&");
      return { kind: "magnet", value: magnet, label: sourceLabel(magnet) };
    }

    const mediaMatch = html.match(/https?:\/\/[^"'<>\s]+\.(?:mp4|m4v|webm|ogv)(?:\?[^"'<>\s]*)?/i);
    if (mediaMatch) {
      const mediaUrl = mediaMatch[0].replaceAll("&amp;", "&");
      return { kind: "direct", value: mediaUrl, label: sourceLabel(mediaUrl) };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The page could not be read.";
    throw new Error(`Could not resolve that page in the browser. Paste its magnet or direct video link instead. ${reason}`);
  }

  throw new Error("No magnet or playable video link was found on that page.");
}

interface StorageWithDirectory {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

export async function downloadDirectFile(
  source: Pick<SharedSource, "id" | "value" | "label">,
  onProgress: (progress: number) => void,
  signal: AbortSignal
) {
  const response = await fetch(source.value, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status}.`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const contentType = response.headers.get("content-type") || "video/mp4";
  const reader = response.body.getReader();
  const storage = navigator.storage as unknown as StorageWithDirectory;
  const root = storage.getDirectory ? await storage.getDirectory() : null;
  const handle = root
    ? await root.getFileHandle(`watchpair-${source.id}.media`, { create: true })
    : null;
  const writable = handle ? await handle.createWritable() : null;
  const chunks: ArrayBuffer[] = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (writable) {
        await writable.write(value);
      } else {
        chunks.push(value.slice().buffer);
      }
      onProgress(total ? (received / total) * 100 : Math.min(95, received / 1_000_000));
    }
    await writable?.close();
  } catch (error) {
    await writable?.abort();
    throw error;
  }

  onProgress(100);
  if (handle) {
    return handle.getFile();
  }
  return new File(chunks, source.label, { type: contentType });
}

function timestampToSeconds(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return Number.NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

export function parseSubtitles(contents: string): SubtitleCue[] {
  const blocks = contents
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .split(/\n{2,}/);

  return blocks.flatMap((block) => {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];

    const [startValue, endValue] = lines[timingIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const start = timestampToSeconds(startValue);
    const end = timestampToSeconds(endValue);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

    return [{
      start,
      end,
      text: lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, ""),
    }];
  });
}

export function sourceKindLabel(kind: SourceKind) {
  return kind === "magnet" ? "Magnet" : "Direct";
}
