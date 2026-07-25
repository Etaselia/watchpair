import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const MANAGED_JOB_DIRECTORY = /^[a-zA-Z0-9-]{8,80}$/;

export async function pathSize(target) {
  const info = await stat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;

  const entries = await readdir(target, { withFileTypes: true });
  const sizes = await Promise.all(entries.map((entry) => pathSize(path.join(target, entry.name))));
  return sizes.reduce((total, size) => total + size, 0);
}

export async function removePathAndMeasure(target) {
  const bytes = await pathSize(target);
  await rm(target, { recursive: true, force: true });
  return bytes;
}

export async function pruneExpiredChildren(
  root,
  {
    now = Date.now(),
    maxAgeMs,
    include = () => true,
    protectedNames = new Set(),
  }
) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const removed = [];

  for (const entry of entries) {
    if (protectedNames.has(entry.name) || !include(entry)) continue;
    const target = path.join(root, entry.name);
    const info = await stat(target).catch(() => null);
    if (!info || now - info.mtimeMs < maxAgeMs) continue;
    const bytes = await removePathAndMeasure(target);
    removed.push({ name: entry.name, bytes });
  }
  return removed;
}
