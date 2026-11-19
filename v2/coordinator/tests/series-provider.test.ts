import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createSeriesProvider, episodeSearchTerms, parseNyaaListing, parseNyaaRss, parseSeriesTitle,
  releaseMatches, SeriesProviderError, verifySeriesMetainfo, type SeriesListing,
} from '../src/series-provider.js';

const title = '[DKB] Kusuriya no Hitorigoto - S03E07 [1080p][HEVC x265 10bit][Multi-Subs][weekly]';
const media = '[DKB] Kusuriya no Hitorigoto - S03E07 [1080p][HEVC x265 10bit][Multi-Subs][29DBFC51].mkv';
const id = 2185799;
const publishedAt = 1794602212000;
const catalogEntry = {
  id: 61987, title: 'Kusuriya no Hitorigoto 3rd Season', status: 'currently_airing', num_episodes: 12,
  start_date: '2026-10-02', broadcast: { day_of_the_week: 'friday', start_time: '23:00' },
  alternative_titles: { en: 'The Apothecary Diaries Season 3', synonyms: ['The Apothecary Diaries S3'] },
};

function torrent(name: string, extra = '') {
  const info = Buffer.concat([
    Buffer.from(`d${extra}6:lengthi123e4:name${Buffer.byteLength(name)}:${name}12:piece lengthi16384e6:pieces20:`),
    Buffer.alloc(20, 41), Buffer.from('e'),
  ]);
  return { bytes: Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]), infoHash: createHash('sha1').update(info).digest('hex') };
}

function rss(entries: string) {
  return `<?xml version="1.0" encoding="utf-8"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0"><channel>
    <title>Nyaa &amp; RSS</title>${entries}</channel></rss>`;
}

function rssEntry(hash: string, name = title) {
  return `<item><title>${name}</title><guid isPermaLink="true">https://nyaa.si/view/${id}</guid>
    <pubDate>Fri, 13 Nov 2026 20:36:52 -0000</pubDate><nyaa:infoHash>${hash.toUpperCase()}</nyaa:infoHash>
    <nyaa:seeders>12</nyaa:seeders><description><![CDATA[https://example.invalid/<item>not a release</item>]]></description></item>`;
}

function page(hash: string) {
  return `<html><div class="panel panel-default"><div class="panel-heading">
    <h3 class="panel-title">\n[DKB] Kusuriya no Hitorigoto &amp; Tests - S03E07 (1080p)\n</h3></div>
    <div class="panel-body"><div class="row"><div>Category:</div><div><a href="/?c=1_0">Anime</a> - <a href="/?c=1_2">English-translated</a></div>
    <div>Date:</div><div data-timestamp="${publishedAt / 1000}">2026-11-13 20:36 UTC</div></div>
    <div class="row"><div class="col-md-1">Submitter:</div><div class="col-md-5"><a href="/user/DKB" title="User">DKB</a></div></div>
    <div class="row"><div class="col-md-offset-6 col-md-1">Info hash:</div><div class="col-md-5"><kbd>${hash}</kbd></div></div></div>
    <div class="panel-footer clearfix"></div><div id="torrent-description"><a href="https://example.invalid/">Ignore</a></div></html>`;
}

test('locks the original group, title, series numbering and edition without locking the episode number', () => {
  const anchor = parseSeriesTitle(title)!;
  assert.deepEqual(anchor, { group: 'dkb', stem: 'kusuriya no hitorigoto', season: 3, episode: 7,
    edition: '[1080p][hevc x265 10bit][multi-subs][weekly]', style: 'season' });
  assert(releaseMatches(anchor, parseSeriesTitle(title.replace('E07', 'E08v2') + ' [36DAB312]')!));
  assert(!releaseMatches(anchor, parseSeriesTitle(title.replace('1080p', '720p'))!));
  assert(!releaseMatches(anchor, parseSeriesTitle(title.replace('S03', 'S04'))!));
  assert(!releaseMatches(anchor, parseSeriesTitle(title.replace('DKB', 'Other'))!));
  assert.deepEqual(episodeSearchTerms(anchor, 8), ['kusuriya no hitorigoto S03E08', 'kusuriya no hitorigoto S3E8']);
  assert.equal(parseSeriesTitle('[Group] 3D Power - 02 (720p) [DEADBEEF].mkv')?.stem, '3d power');
  assert.equal(parseSeriesTitle('[Group] Example S02 - 08 (720p)')?.season, 2);
});

