import { randomUUID } from 'node:crypto';
import { DomainError, requireThat } from './protocol.js';
import {
  parseNyaaListing, parseNyaaRss, SeriesProviderError, verifySeriesMetainfo, type SeriesListing, type SeriesProvider,
} from './series-provider.js';
import type { Store } from './store.js';

type Lookup = { kind: 'listing'; listingId: number } | { kind: 'search'; query: string; uploader?: string };
type Work = Lookup | { kind: 'metadata'; listing: SeriesListing; titles: readonly string[] };
export type DesktopRequest =
  | { type: 'series.metadata'; requestId: string; listingId: number }
  | ({ type: 'series.lookup'; requestId: string } & Lookup);
export type DesktopRecipient = { memberId: string; connectionId: string; network: string };
export type AskDesktop = (roomId: string, request: DesktopRequest, tried: ReadonlySet<string>) => DesktopRecipient | undefined;

const ATTEMPT_TIMEOUT = 25_000;
const ROUND_COOLDOWN = 60_000;
const RETAIN = 5 * 60_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

type Attempt = DesktopRecipient & { id: string; timer: ReturnType<typeof setTimeout> };
type Round = {
  roomId: string; work: Work; tried: Set<string>; active?: Attempt; retryAt: number; notBefore: number; expiresAt: number;
};

