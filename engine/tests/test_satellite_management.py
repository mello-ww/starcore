"""Satellite enable/disable/reload: StarCore.set_satellite_enabled() and
.reload_satellite(), and the generic /enable, /disable, /reload endpoints
that expose them over the API.

These use disposable fake satellites (never the real Photo/Music/Status/Docker
ones) so a failing hook or a broken manifest can be exercised on purpose
without touching real storage or a real background service.
"""

from contextlib import redirect_stdout
from http.client import HTTPConnection
from pathlib import Path
import io
import json
import tempfile
import tomllib
import unittest

from starcore.auth import AuthStore
from starcore.core import StarCore, SatelliteError
from starcore.satellite_loader import SatelliteLoadError
from starcore.api.payloads import describe_satellite

SATELLITE_TOML = """name = "{name}"
version = "{version}"
author = "tests"
description = "{description}"
"""

CONFIG_TOML = "enabled = {enabled}\n"

SATELLITE_PY = '''from pathlib import Path

MARKER = Path(r"{marker}")
FAIL = Path(r"{fail}")


def _record(event):
    with open(MARKER, "a", encoding="utf-8") as file:
        file.write(event + "\\n")


def start(engine, satellite):
    if (FAIL / "start").exists():
        raise RuntimeError("start failed on purpose")
    _record("start")


def stop(engine, satellite):
    if (FAIL / "stop").exists():
        raise RuntimeError("stop failed on purpose")
    _record("stop")
'''

COMMAND_PY = '''COMMAND = {{
    "description": "{description}",
    "usage": "fake-command",
    "aliases": [],
    "category": "Test",
}}


def fake_command(engine, args):
    print("fake")
'''


def _build_fake_satellite(root: Path, name="Fake", enabled=True, version="1.0.0",
                           description="A fake satellite for lifecycle tests.",
                           command_description="A fake command.", with_lifecycle=True) -> dict:
    """Writes one satellite directory under `root` and returns its marker/fail paths.

    `marker` accumulates one line per start()/stop() call actually made, so a
    test can check exactly what ran without needing shared Python state across
    a dynamically loaded module. `fail` is a directory tests can drop an empty
    "start" or "stop" file into to make the corresponding hook raise on demand.
    """
    satellite_dir = root / name.lower()
    satellite_dir.mkdir(parents=True, exist_ok=True)
    (satellite_dir / "satellite.toml").write_text(
        SATELLITE_TOML.format(name=name, version=version, description=description), encoding="utf-8")
    (satellite_dir / "config.toml").write_text(
        CONFIG_TOML.format(enabled=str(enabled).lower()), encoding="utf-8")

    marker = satellite_dir / "marker.log"
    fail = satellite_dir / "fail"
    fail.mkdir(exist_ok=True)
    if with_lifecycle:
        (satellite_dir / "satellite.py").write_text(
            SATELLITE_PY.format(marker=marker, fail=fail), encoding="utf-8")

    commands_dir = satellite_dir / "commands"
    commands_dir.mkdir(exist_ok=True)
    (commands_dir / "fake_command.py").write_text(
        COMMAND_PY.format(description=command_description), encoding="utf-8")

    return {"dir": satellite_dir, "marker": marker, "fail": fail}


def _events(marker: Path) -> list:
    if not marker.exists():
        return []
    return [line for line in marker.read_text(encoding="utf-8").splitlines() if line]


def _fail(fail_dir: Path, hook: str):
    (fail_dir / hook).write_text("", encoding="utf-8")


def _engine(services=True, mission_control=False) -> tuple:
    """A StarCore pointed at an empty, disposable native/link pair of directories -
    never the repository's real satellites - so tests can populate exactly the
    fake satellites they need and nothing else gets discovered or started."""
    directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))
    native = directory / "native"
    link = directory / "link"
    native.mkdir()
    link.mkdir()

    config_path = directory / "config.toml"
    config_path.write_text(
        f"[engine]\nname = \"StarCore\"\n\n[server]\nenabled = {str(mission_control).lower()}\n"
        f"host = \"127.0.0.1\"\nport = 0\n\n[satellites]\nservices = {str(services).lower()}\n",
        encoding="utf-8")

    engine = StarCore(config_path)
    engine.native_path = native
    engine.link_path = link
    engine.auth = AuthStore(directory / "auth.json")  # never the real engine/data/auth.json

    with redirect_stdout(io.StringIO()):
        engine.start()

    return engine, native, link


def _stop(engine):
    with redirect_stdout(io.StringIO()):
        engine.stop()


