import { randomUUID } from 'node:crypto';
import { DomainError, requireThat } from './protocol.js';
import {
  parseNyaaListing, parseNyaaRss, SeriesProviderError, verifySeriesMetainfo, type SeriesListing, type SeriesProvider,
} from './series-provider.js';
import type { Store } from './store.js';

type Lookup = { kind: 'listing'; listingId: number } | { kind: 'search'; query: string; uploader?: string };
type Work = Lookup | { kind: 'metadata'; listing: SeriesListing; titles: readonly string[] };
export type DesktopRequest = (
  | { type: 'series.metadata'; requestId: string; listingId: number }
  | ({ type: 'series.lookup'; requestId: string } & Lookup)) & { timeoutMs?: number };
export type DesktopRecipient = { memberId: string; connectionId: string; network: string };
export type AskDesktop = (roomId: string, request: DesktopRequest, tried: ReadonlySet<string>,
  preferredConnection?: string) => DesktopRecipient | undefined;
export type InteractiveLookup = { connectionId?: string; signal: AbortSignal };

const ATTEMPT_TIMEOUT = 25_000;
const ROUND_COOLDOWN = 60_000;
const RETAIN = 5 * 60_000;
const DESKTOP_HEAD_START = 2_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

type Attempt = DesktopRecipient & { id: string; timer: ReturnType<typeof setTimeout> };
type Round = {
  roomId: string; work: Work; tried: Set<string>; active?: Attempt; retryAt: number; notBefore: number; expiresAt: number;
  settled: Promise<void>; settle: () => void;
  short: boolean;
};

