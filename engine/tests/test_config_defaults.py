"""Configuration defaults: the config.default.toml mechanism that lets a
future StarCore version add a new setting without ever touching (or
conflicting with) a machine's own, already-edited config.toml.

Covers the shared reconcile()/load_defaults() helpers in isolation
(config_defaults.py), both callers that build on them - engine_config's
Configuration ([section]-based) and satellite_config's SatelliteConfig
(flat) - and satellite discovery actually wiring a satellite's own
config.default.toml through. See docs/deployment.md, "Keeping configuration
up to date".
"""

from pathlib import Path
import tempfile
import unittest

from starcore.config_defaults import load_defaults, reconcile
from starcore.engine_config import Configuration
from starcore.satellite_config import SatelliteConfig
from starcore.satellite_loader import SatelliteLoader
from starcore.satellite_registry import SatelliteRegistry


def _tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="starcore-config-defaults-tests-"))


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


class LoadDefaultsTest(unittest.TestCase):
    def test_none_path_is_treated_as_no_defaults(self):
        self.assertEqual(load_defaults(None), {})

    def test_a_missing_defaults_file_is_treated_as_no_defaults(self):
        self.assertEqual(load_defaults(_tmpdir() / "does-not-exist.toml"), {})

    def test_an_invalid_defaults_file_is_treated_as_no_defaults(self):
        path = _write(_tmpdir() / "config.default.toml", "this is not [valid toml")

        self.assertEqual(load_defaults(path), {})

    def test_a_valid_defaults_file_is_parsed(self):
        path = _write(_tmpdir() / "config.default.toml", 'enabled = true\nlibrary = "~/Music"\n')

        self.assertEqual(load_defaults(path), {"enabled": True, "library": "~/Music"})


class ReconcileTest(unittest.TestCase):
    """Direct tests of reconcile() itself, independent of either caller."""

    def test_a_missing_flat_key_is_added(self):
        path = _write(_tmpdir() / "config.toml", "enabled = true\n")
        live = {"enabled": True}

        added = reconcile(path, live, {"enabled": True, "library": "~/Music"})

        self.assertEqual(added, [(None, "library")])
        self.assertEqual(live, {"enabled": True, "library": "~/Music"})
        self.assertIn('library = "~/Music"', path.read_text(encoding="utf-8"))

    def test_a_missing_key_inside_a_section_is_added(self):
        path = _write(_tmpdir() / "config.toml", "[server]\nhost = \"127.0.0.1\"\n")
        live = {"server": {"host": "127.0.0.1"}}

        added = reconcile(path, live, {"server": {"host": "127.0.0.1", "port": 8080}})

        self.assertEqual(added, [("server", "port")])
        self.assertEqual(live, {"server": {"host": "127.0.0.1", "port": 8080}})
        self.assertIn("port = 8080", path.read_text(encoding="utf-8"))

    def test_an_existing_value_is_never_overwritten(self):
        path = _write(_tmpdir() / "config.toml", "[server]\nport = 9090\n")
        live = {"server": {"port": 9090}}

        added = reconcile(path, live, {"server": {"port": 8080}})

        self.assertEqual(added, [])
        self.assertEqual(live["server"]["port"], 9090)
        self.assertIn("port = 9090", path.read_text(encoding="utf-8"))
        self.assertNotIn("8080", path.read_text(encoding="utf-8"))

    def test_a_custom_key_the_defaults_do_not_have_is_left_alone(self):
        path = _write(_tmpdir() / "config.toml", "[server]\nhost = \"127.0.0.1\"\ncustom_thing = 42\n")
        live = {"server": {"host": "127.0.0.1", "custom_thing": 42}}

        added = reconcile(path, live, {"server": {"host": "127.0.0.1"}})

        self.assertEqual(added, [])
        self.assertEqual(live["server"]["custom_thing"], 42)

    def test_nothing_to_add_makes_no_writes_at_all(self):
        path = _write(_tmpdir() / "config.toml", "[server]\nport = 9090\n")
        before = path.read_text(encoding="utf-8")
        live = {"server": {"port": 9090}}

        added = reconcile(path, live, {"server": {"port": 8080}})

        self.assertEqual(added, [])
        self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_a_missing_section_entirely_is_created(self):
        path = _write(_tmpdir() / "config.toml", "[engine]\nname = \"StarCore\"\n")
        live = {"engine": {"name": "StarCore"}}

        added = reconcile(path, live, {"server": {"host": "127.0.0.1"}})

        self.assertEqual(added, [("server", "host")])
        text = path.read_text(encoding="utf-8")
        self.assertIn("[server]", text)
        self.assertIn('host = "127.0.0.1"', text)

    def test_an_empty_defaults_dict_adds_nothing(self):
        path = _write(_tmpdir() / "config.toml", "[server]\nport = 9090\n")
        before = path.read_text(encoding="utf-8")
        live = {"server": {"port": 9090}}

        added = reconcile(path, live, {})

        self.assertEqual(added, [])
        self.assertEqual(path.read_text(encoding="utf-8"), before)


