"""The Locked Folder as a private area inside Photos: settings that can't be
changed without the PIN, brute-force limits that survive new sessions,
fail-closed PIN storage, server-verified biometric unlock, private media
kept out of Photos, and verified moves with rollback.

Everything runs against temporary directories - a temp Photo library, a
temp vault and a temp Locked Folder store - never real data.
"""

from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from importlib import import_module
from pathlib import Path
from unittest import mock
import base64
import hashlib
import json
import os
import random
import shutil
import tempfile
import unittest

from starcore.auth import AuthStore, hash_secret
from tests.support import start_engine, stop_engine
from tests.test_photo import png


def module(name):
    return import_module(f"satellites.native.{name}")


# ---------- a test RSA key, generated here so no crypto library is needed ----------

def _probable_prime(bits: int, rng: random.Random) -> int:
    small = [3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]
    while True:
        candidate = rng.getrandbits(bits) | (1 << (bits - 1)) | 1
        if any(candidate % prime == 0 for prime in small):
            continue
        d, r = candidate - 1, 0
        while d % 2 == 0:
            d //= 2
            r += 1
        for _ in range(24):
            x = pow(rng.randrange(2, candidate - 2), d, candidate)
            if x in (1, candidate - 1):
                continue
            for _ in range(r - 1):
                x = pow(x, 2, candidate)
                if x == candidate - 1:
                    break
            else:
                break
        else:
            return candidate


