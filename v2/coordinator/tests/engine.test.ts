import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { DomainError, mergeCoverage, coverageSeconds, timelinePosition, type Command, type Status } from '../src/protocol.js';

const key = () => randomBytes(32).toString('base64url');
function fixture(database = ':memory:') {
  let time = 1_800_000_000_000;
  const store = new Store(database), engine = new Engine(store, () => time);
  const creatorKey = key(), host = engine.create('Friday watch', 'Host', creatorKey);
  const guest = engine.join(host.roomId, host.invite, 'Guest', key());
  const hostConnection = engine.connect(host.roomId, host.memberId), guestConnection = engine.connect(host.roomId, guest.memberId);
  const room = () => engine.room(host.roomId);
  const command = (c: Command, memberId = host.memberId, extra = {}) => engine.command(host.roomId, memberId, {
    operationId: randomUUID(), queueRevision: room().queueRevision, generation: room().playback.generation, command: c, ...extra,
  });
  const files = [1, 2, 10].map(i => ({ mediaId: `btih:fixture:${i}`, path: `Show/S01/E${i}.mkv`, label: `Episode ${i}`,
    fileIndex: i, size: 10_000_000, duration: 100, selected: true }));
  const add = () => command({ type: 'queue.add', source: { id: 'pack', kind: 'torrent', label: 'Show', uri: 'magnet:?xt=urn:btih:fixture', identity: 'btih:fixture' }, files });
  const status = (who: { memberId: string } = host, connection = hostConnection, overrides: Partial<Status> = {}) => {
    const p = room().playback;
    const entry = room().entries.find(e => e.id === p.entryId);
    engine.status(host.roomId, who.memberId, connection, { type: 'status', generation: p.generation,
      entryId: p.entryId, ready: true, reason: '', position: timelinePosition(p, time), duration: entry?.duration ?? null,
      identity: entry?.mediaId ?? '', audio: ['audio:0', 'audio:1'], subtitles: ['sub:0'], ...overrides });
  };
  const start = () => { add(); command({ type: 'watch.join' }); command({ type: 'playback.play' }); status(); };
  const advance = (milliseconds: number) => { time += milliseconds; };
  return { store, engine, creatorKey, host, guest, hostConnection, guestConnection, room, command, files, add, status, start, advance, now: () => time };
}
function code(expected: string) { return (e: unknown) => e instanceof DomainError && e.code === expected; }

test('removing a catalog source releases its manifest and preserves watched history', t => {
  const f = fixture(); t.after(() => f.store.close());f.add();
  const entry=f.room().entries[0]!;
  f.command({type:'history.mark',ids:[entry.id],watched:true});
  f.command({type:'playback.choose',entryId:entry.id});
  f.command({type:'source.remove',sourceId:'pack'},f.guest.memberId);
  assert.equal(f.room().sources.length,0);assert.equal(f.room().entries.length,0);assert.equal(f.room().playback.entryId,null);
  assert.equal(f.store.history(f.host.roomId,null).length,1);
  assert.equal(f.store.load().find(r=>r.id===f.host.roomId)!.sources.length,0);
});

test('interval union counts distinct viewing and clips to real media duration', () => {
  let intervals = mergeCoverage([], -1, 10, 100);
  intervals = mergeCoverage(intervals, 5, 20, 100);
  intervals = mergeCoverage(intervals, 50, 200, 100);
  intervals = mergeCoverage(intervals, 20, 50, 100);
  assert.deepEqual(intervals, [[0, 100]]); assert.equal(coverageSeconds(intervals), 100);
});

test('a delayed EOF or pause cannot move the shared timeline beyond the media duration',t=>{
  const f=fixture();t.after(()=>f.store.close());f.start();f.advance(102000);
  f.command({type:'playback.pause'});assert.equal(f.room().playback.position,100);
  const saved=JSON.parse(String(f.store.db.prepare('SELECT data FROM runtime WHERE room_id=?').get(f.host.roomId)!.data));assert.equal(saved.playback.position,100);
});

