import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store, type Save } from './store.js';
import {
  PROTOCOL, LIMITS, DomainError, envelopeSchema, requireThat, coverageSeconds, mergeCoverage, timelinePosition,
  type Room, type Member, type Entry, type Envelope, type Status, type History, type Change,
} from './protocol.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const matches = (value: string, expected: string) => {
  const a = Buffer.from(hash(value), 'hex'), b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const queueCommand = (type: string) => (type.startsWith('queue.') && type !== 'queue.identify') || type.startsWith('history.') || type === 'source.remove';
const playbackCommand = (type: string) => type.startsWith('playback.') || type === 'tracks.select';
const freshPlayback = (now: number): Room['playback'] => ({
  entryId: null, generation: 0, position: 0, anchor: now, paused: true, requested: false,
  startsAt: null, rate: 1, reason: 'Choose an episode', audio: 'auto', subtitle: 'off', subtitleDelay: 0,
});
type Ack = { operationId: string; revision: number; queueRevision: number; replayed: boolean; secret?: string; secretCurrent?: boolean };

export class Engine extends EventEmitter {
  private rooms = new Map<string, Room>();
  private key: Buffer;
  private lastCheckpoint = 0;
  constructor(readonly store: Store, readonly now: () => number = () => Date.now()) {
    super(); this.key = store.key('capabilities-v2');
    for (const room of store.load()) {
      room.playback = { ...room.playback, paused: true, requested: false, startsAt: null,
        anchor: now(), generation: room.playback.generation + 1, reason: 'Coordinator restarted; join watch to resume' };
      room.reporterId = null; ++room.revision;
      this.rooms.set(room.id, room); store.save(room, now());
    }
  }
  private secret(...parts: string[]) { return createHmac('sha256', this.key).update(JSON.stringify(parts)).digest('base64url'); }
  room(id: string): Room {
    const room = this.rooms.get(id); requireThat(room, 'ROOM_NOT_FOUND', 'This room no longer exists.', 404); return room;
  }
  authenticate(roomId: string, token: string): Member {
    const member = this.room(roomId).members.find(m => matches(token, m.tokenHash));
    requireThat(member, 'UNAUTHORIZED', 'Your room credential is no longer valid.', 401); return member;
  }
  private host(room: Room, memberId: string) { requireThat(room.hostId === memberId, 'HOST_REQUIRED', 'Only the host can do that.', 403); }
  private member(room: Room, id: string) {
    const member = room.members.find(m => m.id === id); requireThat(member, 'MEMBER_NOT_FOUND', 'That member has left the room.', 404); return member;
  }
  private entry(room: Room, id: string) {
    const entry = room.entries.find(e => e.id === id); requireThat(entry, 'ENTRY_NOT_FOUND', 'That episode is not in this room.', 404); return entry;
  }
  private notify(room: Room, type: Change['type'], data: unknown) {
    this.emit('change', { roomId: room.id, type, revision: room.revision, data } satisfies Change);
  }
  private runtimeCopy(room: Room): Room {
    return { ...room, playback: { ...room.playback }, entries: [...room.entries],
      members: room.members.map(m => ({ ...m, live: m.live ? { ...m.live } : null })) };
  }
  private publicMember(m: Member) {
    return { id: m.id, name: m.name, publicKey: m.publicKey, watch: m.watch, connected: !!m.live,
      endpoint: m.live ? m.endpoint ?? null : null,
      status: m.live?.status ?? null, lastSeen: m.live?.lastSeen ?? null };
  }
  private publicEntry(e: Entry) {
    const { coverage, ...entry } = e;
    return { ...entry, coverageSeconds: coverageSeconds(coverage) };
  }
  private validateShare(source: import('./protocol.js').Source,memberId:string) {
    if(source.kind!=='share')return;
    requireThat(source.publisherId===memberId,'INVALID_PUBLISHER','A shared source must belong to its authenticated publisher.',403);
    const assets=source.assets??[];
    requireThat(assets.length>0&&assets.every(a=>a.size<=2**40),'SHARE_MANIFEST','Shared files must have a verified manifest and be at most 1 TiB each.');
    const indexes=new Set(assets.map(a=>a.fileIndex)),paths=new Set(assets.map(a=>a.path));
    requireThat(indexes.size===assets.length&&paths.size===assets.length,'SHARE_MANIFEST','Shared manifest indexes and paths must be unique.');
    const canonical=assets.map(a=>Object.fromEntries(Object.entries(a).sort(([a],[b])=>a<b?-1:a>b?1:0)));
    const identity=`share:${hash(JSON.stringify(canonical))}`;
    requireThat(source.identity===identity&&source.id===`${identity}:${memberId}`,'SHARE_MANIFEST','The shared manifest fingerprint is inconsistent.');
  }
  private state(room: Room) {
    return { id: room.id, name: room.name, hostId: room.hostId, successorId: room.successorId,
      inviteVersion: hash(room.inviteHash), recoveryVersion: hash(room.recoveryHash),
      revision: room.revision, queueRevision: room.queueRevision, historyGeneration: room.historyGeneration, playback: room.playback,
      members: room.members.map(m => this.publicMember(m)), reporterId: room.reporterId, serverTime: this.now() };
  }
  snapshot(id: string) {
    const room = this.room(id);
    return { protocol: PROTOCOL, ...this.state(room), sources: room.sources,
      entries: room.entries.map(e => this.publicEntry(e)), history: this.store.history(id), historyPageSize: 200 };
  }
  advertise(id: string, memberId: string, address: string, port: number) {
    const original=this.room(id), previous=this.member(original,memberId);
    const endpoint=port ? {address,port} : null;
    if (JSON.stringify(previous.endpoint??null)===JSON.stringify(endpoint)) return;
    const room=this.runtimeCopy(original);this.member(room,memberId).endpoint=endpoint;
    ++room.revision;this.store.save(room,this.now(),{metadata:true});this.rooms.set(id,room);this.notify(room,'state',this.state(room));
  }
  create(name: string, memberName: string, retryKey: string) {
    const retryHash = hash(retryKey), existing = this.store.creation(retryHash);
    if (existing) {
      const room = this.room(existing);
      const member = room.members.find(m => m.joinHash === retryHash);
      requireThat(member, 'CREATE_EXPIRED', 'Create a new room with a new request key.');
      return { roomId: room.id, memberId: member.id, token: this.secret('member', room.id, retryKey),
        invite: this.secret('initial-invite', room.id, retryKey), recovery: this.secret('initial-recovery', room.id, retryKey) };
    }
    const now = this.now(), id = randomUUID(), memberId = randomUUID();
    const token = this.secret('member', id, retryKey), invite = this.secret('initial-invite', id, retryKey), recovery = this.secret('initial-recovery', id, retryKey);
    const room: Room = {
      id, name, hostId: memberId, successorId: null, inviteHash: hash(invite), recoveryHash: hash(recovery), recoveryRetry: null,
      createdAt: now, revision: 0, queueRevision: 0, historyGeneration: 0, sources: [], entries: [], playback: freshPlayback(now), reporterId: null,
      members: [{ id: memberId, name: memberName, tokenHash: hash(token), publicKey: null, joinHash: retryHash, joinedAt: now, watch: 'idle', live: null }],
    };
    // Creation and its retry mapping commit together; credentials are derived
    // from a secret retry key, never a public tracing/operation UUID.
    this.store.save(room, now, { metadata: true, queue: true, creationHash: retryHash });
    this.rooms.set(id, room);
    return { roomId: id, memberId, token, invite, recovery };
  }
  join(id: string, invite: string, name: string, retryKey: string) {
    const original = this.room(id);
    requireThat(matches(invite, original.inviteHash), 'INVITE_REVOKED', 'This invite is invalid or was revoked.', 401);
    const joinHash = hash(retryKey), token = this.secret('member', id, retryKey);
    const previous = original.members.find(m => m.joinHash === joinHash);
    if (previous) {
      requireThat(matches(token, previous.tokenHash), 'CREDENTIAL_REPLACED', 'Use your recovered room credential.', 401);
      return { roomId: id, memberId: previous.id, token };
    }
    requireThat(original.members.length < LIMITS.members, 'ROOM_FULL', 'This room has reached its member limit.');
    const room = structuredClone(original), memberId = randomUUID();
    room.members.push({ id: memberId, name, tokenHash: hash(token), publicKey: null, joinHash, joinedAt: this.now(), watch: 'idle', live: null });
    ++room.revision; this.store.save(room, this.now(), { metadata: true }); this.rooms.set(id, room);
    this.notify(room, 'state', this.state(room));
    return { roomId: id, memberId, token };
  }
  recover(id: string, recovery: string, retryKey: string) {
    const original = this.room(id), retryHash = hash(retryKey);
    const retry = original.recoveryRetry?.retryHash === retryHash && matches(recovery, original.recoveryRetry.oldHash);
    requireThat(retry || matches(recovery, original.recoveryHash), 'INVALID_RECOVERY', 'The private recovery link is invalid or has been replaced.', 401);
    const token = this.secret('recovered-member', id, retryKey), newRecovery = this.secret('recovered-link', id, retryKey);
    if (!retry) {
      const room = structuredClone(original), host = this.member(room, room.hostId);
      host.tokenHash = hash(token); host.live = null; host.watch = 'idle';
      room.recoveryRetry = { oldHash: room.recoveryHash, retryHash }; room.recoveryHash = hash(newRecovery);
      this.freeze(room, 'Host recovered control; waiting for the host'); ++room.revision;
      this.store.save(room, this.now(), { metadata: true }); this.rooms.set(id, room); this.notify(room, 'state', this.state(room));
    }
    return { roomId: id, memberId: original.hostId, token, recovery: newRecovery };
  }
  connect(id: string, memberId: string) {
    const room = this.runtimeCopy(this.room(id)), member = this.member(room, memberId), connectionId = randomUUID();
    member.live = { connectionId, lastSeen: this.now(), status: null, statusAt: this.now(), coveragePosition: null, coverageAt: this.now() };
    const changed = this.reconcile(room);
    if (changed) { ++room.revision; this.store.save(room, this.now()); }
    this.rooms.set(id, room);
    this.notify(room, changed ? 'state' : 'presence', changed ? this.state(room) : { member: this.publicMember(member), serverTime: this.now() });
    return connectionId;
  }
  disconnect(id: string, memberId: string, connectionId: string) {
    const original = this.rooms.get(id); if (!original) return;
    const room = this.runtimeCopy(original);
    const member = room.members.find(m => m.id === memberId);
    if (!member?.live || member.live.connectionId !== connectionId) return;
    member.live = null;
    if (member.watch === 'active' || member.id === room.hostId) {
      this.freeze(room, member.id === room.hostId ? 'Host disconnected' : `${member.name} disconnected`);
      ++room.revision; this.reporter(room); this.store.save(room, this.now()); this.rooms.set(id, room); this.notify(room, 'state', this.state(room));
    } else { this.rooms.set(id, room); this.notify(room, 'presence', { member: this.publicMember(member), serverTime: this.now() }); }
  }
  private position(room: Room, at = this.now()) {
    return timelinePosition(room.playback, at, room.entries.find(e => e.id === room.playback.entryId)?.duration);
  }
  private freeze(room: Room, reason: string) {
    if (!room.playback.paused) this.invalidate(room, this.position(room), reason);
    else room.playback.reason = reason;
  }
  private invalidate(room: Room, position: number, reason: string) {
    room.playback.position = position; room.playback.anchor = this.now(); room.playback.paused = true;
    room.playback.startsAt = null; room.playback.reason = reason; ++room.playback.generation;
    for (const member of room.members) if (member.live) { member.live.coveragePosition = null; member.live.coverageAt = this.now(); }
  }
  private reporter(room: Room) {
    const active = room.members.filter(m => m.watch === 'active' && m.live);
    const next = active.find(m => m.id === room.hostId)?.id ?? active[0]?.id ?? null;
    if (next !== room.reporterId) {
      room.reporterId = next;
      if (next) { const live = this.member(room, next).live!; live.coveragePosition = null; live.coverageAt = this.now(); }
    }
  }
  private ready(room: Room, member: Member) {
    const status = member.live?.status, p = room.playback;
    const entry = room.entries.find(e => e.id === p.entryId);
    return !!(entry && status && status.entryId === entry.id && status.generation === p.generation &&
      status.ready && status.identity === entry.mediaId &&
      this.now() - member.live!.statusAt <= 1250 &&
      Math.abs(status.position - timelinePosition(p, p.paused ? this.now() : member.live!.statusAt, entry.duration)) <= 0.75 &&
      (!entry.duration || !status.duration || Math.abs(entry.duration - status.duration) <= 0.5) &&
      (p.audio === 'auto' || status.audio.includes(p.audio)) && (p.subtitle === 'off' || status.subtitles.includes(p.subtitle)));
  }
  private reconcile(room: Room) {
    if (!room.playback.entryId || !room.playback.requested) return false;
    const previous = JSON.stringify(room.playback);
    if (!this.member(room, room.hostId).live) this.freeze(room, 'Host disconnected');
    else {
      const required = room.members.filter(m => m.watch === 'active');
      const waiting = required.find(m => !this.ready(room, m));
      if (!required.length) this.freeze(room, 'Join watch to start playback');
      else if (waiting) {
        const status = waiting.live?.status;
        const reason = status?.generation === room.playback.generation && status.tracksKnown !== false && room.playback.audio !== 'auto' && !status.audio.includes(room.playback.audio)
          ? `${waiting.name} does not have the selected audio track`
          : status?.generation === room.playback.generation && status.tracksKnown !== false && room.playback.subtitle !== 'off' && !status.subtitles.includes(room.playback.subtitle)
            ? `${waiting.name} does not have the selected subtitle track`
            : status?.reason || `Waiting for ${waiting.name}`;
        this.freeze(room, reason);
      }
      else if (room.playback.paused) {
        room.playback.paused = false; room.playback.startsAt = this.now() + 500;
        room.playback.anchor = room.playback.startsAt; room.playback.reason = '';
      }
    }
    return previous !== JSON.stringify(room.playback);
  }
  private next(room: Room) {
    const current = room.entries.findIndex(e => e.id === room.playback.entryId);
    const entry = room.entries.slice(current + 1).find(e => e.enabled && e.watchedAt === null);
    if(room.playback.entryId!==entry?.id&&room.playback.subtitle.startsWith('ext:')){room.playback.subtitle='off';room.playback.subtitleDelay=0;}
    room.playback.entryId = entry?.id ?? null;
    room.playback.requested = !!entry && room.playback.requested;
    this.invalidate(room, 0, entry ? 'Preparing the next episode' : 'No more selected episodes');
  }
  private complete(room: Room, entry: Entry, method: History['method']): History | null {
    if (entry.watchedAt !== null) return null;
    entry.watchedAt = Math.trunc(this.now());
    return { id: entry.viewingId, entryId: entry.id, mediaId: entry.mediaId, label: entry.label,
      path: entry.path, sourceId: entry.sourceId, sourceLabel: room.sources.find(source => source.id === entry.sourceId)?.label,
      watchedAt: entry.watchedAt, method, coverage: coverageSeconds(entry.coverage), duration: entry.duration };
  }
  command(id: string, memberId: string, raw: unknown): Ack {
    const env: Envelope = envelopeSchema.parse(raw), original = this.room(id);
    this.member(original, memberId);
    const digest = hash(JSON.stringify(env)), previous = this.store.operation(id, memberId, env.operationId);
    const secretResult = (room: Room) => {
      const kind = env.command.type;
      if (kind !== 'room.rotate-invite' && kind !== 'room.rotate-recovery') return {};
      const secret = this.secret(kind, id, memberId, env.operationId);
      return { secret, secretCurrent: matches(secret, kind === 'room.rotate-invite' ? room.inviteHash : room.recoveryHash) };
    };
    if (previous) {
      requireThat(previous.hash === digest, 'OPERATION_CONFLICT', 'This operation ID was already used for a different command.');
      return { operationId: env.operationId, revision: previous.revision, queueRevision: original.queueRevision, replayed: true, ...secretResult(original) };
    }
    const c = env.command;
    if (queueCommand(c.type)) requireThat(env.queueRevision === original.queueRevision, 'QUEUE_CONFLICT', 'The queue changed; refresh it and try again.');
    if (playbackCommand(c.type)) requireThat(env.generation === original.playback.generation, 'PLAYBACK_CONFLICT', 'Playback changed; apply the command to the current episode.');
    const room = structuredClone(original), member = this.member(room, memberId), p = room.playback;
    const plan: Save = { entries: [], history: [] };
    let queueChanged = false;
    switch (c.type) {
      case 'room.rename': this.host(room, memberId); room.name = c.name; plan.metadata = true; break;
      case 'member.rename': member.name = c.name; plan.metadata = true; break;
      case 'member.key': member.publicKey = c.publicKey; plan.metadata = true; break;
      case 'source.add': {
        this.validateShare(c.source,memberId);
        requireThat(c.source.kind==='share'&&c.source.publisherId===memberId,'INVALID_PUBLISHER','Only publish your own authenticated shared assets.',403);
        const existing=room.sources.find(s=>s.id===c.source.id);
        requireThat(!existing||(existing.identity===c.source.identity&&existing.publisherId===memberId),'SOURCE_CONFLICT','This source identifies different shared content.');
        if(!existing){requireThat(room.sources.length<LIMITS.sources,'SOURCE_LIMIT','This room has reached its source limit.');room.sources.push(c.source);}
        plan.metadata=true;queueChanged=true;break;
      }
      case 'source.remove': {
        const source = room.sources.find(s => s.id === c.sourceId);
        requireThat(source, 'SOURCE_NOT_FOUND', 'This source was already removed.');
        const removed = new Set(room.entries.filter(e => e.sourceId === c.sourceId).map(e => e.id));
        for (const entry of room.entries) if (removed.has(entry.id)) entry.enabled = false;
        if (p.entryId && removed.has(p.entryId)) this.next(room);
        else if (source.assets?.some(a => p.subtitle === `ext:${a.sha256}`)) {
          const position = this.position(room); p.subtitle = 'off'; p.subtitleDelay = 0;
          this.invalidate(room, position, 'Shared subtitle removed');
        }
        room.entries = room.entries.filter(e => !removed.has(e.id));
        room.sources = room.sources.filter(s => s.id !== c.sourceId);
        plan.metadata = true; queueChanged = true; break;
      }
      case 'queue.add': {
        this.validateShare(c.source,memberId);
        const existing = room.sources.find(s => s.id === c.source.id);
        requireThat(!existing || (existing.identity === c.source.identity && existing.kind === c.source.kind), 'SOURCE_CONFLICT', 'This source ID already identifies different content.');
        if (!existing) { requireThat(room.sources.length < LIMITS.sources, 'SOURCE_LIMIT', 'This room has reached its source limit.'); room.sources.push(c.source); }
        if (c.source.kind === 'share') requireThat(c.source.publisherId === memberId, 'INVALID_PUBLISHER', 'A shared source must be published by the authenticated member.', 403);
        const indexes = new Set<number>(), media = new Set<string>(), byId = new Map(room.entries.map(e => [e.id, e]));
        const assets=new Map(c.source.assets?.map(a=>[a.fileIndex,a])??[]);
        for (const file of [...c.files].sort((a, b) => collator.compare(a.path, b.path))) {
          if(c.source.kind==='share'){
            const asset=assets.get(file.fileIndex);
            requireThat(asset&&asset.kind==='video'&&asset.path===file.path&&asset.sha256===file.sha256&&asset.merkleRoot===file.merkleRoot&&asset.size===file.size&&file.mediaId===`media:${hash(`${c.source.identity}\0${file.fileIndex}`)}`,'SHARE_MANIFEST','A shared episode does not match its verified asset manifest.');
          }
          requireThat(!indexes.has(file.fileIndex) && !media.has(file.mediaId), 'DUPLICATE_FILE', 'Each manifest file must have a unique index and media identity.');
          indexes.add(file.fileIndex); media.add(file.mediaId);
          const entryId = hash(`${c.source.id}\0${file.fileIndex}`), old = byId.get(entryId);
          if (old) {
            requireThat(old.mediaId === file.mediaId && old.size === file.size && old.path === file.path, 'MANIFEST_CHANGED', 'The source manifest changed; add it as a new source.');
            old.enabled = file.selected;
          } else {
            const { selected, ...descriptor } = file;
            room.entries.push({ ...descriptor, id: entryId, sourceId: c.source.id, enabled: selected,
              watchedAt: null, viewingId: randomUUID(), coverage: [] });
          }
        }
        requireThat(room.entries.length <= LIMITS.entries, 'QUEUE_LIMIT', 'A room can contain at most 10,000 media entries.');
        plan.metadata = true; queueChanged = true; break;
      }
      case 'queue.select': {
        const entries = room.entries.filter(e => e.sourceId === c.sourceId), known = new Set(entries.map(e => e.mediaId)), requested = new Set(c.mediaIds);
        requireThat(entries.length && requested.size === c.mediaIds.length && [...requested].every(id => known.has(id)), 'INVALID_SELECTION', 'The selection contains media outside this source.');
        for (const entry of entries) entry.enabled = requested.has(entry.mediaId);
        queueChanged = true; break;
      }
      case 'queue.reorder': {
        const upcoming = room.entries.filter(e => e.enabled && e.watchedAt === null), byId = new Map(upcoming.map(e => [e.id, e]));
        requireThat(c.ids.length === upcoming.length && new Set(c.ids).size === c.ids.length && c.ids.every(id => byId.has(id)), 'INVALID_ORDER', 'Reordering must include each upcoming episode once.');
        let index = 0; room.entries = room.entries.map(e => byId.has(e.id) ? byId.get(c.ids[index++]!)! : e);
        queueChanged = true; break;
      }
      case 'queue.remove': for (const entryId of new Set(c.ids)) this.entry(room, entryId).enabled = false; queueChanged = true; break;
      case 'queue.clear': {
        if (c.scope === 'upcoming') {
          for (const entry of room.entries) if (entry.enabled && entry.watchedAt === null) entry.enabled = false;
        } else {
          const removed = new Set(room.entries.filter(entry => entry.watchedAt !== null).map(entry => entry.id));
          for (const entry of room.entries) if (removed.has(entry.id)) entry.enabled = false;
          if (p.entryId && removed.has(p.entryId)) this.next(room);
          room.entries = room.entries.filter(entry => !removed.has(entry.id));
          plan.clearHistory = true;
          ++room.historyGeneration;
        }
        queueChanged = true; break;
      }
      case 'queue.rename': this.entry(room, c.entryId).label = c.label; queueChanged = true; break;
      case 'queue.identify': {
        const entry = this.entry(room, c.entryId);
        requireThat(!entry.sha256 || entry.sha256 === c.sha256, 'FINGERPRINT_CONFLICT', 'This file already has a different fingerprint. Verify the selected local copy.');
        if (!entry.sha256) { entry.sha256 = c.sha256; plan.entries!.push(entry); }
        break;
      }
      case 'playback.choose': {
        const entry = this.entry(room, c.entryId); requireThat(entry.enabled, 'NOT_SELECTED', 'Select this episode before playing it.');
        if(p.entryId!==entry.id&&p.subtitle.startsWith('ext:')){p.subtitle='off';p.subtitleDelay=0;}
        p.entryId = entry.id; p.requested = false; this.invalidate(room, 0, 'Ready to watch'); break;
      }
      case 'playback.play': {
        requireThat(this.member(room, room.hostId).live, 'HOST_OFFLINE', 'The host must reconnect or the designated successor must take over.');
        if (!p.entryId) { const entry = room.entries.find(e => e.enabled && e.watchedAt === null); requireThat(entry, 'EMPTY_QUEUE', 'Add and select an episode first.'); p.entryId = entry.id; this.invalidate(room, 0, 'Preparing playback'); }
        p.requested = true; break;
      }
      case 'playback.pause': this.invalidate(room, this.position(room), 'Paused by a room member'); p.requested = false; break;
      case 'playback.seek': {
        requireThat(p.entryId, 'NO_EPISODE', 'Choose an episode first.'); const entry = this.entry(room, p.entryId);
        requireThat(!entry.duration || c.position <= entry.duration, 'INVALID_POSITION', 'That position is beyond the episode duration.');
        this.invalidate(room, c.position, 'Preparing the seek'); break;
      }
      case 'playback.rate': {
        const position = this.position(room); p.rate = c.rate; this.invalidate(room, position, 'Preparing the playback rate'); break;
      }
      case 'playback.next': this.next(room); break;
      case 'playback.ended': {
        requireThat(room.reporterId === memberId && p.entryId, 'REPORTER_REQUIRED', 'Only the current active reporter can report the end of playback.');
        const entry = this.entry(room, p.entryId);
        requireThat(entry.duration && this.position(room) >= entry.duration - 1, 'NOT_ENDED', 'This episode has not reached its end.'); this.next(room); break;
      }
      case 'tracks.select': {
        p.audio = c.audio; p.subtitle = c.subtitle; p.subtitleDelay = c.subtitleDelay;
        this.invalidate(room, this.position(original), 'Applying shared audio and subtitles'); break;
      }
      case 'watch.join':
        requireThat(member.live, 'NOT_CONNECTED', 'Connect to the room before joining the watch.');
        requireThat(member.watch === 'active' || member.watch === 'staging' || room.members.filter(m => m.watch === 'active' || m.watch === 'staging').length < LIMITS.watchers, 'WATCH_FULL', 'At most eight participants can join a watch.');
        if (member.watch !== 'active') member.watch = 'staging'; break;
      case 'watch.leave': member.watch = 'idle'; break;
      case 'watch.exclude': this.host(room, memberId); this.member(room, c.memberId).watch = 'excluded'; break;
      case 'history.mark': {
        for (const entryId of new Set(c.ids)) {
          const entry = this.entry(room, entryId);
          if (c.watched) { const history = this.complete(room, entry, 'manual'); if (history) plan.history!.push(history); }
          else { entry.watchedAt = null; entry.coverage = []; entry.viewingId = randomUUID(); }
        }
        queueChanged = true; break;
      }
      case 'history.rewatch': {
        const entry = this.entry(room, c.entryId); entry.watchedAt = null; entry.coverage = []; entry.viewingId = randomUUID(); entry.enabled = true;
        room.entries = room.entries.filter(e => e.id !== entry.id).concat(entry); queueChanged = true; break;
      }
      case 'room.successor': this.host(room, memberId); if (c.memberId) this.member(room, c.memberId); room.successorId = c.memberId; plan.metadata = true; break;
      case 'room.handoff':
        this.host(room, memberId); this.member(room, c.memberId); room.hostId = c.memberId; room.successorId = null;
        room.recoveryHash = hash(this.secret('handoff', id, env.operationId)); room.recoveryRetry = null; plan.metadata = true; break;
      case 'room.claim-host':
        requireThat(room.successorId === memberId && !this.member(room, room.hostId).live, 'SUCCESSOR_REQUIRED', 'Only the designated successor can take over while the host is offline.', 403);
        room.hostId = memberId; room.successorId = null; room.recoveryHash = hash(this.secret('succession', id, env.operationId)); room.recoveryRetry = null; plan.metadata = true; break;
      case 'room.remove-member':
        this.host(room, memberId); requireThat(c.memberId !== room.hostId, 'HANDOFF_REQUIRED', 'Hand off the host role before leaving.'); this.member(room, c.memberId);
        room.members = room.members.filter(m => m.id !== c.memberId); if (room.successorId === c.memberId) room.successorId = null; plan.metadata = true; break;
      case 'room.rotate-invite': this.host(room, memberId); room.inviteHash = hash(this.secret(c.type, id, memberId, env.operationId)); plan.metadata = true; break;
      case 'room.rotate-recovery': this.host(room, memberId); room.recoveryHash = hash(this.secret(c.type, id, memberId, env.operationId)); room.recoveryRetry = null; plan.metadata = true; break;
      case 'room.delete': {
        this.host(room, memberId); this.store.deleteRoom(id); this.rooms.delete(id); ++room.revision;
        this.notify(room, 'deleted', { id }); return { operationId: env.operationId, revision: room.revision, queueRevision: room.queueRevision, replayed: false };
      }
    }
    if (queueChanged) {
      ++room.queueRevision; plan.queue = true;
      if (p.entryId && !this.entry(room, p.entryId).enabled) this.next(room);
    }
    this.reporter(room); this.reconcile(room); ++room.revision;
    if (plan.queue || plan.metadata) requireThat(
      Buffer.byteLength(JSON.stringify([room.sources, room.entries])) <= 8 * 1024 * 1024,
      'MANIFEST_LIMIT', 'The room manifest exceeds 8 MiB. Use a smaller pack or a separate room.');
    plan.operation = { memberId, id: env.operationId, hash: digest, revision: room.revision };
    this.store.save(room, this.now(), plan); this.rooms.set(id, room);
    const data = queueChanged ? this.snapshot(id) : { ...this.state(room),
      ...(plan.entries!.length ? { entries: plan.entries!.map(e => this.publicEntry(e)) } : {}),
      ...(plan.history!.length ? { history: plan.history } : {}) };
    this.notify(room, queueChanged ? 'snapshot' : 'state', data);
    return { operationId: env.operationId, revision: room.revision, queueRevision: room.queueRevision, replayed: false, ...secretResult(room) };
  }
  status(id: string, memberId: string, connectionId: string, status: Status) {
    const room = this.runtimeCopy(this.room(id)), member = this.member(room, memberId), live = member.live;
    requireThat(live?.connectionId === connectionId, 'CONNECTION_REPLACED', 'A newer connection replaced this device.', 401);
    const previousStatus = live.status, now = this.now(); live.lastSeen = now;
    if (status.generation !== room.playback.generation || status.entryId !== room.playback.entryId) {
      this.rooms.set(id, room); return;
    }
    live.status = status; live.statusAt = now;
    const plan: Save = { entries: [], history: [] };
    let changed = false;
    if (member.watch === 'staging' && this.ready(room, member)) { member.watch = 'active'; changed = true; }
    this.reporter(room);
    const p = room.playback, entryIndex = room.entries.findIndex(e => e.id === p.entryId);
    const entry = entryIndex >= 0 ? { ...room.entries[entryIndex]! } : null;
    if (entry) room.entries[entryIndex] = entry;
    if (entry && status.entryId === entry.id && status.generation === p.generation && status.identity === entry.mediaId) {
      if (entry.duration === null && status.duration && status.duration > 0) { entry.duration = status.duration; changed = true; plan.entries!.push(entry); }
      const elapsed = (now - live.coverageAt) / 1000;
      if (room.reporterId === memberId && member.watch === 'active' && !p.paused && status.ready && previousStatus?.generation === p.generation &&
        live.coveragePosition !== null && elapsed > 0 && status.position >= live.coveragePosition &&
        status.position - live.coveragePosition <= elapsed * p.rate + 0.5 && Math.abs(status.position - this.position(room, now)) <= 1.5 && entry.duration) {
        entry.coverage = mergeCoverage(entry.coverage, live.coveragePosition, status.position, entry.duration);
        if (entry.watchedAt === null && coverageSeconds(entry.coverage) / entry.duration >= 0.9) {
          const history = this.complete(room, entry, 'automatic'); if (history) plan.history!.push(history);
          ++room.queueRevision; changed = true;
        }
        plan.entries!.push(entry);
      }
      live.coveragePosition = p.paused || !status.ready ? null : status.position; live.coverageAt = now;
    } else { live.coveragePosition = null; live.coverageAt = now; }
    changed = this.reconcile(room) || changed;
    if (changed) {
      ++room.revision; this.store.save(room, now, plan);
      this.rooms.set(id, room);
      this.notify(room, 'state', { ...this.state(room), entries: plan.entries!.map(e => this.publicEntry(e)), history: plan.history });
    } else {
      // Coverage and timeline durability is coalesced by tick(); status itself
      // remains ephemeral and never serializes the whole room queue.
      this.rooms.set(id, room); this.notify(room, 'presence', { member: this.publicMember(member), serverTime: now });
    }
  }
  ping(id: string, memberId: string, connectionId: string) {
    const live = this.member(this.room(id), memberId).live;
    requireThat(live?.connectionId === connectionId, 'CONNECTION_REPLACED', 'A newer connection replaced this device.', 401);
    live.lastSeen = this.now();
  }
  tick() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      for (const member of room.members) if (member.live && now - member.live.lastSeen > 3000) this.disconnect(room.id, member.id, member.live.connectionId);
      const currentRoom = this.room(room.id);
      if (!currentRoom.playback.paused && currentRoom.members.some(m => m.watch === 'active' && !this.ready(currentRoom, m))) {
        // Clone only on a transition; ordinary ticks never copy a large pack.
        const next = structuredClone(currentRoom);
        if (this.reconcile(next)) { ++next.revision; this.store.save(next, now); this.rooms.set(next.id,next); this.notify(next,'state',this.state(next)); }
      }
      if (now - this.lastCheckpoint >= 1000) {
        const latest = this.room(room.id), current = latest.entries.find(e => e.id === latest.playback.entryId);
        this.store.save(latest, now, { entries: current ? [current] : [] });
      }
    }
    if (now - this.lastCheckpoint >= 1000) this.lastCheckpoint = now;
  }
}
