export function mediaTargetKey(jobId, fileIndex) {
  const id = String(jobId || "");
  const index = Number(fileIndex);
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id) || !Number.isInteger(index) || index < 0) {
    throw new Error("A valid media target is required.");
  }
  return `${id}:${index}`;
}

export function normalizeMediaTargets(values, limit = 500) {
  if (!Array.isArray(values) || values.length > limit) {
    throw new Error("A valid media priority plan is required.");
  }
  const seen = new Set();
  return values.map((value) => {
    const jobId = String(value?.jobId || "");
    const fileIndex = Number(value?.fileIndex);
    const key = mediaTargetKey(jobId, fileIndex);
    if (seen.has(key)) throw new Error("A media priority plan cannot contain duplicate files.");
    seen.add(key);
    return {
      jobId,
      fileIndex,
      itemId: value?.itemId ? String(value.itemId).slice(0, 100) : null,
    };
  });
}

export function firstPendingMediaTarget(targets, resolveFile) {
  for (const target of targets) {
    const file = resolveFile(target);
    if (file && !file.done) return target;
  }
  return null;
}

export function preparationMediaTargets(selected, targets, downloadAllowed) {
  const active = selected ? normalizeMediaTargets([selected], 1)[0] : null;
  const activeKey = active ? mediaTargetKey(active.jobId, active.fileIndex) : null;
  const normalized = normalizeMediaTargets(targets || []);
  if (active && !normalized.some((target) => mediaTargetKey(target.jobId, target.fileIndex) === activeKey)) {
    normalized.unshift(active);
  }
  return normalized.filter((target) =>
    mediaTargetKey(target.jobId, target.fileIndex) === activeKey || downloadAllowed(target));
}

export function replaceTorrentSelections(torrent, selected = []) {
  if (!torrent?.files) return;
  for (const file of torrent.files) file.deselect();
  selected.forEach(({ fileIndex, priority = 100 }) => {
    const file = torrent.files[fileIndex];
    if (file && !file.done) file.select(priority);
  });
}
