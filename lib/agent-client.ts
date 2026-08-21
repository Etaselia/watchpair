import type { SharedSource } from "./session-types";
import { fetchPreparedAgentAsset } from "./agent-subtitle-fetch.mjs";

export const AGENT_URL = "http://127.0.0.1:41735";
export const AGENT_PROTOCOL_VERSION = 2;

export type AgentPermissionState = PermissionState | "unsupported";

export async function getAgentPermissionState(): Promise<AgentPermissionState> {
  if (!("permissions" in navigator)) return "unsupported";
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      return (await navigator.permissions.query({ name: name as PermissionName })).state;
    } catch {
      // Try the permission name used by the previous Chrome generation.
    }

  }
  return "unsupported";
}

export async function waitForAgentSeed(
  sourceId: string,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
) {
  while (true) {
    if (signal?.aborted) throw new DOMException("Torrent creation cancelled", "AbortError");
    const job = await getAgentDownload(sourceId);
    onProgress?.(100 + Math.min(100, Math.max(0, job.creationProgress || 0)));
    if (job.status === "error") throw new Error(job.error || "Could not create the torrent.");
    if (job.status === "ready") {
      // Compatibility with companion builds from before publication magnets
      // were split out of the privacy-redacted download snapshot.
      if (job.magnetURI) return { job, magnetURI: job.magnetURI };
      const magnetURI = await getAgentSeedPublication(sourceId, signal);
      if (magnetURI) return { job, magnetURI };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
}

export interface AgentFile {
  index: number;
  itemId: string;
  path: string;
  name: string;
  size: number;
  duration?: number | null;
  downloaded: number;
  progress: number;
  downloadReady: boolean;
  ready: boolean;
  selected: boolean;
  status: "waiting" | "downloading" | "verifying" | "ready" | "error";
  fingerprint?: string | null;
  subtitleStatus: "waiting" | "probing" | "ready" | "error";
  subtitleError: string | null;
  subtitleAssetStatus?: "waiting" | "preparing" | "ready" | "error";
  subtitleAssetError?: string | null;
  audioTracks: AgentAudioTrack[];
  chapters: AgentChapter[];
  subtitles: AgentSubtitleTrack[];
  preparation: AgentPreparation;
  streamUrl: string;
  hlsUrl?: string | null;
}

export interface AgentAudioTrack {
  id: string;
  streamIndex: number;
  language: string;
  label: string;
  codec: string;
  channels: number;
  channelLayout?: string;
  default: boolean;
}

export interface AgentChapter {
  id: string;
  index: number;
  title: string;
  start: number;
  end: number;
  language: string;
}

export interface AgentSubtitleTrack {
  id: string;
  streamIndex: number;
  language: string;
  label: string;
  codec: string;
  supported: boolean;
  styled: boolean;
  default: boolean;
  forced: boolean;
  url: string;
  assUrl: string | null;
  fonts: AgentSubtitleFont[];
}

export interface AgentSubtitleFont {
  id: string;
  streamIndex: number;
  name: string;
  mimeType: string;
  url: string;
}

export interface AgentPipelineStage {
  name: string;
  hardware: boolean;
}

export interface AgentVideoPipeline {
  id: string;
  backend: string;
  platform: string;
  hardwareDecode: boolean;
  hardwareFilter: boolean;
  hardwareUpload: boolean;
  hardwareEncode: boolean;
  decode: AgentPipelineStage;
  filter: AgentPipelineStage;
  upload: AgentPipelineStage;
  encode: AgentPipelineStage;
}

export interface AgentPipelineDiagnostic {
  code: string;
  stage: string;
  backend?: string;
  candidate?: string;
  message: string;
  detail?: string;
}

export interface AgentTranscoder {
  encoder: string;
  label: string;
  hardware: boolean;
  hardwareDecode?: boolean;
  ffmpegSource: "configured" | "system" | "bundled";
  preference?: string;
  pipeline?: AgentVideoPipeline;
  diagnostics?: AgentPipelineDiagnostic[];
}

export interface AgentPreparation {
  status: "waiting" | "queued" | "preparing" | "ready" | "direct" | "error";
  error: string | null;
  resourceProfile?: "foreground" | "background";
  encoder: { id: string; label: string; hardware: boolean } | null;
  hardwareDecode?: boolean;
  fallback: boolean;
  bufferedSeconds?: number;
  contiguousReadySeconds?: number;
  sourceDuration?: number;
  committedEpochs?: number;
  epochSeconds?: number;
  complete?: boolean;
  generationId?: string | null;
  resumed?: boolean;
  resumeSeconds?: number;
  resumeSegments?: number;
  rendering?: boolean;
  pipeline?: AgentVideoPipeline | null;
  diagnostics?: AgentPipelineDiagnostic[];
}

export interface AgentJob {
  id: string;
  kind: "magnet" | "direct";
  status: "queued" | "metadata" | "downloading" | "paused" | "ready" | "error";
  progress: number;
  infoHash: string | null;
  magnetURI: string | null;
  sourceIdentity: string | null;
  seed: boolean;
  paused?: boolean;
  seedState: "creating" | "starting" | "seeding" | "uploading" | "error" | null;
  peers: number;
  uploadSpeed: number;
  uploaded: number;
  creationProgress: number;
  trackerAnnounces: number;
  trackerWarnings?: string[];
  torrent?: AgentTorrentSummary | null;
  seedStartedAt: number | null;
  platform: string;
  torrentPort: number;
  dhtPort: number;
  webRtcSupported: boolean;
  identityFingerprint: string | null;
  error: string | null;
  subtitleStatus: "waiting" | "probing" | "ready" | "error";
  subtitleError: string | null;
  subtitleAssetStatus?: "waiting" | "preparing" | "ready" | "error";
  subtitleAssetError?: string | null;
  audioTracks: AgentAudioTrack[];
  chapters: AgentChapter[];
  subtitles: AgentSubtitleTrack[];
  managed: boolean;
  pinned: boolean;
  createdAt: number;
  completedAt: number | null;
  lastAccessedAt: number;
  preparation: AgentPreparation;
  transcoder: AgentTranscoder;
  files: AgentFile[];
  updatedAt: number;
}

export interface AgentTorrentSummary {
  connectedPeers: number;
  connectedSeeds: number;
  downloadSpeed: number;
  uploadSpeed: number;
  downloaded: number;
  uploaded: number;
  trackerReportedSeeders: number | null;
  trackerReportedLeechers: number | null;
  trackerAvailability: "known" | "unknown";
  configuredTrackers: number;
  respondingTrackers: number;
  lastTrackerResponseAt: number | null;
  trackerAnnounces: number;
  lastTrackerAnnounceAt: number | null;
  discovery: {
    trackerEnabled: boolean;
    dhtEnabled: boolean;
    lsdEnabled: boolean;
    peerExchangeEnabled: boolean;
    lastDhtAnnounceAt: number | null;
  };
}

export interface AgentLibraryFile {
  id: string;
  name: string;
  size: number;
  copyCount?: number;
  collectionId?: string;
  relativePath?: string;
  fileIndex?: number;
  torrentFileIndex?: number;
  managed?: boolean;
  pinned?: boolean;
  fingerprint?: string | null;
  infoHash?: string | null;
  usable?: boolean;
}

export interface AgentCleanupSettings {
  enabled: boolean;
  downloadRetentionDays: number;
  cacheRetentionDays: number;
  partialRetentionHours: number;
  maxStorageGb: number;
  minFreeSpaceGb: number;
}

export interface AgentStorageStatus {
  directory: string;
  cleanup: AgentCleanupSettings;
  usage: {
    bytes: number;
    availableBytes: number | null;
    totalBytes: number | null;
    managedJobs: number;
    pinnedJobs: number;
  };
}

export interface AgentCleanupResult {
  removedJobs: string[];
  removedEntries: string[];
  bytes: number;
}

export interface AgentCleanupOperation {
  id: string | null;
  status: "idle" | "running" | "complete" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  result: AgentCleanupResult | null;
  error: string | null;
}

let lastAgentResponseAt = 0;

function noteAgentResponse() {
  lastAgentResponseAt = Date.now();
}

export function getAgentActivityAge() {
  return lastAgentResponseAt ? Date.now() - lastAgentResponseAt : Number.POSITIVE_INFINITY;
}

class AgentRequestError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown = null) {
    super(message);
    this.name = "AgentRequestError";
    this.status = status;
    this.payload = payload;
  }
}

