import { randomUUID } from 'node:crypto';
import { DomainError, requireThat } from './protocol.js';
import { SeriesProviderError, verifySeriesMetainfo, type SeriesListing, type SeriesProvider } from './series-provider.js';
import type { Store } from './store.js';

export type MetadataRequest = { type: 'series.metadata'; requestId: string; listingId: number };
export type AskDesktop = (roomId: string, request: MetadataRequest, sent: ReadonlySet<string>, attempt: number) => string[];

type Job = {
  roomId: string;
  listing: SeriesListing;
  titles: readonly string[];
  expiresAt: number;
  attempt: number;
  recipients: Set<string>;
};

export function retryableMetadata(error: unknown): error is SeriesProviderError {
  return error instanceof SeriesProviderError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

export function canAskDesktop(error: SeriesProviderError) {
  return error.status !== 429 && error.retryAfterMs === undefined;
}

export class SeriesMetadata {
  private jobs = new Map<string, Job>();

  constructor(private readonly provider: SeriesProvider, private readonly store: Store,
    private readonly now: () => number, private readonly askDesktop: AskDesktop) {}

  async resolve(roomId: string, listing: SeriesListing, titles: readonly string[] = [], attempt = 0) {
    const hash = listing.infoHash.toLowerCase();
    const cached = this.store.getSeriesMetadata(hash, this.now());
    if (cached) return verifySeriesMetainfo(cached, listing, titles);
    try {
      const { source, file, bytes } = await this.provider.metadata(listing, titles);
      if (bytes) this.store.saveSeriesMetadata(hash, bytes, this.now());
      return { source, file };
    } catch (error) {
      if (retryableMetadata(error) && canAskDesktop(error)) this.ask(roomId, listing, titles, attempt);
      throw error;
    }
  }

  ask(roomId: string, listing: SeriesListing, titles: readonly string[] = [], attempt = 0) {
    if (!/^[a-f0-9]{40}$/i.test(listing.infoHash)) return;
    const now = this.now();
    for (const [id, job] of this.jobs) if (job.expiresAt <= now) this.jobs.delete(id);
    const existing = [...this.jobs].find(([, job]) => job.roomId === roomId && job.listing.id === listing.id &&
      job.listing.infoHash === listing.infoHash);
    if (!existing && this.jobs.size >= 32) return;
    const [requestId, job] = existing ?? [randomUUID(), {
      roomId, listing, titles, attempt, expiresAt: now + 45_000, recipients: new Set<string>(),
    }];
    const recipients = this.askDesktop(roomId, { type: 'series.metadata', requestId, listingId: listing.id },
      job.recipients, job.attempt);
    for (const memberId of recipients) job.recipients.add(memberId);
    if (job.recipients.size) this.jobs.set(requestId, job);
  }

  accept(roomId: string, memberId: string, id: string, bytes: Buffer) {
    const now = this.now(), job = this.jobs.get(id);
    requireThat(job && job.roomId === roomId && job.expiresAt > now && job.recipients.has(memberId),
      'SERIES_METADATA_REQUEST', 'This torrent metadata request expired or belongs to another session.', 404);
    try { verifySeriesMetainfo(bytes, job.listing, job.titles); }
    catch (error) {
      if (!(error instanceof SeriesProviderError)) throw error;
      throw new DomainError('SERIES_METADATA_INVALID', error.message, 422);
    }
    const hash = job.listing.infoHash.toLowerCase();
    this.store.saveSeriesMetadata(hash, bytes, now);
    this.jobs.delete(id);
    return hash;
  }
}
