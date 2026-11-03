"""Photo thumbnails on a server without Pillow, and concurrent index writes.

Found on a real installation: with Pillow missing, /thumbnails/<id> served the
original under a one-week cache header, so browsers and the app kept the
full-size files even after Pillow was installed; and the gallery's parallel
first requests could collide renaming the same albums.part on Windows
(WinError 32), failing /albums with a 500. Everything here uses temporary
directories and synthetic images.
"""

from importlib import import_module
from pathlib import Path
from unittest import mock
import sys
import tempfile
import threading
import unittest

from tests.test_photo import jpeg, png

# satellites/ lives next to engine/; a running engine normally puts it on the path
REPOSITORY = str(Path(__file__).resolve().parents[2])
if REPOSITORY not in sys.path:
    sys.path.insert(0, REPOSITORY)


class ThumbnailFallbackCacheTest(unittest.TestCase):
    def setUp(self):
        self.library_module = import_module("satellites.native.photo.library")
        self.images = import_module("satellites.native.photo.images")
        self.api = import_module("satellites.native.photo.api")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.library = self.library_module.PhotoLibrary(Path(self.tmp.name) / "storage")
        source = Path(self.tmp.name) / "picture.png"
        source.write_bytes(png(64, 48))
        self.photo = self.library.add_file(source)

    def test_an_original_standing_in_for_a_thumbnail_is_not_cached_for_long(self):
        with mock.patch.object(self.images, "thumbnail", return_value=False):
            response = self.api._serve_media(self.library, self.photo, thumbnail=True)

        self.assertEqual(response.path, self.library.original_path(self.photo))
        self.assertEqual(response.content_type, "image/png")
        self.assertEqual(response.cache, "private, no-cache")

    def test_a_rendered_thumbnail_is_still_cached_as_immutable(self):
        def render(source, destination, size):
            Path(destination).write_bytes(b"\xff\xd8thumbnail\xff\xd9")
            return True

        with mock.patch.object(self.images, "thumbnail", side_effect=render):
            response = self.api._serve_media(self.library, self.photo, thumbnail=True)

        self.assertEqual(response.path.parent.parent, self.library.thumbnails_dir)
        self.assertEqual(response.content_type, "image/jpeg")
        self.assertEqual(response.cache, self.api.IMMUTABLE)

    def test_a_jpeg_original_is_not_mistaken_for_a_thumbnail(self):
        # an original stored as .jpg must get the fallback header too
        source = Path(self.tmp.name) / "photo.jpg"
        source.write_bytes(jpeg(64, 48))
        photo = self.library.add_file(source)
        with mock.patch.object(self.images, "thumbnail", return_value=False):
            response = self.api._serve_media(self.library, photo, thumbnail=True)
        self.assertEqual(response.cache, "private, no-cache")


class ConcurrentIndexWriteTest(unittest.TestCase):
    def setUp(self):
        self.library_module = import_module("satellites.native.photo.library")
        self.albums = import_module("satellites.native.photo.albums")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def run_together(self, count, target):
        errors = []
        start = threading.Barrier(count)

        def work(index):
            try:
                start.wait()
                target(index)
            except Exception as error:  # noqa: BLE001 - collected and asserted below
                errors.append(error)

        threads = [threading.Thread(target=work, args=(index,)) for index in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return errors

    def test_parallel_index_writes_never_collide(self):
        path = self.root / "albums.json"
        errors = self.run_together(8, lambda index: [
            self.library_module.write_index(path, {"version": 1, "writer": index, "round": round_})
            for round_ in range(20)])

        self.assertEqual(errors, [])
        self.assertTrue(path.is_file())
        self.assertEqual(list(self.root.glob("*.part")) + list(self.root.glob(".*.part")), [])

    def test_the_first_parallel_requests_share_one_album_store(self):
        satellite = mock.Mock()
        satellite.config.get.side_effect = lambda key, default=None: (
            str(self.root / "library") if key == "storage" else default)
        stores = []
        self.addCleanup(self.albums._stores.pop, (self.root / "library").resolve(), None)

        errors = self.run_together(6, lambda index: stores.append(self.albums.albums(satellite)))

        self.assertEqual(errors, [])
        self.assertEqual(len({id(store) for store in stores}), 1)
        self.assertIsNotNone(stores[0].get(self.albums.FAVORITES_ID))


if __name__ == "__main__":
    unittest.main()
