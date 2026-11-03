"""The typed command system: discovery, parsing, authorization, confirmation,
audit, JSON output, exit codes, Music device targeting and the one-shot CLI.

Every test uses its own temporary libraries, auth store and audit log -
never a real library, config.toml or data directory.
"""

from http.client import HTTPConnection
from pathlib import Path
from unittest import mock
import io
import json
import shutil
import tempfile
import threading
import time
import unittest

from starcore.auth import AuthStore
from starcore.cli import bridge, runner, spec
from starcore.cli.audit import AuditLog
from starcore.cli.spec import Argument, Command, Namespace, Option, UsageError, bounded, parse_arguments
from starcore.core import StarCore
from tests.support import start_engine, stop_engine
from tests.test_music import flac


def isolate(engine, directory: Path):
    """Points every satellite this file touches at disposable storage."""
    music = engine.registry.get("Music")
    (directory / "music-source").mkdir(parents=True, exist_ok=True)
    music.config.data["storage"] = str(directory / "music")
    music.config.data["library"] = str(directory / "music-source")
    music.config.data["sources"] = []
    photo = engine.registry.get("Photo")
    photo.config.data["storage"] = str(directory / "photo")
    photo.config.data["sync_enabled"] = False
    photo.config.data["photo_directory"] = ""
    locked = engine.registry.get("LockedFolder")
    locked.config.data["storage"] = str(directory / "locked")
    locked.config.data["locked_folder_path"] = ""
    locked.config.path = directory / "locked-config.toml"
    for satellite in (music, photo):
        satellite.config.path = directory / f"{satellite.manifest.name}-config.toml"


class CommandTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-cli-"))
        isolate(self.engine, self.directory)
        self.engine.audit = AuditLog(self.directory / "audit.log")
        self.engine.auth = AuthStore(self.directory / "auth.json")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def run_line(self, line, context=None):
        return self.engine.run_command(line, context or runner.terminal_context(self.engine))

    def run_json(self, line, context=None):
        outcome = self.run_line(f"{line} --json", context)
        return outcome.exit_code, json.loads(outcome.stdout)


# ---------- definitions and parsing ----------

class ParsingTest(unittest.TestCase):
    def command(self, **overrides):
        values = dict(name="demo", summary="a demo", handler=lambda ctx, **values: values, permission="demo.read",
                      arguments=(Argument("item"), Argument("rest", required=False, variadic=True)),
                      options=(Option("count", type=bounded(1, 5), default=1), Option("fast", flag=True),
                               Option("mode", choices=("a", "b"), default="a")))
        values.update(overrides)
        command = Command(**values)
        Namespace("demo", "demo").add(command)
        return command

    def test_values_are_converted_and_defaults_kept(self):
        values = parse_arguments(self.command(), ["x", "--count=3", "--fast", "y", "z"])

        self.assertEqual(values, {"item": "x", "rest": ["y", "z"], "count": 3, "fast": True, "mode": "a"})

    def test_option_value_can_follow_as_its_own_token(self):
        self.assertEqual(parse_arguments(self.command(), ["x", "--mode", "b"])["mode"], "b")

    def test_invalid_input_is_a_usage_error(self):
        for tokens in (["x", "--count", "9"], ["x", "--count", "two"], ["x", "--mode", "c"], ["x", "--nope"],
                       ["x", "-z"], [], ["x", "--count"], ["x", "--fast=yes"], ["bad\x07value"]):
            with self.subTest(tokens=tokens), self.assertRaises(UsageError):
                parse_arguments(self.command(), tokens)

    def test_double_dash_passes_values_that_look_like_options(self):
        values = parse_arguments(self.command(), ["--", "--not-an-option", "-1"])

        self.assertEqual(values["item"], "--not-an-option")
        self.assertEqual(values["rest"], ["-1"])

    def test_negative_numbers_are_positional_values(self):
        self.assertEqual(parse_arguments(self.command(), ["-5"])["item"], "-5")

    def test_an_extra_positional_is_refused(self):
        command = self.command(arguments=(Argument("item"),))
        with self.assertRaises(UsageError):
            parse_arguments(command, ["a", "b"])

    def test_a_remote_command_cannot_ask_for_confirmation(self):
        with self.assertRaises(ValueError):
            Command("x", "x", lambda ctx: None, "demo.control", mutates=True, remote=True, confirm="Sure?")

    def test_state_changing_commands_are_not_remote_by_default(self):
        self.assertFalse(Command("x", "x", lambda ctx: None, "demo.manage", mutates=True).remote)
        self.assertTrue(Command("y", "y", lambda ctx: None, "demo.read").remote)

    def test_tokenizer_keeps_backslashes_and_honours_quotes(self):
        self.assertEqual(runner.tokenize(r'music scan "D:\My Music" C:\x'), ["music", "scan", r"D:\My Music", r"C:\x"])
        with self.assertRaises(UsageError):
            runner.tokenize('music scan "unterminated')

    def test_permission_wildcards(self):
        self.assertTrue(spec.permitted({"*.read"}, "music.read"))
        self.assertFalse(spec.permitted({"*.read"}, "music.manage"))
        self.assertTrue(spec.permitted({"music.*"}, "music.manage"))
        self.assertFalse(spec.permitted(set(), "music.read"))

    def test_sensitive_values_are_redacted(self):
        command = self.command(arguments=(Argument("item", sensitive=True),))
        self.assertEqual(spec.redacted(command, {"item": "secret", "count": 1})["item"], "[redacted]")


