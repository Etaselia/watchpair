"use client";

import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Expand,
  FileVideo2,
  Headphones,
  Link2,
  LoaderCircle,
  Minus,
  MonitorUp,
  PackageOpen,
  Pause,
  Play,
  Plug,
  Plus,
  Radio,
  RotateCcw,
  Settings2,
  Subtitles,
  Upload,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AGENT_URL,
  addAgentDownload,
  detectAgent,
  getAgentDownload,
  getAgentPermissionState,
  getAgentPairingUrl,
  getAgentSubtitle,
  resolveAgentSource,
  selectAgentFile,
  type AgentAudioTrack,
  type AgentFile,
  type AgentPermissionState,
  type AgentJob,
  type AgentSubtitleTrack,
} from "../lib/agent-client";
import {
  downloadDirectFile,
  fingerprintFile,
  formatBytes,
  formatTime,
  normalizeToken,
  parseSubtitles,
  resolveSharedSource,
  sourceKindLabel,
  type SubtitleCue,
} from "../lib/media";
import {
  type LocalReadiness,
  type PlayerState,
  type WatchSession,
} from "../lib/session-types";

const emptyReadiness = (): LocalReadiness => ({
  ready: false,
  progress: 0,
  status: "Waiting for media",
  fileName: null,
  fileSize: null,
  fingerprint: null,
});

async function sessionRequest(payload: Record<string, unknown>) {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as { session?: WatchSession; error?: string };
  if (!response.ok || !data.session) {
    throw new Error(data.error || "The session could not be updated.");
  }
  return data.session;
}

function sameSelectedFile(session: WatchSession, readiness: LocalReadiness) {
  if (!session.selectedMedia || !readiness.fileName) return true;
  return (
    session.selectedMedia.name === readiness.fileName &&
    session.selectedMedia.size === readiness.fileSize
  );
}

type SubtitleFont =
  | "proportional-sans"
  | "proportional-serif"
  | "monospace-sans"
  | "monospace-serif"
  | "casual"
  | "cursive"
  | "small-caps";

type SubtitleEdge = "none" | "raised" | "depressed" | "uniform" | "drop-shadow";

interface SubtitleAppearance {
  font: SubtitleFont;
  fontColor: string;
  fontOpacity: number;
  fontSize: number;
  backgroundColor: string;
  backgroundOpacity: number;
  windowColor: string;
  windowOpacity: number;
  edgeStyle: SubtitleEdge;
}

const subtitleColors = [
  { value: "#ffffff", label: "White" },
  { value: "#000000", label: "Black" },
  { value: "#ff5252", label: "Red" },
  { value: "#73d13d", label: "Green" },
  { value: "#4d9fff", label: "Blue" },
  { value: "#ffe45c", label: "Yellow" },
  { value: "#f062d0", label: "Magenta" },
  { value: "#58e5e5", label: "Cyan" },
] as const;

const subtitleFonts: { value: SubtitleFont; label: string; family: string }[] = [
  { value: "proportional-sans", label: "Proportional Sans-Serif", family: "Arial, Helvetica, sans-serif" },
  { value: "proportional-serif", label: "Proportional Serif", family: "Georgia, 'Times New Roman', serif" },
  { value: "monospace-sans", label: "Monospace Sans-Serif", family: "Consolas, 'Liberation Mono', monospace" },
  { value: "monospace-serif", label: "Monospace Serif", family: "'Courier New', Courier, monospace" },
  { value: "casual", label: "Casual", family: "'Comic Sans MS', cursive" },
  { value: "cursive", label: "Cursive", family: "'Brush Script MT', cursive" },
  { value: "small-caps", label: "Small Capitals", family: "Arial, Helvetica, sans-serif" },
];

const subtitleEdges: { value: SubtitleEdge; label: string; shadow: string }[] = [
  { value: "none", label: "None", shadow: "none" },
  { value: "raised", label: "Raised", shadow: "-1px -1px 0 #000, 1px 1px 0 rgba(255,255,255,0.35)" },
  { value: "depressed", label: "Depressed", shadow: "1px 1px 0 #000, -1px -1px 0 rgba(255,255,255,0.3)" },
  { value: "uniform", label: "Uniform", shadow: "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000" },
  { value: "drop-shadow", label: "Drop shadow", shadow: "2px 2px 2px #000" },
];

const defaultSubtitleAppearance: SubtitleAppearance = {
  font: "proportional-sans",
  fontColor: "#ffffff",
  fontOpacity: 100,
  fontSize: 100,
  backgroundColor: "#000000",
  backgroundOpacity: 75,
  windowColor: "#000000",
  windowOpacity: 0,
  edgeStyle: "drop-shadow",
};

function rgba(hex: string, opacity: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  return "rgba(" + (value >> 16) + ", " + ((value >> 8) & 255) + ", " + (value & 255) + ", " + (opacity / 100) + ")";
}

function readSubtitleAppearance(): SubtitleAppearance {
  try {
    const saved = JSON.parse(localStorage.getItem("watchpair-subtitle-appearance") || "{}") as Partial<SubtitleAppearance>;
    const font = subtitleFonts.some((option) => option.value === saved.font)
      ? saved.font as SubtitleFont
      : defaultSubtitleAppearance.font;
    const edgeStyle = subtitleEdges.some((option) => option.value === saved.edgeStyle)
      ? saved.edgeStyle as SubtitleEdge
      : defaultSubtitleAppearance.edgeStyle;
    const color = (candidate: unknown, fallback: string) =>
      subtitleColors.some((option) => option.value === candidate) ? String(candidate) : fallback;
    const percentage = (candidate: unknown, fallback: number, min = 0, max = 100) => {
      const number = Number(candidate);
      return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
    };
    return {
      font,
      edgeStyle,
      fontColor: color(saved.fontColor, defaultSubtitleAppearance.fontColor),
      backgroundColor: color(saved.backgroundColor, defaultSubtitleAppearance.backgroundColor),
      windowColor: color(saved.windowColor, defaultSubtitleAppearance.windowColor),
      fontOpacity: percentage(saved.fontOpacity, defaultSubtitleAppearance.fontOpacity),
      fontSize: percentage(saved.fontSize, defaultSubtitleAppearance.fontSize, 50, 200),
      backgroundOpacity: percentage(saved.backgroundOpacity, defaultSubtitleAppearance.backgroundOpacity),
      windowOpacity: percentage(saved.windowOpacity, defaultSubtitleAppearance.windowOpacity),
    };
  } catch {
    return defaultSubtitleAppearance;
  }
}

function ColorSwatches({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="color-swatches" role="radiogroup" aria-label={label}>
      {subtitleColors.map((color) => (
        <button
          key={color.value}
          type="button"
          className={value === color.value ? "selected" : ""}
          role="radio"
          aria-checked={value === color.value}
          aria-label={color.label}
          title={color.label}
          onClick={() => onChange(color.value)}
          style={{ "--swatch-color": color.value } as CSSProperties}
        >
          <span />
        </button>
      ))}
    </div>
  );
}

