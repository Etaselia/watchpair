"""Read-only airing-series pilot. Uses Nyaa listings and .torrent metadata, never peers or rooms."""

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree


ORIGIN = 'https://nyaa.si'
NS = '{https://nyaa.si/xmlns/nyaa}'
MAX_BYTES = 2 * 1024 * 1024
MAX_CATCH_UP = 3
VIDEO_SUFFIXES = {'.mkv', '.mp4', '.webm', '.avi', '.m4v', '.mov', '.ts', '.m2ts'}
EPISODE_PATTERNS = (
    ('season', r'\s+(?:-\s+)?S(?P<season>[0-9]{1,3})E(?P<episode>[0-9]{1,5})'),
    ('season_dash', r'\s+S(?P<season>[0-9]{1,3})\s+-\s+(?P<episode>[0-9]{1,5})'),
    ('explicit', r'\s+(?:-\s+)?E(?:P)?(?P<episode>[0-9]{1,5})'),
    ('dash', r'\s+-\s+(?P<episode>[0-9]{1,5})'),
)
RELEASE_TAIL = r'(?:\s*v[0-9]+)?(?P<tail>(?:\s|\[|\().*|)$'
TECH_MARKER = re.compile(r'(?i)\b(?:[0-9]{3,4}[pi]|x26[45]|h\.?26[45]|av1|hevc|web[ .-]?(?:dl|rip)|bluray)\b')
EPISODE_RANGE = re.compile(r'(?i)^\s*(?:[-+–—&~]|to\b)\s*(?:[SE][0-9]|[0-9])')
SPECIAL_MARKER = re.compile(r'(?i)(?:^|[\s\[(])(?:batch|ova|oad|special|ncop|nced|trailer|pv|recap)(?:$|[\s\])])')


@dataclass(frozen=True)
class Release:
    group: str
    stem: str
    season: int | None
    episode: int
    edition: str
    style: str


@dataclass(frozen=True)
class Listing:
    listing_id: int
    title: str
    info_hash: str
    published_at: datetime
    seeders: int | None = None


def normalized(text):
    return ' '.join(unicodedata.normalize('NFC', text).casefold().split())


def parse_title(title):
    if not isinstance(title, str) or len(title) > 600 or '|' in title or any(ord(c) < 32 for c in title):
        return None
    title = title.strip()
    suffix = Path(title).suffix
    if suffix.lower() in VIDEO_SUFFIXES:
        title = title[:-len(suffix)]
    group = re.fullmatch(r'\[(?P<group>[^\[\]]+)\]\s*(?:-\s+)?(?P<body>.+)', title)
    if group is None:
        return None
    body = group['body']
    for style, pattern in EPISODE_PATTERNS:
        match = re.fullmatch(r'(?P<stem>.+?)' + pattern + RELEASE_TAIL, body, re.I)
        if match is None:
            continue
        tail = match['tail'].strip()
        if EPISODE_RANGE.match(tail) or SPECIAL_MARKER.search(tail):
            return None
        # Accept bracketed edition tags and common bare technical suffixes. Episode
        # subtitles and additional numbering styles need an explicit parser rule.
        if tail and tail[0] not in '[(' and TECH_MARKER.match(tail) is None:
            return None
        if re.search(r'(?i)(?:^|[\s\[(])(?:S[0-9]+E[0-9]+|EP?[0-9]+)(?:\b|v[0-9])', tail):
            return None
        edition = re.sub(r'\[[0-9a-fA-F]{8}\]', '', tail)
        edition = re.sub(r'\s+', ' ', edition).strip()
        edition = re.sub(r'\]\s+\[', '][', edition)
        episode = int(match['episode'])
        season_token = match.groupdict().get('season')
        season = int(season_token) if season_token is not None else None
        stem = normalized(match['stem'])
        group_name = normalized(group['group'])
        if episode > 0 and stem and group_name:
            return Release(group_name, stem, season, episode, normalized(edition), style)
    return None


def release_key(release):
    return release.stem, release.season, release.style


def timestamp(value):
    if value is None:
        return None
    when = datetime.fromisoformat(value)
    if when.tzinfo is None:
        raise ValueError('Use an ISO timestamp with a time zone.')
    return when.astimezone(timezone.utc)


def retry_at(expected, now):
    if expected is None:
        return None
    interval = timedelta(hours=2) if now < expected + timedelta(hours=48) else timedelta(days=1)
    return max(expected, now + interval)


def next_action(expected, now, last, manual=False):
    if manual:
        return 'checking', None
    if expected is None:
        return 'airtime_unknown', None
    if now < expected:
        return 'waiting_airtime', expected
    if last is not None and last >= expected:
        due = retry_at(expected, last)
        if now < due:
            return 'waiting_retry', due
    return 'checking', None


