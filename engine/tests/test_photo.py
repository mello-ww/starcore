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


def images_module():
    from importlib import import_module
    return import_module("satellites.native.photo.images")


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


# tag numbers used by the richer EXIF fixtures below - mirrors images.py's own
EXIF_MAKE, EXIF_MODEL, EXIF_ORIENTATION = 0x010F, 0x0110, 0x0112
EXIF_EXPOSURE_TIME, EXIF_FNUMBER, EXIF_ISO = 0x829A, 0x829D, 0x8827
EXIF_DATE_TIME_ORIGINAL, EXIF_FOCAL_LENGTH, EXIF_LENS_MODEL = 0x9003, 0x920A, 0xA434
EXIF_SUB_IFD = 0x8769
EXIF_GPS_IFD = 0x8825
GPS_LATITUDE_REF, GPS_LATITUDE, GPS_LONGITUDE_REF, GPS_LONGITUDE = 0x0001, 0x0002, 0x0003, 0x0004

ASCII, SHORT, LONG, RATIONAL = 2, 3, 4, 5
_SIZES = {ASCII: 1, SHORT: 2, LONG: 4, RATIONAL: 8}


def text_field(value: str) -> tuple:
    payload = value.encode("ascii") + b"\x00"
    return (ASCII, len(payload), payload)


def short_field(value: int) -> tuple:
    return (SHORT, 1, struct.pack("<H", value))


def rational_field(*pairs) -> tuple:
    """pairs are (numerator, denominator) tuples; one field can hold several,
    as GPSLatitude/GPSLongitude (degrees, minutes, seconds) always do."""
    payload = b"".join(struct.pack("<II", numerator, denominator) for numerator, denominator in pairs)
    return (RATIONAL, len(pairs), payload)


def _ifd_bytes(entries: dict, base_offset: int) -> bytes:
    """entries: {tag: (kind, count, payload)}. Builds one IFD - its entry table
    plus, for any value that doesn't fit inline, a trailing data area - exactly
    the shape a real EXIF writer produces and images.py's parser expects."""
    header_size = 2 + 12 * len(entries) + 4
    data = bytearray()
    packed = bytearray()

    for tag, (kind, count, payload) in entries.items():
        size = _SIZES[kind] * count
        if size <= 4:
            value_field = payload + b"\x00" * (4 - size)
        else:
            value_field = struct.pack("<I", base_offset + header_size + len(data))
            data += payload
        packed += struct.pack("<HHI", tag, kind, count) + value_field

    return struct.pack("<H", len(entries)) + bytes(packed) + struct.pack("<I", 0) + bytes(data)


def build_exif(root: dict = None, detail: dict = None, gps: dict = None) -> bytes:
    """A full little-endian TIFF/EXIF blob: IFD0, optionally an Exif sub-IFD and
    a GPS sub-IFD, linked the same way a camera links them. `root`, `detail` and
    `gps` are {tag: (kind, count, payload)} - build with text_field/short_field/
    rational_field, or by hand for a deliberately malformed entry."""
    root = dict(root or {})

    # the two IFD0 entries are the same 12 bytes whichever offset they end up
    # pointing at, so IFD0's own length - and therefore where the sub-IFDs
    # start - is known before those offsets are computed
    if detail:
        root[EXIF_SUB_IFD] = (LONG, 1, b"\x00\x00\x00\x00")
    if gps:
        root[EXIF_GPS_IFD] = (LONG, 1, b"\x00\x00\x00\x00")

    root_ifd = _ifd_bytes(root, 8)
    detail_offset = 8 + len(root_ifd)
    detail_ifd = _ifd_bytes(detail, detail_offset) if detail else b""
    gps_offset = detail_offset + len(detail_ifd)
    gps_ifd = _ifd_bytes(gps, gps_offset) if gps else b""

    if detail:
        root[EXIF_SUB_IFD] = (LONG, 1, struct.pack("<I", detail_offset))
    if gps:
        root[EXIF_GPS_IFD] = (LONG, 1, struct.pack("<I", gps_offset))
    root_ifd = _ifd_bytes(root, 8)  # rebuilt now that the pointer values are known

    return b"II" + struct.pack("<HI", 42, 8) + root_ifd + detail_ifd + gps_ifd