# ---------- discovery and help ----------

class DiscoveryTest(CommandTestCase):
    def test_namespaces_are_registered_by_their_owners(self):
        registry = self.engine.command_registry
        expected = {"engine": "core", "satellites": "core", "music": "Music", "photo": "Photo",
                    "status": "Status", "files": "FileExplorer", "locked": "LockedFolder"}
        for name, source in expected.items():
            with self.subTest(name=name):
                entry = registry.get(name)
                self.assertIsNotNone(entry)
                self.assertEqual(entry["source"], source)
                self.assertIsNotNone(entry["namespace"])

    def test_aliases_resolve_to_their_namespace(self):
        self.assertIs(self.engine.command_registry.get("photos"), self.engine.command_registry.get("photo"))
        self.assertEqual(self.run_line("photos").exit_code, 0)

    def test_older_single_function_commands_still_work(self):
        self.assertEqual(self.engine.execute_command("version"), "StarCore CLI v1.0.0")
        self.assertIn("server.host", self.run_line("config").stdout)

    def test_a_namespace_cannot_take_an_existing_name(self):
        registry = self.engine.command_registry
        before = registry.get("music")
        registry.add_namespace(Namespace("music", "impostor"), source="Impostor")

        self.assertIs(registry.get("music"), before)

    def test_a_broken_satellite_command_module_is_skipped(self):
        from starcore.command_loader import CommandLoader
        from starcore.command_registry import CommandRegistry

        satellite_dir = self.directory / "broken"
        (satellite_dir / "commands").mkdir(parents=True)
        (satellite_dir / "commands" / "broken.py").write_text(
            "from starcore.cli.spec import Command\n"
            "COMMANDS = [Command('x', 'x', lambda ctx: None, 'x.control', mutates=True, remote=True, confirm='?')]\n",
            encoding="utf-8")
        satellite = mock.Mock(path=satellite_dir, type="native")
        satellite.manifest.name = "Broken"
        registry = CommandRegistry()
        with mock.patch("sys.stdout", io.StringIO()) as output:
            CommandLoader(registry, self.directory).discover_satellite(satellite)

        self.assertIsNone(registry.get("broken"))
        self.assertIn("could not be loaded", output.getvalue())

    def test_help_lists_every_namespace(self):
        output = self.run_line("help").stdout
        for name in ("engine", "satellites", "music", "photo", "status", "files", "locked"):
            self.assertIn(name, output)

    def test_help_for_a_namespace_and_a_command(self):
        self.assertIn("playlist-delete", self.run_line("help music").stdout)
        self.assertEqual(self.run_line("music --help").stdout, self.run_line("help music").stdout)
        detail = self.run_line("music seek --help").stdout
        self.assertIn("Usage", detail)
        self.assertIn("music.control", detail)
        self.assertEqual(self.run_line("help music seek").stdout, detail)

    def test_starcore_prefix_is_accepted(self):
        self.assertEqual(self.run_line("starcore help").stdout, self.run_line("help").stdout)

    def test_help_json_is_a_permission_filtered_schema(self):
        _, local = self.run_json("help")
        _, remote = self.run_json("help", runner.remote_context(self.engine))

        def commands(payload):
            return {command["command"]: command for entry in payload["data"]["entries"]
                    for command in entry.get("commands", [])}

        self.assertIn("music scan", commands(local))
        self.assertNotIn("music scan", commands(remote))
        self.assertIn("music pause", commands(remote))
        self.assertNotIn("locked status", commands(remote))
        schema = commands(local)["music seek"]
        for key in ("permission", "read_only", "confirmation", "remote", "arguments", "options"):
            self.assertIn(key, schema)
        self.assertFalse(schema["read_only"])

    def test_api_command_list_carries_remote_schemas_only(self):
        from starcore.api import payloads
        music = next(item for item in payloads.describe_commands(self.engine) if item["name"] == "music")
        names = {command["name"] for command in music["commands"]}

        self.assertIn("devices", names)
        self.assertNotIn("scan", names)
        self.assertNotIn("playlist-delete", names)


