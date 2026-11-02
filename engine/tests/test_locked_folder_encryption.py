"""Encryption at rest, persistent PIN lockouts and the recovery key for the
Locked Folder.

Everything runs against temporary directories and synthetic files - a temp
vault, a temp Photo library, a temp Locked Folder store (and so a temp
server key) - never real photos, PINs or keys.
"""

from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from importlib import import_module
from pathlib import Path
from unittest import mock
import contextlib
import errno
import hashlib
import io
import json
import os
import secrets
import shutil
import sys
import tempfile
import time
import tracemalloc
import unittest

from starcore.auth import AuthStore, hash_secret
from tests.support import start_engine, stop_engine
from tests.test_photo import png


def module(name):
    return import_module(f"satellites.native.{name}")


crypto = keystore = encryption = None


def setUpModule():
    # satellite packages are registered for import by the engine that loads them
    global crypto, keystore, encryption
    engine = start_engine()
    try:
        crypto = module("locked_folder.crypto")
        keystore = module("locked_folder.keystore")
        encryption = module("locked_folder.encryption")
    finally:
        stop_engine(engine)


try:
    import cryptography  # noqa: F401
    HAVE_CRYPTO = True
except ImportError:
    HAVE_CRYPTO = False

needs_crypto = unittest.skipUnless(HAVE_CRYPTO, "the 'encryption' extra (cryptography) isn't installed")


def encrypt_bytes(data: bytes, key: bytes, vault_id: bytes, segment_size: int = 1024 * 1024,
                  metadata=None) -> bytes:
    out = io.BytesIO()
    writer = crypto.Encryptor(out, key, vault_id, segment_size=segment_size)
    for start in range(0, len(data), 7000):
        writer.write(data[start:start + 7000])
    writer.finish(metadata or {"name": "x.bin", "folder": ""})
    return out.getvalue()