export class AgentProtocolVersionError extends Error {
  constructor(received: number | null) {
    super(
      `This Companion uses protocol ${received ?? "unknown"}; WatchPair now requires protocol ${AGENT_PROTOCOL_VERSION}. Update the Companion app before reconnecting.`
    );
    this.name = "AgentProtocolVersionError";
  }
}

export function isAgentProtocolVersionError(error: unknown): error is AgentProtocolVersionError {
  return error instanceof AgentProtocolVersionError;
}

async function agentFetch<T>(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(AGENT_URL + path, { ...init, headers });
  noteAgentResponse();
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new AgentRequestError(
      data.error || "The local agent rejected the request.",
      response.status,
      data
    );
  }
  return data;
}

export async function detectAgent() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const result = await agentFetch<{ ok: boolean; protocolVersion?: number }>("/health", {
      signal: controller.signal,
    });
    if (result.ok && result.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      throw new AgentProtocolVersionError(result.protocolVersion ?? null);
    }
    return result.ok;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getAgentConnectUrl() {
  return "watchpair://connect?origin=" + encodeURIComponent(window.location.origin);
}

export function getAgentPairingUrl() {
  return AGENT_URL + "/pair?origin=" + encodeURIComponent(window.location.origin);
}

export async function resolveAgentSource(value: string) {
  const result = await agentFetch<{ source: Pick<SharedSource, "kind" | "value" | "label"> }>(
    "/resolve",
    { method: "POST", body: JSON.stringify({ value }) }
  );
  return result.source;
}

