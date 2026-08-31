import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { mediaItemId, mediaManifest, sameMediaManifest } from "../lib/media-queue.mjs";
import { magnetInfoHash } from "../lib/magnet-identity.mjs";
import {
  initialPlayerState,
  type LocalReadiness,
  type ParticipantState,
  type PlayerState,
  type QueueReadiness,
  type SelectedMedia,
  type SharedMediaItem,
  type SharedSource,
  type VoiceConfig,
  type VoicePresence,
  type VoiceSignal,
  type VoiceSignalType,
  type WatchSession,
} from "../lib/session-types.ts";

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COMPLETE_TOKEN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PARTICIPANT_ACTIVE_MS = 20_000;
const VOICE_SIGNAL_TTL_MS = 90_000;
const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
  ],
};

export interface SessionRuntimeEnv {
  WATCHPAIR_ICE_SERVERS?: string;
  /**
   * Optional JSON snapshot file that mirrors watch-room state across process
   * restarts. When unset, sessions live in memory only (the default for local
   * `compose` and development runs without a persistent volume).
   */
  WATCHPAIR_SESSION_FILE?: string;
}

interface SessionStore {
  initialize(): Promise<void>;
  get(token: string, recipientId?: string): Promise<WatchSession | null>;
  create(token: string, hostId: string, now: number): Promise<void>;
  touch(
    token: string,
    deviceId: string,
    name: string,
    readiness: Partial<LocalReadiness> | undefined,
    now: number
  ): Promise<void>;
  setSource(token: string, source: SharedSource, now: number): Promise<void>;
  setSources(token: string, sources: SharedSource[], now: number): Promise<void>;
  setSelectedMedia(token: string, media: SelectedMedia | null, now: number): Promise<void>;
  setPlayer(token: string, player: PlayerState, now: number): Promise<void>;
  addVoiceSignal(token: string, signal: VoiceSignal): Promise<void>;
}

function normalizeToken(value: unknown) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .replace(/^(.{4})(.+)$/, "$1-$2")
    .slice(0, 9);
}

function safeName(value: unknown) {
  const name = String(value ?? "Guest").trim().slice(0, 28);
  return name || "Guest";
}

function makeToken() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]).join("");
  return `${token.slice(0, 4)}-${token.slice(4)}`;
}

function defaultQueueReadiness(): QueueReadiness {
  return {
    ready: false,
    progress: 0,
    status: "Waiting for media",
    fileName: null,
    fileSize: null,
    fingerprint: null,
    preparation: "waiting",
  };
}

function defaultVoicePresence(): VoicePresence {
  return { enabled: false, muted: true, deafened: false };
}

function defaultReadiness(): LocalReadiness {
  return { ...defaultQueueReadiness(), queue: {}, voice: defaultVoicePresence() };
}

function sanitizeQueueReadiness(value: Partial<QueueReadiness> | undefined): QueueReadiness {
  const preparation = ["waiting", "queued", "preparing", "ready", "direct", "error"].includes(
    String(value?.preparation)
  )
    ? value?.preparation as QueueReadiness["preparation"]
    : "waiting";
  return {
    ready: Boolean(value?.ready),
    progress: Math.max(0, Math.min(100, Number(value?.progress) || 0)),
    status: String(value?.status ?? "Waiting for media").slice(0, 80),
    fileName: value?.fileName ? String(value.fileName).slice(0, 260) : null,
    fileSize: Number.isFinite(value?.fileSize) ? Number(value?.fileSize) : null,
    fingerprint: value?.fingerprint ? String(value.fingerprint).slice(0, 128) : null,
    preparation,
  };
}

function sanitizeVoicePresence(value: Partial<VoicePresence> | undefined): VoicePresence {
  return {
    enabled: Boolean(value?.enabled),
    muted: Boolean(value?.muted),
    deafened: Boolean(value?.deafened),
  };
}

function sanitizeReadiness(value: Partial<LocalReadiness> | undefined): LocalReadiness {
  const queue = Object.fromEntries(
    Object.entries(value?.queue || {})
      .filter(([id]) => /^[a-zA-Z0-9-]{8,100}$/.test(id))
      .slice(0, 500)
      .map(([id, state]) => [id, sanitizeQueueReadiness(state)])
  );
  return {
    ...sanitizeQueueReadiness(value),
    queue,
    voice: sanitizeVoicePresence(value?.voice),
  };
}

