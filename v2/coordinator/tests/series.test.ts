import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { Change } from '../src/protocol.js';
import { SeriesProviderError, verifySeriesMetainfo, type SeriesCatalog, type SeriesListing, type SeriesProvider } from '../src/series-provider.js';
import { buildServer } from '../src/server.js';

const start = Date.parse('2026-11-20T13:59:00Z');
const air = Date.parse('2026-11-20T14:00:00Z');
const headers = { 'x-watchpair-protocol': '2' };
const key = () => randomBytes(32).toString('base64url');
const auth = (token: string) => ({ ...headers, authorization: `Bearer ${token}` });
const seedTitle = '[Origin] Test Anime - 07 (1080p)';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function release(id: number, title: string, publishedAt: number, uploader?: string, name = `${title}.mkv`) {
  const info = Buffer.concat([Buffer.from(`d6:lengthi123e4:name${Buffer.byteLength(name)}:${name}12:piece lengthi16384e6:pieces20:`),
    Buffer.alloc(20, id % 255), Buffer.from('e')]);
  const bytes = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
  const listing: SeriesListing = { id, title, infoHash: createHash('sha1').update(info).digest('hex'), publishedAt, uploader };
  return { listing, bytes };
}

function rss(listing: SeriesListing) {
  return Buffer.from(`<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><item><title>${listing.title}</title>` +
    `<guid>https://nyaa.si/view/${listing.id}</guid><pubDate>${new Date(listing.publishedAt).toUTCString()}</pubDate>` +
    `<nyaa:infoHash>${listing.infoHash}</nyaa:infoHash></item></channel></rss>`);
}

class FixtureProvider implements SeriesProvider {
  entry: SeriesCatalog = { id: 101, title: 'Test Anime', status: 'currently_airing', episodeCount: 12,
    startDate: '2026-10-02', broadcastDayJapan: 'friday', broadcastTimeJapan: '23:00' };
  searches: { query: string; uploader?: string }[] = [];
  catalogCalls = 0;
  metadataCalls: number[] = [];
  records = new Map<number, ReturnType<typeof release>>();
  beforeListing?: () => void;
  beforeSearch?: () => void;
  beforeMetadata?: (listing: SeriesListing) => Promise<void>;

  constructor() {
    this.put(100, seedTitle, Date.parse('2026-11-13T15:00:00Z'), 'Original');
  }

  put(id: number, title: string, publishedAt = air, uploader?: string, filename?: string) {
    const record = release(id, title, publishedAt, uploader, filename);
    this.records.set(id, record);
    return record;
  }

  async searchCatalog(_query: string) { return [this.entry]; }
  async catalog(_id: number) { ++this.catalogCalls; return this.entry; }
  async listing(id: number) { this.beforeListing?.(); return this.records.get(id)!.listing; }
  async searchReleases(query: string, uploader?: string) {
    this.beforeSearch?.();
    this.searches.push({ query, uploader });
    return [...this.records.values()].map(record => record.listing).filter(listing => !uploader || listing.uploader === uploader);
  }
  async metadata(listing: SeriesListing, catalogTitles?: readonly string[]) {
    this.metadataCalls.push(listing.id);
    await this.beforeMetadata?.(listing);
    return verifySeriesMetainfo(this.records.get(listing.id)!.bytes, listing, catalogTitles);
  }
}

