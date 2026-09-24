"""Video support: probing MP4-family containers, ingesting them into the
library alongside photos, and serving their (optional, ffmpeg-rendered)
thumbnails - see "Video" in docs/satellites/photo.md."""

from pathlib import Path
import struct
import tempfile
import unittest

SATELLITE = Path(__file__).resolve().parents[2] / "satellites" / "native" / "photo"


def videos_module():
    from importlib import import_module
    return import_module("satellites.native.photo.videos")


def _box(box_type: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), box_type) + payload


def _tkhd(width: int, height: int, version: int = 0) -> bytes:
    if version == 1:
        body = bytes([1, 0, 0, 0]) + b"\x00" * 8 + b"\x00" * 8 + b"\x00" * 4 + b"\x00" * 4 + b"\x00" * 8
        body += b"\x00" * (88 - len(body))
        body += struct.pack(">II", width << 16, height << 16)
    else:
        body = bytes([0, 0, 0, 0]) + b"\x00" * (76 - 4)
        body += struct.pack(">II", width << 16, height << 16)
    return _box(b"tkhd", body)


def _mvhd(timescale: int, duration: int, version: int = 0) -> bytes:
    if version == 1:
        body = bytes([1, 0, 0, 0]) + b"\x00" * 8 + b"\x00" * 8
        body += struct.pack(">I", timescale) + struct.pack(">Q", duration)
        body += b"\x00" * 80
    else:
        body = bytes([0, 0, 0, 0]) + b"\x00" * 4 + b"\x00" * 4
        body += struct.pack(">II", timescale, duration)
        body += b"\x00" * 80
    return _box(b"mvhd", body)


def _hdlr(handler_type: bytes) -> bytes:
    body = b"\x00" * 8 + handler_type + b"\x00" * 12
    return _box(b"hdlr", body)


def mp4(width=1920, height=1080, timescale=600, duration=1800, major_brand=b"isom",
        mvhd_version=0, tkhd_version=0, video_track=True) -> bytes:
    """A minimal, synthetic but structurally real MP4: just enough of the
    ISOBMFF box tree (ftyp/moov/mvhd/trak/tkhd/mdia/hdlr) for videos.py's own
    parser to read - no encoded video frames, since probe() never looks at
    the actual media data (it lives in a sibling 'mdat' this fixture never
    even bothers writing)."""
    ftyp = _box(b"ftyp", major_brand + b"\x00\x00\x02\x00" + b"isom" + b"mp42")
    hdlr = _hdlr(b"vide" if video_track else b"soun")
    mdia = _box(b"mdia", hdlr)
    trak = _box(b"trak", _tkhd(width, height, tkhd_version) + mdia)
    moov = _box(b"moov", _mvhd(timescale, duration, mvhd_version) + trak)
    return ftyp + moov


class VideoProbeTest(unittest.TestCase):
    def setUp(self):
        self.videos = videos_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, name: str, data: bytes) -> Path:
        path = Path(self.tmp.name) / name
        path.write_bytes(data)
        return path

    def test_a_well_formed_mp4_is_recognized(self):
        path = self.write("clip.mp4", mp4(1280, 720, timescale=600, duration=3000))
        info = self.videos.probe(path)

        self.assertEqual(info["format"], "mp4")
        self.assertEqual((info["width"], info["height"]), (1280, 720))
        self.assertEqual(info["duration"], 5.0)

    def test_recognized_by_content_not_by_filename(self):
        # sync.py hands add_file() an extensionless temp file - probe() has
        # to work from the bytes alone, exactly like images.probe() does
        path = self.write("upload.part", mp4(640, 480))
        info = self.videos.probe(path)

        self.assertEqual(info["format"], "mp4")
        self.assertEqual((info["width"], info["height"]), (640, 480))

    def test_a_quicktime_brand_is_reported_as_mov(self):
        path = self.write("clip.mov", mp4(major_brand=b"qt  "))
        self.assertEqual(self.videos.probe(path)["format"], "mov")

    def test_a_3gp_brand_is_reported_as_3gp(self):
        path = self.write("clip.3gp", mp4(major_brand=b"3gp4"))
        self.assertEqual(self.videos.probe(path)["format"], "3gp")

    def test_version_1_mvhd_and_tkhd_boxes_are_understood(self):
        path = self.write("clip.mp4", mp4(1920, 1080, timescale=1000, duration=10000,
                                           mvhd_version=1, tkhd_version=1))
        info = self.videos.probe(path)

        self.assertEqual((info["width"], info["height"]), (1920, 1080))
        self.assertEqual(info["duration"], 10.0)

    def test_an_audio_only_track_is_not_mistaken_for_the_video_track(self):
        path = self.write("clip.mp4", mp4(video_track=False))
        info = self.videos.probe(path)

        # no video track means no display size to report - not a crash, and
        # not the (0, 0) an audio track's own tkhd would otherwise supply
        self.assertEqual((info["width"], info["height"]), (None, None))

    def test_a_non_isobmff_file_is_rejected(self):
        path = self.write("notes.txt", b"just some text, not a video at all")
        with self.assertRaises(self.videos.UnsupportedVideo):
            self.videos.probe(path)

    def test_a_truncated_file_is_rejected(self):
        path = self.write("clip.mp4", mp4()[:20])
        with self.assertRaises(self.videos.UnsupportedVideo):
            self.videos.probe(path)

    def test_duration_label_formats_minutes_and_seconds(self):
        self.assertEqual(self.videos.duration_label(65), "1:05")
        self.assertEqual(self.videos.duration_label(3661), "1:01:01")
        self.assertEqual(self.videos.duration_label(None), "")
        self.assertEqual(self.videos.duration_label(-1), "")


