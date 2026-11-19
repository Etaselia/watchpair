"""Exercise the read-only airing-series prototype with synthetic provider data."""

from datetime import datetime, timedelta, timezone
import hashlib
import unittest

from airing_series_dry_run import Listing, evaluate_case, next_action, parse_title, retry_at, verify_metainfo


NOW = datetime(2026, 11, 19, 13, tzinfo=timezone.utc)
ANCHOR = "[Cove] Orbit 86 - 07 (1080p)"


def bencode(value):
    if isinstance(value, int):
        return f"i{value}e".encode("ascii")
    if isinstance(value, bytes):
        return str(len(value)).encode("ascii") + b":" + value
    if isinstance(value, dict):
        return b"d" + b"".join(bencode(key) + bencode(value[key]) for key in sorted(value)) + b"e"
    if isinstance(value, list):
        return b"l" + b"".join(map(bencode, value)) + b"e"
    raise TypeError(type(value))


def torrent(filename, payload=b"synthetic media", **changes):
    info = {
        b"length": len(payload),
        b"name": filename.encode("utf-8"),
        b"piece length": 16384,
        b"pieces": hashlib.sha1(payload).digest(),
    }
    info.update({key.encode("ascii"): value for key, value in changes.items()})
    data = bencode({b"announce": b"https://tracker.example.invalid/announce", b"info": info})
    return data, hashlib.sha1(bencode(info)).hexdigest()


class TitleTests(unittest.TestCase):
    def test_title_numerals_survive_and_release_revision_keeps_episode(self):
        release = parse_title("[Cove] Orbit 86 - 08v2 (1080p) [DEADBEEF]")
        self.assertIsNotNone(release)
        self.assertEqual(release.group.casefold(), "cove")
        self.assertEqual(release.stem.casefold(), "orbit 86")
        self.assertEqual(release.episode, 8)
        self.assertIsNone(release.season)
        self.assertEqual(release.edition, parse_title(ANCHOR).edition)
        self.assertEqual(release.style, parse_title(ANCHOR).style)

    def test_explicit_season_is_distinct_from_episode(self):
        release = parse_title("[Cove] Orbit 86 S02E08 (1080p)")
        self.assertIsNotNone(release)
        self.assertEqual((release.season, release.episode), (2, 8))

    def test_episode_ranges_fractions_and_unmarked_title_numbers_are_not_episodes(self):
        for title in (
            "[Cove] Orbit 86 (1080p)",
            "[Cove] Orbit 86 - 08.5 (1080p)",
            "[Cove] Orbit 86 - 08-09 (1080p)",
            "[Cove] Orbit 86 S02E08E09 (1080p)",
        ):
            with self.subTest(title=title):
                self.assertIsNone(parse_title(title))


class SchedulingTests(unittest.TestCase):
    def test_waits_until_airtime_and_does_not_poll_unknown_dates(self):
        future = NOW + timedelta(minutes=1)
        self.assertEqual(next_action(future, NOW, None), ("waiting_airtime", future))
        self.assertEqual(next_action(NOW, NOW, None)[0], "checking")
        self.assertEqual(next_action(None, NOW, None), ("airtime_unknown", None))
        self.assertEqual(next_action(None, NOW, None, manual=True)[0], "checking")
        self.assertIsNone(retry_at(None, NOW))

    def test_retry_is_two_hours_after_last_check_then_daily_after_48_hours(self):
        aired = NOW - timedelta(hours=5)
        last = NOW - timedelta(minutes=5)
        due = last + timedelta(hours=2)
        self.assertEqual(next_action(aired, NOW, last), ("waiting_retry", due))
        self.assertEqual(next_action(aired, due, last)[0], "checking")
        self.assertEqual(retry_at(aired, NOW), NOW + timedelta(hours=2))
        self.assertEqual(retry_at(NOW - timedelta(hours=48), NOW), NOW + timedelta(days=1))


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.title = "[Cove] Orbit 86 - 08 (1080p)"
        self.release = parse_title(self.title)
        self.filename = self.title + ".mkv"

    def test_single_file_passes_raw_info_hash_and_title_validation(self):
        data, expected = torrent(self.filename)
        identity = f"bt:{expected}"
        media_id = hashlib.sha256(identity.encode("ascii") + b"\0" + b"0").hexdigest()
        self.assertEqual(verify_metainfo(data, expected, self.release), {
            "identity": identity,
            "fileIndex": 0,
            "path": self.filename,
            "size": len(b"synthetic media"),
            "mediaId": f"media:{media_id}",
        })
        self.assertNotEqual(expected, hashlib.sha1(data).hexdigest())

    def test_metadata_with_wrong_identity_or_filename_is_rejected(self):
        data, expected = torrent(self.filename)
        with self.assertRaises(ValueError):
            verify_metainfo(data, "0" * 40, self.release)
        with self.assertRaises(ValueError):
            verify_metainfo(data + b"garbage", expected, self.release)
        for filename in (
            self.filename.replace(" - 08 ", " - 09 "),
            self.filename.replace("[Cove]", "[Pine]"),
            "../" + self.filename,
            "subdir\\" + self.filename,
            self.title + ".txt",
        ):
            with self.subTest(filename=filename):
                data, expected = torrent(filename)
                with self.assertRaises(ValueError):
                    verify_metainfo(data, expected, self.release)

    def test_multifile_and_hybrid_metadata_need_native_parity(self):
        multifile = {"files": [{b"length": 15, b"path": [self.filename.encode("utf-8")]}]}
        for changes in (multifile, {"meta version": 2}):
            with self.subTest(changes=changes):
                data, expected = torrent(self.filename, **changes)
                with self.assertRaises(ValueError):
                    verify_metainfo(data, expected, self.release)

    def test_info_hash_match_does_not_excuse_invalid_piece_layout_or_attributes(self):
        for changes in ({"pieces": b""}, {"piece length": 0}, {"attr": b"l"}):
            with self.subTest(changes=changes):
                data, expected = torrent(self.filename, **changes)
                with self.assertRaises(ValueError):
                    verify_metainfo(data, expected, self.release)


