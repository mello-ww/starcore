"""Music catalog: metadata parsing, incremental scans, identity, grouping, search, migrations."""

from importlib import import_module
from pathlib import Path
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest

from tests import music_fixtures as media

COVER = b"\x89PNG\r\n\x1a\n" + b"cover" * 8


def module(name):
    return import_module(f"satellites.native.music.{name}")


def tearDownModule():
    engine = getattr(MusicCase, "_engine", None)
    if engine is not None:
        from tests.support import stop_engine
        stop_engine(engine)


class MusicCase(unittest.TestCase):
    def setUp(self):
        from tests.support import start_engine  # registers the satellites package
        if not hasattr(MusicCase, "_engine"):
            MusicCase._engine = start_engine()
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-music-catalog-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.library = module("library").MusicLibrary(self.directory / "library", str(self.source))

    def tearDown(self):
        self.library.close()
        shutil.rmtree(self.directory, ignore_errors=True)

    def write(self, name: str, data: bytes) -> Path:
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def only(self):
        tracks = self.library.tracks()
        self.assertEqual(len(tracks), 1)
        return tracks[0]


class MetadataTest(MusicCase):
    def test_flac_credits_replaygain_and_identifiers_are_read(self):
        self.write("a.flac", media.flac({
            "TITLE": "Aurora", "ALBUM": "Orbit", "TRACKNUMBER": "4/12", "DISCNUMBER": "1/2", "DATE": "2013-05-02",
            "GENRE": "Ambient", "COMPOSER": "Ada", "LABEL": "Quiet Records", "COPYRIGHT": "(c) 2013", "ISRC": "USX9P1300001",
            "REPLAYGAIN_TRACK_GAIN": "-6.5 dB", "REPLAYGAIN_TRACK_PEAK": "0.98", "REPLAYGAIN_ALBUM_GAIN": "-7.1 dB",
            "MUSICBRAINZ_ALBUMID": "1b2c", "MUSICBRAINZ_TRACKID": "9f8e"}, artists=("Nightfall", "Daybreak")))
        self.library.scan()
        track = self.library.catalog.track(self.only()["id"])

        self.assertEqual([artist["name"] for artist in track["artists"]], ["Nightfall", "Daybreak"])
        self.assertEqual((track["track"], track["track_total"], track["disc"], track["disc_total"]), (4, 12, 1, 2))
        self.assertEqual(track["date"], "2013-05-02")
        self.assertEqual(track["year"], 2013)
        self.assertEqual(track["credits"]["composer"], "Ada")
        self.assertEqual(track["credits"]["label"], "Quiet Records")
        self.assertEqual(track["credits"]["isrc"], "USX9P1300001")
        self.assertEqual(track["replaygain"]["track_gain"], -6.5)
        self.assertEqual(track["replaygain"]["album_gain"], -7.1)
        self.assertEqual(track["musicbrainz"]["album"], "1b2c")
        self.assertEqual((track["codec"], track["sample_rate"], track["bit_depth"], track["channels"]),
                         ("flac", 44100, 16, 2))
        self.assertTrue(track["quality"]["lossless"])
        self.assertFalse(track["quality"]["hires"])

    def test_hi_res_is_only_claimed_for_hi_res_streams(self):
        self.write("hires.flac", media.flac({"TITLE": "Wide"}, sample_rate=96000, bits=24))
        self.write("lossy.mp3", media.mp3({b"TIT2": "Narrow"}))
        self.library.scan()
        by_title = {track["title"]: self.library.catalog.track(track["id"]) for track in self.library.tracks()}

        self.assertTrue(by_title["Wide"]["quality"]["hires"])
        self.assertIn("24-bit/96 kHz", by_title["Wide"]["quality"]["label"])
        self.assertFalse(by_title["Narrow"]["quality"]["lossless"])
        self.assertEqual(by_title["Narrow"]["quality"]["label"], "MP3 128 kbps")

    def test_id3_user_frames_lyrics_and_composer_are_read(self):
        self.write("tagged.mp3", media.mp3({b"TIT2": "Lyric", b"TPE1": "Singer", b"TCOM": "Writer"},
                                           user={"REPLAYGAIN_TRACK_GAIN": "-3.20 dB", "MusicBrainz Album Id": "abc"},
                                           lyrics="first line\nsecond line"))
        info = module("audio").probe(self.source / "tagged.mp3")

        self.assertEqual(info["composer"], "Writer")
        self.assertEqual(info["rg_track_gain"], -3.2)
        self.assertEqual(info["mb_album_id"], "abc")
        self.assertEqual(info["lyrics"], "first line\nsecond line")
        self.assertEqual((info["codec"], info["sample_rate"], info["channels"], info["bitrate"]), ("mp3", 44100, 2, 128000))

    def test_ogg_opus_and_vorbis_are_indexed(self):
        self.write("song.opus", media.opus({"TITLE": "Wave", "ARTIST": "Tide", "ALBUM": "Sea"}, seconds=30, cover=COVER))
        self.write("song.ogg", media.vorbis({"TITLE": "Wind"}, seconds=20))
        self.library.scan()
        by_title = {track["title"]: self.library.catalog.track(track["id"]) for track in self.library.tracks()}

        self.assertEqual(by_title["Wave"]["format"], "opus")
        self.assertEqual(by_title["Wave"]["codec"], "opus")
        self.assertEqual(by_title["Wave"]["duration"], 30.0)
        self.assertTrue(by_title["Wave"]["has_artwork"])
        self.assertEqual(by_title["Wind"]["codec"], "vorbis")
        self.assertEqual(by_title["Wind"]["duration"], 20.0)
        self.assertEqual(by_title["Wind"]["bitrate"], 160000)

        album = self.library.catalog.albums_by_id([by_title["Wave"]["album_id"]])[0]
        self.assertEqual(self.library.artwork_path(album).read_bytes(), COVER)

    def test_m4a_alac_technical_details(self):
        self.write("apple.m4a", media.m4a())
        self.library.scan()
        track = self.library.catalog.track(self.only()["id"])

        self.assertEqual((track["title"], track["artist"], track["track"], track["track_total"]), ("Apple", "Orchard", 3, 9))
        self.assertEqual((track["codec"], track["bit_depth"], track["sample_rate"]), ("alac", 24, 48000))
        self.assertTrue(track["quality"]["hires"])

    def test_featured_artists_and_compilations_group_sensibly(self):
        self.write("a.flac", media.flac({"TITLE": "Song (feat. Guest)", "ARTIST": "Lead", "ALBUM": "Duets"}))
        self.write("b.flac", media.flac({"TITLE": "Other", "ARTIST": "Lead feat. Friend", "ALBUM": "Duets"}, seconds=100))
        self.write("c.flac", media.flac({"TITLE": "Hit", "ARTIST": "Someone", "ALBUM": "Now 1", "COMPILATION": "1"},
                                        seconds=90))
        self.library.scan()
        catalog = self.library.catalog

        albums = {album["album"]: album for album in catalog.albums()}
        self.assertEqual(albums["Duets"]["artist"], "Lead")
        self.assertEqual(albums["Duets"]["tracks"], 2)
        self.assertEqual(albums["Now 1"]["artist"], "Various Artists")
        self.assertEqual(albums["Now 1"]["type"], "compilation")
        guest = module("grouping").artist_id("Guest")
        self.assertEqual(len(catalog.tracks(artist_id=guest)["tracks"]), 1)
        lead = catalog.artist(module("grouping").artist_id("Lead"))
        self.assertEqual(lead["name"], "Lead")
        self.assertTrue(lead["albums"] or lead["singles"])

    def test_the_decodable_demo_library_indexes_completely(self):
        written = media.write_demo_library(self.source, cover=COVER)
        result = self.library.scan()

        self.assertEqual((result["added"], result["failed"]), (len(written), []))
        albums = {album["album"]: album for album in self.library.catalog.albums()}
        self.assertEqual(set(albums), {"Northern Lights", "Polar Night", "Carrier Waves"})
        self.assertEqual(albums["Northern Lights"]["tracks"], 4)
        track = self.library.catalog.tracks(album_id=albums["Northern Lights"]["id"])["tracks"][0]
        self.assertAlmostEqual(track["duration"], 8.0, delta=0.1)
        self.assertTrue(track["has_lyrics"])

    def test_untagged_files_can_take_names_from_their_folders(self):
        self.library.options = {"missing_metadata": "folders"}
        self.write("Band/Record/03 - Opening.wav", media.wav())
        self.library.scan()
        track = self.only()

        self.assertEqual((track["artist"], track["album"], track["title"], track["track"]),
                         ("Band", "Record", "Opening", 3))


