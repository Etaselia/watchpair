import { randomUUID } from 'node:crypto';
import { Engine } from './engine.js';
import { DomainError, requireThat, type Entry, type FileDescriptor, type Source } from './protocol.js';
import {
  catalogSearchTerms, episodeSearchTerms, matchesCatalogTitle, parseSeriesTitle, sameSeriesStem, seriesTitleParts,
  SeriesProviderError,
  type SeriesCatalog, type SeriesListing, type SeriesProvider, type SeriesRelease,
} from './series-provider.js';
import { canAskDesktop, retryableMetadata, SeriesLookupWaiting, SeriesMetadata, type AskDesktop } from './series-metadata.js';
import { estimateAirtime, inferAnchorAirtime, retryAt, type SeriesEntryBinding, type SeriesEpisode,
  type SeriesFollow, type SeriesMetadataRetry } from './series-state.js';

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
type Draft = {
  id: string; roomId: string; memberId: string; expiresAt: number; catalog: SeriesCatalog;
  listing: SeriesListing; release: SeriesRelease; manifest?: Manifest; anchor?: SeriesEntryBinding;
};
type Preview = { input: string; malId?: number; listingId?: number; entryId?: string; deferMetadata?: boolean };
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

function verifiedCatalogTitles(catalog: SeriesCatalog) {
  return [catalog.title, ...(catalog.alternativeTitles ?? [])];
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
  const daysSincePremiere = Math.floor((inferred - start) / DAY);
  const numberedWeek = (catalogEpisode - 1) * 7;
  // A verified early episode can put the numbering one slot ahead of the TV
  // premiere. A late upload or a larger gap still needs a confirmed airtime.
  return daysSincePremiere >= 0 && (daysSincePremiere === numberedWeek || daysSincePremiere === numberedWeek - 7)
    ? inferred : null;
}

