import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Engine } from '../src/engine.js';
import { DomainError } from '../src/protocol.js';
import { estimateAirtime, inferAnchorAirtime, retryAt, type SeriesEpisode, type SeriesFollow } from '../src/series-state.js';
import { Store } from '../src/store.js';

const hour = 3_600_000;
const friday = { broadcastDayJapan: 'friday', broadcastTimeJapan: '23:30' };
const air = Date.parse('2026-11-20T14:30:00Z');

function createRoom(store: Store) {
  const engine = new Engine(store, () => air);
  return engine.create('Friday room', 'Host', randomBytes(32).toString('base64url')).roomId;
}

function follow(roomId: string, overrides: Partial<SeriesFollow> = {}): SeriesFollow {
  return {
    id: 'follow-1', roomId, malId: 1000, revision: 0, title: 'Test series', anchorListingId: 3000,
    anchorTitle: '[Group] Test series - 07 (1080p)', preferredUploader: null,
    anchorPublishedAt: air - 7 * 24 * hour, anchorBroadcastAt: air - 7 * 24 * hour,
    broadcastDayJapan: 'friday', broadcastTimeJapan: '23:30',
    catalogEpisodeOffset: 0, nextEpisode: 8, status: 'active', expectedAirAt: air,
    airtimeManual: false, nextCheckAt: air, nextCatalogAt: null, lastCheckedAt: null,
    manualCheck: false, finalEpisode: null, episodeCount: null, finishConfirmed: false, error: null,
    alternative: null, dismissedAlternativeHashes: [], createdAt: air - hour, updatedAt: air - hour,
    ...overrides,
  };
}

function ledger(roomId: string, episode: number): SeriesEpisode {
  return { roomId, malId: 1000, episode, disposition: 'skipped', entryId: null, listingId: null, createdAt: air };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test('a release near its Japanese broadcast can anchor the next weekly episode, with weekday corrections', () => {
  const published = Date.parse('2026-11-13T16:04:00Z');
  const anchor = inferAnchorAirtime(published, friday);
  assert.equal(anchor, Date.parse('2026-11-13T14:30:00Z'));
  assert.equal(estimateAirtime(anchor, 8, 7, friday), air);
  assert.equal(estimateAirtime(anchor, 8, 7, { ...friday, broadcastDayJapan: 'saturday' }), air + 24 * hour);
  assert.equal(inferAnchorAirtime(Date.parse('2026-11-17T15:00:00Z'), friday), null);
  assert.equal(estimateAirtime(anchor, 8, 7, { ...friday, broadcastTimeJapan: '25:00' }), null);
  assert.equal(estimateAirtime(null, 8, 7, friday), null);
});

test('an overdue episode retries every two hours, then daily; an unscheduled check is one-shot', () => {
  assert.equal(retryAt(air, air - hour), air);
  assert.equal(retryAt(air, air), air + 2 * hour);
  assert.equal(retryAt(air, air + 47 * hour), air + 49 * hour);
  assert.equal(retryAt(air, air + 48 * hour), air + 72 * hour);
  assert.equal(retryAt(null, air), null);
});

test('a v1 coordinator database migrates, retains its room, and resumes due series after reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'watchpair-series-'));
  const path = join(directory, 'coordinator.sqlite');
  t.after(() => {
    for (const suffix of ['', '-shm', '-wal']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  });

  const initial = new Store(path);
  const roomId = createRoom(initial);
  initial.close();
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec('DROP TABLE series_episodes; DROP TABLE series_follows; PRAGMA user_version=1;');
  } finally { legacy.close(); }

  const migrated = new Store(path);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.equal(migrated.load().find(room => room.id === roomId)?.name, 'Friday room');
    const first = follow(roomId, { nextCheckAt: air + hour, nextCatalogAt: air });
    const second = follow(roomId, { id: 'follow-2', malId: 1001, nextCheckAt: null, nextCatalogAt: air - hour });
    const paused = follow(roomId, { id: 'paused', malId: 1002, status: 'paused', nextCheckAt: air - 2 * hour });
    for (const rule of [first, second, paused]) migrated.saveSeries({ follow: rule, expectedRevision: null });
  } finally { migrated.close(); }

  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.dueSeries(air - hour).map(rule => rule.id), ['follow-2']);
    assert.deepEqual(reopened.dueSeries(air).map(rule => rule.id), ['follow-2', 'follow-1']);
    assert.deepEqual(reopened.dueSeries(air, 1).map(rule => rule.id), ['follow-2']);
    reopened.deleteRoom(roomId);
    assert.deepEqual(reopened.dueSeries(air), []);
  } finally { reopened.close(); }
});

test('stale worker cannot save a room change after a pause; duplicate ledger entry rolls back a queue write', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const roomId = createRoom(store);
  const initial = follow(roomId);
  const episode = ledger(roomId, 8);
  store.saveSeries({ follow: initial, expectedRevision: null, episodes: [episode] });

  const paused = { ...initial, status: 'paused' as const, revision: 1 };
  store.saveSeries({ follow: paused, expectedRevision: 0 });
  const original = store.load().find(room => room.id === roomId)!;
  const attemptedRoom = { ...original, name: 'Stale queue write', queueRevision: original.queueRevision + 1 };
  assert.throws(() => store.save(attemptedRoom, air, {
    metadata: true, queue: true, series: { follow: { ...initial, revision: 1 }, expectedRevision: 0 },
  }), hasCode('SERIES_CONFLICT'));

  assert.throws(() => store.save(attemptedRoom, air, {
    metadata: true, queue: true, series: { follow: { ...paused, revision: 2 }, expectedRevision: 1, episodes: [episode] },
  }), hasCode('SERIES_CONFLICT'));
  assert.deepEqual(store.getSeries(roomId, initial.id), paused);
  assert.equal(store.load().find(room => room.id === roomId)?.name, original.name);
  assert.equal(store.load().find(room => room.id === roomId)?.queueRevision, original.queueRevision);
});

test('one live follow per MAL ID, with episode handling retained on stop and re-follow', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const roomId = createRoom(store);
  const initial = follow(roomId);
  const episode = ledger(roomId, 8);
  store.saveSeries({ follow: initial, expectedRevision: null, episodes: [episode] });
  const next = follow(roomId, { id: 'new-rule', anchorListingId: 4000 });
  assert.throws(() => store.saveSeries({ follow: next, expectedRevision: null }), hasCode('SERIES_EXISTS'));
  store.saveSeries({ follow: { ...initial, revision: 1, status: 'stopped' }, expectedRevision: 0 });
  store.saveSeries({ follow: next, expectedRevision: null });
  assert.equal(store.listSeries(roomId).length, 2);
  assert.deepEqual(store.getSeriesEpisode(roomId, initial.malId, 8), episode);
  store.deleteRoom(roomId);
  assert.equal(store.getSeriesEpisode(roomId, initial.malId, 8), null);
  assert.throws(() => store.saveSeries({ follow: next, expectedRevision: null }), hasCode('ROOM_NOT_FOUND'));
});