# ---------- exit codes, output, authorization ----------

class BehaviourTest(CommandTestCase):
    def test_success_and_json_envelope(self):
        code, payload = self.run_json("engine status")

        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["command"], "engine status")
        self.assertTrue(payload["data"]["running"])

    def test_unknown_names_are_usage_errors_with_a_hint(self):
        outcome = self.run_line("satelites")
        self.assertEqual(outcome.exit_code, spec.EXIT_USAGE)
        self.assertIn("satellites", outcome.stderr)

        code, payload = self.run_json("music explode")
        self.assertEqual(code, spec.EXIT_USAGE)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "usage")

    def test_not_found(self):
        self.assertEqual(self.run_line("satellites show Nothing").exit_code, spec.EXIT_NOT_FOUND)

    def test_a_disabled_satellite_is_reported_as_unavailable(self):
        music = self.engine.registry.get("Music")
        music.config.data["enabled"] = False
        try:
            outcome = self.run_line("music stats")
        finally:
            music.config.data["enabled"] = True
        self.assertEqual(outcome.exit_code, spec.EXIT_UNAVAILABLE)
        self.assertIn("satellites enable Music", outcome.stderr)

    def test_remote_consoles_cannot_run_terminal_only_commands(self):
        remote = runner.remote_context(self.engine)
        for line in ("music scan", "photo import x", "satellites disable Status", "engine stop", "locked status",
                     "files stat C:\\", "config server.port 1"):
            with self.subTest(line=line):
                outcome = self.run_line(line, remote)
                self.assertEqual(outcome.exit_code, spec.EXIT_DENIED)
                self.assertIn("terminal", outcome.output)
        self.assertEqual(self.run_line("music stats", remote).exit_code, 0)
        self.assertEqual(self.run_line("version", remote).exit_code, 0)

    def test_remote_grants_never_reach_manage_even_for_a_remote_command(self):
        namespace = Namespace("probe", "probe")
        namespace.add(Command("go", "x", lambda ctx: "ran", "probe.manage", mutates=True, remote=True))
        self.engine.command_registry.add_namespace(namespace)
        try:
            self.assertEqual(self.run_line("probe go", runner.remote_context(self.engine)).exit_code, spec.EXIT_DENIED)
            self.assertEqual(self.run_line("probe go").exit_code, 0)
        finally:
            self.engine.command_registry.commands.pop("probe")
        self.assertNotIn("*.manage", runner.REMOTE_GRANTS)

    def test_a_context_without_grants_is_refused(self):
        bare = spec.Context(self.engine, "terminal", frozenset(), actor="test")
        self.assertEqual(self.run_line("engine status", bare).exit_code, spec.EXIT_DENIED)

    def test_commands_that_need_the_running_engine_say_so(self):
        engine = StarCore(self.directory / "config.toml")
        engine.auth = AuthStore(self.directory / "offline-auth.json")
        engine.audit = AuditLog(self.directory / "offline-audit.log")
        with mock.patch("sys.stdout", io.StringIO()):
            engine.load()
        isolate(engine, self.directory / "offline")
        context = runner.local_context(engine)

        self.assertEqual(engine.run_command("engine version", context).exit_code, 0)
        self.assertEqual(engine.run_command("engine health", context).exit_code, spec.EXIT_UNAVAILABLE)
        outcome = engine.run_command("satellites reload Status --yes", context)
        self.assertEqual(outcome.exit_code, spec.EXIT_UNAVAILABLE)
        self.assertIn("running", outcome.stderr)
        self.assertEqual(engine.run_command("music pause", context).exit_code, spec.EXIT_UNAVAILABLE)

    def test_confirmation(self):
        self.assertEqual(self.run_line("music playlist-create Keep").exit_code, 0)

        refused = self.run_line("music playlist-delete Keep")
        self.assertEqual(refused.exit_code, spec.EXIT_CONFIRMATION)
        self.assertIn("--yes", refused.stderr)
        self.assertIn("Keep", self.run_line("music playlists").stdout)

        declined = runner.terminal_context(self.engine)
        declined.interactive, declined.confirm = True, lambda prompt: False
        self.assertEqual(self.run_line("music playlist-delete Keep", declined).exit_code, spec.EXIT_CONFIRMATION)

        accepted = runner.terminal_context(self.engine)
        accepted.interactive, accepted.confirm = True, lambda prompt: True
        self.assertEqual(self.run_line("music playlist-delete Keep", accepted).exit_code, 0)

        self.run_line("music playlist-create Gone")
        self.assertEqual(self.run_line("music playlist-delete Gone --yes").exit_code, 0)
        self.assertNotIn("Gone", self.run_line("music playlists").stdout)

    def test_audit_records_changes_and_refusals_but_not_reads(self):
        self.engine.auth.bootstrap("admin", "a very good password")
        token = self.engine.auth.login("admin", "a very good password")
        self.run_line("music stats")
        self.run_line("music playlist-create Audited")
        self.run_line("music scan", runner.remote_context(self.engine, token))

        entries = self.engine.audit.recent()
        self.assertEqual([entry["command"] for entry in entries], ["music playlist-create", "music scan"])
        self.assertEqual(entries[0]["outcome"], "ok")
        self.assertEqual(entries[0]["user"], "admin")
        self.assertEqual(entries[1]["outcome"], "denied")
        self.assertTrue(entries[1]["actor"].startswith("session:"))
        self.assertNotIn(token, (self.directory / "audit.log").read_text(encoding="utf-8"))

    def test_older_commands_are_audited_unless_read_only(self):
        self.run_line("hello")
        self.run_line("config")
        self.run_line("config server.port 1", runner.remote_context(self.engine))

        entries = self.engine.audit.recent()
        self.assertEqual([(entry["command"], entry["outcome"]) for entry in entries],
                         [("config", "ok"), ("config", "denied")])
        self.assertEqual(entries[0]["arguments"], {"argv": []})

    def test_unexpected_errors_are_contained(self):
        namespace = Namespace("boom", "boom")
        namespace.add(Command("go", "x", lambda ctx: 1 / 0, "boom.read"))
        self.engine.command_registry.add_namespace(namespace)
        try:
            with mock.patch("sys.stdout", io.StringIO()):
                code, payload = self.run_json("boom go")
        finally:
            self.engine.command_registry.commands.pop("boom")
        self.assertEqual(code, spec.EXIT_FAILED)
        self.assertIn("internal error", payload["error"]["message"])


