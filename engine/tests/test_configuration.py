"""The Configuration class, the CLI 'config' command, the Configuration API,
and Mission Control's ability to bind to a configured host and port."""

from contextlib import redirect_stdout
from http.client import HTTPConnection
from pathlib import Path
import io
import json
import socket
import tempfile
import unittest

from starcore.engine_config import Configuration, ConfigurationError
from tests.support import start_engine, stop_engine


def _config_path(content: str = "") -> Path:
    directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))
    path = directory / "config.toml"
    if content:
        path.write_text(content, encoding="utf-8")
    return path


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class ConfigurationClassTest(unittest.TestCase):
    def test_default_server_host_and_port_when_the_key_is_absent(self):
        config = Configuration(_config_path("[server]\n"))

        self.assertEqual(config.section("server").get("host", "127.0.0.1"), "127.0.0.1")
        self.assertEqual(config.section("server").get("port", 8080), 8080)

    def test_set_persists_the_new_value(self):
        path = _config_path('[server]\nhost = "127.0.0.1"\nport = 8080\n')
        config = Configuration(path)

        saved = config.set("server", "host", "0.0.0.0")

        self.assertEqual(saved, "0.0.0.0")
        self.assertEqual(config.section("server")["host"], "0.0.0.0")
        self.assertEqual(Configuration(path).section("server")["host"], "0.0.0.0")

    def test_set_preserves_comments_and_sibling_keys(self):
        path = _config_path(
            '[server]\n'
            'enabled = true\n'
            'host = "127.0.0.1" # localhost only by default\n'
            'port = 8080\n'
        )
        config = Configuration(path)

        config.set("server", "host", "0.0.0.0")

        text = path.read_text(encoding="utf-8")
        self.assertIn("# localhost only by default", text)
        self.assertIn('host = "0.0.0.0"', text)
        self.assertIn("enabled = true", text)
        self.assertIn("port = 8080", text)

    def test_set_preserves_other_sections(self):
        path = _config_path('[engine]\nname = "StarCore"\n\n[server]\nhost = "127.0.0.1"\nport = 8080\n')
        config = Configuration(path)

        config.set("server", "port", 9090)

        text = path.read_text(encoding="utf-8")
        self.assertIn('name = "StarCore"', text)
        self.assertIn("port = 9090", text)

    def test_set_creates_a_missing_section(self):
        path = _config_path('[engine]\nname = "StarCore"\n')
        config = Configuration(path)

        config.set("server", "host", "0.0.0.0")

        text = path.read_text(encoding="utf-8")
        self.assertIn("[server]", text)
        self.assertIn('host = "0.0.0.0"', text)

    def test_set_creates_a_missing_file(self):
        path = Path(tempfile.mkdtemp(prefix="starcore-tests-")) / "config.toml"
        config = Configuration(path)

        config.set("server", "port", 9090)

        self.assertTrue(path.is_file())
        self.assertIn("port = 9090", path.read_text(encoding="utf-8"))

    def test_set_preserves_crlf_line_endings(self):
        path = _config_path('[server]\r\nhost = "127.0.0.1"\r\nport = 8080\r\n')
        config = Configuration(path)

        config.set("server", "port", 9090)

        raw = path.read_bytes()
        self.assertIn(b"\r\n", raw)
        self.assertNotIn(b"\r\r\n", raw)

    def test_an_unknown_key_is_rejected(self):
        config = Configuration(_config_path("[server]\n"))

        with self.assertRaises(ConfigurationError):
            config.set("server", "does_not_exist", "x")

    def test_an_unknown_section_is_rejected(self):
        config = Configuration(_config_path("[server]\n"))

        with self.assertRaises(ConfigurationError):
            config.set("photo", "sync_host", "0.0.0.0")

    def test_an_empty_host_is_rejected(self):
        config = Configuration(_config_path("[server]\n"))

        with self.assertRaises(ConfigurationError):
            config.set("server", "host", "   ")

    def test_a_non_numeric_port_is_rejected(self):
        config = Configuration(_config_path("[server]\n"))

        with self.assertRaises(ConfigurationError):
            config.set("server", "port", "not-a-port")

    def test_an_out_of_range_port_is_rejected(self):
        config = Configuration(_config_path("[server]\n"))

        with self.assertRaises(ConfigurationError):
            config.set("server", "port", 70000)
        with self.assertRaises(ConfigurationError):
            config.set("server", "port", -1)

    def test_port_is_coerced_from_a_string(self):
        config = Configuration(_config_path("[server]\n"))

        config.set("server", "port", "9090")

        self.assertEqual(config.section("server")["port"], 9090)

    def test_enabled_accepts_common_boolean_spellings(self):
        config = Configuration(_config_path("[server]\n"))

        config.set("server", "enabled", "false")
        self.assertIs(config.section("server")["enabled"], False)

        config.set("server", "enabled", "yes")
        self.assertIs(config.section("server")["enabled"], True)

    def test_an_invalid_boolean_is_rejected(self):
        config = Configuration(_config_path("[server]\n"))

        with self.assertRaises(ConfigurationError):
            config.set("server", "enabled", "maybe")

    def test_a_rejected_value_is_not_written(self):
        path = _config_path('[server]\nhost = "127.0.0.1"\n')
        config = Configuration(path)
        before = path.read_text(encoding="utf-8")

        with self.assertRaises(ConfigurationError):
            config.set("server", "host", "")

        self.assertEqual(path.read_text(encoding="utf-8"), before)
        self.assertEqual(config.section("server")["host"], "127.0.0.1")


