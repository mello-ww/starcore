"""File Explorer's shared interface (UI contract 1.2, F1-F6 of
docs/archive/file-explorer-migration.md): its ui.json, and the read-only view routes it
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
from tests.support import every_block, start_engine, stop_engine
from tests.test_photo_gallery import routes_in

REPO = Path(__file__).resolve().parents[2]
FILE_EXPLORER_DIR = REPO / "satellites" / "native" / "file_explorer"
# the Satellite's modules, importable on their own (without an engine started first)
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


class FileExplorerUiDocumentTest(unittest.TestCase):
    def setUp(self):
        self.document = ui_contract.load(FILE_EXPLORER_DIR / "ui.json")

    def test_the_document_is_valid_and_no_longer_a_preview(self):
        # F6: both clients draw it by default; F7 retired its page.js
        self.assertEqual(self.document["contract"], "starcore.ui/1.2")
        self.assertNotIn("preview", self.document)
        self.assertNotIn("preview", ui_contract.UiDefinition(self.document).describe())

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

    def test_boot_locations_are_kept_apart_for_developer_mode_and_warned_about(self):
        from importlib import import_module
        from pathlib import PurePosixPath as Path

        views = import_module("satellites.native.file_explorer.views")
        listing = {"entries": [{"name": place, "storage": None, "device": ""}
                               for place in ("/", "/boot", "/boot/efi", "/srv/data")],
                   "machine": None}
        view = views.locations_view(listing)
        self.assertEqual([drive["path"] for drive in view["drives"]], ["/", "/srv/data"])
        self.assertEqual([drive["path"] for drive in view["system_drives"]], ["/boot", "/boot/efi"])
        self.assertTrue(view["has_system_drives"])
        self.assertFalse(views.locations_view({"entries": listing["entries"][:1], "machine": None})["has_system_drives"])
        for place, warned in (("/boot", True), ("/boot/efi/EFI", True), ("/bootleg", False), ("/srv", False)):
            folder = views.folder_view(Path(place), "/", [], None)
            self.assertEqual(bool(folder["warning"]), warned, place)

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
        # the way down, one entry per level, each with the path it opens: the last is this folder
        crumbs = view["crumbs"]
        self.assertEqual(crumbs[-1], {"name": self.directory.name, "path": str(self.directory)})
        self.assertEqual(crumbs[0]["path"], self.directory.parts[0])
        self.assertEqual([crumb["path"] for crumb in crumbs][-2], str(self.directory.parent))
        self.assertEqual(len(crumbs), len(self.directory.parts))
        self.assertNotIn("\\", "".join(crumb["name"] for crumb in crumbs))
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

    # ---------- a file's page (F3) ----------

    def file(self, path):
        return self.json_request(f"/api/satellites/FileExplorer/view/file?{urlencode({'path': str(path)})}")

    def test_a_file_page_has_its_details_and_its_folder(self):
        notes = self.directory / "notes.txt"
        notes.write_text("hello", encoding="utf-8")
        status, view = self.file(notes)
        self.assertEqual(status, 200)
        self.assertEqual((view["name"], view["path"], view["folder"]), ("notes.txt", str(notes), str(self.directory)))
        self.assertEqual((view["size"], view["kind"], view["preview"]), (5, "Text file", False))
        self.assertEqual(view["modified"], int(notes.stat().st_mtime))  # epoch seconds, for the datetime format

    def test_a_picture_is_previewed_unless_it_is_too_large(self):
        (self.directory / "Photo.JPG").write_bytes(bytes([0xFF, 0xD8, 0xFF]))
        status, view = self.file(self.directory / "Photo.JPG")
        self.assertEqual((status, view["kind"], view["preview"]), (200, "JPEG image", True))
        large = self.directory / "huge.png"
        with open(large, "wb") as file:
            file.truncate(20 * 1024 * 1024 + 1)  # sparse: no real 20 MB written
        status, view = self.file(large)
        self.assertEqual((view["kind"], view["preview"]), ("PNG image", False))
        # an SVG is a document, not a picture both clients draw
        (self.directory / "drawing.svg").write_text("<svg/>", encoding="utf-8")
        self.assertFalse(self.file(self.directory / "drawing.svg")[1]["preview"])
        (self.directory / "README").write_text("x", encoding="utf-8")
        self.assertEqual(self.file(self.directory / "README")[1]["kind"], "File")

    def test_a_well_known_extension_has_a_readable_type(self):
        for name, kind in (("setup.EXE", "Windows application"), ("report.pdf", "PDF document"),
                           ("song.flac", "FLAC audio"), ("clip.mp4", "MP4 video"), ("Track.M4A", "M4A audio"),
                           ("scan.bmp", "BMP image"), ("data.xyz", "XYZ file")):
            (self.directory / name).write_bytes(b"x")
            self.assertEqual(self.file(self.directory / name)[1]["kind"], kind, name)

    def test_a_file_page_refuses_what_is_not_a_file(self):
        self.assertEqual(self.file(self.directory)[0], 400)
        self.assertEqual(self.file(self.directory / "missing.txt")[0], 404)
        self.assertEqual(self.file("relative/path.txt")[0], 400)
        self.assertEqual(self.json_request(
            f"/api/satellites/FileExplorer/view/file?{urlencode({'path': str(self.directory)})}", "POST")[0], 405)

    # ---------- paging (F2): each list arrives a page at a time ----------

    def page(self, **query):
        return self.json_request(f"/api/satellites/FileExplorer/view/folder?{urlencode(query)}")

    def every_row(self, view, part, limit=None):
        """Follows one list's cursors to its end: every name, in the order shown."""
        names = [row["name"] for row in view[part]]
        cursor = view[f"{part}_next"]
        while cursor is not None:
            query = {"path": str(self.directory), "part": part, "cursor": cursor}
            if limit is not None:
                query["limit"] = limit
            status, following = self.page(**query)
            self.assertEqual(status, 200)
            names += [row["name"] for row in following[part]]
            cursor = following[f"{part}_next"]
        return names

    def test_a_folder_of_ten_thousand_files_arrives_page_by_page(self):
        for index in range(10_000):
            (self.directory / f"file-{index:05d}.txt").touch()
        for index in range(250):
            (self.directory / f"Folder {index:03d}").mkdir()

        status, view = self.folder(self.directory)
        self.assertEqual(status, 200)
        self.assertEqual((len(view["folders"]), len(view["files"])), (200, 200))
        self.assertEqual((view["total_folders"], view["total_files"]), (250, 10_000))
        self.assertEqual(view["summary"], "250 folders, 10,000 files")
        self.assertTrue(view["has_folders"] and view["has_files"])
        self.assertIsNotNone(view["storage"])

        folders = self.every_row(view, "folders")
        files = self.every_row(view, "files", limit=500)
        self.assertEqual(folders, [f"Folder {index:03d}" for index in range(250)])
        self.assertEqual(files, [f"file-{index:05d}.txt" for index in range(10_000)])

    def test_a_page_of_one_part_holds_only_that_part(self):
        (self.directory / "a").mkdir()
        (self.directory / "b").mkdir()
        (self.directory / "x.txt").touch()
        status, view = self.page(path=str(self.directory), part="folders", cursor="a")
        self.assertEqual(status, 200)
        self.assertEqual(([row["name"] for row in view["folders"]], view["files"]), (["b"], []))
        self.assertIsNone(view["folders_next"])
        self.assertIsNone(view["storage"])  # only the first page says it
        self.assertEqual(view["summary"], "2 folders, 1 file")

    def test_a_page_carries_on_after_its_cursor_even_when_the_folder_changed(self):
        for name in ("a", "b", "c", "d", "e"):
            (self.directory / f"{name}.txt").touch()
        status, first = self.page(path=str(self.directory), limit=2)
        self.assertEqual([row["name"] for row in first["files"]], ["a.txt", "b.txt"])
        self.assertEqual(first["files_next"], "b.txt")
        # between pages: one already shown goes, the cursor's own goes, one before it and one after it arrive
        (self.directory / "a.txt").unlink()
        (self.directory / "b.txt").unlink()
        (self.directory / "aa.txt").touch()
        (self.directory / "f.txt").touch()
        rest = self.every_row(first, "files", limit=2)
        self.assertEqual(rest, ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"])

    def test_names_that_differ_only_by_case_keep_one_order(self):
        names = ["b.txt", "B.TXT"] if sys.platform != "win32" else ["b.txt", "c.txt"]
        for name in names:
            (self.directory / name).touch()
        status, view = self.page(path=str(self.directory), limit=1)
        self.assertEqual(self.every_row(view, "files", limit=1), sorted(names, key=lambda name: (name.lower(), name)))

    def test_paging_refuses_what_it_doesnt_understand(self):
        for query in ({"limit": "0"}, {"limit": "ten"}, {"limit": "-3"}, {"part": "both"}):
            with self.subTest(query):
                status, _ = self.page(path=str(self.directory), **query)
                self.assertEqual(status, 400)
        for index in range(600):
            (self.directory / f"{index:03d}").touch()
        status, view = self.page(path=str(self.directory), limit=10_000)
        self.assertEqual(len(view["files"]), 500)  # at most a page of 500

    def test_the_listing_offers_the_document_alone_with_no_page_of_its_own(self):
        status, listing = self.json_request("/api/satellites")
        self.assertEqual(status, 200)
        entries = listing["satellites"] if isinstance(listing, dict) else listing
        explorer = next(entry for entry in entries if entry["name"] == "FileExplorer")
        self.assertTrue(explorer["ui"]["revision"])
        self.assertNotIn("preview", explorer["ui"])
        self.assertFalse(explorer["page"])  # F7: its page.js is retired


class FileDocumentTest(unittest.TestCase):
    def test_a_file_row_opens_its_page_with_open_download_and_share(self):
        document = ui_contract.load(FILE_EXPLORER_DIR / "ui.json")
        folder = document["pages"]["folder"]
        files = next(block for block in folder["blocks"] if block.get("id") == "files")
        self.assertEqual(files["action"], {"navigate": "file", "params": {"path": "$.path"}})
        page = document["pages"]["file"]
        self.assertEqual(page["source"]["route"], "view/file?path={$params.path}")
        # on one row (an actions block), with the rename and delete in its Manage dropdown
        [row] = [block for block in page["blocks"] if block["type"] == "actions"]
        actions = {block["label"]: block["action"] for block in row["blocks"] if block["type"] == "button"}
        self.assertEqual(actions["Open"], {"download": "content?path={$params.path}", "name": "$.name", "open": True})
        self.assertEqual(actions["Download"]["download"], "content?path={$params.path}&download=1")
        self.assertEqual(actions["Share"]["share"], "content?path={$params.path}")
        [image] = [block for block in page["blocks"] if block["type"] == "image"]
        self.assertEqual((image["src"], image["visible"]), ("content?path={$params.path}", "$.preview"))

    def test_management_uses_the_existing_routes_and_confirms_a_delete(self):
        document = ui_contract.load(FILE_EXPLORER_DIR / "ui.json")

        def controls(page):
            return list(every_block(page["blocks"]))

        folder = controls(document["pages"]["folder"])
        [create] = [b for b in folder if b["type"] == "form" and b["submit"]["label"] == "Create folder"]
        self.assertEqual(create["submit"]["action"]["route"], "mkdir")
        self.assertEqual(create["submit"]["action"]["body"], {"path": "$params.path", "name": "$form.folder"})
        self.assertEqual(create["submit"]["action"]["then"], "refresh")
        # a page's forms are told apart by their field keys: two forms asking for a `name` would
        # share what was typed
        [rename] = [b for b in folder if b["type"] == "form" and b["submit"]["label"] == "Rename"]
        self.assertNotEqual([f["key"] for f in create["fields"]], [f["key"] for f in rename["fields"]])
        # a drive's root has no parent: it shows no rename and no delete; both sit in a dropdown
        # of the page's actions row, as does the new folder's name
        [manage] = [b for b in folder if b.get("label") == "This folder"]
        self.assertEqual((manage["type"], manage["visible"]), ("dropdown", "$.parent"))
        [new] = [b for b in folder if b.get("label") == "New folder"]
        self.assertEqual((new["type"], new["blocks"]), ("dropdown", [create]))

        # after a rename or a delete the page's path is gone: both go back to the folder, which
        # reloads and shows what is there now
        for name in ("folder", "file"):
            blocks = controls(document["pages"][name]) if name == "file" else manage["blocks"]
            [rename] = [b for b in blocks if b["type"] == "form" and b["submit"]["label"] == "Rename"]
            action = rename["submit"]["action"]
            self.assertEqual((action["route"], action["then"]), ("rename", "back"))
            [delete] = [b for b in blocks if b["type"] == "button" and b["label"].startswith("Delete")]
            self.assertEqual(delete["style"], "danger")
            self.assertEqual(delete["action"]["route"], "delete")
            self.assertEqual(delete["action"]["then"], "back")
            self.assertIn("cannot be undone", delete["action"]["confirm"])

    def test_a_folder_uploads_into_itself_and_asks_before_replacing_a_file(self):
        document = ui_contract.load(FILE_EXPLORER_DIR / "ui.json")
        [upload] = [block for block in every_block(document["pages"]["folder"]["blocks"])
                    if block["type"] == "button" and "upload" in block.get("action", {})]
        action = upload["action"]
        self.assertEqual(upload["label"], "Upload files")
        self.assertEqual(action["upload"], {"multiple": True})
        # the existing raw-body route; a file already there answers 409 and is replaced only
        # once the person confirms, by the same route with `overwrite`
        self.assertEqual(action["route"], "upload?path={$params.path}&name={$value.name}")
        self.assertEqual(action["conflict"]["route"], action["route"] + "&overwrite=1")
        self.assertIn("Replace it?", action["conflict"]["confirm"])
        self.assertEqual(action["then"], "refresh")
        self.assertNotIn("upload", json.dumps(document["pages"]["file"]))


class FolderViewTest(unittest.TestCase):
    def test_a_locked_folder_shows_a_lock_and_says_so(self):
        from satellites.native.file_explorer import views

        view = views.folder_view(Path("/data"), "/", [
            {"name": "vault", "type": "dir", "size": None, "modified": "2026-11-12T10:00:00+00:00", "locked": True},
        ], None)
        [vault] = view["folders"]
        self.assertEqual((view["total_folders"], view["total_files"], view["folders_next"]), (1, 0, None))
        self.assertEqual((vault["icon"], vault["subtitle"]), ("lock", "Locked"))
        self.assertEqual(vault["modified"], int(datetime(2026, 11, 12, 10, tzinfo=timezone.utc).timestamp()))
        self.assertIsNone(view["storage"])

    def test_sizes_in_summaries_use_the_contracts_bytes_format(self):
        from satellites.native.file_explorer import views

        for size in (0, 10, 1536, 5 * 1024 ** 3, 536870912000):
            self.assertEqual(views._bytes(size), ui_contract.format_value(size, "bytes"))
