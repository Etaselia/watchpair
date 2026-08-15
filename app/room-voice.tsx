"use client";

import {
  HeadphoneOff,
  Headphones,
  LoaderCircle,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  PhoneOff,
  Settings2,
  ShieldCheck,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  VoicePresence,
  VoiceSignalType,
  WatchSession,
} from "../lib/session-types";
import {
  createVoiceAutoJoinState,
  reconcileVoiceAutoJoin,
  suppressVoiceAutoJoin,
  voiceAutoJoinFailureMessage,
  voiceMicrophoneFailureMessage,
} from "../lib/voice-auto-join.mjs";
import {
  createPendingVoiceCaptureRegistry,
  createVoiceCaptureGenerationGuard,
  updateVoicePeersUntilQuiescent,
} from "../lib/voice-capture-generation.mjs";

interface PeerState {
  pc: RTCPeerConnection;
  pendingCandidates: RTCIceCandidateInit[];
  audio: HTMLAudioElement | null;
  analyser: AnalyserNode | null;
  levelData: Uint8Array<ArrayBuffer> | null;
  offerStarted: boolean;
}

interface AudioDevice {
  id: string;
  label: string;
}

class VoiceCaptureCancelledError extends Error {
  constructor() {
    super("Voice capture was cancelled.");
    this.name = "VoiceCaptureCancelledError";
  }
}

export interface RoomVoiceController {
  enabled: boolean;
  muted: boolean;
  deafened: boolean;
  busy: boolean;
  settingsOpen: boolean;
  noiseSuppression: boolean;
  inputGain: number;
  masterVolume: number;
  participantVolumes: Record<string, number>;
  selfId: string;
  inputDeviceId: string;
  outputDeviceId: string;
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  connectedPeers: number;
  speakingIds: Set<string>;
  selfSpeaking: boolean;
  error: string;
  notice: string;
  participants: WatchSession["participants"];
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  setInputDevice: (id: string) => Promise<void>;
  setOutputDevice: (id: string) => Promise<void>;
  setNoiseSuppression: (enabled: boolean) => Promise<void>;
  setInputGain: (gain: number) => void;
  setMasterVolume: (volume: number) => void;
  setParticipantVolume: (deviceId: string, volume: number) => void;
}

interface RoomVoiceOptions {
  session: WatchSession | null;
  deviceId: string;
  onSignal: (toId: string, type: VoiceSignalType, data: string) => Promise<void>;
  onPresence: (presence: VoicePresence) => void;
}

const SILENT_PRESENCE: VoicePresence = {
  enabled: false,
  muted: true,
  deafened: false,
};

function voiceConstraints(
  inputDeviceId: string,
  noiseSuppression: boolean
): MediaTrackConstraints {
  const supported = navigator.mediaDevices.getSupportedConstraints() as MediaTrackSupportedConstraints & {
    voiceIsolation?: boolean;
  };
  const constraints: MediaTrackConstraints & Record<string, unknown> = {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    sampleSize: { ideal: 16 },
    echoCancellation: true,
    noiseSuppression,
    autoGainControl: true,
    latency: { ideal: 0.01 },
  };
  if (inputDeviceId) constraints.deviceId = { exact: inputDeviceId };
  if (supported.voiceIsolation) constraints.voiceIsolation = noiseSuppression;
  return constraints;
}

function setAudioVolume(audio: HTMLAudioElement, volume: number) {
  audio.volume = Math.max(0, Math.min(1, volume));
}

function level(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>) {
  analyser.getByteTimeDomainData(data);
  let energy = 0;
  for (const sample of data) {
    const centered = (sample - 128) / 128;
    energy += centered * centered;
  }
  return Math.sqrt(energy / data.length);
}

function playVoiceCue(kind: "connect" | "disconnect") {
  const context = new AudioContext({ latencyHint: "interactive" });
  const frequencies = kind === "connect" ? [440, 660] : [660, 390];
  const startedAt = context.currentTime + 0.01;
  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = startedAt + index * 0.085;
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.09, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.075);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.08);
  });
  window.setTimeout(() => void context.close().catch(() => {}), 300);
}

