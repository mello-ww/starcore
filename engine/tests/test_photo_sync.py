from http.client import HTTPConnection
from pathlib import Path
import contextlib
import io
import json
import shutil
import socket
import tempfile
import unittest

from tests.support import start_engine, stop_engine
from tests.test_photo import png, photo_library

TOKEN = "test-token"


def sync_module():
    from importlib import import_module
    return import_module("satellites.native.photo.sync")


def configuration_module():
    from importlib import import_module
    return import_module("satellites.native.photo.configuration")


class SyncServiceTest(unittest.TestCase):
    """Every test drives the real listener over HTTP on a temporary library."""

    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()  # loads the satellite package so it can be imported

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-sync-"))
        self.library = photo_library(self.directory / "library")
        self.service = sync_module().SyncService(self.library, "127.0.0.1", 0, TOKEN, 1024 * 1024)

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(self.service.start())

    def tearDown(self):
        self.service.stop()
        shutil.rmtree(self.directory, ignore_errors=True)

    def upload(self, data: bytes, filename="photo.png", token=TOKEN, headers=None, length=None):
        connection = HTTPConnection("127.0.0.1", self.service.port, timeout=5)
        request = {"X-Photo-Filename": filename, "Content-Length": str(length if length is not None else len(data))}
        request.update(headers or {})

        try:
            connection.request("POST", f"/upload?token={token}", body=data, headers=request)
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def test_a_valid_photo_is_imported(self):
        status, payload = self.upload(png(8, 6), filename="beach.png")

        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "imported")
        self.assertEqual(payload["photo"]["filename"], "beach.png")
        self.assertEqual(self.library.count, 1)

    def test_the_same_photo_twice_is_a_duplicate(self):
        self.upload(png(8, 6))
        status, payload = self.upload(png(8, 6))

        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "duplicate")
        self.assertIsNone(payload["photo"])
        self.assertEqual(self.library.count, 1)

    def test_several_photos_can_be_uploaded(self):
        for index in range(4):
            status, payload = self.upload(png(8 + index, 6), filename=f"photo-{index}.png")
            self.assertEqual((status, payload["status"]), (200, "imported"))

        self.assertEqual(self.library.count, 4)
        self.assertEqual(self.service.activity.counts()["imported"], 4)

    def test_a_file_that_is_not_an_image_is_refused(self):
        status, payload = self.upload(b"just some text", filename="notes.txt")

        self.assertEqual(status, 415)
        self.assertEqual(payload["status"], "error")
        self.assertEqual(self.library.count, 0)

    def test_a_malformed_image_is_refused(self):
        status, _ = self.upload(b"\x89PNG\r\n\x1a\n truncated", filename="broken.png")

        self.assertEqual(status, 415)
        self.assertEqual(self.library.count, 0)

    def test_an_empty_upload_is_refused(self):
        status, payload = self.upload(b"", filename="empty.png")

        self.assertEqual(status, 400)
        self.assertIn("empty", payload["error"])

    def test_an_upload_larger_than_the_limit_is_refused(self):
        self.service.max_bytes = 16
        status, payload = self.upload(png(8, 6))

        self.assertEqual(status, 413)
        self.assertEqual(self.library.count, 0)

    def test_an_upload_that_ends_early_is_refused(self):
        # the request promises more than it sends, then closes: the library must not
        # be left with a partial file
        client = socket.create_connection(("127.0.0.1", self.service.port), timeout=5)
        try:
            client.sendall(
                f"POST /upload?token={TOKEN} HTTP/1.1\r\nHost: localhost\r\n"
                f"Content-Length: 4096\r\nConnection: close\r\n\r\n".encode("ascii") + png(8, 6)[:20])
            client.shutdown(socket.SHUT_WR)
            response = b""
            while chunk := client.recv(4096):
                response += chunk
        finally:
            client.close()

        self.assertIn(b"400", response.split(b"\r\n")[0])
        self.assertEqual(self.library.count, 0)

    def test_a_missing_content_length_is_refused(self):
        client = socket.create_connection(("127.0.0.1", self.service.port), timeout=5)
        try:
            client.sendall(
                f"POST /upload?token={TOKEN} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode("ascii"))
            response = client.recv(4096)
        finally:
            client.close()

        self.assertIn(b"411", response.split(b"\r\n")[0])

    def test_failed_uploads_leave_the_library_intact(self):
        self.upload(png(8, 6), filename="good.png")
        self.upload(b"nonsense", filename="bad.png")
        self.upload(b"", filename="empty.png")

        self.assertEqual(self.library.count, 1)
        self.assertEqual(photo_library(self.library.root).count, 1)
        self.assertEqual(list((self.library.root / "incoming").glob("*")), [])

    def test_a_wrong_token_is_rejected(self):
        status, payload = self.upload(png(8, 6), token="not-the-token")

        self.assertEqual(status, 401)
        self.assertEqual(self.library.count, 0)

    def test_a_missing_token_is_rejected(self):
        connection = HTTPConnection("127.0.0.1", self.service.port, timeout=5)
        try:
            connection.request("GET", "/")
            self.assertEqual(connection.getresponse().status, 401)
        finally:
            connection.close()

    def test_the_token_may_be_sent_as_a_header(self):
        connection = HTTPConnection("127.0.0.1", self.service.port, timeout=5)
        data = png(8, 6)
        try:
            connection.request("POST", "/upload", body=data, headers={
                "X-StarCore-Token": TOKEN,
                "X-Photo-Filename": "header.png",
                "Content-Length": str(len(data)),
            })
            self.assertEqual(connection.getresponse().status, 200)
        finally:
            connection.close()

        self.assertEqual(self.library.count, 1)

    def test_a_filename_cannot_escape_the_library(self):
        status, payload = self.upload(png(8, 6), filename="../../../etc/passwd.png")

        self.assertEqual(status, 200)
        self.assertEqual(payload["photo"]["filename"], "passwd.png")
        self.assertNotIn("..", payload["photo"]["path"])
        self.assertTrue(self.library.original_path(payload["photo"]).is_relative_to(self.library.root))

    def test_an_encoded_filename_is_decoded(self):
        status, payload = self.upload(png(9, 6), filename="holiday%20%E2%98%85.png")

        self.assertEqual(status, 200)
        self.assertEqual(payload["photo"]["filename"], "holiday ★.png")

    def test_an_unnamed_upload_still_works(self):
        status, payload = self.upload(png(8, 6), headers={"X-Photo-Filename": ""})

        self.assertEqual(status, 200)
        self.assertEqual(payload["photo"]["filename"], "upload")

    def test_unknown_paths_are_not_served(self):
        connection = HTTPConnection("127.0.0.1", self.service.port, timeout=5)
        try:
            connection.request("GET", f"/../library.json?token={TOKEN}")
            self.assertEqual(connection.getresponse().status, 404)
        finally:
            connection.close()

    def test_the_upload_page_is_served_to_a_phone(self):
        connection = HTTPConnection("127.0.0.1", self.service.port, timeout=5)
        try:
            connection.request("GET", f"/?token={TOKEN}")
            response = connection.getresponse()
            body = response.read().decode("utf-8")
        finally:
            connection.close()

        self.assertEqual(response.status, 200)
        self.assertIn("StarCore", body)
        self.assertIn("/upload", body)

    def test_activity_is_recorded(self):
        self.upload(png(8, 6), filename="one.png")
        self.upload(png(8, 6), filename="one-again.png")
        self.upload(b"nonsense", filename="bad.png")

        described = self.service.describe()

        self.assertEqual(described["counts"], {"received": 3, "imported": 1, "duplicates": 1, "failed": 1})
        self.assertEqual([event["filename"] for event in described["events"]],
                         ["bad.png", "one-again.png", "one.png"])
        self.assertTrue(described["running"])
        self.assertEqual(described["token"], TOKEN)


class SyncIntegrationTest(unittest.TestCase):
    """The satellite's own wiring: configuration, lifecycle and the status route."""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-sync-wiring-"))
        self.engine = start_engine()
        self.satellite = self.engine.registry.get("Photo")
        self.satellite.config.data["storage"] = str(self.directory / "library")

    def tearDown(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.satellite.stop(self.engine)
        stop_engine(self.engine)
        shutil.rmtree(self.directory, ignore_errors=True)

    def start_sync(self, **overrides):
        self.satellite.config.data.update({"sync_port": 0, "sync_token": TOKEN, **overrides})
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.satellite.start(self.engine)
        return output.getvalue()

    def test_the_satellite_declares_lifecycle_hooks(self):
        self.assertEqual(sorted(self.satellite.lifecycle), ["start", "stop"])

    def test_starting_the_satellite_starts_the_listener(self):
        self.start_sync()
        service = sync_module().service(self.satellite)

        self.assertIsNotNone(service)
        self.assertTrue(service.running)

    def test_stopping_the_satellite_stops_the_listener(self):
        self.start_sync()
        service = sync_module().service(self.satellite)

        with contextlib.redirect_stdout(io.StringIO()):
            self.satellite.stop(self.engine)

        self.assertFalse(service.running)
        self.assertIsNone(sync_module().service(self.satellite))

    def test_sync_can_be_turned_off(self):
        output = self.start_sync(sync_enabled=False)

        self.assertIn("disabled", output)
        self.assertIsNone(sync_module().service(self.satellite))

    def test_a_token_is_generated_and_reused(self):
        self.satellite.config.data["sync_token"] = ""
        first = sync_module()._token(self.satellite)
        second = sync_module()._token(self.satellite)

        self.assertTrue(first)
        self.assertEqual(first, second)

    def test_the_state_reports_where_sync_is_listening(self):
        self.start_sync()

        self.assertTrue(self.satellite.state(self.engine)["sync"].startswith("http://"))

    def test_the_state_reports_sync_off_when_it_is_not_running(self):
        self.assertEqual(self.satellite.state(self.engine)["sync"], "off")

    def test_the_status_route_describes_sync(self):
        self.start_sync()
        handler = self.satellite.routes["sync"]
        request = type("Request", (), {"method": "GET", "satellite": self.satellite, "path": ()})()

        described = handler(request).payload

        self.assertTrue(described["running"])
        self.assertEqual(described["token"], TOKEN)
        self.assertEqual(described["counts"]["received"], 0)

    def test_a_satellite_failure_does_not_stop_the_core(self):
        self.satellite.lifecycle["start"] = lambda engine, satellite: 1 / 0

        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.satellite.start(self.engine)

        self.assertIn("[WARNING]", output.getvalue())
        self.assertTrue(self.engine.status()["running"])


class PhotoConfigurationTest(unittest.TestCase):
    """Photo Sync's own sync_host/sync_port, through the generic satellite
    configuration mechanism - never through any Photo-specific Core code."""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-config-"))
        self.engine = start_engine()
        self.satellite = self.engine.registry.get("Photo")
        self.satellite.config.data["storage"] = str(self.directory / "library")
        self.satellite.config.data["sync_port"] = 0

        # configuration.update() persists through satellite.config.set(), which
        # would otherwise write into the real satellites/native/photo/config.toml
        # on disk - every test here redirects that to a throwaway file first
        self.config_path = self.directory / "config.toml"
        self.config_path.write_text(
            'enabled = true\nsync_enabled = true\nsync_host = "127.0.0.1"\nsync_port = 0\n',
            encoding="utf-8")
        self.satellite.config.path = self.config_path

    def tearDown(self):
        with contextlib.redirect_stdout(io.StringIO()):
            sync_module().stop(self.engine, self.satellite)
        stop_engine(self.engine)
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_reading_the_configuration_reports_the_current_values(self):
        payload = configuration_module().describe(self.satellite)
        by_key = {setting["key"]: setting for setting in payload["settings"]}

        self.assertEqual(by_key["sync_host"]["value"], "127.0.0.1")
        self.assertEqual(by_key["sync_port"]["value"], 0)
        self.assertIn("sync_host", by_key["sync_host"]["description"] + " " + by_key["sync_host"]["key"])

    def test_changing_the_host_persists_and_restarts_the_listener(self):
        with contextlib.redirect_stdout(io.StringIO()):
            result = configuration_module().update(self.engine, self.satellite, "sync_host", "127.0.0.2")

        self.assertEqual(self.satellite.config.get("sync_host"), "127.0.0.2")
        self.assertIn('sync_host = "127.0.0.2"', self.config_path.read_text(encoding="utf-8"))

        running = sync_module().service(self.satellite)
        self.assertIsNotNone(running)
        self.assertEqual(running.host, "127.0.0.2")
        self.assertIn("applied", result["note"].lower())
        self.assertFalse(result["restart_required"])

    def test_changing_the_port_persists_and_restarts_the_listener(self):
        with contextlib.redirect_stdout(io.StringIO()):
            configuration_module().update(self.engine, self.satellite, "sync_host", "127.0.0.1")
            result = configuration_module().update(self.engine, self.satellite, "sync_port", "0")

        running = sync_module().service(self.satellite)
        self.assertIsNotNone(running)
        self.assertTrue(running.running)
        self.assertEqual(result["settings"][1]["live_value"], running.port)

    def test_an_invalid_host_is_rejected_and_nothing_is_written(self):
        before = self.config_path.read_text(encoding="utf-8")

        with self.assertRaises(configuration_module().ConfigurationError):
            configuration_module().update(self.engine, self.satellite, "sync_host", "   ")

        self.assertEqual(self.config_path.read_text(encoding="utf-8"), before)
        self.assertIsNone(sync_module().service(self.satellite))

    def test_an_invalid_port_is_rejected(self):
        for bad in ("not-a-port", "70000", "-1"):
            with self.assertRaises(configuration_module().ConfigurationError):
                configuration_module().update(self.engine, self.satellite, "sync_port", bad)

    def test_an_unknown_setting_is_rejected(self):
        with self.assertRaises(configuration_module().ConfigurationError):
            configuration_module().update(self.engine, self.satellite, "sync_token", "anything")

    def test_the_saved_value_survives_a_fresh_read_of_the_satellite_config(self):
        with contextlib.redirect_stdout(io.StringIO()):
            configuration_module().update(self.engine, self.satellite, "sync_port", "0")

        from starcore.satellite_config import SatelliteConfig
        import tomllib
        with open(self.config_path, "rb") as file:
            reloaded = SatelliteConfig(tomllib.load(file), path=self.config_path)

        self.assertEqual(reloaded.get("sync_port"), 0)

    def test_startup_uses_the_configured_host_and_port(self):
        self.satellite.config.data["sync_host"] = "127.0.0.1"

        with contextlib.redirect_stdout(io.StringIO()):
            self.satellite.start(self.engine)

        running = sync_module().service(self.satellite)
        self.assertEqual(running.host, "127.0.0.1")

    def test_the_generic_mechanism_marks_photo_as_configurable(self):
        from starcore.api import payloads

        described = payloads.describe_satellite(self.engine, self.satellite)

        self.assertTrue(described["configurable"])
        self.assertIn("configuration", self.satellite.routes)

    def test_a_satellite_without_a_configuration_route_is_not_configurable(self):
        from starcore.api import payloads

        status = self.engine.registry.get("Status")
        described = payloads.describe_satellite(self.engine, status)

        self.assertFalse(described["configurable"])

    def test_the_configuration_route_handles_get_and_post_generically(self):
        handler = self.satellite.routes["configuration"]

        get_request = type("Request", (), {
            "method": "GET", "satellite": self.satellite, "engine": self.engine, "path": (), "body": None,
        })()
        response = handler(get_request)
        self.assertIn("settings", response.payload)

        with contextlib.redirect_stdout(io.StringIO()):
            post_request = type("Request", (), {
                "method": "POST", "satellite": self.satellite, "engine": self.engine, "path": (),
                "body": {"key": "sync_port", "value": 0},
            })()
            response = handler(post_request)
        self.assertIn("note", response.payload)

    def test_core_source_has_no_photo_specific_configuration_logic(self):
        """A regression guard, not just a design intention: the Core's own
        engine_config.py, satellite_config.py, toml_edit.py and api/*.py must
        never come to know about sync_host, sync_port, or "photo" by name -
        the generic mechanism (docs/satellites.md) is what has to keep working
        for any future satellite, not a special case for this one."""
        core_path = Path(sync_module().__file__).resolve().parents[2].parent / "engine" / "starcore"
        offenders = []

        for path in core_path.rglob("*.py"):
            text = path.read_text(encoding="utf-8").lower()
            if "sync_host" in text or "sync_port" in text or "photo" in text:
                offenders.append(str(path))

        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
