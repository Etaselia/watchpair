import { createHash } from 'node:crypto';
import { fileSchema, sourceSchema, type FileDescriptor, type Source } from './protocol.js';

const MAL = 'https://api.myanimelist.net';
const NYAA = 'https://nyaa.si';
const NYAA_FIELDS = 'https://nyaa.si/xmlns/nyaa';
export const MAX_SERIES_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_LISTINGS = 150;
const FIELDS = 'id,title,alternative_titles,broadcast,start_date,end_date,status,num_episodes';
const VIDEO_SUFFIX = /\.(?:mkv|mp4|webm|avi|m4v|mov|ts|m2ts)$/i;
const RELEASE_TAIL = String.raw`(?:\s*v[0-9]+)?(?<tail>(?:\s|\[|\().*|)$`;
const TECH_MARKER = /^(?:[0-9]{3,4}[pi]|x26[45]|h\.?26[45]|av1|hevc|web[ .-]?(?:dl|rip)|bluray)\b/i;
const RANGE = /^\s*(?:[-+–—&~]|to\b)\s*(?:[SE][0-9]|[0-9])/i;
const SPECIAL = /(?:^|[\s[(])(?:batch|ova|oad|special|ncop|nced|trailer|pv|recap)(?:$|[\s\])])/i;
const MULTIPLE_EPISODES = /(?:^|[\s[(])(?:S[0-9]+E[0-9]+|EP?[0-9]+)(?:\b|v[0-9])/i;
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const STATUS = ['currently_airing', 'finished_airing', 'not_yet_aired'] as const;
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'other'];
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export type SeriesRelease = {
  group: string; stem: string; season: number | null; episode: number; edition: string;
  style: 'season' | 'season-dash' | 'explicit' | 'dash';
};

export type SeriesListing = {
  id: number; title: string; infoHash: string; publishedAt: number; seeders?: number | null; uploader?: string;
};

export type SeriesCatalog = {
  id: number; title: string; status: typeof STATUS[number]; broadcastDayJapan: string | null;
  broadcastTimeJapan: string | null; episodeCount: number | null;
  startDate?: string | null; endDate?: string | null; alternativeTitles?: string[];
};

export interface SeriesProvider {
  searchCatalog(query: string): Promise<SeriesCatalog[]>;
  catalog(id: number): Promise<SeriesCatalog>;
  searchReleases(query: string, uploader?: string): Promise<SeriesListing[]>;
  listing(id: number): Promise<SeriesListing>;
  metadata(listing: SeriesListing, catalogTitles?: readonly string[]): Promise<{ source: Source; file: FileDescriptor; bytes?: Buffer }>;
}

export class SeriesProviderError extends Error {
  constructor(message: string, readonly status = 502, readonly retryAfterMs?: number) { super(message); }
}

const EPISODE_PATTERNS: [SeriesRelease['style'], RegExp][] = [
  ['season', String.raw`\s+(?:-\s+)?S(?<season>[0-9]{1,3})E(?<episode>[0-9]{1,5})`],
  ['season-dash', String.raw`\s+S(?<season>[0-9]{1,3})\s+-\s+(?<episode>[0-9]{1,5})`],
  ['explicit', String.raw`\s+(?:-\s+)?E(?:P)?(?<episode>[0-9]{1,5})`],
  ['dash', String.raw`\s+-\s+(?<episode>[0-9]{1,5})`],
].map(([style, episode]) => [style as SeriesRelease['style'], new RegExp(`^(?<stem>.+?)${episode}${RELEASE_TAIL}`, 'i')]);

function normalize(value: string) { return value.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' '); }

export function seriesTitleParts(value: string) {
  const match = /^(.+?)\s+\(([^()]+)\)$/u.exec(value);
  return match?.[2] && /\p{L}/u.test(match[2]) ? { primary: match[1]!, alternate: match[2] }
    : { primary: value, alternate: undefined };
}