test('does not guess from batch, recap, fractional or multiple-number release names', () => {
  for (const rejected of ['[Group] Show - 02-03 (1080p)', '[Group] Show - 02.5 (1080p)', '[Group] Show - 02 (Recap)',
    '[Group] Show - 02 (1080p) | Show - 50', '[Group] Show - 02 (1080p) [E03]', 'Show 02 (1080p)']) {
    assert.equal(parseSeriesTitle(rejected), null, rejected);
  }
});

test('reads only bounded canonical RSS fields and keeps multiple distinct hashes for review', () => {
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  const rows = parseNyaaRss(rss(rssEntry(first, title.replace(' no ', ' &amp; ')) + rssEntry(second)));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id, title: title.replace(' no ', ' & '), infoHash: first, publishedAt, seeders: 12 });
  assert.equal(rows[1]?.infoHash, second);
  assert.deepEqual(parseNyaaRss(rss('')), []);
  assert.throws(() => parseNyaaRss(rss(rssEntry(first).replace('nyaa.si/view', 'example.invalid/view'))), /invalid RSS feed/);
});

test('refuses XML declaration attacks, unexpected root and duplicate or nested item fields', () => {
  const entry = rssEntry('a'.repeat(40));
  for (const malformed of [
    rss(entry).replace('<rss', '<!DOCTYPE rss [<!ENTITY leak SYSTEM "file:///local">]><rss'),
    rss(entry.replace('</title>', '&leak;</title>')),
    rss(entry.replace('</title>', '</title><title>spoof</title>')),
    rss(entry.replace('</title>', '<item></item></title>')),
    rss(entry).replace('https://nyaa.si/xmlns/nyaa', 'https://example.invalid'),
    '<html>Unavailable</html>', rss(entry).slice(0, -8),
  ]) assert.throws(() => parseNyaaRss(malformed), SeriesProviderError);
});

test('looks up a canonical view with a public uploader and restricts anchors to translated anime', () => {
  const hash = '9'.repeat(40), html = page(hash);
  assert.deepEqual(parseNyaaListing(html, id), { id, title: '[DKB] Kusuriya no Hitorigoto & Tests - S03E07 (1080p)',
    infoHash: hash, publishedAt, uploader: 'DKB' });
  assert.equal(parseNyaaListing(html.replace('<a href="/user/DKB" title="User">DKB</a>', 'Anonymous'), id).uploader, undefined);
  assert.throws(() => parseNyaaListing(html.replace('/?c=1_2', '/?c=3_1'), id), /translated anime/);
});

test('reconstructs the existing WatchPair wire descriptors from raw verified torrent bytes', () => {
  const { bytes, infoHash } = torrent(media);
  const actual = verifySeriesMetainfo(bytes, { id, title, infoHash, publishedAt });
  const identity = `bt:${infoHash}`;
  assert.deepEqual(actual.source, { id: identity, kind: 'torrent', identity, label: title, uri: `https://nyaa.si/download/${id}.torrent` });
  assert.deepEqual(actual.file, { mediaId: 'media:' + createHash('sha256').update(Buffer.concat([Buffer.from(identity), Buffer.from([0, 48])])).digest('hex'),
    fileIndex: 0, path: media, label: title, size: 123, duration: null, selected: true });
});

test('accepts abbreviated torrent filenames only with matching catalog aliases and episode identity', () => {
  const listingTitle = '[Judas] Tensei shitara Ken deshita (Reincarnated as a Sword) - S02E08 [1080p]';
  const filename = '[Judas] TenKen - S02E08.mkv';
  const titles = ['Tensei shitara Ken deshita II', 'Reincarnated as a Sword Season 2',
    'I became the sword by transmigrating 2nd Season, TenKen 2'];
  const { bytes, infoHash } = torrent(filename);
  const listing = { id: 2187750, title: listingTitle, infoHash, publishedAt };
  assert.throws(() => verifySeriesMetainfo(bytes, listing), /verified single-file/);
  const verified = verifySeriesMetainfo(bytes, listing, titles);
  assert.equal(verified.file.path, filename);
  assert.equal(verified.file.fileIndex, 0);
  assert.equal(verified.source.identity, `bt:${infoHash}`);
  const englishLabel = { ...listing, title: '[Judas] I became the sword by transmigrating - S02E08 [1080p]' };
  assert.equal(verifySeriesMetainfo(bytes, englishLabel, titles).file.path, filename);
  assert.throws(() => verifySeriesMetainfo(bytes, listing, ['TenKen 2']), /verified single-file/);
  assert.throws(() => verifySeriesMetainfo(bytes, { ...listing, infoHash: '0'.repeat(40) }, titles), /verified single-file/);
  for (const badName of [filename.replace('TenKen', 'Other Series'), filename.replace('E08', 'E09'),
    filename.replace('S02', 'S03'), filename.replace('Judas', 'Other Group')]) {
    const candidate = torrent(badName);
    assert.throws(() => verifySeriesMetainfo(candidate.bytes, { ...listing, infoHash: candidate.infoHash }, titles),
      /verified single-file/, badName);
  }
});