async function fixture(t: TestContext, trustProxy = false) {
  let now = start;
  const provider = new FixtureProvider();
  const built = await buildServer({ now: () => now, seriesProvider: provider, seriesTimer: false, trustProxy });
  const { app, engine, series } = built;
  t.after(() => app.close());
  const room = engine.create('Series room', 'Host', key());
  const guest = engine.join(room.roomId, room.invite, 'Guest', key());
  const path = `/v2/rooms/${room.roomId}`;
  const changes: Change[] = [];
  engine.on('change', change => changes.push(change));
  async function preview(token = room.token, listingId = 100, deferMetadata = false) {
    const response = await app.inject({ method: 'POST', url: `${path}/series/preview`, headers: auth(token),
      payload: { input: `https://nyaa.si/view/${listingId}`, malId: provider.entry.id,
        ...(deferMetadata ? { deferMetadata: true } : {}) } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().draft;
  }
  async function add(overrides = {}, listingId = 100) {
    const draft = await preview(room.token, listingId);
    const response = await app.inject({ method: 'POST', url: `${path}/series`, headers: auth(room.token),
      payload: { draftId: draft.id, ...overrides } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().item;
  }
  const rules = () => series!.list(room.roomId).items;
  const action = (id: string, payload: object, token = room.token) => app.inject({ method: 'POST',
    url: `${path}/series/${id}/actions`, headers: auth(token), payload });
  return { ...built, provider, get now() { return now; }, set now(value: number) { now = value; },
    room, guest, path, changes, preview, add, rules, action };
}

async function attachDesktop(f: Awaited<ReturnType<typeof fixture>>, token: string, address: string) {
  const server = f.app.server.address();
  assert.ok(server && typeof server !== 'string');
  const jobs: { type: string; requestId: string; kind?: string; listingId?: number; query?: string; uploader?: string }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${f.path}/events`, {
    headers: { ...auth(token), 'x-watchpair-series-metadata': '1', 'x-watchpair-series-lookup': '1', 'x-forwarded-for': address },
  });
  ws.on('message', data => { const event = JSON.parse(data.toString()); if (event.requestId) jobs.push(event); });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, jobs,
    async take() {
      for (let i = 0; i < 100 && !jobs.length; ++i) await delay(10);
      assert.ok(jobs.length, 'desktop received a fallback request');
      return jobs.shift()!;
    },
    fail(requestId: string, retryAfterMs?: number) { ws.send(JSON.stringify({ type: 'series.failed', requestId, retryAfterMs })); },
    submit: (kind: 'lookup' | 'metadata', requestId: string, bytes: Buffer) => f.app.inject({ method: 'POST',
      url: `${f.path}/series/${kind}/${requestId}`, payload: bytes,
      headers: { ...auth(token), 'content-type': kind === 'lookup' ? 'application/vnd.watchpair.nyaa' : 'application/vnd.watchpair.torrent' } }),
  };
}

test('a Nyaa link and its torrent fall back in order, skipping desktops behind the same public IP', async t => {
  const f = await fixture(t, true);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const join = (name: string) => f.engine.join(f.room.roomId, f.room.invite, name, key()).token;
  const first = await attachDesktop(f, f.room.token, '203.0.113.10');
  const duplicate = await attachDesktop(f, f.guest.token, '::ffff:cb00:710a');
  const second = await attachDesktop(f, join('Disconnects'), '203.0.113.11');
  const last = await attachDesktop(f, join('Works'), '203.0.113.12');
  try {
    f.provider.beforeListing = () => { throw new SeriesProviderError('Gateway timeout', 504); };
    const preview = () => f.app.inject({ method: 'POST', url: `${f.path}/series/preview`,
      headers: { ...auth(f.room.token), 'x-watchpair-series-lookup': '1' },
      payload: { input: 'https://nyaa.si/view/100', malId: 101, deferMetadata: true } });
    assert.deepEqual((await preview()).json(), { lookupPending: true });
    const firstJob = await first.take();
    assert.equal(firstJob.kind, 'listing');
    assert.equal(firstJob.listingId, 100);
    first.fail(firstJob.requestId);
    await second.take();
    second.ws.terminate();
    const lastJob = await last.take();
    assert.equal(duplicate.jobs.length, 0);
    const seed = f.provider.records.get(100)!;
    const html = Buffer.from(`<h3 class="panel-title">${seedTitle}</h3><a href="/?c=1_2">Anime</a>` +
      `<div>Info hash:</div><div><kbd>${seed.listing.infoHash}</kbd></div>` +
      `<div data-timestamp="${seed.listing.publishedAt / 1000}"></div><div class="panel-footer clearfix">`);
    assert.equal((await first.submit('lookup', firstJob.requestId, html)).statusCode, 404);
    assert.equal((await duplicate.submit('lookup', lastJob.requestId, html)).statusCode, 404);
    assert.equal((await last.submit('lookup', lastJob.requestId, html)).statusCode, 200);
    const draft = (await preview()).json().draft;
    assert.equal(draft.anchorListingId, 100);
    f.provider.beforeMetadata = async () => { throw new SeriesProviderError('Gateway timeout', 504); };
    const confirmed = await f.app.inject({ method: 'POST', url: `${f.path}/series`, headers: auth(f.room.token),
      payload: { draftId: draft.id } });
    assert.equal(confirmed.json().item.pending, 'setup');
    await f.series!.runOnce();
    const firstTorrent = await first.take();
    assert.equal(firstTorrent.type, 'series.metadata');
    assert.equal((await first.submit('metadata', firstTorrent.requestId, Buffer.from('wrong torrent'))).statusCode, 422);
    assert.equal((await first.submit('metadata', firstTorrent.requestId, seed.bytes)).statusCode, 404);
    const lastTorrent = await last.take();
    assert.equal(duplicate.jobs.length, 0);
    assert.equal((await last.submit('metadata', lastTorrent.requestId, seed.bytes)).statusCode, 200);
    await f.series!.runOnce();
    assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 1);
    assert.equal(f.rules()[0]!.pending, null);
  } finally {
    for (const desktop of [first, duplicate, second, last]) desktop.ws.terminate();
  }
});

test('desktop RSS lookup keeps a per-IP cooldown and retries on the next round', async t => {
  const f = await fixture(t, true);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const desktop = await attachDesktop(f, f.room.token, '203.0.113.10');
  try {
    const preview = () => f.app.inject({ method: 'POST', url: `${f.path}/series/preview`,
      headers: { ...auth(f.room.token), 'x-watchpair-series-lookup': '1' }, payload: { input: 'Test Anime' } });
    f.provider.beforeSearch = () => { throw new SeriesProviderError('Please retry later', 429, 60_000); };
    assert.equal((await preview()).statusCode, 429);
    f.provider.beforeSearch = () => { throw new SeriesProviderError('Gateway timeout', 504); };
    assert.deepEqual((await preview()).json(), { lookupPending: true });
    const first = await desktop.take();
    assert.equal(first.kind, 'search');
    assert.equal(first.query, 'Test Anime');
    desktop.fail(first.requestId, 90_000);
    for (let i = 0; i < 100; ++i) {
      if (!(await preview()).json().lookupPending) break;
      await delay(10);
    }
    f.now += 89_999;
    assert.equal((await preview()).statusCode, 503);
    assert.equal(desktop.jobs.length, 0);
    ++f.now;
    assert.deepEqual((await preview()).json(), { lookupPending: true });
    const retry = await desktop.take();
    assert.notEqual(retry.requestId, first.requestId);
    assert.equal((await desktop.submit('lookup', retry.requestId, rss(f.provider.records.get(100)!.listing))).statusCode, 200);
    assert.equal((await preview()).json().releases[0].id, 100);
  } finally { desktop.ws.terminate(); }
});

test('scheduled follows resume from desktop RSS and add the verified next episode', async t => {
  const f = await fixture(t, true);
  const rule = await f.add();
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const desktop = await attachDesktop(f, f.room.token, '203.0.113.10');
  try {
    f.now = rule.nextCheckAt;
    const episode = f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', f.now, 'Original');
    f.provider.beforeSearch = () => { throw new SeriesProviderError('Gateway timeout', 504); };
    await f.series!.runOnce();
    assert.equal(f.rules()[0]!.nextEpisode, 8);
    assert.match(f.rules()[0]!.error!, /connected desktops/);
    const request = await desktop.take();
    assert.equal(request.uploader, 'Original');
    assert.equal((await desktop.submit('lookup', request.requestId, rss(episode.listing))).statusCode, 200);
    f.now = f.rules()[0]!.nextCheckAt!;
    await f.series!.runOnce();
    assert.equal(f.rules()[0]!.nextEpisode, 9);
    assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 8)!.listingId, episode.listing.id);
  } finally { desktop.ws.terminate(); }
});

test('one click saves a pending follow even when metadata is down, and the VPS retries without a desktop', async t => {
  const f = await fixture(t);
  f.provider.beforeMetadata = async () => { throw new SeriesProviderError('Gateway timeout', 504); };
  const draft = await f.preview(f.room.token, 100, true);
  assert.deepEqual(f.provider.metadataCalls, []);
  const submit = () => f.app.inject({ method: 'POST', url: `${f.path}/series`, headers: auth(f.room.token),
    payload: { draftId: draft.id } });
  const saved = (await submit()).json().item;
  assert.equal(saved.pending, 'setup');
  assert.equal((await submit()).json().item.id, saved.id);
  await f.series!.runOnce();
  assert.equal(f.rules()[0]?.pending, 'setup');
  assert.match(f.rules()[0]!.error!, /retry automatically/);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 0);
  assert.equal(f.engine.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 7), null);
  f.provider.beforeMetadata = undefined;
  f.now = f.rules()[0]!.nextCheckAt! - 1;
  await f.series!.runOnce();
  assert.deepEqual(f.provider.metadataCalls, [100]);
  ++f.now;
  await f.series!.runOnce();
  assert.equal(f.rules()[0]?.pending, null);
  assert.equal(f.rules()[0]?.nextEpisode, 8);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 1);
});

test('an online desktop helps a persisted follow and only hash-verified metadata survives a restart', { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'watchpair-series-'));
  const database = join(dir, 'room.sqlite');
  const provider = new FixtureProvider();
  provider.beforeMetadata = async () => { throw new SeriesProviderError('Gateway timeout', 504); };
  let current = start;
  const open = () => buildServer({ database, now: () => current, seriesProvider: provider, seriesTimer: false });
  let built = await open();
  let ws: WebSocket | undefined;
  t.after(async () => { ws?.terminate(); await built.app.close(); rmSync(dir, { recursive: true, force: true }); });
  const room = built.engine.create('Restart test', 'Host', key());
  const desktop = built.engine.join(room.roomId, room.invite, 'Online desktop', key());
  const path = `/v2/rooms/${room.roomId}`;
  const preview = await built.app.inject({ method: 'POST', url: `${path}/series/preview`, headers: auth(room.token),
    payload: { input: 'https://nyaa.si/view/100', malId: provider.entry.id, deferMetadata: true } });
  assert.equal(preview.statusCode, 200, preview.body);
  const confirm = { method: 'POST' as const, url: `${path}/series`, headers: auth(room.token),
    payload: { draftId: preview.json().draft.id } };
  const pending = (await built.app.inject(confirm)).json().item;
  await built.series!.runOnce();
  assert.equal(built.series!.list(room.roomId).items[0]?.nextCheckAt, current + 60_000);
  await built.app.close();
  built = await open();
  assert.equal((await built.app.inject(confirm)).json().item.id, pending.id);
  assert.equal(built.series!.list(room.roomId).items[0]?.pending, 'setup');
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const address = built.app.server.address();
  assert.ok(address && typeof address !== 'string');
  ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}/events`,
    { headers: { ...auth(desktop.token), 'x-watchpair-series-metadata': '1' } });
  let job: { requestId: string; listingId: number } | undefined;
  ws.on('message', bytes => {
    const event = JSON.parse(bytes.toString());
    if (event.type === 'series.metadata') job = event;
  });
  await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
  for (let i = 0; i < 100 && !job; ++i) await delay(10);
  assert.equal(job?.listingId, 100);
  const submit = (token: string, bytes: Buffer) => built.app.inject({ method: 'POST',
    url: `${path}/series/metadata/${job!.requestId}`, payload: bytes,
    headers: { ...auth(token), 'content-type': 'application/vnd.watchpair.torrent' } });
  const seed = provider.records.get(100)!;
  assert.equal((await submit(room.token, seed.bytes)).statusCode, 404);
  assert.equal((await submit(desktop.token, Buffer.alloc(2 * 1024 * 1024 + 1))).statusCode, 413);
  assert.equal(built.engine.snapshot(room.roomId).entries.length, 0);
  assert.equal(built.store.getSeriesMetadata(seed.listing.infoHash, current), null);
  assert.equal((await submit(desktop.token, seed.bytes)).statusCode, 200);
  assert.equal((await submit(desktop.token, seed.bytes)).statusCode, 404);
  ws.terminate(); ws = undefined;
  await built.app.close();
  built = await open();
  await built.series!.runOnce();
  assert.deepEqual(provider.metadataCalls, [100]);
  assert.equal(built.series!.list(room.roomId).items[0]?.pending, null);
  assert.equal(built.engine.snapshot(room.roomId).entries[0]?.path, `${seedTitle}.mkv`);
});

test('later episodes hold their exact release through metadata failure and retry without another search', async t => {
  const f = await fixture(t);
  await f.add();
  f.provider.put(108, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  f.provider.beforeMetadata = async () => { throw new SeriesProviderError('Gateway timeout', 504); };
  f.now = air;
  await f.series!.runOnce();
  assert.equal(f.rules()[0]?.pending, 'episode');
  assert.equal(f.rules()[0]?.nextEpisode, 8);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 1);
  const searches = f.provider.searches.length;
  f.now = f.rules()[0]!.nextCheckAt!;
  f.provider.beforeMetadata = undefined;
  await f.series!.runOnce();
  assert.equal(f.provider.searches.length, searches);
  assert.equal(f.rules()[0]?.pending, null);
  assert.equal(f.rules()[0]?.nextEpisode, 9);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 2);
});

test('a definitive metadata error holds the pending rule for review and cancellation prevents retries', async t => {
  const f = await fixture(t);
  const draft = await f.preview(f.room.token, 100, true);
  const result = await f.app.inject({ method: 'POST', url: `${f.path}/series`, headers: auth(f.room.token),
    payload: { draftId: draft.id } });
  assert.equal(result.statusCode, 200, result.body);
  f.provider.beforeMetadata = async () => { throw new SeriesProviderError('This release has several files.', 422); };
  await f.series!.runOnce();
  const rule = f.rules()[0]!;
  assert.equal(rule.status, 'paused');
  assert.equal(rule.error, 'This release has several files.');
  assert.equal(rule.nextCheckAt, null);
  const stopped = await f.action(rule.id, { revision: rule.revision, action: 'stop' }, f.guest.token);
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json().item.pending, null);
  f.now += 60 * 60_000;
  await f.series!.runOnce();
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 0);
  assert.deepEqual(f.provider.metadataCalls, [100]);
});

