from http.client import HTTPConnection
from pathlib import Path
import contextlib
import io
import json
import shutil
import struct
import tempfile
import unittest
import zlib

from tests.support import start_engine, stop_engine

SATELLITE = Path(__file__).resolve().parents[2] / "satellites" / "native" / "photo"


def png(width: int, height: int, colour: bytes = b"\x40\x60\xa0") -> bytes:
    """A real, decodable PNG, so tests do not depend on fixture files."""
    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    rows = b"".join(b"\x00" + colour * width for _ in range(height))

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def jpeg(width: int, height: int, taken: str = None) -> bytes:
    """The header of a JPEG, which is all the library reads to size an image."""
    frame = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + (exif(taken) if taken else b"") + frame + b"\xff\xd9"


def exif(taken: str) -> bytes:
    """An APP1 segment holding nothing but DateTimeOriginal."""
    text = taken.encode("ascii") + b"\x00"
    tiff = b"II" + struct.pack("<HI", 42, 8)
    tiff += struct.pack("<H", 1) + struct.pack("<HHII", 0x8769, 4, 1, 26) + struct.pack("<I", 0)
    tiff += struct.pack("<H", 1) + struct.pack("<HHII", 0x9003, 2, len(text), 44) + struct.pack("<I", 0)
    tiff += text

    payload = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


def photo_library(root: Path):
    from importlib import import_module
    return import_module("satellites.native.photo.library").PhotoLibrary(root)


class PhotoLibraryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()  # loads the satellite package so it can be imported

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.library = photo_library(self.directory / "library")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def write(self, name: str, data: bytes) -> Path:
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_a_new_library_is_empty(self):
        self.assertEqual(self.library.count, 0)
        self.assertEqual(self.library.all(), [])
        self.assertEqual(self.library.summary()["photos"], 0)

    def test_import_copies_photos_and_keeps_the_originals(self):
        original = self.write("holiday.png", png(4, 3))

        result = self.library.import_directory(self.source)

        self.assertEqual(result["found"], 1)
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["duplicates"], 0)
        self.assertEqual(result["failed"], [])
        self.assertTrue(original.is_file())
        self.assertEqual(self.library.count, 1)

    def test_imported_photos_carry_metadata(self):
        self.write("holiday.png", png(6, 4))
        self.library.import_directory(self.source)

        photo = self.library.all()[0]

        self.assertEqual(photo["filename"], "holiday.png")
        self.assertEqual(photo["format"], "png")
        self.assertEqual((photo["width"], photo["height"]), (6, 4))
        self.assertGreater(photo["size"], 0)
        self.assertTrue(photo["imported_at"])
        self.assertEqual(len(photo["id"]), 16)
        self.assertTrue(self.library.original_path(photo).is_file())

    def test_stored_photos_are_named_after_their_content(self):
        self.write("holiday.png", png(4, 3))
        self.library.import_directory(self.source)

        photo = self.library.all()[0]

        self.assertEqual(Path(photo["path"]).name, f"{photo['id']}.png")
        self.assertNotIn("holiday", photo["path"])

    def test_importing_the_same_directory_twice_changes_nothing(self):
        self.write("holiday.png", png(4, 3))
        self.library.import_directory(self.source)

        result = self.library.import_directory(self.source)

        self.assertEqual(result["imported"], 0)
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(self.library.count, 1)

    def test_identical_photos_with_different_names_are_stored_once(self):
        self.write("a.png", png(4, 3))
        self.write("nested/b.png", png(4, 3))

        result = self.library.import_directory(self.source)

        self.assertEqual(result["found"], 2)
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["duplicates"], 1)

    def test_photos_sharing_a_filename_do_not_collide(self):
        self.write("one/photo.png", png(4, 3))
        self.write("two/photo.png", png(8, 6))

        result = self.library.import_directory(self.source)
        stored = {photo["path"] for photo in self.library.all()}

        self.assertEqual(result["imported"], 2)
        self.assertEqual(len(stored), 2)
        self.assertEqual({photo["filename"] for photo in self.library.all()}, {"photo.png"})

    def test_unreadable_files_are_reported_without_stopping_the_import(self):
        self.write("broken.png", b"not really a png")
        self.write("good.png", png(4, 3))

        result = self.library.import_directory(self.source)

        self.assertEqual(result["found"], 2)
        self.assertEqual(result["imported"], 1)
        self.assertEqual([failure["file"] for failure in result["failed"]], ["broken.png"])

    def test_unsupported_files_are_ignored(self):
        self.write("notes.txt", b"hello")
        self.write("clip.mp4", b"\x00\x00\x00\x18ftyp")

        result = self.library.import_directory(self.source)

        self.assertEqual(result["found"], 0)
        self.assertEqual(self.library.count, 0)

    def test_jpeg_headers_are_understood(self):
        self.write("shot.jpg", jpeg(1920, 1080))
        self.library.import_directory(self.source)

        photo = self.library.all()[0]

        self.assertEqual(photo["format"], "jpeg")
        self.assertEqual((photo["width"], photo["height"]), (1920, 1080))

    def test_the_exif_capture_date_is_read_when_present(self):
        self.write("with-exif.jpg", jpeg(800, 600, taken="2024:05:17 09:14:03"))
        self.write("without-exif.jpg", jpeg(640, 480))

        self.library.import_directory(self.source)
        dates = {photo["filename"]: photo["captured_at"] for photo in self.library.all()}

        self.assertEqual(dates["with-exif.jpg"], "2024-05-17T09:14:03")
        self.assertIsNone(dates["without-exif.jpg"])

    def test_photos_are_listed_newest_first(self):
        self.write("older.jpg", jpeg(100, 100, taken="2019:01:02 03:04:05"))
        self.write("newer.jpg", jpeg(200, 200, taken="2024:01:02 03:04:05"))

        self.library.import_directory(self.source)

        self.assertEqual([photo["filename"] for photo in self.library.all()], ["newer.jpg", "older.jpg"])

    def test_scan_reports_without_importing(self):
        self.write("holiday.png", png(4, 3))

        report = self.library.scan(self.source)

        self.assertEqual(report["found"], 1)
        self.assertEqual(report["new"], 1)
        self.assertEqual(self.library.count, 0)

    def test_the_library_refuses_to_import_itself(self):
        from satellites.native.photo.library import PhotoImportError

        self.library.import_directory(self.source)
        with self.assertRaises(PhotoImportError):
            self.library.import_directory(self.library.root)

    def test_a_missing_source_is_reported_clearly(self):
        from satellites.native.photo.library import PhotoImportError

        with self.assertRaises(PhotoImportError) as failure:
            self.library.import_directory(self.directory / "nowhere")

        self.assertIn("does not exist", str(failure.exception))

    def test_the_index_survives_a_restart(self):
        self.write("holiday.png", png(4, 3))
        self.library.import_directory(self.source)

        reopened = photo_library(self.library.root)

        self.assertEqual(reopened.count, 1)
        self.assertEqual(reopened.all()[0]["filename"], "holiday.png")

    def test_a_damaged_index_does_not_break_the_library(self):
        self.write("holiday.png", png(4, 3))
        self.library.import_directory(self.source)
        self.library.index_path.write_text("{ not json", encoding="utf-8")

        with contextlib.redirect_stdout(io.StringIO()):
            reopened = photo_library(self.library.root)

        self.assertEqual(reopened.count, 0)

    def test_thumbnails_are_cached_and_never_touch_the_original(self):
        self.write("holiday.png", png(64, 48))
        self.library.import_directory(self.source)
        photo = self.library.all()[0]

        first = self.library.thumbnail_path(photo)
        second = self.library.thumbnail_path(photo)

        self.assertTrue(first.is_file())
        self.assertEqual(first, second)
        self.assertTrue(self.library.original_path(photo).is_file())

    def test_thumbnails_fall_back_to_the_original_without_an_image_library(self):
        from satellites.native.photo import images

        self.write("holiday.png", png(64, 48))
        self.library.import_directory(self.source)
        photo = self.library.all()[0]

        available = images._pillow
        images._pillow = False  # simulates a machine where Pillow is not installed
        try:
            path = self.library.thumbnail_path(photo)
        finally:
            images._pillow = available

        self.assertEqual(path, self.library.original_path(photo))

    def test_add_file_is_reusable_on_its_own(self):
        source = self.write("holiday.png", png(4, 3))

        photo = self.library.add_file(source, filename="from-elsewhere.png")

        self.assertEqual(photo["filename"], "from-elsewhere.png")
        self.assertIsNone(self.library.add_file(source))
        self.assertEqual(photo_library(self.library.root).count, 1)


class PhotoSatelliteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")

        cls.satellite = cls.engine.registry.get("Photo")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        # the satellite is pointed at a temporary library, so the real one is never touched
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-api-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def request(self, path, method="GET", payload=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}

        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.headers.get("Content-Type", ""), response.read()
        finally:
            connection.close()

    def json_request(self, path, method="GET", payload=None):
        status, content_type, body = self.request(path, method, payload)
        self.assertIn("application/json", content_type)
        return status, json.loads(body.decode("utf-8"))

    def fill(self, count=2):
        for index in range(count):
            (self.source / f"photo-{index}.png").write_bytes(png(8 + index, 6))

        status, payload = self.json_request("/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)
        return payload

    def test_the_satellite_is_discovered(self):
        self.assertIsNotNone(self.satellite)
        self.assertEqual(self.satellite.type, "native")
        self.assertTrue(self.satellite.manifest.description)

    def test_the_satellite_publishes_a_page(self):
        status, payload = self.json_request("/api/satellites/photo")

        self.assertEqual(status, 200)
        self.assertEqual(payload["page"], {"module": "page.js", "stylesheet": "page.css"})

    def test_page_assets_are_served(self):
        for asset, expected in (("page.js", "javascript"), ("page.css", "text/css")):
            status, content_type, body = self.request(f"/api/satellites/photo/assets/{asset}")
            self.assertEqual(status, 200)
            self.assertIn(expected, content_type)
            self.assertTrue(body)

    def test_assets_cannot_escape_the_satellite(self):
        for path in ("/api/satellites/photo/assets/../../config.toml", "/api/satellites/photo/assets/..%2fapi.py"):
            status, _, body = self.request(path)
            self.assertIn(status, (403, 404))
            self.assertNotIn(b"routes", body)

    def test_the_state_reports_the_library(self):
        state = self.satellite.state(self.engine)

        self.assertEqual(state["photos"], 0)
        self.assertIn("storage", state)

    def test_library_endpoint_describes_an_empty_library(self):
        status, payload = self.json_request("/api/satellites/photo/library")

        self.assertEqual(status, 200)
        self.assertEqual(payload["photos"], 0)
        self.assertEqual(payload["size_bytes"], 0)
        self.assertIn("jpeg", payload["formats"])

    def test_photos_endpoint_lists_imported_photos(self):
        self.fill(2)

        status, payload = self.json_request("/api/satellites/photo/photos")

        self.assertEqual(status, 200)
        self.assertEqual(len(payload["photos"]), 2)

    def test_a_single_photo_can_be_looked_up(self):
        self.fill(1)
        photo = self.json_request("/api/satellites/photo/photos")[1]["photos"][0]

        status, payload = self.json_request(f"/api/satellites/photo/photos/{photo['id']}")

        self.assertEqual(status, 200)
        self.assertEqual(payload["id"], photo["id"])

    def test_an_unknown_photo_returns_404(self):
        for path in ("photos/deadbeefdeadbeef", "originals/deadbeefdeadbeef", "thumbnails/deadbeefdeadbeef"):
            status, payload = self.json_request(f"/api/satellites/photo/{path}")
            self.assertEqual(status, 404)
            self.assertIn("error", payload)

    def test_originals_and_thumbnails_are_served_as_images(self):
        self.fill(1)
        photo = self.json_request("/api/satellites/photo/photos")[1]["photos"][0]

        for route in ("originals", "thumbnails"):
            status, content_type, body = self.request(f"/api/satellites/photo/{route}/{photo['id']}")
            self.assertEqual(status, 200)
            self.assertTrue(content_type.startswith("image/"))
            self.assertTrue(body)

    def test_photo_files_cannot_be_reached_by_path(self):
        for identifier in ("../../../config.toml", "..%2f..%2fapi.py", "photos"):
            status, payload = self.json_request(f"/api/satellites/photo/originals/{identifier}")
            self.assertEqual(status, 404)
            self.assertIn("error", payload)

    def test_import_reports_what_it_did(self):
        report = self.fill(2)

        self.assertEqual(report["found"], 2)
        self.assertEqual(report["imported"], 2)
        self.assertEqual(len(report["photos"]), 2)

    def test_import_rejects_an_unusable_source(self):
        status, payload = self.json_request(
            "/api/satellites/photo/import", "POST", {"source": str(self.directory / "nowhere")})

        self.assertEqual(status, 400)
        self.assertIn("does not exist", payload["error"])

    def test_import_requires_a_source(self):
        status, payload = self.json_request("/api/satellites/photo/import", "POST", {})

        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_scan_does_not_import(self):
        (self.source / "photo.png").write_bytes(png(4, 3))

        status, payload = self.json_request(
            "/api/satellites/photo/scan", "POST", {"source": str(self.source)})

        self.assertEqual(status, 200)
        self.assertEqual(payload["new"], 1)
        self.assertEqual(self.json_request("/api/satellites/photo/library")[1]["photos"], 0)

    def test_read_only_routes_reject_writes(self):
        status, payload = self.json_request("/api/satellites/photo/photos", "POST", {})

        self.assertEqual(status, 405)
        self.assertIn("error", payload)

    def test_unknown_satellite_routes_return_404(self):
        status, payload = self.json_request("/api/satellites/photo/nothing-here")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_a_satellite_without_routes_is_unaffected(self):
        status, payload = self.json_request("/api/satellites/status/anything")

        self.assertEqual(status, 404)
        self.assertIsNone(self.engine.registry.get("Status").page)


class PhotoCommandTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()
        cls.satellite = cls.engine.registry.get("Photo")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-cli-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def run_command(self, command: str) -> str:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.engine.execute_command(command)
        return output.getvalue()

    def test_photo_is_registered_by_the_satellite(self):
        entry = self.engine.command_registry.get("photo")

        self.assertIsNotNone(entry)
        self.assertEqual(entry["source"], "Photo")

    def test_photo_shows_a_summary(self):
        output = self.run_command("photo")

        self.assertIn("StarCore photo library", output)
        self.assertIn("Photos       0", output)

    def test_photo_list_reports_an_empty_library(self):
        self.assertIn("empty", self.run_command("photo list"))

    def test_photo_import_fills_the_library(self):
        (self.source / "holiday.png").write_bytes(png(4, 3))

        imported = self.run_command(f"photo import {self.source}")
        listing = self.run_command("photo list")

        self.assertIn("Imported     1", imported)
        self.assertIn("holiday.png", listing)

    def test_photo_import_reports_a_bad_path(self):
        output = self.run_command(f"photo import {self.directory / 'nowhere'}")

        self.assertIn("[ERROR]", output)
        self.assertIn("does not exist", output)

    def test_photo_rejects_an_unknown_action(self):
        self.assertIn("Usage", self.run_command("photo explode"))


if __name__ == "__main__":
    unittest.main()