function publicFollow(follow: SeriesFollow) {
  const { id, malId, revision, title, anchorTitle, nextEpisode, status, nextCheckAt, lastCheckedAt, expectedAirAt, error, alternative, episodeCount } = follow;
  return { id, malId, revision, title, anchorTitle, nextEpisode, status, nextCheckAt, lastCheckedAt, expectedAirAt, error,
    pending: follow.pendingSeed ? 'setup' : follow.pendingRelease ? 'episode' : null,
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
  private readonly metadata: SeriesMetadata;

  constructor(private readonly engine: Engine, private readonly provider: SeriesProvider, askDesktop: AskDesktop = () => undefined) {
    this.metadata = new SeriesMetadata(provider, engine.store, () => engine.now(), askDesktop);
  }

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
    this.metadata.close();
  }

  list(roomId: string) {
    return { enabled: true, items: this.engine.store.listSeries(roomId).map(publicFollow) };
  }

  desktopOnline(roomId: string) {
    this.metadata.desktopOnline(roomId);
    for (const follow of this.engine.store.listSeries(roomId)) {
      const pending = follow.pendingSeed ?? follow.pendingRelease;
      if (follow.status === 'active' && pending?.desktopEligible &&
          !this.engine.store.getSeriesMetadata(pending.listing.infoHash, this.engine.now())) {
        this.metadata.ask(roomId, pending.listing, follow.catalogTitles);
      }
    }
  }

  desktopOffline(connectionId: string) { this.metadata.desktopOffline(connectionId); }

  desktopFailed(roomId: string, memberId: string, connectionId: string, requestId: string, retryAfterMs?: number) {
    this.metadata.fail(roomId, memberId, connectionId, requestId, retryAfterMs);
  }

  acceptMetadata(roomId: string, memberId: string, connectionId: string, requestId: string, bytes: Buffer, lookup: boolean) {
    const hash = this.metadata.accept(roomId, memberId, connectionId, requestId, bytes, lookup);
    if (!hash) return { accepted: true };
    const now = this.engine.now();
    for (const follow of this.engine.store.listSeries(roomId)) {
      const pending = follow.pendingSeed ?? follow.pendingRelease;
      if (follow.status === 'active' && pending?.listing.infoHash === hash &&
          follow.nextCheckAt !== null && follow.nextCheckAt > now) {
        this.engine.commitSeries({
          follow: { ...follow, nextCheckAt: now, revision: follow.revision + 1, updatedAt: now },
          expectedRevision: follow.revision,
        });
      }
    }
    return { accepted: true };
  }

  private trimDrafts(now: number) {
    for (const [id, draft] of this.drafts) if (draft.expiresAt <= now) this.drafts.delete(id);
    if (this.drafts.size >= 128) this.drafts.delete(this.drafts.keys().next().value!);
  }

  async preview(roomId: string, memberId: string, input: Preview, waitForLookup = false) {
    requireThat(this.previews < 2, 'SERIES_BUSY', 'Series search is busy. Try again in a moment.', 429);
    ++this.previews;
    try {
      const entry = input.entryId ? this.roomEntry(roomId, input.entryId) : null;
      const knownRelease = entry && entryRelease(entry);
      const parts = inputParts(input.input);
      const listingId = input.listingId ?? parts.listingId;
      const malId = input.malId ?? parts.malId;
      let listing = listingId ? await this.metadata.listing(roomId, listingId) : null;
      if (!listing && entry && !parts.title) {
        const source = this.engine.room(roomId).sources.find(item => item.id === entry.sourceId);
        listing = await this.findEntryListing(roomId, source, knownRelease);
      }
      const parsed = listing && eligible(listing);
      if (listing) requireThat(parsed, 'SERIES_UNSUPPORTED_TITLE', 'This release does not identify a single episode and edition. Choose a clearer Nyaa release.', 422);
      if (parsed) requireThat(sameEntryEpisode(knownRelease, parsed), 'SERIES_ANCHOR_MISMATCH',
        'Choose a Nyaa release of the same episode as the selected room item.', 422);
      const stem = parsed?.stem ?? knownRelease?.stem;
      const query = parts.title || stem?.slice(0, 160);
      const inferredTitle = stem ? seriesTitleParts(stem) : undefined;
      const catalogQuery = parts.title || inferredTitle?.primary.slice(0, 160);
      let catalog = malId ? [await this.provider.catalog(malId)] : catalogQuery ? await this.provider.searchCatalog(catalogQuery) : [];
      const fallbackTitle = parts.title ? seriesTitleParts(parts.title).primary : inferredTitle?.alternate?.slice(0, 160);
      if (!catalog.length && fallbackTitle && fallbackTitle !== catalogQuery)
        catalog = await this.provider.searchCatalog(fallbackTitle);
      const selectedCatalog = malId ? catalog[0] : undefined;
      const titles = selectedCatalog ? verifiedCatalogTitles(selectedCatalog) : undefined;
      const firstQuery = query ?? catalog[0]?.title.slice(0, 160);
      const candidates = (rows: SeriesListing[], useSelectedTitle = false) => rows.flatMap(item => {
        const match = eligible(item);
        if (!match || !sameEntryEpisode(knownRelease, match)) return [];
        if (useSelectedTitle && titles &&
            !(knownRelease && sameSeriesStem(knownRelease, match)) &&
            (!matchesCatalogTitle(match, match, titles) ||
              (knownRelease?.season != null && match.season !== knownRelease.season))) return [];
        return [{ id: item.id, title: item.title, episode: match.episode, group: match.group, edition: match.edition }];
      }).slice(0, 25);
      let releases = listing ? candidates([listing]) :
        firstQuery ? candidates(await this.metadata.searchReleases(roomId, firstQuery), Boolean(knownRelease)) : [];
      if (!listing && !releases.length && selectedCatalog) {
        for (const term of catalogSearchTerms(selectedCatalog.title, knownRelease?.season ?? null, firstQuery)) {
          releases = candidates(await this.metadata.searchReleases(roomId, term), true);
          if (releases.length) break;
        }
      }
      const result = { catalog: catalog.slice(0, 12), releases };
      if (!listing || !parsed || !malId || !catalog[0]) return result;
      const manifest = input.deferMetadata ? undefined : await this.metadata.resolve(roomId, listing, verifiedCatalogTitles(catalog[0]));
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
      if (waitForLookup && error instanceof SeriesLookupWaiting && error.pending) return { lookupPending: true };
      if (error instanceof SeriesProviderError) throw providerError(error);
      throw error;
    } finally { --this.previews; }
  }

  private async findEntryListing(roomId: string, source: Source | undefined, knownRelease: SeriesRelease | null) {
    const id = sourceListingId(source);
    if (!id) return null;
    try {
      const listing = await this.metadata.listing(roomId, id);
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

  private checkAnchor(roomId: string, anchor: SeriesEntryBinding) {
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
      delete follow.pendingRelease;
      return true;
    }
    return false;
  }

  private advance(follow: SeriesFollow, now: number) {
    delete follow.pendingRelease;
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
    const store = this.engine.store, now = this.engine.now();
    const previous = store.getSeries(roomId, input.draftId);
    if (previous) return { item: publicFollow(previous) };
    const draft = this.draft(roomId, memberId, input.draftId);
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
      title: draft.catalog.title, catalogTitles: verifiedCatalogTitles(draft.catalog),
      anchorTitle: draft.listing.title, anchorListingId: draft.listing.id,
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
    if (!draft.manifest && !store.getSeriesEpisode(roomId, follow.malId, catalogEpisode)) {
      follow.pendingSeed = { listing: draft.listing, anchor: draft.anchor, failures: 0, desktopEligible: false };
      follow.nextCheckAt = now; follow.nextCatalogAt = null;
      follow.error = 'Checking the starting release. WatchPair retries automatically if metadata is temporarily unavailable.';
      this.engine.commitSeries({ follow, expectedRevision: null });
    } else {
      this.completeSeed(follow, null, draft.listing, draft.anchor, draft.manifest);
    }
    return { item: publicFollow(follow) };
  }

  private completeSeed(follow: SeriesFollow, revision: number | null, listing: SeriesListing,
    anchor?: SeriesEntryBinding, manifest?: Manifest) {
    const now = this.engine.now();
    if (follow.pendingSeed) follow.lastCheckedAt = null;
    delete follow.pendingSeed;
    follow.nextCatalogAt = now + CATALOG_INTERVAL;
    follow.nextCheckAt = scheduledCheck(follow, now);
    follow.error = scopeReview(follow);
    this.finishIfDone(follow);
    const seed = this.episode(follow, follow.nextEpisode - 1, anchor ? 'existing' : 'added', listing.id, anchor?.id);
    if (this.engine.store.getSeriesEpisode(follow.roomId, follow.malId, seed.episode)) {
      this.engine.commitSeries({ follow, expectedRevision: revision });
    } else {
      requireThat(manifest, 'SERIES_METADATA_REQUIRED', 'The starting release still needs verified torrent metadata.', 409);
      this.engine.commitSeries({ follow, expectedRevision: revision, episodes: [seed] },
        anchor ? [] : [{ episode: seed.episode, ...manifest }]);
    }
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
    requireThat(!follow.pendingSeed || ['pause', 'resume', 'stop'].includes(input.action),
      'SERIES_PENDING', 'The starting release needs verified metadata before this action is available.', 409);
    let handled: SeriesEpisode | undefined, manifest: Manifest | undefined;
    switch (input.action) {
      case 'pause':
        active(); follow.status = 'paused'; follow.nextCheckAt = null; follow.manualCheck = false; break;
      case 'resume':
        requireThat(follow.status === 'paused', 'SERIES_INACTIVE', 'Only a paused follow can be resumed.', 409);
        follow.status = 'active';
        follow.nextCatalogAt = follow.pendingSeed ? null : now;
        follow.nextCheckAt = follow.pendingSeed || follow.pendingRelease ? now : scheduledCheck(follow, now); break;
      case 'stop':
        follow.status = 'stopped'; follow.nextCheckAt = null; follow.nextCatalogAt = null; follow.alternative = null; follow.manualCheck = false;
        if (follow.pendingSeed || follow.pendingRelease) follow.error = null;
        delete follow.pendingSeed; delete follow.pendingRelease; break;
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
        if (!follow.pendingRelease) follow.nextCheckAt = scheduledCheck(follow, now);
        break;
      case 'set-finale': {
        active(); requireThat(input.finalEpisode !== undefined && (input.finalEpisode === null || input.finalEpisode >= follow.nextEpisode - 1),
          'SERIES_FINALE', 'The finale cannot come before the episodes already accounted for.', 422);
        follow.finalEpisode = input.finalEpisode; this.finishIfDone(follow);
        const review = scopeReview(follow);
        if (follow.status === 'active' && review) {
          follow.nextCheckAt = null; follow.manualCheck = false; follow.alternative = null; follow.error = review;
          delete follow.pendingRelease;
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
        requireThat(draft.manifest, 'SERIES_METADATA_REQUIRED', 'Preview the new release to verify its torrent metadata.', 409);
        const priorForecast = forecast(follow, follow.nextEpisode);
        follow.anchorBroadcastAt = follow.expectedAirAt ?? priorForecast;
        follow.anchorPublishedAt = draft.listing.publishedAt;
        follow.anchorTitle = draft.listing.title; follow.anchorListingId = draft.listing.id;
        follow.catalogTitles = verifiedCatalogTitles(draft.catalog);
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
          const listing = await this.metadata.listing(roomId, offer.listingId);
          requireThat(listing.infoHash === offer.infoHash, 'SERIES_ALTERNATE', 'This listing changed. Wait for the next check.', 409);
          const source = eligible(listing), anchor = parseSeriesTitle(follow.anchorTitle);
          requireThat(source && anchor && this.matchesSeries(follow, anchor, source) && source.episode === follow.nextEpisode,
            'SERIES_ALTERNATE', 'The alternative no longer matches the missing episode.', 409);
          manifest = await this.metadata.resolve(roomId, listing, follow.catalogTitles);
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
    try {
      if (original.pendingSeed) await this.pollSeed(original, original.pendingSeed);
      else await this.pollFollow(original);
    }
    catch (error) {
      if (error instanceof DomainError && ['SERIES_CONFLICT', 'SERIES_NOT_FOUND', 'ROOM_NOT_FOUND'].includes(error.code)) return;
      throw error;
    }
  }

  private saveRetry(follow: SeriesFollow, error: SeriesProviderError, pending: SeriesMetadataRetry) {
    const failures = pending.failures + 1;
    const delay = this.providerDelay(error, Math.min(30 * 60_000, 60_000 * 2 ** Math.min(5, pending.failures)));
    follow.nextCheckAt = this.engine.now() + delay;
    follow.error = 'Waiting for Nyaa torrent metadata. WatchPair will retry automatically.';
    return { ...pending, failures, desktopEligible: canAskDesktop(error) };
  }

  private async pollSeed(original: SeriesFollow, pending: NonNullable<SeriesFollow['pendingSeed']>) {
    const follow = { ...original, revision: original.revision + 1, updatedAt: this.engine.now(),
      lastCheckedAt: this.engine.now() };
    const { anchor, listing } = pending;
    try {
      if (anchor) this.checkAnchor(follow.roomId, anchor);
      const manifest = await this.metadata.resolve(follow.roomId, listing, follow.catalogTitles);
      if (this.closing) return;
      this.existing(follow.roomId, follow.id, original.revision);
      if (anchor) this.checkAnchor(follow.roomId, anchor);
      this.completeSeed(follow, original.revision, listing, anchor, manifest);
    } catch (error) {
      if (this.closing) return;
      Object.assign(follow, original, { revision: original.revision + 1, updatedAt: this.engine.now(), lastCheckedAt: follow.lastCheckedAt });
      follow.pendingSeed = pending;
      follow.nextCatalogAt = null;
      if (retryableMetadata(error)) {
        follow.pendingSeed = { ...this.saveRetry(follow, error, pending), anchor };
      } else if (error instanceof SeriesProviderError || error instanceof DomainError &&
          (QUEUE_APPEND_ERRORS.has(error.code) || ['ENTRY_NOT_FOUND', 'SERIES_ANCHOR_CHANGED'].includes(error.code))) {
        follow.status = 'paused';
        follow.nextCheckAt = null;
        follow.error = error.message;
      } else throw error;
      this.engine.commitSeries({ follow, expectedRevision: original.revision });
    }
  }

  private async refreshCatalog(follow: SeriesFollow, now: number) {
    if (follow.nextCatalogAt === null || (follow.catalogTitles && follow.nextCatalogAt > now)) return;
    if (this.malBackoff > now) { follow.nextCatalogAt = this.malBackoff; return; }
    try {
      const catalog = await this.provider.catalog(follow.malId);
      const hadFinale = follow.finishConfirmed && finale(follow) !== null;
      const previousReview = scopeReview(follow);
      follow.nextCatalogAt = now + CATALOG_INTERVAL;
      follow.title = catalog.title; follow.catalogTitles = verifiedCatalogTitles(catalog); follow.episodeCount = catalog.episodeCount;
      follow.finishConfirmed = catalog.status === 'finished_airing';
      follow.broadcastDayJapan = catalog.broadcastDayJapan; follow.broadcastTimeJapan = catalog.broadcastTimeJapan;
      const review = scopeReview(follow);
      if (review) {
        follow.error = review;
        follow.nextCheckAt = null; follow.manualCheck = false; follow.alternative = null;
        delete follow.pendingRelease;
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
        if (!follow.manualCheck && !follow.pendingRelease) follow.nextCheckAt = scheduledCheck(follow, now);
      }
      if (previousReview && follow.nextCheckAt === null) follow.nextCheckAt = scheduledCheck(follow, now);
      if (follow.finishConfirmed && !follow.pendingRelease && (!hadFinale || follow.nextCheckAt === null)) follow.nextCheckAt = now;
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

  private matchesSeries(follow: SeriesFollow, anchor: SeriesRelease, release: SeriesRelease) {
    return sameSeriesStem(anchor, release) ||
      matchesCatalogTitle(anchor, release, follow.catalogTitles ?? [follow.title]);
  }

  private choose(follow: SeriesFollow, listings: SeriesListing[], anchor: SeriesRelease, episode: number, matchGroup: boolean, now: number) {
    const found = new Map<string, { listing: SeriesListing; release: SeriesRelease }>();
    for (const item of listings) {
      if (item.publishedAt > now) continue;
      const release = eligible(item);
      if (!release || release.episode !== episode || !this.matchesSeries(follow, anchor, release) ||
          (release.group === anchor.group) !== matchGroup) continue;
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
    if (follow.pendingRelease) {
      const pending = follow.pendingRelease;
      const record = this.episode(follow, follow.nextEpisode, 'added', pending.listing.id);
      try {
        const manifest = this.engine.store.getSeriesEpisode(follow.roomId, follow.malId, record.episode)
          ? undefined : await this.metadata.resolve(follow.roomId, pending.listing, follow.catalogTitles);
        if (this.closing) return;
        this.advance(follow, now);
        commit(manifest ? record : undefined, manifest);
      } catch (error) {
        if (this.closing) return;
        if (retryableMetadata(error)) follow.pendingRelease = this.saveRetry(follow, error, pending);
        else if (error instanceof SeriesProviderError) {
          delete follow.pendingRelease;
          follow.error = error.message;
          follow.nextCheckAt = this.nextRetry(follow, now, follow.manualCheck);
        } else if (error instanceof DomainError && QUEUE_APPEND_ERRORS.has(error.code)) {
          Object.assign(follow, original);
          follow.pendingRelease = { ...pending, desktopEligible: false };
          follow.error = error.message;
          follow.nextCheckAt = now + DAY;
        } else throw error;
        commit();
      }
      return;
    }
    if (now < this.nyaaBackoff) { follow.nextCheckAt = this.nyaaBackoff; commit(); return; }
    const anchor = eligible({ id: follow.anchorListingId, title: follow.anchorTitle, infoHash: '', publishedAt: now });
    if (!anchor) { follow.error = 'The starting release needs a new preview.'; follow.nextCheckAt = null; commit(); return; }

    const manual = follow.manualCheck;
    follow.manualCheck = false;
    follow.lastCheckedAt = now;
    follow.error = null;
    try {
      const query = anchor.stem.slice(0, 120);
      const catalogTerms = catalogSearchTerms(follow.title, anchor.season, query);
      const searches = new Map<string, Promise<SeriesListing[]>>();
      const search = (term: string, uploader?: string) => {
        const key = JSON.stringify([term, uploader]);
        let request = searches.get(key);
        if (!request) {
          request = this.metadata.searchReleases(follow.roomId, term, uploader);
          searches.set(key, request);
        }
        return request;
      };
      const uploader = follow.preferredUploader ?? undefined;
      const preferred = await search(query, uploader);
      for (let i = 0; i < MAX_CATCH_UP && follow.status === 'active' && !this.closing; ++i) {
        if (scopeReview(follow)) return;
        this.existing(follow.roomId, follow.id, revision);
        const rawEpisode = follow.nextEpisode;
        const record = this.episode(follow, rawEpisode, 'added', null);
        if (this.engine.store.getSeriesEpisode(follow.roomId, follow.malId, record.episode)) {
          this.advance(follow, now); commit(); continue;
        }
        let matches = this.choose(follow, preferred, anchor, rawEpisode, true, now);
        let exact = matches.filter(row => row.release.edition === anchor.edition);
        const due = i === 0 || follow.nextCheckAt !== null && follow.nextCheckAt <= now;
        const olderTerms = i === 0 && (follow.finishConfirmed || follow.expectedAirAt !== null && now - follow.expectedAirAt >= 2 * DAY)
          ? episodeSearchTerms(anchor, rawEpisode) : [];
        if (!exact.length && due) {
          for (const term of [...catalogTerms, ...olderTerms]) {
            this.existing(follow.roomId, follow.id, revision);
            const rows = await search(term, uploader);
            matches = this.choose(follow, [...matches.map(row => row.listing), ...rows], anchor, rawEpisode, true, now);
            exact = matches.filter(row => row.release.edition === anchor.edition);
            if (exact.length) break;
          }
        }
        if (exact.length === 1) {
          const listing = exact[0]!.listing;
          let manifest: Manifest | undefined;
          try { manifest = await this.metadata.resolve(follow.roomId, listing, follow.catalogTitles); }
          catch (error) {
            if (retryableMetadata(error)) {
              follow.pendingRelease = this.saveRetry(follow, error, { listing, failures: 0, desktopEligible: false });
              follow.alternative = null;
              if (!this.closing) commit();
              return;
            }
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
            let alternatives: ReturnType<SeriesService['choose']> = [];
            for (const term of [query, ...catalogTerms, ...olderTerms]) {
              this.existing(follow.roomId, follow.id, revision);
              alternatives = this.choose(follow, await search(term), anchor, rawEpisode, false, now)
                .filter(item => !follow.dismissedAlternativeHashes.includes(item.listing.infoHash));
              if (alternatives.length) break;
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
      if (error instanceof SeriesLookupWaiting) {
        follow.error = error.message;
        follow.manualCheck = manual;
        follow.nextCheckAt = error.checkAt;
        if (!this.closing) commit();
        return;
      }
      this.nyaaBackoff = now + this.providerDelay(error, 30 * 60_000);
      follow.manualCheck = manual;
      follow.nextCheckAt = Math.max(this.nyaaBackoff, follow.finishConfirmed ? 0 : follow.expectedAirAt ?? 0);
      follow.error = 'Nyaa is temporarily unavailable. WatchPair will retry without advancing the episode.';
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
      try { await this.metadata.resolve(follow.roomId, listing, follow.catalogTitles); return newAlternative(listing); }
      catch (error) { if (!unavailableListing(error)) throw error; }
    }
    return null;
  }
}
