"""Platform-neutral path/config behaviour, and running away from the repository."""

from pathlib import Path
from unittest import mock
import os
import shutil
import tempfile
import threading
import unittest

from starcore import core as core_module
from starcore import runtime_paths
from starcore.auth import AuthStore
from starcore.cli.main import run
from starcore.core import StarCore
from starcore.engine_config import Configuration
from tests.support import start_engine, stop_engine


class ConfigurationTest(unittest.TestCase):
    def test_a_missing_config_file_falls_back_to_defaults(self):
        missing = Path(tempfile.mkdtemp(prefix="starcore-tests-")) / "does-not-exist.toml"

        config = Configuration(missing)

        self.assertEqual(config.config_data, {})
        self.assertEqual(config.get("engine", "fallback"), "fallback")
        self.assertEqual(config.section("server"), {})

    def test_invalid_toml_falls_back_to_defaults(self):
        directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))
        broken = directory / "config.toml"
        broken.write_text("this is not [ valid toml", encoding="utf-8")

        config = Configuration(broken)

        self.assertEqual(config.config_data, {})

    def test_section_of_a_non_table_key_is_an_empty_dict(self):
        directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))
        path = directory / "config.toml"
        path.write_text('engine = "not a table"\n', encoding="utf-8")

        config = Configuration(path)

        self.assertEqual(config.section("engine"), {})


class PathConstructionTest(unittest.TestCase):
    def test_engine_paths_are_absolute_pathlib_paths(self):
        for value in (core_module.ENGINE_DIR, core_module.BASE_DIR, core_module.CONFIG_PATH):
            self.assertIsInstance(value, Path)
            self.assertTrue(value.is_absolute())

        self.assertEqual(core_module.BASE_DIR, core_module.ENGINE_DIR.parent)
        self.assertEqual(core_module.CONFIG_PATH, core_module.ENGINE_DIR / "config.toml")

    def test_satellite_directories_are_derived_from_base_dir_not_cwd(self):
        engine = start_engine()
        try:
            self.assertEqual(engine.native_path, core_module.BASE_DIR / "satellites" / "native")
            self.assertEqual(engine.link_path, core_module.BASE_DIR / "satellites" / "link")
        finally:
            stop_engine(engine)


class WorkingDirectoryIndependenceTest(unittest.TestCase):
    def test_starting_from_a_different_working_directory_still_finds_everything(self):
        original_cwd = Path.cwd()
        elsewhere = Path(tempfile.mkdtemp(prefix="starcore-elsewhere-"))

        os.chdir(elsewhere)
        try:
            engine = start_engine(mission_control=True)
            try:
                self.assertTrue(engine.registry.all(), "no satellites were discovered")
                self.assertIsNotNone(engine.registry.get("Photo"))

                self.assertTrue(engine.api.web_root.is_dir())
                self.assertTrue((engine.api.web_root / "index.html").is_file())

                photo = engine.registry.get("Photo")
                self.assertTrue(photo.assets_path.is_dir())
                self.assertTrue((photo.assets_path / "page.js").is_file())
            finally:
                stop_engine(engine)
        finally:
            os.chdir(original_cwd)


class DeterministicDiscoveryOrderTest(unittest.TestCase):
    def test_satellite_discovery_order_does_not_depend_on_filesystem_order(self):
        engine = start_engine()
        try:
            native_names = [satellite.path.name for satellite in engine.registry.all()
                             if satellite.type == "native"]
            self.assertEqual(native_names, sorted(native_names))
        finally:
            stop_engine(engine)

    def test_command_discovery_order_does_not_depend_on_filesystem_order(self):
        engine = start_engine()
        try:
            core_command_names = [name for name, entry in engine.command_registry.all().items()
                                   if entry["source"] == "core"]
            self.assertEqual(core_command_names, sorted(core_command_names))
        finally:
            stop_engine(engine)


