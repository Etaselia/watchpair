import type { SharedMediaItem, SharedSource } from "./session-types";

export interface QueuedMediaItem extends SharedMediaItem {
  sourceId: string;
  source: SharedSource;
}

export function normalizeMediaPath(value: unknown): string;
export function compareMediaPaths(left: unknown, right: unknown): number;
export function mediaItemId(sourceId: string, fileIndex: number): string;
export function mediaManifest(
  files: Array<Partial<SharedMediaItem> & { index?: number }>,
  sourceId: string
): SharedMediaItem[];
export function mediaQueue(sources: SharedSource[]): QueuedMediaItem[];
export function orderedMediaQueue(
  sources: SharedSource[],
  selectedItemId?: string | null
): QueuedMediaItem[];
export function sameMediaManifest(left: SharedMediaItem[], right: SharedMediaItem[]): boolean;