@needs_crypto
class FileFormatTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-lf-format-"))
        self.key = crypto.new_key()
        self.vault_id = secrets.token_bytes(16)

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def write(self, blob: bytes, name="file.sclf") -> Path:
        path = self.directory / name
        path.write_bytes(blob)
        return path

    def open(self, path, key=None, vault_id=None):
        return crypto.EncryptedFile(path, key or self.key, vault_id or self.vault_id)

    def test_round_trips_at_every_segment_boundary(self):
        segment = 4096
        for size in (0, 1, segment - 1, segment, segment + 1, 2 * segment, 3 * segment + 5):
            data = os.urandom(size)
            path = self.write(encrypt_bytes(data, self.key, self.vault_id, segment), f"{size}.sclf")
            with self.open(path) as opened:
                self.assertEqual(opened.size, size)
                self.assertEqual(b"".join(opened.chunks()), data, size)
                self.assertEqual(opened.verify(), hashlib.sha256(data).hexdigest())
                self.assertEqual(opened.metadata["name"], "x.bin")

    def test_any_range_decrypts_to_the_same_bytes(self):
        data = os.urandom(5 * 4096 + 123)
        path = self.write(encrypt_bytes(data, self.key, self.vault_id, 4096))
        with self.open(path) as opened:
            for start, end in ((0, 0), (0, 4095), (4095, 4096), (100, 9000), (len(data) - 1, len(data) - 1),
                               (3 * 4096, len(data) - 1)):
                self.assertEqual(b"".join(opened.read_range(start, end)), data[start:end + 1], (start, end))

    def test_nothing_readable_is_left_in_the_file(self):
        marker = b"PRIVATE-MARKER-" * 300
        blob = encrypt_bytes(marker, self.key, self.vault_id, metadata={"name": "secret-name.jpg", "folder": "Trip"})
        self.assertNotIn(b"PRIVATE-MARKER", blob)
        self.assertNotIn(b"secret-name", blob)
        self.assertNotIn(b"Trip", blob)
        # the same content never encrypts the same way twice
        self.assertNotEqual(blob, encrypt_bytes(marker, self.key, self.vault_id))

    def test_any_changed_byte_is_rejected(self):
        data = os.urandom(3 * 4096 + 10)
        blob = encrypt_bytes(data, self.key, self.vault_id, 4096)
        for offset in (0, 5, 20, crypto.HEADER_SIZE + 1, crypto.HEADER_SIZE + 4096 + 20,
                       len(blob) - 30, len(blob) - 1):
            damaged = bytearray(blob)
            damaged[offset] ^= 0x01
            path = self.write(bytes(damaged), f"damaged-{offset}.sclf")
            with self.assertRaises(crypto.CorruptFile, msg=offset):
                with self.open(path) as opened:
                    opened.verify()

    def test_cut_short_extended_or_reordered_files_are_rejected(self):
        segment = 4096
        data = os.urandom(3 * segment + 10)
        blob = encrypt_bytes(data, self.key, self.vault_id, segment)
        stride = segment + crypto.TAG_SIZE
        header, body = blob[:crypto.HEADER_SIZE], blob[crypto.HEADER_SIZE:]
        segments_end = crypto.HEADER_SIZE + 3 * stride + 10 + crypto.TAG_SIZE
        trailer = blob[segments_end:]
        first, second = body[:stride], body[stride:2 * stride]
        variants = {
            "dropped segment": header + body[stride:],
            "swapped segments": header + second + first + body[2 * stride:],
            "last segment cut": blob[:segments_end - 5] + trailer,
            "extra bytes": blob[:segments_end] + b"\x00" * 16 + trailer,
            "no metadata": blob[:segments_end],
        }
        for name, variant in variants.items():
            path = self.write(variant, f"{name}.sclf")
            with self.assertRaises(crypto.CorruptFile, msg=name):
                with self.open(path) as opened:
                    opened.verify()

    def test_the_wrong_key_or_vault_opens_nothing(self):
        path = self.write(encrypt_bytes(b"hello", self.key, self.vault_id))
        with self.assertRaises(crypto.CorruptFile):
            self.open(path, key=crypto.new_key())
        with self.assertRaises(crypto.CorruptFile):
            self.open(path, vault_id=secrets.token_bytes(16))

    def test_large_videos_are_streamed_in_constant_memory(self):
        size = 48 * 1024 * 1024
        path = self.directory / "video.sclf"
        block = os.urandom(1024 * 1024)
        hasher = hashlib.sha256()
        tracemalloc.start()
        try:
            with open(path, "wb") as out:
                writer = crypto.Encryptor(out, self.key, self.vault_id)
                for _ in range(size // len(block)):
                    writer.write(block)
                    hasher.update(block)
                writer.finish({"name": "clip.mp4"})
            with self.open(path) as opened:
                self.assertEqual(opened.verify(), hasher.hexdigest())
                middle = b"".join(opened.read_range(20 * 1024 * 1024 + 7, 20 * 1024 * 1024 + 99))
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(middle, block[7:100])
        self.assertLess(peak, 12 * 1024 * 1024, "a 48 MiB file must never be held in memory whole")

    def test_wrapped_keys_open_only_with_their_key_and_label(self):
        kek, key = crypto.new_key(), crypto.new_key()
        slot = crypto.wrap(kek, key, b"server|x")
        self.assertEqual(crypto.unwrap(kek, slot, b"server|x"), key)
        with self.assertRaises(crypto.WrongKey):
            crypto.unwrap(crypto.new_key(), slot, b"server|x")
        with self.assertRaises(crypto.WrongKey):
            crypto.unwrap(kek, slot, b"recovery|x")
        self.assertNotIn(key.hex(), json.dumps(slot))

    def test_recovery_keys_parse_forgivingly_but_not_loosely(self):
        secret, text = crypto.new_recovery_key()
        self.assertEqual(len(text.replace("-", "")), 52)
        self.assertEqual(crypto.parse_recovery_key(text), secret)
        self.assertEqual(crypto.parse_recovery_key(" " + text.lower().replace("-", " ") + "\n"), secret)
        for bad in ("", "ABCD", text[:-4], text + "AAAA", None, 12345):
            with self.assertRaises(ValueError):
                crypto.parse_recovery_key(bad)


@needs_crypto
class KeystoreTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-lf-keystore-"))

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_the_server_key_is_created_once_and_reused(self):
        with self.assertRaises(keystore.KeyUnavailable):
            keystore.load(self.directory)
        key = keystore.load(self.directory, create=True)
        self.assertEqual(len(key), 32)
        self.assertEqual(keystore.load(self.directory), key)
        self.assertEqual(keystore.load(self.directory, create=True), key)

    @unittest.skipUnless(sys.platform == "win32", "DPAPI is Windows-only")
    def test_on_windows_the_key_is_stored_protected_by_dpapi(self):
        key = keystore.load(self.directory, create=True)
        stored = keystore.key_path(self.directory).read_bytes()
        self.assertNotIn(key, stored)
        self.assertGreater(len(stored), 100)

    def test_the_file_backend_writes_an_owner_only_file(self):
        with mock.patch.object(keystore, "BACKEND", "file"):
            key = keystore.load(self.directory, create=True)
            path = keystore.key_path(self.directory)
            self.assertEqual(path.read_bytes(), key)
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o077, 0)

    def test_a_damaged_key_is_unavailable_not_replaced(self):
        keystore.load(self.directory, create=True)
        keystore.key_path(self.directory).write_bytes(b"garbage")
        with self.assertRaises(keystore.KeyUnavailable):
            keystore.load(self.directory, create=True)
        self.assertEqual(keystore.key_path(self.directory).read_bytes(), b"garbage")