def jpeg_with_exif(width: int, height: int, tiff: bytes) -> bytes:
    """A JPEG whose APP1 segment carries an arbitrary pre-built TIFF/EXIF blob."""
    payload = b"Exif\x00\x00" + tiff
    app1 = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    frame = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + app1 + frame + b"\xff\xd9"


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


class PhotoMetadataTest(unittest.TestCase):
    """EXIF extraction: camera/lens/GPS details, and what happens without them."""

    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()  # loads the satellite package so it can be imported

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-meta-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.library = photo_library(self.directory / "library")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def write(self, name: str, data: bytes) -> Path:
        path = self.source / name
        path.write_bytes(data)
        return path

    def import_one(self, filename: str, data: bytes) -> dict:
        self.write(filename, data)
        self.library.import_directory(self.source)
        return self.library.all()[0]

    def test_full_exif_metadata_is_extracted(self):
        root = {EXIF_MAKE: text_field("Canon"), EXIF_MODEL: text_field("EOS R5"), EXIF_ORIENTATION: short_field(6)}
        detail = {
            EXIF_DATE_TIME_ORIGINAL: text_field("2024:05:17 09:14:03"),
            EXIF_EXPOSURE_TIME: rational_field((1, 125)),
            EXIF_FNUMBER: rational_field((28, 10)),
            EXIF_ISO: short_field(400),
            EXIF_FOCAL_LENGTH: rational_field((50, 1)),
            EXIF_LENS_MODEL: text_field("RF24-70mm F2.8L IS USM"),
        }
        tiff = build_exif(root, detail)
        photo = self.import_one("full.jpg", jpeg_with_exif(1920, 1280, tiff))
        metadata = photo["metadata"]

        self.assertEqual(metadata["camera_make"], "Canon")
        self.assertEqual(metadata["camera_model"], "EOS R5")
        self.assertEqual(metadata["lens_model"], "RF24-70mm F2.8L IS USM")
        self.assertEqual(metadata["focal_length"], 50.0)
        self.assertEqual(metadata["aperture"], 2.8)
        self.assertEqual(metadata["shutter_speed"], "1/125")
        self.assertEqual(metadata["iso"], 400)
        self.assertEqual(metadata["orientation"], 6)
        self.assertEqual(metadata["megapixels"], 2.5)
        self.assertEqual(photo["captured_at"], "2024-05-17T09:14:03")

    def test_gps_metadata_is_extracted_and_made_human_readable(self):
        gps = {
            GPS_LATITUDE_REF: text_field("N"),
            GPS_LATITUDE: rational_field((37, 1), (46, 1), (29, 1)),
            GPS_LONGITUDE_REF: text_field("W"),
            GPS_LONGITUDE: rational_field((122, 1), (25, 1), (9, 1)),
        }
        tiff = build_exif(gps=gps)
        photo = self.import_one("located.jpg", jpeg_with_exif(800, 600, tiff))
        metadata = photo["metadata"]

        self.assertAlmostEqual(metadata["gps_latitude"], 37.774722, places=5)
        self.assertAlmostEqual(metadata["gps_longitude"], -122.419167, places=5)
        self.assertIn("N", metadata["gps_coordinates"])
        self.assertIn("W", metadata["gps_coordinates"])

    def test_southern_and_eastern_hemispheres_are_negated_correctly(self):
        gps = {
            GPS_LATITUDE_REF: text_field("S"),
            GPS_LATITUDE: rational_field((33, 1), (52, 1), (4, 1)),
            GPS_LONGITUDE_REF: text_field("E"),
            GPS_LONGITUDE: rational_field((151, 1), (12, 1), (36, 1)),
        }
        tiff = build_exif(gps=gps)
        photo = self.import_one("sydney.jpg", jpeg_with_exif(800, 600, tiff))
        metadata = photo["metadata"]

        self.assertLess(metadata["gps_latitude"], 0)
        self.assertGreater(metadata["gps_longitude"], 0)
        self.assertIn("S", metadata["gps_coordinates"])
        self.assertIn("E", metadata["gps_coordinates"])

    def test_camera_and_lens_metadata_without_gps(self):
        root = {EXIF_MAKE: text_field("FUJIFILM"), EXIF_MODEL: text_field("X100V")}
        detail = {EXIF_LENS_MODEL: text_field("23mm F2")}
        tiff = build_exif(root, detail)
        photo = self.import_one("street.jpg", jpeg_with_exif(640, 480, tiff))
        metadata = photo["metadata"]

        self.assertEqual(metadata["camera_make"], "FUJIFILM")
        self.assertEqual(metadata["lens_model"], "23mm F2")
        self.assertIsNone(metadata["gps_latitude"])
        self.assertIsNone(metadata["gps_coordinates"])

    def test_missing_exif_leaves_metadata_fields_null_without_failing(self):
        photo = self.import_one("plain.jpg", jpeg(320, 240))
        metadata = photo["metadata"]

        # captured_at lives at the top level of the photo record, not inside
        # "metadata" - everything else EXIF-derived does live there
        for field in images_module().METADATA_FIELDS:
            if field != "captured_at":
                self.assertIsNone(metadata[field])
        self.assertIsNone(photo["captured_at"])
        self.assertEqual(metadata["megapixels"], 0.1)
        self.assertIsNotNone(photo["id"])

    def test_a_normal_photo_with_no_exif_support_is_unaffected(self):
        photo = self.import_one("holiday.png", png(1000, 1000))

        self.assertEqual(photo["metadata"]["megapixels"], 1.0)
        self.assertIsNone(photo["metadata"]["camera_make"])
        self.assertIsNone(photo["captured_at"])

    def test_a_truncated_exif_segment_does_not_fail_the_import(self):
        payload = b"Exif\x00\x00" + b"II" + struct.pack("<HI", 42, 8) + b"\x05\x00" + b"\xff" * 10
        app1 = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
        frame = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8,240, 320, 1) + b"\x01\x11\x00"
        data = b"\xff\xd8" + app1 + frame + b"\xff\xd9"

        photo = self.import_one("broken-exif.jpg", data)

        self.assertIsNone(photo["metadata"]["camera_make"])
        self.assertEqual(photo["width"], 320)

    def test_an_exif_offset_pointing_outside_the_segment_is_ignored(self):
        # a sub-IFD pointer that points past the end of the blob - a malformed
        # or deliberately hostile file, not just an absent field
        root = {EXIF_SUB_IFD: (LONG, 1, struct.pack("<I", 999_999))}
        tiff = build_exif(root)
        photo = self.import_one("bad-offset.jpg", jpeg_with_exif(320, 240, tiff))

        self.assertIsNone(photo["metadata"]["iso"])
        self.assertEqual(photo["width"], 320)

    def test_a_zero_denominator_rational_does_not_fail_the_import(self):
        # some cameras write 0/0 for an unmeasured aperture or focal length
        detail = {EXIF_FNUMBER: rational_field((0, 0))}
        tiff = build_exif(detail=detail)
        photo = self.import_one("zero-rational.jpg", jpeg_with_exif(320, 240, tiff))

        self.assertIsNone(photo["metadata"]["aperture"])

    def test_an_invalid_gps_reference_is_ignored(self):
        gps = {
            GPS_LATITUDE_REF: text_field("X"),  # not N/S/E/W
            GPS_LATITUDE: rational_field((37, 1), (0, 1), (0, 1)),
        }
        tiff = build_exif(gps=gps)
        photo = self.import_one("bad-gps-ref.jpg", jpeg_with_exif(320, 240, tiff))

        # GPSLongitude is entirely absent, so a decimal coordinate cannot be
        # formed even though GPSLatitude itself decoded fine
        self.assertIsNone(photo["metadata"]["gps_latitude"])

    def test_metadata_survives_a_library_reload(self):
        root = {EXIF_MAKE: text_field("Canon")}
        gps = {
            GPS_LATITUDE_REF: text_field("N"), GPS_LATITUDE: rational_field((10, 1), (0, 1), (0, 1)),
            GPS_LONGITUDE_REF: text_field("E"), GPS_LONGITUDE: rational_field((20, 1), (0, 1), (0, 1)),
        }
        tiff = build_exif(root, gps=gps)
        self.import_one("reload.jpg", jpeg_with_exif(400, 300, tiff))

        reopened = photo_library(self.library.root)
        photo = reopened.all()[0]

        self.assertEqual(photo["metadata"]["camera_make"], "Canon")
        self.assertAlmostEqual(photo["metadata"]["gps_latitude"], 10.0)
        self.assertAlmostEqual(photo["metadata"]["gps_longitude"], 20.0)

    def test_a_pre_metadata_library_record_loads_with_metadata_backfilled(self):
        self.library.root.mkdir(parents=True, exist_ok=True)
        old_record = {
            "id": "0" * 16, "filename": "old.jpg", "path": "photos/00/old.jpg", "size": 123,
            "width": 100, "height": 50, "format": "jpeg",
            "imported_at": "2020-01-01T00:00:00", "captured_at": None,
            # no "metadata" key at all - exactly what library.json looked like
            # before this milestone
        }
        (self.library.root / "library.json").write_text(
            json.dumps({"version": 1, "photos": {old_record["id"]: old_record}}), encoding="utf-8")

        reopened = photo_library(self.library.root)
        photo = reopened.get(old_record["id"])

        self.assertIsNotNone(photo)
        self.assertIn("metadata", photo)
        self.assertEqual(photo["metadata"]["megapixels"], 0.0)
        self.assertIsNone(photo["metadata"]["camera_make"])
        # the file on disk is untouched by merely reading it - no silent migration
        on_disk = json.loads((self.library.root / "library.json").read_text(encoding="utf-8"))
        self.assertNotIn("metadata", on_disk["photos"][old_record["id"]])


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
        # a previous test in this class may have configured a default -
        # every test here starts from "not configured" unless it says otherwise
        self.satellite.config.data["photo_directory"] = ""

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

    def test_import_falls_back_to_the_configured_photo_directory(self):
        (self.source / "photo.png").write_bytes(png(5, 5))
        self.satellite.config.data["photo_directory"] = str(self.source)

        status, payload = self.json_request("/api/satellites/photo/import", "POST", {})

        self.assertEqual(status, 200)
        self.assertEqual(payload["imported"], 1)

    def test_scan_falls_back_to_the_configured_photo_directory(self):
        (self.source / "photo.png").write_bytes(png(5, 5))
        self.satellite.config.data["photo_directory"] = str(self.source)

        status, payload = self.json_request("/api/satellites/photo/scan", "POST", {})

        self.assertEqual(status, 200)
        self.assertEqual(payload["new"], 1)

    def test_an_explicit_source_overrides_the_configured_photo_directory(self):
        elsewhere = self.directory / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "photo.png").write_bytes(png(5, 5))
        # deliberately pointed somewhere with nothing in it, to prove the
        # explicit source below is what actually gets used
        self.satellite.config.data["photo_directory"] = str(self.source)

        status, payload = self.json_request(
            "/api/satellites/photo/import", "POST", {"source": str(elsewhere)})

        self.assertEqual(status, 200)
        self.assertEqual(payload["imported"], 1)

    def test_a_nonexistent_configured_photo_directory_is_reported_cleanly(self):
        self.satellite.config.data["photo_directory"] = str(self.directory / "nowhere")

        status, payload = self.json_request("/api/satellites/photo/import", "POST", {})

        self.assertEqual(status, 400)
        self.assertIn("does not exist", payload["error"])

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