test('accepts a catalog-backed whole-word filename prefix for an explicitly numbered season', () => {
  const listingTitle = '[Judas] Yasei no Last Boss ga Arawareta! (A Wild Last Boss Appeared!) - S02E08 [1080p]';
  const catalogTitles = ['Yasei no Last Boss ga Arawareta! 2nd Season'];
  const filename = '[Judas] Yasei no - S02E08.mkv';
  const { bytes, infoHash } = torrent(filename);
  const listing = { id: 2186101, title: listingTitle, infoHash, publishedAt };
  const verified = verifySeriesMetainfo(bytes, listing, catalogTitles);
  assert.equal(verified.file.path, filename);
  assert.equal(verified.file.fileIndex, 0);
  assert.equal(verified.source.identity, `bt:${infoHash}`);
  assert.throws(() => verifySeriesMetainfo(bytes, listing), /verified single-file/);
  assert.throws(() => verifySeriesMetainfo(bytes, listing, ['Yasei no Other Series 2nd Season']), /verified single-file/);
  assert.throws(() => verifySeriesMetainfo(bytes, { ...listing, infoHash: '0'.repeat(40) }, catalogTitles), /verified single-file/);

  for (const badName of [filename.replace('Yasei no', 'Yasei'), filename.replace('Yasei no', 'Yasei n'),
    filename.replace('Yasei no', 'Other Title'), filename.replace('S02E08', 'S03E08'),
    filename.replace('S02E08', 'S02E09'), '[Judas] Yasei no S02 - 08.mkv',
    filename.replace('S02E08', 'E08'), filename.replace('Judas', 'Other Group')]) {
    const candidate = torrent(badName);
    assert.throws(() => verifySeriesMetainfo(candidate.bytes, { ...listing, infoHash: candidate.infoHash }, catalogTitles),
      /verified single-file/, badName);
  }
  const unnumbered = torrent(filename.replace('S02E08', '08'));
  assert.throws(() => verifySeriesMetainfo(unnumbered.bytes,
    { ...listing, title: listingTitle.replace('S02E08', '08'), infoHash: unnumbered.infoHash }, catalogTitles), /verified single-file/);
});

test('cached torrent metadata still requires matching catalog aliases for each caller', async () => {
  const { bytes, infoHash } = torrent('[Judas] TenKen - S02E08.mkv');
  const listing = { id: 2187750, title: '[Judas] Reincarnated as a Sword - S02E08 [1080p]', infoHash, publishedAt };
  const provider = createSeriesProvider(undefined, { fetch: async () => new Response(Uint8Array.from(bytes)) });
  const manifest = await provider.metadata(listing, ['Reincarnated as a Sword Season 2', 'TenKen 2']);
  assert.equal(manifest.file.path, '[Judas] TenKen - S02E08.mkv');
  await assert.rejects(provider.metadata(listing, ['Other Series Season 2', 'TenKen 2']), /verified single-file/);
  await assert.rejects(provider.metadata(listing), /verified single-file/);
});

test('rejects unsafe paths, bad hashes, wrong episodes and multi-file or hybrid metainfo', () => {
  const hash = 'a'.repeat(40);
  const wrong = torrent(media);
  assert.throws(() => verifySeriesMetainfo(wrong.bytes, { id, title, infoHash: hash, publishedAt }), /verified single-file/);
  for (const [name, extra] of [[media.replace('E07', 'E08'), ''], ['../' + media, ''], [media, '5:filesle'], [media, '4:attr1:p']]) {
    const { bytes, infoHash } = torrent(name!, extra!);
    assert.throws(() => verifySeriesMetainfo(bytes, { id, title, infoHash, publishedAt }), /verified single-file/);
  }
  const encoded = torrent(media);
  assert.throws(() => verifySeriesMetainfo(encoded.bytes, { id, title, infoHash: hash.padEnd(64, 'a'), publishedAt }), /verified single-file/);
  assert.throws(() => verifySeriesMetainfo(Buffer.concat([encoded.bytes, Buffer.from('junk')]), { id, title, infoHash: encoded.infoHash, publishedAt }), /verified single-file/);
});