class _VaultTestBase(unittest.TestCase):
    PIN = "2468"

    def setUp(self):
        self.engine = start_engine(mission_control=True)
        if not self.engine.api.running:
            stop_engine(self.engine)
            raise unittest.SkipTest("Mission Control could not be started")
        self.locked_folder = self.engine.registry.get("LockedFolder")
        self.photo = self.engine.registry.get("Photo")
        if None in (self.locked_folder, self.photo, self.engine.registry.get("FileExplorer")):
            stop_engine(self.engine)
            raise unittest.SkipTest("LockedFolder, Photo or FileExplorer did not load")

        self.directory = Path(tempfile.mkdtemp(prefix="starcore-lf-encryption-"))
        self.vault = self.directory / "vault"
        self.vault.mkdir()
        self.storage = self.directory / "lf-data"
        self.locked_folder.config.data.update({
            "storage": str(self.storage), "locked_folder_path": "",
            "session_timeout_seconds": 900, "max_pin_attempts": 5, "lockout_seconds": 300,
        })
        self.locked_folder.config.path = self.directory / "lf-config.toml"
        self.photo.config.data.update({"storage": str(self.directory / "photo-data"), "photo_directory": ""})
        self.photo.config.path = self.directory / "photo-config.toml"
        self.engine.auth = AuthStore(self.directory / "auth.json")
        self.token = self.engine.auth.bootstrap("admin", "a very good password")
        encryption.forget_keys()

    def tearDown(self):
        live = getattr(self.locked_folder, "locked_folder_runtime", None)
        if live is not None and live.migration is not None:
            self.wait_for_encryption()
        stop_engine(self.engine)
        encryption.forget_keys()
        shutil.rmtree(self.directory, ignore_errors=True)

    # ---------- helpers ----------

    def request(self, path, method="GET", payload=None, token=None, raw=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=30)
        all_headers = dict(headers or {})
        body = None
        if raw is not None:
            body = raw
            all_headers["Content-Type"] = "application/octet-stream"
        elif payload is not None:
            body = json.dumps(payload).encode("utf-8")
            all_headers["Content-Type"] = "application/json"
        token = self.token if token is None else token
        if token:
            all_headers["Authorization"] = f"Bearer {token}"
        try:
            connection.request(method, path, body=body, headers=all_headers)
            response = connection.getresponse()
            try:
                data = response.read()
            except Exception:
                data = None
            return response.status, data, dict(response.getheaders())
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

    def setup_vault(self, files=None):
        for relative, content in (files or {}).items():
            path = self.vault / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.assertEqual(self.lf("configuration", {"key": "locked_folder_path", "value": str(self.vault)})[0], 200)
        self.assertEqual(self.lf("pin", {"pin": self.PIN})[0], 200)

    def unlock(self, pin=None, token=None):
        return self.lf("unlock", {"pin": pin or self.PIN}, token=token)

    def runtime(self):
        return module("locked_folder.runtime").runtime(self.locked_folder)

    def restart(self):
        """What a StarCore restart does to the Locked Folder: a new runtime
        read back from disk, and no unlocks."""
        runtime_module = module("locked_folder.runtime")
        runtime_module._runtimes.clear()
        self.locked_folder.locked_folder_runtime = None
        encryption.forget_keys()
        return self.runtime()

    def new_session(self):
        return self.engine.auth.create_session("admin")

    def wait_for_encryption(self, timeout=60):
        deadline = time.time() + timeout
        live = self.runtime()
        while live.migration is not None and live.migration.running and time.time() < deadline:
            time.sleep(0.05)
        self.assertFalse(live.migration is not None and live.migration.running, "encryption did not finish")
        return live.migration

    def encrypt(self, recovery=True):
        self.unlock()
        status, payload = self.lf("encryption/start", {"recovery_key": recovery})
        self.assertEqual(status, 200, payload)
        progress = self.wait_for_encryption()
        self.assertIsNone(progress.error)
        return payload["recovery_key"]

    def media(self):
        status, payload = self.lf("media")
        self.assertEqual(status, 200, payload)
        return payload["items"]

    def fetch(self, relative, headers=None):
        from urllib.parse import quote
        return self.request(f"/api/satellites/LockedFolder/media/file?path={quote(relative)}", headers=headers)

    def plaintext_left(self):
        """Files in the vault folder outside .starcore-vault."""
        return sorted(path.relative_to(self.vault).as_posix() for path in self.vault.rglob("*")
                      if path.is_file() and ".starcore-vault" not in path.relative_to(self.vault).parts)

    def objects(self):
        return sorted((self.vault / ".starcore-vault" / "objects").glob("*.sclf"))

    def import_photos(self, count=2):
        source = self.directory / "camera"
        source.mkdir(exist_ok=True)
        for index in range(count):
            (source / f"IMG_{index}.png").write_bytes(png(8 + index, 8, bytes([index * 40, 60, 90])))
        status, payload = self.call("/api/satellites/Photo/import", "POST", {"source": str(source)})
        self.assertEqual(status, 200)
        return [photo["id"] for photo in payload["photos"]]


