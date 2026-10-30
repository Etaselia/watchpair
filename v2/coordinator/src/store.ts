import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { timelinePosition, type Entry, type History, type Room } from './protocol.js';

export type Operation = { memberId: string; id: string; hash: string; revision: number; secret?: string };
export type Save = { metadata?: boolean; queue?: boolean; entries?: Entry[]; history?: History[]; clearHistory?: boolean; operation?: Operation; creationHash?: string };
type Metadata = Pick<Room, 'id' | 'name' | 'hostId' | 'successorId' | 'inviteHash' | 'recoveryHash' | 'createdAt' | 'sources' | 'members' | 'recoveryRetry'>;
type Runtime = Pick<Room, 'revision' | 'queueRevision' | 'historyGeneration' | 'playback' | 'reporterId'>;

// Only the small runtime row is checkpointed during playback. A 10,000-entry
// season pack is never rewritten on every heartbeat or coverage report.
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 1) { this.db.close(); throw new Error('This coordinator cannot open a newer WatchPair database. Update the coordinator.'); }
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys (id TEXT PRIMARY KEY, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creations (retry_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS runtime (room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room_id,id));
      CREATE INDEX IF NOT EXISTS entries_order ON entries(room_id,ordinal);
      CREATE TABLE IF NOT EXISTS history (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL, watched_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room_id,id));
      CREATE INDEX IF NOT EXISTS history_order ON history(room_id,watched_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS operations (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member_id TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(room_id,member_id,id));
      PRAGMA user_version=1;
    `);
    // Older coordinators used an epoch + monotonic clock with fractional
    // milliseconds. Normalize both the JSON and ordering column together so
    // integer history cursors cannot skip records within the same millisecond.
    // Fill missing legacy context only through exact entry/source identities;
    // removed sources cannot be reconstructed by guessing from episode names.
    this.transaction(() => {
      this.db.exec(`
        UPDATE entries SET data=json_set(data,'$.watchedAt',CAST(json_extract(data,'$.watchedAt') AS INTEGER))
          WHERE json_type(data,'$.watchedAt')='real';
        UPDATE history SET watched_at=CAST(json_extract(data,'$.watchedAt') AS INTEGER),
          data=json_set(data,'$.watchedAt',CAST(json_extract(data,'$.watchedAt') AS INTEGER))
          WHERE json_type(data,'$.watchedAt')='real';
        UPDATE history AS h SET data=json_set(h.data,
          '$.path',COALESCE(json_extract(h.data,'$.path'),(SELECT json_extract(e.data,'$.path') FROM entries e WHERE e.room_id=h.room_id AND e.id=json_extract(h.data,'$.entryId'))),
          '$.sourceId',COALESCE(json_extract(h.data,'$.sourceId'),(SELECT json_extract(e.data,'$.sourceId') FROM entries e WHERE e.room_id=h.room_id AND e.id=json_extract(h.data,'$.entryId'))))
          WHERE (json_extract(h.data,'$.path') IS NULL OR json_extract(h.data,'$.sourceId') IS NULL)
          AND EXISTS(SELECT 1 FROM entries e WHERE e.room_id=h.room_id AND e.id=json_extract(h.data,'$.entryId'));
        UPDATE history AS h SET data=json_set(h.data,'$.sourceLabel',
          (SELECT json_extract(s.value,'$.label') FROM rooms r,json_each(r.data,'$.sources') s WHERE r.id=h.room_id AND json_extract(s.value,'$.id')=json_extract(h.data,'$.sourceId')))
          WHERE json_extract(h.data,'$.sourceLabel') IS NULL
          AND EXISTS(SELECT 1 FROM rooms r,json_each(r.data,'$.sources') s WHERE r.id=h.room_id AND json_extract(s.value,'$.id')=json_extract(h.data,'$.sourceId'));
      `);
    });
    if(path!==':memory:')for(const file of [path,`${path}-wal`,`${path}-shm`])if(existsSync(file))chmodSync(file,0o600);
  }
  close() { this.db.close(); }
  key(id: string): Buffer {
    const current = this.db.prepare('SELECT secret FROM keys WHERE id=?').get(id);
    if (current) return Buffer.from(String(current.secret), 'base64');
    const secret = randomBytes(32);
    this.db.prepare('INSERT INTO keys(id,secret) VALUES(?,?)').run(id, secret.toString('base64'));
    return secret;
  }
  creation(retryHash: string): string | null {
    const row = this.db.prepare('SELECT room_id FROM creations WHERE retry_hash=?').get(retryHash);
    return row ? String(row.room_id) : null;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  load(): Room[] {
    return this.db.prepare('SELECT id,data FROM rooms').all().map(row => {
      const meta = JSON.parse(String(row.data)) as Metadata;
      const runtime = this.db.prepare('SELECT data FROM runtime WHERE room_id=?').get(String(row.id));
      if (!runtime) throw new Error('Room runtime is missing; restore a database backup.');
      const state = JSON.parse(String(runtime.data)) as Runtime;
      const entries = this.db.prepare('SELECT data FROM entries WHERE room_id=? ORDER BY ordinal').all(String(row.id))
        .map(e => JSON.parse(String(e.data)) as Entry);
      return { ...meta, ...state, historyGeneration: state.historyGeneration ?? 0, entries, members: meta.members.map(m => ({ ...m, live: null, watch: 'idle' as const })) };
    });
  }
  save(room: Room, now: number, plan: Save = {}) {
    this.transaction(() => {
      if (plan.metadata) {
        const meta: Metadata = {
          id: room.id, name: room.name, hostId: room.hostId, successorId: room.successorId,
          inviteHash: room.inviteHash, recoveryHash: room.recoveryHash, createdAt: room.createdAt,
          recoveryRetry: room.recoveryRetry,
          sources: room.sources, members: room.members.map(m => ({ ...m, live: null, watch: 'idle' })),
        };
        this.db.prepare('INSERT INTO rooms(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
          .run(room.id, JSON.stringify(meta));
      }
      if (plan.creationHash) this.db.prepare('INSERT INTO creations(retry_hash,room_id) VALUES(?,?)').run(plan.creationHash, room.id);
      const runtime: Runtime = {
        revision: room.revision, queueRevision: room.queueRevision, historyGeneration: room.historyGeneration, reporterId: room.reporterId,
        playback: { ...room.playback, position: timelinePosition(room.playback, now, room.entries.find(e=>e.id===room.playback.entryId)?.duration), anchor: now,
          startsAt: room.playback.startsAt !== null && room.playback.startsAt > now ? room.playback.startsAt : null },
      };
      this.db.prepare('INSERT INTO runtime(room_id,data) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET data=excluded.data')
        .run(room.id, JSON.stringify(runtime));
      if (plan.queue) {
        this.db.prepare('DELETE FROM entries WHERE room_id=?').run(room.id);
        const insert = this.db.prepare('INSERT INTO entries(room_id,id,ordinal,data) VALUES(?,?,?,?)');
        room.entries.forEach((entry, ordinal) => insert.run(room.id, entry.id, ordinal, JSON.stringify(entry)));
      } else {
        const update = this.db.prepare('UPDATE entries SET data=? WHERE room_id=? AND id=?');
        for (const entry of plan.entries ?? []) update.run(JSON.stringify(entry), room.id, entry.id);
      }
      if (plan.clearHistory) this.db.prepare('DELETE FROM history WHERE room_id=?').run(room.id);
      const history = this.db.prepare('INSERT OR IGNORE INTO history(room_id,id,watched_at,data) VALUES(?,?,?,?)');
      for (const item of plan.history ?? []) history.run(room.id, item.id, item.watchedAt, JSON.stringify(item));
      if (plan.operation) {
        const op = plan.operation;
        this.db.prepare('INSERT INTO operations(room_id,member_id,id,hash,revision) VALUES(?,?,?,?,?)')
          .run(room.id, op.memberId, op.id, op.hash, op.revision);
        // UUIDs are scoped to a member. Keep a documented 10,000-operation retry
        // window per room; retaining large snapshots for deduplication is avoided.
        this.db.prepare('DELETE FROM operations WHERE room_id=? AND revision < ?').run(room.id, Math.max(0, room.revision - 10_000));
      }
    });
  }
  operation(roomId: string, memberId: string, id: string): { hash: string; revision: number } | null {
    const row = this.db.prepare('SELECT hash,revision FROM operations WHERE room_id=? AND member_id=? AND id=?').get(roomId, memberId, id);
    return row ? { hash: String(row.hash), revision: Number(row.revision) } : null;
  }
  history(roomId: string, before: { time: number; id: string } | null = null, limit = 200, search = ''): History[] {
    let where = 'room_id=?'; const values: (string | number)[] = [roomId];
    if (before) { where += ' AND (watched_at < ? OR (watched_at = ? AND id < ?))'; values.push(before.time, before.time, before.id); }
    if (search) { where += " AND (json_extract(data,'$.label') || ' ' || COALESCE(json_extract(data,'$.path'),'') || ' ' || COALESCE(json_extract(data,'$.sourceLabel'),'')) LIKE ? ESCAPE '\\' COLLATE NOCASE"; values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`); }
    values.push(limit);
    const rows = this.db.prepare(`SELECT data FROM history WHERE ${where} ORDER BY watched_at DESC,id DESC LIMIT ?`).all(...values);
    return rows.map(row => JSON.parse(String(row.data)) as History);
  }
  deleteRoom(id: string) { this.transaction(() => this.db.prepare('DELETE FROM rooms WHERE id=?').run(id)); }
}
