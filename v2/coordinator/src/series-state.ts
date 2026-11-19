export type SeriesFollowStatus = 'active' | 'paused' | 'stopped' | 'finished';

export type SeriesAlternative = {
  id: string;
  title: string;
  listingId: number;
  infoHash: string;
  publishedAt: number;
};

export type SeriesFollow = {
  id: string;
  roomId: string;
  malId: number;
  revision: number;
  title: string;
  catalogTitles?: string[];
  anchorTitle: string;
  anchorListingId: number;
  preferredUploader: string | null;
  anchorPublishedAt: number;
  anchorBroadcastAt: number | null;
  broadcastDayJapan: string | null;
  broadcastTimeJapan: string | null;
  // The original release can use absolute numbering. The ledger uses the
  // episode number within the selected MAL entry, independent of release edits.
  catalogEpisodeOffset: number;
  nextEpisode: number;
  status: SeriesFollowStatus;
  expectedAirAt: number | null;
  airtimeManual: boolean;
  nextCheckAt: number | null;
  nextCatalogAt: number | null;
  lastCheckedAt: number | null;
  manualCheck: boolean;
  finalEpisode: number | null;
  episodeCount: number | null;
  finishConfirmed: boolean; // The catalog marks this entry finished, even if its episode total is absent.
  error: string | null;
  alternative: SeriesAlternative | null;
  dismissedAlternativeHashes: string[];
  createdAt: number;
  updatedAt: number;
};

export type SeriesEpisode = {
  roomId: string;
  malId: number;
  episode: number;
  disposition: 'added' | 'existing' | 'skipped';
  entryId: string | null;
  listingId: number | null;
  createdAt: number;
};

export type SeriesSave = { follow: SeriesFollow; expectedRevision: number | null; episodes?: SeriesEpisode[] };

type BroadcastSlot = { broadcastDayJapan: string | null; broadcastTimeJapan: string | null };

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const week = 7 * day;
const japanOffset = 9 * hour;
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function slotAtOrBefore(reference: number, slot: BroadcastSlot): number | null {
  const weekday = weekdays.indexOf(slot.broadcastDayJapan?.toLowerCase() ?? '');
  const time = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/.exec(slot.broadcastTimeJapan ?? '');
  if (weekday < 0 || !time?.groups || !Number.isSafeInteger(reference)) return null;
  const local = reference + japanOffset;
  const currentDay = new Date(local).getUTCDay();
  if (!Number.isFinite(currentDay)) return null;
  const midnight = Math.floor(local / day) * day;
  const daysBack = (currentDay - weekday + weekdays.length) % weekdays.length;
  const localTime = Number(time.groups.hour) * hour + Number(time.groups.minute) * 60_000;
  const occurrence = midnight - daysBack * day + localTime - japanOffset;
  return occurrence <= reference ? occurrence : occurrence - week;
}

/** Infer a conservative anchor from an already released episode. */
export function inferAnchorAirtime(publishedAt: number, slot: BroadcastSlot): number | null {
  const occurrence = slotAtOrBefore(publishedAt, slot);
  if (occurrence === null || publishedAt - occurrence > 3 * day) return null;
  return occurrence;
}

/** Project the known episode's week, then resolve the nearest current JST slot. */
export function estimateAirtime(
  anchorBroadcastAt: number | null,
  nextEpisode: number,
  anchorEpisode: number,
  slot: BroadcastSlot,
): number | null {
  if (anchorBroadcastAt === null || !Number.isSafeInteger(anchorBroadcastAt) ||
      !Number.isSafeInteger(nextEpisode) || !Number.isSafeInteger(anchorEpisode)) return null;
  const projected = anchorBroadcastAt + (nextEpisode - anchorEpisode) * week;
  const occurrence = slotAtOrBefore(projected, slot);
  if (occurrence === null) return null;
  return projected - occurrence <= week / 2 ? occurrence : occurrence + week;
}

/** Retry only known-airtime checks. Explicit checks of unscheduled episodes are one-shot. */
export function retryAt(expectedAirAt: number | null, checkedAt: number): number | null {
  if (expectedAirAt === null) return null;
  if (checkedAt < expectedAirAt) return expectedAirAt;
  const interval = checkedAt - expectedAirAt < 48 * hour ? 2 * hour : day;
  return checkedAt + interval;
}