class PersistentLockoutTest(_VaultTestBase):
    def test_a_session_lockout_survives_a_restart(self):
        self.setup_vault()
        for _ in range(5):
            self.assertEqual(self.unlock("0000")[0], 401)
        self.assertEqual(self.unlock()[0], 429)
        self.restart()
        status, payload = self.unlock()
        self.assertEqual(status, 429)
        self.assertGreater(payload["retry_after"], 0)

    def test_the_account_wide_lockout_survives_a_restart(self):
        self.setup_vault()
        for _ in range(5):
            token = self.new_session()
            for _ in range(4):
                self.unlock("0000", token=token)
        self.restart()
        status, _ = self.unlock(token=self.new_session())
        self.assertEqual(status, 429)
        self.assertGreater(self.lf("status")[1]["security"]["lockout"]["retry_after"], 0)

    def test_parallel_guesses_are_all_counted_on_disk(self):
        self.setup_vault()
        tokens = [self.new_session() for _ in range(24)]
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda token: self.unlock("0000", token=token)[0], tokens))
        self.assertEqual(results.count(401), 20)
        self.assertEqual(results.count(429), 4)
        self.restart()
        self.assertEqual(self.unlock()[0], 429)

    def test_the_counters_never_store_a_session_token(self):
        self.setup_vault()
        self.unlock("0000")
        content = (self.storage / "attempts.json").read_text(encoding="utf-8")
        self.assertNotIn(self.token, content)
        self.assertNotIn(self.PIN, content)

    def test_damaged_counters_lock_out_for_one_period_then_heal(self):
        self.setup_vault()
        self.locked_folder.config.data["lockout_seconds"] = 1
        (self.storage / "attempts.json").write_text("{not json", encoding="utf-8")
        live = self.restart()
        self.assertTrue(live.attempts_damaged)
        self.assertEqual(self.unlock()[0], 429)
        self.assertTrue(self.lf("status")[1]["security"]["lockout"]["state_damaged"])
        time.sleep(1.2)
        self.assertEqual(self.unlock()[0], 200)

    def test_a_deadline_from_a_clock_far_ahead_is_capped(self):
        self.setup_vault()
        data = {"version": 1, "sessions": {}, "recovery": {},
                "global": {"count": 0, "lockouts": 9, "locked_until": time.time() + 10 ** 9, "last_failure": time.time()}}
        (self.storage / "attempts.json").write_text(json.dumps(data), encoding="utf-8")
        live = self.restart()
        self.assertLessEqual(live.lockout_status()["retry_after"], 24 * 60 * 60)

    def test_an_attempt_that_cannot_be_recorded_is_refused(self):
        self.setup_vault()
        live = self.runtime()
        original = live._save_json

        def failing(path, data, durable=False):
            if path.name == "attempts.json":
                raise OSError(errno.ENOSPC, "No space left on device")
            return original(path, data, durable)

        with mock.patch.object(live, "_save_json", side_effect=failing):
            status, _ = self.unlock()
        self.assertEqual(status, 503)
        self.assertFalse(live.is_unlocked(self.token))

    def test_ordinary_typos_are_forgotten_after_a_day(self):
        self.setup_vault()
        live = self.runtime()
        for _ in range(3):
            self.unlock("0000", token=self.new_session())
        self.assertEqual(live.lockout_status()["failed_attempts"], 3)
        with mock.patch("time.time", return_value=time.time() + 2 * 24 * 60 * 60):
            self.assertEqual(live.lockout_status()["failed_attempts"], 0)