export default function WatchApp() {
  const [deviceId, setDeviceId] = useState("");
  const [displayName, setDisplayName] = useState("Guest");
  const [tokenInput, setTokenInput] = useState("");
  const [roomToken, setRoomToken] = useState("");
  const [joined, setJoined] = useState(false);
  const [session, setSession] = useState<WatchSession | null>(null);
  const [view, setView] = useState<"lobby" | "player">("lobby");
  const [sourceInput, setSourceInput] = useState("");
  const [readiness, setReadiness] = useState<LocalReadiness>(emptyReadiness);
  const [mediaUrl, setMediaUrl] = useState("");
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [localSubtitleName, setLocalSubtitleName] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | "source" | "file" | "download" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentPermission, setAgentPermission] = useState<AgentPermissionState | "checking">("checking");
  const [agentPairing, setAgentPairing] = useState(false);
  const [agentJob, setAgentJob] = useState<AgentJob | null>(null);
  const [embeddedAudioTracks, setEmbeddedAudioTracks] = useState<AgentAudioTrack[]>([]);
  const [embeddedSubtitles, setEmbeddedSubtitles] = useState<AgentSubtitleTrack[]>([]);
  const [connection, setConnection] = useState<"syncing" | "online" | "offline">("syncing");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const readinessRef = useRef(readiness);
  const handledSourceRef = useRef("");
  const mediaUrlRef = useRef("");
  const sessionRef = useRef<WatchSession | null>(null);
  const selectionSentRef = useRef("");
  const loadedSubtitleRef = useRef("");
  const initializedMediaTracksRef = useRef("");
  const autoOpenedMediaRef = useRef("");
  const pairingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      let id = localStorage.getItem("watchpair-device-id");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("watchpair-device-id", id);
      }

      const savedName = localStorage.getItem("watchpair-display-name") || "Guest";
      const invitedToken = normalizeToken(new URLSearchParams(window.location.search).get("room") || "");
      setDeviceId(id);
      setDisplayName(savedName);
      setRoomToken(invitedToken);
      setTokenInput(invitedToken);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    readinessRef.current = readiness;
  }, [readiness]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let active = true;
    void getAgentPermissionState().then((permission) => {
      if (active) setAgentPermission(permission);
    });
    return () => {
      active = false;
      if (pairingTimerRef.current !== null) window.clearInterval(pairingTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (agentPermission !== "granted" && agentPermission !== "unsupported") return;
    let active = true;
    let failures = 0;
    const keepAlive = async () => {
      try {
        const available = await detectAgent();
        if (!active) return;
        failures = 0;
        setAgentAvailable(available);
      } catch {
        if (!active) return;
        failures += 1;
        if (failures >= 3) setAgentAvailable(false);
      }
    };

    void keepAlive();
    const timer = window.setInterval(keepAlive, 8_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [agentPermission]);

  const connectCompanion = async () => {
    if (agentPairing) return;
    const pairingWindow = window.open("about:blank", "watchpair-companion");
    if (!pairingWindow) {
      setError("Allow the pairing window, then try connecting the companion again.");
      return;
    }

    const stopPairing = (message?: string) => {
      pairingWindow.close();
      setAgentPairing(false);
      if (message) setError(message);
    };

    setAgentPairing(true);
    setError("");
    let permission = await getAgentPermissionState();
    setAgentPermission(permission);
    if (permission === "denied") {
      stopPairing("Local network access is blocked. Allow it for this site in the browser's site settings, then connect again.");
      return;
    }

    try {
      const available = await detectAgent();
      permission = await getAgentPermissionState();
      setAgentPermission(permission);
      if (available) {
        setAgentAvailable(true);
        stopPairing();
        return;
      }
    } catch {
      permission = await getAgentPermissionState();
      setAgentPermission(permission);
      if (permission === "denied") {
        stopPairing("Local network access was declined. Allow it for this site in the browser's site settings, then connect again.");
        return;
      }
    }

    pairingWindow.location.replace(getAgentPairingUrl());
    let attempts = 0;
    if (pairingTimerRef.current !== null) window.clearInterval(pairingTimerRef.current);
    pairingTimerRef.current = window.setInterval(() => {
      attempts += 1;
      void detectAgent()
        .then((available) => {
          if (!available) return;
          setAgentAvailable(true);
          setAgentPermission("granted");
          setAgentPairing(false);
          pairingWindow.close();
          if (pairingTimerRef.current !== null) window.clearInterval(pairingTimerRef.current);
          pairingTimerRef.current = null;
        })
        .catch(() => {
          if (attempts < 120) return;
          setAgentPairing(false);
          setError("The companion did not answer. Make sure it is running, then connect again.");
          if (pairingTimerRef.current !== null) window.clearInterval(pairingTimerRef.current);
          pairingTimerRef.current = null;
        });
    }, 1_000);
  };

  useEffect(() => {
    mediaUrlRef.current = mediaUrl;
  }, [mediaUrl]);

  useEffect(() => {
    return () => {
      if (mediaUrlRef.current.startsWith("blob:")) URL.revokeObjectURL(mediaUrlRef.current);
    };
  }, []);

  const applySession = useCallback((nextSession: WatchSession) => {
    const current = sessionRef.current;
    const older =
      current?.token === nextSession.token &&
      (nextSession.seq < current.seq ||
        (nextSession.seq === current.seq && nextSession.serverTime < current.serverTime));
    if (older) return false;
    sessionRef.current = nextSession;
    setSession(nextSession);
    return true;
  }, []);

  const enterSession = useCallback((nextSession: WatchSession) => {
    applySession(nextSession);
    setRoomToken(nextSession.token);
    setJoined(true);
    setError("");
    setConnection("online");
    const url = new URL(window.location.href);
    url.searchParams.set("room", nextSession.token);
    window.history.replaceState({}, "", url);
  }, [applySession]);

  const createSession = async () => {
    if (!deviceId) return;
    setBusy("create");
    setError("");
    try {
      localStorage.setItem("watchpair-display-name", displayName.trim() || "Guest");
      const nextSession = await sessionRequest({
        action: "create",
        deviceId,
        name: displayName,
      });
      enterSession(nextSession);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the session.");
    } finally {
      setBusy(null);
    }
  };

  const joinSession = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!deviceId) return;
    const token = normalizeToken(tokenInput || roomToken);
    if (token.length !== 9) {
      setError("Enter the complete 8-character session token.");
      return;
    }

    setBusy("join");
    setError("");
    try {
      localStorage.setItem("watchpair-display-name", displayName.trim() || "Guest");
      const nextSession = await sessionRequest({
        action: "join",
        token,
        deviceId,
        name: displayName,
        readiness,
      });
      enterSession(nextSession);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join the session.");
    } finally {
      setBusy(null);
    }
  };

  const sendAction = useCallback(
    async (action: string, values: Record<string, unknown> = {}) => {
      if (!deviceId || !roomToken) throw new Error("Join a session first.");
      const nextSession = await sessionRequest({
        action,
        token: roomToken,
        deviceId,
        name: displayName,
        ...values,
      });
      applySession(nextSession);
      setConnection("online");
      return nextSession;
    },
    [applySession, deviceId, displayName, roomToken]
  );

  useEffect(() => {
    if (!joined || !roomToken) return;

    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/sessions?token=${encodeURIComponent(roomToken)}`, {
          cache: "no-store",
        });
        const data = (await response.json()) as { session?: WatchSession };
        if (active && response.ok && data.session) {
          applySession(data.session);
          setConnection("online");
        } else if (active) {
          setConnection("offline");
        }
      } catch {
        if (active) setConnection("offline");
      }
    };

    void refresh();
    const poll = window.setInterval(refresh, 700);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [applySession, joined, roomToken]);

  useEffect(() => {
    if (!joined || !roomToken || !deviceId) return;

    const heartbeat = () => {
      void sessionRequest({
        action: "heartbeat",
        token: roomToken,
        deviceId,
        name: displayName,
        readiness: readinessRef.current,
      })
        .then((nextSession) => {
          applySession(nextSession);
          setConnection("online");
        })
        .catch(() => setConnection("offline"));
    };

    heartbeat();
    const timer = window.setInterval(heartbeat, 4_000);
    return () => window.clearInterval(timer);
  }, [applySession, deviceId, displayName, joined, roomToken]);

  const attachLocalFile = useCallback(
    async (file: File, preferredName = file.name) => {
      setBusy("file");
      setError("");
      try {
        setEmbeddedAudioTracks([]);
        setEmbeddedSubtitles([]);
        const playableFile =
          preferredName === file.name ? file : new File([file], preferredName, { type: file.type });
        const fingerprint = await fingerprintFile(playableFile);
        const url = URL.createObjectURL(playableFile);
        if (mediaUrlRef.current.startsWith("blob:")) URL.revokeObjectURL(mediaUrlRef.current);
        setMediaUrl(url);

        const nextReadiness: LocalReadiness = {
          ready: true,
          progress: 100,
          status: "Ready to watch",
          fileName: preferredName,
          fileSize: playableFile.size,
          fingerprint,
        };
        setReadiness(nextReadiness);
        readinessRef.current = nextReadiness;
        await sendAction("heartbeat", { readiness: nextReadiness });
        await sendAction("select-media", {
          media: {
            name: preferredName,
            size: playableFile.size,
            fingerprint,
          },
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not prepare that file.");
      } finally {
        setBusy(null);
      }
    },
    [sendAction]
  );

  const onChooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await attachLocalFile(file);
  };

  const onChooseSubtitle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const cues = parseSubtitles(await file.text());
      if (!cues.length) throw new Error("No subtitle cues were found in that file.");
      setSubtitleCues(cues);
      setLocalSubtitleName(file.name);
      if (session) {
        await sendAction("player", {
          player: { ...session.player, subtitleLanguage: "local" },
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read those subtitles.");
    }
  };

  const addSource = async (event: FormEvent) => {
    event.preventDefault();
    if (!sourceInput.trim()) return;

    setBusy("source");
    setError("");
    try {
      const resolved = agentAvailable
        ? await resolveAgentSource(sourceInput)
        : await resolveSharedSource(sourceInput);
      await sendAction("source", { source: resolved });
      setSourceInput("");
      setReadiness(emptyReadiness());
      setMediaUrl((current) => {
        if (current.startsWith("blob:")) URL.revokeObjectURL(current);
        return "";
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add that source.");
    } finally {
      setBusy(null);
    }
  };

  const canHandleSource = session?.source?.kind !== "magnet" || agentAvailable;

  useEffect(() => {
    const source = session?.source;
    if (!joined || !source || !canHandleSource || handledSourceRef.current === source.id) return;

    handledSourceRef.current = source.id;
    selectionSentRef.current = "";
    setAgentJob(null);
    setEmbeddedAudioTracks([]);
    setEmbeddedSubtitles([]);
    setSubtitleCues([]);
    setLocalSubtitleName("");
    loadedSubtitleRef.current = "";
    initializedMediaTracksRef.current = "";
    autoOpenedMediaRef.current = "";
    const controller = new AbortController();
    const initial: LocalReadiness = {
      ...emptyReadiness(),
      status: "Starting local download",
    };
    setReadiness(initial);
    readinessRef.current = initial;
    setBusy("download");

    const startDownload = async () => {
      if (source.kind === "magnet") {
        try {
          const job = await addAgentDownload(source);
          if (controller.signal.aborted) return;
          setAgentJob(job);
          setEmbeddedAudioTracks(job.audioTracks || []);
          setEmbeddedSubtitles(job.subtitles || []);
          setBusy(null);
          return;
        } catch {
          setAgentAvailable(false);
          handledSourceRef.current = "";
          const next: LocalReadiness = {
            ...emptyReadiness(),
            status: "Connect the companion to start this torrent",
          };
          readinessRef.current = next;
          setReadiness(next);
          setBusy(null);
          return;
        }
      }

      try {
        const file = await downloadDirectFile(
          source,
          (progress) => {
            const next: LocalReadiness = {
              ...readinessRef.current,
              ready: false,
              progress: Math.round(progress),
              status: progress >= 100 ? "Verifying file" : "Downloading locally",
            };
            readinessRef.current = next;
            setReadiness(next);
          },
          controller.signal
        );
        if (!controller.signal.aborted) await attachLocalFile(file, source.label);
      } catch (caught) {
        if (controller.signal.aborted) return;
        const next: LocalReadiness = {
          ...emptyReadiness(),
          status: "Choose the downloaded file",
        };
        readinessRef.current = next;
        setReadiness(next);
        setError(
          caught instanceof Error
            ? `Automatic download was blocked. Choose the local file when it is ready. ${caught.message}`
            : "Automatic download was blocked. Choose the local file when it is ready."
        );
      } finally {
        setBusy(null);
      }
    };

    void startDownload();
    return () => controller.abort();
  }, [attachLocalFile, canHandleSource, joined, session?.source]);

  useEffect(() => {
    const source = session?.source;
    if (!joined || !source || !agentAvailable) return;

    let active = true;
    const refresh = async () => {
      try {
        let job: AgentJob;
        try {
          job = await getAgentDownload(source.id);
        } catch {
          job = await addAgentDownload(source);
        }
        if (!active) return;
        setAgentJob(job);
        setEmbeddedAudioTracks(job.audioTracks || []);
        setEmbeddedSubtitles(job.subtitles || []);

        if (job.status === "error") {
          const next = {
            ...emptyReadiness(),
            status: job.error || "Local download failed",
          };
          readinessRef.current = next;
          setReadiness(next);
          return;
        }

        const currentSession = sessionRef.current;
        let target = currentSession?.selectedMedia
          ? job.files.find(
              (file) =>
                file.name === currentSession.selectedMedia?.name &&
                file.size === currentSession.selectedMedia.size
            )
          : job.files.find((file) => file.selected);

        if (!target && job.files.length) {
          target = [...job.files].sort(
            (left, right) =>
              Number(/\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(right.name)) -
                Number(/\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(left.name)) ||
              right.size - left.size
          )[0];
        }

        if (!target) {
          const next = {
            ...emptyReadiness(),
            status: job.status === "metadata" ? "Reading torrent metadata" : "Preparing download",
          };
          readinessRef.current = next;
          setReadiness(next);
          return;
        }

        const selectionKey = `${source.id}:${target.index}`;
        if (job.kind === "magnet" && !target.selected) {
          job = await selectAgentFile(source.id, target.index);
          setAgentJob(job);
          setEmbeddedAudioTracks(job.audioTracks || []);
          setEmbeddedSubtitles(job.subtitles || []);
          target = job.files.find((file) => file.index === target?.index) || target;
        }

        if (!currentSession?.selectedMedia && selectionSentRef.current !== selectionKey) {
          selectionSentRef.current = selectionKey;
          await sendAction("select-media", {
            media: {
              name: target.name,
              size: target.size,
              fingerprint: `${job.infoHash || source.id}:${target.index}:${target.size}`,
            },
          });
        }

        const isReady = target.ready;
        const next: LocalReadiness = {
          ready: isReady,
          progress: target.progress,
          status: isReady ? "Ready to watch" : job.status === "metadata" ? "Reading torrent metadata" : "Downloading locally",
          fileName: target.name,
          fileSize: target.size,
          fingerprint: `${job.infoHash || source.id}:${target.index}:${target.size}`,
        };
        const becameReady = isReady && !readinessRef.current.ready;
        readinessRef.current = next;
        setReadiness(next);
        if (isReady) setMediaUrl(target.streamUrl);
        else setMediaUrl("");
        if (becameReady) await sendAction("heartbeat", { readiness: next });
      } catch {
        // The keepalive retries transient companion failures without stopping this poller.
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [agentAvailable, joined, sendAction, session?.source]);

  useEffect(() => {
    const source = session?.source;
    if (!joined || source?.kind !== "magnet" || agentAvailable || !agentJob) return;
    const timer = window.setTimeout(() => {
      if (mediaUrlRef.current.startsWith(AGENT_URL)) setMediaUrl("");
      const next: LocalReadiness = {
        ...readinessRef.current,
        ready: false,
        status:
          agentPermission === "denied"
            ? "Allow local network access, then reconnect"
            : "Companion disconnected; reconnecting",
      };
      readinessRef.current = next;
      setReadiness(next);
      void sendAction("heartbeat", { readiness: next });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [agentAvailable, agentJob, agentPermission, joined, sendAction, session?.source]);

  const requestedSubtitleSelection = session?.player.subtitleLanguage || "off";
  const requestedSubtitleTrackId = requestedSubtitleSelection.startsWith("embedded:")
    ? requestedSubtitleSelection.slice("embedded:".length)
    : "";
  const requestedSubtitleTrack = embeddedSubtitles.find(
    (track) => track.id === requestedSubtitleTrackId
  );
  const requestedSubtitleTrackSupported = Boolean(requestedSubtitleTrack?.supported);

  const selectedMediaTrackKey =
    session?.selectedMedia?.fingerprint ||
    (session?.selectedMedia ? session.selectedMedia.name + ":" + session.selectedMedia.size : "");

  useEffect(() => {
    const sourceId = session?.source?.id;
    if (!sourceId || !selectedMediaTrackKey || agentJob?.subtitleStatus !== "ready") return;
    const initializationKey = sourceId + ":" + selectedMediaTrackKey;
    if (initializedMediaTracksRef.current === initializationKey) return;
    const defaultSubtitle = embeddedSubtitles.find((track) => track.default && track.supported);
    if (!defaultSubtitle || session.player.subtitleLanguage !== "off") {
      initializedMediaTracksRef.current = initializationKey;
      return;
    }

    initializedMediaTracksRef.current = initializationKey;
    const timer = window.setTimeout(() => {
      void sendAction("player", {
        player: {
          ...session.player,
          subtitleLanguage: "embedded:" + defaultSubtitle.id,
        },
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (initializedMediaTracksRef.current === initializationKey) {
        initializedMediaTracksRef.current = "";
      }
    };
  }, [
    agentJob?.subtitleStatus,
    embeddedSubtitles,
    selectedMediaTrackKey,
    sendAction,
    session?.player,
    session?.source?.id,
  ]);

  useEffect(() => {
    const selection = requestedSubtitleSelection;
    const sourceId = session?.source?.id;
    if (!selection.startsWith("embedded:")) {
      loadedSubtitleRef.current = "";
      return;
    }
    if (!sourceId || !requestedSubtitleTrackSupported) {
      loadedSubtitleRef.current = "";
      const clearTimer = window.setTimeout(() => setSubtitleCues([]), 0);
      return () => window.clearTimeout(clearTimer);
    }

    const trackId = requestedSubtitleTrackId;
    const loadKey = sourceId + ":" + selectedMediaTrackKey + ":" + trackId;
    if (loadedSubtitleRef.current === loadKey) return;
    loadedSubtitleRef.current = loadKey;

    let active = true;
    const clearTimer = window.setTimeout(() => {
      if (active) setSubtitleCues([]);
    }, 0);
    void getAgentSubtitle(sourceId, trackId)
      .then((contents) => {
        if (!active) return;
        const cues = parseSubtitles(contents);
        if (!cues.length) throw new Error("No cues were extracted from that embedded track.");
        setSubtitleCues(cues);
      })
      .catch((caught) => {
        if (!active) return;
        loadedSubtitleRef.current = "";
        setError(caught instanceof Error ? caught.message : "Could not load embedded subtitles.");
      });

    return () => {
      active = false;
      window.clearTimeout(clearTimer);
    };
  }, [
    requestedSubtitleSelection,
    requestedSubtitleTrackId,
    requestedSubtitleTrackSupported,
    selectedMediaTrackKey,
    session?.source?.id,
  ]);

  const chooseAgentMedia = async (file: AgentFile) => {
    const source = session?.source;
    if (!source || !agentJob) return;
    setBusy("file");
    setError("");
    try {
      setMediaUrl("");
      setSubtitleCues([]);
      if (agentJob.kind === "magnet") {
        const nextJob = await selectAgentFile(source.id, file.index);
        setAgentJob(nextJob);
        setEmbeddedAudioTracks(nextJob.audioTracks || []);
        setEmbeddedSubtitles(nextJob.subtitles || []);
      }
      selectionSentRef.current = `${source.id}:${file.index}`;
      await sendAction("select-media", {
        media: {
          name: file.name,
          size: file.size,
          fingerprint: `${agentJob.infoHash || source.id}:${file.index}:${file.size}`,
        },
      });
      const next = {
        ...emptyReadiness(),
        progress: file.progress,
        status: "Downloading selected file",
        fileName: file.name,
        fileSize: file.size,
        fingerprint: `${agentJob.infoHash || source.id}:${file.index}:${file.size}`,
      };
      readinessRef.current = next;
      setReadiness(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not select that file.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!session?.selectedMedia || !readiness.ready || sameSelectedFile(session, readiness)) return;
    const timer = window.setTimeout(() => {
      const next = {
        ...readiness,
        ready: false,
        status: "A different file was selected",
      };
      setReadiness(next);
      readinessRef.current = next;
      void sendAction("heartbeat", { readiness: next });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [readiness, sendAction, session]);

  const copyInvite = async () => {
    if (!session) return;
    const invite = new URL(window.location.href);
    invite.searchParams.set("room", session.token);
    await navigator.clipboard.writeText(invite.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  };

  const leaveSession = () => {
    setJoined(false);
    sessionRef.current = null;
    setSession(null);
    setRoomToken("");
    setTokenInput("");
    setView("lobby");
    setReadiness(emptyReadiness());
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url);
  };

  const sendPlayerState = useCallback(
    async (player: PlayerState) => {
      await sendAction("player", { player });
    },
    [sendAction]
  );

  const readyParticipants = session?.participants.filter((participant) => participant.ready) ?? [];
  const fingerprints = new Set(
    readyParticipants.map((participant) => participant.fingerprint).filter(Boolean)
  );
  const hasMismatch = fingerprints.size > 1;
  const everyoneReady =
    Boolean(session) &&
    session!.participants.length >= 2 &&
    readiness.ready &&
    session!.participants.every((participant) => participant.ready) &&
    !hasMismatch;
  const invitePending = Boolean(roomToken && !joined);
  const playerMediaKey = session?.selectedMedia
    ? (session.source?.id || "local") + ":" +
      (session.selectedMedia.fingerprint || session.selectedMedia.name + ":" + session.selectedMedia.size)
    : "";

  const openPlayer = useCallback(() => {
    if (playerMediaKey) autoOpenedMediaRef.current = playerMediaKey;
    setView("player");
  }, [playerMediaKey]);

  useEffect(() => {
    if (!joined || view !== "lobby" || !everyoneReady || !mediaUrl || !playerMediaKey) return;
    if (autoOpenedMediaRef.current === playerMediaKey) return;
    autoOpenedMediaRef.current = playerMediaKey;
    const timer = window.setTimeout(() => setView("player"), 0);
    return () => window.clearTimeout(timer);
  }, [everyoneReady, joined, mediaUrl, playerMediaKey, view]);

  if (joined && session && view === "player" && mediaUrl) {
    return (
      <SyncedPlayer
        session={session}
        mediaUrl={mediaUrl}
        subtitleCues={subtitleCues}
        localSubtitleName={localSubtitleName}
        audioTracks={embeddedAudioTracks}
        subtitleTracks={embeddedSubtitles}
        onBack={() => setView("lobby")}
        onSend={sendPlayerState}
      />
    );
  }

  if (!joined) {
    return (
      <main className="entry-shell">
        <header className="brand-lockup" aria-label="WatchPair">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span>WatchPair</span>
        </header>

        <section className="entry-panel" aria-labelledby="entry-title">
          <div className="entry-copy">
            <span className="eyebrow">{invitePending ? "Private invite" : "Watch from your own files"}</span>
            <h1 id="entry-title">
              {invitePending ? (
                <>Join session <strong>{roomToken}</strong></>
              ) : (
                <>Same frame. <strong>Same moment.</strong></>
              )}
            </h1>
            <p>
              Pair two browsers, prepare the same video on both devices, and keep every play,
              pause, seek, language, and subtitle choice together.
            </p>
          </div>

          <form className="entry-form" onSubmit={joinSession}>
            <label>
              <span>Your name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={28}
                placeholder="Guest"
                autoComplete="nickname"
              />
            </label>

            <label>
              <span>Session token</span>
              <input
                className="token-input"
                value={tokenInput}
                onChange={(event) => setTokenInput(normalizeToken(event.target.value))}
                maxLength={9}
                placeholder="ABCD-2345"
                autoComplete="off"
              />
            </label>

            {error && <p className="form-error" role="alert">{error}</p>}

            <div className="entry-actions">
              <button className="primary-button" type="submit" disabled={busy !== null}>
                {busy === "join" ? <LoaderCircle className="spin" /> : <Link2 />}
                Join session
              </button>
              {!invitePending && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={createSession}
                  disabled={busy !== null}
                >
                  {busy === "create" ? <LoaderCircle className="spin" /> : <Plus />}
                  Create new
                </button>
              )}
            </div>
          </form>
        </section>

        <footer className="entry-footer">
          <span><Radio /> Peer presence</span>
          <span><FileVideo2 /> Local media</span>
          <span><Subtitles /> Synced tracks</span>
        </footer>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <button className="brand-lockup compact" onClick={leaveSession} aria-label="Leave session">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>WatchPair</span>
        </button>

        <div className="session-pill">
          <span className={`connection-dot ${connection}`} />
          <span className="session-label">Session</span>
          <strong>{session?.token}</strong>
          <button className="icon-button" onClick={copyInvite} title="Copy invite link" aria-label="Copy invite link">
            {copied ? <Check /> : <Copy />}
          </button>
        </div>

        <div className="header-people" aria-label="People in session">
          <Users />
          <span>{session?.participants.length ?? 0} online</span>
        </div>
      </header>

      <div className="workspace">
        <section className="source-section" aria-labelledby="source-title">
          <div className="section-heading">
            <div>
              <span className="step-number">01</span>
              <h2 id="source-title">Choose what to watch</h2>
            </div>
            {session?.source && (
              <span className="source-badge">{sourceKindLabel(session.source.kind)}</span>
            )}
          </div>

          <form className="source-form" onSubmit={addSource}>
            <div className="source-input-wrap">
              <Link2 aria-hidden="true" />
              <input
                value={sourceInput}
                onChange={(event) => setSourceInput(event.target.value)}
                placeholder="Paste a magnet, video URL, or page containing one"
                aria-label="Media source"
              />
            </div>
            <button className="primary-button" disabled={busy === "source" || !sourceInput.trim()}>
              {busy === "source" ? <LoaderCircle className="spin" /> : <Plus />}
              Add
            </button>
          </form>

          {!agentAvailable && (
            <div className="companion-callout">
              <div>
                <span className="companion-icon"><Plug /></span>
                <span>
                  <strong>Companion needed</strong>
                  <small>Connect it for magnet pages, torrent downloads, and embedded MKV subtitles.</small>
                </span>
              </div>
              <div className="companion-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={connectCompanion}
                  disabled={agentPairing}
                >
                  {agentPairing ? <LoaderCircle className="spin" /> : <Plug />}
                  {agentPairing ? "Waiting for approval" : "Connect"}
                </button>
                <a className="secondary-button" href="/watchpair-companion.zip" download>
                  <PackageOpen />
                  Get companion
                </a>
              </div>
            </div>
          )}

          {session?.source ? (
            <>
              <div className="source-current">
                <div className="file-icon"><Download /></div>
                <div className="source-details">
                  <strong>{session.source.label}</strong>
                  <span>
                    {agentAvailable
                      ? `Companion connected: ${agentJob?.status || "starting"}`
                      : session.source.kind === "direct"
                        ? "Downloading in this browser"
                        : "Connect the companion to start this torrent"}
                  </span>
                </div>
                {session.source.kind === "magnet" && !agentAvailable ? (
                  <button className="secondary-button compact-button" type="button" onClick={connectCompanion}>
                    <Plug />
                    Connect
                  </button>
                ) : agentAvailable ? (
                  <span className="agent-chip"><Radio /> Local agent</span>
                ) : null}
              </div>

              {agentJob && agentJob.files.length > 1 && (
                <div className="agent-files" aria-label="Files in download">
                  {agentJob.files.slice(0, 8).map((file) => {
                    const selected =
                      file.selected ||
                      (session.selectedMedia?.name === file.name &&
                        session.selectedMedia.size === file.size);
                    return (
                      <button
                        className={selected ? "selected" : ""}
                        type="button"
                        key={file.index}
                        onClick={() => void chooseAgentMedia(file)}
                      >
                        <FileVideo2 />
                        <span>
                          <strong>{file.name}</strong>
                          <small>{formatBytes(file.size)} / {Math.round(file.progress)}%</small>
                        </span>
                        {selected && <Check />}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <button className="drop-zone" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload />
              <span><strong>Use a local video</strong> already on this device</span>
            </button>
          )}

          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="video/*,.mkv,.m4v,.mov,.webm"
            onChange={onChooseFile}
          />
          <input
            ref={subtitleInputRef}
            className="sr-only"
            type="file"
            accept=".srt,.vtt,text/vtt"
            onChange={onChooseSubtitle}
          />
        </section>

        <section className="readiness-section" aria-labelledby="readiness-title">
          <div className="section-heading">
            <div>
              <span className="step-number">02</span>
              <h2 id="readiness-title">Get both copies ready</h2>
            </div>
            <span className={`readiness-summary ${everyoneReady ? "ready" : ""}`}>
              {everyoneReady ? "Both ready" : `${readyParticipants.length}/${Math.max(2, session?.participants.length ?? 0)} ready`}
            </span>
          </div>

          <div className="people-grid">
            {session?.participants.map((participant) => {
              const isYou = participant.deviceId === deviceId;
              return (
                <article className="person-row" key={participant.deviceId}>
                  <div className={`avatar ${isYou ? "you" : ""}`}>
                    {participant.name.slice(0, 1).toUpperCase()}
                    <span className={participant.ready ? "ready" : ""} />
                  </div>
                  <div className="person-copy">
                    <div>
                      <strong>{participant.name}</strong>
                      {isYou && <span className="you-label">You</span>}
                    </div>
                    <span>{participant.status}</span>
                    <div className="progress-track" aria-label={`${participant.progress}% complete`}>
                      <span style={{ width: `${participant.progress}%` }} />
                    </div>
                  </div>
                  <div className="person-progress">
                    <strong>{Math.round(participant.progress)}%</strong>
                    <span>{participant.fileSize ? formatBytes(participant.fileSize) : "No file"}</span>
                  </div>
                </article>
              );
            })}

            {(session?.participants.length ?? 0) < 2 && (
              <article className="person-row waiting-row">
                <div className="avatar waiting"><Users /></div>
                <div className="person-copy">
                  <strong>Waiting for your watch partner</strong>
                  <button type="button" onClick={copyInvite}>
                    {copied ? "Invite copied" : "Copy invite link"}
                  </button>
                </div>
              </article>
            )}
          </div>

          {hasMismatch && (
            <p className="mismatch-message" role="alert">
              The ready files do not match. Choose the same release on both devices.
            </p>
          )}

          <div className="local-media-bar">
            <div>
              <FileVideo2 />
              <span>
                <strong>{readiness.fileName || session?.selectedMedia?.name || "No local file selected"}</strong>
                <small>
                  {readiness.fileName
                    ? `${formatBytes(readiness.fileSize)} on this device`
                    : "Select the matching download when it is ready"}
                </small>
              </span>
            </div>
            <div className="local-media-actions">
              {mediaUrl && (
                <button className="secondary-button" type="button" onClick={() => subtitleInputRef.current?.click()}>
                  <Subtitles />
                  {localSubtitleName || "Add subtitles"}
                </button>
              )}
              <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                <MonitorUp />
                {readiness.fileName ? "Change file" : "Choose file"}
              </button>
            </div>
          </div>
        </section>

        <section className="watch-section" aria-labelledby="watch-title">
          <div className="watch-copy">
            <span className="step-number">03</span>
            <div>
              <h2 id="watch-title">Enter the screening</h2>
              <p>
                {everyoneReady
                  ? "Both files match. Playback controls now belong to everyone."
                  : "The shared player unlocks when both devices report a matching file."}
              </p>
            </div>
          </div>

          <div className="watch-actions">
            {mediaUrl && !everyoneReady && (
              <button className="secondary-button" onClick={openPlayer}>
                <Play />
                Preview alone
              </button>
            )}
            <button
              className="watch-button"
              disabled={!everyoneReady || !mediaUrl}
              onClick={openPlayer}
            >
              <Play fill="currentColor" />
              Watch together
            </button>
          </div>
        </section>

        {error && (
          <div className="toast-error" role="alert">
            <span>{error}</span>
            <button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error">
              <X />
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

interface SyncedPlayerProps {
  session: WatchSession;
  mediaUrl: string;
  subtitleCues: SubtitleCue[];
  localSubtitleName: string;
  audioTracks: AgentAudioTrack[];
  subtitleTracks: AgentSubtitleTrack[];
  onBack: () => void;
  onSend: (player: PlayerState) => Promise<void>;
}

function SyncedPlayer({
  session,
  mediaUrl,
  subtitleCues,
  localSubtitleName,
  audioTracks,
  subtitleTracks,
  onBack,
  onSend,
}: SyncedPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(-1);
  const controlsHideTimerRef = useRef<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState("");
  const [subtitleText, setSubtitleText] = useState("");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [captionSettingsOpen, setCaptionSettingsOpen] = useState(false);
  const [subtitleAppearance, setSubtitleAppearance] = useState(defaultSubtitleAppearance);

  const defaultAudioTrack = audioTracks.find((track) => track.default) || audioTracks[0];
  const requestedAudioTrackId = session.player.audioLanguage.startsWith("embedded:")
    ? session.player.audioLanguage.slice("embedded:".length)
    : "";
  const requestedAudioTrack = audioTracks.find((track) => track.id === requestedAudioTrackId);
  const audioSelection = requestedAudioTrack ? session.player.audioLanguage : "original";
  const requestedPlayerSubtitleId = session.player.subtitleLanguage.startsWith("embedded:")
    ? session.player.subtitleLanguage.slice("embedded:".length)
    : "";
  const hasRequestedSubtitle = subtitleTracks.some((track) => track.id === requestedPlayerSubtitleId);
  const subtitleSelection =
    session.player.subtitleLanguage === "local" && localSubtitleName
      ? "local"
      : hasRequestedSubtitle
        ? session.player.subtitleLanguage
        : "off";
  const playbackAudioTrack = requestedAudioTrack || defaultAudioTrack;
  const playbackUrl = useMemo(() => {
    if (!playbackAudioTrack) return mediaUrl;
    const url = new URL(mediaUrl);
    url.searchParams.set("audio", playbackAudioTrack.id);
    return url.toString();
  }, [mediaUrl, playbackAudioTrack]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSubtitleAppearance(readSubtitleAppearance()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const clearControlsTimer = useCallback(() => {
    if (controlsHideTimerRef.current !== null) {
      window.clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = null;
    }
  }, []);

  const pinControls = useCallback(() => {
    clearControlsTimer();
    setControlsVisible(true);
  }, [clearControlsTimer]);

  const scheduleControlsHide = useCallback((ignoreOpenSettings = false) => {
    clearControlsTimer();
    const video = videoRef.current;
    if (!video || video.paused || (!ignoreOpenSettings && captionSettingsOpen) || needsGesture) return;
    controlsHideTimerRef.current = window.setTimeout(() => {
      controlsHideTimerRef.current = null;
      const focused = document.activeElement;
      if (focused && focused !== video && playerRef.current?.contains(focused)) return;
      setControlsVisible(false);
    }, 2_500);
  }, [captionSettingsOpen, clearControlsTimer, needsGesture]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  const hideControls = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused || captionSettingsOpen || needsGesture) return;
    clearControlsTimer();
    setControlsVisible(false);
  }, [captionSettingsOpen, clearControlsTimer, needsGesture]);

  useEffect(() => () => clearControlsTimer(), [clearControlsTimer]);

  const handlePlaybackFailure = useCallback(
    (caught: unknown) => {
      const autoplayBlocked = caught instanceof DOMException && caught.name === "NotAllowedError";
      if (autoplayBlocked) {
        setNeedsGesture(true);
      } else {
        setNeedsGesture(false);
        setMediaLoading(false);
        setMediaError(
          mediaUrl.startsWith(AGENT_URL)
            ? "The companion video stream could not be opened. Return to the lobby and reconnect it."
            : "This video could not be prepared for browser playback."
        );
      }
      pinControls();
    },
    [mediaUrl, pinControls]
  );

  const updateSubtitleAppearance = (values: Partial<SubtitleAppearance>) => {
    const next = { ...subtitleAppearance, ...values };
    setSubtitleAppearance(next);
    localStorage.setItem("watchpair-subtitle-appearance", JSON.stringify(next));
  };

  const resetSubtitleAppearance = () => {
    setSubtitleAppearance(defaultSubtitleAppearance);
    localStorage.removeItem("watchpair-subtitle-appearance");
  };

  const selectedSubtitleFont =
    subtitleFonts.find((option) => option.value === subtitleAppearance.font) || subtitleFonts[0];
  const selectedSubtitleEdge =
    subtitleEdges.find((option) => option.value === subtitleAppearance.edgeStyle) || subtitleEdges[0];
  const subtitleStyle = {
    "--subtitle-font-family": selectedSubtitleFont.family,
    "--subtitle-font-scale": subtitleAppearance.fontSize / 100,
    "--subtitle-font-color": rgba(subtitleAppearance.fontColor, subtitleAppearance.fontOpacity),
    "--subtitle-background": rgba(
      subtitleAppearance.backgroundColor,
      subtitleAppearance.backgroundOpacity
    ),
    "--subtitle-window": rgba(subtitleAppearance.windowColor, subtitleAppearance.windowOpacity),
    "--subtitle-edge": selectedSubtitleEdge.shadow,
    fontVariant: subtitleAppearance.font === "small-caps" ? "small-caps" : "normal",
  } as CSSProperties;

  const send = useCallback(
    (values: Partial<PlayerState>) => {
      const video = videoRef.current;
      return onSend({
        ...session.player,
        paused: video?.paused ?? session.player.paused,
        position: video?.currentTime ?? session.player.position,
        ...values,
      });
    },
    [onSend, session.player]
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || lastSeqRef.current === session.seq) return;
    lastSeqRef.current = session.seq;

    const state = session.player;
    const expected = state.paused
      ? state.position
      : state.position + ((Date.now() - state.changedAt) / 1000) * state.playbackRate;
    const drift = expected - video.currentTime;

    if (Math.abs(drift) > 0.85) {
      video.currentTime = Math.max(0, expected);
    } else if (!state.paused && Math.abs(drift) > 0.2) {
      video.playbackRate = Math.max(0.5, Math.min(2, state.playbackRate + Math.sign(drift) * 0.05));
      window.setTimeout(() => {
        if (videoRef.current) videoRef.current.playbackRate = state.playbackRate;
      }, 1_200);
    } else {
      video.playbackRate = state.playbackRate;
    }

    if (state.paused && !video.paused) {
      video.pause();
    } else if (!state.paused && video.paused) {
      void video
        .play()
        .then(() => setNeedsGesture(false))
        .catch(handlePlaybackFailure);
    }

  }, [handlePlaybackFailure, session.player, session.seq]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      setCurrentTime(video.currentTime);
      setDuration(video.duration || 0);

      if (session.player.subtitleLanguage === "off" || !subtitleCues.length) {
        setSubtitleText("");
        return;
      }
      const subtitleTime = video.currentTime - session.player.subtitleOffset / 1000;
      const cue = subtitleCues.find((item) => subtitleTime >= item.start && subtitleTime <= item.end);
      setSubtitleText(cue?.text || "");
    }, 120);

    return () => window.clearInterval(timer);
  }, [session.player.subtitleLanguage, session.player.subtitleOffset, subtitleCues]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      revealControls();
      if (event.key === "Escape" && captionSettingsOpen) {
        setCaptionSettingsOpen(false);
        scheduleControlsHide(true);
        return;
      }
      const target = event.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
      const video = videoRef.current;
      if (!video) return;

      if (event.code === "Space") {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const next = Math.max(0, video.currentTime + (event.key === "ArrowRight" ? 10 : -10));
        video.currentTime = next;
        void send({ position: next, paused: video.paused });
      } else if (event.key.toLowerCase() === "f") {
        void playerRef.current?.requestFullscreen();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      try {
        await video.play();
        setNeedsGesture(false);
        setMediaError("");
        await send({ paused: false, position: video.currentTime });
      } catch (caught) {
        handlePlaybackFailure(caught);
      }
    } else {
      video.pause();
      await send({ paused: true, position: video.currentTime });
    }
  }

  const seekTo = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentTime(value);
  };

  const commitSeek = () => {
    const video = videoRef.current;
    if (video) void send({ position: video.currentTime, paused: video.paused });
  };

  const changeVolume = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = false;
    setMuted(false);
    setVolume(value);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const updateTrack = (key: "audioLanguage" | "subtitleLanguage", value: string) => {
    void send({ [key]: value });
  };

  const updateOffset = (amount: number) => {
    void send({
      subtitleOffset: Math.max(-10_000, Math.min(10_000, session.player.subtitleOffset + amount)),
    });
  };

  const toggleCaptionSettings = () => {
    if (captionSettingsOpen) {
      setCaptionSettingsOpen(false);
      setControlsVisible(true);
      scheduleControlsHide(true);
    } else {
      setCaptionSettingsOpen(true);
      pinControls();
    }
  };

  const fullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void playerRef.current?.requestFullscreen();
    }
  };

  return (
    <main
      className={"player-shell " + (controlsVisible ? "controls-visible" : "controls-hidden")}
      ref={playerRef}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onPointerLeave={hideControls}
      onFocusCapture={revealControls}
      onBlurCapture={revealControls}
    >
      <video
        ref={videoRef}
        src={playbackUrl}
        playsInline
        onLoadStart={() => {
          setMediaLoading(true);
          setMediaError("");
        }}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration);
          setMediaLoading(false);
          setMediaError("");
          const expected = session.player.paused
            ? session.player.position
            : session.player.position + ((Date.now() - session.player.changedAt) / 1000) * session.player.playbackRate;
          video.currentTime = Math.max(0, expected);
        }}
        onCanPlay={() => setMediaLoading(false)}
        onPlaying={() => setMediaLoading(false)}
        onWaiting={() => setMediaLoading(true)}
        onError={() => {
          setMediaLoading(false);
          setMediaError(
            mediaUrl.startsWith(AGENT_URL)
              ? "The companion video stream could not be opened. Return to the lobby and reconnect it."
              : "This video format could not be opened by the browser."
          );
          pinControls();
        }}
        onEnded={() => void send({ paused: true, position: duration })}
        onPlay={revealControls}
        onPause={pinControls}
        onDoubleClick={fullscreen}
      />

      <div className="player-topbar">
        <button className="player-icon-button" onClick={onBack} title="Back to lobby" aria-label="Back to lobby">
          <ArrowLeft />
        </button>
        <div className="player-title">
          <strong>{session.selectedMedia?.name || "Local preview"}</strong>
          <span><span className="live-dot" /> Synced with {Math.max(0, session.participants.length - 1)} partner</span>
        </div>
        <div className="player-avatars">
          {session.participants.slice(0, 4).map((participant) => (
            <span key={participant.deviceId} title={participant.name}>
              {participant.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
      </div>

      {subtitleText && (
        <div className="subtitle-overlay">
          <div className="subtitle-window" style={subtitleStyle}>
            {subtitleText.split("\n").map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}
          </div>
        </div>
      )}

      {(mediaLoading || mediaError) && !needsGesture && (
        <div className={"media-state-overlay" + (mediaError ? " error" : "")} role={mediaError ? "alert" : "status"}>
          {mediaError ? <X /> : <LoaderCircle className="spin" />}
          <strong>{mediaError || "Preparing video for this browser"}</strong>
          {mediaError && (
            <button type="button" onClick={onBack}>
              <ArrowLeft />
              Back to lobby
            </button>
          )}
        </div>
      )}

      {needsGesture && (
        <button className="gesture-overlay" onClick={togglePlayback}>
          <Play fill="currentColor" />
          Tap to join playback
        </button>
      )}

      <div className="player-controls">
        {captionSettingsOpen && (
          <section className="caption-settings" role="dialog" aria-label="Caption options">
            <header className="caption-settings-header">
              <strong>Caption options</strong>
              <button type="button" className="caption-reset-button" onClick={resetSubtitleAppearance}>
                <RotateCcw />
                Reset
              </button>
            </header>

            <div className="caption-settings-grid">
              <label className="caption-setting caption-setting-wide">
                <span>Font</span>
                <select
                  value={subtitleAppearance.font}
                  onChange={(event) => updateSubtitleAppearance({ font: event.target.value as SubtitleFont })}
                >
                  {subtitleFonts.map((font) => (
                    <option key={font.value} value={font.value}>{font.label}</option>
                  ))}
                </select>
              </label>

              <label className="caption-setting">
                <span>Font size <output>{subtitleAppearance.fontSize}%</output></span>
                <input
                  type="range"
                  min={50}
                  max={200}
                  step={25}
                  value={subtitleAppearance.fontSize}
                  onChange={(event) => updateSubtitleAppearance({ fontSize: Number(event.target.value) })}
                />
              </label>

              <label className="caption-setting">
                <span>Font opacity <output>{subtitleAppearance.fontOpacity}%</output></span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={25}
                  value={subtitleAppearance.fontOpacity}
                  onChange={(event) => updateSubtitleAppearance({ fontOpacity: Number(event.target.value) })}
                />
              </label>

              <div className="caption-setting caption-setting-wide">
                <span>Font color</span>
                <ColorSwatches
                  label="Font color"
                  value={subtitleAppearance.fontColor}
                  onChange={(fontColor) => updateSubtitleAppearance({ fontColor })}
                />
              </div>

              <div className="caption-setting caption-setting-wide">
                <span>Background color</span>
                <ColorSwatches
                  label="Background color"
                  value={subtitleAppearance.backgroundColor}
                  onChange={(backgroundColor) => updateSubtitleAppearance({ backgroundColor })}
                />
              </div>

              <label className="caption-setting caption-setting-wide">
                <span>Background opacity <output>{subtitleAppearance.backgroundOpacity}%</output></span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={25}
                  value={subtitleAppearance.backgroundOpacity}
                  onChange={(event) => updateSubtitleAppearance({ backgroundOpacity: Number(event.target.value) })}
                />
              </label>

              <div className="caption-setting caption-setting-wide">
                <span>Window color</span>
                <ColorSwatches
                  label="Window color"
                  value={subtitleAppearance.windowColor}
                  onChange={(windowColor) => updateSubtitleAppearance({ windowColor })}
                />
              </div>

              <label className="caption-setting">
                <span>Window opacity <output>{subtitleAppearance.windowOpacity}%</output></span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={25}
                  value={subtitleAppearance.windowOpacity}
                  onChange={(event) => updateSubtitleAppearance({ windowOpacity: Number(event.target.value) })}
                />
              </label>

              <label className="caption-setting">
                <span>Character edge</span>
                <select
                  value={subtitleAppearance.edgeStyle}
                  onChange={(event) => updateSubtitleAppearance({ edgeStyle: event.target.value as SubtitleEdge })}
                >
                  {subtitleEdges.map((edge) => (
                    <option key={edge.value} value={edge.value}>{edge.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        )}

        <input
          className="timeline"
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) => seekTo(Number(event.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          aria-label="Seek"
          style={{ "--progress": `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties}
        />

        <div className="control-row">
          <div className="control-cluster">
            <button className="player-icon-button main-play" onClick={togglePlayback} title={session.player.paused ? "Play" : "Pause"} aria-label={session.player.paused ? "Play" : "Pause"}>
              {session.player.paused ? <Play fill="currentColor" /> : <Pause fill="currentColor" />}
            </button>
            <button className="player-icon-button" onClick={toggleMute} title={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"}>
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </button>
            <input
              className="volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(event) => changeVolume(Number(event.target.value))}
              aria-label="Volume"
            />
            <span className="timecode">{formatTime(currentTime)} <i>/</i> {formatTime(duration)}</span>
          </div>

          <div className="control-cluster right">
            <label className="player-select" title="Playback speed">
              <span className="select-rate">{session.player.playbackRate}x</span>
              <select
                value={session.player.playbackRate}
                onChange={(event) => void send({ playbackRate: Number(event.target.value) })}
                aria-label="Playback speed"
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}x</option>)}
              </select>
            </label>

            <label className="player-select" title="Audio language">
              <Headphones />
              <select
                value={audioSelection}
                onChange={(event) => updateTrack("audioLanguage", event.target.value)}
                aria-label="Audio language"
              >
                <option value="original">
                  {defaultAudioTrack
                    ? defaultAudioTrack.label + (defaultAudioTrack.language === "und" ? "" : " (" + defaultAudioTrack.language.toUpperCase() + ")")
                    : "Original audio"}
                </option>
                {audioTracks
                  .filter((track) => track.id !== defaultAudioTrack?.id)
                  .map((track) => (
                    <option key={track.id} value={"embedded:" + track.id}>
                      {track.label}{track.language === "und" ? "" : " (" + track.language.toUpperCase() + ")"}
                    </option>
                  ))}
              </select>
            </label>

            <label className="player-select" title="Subtitles">
              <Subtitles />
              <select
                value={subtitleSelection}
                onChange={(event) => updateTrack("subtitleLanguage", event.target.value)}
                aria-label="Subtitles"
              >
                <option value="off">Off</option>
                <option value="local" disabled={!localSubtitleName}>
                  {localSubtitleName || "Local subtitle file"}
                </option>
                {subtitleTracks.map((track) => (
                  <option key={track.id} value={"embedded:" + track.id} disabled={!track.supported}>
                    {track.label} ({track.language.toUpperCase()})
                  </option>
                ))}
              </select>
            </label>

            <button
              className={"player-icon-button caption-settings-button" + (captionSettingsOpen ? " active" : "")}
              onClick={toggleCaptionSettings}
              title="Caption options"
              aria-label="Caption options"
              aria-expanded={captionSettingsOpen}
            >
              <Settings2 />
            </button>

            {subtitleSelection !== "off" && (
              <div className="offset-control" title="Subtitle timing offset">
                <button onClick={() => updateOffset(-100)} aria-label="Subtitles earlier"><Minus /></button>
                <span>{session.player.subtitleOffset > 0 ? "+" : ""}{session.player.subtitleOffset}ms</span>
                <button onClick={() => updateOffset(100)} aria-label="Subtitles later"><Plus /></button>
              </div>
            )}

            <button className="player-icon-button" onClick={fullscreen} title="Fullscreen" aria-label="Fullscreen">
              <Expand />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
