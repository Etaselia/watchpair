"use client";

import type Hls from "hls.js";
import type { ErrorData } from "hls.js";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Cpu,
  Download,
  Expand,
  FileSearch,
  FileVideo2,
  Headphones,
  Link2,
  ListVideo,
  LoaderCircle,
  Minus,
  MonitorUp,
  PackageOpen,
  Pause,
  Pencil,
  Pin,
  Play,
  Plug,
  Plus,
  Radio,
  RotateCcw,
  Settings2,
  Share2,
  SkipBack,
  Star,
  SkipForward,
  Subtitles,
  Trash2,
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
  acquireAgentSeedLease,
  addAgentDownload,
  attachAgentLibraryFile,
  detectAgent,
  getAgentActivityAge,
  getAgentDownloads,
  getAgentPermissionState,
  getAgentConnectUrl,
  getAgentLibraryPreviewUrl,
  getAgentSubtitle,
  getAgentSubtitleBytes,
  isAgentProtocolVersionError,
  matchAgentLibraryFile,
  pauseAgentDownload,
  reportAgentPlaybackEvent,
  releaseAgentSeedLease,
  resolveAgentSource,
  resumeAgentDownload,
  retryAgentDownload,
  scanAgentLibrary,
  seedAgentLibraryFile,
  selectAgentFile,
  setAgentDownloadPinned,
  setAgentMediaPriority,
  stopAgentDownload,
  uploadAndSeedAgentFile,
  waitForAgentSeed,
  type AgentAudioTrack,
  type AgentChapter,
  type AgentFile,
  type AgentLibraryFile,
  type AgentMediaTarget,
  type AgentPermissionState,
  type AgentPreparation,
  type AgentJob,
  type AgentSubtitleTrack,
} from "../lib/agent-client";
import {
  acquisitionStatus,
  cachedLibraryBindingIsLive,
  isVerifiedLibraryMatch,
  libraryShareIntentKey,
  normalizeAcquisitionPolicy,
  pausableJobIds,
  shouldRetryLibraryMatch,
  shouldAcquireSource,
  transferRefreshIsCurrent,
} from "../lib/acquisition-policy.mjs";
import { opaqueSeedLeaseId } from "../lib/seed-lease.mjs";
import {
  isLibraryPreviewJobId,
  libraryPreviewNeedsHls,
} from "../lib/library-preview.mjs";
import {
  agentJobMatchesSourceIdentity,
  publishedMagnetRoomSourceId,
  sharedSourceIdentity,
} from "../lib/source-identity.mjs";
import { mapWithConcurrency } from "../lib/agent-subtitle-fetch.mjs";
import { VoiceDock, useRoomVoice } from "./room-voice";
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
  agentFileFingerprint,
  findLocalAgentMedia,
  type LocalAgentBinding,
} from "../lib/media-binding.mjs";
import {
  mediaManifest,
  mediaQueue,
  orderedMediaQueue,
} from "../lib/media-queue.mjs";
import {
  hlsAudioPreference,
  resolveHlsAudioChannelCount,
  shouldRetryHlsWithStereo,
  withStereoHlsAudio,
  type HlsAudioMode,
} from "../lib/hls-audio-fallback.mjs";
import {
  clampSeekTarget,
  clampToPreparedRanges,
  isPlaybackAcknowledgement,
  isSeekAcknowledgement,
  shouldHoldLocalPlayback,
  shouldHoldLocalSeek,
  type LocalPlaybackTransaction,
  type LocalSeekTransaction,
} from "../lib/player-seek.mjs";
import {
  activeRecoverySession,
  isRecentStaticAssetRecovery,
  STATIC_ASSET_REJOIN_KEY,
} from "../lib/static-asset-recovery.mjs";
import {
  type LocalReadiness,
  type QueueReadiness,
  type PlayerState,
  type VoicePresence,
  type VoiceSignalType,
  type WatchSession,
} from "../lib/session-types";

const COMPANION_VERSION = "0.12.6"; // x-release-please-version
const EMPTY_AUDIO_TRACKS: AgentAudioTrack[] = [];
const EMPTY_CHAPTERS: AgentChapter[] = [];
const EMPTY_SUBTITLE_TRACKS: AgentSubtitleTrack[] = [];

type AcquisitionPolicy = "automatic" | "ask" | "never";

