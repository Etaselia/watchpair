"use client";

import {
  HeadphoneOff,
  Headphones,
  LoaderCircle,
  Mic,
  MicOff,
  PhoneOff,
  Settings2,
  ShieldCheck,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  VoicePresence,
  VoiceSignalType,
  WatchSession,
} from "../lib/session-types";

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

export interface RoomVoiceController {
  enabled: boolean;
  muted: boolean;
  deafened: boolean;
  busy: boolean;
  settingsOpen: boolean;
  noiseSuppression: boolean;
  inputGain: number;
  inputDeviceId: string;
  outputDeviceId: string;
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  connectedPeers: number;
  speakingIds: Set<string>;
  selfSpeaking: boolean;
  error: string;
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

function level(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>) {
  analyser.getByteTimeDomainData(data);
  let energy = 0;
  for (const sample of data) {
    const centered = (sample - 128) / 128;
    energy += centered * centered;
  }
  return Math.sqrt(energy / data.length);
}

function sameIds(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
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
  const [inputDeviceId, setInputDeviceIdState] = useState("");
  const [outputDeviceId, setOutputDeviceIdState] = useState("");
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [connectedPeers, setConnectedPeers] = useState(0);
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
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
  const enabledRef = useRef(false);
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const outputDeviceRef = useRef("");
  const sessionRef = useRef(session);
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
        peer.audio = audio;
        void applyOutputDevice(audio, outputDeviceRef.current).catch(() => {});
        void audio.play().catch(() => setError("Click the voice controls to allow room audio."));
      }
      const context = audioContextRef.current;
      if (context && !peer.analyser) {
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
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
    nextNoiseSuppression: boolean
  ) => {
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: voiceConstraints(nextInputDeviceId, nextNoiseSuppression),
      video: false,
    });
    const rawTrack = raw.getAudioTracks()[0];
    if (!rawTrack) throw new Error("The selected microphone did not provide audio.");
    rawTrack.contentHint = "speech";

    const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
    await context.resume();
    const source = context.createMediaStreamSource(raw);
    const gain = context.createGain();
    gain.gain.value = inputGain;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    const destination = context.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(destination);
    const outboundTrack = destination.stream.getAudioTracks()[0];
    outboundTrack.enabled = !mutedRef.current;
    outboundTrack.contentHint = "speech";

    for (const peer of peersRef.current.values()) {
      const sender = peer.pc.getSenders().find((candidate) => candidate.track?.kind === "audio");
      if (sender) await sender.replaceTrack(outboundTrack);
      else peer.pc.addTrack(outboundTrack, new MediaStream([outboundTrack]));
    }

    rawStreamRef.current?.getTracks().forEach((track) => track.stop());
    outboundTrackRef.current?.stop();
    await audioContextRef.current?.close().catch(() => {});
    rawStreamRef.current = raw;
    outboundTrackRef.current = outboundTrack;
    audioContextRef.current = context;
    gainNodeRef.current = gain;
    localAnalyserRef.current = analyser;
    localLevelDataRef.current = new Uint8Array(analyser.fftSize);

    for (const peer of peersRef.current.values()) {
      peer.analyser = null;
      peer.levelData = null;
      const remoteStream = peer.audio?.srcObject;
      if (!(remoteStream instanceof MediaStream)) continue;
      const remoteAnalyser = context.createAnalyser();
      remoteAnalyser.fftSize = 256;
      remoteAnalyser.smoothingTimeConstant = 0.72;
      context.createMediaStreamSource(remoteStream).connect(remoteAnalyser);
      peer.analyser = remoteAnalyser;
      peer.levelData = new Uint8Array(remoteAnalyser.fftSize);
    }
  }, [inputGain]);

  const stop = useCallback(() => {
    enabledRef.current = false;
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
    presenceRef.current(SILENT_PRESENCE);
  }, [closePeer]);

  const start = useCallback(async () => {
    if (enabledRef.current || busy) return;
    setBusy(true);
    setError("");
    try {
      await replaceCapture(inputDeviceId, noiseSuppression);
      for (const signal of sessionRef.current?.voiceSignals || []) {
        seenSignalsRef.current.add(signal.id);
      }
      enabledRef.current = true;
      setEnabled(true);
      setBusy(false);
      presenceRef.current({ enabled: true, muted: false, deafened: false });
      await refreshDevices();
      reconcilePeers();
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : "Microphone access failed.");
      stop();
    }
  }, [
    busy,
    inputDeviceId,
    noiseSuppression,
    reconcilePeers,
    refreshDevices,
    replaceCapture,
    stop,
  ]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    if (outboundTrackRef.current) outboundTrackRef.current.enabled = !next;
    setMuted(next);
    presenceRef.current({
      enabled: enabledRef.current,
      muted: next,
      deafened: deafenedRef.current,
    });
  }, []);

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
    setBusy(true);
    try {
      await replaceCapture(id, noiseSuppression);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not switch microphones.");
    } finally {
      setBusy(false);
    }
  }, [noiseSuppression, replaceCapture]);

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
    setBusy(true);
    try {
      await replaceCapture(inputDeviceId, next);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update microphone processing.");
    } finally {
      setBusy(false);
    }
  }, [inputDeviceId, replaceCapture]);

  const setInputGain = useCallback((next: number) => {
    const gain = Math.max(0, Math.min(2, next));
    setInputGainState(gain);
    if (gainNodeRef.current) gainNodeRef.current.gain.value = gain;
    localStorage.setItem("watchpair-voice-gain", String(gain));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedInput = localStorage.getItem("watchpair-voice-input") || "";
      const savedOutput = localStorage.getItem("watchpair-voice-output") || "";
      const savedGain = Number(localStorage.getItem("watchpair-voice-gain"));
      const savedSuppression = localStorage.getItem("watchpair-voice-noise-suppression");
      setInputDeviceIdState(savedInput);
      setOutputDeviceIdState(savedOutput);
      outputDeviceRef.current = savedOutput;
      if (Number.isFinite(savedGain) && savedGain >= 0 && savedGain <= 2) setInputGainState(savedGain);
      if (savedSuppression === "0") setNoiseSuppressionState(false);
      void refreshDevices();
    }, 0);
    navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);
    return () => {
      window.clearTimeout(timer);
      navigator.mediaDevices.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

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
      const next = new Set<string>();
      if (
        !mutedRef.current &&
        localAnalyserRef.current &&
        localLevelDataRef.current &&
        level(localAnalyserRef.current, localLevelDataRef.current) > 0.035
      ) {
        next.add(deviceId);
      }
      for (const [remoteId, peer] of peersRef.current) {
        if (peer.analyser && peer.levelData && level(peer.analyser, peer.levelData) > 0.035) {
          next.add(remoteId);
        }
      }
      setSpeakingIds((current) => sameIds(current, next) ? current : next);
      monitorFrameRef.current = requestAnimationFrame(monitor);
    };
    monitorFrameRef.current = requestAnimationFrame(monitor);
    return () => cancelAnimationFrame(monitorFrameRef.current);
  }, [deviceId, enabled]);

  useEffect(() => {
    const peers = peersRef.current;
    return () => {
      enabledRef.current = false;
      for (const peer of peers.values()) {
        peer.audio?.pause();
        peer.pc.close();
      }
      peers.clear();
      rawStreamRef.current?.getTracks().forEach((track) => track.stop());
      outboundTrackRef.current?.stop();
      void audioContextRef.current?.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    seenSignalsRef.current.clear();
    signalQueueRef.current = Promise.resolve();
    if (!enabledRef.current) return;
    stop();
  }, [session?.token, stop]);

  return {
    enabled,
    muted,
    deafened,
    busy,
    settingsOpen,
    noiseSuppression,
    inputGain,
    inputDeviceId,
    outputDeviceId,
    inputs,
    outputs,
    connectedPeers,
    speakingIds,
    selfSpeaking: speakingIds.has(deviceId),
    error,
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
  };
}

export function VoiceDock({ voice }: { voice: RoomVoiceController }) {
  const voiceParticipants = voice.participants.filter((participant) => participant.voice.enabled);

  if (!voice.enabled) {
    return (
      <aside className="voice-dock voice-off" aria-label="Room voice">
        <button className="voice-join-button" type="button" onClick={() => void voice.start()} disabled={voice.busy}>
          {voice.busy ? <LoaderCircle className="spin" /> : <Mic />}
          {voice.busy ? "Opening microphone" : "Join voice"}
        </button>
        {voice.error && <span className="voice-error" role="alert">{voice.error}</span>}
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
            <span>Input gain</span>
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
