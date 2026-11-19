import { randomUUID } from 'node:crypto';
import { Engine } from './engine.js';
import { DomainError, requireThat, type Entry, type FileDescriptor, type Source } from './protocol.js';
import {
  episodeSearchTerms, parseSeriesTitle, releaseMatches, sameSeriesStem, SeriesProviderError,
  type SeriesCatalog, type SeriesListing, type SeriesProvider, type SeriesRelease,
} from './series-provider.js';
import { estimateAirtime, inferAnchorAirtime, retryAt, type SeriesEpisode, type SeriesFollow } from './series-state.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CATALOG_INTERVAL = 12 * HOUR;
const DRAFT_TTL = 15 * 60_000;
const CHECK_COOLDOWN = 5 * 60_000;
const MAX_CATCH_UP = 3;
const MAX_ALTERNATE_DISMISSALS = 32;
const MAX_FOLLOWS = 16;
const MAX_ROOM_RULES = 128;
const QUEUE_APPEND_ERRORS = new Set(['SOURCE_LIMIT', 'QUEUE_LIMIT', 'MANIFEST_LIMIT', 'SOURCE_CONFLICT', 'MANIFEST_CHANGED']);
const SHARE_PROVIDERS = new Set(['nyaa.si', 'www.nyaa.si', 'myanimelist.net', 'www.myanimelist.net']);
const UNKNOWN_FINALE = 'MyAnimeList marks this entry finished but has no episode total. Confirm the last episode to continue.';
const CATALOG_UNAVAILABLE = 'MyAnimeList is temporarily unavailable. The last known schedule is still in use.';
const WAITING_FOR_FINALE = 'Reached the current MyAnimeList episode total. Waiting for the catalog to confirm the finale.';

type Manifest = { source: Source; file: FileDescriptor };
type EntryBinding = Pick<Entry, 'id' | 'mediaId' | 'path' | 'size'>;
type Draft = {
  id: string; roomId: string; memberId: string; expiresAt: number; catalog: SeriesCatalog;
  listing: SeriesListing; release: SeriesRelease; manifest: Manifest; anchor?: EntryBinding;
};
type Preview = { input: string; malId?: number; listingId?: number; entryId?: string };
type Confirm = { draftId: string; expectedAirAt?: number | null; finalEpisode?: number | null; catalogEpisode?: number };
export type SeriesAction = {
  revision: number; action: 'pause' | 'resume' | 'stop' | 'check' | 'skip' | 'approve-alternate' |
    'dismiss-alternate' | 'set-airtime' | 'set-finale' | 'replace-source' | 'link-existing';
  expectedAirAt?: number | null; finalEpisode?: number | null; alternativeId?: string; draftId?: string; entryId?: string;
};

function inputParts(input: string) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return { title: input };
  let url: URL;
  try { url = new URL(input); } catch { throw new DomainError('SERIES_LINK', 'Use a MyAnimeList anime page or a Nyaa release link.', 400); }
  const valid = url.protocol === 'https:' && SHARE_PROVIDERS.has(url.hostname) && !url.port && !url.username && !url.password;
  const mal = valid && url.hostname.endsWith('myanimelist.net') ? /^\/anime\/(\d{1,9})(?:\/[^/]+)?\/?$/.exec(url.pathname) : null;
  const nyaa = valid && url.hostname.endsWith('nyaa.si') ? /^\/view\/(\d{1,12})\/?$/.exec(url.pathname) : null;
  if (mal && Number(mal[1]) > 0) return { malId: Number(mal[1]) };
  if (nyaa && Number(nyaa[1]) > 0) return { listingId: Number(nyaa[1]) };
  throw new DomainError('SERIES_LINK', 'Use a MyAnimeList anime page or a Nyaa release link.', 400);
}

function eligible(listing: SeriesListing) {
  const release = parseSeriesTitle(listing.title);
  return release?.edition ? release : null;
}

function entryRelease(entry: Entry) {
  const name = entry.path.split('/').at(-1)!;
  return parseSeriesTitle(name) ?? (!name.startsWith('[') ? parseSeriesTitle(`[Room] ${name}`) : null);
}

function sameEntryEpisode(entry: SeriesRelease | null, release: SeriesRelease) {
  return !entry || (entry.episode === release.episode &&
    (entry.season === null || release.season === null || entry.season === release.season));
}