const emptyReadiness = (): LocalReadiness => ({
  ready: false,
  progress: 0,
  status: "Waiting for media",
  fileName: null,
  fileSize: null,
  fingerprint: null,
  preparation: "waiting",
  queue: {},
  voice: { enabled: false, muted: true, deafened: false },
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
  if (session.selectedMedia.fingerprint && readiness.fingerprint) {
    return (
      session.selectedMedia.fingerprint === readiness.fingerprint &&
      session.selectedMedia.size === readiness.fileSize
    );
  }
  return (
    session.selectedMedia.name === readiness.fileName &&
    session.selectedMedia.size === readiness.fileSize
  );
}

function preferredAgentFile(job: AgentJob, selectedMedia?: WatchSession["selectedMedia"]) {
  const matchingFingerprint = selectedMedia?.fingerprint
    ? job.files.find(
      (file) =>
        agentFileFingerprint(job, file) === selectedMedia.fingerprint &&
        file.size === selectedMedia.size
    )
    : null;
  const selected = selectedMedia?.sourceId === job.id
    ? job.files.find((file) =>
        (selectedMedia.itemId
          ? file.itemId === selectedMedia.itemId
          : (selectedMedia.fileIndex === undefined || file.index === selectedMedia.fileIndex) &&
            file.name === selectedMedia.name &&
            file.size === selectedMedia.size)
      )
    : null;
  return matchingFingerprint
    || selected
    || job.files.find((file) => file.selected)
    || [...job.files].sort(
      (left, right) =>
        Number(/\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(right.name)) -
          Number(/\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(left.name))
        || right.size - left.size
    )[0]
    || null;
}

function queueReadinessForJob(job: AgentJob, file: AgentFile | null): QueueReadiness {
  const preparation = file?.preparation?.status || job.preparation?.status || "waiting";
  if (!file) {
    return {
      ready: false,
      progress: 0,
      status: agentJobIsPaused(job)
        ? "Download paused on this device"
        : job.status === "metadata" ? "Reading torrent metadata" : "Starting download",
      fileName: null,
      fileSize: null,
      fingerprint: null,
      preparation,
    };
  }

  const fingerprint = file.fingerprint === undefined
    ? (file.selected ? job.identityFingerprint : null)
    : file.fingerprint;
  const status = agentJobIsPaused(job)
    ? "Download paused on this device"
    : job.status === "error"
    ? job.error || "Download failed"
    : file.status === "verifying"
      ? "Downloaded — verifying on disk"
      : !file.downloadReady
        ? job.status === "metadata" ? "Reading torrent metadata" : "Downloading locally"
        : !file.ready
          ? "Downloaded — preparing browser copy"
          : !fingerprint
            ? "Verifying file identity"
            : preparation === "error"
              ? file?.preparation.error || job.preparation.error || "Browser preparation failed"
              : preparation === "queued"
                ? "Queued for browser preparation"
                : preparation === "preparing"
                  ? "Preparing initial video buffer"
                  : "Ready to watch";

  return {
    ready: file.ready && Boolean(fingerprint) && (preparation === "ready" || preparation === "direct"),
    progress: file.progress,
    status,
    fileName: file.name,
    fileSize: file.size,
    fingerprint,
    preparation,
  };
}

function preparationSummary(job?: AgentJob, file?: AgentFile | null) {
  if (!job) return { label: "Waiting for download", title: "", hardware: false };
  const preparation = file?.preparation || job.preparation;
  const encoder = preparation.encoder?.label || job.transcoder.label;
  const hardwareDecode = preparation.pipeline?.hardwareDecode ?? preparation.hardwareDecode;
  let label = "Waiting for download";

  switch (preparation.status) {
    case "ready":
      label = preparation.encoder?.hardware
        ? `${encoder} + ${hardwareDecode ? "GPU" : "CPU"} decode`
        : encoder || "Browser ready";
      break;
    case "direct":
      label = "Direct playback";
      break;
    case "preparing":
      label = `Preparing with ${job.transcoder.label}`;
      break;
    case "queued":
      label = "Preparation queued";
      break;
    case "error":
      label = "Preparation failed";
      break;
  }

  const pipeline = preparation.pipeline;
  const stages = pipeline
    ? [pipeline.decode.name, pipeline.filter.name, pipeline.upload.name, pipeline.encode.name]
        .filter((stage, index, values) => stage !== "none" && values.indexOf(stage) === index)
        .join(" -> ")
    : "";
  const diagnostics = (preparation.diagnostics || [])
    .map((diagnostic) => diagnostic.message)
    .filter(Boolean)
    .join(" ");
  return {
    label,
    title: [stages, diagnostics].filter(Boolean).join(" · "),
    hardware: Boolean(
      preparation.encoder?.hardware ||
      (["queued", "preparing"].includes(preparation.status) && job.transcoder.hardware)
    ),
  };
}

function subtitleAvailabilitySummary(job?: AgentJob, file?: AgentFile | null) {
  if (!job || !file?.downloadReady) {
    return { label: "Subtitles inspected after download", title: "", error: false };
  }
  const status = file.subtitleStatus || job.subtitleStatus;
  const assetStatus = file.subtitleAssetStatus || job.subtitleAssetStatus || "waiting";
  const tracks = file.subtitles || job.subtitles || EMPTY_SUBTITLE_TRACKS;
  const supported = tracks.filter((track) => track.supported);
  if (status === "waiting" || status === "probing") {
    return { label: "Detecting subtitle tracks", title: "", error: false };
  }
  if (status === "error") {
    return {
      label: "Subtitle detection failed",
      title: file.subtitleError || job.subtitleError || "",
      error: true,
    };
  }
  if (!tracks.length) {
    return { label: "No embedded subtitles", title: "", error: false };
  }
  if (!supported.length) {
    return {
      label: "Image subtitles unavailable in browser",
      title: "The embedded tracks are image-based rather than browser-renderable text.",
      error: true,
    };
  }
  if (assetStatus === "preparing") {
    return { label: "Preparing embedded subtitles", title: "", error: false };
  }
  if (assetStatus === "error") {
    return {
      label: "Subtitle preparation failed",
      title: file.subtitleAssetError || job.subtitleAssetError || "",
      error: true,
    };
  }
  if (assetStatus === "ready") {
    return { label: "Embedded subtitles ready", title: "", error: false };
  }
  return {
    label: supported.length + " embedded subtitle track" + (supported.length === 1 ? "" : "s"),
    title: "",
    error: false,
  };
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
  originalAssStyling: boolean;
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
  originalAssStyling: true,
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
      originalAssStyling: saved.originalAssStyling !== false,
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
  const [agentUpdateRequired, setAgentUpdateRequired] = useState(false);
  const [agentJobs, setAgentJobs] = useState<Record<string, AgentJob>>({});
  const [verifiedRoomAgentJobs, setVerifiedRoomAgentJobs] = useState<{
    token: string;
    ids: string[];
  }>({ token: "", ids: [] });
  const [localAgentBinding, setLocalAgentBinding] = useState<LocalAgentBinding | null>(null);
  const [acquisitionPolicy, setAcquisitionPolicy] = useState<AcquisitionPolicy>("automatic");
  const [preferLocalCopies, setPreferLocalCopies] = useState(true);
  const [approvedSourceIds, setApprovedSourceIds] = useState<string[]>([]);
  const [libraryFiles, setLibraryFiles] = useState<AgentLibraryFile[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryCatalogStale, setLibraryCatalogStale] = useState(false);
  const [libraryScanWarning, setLibraryScanWarning] = useState("");
  const [selectedLibraryId, setSelectedLibraryId] = useState("");
  const [libraryPreviewUrl, setLibraryPreviewUrl] = useState("");
  const [libraryPreviewBusy, setLibraryPreviewBusy] = useState(false);
  const [connection, setConnection] = useState<"syncing" | "online" | "offline">("syncing");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shareFileInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const readinessRef = useRef(readiness);
  const handledSourceRef = useRef("");
  const mediaUrlRef = useRef("");
  const sessionRef = useRef<WatchSession | null>(null);
  const selectionSentRef = useRef("");
  const filenameSyncedRef = useRef(new Set<string>());
  const manifestSyncedRef = useRef(new Set<string>());
  const loadedSubtitleRef = useRef("");
  const initializedMediaTracksRef = useRef("");
  const autoOpenedMediaRef = useRef("");
  const recoveryJoinAttemptedRef = useRef(false);
  const pairingTimerRef = useRef<number | null>(null);
  const roomSourcesRef = useRef<{ token: string; ids: string[] }>({ token: "", ids: [] });
  const libraryShareIntentsRef = useRef(new Map<string, string>());
  const libraryPreviewJobIdRef = useRef("");
  const libraryPreviewEpochRef = useRef(0);
  const pendingLibrarySharesRef = useRef(new Set<string>());
  const locallySatisfiedSourceIdsRef = useRef(new Set<string>());
  const browserDownloadControllerRef = useRef<AbortController | null>(null);
  const pausingDownloadIdsRef = useRef(new Set<string>());
  const automaticLibraryBindingsRef = useRef(new Map<string, Promise<{
    sourceId: string;
    job: AgentJob;
    file: AgentFile;
  } | null>>());
  const localLibraryBindingJobIdsRef = useRef(new Set<string>());
  const seedLeasesRef = useRef(new Map<string, { leaseId: string; roomToken: string }>());
  const seedLeaseSecretRef = useRef("");
  const seedLeaseTabIdRef = useRef("");
  const sourceIdentityCacheRef = useRef(new Map<string, Promise<string | null>>());
  const sourceIdentityConflictIdsRef = useRef(new Set<string>());
  const automaticLibraryMissesRef = useRef(new Map<string, number>());
  const roomBindingEpochRef = useRef(0);
  const transferPolicyRoomRef = useRef("");
  const localAgentBindingRef = useRef<LocalAgentBinding | null>(null);
  const localFileBindingRef = useRef<{
    fingerprint: string;
    url: string;
    readiness: QueueReadiness;
  } | null>(null);
  const sources = session?.sources?.length ? session.sources : session?.source ? [session.source] : [];
  const activeSource = sources.find((source) => source.id === session?.selectedMedia?.sourceId)
    || sources[0]
    || null;
  const activeSourceId = activeSource?.id || "";
  const activeSourceKind = activeSource?.kind || "";
  const currentRoomSourceIds = new Set(sources.map((source) => source.id));
  const verifiedRoomSourceIds = verifiedRoomAgentJobs.token === roomToken
    ? new Set(verifiedRoomAgentJobs.ids)
    : new Set<string>();
  const playbackEligibleAgentJobs = Object.fromEntries(
    Object.entries(agentJobs).filter(([sourceId]) =>
      (!isLibraryPreviewJobId(sourceId) || currentRoomSourceIds.has(sourceId)) &&
      (!currentRoomSourceIds.has(sourceId) || verifiedRoomSourceIds.has(sourceId))
    )
  );
  const roomAgentJob = (sourceId: string) => verifiedRoomSourceIds.has(sourceId)
    ? agentJobs[sourceId]
    : undefined;
  const localAgentMedia = preferLocalCopies
    ? findLocalAgentMedia(playbackEligibleAgentJobs, session?.selectedMedia, localAgentBinding)
    : null;
  const playbackSourceId = localAgentMedia?.sourceId || activeSourceId;
  const agentJob = localAgentMedia?.job || (activeSource ? roomAgentJob(activeSource.id) || null : null);
  const selectedAgentFile = localAgentMedia?.file
    || (agentJob ? preferredAgentFile(agentJob, session?.selectedMedia) : null);
  const synchronizedMedia = mediaQueue(sources);
  const selectedItemId = session?.selectedMedia?.itemId
    || synchronizedMedia.find((item) =>
      item.sourceId === session?.selectedMedia?.sourceId &&
      item.fileIndex === session?.selectedMedia?.fileIndex
    )?.id
    || null;
  const orderedSynchronizedMedia = orderedMediaQueue(sources, selectedItemId);
  const episodeTargets: AgentMediaTarget[] = orderedSynchronizedMedia.flatMap((item) => {
    const job = roomAgentJob(item.sourceId);
    const file = job?.files.find((candidate) =>
      candidate.index === item.fileIndex &&
      candidate.size === item.size
    );
    return job && file ? [{ jobId: job.id, fileIndex: file.index, itemId: item.id }] : [];
  });
  let selectedTarget = episodeTargets.find((target) => target.itemId === selectedItemId) || null;
  if (localAgentMedia && session?.selectedMedia) {
    selectedTarget = {
      jobId: localAgentMedia.job.id,
      fileIndex: localAgentMedia.file.index,
      itemId: selectedItemId,
    };
    const existingIndex = episodeTargets.findIndex((target) =>
      (Boolean(selectedItemId) && target.itemId === selectedItemId) ||
      (target.jobId === selectedTarget?.jobId &&
        target.fileIndex === selectedTarget.fileIndex)
    );
    if (existingIndex >= 0) episodeTargets.splice(existingIndex, 1);
    episodeTargets.unshift(selectedTarget);
  }
  const priorityPlanKey = JSON.stringify({ selected: selectedTarget, targets: episodeTargets });
  const embeddedAudioTracks = selectedAgentFile?.audioTracks || agentJob?.audioTracks || EMPTY_AUDIO_TRACKS;
  const embeddedChapters = selectedAgentFile?.chapters || agentJob?.chapters || EMPTY_CHAPTERS;
  const embeddedSubtitles = selectedAgentFile?.subtitles || agentJob?.subtitles || EMPTY_SUBTITLE_TRACKS;
  const embeddedSubtitleStatus = selectedAgentFile?.subtitleStatus || agentJob?.subtitleStatus || "waiting";
  const embeddedSubtitleAssetStatus =
    selectedAgentFile?.subtitleAssetStatus || agentJob?.subtitleAssetStatus || "waiting";
  const embeddedSubtitleError = selectedAgentFile?.subtitleError || agentJob?.subtitleError || null;
  const embeddedSubtitleAssetError =
    selectedAgentFile?.subtitleAssetError || agentJob?.subtitleAssetError || null;
  const sourcesKey = sources.map((source) => source.id).join(":");
  const seedSourceIdsKey = sources
    .filter((source) => roomAgentJob(source.id)?.seed)
    .map((source) => source.id)
    .sort()
    .join(":");
  const selectedLibraryFile = libraryFiles.find((file) => file.id === selectedLibraryId) || null;

  useEffect(() => {
    if (!agentAvailable) return;
    const plan = JSON.parse(priorityPlanKey) as {
      selected: AgentMediaTarget | null;
      targets: AgentMediaTarget[];
    };
    void setAgentMediaPriority(plan.selected, plan.targets).catch(() => {});
  }, [agentAvailable, priorityPlanKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      let id = localStorage.getItem("watchpair-device-id");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("watchpair-device-id", id);
      }

      const savedName = localStorage.getItem("watchpair-display-name") || "Guest";
      const policy = normalizeAcquisitionPolicy(
        localStorage.getItem("watchpair-acquisition-policy"),
        localStorage.getItem("watchpair-download-mode")
      ) as AcquisitionPolicy;
      setAcquisitionPolicy(policy);
      localStorage.setItem("watchpair-acquisition-policy", policy);
      setPreferLocalCopies(localStorage.getItem("watchpair-prefer-local-copies") !== "0");
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
    localAgentBindingRef.current = localAgentBinding;
  }, [localAgentBinding]);

  const pauseIncomingJobs = useCallback(async (
    jobs: Record<string, AgentJob>,
    roomSourceIds: string[]
  ) => {
    const jobIds = (pausableJobIds(jobs, roomSourceIds) as string[]).filter(
      (sourceId) => !pausingDownloadIdsRef.current.has(sourceId)
    );
    if (!jobIds.length) return;
    const failures: string[] = [];
    await Promise.all(jobIds.map(async (sourceId) => {
      pausingDownloadIdsRef.current.add(sourceId);
      try {
        const pausedJob = await pauseAgentDownload(sourceId);
        setAgentJobs((current) => {
          const next = { ...current };
          if (pausedJob) next[sourceId] = pausedJob;
          else delete next[sourceId];
          return next;
        });
      } catch {
        failures.push(sourceId);
      } finally {
        pausingDownloadIdsRef.current.delete(sourceId);
      }
    }));
    if (failures.length) {
      setError(`Downloads are disabled, but ${failures.length} active transfer${failures.length === 1 ? "" : "s"} could not be paused.`);
    }
  }, []);

  const releaseSeedLeases = useCallback(async (sourceIds?: Iterable<string>) => {
    const selected = sourceIds ? new Set(sourceIds) : null;
    const releases: Promise<unknown>[] = [];
    for (const [sourceId, lease] of seedLeasesRef.current) {
      if (selected && !selected.has(sourceId)) continue;
      seedLeasesRef.current.delete(sourceId);
      releases.push(releaseAgentSeedLease(sourceId, lease.leaseId).catch(() => null));
    }
    await Promise.all(releases);
  }, []);

  const ensureSeedLease = useCallback(async (
    sourceId: string,
    targetRoomToken: string,
    targetDeviceId: string
  ) => {
    const leaseEpoch = roomBindingEpochRef.current;
    let secret = seedLeaseSecretRef.current;
    if (!secret) {
      try {
        secret = localStorage.getItem("watchpair-seed-lease-secret") || "";
      } catch {
        // A memory-only secret still protects the room token for this page lifetime.
      }
      if (!secret) {
        secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
        try {
          // codeql[js/clear-text-storage-of-sensitive-data]: locally generated per-device pepper used only to derive opaque lease ids; it is never transmitted off the device and holds no user data.
          localStorage.setItem("watchpair-seed-lease-secret", secret);
        } catch {
          // Storage can be unavailable in strict browser privacy modes.
        }
      }
      seedLeaseSecretRef.current = secret;
    }
    let tabId = seedLeaseTabIdRef.current;
    if (!tabId) {
      tabId = crypto.randomUUID();
      seedLeaseTabIdRef.current = tabId;
    }
    const leaseId = await opaqueSeedLeaseId({
      secret,
      tabId,
      roomToken: targetRoomToken,
      deviceId: targetDeviceId,
      sourceId,
    });
    const previous = seedLeasesRef.current.get(sourceId);
    if (previous && previous.leaseId !== leaseId) {
      seedLeasesRef.current.delete(sourceId);
      void releaseAgentSeedLease(sourceId, previous.leaseId).catch(() => {});
    }
    const lease = await acquireAgentSeedLease(sourceId, leaseId);
    if (
      leaseEpoch !== roomBindingEpochRef.current ||
      transferPolicyRoomRef.current !== targetRoomToken
    ) {
      await releaseAgentSeedLease(sourceId, leaseId).catch(() => {});
      throw new Error("The room changed before local sharing was ready.");
    }
    seedLeasesRef.current.set(sourceId, { leaseId, roomToken: targetRoomToken });
    return lease;
  }, []);

  const clearLibraryPreview = useCallback((updateState = true) => {
    libraryPreviewEpochRef.current += 1;
    const previewJobId = libraryPreviewJobIdRef.current;
    libraryPreviewJobIdRef.current = "";
    if (previewJobId) void stopAgentDownload(previewJobId, false).catch(() => {});
    if (!updateState) return;
    setLibraryPreviewUrl("");
    setLibraryPreviewBusy(false);
  }, []);

  const resetRoomTransferState = useCallback((updateState = true) => {
    roomBindingEpochRef.current += 1;
    void releaseSeedLeases();
    clearLibraryPreview(updateState);
    browserDownloadControllerRef.current?.abort();
    browserDownloadControllerRef.current = null;
    handledSourceRef.current = "";
    locallySatisfiedSourceIdsRef.current.clear();
    automaticLibraryBindingsRef.current.clear();
    automaticLibraryMissesRef.current.clear();
    sourceIdentityCacheRef.current.clear();
    sourceIdentityConflictIdsRef.current.clear();
    setVerifiedRoomAgentJobs({ token: "", ids: [] });
    const localJobIds = [...localLibraryBindingJobIdsRef.current];
    localLibraryBindingJobIdsRef.current.clear();
    for (const sourceId of localJobIds) {
      void stopAgentDownload(sourceId, false).catch(() => {});
    }
    localFileBindingRef.current = null;
    if (mediaUrlRef.current.startsWith("blob:")) URL.revokeObjectURL(mediaUrlRef.current);
    if (!updateState) return;
    setApprovedSourceIds([]);
    localAgentBindingRef.current = null;
    setLocalAgentBinding(null);
    setMediaUrl("");
    setAgentJobs({});
  }, [clearLibraryPreview, releaseSeedLeases]);

  useEffect(() => {
    const nextRoom = joined ? roomToken : "";
    const previousRoom = transferPolicyRoomRef.current;
    if (previousRoom && previousRoom !== nextRoom) resetRoomTransferState();
    transferPolicyRoomRef.current = nextRoom;
  }, [joined, resetRoomTransferState, roomToken]);

  useEffect(() => () => resetRoomTransferState(false), [resetRoomTransferState]);

  useEffect(() => {
    if (!agentAvailable || acquisitionPolicy !== "never") return;
    void pauseIncomingJobs(agentJobs, sourcesKey ? sourcesKey.split(":") : []);
  }, [acquisitionPolicy, agentAvailable, agentJobs, pauseIncomingJobs, sourcesKey]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!joined || !roomToken) return;
    const currentIds = sourcesKey ? sourcesKey.split(":") : [];
    const previous = roomSourcesRef.current;
    if (previous.token === roomToken) {
      const current = new Set(currentIds);
      for (const removedId of previous.ids.filter((id) => !current.has(id))) {
        void releaseSeedLeases([removedId]);
        setAgentJobs((jobs) => {
          const next = { ...jobs };
          delete next[removedId];
          return next;
        });
      }
    }
    roomSourcesRef.current = { token: roomToken, ids: currentIds };
  }, [joined, releaseSeedLeases, roomToken, sourcesKey]);

  useEffect(() => {
    if (!joined || !agentAvailable || !roomToken || !deviceId || !seedSourceIdsKey) return;
    let active = true;
    let timer: number | null = null;
    const renew = async () => {
      const sourceIds = seedSourceIdsKey.split(":").filter(Boolean);
      await Promise.all(sourceIds.map((sourceId) =>
        ensureSeedLease(sourceId, roomToken, deviceId).catch(() => null)
      ));
      if (active) timer = window.setTimeout(() => void renew(), 30_000);
    };
    void renew();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [agentAvailable, deviceId, ensureSeedLease, joined, roomToken, seedSourceIdsKey]);

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
    let missedChecks = 0;
    const keepAlive = async () => {
      const startedAt = Date.now();
      try {
        const available = await detectAgent();
        if (!active) return;
        const recoveredChecks = missedChecks;
        failures = 0;
        missedChecks = 0;
        setAgentAvailable(available);
        setAgentUpdateRequired(false);
        if (available && recoveredChecks) {
          void reportAgentPlaybackEvent({
            event: "companion_health_recovered",
            level: "warn",
            consecutiveFailures: recoveredChecks,
            healthCheckDurationMs: Date.now() - startedAt,
            recentActivityAgeMs: getAgentActivityAge(),
            userAgent: navigator.userAgent,
          });
        }
      } catch (caught) {
        if (!active) return;
        if (isAgentProtocolVersionError(caught)) {
          failures = 0;
          setAgentAvailable(false);
          setAgentUpdateRequired(true);
          return;
        }
        missedChecks += 1;
        const recentActivityAgeMs = getAgentActivityAge();
        if (recentActivityAgeMs <= 20_000) {
          failures = 0;
          setAgentAvailable(true);
          return;
        }
        failures += 1;
        if (failures >= 4) {
          setAgentAvailable(false);
          console.warn("WatchPair companion health checks failed", {
            failures,
            recentActivityAgeMs,
            error: caught instanceof Error ? caught.message : String(caught),
          });
        }
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
    setAgentPairing(true);
    setError("");

    try {
      if (await detectAgent()) {
        setAgentAvailable(true);
        setAgentPermission("granted");
        setAgentPairing(false);
        return;
      }
    } catch (caught) {
      if (isAgentProtocolVersionError(caught)) {
        setAgentAvailable(false);
        setAgentUpdateRequired(true);
        setAgentPairing(false);
        setError(caught.message);
        return;
      }
      // Launching the native app below also starts its local agent.
    }

    const launcher = document.createElement("a");
    launcher.href = getAgentConnectUrl();
    launcher.style.display = "none";
    document.body.appendChild(launcher);
    launcher.click();
    launcher.remove();

    let attempts = 0;
    if (pairingTimerRef.current !== null) window.clearInterval(pairingTimerRef.current);
    pairingTimerRef.current = window.setInterval(() => {
      attempts += 1;
      void detectAgent()
        .then((available) => {
          if (!available) return;
          setAgentAvailable(true);
          setAgentUpdateRequired(false);
          setAgentPermission("granted");
          setAgentPairing(false);
          if (pairingTimerRef.current !== null) window.clearInterval(pairingTimerRef.current);
          pairingTimerRef.current = null;
        })
        .catch((caught) => {
          if (isAgentProtocolVersionError(caught)) {
            setAgentAvailable(false);
            setAgentUpdateRequired(true);
            setAgentPairing(false);
            setError(caught.message);
            if (pairingTimerRef.current !== null) window.clearInterval(pairingTimerRef.current);
            pairingTimerRef.current = null;
            return;
          }
          if (attempts < 120) return;
          setAgentPairing(false);
          setError("The companion did not answer. Install or open the WatchPair Companion app, then connect again.");
          if (pairingTimerRef.current !== null) window.clearInterval(pairingTimerRef.current);
          pairingTimerRef.current = null;
        });
    }, 500);
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
    // A coordinator restart can restore a seq lower than the client's in-memory
    // value (the session snapshot is written on a ~1s debounce, so a force-killed
    // process may lose the last bump). Accept such a session when the server
    // clock has advanced, so the client never permanently ignores the
    // coordinator's state after a restart.
    const older =
      current?.token === nextSession.token &&
      ((nextSession.seq < current.seq && nextSession.serverTime <= current.serverTime) ||
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
    const requestedToken = normalizeToken(tokenInput || roomToken);
    setBusy("create");
    setError("");
    try {
      localStorage.setItem("watchpair-display-name", displayName.trim() || "Guest");
      const nextSession = await sessionRequest({
        action: "create",
        token: requestedToken.length === 9 ? requestedToken : undefined,
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

  useEffect(() => {
    if (!deviceId || joined || recoveryJoinAttemptedRef.current) return;

    let shouldRejoin = false;
    try {
      shouldRejoin = isRecentStaticAssetRecovery(
        sessionStorage.getItem(STATIC_ASSET_REJOIN_KEY),
      );
    } catch {
      return;
    }
    if (!shouldRejoin) return;

    const token = normalizeToken(new URLSearchParams(window.location.search).get("room") || "");
    if (token.length !== 9) {
      sessionStorage.removeItem(STATIC_ASSET_REJOIN_KEY);
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || recoveryJoinAttemptedRef.current) return;
      recoveryJoinAttemptedRef.current = true;
      sessionStorage.removeItem(STATIC_ASSET_REJOIN_KEY);
      void fetch(
        `/api/sessions?token=${encodeURIComponent(token)}&deviceId=${encodeURIComponent(deviceId)}`,
        { cache: "no-store" },
      ).then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as { session?: WatchSession };
        return activeRecoverySession(data.session, deviceId) as WatchSession | null;
      }).then((recoveredSession) => {
        if (!cancelled && recoveredSession) enterSession(recoveredSession);
      }).catch(() => {
        // Recovery is best-effort; leave an inactive or unreachable invite in the lobby.
      });
    });

    return () => {
      cancelled = true;
    };
  }, [deviceId, enterSession, joined]);

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
    let timer: number | null = null;
    let refreshing = false;
    const interval = () => document.hidden ? 5_000 : 1_000;
    const schedule = () => {
      if (!active) return;
      timer = window.setTimeout(() => void refresh(), interval());
    };
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const response = await fetch(
          `/api/sessions?token=${encodeURIComponent(roomToken)}&deviceId=${encodeURIComponent(deviceId)}`,
          {
            cache: "no-store",
          }
        );
        const data = (await response.json()) as { session?: WatchSession };
        if (active && response.ok && data.session) {
          applySession(data.session);
          setConnection("online");
        } else if (active) {
          setConnection("offline");
        }
      } catch {
        if (active) setConnection("offline");
      } finally {
        refreshing = false;
        schedule();
      }
    };
    const onVisibilityChange = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (!document.hidden) void refresh();
      else schedule();
    };

    void refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [applySession, deviceId, joined, roomToken]);

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

  const publishVoicePresence = useCallback((voicePresence: VoicePresence) => {
    const next = { ...readinessRef.current, voice: voicePresence };
    readinessRef.current = next;
    setReadiness(next);
    if (!joined || !roomToken || !deviceId) return;
    void sessionRequest({
      action: "heartbeat",
      token: roomToken,
      deviceId,
      name: displayName,
      readiness: next,
    })
      .then((nextSession) => {
        applySession(nextSession);
        setConnection("online");
      })
      .catch(() => setConnection("offline"));
  }, [applySession, deviceId, displayName, joined, roomToken]);

  const sendVoiceSignal = useCallback(
    async (toId: string, type: VoiceSignalType, data: string) => {
      await sendAction("voice-signal", {
        signal: { toId, type, data },
      });
    },
    [sendAction]
  );

  const voice = useRoomVoice({
    session,
    deviceId,
    onSignal: sendVoiceSignal,
    onPresence: publishVoicePresence,
  });

  const attachLocalFile = useCallback(
    async (file: File, preferredName = file.name, sourceId?: string) => {
      setBusy("file");
      setError("");
      try {
        const playableFile =
          preferredName === file.name ? file : new File([file], preferredName, { type: file.type });
        const fingerprint = await fingerprintFile(playableFile);
        const url = URL.createObjectURL(playableFile);
        if (mediaUrlRef.current.startsWith("blob:")) URL.revokeObjectURL(mediaUrlRef.current);
        setMediaUrl(url);

        const itemReadiness: QueueReadiness = {
          ready: true,
          progress: 100,
          status: "Ready to watch",
          fileName: preferredName,
          fileSize: playableFile.size,
          fingerprint,
          preparation: "direct",
        };
        const currentMedia = sessionRef.current?.selectedMedia;
        const matchesCurrent = currentMedia?.fingerprint === fingerprint;
        const logicalSourceId = matchesCurrent ? currentMedia.sourceId : sourceId;
        const nextReadiness: LocalReadiness = {
          ...itemReadiness,
          voice: readinessRef.current.voice,
          queue: logicalSourceId
            ? { ...readinessRef.current.queue, [logicalSourceId]: itemReadiness }
            : readinessRef.current.queue,
        };
        localFileBindingRef.current = { fingerprint, url, readiness: itemReadiness };
        localAgentBindingRef.current = null;
        setLocalAgentBinding(null);
        setReadiness(nextReadiness);
        readinessRef.current = nextReadiness;
        if (!matchesCurrent) {
          await sendAction("select-media", {
            media: {
              sourceId,
              itemId: `${sourceId}-f0`,
              fileIndex: 0,
              name: preferredName,
              size: playableFile.size,
              fingerprint,
            },
          });
        }
        await sendAction("heartbeat", { readiness: nextReadiness });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not prepare that file.");
      } finally {
        setBusy(null);
      }
    },
    [sendAction]
  );

  const publishLocalFile = useCallback(
    async (file: File) => {
      const sourceId = crypto.randomUUID();
      let sourceAddedToRoom = false;
      let leaseAcquired = false;
      setBusy("file");
      setError("");
      try {
        const updateProgress = (progress: number) => {
          const importing = progress < 100;
          const creatingProgress = progress > 100 ? progress - 100 : 0;
          const visibleProgress = importing ? progress : creatingProgress;
          const next: LocalReadiness = {
            ...readinessRef.current,
            ready: false,
            progress: visibleProgress,
            status: importing
              ? "Importing into companion"
              : `Creating torrent${progress > 100 ? ` ${Math.round(creatingProgress)}%` : ""}`,
            fileName: file.name,
            fileSize: file.size,
            fingerprint: null,
            preparation: "waiting",
          };
          readinessRef.current = next;
          setReadiness(next);
        };
        updateProgress(0);
        const published = await uploadAndSeedAgentFile(sourceId, file, updateProgress);
        const job = published.job;
        const target = preferredAgentFile(job);
        if (!target || !job.infoHash) throw new Error("The companion did not publish the selected video.");
        if (!roomToken || !deviceId) throw new Error("Join the room before sharing a local video.");
        await ensureSeedLease(sourceId, roomToken, deviceId);
        leaseAcquired = true;

        const publishedSession = await sendAction("source", {
          source: {
            id: sourceId,
            kind: "magnet",
            value: published.magnetURI,
            label: file.name,
          },
        });
        const retainedSourceId = publishedMagnetRoomSourceId(
          publishedSession.sources,
          sourceId,
          published.magnetURI
        );
        if (!retainedSourceId) {
          throw new Error("The room did not retain the published video.");
        }
        if (retainedSourceId !== sourceId) {
          await releaseSeedLeases([sourceId]);
          leaseAcquired = false;
          await stopAgentDownload(sourceId, true).catch(() => {});
          setAgentJobs((current) => {
            const next = { ...current };
            delete next[sourceId];
            return next;
          });
          setError("That video is already in the room, so the existing queue item was kept.");
          return;
        }
        sourceAddedToRoom = true;
        setAgentJobs((current) => ({ ...current, [sourceId]: job }));

        const item = queueReadinessForJob(job, target);
        const currentMedia = sessionRef.current?.selectedMedia;
        const matchesCurrent = Boolean(
          item.fingerprint && currentMedia?.fingerprint === item.fingerprint
        );
        const logicalSourceId = matchesCurrent ? currentMedia?.sourceId : sourceId;
        const nextQueue = { ...readinessRef.current.queue, [sourceId]: item };
        if (logicalSourceId) nextQueue[logicalSourceId] = item;
        const next: LocalReadiness = {
          ...item,
          voice: readinessRef.current.voice,
          queue: nextQueue,
        };
        const nextLocalAgentBinding = item.fingerprint ? {
          sourceId,
          fileIndex: target.index,
          fingerprint: item.fingerprint,
        } : null;
        localAgentBindingRef.current = nextLocalAgentBinding;
        setLocalAgentBinding(nextLocalAgentBinding);
        localFileBindingRef.current = null;
        readinessRef.current = next;
        setReadiness(next);
        setMediaUrl(item.ready ? target.hlsUrl || target.streamUrl : "");
        if (!matchesCurrent) {
          await sendAction("select-media", {
            media: {
              sourceId,
              itemId: target.itemId || `${sourceId}-f${target.index}`,
              fileIndex: target.index,
              name: target.name,
              size: target.size,
              fingerprint: item.fingerprint,
            },
          });
        }
        await sendAction("heartbeat", { readiness: next });
      } catch (caught) {
        if (leaseAcquired && !sourceAddedToRoom) await releaseSeedLeases([sourceId]);
        if (!sourceAddedToRoom) await stopAgentDownload(sourceId, true).catch(() => {});
        setError(caught instanceof Error ? caught.message : "Could not share that local video.");
      } finally {
        setBusy(null);
      }
    },
    [deviceId, ensureSeedLease, releaseSeedLeases, roomToken, sendAction]
  );

  const onChooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!activeSource?.id) {
      setError("There is no room item to match. Use Share a local file to add this video to the room.");
      return;
    }
    await attachLocalFile(file, file.name, activeSource.id);
  };

  const onShareFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!agentAvailable) {
      setError("Connect the companion before sharing a local file.");
      return;
    }
    if (!window.confirm(
      "Add this file to the room and share it using BitTorrent? Other participants may see this device's IP address."
    )) return;
    await publishLocalFile(file);
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add that source.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const browserDownloadEnabled = shouldAcquireSource(
      acquisitionPolicy,
      activeSourceId,
      approvedSourceIds
    );
    if (!joined || agentAvailable || !browserDownloadEnabled || activeSourceKind !== "direct" || !activeSourceId) return;
    if (handledSourceRef.current === activeSourceId) return;

    const currentSession = sessionRef.current;
    const source = currentSession?.sources?.find((item) => item.id === activeSourceId)
      || (currentSession?.source?.id === activeSourceId ? currentSession.source : null);
    if (!source) return;
    handledSourceRef.current = source.id;
    const controller = new AbortController();
    browserDownloadControllerRef.current?.abort();
    browserDownloadControllerRef.current = controller;
    const updateItem = (item: QueueReadiness) => {
      const next: LocalReadiness = {
        ...item,
        voice: readinessRef.current.voice,
        queue: { ...readinessRef.current.queue, [source.id]: item },
      };
      readinessRef.current = next;
      setReadiness(next);
    };
    updateItem({
      ready: false,
      progress: 0,
      status: "Starting browser download",
      fileName: null,
      fileSize: null,
      fingerprint: null,
      preparation: "waiting",
    });
    setBusy("download");

    void downloadDirectFile(
      source,
      (progress) => updateItem({
        ready: false,
        progress: Math.round(progress),
        status: progress >= 100 ? "Verifying file" : "Downloading in this browser",
        fileName: source.label,
        fileSize: null,
        fingerprint: null,
        preparation: "waiting",
      }),
      controller.signal
    )
      .then((file) => {
        if (!controller.signal.aborted) return attachLocalFile(file, source.label, source.id);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        handledSourceRef.current = "";
        updateItem({
          ready: false,
          progress: 0,
          status: "Choose the downloaded file",
          fileName: null,
          fileSize: null,
          fingerprint: null,
          preparation: "waiting",
        });
        setError(
          caught instanceof Error
            ? `Automatic download was blocked. Choose the local file when it is ready. ${caught.message}`
            : "Automatic download was blocked. Choose the local file when it is ready."
        );
      })
      .finally(() => {
        if (browserDownloadControllerRef.current === controller) {
          browserDownloadControllerRef.current = null;
        }
        setBusy(null);
      });

    return () => {
      controller.abort();
      if (browserDownloadControllerRef.current === controller) {
        browserDownloadControllerRef.current = null;
      }
    };
  }, [activeSourceId, activeSourceKind, acquisitionPolicy, agentAvailable, approvedSourceIds, attachLocalFile, joined]);

  useEffect(() => {
    // The queue rebuild and readiness publish must not depend on the
    // permissions/keep-alive pipeline: after a reload or rejoin the companion
    // job list is the only source that can restore per-video readiness, and the
    // keep-alive loop (gated on agentPermission) may never open on some
    // networks. Poll optimistically; getAgentDownloads() fails fast when the
    // companion is genuinely unreachable.
    if (!joined || !sourcesKey) return;

    let active = true;
    let refreshRunning = false;
    const pendingBindingKeys = new Set<string>();
    const automaticLibraryBindings = automaticLibraryBindingsRef.current;
    const performRefresh = async () => {
      const roomBindingEpoch = roomBindingEpochRef.current;
      const refreshIsCurrent = () => transferRefreshIsCurrent(
        active,
        roomBindingEpoch,
        roomBindingEpochRef.current
      );
      const currentSession = sessionRef.current;
      const queueSources = currentSession?.sources?.length
        ? currentSession.sources
        : currentSession?.source ? [currentSession.source] : [];
      if (!queueSources.length) return;

      let localJobs: AgentJob[];
      try {
        localJobs = await getAgentDownloads();
      } catch {
        return;
      }
      if (!refreshIsCurrent()) return;
      const expectedIdentityEntries = await Promise.all(queueSources.map(async (source) => {
        const cacheKey = `${source.kind}\u0000${source.value}`;
        let pendingIdentity = sourceIdentityCacheRef.current.get(cacheKey);
        if (!pendingIdentity) {
          pendingIdentity = sharedSourceIdentity(source.kind, source.value);
          sourceIdentityCacheRef.current.set(cacheKey, pendingIdentity);
        }
        try {
          return [source.id, await pendingIdentity] as const;
        } catch {
          if (sourceIdentityCacheRef.current.get(cacheKey) === pendingIdentity) {
            sourceIdentityCacheRef.current.delete(cacheKey);
          }
          return [source.id, null] as const;
        }
      }));
      if (!refreshIsCurrent()) return;
      const expectedSourceIdentities = new Map(expectedIdentityEntries);
      const compatibleJobs = localJobs.filter((job) => {
        if (!expectedSourceIdentities.has(job.id)) return !isLibraryPreviewJobId(job.id);
        return agentJobMatchesSourceIdentity(job, expectedSourceIdentities.get(job.id));
      });
      const existingById = new Map(compatibleJobs.map((job) => [job.id, job]));
      const allJobsById = Object.fromEntries(compatibleJobs.map((job) => [job.id, job]));
      for (const source of queueSources) {
        if (existingById.has(source.id)) sourceIdentityConflictIdsRef.current.delete(source.id);
      }
      let selectedMediaForLibrary = currentSession?.selectedMedia;
      let automaticLocalBinding: LocalAgentBinding | null = null;
      const selectedSourceId = selectedMediaForLibrary?.sourceId;
      const selectedRoomSource = selectedSourceId
        ? queueSources.find((source) => source.id === selectedSourceId) || null
        : null;
      const selectedRoomItemForMatch = selectedRoomSource?.mediaItems?.find((item) =>
        (selectedMediaForLibrary?.itemId ? item.id === selectedMediaForLibrary.itemId : true) &&
        (selectedMediaForLibrary?.fileIndex === undefined || item.fileIndex === selectedMediaForLibrary.fileIndex)
      ) || null;
      const automaticMatchKey = selectedMediaForLibrary && selectedSourceId
        ? JSON.stringify({
          sourceId: selectedSourceId,
          fingerprint: selectedMediaForLibrary.fingerprint || null,
          infoHash: selectedRoomSource?.infoHash || existingById.get(selectedSourceId)?.infoHash || null,
          size: selectedMediaForLibrary.size,
          fileIndex: selectedMediaForLibrary.fileIndex ?? selectedRoomItemForMatch?.fileIndex ?? null,
          path: selectedRoomItemForMatch?.path || null,
          itemId: selectedMediaForLibrary.itemId || null,
        })
        : "";
      const mayRetryAutomaticMatch = shouldRetryLibraryMatch(
        automaticLibraryMissesRef.current.get(automaticMatchKey)
      );
      if (
        preferLocalCopies &&
        selectedMediaForLibrary &&
        selectedSourceId &&
        automaticMatchKey &&
        mayRetryAutomaticMatch
      ) {
        let pendingBinding = automaticLibraryBindingsRef.current.get(automaticMatchKey);
        if (!pendingBinding) {
          pendingBinding = createVerifiedLibraryBinding(
            selectedMediaForLibrary,
            selectedRoomSource,
            existingById.get(selectedSourceId)
          );
          automaticLibraryBindingsRef.current.set(automaticMatchKey, pendingBinding);
          pendingBindingKeys.add(automaticMatchKey);
        }
        try {
          const binding = await pendingBinding;
          if (!binding) {
            if (automaticLibraryBindingsRef.current.get(automaticMatchKey) === pendingBinding) {
              automaticLibraryBindingsRef.current.delete(automaticMatchKey);
            }
            pendingBindingKeys.delete(automaticMatchKey);
            if (refreshIsCurrent()) {
              automaticLibraryMissesRef.current.set(automaticMatchKey, Date.now());
            }
          } else {
            const ownsPendingBinding = pendingBindingKeys.has(automaticMatchKey);
            if (!refreshIsCurrent()) {
              if (ownsPendingBinding) {
                if (automaticLibraryBindingsRef.current.get(automaticMatchKey) === pendingBinding) {
                  automaticLibraryBindingsRef.current.delete(automaticMatchKey);
                }
                pendingBindingKeys.delete(automaticMatchKey);
                await stopAgentDownload(binding.sourceId, false).catch(() => {});
              }
              return;
            }
            if (!cachedLibraryBindingIsLive(
              ownsPendingBinding,
              binding.sourceId,
              existingById.keys()
            )) {
              if (automaticLibraryBindingsRef.current.get(automaticMatchKey) === pendingBinding) {
                automaticLibraryBindingsRef.current.delete(automaticMatchKey);
              }
              localLibraryBindingJobIdsRef.current.delete(binding.sourceId);
              locallySatisfiedSourceIdsRef.current.delete(selectedSourceId);
              if (localAgentBindingRef.current?.sourceId === binding.sourceId) {
                localAgentBindingRef.current = null;
                setLocalAgentBinding(null);
                if (mediaUrlRef.current.startsWith(AGENT_URL)) setMediaUrl("");
              }
              return;
            }
            const liveBindingJob = existingById.get(binding.sourceId) || binding.job;
            const liveBindingFile = liveBindingJob.files.find((file) => file.index === binding.file.index)
              || binding.file;
            const fingerprint = agentFileFingerprint(liveBindingJob, liveBindingFile) as string;
            automaticLocalBinding = {
              sourceId: binding.sourceId,
              fileIndex: liveBindingFile.index,
              fingerprint,
            };
            const canonicalJob = existingById.get(selectedSourceId);
            if (canonicalJob && !canonicalJob.seed && !agentJobIsPaused(canonicalJob) && (
              canonicalJob.status === "queued" ||
              canonicalJob.status === "metadata" ||
              canonicalJob.status === "downloading"
            )) {
              const pausedJob = await pauseAgentDownload(selectedSourceId);
              if (pausedJob) {
                existingById.set(selectedSourceId, pausedJob);
                allJobsById[selectedSourceId] = pausedJob;
              } else {
                existingById.delete(selectedSourceId);
                delete allJobsById[selectedSourceId];
              }
            }
            if (!refreshIsCurrent()) {
              if (ownsPendingBinding) {
                if (automaticLibraryBindingsRef.current.get(automaticMatchKey) === pendingBinding) {
                  automaticLibraryBindingsRef.current.delete(automaticMatchKey);
                }
                pendingBindingKeys.delete(automaticMatchKey);
                await stopAgentDownload(binding.sourceId, false).catch(() => {});
              }
              return;
            }
            pendingBindingKeys.delete(automaticMatchKey);
            automaticLibraryMissesRef.current.delete(automaticMatchKey);
            localLibraryBindingJobIdsRef.current.add(binding.sourceId);
            existingById.set(binding.sourceId, liveBindingJob);
            allJobsById[binding.sourceId] = liveBindingJob;
            locallySatisfiedSourceIdsRef.current.add(selectedSourceId);
            const currentLocalBinding = localAgentBindingRef.current;
            if (
              currentLocalBinding?.sourceId !== automaticLocalBinding.sourceId ||
              currentLocalBinding.fileIndex !== automaticLocalBinding.fileIndex ||
              currentLocalBinding.fingerprint !== automaticLocalBinding.fingerprint
            ) {
              localAgentBindingRef.current = automaticLocalBinding;
              setLocalAgentBinding(automaticLocalBinding);
            }
            if (activeSourceId === selectedSourceId) {
              browserDownloadControllerRef.current?.abort();
              browserDownloadControllerRef.current = null;
            }
            if (!selectedMediaForLibrary.fingerprint) {
              selectedMediaForLibrary = { ...selectedMediaForLibrary, fingerprint };
              try {
                await sendAction("select-media", { media: selectedMediaForLibrary });
              } catch {
                // The next companion refresh retries publishing verified identity.
              }
            }
          }
        } catch {
          if (automaticLibraryBindingsRef.current.get(automaticMatchKey) === pendingBinding) {
            automaticLibraryBindingsRef.current.delete(automaticMatchKey);
          }
          pendingBindingKeys.delete(automaticMatchKey);
          if (refreshIsCurrent()) {
            automaticLibraryMissesRef.current.set(automaticMatchKey, Date.now());
          }
        }
      }
      if (!refreshIsCurrent()) return;
      const preferredLocalMatch = preferLocalCopies
        ? findLocalAgentMedia(
          allJobsById,
          selectedMediaForLibrary,
          automaticLocalBinding || localAgentBindingRef.current
        )
        : null;
      const canStart = (sourceId: string) =>
        !locallySatisfiedSourceIdsRef.current.has(sourceId) &&
        shouldAcquireSource(acquisitionPolicy, sourceId, approvedSourceIds);
      const usesVerifiedLocalCopy = (sourceId: string) => Boolean(
        preferredLocalMatch &&
        preferredLocalMatch.sourceId !== sourceId &&
        selectedMediaForLibrary?.sourceId === sourceId
      );
      const resumed = await Promise.all(
        queueSources
          .filter((source) => {
            const job = existingById.get(source.id);
            return Boolean(job && agentJobIsPaused(job) && canStart(source.id));
          })
          .map(async (source) => {
            if (!refreshIsCurrent()) return null;
            try {
              return await resumeAgentDownload(source.id);
            } catch {
              return null;
            }
          })
      );
      for (const job of resumed) {
        if (job) existingById.set(job.id, job);
      }
      if (!refreshIsCurrent()) return;
      const started = await Promise.all(
        queueSources
          .filter(
            (source) =>
              !existingById.has(source.id) &&
              canStart(source.id) &&
              !usesVerifiedLocalCopy(source.id)
          )
          .map(async (source) => {
            if (!refreshIsCurrent()) return null;
            try {
              const job = await addAgentDownload(source);
              if (!refreshIsCurrent()) return null;
              const expectedIdentity = expectedSourceIdentities.get(source.id);
              if (!agentJobMatchesSourceIdentity(job, expectedIdentity)) {
                throw new Error("The companion returned a different source identity.");
              }
              sourceIdentityConflictIdsRef.current.delete(source.id);
              return job;
            } catch (caught) {
              if (
                refreshIsCurrent() &&
                caught instanceof Error &&
                /(?:source id.*different|bound to different|different source identity)/i.test(caught.message) &&
                !sourceIdentityConflictIdsRef.current.has(source.id)
              ) {
                sourceIdentityConflictIdsRef.current.add(source.id);
                setError(
                  "This device already has different media under the same source ID. Pause or remove the conflicting Companion transfer, then retry."
                );
              }
              return null;
            }
          })
      );
      for (const job of started) {
        if (job) existingById.set(job.id, job);
      }
      if (!refreshIsCurrent()) return;

      const jobsById: Record<string, AgentJob> = preferLocalCopies ? { ...allJobsById } : {};
      for (const source of queueSources) {
        const job = existingById.get(source.id);
        if (job) jobsById[source.id] = job;
      }
      const verifiedIds = queueSources
        .filter((source) => existingById.has(source.id))
        .map((source) => source.id);
      const verifiedToken = currentSession?.token || "";
      setVerifiedRoomAgentJobs((current) =>
        current.token === verifiedToken &&
        current.ids.length === verifiedIds.length &&
        current.ids.every((sourceId, index) => sourceId === verifiedIds[index])
          ? current
          : { token: verifiedToken, ids: verifiedIds }
      );
      setAgentJobs((current) => {
        const next = { ...current, ...jobsById };
        for (const sourceId of Object.keys(next)) {
          if (isLibraryPreviewJobId(sourceId) && !expectedSourceIdentities.has(sourceId)) {
            delete next[sourceId];
          }
        }
        for (const source of queueSources) {
          if (!jobsById[source.id]) delete next[source.id];
        }
        return next;
      });

      for (const source of queueSources) {
        if (!refreshIsCurrent()) return;
        const job = jobsById[source.id];
        if (!job || source.mediaItems?.length) continue;
        const manifest = mediaManifest(job.files, source.id);
        if (!manifest.length) continue;
        const manifestKey = JSON.stringify({
          sourceId: source.id,
          infoHash: job.infoHash,
          files: manifest.map((item) => [item.fileIndex, item.path, item.size]),
        });
        if (manifestSyncedRef.current.has(manifestKey)) continue;
        manifestSyncedRef.current.add(manifestKey);
        try {
          await sendAction("source-manifest", {
            sourceId: source.id,
            infoHash: job.infoHash,
            mediaItems: manifest,
          });
          if (!refreshIsCurrent()) return;
        } catch {
          manifestSyncedRef.current.delete(manifestKey);
        }
      }

      for (const source of queueSources) {
        if (!refreshIsCurrent()) return;
        const job = jobsById[source.id];
        const videoFiles = job ? mediaManifest(job.files, source.id) : [];
        if (videoFiles.length !== 1) continue;
        const target = job ? preferredAgentFile(job) : null;
        const renameKey = target ? `${source.id}:${target.name}` : "";
        if (!target?.name || source.label === target.name || filenameSyncedRef.current.has(renameKey)) {
          continue;
        }
        filenameSyncedRef.current.add(renameKey);
        try {
          await sendAction("rename-source", { sourceId: source.id, label: target.name });
          if (!refreshIsCurrent()) return;
        } catch {
          filenameSyncedRef.current.delete(renameKey);
        }
      }

      let selectedMedia = currentSession?.selectedMedia || null;
      if (selectedMedia?.sourceId) {
        const selectedJob = jobsById[selectedMedia.sourceId];
        let selectedFile = selectedJob ? preferredAgentFile(selectedJob, selectedMedia) : null;
        if (selectedJob?.kind === "magnet" && selectedFile && !selectedFile.selected) {
          try {
            const updated = await selectAgentFile(selectedJob.id, selectedFile.index);
            if (!refreshIsCurrent()) return;
            jobsById[selectedJob.id] = updated;
            selectedFile = preferredAgentFile(updated, selectedMedia);
            setAgentJobs((current) => ({ ...current, [updated.id]: updated }));
          } catch {
            // The next poll retries a transient companion selection failure.
          }
        }
      }

      if (!selectedMedia && !sessionRef.current?.selectedMedia) {
        for (const source of queueSources) {
          if (!refreshIsCurrent()) return;
          // A user (or another client) may have selected media while this tick
          // was fetching and verifying jobs; never override it with the
          // auto-select, otherwise a fresh selection gets reverted ~1s later.
          if (sessionRef.current?.selectedMedia) return;
          const job = jobsById[source.id];
          const target = job ? preferredAgentFile(job) : null;
          if (!job || !target) continue;
          const selectionKey = `${source.id}:${target.index}`;
          if (selectionSentRef.current === selectionKey) break;
          selectionSentRef.current = selectionKey;
          try {
            const nextSession = await sendAction("select-media", {
              media: {
                sourceId: source.id,
                itemId: target.itemId || `${source.id}-f${target.index}`,
                fileIndex: target.index,
                name: target.name,
                size: target.size,
                fingerprint: queueReadinessForJob(job, target).fingerprint || undefined,
              },
            });
            if (!refreshIsCurrent()) return;
            selectedMedia = nextSession.selectedMedia;
          } catch {
            if (selectionSentRef.current === selectionKey) {
              selectionSentRef.current = "";
            }
          }
          break;
        }
      }

      const queue: Record<string, QueueReadiness> = {};
      const unavailable = (): QueueReadiness => ({
        ready: false,
        progress: 0,
        status:
          acquisitionStatus(acquisitionPolicy),
        fileName: null,
        fileSize: null,
        fingerprint: null,
        preparation: "waiting",
      });
      for (const source of queueSources) {
        const job = jobsById[source.id];
        const manifest = source.mediaItems?.length
          ? source.mediaItems
          : job ? mediaManifest(job.files, source.id) : [];
        let sourceState = unavailable();
        for (const mediaItem of manifest) {
          const file = job?.files.find((candidate) =>
            candidate.index === mediaItem.fileIndex &&
            candidate.size === mediaItem.size
          ) || null;
          const itemState = job ? queueReadinessForJob(job, file) : unavailable();
          queue[mediaItem.id] = itemState;
          if (
            !sourceState.fileName ||
            mediaItem.id === selectedMedia?.itemId ||
            (
              source.id === selectedMedia?.sourceId &&
              mediaItem.fileIndex === selectedMedia?.fileIndex
            )
          ) sourceState = itemState;
        }
        queue[source.id] = sourceState;
      }

      const logicalSourceId = selectedMedia?.sourceId || queueSources[0]?.id;
      const logicalItemId = selectedMedia?.itemId || logicalSourceId;
      const localFileBinding = localFileBindingRef.current;
      let localMatch = findLocalAgentMedia(jobsById, selectedMedia, localAgentBindingRef.current);
      if (localMatch?.job.kind === "magnet" && !localMatch.file.selected) {
        try {
          const updated = await selectAgentFile(localMatch.sourceId, localMatch.file.index);
          if (!refreshIsCurrent()) return;
          jobsById[localMatch.sourceId] = updated;
          localMatch = findLocalAgentMedia(jobsById, selectedMedia, localAgentBindingRef.current);
          setAgentJobs((current) => ({ ...current, [updated.id]: updated }));
        } catch {
          // The next poll retries a transient participant-specific selection failure.
        }
      }

      const usesLocalFile = Boolean(
        localFileBinding &&
        selectedMedia?.fingerprint &&
        localFileBinding.fingerprint === selectedMedia.fingerprint
      );
      let activeItem = usesLocalFile ? localFileBinding?.readiness || null : null;
      let activeFile: AgentFile | null = null;
      if (!activeItem && localMatch) {
        activeFile = localMatch.file;
        activeItem = queueReadinessForJob(localMatch.job, localMatch.file);
        queue[localMatch.file.itemId || localMatch.sourceId] = activeItem;
      }
      if (!activeItem && logicalItemId) activeItem = queue[logicalItemId] || null;
      if (!activeItem && logicalSourceId) activeItem = queue[logicalSourceId] || null;
      if (!activeItem) return;
      // Readiness belongs to the logical movie, even when this participant uses another source.
      if (logicalItemId) queue[logicalItemId] = activeItem;
      if (logicalSourceId) queue[logicalSourceId] = activeItem;

      const next: LocalReadiness = {
        ...activeItem,
        queue,
        voice: readinessRef.current.voice,
      };
      if (!refreshIsCurrent()) return;
      const previous = readinessRef.current;
      const queueKeys = Object.keys(queue);
      const queueChanged =
        queueKeys.length !== Object.keys(previous.queue).length ||
        queueKeys.some((key) => {
          const current = queue[key];
          const prior = previous.queue[key];
          return !prior || current.ready !== prior.ready ||
            current.progress !== prior.progress ||
            current.preparation !== prior.preparation ||
            current.status !== prior.status ||
            current.fileName !== prior.fileName ||
            current.fileSize !== prior.fileSize ||
            current.fingerprint !== prior.fingerprint;
        });
      const readinessChanged =
        next.ready !== previous.ready ||
        (next.ready && previous.fingerprint !== next.fingerprint) ||
        queueChanged;
      readinessRef.current = next;
      setReadiness(next);
      if (usesLocalFile && localFileBinding) {
        if (mediaUrlRef.current !== localFileBinding.url) setMediaUrl(localFileBinding.url);
      } else if (activeFile?.ready && activeItem.ready) {
        setMediaUrl(activeFile.hlsUrl || activeFile.streamUrl);
      } else if (mediaUrlRef.current.startsWith(AGENT_URL)) {
        setMediaUrl("");
      }
      if (
        next.ready &&
        next.fingerprint &&
        selectedMedia &&
        !selectedMedia.fingerprint
      ) {
        await sendAction("select-media", {
          media: { ...selectedMedia, fingerprint: next.fingerprint },
        });
        if (!refreshIsCurrent()) return;
      }
      if (readinessChanged) await sendAction("heartbeat", { readiness: next });
    };

    let refreshTimer: number | null = null;
    const refresh = async () => {
      if (!active || refreshRunning) return;
      refreshRunning = true;
      try {
        await performRefresh();
      } catch {
        // The next serialized poll retries a transient refresh failure.
      } finally {
        refreshRunning = false;
        if (active) refreshTimer = window.setTimeout(() => void refresh(), 1_000);
      }
    };

    void refresh();
    return () => {
      active = false;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      for (const key of pendingBindingKeys) {
        automaticLibraryBindings.delete(key);
      }
    };
  }, [acquisitionPolicy, activeSourceId, agentAvailable, approvedSourceIds, joined, preferLocalCopies, sendAction, sourcesKey]);

  useEffect(() => {
    if (!joined || agentAvailable || !activeSourceId || !agentJobs[activeSourceId]) return;
    const timer = window.setTimeout(() => {
      if (mediaUrlRef.current.startsWith(AGENT_URL)) setMediaUrl("");
      const item: QueueReadiness = {
        ...(readinessRef.current.queue[activeSourceId] || emptyReadiness()),
        ready: false,
        status:
          agentPermission === "denied"
            ? "Allow local network access, then reconnect"
            : "Companion disconnected; reconnecting",
      };
      const next: LocalReadiness = {
        ...item,
        voice: readinessRef.current.voice,
        queue: { ...readinessRef.current.queue, [activeSourceId]: item },
      };
      readinessRef.current = next;
      setReadiness(next);
      void sendAction("heartbeat", { readiness: next });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSourceId, agentAvailable, agentJobs, agentPermission, joined, sendAction]);

  const requestedSubtitleSelection = session?.player.subtitleLanguage || "off";
  const requestedSubtitleTrackId = requestedSubtitleSelection.startsWith("embedded:")
    ? requestedSubtitleSelection.slice("embedded:".length)
    : "";
  const requestedSubtitleTrack = embeddedSubtitles.find(
    (track) => track.id === requestedSubtitleTrackId
  );
  const requestedSubtitleTrackSupported = Boolean(requestedSubtitleTrack?.supported);
  const requestedSubtitleTrackUrl = requestedSubtitleTrack?.url || "";

  const selectedMediaTrackKey =
    session?.selectedMedia?.fingerprint ||
    (session?.selectedMedia ? session.selectedMedia.name + ":" + session.selectedMedia.size : "");

  useEffect(() => {
    const sourceId = playbackSourceId;
    const player = sessionRef.current?.player;
    if (!player || !sourceId || !selectedMediaTrackKey || agentJob?.subtitleStatus !== "ready") return;
    const initializationKey = sourceId + ":" + selectedMediaTrackKey;
    if (initializedMediaTracksRef.current === initializationKey) return;

    const supportedTracks = embeddedSubtitles.filter((track) => track.supported);
    const defaultSubtitle =
      supportedTracks.find((track) => track.forced) ||
      supportedTracks.find((track) => track.default) ||
      supportedTracks[0];
    const requestedTrackIsReady = Boolean(
      requestedSubtitleTrack && requestedSubtitleTrack.supported
    );
    const shouldRecoverEmbeddedSelection =
      requestedSubtitleSelection.startsWith("embedded:") &&
      !requestedTrackIsReady;
    const shouldSelectDefault =
      requestedSubtitleSelection === "off" &&
      Boolean(defaultSubtitle?.default || defaultSubtitle?.forced);
    if (
      !defaultSubtitle ||
      (!shouldRecoverEmbeddedSelection && !shouldSelectDefault)
    ) {
      initializedMediaTracksRef.current = initializationKey;
      return;
    }

    initializedMediaTracksRef.current = initializationKey;
    const timer = window.setTimeout(() => {
      void sendAction("player", {
        player: {
          ...player,
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
    requestedSubtitleSelection,
    requestedSubtitleTrack,
    playbackSourceId,
  ]);

  useEffect(() => {
    const selection = requestedSubtitleSelection;
    const sourceId = playbackSourceId;
    if (!selection.startsWith("embedded:")) {
      loadedSubtitleRef.current = "";
      return;
    }
    if (!sourceId || !requestedSubtitleTrackSupported || !requestedSubtitleTrackUrl) {
      loadedSubtitleRef.current = "";
      const clearTimer = window.setTimeout(() => setSubtitleCues([]), 0);
      return () => window.clearTimeout(clearTimer);
    }

    const trackId = requestedSubtitleTrackId;
    const loadKey = sourceId + ":" + selectedMediaTrackKey + ":" + trackId;
    if (loadedSubtitleRef.current === loadKey) return;
    loadedSubtitleRef.current = loadKey;

    let active = true;
    const controller = new AbortController();
    const clearTimer = window.setTimeout(() => {
      if (active) setSubtitleCues([]);
    }, 0);
    void getAgentSubtitle(requestedSubtitleTrackUrl, controller.signal)
      .then((contents) => {
        if (!active) return;
        const cues = parseSubtitles(contents);
        if (!cues.length) throw new Error("No cues were extracted from that embedded track.");
        setSubtitleCues(cues);
      })
      .catch((caught) => {
        if (!active || controller.signal.aborted) return;
        loadedSubtitleRef.current = "";
        setError(caught instanceof Error ? caught.message : "Could not load embedded subtitles.");
      });

    return () => {
      active = false;
      controller.abort();
      if (loadedSubtitleRef.current === loadKey) {
        loadedSubtitleRef.current = "";
      }
      window.clearTimeout(clearTimer);
    };
  }, [
    requestedSubtitleSelection,
    requestedSubtitleTrackId,
    requestedSubtitleTrackSupported,
    requestedSubtitleTrackUrl,
    selectedMediaTrackKey,
    playbackSourceId,
  ]);

  const chooseAgentMedia = async (sourceId: string, job: AgentJob, file: AgentFile) => {
    setBusy("file");
    setError("");
    try {
      setMediaUrl("");
      setSubtitleCues([]);
      let selectedJob = job;
      if (job.kind === "magnet" && !file.selected) {
        selectedJob = await selectAgentFile(sourceId, file.index);
        setAgentJobs((current) => ({ ...current, [sourceId]: selectedJob }));
      }
      const selectedFile =
        selectedJob.files.find((candidate) => candidate.index === file.index) || file;
      const item = queueReadinessForJob(selectedJob, selectedFile);
      const currentMedia = sessionRef.current?.selectedMedia;
      const matchesCurrent = Boolean(
        item.fingerprint && currentMedia?.fingerprint === item.fingerprint
      );
      const logicalSourceId = matchesCurrent ? currentMedia?.sourceId : sourceId;
      const nextQueue = { ...readinessRef.current.queue, [sourceId]: item };
      if (logicalSourceId) nextQueue[logicalSourceId] = item;
      const next: LocalReadiness = {
        ...item,
        voice: readinessRef.current.voice,
        queue: nextQueue,
      };
      selectionSentRef.current = `${sourceId}:${file.index}`;
      const nextLocalAgentBinding = item.fingerprint ? {
        sourceId,
        fileIndex: selectedFile.index,
        fingerprint: item.fingerprint,
      } : null;
      localAgentBindingRef.current = nextLocalAgentBinding;
      setLocalAgentBinding(nextLocalAgentBinding);
      localFileBindingRef.current = null;
      setMediaUrl(item.ready ? selectedFile.hlsUrl || selectedFile.streamUrl : "");
      readinessRef.current = next;
      setReadiness(next);
      if (!matchesCurrent) {
        await sendAction("select-media", {
          media: {
            sourceId,
            itemId: file.itemId || `${sourceId}-f${file.index}`,
            fileIndex: file.index,
            name: file.name,
            size: file.size,
            fingerprint: item.fingerprint || undefined,
          },
        });
      }
      await sendAction("heartbeat", { readiness: next });
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

  const changeAcquisitionPolicy = async (policy: AcquisitionPolicy) => {
    setAcquisitionPolicy(policy);
    localStorage.setItem("watchpair-acquisition-policy", policy);
    handledSourceRef.current = "";
    if (policy !== "never") return;

    setApprovedSourceIds([]);
    await pauseIncomingJobs(agentJobs, sourcesKey ? sourcesKey.split(":") : []);
  };

  const startQueuedSource = (sourceId: string) => {
    setApprovedSourceIds((current) => current.includes(sourceId) ? current : [...current, sourceId]);
  };

  const pauseQueuedSource = async (sourceId: string) => {
    try {
      const pausedJob = await pauseAgentDownload(sourceId);
      setApprovedSourceIds((current) => current.filter((id) => id !== sourceId));
      if (pausedJob) setAgentJobs((current) => ({ ...current, [sourceId]: pausedJob }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not pause that download.");
    }
  };

  const retryQueuedSource = async (sourceId: string) => {
    try {
      const job = await retryAgentDownload(sourceId);
      setAgentJobs((current) => ({ ...current, [sourceId]: job }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not retry that download.");
    }
  };

  const toggleQueuedSourcePin = async (sourceId: string, pinned: boolean) => {
    try {
      const job = await setAgentDownloadPinned(sourceId, pinned);
      setAgentJobs((current) => ({ ...current, [sourceId]: job }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update download retention.");
    }
  };

  const updateQueuedMedia = async (
    action: "prioritize-media" | "include-media",
    itemId: string,
    value: boolean
  ) => {
    try {
      await sendAction(action, action === "prioritize-media"
        ? { itemId, priority: value }
        : { itemId, included: value });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update the synchronized episode queue."
      );
    }
  };

  const moveQueuedSource = async (sourceId: string, direction: -1 | 1) => {
    const index = sources.findIndex((source) => source.id === sourceId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sources.length) return;
    const ordered = sources.map((source) => source.id);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    await sendAction("reorder-sources", { sourceIds: ordered });
  };

  const renameQueuedSource = async (sourceId: string, currentLabel: string) => {
    const label = window.prompt("Queue item name", currentLabel)?.trim();
    if (!label || label === currentLabel) return;
    await sendAction("rename-source", { sourceId, label });
  };

  const removeQueuedSource = async (sourceId: string) => {
    if (!window.confirm("Remove this item from the shared queue? Downloaded files will be kept.")) return;
    await sendAction("remove-source", { sourceId });
    setAgentJobs((current) => {
      const next = { ...current };
      delete next[sourceId];
      return next;
    });
  };

  const copySource = async (value: string) => {
    await navigator.clipboard.writeText(value);
  };

  const openLibrary = async () => {
    setLibraryOpen(true);
    clearLibraryPreview();
    setLibraryBusy(true);
    try {
      const result = await scanAgentLibrary();
      const files = result.files;
      setLibraryFiles(files);
      setLibraryCatalogStale(result.stale);
      setLibraryScanWarning(result.stale
        ? result.error || result.scan?.error || "The latest library scan failed; these results may be out of date."
        : "");
      setSelectedLibraryId((current) =>
        files.some((file) => file.id === current) ? current : files[0]?.id || ""
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not scan the companion library.";
      setLibraryCatalogStale(true);
      setLibraryScanWarning(message);
    } finally {
      setLibraryBusy(false);
    }
  };

  const startLibraryHlsPreview = async (libraryFile: AgentLibraryFile) => {
    clearLibraryPreview();
    const previewEpoch = libraryPreviewEpochRef.current;
    const previewSourceId = `preview-${crypto.randomUUID()}`;
    setSelectedLibraryId(libraryFile.id);
    setLibraryPreviewBusy(true);
    setError("");
    try {
      const job = await attachAgentLibraryFile(
        previewSourceId,
        libraryFile.id,
        `Preview · ${libraryFile.name}`
      );
      if (previewEpoch !== libraryPreviewEpochRef.current) {
        await stopAgentDownload(previewSourceId, false).catch(() => {});
        return;
      }
      const target = preferredAgentFile(job);
      if (!target?.hlsUrl) {
        throw new Error("The Companion could not prepare an HLS preview for this video.");
      }
      libraryPreviewJobIdRef.current = previewSourceId;
      setLibraryPreviewUrl(target.hlsUrl);
    } catch (caught) {
      await stopAgentDownload(previewSourceId, false).catch(() => {});
      if (previewEpoch !== libraryPreviewEpochRef.current) return;
      setLibraryPreviewBusy(false);
      setError(caught instanceof Error ? caught.message : "Could not prepare that library preview.");
    }
  };

  const previewLibraryFile = (libraryFile: AgentLibraryFile) => {
    if (libraryCatalogStale) {
      setError("Rescan the Companion library before previewing an out-of-date entry.");
      return;
    }
    if (libraryFile.usable === false) {
      setLibraryPreviewUrl("");
      setError("That library video is still downloading or being verified.");
      return;
    }
    if (libraryPreviewNeedsHls(libraryFile.name)) {
      void startLibraryHlsPreview(libraryFile);
      return;
    }
    clearLibraryPreview();
    setSelectedLibraryId(libraryFile.id);
    setLibraryPreviewBusy(true);
    setError("");
    setLibraryPreviewUrl(getAgentLibraryPreviewUrl(libraryFile.id));
  };

  const handleLibraryPreviewError = () => {
    if (!selectedLibraryFile) return;
    if (!libraryPreviewJobIdRef.current) {
      void startLibraryHlsPreview(selectedLibraryFile);
      return;
    }
    clearLibraryPreview();
    setError("The Companion could not preview that library file.");
  };

  const bindLibraryFileLocally = async (libraryFile: AgentLibraryFile) => {
    if (libraryCatalogStale) {
      setError("Rescan the Companion library before using an out-of-date entry.");
      return;
    }
    if (libraryFile.usable === false) {
      setError("That library video is still downloading or being verified.");
      return;
    }
    setLibraryBusy(true);
    setError("");
    let localSourceId = "";
    try {
      const selectedMedia = sessionRef.current?.selectedMedia;
      const selectedSourceId = selectedMedia?.sourceId;
      if (!selectedMedia || !selectedSourceId) {
        throw new Error("Select a room video before choosing a local copy.");
      }
      const canonicalJob = agentJobs[selectedSourceId];
      const canonicalFile = canonicalJob?.files.find((candidate) =>
        (selectedMedia.itemId ? candidate.itemId === selectedMedia.itemId : true) &&
        (selectedMedia.fileIndex === undefined || candidate.index === selectedMedia.fileIndex)
      );
      const currentSession = sessionRef.current;
      const currentSources = currentSession?.sources?.length
        ? currentSession.sources
        : currentSession?.source ? [currentSession.source] : [];
      const roomSource = currentSources.find((source) => source.id === selectedSourceId) || null;
      const roomMediaItem = roomSource?.mediaItems?.find((item) =>
        (selectedMedia.itemId ? item.id === selectedMedia.itemId : true) &&
        (selectedMedia.fileIndex === undefined || item.fileIndex === selectedMedia.fileIndex)
      ) || null;
      const torrentIdentity = {
        selectedInfoHash: roomSource?.infoHash || canonicalJob?.infoHash,
        libraryInfoHash: libraryFile.infoHash,
        selectedFileIndex: selectedMedia.fileIndex ?? roomMediaItem?.fileIndex,
        libraryFileIndex: libraryFile.torrentFileIndex ?? libraryFile.fileIndex,
        selectedPath: roomMediaItem?.path,
        libraryPath: libraryFile.relativePath,
      };
      const expectedFingerprint = selectedMedia.fingerprint || (
        canonicalJob && canonicalFile ? agentFileFingerprint(canonicalJob, canonicalFile) : null
      );
      if (!expectedFingerprint && !isVerifiedLibraryMatch(
        selectedMedia,
        null,
        libraryFile.size,
        torrentIdentity
      )) {
        throw new Error("Wait for the room video's identity check before replacing it with a library copy.");
      }

      localSourceId = `local-${crypto.randomUUID()}`;
      const job = await attachAgentLibraryFile(localSourceId, libraryFile.id, libraryFile.name);
      const target = preferredAgentFile(job);
      const fingerprint = target ? agentFileFingerprint(job, target) : null;
      if (!target || !fingerprint || !isVerifiedLibraryMatch(
        expectedFingerprint ? { ...selectedMedia, fingerprint: expectedFingerprint } : selectedMedia,
        fingerprint,
        target.size,
        torrentIdentity
      )) {
        throw new Error("That library file is not the same video as the selected room item.");
      }

      browserDownloadControllerRef.current?.abort();
      browserDownloadControllerRef.current = null;
      const canonicalIsActive = canonicalJob && !canonicalJob.seed && (
        canonicalJob.status === "queued" ||
        canonicalJob.status === "metadata" ||
        canonicalJob.status === "downloading"
      );
      if (canonicalIsActive) {
        const pausedJob = await pauseAgentDownload(selectedSourceId);
        setAgentJobs((current) => {
          const next = { ...current };
          if (pausedJob) next[selectedSourceId] = pausedJob;
          else delete next[selectedSourceId];
          return next;
        });
      }
      locallySatisfiedSourceIdsRef.current.add(selectedSourceId);

      const item = queueReadinessForJob(job, target);
      const logicalItemId = selectedMedia.itemId || selectedSourceId;
      const nextQueue = {
        ...readinessRef.current.queue,
        [localSourceId]: item,
        [selectedSourceId]: item,
        [logicalItemId]: item,
      };
      const next: LocalReadiness = {
        ...item,
        voice: readinessRef.current.voice,
        queue: nextQueue,
      };
      setAgentJobs((current) => ({ ...current, [localSourceId]: job }));
      localLibraryBindingJobIdsRef.current.add(localSourceId);
      const nextLocalAgentBinding = {
        sourceId: localSourceId,
        fileIndex: target.index,
        fingerprint: fingerprint as string,
      };
      localAgentBindingRef.current = nextLocalAgentBinding;
      setLocalAgentBinding(nextLocalAgentBinding);
      setPreferLocalCopies(true);
      localStorage.setItem("watchpair-prefer-local-copies", "1");
      localFileBindingRef.current = null;
      readinessRef.current = next;
      setReadiness(next);
      setMediaUrl(item.ready ? target.hlsUrl || target.streamUrl : "");
      if (!selectedMedia.fingerprint) {
        await sendAction("select-media", {
          media: { ...selectedMedia, fingerprint },
        });
      }
      await sendAction("heartbeat", { readiness: next });
    } catch (caught) {
      const selectedSourceId = sessionRef.current?.selectedMedia?.sourceId;
      if (selectedSourceId) locallySatisfiedSourceIdsRef.current.delete(selectedSourceId);
      if (localSourceId) {
        localLibraryBindingJobIdsRef.current.delete(localSourceId);
        void stopAgentDownload(localSourceId, false).catch(() => {});
      }
      setError(caught instanceof Error ? caught.message : "Could not use that library file locally.");
    } finally {
      setLibraryBusy(false);
    }
  };

  const shareLibraryFile = async (libraryFile: AgentLibraryFile) => {
    if (libraryCatalogStale) {
      setError("Rescan the Companion library before sharing an out-of-date entry.");
      return;
    }
    if (libraryFile.usable === false) {
      setError("That library video is still downloading or being verified.");
      return;
    }
    const intentKey = libraryShareIntentKey(libraryFile);
    if (pendingLibrarySharesRef.current.has(intentKey)) return;
    const existingSeed = Object.entries(agentJobs).find(([, job]) =>
      job.seed &&
      (
        Boolean(job.infoHash && job.files.some((file) =>
          libraryShareIntentKey({
            id: job.id,
            size: file.size,
            infoHash: job.infoHash,
            torrentFileIndex: file.index,
            relativePath: file.path,
          }) === intentKey
        )) ||
        Boolean(libraryFile.fingerprint && job.files.some((file) =>
          agentFileFingerprint(job, file) === libraryFile.fingerprint &&
          file.size === libraryFile.size
        ))
      )
    );
    const existingSourceId = libraryShareIntentsRef.current.get(intentKey) || existingSeed?.[0];
    if (existingSourceId) libraryShareIntentsRef.current.set(intentKey, existingSourceId);
    const existingJob = existingSourceId ? agentJobs[existingSourceId] : null;
    if (existingSourceId && sources.some((source) => source.id === existingSourceId)) {
      if (existingJob?.seed && roomToken && deviceId) {
        void ensureSeedLease(existingSourceId, roomToken, deviceId).catch(() => {});
      }
      return;
    }
    if (!window.confirm(
      `Add “${libraryFile.name}” to the room and share it using BitTorrent? Other participants may see this device's IP address.`
    )) return;

    pendingLibrarySharesRef.current.add(intentKey);
    setLibraryBusy(true);
    setError("");
    let shareSourceId = "";
    let leasedSourceId = "";
    let createdNewSeed = false;
    try {
      const sourceId = existingSourceId && existingJob?.seed
        ? existingSourceId
        : crypto.randomUUID();
      shareSourceId = sourceId;
      const published = existingSourceId && existingJob?.seed
        ? await waitForAgentSeed(existingSourceId)
        : await seedAgentLibraryFile(sourceId, libraryFile.id, libraryFile.name);
      createdNewSeed = !(existingSourceId && existingJob?.seed);
      if (!roomToken || !deviceId) throw new Error("Join the room before sharing a library video.");
      await ensureSeedLease(sourceId, roomToken, deviceId);
      leasedSourceId = sourceId;
      libraryShareIntentsRef.current.set(intentKey, sourceId);
      setAgentJobs((current) => ({ ...current, [sourceId]: published.job }));
      const publishedSession = await sendAction("source", {
        source: {
          id: sourceId,
          kind: "magnet",
          value: published.magnetURI,
          label: libraryFile.name,
        },
      });
      const retainedSourceId = publishedMagnetRoomSourceId(
        publishedSession.sources,
        sourceId,
        published.magnetURI
      );
      if (!retainedSourceId) throw new Error("The room did not retain the shared library video.");
      if (retainedSourceId !== sourceId) {
        await releaseSeedLeases([sourceId]);
        leasedSourceId = "";
        if (createdNewSeed) await stopAgentDownload(sourceId, false).catch(() => {});
        setAgentJobs((current) => {
          const next = { ...current };
          delete next[sourceId];
          return next;
        });
        libraryShareIntentsRef.current.set(intentKey, retainedSourceId);
        setError("That video is already in the room, so the existing queue item was kept.");
        return;
      }
      leasedSourceId = "";
    } catch (caught) {
      if (leasedSourceId) await releaseSeedLeases([leasedSourceId]);
      if (createdNewSeed && shareSourceId) {
        void stopAgentDownload(shareSourceId, false).catch(() => {});
      }
      setError(caught instanceof Error ? caught.message : "Could not share that library file.");
    } finally {
      pendingLibrarySharesRef.current.delete(intentKey);
      setLibraryBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!session) return;
    const invite = new URL(window.location.href);
    invite.searchParams.set("room", session.token);
    await navigator.clipboard.writeText(invite.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  };

  const leaveSession = () => {
    voice.stop();
    transferPolicyRoomRef.current = "";
    resetRoomTransferState();
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

  const mediaReadyForEveryone = (itemId: string) => Boolean(
    readiness.queue[itemId]?.ready &&
    session?.participants.every((participant) => participant.queue?.[itemId]?.ready)
  );

  const selectPlaylistMedia = async (itemId: string) => {
    if (itemId === selectedItemId) return;
    const mediaItem = synchronizedMedia.find((item) => item.id === itemId);
    const sourceId = mediaItem?.sourceId || itemId;
    const job = roomAgentJob(sourceId);
    const target = mediaItem
      ? job?.files.find((file) =>
          file.index === mediaItem.fileIndex && file.size === mediaItem.size
        ) || null
      : job ? preferredAgentFile(job) : null;
    if (!job || !target || !mediaReadyForEveryone(itemId)) return;
    await chooseAgentMedia(sourceId, job, target);
  };

  const playbackQueue: PlayerQueueItem[] = synchronizedMedia.length
    ? synchronizedMedia.map((item) => ({
        itemId: item.id,
        sourceId: item.sourceId,
        label: item.path,
        selected: item.id === selectedItemId,
        ready: item.id === selectedItemId || mediaReadyForEveryone(item.id),
      }))
    : sources.map((source) => ({
        itemId: source.id,
        sourceId: source.id,
        label: source.label,
        selected: source.id === session?.selectedMedia?.sourceId,
        ready:
          source.id === session?.selectedMedia?.sourceId ||
          mediaReadyForEveryone(source.id),
      }));

  const advancePlaylist = async () => {
    if (!session || deviceId !== session.hostId || !session.selectedMedia) return;
    const currentIndex = playbackQueue.findIndex((item) => item.selected);
    const nextMedia = currentIndex >= 0 ? playbackQueue[currentIndex + 1] : null;
    if (nextMedia) await selectPlaylistMedia(nextMedia.itemId);
  };

  const readyParticipants = session?.participants.filter((participant) => participant.ready) ?? [];
  const fingerprints = new Set(
    readyParticipants.map((participant) => participant.fingerprint).filter(Boolean)
  );
  if (session?.selectedMedia?.fingerprint) fingerprints.add(session.selectedMedia.fingerprint);
  const hasMismatch = fingerprints.size > 1;
  const everyoneReady =
    Boolean(session) &&
    session!.participants.length >= 2 &&
    readiness.ready &&
    session!.participants.every((participant) => participant.ready) &&
    !hasMismatch;
  const invitePending = Boolean(roomToken && !joined);
  const playerMediaKey = session?.selectedMedia
    ? (activeSource?.id || "local") + ":" +
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

  if (joined && session && view === "player") {
    return (
      <>
      <SyncedPlayer
        session={session}
        deviceId={deviceId}
        mediaUrl={mediaUrl}
        mediaPreparation={selectedAgentFile?.preparation || agentJob?.preparation || null}
        subtitleCues={subtitleCues}
        localSubtitleName={localSubtitleName}
        audioTracks={embeddedAudioTracks}
        chapters={embeddedChapters}
        subtitleTracks={embeddedSubtitles}
        subtitleStatus={embeddedSubtitleStatus}
        subtitleAssetStatus={embeddedSubtitleAssetStatus}
        subtitleError={embeddedSubtitleError}
        subtitleAssetError={embeddedSubtitleAssetError}
        queue={playbackQueue}
        onSelectVideo={selectPlaylistMedia}
        onBack={() => setView("lobby")}
        onEnded={deviceId === session.hostId ? () => void advancePlaylist() : undefined}
        onSend={sendPlayerState}
      />
      <VoiceDock voice={voice} />
      </>
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
    <>
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
              <h2 id="source-title">Download queue</h2>
            </div>
            {sources.length > 0 && (
              <span className="source-badge">{sources.length} queued</span>
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

          <div className="download-controls">
            <span className="session-label">Download here</span>
            <div className="mode-switch" role="group" aria-label="Download room media on this device">
              {(["automatic", "ask", "never"] as AcquisitionPolicy[]).map((policy) => (
                <button
                  key={policy}
                  type="button"
                  className={acquisitionPolicy === policy ? "selected" : ""}
                  aria-pressed={acquisitionPolicy === policy}
                  onClick={() => void changeAcquisitionPolicy(policy)}
                  title={policy === "automatic"
                    ? "Download new room media automatically"
                    : policy === "ask"
                      ? "Wait for you to start each download"
                      : "Do not download room media on this device"}
                >
                  {policy === "automatic" ? "Auto" : policy === "ask" ? "Ask" : "Never"}
                </button>
              ))}
            </div>
            <label className="toggle-control">
              <input
                type="checkbox"
                checked={preferLocalCopies}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setPreferLocalCopies(enabled);
                  localStorage.setItem("watchpair-prefer-local-copies", enabled ? "1" : "0");
                  if (!enabled) {
                    locallySatisfiedSourceIdsRef.current.clear();
                    localAgentBindingRef.current = null;
                    setLocalAgentBinding(null);
                  }
                }}
              />
              <span>Prefer library copies</span>
            </label>
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => shareFileInputRef.current?.click()}
              disabled={!agentAvailable || busy === "file"}
              title="Explicitly add and share a local file with this room"
            >
              <Share2 />
              Share file
            </button>
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => void openLibrary()}
              disabled={!agentAvailable || libraryBusy}
            >
              {libraryBusy ? <LoaderCircle className="spin" /> : <FileSearch />}
              Library
            </button>
          </div>

          {!agentAvailable && (
            <div className="companion-callout">
              <div>
                <span className="companion-icon"><Plug /></span>
                <span>
                  <strong>{agentUpdateRequired ? "Companion update required" : "Companion needed"}</strong>
                  <small>{agentUpdateRequired
                    ? "Install the latest Companion before reconnecting; this version cannot safely identify or share local media."
                    : "Connect it for magnet pages, torrent downloads, and embedded MKV subtitles."}</small>
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
                  {agentPairing ? "Waiting for approval" : agentUpdateRequired ? "Check again" : "Connect"}
                </button>
                <a className="secondary-button" href={`https://github.com/Etaselia/WatchPair/releases/tag/v${COMPANION_VERSION}`} target="_blank" rel="noreferrer">
                  <PackageOpen />
                  Get app
                </a>
              </div>
            </div>
          )}

          {sources.length ? (
            <div className="queue-list" aria-label="Synchronized download queue">
              {sources.map((source, queueIndex) => {
                const job = roomAgentJob(source.id);
                const manifestItems = source.mediaItems?.length
                  ? source.mediaItems
                  : job ? mediaManifest(job.files, source.id) : [];
                const mediaRows = manifestItems.map((item) => ({
                  item,
                  file: job?.files.find((candidate) =>
                    candidate.index === item.fileIndex && candidate.size === item.size
                  ) || null,
                }));
                const selectedRow = mediaRows.find(({ item }) =>
                  item.id === selectedItemId ||
                  (
                    source.id === session?.selectedMedia?.sourceId &&
                    item.fileIndex === session?.selectedMedia?.fileIndex
                  )
                );
                const target = selectedRow?.file || (job ? preferredAgentFile(job, session?.selectedMedia) : null);
                const activeReadinessKey = selectedRow?.item.id || source.id;
                const localState = readiness.queue[activeReadinessKey] || readiness.queue[source.id];
                const selected = localAgentMedia
                  ? localAgentMedia.sourceId === source.id
                  : activeSource?.id === source.id;
                const readyCount = session?.participants.filter(
                  (participant) => participant.queue?.[activeReadinessKey]?.ready
                ).length || 0;
                const preparation = preparationSummary(job, target);
                const subtitleAvailability = subtitleAvailabilitySummary(job, target);

                return (
                  <article className={`queue-item ${selected ? "selected" : ""}`} key={source.id}>
                    <div className="queue-item-main">
                      <span className="queue-index">{String(queueIndex + 1).padStart(2, "0")}</span>
                      <div className="file-icon"><Download /></div>
                      <div className="source-details">
                        <div>
                          <strong>{source.label}</strong>
                          <span className="source-badge subtle">{sourceKindLabel(source.kind)}</span>
                        </div>
                        <span>{localState?.status || (agentAvailable ? "Starting companion job" : "Waiting for companion")}</span>
                        <div className="progress-track" aria-label={`${Math.round(localState?.progress || 0)}% complete`}>
                          <span style={{ width: `${localState?.progress || 0}%` }} />
                        </div>
                      </div>
                      <div className="queue-item-status">
                        <strong>{Math.round(localState?.progress || 0)}%</strong>
                        <span>{readyCount}/{Math.max(2, session?.participants.length || 0)} ready</span>
                      </div>
                      <button
                        className={selected ? "secondary-button compact-button selected" : "secondary-button compact-button"}
                        type="button"
                        disabled={!job || !target}
                        onClick={() => { if (job && target) void chooseAgentMedia(source.id, job, target); }}
                        title={
                          selected ? "Currently selected"
                            : !job || !target ? "Waiting for the companion to verify this job"
                              : "Select for playback"
                        }
                      >
                        {selected ? <Check /> : <Play />}
                        {selected ? "Selected" : "Select"}
                      </button>
                    </div>

                    <div className="queue-preparation" title={preparation.title || undefined}>
                      <Cpu />
                      <span>{preparation.label}</span>
                      {preparation.hardware && <strong>GPU</strong>}
                    </div>
                    <div
                      className={"queue-preparation subtitle-preparation" + (subtitleAvailability.error ? " error" : "")}
                      title={subtitleAvailability.title || undefined}
                    >
                      <Subtitles />
                      <span>{subtitleAvailability.label}</span>
                    </div>

                    <div className="queue-actions">
                      {(!job || agentJobIsPaused(job)) && acquisitionPolicy === "ask" && (
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={() => startQueuedSource(source.id)}
                        >
                          <Download />
                          Start
                        </button>
                      )}
                      {(!job || agentJobIsPaused(job)) && acquisitionPolicy === "never" && (
                        <>
                          <a
                            className="secondary-button compact-button"
                            href={source.value}
                            target={source.value.startsWith("magnet:") ? undefined : "_blank"}
                            rel="noreferrer"
                          >
                            <Share2 />
                            Open
                          </a>
                          <button
                            className="icon-button"
                            type="button"
                            title="Copy source"
                            aria-label="Copy source"
                            onClick={() => void copySource(source.value)}
                          >
                            <Copy />
                          </button>
                        </>
                      )}
                      {job?.status === "error" && !job.seed && acquisitionPolicy !== "never" && (
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={() => void retryQueuedSource(source.id)}
                        >
                          <RotateCcw />
                          Retry
                        </button>
                      )}
                      {job && acquisitionPolicy !== "automatic" && !job.seed && !agentJobIsPaused(job) && (
                        <button
                          className="icon-button"
                          type="button"
                          title="Pause local download"
                          aria-label="Pause local download"
                          onClick={() => void pauseQueuedSource(source.id)}
                        >
                          <Pause />
                        </button>
                      )}
                      {job?.managed && (
                        <button
                          className={job.pinned ? "icon-button selected" : "icon-button"}
                          type="button"
                          title={job.pinned ? "Allow automatic cleanup" : "Keep this download"}
                          aria-label={job.pinned ? "Allow automatic cleanup" : "Keep this download"}
                          aria-pressed={job.pinned}
                          onClick={() => void toggleQueuedSourcePin(source.id, !job.pinned)}
                        >
                          <Pin />
                        </button>
                      )}
                      {job?.seed && (
                        <span
                          className="seed-status"
                          title={torrentSummaryTitle(job)}
                        >
                          <Upload />
                          {job.seedState === "creating"
                            ? `Creating torrent ${Math.round(job.creationProgress)}%`
                            : job.seedState === "starting"
                              ? "Starting seed"
                              : job.seedState === "uploading"
                                ? `Uploading to ${job.peers} peer${job.peers === 1 ? "" : "s"} / ${formatBytes(job.uploadSpeed)}/s`
                                : job.seedState === "error"
                                  ? "Seed failed"
                                  : job.webRtcSupported === false
                                    ? "Seeding / WebRTC unavailable"
                                    : job.trackerAnnounces === 0
                                      ? "Seeding / contacting trackers"
                                      : "Seeding / waiting for peers"}
                        </span>
                      )}
                      <span className="queue-action-spacer" />
                      <button
                        className="icon-button"
                        type="button"
                        title="Move up"
                        aria-label="Move up"
                        disabled={queueIndex === 0}
                        onClick={() => void moveQueuedSource(source.id, -1)}
                      >
                        <ArrowUp />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        title="Move down"
                        aria-label="Move down"
                        disabled={queueIndex === sources.length - 1}
                        onClick={() => void moveQueuedSource(source.id, 1)}
                      >
                        <ArrowDown />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        title="Rename"
                        aria-label="Rename"
                        onClick={() => void renameQueuedSource(source.id, source.label)}
                      >
                        <Pencil />
                      </button>
                      <button
                        className="icon-button danger"
                        type="button"
                        title="Remove from queue"
                        aria-label="Remove from queue"
                        onClick={() => void removeQueuedSource(source.id)}
                      >
                        <Trash2 />
                      </button>
                    </div>

                    {mediaRows.length > 1 && (
                      <div className="agent-files" aria-label={`Files in ${source.label}`}>
                        {mediaRows.map(({ item, file }) => {
                          const fileSelected = selected && (
                            item.id === selectedItemId ||
                            (
                              localAgentMedia?.sourceId === source.id &&
                              localAgentMedia.file.index === item.fileIndex
                            )
                          );
                          const itemState = readiness.queue[item.id];
                          const itemPreparation = preparationSummary(job, file);
                          const itemSubtitles = subtitleAvailabilitySummary(job, file);
                          return (
                            <div
                              className={`agent-file-row ${fileSelected ? "selected" : ""} ${item.included ? "" : "excluded"}`}
                              key={item.id}
                            >
                              <label
                                className="agent-file-include"
                                title={item.included ? "Exclude from synchronized queue" : "Include in synchronized queue"}
                              >
                                <input
                                  type="checkbox"
                                  checked={item.included}
                                  disabled={fileSelected}
                                  onChange={(event) => void updateQueuedMedia(
                                    "include-media",
                                    item.id,
                                    event.currentTarget.checked
                                  )}
                                  aria-label={`Include ${item.name}`}
                                />
                              </label>
                              <button
                                className="agent-file-select"
                                type="button"
                                disabled={!job || !file || !item.included}
                                onClick={() => {
                                  if (job && file) void chooseAgentMedia(source.id, job, file);
                                }}
                              >
                                <FileVideo2 />
                                <span>
                                  <strong>{item.name}</strong>
                                  <small title={item.path}>
                                    {item.path !== item.name ? `${item.path} / ` : ""}
                                    {formatBytes(item.size)} / {Math.round(file?.progress || itemState?.progress || 0)}%
                                    {" / "}{itemPreparation.label}
                                    {" / "}{itemSubtitles.label}
                                  </small>
                                </span>
                                {fileSelected && <Check />}
                              </button>
                              <button
                                className={item.priority ? "icon-button selected" : "icon-button"}
                                type="button"
                                disabled={!item.included || fileSelected}
                                aria-pressed={item.priority}
                                title={item.priority ? "Use normal watch order" : "Prioritize this episode"}
                                aria-label={item.priority ? "Use normal watch order" : "Prioritize this episode"}
                                onClick={() => void updateQueuedMedia(
                                  "prioritize-media",
                                  item.id,
                                  !item.priority
                                )}
                              >
                                <Star fill={item.priority ? "currentColor" : "none"} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <button className="drop-zone" type="button" onClick={() => shareFileInputRef.current?.click()}>
              <Share2 />
              <span><strong>Share a local video</strong> with this room</span>
            </button>
          )}

          {libraryOpen && (
            <div className="library-panel" role="dialog" aria-modal="false" aria-label="Companion library">
              <div className="library-header">
                <strong>Companion library</strong>
                <button
                  className="icon-button"
                  type="button"
                  title="Close library"
                  aria-label="Close library"
                  onClick={() => {
                    setLibraryOpen(false);
                    clearLibraryPreview();
                  }}
                >
                  <X />
                </button>
              </div>
              <div className="library-list">
                {libraryBusy && <LoaderCircle className="spin" />}
                {libraryScanWarning && (
                  <p className="library-file-unavailable" role="alert">
                    {libraryScanWarning} Rescan the Companion library before using these entries.
                  </p>
                )}
                {!libraryBusy && !libraryFiles.length && <span>No videos found in configured library folders.</span>}
                {libraryFiles.map((file) => (
                  <button
                    type="button"
                    key={file.id}
                    className={selectedLibraryId === file.id ? "selected" : ""}
                    aria-expanded={selectedLibraryId === file.id}
                    onClick={() => {
                      clearLibraryPreview();
                      setSelectedLibraryId(file.id);
                    }}
                    disabled={libraryBusy}
                  >
                    <FileVideo2 />
                    <span>
                      <strong>{file.name}</strong>
                      <small>
                        {formatBytes(file.size)}
                        {(file.copyCount || 1) > 1
                          ? ` · ${file.copyCount} local copies`
                          : ""}
                        {file.usable === false ? " · Still downloading or verifying" : ""}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {selectedLibraryFile && (
                <div className="library-details" aria-label={`Actions for ${selectedLibraryFile.name}`}>
                  <div className="queue-actions">
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => previewLibraryFile(selectedLibraryFile)}
                      disabled={libraryBusy || libraryCatalogStale || selectedLibraryFile.usable === false}
                      title={libraryCatalogStale
                        ? "Rescan the Companion library before previewing this entry"
                        : selectedLibraryFile.usable === false
                        ? "Preview is available after the download is complete and verified"
                        : "Preview this library video"}
                    >
                      <Play />
                      Preview
                    </button>
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => void bindLibraryFileLocally(selectedLibraryFile)}
                      disabled={libraryBusy || libraryCatalogStale || selectedLibraryFile.usable === false || !session?.selectedMedia}
                      title={libraryCatalogStale
                        ? "Rescan the Companion library before using this entry"
                        : selectedLibraryFile.usable === false
                        ? "This copy is still downloading or being verified"
                        : session?.selectedMedia
                          ? "Use this copy only on this device; nothing is shared"
                          : "Select a room video first"}
                    >
                      <MonitorUp />
                      Use on this device
                    </button>
                    <button
                      className="primary-button compact-button"
                      type="button"
                      onClick={() => void shareLibraryFile(selectedLibraryFile)}
                      disabled={libraryBusy || libraryCatalogStale || selectedLibraryFile.usable === false}
                      title={libraryCatalogStale
                        ? "Rescan the Companion library before sharing this entry"
                        : selectedLibraryFile.usable === false
                        ? "Sharing is available after the download is complete and verified"
                        : "Add this library video to the room and share it"}
                    >
                      <Share2 />
                      Share / Add to room
                    </button>
                  </div>
                  {selectedLibraryFile.usable === false && (
                    <p className="library-file-unavailable" role="status">
                      Still downloading or verifying. Preview, local use, and sharing will unlock when it is complete.
                    </p>
                  )}
                  {libraryPreviewUrl && (
                    <LibraryVideoPreview
                      url={libraryPreviewUrl}
                      label={selectedLibraryFile.name}
                      onReady={() => setLibraryPreviewBusy(false)}
                      onError={handleLibraryPreviewError}
                    />
                  )}
                  {libraryPreviewBusy && (
                    <p className="library-file-unavailable" role="status">
                      <LoaderCircle className="spin" /> Preparing browser-compatible preview…
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="video/*,.mkv,.m4v,.mov,.webm"
            onChange={onChooseFile}
          />
          <input
            ref={shareFileInputRef}
            className="sr-only"
            type="file"
            accept="video/*,.mkv,.m4v,.mov,.webm"
            onChange={onShareFile}
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
    <VoiceDock voice={voice} />
    </>
  );
}

function LibraryVideoPreview({
  url,
  label,
  onReady,
  onError,
}: {
  url: string;
  label: string;
  onReady: () => void;
  onError: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  }, [onError, onReady]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    let active = true;
    let instance: Hls | null = null;
    let failed = false;
    const notifyReady = () => {
      if (active) onReadyRef.current();
    };
    const notifyError = () => {
      if (!active || failed) return;
      failed = true;
      onErrorRef.current();
    };
    video.addEventListener("loadedmetadata", notifyReady);
    video.addEventListener("error", notifyError);

    if (!url.includes(".m3u8")) {
      video.src = url;
      video.load();
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.load();
    } else {
      void import("hls.js")
        .then(({ default: HlsRuntime, Events }) => {
          if (!active) return;
          if (!HlsRuntime.isSupported()) {
            notifyError();
            return;
          }
          const hls = new HlsRuntime({ enableWorker: true });
          instance = hls;
          hls.on(Events.MANIFEST_PARSED, notifyReady);
          hls.on(Events.ERROR, (_event, data) => {
            if (data.fatal) notifyError();
          });
          hls.loadSource(url);
          hls.attachMedia(video);
        })
        .catch(notifyError);
    }

    return () => {
      active = false;
      instance?.destroy();
      video.removeEventListener("loadedmetadata", notifyReady);
      video.removeEventListener("error", notifyError);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [url]);

  return (
    <video
      ref={videoRef}
      controls
      crossOrigin="anonymous"
      preload="metadata"
      aria-label={`Preview ${label}`}
    />
  );
}

interface PlayerQueueItem {
  sourceId: string;
  itemId: string;
  label: string;
  ready: boolean;
  selected: boolean;
}

interface SyncedPlayerProps {
  session: WatchSession;
  deviceId: string;
  mediaUrl: string;
  mediaPreparation: AgentPreparation | null;
  subtitleCues: SubtitleCue[];
  localSubtitleName: string;
  audioTracks: AgentAudioTrack[];
  chapters: AgentChapter[];
  queue: PlayerQueueItem[];
  onSelectVideo: (itemId: string) => Promise<void>;
  subtitleTracks: AgentSubtitleTrack[];
  subtitleStatus: AgentFile["subtitleStatus"];
  subtitleAssetStatus: NonNullable<AgentFile["subtitleAssetStatus"]>;
  subtitleError: string | null;
  subtitleAssetError: string | null;
  onBack: () => void;
  onEnded?: () => void;
  onSend: (player: PlayerState) => Promise<void>;
}

type HlsVideoRendition = "h264" | "vp9";
type PlaybackDiagnosticDetails = {
  level?: "info" | "warn" | "error";
  message?: string;
  hlsType?: string;
  hlsDetails?: string;
  fatal?: boolean;
  seekTarget?: number;
  seekSource?: string;
  roomPosition?: number;
  roomActorId?: string;
};

function preferredHlsVideoRendition(): HlsVideoRendition {
  if (typeof window === "undefined" || !window.MediaSource?.isTypeSupported) return "h264";
  if (window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')) return "h264";
  if (window.MediaSource.isTypeSupported('video/mp4; codecs="vp09.00.10.08"')) return "vp9";
  return "h264";
}

function isTrustedPlaybackUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin === AGENT_URL ||
      (url.protocol === "blob:" && url.origin === window.location.origin);
  } catch {
    return false;
  }
}

function mediaDuration(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration)) return video.duration;
  return video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
}

function finiteMediaValue(value: number | undefined) {
  return Number.isFinite(value) ? value : undefined;
}

function playbackTarget(video: HTMLVideoElement, expected: number, isHlsPlayback: boolean) {
  const target = Math.max(0, expected);
  if (!isHlsPlayback) return target;
  const ranges = Array.from({ length: video.seekable.length }, (_, index) => ({
    start: video.seekable.start(index),
    end: video.seekable.end(index),
  }));
  return clampToPreparedRanges(target, ranges);
}

function SyncedPlayer({
  session,
  deviceId,
  mediaUrl,
  mediaPreparation,
  subtitleCues,
  localSubtitleName,
  audioTracks,
  chapters,
  subtitleTracks,
  subtitleStatus,
  subtitleAssetStatus,
  subtitleError,
  subtitleAssetError,
  queue,
  onSelectVideo,
  onBack,
  onEnded,
  onSend,
}: SyncedPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const assRendererRef = useRef<import("jassub").default | null>(null);
  const subtitleOffsetRef = useRef(session.player.subtitleOffset);
  const hlsRecoveryRef = useRef(false);
  const hlsStereoFallbackPendingRef = useRef(false);
  const lastSeqRef = useRef(-1);
  const playerStateRef = useRef(session.player);
  const clockOffsetRef = useRef(0);
  const clockOffsetInitializedRef = useRef(false);
  const pendingSeekRef = useRef<LocalSeekTransaction | null>(null);
  const pendingPlaybackRef = useRef<LocalPlaybackTransaction | null>(null);
  const scrubbingRef = useRef(false);
  const controlsHideTimerRef = useRef<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState("");
  const [hlsAudioRevision, setHlsAudioRevision] = useState(0);
  const [hlsAudioModeState, setHlsAudioModeState] = useState<{
    mediaKey: string;
    mode: HlsAudioMode;
  }>({ mediaKey: "", mode: "surround" });
  const [hlsVideoRendition] = useState<HlsVideoRendition>(preferredHlsVideoRendition);
  const [subtitleText, setSubtitleText] = useState("");
  const [failedAssTrack, setFailedAssTrack] = useState("");
  const [readyAssTrack, setReadyAssTrack] = useState("");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [captionSettingsOpen, setCaptionSettingsOpen] = useState(false);
  const [switchingVideo, setSwitchingVideo] = useState(false);
  const [subtitleAppearance, setSubtitleAppearance] = useState(defaultSubtitleAppearance);
  const currentChapterIndex = chapters.findIndex(
    (chapter) => currentTime >= chapter.start && currentTime < chapter.end
  );
  const currentChapter = currentChapterIndex >= 0 ? chapters[currentChapterIndex] : null;
  const selectedVideoIndex = queue.findIndex((item) => item.selected);
  const nextVideo = selectedVideoIndex >= 0 ? queue[selectedVideoIndex + 1] : null;

  const switchVideo = async (itemId: string) => {
    const target = queue.find((item) => item.itemId === itemId);
    if (!target || target.selected || !target.ready || switchingVideo) return;
    setSwitchingVideo(true);
    setMediaLoading(true);
    setMediaError("");
    try {
      await onSelectVideo(itemId);
    } finally {
      setSwitchingVideo(false);
    }
  };

  const defaultAudioTrack = audioTracks.find((track) => track.default) || audioTracks[0];
  const requestedAudioTrackId = session.player.audioLanguage.startsWith("embedded:")
    ? session.player.audioLanguage.slice("embedded:".length)
    : "";
  const requestedAudioTrack = audioTracks.find((track) => track.id === requestedAudioTrackId);
  const audioSelection = requestedAudioTrack ? session.player.audioLanguage : "original";
  const requestedPlayerSubtitleId = session.player.subtitleLanguage.startsWith("embedded:")
    ? session.player.subtitleLanguage.slice("embedded:".length)
    : "";
  const requestedSubtitleTrack = subtitleTracks.find((track) => track.id === requestedPlayerSubtitleId);
  const hasRequestedSubtitle = Boolean(requestedSubtitleTrack);
  const expectsEmbeddedSubtitle =
    session.player.subtitleLanguage.startsWith("embedded:");
  const subtitleSelection =
    session.player.subtitleLanguage === "local" && localSubtitleName
      ? "local"
      : hasRequestedSubtitle
        ? session.player.subtitleLanguage
        : "off";
  const supportedSubtitleTracks = subtitleTracks.filter((track) => track.supported);
  const subtitleNotice = (() => {
    if (subtitleStatus === "waiting" || subtitleStatus === "probing") {
      return { message: "Detecting embedded subtitle tracks", loading: true, error: false };
    }
    if (subtitleStatus === "error") {
      return {
        message: subtitleError || "Embedded subtitle tracks could not be inspected",
        loading: false,
        error: true,
      };
    }
    if (!subtitleTracks.length) {
      return { message: "No embedded subtitles in this video", loading: false, error: false };
    }
    if (!supportedSubtitleTracks.length) {
      return {
        message: "Embedded subtitles are image-based and unavailable in the browser",
        loading: false,
        error: true,
      };
    }
    if (expectsEmbeddedSubtitle && subtitleAssetStatus === "error") {
      return {
        message: subtitleAssetError || "Selected subtitles could not be prepared",
        loading: false,
        error: true,
      };
    }
    if (
      expectsEmbeddedSubtitle &&
      (subtitleAssetStatus === "waiting" || subtitleAssetStatus === "preparing")
    ) {
      return {
        message: "Preparing " + (requestedSubtitleTrack?.label || "embedded") + " subtitles on this device",
        loading: true,
        error: false,
      };
    }
    return null;
  })();
  const playbackAudioTrack = requestedAudioTrack || defaultAudioTrack;
  const playbackAudioTrackLabel = playbackAudioTrack?.label || "";
  const playbackAudioTrackLanguage = playbackAudioTrack?.language || "";
  const playbackAudioTrackChannels = playbackAudioTrack?.channels;
  const initialHlsAudioPreference = useMemo(
    () => hlsAudioPreference(playbackAudioTrackLabel
      ? { label: playbackAudioTrackLabel, language: playbackAudioTrackLanguage }
      : null),
    [playbackAudioTrackLabel, playbackAudioTrackLanguage]
  );
  const hlsAudioMediaKey = `${mediaUrl}\n${playbackAudioTrack?.id || "original"}`;
  const hlsAudioMode: HlsAudioMode = hlsAudioModeState.mediaKey === hlsAudioMediaKey
    ? hlsAudioModeState.mode
    : "surround";
  const desiredAudioTrackIndex = playbackAudioTrack
    ? audioTracks.findIndex((track) => track.id === playbackAudioTrack.id)
    : -1;
  const playbackUrl = useMemo(() => {
    if (mediaUrl.includes("/hls/") && mediaUrl.includes(".m3u8")) {
      const hlsUrl = mediaUrl.replace(
        /\/(?:h264|vp9)\/master\.m3u8$/,
        `/${hlsVideoRendition}/master.m3u8`
      );
      return hlsAudioMode === "stereo" ? withStereoHlsAudio(hlsUrl) : hlsUrl;
    }
    if (hlsVideoRendition === "vp9" && mediaUrl.startsWith(AGENT_URL)) {
      const url = new URL(mediaUrl);
      const stream = /^\/stream\/([a-zA-Z0-9-]{8,80})\/(\d+)$/.exec(url.pathname);
      if (stream) {
        url.pathname = `/hls/${stream[1]}/${stream[2]}/vp9/master.m3u8`;
        url.search = "";
        const hlsUrl = url.toString();
        return hlsAudioMode === "stereo" ? withStereoHlsAudio(hlsUrl) : hlsUrl;
      }
    }
    if (!mediaUrl || !requestedAudioTrack) return mediaUrl;
    const url = new URL(mediaUrl);
    url.searchParams.set("audio", requestedAudioTrack.id);
    return url.toString();
  }, [hlsAudioMode, hlsVideoRendition, mediaUrl, requestedAudioTrack]);
  const isHlsPlayback = playbackUrl.includes("/hls/") && playbackUrl.includes(".m3u8");
  const preparedThrough =
    mediaPreparation?.contiguousReadySeconds ??
    mediaPreparation?.bufferedSeconds ??
    0;
  const roomPlaybackPosition = Math.max(session.player.position, currentTime);
  const preparationError = mediaPreparation?.error || "";
  const visibleMediaError = mediaError || (mediaLoading ? preparationError : "");
  const mediaWaitingMessage = !mediaUrl
    ? "Preparing selected video"
    : !isHlsPlayback
      ? "Preparing video for this browser"
      : hlsAudioMode === "stereo"
        ? "Preparing stereo compatibility audio"
      : mediaPreparation?.complete
        ? "Buffering prepared video"
        : preparedThrough > 0 && roomPlaybackPosition >= preparedThrough - 1
          ? "Preparing " + formatTime(roomPlaybackPosition) +
            ", ready through " + formatTime(preparedThrough)
          : preparedThrough > 0
            ? "Buffering video, ready through " + formatTime(preparedThrough)
            : "Preparing the first video window";

  const reportPlaybackEvent = useCallback(
    (event: string, details: PlaybackDiagnosticDetails = {}) => {
      if (!playbackUrl.startsWith(AGENT_URL)) return;
      const video = videoRef.current;
      let playbackPath = "";
      try {
        playbackPath = new URL(playbackUrl).pathname;
      } catch {
        // Ignore malformed URLs while the selected media is changing.
      }
      let seekableStart: number | undefined;
      let seekableEnd: number | undefined;
      let bufferedStart: number | undefined;
      let bufferedEnd: number | undefined;
      if (video?.seekable.length) {
        seekableStart = video.seekable.start(0);
        seekableEnd = video.seekable.end(video.seekable.length - 1);
      }
      if (video?.buffered.length) {
        bufferedStart = video.buffered.start(0);
        bufferedEnd = video.buffered.end(video.buffered.length - 1);
      }
      void reportAgentPlaybackEvent({
        event,
        ...details,
        playbackPath,
        readyState: video?.readyState,
        networkState: video?.networkState,
        mediaErrorCode: video?.error?.code,
        currentTime: finiteMediaValue(video?.currentTime),
        duration: finiteMediaValue(video?.duration),
        paused: video?.paused,
        seekableStart: finiteMediaValue(seekableStart),
        seekableEnd: finiteMediaValue(seekableEnd),
        bufferedStart: finiteMediaValue(bufferedStart),
        bufferedEnd: finiteMediaValue(bufferedEnd),
        userAgent: navigator.userAgent,
      });
    },
    [playbackUrl]
  );
  const assTrackKey = requestedSubtitleTrack?.assUrl || "";
  const assFontKey = (requestedSubtitleTrack?.fonts || []).map((font) => font.url).join("|");
  const assFontUrls = useMemo(() => assFontKey ? assFontKey.split("|") : [], [assFontKey]);
  const wantsOriginalAss = Boolean(
    subtitleSelection !== "off" &&
    requestedSubtitleTrack?.styled &&
    assTrackKey &&
    subtitleAppearance.originalAssStyling &&
    failedAssTrack !== assTrackKey
  );
  const useOriginalAss = wantsOriginalAss && readyAssTrack === assTrackKey;

  useEffect(() => {
    const timer = window.setTimeout(() => setSubtitleAppearance(readSubtitleAppearance()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !wantsOriginalAss || !assTrackKey) return;

    let active = true;
    const controller = new AbortController();
    let renderer: import("jassub").default | null = null;
    let workerFailed: (() => void) | null = null;
    setReadyAssTrack("");
    void Promise.all([
      import("jassub"),
      getAgentSubtitle(assTrackKey, controller.signal),
      mapWithConcurrency(assFontUrls, 2, (url) => getAgentSubtitleBytes(url, controller.signal)),
    ])
      .then(([{ default: JASSUB }, subContent, fonts]) => {
        if (!active) return null;
        renderer = new JASSUB({
          video,
          subContent,
          fonts,
          queryFonts: false,
          timeOffset: -subtitleOffsetRef.current / 1000,
          maxRenderHeight: 1080,
          libassMemoryLimit: 96,
          libassGlyphLimit: 48,
        });
        workerFailed = () => {
          if (!active) return;
          setReadyAssTrack("");
          setFailedAssTrack(assTrackKey);
        };
        renderer._worker.addEventListener("error", workerFailed, { once: true });
        renderer._worker.addEventListener("messageerror", workerFailed, { once: true });
        assRendererRef.current = renderer;
        return renderer.ready;
      })
      .then(() => {
        if (!active || !renderer) return;
        setReadyAssTrack(assTrackKey);
        return renderer.resize(true);
      })
      .catch((caught) => {
        if (!active || controller.signal.aborted) return;
        console.error("Could not render ASS subtitles", caught);
        setReadyAssTrack("");
        setFailedAssTrack(assTrackKey);
      });

    return () => {
      active = false;
      controller.abort();
      setReadyAssTrack((current) => current === assTrackKey ? "" : current);
      if (assRendererRef.current === renderer) assRendererRef.current = null;
      if (renderer && workerFailed) {
        renderer._worker.removeEventListener("error", workerFailed);
        renderer._worker.removeEventListener("messageerror", workerFailed);
      }
      if (renderer) void renderer.destroy().catch(() => {});
    };
  }, [assFontUrls, assTrackKey, wantsOriginalAss]);

  useEffect(() => {
    subtitleOffsetRef.current = session.player.subtitleOffset;
    const renderer = assRendererRef.current;
    if (!renderer) return;
    renderer.timeOffset = -session.player.subtitleOffset / 1000;
    void renderer.resize(true);
  }, [session.player.subtitleOffset]);

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

  const activateHlsStereoFallback = useCallback((message: string, hlsDetails: string) => {
    if (hlsStereoFallbackPendingRef.current) return;
    hlsStereoFallbackPendingRef.current = true;
    hlsRecoveryRef.current = true;
    hlsRef.current?.stopLoad();
    reportPlaybackEvent("hls_surround_audio_fallback", {
      level: "warn",
      message,
      hlsDetails,
    });
    setHlsAudioModeState({ mediaKey: hlsAudioMediaKey, mode: "stereo" });
    setMediaLoading(true);
    setNeedsGesture(false);
    setMediaError("");
    pinControls();
  }, [hlsAudioMediaKey, pinControls, reportPlaybackEvent]);

  const handlePlaybackFailure = useCallback(
    (caught: unknown) => {
      const video = videoRef.current;
      const exception = caught instanceof DOMException ? caught : null;
      const transient =
        exception &&
        ["AbortError", "NotSupportedError"].includes(exception.name) &&
        (!video?.currentSrc || (video?.readyState ?? 0) < HTMLMediaElement.HAVE_METADATA);
      if (transient) {
        setMediaLoading(true);
        reportPlaybackEvent(
          "playback_not_ready",
          { level: "info", message: exception.message || exception.name }
        );
        return;
      }
      const autoplayBlocked = exception?.name === "NotAllowedError";
      if (autoplayBlocked) {
        setNeedsGesture(true);
        reportPlaybackEvent("playback_gesture_required", { level: "info", message: exception.message });
      } else {
        setNeedsGesture(false);
        setMediaLoading(false);
        const message = mediaUrl.startsWith(AGENT_URL)
          ? "The companion could not prepare this video for browser playback."
          : "This video could not be prepared for browser playback.";
        setMediaError(message);
        reportPlaybackEvent("playback_rejected", {
          level: "error",
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
      pinControls();
    },
    [mediaUrl, pinControls, reportPlaybackEvent]
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setMediaLoading(true);
    setMediaError("");
    setNeedsGesture(false);
    pendingSeekRef.current = null;
    pendingPlaybackRef.current = null;
    scrubbingRef.current = false;
    hlsRecoveryRef.current = false;
    hlsStereoFallbackPendingRef.current = false;

    const fail = (message: string) => {
      setMediaLoading(false);
      setNeedsGesture(false);
      setMediaError(message);
      pinControls();
    };

    if (!playbackUrl) {
      video.removeAttribute("src");
      video.load();
      return () => {
        video.removeAttribute("src");
      };
    }

    if (!isTrustedPlaybackUrl(playbackUrl)) {
      fail("The selected video returned an invalid playback address.");
      video.removeAttribute("src");
      video.load();
      return;
    }

    if (!isHlsPlayback) {
      video.src = playbackUrl;
      video.load();
      return () => {
        video.removeAttribute("src");
      };
    }

    let active = true;
    let instance: Hls | null = null;
    let networkRecoveryTimer: number | null = null;
    let networkRecoveryAttempts = 0;
    void import("hls.js")
      .then(({ default: HlsRuntime, ErrorTypes, Events }) => {
        if (!active) return;
        if (HlsRuntime.isSupported()) {
          const hls = new HlsRuntime({
            enableWorker: true,
            backBufferLength: 90,
            maxBufferLength: 60,
            manifestLoadingTimeOut: 65_000,
            levelLoadingTimeOut: 65_000,
            audioPreference: initialHlsAudioPreference,
          });
          instance = hls;
          hlsRef.current = hls;
          hls.on(Events.MANIFEST_PARSED, () => {
            reportPlaybackEvent("hls_manifest_parsed", { level: "info" });
          });
          hls.on(Events.FRAG_LOADED, () => {
            networkRecoveryAttempts = 0;
          });
          hls.on(Events.AUDIO_TRACKS_UPDATED, () => {
            if (
              desiredAudioTrackIndex >= 0 &&
              hls.audioTracks.length > desiredAudioTrackIndex &&
              hls.audioTrack !== desiredAudioTrackIndex
            ) {
              hls.audioTrack = desiredAudioTrackIndex;
            }
            setHlsAudioRevision((revision) => revision + 1);
          });
          hls.on(Events.ERROR, (_event, data: ErrorData) => {
            if (!data.fatal) return;
            if (
              data.type === ErrorTypes.NETWORK_ERROR &&
              playbackUrl.startsWith(AGENT_URL) &&
              networkRecoveryAttempts < 12
            ) {
              if (networkRecoveryTimer !== null) return;
              networkRecoveryAttempts += 1;
              const retryDelayMs = Math.min(
                5_000,
                500 * (2 ** Math.min(networkRecoveryAttempts - 1, 4))
              );
              reportPlaybackEvent(
                "hls_network_error_retry",
                {
                  level: "warn",
                  message: data.error?.message || String(data.details),
                  hlsType: String(data.type),
                  hlsDetails: `${String(data.details)}; retry ${networkRecoveryAttempts} in ${retryDelayMs}ms`,
                  fatal: false,
                }
              );
              setMediaLoading(true);
              setMediaError("");
              networkRecoveryTimer = window.setTimeout(() => {
                networkRecoveryTimer = null;
                if (!active || instance !== hls) return;
                hls.stopLoad();
                hls.loadSource(playbackUrl);
              }, retryDelayMs);
              return;
            }
            if (
              data.type === ErrorTypes.MEDIA_ERROR &&
              shouldRetryHlsWithStereo({
                isHlsPlayback,
                fatalHlsMediaError: data.fatal,
                sourceChannels: resolveHlsAudioChannelCount(
                  hls.audioTracks[hls.audioTrack]?.channels,
                  playbackAudioTrackChannels
                ),
                audioMode: hlsAudioMode,
              })
            ) {
              const message = data.error?.message || String(data.details);
              const activeAudioChannels = resolveHlsAudioChannelCount(
                hls.audioTracks[hls.audioTrack]?.channels,
                playbackAudioTrackChannels
              );
              activateHlsStereoFallback(
                message,
                `${String(data.details)}; retrying ${activeAudioChannels}-channel audio as stereo`
              );
              return;
            }
            if (data.type === ErrorTypes.MEDIA_ERROR && !hlsRecoveryRef.current) {
              reportPlaybackEvent(
                "hls_media_error_recovery",
                {
                  level: "warn",
                  message: data.error?.message || String(data.details),
                  hlsType: String(data.type),
                  hlsDetails: String(data.details),
                  fatal: true,
                }
              );
              hlsRecoveryRef.current = true;
              hls.recoverMediaError();
              return;
            }
            reportPlaybackEvent(
              "hls_fatal_error",
              {
                level: "error",
                message: data.error?.message || String(data.details),
                hlsType: String(data.type),
                hlsDetails: String(data.details),
                fatal: true,
              }
            );

            const detail = data.error?.message ? ` ${data.error.message}` : "";
            fail(
              data.type === ErrorTypes.NETWORK_ERROR
                ? "The companion could not create browser-ready video segments." + detail
                : "This browser could not decode the prepared video segments." + detail
            );
          });
          hls.loadSource(playbackUrl);
          hls.attachMedia(video);
          return;
        }

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = playbackUrl;
          video.load();
          return;
        }

        reportPlaybackEvent("hls_unsupported", { level: "error" });
        fail("This browser does not support progressive HLS playback.");
      })
      .catch((caught) => {
        if (active) {
          const message = caught instanceof Error ? caught.message : "The streaming player could not be loaded.";
          reportPlaybackEvent("hls_loader_failed", { level: "error", message });
          fail(message);
        }
      });

    return () => {
      active = false;
      if (networkRecoveryTimer !== null) window.clearTimeout(networkRecoveryTimer);
      if (hlsRef.current === instance) hlsRef.current = null;
      instance?.destroy();
      video.removeAttribute("src");
    };
  }, [
    activateHlsStereoFallback,
    hlsAudioMode,
    desiredAudioTrackIndex,
    initialHlsAudioPreference,
    isHlsPlayback,
    pinControls,
    playbackAudioTrackChannels,
    playbackUrl,
    reportPlaybackEvent,
  ]);

  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls || desiredAudioTrackIndex < 0) return;
    if (hls.audioTracks.length <= desiredAudioTrackIndex) return;
    if (hls.audioTrack !== desiredAudioTrackIndex) {
      hls.audioTrack = desiredAudioTrackIndex;
    }
  }, [desiredAudioTrackIndex, hlsAudioRevision]);

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
        ...playerStateRef.current,
        paused: video?.paused ?? playerStateRef.current.paused,
        position: video?.currentTime ?? playerStateRef.current.position,
        ...values,
      });
    },
    [onSend]
  );

  useEffect(() => {
    const pendingPlayback = pendingPlaybackRef.current;
    if (pendingPlayback && isPlaybackAcknowledgement(pendingPlayback, session.player, deviceId)) {
      pendingPlaybackRef.current = null;
      reportPlaybackEvent("playback_acknowledged", {
        level: "info",
        roomPosition: session.player.position,
        roomActorId: session.player.actorId,
      });
    }
    const pending = pendingSeekRef.current;
    if (pending && isSeekAcknowledgement(pending, session.player, deviceId)) {
      pendingSeekRef.current = null;
      scrubbingRef.current = false;
      reportPlaybackEvent("seek_acknowledged", {
        level: "info",
        seekTarget: pending.target,
        seekSource: pending.source,
        roomPosition: session.player.position,
        roomActorId: session.player.actorId,
      });
    }
    playerStateRef.current = session.player;
    const sample = session.serverTime - Date.now();
    if (clockOffsetInitializedRef.current) {
      clockOffsetRef.current = clockOffsetRef.current * 0.8 + sample * 0.2;
    } else {
      clockOffsetRef.current = sample;
      clockOffsetInitializedRef.current = true;
    }
  }, [deviceId, reportPlaybackEvent, session.player, session.serverTime]);

  const synchronizePlayback = useCallback((state: PlayerState) => {
    const video = videoRef.current;
    if (!video || !video.currentSrc || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const pendingPlayback = pendingPlaybackRef.current;
    let holdLocalPlayback = false;
    if (pendingPlayback) {
      if (isPlaybackAcknowledgement(pendingPlayback, state, deviceId)) {
        pendingPlaybackRef.current = null;
        reportPlaybackEvent("playback_acknowledged", {
          level: "info",
          roomPosition: state.position,
          roomActorId: state.actorId,
        });
      } else if (shouldHoldLocalPlayback(pendingPlayback, state, deviceId)) {
        holdLocalPlayback = true;
        if (!pendingPlayback.suppressionReported) {
          pendingPlayback.suppressionReported = true;
          reportPlaybackEvent("playback_remote_sync_deferred", {
            level: "info",
            roomPosition: state.position,
            roomActorId: state.actorId,
          });
        }
      } else {
        pendingPlaybackRef.current = null;
        reportPlaybackEvent("playback_acknowledgement_timeout", {
          level: "warn",
          roomPosition: state.position,
          roomActorId: state.actorId,
        });
      }
    }
    const pending = pendingSeekRef.current;
    if (pending) {
      if (isSeekAcknowledgement(pending, state, deviceId)) {
        pendingSeekRef.current = null;
        scrubbingRef.current = false;
        reportPlaybackEvent("seek_acknowledged", {
          level: "info",
          seekTarget: pending.target,
          seekSource: pending.source,
          roomPosition: state.position,
          roomActorId: state.actorId,
        });
      } else if (shouldHoldLocalSeek(pending, state, deviceId)) {
        if (!pending.suppressionReported) {
          pending.suppressionReported = true;
          reportPlaybackEvent("seek_remote_sync_deferred", {
            level: "info",
            seekTarget: pending.target,
            seekSource: pending.source,
            roomPosition: state.position,
            roomActorId: state.actorId,
          });
        }
        return;
      } else {
        pendingSeekRef.current = null;
        scrubbingRef.current = false;
        reportPlaybackEvent("seek_acknowledgement_timeout", {
          level: "warn",
          seekTarget: pending.target,
          seekSource: pending.source,
          roomPosition: state.position,
          roomActorId: state.actorId,
        });
      }
    }
    const serverNow = Date.now() + clockOffsetRef.current;
    const expected = holdLocalPlayback
      ? video.currentTime
      : state.paused
        ? state.position
        : state.position + ((serverNow - state.changedAt) / 1000) * state.playbackRate;
    const target = playbackTarget(video, expected, isHlsPlayback);
    if (target > expected && video.currentTime < target) video.currentTime = target;
    const drift = target - video.currentTime;

    if (Math.abs(drift) > 0.75) {
      video.currentTime = target;
    } else if (!state.paused && Math.abs(drift) > 0.2) {
      video.playbackRate = Math.max(0.5, Math.min(2, state.playbackRate + Math.sign(drift) * 0.05));
      window.setTimeout(() => {
        if (videoRef.current) videoRef.current.playbackRate = state.playbackRate;
      }, 1_200);
    } else {
      video.playbackRate = state.playbackRate;
    }

    if (!holdLocalPlayback && state.paused && !video.paused) {
      video.pause();
    } else if (!holdLocalPlayback && !state.paused && video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      void video
        .play()
        .then(() => setNeedsGesture(false))
        .catch(handlePlaybackFailure);
    }
  }, [deviceId, handlePlaybackFailure, isHlsPlayback, reportPlaybackEvent]);

  useEffect(() => {
    if (lastSeqRef.current === session.seq) return;
    lastSeqRef.current = session.seq;
    synchronizePlayback(session.player);
  }, [session.player, session.seq, synchronizePlayback]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      synchronizePlayback(playerStateRef.current);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [synchronizePlayback]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      setCurrentTime(video.currentTime);
      const sourceDuration = Number(mediaPreparation?.sourceDuration);
      setDuration(Math.max(
        mediaDuration(video),
        Number.isFinite(sourceDuration) ? sourceDuration : 0
      ));

      if (session.player.subtitleLanguage === "off" || !subtitleCues.length) {
        setSubtitleText("");
        return;
      }
      const subtitleTime = video.currentTime - session.player.subtitleOffset / 1000;
      const cues = subtitleCues.filter((item) => subtitleTime >= item.start && subtitleTime <= item.end);
      setSubtitleText(cues.map((cue) => cue.text).join("\n"));
    }, 120);

    return () => window.clearInterval(timer);
  }, [
    mediaPreparation?.sourceDuration,
    session.player.subtitleLanguage,
    session.player.subtitleOffset,
    subtitleCues,
  ]);

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    const paused = !video.paused;
    const transaction: LocalPlaybackTransaction = {
      paused,
      startedAt: Date.now(),
      suppressionReported: false,
    };
    pendingPlaybackRef.current = transaction;
    const publish = send({ paused, position: video.currentTime });
    void publish.catch(() => {});
    if (!paused) {
      try {
        await video.play();
        setNeedsGesture(false);
        setMediaError("");
      } catch (caught) {
        if (pendingPlaybackRef.current === transaction) pendingPlaybackRef.current = null;
        void publish
          .then(() => send({ paused: true, position: video.currentTime }))
          .catch(() => {});
        handlePlaybackFailure(caught);
        return;
      }
    } else {
      video.pause();
    }
    try {
      await publish;
    } catch (caught) {
      if (pendingPlaybackRef.current === transaction) pendingPlaybackRef.current = null;
      reportPlaybackEvent("playback_request_failed", {
        level: "error",
        message: caught instanceof Error ? caught.message : String(caught),
      });
      synchronizePlayback(playerStateRef.current);
    }
  }

  const stageSeek = useCallback((value: number, source: string) => {
    const video = videoRef.current;
    if (!video) return;
    const target = clampSeekTarget(value, mediaDuration(video));
    const current = pendingSeekRef.current;
    pendingSeekRef.current = {
      target,
      startedAt: current && !current.committed ? current.startedAt : Date.now(),
      committed: false,
      source,
      suppressionReported: current?.suppressionReported ?? false,
    };
    video.currentTime = target;
    setCurrentTime(target);
  }, []);

  const commitSeek = useCallback(() => {
    scrubbingRef.current = false;
    const video = videoRef.current;
    const transaction = pendingSeekRef.current;
    if (!video || !transaction || transaction.committed) return;
    transaction.committed = true;
    transaction.startedAt = Date.now();
    transaction.suppressionReported = false;
    reportPlaybackEvent("seek_requested", {
      level: "info",
      seekTarget: transaction.target,
      seekSource: transaction.source,
      roomPosition: playerStateRef.current.position,
      roomActorId: playerStateRef.current.actorId,
    });
    void send({ position: transaction.target, paused: video.paused }).catch((caught) => {
      if (pendingSeekRef.current === transaction) pendingSeekRef.current = null;
      reportPlaybackEvent("seek_request_failed", {
        level: "error",
        message: caught instanceof Error ? caught.message : String(caught),
        seekTarget: transaction.target,
        seekSource: transaction.source,
        roomPosition: playerStateRef.current.position,
        roomActorId: playerStateRef.current.actorId,
      });
      synchronizePlayback(playerStateRef.current);
    });
  }, [reportPlaybackEvent, send, synchronizePlayback]);

  const finishSeek = useCallback(() => {
    scrubbingRef.current = false;
    window.setTimeout(commitSeek, 0);
  }, [commitSeek]);

  const seekImmediately = useCallback((value: number, source: string) => {
    stageSeek(value, source);
    commitSeek();
  }, [commitSeek, stageSeek]);

  const seekToChapter = useCallback((index: number) => {
    const chapter = chapters[index];
    if (!chapter) return;
    seekImmediately(chapter.start, "chapter");
  }, [chapters, seekImmediately]);

  const previousChapter = () => {
    if (!chapters.length) return;
    const current = currentChapterIndex >= 0 ? currentChapterIndex : 0;
    const restartCurrent = currentChapter && currentTime > currentChapter.start + 3;
    seekToChapter(restartCurrent ? current : Math.max(0, current - 1));
  };

  const nextChapter = () => {
    if (!chapters.length) return;
    const current = currentChapterIndex >= 0 ? currentChapterIndex : -1;
    seekToChapter(Math.min(chapters.length - 1, current + 1));
  };

  useEffect(() => {
    const finishPointerSeek = () => {
      if (scrubbingRef.current) finishSeek();
    };
    window.addEventListener("pointerup", finishPointerSeek);
    window.addEventListener("pointercancel", finishPointerSeek);
    return () => {
      window.removeEventListener("pointerup", finishPointerSeek);
      window.removeEventListener("pointercancel", finishPointerSeek);
    };
  }, [finishSeek]);

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
        event.preventDefault();
        seekImmediately(
          video.currentTime + (event.key === "ArrowRight" ? 10 : -10),
          "keyboard"
        );
      } else if (event.key.toLowerCase() === "f") {
        void playerRef.current?.requestFullscreen();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

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
        playsInline
        onLoadStart={() => {
          setMediaLoading(true);
          setMediaError("");
        }}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(mediaDuration(video));
          setMediaLoading(false);
          setMediaError("");
          const expected = session.player.paused
            ? session.player.position
            : session.player.position + ((Date.now() - session.player.changedAt) / 1000) * session.player.playbackRate;
          video.currentTime = playbackTarget(video, expected, isHlsPlayback);
          reportPlaybackEvent("media_metadata_loaded", { level: "info" });
          synchronizePlayback(playerStateRef.current);
        }}
        onCanPlay={() => {
          setMediaLoading(false);
          reportPlaybackEvent("media_can_play", { level: "info" });
          synchronizePlayback(playerStateRef.current);
        }}
        onPlaying={() => setMediaLoading(false)}
        onWaiting={() => setMediaLoading(true)}
        onSeeking={() => {
          const pending = pendingSeekRef.current;
          reportPlaybackEvent("media_seeking", {
            level: "info",
            seekTarget: pending?.target,
            seekSource: pending?.source,
            roomPosition: playerStateRef.current.position,
            roomActorId: playerStateRef.current.actorId,
          });
        }}
        onSeeked={() => {
          const pending = pendingSeekRef.current;
          reportPlaybackEvent("media_seeked", {
            level: "info",
            seekTarget: pending?.target,
            seekSource: pending?.source,
            roomPosition: playerStateRef.current.position,
            roomActorId: playerStateRef.current.actorId,
          });
        }}
        onError={(event) => {
          const error = event.currentTarget.error;
          const message = error?.message || "HTML media element reported an error.";
          const activeAudioChannels = resolveHlsAudioChannelCount(
            hlsRef.current?.audioTracks[hlsRef.current.audioTrack]?.channels,
            playbackAudioTrackChannels
          );
          reportPlaybackEvent("media_element_error", { level: "error", message });
          if (shouldRetryHlsWithStereo({
            isHlsPlayback,
            mediaErrorCode: error?.code,
            sourceChannels: activeAudioChannels,
            audioMode: hlsAudioMode,
          })) {
            activateHlsStereoFallback(
              message,
              `Native MediaError ${error?.code}; retrying ${activeAudioChannels}-channel audio as stereo`
            );
            return;
          }
          setMediaLoading(false);
          setNeedsGesture(false);
          setMediaError(
            isHlsPlayback && error?.code === 4
              ? "This browser could not decode the prepared video or audio track."
              : mediaUrl.startsWith(AGENT_URL)
              ? "The companion could not prepare this video for browser playback."
              : "This video format could not be opened by the browser."
          );
          pinControls();
        }}
        onEnded={() => {
          if (isHlsPlayback && mediaPreparation?.complete === false) {
            setMediaLoading(true);
            reportPlaybackEvent("hls_window_exhausted", {
              level: "info",
              seekTarget: roomPlaybackPosition,
              message: "Playback reached the current committed HLS window.",
            });
            return;
          }
          if (onEnded) void send({ paused: true, position: duration }).then(onEnded);
        }}
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
        <div className="player-top-actions">
          <label className="player-video-select" title="Playlist">
            <ListVideo />
            <select
              value={queue.find((item) => item.selected)?.itemId || ""}
              onChange={(event) => {
                const selected = queue[event.currentTarget.selectedIndex];
                if (selected) void switchVideo(selected.itemId);
              }}
              disabled={switchingVideo}
              aria-label="Select video"
            >
              {queue.map((item) => (
                <option key={item.itemId} value={item.itemId} disabled={!item.ready}>
                  {item.label}{item.ready ? "" : " (preparing)"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="player-icon-button"
            onClick={() => { if (nextVideo) void switchVideo(nextVideo.itemId); }}
            disabled={!nextVideo?.ready || switchingVideo}
            title={nextVideo?.ready ? "Next video" : "Next video is still preparing"}
            aria-label="Next video"
          >
            {switchingVideo ? <LoaderCircle className="spin" /> : <SkipForward />}
          </button>
          <div className="player-avatars">
            {session.participants.slice(0, 4).map((participant) => (
              <span key={participant.deviceId} title={participant.name}>
                {participant.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      </div>

      {subtitleText && !useOriginalAss && (
        <div className="subtitle-overlay">
          <div className="subtitle-window" style={subtitleStyle}>
            {subtitleText.split("\n").map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}
          </div>
        </div>
      )}

      {(mediaLoading || visibleMediaError) && !needsGesture && (
        <div
          className={"media-state-overlay" + (visibleMediaError ? " error" : "")}
          role={visibleMediaError ? "alert" : "status"}
        >
          {visibleMediaError ? <X /> : <LoaderCircle className="spin" />}
          <strong>{visibleMediaError || mediaWaitingMessage}</strong>
          {visibleMediaError && (
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
        {subtitleNotice && (
          <div
            className={"subtitle-readiness" + (subtitleNotice.error ? " error" : "")}
            role={subtitleNotice.error ? "alert" : "status"}
          >
            {subtitleNotice.loading
              ? <LoaderCircle className="spin" />
              : subtitleNotice.error ? <X /> : <Subtitles />}
            <span>{subtitleNotice.message}</span>
          </div>
        )}
        {captionSettingsOpen && (
          <section className="caption-settings" role="dialog" aria-label="Caption options">
            <header className="caption-settings-header">
              <strong>Caption options</strong>
              <button type="button" className="caption-reset-button" onClick={resetSubtitleAppearance}>
                <RotateCcw />
                Reset
              </button>
            </header>

            {requestedSubtitleTrack?.styled && (
              <label className="caption-ass-mode">
                <input
                  type="checkbox"
                  checked={subtitleAppearance.originalAssStyling}
                  onChange={(event) => {
                    if (event.target.checked) setFailedAssTrack("");
                    updateSubtitleAppearance({ originalAssStyling: event.target.checked });
                  }}
                />
                <span>Original ASS styling</span>
              </label>
            )}

            {(!requestedSubtitleTrack?.styled || !subtitleAppearance.originalAssStyling) && (
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
            )}
          </section>
        )}

        <div className="timeline-wrap">
          <input
            className="timeline"
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={Math.min(currentTime, duration || 0)}
            onPointerDown={() => {
              scrubbingRef.current = true;
            }}
            onChange={(event) => stageSeek(Number(event.target.value), "timeline")}
            onPointerUp={finishSeek}
            onPointerCancel={finishSeek}
            onBlur={commitSeek}
            onKeyUp={commitSeek}
            aria-label="Seek"
            style={{ "--progress": `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties}
          />
          {duration > 0 && chapters.slice(1).map((chapter) => (
            <button
              key={chapter.id}
              type="button"
              className="chapter-marker"
              style={{ left: `${Math.min(100, (chapter.start / duration) * 100)}%` }}
              onClick={() => seekToChapter(chapter.index)}
              title={`${chapter.title} · ${formatTime(chapter.start)}`}
              aria-label={`Go to ${chapter.title} at ${formatTime(chapter.start)}`}
            />
          ))}
        </div>

        <div className="control-row">
          <div className="control-cluster">
            <button className="player-icon-button main-play" onClick={togglePlayback} title={session.player.paused ? "Play" : "Pause"} aria-label={session.player.paused ? "Play" : "Pause"}>
              {session.player.paused ? <Play fill="currentColor" /> : <Pause fill="currentColor" />}
            </button>
            {chapters.length > 0 && (
              <div className="chapter-controls">
                <button className="player-icon-button" onClick={previousChapter} title="Previous chapter" aria-label="Previous chapter">
                  <SkipBack />
                </button>
                <label className="chapter-select" title="Video chapters">
                  <select
                    value={currentChapterIndex >= 0 ? currentChapterIndex : 0}
                    onChange={(event) => seekToChapter(Number(event.target.value))}
                    aria-label="Video chapter"
                  >
                    {chapters.map((chapter) => (
                      <option key={chapter.id} value={chapter.index}>
                        {chapter.title} · {formatTime(chapter.start)}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="player-icon-button" onClick={nextChapter} title="Next chapter" aria-label="Next chapter">
                  <SkipForward />
                </button>
              </div>
            )}
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
                {(subtitleStatus === "waiting" || subtitleStatus === "probing") && (
                  <option value="subtitle-status" disabled>Detecting embedded subtitles...</option>
                )}
                {subtitleStatus === "ready" && !subtitleTracks.length && (
                  <option value="subtitle-empty" disabled>No embedded subtitles</option>
                )}
                {subtitleStatus === "error" && (
                  <option value="subtitle-error" disabled>Embedded subtitles unavailable</option>
                )}
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

async function createVerifiedLibraryBinding(
  selectedMedia: NonNullable<WatchSession["selectedMedia"]>,
  roomSource: WatchSession["sources"][number] | null,
  canonicalJob: AgentJob | undefined
) {
  const roomItem = roomSource?.mediaItems?.find((item) =>
    (selectedMedia.itemId ? item.id === selectedMedia.itemId : true) &&
    (selectedMedia.fileIndex === undefined || item.fileIndex === selectedMedia.fileIndex)
  ) || null;
  const infoHash = roomSource?.infoHash || canonicalJob?.infoHash;
  if (!selectedMedia.fingerprint && !infoHash) return null;
  if (
    !selectedMedia.fingerprint &&
    !Number.isInteger(selectedMedia.fileIndex ?? roomItem?.fileIndex) &&
    !roomItem?.path
  ) return null;
  const libraryFile = await matchAgentLibraryFile({
    fingerprint: selectedMedia.fingerprint,
    infoHash,
    size: selectedMedia.size,
    fileIndex: selectedMedia.fileIndex ?? roomItem?.fileIndex,
    relativePath: roomItem?.path,
  });
  if (!libraryFile) return null;

  const sourceId = `local-${crypto.randomUUID()}`;
  try {
    const job = await attachAgentLibraryFile(sourceId, libraryFile.id, libraryFile.name);
    const file = preferredAgentFile(job, selectedMedia);
    const fingerprint = file ? agentFileFingerprint(job, file) : null;
    const verified = file && fingerprint && isVerifiedLibraryMatch(
      selectedMedia,
      fingerprint,
      file.size,
      {
        selectedInfoHash: infoHash,
        libraryInfoHash: libraryFile.infoHash,
        selectedFileIndex: selectedMedia.fileIndex ?? roomItem?.fileIndex,
        libraryFileIndex: libraryFile.torrentFileIndex ?? libraryFile.fileIndex,
        selectedPath: roomItem?.path,
        libraryPath: libraryFile.relativePath,
      }
    );
    if (!file || !verified) {
      throw new Error("The companion library match did not pass identity verification.");
    }
    return { sourceId, job, file };
  } catch (error) {
    await stopAgentDownload(sourceId, false).catch(() => {});
    throw error;
  }
}

function agentJobIsPaused(job: AgentJob) {
  return Boolean(job.paused || job.status === "paused");
}

function torrentSummaryTitle(job: AgentJob) {
  const torrent = job.torrent;
  if (!torrent) {
    return `Torrent TCP ${job.torrentPort || "dynamic"}, DHT UDP ${job.dhtPort || "dynamic"}`;
  }
  const reportedSeeds = torrent.trackerReportedSeeders === null
    ? "tracker seeders unknown"
    : `${torrent.trackerReportedSeeders} tracker-reported seed${torrent.trackerReportedSeeders === 1 ? "" : "s"}`;
  return `${torrent.connectedPeers} connected peer${torrent.connectedPeers === 1 ? "" : "s"}, ${torrent.connectedSeeds} connected seed${torrent.connectedSeeds === 1 ? "" : "s"}; ${reportedSeeds}; ${torrent.respondingTrackers}/${torrent.configuredTrackers} trackers responding`;
}
