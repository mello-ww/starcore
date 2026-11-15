"""The Locked Folder's shared interface (ui.json, UI contract 1.2): the document validates as a
protected preview, every route it names is one of the Locked Folder's own and refuses a session
that hasn't unlocked the vault (the setup page's excepted, which says nothing about where the
vault is), and the views it reads give the grid and the viewer what they bind.

See docs/satellites/locked_folder.md, "Shared interface".
"""

from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import quote
import json
import re
import shutil
import tempfile
import unittest

from starcore import ui_contract
from starcore.auth import AuthStore
from tests.support import start_engine, stop_engine
from tests.test_photo import png

REPO = Path(__file__).resolve().parents[2]
LOCKED_FOLDER_DIR = REPO / "satellites" / "native" / "locked_folder"
BINDING = re.compile(r"\{([^{}]*)\}")


def _templates(document) -> list:
    """(method, route template, body or None, kind) for every route the document names:
    page sources and paging (GET), images and downloads (GET), actions (POST, an upload's
    raw). `kind` is "page" for a page's own source, so the setup page can be told apart."""
    found = []

    def action(entry):
        if not isinstance(entry, dict):
            return
        if "download" in entry:
            found.append(("GET", entry["download"], None, "download"))
        elif "upload" in entry:
            found.append(("POST", entry["route"], None, "upload"))
        elif "route" in entry:
            found.append((entry.get("method", "POST"), entry["route"], entry.get("body"), "action"))

    def block(entry, page_name):
        action(entry.get("action"))
        if entry.get("type") == "media-grid":
            found.append(("GET", entry["more"]["route"], None, page_name))
            found.append(("GET", entry["item"]["image"], None, "image"))
            viewer = entry.get("viewer") or {}
            for key in ("image", "video"):
                if key in viewer:
                    found.append(("GET", viewer[key], None, "image"))
            for listed in (viewer.get("actions") or []) + ((entry.get("selection") or {}).get("actions") or []):
                action(listed.get("action"))
        for inner in entry.get("blocks") or []:
            block(inner, page_name)

    for name, page in document["pages"].items():
        if "source" in page:
            found.append(("GET", page["source"]["route"], None, name))
        for entry in page["blocks"]:
            block(entry, name)
    return found


SAMPLE = {"$.path": "secret.txt", "$.preview": "file", "$value.name": "new.txt", "$value": "0"}


def _resolve(template: str) -> str:
    return BINDING.sub(lambda match: quote(SAMPLE.get(match.group(1), "x"), safe=""), template)


def _body(body):
    if body is None:
        return None
    return json.loads(json.dumps(body).replace('"$.path"', '"secret.txt"'))


class LockedFolderUiDocumentTest(unittest.TestCase):
    def setUp(self):
        self.document = ui_contract.load(LOCKED_FOLDER_DIR / "ui.json")

    def test_it_is_a_protected_preview_with_a_setup_page_and_nothing_kept(self):
        self.assertEqual(self.document["contract"], "starcore.ui/1.2")
        self.assertTrue(self.document["preview"])
        self.assertEqual(self.document["protected"], {"capability": "media.vault", "setup": "setup"})
        self.assertNotIn("params", self.document["pages"]["setup"])
        self.assertNotIn("widgets", self.document)
        self.assertFalse([name for name, page in self.document["pages"].items() if "offline" in page])
        self.assertNotIn('"share"', json.dumps(self.document))

    def test_every_route_it_names_is_one_of_the_locked_folders_own(self):
        from satellites.native.locked_folder import api, views
        routes = api.routes()
        for method, template, _, _ in _templates(self.document):
            first = re.split(r"[/?]", template, maxsplit=1)[0]
            self.assertIn(first, routes, template)
            if first == "media" and template.startswith("media/"):
                inner = re.split(r"[?]", template[len("media/"):], maxsplit=1)[0]
                # a tile's route is media/<preview>: the sub-routes media answers
                allowed = set(views.PREVIEWS.values()) if inner == "{$.preview}" else {"file", "thumbnail", "duration"}
                self.assertTrue(inner in allowed or inner == "{$.preview}", template)
        self.assertLessEqual(set(views.PREVIEWS.values()), {"file", "thumbnail"})

    def test_it_changes_the_vault_only_through_its_existing_routes(self):
        changing = sorted({re.split(r"[/?]", template)[0] for method, template, _, kind in _templates(self.document)
                           if method == "POST"})
        self.assertEqual(changing, ["delete", "move_out", "upload"])
        # a download names the file, and nothing is handed to another app or Satellite
        downloads = [template for _, template, _, kind in _templates(self.document) if kind == "download"]
        self.assertEqual(downloads, ["media/file?path={$.path}&download=1"])