test('legacy coordinator advertises disabled capability and still requires room membership', async t => {
  const { app, engine } = await buildServer({ seriesTimer: false });
  t.after(() => app.close());
  const room = engine.create('Legacy room', 'Host', key());
  const path = `/v2/rooms/${room.roomId}/series`;
  const version = await app.inject({ url: '/v2/version', headers });
  assert.equal(version.json().seriesFollows, false);
  assert.equal((await app.inject({ url: path, headers })).statusCode, 401);
  assert.deepEqual((await app.inject({ url: path, headers: auth(room.token) })).json(), { enabled: false, items: [] });
  const disabled = await app.inject({ method: 'POST', url: `${path}/preview`, headers: auth(room.token), payload: { input: 'Test Anime' } });
  assert.equal(disabled.statusCode, 404);
  assert.equal(disabled.json().error.code, 'SERIES_DISABLED');
});

test('looks up the main title from a Nyaa link and follows catalog-verified abbreviated filenames', async t => {
  const f = await fixture(t);
  const { app, room, path, provider } = f;
  const primary = 'tensei shitara ken deshita';
  const supplied = 'Tensei shitara Ken deshita (Reincarnated as a Sword)';
  const title = `[Judas] ${supplied} - S02E08 [1080p]`;
  provider.entry = { ...provider.entry, title: 'Tensei shitara Ken deshita II',
    alternativeTitles: ['Reincarnated as a Sword Season 2', 'I became the sword by transmigrating 2nd Season, TenKen 2'] };
  provider.put(2187750, title, start, 'Judas', '[Judas] TenKen - S02E08.mkv');
  const queries: string[] = [];
  provider.searchCatalog = async query => {
    queries.push(query);
    return query.toLowerCase() === primary ? [provider.entry] : [];
  };
  const preview = (input: string) => app.inject({ method: 'POST', url: `${path}/series/preview`, headers: auth(room.token),
    payload: { input } });
  const link = await preview('https://nyaa.si/view/2187750');
  assert.equal(link.statusCode, 200, link.body);
  assert.deepEqual(queries, [primary]);
  assert.equal(link.json().catalog[0]?.id, provider.entry.id);
  assert.equal(link.json().releases[0]?.title, title);

  queries.length = 0;
  const typed = await preview(supplied);
  assert.equal(typed.statusCode, 200, typed.body);
  assert.deepEqual(queries.map(query => query.toLowerCase()), [supplied.toLowerCase(), primary]);
  assert.equal(queries[0], supplied);
  assert.equal(typed.json().catalog[0]?.id, provider.entry.id);

  const item = await f.add({ expectedAirAt: air }, 2187750);
  assert.equal(item.nextEpisode, 9);
  provider.put(2187751, title.replace('E08', 'E09'), air, 'Judas', '[Judas] TenKen - S02E09.mkv');
  f.now = air;
  await f.series!.runOnce();
  assert.equal(f.rules()[0]!.nextEpisode, 10);
  assert.deepEqual(f.engine.snapshot(room.roomId).entries.map(entry => entry.path),
    ['[Judas] TenKen - S02E08.mkv', '[Judas] TenKen - S02E09.mkv']);
});