export function parseSeriesTitle(title: string): SeriesRelease | null {
  if (!title || title.length > 600 || /[|\x00-\x1f\x7f]/.test(title)) return null;
  const prefix = /^\[(?<group>[^\[\]]+)\]\s*(?:-\s+)?(?<body>.+)$/.exec(title.trim().replace(VIDEO_SUFFIX, ''))?.groups;
  if (!prefix?.group || !prefix.body) return null;
  for (const [style, pattern] of EPISODE_PATTERNS) {
    const match = pattern.exec(prefix.body)?.groups;
    if (!match?.episode || !match.stem) continue;
    const tail = match.tail?.trim() ?? '';
    if (RANGE.test(tail) || SPECIAL.test(tail) || MULTIPLE_EPISODES.test(tail)
      || (tail && !/^[[(]/.test(tail) && !TECH_MARKER.test(tail))) return null;
    const group = normalize(prefix.group), stem = normalize(match.stem), episode = Number(match.episode);
    const edition = normalize(tail.replace(/\[[0-9a-f]{8}\]/gi, '').replace(/\]\s+\[/g, ']['));
    if (group && stem && episode > 0) return { group, stem, season: match.season ? Number(match.season) : null, episode, edition, style };
  }
  return null;
}

export function sameSeriesStem(a: SeriesRelease, b: SeriesRelease) {
  return a.stem === b.stem && a.season === b.season && a.style === b.style;
}

export function releaseMatches(a: SeriesRelease, b: SeriesRelease) {
  return sameSeriesStem(a, b) && a.group === b.group && a.edition === b.edition;
}

function releaseToken(release: SeriesRelease, episode: string, season: string) {
  switch (release.style) {
    case 'season': return `S${season}E${episode}`;
    case 'season-dash': return `S${season} ${episode}`;
    case 'explicit': return `E${episode}`;
    case 'dash': return episode;
  }
}

export function episodeSearchTerms(anchor: SeriesRelease, episode: number) {
  const number = String(episode), season = String(anchor.season ?? 0);
  const stem = anchor.stem.slice(0, 100).trimEnd();
  return [...new Set([`${stem} ${releaseToken(anchor, number.padStart(2, '0'), season.padStart(2, '0'))}`,
    `${stem} ${releaseToken(anchor, number, season)}`])];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 999_999_999_999;
}

function safeTitle(value: unknown, max = 600): value is string {
  return typeof value === 'string' && value.length <= max && Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value);
}

function date(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function catalogEntry(value: unknown): SeriesCatalog | null {
  const row = object(value);
  if (!row || !validId(row.id) || !safeTitle(row.title, 300) || !STATUS.some(status => status === row.status)) return null;
  const broadcast = object(row.broadcast), titles = object(row.alternative_titles);
  const day = broadcast?.day_of_the_week, time = broadcast?.start_time;
  const count = row.num_episodes;
  const alternativeTitles = [titles?.en, titles?.ja, ...(Array.isArray(titles?.synonyms) ? titles.synonyms.slice(0, 12) : [])]
    .filter((title): title is string => safeTitle(title, 300));
  return { id: row.id, title: row.title.trim(), status: row.status as SeriesCatalog['status'],
    broadcastDayJapan: typeof day === 'string' && DAYS.includes(day) ? day : null,
    broadcastTimeJapan: typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null,
    episodeCount: typeof count === 'number' && Number.isInteger(count) && count > 0 && count <= 10_000 ? count : null,
    startDate: date(row.start_date), endDate: date(row.end_date), alternativeTitles };
}

function entityText(value: string, html = false) {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"', ...(html ? { nbsp: ' ' } : {}) };
  return value.replace(/&(?:#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|[A-Za-z]+);|&/gi, entity => {
    const text = entity.slice(1, -1);
    if (Object.hasOwn(named, text)) return named[text]!;
    if (text.startsWith('#')) {
      const hex = text[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(text.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) return String.fromCodePoint(point);
    }
    throw new SeriesProviderError('The release index returned invalid markup.');
  });
}

const RSS_FIELDS = new Set(['title', 'guid', 'pubDate', 'nyaa:infoHash', 'nyaa:seeders']);

// Read only the RFC 822 timestamp and known scalar fields from Nyaa's RSS layout.
// Processing instructions, DTDs and entities other than XML literals are never evaluated.
export function parseNyaaRss(xml: string): SeriesListing[] {
  const token = /<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?xml(?:\s+[^<>]*)?\?>|<\/(?<close>[A-Za-z_][\w:.-]*)\s*>|<(?<open>[A-Za-z_][\w:.-]*)(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(?<self>\/?)>|[^<]+/gy;
  const stack: string[] = [], result: SeriesListing[] = [];
  let offset = 0, root = false, channel = false, items = 0;
  let row: Map<string, string> | null = null;
  function invalid(): never { throw new SeriesProviderError('The release index returned an invalid RSS feed.'); }
  function close(name: string) {
    if (stack.pop() !== name) invalid();
    if (name !== 'item' || stack.length !== 2 || !row) return;
    const id = Number(/^https:\/\/nyaa\.si\/view\/([1-9][0-9]{0,11})\/?$/.exec(row.get('guid')?.trim() ?? '')?.[1]);
    const title = row.get('title')?.trim(), hash = row.get('nyaa:infoHash')?.trim().toLowerCase();
    const publishedAt = Date.parse(row.get('pubDate')?.trim() ?? '');
    const rawSeeds = row.get('nyaa:seeders')?.trim() ?? '';
    if (validId(id) && safeTitle(title) && hash && HASH.test(hash) && Number.isFinite(publishedAt)) {
      result.push({ id, title, infoHash: hash, publishedAt, seeders: /^\d{1,9}$/.test(rawSeeds) ? Number(rawSeeds) : null });
    }
    row = null;
  }
  while (offset < xml.length) {
    const match = token.exec(xml);
    if (!match || match.index !== offset) invalid();
    offset = token.lastIndex;
    const { open, close: closing, self } = match.groups ?? {};
    const raw = match[0];
    if (closing) { close(closing); continue; }
    if (open) {
      if (stack.length === 0) {
        if (root || open !== 'rss' || !new RegExp(String.raw`\bxmlns:nyaa\s*=\s*(['"])${NYAA_FIELDS.replaceAll('.', '\\.')}/?\1`).test(raw)) invalid();
        root = true;
      }
      if (stack.length === 1) {
        if (channel || open !== 'channel') invalid();
        channel = true;
      }
      if (stack.length === 2 && open === 'item') {
        if (++items > MAX_LISTINGS) invalid();
        row = new Map();
      }
      if (row && stack.length === 3 && RSS_FIELDS.has(open)) {
        if (row.has(open)) invalid();
        row.set(open, '');
      }
      if (row && stack.length === 4 && RSS_FIELDS.has(stack[3]!)) invalid();
      stack.push(open);
      if (stack.length > 16) invalid();
      if (self) close(open);
      continue;
    }
    if (raw.startsWith('<?')) { if (root || stack.length) invalid(); continue; }
    if (raw.startsWith('<!--')) continue;
    const field = stack[3];
    if (row && stack.length === 4 && field && RSS_FIELDS.has(field)) {
      const value = row.get(field)! + (raw.startsWith('<![CDATA[') ? raw.slice(9, -3) : entityText(raw));
      if (value.length > 1000) invalid();
      row.set(field, value);
    } else if (stack.length === 0 && raw.trim()) invalid();
  }
  if (!root || !channel || stack.length || (items > 0 && !result.length)) invalid();
  return result;
}

// Anchor lookups use the fixed view template. Ignore site links and user-written descriptions.
export function parseNyaaListing(html: string, id: number): SeriesListing {
  // Desktop results are authenticated room submissions, so bound the template
  // scan and parse only the first matching heading and its details panel.
  const heading = /<h3\b[^<>]*\bclass\s*=\s*["']panel-title["'][^<>]*>/i.exec(html);
  const details = heading ? html.slice(heading.index + heading[0].length, heading.index + heading[0].length + 64 * 1024) : '';
  const end = /<\/h3\s*>/i.exec(details.slice(0, 4096));
  const fields = end ? details.slice(end.index + end[0].length) : '';
  const footer = /<div\b[^<>]*\bclass\s*=\s*["']panel-footer clearfix["']/i.exec(fields);
  if (!end || !footer) throw new SeriesProviderError('The Nyaa listing could not be read.');
  const panel = fields.slice(0, footer.index);
  const title = entityText(details.slice(0, end.index).replace(/<[^<>]*>/g, '').trim(), true).trim();
  const category = /\bhref\s*=\s*["'](?:https:\/\/nyaa\.si)?\/\?c=1_2["']/i.test(panel);
  const hash = /\bInfo hash:\s*<\/div>\s*<div\b[^>]*>\s*<kbd>\s*([a-f0-9]{40}|[a-f0-9]{64})\s*<\/kbd>/i.exec(panel)?.[1]?.toLowerCase();
  const seconds = Number(/\bdata-timestamp\s*=\s*["'](\d{1,12})["']/i.exec(panel)?.[1]);
  const submitter = /\bSubmitter:\s*<\/div>\s*<div\b[^>]*>\s*<a\b[^>]*\bhref\s*=\s*["'](?:https:\/\/nyaa\.si)?\/user\/([a-z0-9_-]{1,64})["']/i.exec(panel)?.[1];
  if (!validId(id) || !category || !safeTitle(title) || !hash || !validId(seconds)) {
    throw new SeriesProviderError('Use a recognized translated anime listing from Nyaa.', 422);
  }
  return { id, title, infoHash: hash, publishedAt: seconds * 1000, ...(submitter ? { uploader: submitter } : {}) };
}

type Bencode = Buffer | number | Bencode[] | Map<string, Bencode>;

function invalidTorrent(): never { throw new SeriesProviderError('The torrent metadata does not describe a verified single-file episode.', 422); }

function matchesCatalogFilename(file: SeriesRelease, listing: SeriesRelease, catalogTitles: readonly string[]) {
  if (!catalogTitles.length || file.season !== listing.season || file.style !== listing.style) return false;
  const season = listing.season;
  const roman = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
  const suffix = season ? new RegExp(` (?:s0?${season}|season 0?${season}|0?${season}(?:(?:st|nd|rd|th) season)?${
    roman[season] ? '|' + roman[season] : ''})$`, 'u') : null;
  const variants = (value: string) => {
    const normalized = normalize(value);
    const { primary, alternate } = seriesTitleParts(normalized);
    const names = [normalized, primary, ...(alternate ? [alternate] : [])];
    return suffix ? [...names, ...names.map(name => name.replace(suffix, ''))] : names;
  };
  const known = new Set(catalogTitles.flatMap(title => [title, ...title.split(/,\s+/u)]).flatMap(variants));
  const listingTitles = variants(listing.stem).filter(title => known.has(title));
  if (!listingTitles.length) return false;
  if (variants(file.stem).some(stem => known.has(stem))) return true;
  // Publishers sometimes keep only the first words of the recognized listing
  // title in the filename. Require a whole-word prefix and an explicit season.
  return season !== null && file.stem.includes(' ') && listingTitles.some(title => title.startsWith(file.stem + ' '));
}

class TorrentReader {
  offset = 0;
  infoBytes: Buffer | null = null;
  private remaining = 5000;
  constructor(private data: Buffer) {}

  read(depth = 0): Bencode {
    if (--this.remaining < 0 || depth > 32 || this.offset >= this.data.length) invalidTorrent();
    const token = this.data[this.offset];
    if (token === 100 || token === 108) {
      this.offset++;
      const items: Bencode[] = [], entries = new Map<string, Bencode>();
      let previous: Buffer | null = null;
      while (this.offset < this.data.length && this.data[this.offset] !== 101) {
        if (token === 108) { items.push(this.read(depth + 1)); continue; }
        const key = this.read(depth + 1);
        if (!Buffer.isBuffer(key) || (previous && previous.compare(key) >= 0)) invalidTorrent();
        previous = key;
        const begin = this.offset, name = key.toString('latin1');
        entries.set(name, this.read(depth + 1));
        if (depth === 0 && name === 'info') this.infoBytes = this.data.subarray(begin, this.offset);
      }
      if (this.data[this.offset++] !== 101) invalidTorrent();
      return token === 108 ? items : entries;
    }
    if (token === 105) {
      const start = ++this.offset, end = this.data.subarray(start, start + 22).indexOf(101);
      const field = end < 0 ? '' : this.data.toString('latin1', start, start + end);
      if (!/^(?:0|-?[1-9][0-9]*)$/.test(field) || !Number.isSafeInteger(Number(field))) invalidTorrent();
      this.offset = start + end + 1;
      return Number(field);
    }
    const start = this.offset, end = this.data.subarray(start, start + 10).indexOf(58);
    const field = end < 0 ? '' : this.data.toString('latin1', start, start + end);
    if (!/^(?:0|[1-9][0-9]*)$/.test(field)) invalidTorrent();
    const begin = start + end + 1;
    this.offset = begin + Number(field);
    if (this.offset > this.data.length) invalidTorrent();
    return this.data.subarray(begin, this.offset);
  }
}

export function verifySeriesMetainfo(data: Buffer, listing: SeriesListing, catalogTitles: readonly string[] = []): { source: Source; file: FileDescriptor } {
  if (!data.length || data.length > MAX_SERIES_METADATA_BYTES || !validId(listing.id) || !/^[a-f0-9]{40}$/i.test(listing.infoHash)) invalidTorrent();
  const reader = new TorrentReader(data), torrent = reader.read();
  if (!(torrent instanceof Map) || reader.offset !== data.length || !reader.infoBytes) invalidTorrent();
  const info = torrent.get('info');
  if (!(info instanceof Map) || ['meta version', 'file tree', 'files', 'attr'].some(key => info.has(key))) invalidTorrent();
  const digest = createHash('sha1').update(reader.infoBytes).digest('hex');
  if (digest !== listing.infoHash.toLowerCase()) invalidTorrent();
  const nativeName = info.get('name'), nativeUtf8 = info.get('name.utf-8');
  if (!Buffer.isBuffer(nativeName) || nativeName.length > 255 || (nativeUtf8 !== undefined && (!Buffer.isBuffer(nativeUtf8) || !nativeName.equals(nativeUtf8)))) invalidTorrent();
  let path: string;
  try { path = UTF8.decode(nativeName); } catch { return invalidTorrent(); }
  if (!path || /^[ .]|[ .]$/.test(path) || /[\/\\:%<>"?*|\x00-\x1f\x7f]/.test(path) || !VIDEO_SUFFIX.test(path)) invalidTorrent();
  const match = parseSeriesTitle(path), release = parseSeriesTitle(listing.title);
  if (!match || !release || match.episode !== release.episode || match.group !== release.group ||
      (!sameSeriesStem(match, release) && !matchesCatalogFilename(match, release, catalogTitles))) invalidTorrent();
  const length = info.get('length'), pieceLength = info.get('piece length'), pieces = info.get('pieces');
  if (typeof length !== 'number' || length <= 0 || typeof pieceLength !== 'number' || pieceLength <= 0
    || !Buffer.isBuffer(pieces) || pieces.length !== 20 * Math.ceil(length / pieceLength)) invalidTorrent();
  const identity = `bt:${digest}`, mediaId = `media:${createHash('sha256').update(`${identity}\0${0}`).digest('hex')}`;
  const label = listing.title.slice(0, 300).replace(/[\uD800-\uDBFF]$/, '').trim();
  const source = sourceSchema.parse({ id: identity, kind: 'torrent', identity, label, uri: `${NYAA}/download/${listing.id}.torrent` });
  const file = fileSchema.parse({ mediaId, fileIndex: 0, path, label, size: length, duration: null, selected: true });
  return { source, file };
}

function retryAfter(header: string | null, now: number) {
  if (!header) return undefined;
  const ms = /^[0-9]{1,10}$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? Math.max(1000, ms) : undefined;
}

class Cache<T> {
  private ready = new Map<string, { expires: number; value: T }>();
  private pending = new Map<string, Promise<T>>();
  constructor(private now: () => number, private ttl: number, private maxEntries = 64) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const entry = this.ready.get(key);
    if (entry && entry.expires > this.now()) return Promise.resolve(entry.value);
    const previous = this.pending.get(key);
    if (previous) return previous;
    if (this.pending.size >= 8) return Promise.reject(new SeriesProviderError('Too many catalog requests are in progress.', 503, 5000));
    const pending = load().then(value => {
      this.ready.delete(key);
      this.ready.set(key, { expires: this.now() + this.ttl, value });
      if (this.ready.size > this.maxEntries) this.ready.delete(this.ready.keys().next().value!);
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
}

export function createSeriesProvider(clientId?: string, options: { fetch?: typeof fetch; now?: () => number } = {}): SeriesProvider {
  const send = options.fetch ?? fetch, now = options.now ?? Date.now;
  const catalogs = new Cache<SeriesCatalog>(now, 12 * 60 * 60 * 1000);
  const searches = new Cache<SeriesCatalog[]>(now, 15 * 60 * 1000);
  const feeds = new Cache<SeriesListing[]>(now, 5 * 60 * 1000);
  const listings = new Cache<SeriesListing>(now, 5 * 60 * 1000);
  const metadata = new Cache<{ source: Source; file: FileDescriptor; bytes: Buffer }>(now, 5 * 60 * 1000, 8);
  const busyUntil = new Map<string, number>();
  let active = 0;

  async function read(url: URL, accept: string): Promise<Buffer> {
    const mal = url.origin === MAL, unavailable = mal ? 'MyAnimeList' : 'Nyaa';
    if (!mal && url.origin !== NYAA) throw new SeriesProviderError('Invalid series provider.', 400);
    if (mal && (!clientId || !/^[A-Za-z0-9_-]{16,128}$/.test(clientId))) throw new SeriesProviderError('MyAnimeList catalog access is not configured.', 503);
    const wait = (busyUntil.get(url.origin) ?? 0) - now();
    if (wait > 0) throw new SeriesProviderError(`${unavailable} requested a pause before checking again.`, 429, wait);
    if (active >= 4) throw new SeriesProviderError('Too many catalog requests are in progress.', 503, 5000);
    active++;
    const signal = AbortSignal.timeout(10_000);
    try {
      const response = await send(url, { redirect: 'manual', signal,
        headers: { Accept: accept, 'User-Agent': 'WatchPair/2 series follows', ...(mal ? { 'X-MAL-CLIENT-ID': clientId! } : {}) } });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const ms = retryAfter(response.headers.get('Retry-After'), now()) ?? (response.status === 429 ? 60_000 : undefined);
        if (ms !== undefined && (response.status === 429 || response.status === 503)) busyUntil.set(url.origin, now() + ms);
        const status = response.status >= 400 ? response.status : 502;
        throw new SeriesProviderError(`${unavailable} returned HTTP ${response.status}.`, status, ms);
      }
      if (!response.body) throw new SeriesProviderError(`${unavailable} returned an empty response.`);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_SERIES_METADATA_BYTES) {
          void reader.cancel().catch(() => {});
          throw new SeriesProviderError(`${unavailable} returned an oversized response.`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof SeriesProviderError) throw error;
      if (signal.aborted) throw new SeriesProviderError(`${unavailable} did not respond in time. Try again shortly.`, 504);
      throw new SeriesProviderError(`${unavailable} could not be reached.`);
    } finally { active--; }
  }

  async function readText(url: URL, accept: string) {
    const bytes = await read(url, accept);
    try { return UTF8.decode(bytes); } catch { throw new SeriesProviderError('The series provider returned invalid text.'); }
  }

  async function readJson(url: URL): Promise<unknown> {
    const text = await readText(url, 'application/json');
    try { return JSON.parse(text); } catch { throw new SeriesProviderError('MyAnimeList returned invalid catalog data.'); }
  }

  return {
    async searchCatalog(query) {
      if (!safeTitle(query, 160)) throw new SeriesProviderError('Enter a title to search MyAnimeList.', 400);
      return searches.get(normalize(query), async () => {
        const url = new URL('/v2/anime', MAL);
        url.search = new URLSearchParams({ q: query.trim(), limit: '10', fields: FIELDS }).toString();
        const data = object(await readJson(url))?.data;
        if (!Array.isArray(data)) throw new SeriesProviderError('MyAnimeList returned an invalid list.');
        return data.slice(0, 10).map(row => catalogEntry(object(row)?.node)).filter((row): row is SeriesCatalog => row !== null);
      });
    },
    async catalog(id) {
      if (!validId(id)) throw new SeriesProviderError('Choose a valid MyAnimeList anime.', 400);
      return catalogs.get(String(id), async () => {
        const url = new URL(`/v2/anime/${id}`, MAL);
        url.searchParams.set('fields', FIELDS);
        const row = catalogEntry(await readJson(url));
        if (row?.id !== id) throw new SeriesProviderError('MyAnimeList returned invalid anime details.');
        return row;
      });
    },
    async searchReleases(query, uploader) {
      if (!safeTitle(query, 160) || (uploader !== undefined && !/^[a-z0-9_-]{1,64}$/i.test(uploader))) throw new SeriesProviderError('Invalid Nyaa search.', 400);
      const params = new URLSearchParams({ page: 'rss', c: '1_2', q: query.trim() });
      if (uploader) params.set('u', uploader);
      return feeds.get(params.toString(), async () => {
        const xml = await readText(new URL(`/?${params}`, NYAA), 'application/rss+xml,application/xml');
        return parseNyaaRss(xml).map(item => uploader ? { ...item, uploader } : item);
      });
    },
    async listing(id) {
      if (!validId(id)) throw new SeriesProviderError('Choose a valid Nyaa listing.', 400);
      return listings.get(String(id), async () => parseNyaaListing(await readText(new URL(`/view/${id}`, NYAA), 'text/html'), id));
    },
    async metadata(listing, catalogTitles = []) {
      if (!validId(listing.id) || !HASH.test(listing.infoHash) || !safeTitle(listing.title)) invalidTorrent();
      const key = JSON.stringify([listing.id, listing.infoHash, listing.title, catalogTitles]);
      return metadata.get(key, async () => {
        const bytes = await read(new URL(`/download/${listing.id}.torrent`, NYAA), 'application/x-bittorrent');
        return { ...verifySeriesMetainfo(bytes, listing, catalogTitles), bytes };
      });
    },
  };
}