class ScanningTest(MusicCase):
    def test_retagging_a_file_keeps_its_identity_and_playlists(self):
        path = self.write("song.flac", media.flac({"TITLE": "Before"}))
        self.library.scan()
        identity = self.only()["id"]
        playlist = self.library.playlists.create("local", "Keep", track_ids=[identity])

        path.write_bytes(media.flac({"TITLE": "After"}, seconds=181))
        os.utime(path, (1, 1))
        result = self.library.scan()

        self.assertEqual(result["updated"], 1)
        self.assertEqual(self.only()["id"], identity)
        self.assertEqual(self.only()["title"], "After")
        self.assertEqual(self.library.playlists.get("local", playlist["id"])["tracks"][0]["id"], identity)

    def test_a_missing_file_is_kept_and_comes_back_with_its_identity(self):
        path = self.write("song.flac", media.flac({"TITLE": "Away"}))
        self.library.scan()
        identity = self.only()["id"]
        self.library.collection.set_favorite("local", "track", [identity], True)
        playlist = self.library.playlists.create("local", "Keep", track_ids=[identity])
        aside = self.directory / "aside.flac"
        path.rename(aside)

        result = self.library.scan()
        self.assertEqual(result["removed"], 1)
        self.assertEqual(self.library.count, 0)
        entry = self.library.playlists.get("local", playlist["id"])["tracks"][0]
        self.assertTrue(entry["missing"])

        aside.rename(path)
        result = self.library.scan()
        self.assertEqual(result["restored"], 1)
        self.assertEqual(self.only()["id"], identity)
        self.assertEqual(self.library.collection.favorite_ids("local")["track"], [identity])
        self.assertFalse(self.library.playlists.get("local", playlist["id"])["tracks"][0]["missing"])

    def test_scanning_never_modifies_a_source_file(self):
        path = self.write("song.flac", media.flac({"TITLE": "Untouched"}, cover=COVER))
        before = (path.read_bytes(), path.stat().st_mtime)
        self.library.scan()
        album = self.library.albums()[0]
        self.library.artwork_path(album)

        self.assertEqual((path.read_bytes(), path.stat().st_mtime), before)

    def test_duplicates_are_recorded_not_indexed_twice(self):
        self.write("a/song.flac", media.flac({"TITLE": "Twin"}))
        self.write("b/song.flac", media.flac({"TITLE": "Twin"}))
        result = self.library.scan()

        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(len(self.library.catalog.duplicates()["identical"]), 1)

    def test_likely_duplicates_across_releases_are_grouped_best_first(self):
        self.write("x.mp3", media.mp3({b"TIT2": "Same", b"TPE1": "Band", b"TALB": "Single"}))
        self.write("y.flac", media.flac({"TITLE": "Same", "ARTIST": "Band", "ALBUM": "Album"}, seconds=1))
        self.library.scan()
        likely = self.library.catalog.duplicates()["likely"]

        self.assertEqual(len(likely), 1)
        best = next(track for track in likely[0]["tracks"] if track["id"] == likely[0]["best"])
        self.assertEqual(best["format"], "flac")

    def test_exclusions_and_minimum_duration(self):
        self.library.options = {"exclude": ["Podcasts/*"], "min_duration": 5}
        self.write("Podcasts/episode.flac", media.flac({"TITLE": "Talk"}))
        self.write("clip.wav", media.wav(seconds=1))
        self.write("keep.flac", media.flac({"TITLE": "Keep"}))
        result = self.library.scan()

        self.assertEqual(result["skipped"], 1)
        self.assertEqual([track["title"] for track in self.library.tracks()], ["Keep"])

    def test_every_configured_source_is_scanned(self):
        second = self.directory / "second"
        second.mkdir()
        (second / "two.flac").write_bytes(media.flac({"TITLE": "Two"}))
        self.write("one.flac", media.flac({"TITLE": "One"}, seconds=10))
        self.library.sources = [str(second)]
        result = self.library.scan()

        self.assertEqual(result["added"], 2)
        self.assertEqual(len(result["source"]), 2)

    def test_folders_are_browsable_from_the_index(self):
        self.write("Band/Record/one.flac", media.flac({"TITLE": "One"}))
        self.library.scan()
        roots = [str(path) for path in self.library.source_paths()]
        top = self.library.catalog.folder(0, "", roots)
        inner = self.library.catalog.folder(0, "Band/Record", roots)

        self.assertEqual([folder["name"] for folder in top["folders"]], ["Band"])
        self.assertEqual([track["title"] for track in inner["tracks"]], ["One"])
        self.assertIsNone(self.library.catalog.folder(0, "Nowhere", roots))
        self.assertIsNone(self.library.catalog.folder(5, "", roots))

    def test_payloads_never_carry_an_absolute_path(self):
        self.write("one.flac", media.flac())
        self.library.scan()
        payload = json.dumps([self.library.catalog.tracks()["tracks"], self.library.catalog.albums(),
                              self.library.catalog.album(self.library.albums()[0]["id"])])

        self.assertNotIn(str(self.source), payload)
        self.assertNotIn('"path"', payload)

    def test_a_background_scan_reports_progress_and_finishes(self):
        for index in range(30):
            self.write(f"{index:02d}.flac", media.flac({"TITLE": f"T{index}"}, seconds=10 + index))
        self.library.scan_in_background()
        for _ in range(200):
            if not self.library.scan_status()["running"]:
                break
            import time
            time.sleep(0.05)

        status = self.library.scan_status()
        self.assertFalse(status["running"])
        self.assertEqual(status["last"]["added"], 30)


