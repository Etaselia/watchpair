import type { SharedSource } from "./session-types";

export const AGENT_URL = "http://127.0.0.1:41735";
export const AGENT_PROTOCOL_VERSION = 1;

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

async function waitForAgentSeed(
  sourceId: string,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
) {
  while (true) {
    if (signal?.aborted) throw new DOMException("Torrent creation cancelled", "AbortError");
    const job = await getAgentDownload(sourceId);
    onProgress?.(100 + Math.min(100, Math.max(0, job.creationProgress || 0)));
    if (job.status === "error") throw new Error(job.error || "Could not create the torrent.");
    if (job.status === "ready" && job.magnetURI) {
      return { job, magnetURI: job.magnetURI };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
}

export interface AgentFile {
  index: number;
  name: string;
  size: number;
  downloaded: number;
  progress: number;
  ready: boolean;
  selected: boolean;
  fingerprint?: string | null;
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
  pipeline?: AgentVideoPipeline | null;
  diagnostics?: AgentPipelineDiagnostic[];
}

export interface AgentJob {
  id: string;
  kind: "magnet" | "direct";
  status: "queued" | "metadata" | "downloading" | "ready" | "error";
  progress: number;
  infoHash: string | null;
  magnetURI: string | null;
  seed: boolean;
  seedState: "creating" | "starting" | "seeding" | "uploading" | "error" | null;
  peers: number;
  uploadSpeed: number;
  uploaded: number;
  creationProgress: number;
  trackerAnnounces: number;
  trackerWarnings: string[];
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

export interface AgentLibraryFile {
  id: string;
  name: string;
  size: number;
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

async function agentFetch<T>(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(AGENT_URL + path, { ...init, headers });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "The local agent rejected the request.");
  return data;
}

export async function detectAgent() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1_200);
  try {
    const result = await agentFetch<{ ok: boolean }>("/health", { signal: controller.signal });
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

async function getAgentSubtitleResponse(url: string) {
  if (!url.startsWith(AGENT_URL + "/downloads/")) {
    throw new Error("The companion returned an invalid subtitle URL.");
  }
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || "Could not extract embedded subtitles.");
  }
  return response;
}

export async function getAgentSubtitle(url: string) {
  return (await getAgentSubtitleResponse(url)).text();
}

export async function getAgentSubtitleBytes(url: string) {
  return new Uint8Array(await (await getAgentSubtitleResponse(url)).arrayBuffer());
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

export async function setAgentPlaybackPriority(sourceId: string | null) {
  return agentFetch<{
    ok: boolean;
    sourceId: string | null;
    foregroundLoad: number;
    backgroundLoad: number;
  }>("/preparation-priority", {
    method: "POST",
    body: JSON.stringify({ sourceId }),
  });
}

export async function stopAgentDownload(sourceId: string, deleteFiles = false) {
  await agentFetch<{ ok: boolean }>(
    `/downloads/${encodeURIComponent(sourceId)}?deleteFiles=${deleteFiles ? "1" : "0"}`,
    { method: "DELETE" }
  );
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

export async function runAgentCleanup() {
  return agentFetch<AgentCleanupResult>("/cleanup", { method: "POST" });
}

export async function retryAgentDownload(sourceId: string) {
  const result = await agentFetch<{ job: AgentJob }>(
    `/downloads/${encodeURIComponent(sourceId)}/retry`,
    { method: "POST" }
  );
  return result.job;
}

export async function scanAgentLibrary(query = "") {
  const result = await agentFetch<{ files: AgentLibraryFile[] }>(
    `/library?query=${encodeURIComponent(query)}`,
    { cache: "no-store" }
  );
  return result.files;
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