class EnableDisableTest(unittest.TestCase):
    def test_disabling_a_running_satellite_stops_it_and_persists(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")
        with redirect_stdout(io.StringIO()):
            satellite.start(engine)  # simulate boot having already started it
        self.assertEqual(_events(fixture["marker"]), ["start"])

        with redirect_stdout(io.StringIO()):
            result = engine.set_satellite_enabled("Fake", False)

        self.assertIsNone(result["error"])
        self.assertFalse(engine.registry.get("Fake").enabled)
        self.assertEqual(_events(fixture["marker"]), ["start", "stop"])
        self.assertFalse(tomllib.loads((fixture["dir"] / "config.toml").read_text())["enabled"])
        _stop(engine)

    def test_enabling_a_disabled_satellite_starts_it_and_persists(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native, enabled=False)
        engine.loader._discover_directory(native, "native")
        self.assertFalse(engine.registry.get("Fake").enabled)

        with redirect_stdout(io.StringIO()):
            result = engine.set_satellite_enabled("Fake", True)

        self.assertIsNone(result["error"])
        self.assertTrue(engine.registry.get("Fake").enabled)
        self.assertEqual(_events(fixture["marker"]), ["start"])
        self.assertTrue(tomllib.loads((fixture["dir"] / "config.toml").read_text())["enabled"])
        _stop(engine)

    def test_setting_the_same_state_is_a_no_op(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")

        with redirect_stdout(io.StringIO()):
            result = engine.set_satellite_enabled("Fake", True)

        self.assertIsNone(result["error"])
        self.assertEqual(_events(fixture["marker"]), [])  # start() was never actually run
        _stop(engine)

    def test_a_failing_stop_hook_leaves_the_satellite_enabled(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native)
        _fail(fixture["fail"], "stop")
        engine.loader._discover_directory(native, "native")

        with redirect_stdout(io.StringIO()):
            result = engine.set_satellite_enabled("Fake", False)

        self.assertIsNotNone(result["error"])
        self.assertIn("stop failed on purpose", result["error"])
        # the actual state - not the requested one - is what's reported: the
        # config was never flipped, so a fresh read still says enabled
        self.assertTrue(engine.registry.get("Fake").enabled)
        self.assertTrue(tomllib.loads((fixture["dir"] / "config.toml").read_text())["enabled"])
        _stop(engine)

    def test_a_failing_start_hook_leaves_the_satellite_disabled(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native, enabled=False)
        _fail(fixture["fail"], "start")
        engine.loader._discover_directory(native, "native")

        with redirect_stdout(io.StringIO()):
            result = engine.set_satellite_enabled("Fake", True)

        self.assertIsNotNone(result["error"])
        self.assertIn("start failed on purpose", result["error"])
        self.assertFalse(engine.registry.get("Fake").enabled)
        self.assertFalse(tomllib.loads((fixture["dir"] / "config.toml").read_text())["enabled"])
        _stop(engine)

    def test_when_satellite_services_are_off_only_the_config_flag_changes(self):
        engine, native, _ = _engine(services=False)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")

        with redirect_stdout(io.StringIO()):
            result = engine.set_satellite_enabled("Fake", False)

        self.assertIsNone(result["error"])
        self.assertEqual(_events(fixture["marker"]), [])  # no hook was ever invoked
        self.assertFalse(tomllib.loads((fixture["dir"] / "config.toml").read_text())["enabled"])
        _stop(engine)

    def test_unknown_satellite_raises(self):
        engine, _, _ = _engine(services=False)
        with self.assertRaises(SatelliteError):
            engine.set_satellite_enabled("does-not-exist", True)
        _stop(engine)


class ReloadTest(unittest.TestCase):
    def test_reload_rebuilds_from_disk_and_restarts_a_running_satellite(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        original = engine.registry.get("Fake")
        with redirect_stdout(io.StringIO()):
            original.start(engine)
        self.assertEqual(_events(fixture["marker"]), ["start"])

        # change the manifest and a command's metadata on disk, the same way
        # editing a satellite's own files while StarCore keeps running would
        _build_fake_satellite(native, description="Updated on disk.",
                               command_description="An updated fake command.")

        with redirect_stdout(io.StringIO()):
            result = engine.reload_satellite("Fake")

        self.assertIsNone(result["error"])
        reloaded = engine.registry.get("Fake")
        self.assertIsNot(reloaded, original, "reload must swap in a fresh Satellite, not mutate the old one")
        self.assertEqual(reloaded.manifest.description, "Updated on disk.")
        self.assertEqual(_events(fixture["marker"]), ["start", "stop", "start"])
        self.assertEqual(engine.command_registry.get("fake_command")["metadata"]["description"],
                          "An updated fake command.")
        _stop(engine)

    def test_reload_of_a_disabled_satellite_does_not_start_it(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native, enabled=False)
        engine.loader._discover_directory(native, "native")

        with redirect_stdout(io.StringIO()):
            result = engine.reload_satellite("Fake")

        self.assertIsNone(result["error"])
        self.assertFalse(engine.registry.get("Fake").enabled)
        self.assertEqual(_events(fixture["marker"]), [])
        _stop(engine)

    def test_a_broken_manifest_keeps_the_previous_satellite_registered(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        original = engine.registry.get("Fake")

        (fixture["dir"] / "satellite.toml").write_text("this is not [ valid toml", encoding="utf-8")

        with redirect_stdout(io.StringIO()):
            result = engine.reload_satellite("Fake")

        self.assertIsNotNone(result["error"])
        self.assertIs(engine.registry.get("Fake"), original)
        _stop(engine)

    def test_a_failing_stop_hook_aborts_the_reload(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        original = engine.registry.get("Fake")
        with redirect_stdout(io.StringIO()):
            original.start(engine)
        _fail(fixture["fail"], "stop")

        with redirect_stdout(io.StringIO()):
            result = engine.reload_satellite("Fake")

        self.assertIsNotNone(result["error"])
        self.assertIs(engine.registry.get("Fake"), original, "a satellite that could not be stopped must not be replaced")
        _stop(engine)

    def test_unknown_satellite_raises(self):
        engine, _, _ = _engine(services=False)
        with self.assertRaises(SatelliteError):
            engine.reload_satellite("does-not-exist")
        _stop(engine)

    def test_loader_reload_raises_for_a_satellite_load_error(self):
        engine, native, _ = _engine(services=False)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")

        (fixture["dir"] / "satellite.toml").unlink()

        with self.assertRaises(SatelliteLoadError):
            engine.loader.reload(satellite)
        _stop(engine)


class ApiTest(unittest.TestCase):
    """The generic enable/disable/reload endpoints, exercised over real HTTP."""

    @classmethod
    def setUpClass(cls):
        cls.engine, cls.native, _ = _engine(services=True, mission_control=True)
        cls.fixture = _build_fake_satellite(cls.native)
        with redirect_stdout(io.StringIO()):
            cls.engine.loader._discover_directory(cls.native, "native")
        if not cls.engine.api.running:
            _stop(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")

    @classmethod
    def tearDownClass(cls):
        _stop(cls.engine)

    def json_request(self, path, method="GET", payload=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def test_disable_then_enable_over_http(self):
        status, payload = self.json_request("/api/satellites/Fake/disable", method="POST")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["error"])
        self.assertFalse(payload["satellite"]["enabled"])

        status, payload = self.json_request("/api/satellites/Fake/enable", method="POST")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["error"])
        self.assertTrue(payload["satellite"]["enabled"])

    def test_reload_over_http(self):
        status, payload = self.json_request("/api/satellites/Fake/reload", method="POST")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["error"])
        self.assertEqual(payload["satellite"]["name"], "Fake")

    def test_a_failing_hook_is_reported_as_a_500_with_a_message(self):
        # independent of whatever order the other tests in this class ran in:
        # disabling has to actually invoke the (about to fail) stop hook
        if not self.engine.registry.get("Fake").enabled:
            self.json_request("/api/satellites/Fake/enable", method="POST")

        _fail(self.fixture["fail"], "stop")
        try:
            status, payload = self.json_request("/api/satellites/Fake/disable", method="POST")
            self.assertEqual(status, 500)
            self.assertIsNotNone(payload["error"])
            self.assertTrue(payload["satellite"]["enabled"])
        finally:
            (self.fixture["fail"] / "stop").unlink(missing_ok=True)
            # make sure a later test doesn't inherit a disabled satellite from a
            # run that failed partway
            if not self.engine.registry.get("Fake").enabled:
                self.json_request("/api/satellites/Fake/enable", method="POST")

    def test_unknown_satellite_is_404(self):
        for action in ("enable", "disable", "reload"):
            status, payload = self.json_request(f"/api/satellites/does-not-exist/{action}", method="POST")
            self.assertEqual(status, 404)
            self.assertIn("error", payload)

    def test_get_is_rejected(self):
        for action in ("enable", "disable", "reload"):
            status, payload = self.json_request(f"/api/satellites/Fake/{action}", method="GET")
            self.assertEqual(status, 405)
            self.assertIn("read-only", payload["error"])

    def test_a_satellite_cannot_shadow_a_reserved_action_name(self):
        # the reserved segments are handled before a satellite's own routes are
        # even consulted, so even a route named "reload" would never be reached -
        # this just documents that this satellite doesn't declare one
        satellite = self.engine.registry.get("Fake")
        self.assertNotIn("reload", satellite.routes)
        self.assertNotIn("enable", satellite.routes)
        self.assertNotIn("disable", satellite.routes)


class StatusAndIconTest(unittest.TestCase):
    """Satellite.status() / describe_satellite()'s "status" and "icon" keys -
    entirely generic, no branching on any particular satellite's name."""

    def test_a_satellite_with_no_service_is_running_whenever_it_is_enabled(self):
        engine, native, _ = _engine(services=True)
        _build_fake_satellite(native, with_lifecycle=False)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")

        self.assertFalse(satellite.has_service)
        self.assertEqual(describe_satellite(engine, satellite)["status"], "running")
        _stop(engine)

    def test_a_disabled_satellite_is_disabled_even_with_a_service(self):
        engine, native, _ = _engine(services=True)
        _build_fake_satellite(native, enabled=False)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")

        self.assertEqual(describe_satellite(engine, satellite)["status"], "disabled")
        _stop(engine)

    def test_an_enabled_satellite_with_a_service_is_running_once_started(self):
        engine, native, _ = _engine(services=True)
        _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")
        with redirect_stdout(io.StringIO()):
            satellite.start(engine)

        self.assertEqual(describe_satellite(engine, satellite)["status"], "running")
        _stop(engine)

    def test_an_enabled_satellite_with_a_service_that_has_not_started_is_stopped(self):
        engine, native, _ = _engine(services=True)
        _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")

        self.assertEqual(describe_satellite(engine, satellite)["status"], "stopped")
        _stop(engine)

    def test_a_satellite_with_services_globally_disabled_is_stopped_not_running(self):
        engine, native, _ = _engine(services=False)
        _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")

        self.assertEqual(describe_satellite(engine, satellite)["status"], "stopped")
        _stop(engine)

    def test_a_failed_stop_hook_reports_error_and_takes_priority(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")
        with redirect_stdout(io.StringIO()):
            satellite.start(engine)
        _fail(fixture["fail"], "stop")

        with redirect_stdout(io.StringIO()):
            ok, message = satellite.stop(engine)

        self.assertFalse(ok)
        self.assertEqual(satellite.last_error, message)
        self.assertEqual(describe_satellite(engine, satellite)["status"], "error")
        # a satellite reporting "error" is still enabled - it just failed to
        # actually stop, it wasn't marked disabled while possibly still running
        self.assertTrue(satellite.enabled)
        _stop(engine)

    def test_a_successful_hook_clears_a_previous_error(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")
        _fail(fixture["fail"], "start")
        with redirect_stdout(io.StringIO()):
            satellite.start(engine)
        self.assertEqual(describe_satellite(engine, satellite)["status"], "error")

        (fixture["fail"] / "start").unlink()
        with redirect_stdout(io.StringIO()):
            ok, message = satellite.start(engine)

        self.assertTrue(ok)
        self.assertIsNone(satellite.last_error)
        self.assertEqual(describe_satellite(engine, satellite)["status"], "running")
        _stop(engine)

    def test_a_satellite_with_no_declared_icon_reports_none(self):
        engine, native, _ = _engine(services=True)
        _build_fake_satellite(native, with_lifecycle=False)
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")

        self.assertIsNone(satellite.manifest.icon)
        self.assertIsNone(describe_satellite(engine, satellite)["icon"])
        _stop(engine)

    def test_a_declared_icon_that_exists_is_reported(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native, with_lifecycle=False)
        with open(fixture["dir"] / "satellite.toml", "a", encoding="utf-8") as file:
            file.write('icon = "icon.svg"\n')
        assets = fixture["dir"] / "mission_control"
        assets.mkdir()
        (assets / "icon.svg").write_text("<svg></svg>", encoding="utf-8")
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")

        self.assertEqual(satellite.manifest.icon, "icon.svg")
        self.assertEqual(describe_satellite(engine, satellite)["icon"], "icon.svg")
        _stop(engine)

    def test_a_declared_icon_that_is_missing_falls_back_to_none(self):
        engine, native, _ = _engine(services=True)
        fixture = _build_fake_satellite(native, with_lifecycle=False)
        with open(fixture["dir"] / "satellite.toml", "a", encoding="utf-8") as file:
            file.write('icon = "missing.svg"\n')
        engine.loader._discover_directory(native, "native")
        satellite = engine.registry.get("Fake")

        self.assertIsNone(satellite.manifest.icon)
        _stop(engine)


if __name__ == "__main__":
    unittest.main()
