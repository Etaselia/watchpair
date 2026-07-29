export const SEEK_ACK_TOLERANCE_SECONDS = 0.5;
export const SEEK_TRANSACTION_TIMEOUT_MS = 10_000;
export const PLAYBACK_TRANSACTION_TIMEOUT_MS = 10_000;

export function clampSeekTarget(value, duration) {
  const target = Number.isFinite(value) ? Math.max(0, value) : 0;
  return Number.isFinite(duration) && duration > 0 ? Math.min(target, duration) : target;
}

export function isSeekAcknowledgement(transaction, state, deviceId) {
  return Boolean(
    transaction?.committed &&
    state?.actorId === deviceId &&
    Math.abs(state.position - transaction.target) <= SEEK_ACK_TOLERANCE_SECONDS
  );
}

export function shouldHoldLocalSeek(transaction, state, deviceId, now = Date.now()) {
  if (!transaction) return false;
  if (isSeekAcknowledgement(transaction, state, deviceId)) return false;
  if (!transaction.committed) return true;
  return now - transaction.startedAt < SEEK_TRANSACTION_TIMEOUT_MS;
}

export function isPlaybackAcknowledgement(transaction, state, deviceId) {
  return Boolean(
    transaction &&
    state?.actorId === deviceId &&
    state.paused === transaction.paused
  );
}

export function shouldHoldLocalPlayback(transaction, state, deviceId, now = Date.now()) {
  if (!transaction) return false;
  if (isPlaybackAcknowledgement(transaction, state, deviceId)) return false;
  return now - transaction.startedAt < PLAYBACK_TRANSACTION_TIMEOUT_MS;
}