async function getAgentSubtitleResponse(url: string, signal?: AbortSignal) {
  if (!url.startsWith(AGENT_URL + "/downloads/")) {
    throw new Error("The companion returned an invalid subtitle URL.");
  }
  const response = await fetchPreparedAgentAsset(url, { signal, onResponse: noteAgentResponse });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || "Could not extract embedded subtitles.");
  }
  return response;
}

export async function getAgentSubtitle(url: string, signal?: AbortSignal) {
  return (await getAgentSubtitleResponse(url, signal)).text();
}

export async function getAgentSubtitleBytes(url: string, signal?: AbortSignal) {
  return new Uint8Array(await (await getAgentSubtitleResponse(url, signal)).arrayBuffer());
}

export async function addAgentDownload(source: SharedSource) {
  const result = await agentFetch<{ job: AgentJob }>("/downloads", {
    method: "POST",
    body: JSON.stringify({ source }),
  });
  return result.job;
}

export async function getAgentDownload(sourceId: string) {
  const result = await agentFetch<{ job: AgentJob }>(
    `/downloads/${encodeURIComponent(sourceId)}`,
    { cache: "no-store" }
  );
  return result.job;
}

export async function selectAgentFile(sourceId: string, fileIndex: number) {
  const result = await agentFetch<{ job: AgentJob }>(
    `/downloads/${encodeURIComponent(sourceId)}/select`,
    {
      method: "POST",
      body: JSON.stringify({ fileIndex }),
    }
  );
  return result.job;
}

export async function getAgentDownloads() {
  const result = await agentFetch<{ jobs: AgentJob[] }>("/downloads", { cache: "no-store" });
  return result.jobs;
}

export interface AgentPlaybackDiagnostic {
  event: string;
  level?: "info" | "warn" | "error";
  message?: string;
  playbackPath?: string;
  readyState?: number;
  networkState?: number;
  mediaErrorCode?: number;
  currentTime?: number;
  duration?: number;
  paused?: boolean;
  seekableStart?: number;
  seekableEnd?: number;
  bufferedStart?: number;
  bufferedEnd?: number;
  seekTarget?: number;
  seekSource?: string;
  roomPosition?: number;
  roomActorId?: string;
  hlsType?: string;
  hlsDetails?: string;
  fatal?: boolean;
  consecutiveFailures?: number;
  healthCheckDurationMs?: number;
  recentActivityAgeMs?: number;
  userAgent?: string;
}

export async function reportAgentPlaybackEvent(diagnostic: AgentPlaybackDiagnostic) {
  try {
    await agentFetch<{ ok: boolean }>("/diagnostics/client", {
      method: "POST",
      body: JSON.stringify(diagnostic),
    });
  } catch {
    // Playback reporting is best effort, including while the companion reconnects.
  }
}

export async function setAgentPlaybackPriority(sourceId: string | null, sourceIds: string[] = []) {
  return agentFetch<{
    ok: boolean;
    sourceId: string | null;
    sourceIds: string[];
    foregroundLoad: number;
    backgroundLoad: number;
  }>("/preparation-priority", {
    method: "POST",
    body: JSON.stringify({ sourceId, sourceIds }),
  });
}

export async function stopAgentDownload(sourceId: string, deleteFiles = false) {
  await agentFetch<{ ok: boolean }>(
    `/downloads/${encodeURIComponent(sourceId)}?deleteFiles=${deleteFiles ? "1" : "0"}`,
    { method: "DELETE" }
  );
}

export async function getAgentSeedPublication(sourceId: string, signal?: AbortSignal) {
  const result = await agentFetch<{ magnetURI: string | null }>(
    `/downloads/${encodeURIComponent(sourceId)}/publication`,
    { cache: "no-store", signal }
  );
  return result.magnetURI || null;
}