# ---------- satellites ----------

class SatelliteCommandsTest(CommandTestCase):
    def test_satellites_list_and_show(self):
        code, payload = self.run_json("satellites")
        names = {item["name"] for item in payload["data"]["satellites"]}
        self.assertEqual(code, 0)
        self.assertTrue({"Music", "Photo", "Status"} <= names)

        code, payload = self.run_json("satellites show music")
        self.assertEqual(payload["data"]["name"], "Music")
        self.assertIn("music", payload["data"]["commands"])

    def test_lifecycle_needs_confirmation_then_goes_through_the_core(self):
        status = self.engine.registry.get("Status")
        status.config.path = self.directory / "status-config.toml"
        self.assertEqual(self.run_line("satellites disable Status").exit_code, spec.EXIT_CONFIRMATION)
        self.assertTrue(status.enabled)
        try:
            self.assertEqual(self.run_line("satellites disable Status --yes").exit_code, 0)
            self.assertFalse(self.engine.registry.get("Status").enabled)
            self.assertEqual(self.run_line("status").exit_code, spec.EXIT_UNAVAILABLE)
        finally:
            self.run_line("satellites enable Status")
        self.assertTrue(self.engine.registry.get("Status").enabled)

    def test_status_namespace(self):
        self.assertIn("StarCore status", self.run_line("status").stdout)
        code, payload = self.run_json("status services")
        self.assertEqual(code, 0)
        self.assertIn("Music", {item["name"] for item in payload["data"]["satellites"]})
        code, payload = self.run_json("status metrics")  # the older name of status hardware
        self.assertIn("logical_cores", payload["data"]["cpu"])

    def test_photo_statistics_and_sync_never_show_the_token(self):
        code, payload = self.run_json("photo stats")
        self.assertEqual(code, 0)
        for key in ("photos", "images", "videos", "albums", "size_bytes", "storage"):
            self.assertIn(key, payload["data"])

        from satellites.native.photo import sync
        described = {"enabled": True, "running": True, "url": "http://x", "token": "very-secret",
                     "counts": {"received": 0, "imported": 0, "duplicates": 0, "failed": 0}, "events": []}
        with mock.patch.object(sync, "describe", return_value=described):
            outcome = self.run_line("photo sync --json")
        self.assertNotIn("very-secret", outcome.stdout)

    def test_photo_scan_previews_without_importing(self):
        from tests.test_photo import png
        source = self.directory / "pictures"
        source.mkdir()
        (source / "one.png").write_bytes(png(4, 3))

        code, payload = self.run_json(f'photo scan "{source}"')
        self.assertEqual(code, 0)
        self.assertEqual(payload["data"]["new"], 1)
        self.assertEqual(self.run_json("photo stats")[1]["data"]["photos"], 0)
        self.assertEqual(self.run_line(f'photo scan "{self.directory / "nowhere"}"').exit_code, spec.EXIT_FAILED)

    def test_files_metadata_and_the_locked_folder_guard(self):
        sample = self.directory / "sample.bin"
        sample.write_bytes(b"12345")
        code, payload = self.run_json(f'files stat "{sample}"')
        self.assertEqual((code, payload["data"]["size"], payload["data"]["type"]), (0, 5, "file"))
        self.assertEqual(self.run_line("files stat relative/path").exit_code, spec.EXIT_USAGE)
        self.assertEqual(self.run_line(f'files stat "{self.directory / "missing"}"').exit_code, spec.EXIT_NOT_FOUND)

        vault = self.directory / "vault"
        vault.mkdir()
        (vault / "private.jpg").write_bytes(b"x")
        self.engine.registry.get("LockedFolder").config.data["locked_folder_path"] = str(vault)
        self.assertEqual(self.run_line(f'files stat "{vault / "private.jpg"}"').exit_code, spec.EXIT_DENIED)
        self.assertTrue(self.run_json(f'files stat "{self.directory}"')[1]["data"]["contains_locked_folder"])
        self.assertEqual(self.run_line("files storage").exit_code, 0)

    def test_locked_folder_reports_state_only(self):
        vault = self.directory / "vault"
        vault.mkdir()
        self.engine.registry.get("LockedFolder").config.data["locked_folder_path"] = str(vault)

        code, payload = self.run_json("locked")
        self.assertEqual(code, 0)
        data = payload["data"]
        self.assertTrue(data["configured"])
        self.assertFalse(data["pin_set"])
        self.assertNotIn("path", data)
        self.assertNotIn(str(vault), json.dumps(payload))
        namespace = self.engine.command_registry.get("locked")["namespace"]
        self.assertEqual([command.name for command in namespace.unique()], ["status"])


