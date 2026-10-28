import { isMediaWatched } from "./watch-history.mjs";

const VIDEO_EXTENSION = /\.(?:mp4|m4v|webm|ogv|mov|mkv|avi|ts)$/i;

export function normalizeMediaPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 500);
}

function naturalTokens(value) {
  return normalizeMediaPath(value)
    .toLowerCase()
    .match(/\d+|\D+/g) || [];
}

export function compareMediaPaths(left, right) {
  const leftTokens = naturalTokens(left);
  const rightTokens = naturalTokens(right);
  const length = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === undefined) return -1;
    if (rightToken === undefined) return 1;
    if (leftToken === rightToken) continue;
    const leftNumber = /^\d+$/.test(leftToken) ? Number(leftToken) : null;
    const rightNumber = /^\d+$/.test(rightToken) ? Number(rightToken) : null;
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    return leftToken.localeCompare(rightToken, "en");
  }
  return String(left).localeCompare(String(right), "en");
}

export function mediaItemId(sourceId, fileIndex) {
  const id = String(sourceId || "");
  const index = Number(fileIndex);
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id) || !Number.isInteger(index) || index < 0) {
    throw new Error("A valid media source and file index are required.");
  }
  return `${id}-f${index}`;
}

export function mediaManifest(files, sourceId) {
  return files
    .filter((file) => file && VIDEO_EXTENSION.test(String(file.path || file.name || "")))
    .map((file) => {
      const fileIndex = Number(file.index);
      const relativePath = normalizeMediaPath(file.path || file.name);
      return {
        id: mediaItemId(sourceId, fileIndex),
        fileIndex,
        path: relativePath,
        name: relativePath.split("/").at(-1) || "video",
        size: Math.max(0, Number(file.size) || 0),
        included: file.included !== false,
        priority: Boolean(file.priority),
      };
    })
    .sort((left, right) => compareMediaPaths(left.path, right.path) || left.fileIndex - right.fileIndex);
}

export function torrentFileSelectionStatus(source, job, {
  agentAvailable = false, agentUpdateRequired = false, policy = "automatic", approved = false, syncError = "",
} = {}) {
  if (source.mediaItems?.length) return "Choose files before downloading";
  if (syncError) return `Could not load the file list: ${syncError} Retrying…`;
  if (job?.files?.length) return mediaManifest(job.files, source.id).length
    ? "Syncing file list with the room…"
    : "This torrent contains no supported video files.";
  if (!agentAvailable) return agentUpdateRequired
    ? "Update the Companion to load the file list."
    : "Connect the Companion to load the file list.";
  if (policy === "never") return "Set Download here to Auto or Ask to load the file list.";
  if (job?.status === "error") return job.error || "Could not load the torrent's file list. Retry to try again.";
  if (job?.paused || job?.status === "paused" || (policy === "ask" && !approved && !job)) {
    return "Choose files to start loading the file list.";
  }
  return "Loading file list from torrent peers…";
}

export function mediaQueue(sources, watchRecords = {}) {
  return (sources || []).flatMap((source) =>
    (source.mediaItems || [])
      .filter((item) => source.selectionConfirmed !== false && item.included !== false && !isMediaWatched(watchRecords, source, item))
      .map((item) => ({ ...item, sourceId: source.id, source }))
  );
}

export function orderedMediaQueue(sources, selectedItemId = null, watchRecords = {}) {
  const queue = mediaQueue(sources, watchRecords);
  if (!queue.length) return [];
  const selectedIndex = queue.findIndex((item) => item.id === selectedItemId);
  const rotated = selectedIndex >= 0
    ? [...queue.slice(selectedIndex), ...queue.slice(0, selectedIndex)]
    : queue;
  const selected = selectedIndex >= 0 ? rotated[0] : null;
  const remaining = selected ? rotated.slice(1) : rotated;
  return [
    ...(selected ? [selected] : []),
    ...remaining.filter((item) => item.priority),
    ...remaining.filter((item) => !item.priority),
  ];
}

export function sameMediaManifest(left, right) {
  if (left.length !== right.length) return false;
  const candidates = new Map(right.map((item) => [item.id, item]));
  return left.every((item) => {
    const candidate = candidates.get(item.id);
    return Boolean(candidate) &&
      item.fileIndex === candidate.fileIndex &&
      item.path === candidate.path &&
      item.size === candidate.size;
  });
}

export function mediaFolderTree(items) {
  const root = { name: "All files", path: "", items: [], children: [] };
  for (const item of items) {
    const parts = normalizeMediaPath(item.path || item.name).split("/");
    parts.pop();
    let folder = root;
    for (const name of parts) {
      const path = folder.path ? `${folder.path}/${name}` : name;
      let child = folder.children.find((candidate) => candidate.path === path);
      if (!child) {
        child = { name, path, items: [], children: [] };
        folder.children.push(child);
      }
      folder = child;
    }
    folder.items.push(item);
  }
  const sortFolder = (folder) => {
    folder.items.sort((a, b) => compareMediaPaths(a.path, b.path));
    folder.children.sort((a, b) => compareMediaPaths(a.path, b.path));
    folder.children.forEach(sortFolder);
  };
  sortFolder(root);
  return root;
}