def _der(tag: int, content: bytes) -> bytes:
    length = len(content)
    if length < 0x80:
        encoded = bytes([length])
    else:
        raw = length.to_bytes((length.bit_length() + 7) // 8, "big")
        encoded = bytes([0x80 | len(raw)]) + raw
    return bytes([tag]) + encoded + content


def _der_int(value: int) -> bytes:
    raw = value.to_bytes(value.bit_length() // 8 + 1, "big")
    return _der(0x02, raw)


class TestKey:
    def __init__(self, bits: int = 2048, seed: int = 1):
        rng = random.Random(seed)
        e = 65537
        while True:
            p = _probable_prime(bits // 2, rng)
            q = _probable_prime(bits // 2, rng)
            n = p * q
            phi = (p - 1) * (q - 1)
            if p != q and n.bit_length() == bits and phi % e:
                break
        self.n, self.e, self.d = n, e, pow(e, -1, phi)

    def public_der(self) -> bytes:
        rsa = _der(0x30, _der_int(self.n) + _der_int(self.e))
        algorithm = _der(0x30, _der(0x06, bytes.fromhex("2a864886f70d010101")) + b"\x05\x00")
        return _der(0x30, algorithm + _der(0x03, b"\x00" + rsa))

    def sign(self, message: bytes) -> bytes:
        size = (self.n.bit_length() + 7) // 8
        encoded = module("locked_folder.signatures").expected_encoding(message, size)
        return pow(int.from_bytes(encoded, "big"), self.d, self.n).to_bytes(size, "big")


_KEYS = {}


def test_key(seed: int = 1, bits: int = 2048) -> TestKey:
    if (seed, bits) not in _KEYS:
        _KEYS[(seed, bits)] = TestKey(bits, seed)
    return _KEYS[(seed, bits)]


def b64(data: bytes) -> str:
    # wrapped like Android's Base64.DEFAULT, which the server must accept
    text = base64.b64encode(data).decode("ascii")
    return "\n".join(text[index:index + 76] for index in range(0, len(text), 76)) + "\n"


class LockedFolderSecurityTest(unittest.TestCase):
    def setUp(self):
        self.engine = start_engine(mission_control=True)
        if not self.engine.api.running:
            stop_engine(self.engine)
            raise unittest.SkipTest("Mission Control could not be started")

        self.locked_folder = self.engine.registry.get("LockedFolder")
        self.photo = self.engine.registry.get("Photo")
        self.file_explorer = self.engine.registry.get("FileExplorer")
        if None in (self.locked_folder, self.photo, self.file_explorer):
            stop_engine(self.engine)
            raise unittest.SkipTest("LockedFolder, Photo or FileExplorer did not load")

        self.directory = Path(tempfile.mkdtemp(prefix="starcore-lf-security-"))
        self.vault = self.directory / "vault"
        self.vault.mkdir()

        self.locked_folder.config.data.update({
            "storage": str(self.directory / "lf-data"),
            "locked_folder_path": "",
            "session_timeout_seconds": 900,
            "max_pin_attempts": 5,
            "lockout_seconds": 300,
        })
        self.locked_folder.config.path = self.directory / "lf-config.toml"
        self.photo.config.data.update({"storage": str(self.directory / "photo-data"), "photo_directory": ""})
        self.photo.config.path = self.directory / "photo-config.toml"

        self.engine.auth = AuthStore(self.directory / "auth.json")
        self.token = self.engine.auth.bootstrap("admin", "a very good password")

    def tearDown(self):
        stop_engine(self.engine)
        shutil.rmtree(self.directory, ignore_errors=True)

    # ---------- helpers ----------

    def request(self, path, method="GET", payload=None, token=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        token = self.token if token is None else token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, raw, dict(response.getheaders())
        finally:
            connection.close()

    def call(self, path, method="GET", payload=None, token=None):
        status, raw, _ = self.request(path, method, payload, token)
        try:
            return status, json.loads(raw) if raw else {}
        except ValueError:
            return status, {}

    def lf(self, route, payload=None, token=None, method=None):
        return self.call(f"/api/satellites/LockedFolder/{route}",
                         method or ("POST" if payload is not None else "GET"), payload, token)

    def setup_vault(self, pin="2468"):
        status, _ = self.lf("configuration", {"key": "locked_folder_path", "value": str(self.vault)})
        self.assertEqual(status, 200)
        status, _ = self.lf("pin", {"pin": pin})
        self.assertEqual(status, 200)

    def unlock(self, pin="2468", token=None):
        return self.lf("unlock", {"pin": pin}, token=token)

    def runtime(self):
        return module("locked_folder.runtime").runtime(self.locked_folder)

    def library(self):
        return module("photo.library").library(self.photo)

    def import_photos(self, count=3):
        source = self.directory / "camera"
        source.mkdir(exist_ok=True)
        for index in range(count):
            (source / f"IMG_{index}.png").write_bytes(png(8 + index, 8, bytes([index * 40, 60, 90])))
        status, payload = self.call("/api/satellites/Photo/import", "POST", {"source": str(source)})
        self.assertEqual(status, 200)
        return [photo["id"] for photo in payload["photos"]]

    # ---------- settings need the PIN once one is set ----------

    def test_vault_settings_cannot_be_changed_while_locked(self):
        self.setup_vault()
        elsewhere = self.directory / "elsewhere"
        elsewhere.mkdir()
        for key, value in (("locked_folder_path", str(elsewhere)), ("locked_folder_path", ""),
                           ("max_pin_attempts", 20), ("lockout_seconds", 10), ("session_timeout_seconds", 86400)):
            status, payload = self.lf("configuration", {"key": key, "value": value})
            self.assertEqual(status, 403, key)
        status, _ = self.lf("delink", {})
        self.assertEqual(status, 403)
        self.assertEqual(self.runtime().configured_root, self.vault.resolve())

        # once unlocked, the owner can change them as before
        self.unlock()
        status, _ = self.lf("configuration", {"key": "max_pin_attempts", "value": 3})
        self.assertEqual(status, 200)

    def test_a_locked_vault_cannot_be_reached_by_repointing_it(self):
        (self.vault / "private.txt").write_text("private", encoding="utf-8")
        self.setup_vault()
        self.lf("configuration", {"key": "locked_folder_path", "value": ""})
        status, _ = self.call(f"/api/satellites/FileExplorer/entries?path={self.vault}")
        self.assertEqual(status, 403)

    # ---------- brute force ----------

    def test_fresh_sessions_cannot_reset_the_pin_limit(self):
        self.setup_vault()
        self.locked_folder.config.data["max_pin_attempts"] = 2
        threshold = 2 * module("locked_folder.runtime").GLOBAL_ATTEMPT_FACTOR
        for _ in range(threshold // 2):
            session = self.engine.auth.create_session("admin")
            for _ in range(2):
                status, _ = self.unlock("0000", token=session)
                self.assertEqual(status, 401)

        # every session is now refused, even a brand new one with the right PIN
        status, payload = self.unlock("2468", token=self.engine.auth.create_session("admin"))
        self.assertEqual(status, 429)
        self.assertGreater(payload["retry_after"], 0)

    def test_parallel_guesses_cannot_exceed_the_limit(self):
        self.setup_vault()
        self.locked_folder.config.data["max_pin_attempts"] = 3
        with ThreadPoolExecutor(max_workers=12) as pool:
            statuses = list(pool.map(lambda _: self.unlock("0000")[0], range(12)))
        self.assertLessEqual(statuses.count(401), 3)
        self.assertEqual(statuses.count(401) + statuses.count(429), 12)

    def test_a_wrong_current_pin_counts_toward_the_limit(self):
        self.setup_vault()
        self.locked_folder.config.data["max_pin_attempts"] = 2
        for _ in range(2):
            status, _ = self.lf("pin", {"pin": "9999", "current_pin": "0000"})
            self.assertEqual(status, 401)
        status, _ = self.lf("pin", {"pin": "9999", "current_pin": "2468"})
        self.assertEqual(status, 429)

    # ---------- PIN storage ----------

    def test_an_existing_pin_file_keeps_working_unchanged(self):
        storage = self.directory / "lf-data"
        storage.mkdir()
        salt = os.urandom(16)
        stored = json.dumps({"salt": salt.hex(), "hash": hash_secret("13579", salt)})
        (storage / "pin.json").write_text(stored, encoding="utf-8")
        self.lf("configuration", {"key": "locked_folder_path", "value": str(self.vault)})

        status, _ = self.unlock("13579")
        self.assertEqual(status, 200)
        self.assertEqual((storage / "pin.json").read_text(encoding="utf-8"), stored)

    def test_an_unreadable_pin_file_keeps_the_vault_locked(self):
        storage = self.directory / "lf-data"
        storage.mkdir()
        (storage / "pin.json").write_text("{not json", encoding="utf-8")
        self.locked_folder.config.data["locked_folder_path"] = str(self.vault)

        status, payload = self.lf("status")
        self.assertTrue(payload["pin_set"])
        self.assertTrue(payload["pin_unreadable"])
        self.assertEqual(self.lf("pin", {"pin": "1111"})[0], 409, "a new PIN must not replace an unreadable one")
        self.assertEqual(self.unlock("1111")[0], 409)
        self.assertEqual(self.call(f"/api/satellites/FileExplorer/entries?path={self.vault}")[0], 403)

    def test_the_pin_never_appears_in_responses_or_storage(self):
        self.setup_vault("80864213")
        responses = [self.request("/api/satellites/LockedFolder/status")[1],
                     self.request("/api/satellites/LockedFolder/unlock", "POST", {"pin": "80864213"})[1],
                     self.request("/api/satellites/LockedFolder/configuration")[1]]
        for raw in responses:
            self.assertNotIn(b"80864213", raw)
        for path in (self.directory / "lf-data").iterdir():
            self.assertNotIn(b"80864213", path.read_bytes(), path.name)

    # ---------- unauthorized access ----------

    def test_vault_routes_refuse_a_locked_or_missing_session(self):
        self.setup_vault()
        (self.vault / "a.png").write_bytes(png(4, 4))
        ids = self.import_photos(1)
        for method, route, payload in (("GET", "media", None), ("GET", "media/file?path=a.png", None),
                                       ("POST", "move_in", {"photo_ids": ids}),
                                       ("POST", "move_out", {"paths": ["a.png"]})):
            status, _ = self.lf(route, payload, method=method)
            self.assertEqual(status, 403, route)
            status, _, _ = self.request(f"/api/satellites/LockedFolder/{route}", method, payload, token="")
            self.assertEqual(status, 401, route)
        self.assertTrue((self.vault / "a.png").is_file())
        self.assertIsNotNone(self.library().get(ids[0]))

    def test_another_sessions_unlock_grants_nothing_here(self):
        self.setup_vault()
        other = self.engine.auth.create_session("admin")
        self.unlock(token=other)
        self.assertEqual(self.lf("media")[0], 403)

    def test_media_cannot_escape_the_vault(self):
        self.setup_vault()
        self.unlock()
        (self.directory / "outside.txt").write_text("outside", encoding="utf-8")
        for path in ("../outside.txt", str(self.directory / "outside.txt"), "", "."):
            status, _ = self.lf(f"media/file?path={path}")
            self.assertIn(status, (400, 403, 404), path)

    def test_vault_files_are_served_without_caching(self):
        self.setup_vault()
        self.unlock()
        (self.vault / "a.png").write_bytes(png(4, 4))
        status, raw, headers = self.request("/api/satellites/LockedFolder/media/file?path=a.png")
        self.assertEqual(status, 200)
        self.assertEqual(raw, (self.vault / "a.png").read_bytes())
        self.assertIn("no-store", headers.get("Cache-Control", ""))

    def test_media_lists_vault_files_once_unlocked(self):
        self.setup_vault()
        self.unlock()
        (self.vault / "a.png").write_bytes(png(4, 4))
        (self.vault / "notes.txt").write_text("x", encoding="utf-8")
        (self.vault / ".hidden.png").write_bytes(png(4, 4))
        status, payload = self.lf("media")
        self.assertEqual(status, 200)
        kinds = {item["path"]: item["media_type"] for item in payload["items"]}
        self.assertEqual(kinds, {"a.png": "photo", "notes.txt": "file"})

    # ---------- File Explorer ----------

    def test_folders_containing_the_vault_cannot_be_renamed_or_deleted_while_locked(self):
        parent = self.directory / "parent"
        parent.mkdir()
        nested = parent / "vault"
        nested.mkdir()
        (nested / "private.txt").write_text("private", encoding="utf-8")
        self.lf("configuration", {"key": "locked_folder_path", "value": str(nested)})
        self.lf("pin", {"pin": "2468"})

        status, _ = self.call("/api/satellites/FileExplorer/rename", "POST", {"path": str(parent), "name": "moved"})
        self.assertEqual(status, 403)
        status, _ = self.call("/api/satellites/FileExplorer/delete", "POST", {"path": str(parent)})
        self.assertEqual(status, 403)
        self.assertTrue((nested / "private.txt").is_file())

        self.unlock()
        status, _ = self.call("/api/satellites/FileExplorer/rename", "POST", {"path": str(parent), "name": "moved"})
        self.assertEqual(status, 200)

    def test_the_guard_works_before_anything_else_touched_the_locked_folder(self):
        # the configuration a restart would read, with no runtime created yet
        self.locked_folder.config.data["locked_folder_path"] = str(self.vault)
        if hasattr(self.locked_folder, "locked_folder_runtime"):
            del self.locked_folder.locked_folder_runtime
        status, _ = self.call(f"/api/satellites/FileExplorer/entries?path={self.vault}")
        self.assertEqual(status, 403)

    # ---------- private media stays out of Photos ----------

    def test_photos_refuses_to_import_the_vault(self):
        self.setup_vault()
        (self.vault / "private.png").write_bytes(png(5, 5))
        status, payload = self.call("/api/satellites/Photo/import", "POST", {"source": str(self.vault)})
        self.assertEqual(status, 400)
        status, _ = self.call("/api/satellites/Photo/scan", "POST", {"source": str(self.vault)})
        self.assertEqual(status, 400)
        self.assertEqual(self.library().count, 0)

    def test_importing_a_parent_folder_skips_the_vault(self):
        parent = self.directory / "pictures"
        nested = parent / "vault"
        nested.mkdir(parents=True)
        (parent / "public.png").write_bytes(png(6, 6, b"\x10\x20\x30"))
        (nested / "private.png").write_bytes(png(7, 7, b"\x90\x20\x30"))
        self.lf("configuration", {"key": "locked_folder_path", "value": str(nested)})

        status, payload = self.call("/api/satellites/Photo/import", "POST", {"source": str(parent)})
        self.assertEqual(status, 200)
        self.assertEqual([photo["filename"] for photo in payload["photos"]], ["public.png"])

    # ---------- moves ----------

    def test_moving_a_photo_in_takes_it_out_of_photos_completely(self):
        ids = self.import_photos(2)
        library = self.library()
        original = library.original_path(library.get(ids[0])).read_bytes()
        status, _ = self.call("/api/satellites/Photo/albums/favorites/photos", "POST", {"photo_id": ids[0]})
        self.assertEqual(status, 200)
        self.setup_vault()
        self.unlock()

        status, payload = self.lf("move_in", {"photo_ids": [ids[0]]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["failed"], [])
        moved = self.vault / payload["moved"][0]["path"]
        self.assertEqual(moved.read_bytes(), original)

        self.assertIsNone(library.get_any(ids[0]))
        _, listing = self.call("/api/satellites/Photo/photos")
        self.assertNotIn(ids[0], json.dumps(listing))
        _, albums = self.call("/api/satellites/Photo/albums")
        self.assertNotIn(ids[0], json.dumps(albums))
        stored = module("photo.albums").albums(self.photo).get("favorites")
        self.assertNotIn(ids[0], stored["photo_ids"], "no album keeps pointing at a private photo")
        self.assertEqual(self.request(f"/api/satellites/Photo/thumbnails/{ids[0]}")[0], 404)
        self.assertEqual(self.request(f"/api/satellites/Photo/originals/{ids[0]}")[0], 404)
        self.assertEqual(list(self.vault.rglob("*.part")), [])

    def test_a_moved_photo_is_not_taken_back_by_import_or_sync(self):
        ids = self.import_photos(1)
        library = self.library()
        data = library.original_path(library.get(ids[0])).read_bytes()
        self.setup_vault()
        self.unlock()
        self.lf("move_in", {"photo_ids": ids})

        again = self.directory / "again"
        again.mkdir()
        (again / "copy.png").write_bytes(data)
        status, payload = self.call("/api/satellites/Photo/import", "POST", {"source": str(again)})
        self.assertEqual((status, payload["imported"], payload["duplicates"]), (200, 0, 1))

        sync = module("photo.sync")
        service = sync.SyncService(library, "127.0.0.1", 0, "token", 1024 * 1024)
        service.private = lambda: module("photo.private_media").policy(self.engine)
        self.assertEqual(service.accept(data, "copy.png")["status"], "duplicate")
        self.assertIsNone(library.get(ids[0]))

    def test_a_failed_copy_leaves_the_photo_where_it_was(self):
        ids = self.import_photos(1)
        self.setup_vault()
        self.unlock()
        vault = module("locked_folder.vault")
        real_digest = vault.digest
        calls = []

        def corrupt_second_read(path):
            calls.append(path)
            return real_digest(path) if len(calls) == 1 else "0" * 64

        with mock.patch.object(vault, "digest", corrupt_second_read):
            status, payload = self.lf("move_in", {"photo_ids": ids})
        self.assertEqual(status, 409)
        self.assertEqual(payload["moved"], [])
        self.assertIsNotNone(self.library().get(ids[0]))
        self.assertEqual([path for path in self.vault.rglob("*") if path.is_file()], [])
        self.assertFalse(self.runtime().is_sealed(real_digest(self.library().original_path(self.library().get(ids[0])))))

    def test_a_failure_after_copying_rolls_the_copy_back(self):
        ids = self.import_photos(1)
        self.setup_vault()
        self.unlock()
        library = self.library()
        with mock.patch.object(type(library), "remove_moved", side_effect=OSError("disk full")):
            status, payload = self.lf("move_in", {"photo_ids": ids})
        self.assertEqual(status, 409)
        self.assertIsNotNone(library.get(ids[0]))
        self.assertEqual([path for path in self.vault.rglob("*") if path.is_file()], [])

    def test_moving_out_puts_the_file_back_in_photos(self):
        ids = self.import_photos(1)
        self.setup_vault()
        self.unlock()
        _, moved = self.lf("move_in", {"photo_ids": ids})
        relative = moved["moved"][0]["path"]

        status, payload = self.lf("move_out", {"paths": [relative]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["moved"][0]["id"], ids[0])
        self.assertFalse((self.vault / relative).exists())
        self.assertIsNotNone(self.library().get(ids[0]))
        self.assertEqual(self.runtime()._sealed, set())

    def test_a_file_photos_cannot_read_stays_in_the_vault(self):
        self.setup_vault()
        self.unlock()
        (self.vault / "notes.txt").write_text("not a photo", encoding="utf-8")
        status, payload = self.lf("move_out", {"paths": ["notes.txt"]})
        self.assertEqual(status, 409)
        self.assertTrue((self.vault / "notes.txt").is_file())
        self.assertEqual(self.library().count, 0)

    def test_a_failed_move_out_keeps_the_original(self):
        self.setup_vault()
        self.unlock()
        (self.vault / "a.png").write_bytes(png(9, 9))
        library = self.library()
        with mock.patch.object(type(library), "add_file", side_effect=OSError("disk full")):
            status, _ = self.lf("move_out", {"paths": ["a.png"]})
        self.assertEqual(status, 409)
        self.assertTrue((self.vault / "a.png").is_file())

    # ---------- biometric unlock ----------

    def enroll(self, key=None, pin="2468"):
        key = key or test_key()
        return self.lf("biometric/enroll", {"pin": pin, "public_key": b64(key.public_der()), "device_name": "Pixel"})

    def biometric_unlock(self, key_id, key=None, token=None, tamper=False):
        key = key or test_key()
        status, payload = self.lf("biometric/challenge", {"key_id": key_id}, token=token)
        if status != 200:
            return status, payload
        challenge = payload["challenge"]
        signature = key.sign((challenge + ("x" if tamper else "")).encode("utf-8"))
        return self.lf("biometric/unlock", {"key_id": key_id, "challenge": challenge,
                                            "signature": b64(signature)}, token=token)

    def test_biometric_enrollment_needs_the_pin(self):
        self.setup_vault()
        status, _ = self.enroll(pin="0000")
        self.assertEqual(status, 401)
        status, payload = self.enroll()
        self.assertEqual(status, 200)
        self.assertTrue(payload["key_id"])
        self.assertEqual(self.lf("status")[1]["biometric_devices"], 1)

    def test_a_valid_biometric_signature_unlocks_this_session_only(self):
        self.setup_vault()
        key_id = self.enroll()[1]["key_id"]
        status, payload = self.biometric_unlock(key_id)
        self.assertEqual(status, 200)
        self.assertTrue(payload["unlocked"])
        self.assertEqual(self.lf("media")[0], 200)
        other = self.engine.auth.create_session("admin")
        self.assertEqual(self.lf("media", token=other)[0], 403)

    def test_a_bad_or_replayed_signature_is_refused(self):
        self.setup_vault()
        key_id = self.enroll()[1]["key_id"]
        self.assertEqual(self.biometric_unlock(key_id, tamper=True)[0], 401)
        self.assertEqual(self.biometric_unlock(key_id, key=test_key(seed=2))[0], 401)

        _, payload = self.lf("biometric/challenge", {"key_id": key_id})
        signature = b64(test_key().sign(payload["challenge"].encode()))
        body = {"key_id": key_id, "challenge": payload["challenge"], "signature": signature}
        self.assertEqual(self.lf("biometric/unlock", body)[0], 200)
        self.lf("lock", {})
        self.assertEqual(self.lf("biometric/unlock", body)[0], 401, "a challenge works once")
        self.assertFalse(self.lf("status")[1]["unlocked"])

    def test_a_challenge_belongs_to_the_session_that_asked(self):
        self.setup_vault()
        key_id = self.enroll()[1]["key_id"]
        _, payload = self.lf("biometric/challenge", {"key_id": key_id})
        other = self.engine.auth.create_session("admin")
        body = {"key_id": key_id, "challenge": payload["challenge"],
                "signature": b64(test_key().sign(payload["challenge"].encode()))}
        self.assertEqual(self.lf("biometric/unlock", body, token=other)[0], 401)

    def test_failed_biometric_attempts_count_toward_the_limit(self):
        self.setup_vault()
        self.locked_folder.config.data["max_pin_attempts"] = 2
        key_id = self.enroll()[1]["key_id"]
        for _ in range(2):
            self.assertEqual(self.biometric_unlock(key_id, tamper=True)[0], 401)
        self.assertEqual(self.biometric_unlock(key_id)[0], 429)

    def test_changing_the_pin_removes_biometric_enrollments(self):
        self.setup_vault()
        key_id = self.enroll()[1]["key_id"]
        self.lf("pin", {"pin": "1357", "current_pin": "2468"})
        self.assertEqual(self.lf("biometric/challenge", {"key_id": key_id})[0], 404)

    def test_a_revoked_device_can_no_longer_unlock(self):
        self.setup_vault()
        key_id = self.enroll()[1]["key_id"]
        self.assertEqual(self.lf("biometric/revoke", {"key_id": key_id})[0], 200)
        self.assertEqual(self.biometric_unlock(key_id)[0], 404)

    def test_weak_or_malformed_keys_are_refused(self):
        self.setup_vault()
        self.assertEqual(self.enroll(key=test_key(seed=3, bits=1024))[0], 400)
        self.assertEqual(self.lf("biometric/enroll", {"pin": "2468", "public_key": b64(b"nonsense")})[0], 400)
        self.assertEqual(self.lf("biometric/enroll", {"pin": "2468", "public_key": "%%%"})[0], 400)

    # ---------- navigation ----------

    def test_the_locked_folder_is_described_as_a_section_of_photo(self):
        status, payload = self.call("/api/satellites")
        described = {satellite["name"]: satellite for satellite in payload["satellites"]}
        self.assertEqual(described["LockedFolder"]["section_of"], "Photo")
        self.assertIsNone(described["Photo"]["section_of"])

    # ---------- single-use grants for one move, and references (M5) ----------

    def ref(self, photo_id, **changes):
        return {"provider": "Photo", "capability": "media.gallery", "id": photo_id, **changes}

    def grant_for(self, photo_ids, pin="2468", token=None):
        return self.lf("unlock", {"pin": pin, "for": {"operation": "move_in", "items": [self.ref(i) for i in photo_ids]}},
                       token=token)

    def move(self, photo_ids, grant=None, token=None):
        body = {"items": [self.ref(i) for i in photo_ids]}
        if grant is not None:
            body["grant"] = grant
        return self.lf("move_in", body, token=token)

    def test_a_grant_moves_exactly_its_items_once_without_unlocking_the_vault(self):
        self.setup_vault()
        first, second, _third = self.import_photos()
        status, payload = self.grant_for([first])
        self.assertEqual(status, 200)
        self.assertFalse(payload["unlocked"])
        self.assertTrue(payload["grant"] and payload["expires_at"])
        # not an unlock: the vault still refuses this session everything else
        self.assertFalse(self.lf("status")[1]["unlocked"])
        for route, body in (("media", None), ("media/file?path=Photos/x.png", None), ("move_out", {"paths": ["x"]}),
                            ("delete", {"paths": ["x"]}), ("encryption", None)):
            self.assertEqual(self.lf(route, body)[0], 403, route)

        status, payload = self.move([first], payload["grant"])
        self.assertEqual(status, 200, payload)
        self.assertEqual([item["id"] for item in payload["moved"]], [first])
        self.assertIsNone(self.library().get(first))
        self.assertFalse(self.lf("status")[1]["unlocked"], "nothing to lock again afterwards")

    def test_a_grant_is_used_up_by_the_first_request_whatever_it_asks(self):
        self.setup_vault()
        first, second, _third = self.import_photos()
        grant = self.grant_for([first])[1]["grant"]
        # another item than the granted one: refused, and the grant is gone
        self.assertEqual(self.move([second], grant)[0], 403)
        self.assertEqual(self.move([first], grant)[0], 403)
        # a superset is refused too
        grant = self.grant_for([first])[1]["grant"]
        self.assertEqual(self.move([first, second], grant)[0], 403)
        self.assertEqual(self.move([first], grant)[0], 403)
        # a request refused for its references uses it up as well
        grant = self.grant_for([first])[1]["grant"]
        self.assertEqual(self.lf("move_in", {"items": [self.ref(first, provider="Elsewhere")], "grant": grant})[0], 400)
        self.assertEqual(self.move([first], grant)[0], 403)
        # replayed after a successful move: nothing left to use
        grant = self.grant_for([first])[1]["grant"]
        self.assertEqual(self.move([first], grant)[0], 200)
        self.assertEqual(self.move([first], grant)[0], 400, "already moved, so no longer a reference")
        self.assertIsNotNone(self.library().get(second))

    def test_a_grant_belongs_to_the_session_that_asked(self):
        self.setup_vault()
        first, *_ = self.import_photos()
        grant = self.grant_for([first])[1]["grant"]
        other = self.engine.auth.create_session("admin")
        self.assertEqual(self.move([first], grant, token=other)[0], 403)
        self.assertEqual(self.move([first], grant)[0], 403, "presented once, by anyone, it is gone")
        self.assertIsNotNone(self.library().get(first))

    def test_concurrent_requests_with_one_grant_move_at_most_once(self):
        self.setup_vault()
        photos = self.import_photos(3)
        grant = self.grant_for(photos[:1])[1]["grant"]
        with ThreadPoolExecutor(max_workers=6) as pool:
            statuses = list(pool.map(lambda _: self.move(photos[:1], grant)[0], range(6)))
        self.assertEqual(statuses.count(200), 1, statuses)
        self.assertTrue(all(status in (200, 400, 403) for status in statuses), statuses)

    def test_an_expired_grant_moves_nothing(self):
        self.setup_vault()
        first, *_ = self.import_photos()
        grant = self.grant_for([first])[1]["grant"]
        runtime_module = module("locked_folder.runtime")
        later = runtime_module.time.time() + runtime_module.GRANT_SECONDS + 1
        with mock.patch.object(runtime_module.time, "time", return_value=later):
            self.assertEqual(self.move([first], grant)[0], 403)
        self.assertIsNotNone(self.library().get(first))

    def test_a_changed_pin_or_location_drops_every_grant(self):
        self.setup_vault()
        first, *_ = self.import_photos()
        grant = self.grant_for([first])[1]["grant"]
        self.runtime().forget_all_unlocks()  # what a PIN change and a new location do
        self.assertEqual(self.move([first], grant)[0], 403)

    def test_locking_drops_the_sessions_grants_too(self):
        self.setup_vault()
        first, *_ = self.import_photos()
        grant = self.grant_for([first])[1]["grant"]
        other = self.engine.auth.create_session("admin")
        kept = self.lf("unlock", {"pin": "2468", "for": {"operation": "move_in", "items": [self.ref(first)]}}, token=other)[1]["grant"]
        self.assertEqual(self.lf("lock", {})[0], 200)
        self.assertEqual(self.move([first], grant)[0], 403)
        self.assertEqual(self.move([first], kept, token=other)[0], 200, "another session's grant is its own")

    def test_a_grant_needs_the_right_pin_and_counts_attempts(self):
        self.setup_vault()
        first, *_ = self.import_photos()
        status, payload = self.grant_for([first], pin="0000")
        self.assertEqual(status, 401)
        self.assertNotIn("grant", payload)
        for _ in range(4):
            self.grant_for([first], pin="0000")
        self.assertEqual(self.grant_for([first])[0], 429, "locked out like any unlock")

    def test_references_are_resolved_on_the_server_never_trusted(self):
        self.setup_vault()
        first, second, binned = self.import_photos()
        self.assertEqual(self.call(f"/api/satellites/Photo/trash/{binned}", "POST")[0], 200)
        forged = [
            self.ref(first, provider="Elsewhere"),       # a provider other than the one the Engine knows
            self.ref(first, capability="media.vault"),   # another capability
            self.ref("0" * 64),                          # no such photo
            self.ref(binned),                            # in the recycle bin
            self.ref("../../etc"),                       # not an item id
            {**self.ref(first), "path": "/srv/x"},       # not a reference
        ]
        for reference in forged:
            body = {"pin": "2468", "for": {"operation": "move_in", "items": [self.ref(second), reference]}}
            status, payload = self.lf("unlock", body)
            self.assertEqual(status, 400, reference)
            self.assertNotIn("grant", payload)
        self.assertEqual(self.lf("unlock", {"pin": "2468", "for": {"operation": "move_out", "items": [self.ref(first)]}})[0], 400)
        # none of that cost a PIN attempt
        self.assertEqual(self.grant_for([first])[0], 200)

        # with the vault unlocked, a forged reference still moves nothing - not even the valid one
        self.assertEqual(self.unlock()[0], 200)
        status, payload = self.lf("move_in", {"items": [self.ref(second), self.ref(binned)]})
        self.assertEqual(status, 400)
        self.assertEqual([item["index"] for item in payload["refused"]], [1])
        self.assertIsNotNone(self.library().get(second))
        self.assertIsNotNone(self.library().get_any(binned))

    def test_an_unlocked_session_moves_references_without_a_grant_and_stays_unlocked(self):
        self.setup_vault()
        first, *_ = self.import_photos()
        self.assertEqual(self.move([first])[0], 403, "locked, and no grant")
        self.assertEqual(self.unlock()[0], 200)
        self.assertEqual(self.move([first])[0], 200)
        self.assertTrue(self.lf("status")[1]["unlocked"])

    def test_a_photo_binned_after_the_check_is_left_alone(self):
        self.setup_vault()
        first, second, _third = self.import_photos()
        grant = self.grant_for([first, second])[1]["grant"]
        vault = module("locked_folder.vault")
        real = vault.still_movable

        def binned_meanwhile(engine, token):
            check = real(engine, token)

            def still(photo_id):
                if photo_id == first:
                    self.library().trash(first)  # someone bins it just before its copy
                return check(photo_id)
            return still

        with mock.patch.object(vault, "still_movable", binned_meanwhile):
            status, payload = self.move([first, second], grant)
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in payload["moved"]], [second])
        self.assertEqual([item["id"] for item in payload["failed"]], [first])
        self.assertIsNotNone(self.library().get_any(first), "still in the recycle bin")
        self.assertEqual(len(list((self.vault / "Photos").iterdir())), 1)

    def test_the_library_refuses_to_remove_a_binned_photo_for_a_move(self):
        first, *_ = self.import_photos()
        library = self.library()
        library.trash(first)
        with self.assertRaises(module("photo.library").PhotoNotFound):
            library.remove_moved(first)
        self.assertIsNotNone(library.get_any(first))

    def test_photo_resolves_only_active_library_items(self):
        first, binned, _third = self.import_photos()
        self.call(f"/api/satellites/Photo/trash/{binned}", "POST")
        status, payload = self.call(f"/api/satellites/Photo/media/resolve/{first}")
        self.assertEqual((status, payload), (200, {"id": first, "kind": "image"}))
        self.assertEqual(self.call(f"/api/satellites/Photo/media/resolve/{binned}")[0], 404)
        self.assertEqual(self.call(f"/api/satellites/Photo/media/resolve/{'f' * 64}")[0], 404)

    def test_no_reference_resolves_without_an_enabled_provider(self):
        capabilities = import_module("starcore.capabilities")
        first, *_ = self.import_photos()
        with mock.patch.object(type(self.photo), "enabled", new_callable=mock.PropertyMock, return_value=False):
            with self.assertRaises(capabilities.ReferenceProblem):
                capabilities.resolve_references(self.engine, "media.gallery", [self.ref(first)], self.token)

    def test_a_biometric_unlock_can_ask_for_a_grant(self):
        self.setup_vault()
        first, *_ = self.import_photos()
        key_id = self.enroll()[1]["key_id"]
        _, payload = self.lf("biometric/challenge", {"key_id": key_id})
        body = {"key_id": key_id, "challenge": payload["challenge"],
                "signature": b64(test_key().sign(payload["challenge"].encode())),
                "for": {"operation": "move_in", "items": [self.ref(first)]}}
        status, payload = self.lf("biometric/unlock", body)
        self.assertEqual(status, 200)
        self.assertFalse(payload["unlocked"])
        self.assertFalse(self.lf("status")[1]["unlocked"])
        self.assertEqual(self.move([first], payload["grant"])[0], 200)


class SignatureTest(unittest.TestCase):
    def test_verify_accepts_only_the_exact_signature(self):
        signatures = module("locked_folder.signatures")
        key = test_key()
        public = signatures.parse_public_key(key.public_der())
        signature = key.sign(b"challenge")
        self.assertTrue(signatures.verify(public, b"challenge", signature))
        self.assertFalse(signatures.verify(public, b"challengf", signature))
        self.assertFalse(signatures.verify(public, b"challenge", signature[:-1]))
        self.assertFalse(signatures.verify(public, b"challenge", b"\x00" + signature[1:]))
        self.assertFalse(signatures.verify(public, b"challenge", (key.n).to_bytes(256, "big")))

    def test_the_digest_info_matches_sha256(self):
        signatures = module("locked_folder.signatures")
        encoded = signatures.expected_encoding(b"abc", 256)
        self.assertTrue(encoded.endswith(hashlib.sha256(b"abc").digest()))
        self.assertEqual(len(encoded), 256)


if __name__ == "__main__":
    unittest.main()