export interface AgentSeedLease {
  leaseId: string;
  expiresAt: number;
  job?: AgentJob;
}

export async function acquireAgentSeedLease(
  sourceId: string,
  leaseId: string,
  ttlMs = 120_000
) {
  return agentFetch<AgentSeedLease>(
    `/downloads/${encodeURIComponent(sourceId)}/leases`,
    {
      method: "POST",
      body: JSON.stringify({ leaseId, ttlMs }),
    }
  );
}

export async function releaseAgentSeedLease(sourceId: string, leaseId: string) {
  return agentFetch<{ released: boolean; lastLease: boolean }>(
    `/downloads/${encodeURIComponent(sourceId)}/leases/${encodeURIComponent(leaseId)}`,
    { method: "DELETE", keepalive: true }
  );
}

export async function pauseAgentDownload(sourceId: string) {
  try {
    const result = await agentFetch<{ ok?: boolean; job?: AgentJob }>(
      `/downloads/${encodeURIComponent(sourceId)}/pause`,
      { method: "POST" }
    );
    return result.job || null;
  } catch (error) {
    if (!(error instanceof AgentRequestError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
    throw new Error("This companion version cannot pause downloads. Update the companion and try again.");
  }
}

export async function resumeAgentDownload(sourceId: string) {
  try {
    const result = await agentFetch<{ job: AgentJob }>(
      `/downloads/${encodeURIComponent(sourceId)}/resume`,
      { method: "POST" }
    );
    return result.job;
  } catch (error) {
    if (!(error instanceof AgentRequestError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
    return retryAgentDownload(sourceId);
  }
}

export interface AgentMediaTarget {
  jobId: string;
  fileIndex: number;
  itemId?: string | null;
}

export async function setAgentMediaPriority(
  selected: AgentMediaTarget | null,
  targets: AgentMediaTarget[]
) {
  return agentFetch<{
    ok: boolean;
    selected: AgentMediaTarget | null;
    targets: AgentMediaTarget[];
    foregroundLoad: number;
    backgroundLoad: number;
    systemTier: "low" | "standard" | "high";
    foregroundThreads: number;
    backgroundThreads: number;
  }>("/media-priority", {
    method: "POST",
    body: JSON.stringify({ selected, targets }),
  });
}

export async function setAgentDownloadPinned(sourceId: string, pinned: boolean) {
  const result = await agentFetch<{ job: AgentJob }>(
    "/downloads/" + encodeURIComponent(sourceId) + "/pin",
    { method: "POST", body: JSON.stringify({ pinned }) }
  );
  return result.job;
}

export async function getAgentStorage() {
  return agentFetch<AgentStorageStatus>("/storage", { cache: "no-store" });
}

function isAgentCleanupResult(value: unknown): value is AgentCleanupResult {
  const result = value as Partial<AgentCleanupResult> | null;
  return Boolean(result && Array.isArray(result.removedJobs) &&
    Array.isArray(result.removedEntries) && Number.isFinite(result.bytes));
}

export async function startAgentCleanup() {
  return agentFetch<AgentCleanupOperation | AgentCleanupResult>("/cleanup", { method: "POST" });
}

export async function getAgentCleanup(operationId?: string) {
  const query = operationId ? `?id=${encodeURIComponent(operationId)}` : "";
  return agentFetch<AgentCleanupOperation>(`/cleanup${query}`, { cache: "no-store" });
}

export async function runAgentCleanup() {
  const started = await startAgentCleanup();
  if (isAgentCleanupResult(started)) return started;

  let operation = started;
  while (operation.status === "running") {
    if (!operation.id) throw new Error("The local agent returned an invalid cleanup operation.");
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    operation = await getAgentCleanup(operation.id);
  }
  if (operation.status === "complete" && isAgentCleanupResult(operation.result)) {
    return operation.result;
  }
  if (operation.status === "error") throw new Error(operation.error || "Cleanup failed.");
  throw new Error("The local agent returned an invalid cleanup operation.");
}

export async function retryAgentDownload(sourceId: string) {
  const result = await agentFetch<{ job: AgentJob }>(
    `/downloads/${encodeURIComponent(sourceId)}/retry`,
    { method: "POST" }
  );
  return result.job;
}

export interface AgentLibraryScanResult {
  files: AgentLibraryFile[];
  scan?: {
    id?: string;
    status?: "idle" | "running" | "complete" | "error";
    error?: string | null;
    scannedFiles?: number;
    failedRoots?: number;
  } | null;
  stale: boolean;
  error: string | null;
}

export async function scanAgentLibrary(query = ""): Promise<AgentLibraryScanResult> {
  try {
    const result = await agentFetch<{
      files: AgentLibraryFile[];
      scan?: AgentLibraryScanResult["scan"];
      stale?: boolean;
    }>(`/library?query=${encodeURIComponent(query)}`, { cache: "no-store" });
    return {
      files: Array.isArray(result.files) ? result.files : [],
      scan: result.scan || null,
      stale: Boolean(result.stale),
      error: null,
    };
  } catch (error) {
    if (error instanceof AgentRequestError && error.status === 503) {
      const payload = error.payload as {
        files?: AgentLibraryFile[];
        scan?: AgentLibraryScanResult["scan"];
        stale?: boolean;
        error?: string;
      } | null;
      return {
        files: Array.isArray(payload?.files) ? payload.files : [],
        scan: payload?.scan || null,
        stale: true,
        error: payload?.error || error.message,
      };
    }
    throw error;
  }
}

export async function matchAgentLibraryFile(criteria: {
  fingerprint?: string | null;
  infoHash?: string | null;
  size?: number | null;
  fileIndex?: number | null;
  relativePath?: string | null;
}) {
  const query = new URLSearchParams();
  if (criteria.fingerprint) query.set("fingerprint", criteria.fingerprint);
  if (criteria.infoHash) query.set("infoHash", criteria.infoHash);
  if (Number.isFinite(criteria.size)) query.set("size", String(criteria.size));
  if (Number.isInteger(criteria.fileIndex)) query.set("fileIndex", String(criteria.fileIndex));
  if (criteria.relativePath) query.set("relativePath", criteria.relativePath);
  if (!criteria.fingerprint && !criteria.infoHash) return null;
  try {
    const result = await agentFetch<{ file: AgentLibraryFile }>(
      `/library/match?${query.toString()}`,
      { cache: "no-store" }
    );
    return result.file;
  } catch (error) {
    if (error instanceof AgentRequestError && error.status === 404) return null;
    throw error;
  }
}

export function getAgentLibraryPreviewUrl(libraryId: string) {
  return `${AGENT_URL}/library/${encodeURIComponent(libraryId)}/preview`;
}

export async function seedAgentLibraryFile(sourceId: string, libraryId: string, label: string) {
  const pending = await agentFetch<{ job: AgentJob; magnetURI: string | null }>(
    `/library/${encodeURIComponent(libraryId)}/seed`,
    {
      method: "POST",
      body: JSON.stringify({ sourceId, label }),
    }
  );
  return pending.magnetURI
    ? { job: pending.job, magnetURI: pending.magnetURI }
    : waitForAgentSeed(sourceId);
}

export async function attachAgentLibraryFile(
  sourceId: string,
  libraryId: string,
  label: string
) {
  const result = await agentFetch<{ job: AgentJob }>(
    `/library/${encodeURIComponent(libraryId)}/attach`,
    {
      method: "POST",
      body: JSON.stringify({ sourceId, label }),
    }
  );
  return result.job;
}

export async function uploadAndSeedAgentFile(
  sourceId: string,
  file: File,
  onProgress: (progress: number) => void,
  signal?: AbortSignal
) {
  const chunkSize = 16 * 1024 * 1024;
  let offset = 0;
  try {
    const existing = await agentFetch<{ uploaded: number }>(
      `/imports/${encodeURIComponent(sourceId)}`,
      { cache: "no-store", signal }
    );
    offset = Math.min(file.size, Math.max(0, existing.uploaded || 0));
    onProgress(file.size ? (offset / file.size) * 100 : 100);
    while (offset < file.size) {
      if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
      const progress = await agentFetch<{ uploaded: number; total: number }>(
        `/imports/${encodeURIComponent(sourceId)}?offset=${offset}&total=${file.size}`,
        {
          method: "PUT",
          body: chunk,
          headers: { "content-type": "application/octet-stream" },
          signal,
        }
      );
      offset = progress.uploaded;
      onProgress(file.size ? (offset / file.size) * 100 : 100);
    }

    const pending = await agentFetch<{ job: AgentJob; magnetURI: string | null }>(
      `/imports/${encodeURIComponent(sourceId)}/seed`,
      {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size }),
        signal,
      }
    );
    return pending.magnetURI
      ? { job: pending.job, magnetURI: pending.magnetURI }
      : waitForAgentSeed(sourceId, onProgress, signal);
  } catch (error) {
    if (signal?.aborted) {
      void agentFetch<{ ok: boolean }>(
        `/imports/${encodeURIComponent(sourceId)}`,
        { method: "DELETE" }
      ).catch(() => {});
    }
    throw error;
  }
}
