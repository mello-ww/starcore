from http.client import HTTPConnection
import json
import time
import unittest

from tests.support import start_engine, stop_engine


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def request(self, path, method="GET"):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, response.headers.get("Content-Type", ""), response.read().decode("utf-8")
        finally:
            connection.close()

    def json_request(self, path, method="GET", payload=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}

        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            content_type = response.headers.get("Content-Type", "")
            self.assertIn("application/json", content_type)
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def test_status_endpoint_returns_core_state(self):
        status, payload = self.json_request("/api/status")

        self.assertEqual(status, 200)
        self.assertEqual(payload["engine"], "StarCore")
        self.assertTrue(payload["running"])
        self.assertTrue(payload["mission_control"]["running"])
        self.assertTrue(payload["mission_control"]["url"].startswith("http://127.0.0.1:"))

    def test_satellites_endpoint_lists_loaded_satellites(self):
        status, payload = self.json_request("/api/satellites")
        names = [satellite["name"] for satellite in payload["satellites"]]

        self.assertEqual(status, 200)
        self.assertEqual(names, [satellite.manifest.name for satellite in self.engine.registry.all()])

        for satellite in payload["satellites"]:
            self.assertIn(satellite["type"], ("native", "link"))
            self.assertIsInstance(satellite["enabled"], bool)
            self.assertIsInstance(satellite["commands"], list)
            self.assertIsInstance(satellite["state"], dict)

    def test_single_satellite_endpoint_ignores_case(self):
        expected = self.engine.registry.all()[0].manifest.name
        status, payload = self.json_request(f"/api/satellites/{expected.lower()}")

        self.assertEqual(status, 200)
        self.assertEqual(payload["name"], expected)

    def test_unknown_satellite_returns_404(self):
        status, payload = self.json_request("/api/satellites/does-not-exist")

        self.assertEqual(status, 404)
        self.assertIn("does-not-exist", payload["error"])

    def test_satellite_endpoint_without_a_name_returns_404(self):
        status, payload = self.json_request("/api/satellites/")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_commands_endpoint_exposes_command_metadata(self):
        status, payload = self.json_request("/api/commands")
        commands = {command["name"]: command for command in payload["commands"]}

        self.assertEqual(status, 200)
        self.assertEqual(commands["help"]["source"], "core")
        self.assertNotEqual(commands["status"]["source"], "core")
        self.assertTrue(commands["status"]["description"])

    def test_unknown_endpoint_returns_404(self):
        status, payload = self.json_request("/api/nothing-here")

        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_write_methods_are_rejected_on_read_only_endpoints(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            status, payload = self.json_request("/api/status", method=method)
            self.assertEqual(status, 405)
            self.assertIn("read-only", payload["error"])

    def test_execute_runs_a_registered_command(self):
        status, payload = self.json_request("/api/commands/execute", method="POST", payload={"command": "version"})

        self.assertEqual(status, 200)
        self.assertIsNone(payload["error"])
        self.assertIn("StarCore CLI", payload["output"])

    def test_execute_passes_arguments_through_like_the_cli(self):
        status, payload = self.json_request("/api/commands/execute", method="POST", payload={"command": "help version"})

        self.assertEqual(status, 200)
        self.assertIn("Display the current StarCore version.", payload["output"])

    def test_execute_reports_an_unknown_command_without_failing(self):
        status, payload = self.json_request("/api/commands/execute", method="POST", payload={"command": "not-a-command"})

        self.assertEqual(status, 200)
        self.assertIsNone(payload["error"])
        self.assertIn("not found in registry", payload["output"])

    def test_execute_rejects_a_missing_command_field(self):
        status, payload = self.json_request("/api/commands/execute", method="POST", payload={})

        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_execute_rejects_an_empty_command(self):
        status, payload = self.json_request("/api/commands/execute", method="POST", payload={"command": "   "})

        self.assertEqual(status, 400)

    def test_execute_rejects_malformed_json(self):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        try:
            connection.request("POST", "/api/commands/execute", body=b"{not json",
                                headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

        self.assertEqual(response.status, 400)
        self.assertIn("error", payload)

    def test_execute_via_get_is_rejected(self):
        status, payload = self.json_request("/api/commands/execute", method="GET")

        self.assertEqual(status, 405)
        self.assertIn("error", payload)

    def test_frontend_is_served(self):
        status, content_type, body = self.request("/")

        self.assertEqual(status, 200)
        self.assertIn("text/html", content_type)
        self.assertIn("Mission Control", body)

    def test_frontend_assets_are_served(self):
        for path, expected_type in (("/app.js", "javascript"), ("/style.css", "text/css")):
            status, content_type, _ = self.request(path)
            self.assertEqual(status, 200)
            self.assertIn(expected_type, content_type)

    def test_missing_asset_returns_404(self):
        status, _, _ = self.request("/does-not-exist.js")

        self.assertEqual(status, 404)

    def test_paths_outside_the_frontend_are_refused(self):
        status, _, body = self.request("/../engine/config.toml")

        self.assertIn(status, (403, 404))
        self.assertNotIn("[server]", body)


class ShutdownTest(unittest.TestCase):
    """Each test starts its own engine, since shutdown is destructive."""

    def request(self, engine, path, method="GET"):
        connection = HTTPConnection("127.0.0.1", engine.api.port, timeout=5)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def wait_until(self, predicate, timeout=2.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.05)
        return predicate()

    def test_shutdown_stops_the_core_and_mission_control(self):
        engine = start_engine(mission_control=True)

        status, payload = self.request(engine, "/api/shutdown", method="POST")
        self.assertEqual(status, 200)
        self.assertIn("shutting down", payload["message"])

        self.assertTrue(self.wait_until(lambda: not engine.status()["running"]))
        self.assertTrue(self.wait_until(lambda: not engine.api.running))
        self.assertTrue(engine.stopped.is_set())

    def test_shutdown_via_get_is_rejected(self):
        engine = start_engine(mission_control=True)
        try:
            status, payload = self.request(engine, "/api/shutdown", method="GET")
            self.assertEqual(status, 405)
            self.assertIn("error", payload)
        finally:
            stop_engine(engine)


if __name__ == "__main__":
    unittest.main()