class HeadlessCliTest(unittest.TestCase):
    def test_a_non_interactive_stdin_does_not_start_a_reader_thread(self):
        engine = start_engine()
        try:
            with mock.patch("starcore.cli.main._interactive", return_value=False):
                runner = threading.Thread(target=run, args=(engine,), daemon=True)
                runner.start()
                runner.join(timeout=0.2)

                self.assertTrue(runner.is_alive(), "run() returned before a stop was requested")
                self.assertNotIn("starcore-cli", {thread.name for thread in threading.enumerate()})

                engine.stop()
                runner.join(timeout=2)

            self.assertFalse(runner.is_alive())
        finally:
            stop_engine(engine)


class RuntimeDataDirectoryTest(unittest.TestCase):
    """runtime_paths.data_dir() - where StarCore's own credentials, sessions
    and generated satellite secrets live, kept out of the Git checkout by
    default. See docs/deployment.md, "Runtime data location".
    """

    def test_the_environment_override_always_wins(self):
        with mock.patch.dict(os.environ, {runtime_paths.ENV_OVERRIDE: "/somewhere/custom"}):
            self.assertEqual(runtime_paths.data_dir(), Path("/somewhere/custom"))

    def test_the_environment_override_expands_a_leading_tilde(self):
        with mock.patch.dict(os.environ, {runtime_paths.ENV_OVERRIDE: "~/custom-starcore-data"}):
            self.assertEqual(runtime_paths.data_dir(), Path.home() / "custom-starcore-data")

    def test_windows_uses_appdata_roaming(self):
        with mock.patch.dict(os.environ, {runtime_paths.ENV_OVERRIDE: "", "APPDATA": "C:\\Users\\nathan\\AppData\\Roaming"}), \
             mock.patch.object(runtime_paths.sys, "platform", "win32"):
            self.assertEqual(runtime_paths.data_dir(), Path("C:\\Users\\nathan\\AppData\\Roaming") / "StarCore")

    def test_windows_falls_back_to_home_appdata_roaming_if_unset(self):
        env = os.environ.copy()
        env.pop("APPDATA", None)
        env[runtime_paths.ENV_OVERRIDE] = ""
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(runtime_paths.sys, "platform", "win32"):
            self.assertEqual(runtime_paths.data_dir(), Path.home() / "AppData" / "Roaming" / "StarCore")

    def test_linux_uses_xdg_data_home(self):
        with mock.patch.dict(os.environ, {runtime_paths.ENV_OVERRIDE: "", "XDG_DATA_HOME": "/home/nathan/.data"}), \
             mock.patch.object(runtime_paths.sys, "platform", "linux"):
            self.assertEqual(runtime_paths.data_dir(), Path("/home/nathan/.data") / "starcore")

    def test_linux_falls_back_to_local_share_if_unset(self):
        env = os.environ.copy()
        env.pop("XDG_DATA_HOME", None)
        env[runtime_paths.ENV_OVERRIDE] = ""
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(runtime_paths.sys, "platform", "linux"):
            self.assertEqual(runtime_paths.data_dir(), Path.home() / ".local" / "share" / "starcore")

    def test_data_dir_never_creates_anything(self):
        directory = Path(tempfile.mkdtemp(prefix="starcore-tests-")) / "not-yet-created"
        with mock.patch.dict(os.environ, {runtime_paths.ENV_OVERRIDE: str(directory)}):
            result = runtime_paths.data_dir()
        self.assertEqual(result, directory)
        self.assertFalse(directory.exists())