class Bencode:
    def __init__(self, data):
        self.data = data
        self.offset = 0
        self.remaining = 5000
        self.info = None

    def read(self, depth=0):
        data, start = self.data, self.offset
        self.remaining -= 1
        if self.remaining < 0 or depth > 32 or start >= len(data):
            raise ValueError('Invalid or oversized bencode structure.')
        token = data[start:start + 1]
        if token in (b'd', b'l'):
            self.offset += 1
            result = {} if token == b'd' else []
            previous = None
            while self.offset < len(data) and data[self.offset:self.offset + 1] != b'e':
                if token == b'l':
                    result.append(self.read(depth + 1))
                    continue
                key = self.read(depth + 1)
                if not isinstance(key, bytes) or (previous is not None and previous >= key):
                    raise ValueError('Invalid or unordered torrent dictionary.')
                previous = key
                value_start = self.offset
                result[key] = self.read(depth + 1)
                if depth == 0 and key == b'info':
                    self.info = data[value_start:self.offset]
            if self.offset >= len(data):
                raise ValueError('Unterminated torrent dictionary or list.')
            self.offset += 1
            return result
        if token == b'i':
            end = data.find(b'e', start + 1, start + 23)
            number = data[start + 1:end] if end != -1 else b''
            if not re.fullmatch(rb'(?:0|-?[1-9][0-9]*)', number):
                raise ValueError('Invalid torrent integer.')
            self.offset = end + 1
            return int(number)
        end = data.find(b':', start, start + 10)
        count = data[start:end] if end != -1 else b''
        if not re.fullmatch(rb'(?:0|[1-9][0-9]*)', count):
            raise ValueError('Invalid torrent string length.')
        self.offset = end + 1 + int(count)
        if self.offset > len(data):
            raise ValueError('Truncated torrent string.')
        return data[end + 1:self.offset]


