"""Video thumbnails: Photos' on-disk cache, and the Locked Folder's
memory-only poster frames.

ffmpeg is stubbed (it isn't needed to check caching, invalidation, fallback
or privacy), and everything runs against temporary directories with
synthetic files - never a real library or vault.
"""

from pathlib import Path
import json
from unittest import mock
from urllib.parse import quote
import subprocess
import tempfile
import unittest

from tests import test_locked_folder_encryption as vault_tests
from tests.test_locked_folder_encryption import _VaultTestBase, module, needs_crypto
from tests.test_photo_video import mp4


def setUpModule():
    vault_tests.setUpModule()  # the vault base class needs its crypto modules loaded

JPEG = b"\xff\xd8\xff\xe0" + b"poster-frame" + b"\xff\xd9"


class PhotoVideoThumbnailCacheTest(unittest.TestCase):
    def setUp(self):
        from importlib import import_module
        self.library_module = import_module("satellites.native.photo.library")
        self.videos = import_module("satellites.native.photo.videos")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.library = self.library_module.PhotoLibrary(Path(self.tmp.name) / "storage")
        source = Path(self.tmp.name) / "clip.mp4"
        source.write_bytes(mp4(640, 360))
        self.video = self.library.add_file(source)

    def test_a_rendered_frame_is_cached_by_media_id(self):
        calls = []

        def render(source, destination, size, duration=None):
            calls.append(source)
            Path(destination).write_bytes(JPEG)
            return True

        with mock.patch.object(self.videos, "thumbnail", side_effect=render):
            first = self.library.thumbnail_path(self.video)
            second = self.library.thumbnail_path(self.video)

        self.assertEqual(first, second)
        self.assertIn(self.video["id"], first.name)
        self.assertEqual(first.read_bytes(), JPEG)
        self.assertEqual(len(calls), 1)

    def test_a_failed_extraction_is_not_retried_on_every_request(self):
        with mock.patch.object(self.videos, "thumbnail", return_value=False) as render:
            self.assertIsNone(self.library.thumbnail_path(self.video))
            self.assertIsNone(self.library.thumbnail_path(self.video))
        self.assertEqual(render.call_count, 1)
        self.assertFalse(any(self.library.thumbnails_dir.rglob("*.part")))

    def test_a_failure_is_retried_once_ffmpeg_shows_up_without_a_restart(self):
        with mock.patch.object(self.videos, "_load_ffmpeg", return_value=None):
            self.assertIsNone(self.library.thumbnail_path(self.video))

        def render(source, destination, size, duration=None):
            Path(destination).write_bytes(JPEG)
            return True

        with mock.patch.object(self.videos, "_load_ffmpeg", return_value="ffmpeg"),                 mock.patch.object(self.videos, "thumbnail", side_effect=render) as rendered:
            self.assertIsNotNone(self.library.thumbnail_path(self.video))
        self.assertEqual(rendered.call_count, 1)

    def test_a_failure_with_the_same_ffmpeg_is_retried_after_the_cool_down(self):
        with mock.patch.object(self.videos, "_load_ffmpeg", return_value="ffmpeg"),                 mock.patch.object(self.videos, "thumbnail", return_value=False) as render:
            self.library.thumbnail_path(self.video)
            self.library.thumbnail_path(self.video)
            self.assertEqual(render.call_count, 1)
            with mock.patch.object(self.library_module.time, "monotonic",
                                   return_value=self.library_module.time.monotonic() + 301):
                self.library.thumbnail_path(self.video)
            self.assertEqual(render.call_count, 2)

    def test_missing_ffmpeg_gives_no_thumbnail_rather_than_the_video(self):
        with mock.patch.object(self.videos, "_load_ffmpeg", return_value=None):
            self.assertIsNone(self.library.thumbnail_path(self.video))


class FakeFfmpeg:
    """Stands in for subprocess.run: records what ffmpeg was given to read
    (and its bytes at that moment) and answers with a JPEG on stdout."""

    def __init__(self, fail=False):
        self.fail = fail
        self.inputs = []

    def __call__(self, argv, **kwargs):
        source = Path(argv[argv.index("-i") + 1])
        self.inputs.append((source, source.read_bytes()))
        assert argv[-1] == "pipe:1", "the frame must go to a pipe, never a file"
        if self.fail:
            return subprocess.CompletedProcess(argv, 1, b"", b"")
        return subprocess.CompletedProcess(argv, 0, JPEG, b"")