function sameIds(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

function activeRemoteVoiceParticipants(session: WatchSession | null, deviceId: string) {
  if (!deviceId) return [];
  return (session?.participants || []).filter(
    (participant) => participant.deviceId !== deviceId && participant.voice.enabled
  );
}

export function useRoomVoice({
  session,
  deviceId,
  onSignal,
  onPresence,
}: RoomVoiceOptions): RoomVoiceController {
  const [enabled, setEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noiseSuppression, setNoiseSuppressionState] = useState(true);
  const [inputGain, setInputGainState] = useState(1);
  const [masterVolume, setMasterVolumeState] = useState(1);
  const [participantVolumes, setParticipantVolumes] = useState<Record<string, number>>({});
  const [inputDeviceId, setInputDeviceIdState] = useState("");
  const [outputDeviceId, setOutputDeviceIdState] = useState("");
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [connectedPeers, setConnectedPeers] = useState(0);
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [captureGuard] = useState(() => createVoiceCaptureGenerationGuard());
  const [pendingCaptureRegistry] = useState(() => createPendingVoiceCaptureRegistry());
  const peersRef = useRef(new Map<string, PeerState>());
  const seenSignalsRef = useRef(new Set<string>());
  const signalQueueRef = useRef(Promise.resolve());
  const rawStreamRef = useRef<MediaStream | null>(null);
  const outboundTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const localLevelDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const monitorFrameRef = useRef(0);
  const speakingUntilRef = useRef(new Map<string, number>());
  const masterVolumeRef = useRef(1);
  const inputGainRef = useRef(1);
  const participantVolumesRef = useRef<Record<string, number>>({});
  const enabledRef = useRef(false);
  const startingRef = useRef(false);
  const autoJoinStateRef = useRef(createVoiceAutoJoinState());
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const outputDeviceRef = useRef("");
  const sessionRef = useRef(session);
  const captureSessionTokenRef = useRef(session?.token ?? null);
  const signalRef = useRef(onSignal);
  const presenceRef = useRef(onPresence);

  useEffect(() => {
    sessionRef.current = session;
    signalRef.current = onSignal;
    presenceRef.current = onPresence;
  }, [onPresence, onSignal, session]);

  const refreshDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setInputs(
      devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          id: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        }))
    );
    setOutputs(
      devices
        .filter((device) => device.kind === "audiooutput")
        .map((device, index) => ({
          id: device.deviceId,
          label: device.label || `Speaker ${index + 1}`,
        }))
    );
  }, []);

  const updatePeerCount = useCallback(() => {
    setConnectedPeers(
      Array.from(peersRef.current.values()).filter(
        (peer) => peer.pc.connectionState === "connected"
      ).length
    );
  }, []);

  const closePeer = useCallback((remoteId: string) => {
    const peer = peersRef.current.get(remoteId);
    if (!peer) return;
    peersRef.current.delete(remoteId);
    speakingUntilRef.current.delete(remoteId);
    peer.audio?.pause();
    peer.audio?.remove();
    peer.pc.close();
    updatePeerCount();
    setSpeakingIds((current) => {
      if (!current.has(remoteId)) return current;
      const next = new Set(current);
      next.delete(remoteId);
      return next;
    });
  }, [updatePeerCount]);

  const applyOutputDevice = useCallback(async (audio: HTMLAudioElement, id: string) => {
    const sinkAudio = audio as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    if (id && sinkAudio.setSinkId) await sinkAudio.setSinkId(id);
  }, []);

  const ensurePeer = useCallback((remoteId: string) => {
    const existing = peersRef.current.get(remoteId);
    if (existing) return existing;
    const currentSession = sessionRef.current;
    const pc = new RTCPeerConnection({
      iceServers: (currentSession?.voice.iceServers || []) as RTCIceServer[],
      bundlePolicy: "max-bundle",
    });
    const peer: PeerState = {
      pc,
      pendingCandidates: [],
      audio: null,
      analyser: null,
      levelData: null,
      offerStarted: false,
    };
    peersRef.current.set(remoteId, peer);

    const track = outboundTrackRef.current;
    if (track) pc.addTrack(track, new MediaStream([track]));

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void signalRef.current(
        remoteId,
        "candidate",
        JSON.stringify(event.candidate.toJSON())
      ).catch(() => setError("Voice signaling was interrupted."));
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (!peer.audio) {
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.className = "room-voice-audio";
        audio.srcObject = stream;
        audio.muted = deafenedRef.current;
        audio.volume = Math.min(
          1,
          masterVolumeRef.current * (participantVolumesRef.current[remoteId] ?? 1)
        );
        peer.audio = audio;
        void applyOutputDevice(audio, outputDeviceRef.current).catch(() => {});
        void audio.play().catch(() => setError("Click the voice controls to allow room audio."));
      }
      const context = audioContextRef.current;
      if (context && !peer.analyser) {
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.85;
        context.createMediaStreamSource(stream).connect(analyser);
        peer.analyser = analyser;
        peer.levelData = new Uint8Array(analyser.fftSize);
      }
    };
    pc.onconnectionstatechange = () => {
      updatePeerCount();
      if (pc.connectionState === "failed") {
        setError("A voice peer could not connect. A TURN server may be required on this network.");
        closePeer(remoteId);
      }
    };
    return peer;
  }, [applyOutputDevice, closePeer, updatePeerCount]);

  const sendOffer = useCallback(async (remoteId: string, peer: PeerState) => {
    if (peer.offerStarted || peer.pc.signalingState !== "stable") return;
    peer.offerStarted = true;
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await signalRef.current(
        remoteId,
        "offer",
        JSON.stringify(peer.pc.localDescription)
      );
    } catch {
      peer.offerStarted = false;
      setError("Could not start voice with a room participant.");
    }
  }, []);

  const reconcilePeers = useCallback(() => {
    if (!enabledRef.current || !deviceId) return;
    const active = new Set(
      (sessionRef.current?.participants || [])
        .filter((participant) => participant.deviceId !== deviceId && participant.voice.enabled)
        .map((participant) => participant.deviceId)
    );
    for (const remoteId of peersRef.current.keys()) {
      if (!active.has(remoteId)) closePeer(remoteId);
    }
    for (const remoteId of active) {
      const peer = ensurePeer(remoteId);
      if (deviceId.localeCompare(remoteId) < 0) void sendOffer(remoteId, peer);
    }
  }, [closePeer, deviceId, ensurePeer, sendOffer]);

  const replaceCapture = useCallback(async (
    nextInputDeviceId: string,
    nextNoiseSuppression: boolean,
    isCurrent: () => boolean
  ) => {
    const pendingCapture = pendingCaptureRegistry.begin();
    let outboundTrack: MediaStreamTrack | null = null;
    const senderChanges: Array<{
      remoteId: string;
      peer: PeerState;
      sender: RTCRtpSender;
      previousTrack: MediaStreamTrack | null;
      added: boolean;
    }> = [];
    const requireCurrent = () => {
      if (!isCurrent()) throw new VoiceCaptureCancelledError();
    };
    const isPeerCurrent = (remoteId: string, peer: PeerState) => Boolean(
      peersRef.current.get(remoteId) === peer &&
      peer.pc.signalingState !== "closed" &&
      peer.pc.connectionState !== "closed"
    );
    const disposePreparedCapture = () => {
      pendingCaptureRegistry.dispose(pendingCapture);
    };

    try {
      const nextRaw = await navigator.mediaDevices.getUserMedia({
        audio: voiceConstraints(nextInputDeviceId, nextNoiseSuppression),
        video: false,
      });
      if (!pendingCaptureRegistry.attachRawStream(pendingCapture, nextRaw)) {
        throw new VoiceCaptureCancelledError();
      }
      requireCurrent();
      const rawTrack = nextRaw.getAudioTracks()[0];
      if (!rawTrack) throw new Error("The selected microphone did not provide audio.");
      rawTrack.contentHint = "speech";

      const nextContext = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
      if (!pendingCaptureRegistry.attachContext(pendingCapture, nextContext)) {
        throw new VoiceCaptureCancelledError();
      }
      await nextContext.resume();
      requireCurrent();
      const source = nextContext.createMediaStreamSource(nextRaw);
      const gain = nextContext.createGain();
      if (!pendingCaptureRegistry.attachGainNode(
        pendingCapture,
        gain,
        inputGainRef.current
      )) {
        throw new VoiceCaptureCancelledError();
      }
      const analyser = nextContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.85;
      const destination = nextContext.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(destination);
      const nextOutboundTrack = destination.stream.getAudioTracks()[0];
      if (!nextOutboundTrack) throw new Error("The microphone processor did not provide audio.");
      outboundTrack = nextOutboundTrack;
      nextOutboundTrack.contentHint = "speech";
      if (!pendingCaptureRegistry.attachOutboundTrack(
        pendingCapture,
        nextOutboundTrack,
        mutedRef.current
      )) {
        throw new VoiceCaptureCancelledError();
      }

      await updateVoicePeersUntilQuiescent({
        snapshotPeers: () => Array.from(peersRef.current.entries()),
        isPeerCurrent,
        requireCurrent,
        updatePeer: async (remoteId: string, peer: PeerState) => {
          const sender = peer.pc.getSenders().find(
            (candidate) => candidate.track?.kind === "audio"
          );
          if (sender) {
            const previousTrack = sender.track;
            await sender.replaceTrack(nextOutboundTrack);
            senderChanges.push({
              remoteId,
              peer,
              sender,
              previousTrack,
              added: false,
            });
          } else {
            const addedSender = peer.pc.addTrack(
              nextOutboundTrack,
              new MediaStream([nextOutboundTrack])
            );
            senderChanges.push({
              remoteId,
              peer,
              sender: addedSender,
              previousTrack: null,
              added: true,
            });
          }
        },
        commit: () => {
          const peerSnapshots = Array.from(peersRef.current.entries())
            .filter(([remoteId, peer]) => isPeerCurrent(remoteId, peer));
          const remoteLevels = new Map<string, {
            peer: PeerState;
            analyser: AnalyserNode;
            levelData: Uint8Array<ArrayBuffer>;
          }>();
          for (const [remoteId, peer] of peerSnapshots) {
            const remoteStream = peer.audio?.srcObject;
            if (!(remoteStream instanceof MediaStream)) continue;
            const remoteAnalyser = nextContext.createAnalyser();
            remoteAnalyser.fftSize = 256;
            remoteAnalyser.smoothingTimeConstant = 0.85;
            nextContext.createMediaStreamSource(remoteStream).connect(remoteAnalyser);
            remoteLevels.set(remoteId, {
              peer,
              analyser: remoteAnalyser,
              levelData: new Uint8Array(remoteAnalyser.fftSize),
            });
          }

          // Quiescence, the ownership check, and the ref swap are synchronous.
          // Any peer added before this point received the new track in a prior pass.
          requireCurrent();
          const previousRaw = rawStreamRef.current;
          const previousOutboundTrack = outboundTrackRef.current;
          const previousContext = audioContextRef.current;
          if (!pendingCaptureRegistry.commit(pendingCapture, () => {
            nextOutboundTrack.enabled = !mutedRef.current;
            gain.gain.value = inputGainRef.current;
            rawStreamRef.current = nextRaw;
            outboundTrackRef.current = nextOutboundTrack;
            audioContextRef.current = nextContext;
            gainNodeRef.current = gain;
            localAnalyserRef.current = analyser;
            localLevelDataRef.current = new Uint8Array(analyser.fftSize);
          })) {
            throw new VoiceCaptureCancelledError();
          }
          previousRaw?.getTracks().forEach((track) => track.stop());
          previousOutboundTrack?.stop();
          void previousContext?.close().catch(() => {});

          for (const [remoteId, peer] of peerSnapshots) {
            const remoteLevel = remoteLevels.get(remoteId);
            peer.analyser = remoteLevel?.peer === peer ? remoteLevel.analyser : null;
            peer.levelData = remoteLevel?.peer === peer ? remoteLevel.levelData : null;
          }
        },
      });
    } catch (caught) {
      for (const change of senderChanges.reverse()) {
        if (!isPeerCurrent(change.remoteId, change.peer)) continue;
        if (change.sender.track !== outboundTrack) continue;
        try {
          if (change.added) change.peer.pc.removeTrack(change.sender);
          else await change.sender.replaceTrack(change.previousTrack);
        } catch {
          // The peer may already be closed by the cancellation that brought us here.
        }
      }
      disposePreparedCapture();
      throw caught;
    }
  }, [pendingCaptureRegistry]);

  const stopVoice = useCallback((
    suppressAutoJoin: boolean,
    publishPresence = true
  ) => {
    captureGuard.cancel();
    pendingCaptureRegistry.disposeCurrent();
    if (suppressAutoJoin) {
      autoJoinStateRef.current = suppressVoiceAutoJoin(
        activeRemoteVoiceParticipants(sessionRef.current, deviceId).length
      );
    }
    const wasEnabled = enabledRef.current;
    enabledRef.current = false;
    startingRef.current = false;
    if (wasEnabled) {
      try {
        playVoiceCue("disconnect");
      } catch {
        // Audio cues are optional; capture teardown must always continue.
      }
    }
    for (const remoteId of Array.from(peersRef.current.keys())) closePeer(remoteId);
    rawStreamRef.current?.getTracks().forEach((track) => track.stop());
    outboundTrackRef.current?.stop();
    rawStreamRef.current = null;
    outboundTrackRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    gainNodeRef.current = null;
    localAnalyserRef.current = null;
    localLevelDataRef.current = null;
    setEnabled(false);
    setMuted(false);
    mutedRef.current = false;
    setDeafened(false);
    deafenedRef.current = false;
    setBusy(false);
    setConnectedPeers(0);
    setSpeakingIds(new Set());
    setSettingsOpen(false);
    setNotice("");
    if (publishPresence) presenceRef.current(SILENT_PRESENCE);
  }, [captureGuard, closePeer, deviceId, pendingCaptureRegistry]);

  const stop = useCallback(() => stopVoice(true), [stopVoice]);

  useLayoutEffect(() => {
    const nextToken = session?.token ?? null;
    if (captureSessionTokenRef.current === nextToken) return;
    captureSessionTokenRef.current = nextToken;
    if (enabledRef.current || startingRef.current) stopVoice(false, false);
    else {
      captureGuard.cancel();
      pendingCaptureRegistry.disposeCurrent();
    }
  }, [captureGuard, pendingCaptureRegistry, session?.token, stopVoice]);

  const startVoice = useCallback(async (autoJoinerName: string | null) => {
    if (enabledRef.current || startingRef.current) return;
    const captureLease = captureGuard.begin(captureSessionTokenRef.current);
    const captureIsCurrent = () => Boolean(
      startingRef.current &&
      captureGuard.isCurrent(captureLease, captureSessionTokenRef.current)
    );
    startingRef.current = true;
    setBusy(true);
    setError("");
    setNotice(
      autoJoinerName
        ? `${autoJoinerName} joined voice. Joining automatically…`
        : ""
    );
    try {
      await replaceCapture(inputDeviceId, noiseSuppression, captureIsCurrent);
      if (!captureIsCurrent()) throw new VoiceCaptureCancelledError();
      for (const signal of sessionRef.current?.voiceSignals || []) {
        seenSignalsRef.current.add(signal.id);
      }
      enabledRef.current = true;
      startingRef.current = false;
      setEnabled(true);
      setBusy(false);
      setNotice("");
      try {
        playVoiceCue("connect");
      } catch {
        // Audio cues are optional and must not affect an established capture.
      }
      presenceRef.current({
        enabled: true,
        muted: mutedRef.current,
        deafened: deafenedRef.current,
      });
      void refreshDevices().catch(() => {});
      reconcilePeers();
    } catch (caught) {
      if (
        caught instanceof VoiceCaptureCancelledError ||
        !captureGuard.isCurrent(captureLease, captureSessionTokenRef.current)
      ) {
        if (captureGuard.owns(captureLease)) stopVoice(false, false);
        return;
      }
      autoJoinStateRef.current = suppressVoiceAutoJoin(
        activeRemoteVoiceParticipants(sessionRef.current, deviceId).length
      );
      stopVoice(false, false);
      setError(
        autoJoinerName
          ? voiceAutoJoinFailureMessage(autoJoinerName, caught)
          : voiceMicrophoneFailureMessage(caught)
      );
    }
  }, [
    captureGuard,
    deviceId,
    inputDeviceId,
    noiseSuppression,
    reconcilePeers,
    refreshDevices,
    replaceCapture,
    stopVoice,
  ]);

  const start = useCallback(() => startVoice(null), [startVoice]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    if (outboundTrackRef.current) outboundTrackRef.current.enabled = !next;
    pendingCaptureRegistry.setMuted(next);
    setMuted(next);
    presenceRef.current({
      enabled: enabledRef.current,
      muted: next,
      deafened: deafenedRef.current,
    });
  }, [pendingCaptureRegistry]);

  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    for (const peer of peersRef.current.values()) {
      if (peer.audio) peer.audio.muted = next;
    }
    setDeafened(next);
    presenceRef.current({
      enabled: enabledRef.current,
      muted: mutedRef.current,
      deafened: next,
    });
  }, []);

  const setInputDevice = useCallback(async (id: string) => {
    setInputDeviceIdState(id);
    localStorage.setItem("watchpair-voice-input", id);
    if (!enabledRef.current) return;
    const captureLease = captureGuard.begin(captureSessionTokenRef.current);
    const captureIsCurrent = () => Boolean(
      enabledRef.current &&
      captureGuard.isCurrent(captureLease, captureSessionTokenRef.current)
    );
    setBusy(true);
    try {
      await replaceCapture(id, noiseSuppression, captureIsCurrent);
      if (!captureIsCurrent()) throw new VoiceCaptureCancelledError();
      setError("");
    } catch (caught) {
      if (
        caught instanceof VoiceCaptureCancelledError ||
        !captureGuard.isCurrent(captureLease, captureSessionTokenRef.current)
      ) {
        if (captureGuard.owns(captureLease)) stopVoice(false, false);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not switch microphones.");
    } finally {
      if (captureGuard.owns(captureLease)) setBusy(false);
    }
  }, [captureGuard, noiseSuppression, replaceCapture, stopVoice]);

  const setOutputDevice = useCallback(async (id: string) => {
    outputDeviceRef.current = id;
    setOutputDeviceIdState(id);
    localStorage.setItem("watchpair-voice-output", id);
    await Promise.all(
      Array.from(peersRef.current.values()).map((peer) =>
        peer.audio ? applyOutputDevice(peer.audio, id).catch(() => {}) : Promise.resolve()
      )
    );
  }, [applyOutputDevice]);

  const setNoiseSuppression = useCallback(async (next: boolean) => {
    setNoiseSuppressionState(next);
    localStorage.setItem("watchpair-voice-noise-suppression", next ? "1" : "0");
    if (!enabledRef.current) return;
    const captureLease = captureGuard.begin(captureSessionTokenRef.current);
    const captureIsCurrent = () => Boolean(
      enabledRef.current &&
      captureGuard.isCurrent(captureLease, captureSessionTokenRef.current)
    );
    setBusy(true);
    try {
      await replaceCapture(inputDeviceId, next, captureIsCurrent);
      if (!captureIsCurrent()) throw new VoiceCaptureCancelledError();
      setError("");
    } catch (caught) {
      if (
        caught instanceof VoiceCaptureCancelledError ||
        !captureGuard.isCurrent(captureLease, captureSessionTokenRef.current)
      ) {
        if (captureGuard.owns(captureLease)) stopVoice(false, false);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not update microphone processing.");
    } finally {
      if (captureGuard.owns(captureLease)) setBusy(false);
    }
  }, [captureGuard, inputDeviceId, replaceCapture, stopVoice]);

  const setInputGain = useCallback((next: number) => {
    const gain = Math.max(0, Math.min(2, next));
    inputGainRef.current = gain;
    setInputGainState(gain);
    if (gainNodeRef.current) gainNodeRef.current.gain.value = gain;
    pendingCaptureRegistry.setGain(gain);
    localStorage.setItem("watchpair-voice-gain", String(gain));
  }, [pendingCaptureRegistry]);

  const applyVolumes = useCallback(() => {
    for (const [remoteId, peer] of peersRef.current) {
      if (!peer.audio) continue;
      setAudioVolume(
        peer.audio,
        masterVolumeRef.current * (participantVolumesRef.current[remoteId] ?? 1)
      );
    }
  }, []);

  const setMasterVolume = useCallback((next: number) => {
    const volume = Math.max(0, Math.min(1, next));
    masterVolumeRef.current = volume;
    setMasterVolumeState(volume);
    localStorage.setItem("watchpair-voice-master-volume", String(volume));
    applyVolumes();
  }, [applyVolumes]);

  const setParticipantVolume = useCallback((remoteId: string, next: number) => {
    const volume = Math.max(0, Math.min(1, next));
    const values = { ...participantVolumesRef.current, [remoteId]: volume };
    participantVolumesRef.current = values;
    setParticipantVolumes(values);
    localStorage.setItem("watchpair-voice-participant-volumes", JSON.stringify(values));
    applyVolumes();
  }, [applyVolumes]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedInput = localStorage.getItem("watchpair-voice-input") || "";
      const savedOutput = localStorage.getItem("watchpair-voice-output") || "";
      const savedGainValue = localStorage.getItem("watchpair-voice-gain");
      const savedMasterVolumeValue = localStorage.getItem("watchpair-voice-master-volume");
      const savedGain = savedGainValue === null ? Number.NaN : Number(savedGainValue);
      const savedMasterVolume =
        savedMasterVolumeValue === null ? Number.NaN : Number(savedMasterVolumeValue);
      let savedParticipantVolumes: Record<string, number> = {};
      try {
        savedParticipantVolumes = JSON.parse(
          localStorage.getItem("watchpair-voice-participant-volumes") || "{}"
        ) as Record<string, number>;
      } catch {
        savedParticipantVolumes = {};
      }
      const savedSuppression = localStorage.getItem("watchpair-voice-noise-suppression");
      setInputDeviceIdState(savedInput);
      setOutputDeviceIdState(savedOutput);
      outputDeviceRef.current = savedOutput;
      if (Number.isFinite(savedMasterVolume) && savedMasterVolume >= 0 && savedMasterVolume <= 1) {
        masterVolumeRef.current = savedMasterVolume;
        setMasterVolumeState(savedMasterVolume);
      }
      participantVolumesRef.current = Object.fromEntries(
        Object.entries(savedParticipantVolumes)
          .filter(([, volume]) => Number.isFinite(volume))
          .map(([id, volume]) => [id, Math.max(0, Math.min(1, volume))])
      );
      setParticipantVolumes(participantVolumesRef.current);
      if (Number.isFinite(savedGain) && savedGain >= 0 && savedGain <= 2) {
        inputGainRef.current = savedGain;
        setInputGainState(savedGain);
        if (gainNodeRef.current) gainNodeRef.current.gain.value = savedGain;
        pendingCaptureRegistry.setGain(savedGain);
      }
      if (savedSuppression === "0") setNoiseSuppressionState(false);
      void refreshDevices();
    }, 0);
    navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);
    return () => {
      window.clearTimeout(timer);
      navigator.mediaDevices.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [pendingCaptureRegistry, refreshDevices]);

  useEffect(() => {
    if (!enabled) return;
    reconcilePeers();
  }, [enabled, reconcilePeers, session?.participants]);

  useEffect(() => {
    if (!enabled || !session?.voiceSignals.length) return;
    for (const signal of session.voiceSignals) {
      if (signal.toId !== deviceId || seenSignalsRef.current.has(signal.id)) continue;
      seenSignalsRef.current.add(signal.id);
      signalQueueRef.current = signalQueueRef.current
        .then(async () => {
          const peer = ensurePeer(signal.fromId);
          if (signal.type === "candidate") {
            const candidate = JSON.parse(signal.data) as RTCIceCandidateInit;
            if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
            else peer.pendingCandidates.push(candidate);
            return;
          }

          const description = JSON.parse(signal.data) as RTCSessionDescriptionInit;
          await peer.pc.setRemoteDescription(description);
          while (peer.pendingCandidates.length) {
            await peer.pc.addIceCandidate(peer.pendingCandidates.shift()!);
          }
          if (signal.type === "offer") {
            await peer.pc.setLocalDescription(await peer.pc.createAnswer());
            await signalRef.current(
              signal.fromId,
              "answer",
              JSON.stringify(peer.pc.localDescription)
            );
          }
        })
        .catch(() => setError("A room voice negotiation failed."));
    }
  }, [deviceId, enabled, ensurePeer, session?.voiceSignals]);

  useEffect(() => {
    if (!enabled) return;
    const monitor = () => {
      const now = performance.now();
      const next = new Set<string>();
      const keepSpeaking = (id: string, currentLevel: number) => {
        if (currentLevel > 0.035) speakingUntilRef.current.set(id, now + 360);
        if ((speakingUntilRef.current.get(id) || 0) > now) next.add(id);
      };
      keepSpeaking(
        deviceId,
        !mutedRef.current && localAnalyserRef.current && localLevelDataRef.current
          ? level(localAnalyserRef.current, localLevelDataRef.current)
          : 0
      );
      for (const [remoteId, peer] of peersRef.current) {
        keepSpeaking(
          remoteId,
          peer.analyser && peer.levelData ? level(peer.analyser, peer.levelData) : 0
        );
      }
      setSpeakingIds((current) => sameIds(current, next) ? current : next);
      monitorFrameRef.current = requestAnimationFrame(monitor);
    };
    monitorFrameRef.current = requestAnimationFrame(monitor);
    return () => cancelAnimationFrame(monitorFrameRef.current);
  }, [deviceId, enabled]);

  useLayoutEffect(() => {
    captureGuard.mount();
    const peers = peersRef.current;
    return () => {
      captureGuard.unmount();
      pendingCaptureRegistry.disposeCurrent();
      enabledRef.current = false;
      startingRef.current = false;
      for (const peer of peers.values()) {
        peer.audio?.pause();
        peer.pc.close();
      }
      peers.clear();
      rawStreamRef.current?.getTracks().forEach((track) => track.stop());
      outboundTrackRef.current?.stop();
      rawStreamRef.current = null;
      outboundTrackRef.current = null;
      void audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;
      gainNodeRef.current = null;
      localAnalyserRef.current = null;
      localLevelDataRef.current = null;
    };
  }, [captureGuard, pendingCaptureRegistry]);

  useEffect(() => {
    seenSignalsRef.current.clear();
    signalQueueRef.current = Promise.resolve();
    autoJoinStateRef.current = createVoiceAutoJoinState();
    if (!enabledRef.current && !startingRef.current) return;
    stopVoice(false, false);
  }, [session?.token, stopVoice]);

  useEffect(() => {
    if (!deviceId) return;
    const remoteParticipants = activeRemoteVoiceParticipants(session, deviceId);
    const update = reconcileVoiceAutoJoin(autoJoinStateRef.current, {
      remoteCount: remoteParticipants.length,
      localEnabled: enabledRef.current,
      localStarting: startingRef.current,
    });
    autoJoinStateRef.current = update.state;
    if (!update.shouldStart) return;
    void startVoice(remoteParticipants[0]?.name || "Someone");
  }, [deviceId, session, startVoice]);

  return {
    enabled,
    muted,
    deafened,
    busy,
    settingsOpen,
    noiseSuppression,
    inputGain,
    masterVolume,
    participantVolumes,
    selfId: deviceId,
    inputDeviceId,
    outputDeviceId,
    inputs,
    outputs,
    connectedPeers,
    speakingIds,
    selfSpeaking: speakingIds.has(deviceId),
    error,
    notice,
    participants: session?.participants || [],
    start,
    stop,
    toggleMute,
    toggleDeafen,
    toggleSettings: () => setSettingsOpen((open) => !open),
    closeSettings: () => setSettingsOpen(false),
    setInputDevice,
    setOutputDevice,
    setNoiseSuppression,
    setInputGain,
    setMasterVolume,
    setParticipantVolume,
  };
}