test('readiness compares each sample with its own timeline time and expires silent status',t=>{
  const f=fixture();t.after(()=>f.store.close());f.start();
  f.command({type:'playback.rate',rate:3});f.status();
  f.command({type:'watch.join'},f.guest.memberId);f.status(f.guest,f.guestConnection);
  f.advance(500);f.status();f.status(f.guest,f.guestConnection);
  for(let i=0;i<20;i++) { f.advance(200);f.status();f.engine.tick();f.status(f.guest,f.guestConnection);assert.equal(f.room().playback.paused,false); }
  // Heartbeats alone cannot keep an old readiness sample usable indefinitely.
  f.advance(1500);f.engine.ping(f.host.roomId,f.host.memberId,f.hostConnection);f.engine.ping(f.host.roomId,f.guest.memberId,f.guestConnection);f.engine.tick();assert.equal(f.room().playback.paused,true);
});

test('exact-copy fingerprints cannot be overwritten; history search treats wildcard characters literally', t => {
  const f = fixture(); t.after(() => f.store.close()); f.add();
  const entry = f.room().entries[0]!;
  let event: { type: string; data: { entries?: unknown[]; sources?: unknown[] } } | undefined;
  f.engine.once('change', value => { event = value; });
  f.command({ type: 'queue.identify', entryId: entry.id, sha256: 'a'.repeat(64) });
  assert.equal(f.room().entries[0]!.sha256, 'a'.repeat(64));
  assert.equal(event?.type, 'state'); assert.equal(event?.data.entries?.length, 1); assert.equal(event?.data.sources, undefined);
  assert.equal(f.store.load().find(room => room.id === f.host.roomId)!.entries[0]!.sha256, 'a'.repeat(64));
  assert.equal(f.room().queueRevision, 1, 'background file identification must not invalidate a pending user queue edit');
  assert.throws(() => f.command({ type: 'queue.identify', entryId: entry.id, sha256: 'b'.repeat(64) }), code('FINGERPRINT_CONFLICT'));
  f.command({ type: 'queue.rename', entryId: entry.id, label: 'Episode 100%_complete' });
  f.command({ type: 'history.mark', ids: f.room().entries.map(e => e.id), watched: true });
  assert.equal(f.store.history(f.host.roomId, null, 200, '%_').length, 1);
  assert.equal(f.store.history(f.host.roomId, null, 200, 'EPISODE').length, 3);
  assert.equal(f.store.history(f.host.roomId, null, 200, 'unknown').length, 0);
});

test('private credentials are separate, create/join retries are stable, and snapshots do not expose credentials', t => {
  const f = fixture(); t.after(() => f.store.close());
  const replay = f.engine.create('Friday watch', 'Host', f.creatorKey);
  assert.deepEqual(replay, f.host);
  assert.throws(() => f.engine.authenticate(f.host.roomId, f.host.invite), code('UNAUTHORIZED'));
  assert.throws(() => f.engine.command(f.host.roomId, f.guest.memberId, { operationId: randomUUID(), command: { type: 'room.delete' } }), code('HOST_REQUIRED'));
  const snapshot = JSON.stringify(f.engine.snapshot(f.host.roomId));
  for (const secret of [f.host.token, f.host.invite, f.host.recovery, f.guest.token, 'tokenHash', 'inviteHash', 'recoveryHash', 'joinHash']) assert.ok(!snapshot.includes(secret));
  const retryKey = key(), joined = f.engine.join(f.host.roomId, f.host.invite, 'Third', retryKey);
  assert.deepEqual(f.engine.join(f.host.roomId, f.host.invite, 'Third', retryKey), joined);
  f.command({ type: 'room.rotate-invite' });
  assert.throws(() => f.engine.join(f.host.roomId, f.host.invite, 'Rejected', key()), code('INVITE_REVOKED'));
});

