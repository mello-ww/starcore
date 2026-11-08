"""StarCore UI contract v1 on the Engine: the validator agrees with the shared
vocabulary and fixtures in contracts/ui/ (which Mission Control and the
Android app test against too), and the API serves documents, the catalog and
rediscovery - see docs/ui-contract.md.
"""

from http.client import HTTPConnection
from pathlib import Path
import json
import shutil
import sys
import tempfile
import unittest

from starcore import ui_contract
from starcore.api.payloads import describe_satellite
from tests.support import start_engine, stop_engine

REPO = Path(__file__).resolve().parents[2]
CONTRACT = REPO / "contracts" / "ui"
SHOWCASE = REPO / "examples" / "satellites" / "native" / "showcase"
PASSWORD = "a very good password"


def fixture(name):
    return json.loads((CONTRACT / "fixtures" / name).read_text(encoding="utf-8"))


def add_satellite(engine, path: Path, satellite_type="native"):
    """Loads one Satellite folder into a running engine, the way discovery would."""
    satellite = engine.loader._build_satellite(path, satellite_type)
    engine.registry.add(satellite)
    return satellite


def request(engine, path, method="GET", payload=None, headers=None, bearer=None):
    connection = HTTPConnection("127.0.0.1", engine.api.port, timeout=5)
    sent = dict(headers or {})
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        sent["Content-Type"] = "application/json"
    if bearer:
        sent["Authorization"] = f"Bearer {bearer}"
    try:
        connection.request(method, path, body=body, headers=sent)
        response = connection.getresponse()
        raw = response.read().decode("utf-8")
        parsed = json.loads(raw) if raw and response.getheader("Content-Type", "").startswith("application/json") else raw
        return response.status, parsed, dict(response.getheaders())
    finally:
        connection.close()


class VocabularyTest(unittest.TestCase):
    """The Engine's built-in copy of the vocabulary is the shared one."""

    @classmethod
    def setUpClass(cls):
        cls.vocabulary = json.loads((CONTRACT / "vocabulary.json").read_text(encoding="utf-8"))

    def test_version(self):
        self.assertEqual(self.vocabulary["contract"], ui_contract.CONTRACT_NAME)
        self.assertEqual(self.vocabulary["version"], f"{ui_contract.MAJOR}.{ui_contract.MINOR}")

    def test_blocks(self):
        shared = {name: (set(spec["required"]), set(spec["optional"]))
                  for name, spec in self.vocabulary["blocks"].items()}
        self.assertEqual(shared, ui_contract.BLOCKS)
        self.assertEqual(set(self.vocabulary["common_block_keys"]), ui_contract.COMMON_BLOCK_KEYS)

    def test_enumerations(self):
        for key, value in (("text_styles", ui_contract.TEXT_STYLES), ("button_styles", ui_contract.BUTTON_STYLES),
                           ("tones", ui_contract.TONES), ("formats", ui_contract.FORMATS),
                           ("form_field_kinds", ui_contract.FORM_FIELD_KINDS),
                           ("file_browser_select", ui_contract.FILE_BROWSER_SELECT),
                           ("action_then", ui_contract.ACTION_THEN), ("methods", ui_contract.METHODS),
                           ("icons", ui_contract.ICONS), ("chart_kinds", ui_contract.CHART_KINDS),
                           ("column_align", ui_contract.COLUMN_ALIGN), ("page_templates", ui_contract.PAGE_TEMPLATES)):
            self.assertEqual(set(self.vocabulary[key]), value, key)

    def test_capabilities_and_limits(self):
        shared = {name: set(spec["versions"]) for name, spec in self.vocabulary["satellite_capabilities"].items()}
        self.assertEqual(shared, {name: spec["versions"] for name, spec in ui_contract.SATELLITE_CAPABILITIES.items()})
        for name, spec in self.vocabulary["satellite_capabilities"].items():
            self.assertEqual(set(spec["operations"]), ui_contract.SATELLITE_CAPABILITIES[name]["operations"])
        self.assertEqual(self.vocabulary["limits"], ui_contract.LIMITS)


