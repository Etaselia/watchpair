export function createVoiceAutoJoinState() {
  return {
    remoteActive: false,
    suppressed: false,
  };
}

export function reconcileVoiceAutoJoin(
  state,
  { remoteCount, localEnabled, localStarting }
) {
  const remoteActive = remoteCount > 0;
  if (!remoteActive) {
    return {
      state: createVoiceAutoJoinState(),
      shouldStart: false,
    };
  }

  const shouldStart = Boolean(
    !state.remoteActive &&
    !state.suppressed &&
    !localEnabled &&
    !localStarting
  );
  return {
    state: {
      remoteActive: true,
      // Claim the activation before opening the microphone so repeated room
      // snapshots cannot create concurrent permission prompts.
      suppressed: state.suppressed || shouldStart,
    },
    shouldStart,
  };
}

export function suppressVoiceAutoJoin(remoteCount) {
  const remoteActive = remoteCount > 0;
  return {
    remoteActive,
    suppressed: remoteActive,
  };
}

export function voiceMicrophoneFailureMessage(caught) {
  const errorName =
    caught && typeof caught === "object" && "name" in caught
      ? String(caught.name)
      : "";
  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    return "Microphone permission was not granted.";
  }
  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "No microphone was found.";
  }
  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "The microphone is already in use or unavailable.";
  }
  if (errorName === "OverconstrainedError" || errorName === "ConstraintNotSatisfiedError") {
    return "The selected microphone is unavailable.";
  }
  return caught instanceof Error && caught.message
    ? caught.message
    : "Microphone access failed.";
}

export function voiceAutoJoinFailureMessage(participantName, caught) {
  const detail = voiceMicrophoneFailureMessage(caught).replace(/\.$/, "");
  const sentenceDetail = detail.slice(0, 1).toLowerCase() + detail.slice(1);
  return `${participantName} joined voice, but ${sentenceDetail}. Select Join voice to try again.`;
}