test('queue commands serialize revisions and operation IDs; metadata-only heartbeats do not invalidate queue edits', t => {
  const f = fixture(); t.after(() => f.store.close()); f.add();
  const ids = f.room().entries.map(e => e.id).reverse(), q = f.room().queueRevision;
  const envelope = { operationId: randomUUID(), queueRevision: q, command: { type: 'queue.reorder' as const, ids } };
  const ack = f.engine.command(f.host.roomId, f.guest.memberId, envelope);
  assert.equal(ack.replayed, false); assert.equal(f.engine.command(f.host.roomId, f.guest.memberId, envelope).replayed, true);
  assert.deepEqual(f.room().entries.map(e => e.id), ids);
  assert.throws(() => f.command({ type: 'queue.rename', entryId: ids[0]!, label: 'Stale' }, f.host.memberId, { queueRevision: q }), code('QUEUE_CONFLICT'));
  assert.throws(() => f.engine.command(f.host.roomId, f.guest.memberId, { ...envelope, command: { type: 'queue.reorder', ids: [...ids].reverse() } }), code('OPERATION_CONFLICT'));
  const revision = f.room().queueRevision; f.status(); f.advance(1000); f.status(); assert.equal(f.room().queueRevision, revision);
  f.add(); assert.deepEqual(f.room().entries.map(e => e.id), ids, 're-adding a pack must preserve manual order');
});

test('membership does not block playback; joining stages a watcher; stale readiness cannot finish a seek', t => {
  const f = fixture(); t.after(() => f.store.close()); f.start();
  assert.equal(f.room().playback.paused, false); assert.equal(f.room().members.find(m => m.id === f.guest.memberId)!.watch, 'idle');
  f.command({ type: 'watch.join' }, f.guest.memberId); assert.equal(f.room().playback.paused, false);
  f.status(f.guest, f.guestConnection); assert.equal(f.room().members.find(m => m.id === f.guest.memberId)!.watch, 'active');
  const oldGeneration = f.room().playback.generation;
  f.command({ type: 'playback.seek', position: 60 }); assert.equal(f.room().playback.paused, true);
  f.status(f.guest, f.guestConnection, { generation: oldGeneration }); assert.equal(f.room().playback.paused, true);
  f.status(); assert.equal(f.room().playback.paused, true);
  f.status(f.guest, f.guestConnection, { position: 0 }); assert.equal(f.room().playback.paused, true, 'ready must refer to the target position');
  f.status(f.guest, f.guestConnection); assert.equal(f.room().playback.paused, false);
  f.command({ type: 'playback.pause' }); f.status(); f.status(f.guest, f.guestConnection);
  assert.equal(f.room().playback.paused, true, 'readiness must not override a manual room pause');
});

test('disconnect pauses immediately, a superseded socket cannot disconnect the replacement, and host override excludes a watcher', t => {
  const f = fixture(); t.after(() => f.store.close()); f.start();
  f.command({ type: 'watch.join' }, f.guest.memberId); f.status(f.guest, f.guestConnection); f.advance(1500);
  f.engine.disconnect(f.host.roomId, f.guest.memberId, f.guestConnection);
  assert.equal(f.room().playback.paused, true); assert.match(f.room().playback.reason, /disconnected/);
  const replacement = f.engine.connect(f.host.roomId, f.guest.memberId);
  f.engine.disconnect(f.host.roomId, f.guest.memberId, f.guestConnection);
  assert.equal(f.room().members.find(m => m.id === f.guest.memberId)!.live!.connectionId, replacement);
  assert.throws(() => f.command({ type: 'watch.exclude', memberId: f.host.memberId }, f.guest.memberId), code('HOST_REQUIRED'));
  f.command({ type: 'watch.exclude', memberId: f.guest.memberId }); f.status(); assert.equal(f.room().playback.paused, false);
});

