"""The Locked Folder's shared interface (ui.json, UI contract 1.2): the document validates as a
protected preview, every route it names is one of the Locked Folder's own and refuses a session
that hasn't unlocked the vault (the setup page's excepted, which says nothing about where the
vault is), every management route it reaches still needs what it needs from its own screens
(the PIN, the recovery key, an unlock), and the views it reads give its pages what they bind.

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
    """(method, route template, body or None, kind, secrets or None) for every route the
    document names: page sources and paging (GET), images and downloads (GET), actions and form
    submits (POST, an upload's raw). `kind` is the page's name for a page's own source, so the
    setup page can be told apart."""
    found = []

    def action(entry):
        if not isinstance(entry, dict):
            return
        if "download" in entry:
            found.append(("GET", entry["download"], None, "download", None))
        elif "upload" in entry:
            found.append(("POST", entry["route"], None, "upload", None))
        elif "route" in entry:
            found.append((entry.get("method", "POST"), entry["route"], entry.get("body"), "action", entry.get("secrets")))

    def block(entry, page_name):
        action(entry.get("action"))
        if entry.get("type") == "form":
            action(entry["submit"]["action"])
        if entry.get("type") == "media-grid":
            found.append(("GET", entry["more"]["route"], None, page_name, None))
            found.append(("GET", entry["item"]["image"], None, "image", None))
            viewer = entry.get("viewer") or {}
            for key in ("image", "video"):
                if key in viewer:
                    found.append(("GET", viewer[key], None, "image", None))
            for listed in (viewer.get("actions") or []) + ((entry.get("selection") or {}).get("actions") or []):
                action(listed.get("action"))
        for inner in entry.get("blocks") or []:
            block(inner, page_name)

    for name, page in document["pages"].items():
        if "source" in page:
            found.append(("GET", page["source"]["route"], None, name, None))
        for entry in page["blocks"]:
            block(entry, name)
    return found


SAMPLE = {"$.path": "secret.txt", "$.preview": "file", "$value.name": "new.txt", "$value": "0"}
# what a client would put in the body for each secret: never the right PIN here
WRONG = {"pin": "9999", "recovery-key": "AAAA-BBBB-CCCC-DDDD"}


def _resolve(template: str) -> str:
    return BINDING.sub(lambda match: quote(SAMPLE.get(match.group(1), "x"), safe=""), template)


def _body(body, secrets=None, values=None):
    """The body a client sends: each binding resolved (SAMPLE, else "x"), and each secret as
    `values` gives it by kind (WRONG unless told)."""
    def fill(value):
        if isinstance(value, str) and value.startswith("$"):
            return SAMPLE.get(value, "x")
        if isinstance(value, list):
            return [fill(item) for item in value]
        if isinstance(value, dict):
            return {key: fill(item) for key, item in value.items()}
        return value
    if body is None and not secrets:
        return None
    sent = fill(body or {})
    for key, secret in (secrets or {}).items():
        sent[key] = (values or WRONG)[secret["kind"]]
    return sent


class LockedFolderUiDocumentTest(unittest.TestCase):
    def setUp(self):
        self.document = ui_contract.load(LOCKED_FOLDER_DIR / "ui.json")

    def test_it_is_a_protected_preview_with_a_setup_page_and_nothing_kept(self):
        self.assertEqual(self.document["contract"], "starcore.ui/1.2")
        self.assertTrue(self.document["preview"])
        self.assertEqual(self.document["protected"], {"capability": "media.vault", "setup": "setup", "forgot": "forgot"})
        self.assertNotIn("params", self.document["pages"]["setup"])
        self.assertNotIn("params", self.document["pages"]["forgot"])
        self.assertEqual(self.document["pages"]["forgot"]["source"]["route"], "setup?forgot=1")
        self.assertNotIn("widgets", self.document)
        self.assertFalse([name for name, page in self.document["pages"].items() if "offline" in page])
        self.assertNotIn('"share"', json.dumps(self.document))

    def test_every_route_it_names_is_one_of_the_locked_folders_own(self):
        from satellites.native.locked_folder import api, views
        routes = api.routes()
        for method, template, _, _, _ in _templates(self.document):
            first = re.split(r"[/?]", template, maxsplit=1)[0]
            self.assertIn(first, routes, template)
            if first == "media" and template.startswith("media/"):
                inner = re.split(r"[?]", template[len("media/"):], maxsplit=1)[0]
                # a tile's route is media/<preview>: the sub-routes media answers
                allowed = set(views.PREVIEWS.values()) if inner == "{$.preview}" else {"file", "thumbnail", "duration"}
                self.assertTrue(inner in allowed or inner == "{$.preview}", template)
            if first == "encryption":
                self.assertIn(template, {"encryption/start", "encryption/undo", "encryption/discard",
                                         "encryption/recovery_key"})
        self.assertLessEqual(set(views.PREVIEWS.values()), {"file", "thumbnail"})

    def test_it_changes_the_vault_only_through_its_existing_routes(self):
        changing = sorted({re.split(r"[/?]", template)[0] for method, template, _, kind, _ in _templates(self.document)
                           if method == "POST"})
        self.assertEqual(changing, ["configuration", "delete", "delink", "encryption", "move_out", "pin", "recover",
                                    "upload"])
        # the only setting it changes is the location, from the setup page
        settings = [body for _, template, body, _, _ in _templates(self.document) if template == "configuration"]
        self.assertEqual(settings, [{"key": "locked_folder_path", "value": "$form.path"}])
        # a download names the file, and nothing is handed to another app or Satellite
        downloads = [template for _, template, _, kind, _ in _templates(self.document) if kind == "download"]
        self.assertEqual(downloads, ["media/file?path={$.path}&download=1"])

    def test_every_pin_and_recovery_key_is_a_secret_never_a_form_field(self):
        asked = {}
        for _, template, body, _, secrets in _templates(self.document):
            if secrets:
                asked.setdefault(template, []).append(
                    {key: (secret["kind"], secret.get("new", False)) for key, secret in secrets.items()})
                self.assertFalse(set(secrets) & set(body or {}), template)
        self.assertEqual(asked, {
            "pin": [{"pin": ("pin", True)},
                    {"current_pin": ("pin", False), "pin": ("pin", True)}],
            "recover": [{"recovery_key": ("recovery-key", False), "pin": ("pin", True)}] * 2,  # setup and forgot
            "encryption/recovery_key": [{"pin": ("pin", False)}] * 3,
            "encryption/discard": [{"pin": ("pin", False)}],
        })
        text = json.dumps(self.document).lower()
        for field in ('"key": "pin"', '"key": "current_pin"', '"key": "recovery_key"'):
            self.assertNotIn(field, text)
        # a new recovery key is only ever revealed, never bound into a page
        self.assertNotIn("$.recovery_key", text)

    def test_the_setup_summary_names_the_step_and_never_the_vault(self):
        from satellites.native.locked_folder import views

        class Live:
            pin_set = False

        live = Live()
        self.assertTrue(views.setup(live, False, None)["needs_location"])
        page = views.setup(live, True, None)
        self.assertEqual((page["title"], page["needs_pin"], page["needs_location"]), ("No PIN yet", True, False))
        live.pin_set = True
        self.assertEqual(views.setup(live, True, None)["title"], "Ready")
        for problem in views.PROBLEMS:
            without, with_key = views.setup(live, True, problem, False), views.setup(live, True, problem, True)
            self.assertEqual(without["title"], views.PROBLEMS[problem][0])
            self.assertFalse(without["recoverable"] or without["needs_pin"] or without["needs_location"])
            self.assertEqual(with_key["recoverable"], problem in views.RECOVERABLE)
            for page in (without, with_key):
                self.assertNotIn("vault", json.dumps(page).lower().replace("locked folder", ""))
        self.assertIn("recovery key to set a new PIN", views.setup(live, True, "pin_tampered", True)["message"])
        self.assertIn("No recovery key", views.setup(live, True, "key_unavailable", False)["message"])

    def test_the_forgot_page_offers_the_recovery_key_or_says_who_can_reset_it(self):
        from satellites.native.locked_folder import views

        class Live:
            pin_set = True

        live = Live()
        with_key = views.setup(live, True, None, True, True, forgot=True)
        self.assertEqual((with_key["title"], with_key["recoverable"]), ("Forgot your PIN?", True))
        encrypted = views.setup(live, True, None, False, True, forgot=True)
        self.assertFalse(encrypted["recoverable"])
        self.assertIn("can't be reset", encrypted["message"])
        plain = views.setup(live, True, None, False, False, forgot=True)
        self.assertFalse(plain["recoverable"])
        self.assertIn("pin.json", plain["message"])
        # a vault that can't be opened, or isn't set up, says so rather than the forgotten PIN
        self.assertEqual(views.setup(live, True, "pin_tampered", True, True, forgot=True)["title"],
                         views.PROBLEMS["pin_tampered"][0])
        self.assertTrue(views.setup(live, False, None, forgot=True)["needs_location"])
        live.pin_set = False
        self.assertTrue(views.setup(live, True, None, forgot=True)["needs_pin"])

    def test_the_settings_view_offers_what_applies_now(self):
        from satellites.native.locked_folder import views

        class Live:
            pin_set = True

            def device_count(self):
                return 2

        root = LOCKED_FOLDER_DIR  # any folder that exists
        off = views.settings(Live(), root, {"available": True, "state": "off", "recovery_key": False})
        self.assertTrue(off["can_encrypt"])
        self.assertFalse(off["can_resume"] or off["can_undo"] or off["has_recovery_key"] or off["no_recovery_key"])
        self.assertIsNone(off["recovery"])
        self.assertIn("2 phones", off["biometric_note"])
        self.assertFalse(views.settings(Live(), root, {"available": False, "state": "off"})["can_encrypt"])

        interrupted = views.settings(Live(), root, {"available": True, "state": "interrupted", "interrupted_run": "r1",
                                                    "recovery_key": True})
        self.assertEqual((interrupted["can_resume"], interrupted["resume_label"], interrupted["can_undo"],
                          interrupted["interrupted_run"]), (True, "Resume encryption", True, "r1"))
        self.assertFalse(interrupted["can_encrypt"])

        on = views.settings(Live(), root, {"available": True, "state": "on", "recovery_key": False,
                                           "unencrypted_files": 3,
                                           "backups": [{"id": "r1", "created": "2026-11-01T10:00:00+00:00",
                                                        "files": 1, "bytes": 10}]})
        self.assertEqual((on["can_resume"], on["resume_label"], on["no_recovery_key"], on["has_recovery_key"]),
                         (True, "Encrypt remaining files", True, False))
        self.assertIn("3 files are not encrypted yet", on["encryption"])
        self.assertEqual((on["has_backups"], on["backups"][0]["title"]), (True, "Backup of 1 original"))
        found = views.backup({"backups": on["backups"]}, "r1")
        self.assertEqual((found["id"], found["files"]), ("r1", 1))
        self.assertIsNone(views.backup({"backups": on["backups"]}, "r2"))
        self.assertNotIn("recovery_key\": \"", json.dumps(on))  # never a key, only whether there is one


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
        SAMPLE["$form.path"] = str(self.directory / "elsewhere")
        self.addCleanup(SAMPLE.pop, "$form.path", None)

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

    def unlock(self, pin="1234"):
        self.assertEqual(self.json_request("unlock", "POST", {"pin": pin})[0], 200)

    def call(self, method, template, body, kind, secrets=None, token=None, values=None):
        route = _resolve(template)
        if kind == "upload":
            return self.request(route, "POST", raw=b"hello", token=token)[0]
        return self.request(route, method, payload=_body(body, secrets, values), token=token)[0]

    def configured_path(self):
        return self.locked_folder.config.data["locked_folder_path"]

    def test_every_route_it_names_refuses_a_locked_session_but_the_setup_page(self):
        self.protect()
        named = _templates(self.document)
        self.assertGreaterEqual(len(named), 20)
        for method, template, body, kind, secrets in named:
            status = self.call(method, template, body, kind, secrets)
            if kind in ("setup", "forgot"):
                self.assertEqual(status, 200, template)
            elif template in ("pin", "recover"):
                # a PIN or a recovery key is what these need, not an unlock: a wrong one is refused
                self.assertIn(status, (400, 401), f"{method} {template}")
            else:
                self.assertEqual(status, 403, f"{method} {template}")
            # and nothing at all without a session
            self.assertEqual(self.call(method, template, body, kind, secrets, token=""), 401, f"{method} {template}")
        # nothing was changed on the way: the file is still there, nothing was added, the vault
        # is where it was and its PIN still opens it
        self.assertEqual(sorted(path.name for path in self.vault.iterdir()), ["secret.txt"])
        self.assertEqual(self.configured_path(), str(self.vault))
        self.unlock()

    def test_every_management_route_still_needs_what_it_needs(self):
        self.locked_folder.config.data["max_pin_attempts"] = 10  # every refusal here is a wrong attempt
        self.protect()
        self.unlock()
        # an unlocked session still needs the current PIN to change it, and the PIN again to
        # delete a backup or replace the recovery key
        self.assertEqual(self.json_request("pin", "POST", {"pin": "5678"})[0], 401)
        self.assertEqual(self.json_request("pin", "POST", {"pin": "5678", "current_pin": "9999"})[0], 401)
        for route, body in (("encryption/discard", {"run": "x"}), ("encryption/recovery_key", {}),
                            ("encryption/recovery_key", {"remove": True})):
            self.assertEqual(self.json_request(route, "POST", body)[0], 401, route)
            self.assertEqual(self.json_request(route, "POST", {**body, "pin": "9999"})[0], 401, route)
        self.assertEqual(self.json_request("recover", "POST", {"recovery_key": WRONG["recovery-key"], "pin": "5678"})[0], 400)
        # nothing changed: the PIN is the old one
        self.json_request("lock", "POST", {})
        self.assertEqual(self.json_request("unlock", "POST", {"pin": "5678"})[0], 401)
        self.unlock()

    def test_the_document_changes_the_pin_and_every_unlock_ends(self):
        self.protect()
        self.unlock()
        change = next((template, body, secrets) for _, template, body, _, secrets in _templates(self.document)
                      if template == "pin" and secrets and "current_pin" in secrets)
        values = {"pin": "1234"}
        body = _body(change[1], {"current_pin": change[2]["current_pin"]}, values)
        body["pin"] = "5678"
        self.assertEqual(self.json_request("pin", "POST", body)[0], 200)
        # the client asks status again after the action: locked now, the new PIN opens it
        self.assertFalse(self.json_request("status")[1]["unlocked"])
        self.assertEqual(self.json_request("settings")[0], 403)
        self.unlock("5678")

    def test_the_setup_page_says_what_is_missing_and_never_where_the_vault_is(self):
        status, page = self.json_request("setup")
        self.assertEqual((status, page["title"], page["problem"]), (200, "Not set up yet", None))
        self.assertTrue(page["needs_location"])
        # the setup page's own form sets the location
        self.assertEqual(self.json_request("configuration", "POST",
                                           {"key": "locked_folder_path", "value": str(self.vault)})[0], 200)
        status, page = self.json_request("setup")
        self.assertEqual((page["title"], page["needs_pin"], page["needs_location"]), ("No PIN yet", True, False))
        self.protect()
        status, page = self.json_request("setup")
        self.assertEqual(page["title"], "Ready")
        self.assertFalse(page["needs_pin"] or page["needs_location"] or page["recoverable"])
        self.assertNotIn(str(self.vault), json.dumps(page))
        self.assertNotIn("vault", json.dumps(page).lower().replace("locked folder", ""))
        # locked, the forgot page answers too, and says how a forgotten PIN is reset
        status, page = self.json_request("setup?forgot=1")
        self.assertEqual((status, page["title"], page["recoverable"]), (200, "Forgot your PIN?", False))
        self.assertIn("pin.json", page["message"])
        self.assertNotIn(str(self.vault), json.dumps(page))

    def test_the_settings_page_gives_its_cards_what_they_bind(self):
        self.protect()
        self.assertEqual(self.json_request("settings")[0], 403)
        self.assertEqual(self.json_request("settings", token="")[0], 401)
        self.unlock()
        status, page = self.json_request("settings")
        self.assertEqual(status, 200)
        self.assertEqual((page["path"], page["path_missing"], page["biometric_devices"]), (str(self.vault), False, 0))
        self.assertEqual((page["has_backups"], page["backups"], page["recovery"]), (False, [], None))
        self.assertFalse(page["can_resume"] or page["can_undo"])
        self.assertTrue(page["encryption"])
        self.assertEqual(self.json_request("settings?run=nothing")[0], 404)
        self.assertEqual(self.json_request("settings", "POST", {})[0], 405)

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
