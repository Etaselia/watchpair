import type { SharedSource, SelectedMedia, WatchRecord } from "./session-types";
export function mediaWatchKey(source?: SharedSource | null, media?: Partial<SelectedMedia>): string;
export function isMediaWatched(records: Record<string, WatchRecord> | undefined, source?: SharedSource | null, media?: Partial<SelectedMedia>): boolean;
export function mergeWatchedRanges(ranges: [number, number][], start: number, end: number, duration: number): [number, number][];
export function watchedFraction(ranges: [number, number][], duration: number): number;
export function createWatchCoverageTracker(): {
  observe(sample: { position: number; time: number; rate?: number; playing?: boolean; seeking?: boolean }): void;
  discontinuity(): void;
  ranges(): [number, number][];
};
export function unreportedWatchedRanges(played: [number, number][], reported: [number, number][], duration: number): [number, number][];
export function downloadFileIndexes(source: SharedSource, records?: Record<string, WatchRecord>): number[] | null;
export function relativeWatchTime(timestamp: number, now?: number): string;
