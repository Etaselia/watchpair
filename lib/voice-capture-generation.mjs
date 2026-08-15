export function createVoiceCaptureGenerationGuard() {
  let generation = 0;
  let mounted = true;

  return {
    begin(sessionToken) {
      generation += 1;
      return {
        generation,
        sessionToken: sessionToken ?? null,
      };
    },
    cancel() {
      generation += 1;
    },
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
      generation += 1;
    },
    owns(lease) {
      return mounted && lease.generation === generation;
    },
    isCurrent(lease, sessionToken) {
      return Boolean(
        mounted &&
        lease.generation === generation &&
        lease.sessionToken === (sessionToken ?? null)
      );
    },
  };
}

function stopStream(stream) {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {
    // Capture teardown is best effort and must not block the next attempt.
  }
}

function stopTrack(track) {
  try {
    track?.stop();
  } catch {
    // Capture teardown is best effort and must not block the next attempt.
  }
}

function closeContext(context) {
  try {
    const closing = context?.close();
    if (closing && typeof closing.catch === "function") closing.catch(() => {});
  } catch {
    // Capture teardown is best effort and must not block the next attempt.
  }
}

export function createPendingVoiceCaptureRegistry() {
  let current = null;

  const isCurrent = (capture) => Boolean(
    capture && capture === current && capture.status === "pending"
  );

  const dispose = (capture) => {
    if (!capture || capture.status !== "pending") return false;
    capture.status = "disposed";
    if (current === capture) current = null;
    stopStream(capture.rawStream);
    stopTrack(capture.outboundTrack);
    closeContext(capture.context);
    capture.rawStream = null;
    capture.outboundTrack = null;
    capture.context = null;
    capture.gainNode = null;
    return true;
  };

  return {
    begin() {
      dispose(current);
      current = {
        status: "pending",
        rawStream: null,
        outboundTrack: null,
        context: null,
        gainNode: null,
      };
      return current;
    },
    attachRawStream(capture, stream) {
      if (!isCurrent(capture)) {
        stopStream(stream);
        return false;
      }
      if (capture.rawStream && capture.rawStream !== stream) stopStream(capture.rawStream);
      capture.rawStream = stream;
      return true;
    },
    attachContext(capture, context) {
      if (!isCurrent(capture)) {
        closeContext(context);
        return false;
      }
      if (capture.context && capture.context !== context) closeContext(capture.context);
      capture.context = context;
      return true;
    },
    attachGainNode(capture, gainNode, value) {
      if (!isCurrent(capture)) return false;
      capture.gainNode = gainNode;
      gainNode.gain.value = value;
      return true;
    },
    attachOutboundTrack(capture, track, muted) {
      if (!isCurrent(capture)) {
        stopTrack(track);
        return false;
      }
      if (capture.outboundTrack && capture.outboundTrack !== track) {
        stopTrack(capture.outboundTrack);
      }
      capture.outboundTrack = track;
      track.enabled = !muted;
      return true;
    },
    setMuted(muted) {
      if (current?.status === "pending" && current.outboundTrack) {
        current.outboundTrack.enabled = !muted;
      }
    },
    setGain(value) {
      if (current?.status === "pending" && current.gainNode) {
        current.gainNode.gain.value = value;
      }
    },
    commit(capture, transfer = () => {}) {
      if (!isCurrent(capture)) return false;
      try {
        transfer();
      } catch (caught) {
        dispose(capture);
        throw caught;
      }
      capture.status = "committed";
      current = null;
      return true;
    },
    dispose,
    disposeCurrent() {
      return dispose(current);
    },
  };
}

export async function updateVoicePeersUntilQuiescent({
  snapshotPeers,
  isPeerCurrent,
  requireCurrent,
  updatePeer,
  commit = () => {},
}) {
  const updatedPeers = new Set();
  while (true) {
    requireCurrent();
    const pending = snapshotPeers().filter(([, peer]) => !updatedPeers.has(peer));
    if (!pending.length) {
      requireCurrent();
      return commit();
    }

    for (const [remoteId, peer] of pending) {
      updatedPeers.add(peer);
      requireCurrent();
      if (!isPeerCurrent(remoteId, peer)) continue;
      try {
        await updatePeer(remoteId, peer);
      } catch (caught) {
        requireCurrent();
        if (!isPeerCurrent(remoteId, peer)) continue;
        throw caught;
      }
      requireCurrent();
      // A same-ID replacement has a different peer identity and is therefore
      // discovered by the next synchronous snapshot.
      if (!isPeerCurrent(remoteId, peer)) continue;
    }
  }
}