class VideoThumbnailTest(unittest.TestCase):
    """These exercise the real, optional ffmpeg path when it's on PATH (this
    sandbox has it), and the graceful fallback either way - mirroring how
    images.py's own thumbnail tests treat Pillow as optional."""

    def setUp(self):
        self.videos = videos_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_thumbnails_available_reflects_whether_ffmpeg_is_on_path(self):
        self.assertEqual(self.videos.thumbnails_available(), bool(self.videos._load_ffmpeg()))

    def test_thumbnail_of_an_unreadable_file_fails_gracefully(self):
        if not self.videos.thumbnails_available():
            self.skipTest("ffmpeg is not installed in this environment")

        source = Path(self.tmp.name) / "clip.mp4"
        source.write_bytes(mp4())  # structurally valid box tree, but no actual video frames
        destination = Path(self.tmp.name) / "thumb.jpg"

        self.assertFalse(self.videos.thumbnail(source, destination, 480))
        self.assertFalse(destination.exists())


class VideoLibraryIngestionTest(unittest.TestCase):
    """A real ffmpeg-encoded clip, imported through the same PhotoLibrary a
    photo goes through - the library.py side of video support."""

    def setUp(self):
        self.library_module = self._library_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.library = self.library_module.PhotoLibrary(Path(self.tmp.name) / "storage")
        self.source = Path(self.tmp.name) / "source"
        self.source.mkdir()

    def _library_module(self):
        from importlib import import_module
        return import_module("satellites.native.photo.library")

    def write(self, name: str, data: bytes) -> Path:
        path = self.source / name
        path.write_bytes(data)
        return path

    def test_a_video_is_imported_alongside_photos(self):
        self.write("clip.mp4", mp4(640, 480, timescale=600, duration=1200))

        result = self.library.import_directory(self.source)

        self.assertEqual(result["imported"], 1)
        photo = self.library.all()[0]
        self.assertEqual(photo["media_type"], "video")
        self.assertEqual(photo["format"], "mp4")
        self.assertEqual((photo["width"], photo["height"]), (640, 480))
        self.assertEqual(photo["duration"], 2.0)

    def test_a_video_is_recognized_even_under_a_temp_filename(self):
        # add_file() (what sync.py calls) never trusts the caller's own
        # extension - see its docstring
        source = self.write("07f3c9a1.part", mp4())
        photo = self.library.add_file(source, filename="VID_20240101_120000.mp4")

        self.assertIsNotNone(photo)
        self.assertEqual(photo["media_type"], "video")
        self.assertEqual(photo["filename"], "VID_20240101_120000.mp4")

    def test_videos_and_photos_share_the_same_dedup_and_trash_behaviour(self):
        data = mp4()
        first = self.library.add_file(self.write("a.mp4", data))
        again = self.library.add_file(self.write("b.mp4", data))  # identical bytes

        self.assertIsNotNone(first)
        self.assertIsNone(again)  # exact duplicate content, regardless of media type

        self.library.trash(first["id"])
        self.assertIsNone(self.library.get(first["id"]))
        self.assertEqual(self.library.count, 0)

    def test_summary_breaks_photos_and_videos_down_separately(self):
        self.write("clip.mp4", mp4())
        images_module = __import__(
            "satellites.native.photo.images", fromlist=["png"],
        )
        # a 1x1 PNG is enough to be recognized as a photo
        png_bytes = (b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" +
                     struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0) + b"\x00" * 4)
        self.write("shot.png", png_bytes[:33])  # header is all probe() reads

        result = self.library.import_directory(self.source)
        summary = self.library.summary()

        self.assertGreaterEqual(result["imported"], 1)  # the video always imports; the truncated PNG may not
        self.assertEqual(summary["videos"], 1)
        self.assertIn("mp4", summary["formats"])

    def test_a_pre_video_library_record_loads_as_a_photo(self):
        # a library.json written before video support existed has no
        # "media_type"/"duration" keys at all - backfilled the same way
        # trashed_at is for pre-recycle-bin records
        self.write("shot.jpg", b"\xff\xd8\xff\xc0" + struct.pack(">HBHHB", 11, 8, 2, 2, 1) + b"\x01\x11\x00\xff\xd9")
        self.library.import_directory(self.source)
        self.library._save()

        index = self.library.index_path.read_text(encoding="utf-8")
        import json
        data = json.loads(index)
        for photo in data["photos"].values():
            del photo["media_type"]
            del photo["duration"]
        self.library.index_path.write_text(json.dumps(data), encoding="utf-8")

        reloaded = self.library_module.PhotoLibrary(self.library.root)
        photo = reloaded.all()[0]
        self.assertEqual(photo["media_type"], "photo")
        self.assertIsNone(photo["duration"])
