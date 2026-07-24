import type { AgentFile, AgentJob } from "./agent-client";
import type { SelectedMedia } from "./session-types";

export interface LocalAgentBinding {
  sourceId: string;
  fileIndex: number;
  fingerprint: string;
}

export interface LocalAgentMedia {
  sourceId: string;
  job: AgentJob;
  file: AgentFile;
  fingerprint: string | null;
}

export function agentFileFingerprint(job: AgentJob, file: AgentFile): string | null;

export function findLocalAgentMedia(
  jobs: Record<string, AgentJob>,
  selectedMedia: SelectedMedia | null | undefined,
  preferredBinding?: LocalAgentBinding | null
): LocalAgentMedia | null;