class CaseTests(unittest.TestCase):
    def setUp(self):
        self.case = {
            "name": "Synthetic season",
            "anchorTitle": ANCHOR,
            "expectedAirAt": (NOW - timedelta(days=35)).isoformat(),
        }
        self.listings = []
        self.metainfo = {}
        self.feed_calls = 0
        self.metadata_calls = []

    def add_listing(self, listing_id, episode, *, group="Cove", quality="1080p", payload=b"test media"):
        title = f"[{group}] Orbit 86 - {episode:02d} ({quality})"
        data, info_hash = torrent(title + ".mkv", payload=payload)
        self.metainfo[listing_id] = data
        self.listings.append(Listing(listing_id, title, info_hash, NOW - timedelta(days=2)))

    def evaluate(self, **changes):
        def feed(case):
            self.feed_calls += 1
            return self.listings

        def metadata(listing):
            self.metadata_calls.append(listing.listing_id)
            return self.metainfo.get(listing.listing_id)

        return evaluate_case(dict(self.case, **changes), NOW, feed, metadata)

    @staticmethod
    def outcomes(result):
        return [(row["episode"], row["outcome"]) for row in result["episodes"]]

    def test_before_airtime_makes_no_provider_calls(self):
        result = self.evaluate(expectedAirAt=(NOW + timedelta(minutes=1)).isoformat())
        self.assertEqual(result["status"], "waiting_airtime")
        self.assertEqual(self.feed_calls, 0)
        self.assertEqual(self.metadata_calls, [])

    def test_confirmed_finale_stops_catchup_even_if_a_later_listing_matches(self):
        self.add_listing(108, 8)
        self.add_listing(109, 9)
        result = self.evaluate(finalEpisode=8)
        self.assertEqual(self.outcomes(result), [(8, "would_add")])
        self.assertEqual(result["status"], "would_finish")
        self.assertEqual(self.metadata_calls, [108])

    def test_catchup_processes_only_consecutive_episodes_in_order(self):
        self.add_listing(109, 9)
        self.add_listing(108, 8)
        self.add_listing(111, 11)
        result = self.evaluate()
        self.assertEqual(self.outcomes(result)[:2], [(8, "would_add"), (9, "would_add")])
        self.assertEqual(self.metadata_calls, [108, 109])
        self.assertNotIn((11, "would_add"), self.outcomes(result))

    def test_after_catchup_a_future_episode_waits_even_with_an_alternate_in_the_feed(self):
        self.add_listing(108, 8)
        self.add_listing(109, 9, group="Pine")
        next_air = (NOW + timedelta(days=1)).isoformat()
        result = self.evaluate(episodeAirTimes={"9": next_air})
        self.assertEqual(self.outcomes(result), [(8, "would_add"), (9, "waiting_airtime")])
        self.assertEqual(result["nextCheckAt"], next_air)
        self.assertEqual(self.feed_calls, 1)
        self.assertEqual(self.metadata_calls, [108])

    def test_later_release_does_not_cross_gap_and_old_gap_stays_on_same_episode(self):
        self.add_listing(109, 9)
        for expected in (NOW - timedelta(hours=3), NOW - timedelta(days=10)):
            with self.subTest(expected=expected):
                result = self.evaluate(expectedAirAt=expected.isoformat())
                self.assertEqual(self.outcomes(result), [(8, "no_match")])
        self.assertEqual(self.metadata_calls, [])

    def test_handled_episode_is_not_revived_when_it_appears_in_feed(self):
        self.add_listing(108, 8)
        self.add_listing(109, 9)
        result = self.evaluate(handledEpisodes=[8])
        self.assertEqual(self.outcomes(result)[:2], [(8, "already_handled"), (9, "would_add")])
        self.assertEqual(self.metadata_calls, [109])

    def test_same_hash_duplicates_collapse_but_different_releases_need_review(self):
        self.add_listing(108, 8)
        self.add_listing(208, 8)
        self.assertEqual(self.outcomes(self.evaluate())[0], (8, "would_add"))
        self.assertEqual(len(self.metadata_calls), 1)
        self.add_listing(308, 8, payload=b"different release")
        self.assertEqual(self.outcomes(self.evaluate())[0], (8, "ambiguous_release"))

    def test_alternate_group_and_changed_edition_do_not_automatically_advance(self):
        self.add_listing(109, 9)
        self.add_listing(108, 8, group="Pine")
        self.assertEqual(self.outcomes(self.evaluate()), [(8, "host_review")])
        self.listings.pop()
        self.add_listing(208, 8, quality="720p")
        self.assertEqual(self.outcomes(self.evaluate()), [(8, "edition_review")])
        self.add_listing(308, 8)
        self.assertEqual(self.outcomes(self.evaluate())[:2], [(8, "would_add"), (9, "would_add")])

    def test_wrong_metadata_and_source_limit_prevent_would_add(self):
        self.add_listing(108, 8)
        data = self.metainfo.pop(108)
        self.assertEqual(self.outcomes(self.evaluate()), [(8, "metadata_unavailable")])
        self.metainfo[108] = b"invalid metainfo"
        self.assertEqual(self.outcomes(self.evaluate()), [(8, "metadata_rejected")])
        self.metainfo[108] = data
        self.assertEqual(self.outcomes(self.evaluate(sourceCount=128)), [(8, "source_limit")])


if __name__ == "__main__":
    unittest.main()
