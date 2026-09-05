"""The Locked Folder: PIN storage/verification, session-aware unlock/lock,
brute-force rate limiting, and - crucially - that File Explorer's own
routes can never reach a configured Locked Folder root without that exact
session having unlocked it first, however the path is reached (direct
navigation, "..", or a symlink).

Every test here needs a real, bootstrapped session (unlike Photo's or File
Explorer's own tests, which run with StarCore deliberately not-yet-
bootstrapped, since they don't care about *which* session is asking) - so,
following the same pattern test_auth.py's AuthApiTest and
test_satellite_management.py's _engine() use for the same reason, each test
starts its own fresh engine and its own fresh admin session rather than
sharing one across the class.
"""

from http.client import HTTPConnection
from pathlib import Path
from unittest import mock
import json
import os
import shutil
import tempfile
import time
import unittest

from starcore.auth import AuthStore
from tests.support import start_engine, stop_engine


class LockedFolderApiTest(unittest.TestCase):
    def setUp(self):
        self.engine = start_engine(mission_control=True)
        if not self.engine.api.running:
            stop_engine(self.engine)
            raise unittest.SkipTest("Mission Control could not be started")

        self.locked_folder = self.engine.registry.get("LockedFolder")
        self.file_explorer = self.engine.registry.get("FileExplorer")
        if self.locked_folder is None or self.file_explorer is None:
            stop_engine(self.engine)
            raise unittest.SkipTest("LockedFolder or FileExplorer satellite did not load")

        self.directory = Path(tempfile.mkdtemp(prefix="starcore-lockedfolder-"))
        self.locked_folder.config.data["storage"] = str(self.directory / "lf-data")
        self.locked_folder.config.data["locked_folder_path"] = ""
        self.locked_folder.config.data["session_timeout_seconds"] = 900
        self.locked_folder.config.data["max_pin_attempts"] = 5
        self.locked_folder.config.data["lockout_seconds"] = 300
        # configuration.update() persists through satellite.config.set(), which
        # writes straight to config.path - redirected to a disposable file so
        # a test can never touch the real satellites/native/locked_folder/
        # config.toml (see PhotoConfigurationTest in test_photo.py for the
        # same pattern, for the same reason)
        self.locked_folder.config.path = self.directory / "config.toml"

        self.vault = self.directory / "vault"
        self.vault.mkdir()
        (self.vault / "secret.txt").write_text("shh", encoding="utf-8")

        # a fresh AuthStore per test, bootstrapped immediately - never the
        # real engine/data/auth.json, and never shared across tests
        self.engine.auth = AuthStore(self.directory / "auth.json")
        self.token = self.engine.auth.bootstrap("admin", "a very good password")

    def tearDown(self):
        stop_engine(self.engine)
        shutil.rmtree(self.directory, ignore_errors=True)

    # ---------- HTTP helpers ----------

    def request(self, path, method="GET", payload=None, token=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def json_request(self, path, method="GET", payload=None, token=None):
        status, body = self.request(path, method, payload, token=token if token is not None else self.token)
        return status, (json.loads(body.decode("utf-8")) if body else {})

    def second_session(self) -> str:
        """A second, independent session for the same admin account - used to
        prove unlock state is session-aware, not account-wide."""
        return self.engine.auth.create_session("admin")

    def configure_vault(self):
        status, payload = self.json_request(
            "/api/satellites/LockedFolder/configuration", "POST",
            {"key": "locked_folder_path", "value": str(self.vault)})
        self.assertEqual(status, 200)
        return payload

    def set_pin(self, pin="1234", current_pin=None, token=None):
        body = {"pin": pin}
        if current_pin is not None:
            body["current_pin"] = current_pin
        return self.json_request("/api/satellites/LockedFolder/pin", "POST", body, token=token)

    def unlock(self, pin="1234", token=None):
        return self.json_request("/api/satellites/LockedFolder/unlock", "POST", {"pin": pin}, token=token)

    def lock(self, token=None):
        return self.json_request("/api/satellites/LockedFolder/lock", "POST", {}, token=token)

    def status(self, token=None):
        return self.json_request("/api/satellites/LockedFolder/status", token=token)

    def fe_entries(self, path, token=None):
        return self.json_request(f"/api/satellites/FileExplorer/entries?path={path}", token=token)

    def fe_content(self, path, token=None):
        status, body = self.request(
            f"/api/satellites/FileExplorer/content?path={path}",
            token=token if token is not None else self.token)
        return status

    # ---------- configuration ----------

    def test_a_fresh_locked_folder_is_not_configured(self):
        status, payload = self.status()
        self.assertEqual(status, 200)
        self.assertFalse(payload["configured"])
        self.assertIsNone(payload["path"])
        self.assertFalse(payload["pin_set"])

    def test_configuring_a_relative_path_is_rejected(self):
        status, payload = self.json_request(
            "/api/satellites/LockedFolder/configuration", "POST",
            {"key": "locked_folder_path", "value": "relative/path"})
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_configuring_a_filesystem_root_is_rejected(self):
        root = "C:\\" if Path(".").resolve().drive else "/"
        status, payload = self.json_request(
            "/api/satellites/LockedFolder/configuration", "POST",
            {"key": "locked_folder_path", "value": root})
        self.assertEqual(status, 400)

    def test_configuring_the_vault_reports_it_as_configured(self):
        self.configure_vault()
        status, payload = self.status()
        self.assertTrue(payload["configured"])
        self.assertEqual(payload["path"], str(self.vault.resolve()))

    # ---------- PIN ----------

    def test_the_pin_is_never_stored_in_plain_text(self):
        self.configure_vault()
        self.set_pin("135790")

        raw = (self.directory / "lf-data" / "pin.json").read_text(encoding="utf-8")
        self.assertNotIn("135790", raw)

    def test_setting_a_pin_reports_pin_set(self):
        self.configure_vault()
        status, payload = self.set_pin("1234")
        self.assertEqual(status, 200)
        self.assertTrue(payload["pin_set"])

        _, status_payload = self.status()
        self.assertTrue(status_payload["pin_set"])

    def test_a_pin_must_be_digits_only(self):
        self.configure_vault()
        status, payload = self.set_pin("12ab")
        self.assertEqual(status, 400)

    def test_a_pin_must_be_within_length_bounds(self):
        self.configure_vault()
        status, _ = self.set_pin("12")
        self.assertEqual(status, 400)
        status, _ = self.set_pin("1234567890123")
        self.assertEqual(status, 400)

    def test_changing_the_pin_requires_the_current_one(self):
        self.configure_vault()
        self.set_pin("1234")

        status, payload = self.set_pin("5678")  # no current_pin given
        self.assertEqual(status, 401)

        status, payload = self.set_pin("5678", current_pin="0000")  # wrong
        self.assertEqual(status, 401)

        status, payload = self.set_pin("5678", current_pin="1234")  # right
        self.assertEqual(status, 200)

    def test_changing_the_pin_revokes_every_existing_unlock(self):
        self.configure_vault()
        self.set_pin("1234")
        self.unlock("1234")
        self.assertTrue(self.status()[1]["unlocked"])

        self.set_pin("5678", current_pin="1234")
        self.assertFalse(self.status()[1]["unlocked"])

    # ---------- unlock / lock, session-aware ----------

    def test_unlock_fails_with_no_pin_configured(self):
        self.configure_vault()
        status, payload = self.unlock("1234")
        self.assertEqual(status, 400)

    def test_unlock_fails_with_no_vault_configured(self):
        status, payload = self.unlock("1234")
        self.assertEqual(status, 400)

    def test_correct_pin_unlocks(self):
        self.configure_vault()
        self.set_pin("1234")
        status, payload = self.unlock("1234")
        self.assertEqual(status, 200)
        self.assertTrue(payload["unlocked"])
        self.assertIsNotNone(payload["expires_at"])

        self.assertTrue(self.status()[1]["unlocked"])

    def test_incorrect_pin_is_rejected(self):
        self.configure_vault()
        self.set_pin("1234")
        status, payload = self.unlock("0000")
        self.assertEqual(status, 401)
        self.assertFalse(self.status()[1]["unlocked"])

    def test_locking_immediately_revokes_access(self):
        self.configure_vault()
        self.set_pin("1234")
        self.unlock("1234")
        self.assertTrue(self.status()[1]["unlocked"])

        status, payload = self.lock()
        self.assertEqual(status, 200)
        self.assertFalse(self.status()[1]["unlocked"])

    def test_unlock_is_session_aware_not_account_wide(self):
        self.configure_vault()
        self.set_pin("1234")
        other_token = self.second_session()

        self.unlock("1234")  # unlocks for self.token only
        self.assertTrue(self.status()[1]["unlocked"])
        self.assertFalse(self.status(token=other_token)[1]["unlocked"])

    def test_unlock_expires_after_the_configured_timeout(self):
        self.configure_vault()
        self.locked_folder.config.data["session_timeout_seconds"] = 1
        self.set_pin("1234")
        self.unlock("1234")
        self.assertTrue(self.status()[1]["unlocked"])

        time.sleep(1.5)
        self.assertFalse(self.status()[1]["unlocked"])

    # ---------- brute-force protection ----------

    def test_too_many_incorrect_pins_locks_out_further_attempts(self):
        self.configure_vault()
        self.locked_folder.config.data["max_pin_attempts"] = 3
        self.set_pin("1234")

        for _ in range(3):
            status, _ = self.unlock("0000")
            self.assertEqual(status, 401)

        status, payload = self.unlock("0000")
        self.assertEqual(status, 429)

        # even the CORRECT pin is refused while locked out
        status, payload = self.unlock("1234")
        self.assertEqual(status, 429)

    def test_a_lockout_is_scoped_to_the_session_that_earned_it(self):
        self.configure_vault()
        self.locked_folder.config.data["max_pin_attempts"] = 2
        self.set_pin("1234")
        other_token = self.second_session()

        for _ in range(2):
            self.unlock("0000")
        status, _ = self.unlock("0000")
        self.assertEqual(status, 429)

        # a different session is entirely unaffected
        status, payload = self.unlock("1234", token=other_token)
        self.assertEqual(status, 200)

    # ---------- File Explorer cannot bypass the Locked Folder ----------

    def test_file_explorer_refuses_to_list_the_locked_vault_when_locked(self):
        self.configure_vault()
        status, payload = self.fe_entries(str(self.vault))
        self.assertEqual(status, 403)

    def test_file_explorer_refuses_a_file_inside_the_locked_vault(self):
        self.configure_vault()
        status = self.fe_content(str(self.vault / "secret.txt"))
        self.assertEqual(status, 403)

    def test_the_parent_listing_flags_the_vault_as_locked_but_still_shows_it(self):
        self.configure_vault()
        status, payload = self.fe_entries(str(self.vault.parent))
        self.assertEqual(status, 200)
        entry = next(item for item in payload["entries"] if item["name"] == self.vault.name)
        self.assertTrue(entry["locked"])

    def test_file_explorer_serves_the_vault_once_unlocked(self):
        self.configure_vault()
        self.set_pin("1234")
        self.unlock("1234")

        status, payload = self.fe_entries(str(self.vault))
        self.assertEqual(status, 200)
        names = [item["name"] for item in payload["entries"]]
        self.assertIn("secret.txt", names)

        status = self.fe_content(str(self.vault / "secret.txt"))
        self.assertEqual(status, 200)

    def test_file_explorer_refuses_again_immediately_after_locking(self):
        self.configure_vault()
        self.set_pin("1234")
        self.unlock("1234")
        self.assertEqual(self.fe_entries(str(self.vault))[0], 200)

        self.lock()
        self.assertEqual(self.fe_entries(str(self.vault))[0], 403)

    def test_a_different_sessions_unlock_does_not_grant_this_one_access(self):
        self.configure_vault()
        self.set_pin("1234")
        other_token = self.second_session()
        self.unlock("1234", token=other_token)

        # the caller's OWN session (self.token) never unlocked anything
        status, _ = self.fe_entries(str(self.vault))
        self.assertEqual(status, 403)

    def test_dotdot_traversal_into_the_vault_is_still_blocked_when_locked(self):
        self.configure_vault()
        sibling = self.vault.parent / (self.vault.name + "-traversal-check")
        traversal_path = f"{sibling}/../{self.vault.name}/secret.txt"
        status = self.fe_content(traversal_path)
        self.assertEqual(status, 403)

    def test_a_symlink_pointing_into_the_vault_is_still_blocked_when_locked(self):
        self.configure_vault()
        link = self.directory / "escape-link.txt"
        try:
            link.symlink_to(self.vault / "secret.txt")
        except OSError:
            raise unittest.SkipTest("symlinks are not available in this environment")
        status = self.fe_content(str(link))
        self.assertEqual(status, 403)

    def test_upload_into_the_locked_vault_requires_authorization(self):
        self.configure_vault()
        status, body = self.request(
            f"/api/satellites/FileExplorer/upload?path={self.vault}&name=new.txt",
            "POST", token=self.token)
        # a raw (non-JSON) POST body is required for a real upload, but the
        # Locked Folder guard runs before any of that is even considered
        self.assertEqual(status, 403)

    def test_mkdir_in_the_locked_vault_requires_authorization(self):
        self.configure_vault()
        status, payload = self.json_request(
            "/api/satellites/FileExplorer/mkdir", "POST",
            {"path": str(self.vault), "name": "new-folder"})
        self.assertEqual(status, 403)

    def test_delete_in_the_locked_vault_requires_authorization(self):
        self.configure_vault()
        status, payload = self.json_request(
            "/api/satellites/FileExplorer/delete", "POST",
            {"path": str(self.vault / "secret.txt")})
        self.assertEqual(status, 403)

    def test_rename_in_the_locked_vault_requires_authorization(self):
        self.configure_vault()
        status, payload = self.json_request(
            "/api/satellites/FileExplorer/rename", "POST",
            {"path": str(self.vault / "secret.txt"), "name": "renamed.txt"})
        self.assertEqual(status, 403)

    def test_changing_the_vault_path_revokes_existing_unlocks(self):
        self.configure_vault()
        self.set_pin("1234")
        self.unlock("1234")
        self.assertTrue(self.status()[1]["unlocked"])

        other_vault = self.directory / "other-vault"
        other_vault.mkdir()
        self.json_request(
            "/api/satellites/LockedFolder/configuration", "POST",
            {"key": "locked_folder_path", "value": str(other_vault)})

        self.assertFalse(self.status()[1]["unlocked"])

    def test_clearing_the_vault_path_disables_protection_entirely(self):
        self.configure_vault()
        self.json_request(
            "/api/satellites/LockedFolder/configuration", "POST",
            {"key": "locked_folder_path", "value": ""})

        status, payload = self.fe_entries(str(self.vault))
        self.assertEqual(status, 200)  # nothing is protected any more

    # ---------- missing directory ----------

    def test_status_reports_the_directory_exists_when_it_does(self):
        self.configure_vault()
        status, payload = self.status()
        self.assertTrue(payload["path_exists"])

    def test_status_reports_the_directory_missing_once_deleted_externally(self):
        self.configure_vault()
        shutil.rmtree(self.vault)  # simulates deletion outside StarCore (File Explorer, `rm -rf`, ...)

        status, payload = self.status()
        self.assertEqual(status, 200)  # never a crash
        self.assertTrue(payload["configured"])
        self.assertFalse(payload["path_exists"])

    def test_path_exists_is_none_when_nothing_is_configured(self):
        status, payload = self.status()
        self.assertIsNone(payload["path_exists"])

    # ---------- delink ----------

    def test_delink_removes_the_configured_path(self):
        self.configure_vault()
        status, payload = self.json_request("/api/satellites/LockedFolder/delink", "POST", {})
        self.assertEqual(status, 200)
        self.assertTrue(payload["delinked"])

        _, status_payload = self.status()
        self.assertFalse(status_payload["configured"])
        self.assertIsNone(status_payload["path"])

    def test_delinking_an_unconfigured_locked_folder_is_a_clean_400(self):
        status, payload = self.json_request("/api/satellites/LockedFolder/delink", "POST", {})
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_delink_invalidates_the_active_unlock(self):
        self.configure_vault()
        self.set_pin("1234")
        self.unlock("1234")
        self.assertTrue(self.status()[1]["unlocked"])

        self.json_request("/api/satellites/LockedFolder/delink", "POST", {})
        self.assertFalse(self.status()[1]["unlocked"])

    def test_delink_clears_a_brute_force_lockout(self):
        self.configure_vault()
        self.locked_folder.config.data["max_pin_attempts"] = 2
        self.set_pin("1234")
        for _ in range(2):
            self.unlock("0000")
        status, _ = self.unlock("0000")
        self.assertEqual(status, 429)  # locked out

        self.json_request("/api/satellites/LockedFolder/delink", "POST", {})
        self.configure_vault()  # reconfigure the exact same path

        status, payload = self.unlock("1234")
        self.assertEqual(status, 200, "a lockout earned before delinking should not linger afterward")

    def test_after_delink_file_explorer_no_longer_treats_the_old_path_as_protected(self):
        self.configure_vault()
        self.json_request("/api/satellites/LockedFolder/delink", "POST", {})

        status, payload = self.fe_entries(str(self.vault))
        self.assertEqual(status, 200)  # no longer protected at all

    def test_a_new_locked_folder_can_be_configured_after_delinking(self):
        self.configure_vault()
        self.set_pin("1234")
        self.json_request("/api/satellites/LockedFolder/delink", "POST", {})

        other_vault = self.directory / "other-vault"
        other_vault.mkdir()
        status, payload = self.json_request(
            "/api/satellites/LockedFolder/configuration", "POST",
            {"key": "locked_folder_path", "value": str(other_vault)})
        self.assertEqual(status, 200)

        # delinking never touches the PIN itself - the same one still works
        # for the newly configured location
        status, payload = self.unlock("1234")
        self.assertEqual(status, 200)

        status, entries_payload = self.fe_entries(str(other_vault))
        self.assertEqual(status, 200)

    def test_delinking_leaves_the_directory_untouched_on_disk(self):
        self.configure_vault()
        self.json_request("/api/satellites/LockedFolder/delink", "POST", {})

        self.assertTrue(self.vault.is_dir())
        self.assertTrue((self.vault / "secret.txt").is_file())

    def test_delink_of_a_missing_directory_still_works(self):
        self.configure_vault()
        shutil.rmtree(self.vault)

        status, payload = self.json_request("/api/satellites/LockedFolder/delink", "POST", {})
        self.assertEqual(status, 200)
        self.assertFalse(self.status()[1]["configured"])

    # ---------- unauthenticated access ----------

    def test_every_locked_folder_route_requires_a_session(self):
        for path, method, payload in (
            ("/api/satellites/LockedFolder/status", "GET", None),
            ("/api/satellites/LockedFolder/unlock", "POST", {"pin": "1234"}),
            ("/api/satellites/LockedFolder/lock", "POST", {}),
            ("/api/satellites/LockedFolder/pin", "POST", {"pin": "1234"}),
            ("/api/satellites/LockedFolder/delink", "POST", {}),
        ):
            status, _ = self.request(path, method, payload, token="not-a-real-token")
            self.assertEqual(status, 401, f"{method} {path} should require a valid session")

    def test_only_get_and_post_are_ever_allowed(self):
        for method in ("PUT", "PATCH", "DELETE"):
            status, _ = self.request("/api/satellites/LockedFolder/status", method, token=self.token)
            self.assertEqual(status, 405)


class LockedFolderStorageMigrationTest(unittest.TestCase):
    """Where the PIN hash actually lives on disk - see runtime_paths.py and
    "Runtime data location" in docs/deployment.md. Deliberately a separate
    fixture from LockedFolderApiTest above: that fixture always points
    "storage" at an explicit temp path precisely so its tests never depend
    on (or accidentally exercise) this default-resolution/migration logic -
    these tests are the ones that actually put the literal default ("data")
    in play, with STARCORE_DATA_DIR redirected so nothing here can ever
    read or write a real machine's actual application-data directory.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="starcore-lockedfolder-migration-"))
        self.data_dir = self.tmp / "app-data"
        self._env_patch = mock.patch.dict(os.environ, {"STARCORE_DATA_DIR": str(self.data_dir)})
        self._env_patch.start()

        self.engine = start_engine(mission_control=True)
        if not self.engine.api.running:
            self._cleanup()
            raise unittest.SkipTest("Mission Control could not be started")

        self.locked_folder = self.engine.registry.get("LockedFolder")
        if self.locked_folder is None:
            self._cleanup()
            raise unittest.SkipTest("LockedFolder satellite did not load")
        # deliberately NOT overriding "storage" here, unlike LockedFolderApiTest -
        # but configuration.update() (via configure_vault()'s POST) still
        # persists through satellite.config.set(), which writes straight to
        # config.path, so that still has to be redirected to a disposable
        # file - otherwise a test run here would corrupt the real
        # satellites/native/locked_folder/config.toml in the checkout (see
        # PhotoSyncConfigurationTest in test_photo.py for the same pattern)
        self.locked_folder.config.path = self.tmp / "config.toml"

        self.engine.auth = AuthStore(self.tmp / "auth.json")
        self.token = self.engine.auth.bootstrap("admin", "a very good password")

    def tearDown(self):
        self._cleanup()

    def _cleanup(self):
        if getattr(self, "engine", None) is not None:
            stop_engine(self.engine)
        self._env_patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)
        legacy = getattr(self, "locked_folder", None)
        if legacy is not None:
            shutil.rmtree(legacy.path / "data", ignore_errors=True)

    # ---------- HTTP helpers (a small, deliberate duplicate of
    # LockedFolderApiTest's - see the class docstring for why this fixture
    # is kept separate rather than sharing one) ----------

    def request(self, path, method="GET", payload=None, token=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def json_request(self, path, method="GET", payload=None, token=None):
        status, body = self.request(path, method, payload, token=token if token is not None else self.token)
        return status, (json.loads(body.decode("utf-8")) if body else {})

    def status(self):
        return self.json_request("/api/satellites/LockedFolder/status")

    def configure_vault(self, vault: Path):
        status, payload = self.json_request(
            "/api/satellites/LockedFolder/configuration", "POST",
            {"key": "locked_folder_path", "value": str(vault)})
        self.assertEqual(status, 200)
        return payload

    # ---------- tests ----------

    def test_a_fresh_install_stores_the_pin_outside_the_git_checkout(self):
        vault = self.tmp / "vault"
        vault.mkdir()
        self.configure_vault(vault)

        status, payload = self.json_request("/api/satellites/LockedFolder/pin", "POST", {"pin": "1234"})
        self.assertEqual(status, 200)

        new_pin = self.data_dir / "satellites" / "LockedFolder" / "pin.json"
        self.assertTrue(new_pin.is_file(), f"expected the PIN at {new_pin}")
        self.assertFalse((self.locked_folder.path / "data").exists(),
                          "nothing should be written inside the satellite's own directory in the checkout")

    def test_a_pin_from_the_historical_location_is_migrated_automatically(self):
        legacy_dir = self.locked_folder.path / "data"
        legacy_dir.mkdir(parents=True, exist_ok=True)
        legacy_pin = legacy_dir / "pin.json"
        legacy_pin.write_text('{"salt": "aa", "hash": "bb"}', encoding="utf-8")

        # the very first request that touches the Locked Folder's runtime
        # triggers the migration - a plain status check is enough
        status, payload = self.status()
        self.assertEqual(status, 200)
        self.assertTrue(payload["pin_set"], "the migrated PIN should already be recognized")

        new_pin = self.data_dir / "satellites" / "LockedFolder" / "pin.json"
        self.assertTrue(new_pin.is_file())
        self.assertEqual(new_pin.read_text(encoding="utf-8"), '{"salt": "aa", "hash": "bb"}')
        self.assertFalse(legacy_pin.exists(), "the historical file should be moved, not copied")

    def test_migration_never_overwrites_a_pin_already_at_the_new_location(self):
        new_dir = self.data_dir / "satellites" / "LockedFolder"
        new_dir.mkdir(parents=True, exist_ok=True)
        (new_dir / "pin.json").write_text('{"salt": "new", "hash": "new"}', encoding="utf-8")

        legacy_dir = self.locked_folder.path / "data"
        legacy_dir.mkdir(parents=True, exist_ok=True)
        (legacy_dir / "pin.json").write_text('{"salt": "old", "hash": "old"}', encoding="utf-8")

        self.status()  # would-be migration trigger

        self.assertEqual((new_dir / "pin.json").read_text(encoding="utf-8"), '{"salt": "new", "hash": "new"}')
        # the legacy file is simply left alone - never destroyed - when the
        # new location already has its own
        self.assertTrue((legacy_dir / "pin.json").exists())
