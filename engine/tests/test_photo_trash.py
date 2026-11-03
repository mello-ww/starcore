"""The Photo Library's recycle bin: soft-delete, restore, permanent erase and
the retention-based auto-purge - exercised at the library layer and through
the same HTTP API Mission Control's own Photo page calls."""

from http.client import HTTPConnection
from pathlib import Path
import contextlib
import io
import json
import shutil
import tempfile
import unittest

from tests.support import start_engine, stop_engine
from tests.test_photo import png, photo_library


class PhotoTrashLibraryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()  # loads the satellite package so it can be imported

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-trash-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.library = photo_library(self.directory / "library")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def add(self, name: str, colour: bytes = b"\x40\x60\xa0") -> dict:
        path = self.source / name
        path.write_bytes(png(4, 3, colour))
        return self.library.add_file(path, filename=name)

    def test_a_trashed_photo_disappears_from_the_library(self):
        photo = self.add("holiday.png")

        self.library.trash(photo["id"])

        self.assertEqual(self.library.all(), [])
        self.assertIsNone(self.library.get(photo["id"]))
        self.assertEqual(self.library.count, 0)
        self.assertEqual(self.library.size, 0)

    def test_a_trashed_photo_is_still_reachable_through_get_any(self):
        photo = self.add("holiday.png")

        self.library.trash(photo["id"])

        found = self.library.get_any(photo["id"])
        self.assertIsNotNone(found)
        self.assertTrue(found["trashed_at"])

    def test_a_trashed_photo_still_counts_toward_all_ids(self):
        photo = self.add("holiday.png")

        self.library.trash(photo["id"])

        self.assertIn(photo["id"], self.library.all_ids())

    def test_trashing_an_unknown_photo_is_rejected(self):
        from satellites.native.photo.library import PhotoNotFound

        with self.assertRaises(PhotoNotFound):
            self.library.trash("deadbeefdeadbeef")

    def test_trashing_an_already_trashed_photo_is_rejected(self):
        from satellites.native.photo.library import PhotoNotFound

        photo = self.add("holiday.png")
        self.library.trash(photo["id"])

        with self.assertRaises(PhotoNotFound):
            self.library.trash(photo["id"])

    def test_a_restored_photo_reappears_in_the_library(self):
        photo = self.add("holiday.png")
        self.library.trash(photo["id"])

        restored = self.library.restore(photo["id"])

        self.assertIsNone(restored["trashed_at"])
        self.assertEqual([entry["id"] for entry in self.library.all()], [photo["id"]])
        self.assertEqual(self.library.count, 1)

    def test_restoring_a_photo_that_is_not_trashed_is_rejected(self):
        from satellites.native.photo.library import PhotoNotFound

        photo = self.add("holiday.png")

        with self.assertRaises(PhotoNotFound):
            self.library.restore(photo["id"])

    def test_restoring_an_unknown_photo_is_rejected(self):
        from satellites.native.photo.library import PhotoNotFound

        with self.assertRaises(PhotoNotFound):
            self.library.restore("deadbeefdeadbeef")

    def test_erasing_a_trashed_photo_deletes_its_files(self):
        photo = self.add("holiday.png")
        self.library.trash(photo["id"])
        original = self.library.original_path(self.library.get_any(photo["id"]))
        self.library.thumbnail_path(self.library.get_any(photo["id"]))  # renders and caches a thumbnail
        thumbnail = self.library._thumbnail_file(self.library.get_any(photo["id"]))
        self.assertTrue(original.is_file())

        self.library.erase(photo["id"])

        self.assertFalse(original.is_file())
        self.assertFalse(thumbnail.is_file())
        self.assertIsNone(self.library.get_any(photo["id"]))
        self.assertNotIn(photo["id"], self.library.all_ids())

    def test_erasing_a_photo_that_is_not_trashed_is_rejected(self):
        from satellites.native.photo.library import PhotoNotFound

        photo = self.add("holiday.png")

        with self.assertRaises(PhotoNotFound):
            self.library.erase(photo["id"])

        self.assertEqual(self.library.count, 1)

    def test_erasing_an_unknown_photo_is_rejected(self):
        from satellites.native.photo.library import PhotoNotFound

        with self.assertRaises(PhotoNotFound):
            self.library.erase("deadbeefdeadbeef")

    def test_trashed_lists_only_trashed_photos_newest_first(self):
        first = self.add("a.png", b"\x10\x10\x10")
        second = self.add("b.png", b"\x20\x20\x20")
        self.add("c.png", b"\x30\x30\x30")  # left active
        self.library.trash(first["id"])
        self.library.trash(second["id"])

        listed = [photo["id"] for photo in self.library.trashed(retention_days=30)]

        self.assertEqual(sorted(listed), sorted([first["id"], second["id"]]))
        self.assertEqual(self.library.count, 1)

    def test_a_photo_past_its_retention_period_is_purged_when_trash_is_listed(self):
        photo = self.add("holiday.png")
        self.library.trash(photo["id"])
        # backdate the trash timestamp well past any sane retention window,
        # exactly like a photo that has been sitting in the bin for months
        self.library.get_any(photo["id"])["trashed_at"] = "2000-01-01T00:00:00+00:00"

        listed = self.library.trashed(retention_days=30)

        self.assertEqual(listed, [])
        self.assertIsNone(self.library.get_any(photo["id"]))

    def test_a_photo_within_its_retention_period_is_kept(self):
        photo = self.add("holiday.png")
        self.library.trash(photo["id"])

        listed = self.library.trashed(retention_days=30)

        self.assertEqual([entry["id"] for entry in listed], [photo["id"]])

    def test_trash_state_survives_a_library_reload(self):
        photo = self.add("holiday.png")
        self.library.trash(photo["id"])

        reopened = photo_library(self.library.root)

        self.assertIsNone(reopened.get(photo["id"]))
        self.assertTrue(reopened.get_any(photo["id"])["trashed_at"])

    def test_a_pre_trash_library_record_loads_as_not_trashed(self):
        self.library.root.mkdir(parents=True, exist_ok=True)
        old_record = {
            "id": "0" * 16, "filename": "old.jpg", "path": "photos/00/old.jpg", "size": 123,
            "width": 100, "height": 50, "format": "jpeg",
            "imported_at": "2020-01-01T00:00:00", "captured_at": None,
            "metadata": {"megapixels": 0.01},
            # no "trashed_at" key at all - exactly what library.json looked
            # like before the recycle bin existed
        }
        (self.library.root / "library.json").write_text(
            json.dumps({"version": 1, "photos": {old_record["id"]: old_record}}), encoding="utf-8")

        reopened = photo_library(self.library.root)

        self.assertIsNotNone(reopened.get(old_record["id"]))
        self.assertEqual(reopened.count, 1)