test('keeps the app client ID on MAL, does not follow redirects and caches repeated catalog/search calls', async () => {
  const clientId = 'synthetic_client_abcdef';
  const calls: string[] = [];
  const { bytes, infoHash } = torrent(media);
  const provider = createSeriesProvider(clientId, { fetch: async (input, options) => {
    const url = new URL(String(input)), headers = new Headers(options?.headers);
    calls.push(`${url.origin}${url.pathname}`);
    assert.equal(options?.redirect, 'manual');
    if (url.origin === 'https://api.myanimelist.net') {
      assert.equal(headers.get('X-MAL-CLIENT-ID'), clientId);
      return Response.json(url.pathname === '/v2/anime' ? { data: [{ node: catalogEntry }] } : catalogEntry);
    }
    assert.equal(url.origin, 'https://nyaa.si');
    assert.equal(headers.has('X-MAL-CLIENT-ID'), false);
    if (url.pathname === `/view/${id}`) return new Response(page(infoHash));
    if (url.pathname === `/download/${id}.torrent`) return new Response(Uint8Array.from(bytes));
    assert.equal(url.searchParams.get('q'), 'a & u=other');
    assert.equal(url.searchParams.get('u'), 'DKB');
    assert.equal(url.searchParams.get('c'), '1_2');
    return new Response(rss(rssEntry(infoHash)));
  } });
  assert.equal((await provider.searchCatalog('Kusuriya no Hitorigoto'))[0]?.id, catalogEntry.id);
  const result = await Promise.all([provider.catalog(catalogEntry.id), provider.catalog(catalogEntry.id)]);
  assert.equal(result[0].broadcastTimeJapan, '23:00');
  assert.deepEqual(result[1].alternativeTitles, ['The Apothecary Diaries Season 3', 'The Apothecary Diaries S3']);
  assert.equal((await provider.listing(id)).uploader, 'DKB');
  const item = (await provider.searchReleases('a & u=other', 'DKB'))[0] as SeriesListing;
  assert.equal(item.uploader, 'DKB');
  assert.equal((await provider.metadata(item)).file.path, media);
  await provider.searchReleases('a & u=other', 'DKB');
  assert.equal(calls.length, 5);
});

test('handles provider backoff and unknown schedule values without leaking request material', async () => {
  let now = 1_800_000_000_000, attempts = 0;
  const provider = createSeriesProvider('synthetic_client_abcdef', { now: () => now, fetch: async input => {
    attempts++;
    if (String(input).startsWith('https://nyaa.si')) return new Response('ignore this body', { status: 429, headers: { 'Retry-After': '16' } });
    return Response.json({ ...catalogEntry, num_episodes: 0, broadcast: { day_of_the_week: 'other', start_time: null } });
  } });
  const row = await provider.catalog(catalogEntry.id);
  assert.equal(row.episodeCount, null);
  assert.equal(row.broadcastTimeJapan, null);
  await assert.rejects(provider.searchReleases('one'), { status: 429, retryAfterMs: 16000 });
  now += 1000;
  await assert.rejects(provider.searchReleases('two'), { status: 429, retryAfterMs: 15000 });
  assert.equal(attempts, 2);
  now += 15_000;
  await assert.rejects(provider.searchReleases('two'), { status: 429, retryAfterMs: 16000 });
  assert.equal(attempts, 3);
  await assert.rejects(createSeriesProvider(undefined, { fetch: async () => { throw new Error('must not fetch'); } }).catalog(catalogEntry.id), { status: 503 });
});

test('does not follow provider redirects or accept oversized responses', async () => {
  let calls = 0;
  const redirect = createSeriesProvider(undefined, { fetch: async (input, options) => {
    calls++;
    assert.equal(new URL(String(input)).origin, 'https://nyaa.si');
    assert.equal(options?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://example.invalid/next' } });
  } });
  await assert.rejects(redirect.listing(id), { status: 502 });
  assert.equal(calls, 1);
  const oversized = createSeriesProvider(undefined, { fetch: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) });
  await assert.rejects(oversized.listing(id), /oversized response/);
});