export function VoiceDock({ voice }: { voice: RoomVoiceController }) {
  const [minimized, setMinimized] = useState(false);
  const voiceParticipants = voice.participants.filter((participant) => participant.voice.enabled);
  const remoteParticipants = voiceParticipants.filter((participant) => participant.deviceId !== voice.selfId);

  if (!voice.enabled) {
    return (
      <aside className="voice-dock voice-off" aria-label="Room voice">
        <button className="voice-join-button" type="button" onClick={() => void voice.start()} disabled={voice.busy}>
          {voice.busy ? <LoaderCircle className="spin" /> : <Mic />}
          {voice.busy ? "Opening microphone" : "Join voice"}
        </button>
        {voice.notice && <span className="voice-processing" role="status">{voice.notice}</span>}
        {voice.error && <span className="voice-error" role="alert">{voice.error}</span>}
      </aside>
    );
  }

  if (minimized) {
    return (
      <aside className="voice-dock voice-minimized" aria-label="Room voice minimized">
        <div className={"voice-self-avatar" + (voice.selfSpeaking ? " speaking" : "")}>
          {voice.muted ? <MicOff /> : <Volume2 />}
        </div>
        <span className="voice-minimized-count">{voice.connectedPeers}</span>
        <button
          className={"icon-button" + (voice.muted ? " active danger" : "")}
          type="button"
          onClick={voice.toggleMute}
          aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
          title={voice.muted ? "Unmute microphone" : "Mute microphone"}
        >
          {voice.muted ? <MicOff /> : <Mic />}
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => setMinimized(false)}
          aria-label="Expand room voice"
          title="Expand room voice"
        >
          <Maximize2 />
        </button>
      </aside>
    );
  }

  return (
    <aside className="voice-dock" aria-label="Room voice">
      <div className="voice-summary">
        <div className={"voice-self-avatar" + (voice.selfSpeaking ? " speaking" : "")}>
          <Volume2 />
        </div>
        <span>
          <strong>Room voice</strong>
          <small>{voice.connectedPeers} connected / {voiceParticipants.length} joined</small>
        </span>
      </div>

      <div className="voice-participants" aria-label="Participants in voice">
        {voiceParticipants.slice(0, 6).map((participant) => (
          <span
            className={voice.speakingIds.has(participant.deviceId) ? "speaking" : ""}
            key={participant.deviceId}
            title={participant.name + (participant.voice.muted ? " (muted)" : "")}
          >
            {participant.voice.muted ? <MicOff /> : participant.name.slice(0, 1).toUpperCase()}
          </span>
        ))}
      </div>

      <div className="voice-actions">
        <button
          className={"icon-button" + (voice.muted ? " active danger" : "")}
          type="button"
          onClick={voice.toggleMute}
          title={voice.muted ? "Unmute microphone" : "Mute microphone"}
          aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={voice.muted}
        >
          {voice.muted ? <MicOff /> : <Mic />}
        </button>
        <button
          className={"icon-button" + (voice.deafened ? " active danger" : "")}
          type="button"
          onClick={voice.toggleDeafen}
          title={voice.deafened ? "Undeafen room voice" : "Deafen room voice"}
          aria-label={voice.deafened ? "Undeafen room voice" : "Deafen room voice"}
          aria-pressed={voice.deafened}
        >
          {voice.deafened ? <HeadphoneOff /> : <Headphones />}
        </button>
        <button
          className={"icon-button" + (voice.settingsOpen ? " active" : "")}
          type="button"
          onClick={voice.toggleSettings}
          title="Voice settings"
          aria-label="Voice settings"
          aria-expanded={voice.settingsOpen}
        >
          <Settings2 />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            voice.closeSettings();
            setMinimized(true);
          }}
          title="Minimize room voice"
          aria-label="Minimize room voice"
        >
          <Minimize2 />
        </button>
        <button
          className="icon-button danger"
          type="button"
          onClick={voice.stop}
          title="Leave room voice"
          aria-label="Leave room voice"
        >
          <PhoneOff />
        </button>
      </div>

      {voice.settingsOpen && (
        <div className="voice-settings" role="dialog" aria-label="Voice settings">
          <div className="voice-settings-heading">
            <strong>Voice settings</strong>
            <button className="icon-button" type="button" onClick={voice.closeSettings} aria-label="Close voice settings">
              <X />
            </button>
          </div>
          <label>
            <span>Microphone</span>
            <select value={voice.inputDeviceId} onChange={(event) => void voice.setInputDevice(event.target.value)}>
              <option value="">System default</option>
              {voice.inputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
            </select>
          </label>
          <label>
            <span>Speakers</span>
            <select value={voice.outputDeviceId} onChange={(event) => void voice.setOutputDevice(event.target.value)}>
              <option value="">System default</option>
              {voice.outputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
            </select>
          </label>
          <label>
            <span>Room volume <output>{Math.round(voice.masterVolume * 100)}%</output></span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={voice.masterVolume}
              onChange={(event) => voice.setMasterVolume(Number(event.target.value))}
            />
          </label>
          {remoteParticipants.length > 0 && (
            <div className="voice-volume-list">
              <strong>People</strong>
              {remoteParticipants.map((participant) => (
                <label key={participant.deviceId}>
                  <span>
                    {participant.name}
                    <output>{Math.round((voice.participantVolumes[participant.deviceId] ?? 1) * 100)}%</output>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={voice.participantVolumes[participant.deviceId] ?? 1}
                    onChange={(event) =>
                      voice.setParticipantVolume(participant.deviceId, Number(event.target.value))
                    }
                  />
                </label>
              ))}
            </div>
          )}
          <label>
            <span>Input gain <output>{Math.round(voice.inputGain * 100)}%</output></span>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={voice.inputGain}
              onChange={(event) => voice.setInputGain(Number(event.target.value))}
            />
          </label>
          <label className="voice-toggle">
            <span><ShieldCheck /> Noise suppression</span>
            <input
              type="checkbox"
              checked={voice.noiseSuppression}
              onChange={(event) => void voice.setNoiseSuppression(event.target.checked)}
            />
          </label>
          {voice.busy && <span className="voice-processing"><LoaderCircle className="spin" /> Applying audio settings</span>}
        </div>
      )}

      {voice.error && <span className="voice-error" role="alert">{voice.error}</span>}
    </aside>
  );
}