export function retryableMetadata(error: unknown): error is SeriesProviderError {
  return error instanceof SeriesProviderError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

export function canAskDesktop(error: SeriesProviderError) {
  return error.status !== 429 && error.retryAfterMs === undefined;
}

export class SeriesLookupWaiting extends SeriesProviderError {
  constructor(readonly pending: boolean, readonly checkAt: number) {
    super(pending ? 'Checking Nyaa from connected desktops…'
      : 'Nyaa could not be reached from the connected desktops. Try again shortly.', 503);
  }
}

export class SeriesMetadata {
  private rounds = new Map<string, Round>();
  private results = new Map<string, { listings: SeriesListing[]; expiresAt: number }>();
  constructor(private readonly provider: SeriesProvider, private readonly store: Store,
    private readonly now: () => number, private readonly askDesktop: AskDesktop) {}

  async resolve(roomId: string, listing: SeriesListing, titles: readonly string[] = []) {
    const hash = listing.infoHash.toLowerCase();
    const cached = this.store.getSeriesMetadata(hash, this.now());
    if (cached) return verifySeriesMetainfo(cached, listing, titles);
    try {
      const { source, file, bytes } = await this.provider.metadata(listing, titles);
      if (bytes) this.store.saveSeriesMetadata(hash, bytes, this.now());
      const key = this.key(roomId, { kind: 'metadata', listing, titles });
      const round = this.rounds.get(key);
      if (round) this.remove(key, round);
      return { source, file };
    } catch (error) {
      if (retryableMetadata(error) && canAskDesktop(error)) this.ask(roomId, listing, titles);
      throw error;
    }
  }

  ask(roomId: string, listing: SeriesListing, titles: readonly string[] = []) {
    if (/^[a-f0-9]{40}$/i.test(listing.infoHash)) this.request(roomId, { kind: 'metadata', listing, titles });
  }

  async listing(roomId: string, listingId: number) {
    return (await this.lookup(roomId, { kind: 'listing', listingId }))[0]!;
  }

  searchReleases(roomId: string, query: string, uploader?: string) {
    return this.lookup(roomId, { kind: 'search', query, uploader });
  }

  private async lookup(roomId: string, lookup: Lookup): Promise<SeriesListing[]> {
    const key = this.key(roomId, lookup), now = this.now();
    const result = this.results.get(key);
    if (result && result.expiresAt > now) return result.listings;
    const existing = this.rounds.get(key);
    if (existing?.active || (existing && existing.retryAt > now)) this.waitFor(existing);
    try {
      return lookup.kind === 'listing'
        ? [await this.provider.listing(lookup.listingId)]
        : await this.provider.searchReleases(lookup.query, lookup.uploader);
    } catch (error) {
      if (retryableMetadata(error) && canAskDesktop(error)) {
        const round = this.request(roomId, lookup);
        if (round?.tried.size) this.waitFor(round);
      }
      throw error;
    }
  }

  desktopOnline(roomId: string) {
    this.prune();
    for (const round of this.rounds.values()) {
      if (round.roomId === roomId && !round.active && round.retryAt > this.now()) this.dispatch(round);
    }
  }

  desktopOffline(connectionId: string) {
    for (const round of this.rounds.values()) {
      if (round.active?.connectionId === connectionId) this.next(round);
    }
  }

  close() {
    for (const [key, round] of this.rounds) this.remove(key, round);
    this.results.clear();
  }

  fail(roomId: string, memberId: string, connectionId: string, id: string, retryAfterMs = 0) {
    const match = this.attempt(roomId, memberId, connectionId, id);
    if (!match) return;
    const round = match[1];
    round.notBefore = Math.max(round.notBefore, this.now() + retryAfterMs);
    this.next(round);
  }

  accept(roomId: string, memberId: string, connectionId: string, id: string, bytes: Buffer, lookup = false) {
    const match = this.attempt(roomId, memberId, connectionId, id);
    requireThat(match && (match[1].work.kind !== 'metadata') === lookup,
      'SERIES_METADATA_REQUEST', 'This Nyaa request expired or belongs to another session.', 404);
    const [key, round] = match, work = round.work, now = this.now();
    let hash: string | null = null;
    try {
      if (work.kind === 'metadata') {
        verifySeriesMetainfo(bytes, work.listing, work.titles);
        hash = work.listing.infoHash.toLowerCase();
      } else {
        const text = UTF8.decode(bytes);
        const listings = work.kind === 'listing' ? [parseNyaaListing(text, work.listingId)]
          : parseNyaaRss(text).map(listing => work.uploader ? { ...listing, uploader: work.uploader } : listing);
        if (this.results.size >= 64) this.results.delete(this.results.keys().next().value!);
        this.results.set(key, { listings, expiresAt: now + RETAIN });
      }
    } catch (error) {
      this.next(round);
      if (error instanceof TypeError || error instanceof SeriesProviderError)
        throw new DomainError('SERIES_METADATA_INVALID', 'The desktop did not return a valid Nyaa response.', 422);
      throw error;
    }
    if (hash) this.store.saveSeriesMetadata(hash, bytes, now);
    this.remove(key, round);
    return hash;
  }

  private key(roomId: string, work: Work) {
    const query = work.kind === 'metadata' ? [work.kind, work.listing.id, work.listing.infoHash.toLowerCase()]
      : work.kind === 'listing' ? [work.kind, work.listingId]
      : [work.kind, work.query.trim().toLowerCase(), work.uploader?.toLowerCase()];
    return JSON.stringify([roomId, ...query]);
  }

  private waitFor(round: Round): never {
    throw new SeriesLookupWaiting(Boolean(round.active), round.active ? this.now() + 15_000 : round.retryAt);
  }

  private request(roomId: string, work: Work) {
    this.prune();
    const key = this.key(roomId, work), now = this.now();
    let round = this.rounds.get(key);
    if (!round) {
      if (this.rounds.size >= 32) return;
      round = { roomId, work, tried: new Set(), retryAt: 0, notBefore: 0, expiresAt: now + RETAIN };
      this.rounds.set(key, round);
    }
    if (round.active) return round;
    if (round.retryAt && now >= round.retryAt) {
      round.tried.clear();
      round.retryAt = 0;
      round.notBefore = 0;
    }
    this.dispatch(round);
    if (!round.tried.size) this.remove(key, round);
    return round;
  }

  private dispatch(round: Round) {
    const id = randomUUID(), work = round.work;
    const event: DesktopRequest = work.kind === 'metadata'
      ? { type: 'series.metadata', requestId: id, listingId: work.listing.id }
      : { type: 'series.lookup', requestId: id, ...work };
    const recipient = this.askDesktop(round.roomId, event, round.tried);
    if (!recipient) {
      round.retryAt ||= Math.max(round.notBefore, this.now() + ROUND_COOLDOWN);
      round.expiresAt = Math.max(round.expiresAt, round.retryAt + RETAIN);
      return;
    }
    round.retryAt = 0;
    round.expiresAt = this.now() + RETAIN;
    round.tried.add(recipient.network);
    const timer = setTimeout(() => this.next(round), ATTEMPT_TIMEOUT);
    timer.unref();
    round.active = { ...recipient, id, timer };
  }

  private next(round: Round) {
    clearTimeout(round.active?.timer);
    delete round.active;
    this.dispatch(round);
  }

  private attempt(roomId: string, memberId: string, connectionId: string, id: string) {
    return [...this.rounds].find(([, round]) => round.roomId === roomId && round.active?.id === id &&
      round.active.memberId === memberId && round.active.connectionId === connectionId);
  }

  private remove(key: string, round: Round) {
    clearTimeout(round.active?.timer);
    this.rounds.delete(key);
  }

  private prune() {
    const now = this.now();
    for (const [key, round] of this.rounds) if (!round.active && round.expiresAt <= now) this.remove(key, round);
    for (const [key, result] of this.results) if (result.expiresAt <= now) this.results.delete(key);
  }
}