class StorageTest(MusicCase):
    def test_migrations_run_once_and_record_the_schema(self):
        db = module("db")
        self.assertEqual(self.library.db.version, len(db.MIGRATIONS))
        self.library.close()
        reopened = module("library").MusicLibrary(self.directory / "library", str(self.source))
        self.assertEqual(reopened.db.version, len(db.MIGRATIONS))
        reopened.close()

    def test_a_drifted_search_index_is_rebuilt_on_open(self):
        self.write("one.flac", media.flac({"TITLE": "Findable"}))
        self.library.scan()
        self.library.db.execute("DELETE FROM track_search")
        self.library.close()

        self.library = module("library").MusicLibrary(self.directory / "library", str(self.source))

        self.assertEqual(self.library.finder.search("local", "findab")["tracks"][0]["title"], "Findable")

    def test_the_json_index_is_imported_with_its_identifiers_and_kept(self):
        self.library.close()
        root = self.directory / "legacy"
        root.mkdir()
        song = self.write("old.flac", media.flac({"TITLE": "Old"}))
        legacy = {"version": 1, "last_scan": "2025-01-01T00:00:00+00:00", "tracks": {"0123456789abcdef": {
            "id": "0123456789abcdef", "path": str(song), "filename": "old.flac", "format": "flac", "size": 1,
            "mtime": 1, "title": "Old", "artist": "Elder", "album": "Past", "album_artist": None, "track": 1,
            "disc": None, "year": 1999, "genre": "Folk", "duration": 180.0, "has_artwork": False}}}
        (root / "library.json").write_text(json.dumps(legacy), encoding="utf-8")

        with contextlib.redirect_stdout(io.StringIO()):
            self.library = module("library").MusicLibrary(root, str(self.source))

        self.assertEqual(self.library.track("0123456789abcdef")["title"], "Old")
        self.assertEqual(self.library.last_scan, "2025-01-01T00:00:00+00:00")
        self.assertTrue((root / "library.json").is_file())
        self.library.scan()
        self.assertEqual(self.only()["id"], "0123456789abcdef")


