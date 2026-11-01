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
