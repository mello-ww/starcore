from http.client import HTTPConnection
from pathlib import Path
import contextlib
import io
import json
import shutil
import struct
import tempfile
import unittest
import wave
import zlib

from tests.support import start_engine, stop_engine

COVER = b"\x89PNG\r\n\x1a\n" + b"cover-bytes" * 4


def flac(title="Title", artist="Artist", album="Album", seconds=180, cover=None) -> bytes:
    """A FLAC header carrying exactly what the library reads."""
    sample_rate = 44100
    samples = sample_rate * seconds
    stream = (struct.pack(">HH", 4096, 4096) + b"\x00\x00\x10\x00\x00\x10"
              + struct.pack(">Q", (sample_rate << 44) | (1 << 41) | (15 << 36) | samples) + b"\x00" * 16)

    comments = [f"TITLE={title}", f"ARTIST={artist}", f"ALBUM={album}", "ALBUMARTIST=Album Artist",
                "TRACKNUMBER=4/12", "DISCNUMBER=2", "DATE=2013-05-02", "GENRE=Ambient"]
    vorbis = struct.pack("<I", 6) + b"StarCo" + struct.pack("<I", len(comments))
    for comment in comments:
        encoded = comment.encode("utf-8")
        vorbis += struct.pack("<I", len(encoded)) + encoded

    blocks = _block(0, stream, last=False) + _block(4, vorbis, last=cover is None)
    if cover is not None:
        picture = (struct.pack(">I", 3) + struct.pack(">I", 9) + b"image/png" + struct.pack(">I", 0)
                   + struct.pack(">IIII", 10, 10, 8, 0) + struct.pack(">I", len(cover)) + cover)
        blocks += _block(6, picture, last=True)

    return b"fLaC" + blocks


def _block(kind: int, payload: bytes, last: bool) -> bytes:
    return bytes([kind | (0x80 if last else 0)]) + len(payload).to_bytes(3, "big") + payload


def wav(seconds=2, frames=None) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(frames if frames is not None else b"\x00\x00" * 8000 * seconds)
    return buffer.getvalue()


def mp3(title="MP3 Title", artist="MP3 Artist") -> bytes:
    frames = b""
    for identifier, text in ((b"TIT2", title), (b"TPE1", artist), (b"TALB", "MP3 Album"), (b"TRCK", "7")):
        payload = b"\x03" + text.encode("utf-8") + b"\x00"
        frames += identifier + struct.pack(">I", len(payload)) + b"\x00\x00" + payload

    size = len(frames)
    syncsafe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
    tag = b"ID3\x03\x00\x00" + syncsafe + frames

    # a 128 kbps 44.1 kHz stereo layer III frame, repeated so the size implies a duration
    header = b"\xff\xfb\x90\x00"
    return tag + (header + b"\x00" * 413) * 40