function normalizedSourceIdentity(kind: unknown, value: unknown) {
  const normalizedKind = String(kind || "");
  const rawValue = String(value || "").trim();
  if (normalizedKind === "magnet") {
    const infoHash = magnetInfoHash(rawValue);
    return infoHash ? `magnet:${infoHash}` : `magnet:${rawValue}`;
  }
  if (normalizedKind !== "direct") return null;
  try {
    return `direct:${new URL(rawValue).href}`;
  } catch {
    return `direct:${rawValue}`;
  }
}

function voiceConfig(value: string | undefined): VoiceConfig {
  if (!value) return DEFAULT_VOICE_CONFIG;
  try {
    const parsed = JSON.parse(value) as { iceServers?: VoiceConfig["iceServers"] };
    const iceServers = (parsed.iceServers || [])
      .slice(0, 8)
      .map((server) => ({
        urls: (Array.isArray(server.urls) ? server.urls : [server.urls])
          .map((url) => String(url))
          .filter((url) => /^(stun|turn|turns):/i.test(url))
          .slice(0, 8),
        username: server.username ? String(server.username).slice(0, 256) : undefined,
        credential: server.credential ? String(server.credential).slice(0, 512) : undefined,
      }))
      .filter((server) => server.urls.length > 0);
    return iceServers.length ? { iceServers } : DEFAULT_VOICE_CONFIG;
  } catch {
    return DEFAULT_VOICE_CONFIG;
  }
}

function activeSource(sources: SharedSource[], selectedMedia: SelectedMedia | null) {
  return sources.find((item) => item.id === selectedMedia?.sourceId) || sources[0] || null;
}

function stableParticipants(participants: ParticipantState[], hostId: string) {
  return participants.sort(
    (left, right) =>
      Number(right.deviceId === hostId) - Number(left.deviceId === hostId) ||
      left.name.localeCompare(right.name) ||
      left.deviceId.localeCompare(right.deviceId)
  );
}

interface MemorySession {
  token: string;
  hostId: string;
  sources: SharedSource[];
  selectedMedia: SelectedMedia | null;
  player: PlayerState;
  seq: number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  participants: Map<string, ParticipantState>;
  voiceSignals: VoiceSignal[];
}

class MemorySessionStore implements SessionStore {
  protected readonly sessions = new Map<string, MemorySession>();
  protected readonly voice: VoiceConfig;
  protected readonly clock: () => number;

  constructor(voice: VoiceConfig, clock: () => number = Date.now) {
    this.voice = voice;
    this.clock = clock;
  }

  async initialize() {}

  async get(token: string, recipientId?: string): Promise<WatchSession | null> {
    const record = this.sessions.get(token);
    const now = this.clock();
    if (!record || record.expiresAt <= now) {
      this.sessions.delete(token);
      return null;
    }

    return {
      token: record.token,
      hostId: record.hostId,
      sources: record.sources,
      source: activeSource(record.sources, record.selectedMedia),
      selectedMedia: record.selectedMedia,
      player: record.player,
      seq: record.seq,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      updatedAt: record.updatedAt,
      serverTime: now,
      participants: stableParticipants(
        Array.from(record.participants.values()).filter(
          (participant) => participant.updatedAt >= now - PARTICIPANT_ACTIVE_MS
        ),
        record.hostId
      ),
      voiceSignals: recipientId
        ? record.voiceSignals.filter(
            (signal) => signal.toId === recipientId && signal.createdAt >= now - VOICE_SIGNAL_TTL_MS
          )
        : [],
      voice: this.voice,
    };
  }

  async create(token: string, hostId: string, now: number) {
    if (this.sessions.has(token)) return;
    this.sessions.set(token, {
      token,
      hostId,
      sources: [],
      selectedMedia: null,
      player: initialPlayerState(now),
      seq: 0,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      updatedAt: now,
      participants: new Map(),
      voiceSignals: [],
    });
  }

