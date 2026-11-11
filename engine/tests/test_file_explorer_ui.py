"""File Explorer's shared interface (UI contract 1.2, a preview - F1 of
docs/file-explorer-migration.md): its ui.json, and the read-only view routes it
binds to. The listing itself is the `entries` route's (test_file_explorer.py)."""

from datetime import datetime, timezone
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlencode
import json
import shutil
import sys
import tempfile
import unittest

from starcore import ui_contract
from tests.support import start_engine, stop_engine
from tests.test_photo_gallery import routes_in

REPO = Path(__file__).resolve().parents[2]
FILE_EXPLORER_DIR = REPO / "satellites" / "native" / "file_explorer"
# the Satellite's modules, importable on their own (without an engine started first)
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


class FileExplorerUiDocumentTest(unittest.TestCase):
    def setUp(self):
        self.document = ui_contract.load(FILE_EXPLORER_DIR / "ui.json")

    def test_the_document_is_a_valid_preview(self):
        # the web keeps page.js by default until the shared interface reaches parity
        self.assertEqual(self.document["contract"], "starcore.ui/1.2")
        self.assertIs(self.document["preview"], True)
        self.assertTrue(ui_contract.UiDefinition(self.document).describe()["preview"])

    def test_every_route_it_names_is_one_of_file_explorers_own(self):
        from satellites.native.file_explorer import api

        known = set(api.routes())
        for route in routes_in(self.document):
            self.assertIn(route.split("?")[0].split("/")[0], known, route)


class FileExplorerViewTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")
        if cls.engine.registry.get("FileExplorer") is None:
            stop_engine(cls.engine)
            raise unittest.SkipTest("FileExplorer satellite did not load")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-fe-ui-")).resolve()

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def json_request(self, path, method="GET"):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        try:
            connection.request(method, path, body=b"{}" if method == "POST" else None,
                               headers={"Content-Type": "application/json"} if method == "POST" else {})
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def folder(self, path):
        return self.json_request(f"/api/satellites/FileExplorer/view/folder?{urlencode({'path': str(path)})}")

    def test_locations_list_every_root_with_its_storage(self):
        status, view = self.json_request("/api/satellites/FileExplorer/view/locations")
        self.assertEqual(status, 200)
        self.assertTrue(view["drives"])
        for drive in view["drives"]:
            self.assertEqual(drive["path"], drive["title"])
            self.assertIsInstance(drive["summary"], str)
            if drive["used_percent"] is not None:
                self.assertTrue(0 <= drive["used_percent"] <= 100)
        if view["machine"] is not None:
            self.assertLessEqual(view["machine"]["used"], view["machine"]["total"])
            self.assertIn("free across", view["machine_summary"])

    def test_a_folder_lists_its_folders_then_its_files_with_full_paths(self):
        (self.directory / "Beta").mkdir()
        (self.directory / "alpha").mkdir()
        (self.directory / "notes.txt").write_text("hello", encoding="utf-8")

        status, view = self.folder(self.directory)
        self.assertEqual(status, 200)
        self.assertEqual(view["path"], str(self.directory))
        self.assertEqual(view["name"], self.directory.name)
        self.assertEqual(view["parent"], str(self.directory.parent))
        self.assertFalse(view["at_drive_root"])
        self.assertEqual([row["name"] for row in view["folders"]], ["alpha", "Beta"])
        self.assertEqual(view["folders"][0]["path"], str(self.directory / "alpha"))
        self.assertEqual(view["folders"][0]["icon"], "folder")
        self.assertEqual(view["folders"][0]["subtitle"], view["folders"][0]["modified"])
        [notes] = view["files"]
        self.assertEqual((notes["name"], notes["size"], notes["icon"]), ("notes.txt", 5, "file"))
        self.assertIsInstance(notes["modified"], int)  # epoch seconds, for the datetime format
        self.assertEqual(notes["path"], str(self.directory / "notes.txt"))
        self.assertEqual(view["summary"], "2 folders, 1 file")
        self.assertTrue(view["has_folders"] and view["has_files"])
        self.assertFalse(view["empty"])

    def test_an_empty_folder_says_so(self):
        status, view = self.folder(self.directory)
        self.assertEqual(status, 200)
        self.assertTrue(view["empty"])
        self.assertEqual((view["folders"], view["files"], view["summary"]), ([], [], "Empty"))

    def test_up_from_a_drive_root_is_the_list_of_locations(self):
        root = Path(self.directory.anchor)
        status, view = self.folder(root)
        self.assertEqual(status, 200)
        self.assertIsNone(view["parent"])
        self.assertTrue(view["at_drive_root"])
        self.assertEqual(view["name"], str(root))

    def test_errors_are_the_listings_own(self):
        self.assertEqual(self.folder(self.directory / "missing")[0], 404)
        (self.directory / "a.txt").write_text("x", encoding="utf-8")
        self.assertEqual(self.folder(self.directory / "a.txt")[0], 400)
        self.assertEqual(self.folder("relative/path")[0], 400)
        self.assertEqual(self.json_request("/api/satellites/FileExplorer/view/nope")[0], 404)
        self.assertEqual(self.json_request("/api/satellites/FileExplorer/view/locations", "POST")[0], 405)

    def test_the_listing_offers_the_document_as_a_preview_beside_the_page(self):
        status, listing = self.json_request("/api/satellites")
        self.assertEqual(status, 200)
        entries = listing["satellites"] if isinstance(listing, dict) else listing
        explorer = next(entry for entry in entries if entry["name"] == "FileExplorer")
        self.assertTrue(explorer["ui"]["revision"])
        self.assertIs(explorer["ui"]["preview"], True)
        self.assertTrue(explorer["page"])


class FolderViewTest(unittest.TestCase):
    def test_a_locked_folder_shows_a_lock_and_says_so(self):
        from satellites.native.file_explorer import views

        view = views.folder_view(Path("/data"), "/", [
            {"name": "vault", "type": "dir", "size": None, "modified": "2026-11-12T10:00:00+00:00", "locked": True},
        ], None)
        [vault] = view["folders"]
        self.assertEqual((vault["icon"], vault["subtitle"]), ("lock", "Locked"))
        self.assertEqual(vault["modified"], int(datetime(2026, 11, 12, 10, tzinfo=timezone.utc).timestamp()))
        self.assertIsNone(view["storage"])

    def test_sizes_in_summaries_use_the_contracts_bytes_format(self):
        from satellites.native.file_explorer import views

        for size in (0, 10, 1536, 5 * 1024 ** 3, 536870912000):
            self.assertEqual(views._bytes(size), ui_contract.format_value(size, "bytes"))
