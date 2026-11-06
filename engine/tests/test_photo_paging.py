"""Photo's paged lists and viewport map (UI contract 1.2's media-grid `more` and map
`viewport`): keyset paging that never repeats or loses a photo, and map answers that stay
bounded for any library. The paging itself is checked on large synthetic sets; the routes on a
small real library."""

from http.client import HTTPConnection
from pathlib import Path
import json
import random
import shutil
import tempfile
import unittest

from tests.support import start_engine, stop_engine
from tests.test_photo import png


def photos(count, seed=1, ties=True):
    """Synthetic library records, many sharing a capture time (ties are where paging breaks)."""
    rng = random.Random(seed)
    out = []
    for index in range(count):
        day = rng.randrange(1, 28) if ties else index
        out.append({"id": f"{index:016x}", "captured_at": f"2026-10-{day % 28 + 1:02d}T10:00:00" if ties else
                    f"2026-01-01T00:00:{index:06d}", "imported_at": "2026-11-01T00:00:00+00:00"})
    return out


class KeysetPagingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()  # loads the satellite package so it can be imported

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        from satellites.native.photo import gallery

        self.gallery = gallery

    def walk(self, records, limit):
        seen, cursor, pages = [], None, 0
        while True:
            chosen, cursor = self.gallery.page(records, limit, cursor and self.gallery.paging({"limit": str(limit), "cursor": cursor})[1])
            seen.extend(photo["id"] for photo in chosen)
            pages += 1
            if cursor is None:
                return seen, pages

    def test_every_photo_once_in_a_fixed_order_with_ties(self):
        for count, limit in ((300, 1), (1000, 7), (20000, 120), (20000, 500)):
            records = photos(count)
            seen, pages = self.walk(records, limit)
            expected = [photo["id"] for photo in self.gallery.page(records, None, None)[0]]
            self.assertEqual(seen, expected, (count, limit))
            self.assertEqual(len(seen), len(set(seen)))

    def test_photos_added_or_removed_between_pages_never_duplicate_or_skip_the_others(self):
        records = photos(1000, seed=2)
        first, cursor = self.gallery.page(records, 100, None)
        key = self.gallery.paging({"limit": "100", "cursor": cursor})[1]
        # between two pages: one photo shown already is removed, one not yet shown is removed,
        # and one newer and one older are added
        shown = {photo["id"] for photo in first}
        later = [photo for photo in self.gallery.page(records, None, None)[0] if photo["id"] not in shown]
        changed = [photo for photo in records if photo["id"] not in (first[0]["id"], later[5]["id"])]
        changed.append({"id": "ffffffffffffff01", "captured_at": "2027-01-01T00:00:00"})
        changed.append({"id": "0000000000000001", "captured_at": "2000-01-01T00:00:00"})
        rest = []
        while True:
            chosen, cursor = self.gallery.page(changed, 100, key)
            rest.extend(photo["id"] for photo in chosen)
            if cursor is None:
                break
            key = self.gallery.paging({"limit": "100", "cursor": cursor})[1]
        expected_rest = [photo["id"] for photo in later if photo["id"] != later[5]["id"]] + ["0000000000000001"]
        self.assertEqual(rest, expected_rest)
        self.assertFalse(shown & set(rest))

    def test_an_album_pages_in_its_own_order(self):
        records = photos(50, seed=4)  # in the order they were added, not by date
        seen, cursor = [], None
        while True:
            chosen, cursor = self.gallery.page_in_order(records, 7, cursor and self.gallery.paging({"limit": "7", "cursor": cursor})[1])
            seen.extend(photo["id"] for photo in chosen)
            if cursor is None:
                break
        self.assertEqual(seen, [photo["id"] for photo in records])
        self.assertEqual(self.gallery.page_in_order(records, None, None), (records, None))

    def test_an_album_page_survives_its_last_photo_leaving(self):
        records = photos(20, seed=5)
        first, cursor = self.gallery.page_in_order(records, 5, None)
        key = self.gallery.paging({"limit": "5", "cursor": cursor})[1]
        # the last photo shown is taken out of the album before the next page
        changed = [photo for photo in records if photo["id"] != first[-1]["id"]]
        following, _ = self.gallery.page_in_order(changed, 5, key)
        self.assertEqual([photo["id"] for photo in following], [photo["id"] for photo in records[5:10]])
        # an untouched list continues straight after it
        self.assertEqual(self.gallery.page_in_order(records, 5, key)[0], records[5:10])
        with self.assertRaises(self.gallery.PagingError):
            self.gallery.page_in_order(records, 5, ("x", "y"))

    def test_days_left_in_the_bin_read_like_photos_own_screens(self):
        from datetime import datetime, timezone

        now = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(self.gallery.days_left("2026-11-06T11:00:00+00:00", 30, now), "30 days left")
        self.assertEqual(self.gallery.days_left("2026-10-08T12:00:00+00:00", 30, now), "1 day left")
        self.assertEqual(self.gallery.days_left("2026-10-01T00:00:00+00:00", 30, now), "Erasing soon")
        self.assertEqual(self.gallery.days_left("2026-11-05T12:00:00", 7, now), "6 days left")  # no zone: UTC
        self.assertIsNone(self.gallery.days_left(None, 30, now))
        self.assertIsNone(self.gallery.days_left("not a date", 30, now))

    def test_bad_limits_and_cursors_are_refused(self):
        for query in ({"limit": "0"}, {"limit": "501"}, {"limit": "ten"}, {"cursor": "abc"},
                      {"limit": "10", "cursor": "not-a-cursor!"}, {"limit": "10", "cursor": "WzFd"}):
            with self.assertRaises(self.gallery.PagingError, msg=query):
                self.gallery.paging(query)
        self.assertEqual(self.gallery.paging({}), (None, None))

    def test_paging_twenty_thousand_photos_is_quick(self):
        import time

        records = photos(20000, seed=3)
        started = time.perf_counter()
        chosen, cursor = self.gallery.page(records, 120, None)
        for _ in range(10):
            chosen, cursor = self.gallery.page(records, 120, self.gallery.paging({"limit": "120", "cursor": cursor})[1])
        per_page = (time.perf_counter() - started) / 11
        self.assertLess(per_page, 0.5)  # measured locally at a few tens of milliseconds


