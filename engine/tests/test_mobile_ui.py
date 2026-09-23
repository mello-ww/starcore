"""The "mobile" Satellite route convention - see "Exposing a mobile
interface" in docs/satellites.md. Mirrors how test_core.py's
SatelliteStateTest exercises state() in isolation (no HTTP, no real
satellite discovery) and test_file_explorer.py exercises a real Satellite's
routes end-to-end through a started engine.
"""

from pathlib import Path
import unittest

from starcore.api.payloads import describe_satellite
from starcore.api.response import Request
from starcore.manifest import SatelliteManifest
from starcore.satellite import Satellite
from starcore.satellite_config import SatelliteConfig

from tests.support import start_engine, stop_engine


class MobileUiFlagTest(unittest.TestCase):
    """describe_satellite()'s "mobile_ui" flag, purely generic - built from
    a synthetic Satellite the same way SatelliteStateTest does, so this
    never depends on any real satellite under satellites/.

    describe_satellite() also reports each satellite's commands
    (describe_commands(), see payloads.py), which needs a real engine with
    a command_registry - so, like StatusMobileRouteTest below, this uses a
    real started engine rather than None, the same way every other
    describe_satellite() caller does.
    """

    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def satellite(self, routes: dict = None):
        manifest = SatelliteManifest("Test", "1.0.0", "tests", "Test satellite.")
        return Satellite(manifest, SatelliteConfig({}), "native", Path("."), routes=routes)

    def test_false_with_no_mobile_route(self):
        described = describe_satellite(self.engine, self.satellite())
        self.assertFalse(described["mobile_ui"])

    def test_false_with_unrelated_routes(self):
        described = describe_satellite(self.engine, self.satellite({"library": lambda request: None}))
        self.assertFalse(described["mobile_ui"])

    def test_true_once_a_mobile_route_is_named(self):
        described = describe_satellite(self.engine, self.satellite({"mobile": lambda request: None}))
        self.assertTrue(described["mobile_ui"])

    def test_independent_of_configurable(self):
        """The two flags are each purely a "is this route name present"
        check - one route being named doesn't imply anything about the
        other, and both can be true or false in any combination."""
        described = describe_satellite(self.engine, self.satellite({
            "configuration": lambda request: None,
            "mobile": lambda request: None,
        }))
        self.assertTrue(described["configurable"])
        self.assertTrue(described["mobile_ui"])


class StatusMobileRouteTest(unittest.TestCase):
    """The worked example (satellites/native/status/api.py), exercised
    through a real, started engine - the same pattern
    FileExplorerApiTest uses - so this also proves the "mobile" route name
    isn't reserved or otherwise special-cased by the dispatcher itself."""

    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")

        cls.satellite = cls.engine.registry.get("Status")
        if cls.satellite is None:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Status satellite did not load")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def test_status_is_reported_as_mobile_capable(self):
        described = describe_satellite(self.engine, self.satellite)
        self.assertTrue(described["mobile_ui"])

    def test_mobile_route_returns_a_declarative_screen(self):
        handler = self.satellite.routes["mobile"]
        request = Request(self.engine, self.satellite, "GET", (), {})

        response = handler(request)

        self.assertEqual(response.status, 200)
        screen = response.payload["screen"]
        self.assertEqual(screen["title"], "Status")
        items = screen["sections"][0]["items"]
        labels = [item["label"] for item in items]
        self.assertIn("Platform", labels)
        self.assertIn("Python", labels)

    def test_mobile_route_only_supports_get(self):
        handler = self.satellite.routes["mobile"]
        request = Request(self.engine, self.satellite, "POST", (), {})

        response = handler(request)

        self.assertEqual(response.status, 405)


if __name__ == "__main__":
    unittest.main()