class FormatTest(unittest.TestCase):
    """format_value gives exactly what both clients give (formats.json)."""

    def test_formats(self):
        for case in fixture("formats.json")["cases"]:
            options = case.get("options", {})
            with self.subTest(case):
                self.assertEqual(ui_contract.format_value(case["value"], case.get("format", "text"), case.get("unit"),
                                                          now=options.get("now"), utc=options.get("utc", False)),
                                 case["expected"])

    def test_every_1_1_addition_is_in_the_vocabulary(self):
        since = ui_contract.SINCE_1_1
        self.assertLessEqual(set(since["blocks"]), set(ui_contract.BLOCKS))
        self.assertLessEqual(set(since["formats"]), ui_contract.FORMATS)


class DocumentFixturesTest(unittest.TestCase):
    def test_valid_documents_load(self):
        for case in fixture("documents.json")["valid"]:
            with self.subTest(case["name"]):
                self.assertEqual(ui_contract.validate(case["document"]), [])

    def test_invalid_documents_are_refused_with_a_reason(self):
        for case in fixture("documents.json")["invalid"]:
            with self.subTest(case["name"]):
                errors = ui_contract.validate(case["document"])
                self.assertTrue(errors, "accepted")
                self.assertIn(case["error"].lower(), " ".join(errors).lower())

    def test_route_safety(self):
        routes = fixture("routes.json")
        for route in routes["safe"]:
            self.assertTrue(ui_contract.is_safe_route(route), route)
        for route in routes["unsafe"]:
            self.assertFalse(ui_contract.is_safe_route(route), route)

    def test_the_showcase_document_is_valid(self):
        document = json.loads((SHOWCASE / "ui.json").read_text(encoding="utf-8"))
        self.assertEqual(ui_contract.validate(document), [])

    def test_revision_is_stable_and_content_based(self):
        document = {"contract": "starcore.ui/1.0", "entry": "a", "pages": {"a": {"blocks": []}}}
        reordered = {"pages": {"a": {"blocks": []}}, "entry": "a", "contract": "starcore.ui/1.0"}
        self.assertEqual(ui_contract.revision(document), ui_contract.revision(reordered))
        changed = {**document, "title": "x"}
        self.assertNotEqual(ui_contract.revision(document), ui_contract.revision(changed))

    def test_oversized_and_broken_files_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ui.json"
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaisesRegex(ui_contract.UiDocumentError, "not valid JSON"):
                ui_contract.load(path)
            path.write_text(" " * (ui_contract.LIMITS["document_bytes"] + 1), encoding="utf-8")
            with self.assertRaisesRegex(ui_contract.UiDocumentError, "larger"):
                ui_contract.load(path)


