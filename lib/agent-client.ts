import type { SharedSource } from "./session-types";

export const AGENT_URL = "http://127.0.0.1:41735";

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

export interface AgentFile {
  index: number;
  name: string;
  size: number;
  downloaded: number;
  progress: number;
  ready: boolean;
  selected: boolean;
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

export interface AgentSubtitleTrack {
  id: string;
  streamIndex: number;
  language: string;
  label: string;
  codec: string;
  supported: boolean;
  default: boolean;
  forced: boolean;
  url: string;
}

export interface AgentTranscoder {
  encoder: string;
  label: string;
  hardware: boolean;
  ffmpegSource: "configured" | "system" | "bundled";
  preference?: string;
}

export interface AgentPreparation {
  status: "waiting" | "queued" | "preparing" | "ready" | "direct" | "error";
  error: string | null;
  encoder: { id: string; label: string; hardware: boolean } | null;
  fallback: boolean;
}

export interface AgentJob {
  id: string;
  kind: "magnet" | "direct";
  status: "queued" | "metadata" | "downloading" | "ready" | "error";
  progress: number;
  infoHash: string | null;
  magnetURI: string | null;
  seed: boolean;
  peers: number;
  uploadSpeed: number;
  uploaded: number;
  identityFingerprint: string | null;
  error: string | null;
  subtitleStatus: "waiting" | "probing" | "ready" | "error";
  subtitleError: string | null;
  audioTracks: AgentAudioTrack[];
  subtitles: AgentSubtitleTrack[];
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

export async function getAgentSubtitle(sourceId: string, trackId: string) {
  const response = await fetch(
    AGENT_URL + "/downloads/" + encodeURIComponent(sourceId) + "/subtitles/" + encodeURIComponent(trackId) + ".vtt",
    { cache: "force-cache" }
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || "Could not extract embedded subtitles.");
  }
  return response.text();
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

export async function stopAgentDownload(sourceId: string, deleteFiles = false) {
  await agentFetch<{ ok: boolean }>(
    `/downloads/${encodeURIComponent(sourceId)}?deleteFiles=${deleteFiles ? "1" : "0"}`,
    { method: "DELETE" }
  );
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
  return agentFetch<{ job: AgentJob; magnetURI: string }>(
    `/library/${encodeURIComponent(libraryId)}/seed`,
    {
      method: "POST",
      body: JSON.stringify({ sourceId, label }),
    }
  );
}

export async function attachAgentLibraryFile(
  sourceId: string,
  libraryId: string,
  label: string,
  identityFingerprint?: string
) {
  const result = await agentFetch<{ job: AgentJob }>(
    `/library/${encodeURIComponent(libraryId)}/attach`,
    {
      method: "POST",
      body: JSON.stringify({ sourceId, label, identityFingerprint }),
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

    return await agentFetch<{ job: AgentJob; magnetURI: string }>(
      `/imports/${encodeURIComponent(sourceId)}/seed`,
      {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size }),
        signal,
      }
    );
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