test('preview verifies the seed; confirm is scoped and idempotent, and timed catch-up sends ordinary queue snapshots', async t => {
  const f = await fixture(t);
  const { app, room, path, engine, provider } = f;
  assert.equal((await app.inject({ url: '/v2/version', headers })).json().seriesFollows, true);
  const search = await app.inject({ method: 'POST', url: `${path}/series/preview`, headers: auth(room.token), payload: { input: 'Test Anime' } });
  assert.equal(search.statusCode, 200, search.body);
  assert.equal(search.json().catalog[0].id, provider.entry.id);
  assert.equal(search.json().releases[0].title, seedTitle);
  assert.equal(search.json().draft, undefined);
  const draft = await f.preview();
  assert.equal(draft.expectedAirAt, air);
  assert.deepEqual(engine.snapshot(room.roomId).entries, []);
  assert.deepEqual(provider.metadataCalls, [100]);

  const submit = (token: string) => app.inject({ method: 'POST', url: `${path}/series`, headers: auth(token), payload: { draftId: draft.id } });
  assert.equal((await submit(f.guest.token)).json().error.code, 'SERIES_DRAFT_EXPIRED');
  const confirmed = await submit(room.token);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const item = confirmed.json().item;
  assert.equal(item.nextEpisode, 8);
  assert.deepEqual((await submit(room.token)).json().item, item);
  const seed = engine.snapshot(room.roomId).entries[0]!;
  engine.command(room.roomId, room.memberId, { operationId: randomUUID(), generation: 0,
    command: { type: 'playback.choose', entryId: seed.id } });
  const pending = engine.snapshot(room.roomId);
  const searches = provider.searches.length, catalogCalls = provider.catalogCalls;
  await f.series!.runOnce();
  assert.equal(provider.searches.length, searches);
  assert.equal(provider.catalogCalls, catalogCalls);
  assert.deepEqual(provider.metadataCalls, [100]);

  // The release batch contains two consecutive episodes and a later one behind
  // a gap. Only the consecutive matches may enter the room in this pass.
  provider.put(102, '[Origin] Test Anime - 09 (1080p)', air, 'Original');
  provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  provider.put(104, '[Origin] Test Anime - 11 (1080p)', air, 'Original');
  f.now = air;
  await f.series!.runOnce();
  const current = engine.snapshot(room.roomId);
  assert.equal(f.rules()[0]!.nextEpisode, 10);
  assert.deepEqual(provider.metadataCalls, [100, 101, 102]);
  assert.equal(provider.searches.length - searches, 1);
  assert.equal(current.queueRevision, pending.queueRevision + 2);
  assert.equal(current.playback.entryId, seed.id);
  assert.equal(current.playback.generation, pending.playback.generation);
  assert.deepEqual(current.entries.map(entry => entry.path), [seedTitle, '[Origin] Test Anime - 08 (1080p)',
    '[Origin] Test Anime - 09 (1080p)'].map(title => `${title}.mkv`));
  assert.equal(current.sources.every(source => source.kind === 'torrent'), true);
  assert.equal(current.entries.every(entry => entry.enabled), true);
  assert.deepEqual(f.changes.filter(change => change.type === 'snapshot').slice(-2).map(change => change.revision), [current.revision - 1, current.revision]);
});