function sourceListingId(source: Source | undefined) {
  if (source?.kind !== 'torrent') return null;
  try {
    const url = new URL(source.uri);
    if (url.protocol !== 'https:' || !['nyaa.si', 'www.nyaa.si'].includes(url.hostname) ||
        url.port || url.username || url.password) return null;
    const match = /^(?:\/view\/(\d{1,12})\/?|\/download\/(\d{1,12})\.torrent)$/.exec(url.pathname);
    return match ? Number(match[1] ?? match[2]) || null : null;
  } catch { return null; }
}

function newAlternative(listing: SeriesListing) {
  return { id: randomUUID(), title: listing.title, listingId: listing.id, infoHash: listing.infoHash,
    publishedAt: listing.publishedAt };
}

function unavailableListing(error: unknown): error is SeriesProviderError {
  return error instanceof SeriesProviderError && (error.status === 404 || error.status === 410 || error.status === 422);
}

function providerError(error: SeriesProviderError) {
  const status = error.status === 429 || error.status === 503 ? error.status
    : error.status === undefined || error.status >= 500 || error.status === 401 || error.status === 403 ? 502 : 422;
  return new DomainError('SERIES_PROVIDER', error.message, status);
}

function catalogEnd(follow: SeriesFollow) {
  return follow.episodeCount === null ? null : follow.episodeCount + follow.catalogEpisodeOffset;
}

function finale(follow: SeriesFollow) {
  return follow.finalEpisode ?? (follow.finishConfirmed ? catalogEnd(follow) : null);
}

function needsFinale(follow: SeriesFollow) {
  return follow.finishConfirmed && finale(follow) === null;
}

function scopeReview(follow: SeriesFollow) {
  if (needsFinale(follow)) return UNKNOWN_FINALE;
  const end = catalogEnd(follow);
  if (!follow.finishConfirmed && follow.finalEpisode === null && end !== null && follow.nextEpisode > end) return WAITING_FOR_FINALE;
  return null;
}

function scheduledCheck(follow: SeriesFollow, now: number) {
  if (scopeReview(follow)) return null;
  if (follow.finishConfirmed || follow.manualCheck) return now;
  return follow.expectedAirAt === null ? null : Math.max(now, follow.expectedAirAt);
}

function forecast(follow: SeriesFollow, episode: number) {
  const release = parseSeriesTitle(follow.anchorTitle);
  return release && follow.anchorBroadcastAt !== null
    ? estimateAirtime(follow.anchorBroadcastAt, episode, release.episode, follow)
    : null;
}

function seedBroadcast(catalog: SeriesCatalog, publishedAt: number, catalogEpisode: number, nextAir?: number | null) {
  if (nextAir !== undefined && nextAir !== null) return nextAir - 7 * DAY;
  if (nextAir === null || !catalog.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(catalog.startDate)) return null;
  const inferred = inferAnchorAirtime(publishedAt, catalog);
  const start = Date.parse(catalog.startDate + 'T00:00:00+09:00');
  if (inferred === null || !Number.isFinite(start)) return null;
  // The listing can be late. Only use the weekly slot if the numbered anchor
  // also agrees with the catalog's first date. Irregular schedules need input.
  return Math.floor((inferred - start) / DAY) === (catalogEpisode - 1) * 7 ? inferred : null;
}

function publicFollow(follow: SeriesFollow) {
  const { id, malId, revision, title, anchorTitle, nextEpisode, status, nextCheckAt, lastCheckedAt, expectedAirAt, error, alternative, episodeCount } = follow;
  return { id, malId, revision, title, anchorTitle, nextEpisode, status, nextCheckAt, lastCheckedAt, expectedAirAt, error,
    episodeCount, finalEpisode: finale(follow), finalEpisodeOverride: follow.finalEpisode,
    alternative: alternative ? { id: alternative.id, title: alternative.title } : null };
}

