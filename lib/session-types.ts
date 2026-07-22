export type SourceKind = "magnet" | "direct";

export interface SharedSource {
  id: string;
  kind: SourceKind;
  value: string;
  label: string;
  addedBy: string;
  addedAt: number;
}

export interface SelectedMedia {
  sourceId?: string;
  fileIndex?: number;
  name: string;
  size: number;
  fingerprint?: string;
}

export interface PlayerState {
  paused: boolean;
  position: number;
  playbackRate: number;
  audioLanguage: string;
  subtitleLanguage: string;
  subtitleOffset: number;
  changedAt: number;
  actorId: string;
}

export interface QueueReadiness {
  ready: boolean;
  progress: number;
  status: string;
  fileName: string | null;
  fileSize: number | null;
  fingerprint: string | null;
  preparation: "waiting" | "queued" | "preparing" | "ready" | "direct" | "error";
}

export interface ParticipantState extends QueueReadiness {
  deviceId: string;
  name: string;
  queue: Record<string, QueueReadiness>;
  updatedAt: number;
}

export interface WatchSession {
  token: string;
  hostId: string;
  sources: SharedSource[];
  source: SharedSource | null;
  selectedMedia: SelectedMedia | null;
  player: PlayerState;
  seq: number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  serverTime: number;
  participants: ParticipantState[];
}

export interface LocalReadiness extends QueueReadiness {
  queue: Record<string, QueueReadiness>;
}

export const initialPlayerState = (now = Date.now()): PlayerState => ({
  paused: true,
  position: 0,
  playbackRate: 1,
  audioLanguage: "original",
  subtitleLanguage: "off",
  subtitleOffset: 0,
  changedAt: now,
  actorId: "system",
});