# ---------- music ----------

class MusicCommandsTest(CommandTestCase):
    def setUp(self):
        super().setUp()
        source = self.directory / "music-source"
        (source / "a.flac").write_bytes(flac(title="Alpha", album="Orbit"))
        (source / "b.flac").write_bytes(flac(title="Beta", album="Orbit"))
        self.assertEqual(self.run_line("music scan").exit_code, 0)
        from satellites.native.music.library import library_for
        self.music = library_for(self.engine)
        self.hub = self.music.connect
        self.track_ids = [track["id"] for track in self.run_json("music tracks")[1]["data"]["tracks"]]

    def register(self, device_id, name, online=True, remote=True, user="local"):
        self.hub.register(user, device_id, name, "mobile", capabilities={"play": True, "remote": remote})
        if not online:
            self.music.db.execute("UPDATE devices SET last_seen = 0 WHERE device_id = ?", (device_id,))

    def events_for(self, device_id):
        return [event for event in self.hub.events("local", device_id, 0, timeout=0)["events"]
                if event["type"] == "command"]

    def test_library_listing(self):
        code, payload = self.run_json("music stats")
        self.assertEqual(payload["data"]["tracks"], 2)
        self.assertIn("Orbit", self.run_line("music albums").stdout)
        self.assertEqual(self.run_json("music tracks 1")[1]["data"]["total"], 2)
        self.assertEqual(len(self.run_json("music tracks 1")[1]["data"]["tracks"]), 1)
        self.assertIn("Alpha", self.run_line("music list").stdout)
        self.assertEqual(self.run_line("music artists").exit_code, 0)
        self.assertFalse(self.run_json("music scan-status")[1]["data"]["running"])

    def test_likes(self):
        track = self.track_ids[0]
        self.assertEqual(self.run_line(f"music like {track}").exit_code, 0)
        self.assertEqual(self.run_json("music likes")[1]["data"]["items"][0]["id"], track)
        self.assertEqual(self.run_line("music like 0123456789abcdef").exit_code, spec.EXIT_NOT_FOUND)
        self.assertEqual(self.run_line("music like not-an-id").exit_code, spec.EXIT_USAGE)
        self.run_line(f"music unlike {track}")
        self.assertEqual(self.run_json("music likes")[1]["data"]["count"], 0)

    def test_playlist_operations(self):
        created = self.run_json('music playlist-create "Road trip" --description "for the car"')[1]["data"]
        self.assertEqual(self.run_line(f'music playlist-add "road trip" {" ".join(self.track_ids)}').exit_code, 0)
        shown = self.run_json(f"music playlist {created['id']}")[1]["data"]
        self.assertEqual(shown["track_count"], 2)
        entry = shown["tracks"][0]["entry_id"]
        self.assertEqual(self.run_line(f"music playlist-remove {created['id']} {entry}").exit_code, 0)
        self.assertEqual(self.run_json(f"music playlist {created['id']}")[1]["data"]["track_count"], 1)
        self.assertEqual(self.run_line("music playlist Nothing").exit_code, spec.EXIT_NOT_FOUND)
        self.assertEqual(self.run_line(f"music playlist-remove {created['id']} nope").exit_code,
                         spec.EXIT_NOT_FOUND)

    def test_devices_and_playback_targeting(self):
        self.register("phone-0001", "Pixel Phone")
        self.register("laptop-0001", "Laptop", online=False)

        code, payload = self.run_json("music devices")
        self.assertEqual({device["name"]: device["online"] for device in payload["data"]["devices"]},
                         {"Pixel Phone": True, "Laptop": False})

        self.assertEqual(self.run_line("music pause --device pixel").exit_code, 0)
        self.assertEqual(self.events_for("phone-0001")[-1]["command"], "pause")
        self.assertEqual(self.run_line("music next --device phone-0001").exit_code, 0)
        self.assertEqual(self.events_for("phone-0001")[-1]["command"], "next")
        self.assertEqual(self.run_line("music seek 1:30 --device Pixel").exit_code, 0)
        self.assertEqual(self.events_for("phone-0001")[-1]["arguments"], {"position": 90.0})
        self.assertEqual(self.events_for("laptop-0001"), [])

    def test_device_errors(self):
        self.register("phone-0001", "Pixel Phone")
        self.register("phone-0002", "Pixel Tablet")
        self.register("laptop-0001", "Laptop", online=False)
        self.register("speaker-001", "Speaker", remote=False)

        self.assertEqual(self.run_line("music pause --device Pixel").exit_code, spec.EXIT_USAGE)  # ambiguous
        self.assertEqual(self.run_line("music pause --device Toaster").exit_code, spec.EXIT_NOT_FOUND)
        offline = self.run_line("music pause --device Laptop")
        self.assertEqual(offline.exit_code, spec.EXIT_UNAVAILABLE)
        self.assertIn("offline", offline.stderr)
        unsupported = self.run_line("music pause --device Speaker")
        self.assertEqual(unsupported.exit_code, spec.EXIT_UNAVAILABLE)
        self.assertIn("remote control", unsupported.stderr)
        self.assertEqual(self.run_line("music seek 1:75 --device Laptop").exit_code, spec.EXIT_USAGE)
        self.assertEqual(self.run_line("music pause --wait 99").exit_code, spec.EXIT_USAGE)
        self.assertEqual(self.run_line('music pause --device ""').exit_code, spec.EXIT_USAGE)

    def test_the_active_device_is_the_default_target(self):
        self.register("phone-0001", "Pixel Phone")
        self.register("laptop-0001", "Laptop")
        self.hub.save_state("local", "laptop-0001", {"queue": self.track_ids, "playing": True, "position": 10})

        self.assertEqual(self.run_line("music pause").exit_code, 0)
        self.assertEqual(self.events_for("laptop-0001")[-1]["command"], "pause")
        playback = self.run_json("music playback")[1]["data"]
        self.assertEqual(playback["device"]["name"], "Laptop")
        self.assertEqual(playback["track"]["id"], self.track_ids[0])
        self.assertEqual(playback["queue_length"], 2)

    def test_wait_times_out_or_confirms(self):
        self.register("phone-0001", "Pixel Phone")

        started = time.monotonic()
        code, payload = self.run_json("music pause --device Pixel --wait 1")
        self.assertEqual(code, spec.EXIT_TIMEOUT)
        self.assertEqual(payload["error"]["code"], "timeout")
        self.assertLess(time.monotonic() - started, 5)

        def report():
            time.sleep(0.2)
            self.hub.save_state("local", "phone-0001", {"queue": self.track_ids, "playing": False})

        threading.Thread(target=report, daemon=True).start()
        code, payload = self.run_json("music pause --device Pixel --wait 5")
        self.assertEqual(code, 0)
        self.assertTrue(payload["data"]["confirmed"])

    def test_devices_belong_to_one_account(self):
        self.register("phone-0001", "Pixel Phone", user="someone-else")
        self.assertEqual(self.run_line("music pause --device Pixel").exit_code, spec.EXIT_UNAVAILABLE)
        self.assertEqual(self.run_json("music devices")[1]["data"]["devices"], [])

    def test_a_remote_console_can_control_playback(self):
        self.register("phone-0001", "Pixel Phone")
        self.assertEqual(self.run_line("music pause --device Pixel", runner.remote_context(self.engine)).exit_code, 0)
        self.assertEqual(self.events_for("phone-0001")[-1]["command"], "pause")