  async touch(
    token: string,
    deviceId: string,
    name: string,
    readiness: Partial<LocalReadiness> | undefined,
    now: number
  ) {
    const record = this.sessions.get(token);
    if (!record) return;
    const existing = record.participants.get(deviceId);
    const incoming = sanitizeReadiness(readiness);
    record.participants.set(deviceId, {
      deviceId,
      name: safeName(name),
      ...incoming,
      // A rejoin/heartbeat that carries an empty queue (fresh page load, or a
      // network switch before the companion refresh has rebuilt state) must not
      // erase the per-video ready states this peer already published. Merge so
      // the coordinator keeps the last-known-good queue until the client
      // re-publishes fresh data for every entry.
      queue: { ...(existing?.queue || {}), ...incoming.queue },
      updatedAt: now,
    });
    record.expiresAt = now + SESSION_TTL_MS;
  }

  async setSource(token: string, source: SharedSource, now: number) {
    const record = this.sessions.get(token);
    if (!record) return;
    record.sources.push(source);
    record.seq += 1;
    record.updatedAt = now;
  }

  async setSources(token: string, sources: SharedSource[], now: number) {
    const record = this.sessions.get(token);
    if (!record) return;
    record.sources = sources;
    record.seq += 1;
    record.updatedAt = now;
  }

  async setSelectedMedia(token: string, media: SelectedMedia | null, now: number) {
    const record = this.sessions.get(token);
    if (!record) return;
    const previous = record.selectedMedia;
    const sameMedia = Boolean(
      media &&
      previous &&
      (media.sourceId ?? null) === (previous.sourceId ?? null) &&
      (media.fileIndex ?? null) === (previous.fileIndex ?? null) &&
      media.size === previous.size
    );
    record.selectedMedia = media;
    // Re-selecting the same media (the client re-publishes select-media to
    // attach a fingerprint once the file is identified) must not reset the room
    // player, otherwise every such POST pauses playback for all participants
    // about a second after the initial selection.
    if (!sameMedia) record.player = initialPlayerState(now);
    record.seq += 1;
    record.updatedAt = now;
  }

  async setPlayer(token: string, player: PlayerState, now: number) {
    const record = this.sessions.get(token);
    if (!record) return;
    record.player = player;
    record.seq += 1;
    record.updatedAt = now;
  }

  async addVoiceSignal(token: string, signal: VoiceSignal) {
    const record = this.sessions.get(token);
    if (!record) return;
    record.voiceSignals = record.voiceSignals
      .filter((item) => item.createdAt >= signal.createdAt - VOICE_SIGNAL_TTL_MS)
      .concat(signal)
      .slice(-400);
  }
}

interface SessionPersistenceOptions {
  /** Debounce window for snapshot writes. Defaults to ~1s. */
  debounceMs?: number;
  /** Injectable clock used for expiry checks. Defaults to Date.now. */
  now?: () => number;
  /** Injectable timer scheduler (tests use this for determinism). */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  /** Cancels a scheduled timer handle returned by `schedule`. */
  clearSchedule?: (timer: unknown) => void;
  /** Handles snapshot load/write failures without failing the request. */
  onError?: (error: unknown) => void;
}

interface PersistedSessionRecord {
  token?: unknown;
  hostId?: unknown;
  sources?: unknown;
  selectedMedia?: unknown;
  player?: unknown;
  seq?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  updatedAt?: unknown;
  participants?: Array<Record<string, unknown>>;
  voiceSignals?: Array<Record<string, unknown>>;
}

const SESSION_SNAPSHOT_VERSION = 1;

function parseSessionSnapshot(raw: string): PersistedSessionRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed as PersistedSessionRecord[];
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { sessions?: unknown }).sessions)
  ) {
    return (parsed as { sessions: unknown }).sessions as PersistedSessionRecord[];
  }
  return null;
}

/**
 * A session store that mirrors every mutation to a JSON snapshot file.
 *
 * Reads stay in-memory for latency. Writes are debounced (~1s) and atomic: the
 * snapshot is written to a `.tmp` file and renamed into place, so the on-disk
 * state is always a recent, consistent JSON document even if the process is
 * SIGKILLed (deploys use `docker rm --force`, so there is no graceful
 * shutdown). Expired sessions and stale participants/voice signals are dropped
 * when the snapshot is loaded.
 *
 * Pass `filePath: null` (or omit it) to keep everything in memory with no file
 * I/O at all.
 */