class LegacyFileMigrationTest(unittest.TestCase):
    """runtime_paths.migrate_legacy_file() - the one, shared, safe-by-
    construction routine every runtime-data migration in this milestone
    goes through (AuthStore's auth.json, the Locked Folder's pin.json),
    rather than each reimplementing its own "move this file, carefully"
    logic.
    """

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_nothing_to_migrate_returns_the_new_path(self):
        legacy = self.directory / "legacy" / "file.json"
        new = self.directory / "new" / "file.json"

        result = runtime_paths.migrate_legacy_file(legacy, new)

        self.assertEqual(result, new)
        self.assertFalse(new.exists())

    def test_an_existing_legacy_file_is_moved_to_the_new_location(self):
        legacy = self.directory / "legacy" / "file.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_text('{"secret": true}', encoding="utf-8")
        new = self.directory / "new" / "nested" / "file.json"

        result = runtime_paths.migrate_legacy_file(legacy, new)

        self.assertEqual(result, new)
        self.assertTrue(new.is_file())
        self.assertEqual(new.read_text(encoding="utf-8"), '{"secret": true}')
        self.assertFalse(legacy.exists(), "the legacy file should be moved, not copied")

    def test_an_existing_new_file_is_never_overwritten(self):
        legacy = self.directory / "legacy" / "file.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("old", encoding="utf-8")
        new = self.directory / "new" / "file.json"
        new.parent.mkdir(parents=True)
        new.write_text("already here", encoding="utf-8")

        result = runtime_paths.migrate_legacy_file(legacy, new)

        self.assertEqual(result, new)
        self.assertEqual(new.read_text(encoding="utf-8"), "already here")
        self.assertTrue(legacy.exists(), "an untouched legacy file is left alone, never deleted")

    def test_a_failed_move_falls_back_to_the_legacy_path_without_losing_the_file(self):
        legacy = self.directory / "legacy" / "file.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("irreplaceable", encoding="utf-8")
        new = self.directory / "new" / "file.json"

        with mock.patch("starcore.runtime_paths.shutil.move", side_effect=OSError("simulated failure")):
            result = runtime_paths.migrate_legacy_file(legacy, new)

        self.assertEqual(result, legacy)
        self.assertTrue(legacy.is_file())
        self.assertEqual(legacy.read_text(encoding="utf-8"), "irreplaceable")
        self.assertFalse(new.exists())


class AuthStoreMigrationTest(unittest.TestCase):
    """StarCore.__init__ wiring: an existing engine/data/auth.json (the
    historical, in-checkout location) is migrated to the application-data
    directory automatically, and a fresh install simply starts there - see
    "Runtime data location" in docs/deployment.md. Patches core.ENGINE_DIR
    so this can never touch the real checkout's actual engine/data/, and
    STARCORE_DATA_DIR so it can never touch a real machine's actual
    application-data directory either.
    """

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))
        self.fake_engine_dir = self.directory / "engine"
        self.fake_engine_dir.mkdir()
        (self.fake_engine_dir / "config.toml").write_text(
            "[server]\nenabled = false\n", encoding="utf-8")
        self.data_dir = self.directory / "app-data"

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def _build_engine(self):
        with mock.patch("starcore.core.ENGINE_DIR", self.fake_engine_dir), \
             mock.patch.dict(os.environ, {runtime_paths.ENV_OVERRIDE: str(self.data_dir)}):
            return StarCore(self.fake_engine_dir / "config.toml")

    def test_a_fresh_install_places_the_auth_store_in_the_data_directory(self):
        engine = self._build_engine()

        self.assertEqual(engine.auth.path, self.data_dir / "auth.json")
        self.assertFalse(engine.auth.is_bootstrapped)
        self.assertFalse((self.fake_engine_dir / "data").exists())

    def test_an_existing_legacy_auth_store_is_migrated_and_preserved(self):
        legacy_auth = AuthStore(self.fake_engine_dir / "data" / "auth.json")
        token = legacy_auth.bootstrap("mellow", "a very good password")

        engine = self._build_engine()

        self.assertEqual(engine.auth.path, self.data_dir / "auth.json")
        self.assertTrue(engine.auth.is_bootstrapped)
        self.assertTrue(engine.auth.validate_session(token),
                         "an existing session should still be valid after migration")
        self.assertFalse((self.fake_engine_dir / "data" / "auth.json").exists(),
                          "the legacy file should be moved, not copied")


if __name__ == "__main__":
    unittest.main()