class SearchTest(MusicCase):
    def setUp(self):
        super().setUp()
        self.write("a.flac", media.flac({"TITLE": "Midnight City", "ARTIST": "Lumen", "ALBUM": "Hurry",
                                         "GENRE": "Synthpop"}))
        self.write("b.mp3", media.mp3({b"TIT2": "Morning Light", b"TPE1": "Lumen", b"TALB": "Hurry"}))
        self.write("c.flac", media.flac({"TITLE": "Ocean", "ARTIST": "Tidal", "ALBUM": "Deep", "GENRE": "Ambient"},
                                        seconds=200))
        self.library.scan()

    def test_prefix_search_finds_tracks_albums_and_artists(self):
        result = self.library.finder.search("local", "midn")

        self.assertEqual(result["tracks"][0]["title"], "Midnight City")
        self.assertEqual(self.library.finder.search("local", "lum")["artists"][0]["name"], "Lumen")
        self.assertEqual(self.library.finder.search("local", "hurry")["albums"][0]["album"], "Hurry")
        self.assertEqual(self.library.finder.search("local", "lumen")["top"]["kind"], "artist")

    def test_typos_are_corrected_against_real_names(self):
        result = self.library.finder.search("local", "Tidall")

        self.assertEqual(result["corrected"], "Tidal")
        self.assertEqual(result["tracks"][0]["title"], "Ocean")

    def test_filters_and_empty_queries(self):
        self.assertEqual([t["title"] for t in self.library.finder.search("local", "lumen", quality="lossless")["tracks"]],
                         ["Midnight City"])
        self.assertEqual(self.library.finder.search("local", "o", genre="Ambient")["tracks"][0]["title"], "Ocean")
        self.assertEqual(self.library.finder.search("local", "   ")["tracks"], [])
        self.assertEqual(self.library.finder.search("local", '"); DROP TABLE tracks; --')["tracks"], [])
        self.assertEqual(self.library.count, 3)

    def test_suggestions(self):
        texts = [entry["text"] for entry in self.library.finder.suggest("local", "Lu")]
        self.assertIn("Lumen", texts)

    def test_sorting(self):
        catalog = self.library.catalog
        self.assertEqual(catalog.tracks(sort="duration", order="desc")["tracks"][0]["title"], "Ocean")
        self.assertEqual(catalog.tracks(sort="title")["tracks"][0]["title"], "Midnight City")
        self.assertEqual(catalog.tracks(sort="quality", order="desc")["tracks"][-1]["format"], "mp3")
        self.assertEqual(catalog.tracks(limit=1, offset=1)["total"], 3)


if __name__ == "__main__":
    unittest.main()