class PhotoAlbumsTest(unittest.TestCase):
    """The Photo Library's Albums resource: CRUD on custom albums, addressed by
    the library's own stable photo ids - plus the GPS/location data the Map
    tab and photo-details location map are built on, exercised through the
    same HTTP API the Mission Control page itself calls."""

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
        # a fresh library and a fresh album store for every test, same as
        # PhotoSatelliteTest - the real one is never touched
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-albums-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")
        self.satellite.config.data["photo_directory"] = ""

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

    def albums_url(self, *segments):
        return "/".join(["/api/satellites/photo/albums", *segments])

    def import_photo(self, name: str, data: bytes) -> dict:
        (self.source / name).write_bytes(data)
        status, payload = self.json_request(
            "/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)
        photo = next(photo for photo in payload["photos"] if photo["filename"] == name)
        (self.source / name).unlink()  # so the next import_photo() call only picks up its own file
        return photo

    # ---------- creation, listing, rename, deletion ----------

    def test_a_new_library_has_no_albums(self):
        status, payload = self.json_request(self.albums_url())

        self.assertEqual(status, 200)
        self.assertEqual(payload["albums"], [])

    def test_an_album_can_be_created(self):
        status, payload = self.json_request(self.albums_url(), "POST", {"name": "Summer trip"})

        self.assertEqual(status, 200)
        self.assertEqual(payload["name"], "Summer trip")
        self.assertEqual(payload["photo_ids"], [])
        self.assertTrue(payload["id"])
        self.assertIn("created_at", payload)
        self.assertIn("updated_at", payload)

    def test_creating_an_album_requires_a_name(self):
        for name in (None, "", "   "):
            status, payload = self.json_request(self.albums_url(), "POST", {"name": name})
            self.assertEqual(status, 400)
            self.assertIn("error", payload)

    def test_an_album_name_has_a_maximum_length(self):
        status, payload = self.json_request(self.albums_url(), "POST", {"name": "x" * 200})

        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_created_albums_are_listed(self):
        self.json_request(self.albums_url(), "POST", {"name": "Beach"})
        self.json_request(self.albums_url(), "POST", {"name": "Mountains"})

        status, payload = self.json_request(self.albums_url())

        self.assertEqual(status, 200)
        names = sorted(album["name"] for album in payload["albums"])
        self.assertEqual(names, ["Beach", "Mountains"])
        # a freshly created album has no photos yet
        self.assertTrue(all(album["photo_count"] == 0 for album in payload["albums"]))
        self.assertTrue(all(album["cover_photo_id"] is None for album in payload["albums"]))

    def test_an_album_can_be_renamed(self):
        album = self.json_request(self.albums_url(), "POST", {"name": "Old name"})[1]

        status, payload = self.json_request(self.albums_url(album["id"]), "POST", {"name": "New name"})

        self.assertEqual(status, 200)
        self.assertEqual(payload["name"], "New name")
        self.assertEqual(self.json_request(self.albums_url(album["id"]))[1]["name"], "New name")

    def test_renaming_an_unknown_album_is_a_404(self):
        status, payload = self.json_request(self.albums_url("does-not-exist"), "POST", {"name": "New name"})

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_renaming_requires_a_valid_name(self):
        album = self.json_request(self.albums_url(), "POST", {"name": "Keeps its name"})[1]

        status, payload = self.json_request(self.albums_url(album["id"]), "POST", {"name": ""})

        self.assertEqual(status, 400)
        self.assertEqual(self.json_request(self.albums_url(album["id"]))[1]["name"], "Keeps its name")

    def test_an_album_can_be_deleted(self):
        album = self.json_request(self.albums_url(), "POST", {"name": "Temporary"})[1]

        status, payload = self.json_request(self.albums_url(album["id"], "delete"), "POST")

        self.assertEqual(status, 200)
        self.assertEqual(payload["deleted"], album["id"])
        self.assertEqual(self.json_request(self.albums_url())[1]["albums"], [])

    def test_deleting_an_unknown_album_is_a_404(self):
        status, payload = self.json_request(self.albums_url("does-not-exist", "delete"), "POST")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_fetching_an_unknown_album_is_a_404(self):
        status, payload = self.json_request(self.albums_url("does-not-exist"))

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    # ---------- adding / removing photos ----------

    def test_a_photo_can_be_added_to_an_album(self):
        photo = self.import_photo("a.png", png(4, 3))
        album = self.json_request(self.albums_url(), "POST", {"name": "Trip"})[1]

        status, payload = self.json_request(self.albums_url(album["id"], "photos"), "POST", {"photo_id": photo["id"]})

        self.assertEqual(status, 200)
        self.assertEqual(payload["photo_ids"], [photo["id"]])

        detail = self.json_request(self.albums_url(album["id"]))[1]
        self.assertEqual(len(detail["photos"]), 1)
        self.assertEqual(detail["photos"][0]["id"], photo["id"])

        listing = self.json_request(self.albums_url())[1]["albums"][0]
        self.assertEqual(listing["photo_count"], 1)
        self.assertEqual(listing["cover_photo_id"], photo["id"])

    def test_adding_the_same_photo_twice_does_not_duplicate_it(self):
        photo = self.import_photo("a.png", png(4, 3))
        album = self.json_request(self.albums_url(), "POST", {"name": "Trip"})[1]

        self.json_request(self.albums_url(album["id"], "photos"), "POST", {"photo_id": photo["id"]})
        status, payload = self.json_request(self.albums_url(album["id"], "photos"), "POST", {"photo_id": photo["id"]})

        self.assertEqual(status, 200)
        self.assertEqual(payload["photo_ids"], [photo["id"]])

    def test_adding_an_unknown_photo_is_rejected(self):
        album = self.json_request(self.albums_url(), "POST", {"name": "Trip"})[1]

        status, payload = self.json_request(
            self.albums_url(album["id"], "photos"), "POST", {"photo_id": "deadbeefdeadbeef"})

        self.assertEqual(status, 400)
        self.assertIn("error", payload)
        self.assertEqual(self.json_request(self.albums_url(album["id"]))[1]["photo_ids"], [])

    def test_adding_a_photo_to_an_unknown_album_is_a_404(self):
        photo = self.import_photo("a.png", png(4, 3))

        status, payload = self.json_request(
            self.albums_url("does-not-exist", "photos"), "POST", {"photo_id": photo["id"]})

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_a_photo_can_be_removed_from_an_album(self):
        photo = self.import_photo("a.png", png(4, 3))
        album = self.json_request(self.albums_url(), "POST", {"name": "Trip"})[1]
        self.json_request(self.albums_url(album["id"], "photos"), "POST", {"photo_id": photo["id"]})

        status, payload = self.json_request(
            self.albums_url(album["id"], "photos", "remove"), "POST", {"photo_id": photo["id"]})

        self.assertEqual(status, 200)
        self.assertEqual(payload["photo_ids"], [])
        self.assertEqual(self.json_request(self.albums_url(album["id"]))[1]["photos"], [])

    def test_removing_a_photo_not_in_the_album_is_a_no_op(self):
        album = self.json_request(self.albums_url(), "POST", {"name": "Trip"})[1]

        status, payload = self.json_request(
            self.albums_url(album["id"], "photos", "remove"), "POST", {"photo_id": "deadbeefdeadbeef"})

        self.assertEqual(status, 200)
        self.assertEqual(payload["photo_ids"], [])

    def test_an_album_can_hold_several_photos_and_is_ordered_by_addition(self):
        first = self.import_photo("a.png", png(4, 3))
        second = self.import_photo("b.png", png(5, 3))
        album = self.json_request(self.albums_url(), "POST", {"name": "Trip"})[1]

        self.json_request(self.albums_url(album["id"], "photos"), "POST", {"photo_id": first["id"]})
        self.json_request(self.albums_url(album["id"], "photos"), "POST", {"photo_id": second["id"]})

        detail = self.json_request(self.albums_url(album["id"]))[1]
        self.assertEqual(detail["photo_ids"], [first["id"], second["id"]])
        self.assertEqual(len(detail["photos"]), 2)

    # ---------- validation / method errors ----------

    def test_albums_route_rejects_other_methods(self):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        try:
            connection.request("DELETE", self.albums_url())
            response = connection.getresponse()
            # the Core itself refuses PUT/PATCH/DELETE before any satellite
            # route is ever reached - see starcore.api.server.RequestHandler
            self.assertEqual(response.status, 405)
        finally:
            connection.close()

    def test_creating_an_album_requires_json_object_semantics(self):
        # a body without a 'name' key at all behaves the same as an empty one
        status, payload = self.json_request(self.albums_url(), "POST", {})

        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    # ---------- GPS / location data, for the Map tab and photo-details map ----------

    def test_a_photo_without_gps_metadata_has_no_location(self):
        photo = self.import_photo("no-gps.png", png(6, 4))

        self.assertIsNone(photo["metadata"]["gps_latitude"])
        self.assertIsNone(photo["metadata"]["gps_longitude"])
        self.assertIsNone(photo["metadata"]["gps_coordinates"])

    def test_a_photo_with_gps_metadata_is_locatable_through_the_api(self):
        gps = {
            GPS_LATITUDE_REF: text_field("N"),
            GPS_LATITUDE: rational_field((48, 1), (51, 1), (29, 1)),
            GPS_LONGITUDE_REF: text_field("E"),
            GPS_LONGITUDE: rational_field((2, 1), (17, 1), (40, 1)),
        }
        tiff = build_exif(gps=gps)
        (self.source / "paris.jpg").write_bytes(jpeg_with_exif(64, 48, tiff))

        status, payload = self.json_request(
            "/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)
        photo = payload["photos"][0]

        self.assertAlmostEqual(photo["metadata"]["gps_latitude"], 48.858056, places=4)
        self.assertAlmostEqual(photo["metadata"]["gps_longitude"], 2.294444, places=4)
        self.assertIsNotNone(photo["metadata"]["gps_coordinates"])

        # the same data reachable the way the Map tab and the photo-details
        # location map both fetch it: the plain /photos listing and a single
        # photo lookup, with nothing map-specific needed on the backend
        listing = self.json_request("/api/satellites/photo/photos")[1]["photos"]
        located = next(entry for entry in listing if entry["id"] == photo["id"])
        self.assertAlmostEqual(located["metadata"]["gps_latitude"], 48.858056, places=4)

        single = self.json_request(f"/api/satellites/photo/photos/{photo['id']}")[1]
        self.assertAlmostEqual(single["metadata"]["gps_longitude"], 2.294444, places=4)

    def test_a_mix_of_located_and_unlocated_photos_can_be_filtered_client_side(self):
        located_gps = {
            GPS_LATITUDE_REF: text_field("N"),
            GPS_LATITUDE: rational_field((10, 1), (0, 1), (0, 1)),
            GPS_LONGITUDE_REF: text_field("E"),
            GPS_LONGITUDE: rational_field((20, 1), (0, 1), (0, 1)),
        }
        (self.source / "located.jpg").write_bytes(jpeg_with_exif(10, 10, build_exif(gps=located_gps)))
        (self.source / "unlocated.png").write_bytes(png(10, 10))

        status, payload = self.json_request(
            "/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)

        listing = self.json_request("/api/satellites/photo/photos")[1]["photos"]
        located = [entry for entry in listing if entry["metadata"]["gps_latitude"] is not None]
        unlocated = [entry for entry in listing if entry["metadata"]["gps_latitude"] is None]

        self.assertEqual(len(located), 1)
        self.assertEqual(len(unlocated), 1)
        self.assertEqual(located[0]["filename"], "located.jpg")
        self.assertEqual(unlocated[0]["filename"], "unlocated.png")

    def test_camera_metadata_is_available_for_device_grouping(self):
        root = {EXIF_MAKE: text_field("Canon"), EXIF_MODEL: text_field("Canon EOS R5")}
        tiff = build_exif(root)
        (self.source / "camera.jpg").write_bytes(jpeg_with_exif(20, 20, tiff))
        (self.source / "unknown.png").write_bytes(png(6, 6))

        status, payload = self.json_request(
            "/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)

        listing = self.json_request("/api/satellites/photo/photos")[1]["photos"]
        with_camera = next(entry for entry in listing if entry["filename"] == "camera.jpg")
        without_camera = next(entry for entry in listing if entry["filename"] == "unknown.png")

        self.assertEqual(with_camera["metadata"]["camera_make"], "Canon")
        self.assertEqual(with_camera["metadata"]["camera_model"], "Canon EOS R5")
        self.assertIsNone(without_camera["metadata"]["camera_make"])
        self.assertIsNone(without_camera["metadata"]["camera_model"])


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

        # config.toml is loaded from the real satellite directory, not a
        # per-test temp file the way engine/config.toml is - redirect it so a
        # "photo config" test never writes into the working copy on disk. The
        # in-memory config.data is reset to match, since earlier tests' saves
        # (which mutate config.data directly) would otherwise leak through -
        # sync_enabled is off so these CLI plumbing tests never touch a real
        # socket; that live-restart behaviour has its own coverage in
        # test_photo_sync.py's PhotoConfigurationTest.
        self.satellite.config.data["sync_enabled"] = False
        self.satellite.config.data["sync_host"] = "127.0.0.1"
        self.satellite.config.data["sync_port"] = 0
        self.config_path = self.directory / "config.toml"
        self.config_path.write_text(
            'enabled = true\nsync_enabled = false\nsync_host = "127.0.0.1"\nsync_port = 0\n',
            encoding="utf-8",
        )
        self.satellite.config.path = self.config_path

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

    def test_photo_config_with_no_arguments_shows_current_settings(self):
        output = self.run_command("photo config")

        self.assertIn("sync_host", output)
        self.assertIn("sync_port", output)
        self.assertIn("127.0.0.1", output)

    def test_photo_config_changes_the_host(self):
        output = self.run_command("photo config sync_host 0.0.0.0")

        self.assertIn("sync_host = 0.0.0.0", output)
        self.assertEqual(self.satellite.config.get("sync_host"), "0.0.0.0")
        self.assertIn("0.0.0.0", self.config_path.read_text(encoding="utf-8"))

    def test_photo_config_changes_the_port(self):
        output = self.run_command("photo config sync_port 9090")

        self.assertIn("sync_port = 9090", output)
        self.assertEqual(self.satellite.config.get("sync_port"), 9090)
        self.assertIn("9090", self.config_path.read_text(encoding="utf-8"))

    def test_photo_config_reports_when_sync_is_turned_off(self):
        output = self.run_command("photo config sync_port 9090")

        self.assertIn("currently turned off", output)

    def test_photo_config_rejects_an_invalid_port(self):
        output = self.run_command("photo config sync_port not-a-number")

        self.assertIn("[ERROR]", output)
        self.assertNotIn("9090", self.config_path.read_text(encoding="utf-8"))

    def test_photo_config_rejects_an_out_of_range_port(self):
        output = self.run_command("photo config sync_port 70000")

        self.assertIn("[ERROR]", output)

    def test_photo_config_rejects_an_unknown_key(self):
        output = self.run_command("photo config sync_nonsense value")

        self.assertIn("[ERROR]", output)

    def test_photo_config_requires_exactly_a_key_and_a_value(self):
        output = self.run_command("photo config sync_host")

        self.assertIn("[ERROR]", output)
        self.assertIn("Usage", output)


if __name__ == "__main__":
    unittest.main()
