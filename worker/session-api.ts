import {
  initialPlayerState,
  type LocalReadiness,
  type ParticipantState,
  type PlayerState,
  type QueueReadiness,
  type SelectedMedia,
  type SharedSource,
  type WatchSession,
} from "../lib/session-types";

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PARTICIPANT_ACTIVE_MS = 20_000;

export interface SessionRuntimeEnv {
  DB?: D1Database;
}

interface SessionRow {
  token: string;
  host_id: string;
  source_json: string | null;
  selected_media_json: string | null;
  player_json: string;
  seq: number;
  created_at: number;
  expires_at: number;
  updated_at: number;
}

interface ParticipantRow {
  device_id: string;
  name: string;
  state_json: string;
  updated_at: number;
}

interface SessionStore {
  initialize(): Promise<void>;
  get(token: string): Promise<WatchSession | null>;
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
}

function json<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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

function defaultReadiness(): LocalReadiness {
  return { ...defaultQueueReadiness(), queue: {} };
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

function sanitizeReadiness(value: Partial<LocalReadiness> | undefined): LocalReadiness {
  const queue = Object.fromEntries(
    Object.entries(value?.queue || {})
      .filter(([id]) => /^[a-zA-Z0-9-]{8,80}$/.test(id))
      .slice(0, 30)
      .map(([id, state]) => [id, sanitizeQueueReadiness(state)])
  );
  return { ...sanitizeQueueReadiness(value), queue };
}

function normalizeSources(value: string | null): SharedSource[] {
  const stored = json<SharedSource | SharedSource[] | null>(value, null);
  if (!stored) return [];
  return (Array.isArray(stored) ? stored : [stored]).filter(
    (item) => item && typeof item.id === "string" && typeof item.value === "string"
  );
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

class D1SessionStore implements SessionStore {
  constructor(private readonly db: D1Database) {}

  async initialize() {
    await this.db.batch([
      this.db.prepare(`CREATE TABLE IF NOT EXISTS watch_sessions (
        token TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        source_json TEXT,
        selected_media_json TEXT,
        player_json TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      this.db.prepare(`CREATE TABLE IF NOT EXISTS watch_participants (
        session_token TEXT NOT NULL,
        device_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_token, device_id)
      )`),
      this.db.prepare(
        "CREATE INDEX IF NOT EXISTS watch_participants_session_idx ON watch_participants (session_token, updated_at)"
      ),
    ]);
  }

  async get(token: string): Promise<WatchSession | null> {
    const now = Date.now();
    const row = await this.db
      .prepare("SELECT * FROM watch_sessions WHERE token = ? AND expires_at > ?")
      .bind(token, now)
      .first<SessionRow>();
    if (!row) return null;

    const participantRows = await this.db
      .prepare(
        "SELECT device_id, name, state_json, updated_at FROM watch_participants WHERE session_token = ? AND updated_at >= ? ORDER BY updated_at DESC"
      )
      .bind(token, now - PARTICIPANT_ACTIVE_MS)
      .all<ParticipantRow>();
    const participants = stableParticipants(
      participantRows.results.map((participant) => ({
        deviceId: participant.device_id,
        name: participant.name,
        ...sanitizeReadiness(json<LocalReadiness>(participant.state_json, defaultReadiness())),
        updatedAt: participant.updated_at,
      })),
      row.host_id
    );

    const sources = normalizeSources(row.source_json);
    const selectedMedia = json<SelectedMedia | null>(row.selected_media_json, null);
    return {
      token: row.token,
      hostId: row.host_id,
      sources,
      source: activeSource(sources, selectedMedia),
      selectedMedia,
      player: json<PlayerState>(row.player_json, initialPlayerState(row.updated_at)),
      seq: row.seq,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
      serverTime: now,
      participants,
    };
  }

  async create(token: string, hostId: string, now: number) {
    await this.db
      .prepare(`INSERT INTO watch_sessions
        (token, host_id, source_json, selected_media_json, player_json, seq, created_at, expires_at, updated_at)
        VALUES (?, ?, NULL, NULL, ?, 0, ?, ?, ?)`)
      .bind(token, hostId, JSON.stringify(initialPlayerState(now)), now, now + SESSION_TTL_MS, now)
      .run();
  }

  async touch(
    token: string,
    deviceId: string,
    name: string,
    readiness: Partial<LocalReadiness> | undefined,
    now: number
  ) {
    await this.db
      .prepare(`INSERT INTO watch_participants (session_token, device_id, name, state_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_token, device_id) DO UPDATE SET
          name = excluded.name,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at`)
      .bind(token, deviceId, safeName(name), JSON.stringify(sanitizeReadiness(readiness)), now)
      .run();
    await this.db
      .prepare("UPDATE watch_sessions SET expires_at = ? WHERE token = ?")
      .bind(now + SESSION_TTL_MS, token)
      .run();
  }

  async setSource(token: string, source: SharedSource, now: number) {
    const serialized = JSON.stringify(source);
    await this.db
      .prepare(`UPDATE watch_sessions SET
        source_json = CASE
          WHEN source_json IS NULL OR NOT json_valid(source_json) THEN json_array(json(?))
          WHEN json_type(source_json) = 'array' THEN json_insert(source_json, '$[#]', json(?))
          ELSE json_array(json(source_json), json(?))
        END,
        seq = seq + 1,
        updated_at = ?
        WHERE token = ?`)
      .bind(serialized, serialized, serialized, now, token)
      .run();
  }

  async setSources(token: string, sources: SharedSource[], now: number) {
    await this.db
      .prepare("UPDATE watch_sessions SET source_json = ?, seq = seq + 1, updated_at = ? WHERE token = ?")
      .bind(JSON.stringify(sources), now, token)
      .run();
  }

  async setSelectedMedia(token: string, media: SelectedMedia | null, now: number) {
    await this.db
      .prepare("UPDATE watch_sessions SET selected_media_json = ?, player_json = ?, seq = seq + 1, updated_at = ? WHERE token = ?")
      .bind(media ? JSON.stringify(media) : null, JSON.stringify(initialPlayerState(now)), now, token)
      .run();
  }

  async setPlayer(token: string, player: PlayerState, now: number) {
    await this.db
      .prepare("UPDATE watch_sessions SET player_json = ?, seq = seq + 1, updated_at = ? WHERE token = ?")
      .bind(JSON.stringify(player), now, token)
      .run();
  }
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
}

const memorySessions = new Map<string, MemorySession>();

class MemorySessionStore implements SessionStore {
  async initialize() {}

  async get(token: string): Promise<WatchSession | null> {
    const record = memorySessions.get(token);
    const now = Date.now();
    if (!record || record.expiresAt <= now) {
      memorySessions.delete(token);
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
    };
  }

  async create(token: string, hostId: string, now: number) {
    memorySessions.set(token, {
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
    });
  }

  async touch(
    token: string,
    deviceId: string,
    name: string,
    readiness: Partial<LocalReadiness> | undefined,
    now: number
  ) {
    const record = memorySessions.get(token);
    if (!record) return;
    record.participants.set(deviceId, {
      deviceId,
      name: safeName(name),
      ...sanitizeReadiness(readiness),
      updatedAt: now,
    });
    record.expiresAt = now + SESSION_TTL_MS;
  }

  async setSource(token: string, source: SharedSource, now: number) {
    const record = memorySessions.get(token);
    if (!record) return;
    record.sources.push(source);
    record.seq += 1;
    record.updatedAt = now;
  }

  async setSources(token: string, sources: SharedSource[], now: number) {
    const record = memorySessions.get(token);
    if (!record) return;
    record.sources = sources;
    record.seq += 1;
    record.updatedAt = now;
  }

  async setSelectedMedia(token: string, media: SelectedMedia | null, now: number) {
    const record = memorySessions.get(token);
    if (!record) return;
    record.selectedMedia = media;
    record.player = initialPlayerState(now);
    record.seq += 1;
    record.updatedAt = now;
  }

  async setPlayer(token: string, player: PlayerState, now: number) {
    const record = memorySessions.get(token);
    if (!record) return;
    record.player = player;
    record.seq += 1;
    record.updatedAt = now;
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected session error";
  return Response.json({ error: message }, { status: 500 });
}

async function handleGet(request: Request, store: SessionStore) {
  const token = normalizeToken(new URL(request.url).searchParams.get("token"));
  if (!token) return Response.json({ error: "Session token is required" }, { status: 400 });

  const session = await store.get(token);
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
    let token = makeToken();
    for (let attempt = 0; attempt < 4 && (await store.get(token)); attempt += 1) {
      token = makeToken();
    }
    await store.create(token, deviceId, now);
    await store.touch(token, deviceId, name, defaultReadiness(), now);
    return Response.json({ session: await store.get(token) }, { status: 201 });
  }

  const token = normalizeToken(body.token);
  const currentSession = token ? await store.get(token) : null;
  if (!token || !currentSession) {
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
    if (currentSession.sources.length >= 30) {
      return Response.json({ error: "A session can queue up to 30 downloads." }, { status: 400 });
    }
    const candidate = body.source as Partial<SharedSource> | null;
    const sourceId = String(candidate?.id || crypto.randomUUID()).slice(0, 80);
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(sourceId)) {
      return Response.json({ error: "A valid source id is required" }, { status: 400 });
    }
    if (currentSession.sources.some((source) => source.id === sourceId)) return Response.json({ session: currentSession });
    if (!candidate?.value || !["magnet", "direct"].includes(String(candidate.kind))) {
      return Response.json({ error: "A supported source is required" }, { status: 400 });
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
  } else if (action === "select-media") {
    const candidate = body.media as Partial<SelectedMedia> | null;
    if (!candidate?.name || !Number.isFinite(candidate.size)) {
      return Response.json({ error: "A media file is required" }, { status: 400 });
    }
    const sourceId = candidate.sourceId ? String(candidate.sourceId).slice(0, 80) : undefined;
    if (sourceId && !currentSession.sources.some((source) => source.id === sourceId)) {
      return Response.json({ error: "That queued source was not found." }, { status: 400 });
    }
    if (candidate.fileIndex !== undefined && (!Number.isInteger(candidate.fileIndex) || Number(candidate.fileIndex) < 0)) {
      return Response.json({ error: "A valid media file index is required." }, { status: 400 });
    }
    await store.setSelectedMedia(
      token,
      {
        sourceId,
        fileIndex: Number.isInteger(candidate.fileIndex) ? Number(candidate.fileIndex) : undefined,
        name: String(candidate.name).slice(0, 260),
        size: Number(candidate.size),
        fingerprint: candidate.fingerprint ? String(candidate.fingerprint).slice(0, 128) : undefined,
      },
      now
    );
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

  return Response.json({ session: await store.get(token) });
}

export async function handleSessionApi(request: Request, runtimeEnv: SessionRuntimeEnv = {}) {
  try {
    const store: SessionStore = runtimeEnv?.DB
      ? new D1SessionStore(runtimeEnv.DB)
      : new MemorySessionStore();
    await store.initialize();

    if (request.method === "GET") return handleGet(request, store);
    if (request.method === "POST") return handlePost(request, store);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  } catch (error) {
    return errorResponse(error);
  }
}