test('only the host can approve an alternate, which leaves the original source rule pinned', async t => {
  const f = await fixture(t);
  const item = await f.add();
  f.provider.put(201, '[Other] Test Anime - 08 (1080p)', air, 'Alternative');
  f.now = air;
  await f.series!.runOnce();
  const offered = f.rules()[0]!;
  assert.equal(offered.alternative?.title, '[Other] Test Anime - 08 (1080p)');
  assert.equal(offered.nextEpisode, 8);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 1);
  const payload = { action: 'approve-alternate', revision: offered.revision, alternativeId: offered.alternative!.id };
  const denied = await f.action(item.id, payload, f.guest.token);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'HOST_REQUIRED');
  const approved = await f.action(item.id, payload);
  assert.equal(approved.statusCode, 200, approved.body);
  const updated = approved.json().item;
  assert.equal(updated.anchorTitle, seedTitle);
  assert.equal(updated.nextEpisode, 9);
  assert.equal(updated.alternative, null);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 2);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 8)?.listingId, 201);
});

test('failed verification of the preferred listing still allows a verified one-time alternative', async t => {
  const f = await fixture(t);
  await f.add();
  f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  f.provider.put(201, '[Other] Test Anime - 08 (1080p)', air, 'Alternative');
  f.provider.beforeMetadata = async listing => {
    if (listing.id === 101) throw new SeriesProviderError('This torrent has unsupported files.', 422);
  };
  f.now = air;
  await f.series!.runOnce();
  const offered = f.rules()[0]!;
  assert.equal(offered.alternative?.title, '[Other] Test Anime - 08 (1080p)');
  assert.equal(offered.error, 'This torrent has unsupported files.');
  assert.equal(offered.nextEpisode, 8);
  assert.deepEqual(f.provider.metadataCalls, [100, 101, 201]);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 1);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 8), null);
});

test('two successive host dismissals prevent either alternate from resurfacing for the same episode', async t => {
  const f = await fixture(t);
  const item = await f.add();
  f.provider.put(201, '[Other] Test Anime - 08 (1080p)', air, 'Alternative');
  f.provider.put(202, '[Another] Test Anime - 08 (1080p)', air, 'Another uploader');
  f.now = air;
  const dismissed = new Set<string>();
  for (let count = 0; count < 2; ++count) {
    await f.series!.runOnce();
    const offered = f.rules()[0]!;
    assert.ok(offered.alternative);
    assert.equal(dismissed.has(offered.alternative.title), false);
    dismissed.add(offered.alternative.title);
    const response = await f.action(item.id, { action: 'dismiss-alternate', revision: offered.revision,
      alternativeId: offered.alternative.id });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().item.alternative, null);
    assert.ok(offered.nextCheckAt);
    f.now = offered.nextCheckAt;
  }
  await f.series!.runOnce();
  assert.equal(f.rules()[0]!.alternative, null);
  assert.equal(f.rules()[0]!.nextEpisode, 8);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 1);
});

test('a member can pause while metadata is in flight; the stale result cannot mutate the queue', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const item = await f.add();
  f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  const entered = barrier();
  const unblock = barrier();
  f.provider.beforeMetadata = async () => { entered.resolve(); await unblock.promise; };
  f.now = air;
  const pending = f.series!.runOnce();
  try {
    await entered.promise;
    const paused = await f.action(item.id, { action: 'pause', revision: item.revision }, f.guest.token);
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().item.status, 'paused');
  } finally { unblock.resolve(); await pending; }
  assert.equal(f.rules()[0]!.status, 'paused');
  assert.equal(f.rules()[0]!.nextEpisode, 8);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 1);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 8), null);
  const stale = await f.action(item.id, { action: 'resume', revision: item.revision });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'SERIES_CONFLICT');
});

