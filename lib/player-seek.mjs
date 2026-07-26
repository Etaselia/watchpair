export const SEEK_ACK_TOLERANCE_SECONDS = 0.5;
export const SEEK_TRANSACTION_TIMEOUT_MS = 10_000;

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
