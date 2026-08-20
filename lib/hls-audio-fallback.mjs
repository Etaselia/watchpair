export function shouldRetryHlsWithStereo({
  isHlsPlayback,
  mediaErrorCode,
  fatalHlsMediaError = false,
  sourceChannels,
  audioMode,
}) {
  return Boolean(
    isHlsPlayback &&
    (mediaErrorCode === 4 || fatalHlsMediaError) &&
    Number(sourceChannels) > 2 &&
    audioMode === "surround"
  );
}

export function withStereoHlsAudio(playbackUrl) {
  const url = new URL(playbackUrl);
  url.searchParams.set("audio", "stereo");
  return url.toString();
}

export function hlsAudioPreference(track) {
  if (!track?.label) return undefined;
  const preference = { name: String(track.label) };
  const language = String(track.language || "").toLowerCase();
  if (language && language !== "und") preference.lang = language;
  return preference;
}

export function resolveHlsAudioChannelCount(activeChannels, sourceChannels) {
  const activeCount = Number.parseInt(String(activeChannels || ""), 10);
  if (Number.isFinite(activeCount) && activeCount > 0) return activeCount;
  const sourceCount = Number(sourceChannels);
  return Number.isFinite(sourceCount) && sourceCount > 0 ? sourceCount : 0;
}