class LockedFolderThumbnailTest(_VaultTestBase):
    VIDEO = b"\x00\x00\x00\x18ftypisom" + b"private-video-bytes" * 64

    def thumb(self, relative, token=None):
        return self.request(f"/api/satellites/LockedFolder/media/thumbnail?path={quote(relative)}", token=token)

    def patched(self, fake, available=True):
        thumbnails = module("locked_folder.thumbnails")
        stack = [mock.patch.object(thumbnails, "ffmpeg", return_value="ffmpeg" if available else None),
                 mock.patch.object(thumbnails.subprocess, "run", side_effect=fake)]
        for patch in stack:
            patch.start()
            self.addCleanup(patch.stop)

    def jpegs_on_disk(self):
        roots = [self.vault, self.storage, self.directory]
        return sorted({path for root in roots if root.exists() for path in root.rglob("*")
                       if path.is_file() and path.read_bytes().startswith(b"\xff\xd8")})

    def test_needs_an_unlocked_session(self):
        fake = FakeFfmpeg()
        self.patched(fake)
        self.setup_vault({"clip.mp4": self.VIDEO})
        status, _, _ = self.thumb("clip.mp4")
        self.assertEqual(status, 403)
        self.assertEqual(self.thumb("clip.mp4", token="")[0], 401)
        self.assertEqual(fake.inputs, [])

    def test_a_plain_vault_video_is_rendered_once_and_never_stored(self):
        fake = FakeFfmpeg()
        self.patched(fake)
        self.setup_vault({"clip.mp4": self.VIDEO})
        self.unlock()

        status, body, headers = self.thumb("clip.mp4")
        self.assertEqual(status, 200)
        self.assertEqual(body, JPEG)
        self.assertEqual(headers.get("Content-Type"), "image/jpeg")
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        self.assertEqual(self.thumb("clip.mp4")[1], JPEG)
        self.assertEqual(len(fake.inputs), 1, "the second request is served from memory")
        self.assertEqual(self.jpegs_on_disk(), [])

        # a changed file gets a new frame
        (self.vault / "clip.mp4").write_bytes(self.VIDEO + b"edited")
        self.assertEqual(self.thumb("clip.mp4")[0], 200)
        self.assertEqual(len(fake.inputs), 2)

    def test_locking_drops_the_cached_frames(self):
        fake = FakeFfmpeg()
        self.patched(fake)
        self.setup_vault({"clip.mp4": self.VIDEO})
        self.unlock()
        self.assertEqual(self.thumb("clip.mp4")[0], 200)
        self.assertEqual(len(self.runtime().thumbnails), 1)

        self.assertEqual(self.lf("lock", {})[0], 200)
        self.assertEqual(len(self.runtime().thumbnails), 0)
        self.assertEqual(self.thumb("clip.mp4")[0], 403)

    def test_failure_missing_ffmpeg_and_non_videos_fall_back_cleanly(self):
        fake = FakeFfmpeg(fail=True)
        self.patched(fake)
        self.setup_vault({"clip.mp4": self.VIDEO, "notes.txt": b"hello"})
        self.unlock()
        self.assertEqual(self.thumb("clip.mp4")[0], 404)
        self.assertEqual(self.thumb("clip.mp4")[0], 404)
        self.assertEqual(len(fake.inputs), 2, "one render (two offsets), then remembered")
        self.assertEqual(self.thumb("notes.txt")[0], 404)
        self.assertEqual(self.thumb("../outside.mp4")[0] in (400, 403, 404), True)

    def test_no_ffmpeg_means_no_thumbnail(self):
        fake = FakeFfmpeg()
        self.patched(fake, available=False)
        self.setup_vault({"clip.mp4": self.VIDEO})
        self.unlock()
        self.assertEqual(self.thumb("clip.mp4")[0], 404)
        self.assertEqual(fake.inputs, [])

    def test_a_failed_frame_is_retried_after_ffmpeg_is_installed(self):
        fake = FakeFfmpeg()
        thumbnails = module("locked_folder.thumbnails")
        self.patched(fake, available=False)
        self.setup_vault({"clip.mp4": self.VIDEO})
        self.unlock()
        self.assertEqual(self.thumb("clip.mp4")[0], 404)
        self.assertEqual(fake.inputs, [])

        # ffmpeg appears on PATH: no restart, the next request renders
        with mock.patch.object(thumbnails, "ffmpeg", return_value="ffmpeg"):
            self.assertEqual(self.thumb("clip.mp4")[0], 200)
        self.assertEqual(len(fake.inputs), 1)

    def test_a_failure_with_the_same_ffmpeg_is_retried_after_the_cool_down(self):
        fake = FakeFfmpeg(fail=True)
        thumbnails = module("locked_folder.thumbnails")
        self.patched(fake)
        self.setup_vault({"clip.mp4": self.VIDEO})
        self.unlock()
        self.thumb("clip.mp4")
        self.thumb("clip.mp4")
        self.assertEqual(len(fake.inputs), 2, "remembered after the first render")
        later = thumbnails.time.monotonic() + thumbnails.RETRY_SECONDS + 1
        with mock.patch.object(thumbnails.time, "monotonic", return_value=later):
            self.thumb("clip.mp4")
        self.assertEqual(len(fake.inputs), 4)

    def duration(self, relative):
        status, body, _ = self.request(f"/api/satellites/LockedFolder/media/duration?path={quote(relative)}")
        return status, (json.loads(body) if status == 200 else None)

    def test_a_plain_video_reports_its_length_from_the_cached_render(self):
        fake = FakeFfmpeg()
        self.patched(fake)
        self.setup_vault({"clip.mp4": mp4(640, 360, duration=600 * 75)})
        self.unlock()
        self.assertEqual(self.thumb("clip.mp4")[0], 200)
        self.assertEqual(self.duration("clip.mp4"), (200, {"duration": 75}))
        self.assertEqual(len(fake.inputs), 1, "the length came from the same render")

    def test_there_is_no_length_without_a_frame(self):
        self.patched(FakeFfmpeg(fail=True))
        self.setup_vault({"clip.mp4": mp4(640, 360, duration=600 * 75), "notes.txt": b"hi"})
        self.unlock()
        self.assertEqual(self.duration("clip.mp4")[0], 404)
        self.assertEqual(self.duration("notes.txt")[0], 404)

    def test_the_length_needs_an_unlocked_session(self):
        self.patched(FakeFfmpeg())
        self.setup_vault({"clip.mp4": mp4(640, 360, duration=600 * 75)})
        self.assertEqual(self.duration("clip.mp4")[0], 403)

    @needs_crypto
    def test_an_encrypted_video_reports_its_length_too(self):
        self.patched(FakeFfmpeg())
        self.setup_vault({"clip.mp4": mp4(640, 360, duration=600 * 12)})
        self.encrypt()
        item = next(item for item in self.media() if item["name"] == "clip.mp4")
        self.assertEqual(self.duration(item["path"]), (200, {"duration": 12}))
        self.assertEqual(self.plaintext_left(), [])

    @needs_crypto
    def test_staging_is_removed_even_when_the_render_blows_up(self):
        self.patched(mock.Mock(side_effect=RuntimeError('boom')))
        self.setup_vault({"clip.mp4": self.VIDEO})
        self.encrypt()
        item = next(item for item in self.media() if item["name"] == "clip.mp4")
        self.assertGreaterEqual(self.thumb(item["path"])[0], 500)
        self.assertEqual(self.plaintext_left(), [])

    @needs_crypto
    def test_a_copy_left_by_a_killed_process_is_swept_but_a_fresh_one_is_spared(self):
        import os
        import time
        fake = FakeFfmpeg()
        self.patched(fake)
        self.setup_vault({"clip.mp4": self.VIDEO})
        self.encrypt()
        item = next(item for item in self.media() if item["name"] == "clip.mp4")
        tmp = self.vault / ".starcore-vault" / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        stale, fresh = tmp / "dead.part", tmp / "live.part"
        stale.write_bytes(b"leftover plaintext")
        fresh.write_bytes(b"in use by another request")
        old = time.time() - 3600
        os.utime(stale, (old, old))

        self.assertEqual(self.thumb(item["path"])[0], 200)
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    @needs_crypto
    def test_an_encrypted_video_is_decrypted_only_while_ffmpeg_reads_it(self):
        fake = FakeFfmpeg()
        self.patched(fake)
        self.setup_vault({"clip.mp4": self.VIDEO})
        self.encrypt()
        item = next(item for item in self.media() if item["name"] == "clip.mp4")

        status, body, headers = self.thumb(item["path"])
        self.assertEqual(status, 200)
        self.assertEqual(body, JPEG)
        self.assertIn("no-store", headers.get("Cache-Control", ""))

        source, seen = fake.inputs[0]
        self.assertEqual(seen, self.VIDEO, "ffmpeg read the decrypted video")
        self.assertTrue(source.is_relative_to(self.vault / ".starcore-vault"), "staged inside the vault only")
        self.assertFalse(source.exists(), "the decrypted copy is removed straight away")
        self.assertEqual(self.jpegs_on_disk(), [])
        self.assertEqual(self.plaintext_left(), [])


if __name__ == "__main__":
    unittest.main()