class ConfigurationDefaultsTest(unittest.TestCase):
    """engine_config.Configuration, given a defaults_path."""

    def test_without_a_defaults_path_nothing_is_reconciled(self):
        path = _write(_tmpdir() / "config.toml", "[server]\nhost = \"127.0.0.1\"\n")

        config = Configuration(path)

        self.assertEqual(config.added_defaults, [])
        self.assertEqual(config.section("server"), {"host": "127.0.0.1"})

    def test_a_missing_config_file_is_bootstrapped_entirely_from_defaults(self):
        directory = _tmpdir()
        config_path = directory / "config.toml"
        defaults_path = _write(directory / "config.default.toml",
                                '[engine]\nname = "StarCore"\n\n[server]\nhost = "127.0.0.1"\nport = 8080\n')

        config = Configuration(config_path, defaults_path=defaults_path)

        self.assertTrue(config_path.is_file())
        self.assertEqual(config.section("engine")["name"], "StarCore")
        self.assertEqual(config.section("server"), {"host": "127.0.0.1", "port": 8080})
        self.assertEqual(len(config.added_defaults), 3)

    def test_an_existing_config_gains_a_new_default_key_without_losing_its_own_values(self):
        directory = _tmpdir()
        config_path = _write(directory / "config.toml", '[server]\nhost = "0.0.0.0"\nport = 9090\n')
        defaults_path = _write(directory / "config.default.toml",
                                '[server]\nhost = "127.0.0.1"\nport = 8080\nhttps_enabled = false\n')

        config = Configuration(config_path, defaults_path=defaults_path)

        # the installation's own edited values survive untouched...
        self.assertEqual(config.section("server")["host"], "0.0.0.0")
        self.assertEqual(config.section("server")["port"], 9090)
        # ...and the new key introduced by this "upgrade" is filled in
        self.assertEqual(config.section("server")["https_enabled"], False)
        self.assertEqual(config.added_defaults, [("server", "https_enabled")])

        text = config_path.read_text(encoding="utf-8")
        self.assertIn('host = "0.0.0.0"', text)
        self.assertIn("port = 9090", text)
        self.assertIn("https_enabled = false", text)

    def test_reconciling_is_idempotent(self):
        directory = _tmpdir()
        config_path = _write(directory / "config.toml", '[server]\nhost = "0.0.0.0"\n')
        defaults_path = _write(directory / "config.default.toml", '[server]\nhost = "127.0.0.1"\nport = 8080\n')

        Configuration(config_path, defaults_path=defaults_path)
        second = Configuration(config_path, defaults_path=defaults_path)

        self.assertEqual(second.added_defaults, [])
        self.assertEqual(second.section("server"), {"host": "0.0.0.0", "port": 8080})

    def test_a_missing_defaults_file_is_the_same_as_none(self):
        directory = _tmpdir()
        config_path = _write(directory / "config.toml", '[server]\nhost = "0.0.0.0"\n')

        config = Configuration(config_path, defaults_path=directory / "does-not-exist.toml")

        self.assertEqual(config.added_defaults, [])
        self.assertEqual(config.section("server"), {"host": "0.0.0.0"})