@needs_crypto
class EncryptionMigrationTest(_VaultTestBase):
    FILES = {
        "a.jpg": png(10, 10, b"\x10\x20\x30"),
        "Trip/b.png": png(12, 9, b"\x40\x50\x60"),
        "notes.txt": b"PRIVATE-NOTE " * 1000,
        "big.mp4": os.urandom(3 * 1024 * 1024 + 77),
    }

    def test_encrypting_keeps_every_file_and_leaves_nothing_readable(self):
        self.setup_vault(self.FILES)
        pin_before = json.loads((self.storage / "pin.json").read_text(encoding="utf-8"))
        recovery = self.encrypt()
        self.assertIsNotNone(recovery)

        # the PIN itself is untouched - only bound to the vault
        pin_after = json.loads((self.storage / "pin.json").read_text(encoding="utf-8"))
        self.assertEqual((pin_after["salt"], pin_after["hash"]), (pin_before["salt"], pin_before["hash"]))
        self.assertIn("binding", pin_after)

        self.assertEqual(self.plaintext_left(), [])
        self.assertEqual(len(self.objects()), len(self.FILES))
        for path in self.objects():
            content = path.read_bytes()
            self.assertNotIn(b"PRIVATE-NOTE", content)
            self.assertNotIn(b"Trip", content)

        items = {(item["folder"], item["name"]): item for item in self.media()}
        self.assertEqual(set(items), {("", "a.jpg"), ("Trip", "b.png"), ("", "notes.txt"), ("", "big.mp4")})
        for relative, content in self.FILES.items():
            folder, _, name = relative.rpartition("/")
            item = items[(folder, name)]
            self.assertTrue(item["encrypted"])
            status, body, headers = self.fetch(item["path"])
            self.assertEqual(status, 200)
            self.assertEqual(body, content, relative)
            self.assertEqual(headers["Cache-Control"], "private, no-store")

        # the originals are in the backup, byte for byte, until deleted
        backup = self.vault / ".starcore-vault" / "backups"
        for relative, content in self.FILES.items():
            self.assertEqual(next(backup.glob(f"*/{relative}")).read_bytes(), content)
        status = self.lf("status")[1]["encryption"]
        self.assertEqual(status["state"], "on")
        self.assertTrue(status["recovery_key"])
        self.assertEqual(status["unencrypted_files"], 0)
        self.assertEqual(status["backups"][0]["files"], len(self.FILES))

    def test_videos_can_be_seeked_without_decrypting_everything(self):
        self.setup_vault(self.FILES)
        self.encrypt(recovery=False)
        item = next(item for item in self.media() if item["name"] == "big.mp4")
        start, end = 2 * 1024 * 1024 - 10, 2 * 1024 * 1024 + 500
        status, body, headers = self.fetch(item["path"], headers={"Range": f"bytes={start}-{end}"})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.FILES["big.mp4"][start:end + 1])
        self.assertEqual(headers["Content-Range"], f"bytes {start}-{end}/{len(self.FILES['big.mp4'])}")

    def test_the_recovery_key_is_never_stored_or_logged(self):
        self.setup_vault(self.FILES)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            recovery = self.encrypt()
        compact = recovery.replace("-", "")
        self.assertNotIn(compact, output.getvalue())
        for base in (self.vault, self.storage):
            for path in base.rglob("*"):
                if path.is_file() and path.suffix in (".json", ""):
                    text = path.read_bytes()
                    self.assertNotIn(compact.encode(), text)
                    self.assertNotIn(recovery.encode(), text)
        status, payload = self.lf("encryption")
        self.assertNotIn(compact, json.dumps(payload))

    def test_encryption_needs_an_explicit_start(self):
        self.setup_vault(self.FILES)
        self.restart()
        self.assertEqual(self.objects(), [])
        self.unlock()
        self.assertEqual(self.lf("encryption/start", {})[0], 400)  # must say whether to make a recovery key
        self.assertEqual(self.plaintext_left(), sorted(self.FILES))

    def test_an_interrupted_run_leaves_every_original_and_resumes(self):
        self.setup_vault(self.FILES)
        self.unlock()
        live = self.runtime()
        encryption.set_up(live, self.vault, with_recovery=False)
        real_add = encryption.Store.add
        calls = []

        def crash_on_third(store, chunks, metadata, expected_sha256=None):
            calls.append(metadata["name"])
            if len(calls) == 3:
                raise KeyboardInterrupt("simulated power cut")
            return real_add(store, chunks, metadata, expected_sha256)

        with mock.patch.object(encryption.Store, "add", crash_on_third):
            with self.assertRaises(KeyboardInterrupt):
                encryption.encrypt_vault(live, self.vault)
        self.assertEqual(self.plaintext_left(), sorted(self.FILES))
        self.assertEqual(list((self.vault / ".starcore-vault" / "objects").glob("*.part")), [])

        # until it resumes, every file is listed once - as its original
        self.restart()
        self.unlock()
        listed = sorted((item["folder"], item["name"]) for item in self.media())
        self.assertEqual(len(listed), len(self.FILES))
        self.assertEqual(self.lf("status")[1]["encryption"]["state"], "interrupted")

        result = encryption.encrypt_vault(self.runtime(), self.vault)
        self.assertEqual(result["phase"], "done")
        self.assertEqual(self.plaintext_left(), [])
        self.assertEqual(len(self.objects()), len(self.FILES))
        self.assertEqual(len(self.media()), len(self.FILES))

    def test_a_crash_while_moving_originals_to_the_backup_loses_nothing(self):
        self.setup_vault(self.FILES)
        self.unlock()
        live = self.runtime()
        encryption.set_up(live, self.vault, with_recovery=False)
        real_rename = os.rename
        moves = []

        def crash_on_second(source, target):
            if "backups" in str(target):
                moves.append(target)
                if len(moves) == 2:
                    raise KeyboardInterrupt("simulated power cut")
            return real_rename(source, target)

        with mock.patch.object(encryption.os, "rename", crash_on_second):
            with self.assertRaises(KeyboardInterrupt):
                encryption.encrypt_vault(live, self.vault)
        # every file is listed once - the encrypted copies now count
        self.assertEqual(len(self.media()), len(self.FILES))
        encryption.encrypt_vault(self.runtime(), self.vault)
        self.assertEqual(self.plaintext_left(), [])
        backup = self.vault / ".starcore-vault" / "backups"
        self.assertEqual(sum(1 for path in backup.rglob("*") if path.is_file()), len(self.FILES))

    def test_too_little_free_space_changes_nothing(self):
        self.setup_vault(self.FILES)
        self.unlock()
        usage = shutil.disk_usage(self.vault)
        tiny = type(usage)(usage.total, usage.used, 1024)
        with mock.patch.object(encryption.shutil, "disk_usage", return_value=tiny):
            status, payload = self.lf("encryption/start", {"recovery_key": False})
            self.assertEqual(status, 200)
            progress = self.wait_for_encryption()
        self.assertIn("not enough free space", progress.error)
        self.assertEqual(self.plaintext_left(), sorted(self.FILES))
        self.assertEqual(self.objects(), [])

    def test_a_disk_filling_up_mid_file_stops_cleanly(self):
        self.setup_vault(self.FILES)
        self.unlock()
        live = self.runtime()
        encryption.set_up(live, self.vault, with_recovery=False)
        real_encryptor = encryption.crypto.Encryptor

        class FullDisk(real_encryptor):
            def write(self, data):
                raise OSError(errno.ENOSPC, "No space left on device")

        with mock.patch.object(encryption.crypto, "Encryptor", FullDisk):
            with self.assertRaises(encryption.EncryptionError) as raised:
                encryption.encrypt_vault(live, self.vault)
        self.assertEqual(raised.exception.status, 507)
        self.assertEqual(self.plaintext_left(), sorted(self.FILES))
        objects = self.vault / ".starcore-vault" / "objects"
        self.assertEqual([path.name for path in objects.iterdir()] if objects.exists() else [], [])
        # and once there is space again it simply carries on
        self.assertEqual(encryption.encrypt_vault(live, self.vault)["phase"], "done")

    def test_a_finished_run_can_be_undone_from_its_backup(self):
        self.setup_vault(self.FILES)
        self.encrypt()
        run = self.lf("status")[1]["encryption"]["backups"][0]["id"]
        status, payload = self.lf("encryption/undo", {"run": run})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["restored"], len(self.FILES))
        for relative, content in self.FILES.items():
            self.assertEqual((self.vault / relative).read_bytes(), content)
        # nothing is encrypted any more, so the vault is plain again
        self.assertFalse((self.vault / ".starcore-vault").exists())
        self.assertEqual(self.lf("status")[1]["encryption"]["state"], "off")
        self.assertEqual(self.unlock()[0], 200)

    def test_deleting_the_backup_needs_the_pin_and_good_copies(self):
        self.setup_vault(self.FILES)
        self.encrypt()
        run = self.lf("status")[1]["encryption"]["backups"][0]["id"]
        self.assertEqual(self.lf("encryption/discard", {"run": run})[0], 401)
        self.assertEqual(self.lf("encryption/discard", {"run": run, "pin": "0000"})[0], 401)

        damaged = self.objects()[0]
        original = damaged.read_bytes()
        damaged.write_bytes(original[:200] + bytes([original[200] ^ 1]) + original[201:])
        status, payload = self.lf("encryption/discard", {"run": run, "pin": self.PIN})
        self.assertEqual(status, 409, payload)
        self.assertTrue((self.vault / ".starcore-vault" / "backups" / run).is_dir())

        damaged.write_bytes(original)
        self.assertEqual(self.lf("encryption/discard", {"run": run, "pin": self.PIN})[0], 200)
        self.assertFalse((self.vault / ".starcore-vault" / "backups" / run).exists())
        self.assertEqual(len(self.media()), len(self.FILES))

    def test_a_damaged_file_is_shown_as_damaged_and_never_served(self):
        self.setup_vault({"notes.txt": b"PRIVATE-NOTE " * 1000})
        self.encrypt(recovery=False)
        path = self.objects()[0]
        original = path.read_bytes()

        # damaged contents: still listed (its details are intact) but never served
        data = bytearray(original)
        data[crypto.HEADER_SIZE + 100] ^= 0xFF
        path.write_bytes(bytes(data))
        status, body, _ = self.fetch(self.media()[0]["path"])
        self.assertEqual(status, 500)
        self.assertNotIn(b"PRIVATE-NOTE", body or b"")

        # a damaged header: listed as damaged, and refused before anything is read
        data = bytearray(original)
        data[10] ^= 0xFF
        path.write_bytes(bytes(data))
        items = self.media()
        self.assertTrue(items[0]["damaged"])
        status, body, _ = self.fetch(items[0]["path"])
        self.assertEqual(status, 422)
        self.assertNotIn(b"PRIVATE-NOTE", body or b"")

    def test_a_segment_damaged_mid_file_stops_the_stream(self):
        content = os.urandom(3 * 1024 * 1024)
        self.setup_vault({"clip.mp4": content})
        self.encrypt(recovery=False)
        path = self.objects()[0]
        data = bytearray(path.read_bytes())
        data[crypto.HEADER_SIZE + (1024 * 1024 + 16) + 10] ^= 0xFF  # inside the second segment
        path.write_bytes(bytes(data))
        _status, body, _ = self.fetch(self.media()[0]["path"])
        body = body or b""
        self.assertLess(len(body), len(content))
        self.assertEqual(body, content[:len(body)])  # only authentic bytes ever went out

    def test_new_files_are_stored_encrypted_and_file_explorer_is_kept_out(self):
        self.setup_vault({"a.jpg": self.FILES["a.jpg"]})
        self.encrypt(recovery=False)
        status, item = self.call_raw("upload?name=diary.txt&folder=Notes", b"PRIVATE-DIARY" * 100)
        self.assertEqual(status, 200, item)
        self.assertTrue(item["encrypted"])
        self.assertEqual(self.plaintext_left(), [])
        self.assertEqual(self.fetch(item["path"])[1], b"PRIVATE-DIARY" * 100)

        # File Explorer can't read or write inside an encrypted vault, unlocked or not
        status, _, _ = self.request(f"/api/satellites/FileExplorer/upload?path={self.vault}&name=x.txt", "POST",
                                    raw=b"plain")
        self.assertEqual(status, 403)
        self.assertEqual(self.call(f"/api/satellites/FileExplorer/entries?path={self.vault}")[0], 403)
        self.assertFalse((self.vault / "x.txt").exists())

        status, payload = self.lf("delete", {"paths": [item["path"]]})
        self.assertEqual(status, 200)
        self.assertEqual(len(self.objects()), 1)

    def call_raw(self, route, data):
        status, raw, _ = self.request(f"/api/satellites/LockedFolder/{route}", "POST", raw=data)
        return status, json.loads(raw)

    def test_moves_both_ways_stay_encrypted_inside_the_vault(self):
        self.setup_vault()
        photo_ids = self.import_photos(2)
        library = module("photo.library").library(self.photo)
        originals = {photo_id: library.original_path(library.get(photo_id)).read_bytes() for photo_id in photo_ids}
        self.encrypt(recovery=False)

        status, payload = self.lf("move_in", {"photo_ids": photo_ids})
        self.assertEqual(status, 200, payload)
        self.assertEqual(len(payload["moved"]), 2)
        self.assertEqual(self.plaintext_left(), [])
        self.assertIsNone(library.get(photo_ids[0]))
        for path in self.objects():
            for content in originals.values():
                self.assertNotIn(content[20:60], path.read_bytes())

        status, payload = self.lf("move_out", {"paths": [item["path"] for item in self.media()]})
        self.assertEqual(status, 200, payload)
        for photo_id, content in originals.items():
            self.assertEqual(library.original_path(library.get(photo_id)).read_bytes(), content)
        self.assertEqual(self.objects(), [])
        tmp = self.vault / ".starcore-vault" / "tmp"
        self.assertEqual(list(tmp.iterdir()) if tmp.exists() else [], [])

    def test_a_failed_move_out_keeps_the_encrypted_file(self):
        self.setup_vault({"notes.txt": b"not a photo"})
        self.encrypt(recovery=False)
        item = self.media()[0]
        status, payload = self.lf("move_out", {"paths": [item["path"]]})
        self.assertEqual(status, 409)
        self.assertEqual(len(self.objects()), 1)
        tmp = self.vault / ".starcore-vault" / "tmp"
        self.assertEqual(list(tmp.iterdir()) if tmp.exists() else [], [])

    def test_every_private_endpoint_needs_this_session_unlocked(self):
        self.setup_vault(self.FILES)
        self.encrypt()
        item = self.media()[0]
        run = self.lf("status")[1]["encryption"]["backups"][0]["id"]
        self.lf("lock", {})
        other = self.new_session()
        for token in (other, self.token):
            checks = [
                ("GET", "media", None), ("GET", f"media/file?path={item['path']}", None),
                ("POST", "delete", {"paths": [item["path"]]}), ("POST", "move_out", {"paths": [item["path"]]}),
                ("POST", "move_in", {"photo_ids": ["x"]}), ("GET", "encryption", None),
                ("POST", "encryption/start", {"recovery_key": True}), ("POST", "encryption/undo", {"run": run}),
                ("POST", "encryption/discard", {"run": run, "pin": self.PIN}),
                ("POST", "encryption/recovery_key", {"pin": self.PIN}),
            ]
            for method, route, payload in checks:
                self.assertEqual(self.lf(route, payload, token=token, method=method)[0], 403, route)
            status, _, _ = self.request("/api/satellites/LockedFolder/upload?name=x.txt", "POST", raw=b"x", token=token)
            self.assertEqual(status, 403)
        self.assertEqual(self.lf("media", token="")[0], 401)
        self.assertEqual(len(self.objects()), len(self.FILES))

    def test_without_the_encryption_package_nothing_is_encrypted_or_opened(self):
        self.setup_vault(self.FILES)
        self.unlock()
        with mock.patch.object(crypto, "IMPORT_ERROR", ImportError("missing")):
            self.assertEqual(self.lf("encryption/start", {"recovery_key": False})[0], 501)
        self.assertEqual(self.plaintext_left(), sorted(self.FILES))
        self.encrypt(recovery=False)
        self.lf("lock", {})
        with mock.patch.object(crypto, "IMPORT_ERROR", ImportError("missing")):
            encryption.forget_keys()
            status, payload = self.unlock()
        self.assertEqual(status, 503)
        self.assertEqual(payload["problem"], "encryption_unavailable")