def png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    rows = b"".join(b"\x00" + b"\x40\x60\xa0" * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def music_library(root: Path, source=""):
    from importlib import import_module
    return import_module("satellites.native.music.library").MusicLibrary(root, source)


class MusicLibraryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-music-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.library = music_library(self.directory / "library", str(self.source))

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def write(self, name: str, data: bytes) -> Path:
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_a_new_library_is_empty(self):
        self.assertEqual(self.library.count, 0)
        self.assertEqual(self.library.tracks(), [])
        self.assertEqual(self.library.summary()["tracks"], 0)
        self.assertIsNone(self.library.summary()["last_scan"])

    def test_scanning_indexes_audio_files(self):
        self.write("one.flac", flac())
        self.write("two.wav", wav())

        result = self.library.scan()

        self.assertEqual(result["found"], 2)
        self.assertEqual(result["added"], 2)
        self.assertEqual(self.library.count, 2)
        self.assertTrue(self.library.summary()["last_scan"])

    def test_files_are_indexed_where_they_are(self):
        original = self.write("keep/here.flac", flac())
        self.library.scan()

        track = self.library.tracks()[0]

        self.assertEqual(track["path"], str(original))
        self.assertTrue(original.is_file())
        self.assertEqual(list(self.library.root.glob("*.flac")), [])

    def test_tags_are_read(self):
        self.write("tagged.flac", flac(title="Aurora", artist="Nightfall", album="Orbit"))
        self.library.scan()

        track = self.library.tracks()[0]

        self.assertEqual(track["title"], "Aurora")
        self.assertEqual(track["artist"], "Nightfall")
        self.assertEqual(track["album"], "Orbit")
        self.assertEqual(track["album_artist"], "Album Artist")
        self.assertEqual((track["track"], track["disc"], track["year"]), (4, 2, 2013))
        self.assertEqual(track["genre"], "Ambient")
        self.assertEqual(track["duration"], 180.0)
        self.assertEqual(track["format"], "flac")

    def test_every_supported_format_is_indexed(self):
        self.write("song.flac", flac())
        self.write("song.wav", wav())
        self.write("song.mp3", mp3())

        self.library.scan()

        self.assertEqual({track["format"] for track in self.library.tracks()}, {"flac", "wav", "mp3"})
        for track in self.library.tracks():
            self.assertIsNotNone(track["duration"], track["format"])

    def test_a_track_without_tags_falls_back_to_its_filename(self):
        self.write("Quiet Piece.wav", wav())
        self.library.scan()

        track = self.library.tracks()[0]

        self.assertEqual(track["title"], "Quiet Piece")
        self.assertIsNone(track["artist"])

    def test_unreadable_files_are_reported_without_stopping_the_scan(self):
        self.write("broken.flac", b"fLaC nonsense")
        self.write("good.flac", flac())

        result = self.library.scan()

        self.assertEqual(result["found"], 2)
        self.assertEqual(result["added"], 1)
        self.assertEqual([failure["file"] for failure in result["failed"]], ["broken.flac"])

    def test_unsupported_files_are_ignored(self):
        self.write("cover.png", png(4, 3))
        self.write("notes.txt", b"hello")

        result = self.library.scan()

        self.assertEqual(result["found"], 0)
        self.assertEqual(self.library.count, 0)

    def test_rescanning_leaves_unchanged_files_alone(self):
        self.write("one.flac", flac())
        self.library.scan()

        result = self.library.scan()

        self.assertEqual(result["unchanged"], 1)
        self.assertEqual(result["added"], 0)
        self.assertEqual(self.library.count, 1)

    def test_the_same_content_in_two_places_is_indexed_once(self):
        self.write("a/song.flac", flac())
        self.write("b/song.flac", flac())

        result = self.library.scan()

        self.assertEqual(result["found"], 2)
        self.assertEqual(result["added"], 1)
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(self.library.count, 1)

    def test_a_moved_file_keeps_its_identity(self):
        original = self.write("before.flac", flac())
        self.library.scan()
        identity = self.library.tracks()[0]["id"]

        moved = self.source / "after.flac"
        original.rename(moved)
        self.library.scan()

        self.assertEqual(self.library.count, 1)
        self.assertEqual(self.library.tracks()[0]["id"], identity)
        self.assertEqual(self.library.tracks()[0]["path"], str(moved))

    def test_deleted_files_leave_the_index(self):
        path = self.write("gone.flac", flac())
        self.library.scan()
        path.unlink()

        result = self.library.scan()

        self.assertEqual(result["removed"], 1)
        self.assertEqual(self.library.count, 0)

    def test_an_edited_file_is_reindexed(self):
        path = self.write("changing.flac", flac(title="First"))
        self.library.scan()

        path.write_bytes(flac(title="Second", seconds=200))
        import os
        os.utime(path, (0, 0))
        result = self.library.scan()

        self.assertEqual(self.library.count, 1)
        self.assertEqual(self.library.tracks()[0]["title"], "Second")
        self.assertEqual(result["found"], 1)

    def test_albums_and_artists_are_grouped(self):
        self.write("a.flac", flac(title="One", album="Orbit"))
        self.write("b.flac", flac(title="Two", album="Orbit", seconds=120))
        self.write("c.flac", flac(title="Three", album="Transit", seconds=90))
        self.library.scan()

        albums = self.library.albums()
        artists = self.library.artists()

        self.assertEqual({album["album"] for album in albums}, {"Orbit", "Transit"})
        self.assertEqual(sum(album["tracks"] for album in albums), 3)
        self.assertEqual([artist["name"] for artist in artists], ["Album Artist"])
        self.assertEqual(artists[0]["albums"], 2)

    def test_an_album_can_be_looked_up_with_its_tracks(self):
        self.write("a.flac", flac(title="One", album="Orbit"))
        self.write("b.flac", flac(title="Two", album="Orbit", seconds=120))
        self.library.scan()
        album = self.library.albums()[0]

        detail = self.library.album(album["id"])

        self.assertEqual(len(detail["tracks"]), 2)
        self.assertIsNone(self.library.album("does-not-exist"))

    def test_artwork_is_extracted_and_cached(self):
        self.write("with-cover.flac", flac(cover=COVER))
        self.library.scan()
        album = self.library.albums()[0]

        first = self.library.artwork_path(album)
        second = self.library.artwork_path(album)

        self.assertEqual(first.read_bytes(), COVER)
        self.assertEqual(first, second)

    def test_an_album_without_artwork_reports_none(self):
        self.write("plain.flac", flac())
        self.library.scan()

        self.assertIsNone(self.library.artwork_path(self.library.albums()[0]))

    def test_the_index_survives_a_restart(self):
        self.write("one.flac", flac())
        self.library.scan()

        reopened = music_library(self.library.root, str(self.source))

        self.assertEqual(reopened.count, 1)
        self.assertEqual(reopened.tracks()[0]["title"], "Title")

    def test_a_damaged_index_does_not_break_the_library(self):
        self.write("one.flac", flac())
        self.library.scan()
        self.library.index_path.write_text("{ not json", encoding="utf-8")

        with contextlib.redirect_stdout(io.StringIO()):
            reopened = music_library(self.library.root, str(self.source))

        self.assertEqual(reopened.count, 0)

    def test_a_missing_source_is_reported_clearly(self):
        from satellites.native.music.library import MusicScanError

        with self.assertRaises(MusicScanError) as failure:
            self.library.scan(self.directory / "nowhere")

        self.assertIn("does not exist", str(failure.exception))

    def test_the_storage_directory_is_never_scanned_into_itself(self):
        self.write("one.flac", flac())
        self.library.scan()
        library_inside = music_library(self.source / "data", str(self.source))
        (self.source / "data").mkdir(exist_ok=True)
        (self.source / "data" / "copy.flac").write_bytes(flac(title="Copy", seconds=99))

        result = library_inside.scan()

        self.assertEqual(result["found"], 1)


class MusicSatelliteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")

        cls.satellite = cls.engine.registry.get("Music")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-music-api-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")
        self.satellite.config.data["library"] = str(self.source)

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def request(self, path, method="GET", payload=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request_headers = {"Content-Type": "application/json"} if body is not None else {}
        request_headers.update(headers or {})

        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def json_request(self, path, method="GET", payload=None):
        status, headers, body = self.request(path, method, payload)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        return status, json.loads(body.decode("utf-8"))

    def fill(self):
        (self.source / "one.flac").write_bytes(flac(title="One", cover=COVER))
        (self.source / "two.flac").write_bytes(flac(title="Two", seconds=120))
        status, payload = self.json_request("/api/satellites/music/scan", "POST", {})
        self.assertEqual(status, 200)
        return payload

    def test_the_satellite_is_discovered(self):
        self.assertIsNotNone(self.satellite)
        self.assertEqual(self.satellite.type, "native")
        self.assertEqual(self.satellite.page, {"module": "page.js", "stylesheet": "page.css"})

    def test_page_assets_are_served(self):
        for asset, expected in (("page.js", "javascript"), ("page.css", "text/css")):
            status, headers, body = self.request(f"/api/satellites/music/assets/{asset}")
            self.assertEqual(status, 200)
            self.assertIn(expected, headers.get("Content-Type", ""))
            self.assertTrue(body)

    def test_the_state_stays_cheap_and_useful(self):
        state = self.satellite.state(self.engine)

        self.assertEqual(state["tracks"], 0)
        self.assertEqual(state["last_scan"], "never")
        self.assertIn("library_size", state)

    def test_library_endpoint_describes_an_empty_library(self):
        status, payload = self.json_request("/api/satellites/music/library")

        self.assertEqual(status, 200)
        self.assertEqual(payload["tracks"], 0)
        self.assertIn("flac", payload["formats"])

    def test_scan_indexes_through_the_api(self):
        report = self.fill()

        self.assertEqual(report["added"], 2)
        self.assertEqual(self.json_request("/api/satellites/music/library")[1]["tracks"], 2)

    def test_scan_rejects_an_unusable_source(self):
        status, payload = self.json_request(
            "/api/satellites/music/scan", "POST", {"source": str(self.directory / "nowhere")})

        self.assertEqual(status, 400)
        self.assertIn("does not exist", payload["error"])

    def test_tracks_albums_and_artists_are_listed(self):
        self.fill()

        self.assertEqual(len(self.json_request("/api/satellites/music/tracks")[1]["tracks"]), 2)
        self.assertEqual(len(self.json_request("/api/satellites/music/albums")[1]["albums"]), 1)
        self.assertEqual(len(self.json_request("/api/satellites/music/artists")[1]["artists"]), 1)

    def test_a_single_track_can_be_looked_up(self):
        self.fill()
        track = self.json_request("/api/satellites/music/tracks")[1]["tracks"][0]

        status, payload = self.json_request(f"/api/satellites/music/tracks/{track['id']}")

        self.assertEqual(status, 200)
        self.assertEqual(payload["id"], track["id"])

    def test_unknown_identifiers_return_404(self):
        for path in ("tracks/deadbeefdeadbeef", "albums/deadbeefdeadbeef",
                     "artwork/deadbeefdeadbeef", "stream/deadbeefdeadbeef"):
            status, payload = self.json_request(f"/api/satellites/music/{path}")
            self.assertEqual(status, 404, path)
            self.assertIn("error", payload)

    def test_files_cannot_be_reached_by_path(self):
        self.fill()
        for identifier in ("../../../config.toml", "..%2f..%2fapi.py", "tracks"):
            status, payload = self.json_request(f"/api/satellites/music/stream/{identifier}")
            self.assertEqual(status, 404)
            self.assertIn("error", payload)

    def test_artwork_is_served(self):
        self.fill()
        album = self.json_request("/api/satellites/music/albums")[1]["albums"][0]

        status, headers, body = self.request(f"/api/satellites/music/artwork/{album['id']}")

        self.assertEqual(status, 200)
        self.assertTrue(headers.get("Content-Type", "").startswith("image/"))
        self.assertEqual(body, COVER)

    def test_a_track_is_streamed(self):
        self.fill()
        track = self.json_request("/api/satellites/music/tracks")[1]["tracks"][0]

        status, headers, body = self.request(f"/api/satellites/music/stream/{track['id']}")

        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "audio/flac")
        self.assertEqual(headers.get("Accept-Ranges"), "bytes")
        self.assertEqual(len(body), track["size"])

    def test_a_range_of_a_track_can_be_requested(self):
        self.fill()
        track = self.json_request("/api/satellites/music/tracks")[1]["tracks"][0]

        status, headers, body = self.request(
            f"/api/satellites/music/stream/{track['id']}", headers={"Range": "bytes=0-9"})

        self.assertEqual(status, 206)
        self.assertEqual(len(body), 10)
        self.assertEqual(headers.get("Content-Range"), f"bytes 0-9/{track['size']}")

    def test_an_impossible_range_falls_back_to_the_whole_file(self):
        self.fill()
        track = self.json_request("/api/satellites/music/tracks")[1]["tracks"][0]

        status, _, body = self.request(
            f"/api/satellites/music/stream/{track['id']}", headers={"Range": "bytes=999999999-"})

        self.assertEqual(status, 200)
        self.assertEqual(len(body), track["size"])

    def test_read_only_routes_reject_writes(self):
        status, payload = self.json_request("/api/satellites/music/tracks", "POST", {})

        self.assertEqual(status, 405)
        self.assertIn("error", payload)

    def test_unknown_music_routes_return_404(self):
        status, payload = self.json_request("/api/satellites/music/nothing-here")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)


class MusicCommandTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()
        cls.satellite = cls.engine.registry.get("Music")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-music-cli-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")
        self.satellite.config.data["library"] = str(self.source)

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def run_command(self, command: str) -> str:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.engine.execute_command(command)
        return output.getvalue()

    def test_music_is_registered_by_the_satellite(self):
        entry = self.engine.command_registry.get("music")

        self.assertIsNotNone(entry)
        self.assertEqual(entry["source"], "Music")

    def test_music_shows_a_summary(self):
        output = self.run_command("music")

        self.assertIn("StarCore music library", output)
        self.assertIn("Tracks       0", output)

    def test_music_scan_indexes_the_configured_directory(self):
        (self.source / "one.flac").write_bytes(flac(title="Scanned"))

        scanned = self.run_command("music scan")
        listing = self.run_command("music list")

        self.assertIn("Added        1", scanned)
        self.assertIn("Scanned", listing)

    def test_music_albums_lists_albums(self):
        (self.source / "one.flac").write_bytes(flac(album="Orbit"))
        self.run_command("music scan")

        self.assertIn("Orbit", self.run_command("music albums"))

    def test_music_list_reports_an_empty_library(self):
        self.assertIn("empty", self.run_command("music list"))

    def test_music_scan_reports_a_bad_path(self):
        output = self.run_command(f"music scan {self.directory / 'nowhere'}")

        self.assertIn("[ERROR]", output)
        self.assertIn("does not exist", output)

    def test_music_rejects_an_unknown_action(self):
        self.assertIn("Usage", self.run_command("music explode"))


if __name__ == "__main__":
    unittest.main()
