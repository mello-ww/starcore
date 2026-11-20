"""Music over HTTP: authentication, listener isolation, streaming, playlists, history, Connect."""

from http.client import HTTPConnection
from importlib import import_module
from pathlib import Path
import json
import shutil
import tempfile
import threading
import time
import unittest

from tests import music_fixtures as media
from tests.support import start_engine, stop_engine

BASE = "/api/satellites/music"
COVER = b"\x89PNG\r\n\x1a\n" + b"art" * 10


def module(name):
    return import_module(f"satellites.native.music.{name}")


class MusicApiCase(unittest.TestCase):
    bootstrap = True

    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")
        cls.satellite = cls.engine.registry.get("Music")
        if cls.bootstrap:
            cls.alice = cls.engine.auth.bootstrap("alice", "correct horse battery")
            cls.bob = cls.engine.auth.create_session("bob")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-music-http-"))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.satellite.config.data["storage"] = str(self.directory / "library")
        self.satellite.config.data["library"] = str(self.source)
        self.satellite.config.data["sources"] = []
        self.satellite.config.data["ffmpeg"] = str(self.directory / "no-ffmpeg-here")

    def tearDown(self):
        module("library").library(self.satellite).close()
        shutil.rmtree(self.directory, ignore_errors=True)

    def request(self, path, method="GET", payload=None, token=None, headers=None, raw=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
        request_headers = dict(headers or {})
        body = raw
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        token = self.alice if token is None and self.bootstrap else token
        if token:
            request_headers["Authorization"] = f"Bearer {token}"
        try:
            connection.request(method, f"{BASE}/{path}" if not path.startswith("/") else path, body=body,
                               headers=request_headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def call(self, path, payload=None, token=None, method=None):
        status, _, body = self.request(path, method or ("POST" if payload is not None else "GET"), payload, token)
        return status, json.loads(body.decode("utf-8")) if body else None

    def fill(self):
        (self.source / "Lumen").mkdir()
        (self.source / "Lumen" / "one.flac").write_bytes(media.flac(
            {"TITLE": "One", "ARTIST": "Lumen", "ALBUM": "First", "GENRE": "Ambient", "TRACKNUMBER": "1"}, cover=COVER))
        (self.source / "Lumen" / "two.flac").write_bytes(media.flac(
            {"TITLE": "Two", "ARTIST": "Lumen", "ALBUM": "First", "GENRE": "Ambient", "TRACKNUMBER": "2"}, seconds=120))
        (self.source / "three.opus").write_bytes(media.opus({"TITLE": "Three", "ARTIST": "Tidal", "GENRE": "Ambient"}))
        (self.source / "Lumen" / "one.lrc").write_text(
            "[offset:+0]\n[00:01.00]Hello\n[00:01.00]Bonjour\n[00:03.50]<00:03.50>World <00:04.00>again\n",
            encoding="utf-8")
        status, report = self.call("scan", {})
        self.assertEqual(status, 200, report)
        tracks = self.call("tracks?sort=title")[1]["tracks"]
        return {track["title"]: track for track in tracks}


class AuthenticationTest(MusicApiCase):
    def test_every_music_route_requires_a_session(self):
        for path in ("library", "tracks", "home", "playlists", "favorites", "stream/0123456789abcdef",
                     "connect/devices", "artwork/0123456789abcdef"):
            status, _, _ = self.request(path, token="")
            self.assertEqual(status, 401, path)
        status, _, _ = self.request("scan", "POST", {}, token="not-a-token")
        self.assertEqual(status, 401)

    def test_a_revoked_session_loses_access(self):
        token = self.engine.auth.create_session("alice")
        self.assertEqual(self.call("library", token=token)[0], 200)
        self.engine.auth.logout(token)
        self.assertEqual(self.call("library", token=token)[0], 401)


class IsolationTest(MusicApiCase):
    def test_playlists_likes_history_and_devices_belong_to_one_listener(self):
        tracks = self.fill()
        one = tracks["One"]["id"]
        status, playlist = self.call("playlists", {"name": "Mine", "tracks": [one]})
        self.assertEqual(status, 201)
        self.call("favorites", {"kind": "track", "ids": [one], "liked": True})
        self.call("history", {"track_id": one, "seconds": 400, "device": "web"})
        self.call("connect/register", {"device_id": "alice-browser", "name": "Alice", "kind": "web"})

        self.assertEqual(self.call(f"playlists/{playlist['id']}", token=self.bob)[0], 404)
        self.assertEqual(self.call(f"playlists/{playlist['id']}/delete", {}, token=self.bob)[0], 404)
        self.assertEqual(self.call(f"playlists/{playlist['id']}/add", {"tracks": [one]}, token=self.bob)[0], 404)
        self.assertEqual(self.call("playlists", token=self.bob)[1]["playlists"], [])
        self.assertEqual(self.call("favorites", token=self.bob)[1]["tracks"], [])
        self.assertEqual(self.call("history", token=self.bob)[1]["tracks"], [])
        self.assertEqual(self.call("connect/devices", token=self.bob)[1]["devices"], [])
        status, payload = self.call("connect/command", {"target": "alice-browser", "command": "pause"}, token=self.bob)
        self.assertEqual(status, 400)
        self.assertIn("unknown device", payload["error"])
        status, _ = self.call("connect/events?device=alice-browser&timeout=0", token=self.bob)
        self.assertEqual(status, 400)

        self.assertEqual(self.call(f"playlists/{playlist['id']}")[1]["name"], "Mine")
        self.assertEqual(len(self.call("favorites")[1]["tracks"]), 1)


class StreamingTest(MusicApiCase):
    def test_ranges_seek_and_content_types_are_right(self):
        tracks = self.fill()
        one, three = tracks["One"], tracks["Three"]

        status, headers, body = self.request(f"stream/{one['id']}", headers={"Range": "bytes=4-13"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], f"bytes 4-13/{one['size']}")
        self.assertEqual(len(body), 10)
        status, headers, _ = self.request(f"stream/{one['id']}", headers={"Range": f"bytes={one['size']}-"})
        self.assertEqual(status, 416)
        status, headers, _ = self.request(f"stream/{three['id']}")
        self.assertEqual(headers["Content-Type"], "audio/ogg; codecs=opus")

    def test_a_transcode_request_without_ffmpeg_says_it_sends_the_original(self):
        tracks = self.fill()
        status, plan = self.call(f"playback/{tracks['One']['id']}?quality=low")

        self.assertEqual(status, 200)
        self.assertEqual(plan["plan"]["delivery"], "original")
        self.assertIn("FFmpeg", plan["plan"]["reason"])
        self.assertTrue(plan["plan"]["lossless"])
        status, headers, body = self.request(f"stream/{tracks['One']['id']}?quality=low")
        self.assertEqual((status, headers["Content-Type"]), (200, "audio/flac"))

    def test_a_failing_transcoder_is_reported_not_hidden(self):
        tracks = self.fill()
        transcoder = module("library").library(self.satellite).transcoder
        original = type(transcoder).available
        type(transcoder).available = property(lambda self: True)
        try:
            transcoder._run = lambda source, target, plan: (_ for _ in ()).throw(
                module("transcode").TranscodeError("FFmpeg failed: broken"))
            status, plan = self.call(f"playback/{tracks['One']['id']}?quality=normal&format=opus")
            self.assertEqual(plan["plan"]["delivery"], "transcode")
            status, payload = self.call(f"stream/{tracks['One']['id']}?quality=normal&format=opus")
            self.assertEqual(status, 503)
            self.assertIn("FFmpeg failed", payload["error"])
        finally:
            type(transcoder).available = original
            del transcoder._run

    def test_ffmpeg_is_run_without_a_shell_on_a_known_file_only(self):
        transcode = module("transcode")
        captured = {}

        def fake_run(arguments, **options):
            captured["arguments"], captured["options"] = arguments, options
            Path(arguments[-1][len("file:"):]).write_bytes(b"OggS")
            return type("Done", (), {"returncode": 0, "stderr": b""})()

        source = self.source / "x.flac"
        source.write_bytes(media.flac())
        transcoder = transcode.Transcoder(self.directory / "cache", binary=str(source))
        original = transcode.subprocess.run
        transcode.subprocess.run = fake_run
        try:
            row = {"id": "0123456789abcdef", "content_hash": "fedcba9876543210", "path": str(source)}
            plan = {"codec": "opus", "bitrate": 128000, "profile": "opus-normal"}
            target = transcoder.transcode(row, plan)
        finally:
            transcode.subprocess.run = original
        self.assertTrue(target.is_file())
        self.assertFalse(captured["options"].get("shell"))
        self.assertIn(f"file:{source}", captured["arguments"])
        self.assertEqual(captured["arguments"][captured["arguments"].index("-protocol_whitelist") + 1], "file")

    def test_unknown_or_hostile_identifiers_never_reach_the_disk(self):
        self.fill()
        for path in ("stream/..%2f..%2fconfig.toml", "stream/../../api.py", "artwork/../../x", "lyrics/notanid",
                     "folders/0/../..", "folders/9", "covers/../x", "tracks/zzzz"):
            status, _, _ = self.request(path)
            self.assertIn(status, (400, 404), path)

    def test_artwork_and_lyrics_are_served(self):
        tracks = self.fill()
        status, headers, body = self.request(f"artwork/{tracks['One']['album_id']}")
        self.assertEqual((status, body), (200, COVER))

        status, lyrics = self.call(f"lyrics/{tracks['One']['id']}")
        self.assertEqual(status, 200)
        self.assertTrue(lyrics["synced"])
        self.assertEqual(lyrics["lines"][0]["text"], "Hello")
        self.assertEqual(lyrics["lines"][0]["translation"], "Bonjour")
        self.assertEqual([word["text"].strip() for word in lyrics["lines"][1]["words"]], ["World", "again"])
        self.call(f"lyrics/{tracks['One']['id']}", {"offset": 250})
        self.assertEqual(self.call(f"lyrics/{tracks['One']['id']}")[1]["offset"], 250)
        self.assertEqual(self.call(f"lyrics/{tracks['Two']['id']}")[0], 404)


class SharedPagesTest(MusicApiCase):
    """What Music's shared pages (ui.json) bind to: a genre's page, what each answer says it
    plays from, and the cover mosaic."""

    def test_a_genre_page_and_the_context_each_answer_plays_from(self):
        tracks = self.fill()
        album_id = tracks["One"]["album_id"]
        album = self.call(f"albums/{album_id}")[1]
        self.assertEqual(album["context"], f"album:{album_id}")
        artist = self.call(f"artists/{tracks['One']['artist_id']}")[1]
        self.assertEqual(artist["context"], f"artist:{tracks['One']['artist_id']}")

        genre = self.call("genres?name=ambient")[1]
        self.assertEqual(genre["context"], "genre:ambient")
        self.assertEqual({track["title"] for track in genre["tracks"]}, {"One", "Two", "Three"})
        self.assertEqual(genre["mosaic"], [album_id])
        self.assertEqual(genre["mosaic_key"], album_id)
        self.assertEqual(self.call("genres?name=Polka")[0], 404)
        listed = self.call("genres")[1]["genres"]
        self.assertEqual([entry["context"] for entry in listed], ["genre:ambient"])

        station = self.call(f"radio/album/{album_id}")[1]
        self.assertEqual(station["context"], f"radio:album-{album_id}")
        self.call("history", {"track_id": tracks["One"]["id"], "seconds": 200})
        mixes = self.call("mixes")[1]["mixes"]
        self.assertTrue(mixes)
        self.assertTrue(all(mix["mosaic_key"] == ".".join(mix["mosaic"]) for mix in mixes))
        mix = self.call(f"mixes/{mixes[0]['id']}")[1]
        self.assertEqual(mix["context"], f"mix:{mixes[0]['id']}")

    def test_your_library_answers_only_the_selected_tab_filtered_on_the_server(self):
        tracks = self.fill()
        one, three = tracks["One"], tracks["Three"]
        self.call("favorites", {"kind": "track", "ids": [one["id"], three["id"]], "liked": True})

        liked = self.call("library?tab=liked")[1]
        self.assertEqual(liked["tab"], "liked")
        self.assertTrue(liked["showing"]["liked"])
        self.assertFalse(liked["showing"]["albums"])
        self.assertNotIn("albums", liked)
        self.assertEqual(liked["count"], 2)
        self.assertEqual(liked["context"], "liked:all")
        self.assertEqual(liked["summary"], "2 songs")
        rows = {row["title"]: row for row in liked["tracks"]}
        self.assertEqual(set(rows), {"One", "Three"})
        self.assertTrue(rows["One"]["liked"])
        self.assertFalse(rows["One"]["not_liked"])
        # the audio host plays these rows, and its player shows their quality
        self.assertIn("lossless", rows["One"]["quality"])
        self.assertEqual(rows["One"]["badge"], "Lossless")
        self.assertEqual(rows["One"]["line"], "Lossless · Lumen")
        self.assertEqual(rows["Three"]["badge"], "")
        self.assertEqual(rows["Three"]["line"], "Tidal")
        self.assertEqual(sorted(row["position"] for row in liked["tracks"]), [0, 1])
        self.assertNotIn("replaygain", rows["One"])
        by_title = self.call("library?tab=liked&sort=title")[1]["tracks"]
        self.assertEqual([row["title"] for row in by_title], ["One", "Three"])
        self.assertEqual([row["title"] for row in self.call("library?tab=liked&q=tid")[1]["tracks"]], ["Three"])

        albums = self.call("library?tab=albums&sort=name")[1]
        self.assertEqual(albums["count"], 2)
        self.assertNotIn("tracks", albums)
        first = next(album for album in albums["albums"] if album["album"] == "First")
        self.assertTrue(first["not_liked"])
        self.assertTrue(first["not_pinned"])
        self.assertEqual(self.call("library?tab=albums&q=first")[1]["count"], 1)
        self.assertEqual(self.call("library?tab=albums&type=compilation")[1]["count"], 0)
        self.call("pins", {"kind": "album", "id": first["id"], "pinned": True})
        pinned = self.call("library?tab=albums&sort=name")[1]["albums"]
        self.assertEqual(pinned[0]["id"], first["id"])
        self.assertTrue(pinned[0]["pinned"])

        self.assertEqual(self.call("library?tab=artists&filter=followed")[1]["count"], 0)
        self.call("favorites", {"kind": "artist", "id": one["artist_id"], "liked": True})
        followed = self.call("library?tab=artists&filter=followed")[1]["artists"]
        self.assertEqual([artist["name"] for artist in followed], ["Lumen"])
        self.assertTrue(followed[0]["liked"])
        self.assertEqual(self.call("library?tab=artists")[1]["count"], 2)

        self.call("playlists", {"name": "Loose"})
        filed = self.call("playlists", {"name": "Filed", "folder": "Evening", "tracks": [one["id"]]})[1]
        top = self.call("playlists", {"name": "Top"})[1]
        self.call("pins", {"kind": "playlist", "id": top["id"], "pinned": True})
        playlists = self.call("library?tab=playlists")[1]["playlists"]
        self.assertEqual([(row["name"], row["group"]) for row in playlists],
                         [("Top", "Pinned"), ("Loose", "Playlists"), ("Filed", "Evening")])
        self.assertEqual(next(row for row in playlists if row["id"] == filed["id"])["line"], "1 song · 3 min")

        self.call("history", {"track_id": three["id"], "seconds": 200})
        recent = self.call("library?tab=recent")[1]
        self.assertEqual([row["title"] for row in recent["tracks"]], ["Three"])
        self.assertEqual(recent["context"], "library:recent")
        self.assertEqual([source["index"] for source in self.call("library?tab=folders")[1]["sources"]], [0])
        self.assertEqual([genre["name"] for genre in self.call("library?tab=genres")[1]["genres"]], ["Ambient"])
        self.assertEqual(self.call("library?tab=nothing")[1]["tab"], "playlists")
        self.assertIn("tracks", self.call("library")[1])  # without a tab: the totals, as before

    def test_a_long_list_comes_page_by_page_and_by_position(self):
        tracks = self.fill()
        ids = [tracks[title]["id"] for title in ("One", "Two", "Three")]
        self.call("favorites", {"kind": "track", "ids": ids, "liked": True})
        route = "library?tab=liked&sort=title&limit=2"

        first = self.call(route)[1]
        self.assertEqual([row["title"] for row in first["tracks"]], ["One", "Three"])
        self.assertEqual((first["count"], first["cursor"]), (3, "2"))
        second = self.call(f"{route}&cursor={first['cursor']}")[1]
        self.assertEqual([row["title"] for row in second["tracks"]], ["Two"])
        self.assertEqual([row["position"] for row in second["tracks"]], [2])
        self.assertIsNone(second["cursor"])

        picked = self.call(f"{route}&positions=2,0")[1]
        self.assertEqual([row["title"] for row in picked["tracks"]], ["Two", "One"])
        self.assertEqual(picked["count"], 3)
        self.assertIsNone(picked["cursor"])

        # a row's play: the list from that row on, positions counted from it
        played = self.call(f"{route}&from=1")[1]
        self.assertEqual([row["title"] for row in played["tracks"]], ["Three", "Two"])
        self.assertEqual([row["position"] for row in played["tracks"]], [1, 2])
        self.assertEqual(played["count"], 2)
        self.assertEqual([row["title"] for row in self.call(f"{route}&from=1&positions=1")[1]["tracks"]], ["Two"])

        for bad in ("cursor=x", "positions=3", "positions=-1", "from=9", "positions=" + ",".join(["0"] * 51)):
            self.assertEqual(self.call(f"{route}&{bad}")[0], 400, bad)

    def test_a_heart_and_a_pin_answer_the_row_they_turn_over(self):
        tracks = self.fill()
        track_id = tracks["One"]["id"]
        status, answer = self.call("favorites", {"kind": "track", "id": track_id, "liked": True})
        self.assertEqual(status, 200)
        self.assertEqual(answer["item"], {"liked": True, "not_liked": False})
        self.assertEqual(self.call("favorites", {"kind": "track", "id": track_id, "liked": False})[1]["item"],
                         {"liked": False, "not_liked": True})
        self.assertNotIn("item", self.call("favorites", {"kind": "track", "ids": [track_id], "liked": True})[1])
        album = self.call(f"albums/{tracks['One']['album_id']}")[1]
        self.assertTrue(album["tracks"][0]["liked"])
        self.assertEqual(album["tracks"][0]["disc_label"], "")
        self.assertEqual(album["line"], "Single · 2 songs · 5 min · Lossless")
        pin = self.call("pins", {"kind": "album", "id": album["id"], "pinned": True})[1]
        self.assertEqual(pin["item"], {"pinned": True, "not_pinned": False})
        self.assertEqual(self.call("pins", {"kind": "album", "id": album["id"], "pinned": False})[1]["item"],
                         {"pinned": False, "not_pinned": True})

    def test_home_by_section_and_search_as_the_shared_pages_read_them(self):
        tracks = self.fill()
        home = self.call("home?view=shelves&hour=9")[1]
        self.assertEqual(home["greeting"], "Good morning")
        self.assertFalse(home["empty"])
        self.assertNotIn("sections", home)
        self.assertIn("added", home["shelves"])
        self.assertIn("start", home["shelves"])
        self.assertTrue(all("not_pinned" in album for album in home["shelves"]["added"]["items"]))

        self.call("favorites", {"kind": "track", "id": tracks["Two"]["id"], "liked": True})
        album_id = tracks["One"]["album_id"]
        self.call("history", {"track_id": tracks["One"]["id"], "seconds": 200, "context": f"album:{album_id}"})
        home = self.call("home?view=shelves")[1]["shelves"]
        self.assertEqual([row["title"] for row in home["recent"]["items"]], ["One"])
        self.assertEqual([row["title"] for row in home["liked"]["items"]], ["Two"])
        self.assertTrue(home["liked"]["items"][0]["liked"])
        tile = home["continue"]["items"][0]
        self.assertEqual((tile["id"], tile["is_album"], tile["is_mix"]), (album_id, True, False))
        self.assertEqual(tile["mosaic_key"], album_id)
        self.assertIn("sections", self.call("home")[1])  # Music's own page reads it as before

        idle = self.call("search?q=")[1]
        self.assertTrue(idle["idle"])
        self.assertEqual([genre["name"] for genre in idle["browse"]], ["Ambient"])
        for query in ("lu", "lume", "lumen"):
            self.call(f"search?q={query}&remember=1")
        self.assertEqual(self.call("search/recent")[1]["recent"], ["lumen"])
        found = self.call("search?q=one")[1]
        self.assertTrue(found["found"])
        self.assertFalse(found["nothing"])
        self.assertEqual(found["songs"][0]["title"], "One")
        self.assertIn("not_liked", found["songs"][0])
        self.assertEqual(found["top_tiles"][0]["is_track"], True)
        self.assertEqual(found["context"], "search:one")
        self.assertTrue(self.call("search?q=zzzzqqq")[1]["nothing"])

        folder = self.call("folders/0?path=Lumen")[1]
        self.assertEqual([crumb["path"] for crumb in folder["crumbs"]], ["", "Lumen"])
        self.assertEqual({track["title"] for track in folder["tracks"]}, {"One", "Two"})
        self.assertEqual(folder["context"], "folder:0")
        root = self.call("folders/0")[1]
        self.assertEqual([(child["name"], child["source"]) for child in root["folders"]], [("Lumen", 0)])
        self.assertEqual(self.call("folders/0?path=../etc")[0], 404)

    def test_the_mosaic_takes_album_ids_only_and_falls_back_to_one_cover(self):
        tracks = self.fill()
        album_id = tracks["One"]["album_id"]
        # fewer than four covers: the first one by itself
        status, _, body = self.request(f"artwork/mosaic/{album_id}")
        self.assertEqual((status, body), (200, COVER))
        status, _, body = self.request(f"artwork/mosaic/{tracks['Three']['album_id']}.{album_id}")
        self.assertEqual((status, body), (200, COVER))
        for path in ("artwork/mosaic/", "artwork/mosaic/notanid", f"artwork/mosaic/{album_id}.x",
                     "artwork/mosaic/..%2f..%2fconfig.toml", f"artwork/mosaic/{tracks['Three']['album_id']}"):
            self.assertIn(self.request(path)[0], (400, 404), path)

    def test_four_covers_make_one_square_picture(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is not installed")
        import io

        def cover(colour):
            out = io.BytesIO()
            Image.new("RGB", (64, 40), colour).save(out, "PNG")
            return out.getvalue()

        colours = ["red", "lime", "blue", "yellow"]
        for index, colour in enumerate(colours):
            (self.source / f"{index}.flac").write_bytes(media.flac(
                {"TITLE": f"T{index}", "ARTIST": "A", "ALBUM": f"Album {index}", "TRACKNUMBER": "1"}, cover=cover(colour)))
        self.assertEqual(self.call("scan", {})[0], 200)
        albums = {album["album"]: album["id"] for album in self.call("albums")[1]["albums"]}
        key = ".".join(albums[f"Album {index}"] for index in range(4))
        status, headers, body = self.request(f"artwork/mosaic/{key}?size=300")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual(image.size, (300, 300))
            corners = [image.getpixel(point) for point in ((75, 75), (225, 75), (75, 225), (225, 225))]
        expected = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
        for got, want in zip(corners, expected):
            self.assertTrue(all(abs(a - b) < 40 for a, b in zip(got, want)), (got, want))
        # composed once, then served from the cache
        self.assertEqual(self.request(f"artwork/mosaic/{key}?size=300")[2], body)


class PlaylistApiTest(MusicApiCase):
    def test_a_playlist_lifecycle(self):
        tracks = self.fill()
        ids = [tracks[name]["id"] for name in ("One", "Two", "Three")]
        status, playlist = self.call("playlists", {"name": "  Road   trip ", "description": "Long drives"})
        self.assertEqual(playlist["name"], "Road trip")

        added = self.call(f"playlists/{playlist['id']}/add", {"tracks": ids})[1]
        self.assertEqual(added["added"], 3)
        again = self.call(f"playlists/{playlist['id']}/add", {"tracks": [ids[0]]})[1]
        self.assertEqual((again["added"], again["duplicates"]), (0, [ids[0]]))

        entries = added["playlist"]["tracks"]
        moved = self.call(f"playlists/{playlist['id']}/move", {"entry": entries[2]["entry_id"], "to": 0})[1]
        self.assertEqual([entry["title"] for entry in moved["tracks"]], ["Three", "One", "Two"])
        removed = self.call(f"playlists/{playlist['id']}/remove", {"entries": [entries[0]["entry_id"]]})[1]
        self.assertEqual([entry["title"] for entry in removed["tracks"]], ["Three", "Two"])
        self.assertEqual(removed["track_count"], 2)

        renamed = self.call(f"playlists/{playlist['id']}", {"name": "Night drive", "cover": f"album:{tracks['One']['album_id']}"})[1]
        self.assertEqual(renamed["name"], "Night drive")
        status, headers, body = self.request(f"playlists/{playlist['id']}/export")
        self.assertEqual(status, 200)
        text = body.decode("utf-8")
        self.assertIn("#EXTM3U", text)
        self.assertIn("Lumen/two.flac", text)
        self.assertNotIn(str(self.source), text)

        imported = self.call("playlists/import", {"name": "Back", "content": text})[1]
        self.assertEqual(imported["matched"], 2)
        self.assertEqual(self.call(f"playlists/{playlist['id']}/delete", {})[1]["deleted"], True)
        self.assertEqual(self.call(f"playlists/{playlist['id']}")[0], 404)

    def test_entries_from_elsewhere_are_matched_to_this_library_only(self):
        tracks = self.fill()
        result = self.call("playlists/import", {"name": "Shared", "entries": [
            {"title": "one", "artist": "LUMEN"}, {"title": "Not Here", "artist": "Nobody"}]})[1]

        self.assertEqual(result["matched"], 1)
        self.assertEqual(result["playlist"]["tracks"][0]["id"], tracks["One"]["id"])
        self.assertEqual(result["unmatched"][0]["title"], "Not Here")

    def test_smart_playlists_follow_their_rules(self):
        tracks = self.fill()
        rules = {"match": "all", "rules": [{"field": "artist", "op": "is", "value": "Lumen"},
                                           {"field": "duration", "op": "lt", "value": 150}], "sort": "title"}
        status, smart = self.call("playlists", {"name": "Short Lumen", "rules": rules})
        self.assertEqual(status, 201)
        self.assertEqual([track["title"] for track in smart["tracks"]], ["Two"])
        self.assertEqual(self.call(f"playlists/{smart['id']}/add", {"tracks": [tracks["One"]["id"]]})[0], 400)

        for bad in ({"rules": [{"field": "path", "op": "is", "value": "x"}]},
                    {"rules": [{"field": "title", "op": "; DROP", "value": "x"}]},
                    {"rules": []}):
            self.assertEqual(self.call("playlists", {"name": "Bad", "rules": bad})[0], 400)
        sneaky = {"rules": [{"field": "title", "op": "contains", "value": "' OR 1=1 --"}]}
        self.assertEqual(self.call("playlists/preview", {"rules": sneaky})[1]["tracks"], [])

    def test_cover_uploads_must_be_images(self):
        self.fill()
        playlist = self.call("playlists", {"name": "Art"})[1]
        status, _, body = self.request(f"playlists/{playlist['id']}/cover", "POST", raw=b"<svg onload=alert(1)>",
                                       headers={"Content-Type": "image/svg+xml"})
        self.assertEqual(status, 415)
        status, _, body = self.request(f"playlists/{playlist['id']}/cover", "POST", raw=COVER,
                                       headers={"Content-Type": "image/png"})
        cover = json.loads(body)["cover"]
        self.assertTrue(cover.startswith("upload:"))
        status, _, served = self.request(f"covers/{cover.split(':')[1]}")
        self.assertEqual((status, served), (200, COVER))
        self.assertEqual(self.request(f"covers/{cover.split(':')[1]}", token=self.bob)[0], 404)

    def test_the_shared_add_dialog_asks_before_adding_a_song_twice(self):
        tracks = self.fill()
        one, two = tracks["One"]["id"], tracks["Two"]["id"]
        mine = self.call("playlists", {"name": "Mine", "tracks": [one]})[1]
        self.call("playlists", {"name": "Ruled",
                                "rules": {"rules": [{"field": "artist", "op": "is", "value": "Lumen"}]}})
        editable = self.call("playlists?editable=1")[1]["playlists"]
        self.assertEqual([(row["name"], row["line"]) for row in editable], [("Mine", "1 song")])

        status, answer = self.call(f"playlists/{mine['id']}/add", {"tracks": [one], "ask": True})
        self.assertEqual(status, 409)
        self.assertEqual(answer["message"], "This song is already in Mine.")
        self.assertEqual(answer["duplicates"], [one])
        self.assertEqual(self.call(f"playlists/{mine['id']}")[1]["track_count"], 1)
        # the listener says to add it anyway
        status, answer = self.call(f"playlists/{mine['id']}/add", {"tracks": [one], "allow_duplicates": True})
        self.assertEqual((status, answer["added"], answer["message"]), (200, 1, "Added to Mine."))
        status, answer = self.call(f"playlists/{mine['id']}/add", {"tracks": [two], "ask": True})
        self.assertEqual((status, answer["added"], answer["message"]), (200, 1, "Added to Mine."))
        created = self.call("playlists", {"name": "Fresh"})
        self.assertEqual((created[0], created[1]["message"]), (201, "Created Fresh."))

    def test_a_playlist_page_says_what_its_forms_and_buttons_need(self):
        tracks = self.fill()
        plain = self.call("playlists", {"name": "Plain: one/two", "tracks": [tracks["One"]["id"]]})[1]
        page = self.call(f"playlists/{plain['id']}")[1]
        self.assertEqual((page["regular"], page["smart"], page["has_unmatched"]), (True, False, False))
        self.assertEqual(page["export_name"], "Plain onetwo.m3u8")
        self.assertTrue(page["tracks"][0]["entry_id"])

        # a smart playlist as its forms send it: rows of text values
        status, smart = self.call("playlists", {
            "name": "Nineties", "smart": True, "match": "all", "sort": "title", "order": "asc", "limit": "50",
            "conditions": [{"field": "year", "op": "between", "value": "1990, 1999"},
                           {"field": "lossless", "op": "is", "value": "true"},
                           {"field": "artist", "op": "contains", "value": "Lum"}]})
        self.assertEqual(status, 201, smart)
        self.assertEqual(smart["rules"]["rules"][0]["value"], [1990.0, 1999.0])
        self.assertIs(smart["rules"]["rules"][1]["value"], True)
        page = self.call(f"playlists/{smart['id']}")[1]
        self.assertEqual((page["regular"], page["smart"], page["limit"], page["order"]), (False, True, 50, "asc"))
        self.assertEqual(page["conditions"], [{"field": "year", "op": "between", "value": "1990 - 1999"},
                                              {"field": "lossless", "op": "is", "value": "true"},
                                              {"field": "artist", "op": "contains", "value": "Lum"}])
        edited = self.call(f"playlists/{smart['id']}", {
            "smart": True, "match": "any", "sort": "added", "order": "desc", "limit": 10,
            "conditions": [{"field": "artist", "op": "is", "value": "Tidal"}]})[1]
        self.assertEqual(([track["title"] for track in edited["tracks"]], edited["message"]), (["Three"], "Saved."))
        status, answer = self.call(f"playlists/{smart['id']}", {
            "smart": True, "conditions": [{"field": "year", "op": "between", "value": "1990"}]})
        self.assertEqual(status, 400, answer)

    def test_a_playlist_file_is_imported_from_its_raw_bytes(self):
        tracks = self.fill()
        text = "#EXTM3U\n#EXTINF:3,Lumen - One\nLumen/one.flac\n#EXTINF:5,Nobody - Missing\nelsewhere/missing.mp3\n"
        octets = {"Content-Type": "application/octet-stream"}
        status, _, body = self.request("playlists/import?name=Road%20songs.m3u8", "POST",
                                       raw=("﻿" + text).encode("utf-8"), headers=octets)
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        self.assertEqual((result["playlist"]["name"], result["matched"]), ("Road songs", 1))
        self.assertEqual(result["message"], "Imported Road songs: 1 song, 1 not found.")
        page = self.call(f"playlists/{result['playlist']['id']}")[1]
        self.assertEqual(page["tracks"][0]["id"], tracks["One"]["id"])
        self.assertTrue(page["has_unmatched"])
        self.assertEqual((page["unmatched"][0]["title"], page["unmatched"][0]["line"]), ("Missing", "Nobody"))
        self.assertEqual(page["unmatched_line"], "1 song from the imported file is not in your library.")
        dismissed = self.call(f"playlists/{result['playlist']['id']}/dismiss", {})[1]
        self.assertEqual(dismissed["unmatched"], [])
        self.assertFalse(self.call(f"playlists/{result['playlist']['id']}")[1]["has_unmatched"])

        # a file naming its own playlist keeps that name
        status, _, body = self.request("playlists/import?name=x.m3u", "POST",
                                       raw=b"#PLAYLIST:Named\nLumen/two.flac\n", headers=octets)
        self.assertEqual(json.loads(body)["playlist"]["name"], "Named")

    def test_a_playlist_picture_is_its_cover_or_its_albums(self):
        tracks = self.fill()
        empty = self.call("playlists", {"name": "Empty"})[1]
        self.assertEqual(self.request(f"playlists/{empty['id']}/picture")[0], 404)
        filled = self.call("playlists", {"name": "Filled", "tracks": [tracks["One"]["id"]]})[1]
        self.assertEqual(self.request(f"playlists/{filled['id']}/picture?size=120")[0], 200)
        status, _, _ = self.request(f"playlists/{empty['id']}/cover", "POST", raw=COVER,
                                    headers={"Content-Type": "image/png"})
        self.assertEqual(status, 200)
        status, _, served = self.request(f"playlists/{empty['id']}/picture")
        self.assertEqual((status, served), (200, COVER))
        self.assertEqual(self.request(f"playlists/{empty['id']}/picture", token=self.bob)[0], 404)
        # back to the automatic picture
        self.call(f"playlists/{empty['id']}/cover", {})
        self.assertEqual(self.request(f"playlists/{empty['id']}/picture")[0], 404)


class ListeningTest(MusicApiCase):
    def test_plays_skips_stats_and_wrapped(self):
        tracks = self.fill()
        one, two = tracks["One"]["id"], tracks["Two"]["id"]
        self.assertTrue(self.call("history", {"track_id": one, "seconds": 120, "context": f"album:{tracks['One']['album_id']}"})[1]["counted"])
        self.assertTrue(self.call("history", {"track_id": one, "seconds": 300})[1]["counted"])
        self.assertTrue(self.call("history", {"track_id": two, "seconds": 5})[1]["skipped"])
        self.assertFalse(self.call("history", {"track_id": two, "seconds": 45})[1]["counted"])

        stats = self.call("stats?days=7")[1]
        self.assertEqual(stats["plays"], 2)
        self.assertEqual(stats["top_tracks"][0]["track"]["id"], one)
        self.assertEqual(stats["top_artists"][0]["name"], "Lumen")
        wrapped = self.call(f"wrapped?year={module('history').year_now()}")[1]
        self.assertEqual(wrapped["new_artist_count"], 1)
        self.assertEqual(wrapped["longest_streak"], 1)

        self.call("preferences", {"history_enabled": False})
        self.assertFalse(self.call("history", {"track_id": one, "seconds": 300})[1]["recorded"])
        self.call("preferences", {"history_enabled": True})
        self.assertEqual(self.call("history/clear", {})[1]["removed"], 4)

    def test_home_mixes_and_radio_use_only_this_library(self):
        tracks = self.fill()
        known = {track["id"] for track in tracks.values()}
        cold = self.call("home?hour=9")[1]
        self.assertEqual(cold["greeting"], "Good morning")
        self.assertFalse(cold["personalized"])
        self.assertIn("added", [section["id"] for section in cold["sections"]])

        for _ in range(3):
            self.call("history", {"track_id": tracks["One"]["id"], "seconds": 200})
        self.call("favorites", {"kind": "artist", "ids": [tracks["One"]["artist_id"]], "liked": True})
        home = self.call("home?hour=20")[1]
        self.assertTrue(home["personalized"])
        mixes = self.call("mixes")[1]["mixes"]
        daily = next(mix for mix in mixes if mix["id"] == "daily-1")
        detail = self.call("mixes/daily-1")[1]
        self.assertTrue(detail["tracks"])
        self.assertTrue(all(track["id"] in known and track["reason"] for track in detail["tracks"]))
        self.assertEqual([t["id"] for t in detail["tracks"]], [t["id"] for t in self.call("mixes/daily-1")[1]["tracks"]])
        self.assertEqual(daily["tracks"], len(detail["tracks"]))

        station = self.call(f"radio/track/{tracks['One']['id']}")[1]
        self.assertEqual(station["tracks"][0]["id"], tracks["One"]["id"])
        self.assertTrue(all(track["id"] in known for track in station["tracks"]))
        self.assertEqual(self.call("radio/track/0123456789abcdef")[0], 404)
        self.assertEqual(self.call("mixes/nothing")[0], 404)

    def test_preferences_are_validated(self):
        self.assertEqual(self.call("preferences", {"theme": "light"})[1]["theme"], "light")
        self.assertEqual(self.call("preferences", {"theme": "neon"})[0], 400)
        self.assertEqual(self.call("preferences", {"accent": "#12ab9F"})[1]["accent"], "#12ab9F")
        self.assertEqual(self.call("preferences", {"accent": "red;}"})[0], 400)
        self.assertEqual(self.call("preferences", {"unknown": 1})[0], 400)
        eq = self.call("preferences", {"equalizer": {"enabled": True, "bands": [40] * 10}})[1]["equalizer"]
        self.assertEqual(eq["bands"], [12] * 10)
        self.assertEqual(self.call("preferences", {"bob": 1}, token=self.bob)[0], 400)
        self.assertEqual(self.call("preferences", token=self.bob)[1]["theme"], "system")

    def test_music_follows_the_starcore_accent_unless_told_otherwise(self):
        # the default no longer recolours Music from album art: that is an explicit choice
        self.assertEqual(self.call("preferences")[1]["accent"], "starcore")
        self.assertEqual(self.call("preferences", {"accent": "artwork"})[1]["accent"], "artwork")
        self.assertEqual(self.call("preferences", {"accent": "#3366ff"})[1]["accent"], "#3366ff")
        self.assertEqual(self.call("preferences", {"accent": "starcore"})[1]["accent"], "starcore")

    def test_a_pinned_copy_of_the_old_default_red_reads_as_following_starcore(self):
        # Music's old picker stored StarCore's red the moment it was switched to a fixed colour,
        # after which no global accent change reached Music. Read as "starcore", not rewritten.
        self.call("preferences", {"accent": "#EE444B"})
        self.assertEqual(self.call("preferences")[1]["accent"], "starcore")
        db = module("library").library(self.satellite).db
        stored = db.all("SELECT value FROM preferences WHERE key = 'accent'")
        self.assertEqual([row["value"] for row in stored], ['"#EE444B"'])


class ConnectTest(MusicApiCase):
    def register(self, device, kind="web", token=None):
        status, payload = self.call("connect/register", {"device_id": device, "name": device, "kind": kind}, token)
        self.assertEqual(status, 200, payload)
        return payload["cursor"]

    def test_commands_reach_only_their_target_by_long_poll(self):
        tracks = self.fill()
        self.register("browser-0001")
        self.register("phone-00001", "mobile")
        cursor = self.call("connect/cursor")[1]["cursor"]
        received = {}

        def listen():
            received["phone"] = self.call(f"connect/events?device=phone-00001&since={cursor}&timeout=5")[1]

        listener = threading.Thread(target=listen)
        listener.start()
        time.sleep(0.3)
        status, sent = self.call("connect/command", {"device_id": "browser-0001", "target": "phone-00001",
                                                     "command": "seek", "arguments": {"position": 42}})
        listener.join(timeout=10)

        self.assertEqual(status, 200)
        commands = [event for event in received["phone"]["events"] if event["type"] == "command"]
        self.assertEqual(commands[0]["arguments"], {"position": 42.0})
        browser = self.call(f"connect/events?device=browser-0001&since={cursor}&timeout=0")[1]
        self.assertFalse([event for event in browser["events"] if event["type"] == "command"])
        self.assertEqual(self.call("connect/command", {"target": "phone-00001", "command": "rm -rf"})[0], 400)
        self.assertTrue(tracks)

    def test_handoff_keeps_queue_position_shuffle_and_repeat(self):
        tracks = self.fill()
        queue = [tracks[name]["id"] for name in ("One", "Two", "Three")]
        self.register("browser-0002")
        cursor = self.register("phone-00002", "mobile")
        state = {"queue": queue, "index": 1, "position": 10, "playing": True, "shuffle": True, "repeat": "all",
                 "context": "album:x"}
        self.assertEqual(self.call("connect/state", {"device_id": "browser-0002", "state": state})[0], 200)
        time.sleep(0.2)

        status, result = self.call("connect/transfer", {"device_id": "phone-00002", "target": "phone-00002"})
        self.assertEqual(status, 200, result)
        moved = result["event"]["arguments"]["state"]
        self.assertEqual((moved["queue"], moved["index"], moved["shuffle"], moved["repeat"]), (queue, 1, True, "all"))
        self.assertGreater(moved["position"], 10)
        browser = self.call(f"connect/events?device=browser-0002&since={cursor}&timeout=0")[1]["events"]
        self.assertIn(("pause", True), [(event.get("command"), event.get("arguments", {}).get("transferred"))
                                        for event in browser if event["type"] == "command"])

        saved = self.call("queue?device=browser-0002&expand=1")[1]["state"]
        self.assertEqual([track["id"] for track in saved["tracks"]], queue)

    def test_states_are_validated(self):
        self.register("browser-0003")
        status, payload = self.call("connect/state", {"device_id": "browser-0003", "state": {
            "queue": ["0123456789abcdef", "../../etc", 5], "index": 99, "repeat": "forever", "volume": 7}})
        self.assertEqual(status, 200)
        self.assertEqual(payload["state"]["queue"], ["0123456789abcdef"])
        self.assertEqual((payload["state"]["index"], payload["state"]["repeat"], payload["state"]["volume"]),
                         (0, "off", 1.0))
        self.assertEqual(self.call("connect/register", {"device_id": "x"})[0], 400)


class OpenInstallTest(MusicApiCase):
    """Before an account exists the Core is open by design; Music then keeps one local listener."""
    bootstrap = False

    def test_an_unconfigured_install_uses_the_local_listener(self):
        self.fill()
        playlist = self.call("playlists", {"name": "Local"})[1]
        self.assertEqual(playlist["owner"], "local")


if __name__ == "__main__":
    unittest.main()
