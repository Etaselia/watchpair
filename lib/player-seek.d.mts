import type { PlayerState } from "./session-types";

export interface LocalSeekTransaction {
  target: number;
  startedAt: number;
  committed: boolean;
  source: string;
  suppressionReported: boolean;
}

export const SEEK_ACK_TOLERANCE_SECONDS: number;
export const SEEK_TRANSACTION_TIMEOUT_MS: number;

export function clampSeekTarget(value: number, duration: number): number;
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