export function retryableMetadata(error: unknown): error is SeriesProviderError {
  return error instanceof SeriesProviderError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

export function canAskDesktop(error: SeriesProviderError) {
  return error.status !== 429 && error.retryAfterMs === undefined;
}

export class SeriesLookupWaiting extends SeriesProviderError {
  constructor(readonly pending: boolean, readonly checkAt: number, readonly lookupKey?: string) {
    super(pending ? 'Checking Nyaa from connected desktops…'
      : 'Nyaa could not be reached from the connected desktops. Try again shortly.', 503);
  }
}

export class SeriesMetadata {
  private rounds = new Map<string, Round>();
  private results = new Map<string, { listings: SeriesListing[]; expiresAt: number }>();
  private interactive = new Map<string, Promise<unknown>>();
  private healthyDesktops = new Map<string, { connectionId: string; until: number }>();
  private vpsSlowUntil = 0;
  constructor(private readonly provider: SeriesProvider, private readonly store: Store,
    private readonly now: () => number, private readonly askDesktop: AskDesktop) {}

  async resolve(roomId: string, listing: SeriesListing, titles: readonly string[] = [], mode?: InteractiveLookup, scheduled = false) {
    const hash = listing.infoHash.toLowerCase();
    const work: Work = { kind: 'metadata', listing, titles };
    const key = this.key(roomId, work);
    const cached = () => {
      const bytes = this.store.getSeriesMetadata(hash, this.now());
      return bytes ? verifySeriesMetainfo(bytes, listing, titles) : undefined;
    };
    const load = async () => {
      const { source, file, bytes } = await this.provider.metadata(listing, titles);
      if (bytes) this.store.saveSeriesMetadata(hash, bytes, this.now());
      return { source, file };
    };
    const ready = cached();
    if (ready) return ready;
    if (mode) return this.raceLookup(roomId, work, mode, cached, load);
    const healthy = scheduled && this.preferredDesktop(roomId);
    if (healthy) {
      const round = this.rounds.get(key) ?? this.request(roomId, work, healthy);
      if (round?.active || (round && round.retryAt > this.now())) this.waitFor(round, key);
    }
    try {
      const result = await load();
      const round = this.rounds.get(key);
      if (round) this.remove(key, round);
      return result;
    } catch (error) {
      if (retryableMetadata(error) && canAskDesktop(error)) {
        this.vpsSlowUntil = this.now() + ROUND_COOLDOWN;
        this.ask(roomId, listing, titles);
      }
      throw error;
    }
  }

  ask(roomId: string, listing: SeriesListing, titles: readonly string[] = []) {
    if (/^[a-f0-9]{40}$/i.test(listing.infoHash)) this.request(roomId, { kind: 'metadata', listing, titles });
  }

  async listing(roomId: string, listingId: number, mode?: InteractiveLookup) {
    return (await this.lookup(roomId, { kind: 'listing', listingId }, mode))[0]!;
  }

  searchReleases(roomId: string, query: string, uploader?: string, mode?: InteractiveLookup, scheduled = false) {
    return this.lookup(roomId, { kind: 'search', query, uploader }, mode, scheduled);
  }

  private async lookup(roomId: string, lookup: Lookup, mode?: InteractiveLookup, scheduled = false): Promise<SeriesListing[]> {
    const key = this.key(roomId, lookup), now = this.now();
    const cached = () => {
      const result = this.results.get(key);
      return result && result.expiresAt > this.now() ? result.listings : undefined;
    };
    const load = async () => lookup.kind === 'listing'
      ? [await this.provider.listing(lookup.listingId)]
      : await this.provider.searchReleases(lookup.query, lookup.uploader);
    const ready = cached();
    if (ready) return ready;
    if (mode) return this.raceLookup(roomId, lookup, mode, cached, load);
    const healthy = scheduled && this.preferredDesktop(roomId);
    const existing = this.rounds.get(key) ?? (healthy ? this.request(roomId, lookup, healthy) : undefined);
    if (existing?.active || (existing && existing.retryAt > now)) this.waitFor(existing, key);
    try {
      return await load();
    } catch (error) {
      if (retryableMetadata(error) && canAskDesktop(error)) {
        this.vpsSlowUntil = this.now() + ROUND_COOLDOWN;
        const round = this.request(roomId, lookup);
        if (round?.tried.size) this.waitFor(round, key);
      }
      throw error;
    }
  }

  private preferredDesktop(room: string) {
    const route = this.healthyDesktops.get(room);
    return route && route.until > this.now() && this.now() < this.vpsSlowUntil ? route.connectionId : undefined;
  }

  private raceLookup<T>(roomId: string, work: Work, mode: InteractiveLookup, cached: () => T | undefined,
    load: () => Promise<T>): Promise<T> {
    const key = this.key(roomId, work);
    const shared = work.kind === 'metadata' ? key + JSON.stringify(work.titles) : key;
    const existing = this.interactive.get(shared);
    if (existing) return existing as Promise<T>;
    if (this.interactive.size >= 32) throw new SeriesProviderError('Too many Nyaa lookups are in progress.', 503, 5000);
    const promise = this.tryRoutes(roomId, work, key, mode, cached, load)
      .finally(() => this.interactive.delete(shared));
    this.interactive.set(shared, promise);
    return promise;
  }

  private async tryRoutes<T>(roomId: string, work: Work, key: string, mode: InteractiveLookup,
    cached: () => T | undefined, load: () => Promise<T>): Promise<T> {
    const timedOut = () => new SeriesProviderError('Nyaa is still taking too long. Try again shortly.', 504);
    if (mode.signal.aborted) throw timedOut();
    let abort!: () => void;
    const deadline = new Promise<never>((_, reject) => { abort = () => reject(timedOut()); });
    mode.signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let round = this.rounds.get(key);
      if (round && round.retryAt <= this.now() && !round.active) round = undefined;
      if (round && !round.active) this.waitFor(round, key);
      const preferred = mode.connectionId ?? this.preferredDesktop(roomId);
      if (!round && preferred) round = this.request(roomId, work, preferred, true);
      if (round?.active) {
        await Promise.race([round.settled, deadline, new Promise<void>(done => {
          timer = setTimeout(done, DESKTOP_HEAD_START);
          timer.unref();
        })]);
        const value = cached();
        if (value !== undefined) return value;
        if (round.notBefore > this.now()) this.waitFor(round, key);
      }
      const direct = load().then(value => ({ type: 'vps' as const, value }),
        error => ({ type: 'error' as const, error: error as unknown }));
      let outcome = await Promise.race(round?.active ?
        [direct, round.settled.then(() => ({ type: 'desktop' as const })), deadline] : [direct, deadline]);
      if (outcome.type === 'desktop') {
        const value = cached();
        if (value !== undefined) return value;
        if (round!.notBefore > this.now()) this.waitFor(round!, key);
        outcome = await Promise.race([direct, deadline]);
      }
      if (outcome.type === 'vps') {
        if (round && this.rounds.get(key) === round) this.remove(key, round);
        return outcome.value;
      }
      if (!retryableMetadata(outcome.error) || !canAskDesktop(outcome.error)) {
        if (round && this.rounds.get(key) === round) this.remove(key, round);
        throw outcome.error;
      }
      this.vpsSlowUntil = this.now() + ROUND_COOLDOWN;
      if (!round) round = this.request(roomId, work, undefined, true);
      if (round?.active) await Promise.race([round.settled, deadline]);
      const value = cached();
      if (value !== undefined) return value;
      if (round?.tried.size) this.waitFor(round, key);
      throw outcome.error;
    } finally {
      clearTimeout(timer);
      mode.signal.removeEventListener('abort', abort);
    }
  }

  desktopOffline(connectionId: string) {
    for (const [room, route] of this.healthyDesktops)
      if (route.connectionId === connectionId) this.healthyDesktops.delete(room);
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
    // An explicit provider cooldown stops this lookup across the existing round.
    if (retryAfterMs > 0) {
      clearTimeout(round.active?.timer);
      delete round.active;
      round.retryAt = Math.max(round.notBefore, this.now() + ROUND_COOLDOWN);
      round.expiresAt = round.retryAt + RETAIN;
      round.settle();
    } else this.next(round);
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
    if (this.healthyDesktops.size >= 64) this.healthyDesktops.delete(this.healthyDesktops.keys().next().value!);
    this.healthyDesktops.set(roomId, { connectionId, until: now + RETAIN });
    this.remove(key, round);
    return { hash, key };
  }

  private key(roomId: string, work: Work) {
    const query = work.kind === 'metadata' ? [work.kind, work.listing.id, work.listing.infoHash.toLowerCase()]
      : work.kind === 'listing' ? [work.kind, work.listingId]
      : [work.kind, work.query.trim().toLowerCase(), work.uploader?.toLowerCase()];
    return JSON.stringify([roomId, ...query]);
  }

  private waitFor(round: Round, key: string): never {
    throw new SeriesLookupWaiting(Boolean(round.active), round.active ? this.now() + 15_000 : round.retryAt, key);
  }

  private request(roomId: string, work: Work, preferred?: string, short = Boolean(preferred)) {
    this.prune();
    const key = this.key(roomId, work), now = this.now();
    let round = this.rounds.get(key);
    if (round && round.retryAt > now) return round;
    if (round && !round.active) {
      this.remove(key, round);
      round = undefined;
    }
    if (!round) {
      if (this.rounds.size >= 32) return;
      let settle!: () => void;
      const settled = new Promise<void>(done => { settle = done; });
      round = { roomId, work, tried: new Set(), retryAt: 0, notBefore: 0, expiresAt: now + RETAIN, settled, settle, short };
      this.rounds.set(key, round);
    }
    if (round.active) return round;
    this.dispatch(round, preferred);
    if (!round.tried.size) { this.remove(key, round); return; }
    return round;
  }

  private dispatch(round: Round, preferred?: string) {
    const id = randomUUID(), work = round.work;
    const event: DesktopRequest = work.kind === 'metadata'
      ? { type: 'series.metadata', requestId: id, listingId: work.listing.id }
      : { type: 'series.lookup', requestId: id, ...work };
    const recipient = this.askDesktop(round.roomId, round.short ? { ...event, timeoutMs: 6500 } : event, round.tried, preferred);
    if (!recipient) {
      round.retryAt ||= Math.max(round.notBefore, this.now() + ROUND_COOLDOWN);
      round.expiresAt = Math.max(round.expiresAt, round.retryAt + RETAIN);
      round.settle();
      return;
    }
    round.retryAt = 0;
    round.expiresAt = this.now() + RETAIN;
    round.tried.add(recipient.network);
    const timer = setTimeout(() => this.next(round), round.short ? 9000 : ATTEMPT_TIMEOUT);
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
    round.settle();
  }

  private prune() {
    const now = this.now();
    for (const [key, round] of this.rounds) if (!round.active && round.expiresAt <= now) this.remove(key, round);
    for (const [key, result] of this.results) if (result.expiresAt <= now) this.results.delete(key);
  }
}