export class FileSessionStore extends MemorySessionStore implements SessionStore {
  private readonly filePath: string | null;
  private readonly debounceMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly clearSchedule: (timer: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private persistTimer: unknown = null;
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(voice: VoiceConfig, filePath: string | null, options: SessionPersistenceOptions = {}) {
    super(voice, options.now ?? Date.now);
    this.filePath = filePath;
    this.debounceMs = options.debounceMs ?? 1_000;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearSchedule =
      options.clearSchedule ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.onError =
      options.onError ?? ((error) => console.error("[watchpair] Session persistence failed:", error));
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (this.filePath === null) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      this.onError(error);
      return;
    }
    const records = parseSessionSnapshot(raw);
    if (!records) return;
    const now = this.clock();
    for (const item of records) {
      const record = item as PersistedSessionRecord;
      if (typeof record?.token !== "string" || typeof record.expiresAt !== "number") continue;
      if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) continue;
      const participants = new Map<string, ParticipantState>();
      for (const candidate of Array.isArray(record.participants) ? record.participants : []) {
        if (
          typeof candidate.deviceId === "string" &&
          typeof candidate.updatedAt === "number" &&
          candidate.updatedAt >= now - PARTICIPANT_ACTIVE_MS
        ) {
          participants.set(candidate.deviceId, candidate as unknown as ParticipantState);
        }
      }
      const voiceSignals: VoiceSignal[] = (
        Array.isArray(record.voiceSignals) ? record.voiceSignals : []
      )
        .filter(
          (signal) =>
            typeof signal.createdAt === "number" &&
            signal.createdAt >= now - VOICE_SIGNAL_TTL_MS
        )
        .map((signal) => signal as unknown as VoiceSignal)
        .slice(-400);
      this.sessions.set(record.token, {
        token: record.token,
        hostId: typeof record.hostId === "string" ? record.hostId : "",
        sources: Array.isArray(record.sources) ? (record.sources as SharedSource[]) : [],
        selectedMedia: record.selectedMedia ? (record.selectedMedia as SelectedMedia) : null,
        player: record.player ? (record.player as PlayerState) : initialPlayerState(now),
        seq: typeof record.seq === "number" && Number.isFinite(record.seq) ? record.seq : 0,
        createdAt:
          typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
            ? record.createdAt
            : now,
        expiresAt: record.expiresAt,
        updatedAt:
          typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
            ? record.updatedAt
            : now,
        participants,
        voiceSignals,
      });
    }
  }

  async create(token: string, hostId: string, now: number) {
    await super.create(token, hostId, now);
    this.schedulePersist();
  }

  async touch(
    token: string,
    deviceId: string,
    name: string,
    readiness: Partial<LocalReadiness> | undefined,
    now: number
  ) {
    await super.touch(token, deviceId, name, readiness, now);
    this.schedulePersist();
  }

  async setSource(token: string, source: SharedSource, now: number) {
    await super.setSource(token, source, now);
    this.schedulePersist();
  }

  async setSources(token: string, sources: SharedSource[], now: number) {
    await super.setSources(token, sources, now);
    this.schedulePersist();
  }

  async setSelectedMedia(token: string, media: SelectedMedia | null, now: number) {
    await super.setSelectedMedia(token, media, now);
    this.schedulePersist();
  }

  async setPlayer(token: string, player: PlayerState, now: number) {
    await super.setPlayer(token, player, now);
    this.schedulePersist();
  }

  async addVoiceSignal(token: string, signal: VoiceSignal) {
    await super.addVoiceSignal(token, signal);
    this.schedulePersist();
  }

  /**
   * Persists any pending changes immediately and awaits the in-flight write.
   * Used by tests; a graceful-shutdown hook could call this too.
   */
  async flush() {
    if (this.persistTimer !== null) {
      this.clearSchedule(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.filePath !== null) this.enqueueWrite();
    await this.writeChain;
  }

  private schedulePersist() {
    if (this.filePath === null || this.persistTimer !== null) return;
    this.persistTimer = this.schedule(() => {
      this.persistTimer = null;
      this.enqueueWrite();
    }, this.debounceMs);
  }

  private enqueueWrite() {
    this.writeChain = this.writeChain
      .then(() => this.writeNow())
      .catch(() => undefined);
  }

  private async writeNow() {
    if (this.filePath === null) return;
    const temporaryPath = `${this.filePath}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(this.serializeSnapshot()), "utf8");
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      this.onError(error);
    }
  }

  private serializeSnapshot() {
    const now = this.clock();
    return {
      version: SESSION_SNAPSHOT_VERSION,
      savedAt: now,
      sessions: Array.from(this.sessions.values())
        .filter((record) => record.expiresAt > now)
        .map((record) => ({
          token: record.token,
          hostId: record.hostId,
          sources: record.sources,
          selectedMedia: record.selectedMedia,
          player: record.player,
          seq: record.seq,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          updatedAt: record.updatedAt,
          participants: Array.from(record.participants.values()),
          voiceSignals: record.voiceSignals,
        })),
    };
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected session error";
  return Response.json({ error: message }, { status: 500 });
}

async function handleGet(request: Request, store: SessionStore) {
  const url = new URL(request.url);
  const token = normalizeToken(url.searchParams.get("token"));
  const deviceId = String(url.searchParams.get("deviceId") || "").slice(0, 80);
  if (!token) return Response.json({ error: "Session token is required" }, { status: 400 });

  const session = await store.get(token, deviceId || undefined);
  if (!session) return Response.json({ error: "Session not found or expired" }, { status: 404 });
  return Response.json({ session });
}

async function handlePost(request: Request, store: SessionStore) {
  const body = (await request.json()) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const deviceId = String(body.deviceId ?? "").slice(0, 80);
  const name = safeName(body.name);
  const now = Date.now();

  if (!deviceId) {
    return Response.json({ error: "A device id is required" }, { status: 400 });
  }

  if (action === "create") {
    const requestedToken = normalizeToken(body.token);
    let token = COMPLETE_TOKEN.test(requestedToken) ? requestedToken : makeToken();
    let currentSession = await store.get(token);
    for (let attempt = 0; !COMPLETE_TOKEN.test(requestedToken) && attempt < 4 && currentSession; attempt += 1) {
      token = makeToken();
      currentSession = await store.get(token);
    }
    if (!currentSession) await store.create(token, deviceId, now);
    await store.touch(token, deviceId, name, defaultReadiness(), now);
    return Response.json({ session: await store.get(token) }, { status: currentSession ? 200 : 201 });
  }

  const token = normalizeToken(body.token);
  if (!COMPLETE_TOKEN.test(token)) {
    return Response.json({ error: "A complete session token is required" }, { status: 400 });
  }
  let currentSession = await store.get(token);
  if (!currentSession && action === "join") {
    await store.create(token, deviceId, now);
    currentSession = await store.get(token);
  }
  if (!currentSession) {
    return Response.json({ error: "Session not found or expired" }, { status: 404 });
  }

  if (action === "join" || action === "heartbeat") {
    await store.touch(
      token,
      deviceId,
      name,
      (body.readiness ?? defaultReadiness()) as Partial<LocalReadiness>,
      now
    );
  } else if (action === "source") {
    const candidate = body.source as Partial<SharedSource> | null;
    const sourceId = String(candidate?.id || crypto.randomUUID()).slice(0, 80);
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(sourceId)) {
      return Response.json({ error: "A valid source id is required" }, { status: 400 });
    }
    if (!candidate?.value || !["magnet", "direct"].includes(String(candidate.kind))) {
      return Response.json({ error: "A supported source is required" }, { status: 400 });
    }
    const existingSource = currentSession.sources.find((source) => source.id === sourceId);
    if (existingSource) {
      const existingIdentity = normalizedSourceIdentity(existingSource.kind, existingSource.value);
      const candidateIdentity = normalizedSourceIdentity(candidate.kind, candidate.value);
      if (existingIdentity === candidateIdentity) return Response.json({ session: currentSession });
      return Response.json(
        { error: "That source id is already assigned to different media." },
        { status: 409 }
      );
    }
    const candidateInfoHash = candidate.kind === "magnet"
      ? magnetInfoHash(candidate.value)
      : null;
    if (
      candidateInfoHash &&
      currentSession.sources.some(
        (source) => source.kind === "magnet" && magnetInfoHash(source.value) === candidateInfoHash
      )
    ) return Response.json({ session: currentSession });
    if (currentSession.sources.length >= 30) {
      return Response.json({ error: "A session can queue up to 30 downloads." }, { status: 400 });
    }
    await store.setSource(
      token,
      {
        id: sourceId,
        kind: candidate.kind as SharedSource["kind"],
        value: String(candidate.value).slice(0, 8_000),
        label: String(candidate.label ?? "Shared media").slice(0, 180),
        addedBy: deviceId,
        addedAt: now,
      },
      now
    );
  } else if (action === "remove-source") {
    const sourceId = String(body.sourceId || "");
    if (!currentSession.sources.some((source) => source.id === sourceId)) {
      return Response.json({ error: "That queued source was not found." }, { status: 400 });
    }
    await store.setSources(
      token,
      currentSession.sources.filter((source) => source.id !== sourceId),
      now
    );
    if (currentSession.selectedMedia?.sourceId === sourceId) {
      await store.setSelectedMedia(token, null, now);
    }
  } else if (action === "rename-source") {
    const sourceId = String(body.sourceId || "");
    const label = String(body.label || "").trim().slice(0, 180);
    if (!label || !currentSession.sources.some((source) => source.id === sourceId)) {
      return Response.json({ error: "A queued source and name are required." }, { status: 400 });
    }
    await store.setSources(
      token,
      currentSession.sources.map((source) => source.id === sourceId ? { ...source, label } : source),
      now
    );
  } else if (action === "reorder-sources") {
    const sourceIds = Array.isArray(body.sourceIds)
      ? body.sourceIds.map((value) => String(value))
      : [];
    if (
      sourceIds.length !== currentSession.sources.length ||
      new Set(sourceIds).size !== sourceIds.length ||
      sourceIds.some((id) => !currentSession.sources.some((source) => source.id === id))
    ) {
      return Response.json({ error: "The complete queue order is required." }, { status: 400 });
    }
    const byId = new Map(currentSession.sources.map((source) => [source.id, source]));
    await store.setSources(
      token,
      sourceIds.map((id) => byId.get(id)!),
      now
    );
  } else if (action === "source-manifest") {
    const sourceId = String(body.sourceId || "");
    const source = currentSession.sources.find((item) => item.id === sourceId);
    if (!source) {
      return Response.json({ error: "That queued source was not found." }, { status: 400 });
    }
    if (source.kind !== "magnet") {
      return Response.json({ error: "Only torrent sources can publish a synchronized file manifest." }, { status: 409 });
    }
    const candidates = Array.isArray(body.mediaItems) ? body.mediaItems : [];
    if (!candidates.length || candidates.length > 500) {
      return Response.json({ error: "A torrent can publish between 1 and 500 video files." }, { status: 400 });
    }
    const indexes = candidates.map((value) => Number((value as Partial<SharedMediaItem>).fileIndex));
    if (
      indexes.some((index) => !Number.isInteger(index) || index < 0) ||
      new Set(indexes).size !== indexes.length
    ) {
      return Response.json({ error: "Every torrent video needs a unique file index." }, { status: 400 });
    }
    const nextManifest = mediaManifest(
      candidates.map((value, index) => {
        const candidate = value as Partial<SharedMediaItem>;
        return {
          index: indexes[index],
          path: String(candidate.path || candidate.name || "").slice(0, 500),
          size: Number(candidate.size),
          included: candidate.included !== false,
          priority: Boolean(candidate.priority),
        };
      }),
      sourceId
    );
    if (
      nextManifest.length !== candidates.length ||
      nextManifest.some((item) => !item.path || !Number.isSafeInteger(item.size) || item.size <= 0)
    ) {
      return Response.json({ error: "The torrent manifest contains an invalid video file." }, { status: 400 });
    }
    if (source.mediaItems?.length && !sameMediaManifest(source.mediaItems, nextManifest)) {
      return Response.json({ error: "This torrent already has a different synchronized file manifest." }, { status: 409 });
    }
    const submittedInfoHash = String(body.infoHash || "").toLowerCase();
    if (submittedInfoHash && !/^[a-f0-9]{40}$/.test(submittedInfoHash)) {
      return Response.json({ error: "A valid torrent info hash is required." }, { status: 400 });
    }
    const expectedInfoHash = source.kind === "magnet" ? magnetInfoHash(source.value) : null;
    if (expectedInfoHash && submittedInfoHash && expectedInfoHash !== submittedInfoHash) {
      return Response.json({ error: "The torrent info hash does not match the synchronized source." }, { status: 409 });
    }
    const infoHash = expectedInfoHash || submittedInfoHash;
    if (source.infoHash && infoHash && source.infoHash !== infoHash) {
      return Response.json({ error: "The torrent info hash does not match the synchronized source." }, { status: 409 });
    }
    const controls = new Map((source.mediaItems || []).map((item) => [item.id, item]));
    const incoming = new Map(nextManifest.map((item) => [item.id, item]));
    const order = source.mediaItems?.length ? source.mediaItems : nextManifest;
    const mediaItems = order.map((current) => {
      const item = incoming.get(current.id)!;
      return {
        ...item,
        included: controls.get(item.id)?.included ?? item.included,
        priority: controls.get(item.id)?.priority ?? item.priority,
      };
    });
    await store.setSources(
      token,
      currentSession.sources.map((item) => item.id === sourceId
        ? { ...item, infoHash: infoHash || item.infoHash, mediaItems }
        : item),
      now
    );
  } else if (action === "prioritize-media" || action === "include-media") {
    const itemId = String(body.itemId || "");
    const source = currentSession.sources.find((candidate) =>
      candidate.mediaItems?.some((item) => item.id === itemId)
    );
    if (!source) {
      return Response.json({ error: "That synchronized video was not found." }, { status: 400 });
    }
    const property = action === "prioritize-media" ? "priority" : "included";
    await store.setSources(
      token,
      currentSession.sources.map((candidate) => candidate.id === source.id
        ? {
            ...candidate,
            mediaItems: candidate.mediaItems?.map((item) => item.id === itemId
              ? { ...item, [property]: Boolean(body[property]) }
              : item),
          }
        : candidate),
      now
    );
  } else if (action === "reorder-media") {
    const sourceId = String(body.sourceId || "");
    const source = currentSession.sources.find((candidate) => candidate.id === sourceId);
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
    if (
      !source?.mediaItems ||
      itemIds.length !== source.mediaItems.length ||
      new Set(itemIds).size !== itemIds.length ||
      itemIds.some((id) => !source.mediaItems?.some((item) => item.id === id))
    ) {
      return Response.json({ error: "The complete episode order is required." }, { status: 400 });
    }
    const byId = new Map(source.mediaItems.map((item) => [item.id, item]));
    await store.setSources(
      token,
      currentSession.sources.map((candidate) => candidate.id === sourceId
        ? { ...candidate, mediaItems: itemIds.map((id) => byId.get(id)!) }
        : candidate),
      now
    );
  } else if (action === "select-media") {
    const candidate = body.media as Partial<SelectedMedia> | null;
    if (!candidate?.name || !Number.isFinite(candidate.size)) {
      return Response.json({ error: "A media file is required" }, { status: 400 });
    }
    const sourceId = candidate.sourceId ? String(candidate.sourceId).slice(0, 80) : undefined;
    if (sourceId && !currentSession.sources.some((source) => source.id === sourceId)) {
      return Response.json({ error: "That queued source was not found." }, { status: 400 });
    }
    const source = sourceId
      ? currentSession.sources.find((item) => item.id === sourceId)
      : undefined;
    const itemId = candidate.itemId ? String(candidate.itemId).slice(0, 100) : undefined;
    const manifestItem = itemId
      ? source?.mediaItems?.find((item) => item.id === itemId)
      : source?.mediaItems?.find((item) => item.fileIndex === Number(candidate.fileIndex));
    if (source?.mediaItems?.length && !manifestItem) {
      return Response.json({ error: "That synchronized video was not found in the torrent manifest." }, { status: 400 });
    }
    if (manifestItem && manifestItem.id !== mediaItemId(sourceId!, manifestItem.fileIndex)) {
      return Response.json({ error: "The synchronized video identity is invalid." }, { status: 400 });
    }
    if (candidate.fileIndex !== undefined && (!Number.isInteger(candidate.fileIndex) || Number(candidate.fileIndex) < 0)) {
      return Response.json({ error: "A valid media file index is required." }, { status: 400 });
    }
    await store.setSelectedMedia(
      token,
      {
        itemId: manifestItem?.id || itemId,
        sourceId,
        fileIndex: manifestItem?.fileIndex ?? (Number.isInteger(candidate.fileIndex) ? Number(candidate.fileIndex) : undefined),
        name: manifestItem?.name || String(candidate.name).slice(0, 260),
        size: manifestItem?.size || Number(candidate.size),
        fingerprint: candidate.fingerprint ? String(candidate.fingerprint).slice(0, 128) : undefined,
      },
      now
    );
  } else if (action === "voice-signal") {
    const candidate = body.signal as Partial<VoiceSignal> | null;
    const toId = String(candidate?.toId || "").slice(0, 80);
    const type = String(candidate?.type || "") as VoiceSignalType;
    const data = String(candidate?.data || "");
    if (
      !toId ||
      toId === deviceId ||
      !currentSession.participants.some((participant) => participant.deviceId === toId) ||
      !["offer", "answer", "candidate"].includes(type) ||
      !data ||
      data.length > 32_000
    ) {
      return Response.json({ error: "A valid voice signal and recipient are required." }, { status: 400 });
    }
    await store.addVoiceSignal(token, {
      id: crypto.randomUUID(),
      fromId: deviceId,
      toId,
      type,
      data,
      createdAt: now,
    });
  } else if (action === "player") {
    const candidate = body.player as Partial<PlayerState>;
    await store.setPlayer(
      token,
      {
        paused: Boolean(candidate.paused),
        position: Math.max(0, Number(candidate.position) || 0),
        playbackRate: Math.max(0.25, Math.min(2, Number(candidate.playbackRate) || 1)),
        audioLanguage: String(candidate.audioLanguage ?? "original").slice(0, 40),
        subtitleLanguage: String(candidate.subtitleLanguage ?? "off").slice(0, 40),
        subtitleOffset: Math.max(-10_000, Math.min(10_000, Number(candidate.subtitleOffset) || 0)),
        changedAt: now,
        actorId: deviceId,
      },
      now
    );
  } else {
    return Response.json({ error: "Unsupported session action" }, { status: 400 });
  }

  return Response.json({ session: await store.get(token, deviceId) });
}

const sessionStores = new Map<string, Promise<SessionStore>>();

/**
 * Returns the process-wide session store for a runtime environment. One store
 * is created per (session file, ICE servers) pair and cached, so in-memory
 * state and the persistence debounce are shared across requests (the previous
 * per-request construction only worked because the session map was module
 * global).
 */
function sessionStoreFor(runtimeEnv: SessionRuntimeEnv): Promise<SessionStore> {
  const filePath = runtimeEnv.WATCHPAIR_SESSION_FILE?.trim() || null;
  const key = `${filePath ?? "memory"}\u0000${runtimeEnv.WATCHPAIR_ICE_SERVERS ?? ""}`;
  let pending = sessionStores.get(key);
  if (!pending) {
    const configuredVoice = voiceConfig(runtimeEnv.WATCHPAIR_ICE_SERVERS);
    const store: SessionStore = filePath === null
      ? new MemorySessionStore(configuredVoice)
      : new FileSessionStore(configuredVoice, filePath);
    pending = store.initialize().then(() => store).catch((error) => {
      sessionStores.delete(key);
      throw error;
    });
    sessionStores.set(key, pending);
  }
  return pending;
}

export async function handleSessionApi(request: Request, runtimeEnv: SessionRuntimeEnv = {}) {
  try {
    const store = await sessionStoreFor(runtimeEnv);

    if (request.method === "GET") return handleGet(request, store);
    if (request.method === "POST") return handlePost(request, store);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  } catch (error) {
    return errorResponse(error);
  }
}
