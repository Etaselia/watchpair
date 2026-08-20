export type HlsAudioMode = "surround" | "stereo";

export function shouldRetryHlsWithStereo(options: {
  isHlsPlayback: boolean;
  mediaErrorCode?: number;
  fatalHlsMediaError?: boolean;
  sourceChannels?: number;
  audioMode: HlsAudioMode;
}): boolean;

export function withStereoHlsAudio(playbackUrl: string): string;

export function hlsAudioPreference(track?: {
  label: string;
  language?: string;
} | null): {
  name: string;
  lang?: string;
} | undefined;

export function resolveHlsAudioChannelCount(
  activeChannels?: string | number,
  sourceChannels?: number,
): number;