class PhotoTrashApiTest(unittest.TestCase):
    """The same recycle bin, driven over HTTP - the shape Mission Control and
    the mobile app both use."""

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
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-trash-api-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")
        self.satellite.config.data["photo_directory"] = ""
        self.satellite.config.data["trash_retention_days"] = 30
        # configuration.update() persists through satellite.config.set(), which
        # writes straight to config.path - redirected so this test never
        # touches the real satellites/native/photo/config.toml
        self.satellite.config.path = self.directory / "config.toml"

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

    def import_photo(self, name: str, colour: bytes = b"\x40\x60\xa0") -> dict:
        (self.source / name).write_bytes(png(8, 6, colour))
        status, payload = self.json_request(
            "/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)
        photo = next(entry for entry in payload["photos"] if entry["filename"] == name)
        (self.source / name).unlink()
        return photo

    def test_a_new_library_has_an_empty_recycle_bin(self):
        status, payload = self.json_request("/api/satellites/photo/trash")

        self.assertEqual(status, 200)
        self.assertEqual(payload["photos"], [])
        self.assertEqual(payload["retention_days"], 30)

    def test_trashing_a_photo_removes_it_from_the_library(self):
        photo = self.import_photo("holiday.png")

        status, payload = self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        self.assertEqual(status, 200)
        self.assertTrue(payload["trashed_at"])
        self.assertEqual(self.json_request("/api/satellites/photo/photos")[1]["photos"], [])
        self.assertEqual(self.json_request("/api/satellites/photo/library")[1]["photos"], 0)

    def test_a_trashed_photo_is_not_reachable_through_the_normal_routes(self):
        photo = self.import_photo("holiday.png")
        self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        for route in ("photos", "originals", "thumbnails"):
            status, _ = self.json_request(f"/api/satellites/photo/{route}/{photo['id']}")
            self.assertEqual(status, 404)

    def test_a_trashed_photo_appears_in_the_recycle_bin(self):
        photo = self.import_photo("holiday.png")
        self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        status, payload = self.json_request("/api/satellites/photo/trash")

        self.assertEqual(status, 200)
        self.assertEqual([entry["id"] for entry in payload["photos"]], [photo["id"]])

    def test_a_trashed_photo_can_still_be_previewed_in_the_recycle_bin(self):
        photo = self.import_photo("holiday.png")
        self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        for kind in ("thumbnail", "original"):
            status, content_type, body = self.request(f"/api/satellites/photo/trash/{photo['id']}/{kind}")
            self.assertEqual(status, 200)
            self.assertTrue(content_type.startswith("image/"))
            self.assertTrue(body)

    def test_previewing_a_photo_that_is_not_trashed_is_a_404(self):
        photo = self.import_photo("holiday.png")

        status, payload = self.json_request(f"/api/satellites/photo/trash/{photo['id']}/thumbnail")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_trashing_an_unknown_photo_is_a_404(self):
        status, payload = self.json_request("/api/satellites/photo/trash/deadbeefdeadbeef", "POST")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_trashing_the_same_photo_twice_is_a_404_the_second_time(self):
        photo = self.import_photo("holiday.png")
        self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        status, payload = self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_a_trashed_photo_can_be_restored(self):
        photo = self.import_photo("holiday.png")
        self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        status, payload = self.json_request(f"/api/satellites/photo/trash/{photo['id']}/restore", "POST")

        self.assertEqual(status, 200)
        self.assertIsNone(payload["trashed_at"])
        self.assertEqual([entry["id"] for entry in self.json_request("/api/satellites/photo/photos")[1]["photos"]],
                          [photo["id"]])
        self.assertEqual(self.json_request("/api/satellites/photo/trash")[1]["photos"], [])

    def test_restoring_a_photo_that_is_not_trashed_is_a_404(self):
        photo = self.import_photo("holiday.png")

        status, payload = self.json_request(f"/api/satellites/photo/trash/{photo['id']}/restore", "POST")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_a_trashed_photo_can_be_permanently_erased(self):
        photo = self.import_photo("holiday.png")
        self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        status, payload = self.json_request(f"/api/satellites/photo/trash/{photo['id']}/erase", "POST")

        self.assertEqual(status, 200)
        self.assertEqual(payload["erased"], photo["id"])
        self.assertEqual(self.json_request("/api/satellites/photo/trash")[1]["photos"], [])

        status, _ = self.json_request(f"/api/satellites/photo/trash/{photo['id']}/thumbnail")
        self.assertEqual(status, 404)

    def test_erasing_a_photo_that_is_not_trashed_is_a_404(self):
        photo = self.import_photo("holiday.png")

        status, payload = self.json_request(f"/api/satellites/photo/trash/{photo['id']}/erase", "POST")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_trash_route_rejects_other_methods(self):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        try:
            connection.request("DELETE", "/api/satellites/photo/trash")
            self.assertEqual(connection.getresponse().status, 405)
        finally:
            connection.close()

    def test_trashing_a_photo_keeps_its_album_membership(self):
        photo = self.import_photo("holiday.png")
        album = self.json_request("/api/satellites/photo/albums", "POST", {"name": "Trip"})[1]
        self.json_request(f"/api/satellites/photo/albums/{album['id']}/photos", "POST", {"photo_id": photo["id"]})

        self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")
        while_trashed = self.json_request(f"/api/satellites/photo/albums/{album['id']}")[1]

        self.json_request(f"/api/satellites/photo/trash/{photo['id']}/restore", "POST")
        after_restore = self.json_request(f"/api/satellites/photo/albums/{album['id']}")[1]

        # invisible while in the bin, but never dropped from the album...
        self.assertEqual(while_trashed["photo_ids"], [photo["id"]])
        self.assertEqual(while_trashed["photos"], [])
        # ...and back once restored
        self.assertEqual(after_restore["photo_ids"], [photo["id"]])
        self.assertEqual([entry["id"] for entry in after_restore["photos"]], [photo["id"]])

    def test_erasing_a_photo_eventually_prunes_it_from_its_albums(self):
        photo = self.import_photo("holiday.png")
        album = self.json_request("/api/satellites/photo/albums", "POST", {"name": "Trip"})[1]
        self.json_request(f"/api/satellites/photo/albums/{album['id']}/photos", "POST", {"photo_id": photo["id"]})
        self.json_request(f"/api/satellites/photo/trash/{photo['id']}", "POST")

        self.json_request(f"/api/satellites/photo/trash/{photo['id']}/erase", "POST")
        detail = self.json_request(f"/api/satellites/photo/albums/{album['id']}")[1]

        self.assertEqual(detail["photo_ids"], [])

    def test_the_retention_setting_is_configurable_through_the_generic_mechanism(self):
        status, payload = self.json_request(
            "/api/satellites/photo/configuration", "POST", {"key": "trash_retention_days", "value": 7})

        self.assertEqual(status, 200)
        by_key = {setting["key"]: setting for setting in payload["settings"]}
        self.assertEqual(by_key["trash_retention_days"]["value"], 7)
        self.assertIn("7 day", payload["note"])

        status, payload = self.json_request("/api/satellites/photo/trash")
        self.assertEqual(payload["retention_days"], 7)

    def test_an_invalid_retention_value_is_rejected(self):
        for bad in ("not-a-number", 0, -5):
            status, payload = self.json_request(
                "/api/satellites/photo/configuration", "POST", {"key": "trash_retention_days", "value": bad})
            self.assertEqual(status, 400)
            self.assertIn("error", payload)


if __name__ == "__main__":
    unittest.main()