@needs_crypto
class SecurityStateTest(_VaultTestBase):
    def test_an_edited_or_deleted_pin_file_keeps_an_encrypted_vault_locked(self):
        self.setup_vault({"a.txt": b"private"})
        self.encrypt(recovery=False)
        self.lf("lock", {})

        # someone with write access swaps in a PIN they know...
        salt = bytes(16)
        (self.storage / "pin.json").write_text(json.dumps({"salt": salt.hex(), "hash": hash_secret("1111", salt)}))
        self.restart()
        status, payload = self.unlock("1111")
        self.assertEqual(status, 409)
        self.assertEqual(payload["problem"], "pin_tampered")

        # ...or deletes it to set a new one
        (self.storage / "pin.json").unlink()
        self.restart()
        self.assertTrue(self.lf("status")[1]["pin_set"])
        self.assertEqual(self.lf("pin", {"pin": "1111"})[0], 409)
        self.assertEqual(self.unlock("1111")[0], 409)

    def test_a_device_added_to_devices_json_by_hand_unlocks_nothing(self):
        self.setup_vault({"a.txt": b"private"})
        self.encrypt(recovery=False)
        devices = self.storage / "devices.json"
        data = json.loads(devices.read_text(encoding="utf-8"))
        data["devices"]["planted"] = {"public_key": "AAAA", "label": "x", "created": "now"}
        devices.write_text(json.dumps(data), encoding="utf-8")
        live = self.restart()
        self.assertFalse(live.has_device("planted"))
        self.assertEqual(live.device_count(), 0)

    def test_the_keyring_is_restored_from_the_servers_copy(self):
        self.setup_vault({"a.txt": b"private"})
        self.encrypt(recovery=False)
        (self.vault / ".starcore-vault" / "keyring.json").unlink()
        self.restart()
        self.assertEqual(self.unlock()[0], 200)
        self.assertEqual(self.fetch(self.media()[0]["path"])[1], b"private")
        self.assertTrue((self.vault / ".starcore-vault" / "keyring.json").exists())

    def test_with_both_keyring_copies_gone_the_vault_stays_locked(self):
        self.setup_vault({"a.txt": b"private"})
        self.encrypt(recovery=False)
        (self.vault / ".starcore-vault" / "keyring.json").unlink()
        shutil.rmtree(self.storage / "keyrings")
        self.restart()
        status, payload = self.unlock()
        self.assertEqual(status, 409)
        self.assertEqual(payload["problem"], "keyring_damaged")