# ---------- the console API and the one-shot CLI ----------

class ConsoleAndBridgeTest(unittest.TestCase):
    def setUp(self):
        self.engine = start_engine(mission_control=True)
        if not self.engine.api.running:
            stop_engine(self.engine)
            raise unittest.SkipTest("Mission Control could not be started")
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-cli-bridge-"))
        isolate(self.engine, self.directory)
        self.engine.audit = AuditLog(self.directory / "audit.log")
        self.control = self.directory / "data" / bridge.CONTROL_FILE

    def tearDown(self):
        bridge.withdraw(self.engine)
        stop_engine(self.engine)
        shutil.rmtree(self.directory, ignore_errors=True)

    def post(self, path, payload, headers=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
        try:
            connection.request("POST", path, body=json.dumps(payload).encode("utf-8"),
                               headers={"Content-Type": "application/json", **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def test_console_execute_reports_exit_codes_and_refuses_terminal_only_commands(self):
        status, payload = self.post("/api/commands/execute", {"command": "music scan"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["exit_code"], spec.EXIT_DENIED)

        status, payload = self.post("/api/commands/execute", {"command": "engine status --json"})
        self.assertEqual(payload["exit_code"], 0)
        self.assertTrue(json.loads(payload["output"])["data"]["running"])

    def test_control_file_and_endpoint(self):
        path = bridge.publish(self.engine, self.control)
        record = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(record["url"], f"http://127.0.0.1:{self.engine.api.port}")
        self.assertEqual(record["token"], self.engine.control_token)

        status, payload = self.post(bridge.ENDPOINT, {"argv": ["engine", "status", "--json"]},
                                    {bridge.HEADER: record["token"]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["exit_code"], 0)
        self.assertTrue(json.loads(payload["stdout"])["data"]["running"])

        status, payload = self.post(bridge.ENDPOINT, {"argv": ["music", "scan"]}, {bridge.HEADER: record["token"]})
        self.assertEqual(payload["exit_code"], 0)  # the operator's CLI may run terminal-only commands

        status, payload = self.post(bridge.ENDPOINT, {"argv": ["satellites", "disable", "Status"]},
                                    {bridge.HEADER: record["token"]})
        self.assertEqual(payload["exit_code"], spec.EXIT_CONFIRMATION)
        self.assertTrue(payload["confirm"])

        self.assertEqual(self.post(bridge.ENDPOINT, {"argv": "engine status"}, {bridge.HEADER: record["token"]})[0], 400)

        bridge.withdraw(self.engine)
        self.assertFalse(path.exists())
        self.assertEqual(self.post(bridge.ENDPOINT, {"argv": ["engine"]}, {bridge.HEADER: record["token"]})[0], 403)

    def test_endpoint_refuses_anything_but_the_control_token(self):
        bridge.publish(self.engine, self.control)
        self.engine.auth = AuthStore(self.directory / "auth.json")
        session = self.engine.auth.bootstrap("admin", "a very good password")

        for headers in ({}, {bridge.HEADER: "guess"}, {"Authorization": f"Bearer {session}"},
                        {"Cookie": f"starcore_session={session}"}):
            with self.subTest(headers=list(headers)):
                status, _ = self.post(bridge.ENDPOINT, {"argv": ["engine", "status"]}, headers)
                self.assertEqual(status, 403)

    def test_only_this_machine_is_accepted(self):
        self.engine.control_token = "token"
        self.assertTrue(bridge.accepts(self.engine, "token", "127.0.0.1"))
        self.assertTrue(bridge.accepts(self.engine, "token", "::1"))
        self.assertFalse(bridge.accepts(self.engine, "token", "192.168.1.20"))
        self.assertFalse(bridge.accepts(self.engine, "wrong", "127.0.0.1"))
        self.engine.control_token = None
        self.assertFalse(bridge.accepts(self.engine, "", "127.0.0.1"))

    def test_one_shot_main_forwards_to_the_running_engine(self):
        bridge.publish(self.engine, self.control)
        stdout = io.StringIO()
        with mock.patch.object(bridge, "control_path", return_value=self.control), \
             mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", io.StringIO()), \
             mock.patch.object(bridge, "_interactive", return_value=False):
            code = bridge.main(["engine", "uptime", "--json"])
            refused = bridge.main(["satellites", "disable", "Status"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(stdout.getvalue())["data"]["running"])
        self.assertEqual(refused, spec.EXIT_CONFIRMATION)
        self.assertTrue(self.engine.registry.get("Status").enabled)

    def test_one_shot_main_runs_offline_when_nothing_is_running(self):
        offline = StarCore(self.directory / "offline-config.toml")
        offline.auth = AuthStore(self.directory / "offline-auth.json")
        offline.audit = AuditLog(self.directory / "offline-audit.log")
        stale = self.directory / "stale.json"
        stale.write_text(json.dumps({"url": "http://127.0.0.1:9", "token": "old"}), encoding="utf-8")
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(bridge, "control_path", return_value=stale), \
             mock.patch("starcore.core.StarCore", return_value=offline), \
             mock.patch.object(bridge, "_interactive", return_value=False), \
             mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", stderr):
            version = bridge.main(["engine", "version", "--json"])
            health = bridge.main(["engine", "health"])
        self.assertEqual(version, 0)
        self.assertIn('"starcore"', stdout.getvalue())
        self.assertEqual(health, spec.EXIT_UNAVAILABLE)
        self.assertIn("not running", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
