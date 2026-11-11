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

    def test_the_document_is_valid_and_no_longer_a_preview(self):
        # M6: both clients open the shared interface by default; Photo's own screens stay in
        # Developer Mode until it is validated
        self.assertEqual(self.document["contract"], "starcore.ui/1.2")
        self.assertNotIn("preview", self.document)
        definition = ui_contract.UiDefinition(self.document)
        self.assertNotIn("preview", definition.describe())

    def test_every_route_it_names_is_one_of_photos_own(self):
        from satellites.native.photo import api

        known = set(api.routes())
        for template in routes_in(self.document["pages"]):
            first = re.sub(r"\{[^}]*\}", "x", template).split("?")[0].split("/")[0]
            self.assertIn(first, known, template)

    def test_it_uses_the_shared_gallery_for_the_library_and_albums(self):
        pages = self.document["pages"]
        self.assertEqual([item["page"] for item in self.document["navigation"]], ["library", "albums", "search", "map"])
        for page in ("library", "album", "trash", "search"):
            kinds = [block["type"] for block in pages[page]["blocks"]]
            self.assertIn("media-grid", kinds, page)

    def test_search_and_map_use_the_shared_blocks(self):
        pages = self.document["pages"]
        search = {block["type"]: block for block in pages["search"]["blocks"]}
        self.assertEqual(search["search"]["key"], "q")
        self.assertIn("{$state.q}", pages["search"]["source"]["route"])
        self.assertEqual(search["choice"]["key"], "kind")
        located = next(block for block in pages["map"]["blocks"] if block["type"] == "map")
        self.assertEqual((located["item"]["lat"], located["item"]["lon"]), ("$.lat", "$.lon"))
        self.assertIn("viewer", located)

    def test_it_imports_a_server_folder_through_the_existing_routes(self):
        page = self.document["pages"]["import"]
        self.assertEqual(page["source"]["route"], "gallery/import")
        forms = [block for card in page["blocks"] if card["type"] == "card" for block in card["blocks"] if block["type"] == "form"]
        self.assertEqual([form["submit"]["action"]["route"] for form in forms], ["scan", "import"])
        for form in forms:
            self.assertEqual(form["submit"]["action"]["body"], {"source": "$form.source"})
            self.assertEqual(form["fields"][0]["value"], "$.directory")
        library = self.document["pages"]["library"]["blocks"]
        self.assertIn({"navigate": "import"}, [block.get("action") for block in library if block["type"] == "button"])

    def test_an_album_is_one_grid_in_its_own_order_not_grouped_by_month(self):
        # its photos come in the order they were added, so month headings would repeat
        grid = next(block for block in self.document["pages"]["album"]["blocks"] if block["type"] == "media-grid")
        self.assertNotIn("group", grid["item"])

    def test_the_recycle_bin_shows_the_days_each_item_has_left(self):
        grid = next(block for block in self.document["pages"]["trash"]["blocks"] if block["type"] == "media-grid")
        self.assertEqual(grid["item"]["subtitle"], "$.left")
        self.assertIn("$.left", [field["value"] for field in grid["viewer"]["fields"]])

    def test_only_the_library_and_albums_are_kept_offline(self):
        kept = sorted(name for name, page in self.document["pages"].items() if page.get("offline"))
        self.assertEqual(kept, ["album", "albums", "library"])  # never the bin, Search or Map

    def test_a_kept_page_never_keeps_a_location_or_a_path_on_the_server(self):
        # gallery items carry GPS coordinates (location) and the file's folder on the server;
        # neither may reach a phone's unencrypted offline copy
        for name in ("album", "albums", "library"):
            omit = self.document["pages"][name]["offline"]["omit"]
            self.assertTrue({"location", "folder"} <= set(omit), name)
        from satellites.native.photo import gallery
        item = gallery.item({"id": "p1", "metadata": {"gps_coordinates": "49.1, 6.2"}, "physical_path": "/srv/p"}, set())
        self.assertTrue({"location", "folder"} <= set(item))  # the fields the omissions name

    def test_it_never_reaches_the_locked_folder_itself(self):
        # no route or media of the document goes near it: it only opens Photo's own screens,
        # which ask for the PIN as they always did
        for template in routes_in(self.document["pages"]):
            self.assertNotIn("lock", template.lower(), template)

    def test_photos_move_into_the_locked_folder_only_through_the_secure_action(self):
        # wherever an active photo is shown, its viewer (and a selection, where there is one)
        # moves it through the client's own prompt - never a route, a form or a PIN field; the
        # recycle bin, whose items no longer resolve, offers none
        move = {"secure": {"capability": "media.vault", "operation": "move_in"}, "item": "$.id"}

        def moves(actions):
            return [entry for entry in actions or [] if "secure" in entry["action"]]

        found = {}
        for name, page in self.document["pages"].items():
            for block in page["blocks"]:
                if block["type"] in ("media-grid", "map"):
                    viewer = moves((block.get("viewer") or {}).get("actions"))
                    selection = moves((block.get("selection") or {}).get("actions"))
                    found[name] = (len(viewer), len(selection))
                    for entry in viewer + selection:
                        self.assertEqual({key: entry["action"][key] for key in move}, move)
                        self.assertEqual(set(entry["action"]) - {"secure", "item", "confirm", "then"}, set())
        self.assertEqual(found, {"library": (1, 1), "search": (1, 0), "map": (1, 0), "albums": (0, 0),
                                 "album": (1, 1), "trash": (0, 0)})

    def test_every_photo_viewer_downloads_and_shares_the_original(self):
        found = {}
        for name, page in self.document["pages"].items():
            for block in page["blocks"]:
                files = [entry["action"] for entry in (block.get("viewer") or {}).get("actions", [])
                         if "download" in entry["action"] or "share" in entry["action"]]
                if block.get("viewer"):
                    found[name] = files
        original = {"name": "$.title"}
        self.assertEqual(found["library"], [{"download": "originals/{$.id}", **original}, {"share": "originals/{$.id}", **original}])
        for name in ("search", "map", "album"):
            self.assertEqual(found[name], found["library"], name)
        self.assertEqual(found["trash"], [])  # a binned photo is only restored or erased

    def test_photo_grids_carry_the_favorite_heart_on_their_tiles(self):
        hearts = {}
        for name, page in self.document["pages"].items():
            for block in page["blocks"]:
                if block["type"] == "media-grid" and "quick" in block:
                    hearts[name] = [(entry["label"], entry["visible"], entry["action"]["route"]) for entry in block["quick"]]
        toggle = [("Favorite", "$.can_favorite", "albums/favorites/photos"),
                  ("Unfavorite", "$.favorite", "albums/favorites/photos/remove")]
        self.assertEqual(hearts, {"library": toggle, "search": toggle, "album": toggle})

    def test_settings_sync_and_the_locked_folder_open_photos_own_screens(self):
        blocks = self.document["pages"]["albums"]["blocks"]
        opened = {block["label"]: block["action"]["own"] for block in blocks
                  if block["type"] == "button" and "own" in block.get("action", {})}
        self.assertEqual(opened, {"Settings and phone sync": "settings"})
        # the Locked Folder is a tile among the albums: the one tile that opens Photo's own screens
        grid = next(block for block in blocks if block["type"] == "media-grid")
        self.assertEqual(grid["open"], [{"visible": "$.locked", "action": {"own": "locked"}},
                                        {"action": {"navigate": "album", "params": {"id": "$.id"}}}])
        self.assertEqual(grid["item"]["icon"], "$.icon")
        # Photo's own web page knows both sections, and the Locked Folder's link as well
        page = (PHOTO_DIR / "mission_control" / "page.js").read_text(encoding="utf-8")
        self.assertIn('section === "settings" ? "config"', page)
        self.assertIn('section === LOCKED_FOLDER || section === "locked"', page)


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

    def test_favorites_is_pinned_first_among_the_folders(self):
        mapping = [{"phone_path": "/DCIM/Camera", "server_path": "camera", "name": "Camera"}]
        status, _ = self.json_request("/api/satellites/photo/configuration", "POST", {"key": "source_paths", "value": mapping})
        self.assertEqual(status, 200)
        self.json_request("/api/satellites/photo/albums", "POST", {"name": "Holidays"})

        tiles = [(tile["title"], tile["group"]) for tile in self.json_request("/api/satellites/photo/gallery/albums")[1]["albums"]]
        # the client groups consecutive tiles, so Favorites heads the Folders group, before the
        # Locked Folder and the phone's folders
        self.assertEqual(tiles, [("Favorites", "Folders"), ("Locked Folder", "Folders"), ("Camera", "Folders"),
                                 ("Holidays", "Albums")])

    def test_the_locked_folder_is_a_folder_tile_while_a_vault_is_there(self):
        from starcore import capabilities
        tile = next(tile for tile in self.json_request("/api/satellites/photo/gallery/albums")[1]["albums"]
                    if tile["id"] == "locked")
        # a lock instead of a cover, and the flag the document opens the Locked Folder on;
        # nothing about what it holds (no count, no cover): it is never listed here
        self.assertEqual(tile, {"id": "locked", "title": "Locked Folder", "subtitle": "Behind your PIN",
                                "group": "Folders", "cover": "", "icon": "lock", "locked": True})

        vault, _ = capabilities.provider(self.engine, "media.vault")
        self.assertIsNotNone(vault)
        before = dict(vault.config.data)
        vault.config.data["enabled"] = False
        try:
            ids = [tile["id"] for tile in self.json_request("/api/satellites/photo/gallery/albums")[1]["albums"]]
        finally:
            vault.config.data.clear()
            vault.config.data.update(before)
        self.assertNotIn("locked", ids)

    def test_an_album_keeps_the_order_photos_were_added_in(self):
        photos = self.import_photos("a.png", "b.png", "c.png", "d.png")
        album = self.json_request("/api/satellites/photo/albums", "POST", {"name": "Ordered"})[1]
        order = [photos[name]["id"] for name in ("c.png", "a.png", "d.png", "b.png")]
        for photo_id in order:
            self.json_request(f"/api/satellites/photo/albums/{album['id']}/photos", "POST", {"photo_id": photo_id})

        own = [photo["id"] for photo in self.json_request(f"/api/satellites/photo/albums/{album['id']}")[1]["photos"]]
        shared = [item["id"] for item in self.json_request(f"/api/satellites/photo/gallery/albums/{album['id']}")[1]["items"]]
        self.assertEqual(own, order)  # Photo's own screens
        self.assertEqual(shared, order)
        first = self.json_request(f"/api/satellites/photo/gallery/albums/{album['id']}?limit=3")[1]
        rest = self.json_request(f"/api/satellites/photo/gallery/albums/{album['id']}?limit=3&cursor={first['next']}")[1]
        self.assertEqual([item["id"] for item in first["items"] + rest["items"]], order)
        self.assertIsNone(rest["next"])

    def test_the_bin_says_how_long_each_item_has_left(self):
        photos = self.import_photos("old.png")
        self.json_request(f"/api/satellites/photo/trash/{photos['old.png']['id']}", "POST")
        self.satellite.config.data["trash_retention_days"] = 7
        items = self.json_request("/api/satellites/photo/gallery/trash")[1]["items"]
        self.assertEqual([item["left"] for item in items], ["7 days left"])

    def test_import_and_scan_answer_with_a_message(self):
        (self.source / "one.png").write_bytes(png(4, 4, bytes([1, 2, 3])))
        status, scanned = self.json_request("/api/satellites/photo/scan", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)
        self.assertEqual((scanned["found"], scanned["new"]), (1, 1))  # the existing fields, unchanged
        self.assertEqual(scanned["message"], "Found 1 supported file: 1 new, 0 already in the library.")
        status, imported = self.json_request("/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual((status, imported["imported"]), (200, 1))
        self.assertEqual(imported["message"], "Imported 1 item, 0 already in the library.")
        again = self.json_request("/api/satellites/photo/import", "POST", {"source": str(self.source)})[1]
        self.assertEqual(again["message"], "Imported 0 items, 1 already in the library.")
        status, refused = self.json_request("/api/satellites/photo/import", "POST", {"source": str(self.directory / "nope")})
        self.assertEqual(status, 400)
        self.assertIn("error", refused)

    def test_the_import_page_offers_the_default_folder(self):
        status, view = self.json_request("/api/satellites/photo/gallery/import")
        self.assertEqual((status, view["directory"]), (200, ""))
        self.assertIn("JPEG", view["formats"])
        self.satellite.config.data["photo_directory"] = str(self.source)
        self.assertEqual(self.json_request("/api/satellites/photo/gallery/import")[1]["directory"], str(self.source))

    def test_unknown_gallery_paths_and_albums_are_refused(self):
        self.assertEqual(self.json_request("/api/satellites/photo/gallery/albums/deadbeef")[0], 404)
        self.assertEqual(self.json_request("/api/satellites/photo/gallery/nope")[0], 404)
        self.assertEqual(self.json_request("/api/satellites/photo/gallery", "POST", {})[0], 405)

    def test_the_listing_offers_photos_document_as_its_interface(self):
        status, listing = self.json_request("/api/satellites")
        self.assertEqual(status, 200)
        entries = listing["satellites"] if isinstance(listing, dict) else listing
        photo = next(entry for entry in entries if entry["name"] == "Photo")
        self.assertTrue(photo["ui"]["revision"])
        self.assertNotIn("preview", photo["ui"])
        # its own page and screens stay, for Developer Mode and older apps
        self.assertTrue(photo["page"])
        self.assertTrue(photo["mobile_ui"])


    # ---------- media.gallery: what the media picker chooses from ----------

    def test_photo_provides_media_gallery_through_the_catalog(self):
        status, catalog = self.json_request("/api/catalog")
        self.assertEqual(status, 200)
        providers = catalog["capabilities"]["media.gallery"]
        self.assertEqual([provider["satellite"] for provider in providers], ["Photo"])
        self.assertEqual(providers[0]["operations"], {"list": "media", "thumbnail": "thumbnails", "resolve": "media/resolve"})
        self.assertEqual(catalog["contract"]["capabilities"]["media.gallery"], [1])

    def test_the_locked_folder_offers_nothing_to_pick_list_or_read(self):
        # it provides media.vault only - a place to move media into - and nothing in it can
        # list or read what the vault holds
        status, catalog = self.json_request("/api/catalog")
        self.assertEqual(status, 200)
        for name, providers in catalog["capabilities"].items():
            if name != "media.vault":
                self.assertNotIn("LockedFolder", [provider["satellite"] for provider in providers], name)
        vault = catalog["capabilities"]["media.vault"]
        self.assertEqual([provider["satellite"] for provider in vault], ["LockedFolder"])
        self.assertEqual(set(vault[0]["operations"]), {"status", "unlock", "lock", "move_in", "biometric"})
        self.assertFalse({"media", "media/file", "move_out", "delete", "upload", "encryption"}
                         & set(vault[0]["operations"].values()))

    def test_the_media_list_offers_the_active_library_only(self):
        photos = self.import_photos("a.png", "b.png")
        trashed = photos["b.png"]["id"]
        self.json_request(f"/api/satellites/photo/trash/{trashed}", "POST")

        status, listing = self.json_request("/api/satellites/photo/media?kinds=image")

        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in listing["items"]], [photos["a.png"]["id"]])
        item = listing["items"][0]
        self.assertEqual(set(item), {"id", "kind", "title", "duration", "group"})  # never a path
        self.assertEqual(item["kind"], "image")
        self.assertEqual(self.json_request("/api/satellites/photo/media?kinds=video")[1]["items"], [])

    def test_picked_references_are_added_to_an_album(self):
        photos = self.import_photos("a.png", "b.png")
        album = self.json_request("/api/satellites/photo/albums", "POST", {"name": "Trip"})[1]
        items = [{"provider": "Photo", "capability": "media.gallery", "id": photos[name]["id"], "kind": "image"}
                 for name in ("a.png", "b.png")]

        status, payload = self.json_request(f"/api/satellites/photo/albums/{album['id']}/photos", "POST",
                                            {"items": items + items[:1]})

        self.assertEqual(status, 200)
        self.assertEqual(payload["photo_ids"], [photos["a.png"]["id"], photos["b.png"]["id"]])
        self.assertEqual(payload["message"], "Added 2 items.")
        # the single-photo form is unchanged
        status, _ = self.json_request(f"/api/satellites/photo/albums/{album['id']}/photos", "POST",
                                      {"photo_id": photos["a.png"]["id"]})
        self.assertEqual(status, 200)

    def test_references_from_elsewhere_or_to_hidden_photos_are_refused(self):
        photos = self.import_photos("a.png", "b.png")
        album = self.json_request("/api/satellites/photo/albums", "POST", {"name": "Trip"})[1]
        route = f"/api/satellites/photo/albums/{album['id']}/photos"
        photo_id = photos["a.png"]["id"]
        self.json_request(f"/api/satellites/photo/trash/{photos['b.png']['id']}", "POST")

        for items in ([{"provider": "Music", "capability": "media.gallery", "id": photo_id, "kind": "image"}],
                      [{"provider": "Photo", "capability": "files.browse", "id": photo_id, "kind": "image"}],
                      [{"provider": "Photo", "capability": "media.gallery", "id": photos["b.png"]["id"], "kind": "image"}],
                      [{"provider": "Photo", "capability": "media.gallery", "id": "../../etc/passwd", "kind": "image"}],
                      [], "a.png"):
            status, payload = self.json_request(route, "POST", {"items": items})
            self.assertEqual(status, 400, items)
        self.assertEqual(self.json_request(f"/api/satellites/photo/gallery/albums/{album['id']}")[1]["items"], [])

    def test_the_album_page_adds_photos_through_the_picker(self):
        document = ui_contract.load(PHOTO_DIR / "ui.json")
        blocks = document["pages"]["album"]["blocks"]
        add = next(block for block in blocks if block.get("label") == "Add photos")
        self.assertEqual(add["action"]["pick"]["capability"], "media.gallery")
        self.assertEqual(add["action"]["route"], "albums/{$params.id}/photos")
        self.assertEqual(add["action"]["body"], {"items": "$value"})


    # ---------- the shared Search and Map pages ----------

    def locate(self, photo_id, lat, lon, **metadata):
        """Gives a test photo GPS (and other) metadata, as an EXIF block would have."""
        from satellites.native.photo.library import library

        record = library(self.satellite).get(photo_id)
        record["metadata"].update({"gps_latitude": lat, "gps_longitude": lon, **metadata})

    def test_search_waits_for_text_and_matches_the_same_fields_as_the_app(self):
        photos = self.import_photos("beach.png", "city.png")
        self.locate(photos["city.png"]["id"], None, None, camera_make="Fixture", camera_model="Zoom 9", lens_model="Wide 24")

        empty = self.json_request("/api/satellites/photo/gallery/search?q=&kind=all")[1]
        self.assertEqual((empty["items"], empty["prompt"]), ([], "Type to search your library."))

        for query, expected in (("BEACH", "beach.png"), ("zoom 9", "city.png"), ("wide", "city.png")):
            found = self.json_request(f"/api/satellites/photo/gallery/search?q={query.replace(' ', '%20')}&kind=all")[1]
            self.assertEqual([item["title"] for item in found["items"]], [expected], query)
            self.assertEqual(found["summary"], "1 result")

        none = self.json_request("/api/satellites/photo/gallery/search?q=nothing-like-this&kind=all")[1]
        self.assertEqual((none["items"], none["summary"]), ([], "No photos match your search."))

    def test_search_filters_by_kind_and_finds_albums(self):
        self.import_photos("trip-1.png")
        self.json_request("/api/satellites/photo/albums", "POST", {"name": "Summer trip"})

        found = self.json_request("/api/satellites/photo/gallery/search?q=trip&kind=video")[1]
        self.assertEqual(found["items"], [])  # no videos
        self.assertEqual([album["title"] for album in found["albums"]], ["Summer trip"])
        self.assertIsNone(found["summary"])  # the albums answer it
        self.assertEqual(len(self.json_request("/api/satellites/photo/gallery/search?q=trip&kind=image")[1]["items"]), 1)

    def test_search_never_finds_the_recycle_bin(self):
        photos = self.import_photos("gone.png")
        self.json_request(f"/api/satellites/photo/trash/{photos['gone.png']['id']}", "POST")
        self.assertEqual(self.json_request("/api/satellites/photo/gallery/search?q=gone&kind=all")[1]["items"], [])

    def test_the_map_lists_located_photos_only(self):
        photos = self.import_photos("paris.png", "nowhere.png", "broken.png", "gone.png")
        self.locate(photos["paris.png"]["id"], 48.8584, 2.2945)
        self.locate(photos["broken.png"]["id"], 123.0, 2.0)  # out of range: never placed
        self.locate(photos["gone.png"]["id"], 51.5, -0.12)
        self.json_request(f"/api/satellites/photo/trash/{photos['gone.png']['id']}", "POST")

        located = self.json_request("/api/satellites/photo/gallery/map")[1]

        self.assertEqual([(item["title"], item["lat"], item["lon"]) for item in located["items"]],
                         [("paris.png", 48.8584, 2.2945)])
        self.assertEqual(located["summary"], "1 item with a location")

    def test_an_empty_map_says_nothing_is_located(self):
        self.import_photos("plain.png")
        located = self.json_request("/api/satellites/photo/gallery/map")[1]
        self.assertEqual((located["items"], located["summary"]), ([], None))


if __name__ == "__main__":
    unittest.main()