def verify_metainfo(data, expected_hash, episode):
    if not 0 < len(data) <= MAX_BYTES:
        raise ValueError('Torrent metadata is empty or above the pilot limit.')
    if not re.fullmatch('[a-fA-F0-9]{40}', expected_hash):
        raise ValueError('No supported v1 listing hash.')
    decoder = Bencode(data)
    torrent = decoder.read()
    if decoder.offset != len(data) or not isinstance(torrent, dict) or decoder.info is None:
        raise ValueError('Expected exactly one torrent dictionary.')
    info = torrent.get(b'info')
    if not isinstance(info, dict):
        raise ValueError('Torrent has no info dictionary.')
    if b'meta version' in info or b'file tree' in info or b'files' in info:
        raise ValueError('Pilot supports only single-file BitTorrent v1 metadata.')
    digest = hashlib.sha1(decoder.info, usedforsecurity=False).hexdigest()
    if digest != expected_hash.lower():
        raise ValueError('Listing and torrent disagree on the info hash.')
    raw_name = info.get(b'name')
    if not isinstance(raw_name, bytes) or info.get(b'name.utf-8', raw_name) != raw_name or b'attr' in info:
        raise ValueError('Torrent filename or file attributes are ambiguous.')
    name = raw_name.decode('utf-8')
    if (not name or name != name.strip(' .') or len(raw_name) > 255
            or any(c in '/\\:%<>"?*|' or ord(c) < 32 or ord(c) == 127 for c in name)):
        raise ValueError('Torrent filename needs path handling outside the pilot scope.')
    if Path(name).suffix.lower() not in VIDEO_SUFFIXES:
        raise ValueError('Torrent does not contain a supported video filename.')
    file_release = parse_title(name)
    if (file_release is None or release_key(file_release) != release_key(episode)
            or file_release.episode != episode.episode or file_release.group != episode.group):
        raise ValueError('The original video filename does not independently match the listing.')
    size, piece_size, pieces = (info.get(key) for key in (b'length', b'piece length', b'pieces'))
    if (not isinstance(size, int) or not 0 < size <= 2**53 - 1 or not isinstance(piece_size, int)
            or piece_size <= 0 or not isinstance(pieces, bytes)
            or len(pieces) != 20 * ((size + piece_size - 1) // piece_size)):
        raise ValueError('Torrent size or piece hashes are inconsistent.')
    identity = f'bt:{digest}'
    return {'identity': identity, 'fileIndex': 0, 'path': name, 'size': size,
            'mediaId': 'media:' + hashlib.sha256((identity + '\0' + '0').encode()).hexdigest()}


def evaluate_case(case, now, feed_loader, metadata_loader):
    if not isinstance(case, dict) or not isinstance(case.get('name'), str) or not case['name'].strip():
        raise ValueError('Each case needs a name.')
    expected = timestamp(case.get('expectedAirAt'))
    manual = case.get('manualCheck', False)
    if type(manual) is not bool:
        raise ValueError('manualCheck must be a boolean.')
    status, due = next_action(expected, now, timestamp(case.get('lastCheckedAt')), manual)
    report = {'name': case['name'], 'status': status, 'nextCheckAt': due.isoformat() if due else None,
              'feedRead': False, 'episodes': []}
    for field in ('malId', 'anchorListingId'):
        if field in case:
            report[field] = case[field]
    anchor = parse_title(case.get('anchorTitle'))
    if anchor is None or not anchor.edition:
        report['status'] = 'anchor_review'
        return report
    next_episode = anchor.episode + 1
    finale = case.get('finalEpisode')
    if finale is not None and (type(finale) is not int or finale < anchor.episode):
        raise ValueError('finalEpisode must include the confirmed starting release.')
    report['nextEpisode'] = next_episode
    if finale is not None and next_episode > finale:
        report.update(status='finished', nextCheckAt=None)
        return report
    if status != 'checking':
        return report
    later_airtimes = case.get('episodeAirTimes', {})
    if not isinstance(later_airtimes, dict):
        raise ValueError('episodeAirTimes must map future episode numbers to timestamps.')

    def airtime(episode):
        return expected if episode == next_episode else timestamp(later_airtimes.get(str(episode)))

    report['feedRead'] = True
    try:
        listings = feed_loader(case)
    except (OSError, ValueError) as error:
        report.update(status='provider_error', error=str(error), nextCheckAt=None)
        return report
    visible = [item for item in listings if item.published_at <= now]
    parsed = [(item, release) for item in visible if (release := parse_title(item.title)) is not None]
    same_series = [(item, release) for item, release in parsed if release_key(release) == release_key(anchor)]
    report['feedItems'] = len(visible)
    report['unparsedItems'] = len(visible) - len(parsed)
    handled = set(case.get('handledEpisodes', []))
    sources = case.get('sourceCount', 0)
    if type(sources) is not int or not 0 <= sources <= 128:
        raise ValueError('sourceCount must be between 0 and 128.')
    for episode in range(next_episode, next_episode + MAX_CATCH_UP):
        if finale is not None and episode > finale:
            break
        expected_episode_at = airtime(episode)
        row = {'episode': episode, 'outcome': 'no_match'}
        if expected_episode_at is not None:
            row['expectedAirAt'] = expected_episode_at.isoformat()
        report['episodes'].append(row)
        if episode in handled:
            row['outcome'] = 'already_handled'
            continue
        exact_episode = [(item, release) for item, release in same_series if release.episode == episode]
        preferred = {}
        changed = []
        alternatives = {}
        for item, release in exact_episode:
            if release.group == anchor.group:
                if release.edition == anchor.edition:
                    preferred.setdefault(item.info_hash, (item, release))
                else:
                    changed.append(item)
            else:
                alternatives.setdefault(item.info_hash, item)
        if len(preferred) > 1:
            row.update(outcome='ambiguous_release', candidates=[item.title for item, _ in preferred.values()],
                       candidateListingIds=[item.listing_id for item, _ in preferred.values()])
        elif len(preferred) == 1:
            item, release = next(iter(preferred.values()))
            row.update(listingId=item.listing_id, title=item.title, seeders=item.seeders,
                       publishedAt=item.published_at.isoformat())
            if sources >= 128:
                row['outcome'] = 'source_limit'
                break
            try:
                data = metadata_loader(item)
            except OSError as error:
                row.update(outcome='metadata_unavailable', reason=str(error))
                break
            try:
                if data is None:
                    row['outcome'] = 'metadata_unavailable'
                else:
                    manifest = verify_metainfo(data, item.info_hash, release)
                    row.update(outcome='would_add', manifest=manifest)
                    sources += 1
                    continue
            except ValueError as error:
                row.update(outcome='metadata_rejected', reason=str(error))
        elif expected_episode_at is not None and now < expected_episode_at:
            row['outcome'] = 'waiting_airtime'
        elif changed:
            row.update(outcome='edition_review', candidates=[item.title for item in changed[:3]],
                       candidateListingIds=[item.listing_id for item in changed[:3]])
            if alternatives:
                row['alternateCandidates'] = [item.title for item in list(alternatives.values())[:3]]
        elif alternatives:
            # These are discovery results. A real approval needs verified metadata
            # and a fresh check for the preferred release before committing.
            candidates = list(alternatives.values())[:3]
            row.update(outcome='host_review', candidates=[item.title for item in candidates],
                       candidateListingIds=[item.listing_id for item in candidates])
        else:
            later = sorted({release.episode for _, release in same_series if release.episode > episode
                            and release.group == anchor.group and release.edition == anchor.edition})
            if later:
                row['laterEpisodesHeld'] = later[:MAX_CATCH_UP]
        break
    if report['episodes']:
        last = report['episodes'][-1]
        advanced = last['outcome'] in {'would_add', 'already_handled'}
        report['nextEpisode'] = last['episode'] + int(advanced)
        if finale is not None and report['nextEpisode'] > finale:
            report['status'] = 'would_finish'
        elif not manual and last['outcome'] != 'source_limit':
            next_air = airtime(report['nextEpisode'])
            if next_air is not None:
                due = next_air if next_air > now else (now if advanced else retry_at(next_air, now))
                report['nextCheckAt'] = due.isoformat()
    report['status'] = 'checked' if report['status'] == 'checking' else report['status']
    return report


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def get_public(path):
    request = Request(ORIGIN + path, headers={'User-Agent': 'WatchPair-airing-dry-run/1', 'Accept-Encoding': 'identity'})
    with build_opener(NoRedirect()).open(request, timeout=10) as response:
        if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
            raise OSError('Unexpected compressed response.')
        content = response.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise OSError('Response exceeds the pilot size limit.')
    return content


def parse_rss(payload):
    if len(payload) > MAX_BYTES:
        raise ValueError('RSS exceeds the pilot size limit.')
    text = payload.decode('utf-8-sig')
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)', text, re.I):
        raise ValueError('Unsupported RSS document declaration.')
    try:
        xml = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise ValueError('Expected a valid Nyaa RSS document.') from error
    channel = xml.find('channel') if xml.tag == 'rss' else None
    if channel is None:
        raise ValueError('Expected a Nyaa RSS channel.')
    listings = []
    for node in channel.findall('item')[:150]:
        identifier = re.fullmatch(r'https://nyaa\.si/view/([0-9]{1,12})', node.findtext('guid', ''))
        digest = node.findtext(NS + 'infoHash', '').strip().lower()
        title = node.findtext('title', '').strip()
        if not identifier or not re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', digest) or not title:
            continue
        try:
            when = parsedate_to_datetime(node.findtext('pubDate', ''))
            when = when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when.astimezone(timezone.utc)
        except (TypeError, ValueError, OverflowError):
            continue
        raw_seeders = node.findtext(NS + 'seeders', '').strip()
        seeders = int(raw_seeders) if re.fullmatch('[0-9]{1,9}', raw_seeders) else None
        listings.append(Listing(int(identifier[1]), title, digest, when, seeders))
    if channel.find('item') is not None and not listings:
        raise ValueError('RSS items do not match the expected Nyaa listing format.')
    return listings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cases', type=Path, help='JSON file with an asOf timestamp and cases array')
    parser.add_argument('--live', action='store_true', required=True, help='allow HTTPS requests to nyaa.si only')
    args = parser.parse_args(argv)
    try:
        plan = json.loads(args.cases.read_text(encoding='utf-8-sig'))
        now = timestamp(plan.get('asOf')) or datetime.now(timezone.utc)
        cases = plan['cases']
        if not isinstance(cases, list) or not 1 <= len(cases) <= 16:
            raise ValueError('Provide between 1 and 16 dry-run cases.')
        feed_cache = {}
        metadata_cache = {}
        requests = {'feed': 0, 'metainfo': 0}

        def feed_loader(case):
            query, category = case['query'], case.get('category', '1_2')
            if not isinstance(query, str) or not 1 <= len(query) <= 120 or category not in ('1_0', '1_2', '1_4'):
                raise ValueError('Use a bounded Nyaa anime query and category.')
            key = (query, category)
            if key not in feed_cache:
                params = urlencode({'page': 'rss', 'c': category, 'q': query})
                requests['feed'] += 1
                try:
                    feed_cache[key] = parse_rss(get_public('/?' + params))
                except (OSError, ValueError) as error:
                    feed_cache[key] = error
            if isinstance(feed_cache[key], Exception):
                raise feed_cache[key]
            return feed_cache[key]

        def metadata_loader(item):
            if item.listing_id not in metadata_cache:
                requests['metainfo'] += 1
                try:
                    metadata_cache[item.listing_id] = get_public(f'/download/{item.listing_id}.torrent')
                except OSError as error:
                    metadata_cache[item.listing_id] = error
            if isinstance(metadata_cache[item.listing_id], Exception):
                raise metadata_cache[item.listing_id]
            return metadata_cache[item.listing_id]

        report = {'asOf': now.isoformat(), 'observationalOnly': True,
                  'cases': [evaluate_case(case, now, feed_loader, metadata_loader) for case in cases],
                  'requests': requests}
        print(json.dumps(report, indent=2, ensure_ascii=True))
    except (OSError, KeyError, TypeError, ValueError, URLError) as error:
        print(f'Dry-run configuration or input error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
