import type { PlayerState } from "./session-types";

export interface LocalSeekTransaction {
  target: number;
  startedAt: number;
  committed: boolean;
  source: string;
  suppressionReported: boolean;
}

export interface LocalPlaybackTransaction {
  paused: boolean;
  startedAt: number;
  suppressionReported: boolean;
}

export const SEEK_ACK_TOLERANCE_SECONDS: number;
export const SEEK_TRANSACTION_TIMEOUT_MS: number;

export const PLAYBACK_TRANSACTION_TIMEOUT_MS: number;
export function clampSeekTarget(value: number, duration: number): number;
export function clampToPreparedRanges(
  value: number,
  ranges: Array<{ start: number; end: number }>,
  edgeMargin?: number
): number;
export function isSeekAcknowledgement(
  transaction: LocalSeekTransaction | null,
  state: PlayerState,
  deviceId: string
): boolean;
export function shouldHoldLocalSeek(
  transaction: LocalSeekTransaction | null,
  state: PlayerState,
  deviceId: string,
  now?: number
): boolean;
export function isPlaybackAcknowledgement(
  transaction: LocalPlaybackTransaction | null,
  state: PlayerState,
  deviceId: string
): boolean;
export function shouldHoldLocalPlayback(
  transaction: LocalPlaybackTransaction | null,
  state: PlayerState,
  deviceId: string,
  now?: number
): boolean;