test('an existing disabled entry is recorded without reenabling it, and a skipped finale stays deduplicated after re-follow', async t => {
  const f = await fixture(t);
  const item = await f.add({ finalEpisode: 9 });
  const record = f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  const manifest = verifySeriesMetainfo(record.bytes, record.listing);
  const { engine, room, store } = f;
  const queue = () => engine.snapshot(room.roomId);
  const command = (payload: object) => engine.command(room.roomId, room.memberId,
    { operationId: randomUUID(), queueRevision: queue().queueRevision, command: payload });
  command({ type: 'queue.add', source: manifest.source, files: [{ ...manifest.file, selected: false }] });
  const disabled = queue().entries[1]!;
  assert.equal(disabled.enabled, false);
  const revision = queue().queueRevision;
  f.now = air;
  await f.series!.runOnce();
  assert.equal(queue().entries[1]!.enabled, false);
  assert.equal(queue().queueRevision, revision);
  assert.equal(store.getSeriesEpisode(room.roomId, f.provider.entry.id, 8)?.disposition, 'existing');
  assert.equal(store.getSeriesEpisode(room.roomId, f.provider.entry.id, 8)?.entryId, disabled.id);

  const skipped = await f.action(item.id, { action: 'skip', revision: f.rules()[0]!.revision }, f.guest.token);
  assert.equal(skipped.statusCode, 200, skipped.body);
  assert.equal(skipped.json().item.status, 'finished');
  assert.equal(store.getSeriesEpisode(room.roomId, f.provider.entry.id, 9)?.disposition, 'skipped');
  f.provider.put(102, '[Origin] Test Anime - 09 (1080p)', air, 'Original');
  const replay = await f.add({ finalEpisode: 9 });
  assert.notEqual(replay.id, item.id);
  await f.series!.runOnce();
  assert.equal(f.rules().find(rule => rule.id === replay.id)!.status, 'finished');
  assert.deepEqual(queue().entries.map(entry => entry.id), [queue().entries[0]!.id, disabled.id]);
  assert.equal(f.provider.metadataCalls.includes(102), false);
});

test('a member can follow a watched Nyaa episode using its original listing and start with the next release', async t => {
  const f = await fixture(t);
  const original = f.provider.records.get(100)!;
  const manifest = verifySeriesMetainfo(original.bytes, original.listing);
  const queue = () => f.engine.snapshot(f.room.roomId);
  const command = (payload: object) => f.engine.command(f.room.roomId, f.room.memberId,
    { operationId: randomUUID(), queueRevision: queue().queueRevision, command: payload });
  command({ type: 'queue.add', source: manifest.source, files: [manifest.file] });
  const entryId = queue().entries[0]!.id;
  command({ type: 'history.mark', ids: [entryId], watched: true });
  const before = queue();

  const version = await f.app.inject({ url: '/v2/version', headers });
  assert.equal(version.json().seriesFollowFromEntry, true);
  const preview = (malId?: number) => f.app.inject({ method: 'POST', url: `${f.path}/series/preview`,
    headers: auth(f.guest.token), payload: { input: '', entryId, malId } });
  const found = await preview();
  assert.equal(found.statusCode, 200, found.body);
  assert.equal(found.json().releases[0].id, 100);
  assert.equal(f.provider.searches.length, 0);
  const verified = await preview(f.provider.entry.id);
  assert.equal(verified.statusCode, 200, verified.body);
  const confirmed = await f.app.inject({ method: 'POST', url: `${f.path}/series`, headers: auth(f.guest.token),
    payload: { draftId: verified.json().draft.id } });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().item.nextEpisode, 8);
  assert.deepEqual(queue(), before);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 7)?.disposition, 'existing');
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 7)?.entryId, entryId);

  f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  f.now = air;
  await f.series!.runOnce();
  assert.equal(f.rules()[0]!.nextEpisode, 9);
  assert.equal(queue().entries.length, 2);
  assert.deepEqual(queue().entries[0], before.entries[0]);
});

test('a room episode with a separate source can use a matching Nyaa reference and a stale anchor is rejected', async t => {
  const f = await fixture(t);
  f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  const source = { id: 'room-copy', kind: 'direct', uri: 'https://example.test/test.mp4',
    identity: 'room-copy', label: 'Imported episode' };
  const file = { mediaId: 'room-copy:old', path: 'Season 1/Test Anime - 07 (1080p).mkv',
    label: 'A different display name', fileIndex: 0, size: 1000, selected: true };
  const queue = () => f.engine.snapshot(f.room.roomId);
  const command = (payload: object) => f.engine.command(f.room.roomId, f.room.memberId,
    { operationId: randomUUID(), queueRevision: queue().queueRevision, command: payload });
  command({ type: 'queue.add', source, files: [file] });
  const entryId = queue().entries[0]!.id;
  const preview = (input = '', listingId?: number) => f.app.inject({ method: 'POST', url: `${f.path}/series/preview`,
    headers: auth(f.room.token), payload: { input, entryId, listingId, malId: f.provider.entry.id } });
  const confirm = (draftId: string) => f.app.inject({ method: 'POST', url: `${f.path}/series`, headers: auth(f.room.token),
    payload: { draftId } });
  const candidates = await preview();
  assert.equal(candidates.statusCode, 200, candidates.body);
  assert.deepEqual(candidates.json().releases.map((item: SeriesListing) => item.id), [100]);
  const mismatch = await preview('https://nyaa.si/view/101');
  assert.equal(mismatch.statusCode, 422, mismatch.body);
  assert.equal(mismatch.json().error.code, 'SERIES_ANCHOR_MISMATCH');

  const reviewed = await preview('', 100);
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  const draft = reviewed.json().draft;
  command({ type: 'source.remove', sourceId: source.id });
  assert.equal((await confirm(draft.id)).statusCode, 404);
  command({ type: 'queue.add', source, files: [{ ...file, mediaId: 'room-copy:replacement' }] });
  const stale = await confirm(draft.id);
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, 'SERIES_ANCHOR_CHANGED');
  assert.equal(f.rules().length, 0);

  const refreshed = await preview('', 100);
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const before = queue();
  const followed = await confirm(refreshed.json().draft.id);
  assert.equal(followed.statusCode, 200, followed.body);
  assert.equal(followed.json().item.nextEpisode, 8);
  assert.deepEqual(queue(), before);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 7)?.entryId, entryId);
});

