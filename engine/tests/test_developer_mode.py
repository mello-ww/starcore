"""Developer Mode: a UI visibility preference, never a permission.

Satellites mark advanced settings and declarative mobile items with
"developer": true; Mission Control and the app hide them unless Developer
Mode is on. These tests pin the server side of that contract: the flags are
described, every route stays signed-in only whatever the client shows, a
developer setting can still be changed by a signed-in caller (it was never a
permission), and no secret is added to any payload. Real configs and
libraries are never touched (see isolate()).
"""

from http.client import HTTPConnection
from pathlib import Path
import json
import shutil
import tempfile
import unittest

from starcore.auth import AuthStore
from tests.support import start_engine, stop_engine
from tests.test_cli import isolate

REPOSITORY = Path(__file__).resolve().parents[2]


class DeveloperSettingsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-developer-"))
        isolate(self.engine, self.directory)
        self.engine.auth = AuthStore(self.directory / "auth.json")
        self.token = self.engine.auth.bootstrap("developer", "correct horse battery")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def request(self, path, method="GET", payload=None, token=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
        headers = {"Accept": "application/json"}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
        finally:
            connection.close()

    def settings(self, path):
        status, payload = self.request(path, token=self.token)
        self.assertEqual(status, 200, payload)
        return {setting["key"]: setting for setting in payload["settings"]}

    # ---------- what each Satellite declares ----------

    def test_satellites_mark_their_advanced_settings(self):
        expected = {
            "/api/satellites/Photo/configuration": ({"sync_host", "sync_port", "sync_default_path"},
                                                    {"photo_directory", "trash_retention_days", "source_paths"}),
            "/api/satellites/Music/configuration": ({"exclude", "min_duration", "missing_metadata", "scan_interval",
                                                     "ffmpeg", "transcode_workers", "transcode_cache_mb"},
                                                    {"library", "sources"}),
        }
        for path, (advanced, everyday) in expected.items():
            with self.subTest(path=path):
                settings = self.settings(path)
                self.assertEqual({key for key, setting in settings.items() if setting.get("developer")}, advanced)
                self.assertEqual(everyday & set(settings), everyday)  # everyday settings are still described

    def test_engine_server_settings_are_developer_settings(self):
        settings = self.settings("/api/configuration")
        self.assertTrue(settings)
        self.assertTrue(all(setting["developer"] is True for setting in settings.values()))

    def test_the_status_fallback_screen_marks_technical_items(self):
        status, payload = self.request("/api/satellites/Status/mobile", token=self.token)
        self.assertEqual(status, 200, payload)
        items = [item for section in payload["screen"]["sections"] for item in section["items"]
                 if item["type"] == "status"]
        flagged = {item["label"] for item in items if item.get("developer")}
        self.assertEqual(flagged, {"Platform", "Python"})
        self.assertIn("Health", {item["label"] for item in items if not item.get("developer")})

    # ---------- never a permission ----------

    def test_developer_routes_and_settings_still_require_a_session(self):
        for method, path, payload in (
            ("GET", "/api/configuration", None),
            ("POST", "/api/configuration", {"section": "server", "key": "port", "value": 1}),
            ("GET", "/api/satellites/Photo/configuration", None),
            ("POST", "/api/satellites/Photo/configuration", {"key": "sync_port", "value": 1}),
            ("POST", "/api/satellites/Music/configuration", {"key": "scan_interval", "value": 5}),
            ("GET", "/api/satellites/Status/diagnostics", None),
            ("POST", "/api/commands/execute", {"command": "status"}),
        ):
            with self.subTest(method=method, path=path):
                status, _ = self.request(path, method, payload)
                self.assertEqual(status, 401)

    def test_a_signed_in_caller_can_change_a_developer_setting_without_any_mode(self):
        # Developer Mode is client-side only: the server neither knows nor checks it
        status, payload = self.request("/api/satellites/Music/configuration", "POST",
                                       {"key": "scan_interval", "value": 15}, token=self.token)
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.settings("/api/satellites/Music/configuration")["scan_interval"]["value"], 15)

    def test_no_secret_is_described_with_the_settings(self):
        photo = self.engine.registry.get("Photo")
        token = photo.config.data.get("sync_token") or ""
        for path in ("/api/configuration", "/api/satellites/Photo/configuration",
                     "/api/satellites/Music/configuration", "/api/satellites/LockedFolder/configuration"):
            with self.subTest(path=path):
                status, payload = self.request(path, token=self.token)
                self.assertEqual(status, 200, payload)
                text = json.dumps(payload).lower()
                self.assertNotIn("sync_token", text)
                self.assertNotIn("https_key_password", text)
                if token:
                    self.assertNotIn(token.lower(), text)
                self.assertNotIn("correct horse", text)


class MissionControlShellTest(unittest.TestCase):
    """The shell's half of the contract, read from the files Mission Control serves."""

    @classmethod
    def setUpClass(cls):
        cls.index = (REPOSITORY / "mission_control" / "index.html").read_text(encoding="utf-8")
        cls.app = (REPOSITORY / "mission_control" / "app.js").read_text(encoding="utf-8")
        cls.css = (REPOSITORY / "mission_control" / "home.css").read_text(encoding="utf-8")

    def test_the_toggle_sits_in_the_top_bar_and_starts_off(self):
        right = self.index[self.index.index('class="topbar-right"'):]
        self.assertIn('id="developer-button"', right[:right.index("</header>")])
        self.assertIn('aria-pressed="false"', self.index)

    def test_one_rule_hides_developer_content_until_it_is_on(self):
        self.assertIn(':root:not([data-developer-mode="on"]) [data-developer]', self.css)
        self.assertIn(':root[data-developer-mode="on"] [data-developer-hint]', self.css)

    def test_the_console_and_server_settings_are_developer_only(self):
        self.assertIn('data-route="console" title="Console" data-developer', self.index)
        self.assertIn('id="configuration-form" class="stack" data-developer', self.index)
        self.assertIn('DEVELOPER_ROUTES = new Set(["console"])', self.app)

    def test_it_is_remembered_per_account_and_given_to_satellite_pages(self):
        self.assertIn("`${DEVELOPER_KEY}.${accountName", self.app)
        self.assertIn("developer: developerContext", self.app)


if __name__ == "__main__":
    unittest.main()