export class SeriesService {
  private drafts = new Map<string, Draft>();
  private previews = 0;
  private running: Promise<void> | null = null;
  private closing = false;
  private nyaaBackoff = 0;
  private malBackoff = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly engine: Engine, private readonly provider: SeriesProvider) {}

  start(onError: (error: unknown) => void) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(onError); }, 15_000);
    this.timer.unref();
  }

  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  list(roomId: string) {
    return { enabled: true, items: this.engine.store.listSeries(roomId).map(publicFollow) };
  }

  private trimDrafts(now: number) {
    for (const [id, draft] of this.drafts) if (draft.expiresAt <= now) this.drafts.delete(id);
    if (this.drafts.size >= 128) this.drafts.delete(this.drafts.keys().next().value!);
  }

  async preview(roomId: string, memberId: string, input: Preview) {
    requireThat(this.previews < 2, 'SERIES_BUSY', 'Series search is busy. Try again in a moment.', 429);
    ++this.previews;
    try {
      const entry = input.entryId ? this.roomEntry(roomId, input.entryId) : null;
      const knownRelease = entry && entryRelease(entry);
      const parts = inputParts(input.input);
      const listingId = input.listingId ?? parts.listingId;
      const malId = input.malId ?? parts.malId;
      let listing = listingId ? await this.provider.listing(listingId) : null;
      if (!listing && entry && !parts.title) {
        const source = this.engine.room(roomId).sources.find(item => item.id === entry.sourceId);
        listing = await this.findEntryListing(source, knownRelease);
      }
      const parsed = listing && eligible(listing);
      if (listing) requireThat(parsed, 'SERIES_UNSUPPORTED_TITLE', 'This release does not identify a single episode and edition. Choose a clearer Nyaa release.', 422);
      if (parsed) requireThat(sameEntryEpisode(knownRelease, parsed), 'SERIES_ANCHOR_MISMATCH',
        'Choose a Nyaa release of the same episode as the selected room item.', 422);
      const query = parts.title || (parsed?.stem ?? knownRelease?.stem)?.slice(0, 160);
      const catalog = malId ? [await this.provider.catalog(malId)] : query ? await this.provider.searchCatalog(query) : [];
      const releases = listing ? [listing] : query || catalog[0] ? await this.provider.searchReleases(query ?? catalog[0]!.title) : [];
      const result = { catalog: catalog.slice(0, 12), releases: releases.flatMap(item => {
        const match = eligible(item);
        return match && sameEntryEpisode(knownRelease, match)
          ? [{ id: item.id, title: item.title, episode: match.episode, group: match.group, edition: match.edition }] : [];
      }).slice(0, 25) };
      if (!listing || !parsed || !malId || !catalog[0]) return result;
      const manifest = await this.provider.metadata(listing);
      const now = this.engine.now();
      const anchor = entry ? { id: entry.id, mediaId: entry.mediaId, path: entry.path, size: entry.size } : undefined;
      if (anchor) this.checkAnchor(roomId, anchor);
      const draft: Draft = { id: randomUUID(), roomId, memberId, expiresAt: now + DRAFT_TTL, catalog: catalog[0],
        listing, release: parsed, manifest, anchor };
      const seed = seedBroadcast(draft.catalog, listing.publishedAt, parsed.episode);
      this.trimDrafts(now);
      this.drafts.set(draft.id, draft);
      return { ...result, draft: { id: draft.id, title: draft.catalog.title, anchorTitle: listing.title, anchorListingId: listing.id,
        anchorEpisode: parsed.episode, nextEpisode: parsed.episode + 1, episodeCount: draft.catalog.episodeCount,
        expectedAirAt: seed === null ? null : estimateAirtime(seed, parsed.episode + 1, parsed.episode, draft.catalog) } };
    } catch (error) {
      if (error instanceof SeriesProviderError) throw providerError(error);
      throw error;
    } finally { --this.previews; }
  }

  private async findEntryListing(source: Source | undefined, knownRelease: SeriesRelease | null) {
    const id = sourceListingId(source);
    if (!id) return null;
    try {
      const listing = await this.provider.listing(id);
      const release = eligible(listing);
      return release && sameEntryEpisode(knownRelease, release) && source?.identity === `bt:${listing.infoHash}` ? listing : null;
    } catch (error) {
      if (unavailableListing(error)) return null;
      throw error;
    }
  }

  private roomEntry(roomId: string, id: string) {
    const entry = this.engine.room(roomId).entries.find(item => item.id === id);
    requireThat(entry, 'ENTRY_NOT_FOUND', 'This episode is no longer in the room. Choose another episode.', 404);
    return entry;
  }

  private checkAnchor(roomId: string, anchor: EntryBinding) {
    const entry = this.roomEntry(roomId, anchor.id);
    requireThat(entry.mediaId === anchor.mediaId && entry.path === anchor.path && entry.size === anchor.size,
      'SERIES_ANCHOR_CHANGED', 'The episode changed. Preview the current room episode before following it.', 409);
  }

  private draft(roomId: string, memberId: string, id: string | undefined) {
    const draft = this.drafts.get(id ?? '');
    requireThat(draft && draft.roomId === roomId && draft.memberId === memberId && draft.expiresAt > this.engine.now(),
      'SERIES_DRAFT_EXPIRED', 'Preview the release again before applying it.', 409);
    return draft;
  }

  private existing(roomId: string, id: string, revision: number) {
    const follow = this.engine.store.getSeries(roomId, id);
    requireThat(follow, 'SERIES_NOT_FOUND', 'This series follow no longer exists.', 404);
    requireThat(follow.revision === revision, 'SERIES_CONFLICT', 'The series follow changed. Refresh and try again.', 409);
    return follow;
  }

  private episode(follow: SeriesFollow, rawEpisode: number, disposition: SeriesEpisode['disposition'], listingId: number | null, entryId: string | null = null): SeriesEpisode {
    return { roomId: follow.roomId, malId: follow.malId, episode: rawEpisode - follow.catalogEpisodeOffset,
      disposition, entryId, listingId, createdAt: this.engine.now() };
  }

  private finishIfDone(follow: SeriesFollow) {
    const end = finale(follow);
    if (end !== null && follow.nextEpisode > end) {
      follow.status = 'finished'; follow.nextCheckAt = null; follow.nextCatalogAt = null;
      follow.expectedAirAt = null; follow.alternative = null; follow.manualCheck = false; follow.error = null;
      return true;
    }
    return false;
  }

  private advance(follow: SeriesFollow, now: number) {
    ++follow.nextEpisode;
    follow.airtimeManual = false;
    follow.manualCheck = false;
    follow.expectedAirAt = forecast(follow, follow.nextEpisode);
    follow.nextCheckAt = scheduledCheck(follow, now);
    follow.alternative = null;
    follow.dismissedAlternativeHashes = [];
    follow.error = scopeReview(follow);
    this.finishIfDone(follow);
  }

  add(roomId: string, memberId: string, input: Confirm) {
    const draft = this.draft(roomId, memberId, input.draftId);
    const store = this.engine.store, now = this.engine.now();
    const previous = store.getSeries(roomId, draft.id);
    if (previous) return { item: publicFollow(previous) };
    if (draft.anchor) this.checkAnchor(roomId, draft.anchor);
    const rules = store.listSeries(roomId);
    requireThat(rules.length < MAX_ROOM_RULES && rules.filter(f => f.status === 'active' || f.status === 'paused').length < MAX_FOLLOWS,
      'SERIES_LIMIT', 'This room has reached its series follow limit.', 409);
    const release = draft.release;
    const catalogEpisode = input.catalogEpisode ?? release.episode;
    requireThat(catalogEpisode <= (draft.catalog.episodeCount ?? Number.MAX_SAFE_INTEGER),
      'SERIES_NUMBERING', 'Map this release to an episode number in the selected MAL entry.', 422);
    requireThat(input.finalEpisode == null || input.finalEpisode >= release.episode,
      'SERIES_FINALE', 'The last episode cannot come before the starting release.', 422);
    const follow: SeriesFollow = { id: draft.id, roomId, malId: draft.catalog.id, revision: 1,
      title: draft.catalog.title, anchorTitle: draft.listing.title, anchorListingId: draft.listing.id,
      preferredUploader: draft.listing.uploader ?? null, nextEpisode: release.episode + 1, status: 'active',
      catalogEpisodeOffset: release.episode - catalogEpisode, episodeCount: draft.catalog.episodeCount,
      broadcastDayJapan: draft.catalog.broadcastDayJapan, broadcastTimeJapan: draft.catalog.broadcastTimeJapan,
      anchorPublishedAt: draft.listing.publishedAt,
      anchorBroadcastAt: seedBroadcast(draft.catalog, draft.listing.publishedAt, catalogEpisode, input.expectedAirAt),
      airtimeManual: input.expectedAirAt !== undefined,
      expectedAirAt: null, nextCheckAt: null, lastCheckedAt: null, finalEpisode: input.finalEpisode ?? null,
      finishConfirmed: draft.catalog.status === 'finished_airing',
      nextCatalogAt: now + CATALOG_INTERVAL, manualCheck: false, dismissedAlternativeHashes: [],
      error: null, alternative: null, createdAt: now, updatedAt: now };
    follow.expectedAirAt = input.expectedAirAt !== undefined ? input.expectedAirAt : forecast(follow, follow.nextEpisode);
    follow.nextCheckAt = scheduledCheck(follow, now);
    follow.error = scopeReview(follow);
    this.finishIfDone(follow);
    const seed = this.episode(follow, release.episode, draft.anchor ? 'existing' : 'added', draft.listing.id, draft.anchor?.id);
    if (store.getSeriesEpisode(roomId, follow.malId, seed.episode)) {
      this.engine.commitSeries({ follow, expectedRevision: null });
    } else {
      this.engine.commitSeries({ follow, expectedRevision: null, episodes: [seed] },
        draft.anchor ? [] : [{ episode: seed.episode, ...draft.manifest }]);
    }
    return { item: publicFollow(follow) };
  }

  async action(roomId: string, id: string, memberId: string, input: SeriesAction, reauthenticate = () => {}) {
    const now = this.engine.now();
    const original = this.existing(roomId, id, input.revision);
    const follow = { ...original, revision: original.revision + 1, updatedAt: now };
    const ledger = this.engine.store;
    const active = () => requireThat(follow.status === 'active', 'SERIES_INACTIVE', 'Resume this series follow first.', 409);
    const host = () => requireThat(this.engine.room(roomId).hostId === memberId, 'HOST_REQUIRED', 'Only the room host can approve or dismiss an alternate release.', 403);
    const checkScope = () => {
      const review = scopeReview(follow);
      if (review) throw new DomainError('SERIES_FINALE', review, 422);
    };
    let handled: SeriesEpisode | undefined, manifest: Manifest | undefined;
    switch (input.action) {
      case 'pause':
        active(); follow.status = 'paused'; follow.nextCheckAt = null; follow.manualCheck = false; break;
      case 'resume':
        requireThat(follow.status === 'paused', 'SERIES_INACTIVE', 'Only a paused follow can be resumed.', 409);
        follow.status = 'active'; follow.nextCatalogAt = now; follow.nextCheckAt = scheduledCheck(follow, now); break;
      case 'stop':
        follow.status = 'stopped'; follow.nextCheckAt = null; follow.nextCatalogAt = null; follow.alternative = null; follow.manualCheck = false; break;
      case 'check':
        active(); checkScope();
        requireThat(!follow.manualCheck && (follow.lastCheckedAt === null || now - follow.lastCheckedAt >= CHECK_COOLDOWN),
          'SERIES_CHECK_COOLDOWN', 'A check was requested recently. Try again in a few minutes.', 429);
        follow.manualCheck = true; follow.nextCheckAt = now; break;
      case 'set-airtime':
        active(); requireThat(input.expectedAirAt !== undefined, 'SERIES_AIRTIME', 'Supply an airtime or choose unknown.', 400);
        follow.expectedAirAt = input.expectedAirAt; follow.airtimeManual = true; follow.manualCheck = false;
        if (input.expectedAirAt !== null) {
          const anchor = parseSeriesTitle(follow.anchorTitle)!;
          follow.anchorBroadcastAt = input.expectedAirAt - (follow.nextEpisode - anchor.episode) * 7 * DAY;
        }
        follow.nextCheckAt = scheduledCheck(follow, now); break;
      case 'set-finale': {
        active(); requireThat(input.finalEpisode !== undefined && (input.finalEpisode === null || input.finalEpisode >= follow.nextEpisode - 1),
          'SERIES_FINALE', 'The finale cannot come before the episodes already accounted for.', 422);
        follow.finalEpisode = input.finalEpisode; this.finishIfDone(follow);
        const review = scopeReview(follow);
        if (follow.status === 'active' && review) {
          follow.nextCheckAt = null; follow.manualCheck = false; follow.alternative = null; follow.error = review;
        } else if (follow.status === 'active' && follow.nextCheckAt === null) {
          follow.nextCheckAt = scheduledCheck(follow, now);
          if (follow.error === UNKNOWN_FINALE || follow.error === WAITING_FOR_FINALE) follow.error = null;
        }
        break;
      }
      case 'skip':
      case 'link-existing': {
        active(); const entryId = input.entryId ?? null;
        if (input.action === 'link-existing') requireThat(entryId && this.engine.room(roomId).entries.some(entry => entry.id === entryId),
          'ENTRY_NOT_FOUND', 'Choose an existing room episode.', 404);
        handled = this.episode(follow, follow.nextEpisode, input.action === 'skip' ? 'skipped' : 'existing', null,
          input.action === 'skip' ? null : entryId);
        this.advance(follow, now); break;
      }
      case 'replace-source': {
        active(); checkScope();
        const draft = this.draft(roomId, memberId, input.draftId);
        requireThat(!draft.anchor && draft.catalog.id === follow.malId && draft.release.episode === follow.nextEpisode, 'SERIES_REPLACE',
          'Choose a release for the same catalog entry and the current missing episode.', 422);
        const priorForecast = forecast(follow, follow.nextEpisode);
        follow.anchorBroadcastAt = follow.expectedAirAt ?? priorForecast;
        follow.anchorPublishedAt = draft.listing.publishedAt;
        follow.anchorTitle = draft.listing.title; follow.anchorListingId = draft.listing.id;
        follow.preferredUploader = draft.listing.uploader ?? null;
        handled = this.episode(follow, follow.nextEpisode, 'added', draft.listing.id);
        manifest = draft.manifest; this.advance(follow, now); break;
      }
      case 'dismiss-alternate':
      case 'approve-alternate': {
        active(); host(); const offer = follow.alternative;
        requireThat(offer && offer.id === input.alternativeId, 'SERIES_ALTERNATE', 'This alternative is no longer available.', 409);
        if (input.action === 'dismiss-alternate') {
          follow.dismissedAlternativeHashes = [...follow.dismissedAlternativeHashes, offer.infoHash];
          follow.alternative = null; break;
        }
        try {
          const listing = await this.provider.listing(offer.listingId);
          requireThat(listing.infoHash === offer.infoHash, 'SERIES_ALTERNATE', 'This listing changed. Wait for the next check.', 409);
          const source = eligible(listing), anchor = parseSeriesTitle(follow.anchorTitle);
          requireThat(source && anchor && sameSeriesStem(anchor, source) && source.episode === follow.nextEpisode,
            'SERIES_ALTERNATE', 'The alternative no longer matches the missing episode.', 409);
          manifest = await this.provider.metadata(listing);
        } catch (error) {
          if (error instanceof SeriesProviderError) throw providerError(error);
          throw error;
        }
        reauthenticate(); this.existing(roomId, id, input.revision); host();
        handled = this.episode(follow, follow.nextEpisode, 'added', offer.listingId);
        this.advance(follow, this.engine.now()); break;
      }
    }
    const newRecord = handled && !ledger.getSeriesEpisode(roomId, follow.malId, handled.episode) ? handled : undefined;
    this.engine.commitSeries({ follow, expectedRevision: original.revision, episodes: newRecord ? [newRecord] : [] },
      manifest && newRecord ? [{ episode: newRecord.episode, ...manifest }] : []);
    return { item: publicFollow(follow) };
  }

  runOnce(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.poll().finally(() => { this.running = null; });
    return this.running;
  }

  private async poll() {
    const original = this.engine.store.dueSeries(this.engine.now(), 1)[0];
    if (!original) return;
    try { await this.pollFollow(original); }
    catch (error) {
      if (error instanceof DomainError && ['SERIES_CONFLICT', 'SERIES_NOT_FOUND', 'ROOM_NOT_FOUND'].includes(error.code)) return;
      throw error;
    }
  }

  private async refreshCatalog(follow: SeriesFollow, now: number) {
    if (follow.nextCatalogAt === null || follow.nextCatalogAt > now) return;
    if (this.malBackoff > now) { follow.nextCatalogAt = this.malBackoff; return; }
    try {
      const catalog = await this.provider.catalog(follow.malId);
      const hadFinale = follow.finishConfirmed && finale(follow) !== null;
      const previousReview = scopeReview(follow);
      follow.nextCatalogAt = now + CATALOG_INTERVAL;
      follow.title = catalog.title; follow.episodeCount = catalog.episodeCount;
      follow.finishConfirmed = catalog.status === 'finished_airing';
      follow.broadcastDayJapan = catalog.broadcastDayJapan; follow.broadcastTimeJapan = catalog.broadcastTimeJapan;
      const review = scopeReview(follow);
      if (review) {
        follow.error = review;
        follow.nextCheckAt = null; follow.manualCheck = false; follow.alternative = null;
        return;
      }
      if (follow.error === UNKNOWN_FINALE || follow.error === WAITING_FOR_FINALE || follow.error === CATALOG_UNAVAILABLE) follow.error = null;
      if (!follow.airtimeManual && (follow.expectedAirAt === null || follow.expectedAirAt > now)) {
        const anchor = parseSeriesTitle(follow.anchorTitle);
        if (anchor && follow.anchorBroadcastAt === null) {
          follow.anchorBroadcastAt = seedBroadcast(catalog, follow.anchorPublishedAt, anchor.episode - follow.catalogEpisodeOffset);
        }
        const predicted = forecast(follow, follow.nextEpisode);
        follow.expectedAirAt = predicted;
        if (!follow.manualCheck) follow.nextCheckAt = scheduledCheck(follow, now);
      }
      if (previousReview && follow.nextCheckAt === null) follow.nextCheckAt = scheduledCheck(follow, now);
      if (follow.finishConfirmed && (!hadFinale || follow.nextCheckAt === null)) follow.nextCheckAt = now;
    } catch (error) {
      if (!(error instanceof SeriesProviderError)) throw error;
      this.malBackoff = now + this.providerDelay(error, HOUR);
      follow.nextCatalogAt = this.malBackoff;
      follow.error = scopeReview(follow) ?? CATALOG_UNAVAILABLE;
    }
  }

  private providerDelay(error: SeriesProviderError, fallback: number) {
    return Math.max(60_000, Math.min(7 * DAY, error.retryAfterMs ?? fallback));
  }

  private choose(listings: SeriesListing[], anchor: SeriesRelease, episode: number, matchGroup: boolean, now: number) {
    const found = new Map<string, { listing: SeriesListing; release: SeriesRelease }>();
    for (const item of listings) {
      if (item.publishedAt > now) continue;
      const release = eligible(item);
      if (!release || release.episode !== episode || !sameSeriesStem(anchor, release) || (release.group === anchor.group) !== matchGroup) continue;
      if (!found.has(item.infoHash)) found.set(item.infoHash, { listing: item, release });
    }
    return [...found.values()];
  }

  private async pollFollow(original: SeriesFollow) {
    let revision = original.revision;
    const follow = { ...original }, now = this.engine.now();
    const commit = (record?: SeriesEpisode, manifest?: Manifest) => {
      follow.revision = revision + 1; follow.updatedAt = this.engine.now();
      this.engine.commitSeries({ follow, expectedRevision: revision, episodes: record ? [record] : [] },
        record && manifest ? [{ episode: record.episode, ...manifest }] : []);
      revision = follow.revision;
    };
    await this.refreshCatalog(follow, now);
    if (this.closing) return;
    this.existing(follow.roomId, follow.id, revision);
    if (this.finishIfDone(follow) || follow.nextCheckAt === null || follow.nextCheckAt > now) { commit(); return; }
    if (now < this.nyaaBackoff) { follow.nextCheckAt = this.nyaaBackoff; commit(); return; }
    const anchor = eligible({ id: follow.anchorListingId, title: follow.anchorTitle, infoHash: '', publishedAt: now });
    if (!anchor) { follow.error = 'The starting release needs a new preview.'; follow.nextCheckAt = null; commit(); return; }

    const manual = follow.manualCheck;
    follow.manualCheck = false;
    follow.lastCheckedAt = now;
    follow.error = null;
    try {
      const query = anchor.stem.slice(0, 120);
      const preferred = await this.provider.searchReleases(query, follow.preferredUploader ?? undefined);
      let broad = follow.preferredUploader ? null : preferred;
      for (let i = 0; i < MAX_CATCH_UP && follow.status === 'active' && !this.closing; ++i) {
        if (scopeReview(follow)) return;
        this.existing(follow.roomId, follow.id, revision);
        const rawEpisode = follow.nextEpisode;
        const record = this.episode(follow, rawEpisode, 'added', null);
        if (this.engine.store.getSeriesEpisode(follow.roomId, follow.malId, record.episode)) {
          this.advance(follow, now); commit(); continue;
        }
        let matches = this.choose(preferred, anchor, rawEpisode, true, now);
        let exact = matches.filter(row => releaseMatches(anchor, row.release));
        const due = i === 0 || follow.nextCheckAt !== null && follow.nextCheckAt <= now;
        const olderTerms = i === 0 && (follow.finishConfirmed || follow.expectedAirAt !== null && now - follow.expectedAirAt >= 2 * DAY)
          ? episodeSearchTerms(anchor, rawEpisode) : [];
        const searchedBroadTerms = new Set<string>();
        if (!exact.length) {
          for (const term of olderTerms) {
            this.existing(follow.roomId, follow.id, revision);
            const older = await this.provider.searchReleases(term, follow.preferredUploader ?? undefined);
            if (!follow.preferredUploader) {
              broad = [...(broad ?? []), ...older];
              searchedBroadTerms.add(term);
            }
            matches = this.choose([...matches.map(row => row.listing), ...older], anchor, rawEpisode, true, now);
            exact = matches.filter(row => releaseMatches(anchor, row.release));
            if (exact.length) break;
          }
        }
        if (exact.length === 1) {
          const listing = exact[0]!.listing;
          let manifest: Manifest | undefined;
          try { manifest = await this.provider.metadata(listing); }
          catch (error) {
            if (!unavailableListing(error)) throw error;
            follow.error = error.message;
          }
          if (this.closing) return;
          if (manifest) {
            record.listingId = listing.id;
            const before = { ...follow };
            this.advance(follow, now);
            try { commit(record, manifest); }
            catch (error) {
              if (!(error instanceof DomainError) || !QUEUE_APPEND_ERRORS.has(error.code)) throw error;
              Object.assign(follow, before);
              follow.error = error.message; follow.nextCheckAt = now + DAY;
              commit(); return;
            }
            continue;
          }
        }
        if (!due) return;
        if (exact.length > 1) {
          follow.error = 'Several distinct releases match this episode. Pick the correct release in a new preview.';
          follow.alternative = null;
        } else {
          if (matches.length && follow.error === null) follow.error = 'The selected release group changed edition. Confirm a new source or approve a one-time alternative.';
          if (follow.dismissedAlternativeHashes.length < MAX_ALTERNATE_DISMISSALS) {
            broad ??= await this.provider.searchReleases(query);
            const eligibleAlternatives = (rows: SeriesListing[]) => this.choose(rows, anchor, rawEpisode, false, now)
              .filter(item => !follow.dismissedAlternativeHashes.includes(item.listing.infoHash));
            let alternatives = eligibleAlternatives(broad);
            for (const term of olderTerms) {
              if (alternatives.length) break;
              if (searchedBroadTerms.has(term)) continue;
              this.existing(follow.roomId, follow.id, revision);
              alternatives = eligibleAlternatives(await this.provider.searchReleases(term));
            }
            alternatives.sort((a, b) => Number(b.release.edition === anchor.edition) - Number(a.release.edition === anchor.edition) ||
              (b.listing.seeders ?? 0) - (a.listing.seeders ?? 0) || b.listing.publishedAt - a.listing.publishedAt);
            follow.alternative = await this.offer(follow, alternatives.map(item => item.listing));
          }
        }
        if (this.closing) return;
        follow.nextCheckAt = this.nextRetry(follow, now, manual && i === 0);
        commit(); return;
      }
    } catch (error) {
      if (!(error instanceof SeriesProviderError)) throw error;
      this.nyaaBackoff = now + this.providerDelay(error, 30 * 60_000);
      follow.nextCheckAt = manual && follow.expectedAirAt === null && !follow.finishConfirmed
        ? null : Math.max(this.nyaaBackoff, follow.finishConfirmed ? 0 : follow.expectedAirAt ?? 0);
      follow.error = follow.nextCheckAt === null
        ? 'Nyaa is temporarily unavailable. Use Check now to try again later.'
        : 'Nyaa is temporarily unavailable. WatchPair will retry without advancing the episode.';
      if (!this.closing) commit();
    }
  }

  private nextRetry(follow: SeriesFollow, now: number, manual: boolean) {
    if (follow.finishConfirmed && (follow.expectedAirAt === null || follow.expectedAirAt > now)) return now + DAY;
    if (follow.expectedAirAt === null) return null;
    if (manual && follow.expectedAirAt > now) return follow.expectedAirAt;
    return retryAt(follow.expectedAirAt, now);
  }

  private async offer(follow: SeriesFollow, alternatives: SeriesListing[]) {
    if (follow.alternative && alternatives.some(listing => listing.infoHash === follow.alternative?.infoHash)) return follow.alternative;
    for (const listing of alternatives.slice(0, 2)) {
      try { await this.provider.metadata(listing); return newAlternative(listing); }
      catch (error) { if (!unavailableListing(error)) throw error; }
    }
    return null;
  }
}
