"""files.open: Music playing a sound by its path (UI contract change 16): external tracks,
playable and in playlists, never part of the library, checked again at each play."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock
import json
import os

from tests import music_fixtures as media
from tests.support import link_folder, protecting
from tests.test_music_api import MusicApiCase, module


class MusicOpenTest(MusicApiCase):
    def setUp(self):
        super().setUp()
        self.outside = self.directory / "elsewhere"
        self.outside.mkdir()

    def sound(self, name="loose.flac", title="Loose", seconds=90):
        path = self.outside / name
        path.write_bytes(media.flac({"TITLE": title, "ARTIST": "Wanderer", "ALBUM": "Away"}, seconds=seconds))
        return path

    def open(self, path):
        return self.call("open", {"path": str(path)})

    def external_id(self, path):
        status, answer = self.open(path)
        self.assertEqual(status, 200, answer)
        self.assertEqual(answer["page"], "track")
        return answer["params"]["id"]

    def test_the_catalog_lists_what_music_opens(self):
        entry = self.satellite.manifest.provides["files.open"]
        self.assertEqual(entry["operations"], {"open": "open"})
        self.assertEqual(entry["types"], ["audio"])
        self.assertIn(".flac", entry["extensions"])
        self.assertNotIn(".mp4", entry["extensions"])
        self.assertEqual(entry["label"], "Music")

    def test_a_sound_of_the_library_opens_its_own_page(self):
        tracks = self.fill()
        status, answer = self.open(self.source / "Lumen" / "one.flac")
        self.assertEqual((status, answer), (200, {"page": "track", "params": {"id": tracks["One"]["id"]}}))
        self.assertFalse(self.call(f"tracks/{tracks['One']['id']}?page=1")[1]["external"])

    def test_a_sound_outside_the_library_plays_and_stays_out_of_it(self):
        self.fill()
        path = self.sound()
        track_id = self.external_id(path)

        status, track = self.call(f"tracks/{track_id}?page=1")
        self.assertEqual(status, 200)
        self.assertEqual((track["title"], track["external"], track["missing"]), ("Loose", True, False))
        self.assertEqual(track["library_note"], "Not in the library")
        self.assertEqual(track["location"], str(path))
        # it has no album, artist or cover of the library to go to
        self.assertEqual((track["album_id"], track["artist_id"], track["has_artwork"]), (None, None, False))

        # never part of the library: lists, counts, search and the folder tree leave it out
        self.assertEqual({row["title"] for row in self.call("tracks?sort=title")[1]["tracks"]}, {"One", "Two", "Three"})
        self.assertEqual(self.call("library")[1]["tracks"], 3)
        self.assertEqual(self.call("search?q=Loose")[1]["tracks"], [])
        self.assertEqual(self.call("library")[1]["missing"], 0)

        # but it plays, as any track does
        status, headers, body = self.request(f"stream/{track_id}")
        self.assertEqual((status, headers["Content-Type"]), (200, "audio/flac"))
        self.assertEqual(body, path.read_bytes())
        status, plan = self.call(f"playback/{track_id}")
        self.assertEqual(status, 200)
        self.assertEqual(plan["stream"].split("?")[0], f"stream/{track_id}")

        # opening it again finds the same track
        self.assertEqual(self.external_id(path), track_id)
        self.assertEqual(module("library").library(self.satellite).db.value(
            "SELECT COUNT(*) FROM tracks WHERE external = 1"), 1)

    def test_it_can_be_added_to_a_playlist_and_goes_missing_with_its_file(self):
        self.fill()
        path = self.sound()
        track_id = self.external_id(path)

        status, playlist = self.call("playlists", {"name": "Wandering", "tracks": [track_id]})
        self.assertEqual(status, 201, playlist)
        status, shown = self.call(f"playlists/{playlist['id']}")
        entry = shown["tracks"][0]
        self.assertEqual((entry["id"], entry["title"], entry["missing"], shown["unavailable"]),
                         (track_id, "Loose", False, 0))
        # a playlist is also made of library tracks, and the external one is not exported
        one = self.call("tracks?sort=title")[1]["tracks"][0]["id"]
        self.call(f"playlists/{playlist['id']}/add", {"tracks": [one]})
        status, _headers, exported = self.request(f"playlists/{playlist['id']}/export")
        self.assertEqual(status, 200)
        self.assertNotIn("loose.flac", exported.decode("utf-8"))

        # the file leaves: the next time the playlist loads or the sound is played, it says so
        moved = path.with_name("moved.flac")
        path.rename(moved)
        shown = self.call(f"playlists/{playlist['id']}")[1]
        entry = next(row for row in shown["tracks"] if row["id"] == track_id)
        self.assertEqual((entry["missing"], shown["unavailable"]), (True, 1))
        self.assertEqual(self.request(f"stream/{track_id}")[0], 404)
        self.assertEqual(self.call(f"playback/{track_id}")[0], 404)
        self.assertIsNone(self.call(f"tracks/{track_id}?page=1")[1]["location"])

        # and it plays again when the file comes back
        moved.rename(path)
        self.assertEqual(self.request(f"stream/{track_id}")[0], 200)
        shown = self.call(f"playlists/{playlist['id']}")[1]
        self.assertEqual(shown["unavailable"], 0)

    def test_what_it_cannot_play_or_the_user_cannot_browse_is_refused(self):
        (self.outside / "notes.txt").write_text("x", encoding="utf-8")
        (self.outside / "broken.mp3").write_bytes(b"not a sound at all")
        for path in (self.outside / "notes.txt", self.outside / "missing.flac", self.outside, "relative/a.flac"):
            status, _ = self.open(path)
            self.assertIn(status, (400, 404), path)
        status, _ = self.open(self.outside / "broken.mp3")
        self.assertEqual(status, 415)
        self.assertEqual(self.request("open")[0], 405)
        self.assertEqual(self.call("open", {"path": 3})[0], 400)
        self.assertEqual(self.call("open", {"path": str(self.outside / "x.flac")}, token="nope")[0], 401)

    def test_a_scan_leaves_it_alone_and_a_source_that_holds_it_takes_it_in(self):
        self.fill()
        path = self.sound()
        track_id = self.external_id(path)
        playlist = self.call("playlists", {"name": "Wandering", "tracks": [track_id]})[1]

        self.call("scan", {})
        row = module("library").library(self.satellite).db.one("SELECT external, missing FROM tracks WHERE id = ?", (track_id,))
        self.assertEqual((row["external"], row["missing"]), (1, 0))
        self.assertEqual(self.call("library")[1]["tracks"], 3)

        # a source that now holds its folder makes it a library track at the next scan, the playlist keeps it
        self.satellite.config.data["sources"] = [str(self.outside)]
        self.call("scan", {})
        self.assertEqual(self.call("library")[1]["tracks"], 4)
        track = self.call(f"tracks/{track_id}")[1]
        self.assertFalse(track["external"])
        self.assertEqual(self.call(f"playlists/{playlist['id']}")[1]["tracks"][0]["id"], track_id)

    def test_what_nothing_holds_is_dropped_after_a_while(self):
        self.fill()
        music = module("library").library(self.satellite)
        held, played, idle = (self.external_id(self.sound(name, title)) for name, title in
                              (("held.flac", "Held"), ("played.flac", "Played"), ("idle.flac", "Idle")))
        self.call("playlists", {"name": "Wandering", "tracks": [held]})
        self.call("history", {"track_id": played, "seconds": 90, "device": "web"})
        old = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat(timespec="seconds")
        music.db.execute("UPDATE tracks SET last_used = ? WHERE external = 1", (old,))

        # recent use keeps one that nothing else holds
        self.assertEqual(module("opening").purge(music), 1)
        kept = {row["id"] for row in music.db.all("SELECT id FROM tracks WHERE external = 1")}
        self.assertEqual(kept, {held, played})
        self.assertNotIn(idle, kept)
        self.assertEqual(self.call(f"tracks/{idle}")[0], 404)

        # a saved queue holds one too
        queued = self.external_id(self.sound("queued.flac", "Queued"))
        music.db.execute("UPDATE tracks SET last_used = ? WHERE id = ?", (old, queued))
        music.db.execute("INSERT INTO playback_state (user, device_id, state, updated_at) VALUES (?, ?, ?, ?)",
                         ("alice", "web", json.dumps({"queue": [queued], "index": 0}), old))
        self.assertEqual(module("opening").purge(music), 0)
        music.db.execute("DELETE FROM playback_state")
        self.assertEqual(module("opening").purge(music), 1)

    # ---------- the security review of O1 to O4 (O5) ----------

    def test_a_file_of_a_protected_area_is_never_kept_even_while_it_is_open(self):
        self.fill()
        vault = self.outside / "vault"
        vault.mkdir()
        path = self.sound("vault/secret.flac", "Secret")
        with protecting(vault):
            status, answer = self.open(path)
        self.assertEqual(status, 403, answer)
        self.assertIn("protected area", answer["error"])
        self.assertEqual(module("library").library(self.satellite).db.value(
            "SELECT COUNT(*) FROM tracks WHERE external = 1"), 0)

    def test_a_track_whose_file_a_protected_area_comes_to_hold_is_dropped_with_all_it_kept(self):
        self.fill()
        folder = self.outside / "later"
        folder.mkdir()
        track_id = self.external_id(self.sound("later/loose.flac"))
        playlist = self.call("playlists", {"name": "Wandering", "tracks": [track_id]})[1]
        self.call("history", {"track_id": track_id, "seconds": 90, "device": "web"})
        music = module("library").library(self.satellite)
        cached = music.transcoder.cache_dir / f"{track_id}-0000-low.mp3"
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(b"transcoded")

        with protecting(folder):
            shown = self.call(f"playlists/{playlist['id']}")[1]
            self.assertEqual(self.request(f"stream/{track_id}")[0], 404)
        # the playlist keeps the entry, missing and nameless; the tags, plays and transcode are gone
        entry = shown["tracks"][0]
        self.assertEqual((entry["id"], entry["missing"], entry["title"]), (track_id, True, None))
        self.assertEqual(self.call(f"tracks/{track_id}")[0], 404)
        self.assertEqual(music.db.value("SELECT COUNT(*) FROM plays WHERE track_id = ?", (track_id,)), 0)
        self.assertFalse(cached.exists())

    def test_a_track_whose_path_comes_to_lead_elsewhere_is_missing_not_the_other_file(self):
        self.fill()
        folder = self.outside / "dir"
        folder.mkdir()
        track_id = self.external_id(self.sound("dir/loose.flac"))
        # the folder leaves, and a link to another folder, holding another sound, takes its place
        folder.rename(self.outside / "moved")
        other = self.outside / "other"
        other.mkdir()
        (other / "loose.flac").write_bytes(media.flac({"TITLE": "Other", "ARTIST": "Someone"}, seconds=30))
        link_folder(folder, other)

        self.assertEqual(self.request(f"stream/{track_id}")[0], 404)
        status, track = self.call(f"tracks/{track_id}?page=1")
        self.assertEqual((status, track["title"], track["missing"], track["location"]), (200, "Loose", True, None))
        self.assertEqual(module("library").library(self.satellite).db.value(
            "SELECT COUNT(*) FROM tracks WHERE external = 1"), 1)

    def test_a_transcode_does_not_outlive_its_file(self):
        self.fill()
        path = self.sound()
        track_id = self.external_id(path)
        music = module("library").library(self.satellite)
        cached = music.transcoder.cache_dir / f"{track_id}-0000-low.mp3"
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(b"transcoded")
        path.unlink()
        self.assertEqual(self.request(f"stream/{track_id}")[0], 404)
        self.assertFalse(cached.exists())

    def test_its_stream_is_not_kept_by_the_browser(self):
        tracks = self.fill()
        track_id = self.external_id(self.sound())
        self.assertEqual(self.request(f"stream/{track_id}")[1]["Cache-Control"], "private, no-store")
        self.assertEqual(self.request(f"stream/{tracks['One']['id']}")[1]["Cache-Control"], "private, max-age=3600")

    def test_lyrics_beside_it_are_read_only_where_the_session_may_browse_them(self):
        self.fill()
        path = self.sound()
        path.with_suffix(".lrc").write_text("[00:01.00]Far away\n", encoding="utf-8")
        track_id = self.external_id(path)
        status, found = self.call(f"lyrics/{track_id}")
        self.assertEqual((status, found["source"]), (200, "sidecar"))
        with mock.patch.object(module("opening"), "readable", return_value=False) as readable:
            self.assertEqual(self.call(f"lyrics/{track_id}")[0], 404)
        self.assertEqual(readable.call_args.args[1], path.with_suffix(".lrc"))

    def test_a_lyric_file_that_links_elsewhere_is_not_read(self):
        self.fill()
        path = self.sound()
        secret = self.directory / "secret.txt"
        secret.write_text("[00:01.00]Not yours\n", encoding="utf-8")
        try:
            os.symlink(secret, path.with_suffix(".lrc"))
        except OSError:
            self.skipTest("no symbolic links to files here")
        track_id = self.external_id(path)
        self.assertEqual(self.call(f"lyrics/{track_id}")[0], 404)

    def test_show_in_folder_covers_any_file_the_session_may_browse(self):
        clip = self.outside / "clip.mp4"
        clip.write_bytes(b"\x00" * 64)
        opening = module("opening")
        request = SimpleNamespace(engine=self.engine, token=self.alice)
        # an .mp4 is not opened here (it is left to the interfaces that show video), but a library
        # track can be one, and its folder can still be shown
        self.assertIsNone(opening.stat(request, str(clip)))
        self.assertEqual(opening.location(request, str(clip)), str(clip))
        self.assertIsNone(opening.location(request, str(self.outside / "gone.mp4")))