test('silent loss detection and host succession preserve pause authority', t => {
  const f = fixture(); t.after(() => f.store.close()); f.start();
  f.command({ type: 'room.successor', memberId: f.guest.memberId }); f.advance(3001);
  f.engine.ping(f.host.roomId, f.guest.memberId, f.guestConnection); f.engine.tick();
  assert.equal(f.room().playback.paused, true);
  assert.throws(() => f.command({ type: 'playback.play' }, f.guest.memberId), code('HOST_OFFLINE'));
  f.command({ type: 'room.claim-host' }, f.guest.memberId); assert.equal(f.room().hostId, f.guest.memberId);
  assert.throws(() => f.engine.recover(f.host.roomId, f.host.recovery, key()), code('INVALID_RECOVERY'));
});

test('shared track mismatches block the barrier and a common track clears it', t => {
  const f = fixture(); t.after(() => f.store.close()); f.start();
  f.command({ type: 'watch.join' }, f.guest.memberId); f.status(f.guest, f.guestConnection);
  f.command({ type: 'tracks.select', audio: 'audio:1', subtitle: 'sub:missing', subtitleDelay: 0.5 });
  f.status(); f.status(f.guest, f.guestConnection); assert.equal(f.room().playback.paused, true); assert.match(f.room().playback.reason, /subtitle track/);
  const pausedRevision = f.room().revision;
  for (let i = 0; i < 10; ++i) { f.advance(100); f.status(); f.status(f.guest, f.guestConnection); }
  assert.equal(f.room().revision, pausedRevision, 'an unchanged readiness barrier must not churn event revisions');
  f.command({ type: 'tracks.select', audio: 'audio:0', subtitle: 'sub:0', subtitleDelay: 0 }); f.status(); f.status(f.guest, f.guestConnection);
  assert.equal(f.room().playback.paused, false);
});

test('loss detection checkpoints the paused generation rather than an obsolete playing snapshot', t => {
  const f = fixture(); t.after(() => f.store.close()); f.start(); f.advance(4000); f.engine.tick();
  const stored = JSON.parse(String(f.store.db.prepare('SELECT data FROM runtime WHERE room_id=?').get(f.host.roomId)!.data));
  assert.equal(stored.playback.paused, true); assert.equal(stored.playback.generation, f.room().playback.generation);
  assert.equal(stored.playback.position, f.room().playback.position);
});

test('room creation and its private retry mapping are one database transaction', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const engine = new Engine(store);
  store.db.exec("CREATE TRIGGER fail_creation BEFORE INSERT ON creations BEGIN SELECT RAISE(ABORT,'Simulated disk failure'); END;");
  const retryKey = key(); assert.throws(() => engine.create('Room', 'Host', retryKey), /Simulated disk failure/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM rooms').get()!.n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runtime').get()!.n, 0);
  store.db.exec('DROP TRIGGER fail_creation'); const created = engine.create('Room', 'Host', retryKey);
  assert.deepEqual(engine.create('Room', 'Host', retryKey), created);
});

test('90% distinct shared coverage archives without stopping current playback or deselecting its download', t => {
  const f = fixture(); t.after(() => f.store.close()); f.start();
  const currentId = f.room().playback.entryId!;
  for (let i = 0; i < 95; ++i) { f.advance(1000); f.status(); f.engine.ping(f.host.roomId, f.guest.memberId, f.guestConnection); f.engine.tick(); }
  const entry = f.room().entries.find(e => e.id === currentId)!;
  assert.notEqual(entry.watchedAt, null); assert.equal(entry.enabled, true); assert.equal(f.room().playback.entryId, currentId); assert.equal(f.room().playback.paused, false);
  assert.equal(f.store.history(f.host.roomId).length, 1); assert.equal(f.store.history(f.host.roomId)[0]!.method, 'automatic');
  f.command({ type: 'history.mark', ids: [currentId], watched: false }, f.guest.memberId);
  assert.equal(f.room().entries.find(e => e.id === currentId)!.watchedAt, null); assert.equal(f.store.history(f.host.roomId).length, 1);
  f.command({ type: 'history.mark', ids: [currentId], watched: true }, f.guest.memberId); assert.equal(f.store.history(f.host.roomId).length, 2);
});

