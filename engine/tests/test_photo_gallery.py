"""Photo's shared interface (UI contract 1.2): its ui.json, and the read-only gallery routes
it binds to. Every action in the document goes to one of Photo's existing routes."""

from http.client import HTTPConnection
from pathlib import Path
import json
import re
import shutil
import tempfile
import unittest

from starcore import ui_contract
from tests.support import start_engine, stop_engine
from tests.test_photo import png

REPO = Path(__file__).resolve().parents[2]
PHOTO_DIR = REPO / "satellites" / "native" / "photo"


def routes_in(value, found=None):
    """Every route template a document names: sources, actions and media routes."""
    found = set() if found is None else found
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("route", "image", "video", "src") and isinstance(item, str):
                found.add(item)
            else:
                routes_in(item, found)
    elif isinstance(value, list):
        for item in value:
            routes_in(item, found)
    return found


class PhotoUiDocumentTest(unittest.TestCase):
    def setUp(self):
        self.document = ui_contract.load(PHOTO_DIR / "ui.json")

    def test_the_document_is_a_valid_preview(self):
        # a preview: both clients keep Photo's own screens first until parity
        self.assertEqual(self.document["contract"], "starcore.ui/1.2")
        self.assertIs(self.document["preview"], True)
        definition = ui_contract.UiDefinition(self.document)
        self.assertEqual(definition.describe()["preview"], True)

    def test_every_route_it_names_is_one_of_photos_own(self):
        from satellites.native.photo import api

        known = set(api.routes())
        for template in routes_in(self.document["pages"]):
            first = re.sub(r"\{[^}]*\}", "x", template).split("?")[0].split("/")[0]
            self.assertIn(first, known, template)

    def test_it_uses_the_shared_gallery_for_the_library_and_albums(self):
        pages = self.document["pages"]
        self.assertEqual([item["page"] for item in self.document["navigation"]], ["library", "albums"])
        for page in ("library", "album", "trash"):
            kinds = [block["type"] for block in pages[page]["blocks"]]
            self.assertIn("media-grid", kinds, page)

    def test_it_never_names_the_locked_folder(self):
        text = (PHOTO_DIR / "ui.json").read_text(encoding="utf-8")
        self.assertNotIn("locked", text.lower().replace("locked folder", ""))


class PhotoGalleryApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")
        cls.satellite = cls.engine.registry.get("Photo")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-gallery-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")
        self.satellite.config.data["photo_directory"] = ""
        self.satellite.config.data["trash_retention_days"] = 30
        self.satellite.config.data["source_paths"] = []
        self.satellite.config.path = self.directory / "config.toml"

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

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

    def import_photos(self, *names):
        for index, name in enumerate(names):
            (self.source / name).write_bytes(png(8, 6, bytes([40 + index * 30, 60, 160])))
        status, payload = self.json_request("/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)
        return {entry["filename"]: entry for entry in payload["photos"]}

    def test_the_library_view_shapes_each_photo_for_the_grid(self):
        photos = self.import_photos("a.png", "b.png")

        status, view = self.json_request("/api/satellites/photo/gallery")

        self.assertEqual(status, 200)
        self.assertEqual({item["id"] for item in view["items"]}, {photo["id"] for photo in photos.values()})
        item = view["items"][0]
        self.assertEqual(item["kind"], "image")
        self.assertEqual(item["dimensions"], "8 × 6")
        self.assertEqual(item["format"], "PNG")
        self.assertIsInstance(item["taken"], int)
        self.assertRegex(item["month"], r"^[A-Z][a-z]+ \d{4}$")
        self.assertEqual((item["favorite"], item["can_favorite"]), (False, True))
        self.assertTrue(view["summary"].startswith("2 items"))

    def test_favourites_and_the_recycle_bin_follow_the_existing_routes(self):
        photos = self.import_photos("a.png", "b.png")
        first, second = photos["a.png"]["id"], photos["b.png"]["id"]

        # the actions the document runs: the albums and trash routes, unchanged
        self.assertEqual(self.json_request("/api/satellites/photo/albums/favorites/photos", "POST", {"photo_id": first})[0], 200)
        self.assertEqual(self.json_request(f"/api/satellites/photo/trash/{second}", "POST")[0], 200)

        items = {item["id"]: item for item in self.json_request("/api/satellites/photo/gallery")[1]["items"]}
        self.assertEqual(list(items), [first])
        self.assertTrue(items[first]["favorite"])
        self.assertFalse(items[first]["can_favorite"])
        trash = self.json_request("/api/satellites/photo/gallery/trash")[1]
        self.assertEqual([item["id"] for item in trash["items"]], [second])
        self.assertIn("30 days", trash["note"])

    def test_albums_are_tiles_with_their_cover_and_open_as_a_grid(self):
        photos = self.import_photos("a.png")
        photo = photos["a.png"]["id"]
        status, album = self.json_request("/api/satellites/photo/albums", "POST", {"name": "Holidays"})
        self.assertEqual(status, 200)
        self.json_request(f"/api/satellites/photo/albums/{album['id']}/photos", "POST", {"photo_id": photo})

        tiles = {tile["title"]: tile for tile in self.json_request("/api/satellites/photo/gallery/albums")[1]["albums"]}
        self.assertEqual(tiles["Holidays"]["cover"], photo)
        self.assertEqual(tiles["Holidays"]["subtitle"], "1 item")
        self.assertEqual(tiles["Holidays"]["group"], "Albums")
        self.assertEqual(tiles["Favorites"]["cover"], "")  # an empty album: the client shows the placeholder

        status, detail = self.json_request(f"/api/satellites/photo/gallery/albums/{album['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(detail["name"], "Holidays")
        self.assertTrue(detail["editable"])
        self.assertEqual([(item["id"], item["removable"]) for item in detail["items"]], [(photo, True)])

        favorites = self.json_request("/api/satellites/photo/gallery/albums/favorites")[1]
        self.assertFalse(favorites["editable"])

    def test_unknown_gallery_paths_and_albums_are_refused(self):
        self.assertEqual(self.json_request("/api/satellites/photo/gallery/albums/deadbeef")[0], 404)
        self.assertEqual(self.json_request("/api/satellites/photo/gallery/nope")[0], 404)
        self.assertEqual(self.json_request("/api/satellites/photo/gallery", "POST", {})[0], 405)

    def test_the_listing_marks_photos_document_as_a_preview(self):
        status, listing = self.json_request("/api/satellites")
        self.assertEqual(status, 200)
        entries = listing["satellites"] if isinstance(listing, dict) else listing
        photo = next(entry for entry in entries if entry["name"] == "Photo")
        self.assertTrue(photo["ui"]["revision"])
        self.assertIs(photo["ui"]["preview"], True)


if __name__ == "__main__":
    unittest.main()