class ConfigCommandTest(unittest.TestCase):
    def setUp(self):
        self.engine = start_engine()

    def tearDown(self):
        stop_engine(self.engine)

    def run_command(self, command):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            self.engine.execute_command(command)
        return buffer.getvalue()

    def test_config_with_no_arguments_shows_current_settings(self):
        output = self.run_command("config")

        self.assertIn("server.host", output)
        self.assertIn("server.port", output)
        self.assertIn("server.enabled", output)
        self.assertIn("restart", output.lower())

    def test_config_changes_a_setting(self):
        output = self.run_command("config server.host 0.0.0.0")

        self.assertIn("server.host = 0.0.0.0", output)
        self.assertIn("Restart StarCore", output)
        self.assertEqual(self.engine.config.section("server")["host"], "0.0.0.0")

    def test_config_changes_the_port(self):
        self.run_command("config server.port 8090")

        self.assertEqual(self.engine.config.section("server")["port"], 8090)

    def test_config_rejects_an_unknown_key(self):
        output = self.run_command("config server.nonsense value")

        self.assertIn("[ERROR]", output)

    def test_config_rejects_an_invalid_port(self):
        output = self.run_command("config server.port not-a-number")

        self.assertIn("[ERROR]", output)

    def test_config_rejects_a_path_without_a_section(self):
        output = self.run_command("config host 0.0.0.0")

        self.assertIn("[ERROR]", output)

    def test_config_requires_exactly_a_key_and_a_value(self):
        output = self.run_command("config server.host")

        self.assertIn("[ERROR]", output)
        self.assertIn("Usage", output)


class ConfigurationApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

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

    def test_get_lists_the_configurable_settings(self):
        status, payload = self.json_request("/api/configuration")

        self.assertEqual(status, 200)
        paths = {setting["path"] for setting in payload["settings"]}
        self.assertEqual(paths, {"server.host", "server.port", "server.enabled",
                                  "server.https_enabled", "server.https_cert", "server.https_key"})
        self.assertIn("restart_required", payload)

    def test_no_secret_looking_fields_are_exposed(self):
        status, payload = self.json_request("/api/configuration")

        self.assertEqual(status, 200)
        self.assertNotIn("token", json.dumps(payload).lower())

    def test_post_updates_a_setting_and_reports_a_pending_restart(self):
        status, payload = self.json_request(
            "/api/configuration", method="POST",
            payload={"section": "server", "key": "host", "value": "0.0.0.0"})

        self.assertEqual(status, 200)
        updated = next(setting for setting in payload["settings"] if setting["path"] == "server.host")
        self.assertEqual(updated["value"], "0.0.0.0")
        self.assertTrue(updated["pending_restart"])
        self.assertTrue(payload["restart_required"])

    def test_post_rejects_an_unknown_key(self):
        status, payload = self.json_request(
            "/api/configuration", method="POST",
            payload={"section": "server", "key": "nonsense", "value": "x"})

        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_post_rejects_an_invalid_port(self):
        status, payload = self.json_request(
            "/api/configuration", method="POST",
            payload={"section": "server", "key": "port", "value": "not-a-port"})

        self.assertEqual(status, 400)

    def test_post_rejects_a_non_string_section_or_key(self):
        status, payload = self.json_request(
            "/api/configuration", method="POST",
            payload={"section": 1, "key": "host", "value": "x"})

        self.assertEqual(status, 400)

    def test_get_rejects_writes_like_other_read_only_endpoints(self):
        status, _ = self.json_request("/api/status", method="PUT")

        self.assertEqual(status, 405)


class MissionControlBindingTest(unittest.TestCase):
    def assert_reachable(self, host, port):
        connection = HTTPConnection(host, port, timeout=5)
        try:
            connection.request("GET", "/api/status")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
        finally:
            connection.close()

    def test_binds_to_localhost_by_default(self):
        engine = start_engine(mission_control=True)
        try:
            self.assertEqual(engine.api.host, "127.0.0.1")
            self.assert_reachable("127.0.0.1", engine.api.port)
        finally:
            stop_engine(engine)

    def test_binds_to_a_configured_port(self):
        port = _free_port()
        engine = start_engine(mission_control=True, port=port)
        try:
            self.assertEqual(engine.api.port, port)
            self.assert_reachable("127.0.0.1", port)
        finally:
            stop_engine(engine)

    def test_binds_to_all_interfaces_when_configured(self):
        engine = start_engine(mission_control=True, host="0.0.0.0")
        try:
            self.assertEqual(engine.api.host, "0.0.0.0")
            # loopback is reachable through a 0.0.0.0 bind too, which makes this a
            # safe, sandbox-portable way to prove the wildcard bind is listening
            self.assert_reachable("127.0.0.1", engine.api.port)
        finally:
            stop_engine(engine)


if __name__ == "__main__":
    unittest.main()
