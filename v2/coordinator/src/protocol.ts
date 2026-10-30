import { z } from 'zod';

export const PROTOCOL = 2;
export const LIMITS = { entries: 10_000, members: 64, watchers: 8, tracks: 128, sources: 128 } as const;
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/);
const label = z.string().trim().min(1).max(300).refine(v => !/[\x00-\x1f\x7f]/.test(v));
const seconds = z.number().finite().min(0).max(7 * 24 * 3600);
const relativePath = z.string().min(1).max(2048).refine(v =>
  !v.startsWith('/') && !v.includes('\\') && !/[\x00-\x1f:]/.test(v) &&
  v.split('/').every(p => p && p !== '.' && p !== '..'), 'Expected a relative manifest path');

export const sourceSchema = z.object({
  id, kind: z.enum(['torrent', 'share', 'direct']), label,
  uri: z.string().max(16384), identity: z.string().min(1).max(200),
  publisherId: id.optional(),
  assets:z.array(z.object({fileIndex:z.number().int().min(0).max(2147483647),path:relativePath,size:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),sha256:z.string().regex(/^[a-f0-9]{64}$/),merkleRoot:z.string().regex(/^[a-f0-9]{64}$/),kind:z.enum(['video','subtitle'])}).strict()).max(20_000).optional(),
}).strict();
export const fileSchema = z.object({
  mediaId: id, path: relativePath, label, fileIndex: z.number().int().min(0).max(2147483647),
  size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  duration: seconds.nullable().default(null), selected: z.boolean(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  merkleRoot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const trackKey = z.string().min(1).max(200);
const commands = [
  z.object({ type: z.literal('room.rename'), name: label }),
  z.object({ type: z.literal('member.rename'), name: label }),
  z.object({ type: z.literal('member.key'), publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }),
  z.object({ type:z.literal('source.add'),source:sourceSchema }),
  z.object({ type:z.literal('source.remove'),sourceId:id }),
  z.object({ type: z.literal('queue.add'), source: sourceSchema, files: z.array(fileSchema).min(1).max(LIMITS.entries) }),
  z.object({ type: z.literal('queue.select'), sourceId: id, mediaIds: z.array(id).max(LIMITS.entries) }),
  z.object({ type: z.literal('queue.reorder'), ids: z.array(id).max(LIMITS.entries) }),
  z.object({ type: z.literal('queue.remove'), ids: z.array(id).min(1).max(LIMITS.entries) }),
  z.object({ type: z.literal('queue.clear'), scope: z.enum(['upcoming', 'watched']) }),
  z.object({ type: z.literal('queue.rename'), entryId: id, label }),
  z.object({ type: z.literal('queue.identify'), entryId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ type: z.literal('playback.choose'), entryId: id }),
  z.object({ type: z.literal('playback.play') }),
  z.object({ type: z.literal('playback.pause') }),
  z.object({ type: z.literal('playback.seek'), position: seconds }),
  z.object({ type: z.literal('playback.rate'), rate: z.number().finite().min(0.25).max(3) }),
  z.object({ type: z.literal('playback.next') }),
  z.object({ type: z.literal('playback.ended') }),
  z.object({ type: z.literal('tracks.select'), audio: trackKey, subtitle: trackKey, subtitleDelay: z.number().finite().min(-600).max(600) }),
  z.object({ type: z.literal('watch.join') }),
  z.object({ type: z.literal('watch.leave') }),
  z.object({ type: z.literal('watch.exclude'), memberId: id }),
  z.object({ type: z.literal('history.mark'), ids: z.array(id).min(1).max(LIMITS.entries), watched: z.boolean() }),
  z.object({ type: z.literal('history.rewatch'), entryId: id }),
  z.object({ type: z.literal('room.successor'), memberId: id.nullable() }),
  z.object({ type: z.literal('room.handoff'), memberId: id }),
  z.object({ type: z.literal('room.claim-host') }),
  z.object({ type: z.literal('room.remove-member'), memberId: id }),
  z.object({ type: z.literal('room.rotate-invite') }),
  z.object({ type: z.literal('room.rotate-recovery') }),
  z.object({ type: z.literal('room.delete') }),
] as const;
export const commandSchema = z.discriminatedUnion('type', commands.map(c => c.strict()) as unknown as typeof commands);
export const envelopeSchema = z.object({
  operationId: z.string().uuid(), queueRevision: z.number().int().min(0).optional(),
  generation: z.number().int().min(0).optional(), command: commandSchema,
}).strict();
export const statusSchema = z.object({
  type: z.literal('status'), generation: z.number().int().min(0),
  entryId: id.nullable(), ready: z.boolean(), reason: z.string().max(300),
  position: seconds, duration: seconds.nullable(), identity: z.string().max(200),
  audio: z.array(trackKey).max(LIMITS.tracks), subtitles: z.array(trackKey).max(LIMITS.tracks),
  tracksKnown: z.boolean().optional(),
}).strict();
export const socketMessageSchema = z.discriminatedUnion('type', [
  statusSchema, z.object({ type: z.literal('ping'), clientTime: z.number().finite() }).strict(),
]);
export type Source = z.infer<typeof sourceSchema>;
export type FileDescriptor = z.infer<typeof fileSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type Status = z.infer<typeof statusSchema>;
export type Interval = [number, number];
export type Entry = Omit<FileDescriptor, 'selected'> & {
  id: string; sourceId: string; enabled: boolean; watchedAt: number | null;
  viewingId: string; coverage: Interval[];
};
export type Playback = {
  entryId: string | null; generation: number; position: number; anchor: number;
  paused: boolean; requested: boolean; startsAt: number | null; rate: number;
  reason: string; audio: string; subtitle: string; subtitleDelay: number;
};
export type Live = { connectionId: string; lastSeen: number; status: Status | null; statusAt: number; coveragePosition: number | null; coverageAt: number };
export type Member = {
  id: string; name: string; tokenHash: string; publicKey: string | null; joinedAt: number;
  joinHash: string;
  watch: 'idle' | 'staging' | 'active' | 'excluded'; live: Live | null;
  endpoint?: { address: string; port: number } | null;
};
export type Room = {
  id: string; name: string; hostId: string; successorId: string | null;
  inviteHash: string; recoveryHash: string; createdAt: number;
  revision: number; queueRevision: number; historyGeneration: number; sources: Source[]; entries: Entry[];
  playback: Playback; members: Member[]; reporterId: string | null;
  recoveryRetry: { oldHash: string; retryHash: string } | null;
};
export type History = {
  id: string; entryId: string; mediaId: string; label: string;
  path?: string; sourceId?: string; sourceLabel?: string;
  // Unix epoch milliseconds, stored and sent as an integer (never Unix seconds).
  watchedAt: number; method: 'automatic' | 'manual'; coverage: number; duration: number | null;
};
export type Change = { roomId: string; type: 'snapshot' | 'state' | 'presence' | 'deleted'; revision: number; data: unknown };

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function requireThat(value: unknown, code: string, message: string, status = 409): asserts value {
  if (!value) throw new DomainError(code, message, status);
}
export function mergeCoverage(intervals: Interval[], start: number, end: number, duration: number): Interval[] {
  start = Math.max(0, Math.min(duration, start)); end = Math.max(start, Math.min(duration, end));
  if (end <= start) return intervals;
  const result: Interval[] = [];
  let inserted = false;
  for (const [a, b] of intervals) {
    if (b < start) result.push([a, b]);
    else if (end < a) { if (!inserted) { result.push([start, end]); inserted = true; } result.push([a, b]); }
    else { start = Math.min(start, a); end = Math.max(end, b); }
  }
  if (!inserted) result.push([start, end]);
  return result;
}
export const coverageSeconds = (intervals: Interval[]) => intervals.reduce((sum, [a, b]) => sum + b - a, 0);
export function timelinePosition(p: Playback, now: number, duration: number | null = null) {
  const position = Math.max(0, p.position + (p.paused ? 0 : Math.max(0, now - (p.startsAt ?? p.anchor)) / 1000 * p.rate));
  return duration && duration > 0 ? Math.min(duration, position) : position;
}