@needs_crypto
class RecoveryTest(_VaultTestBase):
    def test_the_recovery_key_resets_the_pin_and_removes_devices(self):
        self.setup_vault({"a.txt": b"private"})
        recovery = self.encrypt()
        live = self.runtime()
        from tests.test_locked_folder_security import test_key
        live.add_device(test_key().public_der(), "Phone")
        self.assertEqual(live.device_count(), 1)
        self.lf("lock", {})

        wrong = crypto.new_recovery_key()[1]
        self.assertEqual(self.lf("recover", {"recovery_key": wrong, "pin": "1357"})[0], 401)
        self.assertEqual(self.lf("recover", {"recovery_key": "nonsense", "pin": "1357"})[0], 400)
        status, payload = self.lf("recover", {"recovery_key": recovery, "pin": "1357"})
        self.assertEqual(status, 200, payload)
        self.assertEqual(live.device_count(), 0)
        self.assertEqual(self.unlock()[0], 401)
        self.assertEqual(self.unlock("1357")[0], 200)
        self.assertEqual(self.fetch(self.media()[0]["path"])[1], b"private")

    def test_recovery_guesses_are_limited_and_survive_a_restart(self):
        self.setup_vault({"a.txt": b"private"})
        recovery = self.encrypt()
        for _ in range(5):
            self.assertEqual(self.lf("recover", {"recovery_key": crypto.new_recovery_key()[1], "pin": "1357"})[0], 401)
        self.restart()
        self.assertEqual(self.lf("recover", {"recovery_key": recovery, "pin": "1357"})[0], 429)

    def test_a_pin_lockout_does_not_block_recovery(self):
        self.setup_vault({"a.txt": b"private"})
        recovery = self.encrypt()
        for _ in range(5):
            self.unlock("0000")
        self.assertEqual(self.unlock()[0], 429)
        self.assertEqual(self.lf("recover", {"recovery_key": recovery, "pin": "1357"})[0], 200)
        self.assertEqual(self.unlock("1357")[0], 200)

    def test_a_lost_server_key_needs_the_recovery_key(self):
        self.setup_vault({"a.txt": b"private"})
        recovery = self.encrypt()
        keystore.key_path(self.storage).unlink()
        self.restart()
        status, payload = self.unlock()
        self.assertEqual(status, 409)
        self.assertEqual(payload["problem"], "key_unavailable")
        self.assertEqual(self.lf("status")[1]["security"]["problem"], "key_unavailable")

        self.assertEqual(self.lf("recover", {"recovery_key": recovery, "pin": "1357"})[0], 200)
        self.assertEqual(self.unlock("1357")[0], 200)
        self.assertEqual(self.fetch(self.media()[0]["path"])[1], b"private")

    def test_a_backup_of_the_vault_opens_on_a_new_server_with_the_recovery_key(self):
        self.setup_vault({"a.txt": b"private", "b.txt": b"more"})
        recovery = self.encrypt()
        # a new server: the vault folder (with its keyring) restored from a
        # backup, and none of the old server's data directory
        copy = self.directory / "restored-vault"
        shutil.copytree(self.vault, copy)
        self.unlock()
        self.lf("configuration", {"key": "locked_folder_path", "value": str(copy)})
        shutil.rmtree(self.storage)
        self.locked_folder.config.data["storage"] = str(self.directory / "new-server")
        self.restart()
        self.storage = self.directory / "new-server"

        self.assertEqual(self.lf("status")[1]["security"]["problem"], "key_unavailable")
        self.assertEqual(self.lf("recover", {"recovery_key": recovery, "pin": "1357"})[0], 200)
        self.assertEqual(self.unlock("1357")[0], 200)
        self.assertEqual(sorted(self.fetch(item["path"])[1] for item in self.media()), [b"more", b"private"])

    def test_without_a_recovery_key_there_is_no_way_back(self):
        self.setup_vault({"a.txt": b"private"})
        self.encrypt(recovery=False)
        keystore.key_path(self.storage).unlink()
        self.restart()
        self.assertEqual(self.lf("recover", {"recovery_key": crypto.new_recovery_key()[1], "pin": "1357"})[0], 400)
        self.assertEqual(self.unlock()[0], 409)

    def test_a_new_recovery_key_replaces_the_old_one(self):
        self.setup_vault({"a.txt": b"private"})
        old = self.encrypt()
        self.assertEqual(self.lf("encryption/recovery_key", {"pin": "0000"})[0], 401)
        status, payload = self.lf("encryption/recovery_key", {"pin": self.PIN})
        self.assertEqual(status, 200)
        new = payload["recovery_key"]
        self.assertNotEqual(new, old)
        self.assertEqual(self.lf("recover", {"recovery_key": old, "pin": "1357"})[0], 401)
        self.assertEqual(self.lf("recover", {"recovery_key": new, "pin": "1357"})[0], 200)

        self.unlock("1357")
        self.assertEqual(self.lf("encryption/recovery_key", {"pin": "1357", "remove": True})[0], 200)
        self.assertFalse(self.lf("status")[1]["encryption"]["recovery_key"])


if __name__ == "__main__":
    unittest.main()
