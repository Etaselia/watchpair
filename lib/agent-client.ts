import type { SharedSource } from "./session-types";

export const AGENT_URL = "http://127.0.0.1:41735";

export interface AgentFile {
  index: number;
  name: string;
  size: number;
  downloaded: number;
  progress: number;
  selected: boolean;
  streamUrl: string;
}

export interface AgentJob {
  id: string;
  kind: "magnet" | "direct";
  status: "queued" | "metadata" | "downloading" | "ready" | "error";
  progress: number;
  infoHash: string | null;
  error: string | null;
  files: AgentFile[];
  updatedAt: number;
}

async function agentFetch<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
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