test('a manifest conflict backs off the oldest due rule so another series can run', async t => {
  const f = await fixture(t);
  const firstMalId = f.provider.entry.id;
  const first = await f.add();
  const episode = f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  const manifest = verifySeriesMetainfo(episode.bytes, episode.listing);
  const { engine, room, store } = f;
  const queue = () => engine.snapshot(room.roomId);
  engine.command(room.roomId, room.memberId, { operationId: randomUUID(), queueRevision: queue().queueRevision,
    command: { type: 'queue.add', source: manifest.source, files: [{ ...manifest.file, path: 'Different filename.mkv' }] } });

  f.provider.entry = { ...f.provider.entry, id: 102, title: 'Parallel Series' };
  f.provider.put(200, '[Second] Parallel Series - 01 (1080p)', start, 'Second uploader');
  f.provider.put(201, '[Second] Parallel Series - 02 (1080p)', air, 'Second uploader');
  const second = await f.add({ expectedAirAt: air + 1000 }, 200);
  const revision = queue().queueRevision;
  f.now = air + 1000;
  await f.series!.runOnce();

  const blocked = f.rules().find(item => item.id === first.id)!;
  assert.equal(blocked.nextEpisode, 8);
  assert.match(blocked.error ?? '', /source manifest changed/i);
  assert.ok(blocked.nextCheckAt && blocked.nextCheckAt > f.now);
  assert.equal(store.getSeriesEpisode(room.roomId, firstMalId, 8), null);
  assert.equal(queue().queueRevision, revision);
  assert.equal(queue().entries[1]!.path, 'Different filename.mkv');
  assert.equal(store.dueSeries(f.now, 1)[0]?.id, second.id);

  await f.series!.runOnce();
  assert.equal(f.rules().find(item => item.id === second.id)!.nextEpisode, 3);
  assert.equal(store.getSeriesEpisode(room.roomId, f.provider.entry.id, 2)?.listingId, 201);
  assert.equal(queue().queueRevision, revision + 1);
  assert.equal(f.provider.metadataCalls.filter(id => id === 101).length, 1);
});

test('a later MAL broadcast slot schedules an initially unscheduled follow using its saved Nyaa anchor', async t => {
  const f = await fixture(t);
  const catalogWithSlot = f.provider.entry;
  f.provider.entry = { ...catalogWithSlot, broadcastDayJapan: null, broadcastTimeJapan: null };
  f.now = air - 24 * 60 * 60 * 1000;
  const item = await f.add();
  assert.equal(item.expectedAirAt, null);
  assert.equal(item.nextCheckAt, null);

  const pending = f.store.getSeries(f.room.roomId, item.id)!;
  assert.ok(pending.nextCatalogAt !== null && pending.nextCatalogAt < air);
  const searches = f.provider.searches.length;
  const catalogCalls = f.provider.catalogCalls;
  f.provider.entry = catalogWithSlot;
  f.now = pending.nextCatalogAt;
  await f.series!.runOnce();
  const scheduled = f.rules()[0]!;
  assert.equal(scheduled.expectedAirAt, air);
  assert.equal(scheduled.nextCheckAt, air);
  assert.equal(f.provider.catalogCalls, catalogCalls + 1);
  assert.equal(f.provider.searches.length, searches);

  f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  f.now = air;
  await f.series!.runOnce();
  assert.equal(f.rules()[0]!.nextEpisode, 9);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, catalogWithSlot.id, 8)?.listingId, 101);
});

test('an early opening episode can put the verified release schedule one week ahead of the MAL premiere', async t => {
  const title = 'Yasei no Last Boss ga Arawareta!';
  const catalog: SeriesCatalog = { id: 63140, title: `${title} 2nd Season`, status: 'currently_airing',
    episodeCount: null, startDate: '2026-10-03', broadcastDayJapan: 'saturday', broadcastTimeJapan: '22:30' };
  const listingId = 2186101;
  function putRelease(provider: FixtureProvider, episode: string, publishedAt: string) {
    provider.entry = catalog;
    return provider.put(listingId, `[Judas] ${title} (A Wild Last Boss Appeared!) - S02E${episode} [1080p]`,
      Date.parse(publishedAt), 'Judas', `[Judas] Yasei no - S02E${episode}.mkv`);
  }

  await t.test('following watched episode 8 estimates episode 9 at the next Saturday slot', async t => {
    const f = await fixture(t);
    f.now = Date.parse('2026-11-19T12:41:00Z');
    const record = putRelease(f.provider, '08', '2026-11-14T16:00:57Z');
    const manifest = verifySeriesMetainfo(record.bytes, record.listing, [catalog.title]);
    const queue = () => f.engine.snapshot(f.room.roomId);
    const command = (payload: object) => f.engine.command(f.room.roomId, f.room.memberId,
      { operationId: randomUUID(), queueRevision: queue().queueRevision, command: payload });
    command({ type: 'queue.add', source: manifest.source, files: [manifest.file] });
    const entryId = queue().entries[0]!.id;
    command({ type: 'history.mark', ids: [entryId], watched: true });
    const before = queue();

    const preview = await f.app.inject({ method: 'POST', url: `${f.path}/series/preview`,
      headers: auth(f.guest.token), payload: { input: '', entryId, malId: catalog.id } });
    assert.equal(preview.statusCode, 200, preview.body);
    const { draft } = preview.json();
    const expectedAirAt = Date.parse('2026-11-21T13:30:00Z');
    assert.equal(draft.anchorEpisode, 8);
    assert.equal(draft.nextEpisode, 9);
    assert.equal(draft.expectedAirAt, expectedAirAt);

    const submitted = await f.app.inject({ method: 'POST', url: `${f.path}/series`,
      headers: auth(f.guest.token), payload: { draftId: draft.id } });
    assert.equal(submitted.statusCode, 200, submitted.body);
    const { item } = submitted.json();
    assert.equal(item.nextEpisode, 9);
    assert.equal(item.expectedAirAt, expectedAirAt);
    assert.equal(item.nextCheckAt, expectedAirAt);
    assert.deepEqual(queue(), before);
  });

  for (const [name, episode, publishedAt] of [
    ['a release before the listed premiere', '01', '2026-09-26T16:00:57Z'],
    ['a release two weeks ahead of the numbering', '08', '2026-11-07T16:00:57Z'],
    ['a release uploaded a week late', '08', '2026-11-28T16:00:57Z'],
  ] as const) {
    await t.test(`${name} keeps the estimate unknown`, async t => {
      const f = await fixture(t);
      f.now = Date.parse('2026-12-01T12:00:00Z');
      putRelease(f.provider, episode, publishedAt);
      assert.equal((await f.preview(f.room.token, listingId)).expectedAirAt, null);
      const item = await f.add({}, listingId);
      assert.equal(item.expectedAirAt, null);
      assert.equal(item.nextCheckAt, null);
    });
  }
});