class LockedFolderUiApiTest(unittest.TestCase):
    def setUp(self):
        self.engine = start_engine(mission_control=True)
        if not self.engine.api.running:
            stop_engine(self.engine)
            raise unittest.SkipTest("Mission Control could not be started")
        self.locked_folder = self.engine.registry.get("LockedFolder")
        if self.locked_folder is None:
            stop_engine(self.engine)
            raise unittest.SkipTest("the LockedFolder satellite did not load")

        self.directory = Path(tempfile.mkdtemp(prefix="starcore-lockedfolder-ui-"))
        config = self.locked_folder.config
        config.data["storage"] = str(self.directory / "lf-data")
        config.data["locked_folder_path"] = ""
        config.data["session_timeout_seconds"] = 900
        config.data["max_pin_attempts"] = 5
        config.data["lockout_seconds"] = 300
        # never the real satellites/native/locked_folder/config.toml
        config.path = self.directory / "config.toml"

        self.vault = self.directory / "vault"
        self.vault.mkdir()
        (self.vault / "secret.txt").write_text("shh", encoding="utf-8")
        self.engine.auth = AuthStore(self.directory / "auth.json")
        self.token = self.engine.auth.bootstrap("admin", "a very good password")
        self.document = ui_contract.load(LOCKED_FOLDER_DIR / "ui.json")

    def tearDown(self):
        stop_engine(self.engine)
        shutil.rmtree(self.directory, ignore_errors=True)

    def request(self, path, method="GET", payload=None, raw=None, token=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
        headers, body = {}, None
        if raw is not None:
            body, headers["Content-Type"] = raw, "application/octet-stream"
        elif payload is not None:
            body, headers["Content-Type"] = json.dumps(payload).encode("utf-8"), "application/json"
        token = self.token if token is None else token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            connection.request(method, f"/api/satellites/LockedFolder/{path}", body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def json_request(self, path, method="GET", payload=None, token=None):
        status, body = self.request(path, method, payload=payload, token=token)
        return status, (json.loads(body.decode("utf-8")) if body else {})

    def protect(self):
        status, _ = self.json_request("configuration", "POST", {"key": "locked_folder_path", "value": str(self.vault)})
        self.assertEqual(status, 200)
        self.assertEqual(self.json_request("pin", "POST", {"pin": "1234"})[0], 200)
        self.json_request("lock", "POST", {})
        self.assertFalse(self.json_request("status")[1]["unlocked"])

    def unlock(self):
        self.assertEqual(self.json_request("unlock", "POST", {"pin": "1234"})[0], 200)

    def call(self, method, template, body, kind, token=None):
        route = _resolve(template)
        if kind == "upload":
            return self.request(route, "POST", raw=b"hello", token=token)[0]
        return self.request(route, method, payload=_body(body), token=token)[0]

    def test_every_route_it_names_refuses_a_locked_session_but_the_setup_page(self):
        self.protect()
        named = _templates(self.document)
        self.assertGreaterEqual(len(named), 8)
        for method, template, body, kind in named:
            status = self.call(method, template, body, kind)
            if kind == "setup":
                self.assertEqual(status, 200, template)
            else:
                self.assertEqual(status, 403, f"{method} {template}")
            # and nothing at all without a session
            self.assertEqual(self.call(method, template, body, kind, token=""), 401, f"{method} {template}")
        # nothing was changed on the way: the file is still there, nothing was added
        self.assertEqual(sorted(path.name for path in self.vault.iterdir()), ["secret.txt"])

    def test_the_setup_page_says_what_is_missing_and_never_where_the_vault_is(self):
        status, page = self.json_request("setup")
        self.assertEqual((status, page["title"], page["problem"]), (200, "Not set up yet", None))
        self.json_request("configuration", "POST", {"key": "locked_folder_path", "value": str(self.vault)})
        status, page = self.json_request("setup")
        self.assertEqual(page["title"], "No PIN yet")
        self.protect()
        status, page = self.json_request("setup")
        self.assertEqual(page["title"], "Ready")
        self.assertNotIn(str(self.vault), json.dumps(page))
        self.assertNotIn("vault", json.dumps(page).lower().replace("locked folder", ""))

    def test_the_gallery_gives_the_grid_and_the_viewer_what_they_bind(self):
        self.protect()
        self.unlock()
        (self.vault / "beach.png").write_bytes(png(4, 3))
        status, page = self.json_request("gallery?limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(len(page["items"]), 1)
        self.assertEqual(page["next"], "1")
        self.assertEqual(page["summary"], "2 items")
        rest = self.json_request("gallery?limit=1&cursor=1")[1]
        self.assertIsNone(rest["next"])
        items = {item["name"]: item for item in page["items"] + rest["items"]}

        picture, other = items["beach.png"], items["secret.txt"]
        self.assertEqual((picture["kind"], picture["preview"], picture["icon"]), ("image", "file", None))
        self.assertEqual((other["kind"], other["preview"], other["icon"]), (None, None, "file"))
        self.assertFalse(other["movable"])
        self.assertEqual(picture["movable"], page["photos_available"])
        self.assertTrue(picture["group"])

        # the tile's own route, as the document builds it, answers with the picture
        status, data = self.request(f"media/{picture['preview']}?path={quote(picture['path'], safe='')}")
        self.assertEqual((status, data), (200, png(4, 3)))

    def test_what_the_document_uploads_downloads_and_deletes_reaches_the_vault(self):
        self.protect()
        self.unlock()
        status, body = self.request(_resolve("upload?name={$value.name}"), "POST", raw=b"hello")
        self.assertEqual(status, 200, body)
        added = json.loads(body.decode("utf-8"))
        self.assertEqual((self.vault / added["path"]).read_bytes(), b"hello")

        status, data = self.request(f"media/file?path={quote(added['path'], safe='')}&download=1")
        self.assertEqual((status, data), (200, b"hello"))

        status, result = self.json_request("delete", "POST", {"paths": [added["path"]]})
        self.assertEqual(status, 200)
        self.assertFalse((self.vault / added["path"]).exists())


if __name__ == "__main__":
    unittest.main()