class PagedRoutesTest(unittest.TestCase):
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
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-photo-paging-"))
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
        try:
            connection.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def import_photos(self, count):
        for index in range(count):
            (self.source / f"p{index:02d}.png").write_bytes(png(4 + index, 3, bytes([index * 9 % 256, 60, 160])))
        status, payload = self.json_request("/api/satellites/photo/import", "POST", {"source": str(self.source)})
        self.assertEqual(status, 200)
        return [photo["id"] for photo in payload["photos"]]

    def walk(self, path):
        seen, cursor = [], None
        while True:
            separator = "&" if "?" in path else "?"
            status, page = self.json_request(f"{path}{separator}limit=4" + (f"&cursor={cursor}" if cursor else ""))
            self.assertEqual(status, 200, page)
            seen.extend(item["id"] for item in page["items"])
            cursor = page["next"]
            if cursor is None:
                return seen, page

    def test_every_list_pages_to_the_same_items_it_answers_at_once(self):
        ids = self.import_photos(10)
        album = self.json_request("/api/satellites/photo/albums", "POST", {"name": "All"})[1]
        self.json_request(f"/api/satellites/photo/albums/{album['id']}/photos", "POST",
                          {"items": [{"provider": "Photo", "capability": "media.gallery", "id": photo_id, "kind": "image"}
                                     for photo_id in ids]})
        for path in ("/api/satellites/photo/gallery", "/api/satellites/photo/gallery/search?q=p&kind=all",
                     f"/api/satellites/photo/gallery/albums/{album['id']}", "/api/satellites/photo/media?kinds=image"):
            everything = [item["id"] for item in self.json_request(path)[1]["items"]]
            seen, last = self.walk(path)
            self.assertEqual(seen, everything, path)
            self.assertEqual(len(set(seen)), 10, path)

    def test_the_recycle_bin_pages_too(self):
        ids = self.import_photos(6)
        for photo_id in ids:
            self.json_request(f"/api/satellites/photo/trash/{photo_id}", "POST")
        seen, last = self.walk("/api/satellites/photo/gallery/trash")
        self.assertEqual(sorted(seen), sorted(ids))
        self.assertTrue(last["summary"].startswith("6 items"))

    def test_older_clients_still_get_everything(self):
        self.import_photos(5)
        status, view = self.json_request("/api/satellites/photo/gallery")
        self.assertEqual((status, len(view["items"]), view["next"]), (200, 5, None))
        self.assertEqual(len(self.json_request("/api/satellites/photo/media?kinds=image")[1]["items"]), 5)

    def test_bad_paging_is_a_400(self):
        self.import_photos(1)
        for query in ("limit=0", "limit=9999", "cursor=x", "limit=5&cursor=%%%"):
            self.assertEqual(self.json_request(f"/api/satellites/photo/gallery?{query}")[0], 400, query)
            self.assertEqual(self.json_request(f"/api/satellites/photo/media?{query}")[0], 400, query)

    # ---------- the map ----------

    def locate(self, ids, spots):
        from satellites.native.photo.library import library

        for photo_id, (lat, lon) in zip(ids, spots):
            library(self.satellite).get(photo_id)["metadata"].update({"gps_latitude": lat, "gps_longitude": lon})

    def test_the_overview_fits_without_sending_photos(self):
        ids = self.import_photos(4)
        self.locate(ids, [(48.85, 2.35), (45.76, 4.83), (51.5, -0.12)])
        status, overview = self.json_request("/api/satellites/photo/gallery/map?overview=1")
        self.assertEqual(status, 200)
        self.assertEqual(overview["items"], [])
        self.assertEqual(overview["bounds"], [45.76, -0.12, 51.5, 4.83])
        self.assertEqual(overview["count"], 3)

    def test_a_viewport_gets_what_is_inside_it(self):
        ids = self.import_photos(3)
        self.locate(ids, [(48.85, 2.35), (45.76, 4.83), (-33.9, 18.4)])
        status, area = self.json_request("/api/satellites/photo/gallery/map?bbox=40,-5,50,10&zoom=5")
        self.assertEqual(status, 200)
        self.assertEqual(sorted(item["id"] for item in area["items"]), sorted(ids[:2]))
        self.assertTrue(all(item["count"] == 1 and item["cover"] == item["id"] for item in area["items"]))

    def test_a_crowded_viewport_comes_back_as_bounded_clusters(self):
        from satellites.native.photo import gallery
        from satellites.native.photo.library import library

        # 2,000 synthetic located photos, added straight into the index
        lib = library(self.satellite)
        rng = random.Random(4)
        for index in range(2000):
            photo_id = f"{index:016x}"
            lib._photos[photo_id] = {
                "id": photo_id, "filename": f"{index}.jpg", "path": "x", "size": 1, "width": 1, "height": 1,
                "format": "jpeg", "media_type": "photo", "duration": None, "imported_at": "2026-11-01T00:00:00+00:00",
                "captured_at": None, "trashed_at": None, "physical_path": None,
                "metadata": {"gps_latitude": 48 + rng.random(), "gps_longitude": 2 + rng.random()},
            }
        status, area = self.json_request("/api/satellites/photo/gallery/map?bbox=47,1,50,4&zoom=6")
        self.assertEqual(status, 200)
        self.assertEqual(area["visible"], 2000)
        self.assertLessEqual(len(area["items"]), gallery.VIEWPORT_ITEMS)
        self.assertEqual(sum(item["count"] for item in area["items"]), 2000)  # nothing on screen is left out
        group = next(item for item in area["items"] if item["count"] > 1)
        south, west, north, east = group["bounds"]
        self.assertTrue(south <= group["lat"] <= north and west <= group["lon"] <= east)
        # zoomed far in, a small area comes photo by photo
        status, close = self.json_request("/api/satellites/photo/gallery/map?bbox=48.4,2.4,48.45,2.45&zoom=15")
        self.assertTrue(close["items"] and all(item["count"] == 1 for item in close["items"]))

    def test_a_viewport_across_the_antimeridian(self):
        ids = self.import_photos(2)
        self.locate(ids, [(-17.7, 178.4), (-14.3, -170.7)])
        area = self.json_request("/api/satellites/photo/gallery/map?bbox=-30,170,0,-160&zoom=4")[1]
        self.assertEqual(len(area["items"]), 2)

    def test_bad_viewports_are_a_400(self):
        for query in ("bbox=1,2,3&zoom=4", "bbox=a,b,c,d&zoom=1", "bbox=10,0,5,1&zoom=3", "bbox=0,0,1,1&zoom=99"):
            self.assertEqual(self.json_request(f"/api/satellites/photo/gallery/map?{query}")[0], 400, query)


if __name__ == "__main__":
    unittest.main()
