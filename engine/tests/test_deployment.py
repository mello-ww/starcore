"""Platform-neutral path/config behaviour, and running away from the repository."""

from pathlib import Path
from unittest import mock
import os
import tempfile
import threading
import unittest

from starcore import core as core_module
from starcore.cli.main import run
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


if __name__ == "__main__":
    unittest.main()
