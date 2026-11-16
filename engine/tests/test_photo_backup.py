"""media.sync v1 in Photo (backup.py) and the Engine's device credentials.

The protocol: check, uploads resumed after a cut, a wrong offset, a wrong digest, the limits,
stale and surplus unfinished uploads, erased and protected media answered as known, a large
chunk never held in memory. The credential: issued to a session only, for a capability that
allows one, stored hashed, listed and revoked with the sessions, and reaching nothing but its
capability's routes.

Everything runs against temporary directories - a temp Photo library and a temp auth store -
never real data.
"""

from http.client import HTTPConnection
from importlib import import_module
from pathlib import Path
from unittest import mock
import hashlib
import io
import json
import os
import shutil
import tempfile
import time
import tracemalloc
import unittest

from starcore.auth import AuthStore
from tests.support import start_engine, stop_engine
from tests.test_photo import png


def module(name):
    return import_module(f"satellites.native.{name}")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class PhotoBackupTest(unittest.TestCase):
    def setUp(self):
        self.engine = start_engine(mission_control=True)
        if not self.engine.api.running:
            stop_engine(self.engine)
            raise unittest.SkipTest("Mission Control could not be started")
        self.photo = self.engine.registry.get("Photo")
        if self.photo is None:
            stop_engine(self.engine)
            raise unittest.SkipTest("Photo did not load")

        self.directory = Path(tempfile.mkdtemp(prefix="starcore-backup-"))
        self.photo.config.data.update({"storage": str(self.directory / "photo-data"), "photo_directory": "",
                                       "source_paths": [{"phone_path": "DCIM/Camera",
                                                         "server_path": "camera/pixel"}],
                                       "sync_default_path": "camera"})
        self.photo.config.path = self.directory / "photo-config.toml"
        self.engine.auth = AuthStore(self.directory / "auth.json")
        self.token = self.engine.auth.bootstrap("admin", "a very good password")

    def tearDown(self):
        stop_engine(self.engine)
        shutil.rmtree(self.directory, ignore_errors=True)

    # ---------- helpers ----------

    def request(self, path, method="GET", payload=None, token=None, body=None, content_type=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=30)
        headers = {}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif body is not None:
            headers["Content-Type"] = content_type or "application/octet-stream"
            headers["Content-Length"] = str(len(body.getbuffer()) if isinstance(body, io.BytesIO) else len(body))
        token = self.token if token is None else token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
        finally:
            connection.close()
        try:
            return response.status, json.loads(raw) if raw else {}
        except ValueError:
            return response.status, {}

    def backup(self, route, payload=None, token=None):
        return self.request(f"/api/satellites/photo/backup/{route}", "POST" if payload is not None else "GET",
                            payload, token)

    def send(self, digest, data, offset, size, token=None, **query):
        params = "&".join(f"{key}={value}" for key, value in {"offset": offset, "size": size, **query}.items())
        return self.request(f"/api/satellites/photo/backup/upload/{digest}?{params}", "POST", token=token,
                            body=data)

    def send_whole(self, data, token=None, **query):
        return self.send(sha(data), data, 0, len(data), token, **query)

    def library(self):
        return module("photo.library").library(self.photo)

    def import_files(self, *contents):
        source = self.directory / "import"
        source.mkdir(exist_ok=True)
        for index, data in enumerate(contents):
            (source / f"IMG_{index}.png").write_bytes(data)
        status, payload = self.request("/api/satellites/photo/import", "POST", {"source": str(source)})
        self.assertEqual(status, 200)
        return {photo["filename"]: photo["id"] for photo in payload["photos"]}

    def device(self, name="Pixel 8", capability="media.sync", token=None):
        return self.request("/api/auth/devices", "POST", {"capability": capability, "device_name": name}, token)

    # ---------- the protocol ----------

    def test_the_manifest_provides_media_sync(self):
        provided = self.photo.manifest.provides.get("media.sync")
        self.assertIsNotNone(provided)
        self.assertEqual(provided["version"], 1)
        self.assertEqual(set(provided["operations"]), {"status", "check", "upload", "devices"})

    def test_status_says_what_it_takes_and_names_the_device(self):
        status, payload = self.backup("status?device=Pixel%208")
        self.assertEqual(status, 200)
        self.assertEqual(payload["accepts"], ["image", "video"])
        self.assertEqual(payload["chunk_bytes"], module("photo.backup").CHUNK_BYTES)
        self.assertEqual(payload["max_bytes"], module("photo.backup").MAX_BYTES)
        self.assertEqual(payload["device"]["name"], "Pixel 8")
        self.assertEqual(payload["device"]["received"], 0)
        self.assertTrue(payload["device"]["last_seen"])

    def test_check_answers_known_and_wanted_without_saying_which(self):
        kept, binned, erased, new = (png(8 + index, 8, bytes([index * 50, 60, 90])) for index in range(4))
        ids = self.import_files(kept, binned, erased)
        for name in ("IMG_1.png", "IMG_2.png"):
            self.assertEqual(self.request(f"/api/satellites/photo/trash/{ids[name]}", "POST", {})[0], 200)
        self.assertEqual(self.request(f"/api/satellites/photo/trash/{ids['IMG_2.png']}/erase", "POST", {})[0], 200)

        too_large = "f" * 64
        items = [{"sha256": sha(data), "size": len(data)} for data in (kept, binned, erased, new)]
        items.append({"sha256": too_large, "size": module("photo.backup").MAX_BYTES + 1})
        items.append(items[3])  # a repeat is answered once
        status, payload = self.backup("check", {"device": "Pixel 8", "items": items})
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"known": [sha(kept), sha(binned), sha(erased)], "wanted": [sha(new)]})

    def test_check_refuses_a_malformed_request(self):
        for items in ([{"sha256": "ABC", "size": 1}], [{"sha256": "a" * 64, "size": -1}],
                      [{"sha256": "a" * 64, "size": True}], ["a" * 64], "nope"):
            status, _ = self.backup("check", {"items": items})
            self.assertEqual(status, 400, items)
        status, payload = self.backup("check", {"items": [{"sha256": "a" * 64, "size": 1}] * 501})
        self.assertEqual(status, 400)
        self.assertIn("500", payload["error"])

    def test_an_upload_resumes_after_a_cut_and_lands_in_its_album(self):
        data = png(40, 30, b"\x10\x80\xf0")
        digest, size = sha(data), len(data)
        a, b = size // 3, 2 * size // 3
        first, second, third = data[:a], data[a:b], data[b:]

        self.assertEqual(self.backup(f"upload/{digest}"), (200, {"offset": 0}))
        self.assertEqual(self.send(digest, first, 0, size), (200, {"offset": a}))
        # the client lost the answer: it asks where to go on from
        self.assertEqual(self.backup(f"upload/{digest}"), (200, {"offset": a}))

        # a wrong offset is refused with the right one, and nothing is written
        status, payload = self.send(digest, third, b, size)
        self.assertEqual(status, 409)
        self.assertEqual(payload["offset"], a)
        self.assertEqual(self.send(digest, second, a, size), (200, {"offset": b}))

        status, payload = self.send(digest, third, b, size, name="IMG_0042.png", folder="DCIM/Camera",
                                    taken="1700000000")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"status": "imported", "id": digest[:16], "offset": size})

        photo = self.library().get(digest[:16])
        self.assertEqual(photo["filename"], "IMG_0042.png")
        self.assertEqual(photo["physical_path"], "camera/pixel")
        self.assertEqual(self.backup(f"upload/{digest}"), (200, {"offset": 0}))  # nothing left aside
        self.assertEqual(self.backup("check", {"items": [{"sha256": digest, "size": size}]})[1]["known"], [digest])
        self.assertEqual(self.backup("status")[1]["device"]["received"], 1)

        # sent again in full: a duplicate, taken in once
        self.assertEqual(self.send_whole(data)[1]["status"], "duplicate")

    def test_a_folder_without_a_mapping_lands_in_the_default_album_and_a_video_keeps_its_date(self):
        data = png(12, 9, b"\x20\x20\x20")
        status, payload = self.send_whole(data, folder="Download", taken="1700000000")
        self.assertEqual((status, payload["status"]), (200, "imported"))
        photo = self.library().get(payload["id"])
        self.assertEqual(photo["physical_path"], "camera")
        # a PNG has no date of its own, so the one the device sent is kept
        self.assertTrue(photo["captured_at"].startswith("2023-11-1"))

    def test_a_file_that_does_not_match_its_digest_starts_again(self):
        data = png(16, 16, b"\x01\x02\x03")
        wrong = sha(data + b"x")
        status, payload = self.send(wrong, data, 0, len(data))
        self.assertEqual(status, 422)
        self.assertEqual(payload["offset"], 0)
        self.assertEqual(self.backup(f"upload/{wrong}"), (200, {"offset": 0}))
        self.assertEqual(self.library().count, 0)

    def test_a_file_the_library_cannot_read_is_refused(self):
        data = b"not a photo at all" * 10
        status, payload = self.send_whole(data)
        self.assertEqual(status, 415)
        self.assertEqual(self.backup(f"upload/{sha(data)}"), (200, {"offset": 0}))

    def test_the_limits(self):
        backup = module("photo.backup")
        data = png(16, 16)
        digest = sha(data)
        with mock.patch.object(backup, "MAX_BYTES", len(data) - 1):
            self.assertEqual(self.send(digest, data, 0, len(data))[0], 413)
        with mock.patch.object(backup, "CHUNK_BYTES", 10):
            self.assertEqual(self.send(digest, data[:11], 0, len(data))[0], 413)
        self.assertEqual(self.send(digest, data, 0, len(data) - 1)[0], 400)  # past the size
        self.assertEqual(self.send(digest, data, -1, len(data))[0], 400)
        self.assertEqual(self.send(digest, data, 0, "many")[0], 400)
        self.assertEqual(self.send("A" * 64, data, 0, len(data))[0], 400)
        # the bytes must not be read as JSON
        status, _ = self.request(f"/api/satellites/photo/backup/upload/{digest}?offset=0&size={len(data)}", "POST",
                                 payload={"bytes": "nope"})
        self.assertEqual(status, 415)
        with mock.patch.object(backup, "_free_space", return_value=0):
            self.assertEqual(self.send(digest, data[:10], 0, len(data))[0], 507)
        self.assertEqual(self.library().count, 0)

    def test_a_caller_keeps_at_most_four_unfinished_uploads(self):
        started = []
        for index in range(5):
            data = png(20 + index, 20)
            started.append(sha(data))
            self.assertEqual(self.send(sha(data), data[:10], 0, len(data)), (200, {"offset": 10}))
            time.sleep(0.02)  # each one later than the last
        offsets = [self.backup(f"upload/{digest}")[1]["offset"] for digest in started]
        self.assertEqual(offsets, [0, 10, 10, 10, 10])

        # another caller's are its own
        other = self.engine.auth.create_session("admin", kind="mobile")
        self.assertEqual(self.backup(f"upload/{started[1]}", token=other), (200, {"offset": 0}))

    def test_stale_unfinished_uploads_are_dropped(self):
        data = png(30, 30)
        digest = sha(data)
        self.send(digest, data[:10], 0, len(data))
        partial = next((self.library().root / "backup" / "partials").rglob("*.part"))
        old = time.time() - 8 * 86400
        os.utime(partial, (old, old))
        self.backup("status")
        self.assertFalse(partial.exists())
        self.assertEqual(self.backup(f"upload/{digest}"), (200, {"offset": 0}))

    def test_erased_media_is_never_taken_back_and_is_remembered(self):
        data = png(14, 14, b"\x05\x05\x05")
        photo_id = self.import_files(data)["IMG_0.png"]
        self.request(f"/api/satellites/photo/trash/{photo_id}", "POST", {})
        self.request(f"/api/satellites/photo/trash/{photo_id}/erase", "POST", {})
        self.assertIsNone(self.library().get_any(photo_id))

        self.assertEqual(self.send_whole(data), (200, {"status": "duplicate", "id": photo_id, "offset": len(data)}))
        self.assertIsNone(self.library().get_any(photo_id))

        # read back from disk by a new library
        again = module("photo.library").PhotoLibrary(self.library().root)
        self.assertTrue(again.knows(sha(data)))
        # a folder imported on purpose still takes it in
        self.assertEqual(len(self.import_files(data)), 1)

    def test_media_moved_somewhere_protected_is_known_and_never_taken_in(self):
        data = png(18, 18, b"\x09\x09\x09")
        digest = sha(data)
        private_media = module("photo.private_media")
        with mock.patch.object(private_media, "sealed", side_effect=lambda engine, value: value == digest):
            status, payload = self.backup("check", {"items": [{"sha256": digest, "size": len(data)}]})
            self.assertEqual(payload, {"known": [digest], "wanted": []})
            self.assertEqual(self.send_whole(data)[1]["status"], "duplicate")
        self.assertEqual(self.library().count, 0)

    def test_a_large_chunk_is_written_to_disk_without_being_held_in_memory(self):
        size = 24 * 1024 * 1024
        chunk = io.BytesIO(os.urandom(6 * 1024 * 1024))
        digest = "e" * 64
        tracemalloc.start()
        try:
            status, payload = self.send(digest, chunk, 0, size)
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual((status, payload), (200, {"offset": 6 * 1024 * 1024}))
        self.assertLess(peak, 3 * 1024 * 1024)

    def test_devices_lists_who_sent_what(self):
        self.backup("status?device=Laptop")
        _status, issued = self.device()
        self.backup("status?device=Pixel%208", token=issued["token"])
        self.send_whole(png(10, 11), token=issued["token"])

        status, payload = self.backup("devices")
        self.assertEqual(status, 200)
        by_name = {device["name"]: device for device in payload["devices"]}
        self.assertEqual(by_name["Pixel 8"]["kind"], "device")
        self.assertEqual(by_name["Pixel 8"]["received"], 1)
        self.assertFalse(by_name["Pixel 8"]["current"])
        self.assertTrue(by_name["Laptop"]["current"])

    # ---------- the device credential ----------

    def test_a_device_credential_reaches_only_its_capabilitys_routes(self):
        status, issued = self.device()
        self.assertEqual(status, 200)
        self.assertEqual(issued["provider"], "Photo")
        self.assertEqual(issued["capability"], "media.sync")
        self.assertEqual(issued["kind"], "device")
        self.assertIsNone(issued["expires"])
        self.assertEqual(issued["operations"]["upload"], "backup/upload")
        token = issued["token"]

        self.assertEqual(self.backup("status", token=token)[0], 200)
        data = png(22, 22, b"\x33\x44\x55")
        self.assertEqual(self.backup("check", {"items": [{"sha256": sha(data), "size": len(data)}]}, token=token)[0],
                         200)
        self.assertEqual(self.send_whole(data, token=token)[1]["status"], "imported")
        photo_id = sha(data)[:16]

        # it reads nothing, and manages nothing
        for path in ("/api/satellites/photo/photos", f"/api/satellites/photo/originals/{photo_id}",
                     f"/api/satellites/photo/thumbnails/{photo_id}", "/api/satellites/photo/media",
                     "/api/satellites/photo/gallery", "/api/satellites/photo/ui", "/api/satellites/photo",
                     "/api/satellites/photo/backupx/status", "/api/satellites/photo/backup%2Fstatus",
                     "/api/catalog", "/api/status", "/api/satellites", "/api/auth/sessions",
                     "/api/satellites/LockedFolder/status", "/api/satellites/FileExplorer/roots"):
            self.assertEqual(self.request(path, token=token)[0], 403, path)
        for path, payload in (("/api/auth/devices", {"capability": "media.sync"}),
                              ("/api/auth/sessions/revoke", {"session_id": issued["session_id"]}),
                              ("/api/satellites/photo/disable", {}), ("/api/satellites/photo/import", {}),
                              (f"/api/satellites/photo/trash/{photo_id}", {})):
            self.assertEqual(self.request(path, "POST", payload, token)[0], 403, path)
        # the provider refuses it the devices list
        self.assertEqual(self.backup("devices", token=token)[0], 403)
        self.assertIsNotNone(self.library().get(photo_id))
        # and it is not a session
        self.assertEqual(self.request("/api/auth/status", token=token)[1]["authenticated"], False)

    def test_only_a_session_gets_one_and_only_for_a_capability_that_allows_it(self):
        self.assertEqual(self.device(token="not-a-token")[0], 401)
        self.assertEqual(self.device(capability="media.gallery")[0], 400)
        self.assertEqual(self.device(capability="files.browse")[0], 400)
        self.assertEqual(self.device(capability="nothing.here")[0], 400)
        self.assertEqual(self.request("/api/auth/devices")[0], 405)

    def test_it_is_listed_and_revoked_with_the_sessions(self):
        _status, issued = self.device("Pixel 8")
        status, payload = self.request("/api/auth/sessions")
        listed = [entry for entry in payload["sessions"] if entry["kind"] == "device"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["device_name"], "Pixel 8")
        self.assertEqual(listed[0]["capability"], "media.sync")
        self.assertNotIn(issued["token"], json.dumps(payload))

        self.assertEqual(self.request("/api/auth/sessions/revoke", "POST",
                                      {"session_id": listed[0]["session_id"]})[0], 200)
        self.assertEqual(self.backup("status", token=issued["token"])[0], 401)

    def test_it_is_stored_hashed_never_expires_and_survives_a_restart(self):
        _status, issued = self.device()
        token = issued["token"]
        stored = (self.directory / "auth.json").read_text(encoding="utf-8")
        self.assertNotIn(token, stored)
        self.assertIn(hashlib.sha256(token.encode("utf-8")).hexdigest(), stored)

        self.engine.auth = AuthStore(self.directory / "auth.json")
        later = time.time() + 400 * 86400
        with mock.patch("starcore.auth.time.time", return_value=later):
            self.assertEqual(self.backup("status", token=token)[0], 200)

    def test_there_is_a_limit_on_device_credentials(self):
        auth = module_auth()
        with mock.patch.object(auth, "DEVICE_LIMIT", 2):
            self.assertEqual(self.device("one")[0], 200)
            self.assertEqual(self.device("two")[0], 200)
            self.assertEqual(self.device("three")[0], 409)


def module_auth():
    return import_module("starcore.auth")


if __name__ == "__main__":
    unittest.main()