test('seeking forward is not viewed coverage; removing the current episode advances and invalidates pending work', t => {
  const f = fixture(); t.after(() => f.store.close()); f.start();
  f.advance(1500); f.status(); f.command({ type: 'playback.seek', position: 80 }); f.status();
  for (let i = 0; i < 6; ++i) { f.advance(1000); f.status(); }
  const current = f.room().entries.find(e => e.id === f.room().playback.entryId)!;
  assert.equal(current.watchedAt, null); assert.ok(coverageSeconds(current.coverage) < 10);
  const generation = f.room().playback.generation;
  f.command({ type: 'queue.remove', ids: [current.id] }, f.guest.memberId);
  assert.notEqual(f.room().playback.entryId, current.id); assert.equal(f.room().playback.position, 0); assert.equal(f.room().playback.paused, true); assert.ok(f.room().playback.generation > generation);
});

test('recovery retries survive restart, revoke old host credentials, and durable state resumes paused', t => {
  const directory = mkdtempSync(join(tmpdir(), 'watchpair-coordinator-'));
  const path = join(directory, 'room.sqlite'), f = fixture(path); f.start(); f.advance(5000); f.status(); f.engine.tick();
  let originalOpen = true, reopened: Store | undefined;
  t.after(() => {
    if (originalOpen) f.store.close(); reopened?.close();
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('watchpair-coordinator-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const requestKey = key(), recovered = f.engine.recover(f.host.roomId, f.host.recovery, requestKey);
  assert.throws(() => f.engine.authenticate(f.host.roomId, f.host.token), code('UNAUTHORIZED'));
  assert.throws(() => f.engine.recover(f.host.roomId, f.host.recovery, key()), code('INVALID_RECOVERY'));
  f.store.close(); originalOpen = false; const store = new Store(path); reopened = store; const engine = new Engine(store, f.now);
  assert.deepEqual(engine.recover(f.host.roomId, f.host.recovery, requestKey), recovered);
  assert.equal(engine.authenticate(f.host.roomId, recovered.token).id, f.host.memberId);
  const room = engine.room(f.host.roomId); assert.equal(room.entries.length, 3); assert.equal(room.playback.paused, true); assert.equal(room.playback.requested, false);
  assert.ok(room.members.every(m => !m.live && m.watch === 'idle'));
});

test('SQL failure does not acknowledge or apply a queue mutation; large packs retain original indexes and bounded commit time', t => {
  const f = fixture(); t.after(() => f.store.close());
  const files = Array.from({ length: 10_000 }, (_, i) => ({ mediaId: `asset:${i}`, path: `Seasons/Season${Math.floor(i / 100)}/Episode${i}.mkv`,
    label: `Episode ${i}`, fileIndex: i * 2 + 1, size: 1000, duration: 100, selected: true }));
  const begin = performance.now(); f.command({ type: 'queue.add', source: { id: 'huge', kind: 'torrent', label: 'Large pack', uri: 'magnet:?xt=urn:btih:large', identity: 'btih:large' }, files });
  assert.equal(f.room().entries.length, 10_000); assert.equal(new Set(f.room().entries.map(e => e.fileIndex)).size, 10_000);
  assert.ok(performance.now() - begin < 5000, '10,000 entries should not block for seconds on the reference machine');
  const before = JSON.stringify(f.engine.snapshot(f.host.roomId)), save = f.store.save.bind(f.store);
  f.store.save = () => { throw new Error('Simulated disk full'); };
  assert.throws(() => f.command({ type: 'queue.remove', ids: [f.room().entries[0]!.id] }), /disk full/);
  f.store.save = save; assert.equal(JSON.stringify(f.engine.snapshot(f.host.roomId)), before);
});