class ProvidesTest(unittest.TestCase):
    def test_a_complete_declaration_is_kept(self):
        provides, problems = ui_contract.normalise_provides(
            {"files.browse": {"version": 1, "operations": {"list": "entries"}}})
        self.assertEqual(problems, [])
        self.assertEqual(provides, {"files.browse": {"version": 1, "operations": {"list": "entries"}}})

    def test_an_unknown_capability_is_registered_as_declared(self):
        provides, problems = ui_contract.normalise_provides({"weather.forecast": {"operations": {"today": "today"}}})
        self.assertEqual(problems, [])
        self.assertIn("weather.forecast", provides)

    def test_a_broken_declaration_is_left_out(self):
        for broken in ({"files.browse": {"version": 1, "operations": {}}},
                       {"files.browse": {"version": 9, "operations": {"list": "entries"}}},
                       {"files.browse": {"operations": {"list": "/api/shutdown"}}},
                       {"files.browse": "yes"}):
            provides, problems = ui_contract.normalise_provides(broken)
            self.assertEqual(provides, {}, broken)
            self.assertTrue(problems, broken)

    AUDIO = {"search": "search", "track": "tracks", "resolve": "playback", "artwork": "artwork"}

    def test_audio_library_needs_its_four_operations_and_may_offer_lyrics(self):
        for operations in (self.AUDIO, {**self.AUDIO, "lyrics": "lyrics"}):
            provides, problems = ui_contract.normalise_provides(
                {"audio.library": {"version": 1, "operations": operations}})
            self.assertEqual(problems, [])
            self.assertEqual(provides["audio.library"]["operations"], operations)

    def test_a_broken_audio_library_is_left_out(self):
        without_resolve = {key: value for key, value in self.AUDIO.items() if key != "resolve"}
        for operations in (without_resolve,                           # a required operation missing
                           {**self.AUDIO, "download": "download"},     # one version 1 doesn't define
                           {**self.AUDIO, "lyrics": "../lyrics"},      # an optional one, malformed
                           {**self.AUDIO, "artwork": 3}):              # a route that isn't a string
            provides, problems = ui_contract.normalise_provides(
                {"audio.library": {"version": 1, "operations": operations}})
            self.assertEqual(provides, {}, operations)
            self.assertTrue(problems, operations)
        provides, problems = ui_contract.normalise_provides({"audio.library": {"version": 2, "operations": self.AUDIO}})
        self.assertEqual(provides, {})
        self.assertIn("version 2", problems[0])

    SESSION = {"queue": "queue", "history": "history", "radio": "radio", "preferences": "preferences",
               "favorites": "favorites", "stream": "stream", "connect": "connect"}

    def test_audio_session_needs_only_its_queue(self):
        for operations in ({"queue": "queue"}, self.SESSION):
            provides, problems = ui_contract.normalise_provides(
                {"audio.session": {"version": 1, "operations": operations}})
            self.assertEqual(problems, [])
            self.assertEqual(provides["audio.session"], {"version": 1, "operations": operations})

    def test_a_broken_audio_session_is_left_out(self):
        without_queue = {key: value for key, value in self.SESSION.items() if key != "queue"}
        for entry in ({"version": 1, "operations": without_queue},                          # incomplete
                      {"version": 1, "operations": {**self.SESSION, "lyrics": "lyrics"}},  # not a session operation
                      {"version": 1, "operations": {"queue": "queue", "connect": "/api/x"}},  # malformed route
                      {"version": 2, "operations": self.SESSION},                          # a version this Engine doesn't know
                      {"version": "1", "operations": self.SESSION}):                       # not an integer
            provides, problems = ui_contract.normalise_provides({"audio.session": entry})
            self.assertEqual(provides, {}, entry)
            self.assertTrue(problems, entry)
        # one broken capability doesn't take the Satellite's other ones with it
        provides, problems = ui_contract.normalise_provides(
            {"audio.library": {"version": 1, "operations": self.AUDIO},
             "audio.session": {"version": 1, "operations": without_queue}})
        self.assertEqual(list(provides), ["audio.library"])
        self.assertIn("missing operations ['queue']", problems[0])

    def test_the_media_audio_client_capability_replaces_the_old_reserved_name(self):
        reserved = ui_contract.VOCABULARY["client_capabilities"]["reserved"]
        self.assertIn("media.audio", reserved)
        self.assertNotIn("media.audio-playback", reserved)


class ShippedManifestsTest(unittest.TestCase):
    def test_every_icon_name_is_in_the_shared_set(self):
        import tomllib
        for path in [*REPO.glob("satellites/*/*/satellite.toml"), SHOWCASE / "satellite.toml"]:
            manifest = tomllib.loads(path.read_text(encoding="utf-8"))
            self.assertIn(manifest.get("icon_name"), ui_contract.ICONS, path)

    def test_every_declared_operation_is_one_of_the_providers_routes(self):
        """A shipped Satellite's [provides] maps each operation to a route its api.py
        really serves (the Engine only checks the shape: it never imports code to load
        a manifest)."""
        import importlib
        import tomllib
        for path in REPO.glob("satellites/*/*/satellite.toml"):
            manifest = tomllib.loads(path.read_text(encoding="utf-8"))
            provides, problems = ui_contract.normalise_provides(manifest.get("provides"))
            self.assertEqual(problems, [], path)
            if not provides:
                continue
            module = importlib.import_module(f"satellites.{path.parent.parent.name}.{path.parent.name}.api")
            routes = module.routes()
            for name, entry in provides.items():
                for operation, route in entry["operations"].items():
                    # an operation may name a path beneath a route (media/resolve): the route
                    # is its first segment, as the Engine dispatches it
                    self.assertIn(route.split("/")[0], routes, f"{path.parent.name}: {name}.{operation}")