test('the announced part count caps additions while the catalog still reports the part airing', async t => {
  const f = await fixture(t);
  f.provider.entry = { ...f.provider.entry, episodeCount: 8 };
  const item = await f.add();
  f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  f.provider.put(102, '[Origin] Test Anime - 09 (1080p)', air, 'Original');
  f.now = air;
  await f.series!.runOnce();

  const waiting = f.rules()[0]!;
  assert.equal(waiting.status, 'active');
  assert.equal(waiting.nextEpisode, 9);
  assert.equal(waiting.nextCheckAt, null);
  assert.deepEqual(f.provider.metadataCalls, [100, 101]);
  const { room, store } = f;
  assert.equal(store.getSeriesEpisode(room.roomId, f.provider.entry.id, 8)?.listingId, 101);
  assert.equal(store.getSeriesEpisode(room.roomId, f.provider.entry.id, 9), null);

  const searches = f.provider.searches.length;
  f.provider.entry = { ...f.provider.entry, status: 'finished_airing' };
  f.now = store.getSeries(room.roomId, item.id)!.nextCatalogAt!;
  await f.series!.runOnce();
  const finished = f.rules()[0]!;
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finalEpisode, 8);
  assert.equal(finished.nextCheckAt, null);
  assert.equal(f.provider.searches.length, searches);
  assert.equal(f.engine.snapshot(room.roomId).entries.length, 2);
});

test('a finished MAL entry without a count waits for a part boundary, then adds only through that boundary', async t => {
  const f = await fixture(t);
  const item = await f.add({ expectedAirAt: null });
  f.provider.entry = { ...f.provider.entry, status: 'finished_airing', episodeCount: null };
  f.provider.put(101, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  f.provider.put(102, '[Origin] Test Anime - 09 (1080p)', air, 'Original');
  f.provider.put(103, '[Origin] Test Anime - 10 (1080p)', air, 'Original');
  const searches = f.provider.searches.length;
  const catalogCalls = f.provider.catalogCalls;
  f.now = f.store.getSeries(f.room.roomId, item.id)!.nextCatalogAt!;
  await f.series!.runOnce();

  const waiting = f.rules()[0]!;
  assert.equal(waiting.nextEpisode, 8);
  assert.equal(waiting.nextCheckAt, null);
  assert.equal(f.provider.catalogCalls, catalogCalls + 1);
  assert.equal(f.provider.searches.length, searches);
  const blocked = await f.action(item.id, { action: 'check', revision: waiting.revision });
  assert.equal(blocked.statusCode, 422);
  assert.equal(blocked.json().error.code, 'SERIES_FINALE');

  const configured = await f.action(item.id, { action: 'set-finale', finalEpisode: 9, revision: waiting.revision }, f.guest.token);
  assert.equal(configured.statusCode, 200, configured.body);
  assert.equal(configured.json().item.nextCheckAt, f.now);
  await f.series!.runOnce();
  assert.equal(f.rules()[0]!.status, 'finished');
  assert.equal(f.rules()[0]!.nextCheckAt, null);
  assert.deepEqual(f.provider.metadataCalls, [100, 101, 102]);
  assert.equal(f.engine.snapshot(f.room.roomId).entries.length, 3);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 10), null);
});

test('a part with continuous release numbering tracks MAL episodes and waits through an edition change', async t => {
  const f = await fixture(t);
  f.provider.entry = { ...f.provider.entry, startDate: '2026-11-13', episodeCount: 2 };
  const item = await f.add({ catalogEpisode: 1 });
  assert.equal(item.expectedAirAt, air);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 1)?.listingId, 100);
  f.provider.put(101, '[Origin] Test Anime - 08 (720p)', air, 'Original');
  f.now = air;
  await f.series!.runOnce();
  const review = f.rules()[0]!;
  assert.equal(review.nextEpisode, 8);
  assert.match(review.error ?? '', /changed edition/i);
  assert.deepEqual(f.provider.metadataCalls, [100]);

  f.provider.put(102, '[Origin] Test Anime - 08 (1080p)', air, 'Original');
  f.provider.put(103, '[Origin] Test Anime - 09 (1080p)', air, 'Original');
  f.provider.entry = { ...f.provider.entry, status: 'finished_airing' };
  f.now = f.store.getSeries(f.room.roomId, item.id)!.nextCatalogAt!;
  await f.series!.runOnce();
  const completed = f.rules()[0]!;
  assert.equal(completed.status, 'finished');
  assert.equal(completed.finalEpisode, 8);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 2)?.listingId, 102);
  assert.equal(f.store.getSeriesEpisode(f.room.roomId, f.provider.entry.id, 3), null);
  assert.deepEqual(f.provider.metadataCalls, [100, 102]);
});
