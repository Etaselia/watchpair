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

export interface AgentJob {
  id: string;
  kind: "magnet" | "direct";
  status: "queued" | "metadata" | "downloading" | "ready" | "error";
  progress: number;
  infoHash: string | null;
  error: string | null;
  subtitleStatus: "waiting" | "probing" | "ready" | "error";
  subtitleError: string | null;
  audioTracks: AgentAudioTrack[];
  subtitles: AgentSubtitleTrack[];
  files: AgentFile[];
  updatedAt: number;
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