class UiApiTest(unittest.TestCase):
    """A real engine with the Showcase example loaded beside the shipped Satellites."""

    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        cls.showcase = add_satellite(cls.engine, SHOWCASE)

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def test_the_satellite_entry_carries_its_definition(self):
        status, payload, _ = request(self.engine, "/api/satellites")
        self.assertEqual(status, 200)
        self.assertRegex(payload["catalog_revision"], r"^[0-9a-f]{16}$")
        entry = next(item for item in payload["satellites"] if item["name"] == "Showcase")
        self.assertEqual(entry["icon_name"], "layers")
        self.assertEqual(entry["ui"], {"contract": "starcore.ui/1.0", "revision": self.showcase.ui.revision,
                                       "error": None})
        explorer = next(item for item in payload["satellites"] if item["name"] == "FileExplorer")
        self.assertEqual(explorer["provides"]["files.browse"]["operations"], {"list": "entries"})
        self.assertIsNone(explorer["ui"])

    def test_the_document_is_served_with_its_revision_as_etag(self):
        status, payload, headers = request(self.engine, "/api/satellites/Showcase/ui")
        self.assertEqual(status, 200)
        self.assertEqual(payload["revision"], self.showcase.ui.revision)
        self.assertEqual(payload["document"]["entry"], "overview")
        self.assertEqual(headers["ETag"], f'"{self.showcase.ui.revision}"')
        self.assertEqual(headers["Cache-Control"], "no-cache")

        status, body, headers = request(self.engine, "/api/satellites/Showcase/ui",
                                        headers={"If-None-Match": f'"{self.showcase.ui.revision}"'})
        self.assertEqual(status, 304)
        self.assertEqual(body, "")
        status, _, _ = request(self.engine, "/api/satellites/Showcase/ui", headers={"If-None-Match": '"stale"'})
        self.assertEqual(status, 200)

    def test_a_satellite_without_a_document_answers_404(self):
        status, payload, _ = request(self.engine, "/api/satellites/Music/ui")
        self.assertEqual(status, 404)
        self.assertIn("no UI document", payload["error"])

    def test_ui_is_a_core_segment_and_read_only(self):
        status, _, _ = request(self.engine, "/api/satellites/Showcase/ui", method="POST", payload={})
        self.assertEqual(status, 405)

    def test_the_catalog_lists_capabilities_and_revalidates(self):
        status, payload, headers = request(self.engine, "/api/catalog")
        self.assertEqual(status, 200)
        self.assertEqual(payload["contract"]["name"], "starcore.ui")
        self.assertEqual(payload["contract"]["majors"], [1])
        providers = payload["capabilities"]["files.browse"]
        self.assertEqual(providers[0]["satellite"], "FileExplorer")
        self.assertEqual(providers[0]["operations"], {"list": "entries"})
        self.assertEqual(payload["contract"]["capabilities"]["audio.library"], [1])
        self.assertEqual(payload["contract"]["capabilities"]["audio.session"], [1])
        session = payload["capabilities"]["audio.session"]
        self.assertEqual([provider["satellite"] for provider in session], ["Music"])
        self.assertEqual(session[0]["version"], 1)
        self.assertEqual(session[0]["operations"]["queue"], "queue")
        self.assertEqual(set(session[0]["operations"]),
                         {"queue", "history", "radio", "preferences", "favorites", "stream", "connect"})
        audio = payload["capabilities"]["audio.library"]
        self.assertEqual([provider["satellite"] for provider in audio], ["Music"])
        self.assertEqual(audio[0]["version"], 1)
        self.assertEqual(audio[0]["operations"], {"search": "search", "track": "tracks", "resolve": "playback",
                                                  "artwork": "artwork", "lyrics": "lyrics"})
        status, _, _ = request(self.engine, "/api/catalog", headers={"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)

    def test_catalog_revision_ignores_live_state_but_not_definitions(self):
        from starcore.api.payloads import catalog_revision
        before = catalog_revision(self.engine)
        self.assertEqual(before, catalog_revision(self.engine))
        self.showcase.manifest.icon_name = "star"
        try:
            self.assertNotEqual(before, catalog_revision(self.engine))
        finally:
            self.showcase.manifest.icon_name = "layers"
        self.assertEqual(before, catalog_revision(self.engine))

    def test_rediscover_needs_post(self):
        status, _, _ = request(self.engine, "/api/catalog/rediscover")
        self.assertEqual(status, 405)

    def test_assets_and_frontend_revalidate_instead_of_redownloading(self):
        for path in ("/app.js", "/api/satellites/Status/assets/page.js"):
            status, _, headers = request(self.engine, path)
            self.assertEqual(status, 200, path)
            self.assertEqual(headers["Cache-Control"], "no-cache")
            status, body, _ = request(self.engine, path, headers={"If-None-Match": headers["ETag"]})
            self.assertEqual(status, 304, path)
            self.assertEqual(body, "")


PLAY_CONSUMER_UI = {
    "contract": "starcore.ui/1.2",
    "requires": {"client": ["media.audio"], "capabilities": ["audio.library"]},
    "entry": "home",
    "pages": {"home": {"source": {"route": "searches"}, "blocks": [
        {"type": "list", "items": "$.searches", "item": {"title": "$.name"}, "action": {"play": {"search": "$.search"}}},
        {"type": "button", "label": "Play", "action": {"play": {"search": "$.searches.0.search"}}},
    ]}},
}


class PlayActionConsumerTest(unittest.TestCase):
    """A second consumer of the audio capabilities, built here in a temporary folder: a
    Satellite whose interface plays from whichever Satellite provides audio.library with the
    play action (contract 1.2), without naming one (docs/media-audio.md)."""

    @classmethod
    def setUpClass(cls):
        cls.directory = Path(tempfile.mkdtemp(prefix="starcore-play-"))
        folder = cls.directory / "consumer"
        folder.mkdir()
        (folder / "satellite.toml").write_text(
            'name = "PlayConsumer"\nversion = "1.0.0"\nauthor = "tests"\ndescription = "Plays through the client."\n'
            'icon_name = "music"\n', encoding="utf-8")
        (folder / "api.py").write_text(
            "from starcore.api.response import json_response\n\n\n"
            "def routes():\n    return {'searches': lambda request: json_response("
            "{'searches': [{'name': 'Tide', 'search': 'tide'}]})}\n", encoding="utf-8")
        (folder / "ui.json").write_text(json.dumps(PLAY_CONSUMER_UI), encoding="utf-8")
        cls.engine = start_engine(mission_control=True)
        cls.consumer = add_satellite(cls.engine, folder)

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)
        shutil.rmtree(cls.directory, ignore_errors=True)

    def test_a_document_that_plays_is_accepted_and_served(self):
        self.assertIsNone(self.consumer.ui.error)
        status, payload, _ = request(self.engine, "/api/satellites/PlayConsumer/ui")
        self.assertEqual(status, 200)
        self.assertEqual(payload["document"]["contract"], "starcore.ui/1.2")
        self.assertEqual(payload["document"]["requires"], {"client": ["media.audio"], "capabilities": ["audio.library"]})
        status, data, _ = request(self.engine, "/api/satellites/PlayConsumer/searches")
        self.assertEqual((status, data["searches"][0]["search"]), (200, "tide"))

    def test_the_catalog_offers_the_audio_library_it_plays_from(self):
        _, catalog, _ = request(self.engine, "/api/catalog")
        self.assertEqual(catalog["contract"]["version"], f"{ui_contract.MAJOR}.{ui_contract.MINOR}")
        self.assertTrue(any(provider["enabled"] for provider in catalog["capabilities"]["audio.library"]))
        self.assertNotIn("PlayConsumer", [provider["satellite"] for providers in catalog["capabilities"].values()
                                          for provider in providers])

    def test_the_same_document_declaring_1_1_is_refused(self):
        document = {**PLAY_CONSUMER_UI, "contract": "starcore.ui/1.1"}
        errors = ui_contract.validate(document)
        self.assertTrue(any("needs starcore.ui/1.2" in error for error in errors), errors)


class ShowcaseRoutesTest(unittest.TestCase):
    """The routes the Showcase document binds to, exercised the way a client
    acts on them: every action is an ordinary, validated Satellite route."""

    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        add_satellite(cls.engine, SHOWCASE)

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        request(self.engine, "/api/satellites/Showcase/reset", method="POST", payload={})

    def call(self, route, payload=None):
        method = "GET" if payload is None else "POST"
        return request(self.engine, f"/api/satellites/Showcase/{route}", method=method, payload=payload)[:2]

    def test_controls_change_the_summary(self):
        self.assertEqual(self.call("settings", {"level": 75})[0], 200)
        self.assertEqual(self.call("counter/increment", {})[0], 200)
        _, summary = self.call("summary")
        self.assertEqual(summary["level"], 75)
        self.assertEqual(summary["counter"], 1)

    def test_the_route_enforces_what_the_document_only_hides(self):
        self.call("settings", {"enabled": False})
        status, payload = self.call("counter/increment", {})
        self.assertEqual(status, 409)
        self.assertEqual(self.call("settings", {"level": 500})[0], 400)

    def test_item_lifecycle(self):
        status, added = self.call("items", {"title": "Notes", "size": "medium", "copies": 2, "pinned": True})
        self.assertEqual(status, 200)
        _, item = self.call(f"items/{added['id']}")
        self.assertEqual((item["title"], item["size"], item["icon"]), ("Notes", 5 * 1024 * 1024, "star"))
        self.assertEqual(self.call(f"items/{added['id']}/priority", {"priority": 5})[0], 200)
        self.assertEqual(self.call(f"items/{added['id']}/delete", {})[0], 200)
        self.assertEqual(self.call(f"items/{added['id']}")[0], 404)
        self.assertEqual(self.call("items", {"title": " "})[0], 400)


class RediscoverTest(unittest.TestCase):
    """Rediscovery refreshes metadata from disk and never imports code."""

    def setUp(self):
        self.engine = start_engine(mission_control=True)
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-rediscover-"))
        self.native = self.directory / "native"
        self.native.mkdir()
        self.copy = self.native / "showcase"
        shutil.copytree(SHOWCASE, self.copy, ignore=shutil.ignore_patterns("__pycache__"))
        self.showcase = add_satellite(self.engine, self.copy)
        self.engine.native_path = self.native
        self.engine.link_path = self.directory / "link"

    def tearDown(self):
        stop_engine(self.engine)
        shutil.rmtree(self.directory, ignore_errors=True)

    def rediscover(self, bearer=None):
        status, payload, _ = request(self.engine, "/api/catalog/rediscover", method="POST", payload={}, bearer=bearer)
        self.assertEqual(status, 200, payload)
        return payload

    def test_nothing_changed(self):
        payload = self.rediscover()
        self.assertEqual((payload["updated"], payload["pending"], payload["missing"]), ([], [], []))

    def test_an_edited_document_is_picked_up_without_a_reload(self):
        routes_before = self.showcase.routes
        path = self.copy / "ui.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        document["title"] = "Showcase, edited"
        path.write_text(json.dumps(document), encoding="utf-8")

        payload = self.rediscover()
        self.assertEqual(payload["updated"], ["Showcase"])
        _, served, _ = request(self.engine, "/api/satellites/Showcase/ui")
        self.assertEqual(served["document"]["title"], "Showcase, edited")
        # the same Satellite object and the same imported routes - no reload
        self.assertIs(self.engine.registry.get("Showcase"), self.showcase)
        self.assertIs(self.showcase.routes, routes_before)

    def test_a_broken_document_is_reported_not_served(self):
        (self.copy / "ui.json").write_text('{"contract": "starcore.ui/1.0", "entry": "x", "pages": {}}',
                                           encoding="utf-8")
        self.rediscover()
        status, payload, _ = request(self.engine, "/api/satellites/Showcase/ui")
        self.assertEqual(status, 422)
        self.assertIn("pages", payload["error"])
        entry = describe_satellite(self.engine, self.showcase)
        self.assertIsNone(entry["ui"]["revision"])
        self.assertIn("pages", entry["ui"]["error"])

    def test_a_new_folder_is_pending_and_its_code_never_runs(self):
        newcomer = self.native / "newcomer"
        newcomer.mkdir()
        (newcomer / "satellite.toml").write_text(
            'name = "Newcomer"\nversion = "1.0.0"\nauthor = "tests"\ndescription = "New."\n', encoding="utf-8")
        marker = self.directory / "imported.txt"
        (newcomer / "api.py").write_text(
            f"open({str(marker)!r}, 'w').write('imported')\ndef routes():\n    return {{}}\n", encoding="utf-8")

        payload = self.rediscover()
        self.assertEqual(payload["pending"], [{"name": "Newcomer", "type": "native", "folder": "newcomer"}])
        self.assertIsNone(self.engine.registry.get("Newcomer"))
        self.assertFalse(marker.exists())
        self.assertFalse(any(name.endswith(".newcomer") or ".newcomer." in name for name in sys.modules))
        _, catalog, _ = request(self.engine, "/api/catalog")
        self.assertEqual(catalog["pending"][0]["name"], "Newcomer")

    def test_any_satellite_can_provide_audio_library(self):
        """The registry knows capabilities, not Satellites: another Satellite declaring
        audio.library is listed beside Music, in discovery order."""
        manifest = self.copy / "satellite.toml"
        manifest.write_text(manifest.read_text(encoding="utf-8") + (
            '\n[provides."audio.library"]\nversion = 1\n'
            'operations = { search = "summary", track = "summary", resolve = "summary", artwork = "summary" }\n'),
            encoding="utf-8")
        payload = self.rediscover()
        self.assertIn("Showcase", payload["updated"])
        _, catalog, _ = request(self.engine, "/api/catalog")
        providers = {provider["satellite"]: provider for provider in catalog["capabilities"]["audio.library"]}
        self.assertIn("Showcase", providers)
        self.assertNotIn("lyrics", providers["Showcase"]["operations"])

    def test_a_version_change_asks_for_a_reload(self):
        manifest = self.copy / "satellite.toml"
        manifest.write_text(manifest.read_text(encoding="utf-8").replace('version = "1.0.0"', 'version = "1.1.0"'),
                            encoding="utf-8")
        payload = self.rediscover()
        self.assertEqual(payload["reload_required"], ["Showcase"])

    def test_a_removed_folder_is_reported_and_keeps_running(self):
        shutil.rmtree(self.copy)
        payload = self.rediscover()
        self.assertEqual(payload["missing"], ["Showcase"])
        status, _, _ = request(self.engine, "/api/satellites/Showcase/summary")
        self.assertEqual(status, 200)

    def test_rediscover_requires_a_session_once_bootstrapped(self):
        token = self.engine.auth.bootstrap("admin", PASSWORD)
        status, _, _ = request(self.engine, "/api/catalog/rediscover", method="POST", payload={})
        self.assertEqual(status, 401)
        self.rediscover(bearer=token)


if __name__ == "__main__":
    unittest.main()