class SatelliteConfigDefaultsTest(unittest.TestCase):
    """satellite_config.SatelliteConfig, given a defaults_path."""

    def test_without_a_defaults_path_nothing_is_reconciled(self):
        path = _write(_tmpdir() / "config.toml", "enabled = true\n")

        config = SatelliteConfig({"enabled": True}, path=path)

        self.assertEqual(config.added_defaults, [])
        self.assertEqual(config.data, {"enabled": True})

    def test_a_missing_config_file_is_bootstrapped_entirely_from_defaults(self):
        directory = _tmpdir()
        config_path = directory / "config.toml"
        defaults_path = _write(directory / "config.default.toml", 'enabled = true\nlibrary = "~/Music"\n')

        config = SatelliteConfig({}, path=config_path, defaults_path=defaults_path)

        self.assertTrue(config_path.is_file())
        self.assertEqual(config.data, {"enabled": True, "library": "~/Music"})

    def test_an_existing_config_gains_a_new_default_key_without_losing_its_own_values(self):
        directory = _tmpdir()
        config_path = _write(directory / "config.toml", 'enabled = true\nlibrary = "/mnt/music"\n')
        defaults_path = _write(directory / "config.default.toml", 'enabled = true\nlibrary = "~/Music"\nnew_setting = 42\n')

        config = SatelliteConfig({"enabled": True, "library": "/mnt/music"}, path=config_path, defaults_path=defaults_path)

        self.assertEqual(config.data["library"], "/mnt/music")
        self.assertEqual(config.data["new_setting"], 42)
        self.assertEqual(config.added_defaults, [(None, "new_setting")])

    def test_no_path_means_reconciliation_is_skipped_entirely(self):
        # a SatelliteConfig with nowhere to persist to (no config.toml at
        # all) can't bootstrap one from defaults either - this only ever
        # happens for a SatelliteConfig built by hand, never through
        # discovery (SatelliteLoader always gives it a path)
        config = SatelliteConfig({}, path=None, defaults_path=_tmpdir() / "config.default.toml")

        self.assertEqual(config.added_defaults, [])
        self.assertEqual(config.data, {})


class SatelliteLoaderDefaultsTest(unittest.TestCase):
    """Satellite discovery actually wiring a satellite's own
    config.default.toml through to its SatelliteConfig."""

    def setUp(self):
        self.root = _tmpdir()
        self.native = self.root / "native"
        self.link = self.root / "link"
        self.native.mkdir()
        self.link.mkdir()
        self.loader = SatelliteLoader(SatelliteRegistry(), self.native, self.link)

    def _satellite_dir(self, name="fake") -> Path:
        satellite_dir = self.native / name
        satellite_dir.mkdir()
        _write(satellite_dir / "satellite.toml",
               f'name = "{name.title()}"\nversion = "1.0.0"\nauthor = "tests"\ndescription = "A fake satellite."\n')
        return satellite_dir

    def test_a_satellites_own_config_default_toml_fills_in_a_missing_key(self):
        satellite_dir = self._satellite_dir()
        _write(satellite_dir / "config.toml", 'enabled = true\nlibrary = "/mnt/music"\n')
        _write(satellite_dir / "config.default.toml", 'enabled = true\nlibrary = "~/Music"\nnew_setting = 42\n')

        satellite = self.loader._build_satellite(satellite_dir, "native")

        self.assertEqual(satellite.config.get("library"), "/mnt/music")
        self.assertEqual(satellite.config.get("new_setting"), 42)
        self.assertIn("new_setting = 42", (satellite_dir / "config.toml").read_text(encoding="utf-8"))

    def test_a_satellite_with_no_config_toml_yet_is_bootstrapped_from_its_defaults(self):
        satellite_dir = self._satellite_dir()
        _write(satellite_dir / "config.default.toml", 'enabled = true\nlibrary = "~/Music"\n')

        satellite = self.loader._build_satellite(satellite_dir, "native")

        self.assertTrue((satellite_dir / "config.toml").is_file())
        self.assertEqual(satellite.config.get("enabled"), True)
        self.assertEqual(satellite.config.get("library"), "~/Music")

    def test_a_satellite_with_neither_file_still_gets_an_empty_config(self):
        satellite_dir = self._satellite_dir()

        satellite = self.loader._build_satellite(satellite_dir, "native")

        self.assertEqual(satellite.config.data, {})
        self.assertFalse((satellite_dir / "config.toml").is_file())

    def test_a_satellites_own_custom_setting_survives_reconciliation(self):
        satellite_dir = self._satellite_dir()
        _write(satellite_dir / "config.toml", 'enabled = true\nlocked_folder_path = "D:\\\\vault"\n')
        _write(satellite_dir / "config.default.toml",
               'enabled = true\nlocked_folder_path = ""\nsession_timeout_seconds = 900\n')

        satellite = self.loader._build_satellite(satellite_dir, "native")

        self.assertEqual(satellite.config.get("locked_folder_path"), "D:\\vault")
        self.assertEqual(satellite.config.get("session_timeout_seconds"), 900)


if __name__ == "__main__":
    unittest.main()
