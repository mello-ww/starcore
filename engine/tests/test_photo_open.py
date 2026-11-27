"""files.open: Photos opening a file by its path (UI contract change 16) - always through
whichever Satellite provides files.browse, with the asking session."""

from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlencode
import json
import shutil
import tempfile
import unittest

from tests.support import protecting, start_engine, stop_engine
from tests.test_photo import png


class PhotoOpenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")
        cls.satellite = cls.engine.registry.get("Photo")
        if cls.satellite is None or cls.engine.registry.get("FileExplorer") is None:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Photo and FileExplorer are needed")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-open-")).resolve()
        self.outside = self.directory / "elsewhere"
        self.outside.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")
        self.satellite.config.data["photo_directory"] = ""
        self.satellite.config.path = self.directory / "config.toml"

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def request(self, route, method="GET", payload=None, **query):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        suffix = f"?{urlencode(query)}" if query else ""
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        try:
            connection.request(method, f"/api/satellites/Photo/{route}{suffix}", body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def json(self, *args, **kwargs):
        status, _headers, body = self.request(*args, **kwargs)
        return status, json.loads(body.decode("utf-8"))

    def picture(self, name="beach.png", folder=None):
        path = (folder or self.outside) / name
        path.write_bytes(png(4, 3))
        return path

    def test_the_catalog_lists_what_photos_opens(self):
        entry = self.satellite.manifest.provides["files.open"]
        self.assertEqual(entry["operations"], {"open": "open"})
        self.assertEqual(entry["types"], ["image", "video"])
        self.assertIn(".png", entry["extensions"])
        self.assertEqual(entry["label"], "Photos")

    def test_a_picture_opens_the_file_page_with_its_path(self):
        path = self.picture()
        status, answer = self.json("open", "POST", {"path": str(path)})
        self.assertEqual(status, 200)
        self.assertEqual(answer, {"page": "file", "params": {"path": str(path)}})

    def test_what_it_cannot_show_or_the_user_cannot_browse_is_a_404(self):
        (self.outside / "notes.txt").write_text("x", encoding="utf-8")
        for path in (self.outside / "notes.txt", self.outside / "missing.png", self.outside,
                     "relative/a.png"):
            status, _ = self.json("open", "POST", {"path": str(path)})
            self.assertIn(status, (400, 404), path)
        self.assertEqual(self.request("open")[0], 405)
        status, _ = self.json("open", "POST", {"path": 3})
        self.assertEqual(status, 400)

    def test_the_file_page_says_whether_the_library_holds_the_file(self):
        path = self.picture()
        status, view = self.json("gallery/file", path=str(path))
        self.assertEqual(status, 200)
        self.assertEqual((view["name"], view["kind"], view["is_image"], view["can_add"]),
                         ("beach.png", "image", True, True))
        self.assertEqual(view["videos"], [])
        status, added = self.json("file/add", "POST", {"path": str(path)})
        self.assertEqual((status, added["added"]), (200, True))
        status, again = self.json("file/add", "POST", {"path": str(path)})
        self.assertEqual((status, again["added"]), (200, False))
        status, view = self.json("gallery/file", path=str(path))
        self.assertEqual((view["can_add"], view["library_note"]), (False, "In the library"))

    def test_a_video_is_drawn_by_the_viewer_and_served_inline(self):
        path = self.outside / "clip.mp4"
        path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
        status, view = self.json("gallery/file", path=str(path))
        self.assertEqual((status, view["is_video"], len(view["videos"])), (200, True, 1))
        status, headers, body = self.request("file/content", path=str(path))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "video/mp4")
        self.assertNotIn("attachment", headers.get("Content-Disposition", ""))
        self.assertTrue(body.startswith(b"\x00\x00\x00\x18ftyp"))

    def test_the_content_of_a_picture_is_served_from_where_it_is(self):
        path = self.picture()
        status, headers, body = self.request("file/content", path=str(path))
        self.assertEqual((status, headers["Content-Type"], body), (200, "image/png", path.read_bytes()))
        self.assertEqual(self.request("file/content", path=str(self.outside / "gone.png"))[0], 404)
        self.assertEqual(self.request("file/content", path="relative.png")[0], 404)

    def test_adding_something_that_is_not_a_picture_is_refused(self):
        path = self.outside / "fake.png"
        path.write_bytes(b"not a picture at all")
        status, _ = self.json("file/add", "POST", {"path": str(path)})
        self.assertEqual(status, 415)

    def test_a_file_of_a_protected_area_is_shown_but_never_taken_in(self):
        vault = self.outside / "vault"
        vault.mkdir()
        path = self.picture(folder=vault)
        with protecting(vault):
            status, view = self.json("gallery/file", path=str(path))
            self.assertEqual((status, view["can_add"], view["library_note"]), (200, False, "In a protected area"))
            self.assertEqual(self.request("file/content", path=str(path))[0], 200)
            status, refused = self.json("file/add", "POST", {"path": str(path)})
        self.assertEqual(status, 403)
        self.assertIn("protected area", refused["error"])
        # nothing was taken in: outside the area, the same file is still not in the library
        status, view = self.json("gallery/file", path=str(path))
        self.assertEqual((view["can_add"], view["library_note"]), (True, "Not in the library"))


if __name__ == "__main__":
    unittest.main()
