"""StarCore UI contract v1 (1.1) - the Engine's side.

A Satellite describes its interface in a static `ui.json` next to its
`satellite.toml`: pages, blocks, data bindings and actions, from the closed
vocabulary in contracts/ui/vocabulary.json (see docs/ui-contract.md). Mission
Control and the Android app each render it with their own components.

The Engine never renders anything. It only:

- validates a document when a Satellite is loaded or rediscovered, so a
  broken or unsafe one is refused here with a readable error instead of
  reaching a client,
- gives it a content revision, so clients can cache it and revalidate with
  an ETag,
- keeps the registry of Satellite capabilities (`provides` in a manifest)
  that shared blocks such as `file-browser` are bound to,
- formats values exactly as the clients do (`format_value`), so a Satellite
  can build a composite line of text ("8 GB of 16 GB") that reads like the
  values the clients format themselves.

A document is presentation only. It grants nothing: every route it names is
an ordinary Satellite route, with the same authentication as any other.
Reading `ui.json` never imports or runs Python, which is why rediscovery can
refresh it safely without reloading a Satellite's code.
"""

from hashlib import sha256
from pathlib import Path
import json
import math
import re
import time

CONTRACT_NAME = "starcore.ui"
MAJOR = 1
MINOR = 2
UI_FILENAME = "ui.json"

VOCABULARY_PATH = Path(__file__).resolve().parents[2] / "contracts" / "ui" / "vocabulary.json"



def _load_vocabulary() -> dict:
    """contracts/ui/vocabulary.json - the one list of blocks, formats, icons
    and capabilities the Engine and both clients share (each client's tests
    check it implements exactly this). Shipped with every checkout, the
    same way the VERSION file is."""
    with open(VOCABULARY_PATH, encoding="utf-8") as file:
        return json.load(file)


VOCABULARY = _load_vocabulary()
BLOCKS = {name: (set(spec["required"]), set(spec["optional"])) for name, spec in VOCABULARY["blocks"].items()}
COMMON_BLOCK_KEYS = set(VOCABULARY["common_block_keys"])
TEXT_STYLES = set(VOCABULARY["text_styles"])
BUTTON_STYLES = set(VOCABULARY["button_styles"])
TONES = set(VOCABULARY["tones"])
FORMATS = set(VOCABULARY["formats"])
FORM_FIELD_KINDS = set(VOCABULARY["form_field_kinds"])
# what a protected document's action may ask the client to prompt for (1.2): never a form field
SECRET_KINDS = set(VOCABULARY["secret_kinds"])
FILE_BROWSER_SELECT = set(VOCABULARY["file_browser_select"])
ACTION_THEN = set(VOCABULARY["action_then"])
METHODS = set(VOCABULARY["methods"])
ICONS = set(VOCABULARY["icons"])
# a Satellite's own icon (1.2, engine/starcore/icons.py): its name, never a shared one's, and the
# path data the Engine turns its file into - absolute M, L, C and Z only, which is all a client draws
OWN_ICON_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")
_ICON_NUMBER = r"-?\d+(?:\.\d+)?"
_ICON_PAIR = f"{_ICON_NUMBER} {_ICON_NUMBER}"
ICON_PATH = re.compile(rf"M{_ICON_PAIR}(?:[ML]{_ICON_PAIR}|C{_ICON_PAIR} {_ICON_PAIR} {_ICON_PAIR}|Z)*")
CHART_KINDS = set(VOCABULARY["chart_kinds"])
COLUMN_ALIGN = set(VOCABULARY["column_align"])
PAGE_TEMPLATES = set(VOCABULARY["page_templates"])
DOCUMENT_LAYOUTS = set(VOCABULARY["document_layouts"])
# what arrived in 1.1: a document declaring 1.0 may not use it, so that a
# document always says which minor it needs (clients that know only 1.0
# skip a newer document's unknown blocks; a 1.0 one must not have any)
SINCE_1_1 = VOCABULARY["since"]["1.1"]
BLOCKS_1_1 = set(SINCE_1_1["blocks"])
# the minor each later block arrived in: a document declaring an older one may not use it
BLOCK_SINCE = {block: int(minor.split(".")[1]) for minor, added in VOCABULARY["since"].items()
               if not minor.startswith("_") for block in added.get("blocks", [])}
IMAGE_SIZES = set(VOCABULARY["image_sizes"])
IMAGE_SHAPES = set(VOCABULARY["image_shapes"])
IMAGE_FITS = set(VOCABULARY["image_fits"])
MEDIA_KINDS = set(VOCABULARY["media_kinds"])
MEDIA_GRID_ITEM_KEYS = set(VOCABULARY["media_grid_item_keys"])
MEDIA_GRID_LAYOUTS = set(VOCABULARY["media_grid_layouts"])
MEDIA_LIST_ITEM_KEYS = set(VOCABULARY["media_list_item_keys"])
MEDIA_VIEWER_KEYS = set(VOCABULARY["media_viewer_keys"])
MAP_ITEM_KEYS = set(VOCABULARY["map_item_keys"])
# capabilities the client's media picker can choose from (the pick action)
PICKABLE = {"media.gallery"}
# what the secure action may run (1.2): {capability: {operations}}, and the capability whose
# items it acts on - the document's own Satellite must provide it
SECURE_OPERATIONS = {name: set(operations) for name, operations in VOCABULARY["secure_operations"].items()
                     if not name.startswith("_")}
SECURE_ITEMS = "media.gallery"
# the play action (1.2): where its tracks come from, and how they join the queue
PLAY_SOURCES = ("search", "tracks", "route")
PLAY_QUEUE = {"next", "end"}
AUDIO_LIBRARY = "audio.library"
# what the sync action may open (1.2): {Satellite capability: the client capability whose screen
# it opens} - the document's own Satellite must provide it
SYNC_CAPABILITIES = {name: client for name, client in VOCABULARY["sync_capabilities"].items()
                     if not name.startswith("_")}
# what a route action's `reloads` and a page's `follows` may name (1.2, change 9): {Satellite
# capability: what a client keeps from it} - the document's own Satellite must provide it
RELOADABLE_CAPABILITIES = {name: kept for name, kept in VOCABULARY["reloadable_capabilities"].items()
                           if not name.startswith("_")}
# the bindings an `audio` section (1.2) may use: the playing track, and a choose's row
AUDIO_BINDINGS = ("$page", "$params", "$form", "$state", "$sources")
# a section of a Satellite's own interface, for the own action (1.2)
OWN_SECTION = re.compile(r"[a-z][a-z0-9-]{0,31}")
# a Satellite's name, for the section action (1.2)
SATELLITE_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}")
# what a protected document (1.2) may name, and the operations its provider - the document's own
# Satellite - must offer for a client to show it: {capability: {operations}}
PROTECTED_CAPABILITIES = {name: set(operations) for name, operations in VOCABULARY["protected_capabilities"].items()
                          if not name.startswith("_")}
FORMATS_1_1 = set(SINCE_1_1["formats"])
# Satellite capabilities with a protocol this Engine knows: their versions, the
# operations every provider must offer and those it may. A Satellite may also
# declare a capability that isn't listed (the registry reports it as declared).
# Clients draw a shared block only for the capabilities they list themselves.
# device_credentials: whether the Engine issues a device credential limited to it
# (POST /api/auth/devices).
SATELLITE_CAPABILITIES = {name: {"versions": set(spec["versions"]), "operations": set(spec["operations"]),
                                 "optional": set(spec.get("optional_operations", {})),
                                 "device_credentials": spec.get("device_credentials") is True,
                                 "declares": set(spec.get("declares", {}))}
                          for name, spec in VOCABULARY["satellite_capabilities"].items()}
# what a files.open provider's types cover (change 16): {kind: extensions}
FILE_KINDS = {kind: tuple(extensions) for kind, extensions in VOCABULARY["file_kinds"].items()
              if not kind.startswith("_")}
FILE_EXTENSION = re.compile(r"\.[a-z0-9]{1,10}")
OPENER_LABEL_LIMIT = 40
# the shared block bound to each capability
CAPABILITY_BLOCKS = {"file-browser": "files.browse"}
LIMITS = dict(VOCABULARY["limits"])
CLIENT_CAPABILITIES = set(VOCABULARY["client_capabilities"]["reserved"])

# segments the Core itself owns beneath every /api/satellites/<name>/ (see
# api/server.py) - a document can never point an action at them
RESERVED_SEGMENTS = {"assets", "enable", "disable", "reload", "ui"}

CONTRACT_PATTERN = re.compile(r"^starcore\.ui/(\d+)\.(\d+)$")
PAGE_ID = re.compile(r"^[a-z][a-z0-9_-]{0,47}$")
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,47}$")
# an offline page's omit list (1.2), and the {binding} placeholders of a template
OFFLINE_OMIT_LIMIT = 32
TEMPLATE_PLACEHOLDER = re.compile(r"\{([^{}]*)\}")
FIRST_SEGMENT = re.compile(r"^[A-Za-z0-9_-]+$")
SEGMENT = re.compile(r"^[A-Za-z0-9_.~%-]+$")
QUERY = re.compile(r"^[A-Za-z0-9_.~%&=+-]*$")
PLACEHOLDER = re.compile(r"\{([^{}]*)\}")
# a viewer field's link (change 15): its scheme and host are fixed, before any binding, and it
# holds no space or backslash a browser would read its own way
HREF_START = re.compile(r"^https?://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?/[^\s\\]*$")
BINDING_ROOTS = ("$.", "$page.", "$params.", "$form.", "$state.", "$sources.", "$value.")
BINDING_WORDS = {"$", "$value", "$page", "$params", "$form", "$state", "$sources"}


def paged_lists(blocks) -> list:
    """The `list` and `media-list` blocks of a page that load further pages (`more`), also
    inside a card."""
    found = []
    for block in blocks or []:
        if isinstance(block, dict):
            if block.get("type") in ("list", "media-list") and "more" in block:
                found.append(block)
            found += paged_lists(block.get("blocks"))
    return found


def choice_keys(blocks) -> set:
    """The state keys a page's `choice` blocks set, also inside a card."""
    keys = set()
    for block in blocks or []:
        if isinstance(block, dict):
            if block.get("type") == "choice" and isinstance(block.get("key"), str):
                keys.add(block["key"])
            keys |= choice_keys(block.get("blocks"))
    return keys


class UiDocumentError(ValueError):
    """A ui.json that can't be served - unreadable, invalid JSON, or invalid."""


def parse_contract(value):
    """(major, minor) for a "starcore.ui/<major>.<minor>" string, else None."""
    if not isinstance(value, str):
        return None
    match = CONTRACT_PATTERN.match(value)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def is_safe_route(route) -> bool:
    """True for a resolved route a client may call beneath a Satellite.

    Relative only (no leading "/", no scheme, no "..", no empty or "."
    segment), never one of the Core's own segments (assets, lifecycle
    controls, ui), and made only of URL-safe characters - so a document can
    never reach another Satellite, a Core endpoint or another host.
    """
    if not isinstance(route, str) or not route:
        return False
    path, _, query = route.partition("?")
    if "?" in route and not QUERY.match(query):
        return False
    segments = path.split("/")
    if not FIRST_SEGMENT.match(segments[0]) or segments[0] in RESERVED_SEGMENTS:
        return False
    for segment in segments[1:]:
        if segment in ("", ".", "..") or not SEGMENT.match(segment):
            return False
    return True


def is_binding(value) -> bool:
    return isinstance(value, str) and value.startswith("$") and not value.startswith("$$")


def valid_binding(value: str) -> bool:
    return value in BINDING_WORDS or value.startswith(BINDING_ROOTS)


def valid_icon_path(value) -> bool:
    """True for one path of a Satellite's own icon as the Engine serves it."""
    return isinstance(value, str) and len(value) <= LIMITS["icon_bytes"] and ICON_PATH.fullmatch(value) is not None


def revision(document) -> str:
    """A content hash of a document: the same document always gets the same
    revision, so it doubles as its ETag and as the cache key on clients."""
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256(canonical.encode("utf-8")).hexdigest()[:16]


def load(path: Path, provides=None, icons=None) -> dict:
    """Reads and validates one ui.json (with the Satellite's declared capabilities, when
    known), with the Satellite's own icons added under `icons`. Raises UiDocumentError."""
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise UiDocumentError(f"could not be read ({error.strerror or error})")
    if len(raw) > LIMITS["document_bytes"]:
        raise UiDocumentError(f"is larger than {LIMITS['document_bytes'] // 1024} KB")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UiDocumentError(f"is not valid JSON ({error})")
    if isinstance(document, dict):
        if "icons" in document:
            raise UiDocumentError("is invalid: icons: a Satellite declares its own icons in satellite.toml "
                                  "([icons]); the Engine adds them to the document it serves")
        if icons:
            document["icons"] = icons
    errors = validate(document, provides)
    if errors:
        more = f" (and {len(errors) - 1} more)" if len(errors) > 1 else ""
        raise UiDocumentError(f"is invalid: {errors[0]}{more}")
    return document


def validate(document, provides=None) -> list:
    """Every problem with a document, as "where: what" strings; [] if valid. `provides` is the
    Satellite's declared capabilities when known (at load), for the rules that depend on them."""
    return _Validator(document, provides).run()


class _Validator:
    def __init__(self, document, provides=None):
        self.document = document
        # the capabilities the document's Satellite declares, or None when not known - with
        # their operations when given as its [provides] table
        self.provides = None if provides is None else set(provides)
        self.provided = provides if isinstance(provides, dict) else {}
        # a protected document (1.2): it keeps nothing, so no offline page, widget or share
        self.protected = False
        self.in_media_actions = False
        self.in_bulk = False  # a selection's or a tile's quick actions: no download or share there
        self.in_selection = False  # a selection's actions: no play there
        self.in_row = False  # a row's or a tile's quick and menu entries: `then: update` there
        self.in_audio = False  # the document's `audio` section: no page, only the playing track
        self.errors = []
        self.lenient = False  # a newer minor: unknown blocks and keys are skipped by clients
        self.minor = MINOR
        self.pages = {}
        # what the blocks being checked can bind to: the page's declared
        # state keys and named sources (the header's and each widget's own
        # scope declare neither)
        self.state_keys = set()
        self.source_names = set()
        # the icon names the document may use: the shared set and its Satellite's own (1.2)
        self.icons = ICONS

    def since(self, where: str, what: str, minor: int = 1):
        """`what` arrived in 1.`minor`: refused in a document that declares an older minor."""
        if self.minor < minor:
            self.error(where, f"{what} needs {CONTRACT_NAME}/1.{minor} or later (the document declares 1.{self.minor})")

    def error(self, where: str, message: str):
        self.errors.append(f"{where}: {message}" if where else message)

    def run(self) -> list:
        document = self.document
        if not isinstance(document, dict):
            self.error("", "the document must be an object")
            return self.errors

        version = parse_contract(document.get("contract"))
        if version is None:
            self.error("contract", f"must be \"{CONTRACT_NAME}/<major>.<minor>\"")
            return self.errors
        if version[0] != MAJOR:
            self.error("contract", f"{document['contract']} is not supported (this Engine knows {CONTRACT_NAME}/{MAJOR}.x)")
            return self.errors
        self.lenient = version[1] > MINOR
        self.minor = version[1]

        known = {"contract", "title", "requires", "entry", "navigation", "pages", "header", "widgets", "preview",
                 "protected", "icons", "audio", "layout"}
        self.unknown_keys("", document, known)
        if "layout" in document:
            # 1.2 (change 13): where the navigation sits, tabs above the page or a sidebar
            self.since("layout", "a document layout", 2)
            if document["layout"] not in DOCUMENT_LAYOUTS:
                self.error("layout", f"must be one of {sorted(DOCUMENT_LAYOUTS)}")
        if "icons" in document:
            self.check_icons(document["icons"])
        if "title" in document and not isinstance(document["title"], str):
            self.error("title", "must be a string")
        if "preview" in document:
            # 1.2: the document doesn't replace the Satellite's own interface yet - a client
            # that has one keeps opening it, and offers this one in Developer Mode
            self.since("preview", "a preview document", 2)
            if not isinstance(document["preview"], bool):
                self.error("preview", "must be true or false")
        self.check_requires(document.get("requires"))

        pages = document.get("pages")
        if not isinstance(pages, dict) or not pages:
            self.error("pages", "must be an object with at least one page")
            return self.errors
        if len(pages) > LIMITS["pages"]:
            self.error("pages", f"at most {LIMITS['pages']} pages")
        self.pages = pages
        for page_id in pages:
            if not PAGE_ID.match(page_id):
                self.error(f"pages.{page_id}", "page id must be lower case letters, digits, '-' or '_'")

        entry = document.get("entry")
        if entry not in pages:
            self.error("entry", f"must name one of the pages (got {entry!r})")
        elif self.page_params(entry):
            self.error("entry", "the entry page cannot require params")

        navigation = document.get("navigation", [])
        if not isinstance(navigation, list):
            self.error("navigation", "must be a list")
            navigation = []
        for index, item in enumerate(navigation):
            where = f"navigation[{index}]"
            if not isinstance(item, dict):
                self.error(where, "must be an object")
                continue
            self.unknown_keys(where, item, {"page", "label", "icon", "developer"})
            if "developer" in item:
                self.since(f"{where}.developer", "a developer-only navigation item")
                if not isinstance(item["developer"], bool):
                    self.error(f"{where}.developer", "must be true or false")
            if item.get("page") not in pages:
                self.error(where, f"unknown page {item.get('page')!r}")
            elif self.page_params(item["page"]):
                self.error(where, "a navigation page cannot require params")
            if not isinstance(item.get("label"), str) or not item["label"]:
                self.error(where, "needs a label")
            if "icon" in item and item["icon"] not in self.icons:
                self.error(where, f"unknown icon {item['icon']!r}")

        if "protected" in document:
            self.check_protected(document["protected"])
        for page_id, page in pages.items():
            self.check_page(f"pages.{page_id}", page)
        if "header" in document:
            self.check_header(document["header"])
        if "audio" in document:
            self.check_audio(document["audio"])
        if "widgets" in document:
            if self.protected:
                self.error("widgets", "a protected document has no widgets: nothing of it is shown outside it")
            self.check_widgets(document["widgets"])
        return self.errors

    def check_audio(self, audio):
        """audio: {menu?, album?, artist?, library?} (1.2, change 9): what a client's audio host
        adds to its player while it plays from this Satellite, with the playing track (as the
        audio.library provider's `track` operation answers it) as $. - `menu` after the host's own
        entries in the player's More, `album` and `artist` (navigate actions) on the player's title
        and artist, `library` ({label, action}) as the host's way to the Satellite's pages. The
        host runs them without a page: navigate, play, choose or a route action, no `then`, and no
        binding but $. (and a choose's $value)."""
        where = "audio"
        self.since(where, "the audio section", 2)
        if not isinstance(audio, dict) or not audio:
            self.error(where, "must be an object with menu, album, artist or library")
            return
        self.unknown_keys(where, audio, {"menu", "album", "artist", "library"})
        if self.protected:
            self.error(where, "a protected document adds nothing to the player: nothing of it is shown outside it")
        if self.provides is not None and AUDIO_LIBRARY not in self.provides:
            self.error(where, f"adds to the player while it plays this Satellite's tracks, and it provides no {AUDIO_LIBRARY}")
        self.state_keys, self.source_names = set(), set()
        self.in_audio = True
        try:
            if "menu" in audio:
                menu = audio["menu"]
                self.check_media_actions(f"{where}.menu", menu, LIMITS["menu_entries"], required=True,
                                         secure=False)
                for index, entry in enumerate(menu if isinstance(menu, list) else []):
                    if isinstance(entry, dict):
                        if "style" in entry:
                            self.error(f"{where}.menu[{index}].style", "a player's entry has no style")
                        self.check_audio_action(f"{where}.menu[{index}].action", entry.get("action"))
            for key in ("album", "artist"):
                if key in audio:
                    self.check_audio_link(f"{where}.{key}", audio[key])
            if "library" in audio:
                library = audio["library"]
                if not isinstance(library, dict):
                    self.error(f"{where}.library", "must be {label, action}")
                else:
                    self.unknown_keys(f"{where}.library", library, {"label", "action"})
                    if not isinstance(library.get("label"), str) or not library["label"]:
                        self.error(f"{where}.library.label", "needs a label")
                    self.check_audio_link(f"{where}.library.action", library.get("action"))
        finally:
            self.in_audio = False

    def check_audio_link(self, where: str, action):
        if not isinstance(action, dict) or "navigate" not in action:
            self.error(where, "must be a navigate action")
            return
        self.check_action(where, action)

    def check_audio_action(self, where: str, action):
        """What a player's menu entry may run: navigate, play, choose, locate (change 18) or a
        route action (no pick, secrets or reveal), never with `then` - there is no page to
        refresh or go back from."""
        if not isinstance(action, dict):
            return
        kinds = {"navigate", "play", "choose", "locate"}
        others = {"own", "secure", "section", "sync", "offline", "download", "share", "upload", "pick", "secrets", "reveal"}
        if not kinds & set(action) and others & set(action):
            self.error(where, f"the player runs navigate, play, choose, locate or a route action, not {sorted(others & set(action))[0]}")
        if "then" in action:
            self.error(f"{where}.then", "the player has no page: no then")

    def check_icons(self, icons):
        """The Satellite's own icons, as the Engine adds them (1.2): each name is then one the
        document may use, and a client draws its paths, or its fallback without them."""
        self.since("icons", "a Satellite's own icons", 2)
        if not isinstance(icons, dict):
            self.error("icons", "must be an object of icons")
            return
        if len(icons) > LIMITS["icons"]:
            self.error("icons", f"at most {LIMITS['icons']} icons")
        own = set()
        for name, icon in icons.items():
            where = f"icons.{name}"
            if not OWN_ICON_NAME.fullmatch(name) or name in ICONS:
                self.error(where, "a name is lower case letters, digits and '-', and never a shared icon's")
                continue
            if not isinstance(icon, dict):
                self.error(where, "must be {fallback, stroke?, paths?}")
                continue
            self.unknown_keys(where, icon, {"fallback", "stroke", "paths"})
            if icon.get("fallback") not in ICONS:
                self.error(f"{where}.fallback", "must name a shared icon")
            if "paths" in icon or "stroke" in icon:
                stroke, paths = icon.get("stroke"), icon.get("paths")
                if isinstance(stroke, bool) or not isinstance(stroke, (int, float)) or not 0.5 <= stroke <= 3:
                    self.error(f"{where}.stroke", "must be a number between 0.5 and 3")
                if (not isinstance(paths, list) or not paths or len(paths) > LIMITS["icon_paths"]
                        or not all(valid_icon_path(path) for path in paths)):
                    self.error(f"{where}.paths", f"must be 1 to {LIMITS['icon_paths']} paths of absolute M, L, C and Z")
            own.add(name)
        self.icons = ICONS | own

    def check_protected(self, protected):
        """protected: {capability, setup, forgot?} (1.2): the document belongs to a store the
        client must unlock first, through the capability its own Satellite provides
        (protected_capabilities). Before any page the client asks status: not set up, it opens
        `setup` (a page without params, whose routes the server serves without an unlock); locked,
        its own prompt, which offers "Forgot your PIN?" when `forgot` names a page (as setup: no
        params, served without an unlock) and opens it instead. A 403 from the document's routes
        is "locked again"; it calls keep while it shows the document and lock when it leaves; and
        it keeps nothing - so the document has no offline page, no widget and no share action."""
        self.since("protected", "a protected document", 2)
        self.protected = True
        if (not isinstance(protected, dict) or not {"capability", "setup"} <= set(protected)
                or set(protected) - {"capability", "setup", "forgot"}):
            self.error("protected", "must be {capability, setup, forgot?}")
            return
        capability, setup = protected["capability"], protected["setup"]
        if not isinstance(capability, str) or capability not in PROTECTED_CAPABILITIES:
            self.error("protected.capability", f"must be one of {sorted(PROTECTED_CAPABILITIES)}")
        elif self.provides is not None:
            if capability not in self.provides:
                self.error("protected.capability", f"names {capability}, which this Satellite doesn't provide")
            elif self.provided:
                operations = set((self.provided.get(capability) or {}).get("operations") or {})
                missing = PROTECTED_CAPABILITIES[capability] - operations
                if missing:
                    self.error("protected.capability", f"its {capability} must offer {sorted(missing)} "
                                                       "for a client to show a protected document")
        for key in ("setup", "forgot"):
            if key not in protected:
                continue
            page = protected[key]
            if not isinstance(page, str) or page not in self.pages:
                self.error(f"protected.{key}", f"must name one of the pages (got {page!r})")
            elif self.page_params(page):
                self.error(f"protected.{key}", f"the {key} page cannot require params")

    def check_header(self, header):
        """A band above the navigation on top-level pages: its own source and blocks."""
        self.since("header", "a document header")
        if not isinstance(header, dict):
            self.error("header", "must be an object")
            return
        self.unknown_keys("header", header, {"source", "blocks"})
        self.check_scoped_blocks("header", header)

    def check_widgets(self, widgets):
        """Summaries a client may show outside the Satellite's own pages (Home)."""
        self.since("widgets", "widgets")
        if not isinstance(widgets, list):
            self.error("widgets", "must be a list")
            return
        if len(widgets) > LIMITS["widgets"]:
            self.error("widgets", f"at most {LIMITS['widgets']} widgets")
        ids = set()
        for index, widget in enumerate(widgets):
            where = f"widgets[{index}]"
            if not isinstance(widget, dict):
                self.error(where, "must be an object")
                continue
            self.unknown_keys(where, widget, {"id", "title", "icon", "source", "blocks", "action"})
            widget_id = widget.get("id")
            if not isinstance(widget_id, str) or not PAGE_ID.match(widget_id):
                self.error(where, "needs an 'id' (lower case letters, digits, '-' or '_')")
            elif widget_id in ids:
                self.error(where, f"duplicate id {widget_id!r}")
            ids.add(widget_id)
            if "title" in widget:
                self.check_text(f"{where}.title", widget["title"])
            if "icon" in widget and widget["icon"] not in self.icons:
                self.error(f"{where}.icon", f"unknown icon {widget['icon']!r}")
            self.check_scoped_blocks(where, widget)
            if "action" in widget:
                action = widget["action"]
                if not isinstance(action, dict) or "navigate" not in action:
                    self.error(f"{where}.action", "a widget's action opens one of the pages: {navigate, params}")
                else:
                    self.check_action(f"{where}.action", action)

    def check_scoped_blocks(self, where: str, holder: dict):
        """The header and each widget: an optional source of their own, then blocks."""
        self.state_keys, self.source_names = set(), set()
        if "source" in holder:
            self.check_source(f"{where}.source", holder["source"])
        blocks = holder.get("blocks")
        if not isinstance(blocks, list):
            self.error(f"{where}.blocks", "must be a list")
            return
        if len(blocks) > LIMITS["blocks_per_page"]:
            self.error(f"{where}.blocks", f"at most {LIMITS['blocks_per_page']} blocks")
        self.check_blocks(f"{where}.blocks", blocks, depth=1)

    def page_params(self, page_id) -> list:
        page = self.pages.get(page_id)
        params = page.get("params", []) if isinstance(page, dict) else []
        return params if isinstance(params, list) else []

    def unknown_keys(self, where: str, value: dict, known: set):
        if self.lenient:
            return
        for key in value:
            if key not in known and not key.startswith("_"):  # "_note" style comments are allowed
                self.error(where or "document", f"unknown key {key!r}")

    def check_requires(self, requires):
        if requires is None:
            return
        if not isinstance(requires, dict):
            self.error("requires", "must be an object")
            return
        self.unknown_keys("requires", requires, {"client", "capabilities"})
        for key in ("client", "capabilities"):
            values = requires.get(key, [])
            if not isinstance(values, list) or not all(isinstance(value, str) and value for value in values):
                self.error(f"requires.{key}", "must be a list of names")

    def check_block_requires(self, where: str, requires):
        """{client: [names]} on a block (1.2, change 14): a client without every one of those
        client capabilities leaves the block out, as Developer Mode leaves out a developer block.
        Only reserved names, so a typo is refused instead of hiding the block everywhere."""
        self.since(where, "a block's requires", 2)
        if not isinstance(requires, dict):
            self.error(where, "must be an object")
            return
        self.unknown_keys(where, requires, {"client"})
        names = requires.get("client")
        if not isinstance(names, list) or not names or not all(isinstance(name, str) for name in names):
            self.error(f"{where}.client", "must be a list of client capability names")
            return
        for name in names:
            if name not in CLIENT_CAPABILITIES:
                self.error(f"{where}.client", f"unknown client capability {name!r}")

    def check_offline_omit(self, where: str, offline: dict, blocks):
        """{omit: [field names]} (1.2): names left out of what the client keeps, wherever they
        appear. A name an item is keyed by or addressed with ({$.id} in an image or a route)
        can't be left out: the kept page would have nothing to show its items by."""
        self.unknown_keys(where, offline, {"omit"})
        omit = offline.get("omit")
        if (not isinstance(omit, list) or not omit or len(omit) > OFFLINE_OMIT_LIMIT
                or not all(isinstance(name, str) and IDENTIFIER.match(name) for name in omit)):
            self.error(f"{where}.omit", f"must be a list of 1 to {OFFLINE_OMIT_LIMIT} field names")
            return
        needed = set()

        def visit(value, key=None):
            if isinstance(value, dict):
                for name, item in value.items():
                    visit(item, name)
            elif isinstance(value, list):
                for item in value:
                    visit(item, key)
            elif isinstance(value, str) and key != "href":  # a link only goes, nothing is shown by it
                if key == "key" and value.startswith("$."):
                    needed.update(value[2:].split("."))
                for expression in TEMPLATE_PLACEHOLDER.findall(value):
                    if expression.startswith("$."):
                        needed.update(expression[2:].split("."))
        visit(blocks)
        for name in sorted(set(omit) & needed):
            self.error(f"{where}.omit", f"can't leave out {name!r}: items are keyed by it or reached with it")

    def check_page(self, where: str, page):
        if not isinstance(page, dict):
            self.error(where, "must be an object")
            return
        self.unknown_keys(where, page, {"title", "params", "source", "sources", "state", "template", "blocks", "offline",
                                        "follows", "back"})
        if "back" in page:
            # 1.2 (change 12): false when the page carries its own way out (an Up action), so a
            # client that adds a Back beside a detail page's title leaves it out
            self.since(f"{where}.back", "page back", 2)
            if not isinstance(page["back"], bool):
                self.error(f"{where}.back", "must be true or false")
        if "follows" in page:
            # 1.2: the page's sources load again when the client changes that state itself
            self.since(f"{where}.follows", "page follows", 2)
            follows = page["follows"]
            if not isinstance(follows, list) or not follows or not all(isinstance(name, str) for name in follows):
                self.error(f"{where}.follows", "must be a list of capabilities")
            else:
                for name in follows:
                    self.check_reloadable(f"{where}.follows", name)
        if "offline" in page:
            # 1.2: the client may keep this page's data (and a grid's loaded pages) to show while
            # StarCore can't be reached; a page whose source depends on what the person types or
            # chooses ($state) is never kept, so it can't be offered for one
            # The client keeps only the fields the page's blocks bind, and never a field named in
            # `omit` (at any depth) - {"omit": [...]} is how a Satellite keeps what it wouldn't want
            # in a phone's unencrypted app storage (a location, a path on the server) out of it.
            self.since(f"{where}.offline", "offline pages", 2)
            if self.protected:
                self.error(f"{where}.offline", "a protected document keeps nothing offline")
            offline = page["offline"]
            if isinstance(offline, dict):
                self.check_offline_omit(f"{where}.offline", offline, page.get("blocks"))
            elif not isinstance(offline, bool):
                self.error(f"{where}.offline", "must be true, false or {omit: [field names]}")
                offline = False
            if offline and not isinstance(page.get("source"), dict):
                self.error(f"{where}.offline", "needs the page's own source")
            elif offline and paged_lists(page.get("blocks")):
                self.error(f"{where}.offline", "can't keep a list that loads further pages (`more`)")
            elif offline:
                # a source may depend on a choice's state - a handful of fixed values, one kept
                # collection each - but never on any other (a search's free text)
                used = set(re.findall(r"\$state\.([A-Za-z0-9_]+)", str(page["source"].get("route", ""))))
                chosen = choice_keys(page.get("blocks"))
                if used - chosen:
                    self.error(f"{where}.offline", "can keep a source that depends on $state only on a choice's state "
                               f"({', '.join(sorted(used - chosen))} isn't one)")
        self.state_keys, self.source_names = set(), set()
        if "state" in page:
            self.since(f"{where}.state", "page state")
            state = page["state"]
            if not isinstance(state, dict) or not all(
                    isinstance(key, str) and IDENTIFIER.match(key)
                    and (value is None or isinstance(value, (str, int, float, bool)))
                    for key, value in state.items()):
                self.error(f"{where}.state", "must map identifiers to a text, number or true/false default")
            else:
                self.state_keys = set(state)
        if "sources" in page:
            self.since(f"{where}.sources", "named sources")
            sources = page["sources"]
            if not isinstance(sources, dict):
                self.error(f"{where}.sources", "must map names to {route, refresh}")
            else:
                if len(sources) > LIMITS["sources_per_page"]:
                    self.error(f"{where}.sources", f"at most {LIMITS['sources_per_page']} sources")
                for name in sources:
                    if not IDENTIFIER.match(name):
                        self.error(f"{where}.sources", f"source name {name!r} must be an identifier")
                self.source_names = set(sources)
                for name, source in sources.items():
                    self.check_source(f"{where}.sources.{name}", source)
        if "template" in page:
            self.since(f"{where}.template", "page templates")
            if page["template"] not in PAGE_TEMPLATES:
                self.error(f"{where}.template", f"must be one of {sorted(PAGE_TEMPLATES)}")
        if "title" in page:
            self.check_text(f"{where}.title", page["title"])
        params = page.get("params", [])
        if not isinstance(params, list) or not all(isinstance(p, str) and IDENTIFIER.match(p) for p in params):
            self.error(f"{where}.params", "must be a list of identifiers")
        if "source" in page:
            self.check_source(f"{where}.source", page["source"])
        blocks = page.get("blocks")
        if not isinstance(blocks, list):
            self.error(f"{where}.blocks", "must be a list")
            return
        if len(blocks) > LIMITS["blocks_per_page"]:
            self.error(f"{where}.blocks", f"at most {LIMITS['blocks_per_page']} blocks")
        self.check_blocks(f"{where}.blocks", blocks, depth=1)

    def check_source(self, where: str, source):
        if not isinstance(source, dict):
            self.error(where, "must be an object")
            return
        self.unknown_keys(where, source, {"route", "refresh"})
        self.check_route(f"{where}.route", source.get("route"))
        if "refresh" in source:
            refresh = source["refresh"]
            if isinstance(refresh, bool) or not isinstance(refresh, (int, float)) \
                    or refresh < LIMITS["min_refresh_seconds"]:
                self.error(f"{where}.refresh", f"must be at least {LIMITS['min_refresh_seconds']} seconds")

    def check_blocks(self, where: str, blocks: list, depth: int):
        if depth > LIMITS["nesting_depth"]:
            self.error(where, f"blocks can be nested at most {LIMITS['nesting_depth']} deep")
            return
        for index, block in enumerate(blocks):
            self.check_block(f"{where}[{index}]", block, depth)

    def check_block(self, where: str, block, depth: int, in_row: bool = False):
        if not isinstance(block, dict):
            self.error(where, "must be an object")
            return
        kind = block.get("type")
        if kind not in BLOCKS:
            if not self.lenient:
                self.error(where, f"unknown block type {kind!r}")
            return
        if kind in BLOCK_SINCE:
            self.since(where, f"the {kind} block", BLOCK_SINCE[kind])
        required, optional = BLOCKS[kind]
        for key in sorted(required - block.keys()):
            self.error(where, f"{kind} needs {key!r}")
        self.unknown_keys(where, block, required | optional | COMMON_BLOCK_KEYS)
        if "visible" in block and not isinstance(block["visible"], bool):
            self.check_text(f"{where}.visible", block["visible"])
        for key in ("required", "developer"):
            if key in block and not isinstance(block[key], bool):
                self.error(f"{where}.{key}", "must be true or false")
        if "requires" in block:
            self.check_block_requires(f"{where}.requires", block["requires"])

        for key in ("text", "label", "title", "description", "empty", "value", "unit", "detail"):
            if key in block and not (kind in ("toggle", "slider", "field", "metric", "code") and key == "value"):
                self.check_text(f"{where}.{key}", block[key])
        if kind in ("field", "metric", "toggle", "slider", "code") and "value" in block:
            self.check_value(f"{where}.value", block["value"])
        if "detail" in block and kind in ("field", "metric"):
            self.since(f"{where}.detail", f"a {kind}'s detail")
        if "format" in block and kind != "list":
            self.check_format(f"{where}.format", block["format"])
        if "tone" in block and block["tone"] not in TONES:
            self.check_binding(f"{where}.tone", block["tone"], required=True, choices=TONES)
        if "style" in block:
            styles = TEXT_STYLES if kind == "text" else BUTTON_STYLES
            if block["style"] not in styles:
                self.error(f"{where}.style", f"must be one of {sorted(styles)}")
            elif kind == "text" and block["style"] == "eyebrow":
                self.since(f"{where}.style", "the eyebrow text style")
        for key in ("max", "min", "step", "from", "to", "resolution"):
            if key in block:
                self.check_number_or_binding(f"{where}.{key}", block[key])
        if "action" in block:
            if kind == "metric":
                self.since(f"{where}.action", "a metric's action")
            self.check_action(f"{where}.action", block["action"])
        if kind == "metric" and "trend" in block:
            self.since(f"{where}.trend", "a metric's trend")
            self.check_items(f"{where}.trend", block["trend"])

        if kind == "card" and isinstance(block.get("blocks"), list):
            self.check_blocks(f"{where}.blocks", block["blocks"], depth + 1)
        elif kind == "card" and "blocks" in block:
            self.error(f"{where}.blocks", "must be a list")
        elif kind == "actions":
            self.check_actions_row(where, block, depth)
        elif kind == "dropdown":
            self.check_dropdown(where, block, depth, in_row)
        elif kind == "image":
            self.check_image(where, block)
        elif kind == "media-list":
            self.check_media_list(where, block)
        elif kind == "media-grid":
            self.check_media_grid(where, block)
        elif kind == "search":
            self.check_search(where, block)
        elif kind == "map":
            self.check_map(where, block)
        elif kind == "list":
            self.check_list(where, block)
        elif kind == "breadcrumb":
            self.check_breadcrumb(where, block)
        elif kind == "openers":
            self.check_openers(where, block)
        elif kind == "form":
            self.check_form(where, block)
        elif kind == "chart":
            self.check_chart(where, block)
        elif kind == "table":
            self.check_table(where, block)
        elif kind == "choice":
            self.check_choice(where, block)
        elif kind == "code" and "copy" in block and not isinstance(block["copy"], bool):
            self.error(f"{where}.copy", "must be true or false")
        elif kind == "file-browser":
            if block.get("capability") != CAPABILITY_BLOCKS[kind]:
                self.error(f"{where}.capability", f"a file-browser is bound to the {CAPABILITY_BLOCKS[kind]!r} capability")
            if "select" in block and block["select"] not in FILE_BROWSER_SELECT:
                self.error(f"{where}.select", f"must be one of {sorted(FILE_BROWSER_SELECT)}")

    def check_format(self, where: str, value):
        if value not in FORMATS:
            self.error(where, f"unknown format {value!r}")
        elif value in FORMATS_1_1:
            self.since(where, f"the {value} format")

    def check_items(self, where: str, items):
        """A list of values, or a binding to one."""
        if is_binding(items):
            self.check_binding(where, items)
        elif not isinstance(items, list):
            self.error(where, "must be a list or a binding")

    def check_chart(self, where: str, block: dict):
        if "kind" in block and block["kind"] not in CHART_KINDS:
            self.error(f"{where}.kind", f"must be one of {sorted(CHART_KINDS)}")
        series = block.get("series")
        if not isinstance(series, list) or not series:
            self.error(f"{where}.series", "must be a list of {label, points}")
            return
        if len(series) > LIMITS["chart_series"]:
            self.error(f"{where}.series", f"at most {LIMITS['chart_series']} series in one chart")
        for index, line in enumerate(series):
            at = f"{where}.series[{index}]"
            if not isinstance(line, dict):
                self.error(at, "must be an object")
                continue
            self.unknown_keys(at, line, {"label", "points"})
            if "label" in line:
                self.check_text(f"{at}.label", line["label"])
            if "points" not in line:
                self.error(at, "needs 'points'")
            else:
                self.check_items(f"{at}.points", line["points"])

    def check_table(self, where: str, block: dict):
        if "rows" in block:
            self.check_items(f"{where}.rows", block["rows"])
        columns = block.get("columns")
        if not isinstance(columns, list) or not columns:
            self.error(f"{where}.columns", "must be a non-empty list")
            return
        if len(columns) > LIMITS["table_columns"]:
            self.error(f"{where}.columns", f"at most {LIMITS['table_columns']} columns")
        for index, column in enumerate(columns):
            at = f"{where}.columns[{index}]"
            if not isinstance(column, dict):
                self.error(at, "must be an object")
                continue
            self.unknown_keys(at, column, {"label", "value", "format", "unit", "align", "tone", "max"})
            if not isinstance(column.get("label"), str):
                self.error(at, "needs a 'label'")
            if "value" not in column:
                self.error(at, "needs a 'value'")
            else:
                self.check_value(f"{at}.value", column["value"])
            if "format" in column:
                self.check_format(f"{at}.format", column["format"])
            if "unit" in column:
                self.check_text(f"{at}.unit", column["unit"])
            if "align" in column and column["align"] not in COLUMN_ALIGN:
                self.error(f"{at}.align", f"must be one of {sorted(COLUMN_ALIGN)}")
            if "tone" in column and column["tone"] not in TONES:
                self.check_binding(f"{at}.tone", column["tone"], required=True, choices=TONES)
            if "max" in column:
                self.check_number_or_binding(f"{at}.max", column["max"])

    def check_choice(self, where: str, block: dict):
        key = block.get("key")
        if not isinstance(key, str) or key not in self.state_keys:
            self.error(f"{where}.key", f"must name one of the page's state keys (got {key!r})")
        options = block.get("options")
        if not isinstance(options, list) or not options or not all(
                isinstance(option, dict) and isinstance(option.get("label"), str) and "value" in option
                and (option["value"] is None or isinstance(option["value"], (str, int, float, bool)))
                for option in options):
            self.error(f"{where}.options", "needs 'options': [{value, label}, ...]")
        elif len(options) > LIMITS["choice_options"]:
            self.error(f"{where}.options", f"at most {LIMITS['choice_options']} options")

    def check_list(self, where: str, block: dict):
        items = block.get("items")
        if not (isinstance(items, list) or is_binding(items)):
            self.error(f"{where}.items", "must be a list or a binding")
        elif is_binding(items):
            self.check_binding(f"{where}.items", items)
        item = block.get("item")
        if not isinstance(item, dict):
            self.error(f"{where}.item", "must be an object")
            return
        self.unknown_keys(f"{where}.item", item, {"title", "subtitle", "value", "format", "icon", "tone", "selected"})
        if "tone" in item:
            self.since(f"{where}.item.tone", "a list item's tone")
            if item["tone"] not in TONES:
                self.check_binding(f"{where}.item.tone", item["tone"], required=True, choices=TONES)
        if "selected" in item:
            # 1.2, change 17: the row a page was opened on (a file Show in folder points at),
            # marked with the accent and scrolled to
            self.since(f"{where}.item.selected", "a list item's selected", 2)
            if is_binding(item["selected"]):
                self.check_binding(f"{where}.item.selected", item["selected"])
            else:
                self.error(f"{where}.item.selected", "must be a binding to the row's own value ($.)")
        if "title" not in item:
            self.error(f"{where}.item", "needs 'title'")
        for key in ("title", "subtitle", "value"):
            if key in item:
                self.check_text(f"{where}.item.{key}", item[key])
        if "icon" in item and item["icon"] not in self.icons:
            self.check_binding(f"{where}.item.icon", item["icon"], required=True, choices=self.icons)
        formats = item.get("format", {})
        if not isinstance(formats, dict) or any(value not in FORMATS for value in formats.values()):
            self.error(f"{where}.item.format", "must map 'subtitle'/'value' to a known format")
        else:
            for key, value in formats.items():
                self.check_format(f"{where}.item.format.{key}", value)
        if "more" in block:
            # 1.2: a long list arrives page by page, as a media-grid's does
            self.since(f"{where}.more", "a list's more", 2)
            if not is_binding(items):
                self.error(f"{where}.more", "needs `items` bound to the page's data")
            self.check_more(f"{where}.more", block["more"])

    def check_actions_row(self, where: str, block: dict, depth: int):
        """{type: actions, blocks} (1.2, change 11): a page's actions on one line, buttons and
        dropdowns only."""
        blocks = block.get("blocks")
        if not isinstance(blocks, list):
            self.error(f"{where}.blocks", "must be a list")
            return
        if not blocks:
            self.error(f"{where}.blocks", "must hold at least one button or dropdown")
        if len(blocks) > LIMITS["row_actions"]:
            self.error(f"{where}.blocks", f"holds at most {LIMITS['row_actions']} actions")
        if depth + 1 > LIMITS["nesting_depth"]:
            self.error(f"{where}.blocks", f"blocks can be nested at most {LIMITS['nesting_depth']} deep")
            return
        for index, child in enumerate(blocks):
            if isinstance(child, dict) and child.get("type") not in ("button", "dropdown") \
                    and child.get("type") in BLOCKS:
                self.error(f"{where}.blocks[{index}]", "an actions row holds buttons and dropdowns only")
                continue
            self.check_block(f"{where}.blocks[{index}]", child, depth + 1, in_row=True)

    def check_dropdown(self, where: str, block: dict, depth: int, in_row: bool):
        """{type: dropdown, label, blocks, style?} (1.2, change 11): a button of an actions row
        that opens a panel under itself holding its own blocks."""
        if not in_row:
            self.error(where, "a dropdown sits in an actions block")
        blocks = block.get("blocks")
        if not isinstance(blocks, list):
            self.error(f"{where}.blocks", "must be a list")
            return
        if not blocks:
            self.error(f"{where}.blocks", "must hold at least one block")
        for index, child in enumerate(blocks):
            if isinstance(child, dict) and child.get("type") in ("actions", "dropdown"):
                self.error(f"{where}.blocks[{index}]", "a dropdown holds no actions row or dropdown")
        self.check_blocks(f"{where}.blocks", blocks, depth + 1)

    def check_breadcrumb(self, where: str, block: dict):
        """{type: breadcrumb, items, item: {title}, action?} (1.2): the way down to the current
        place, one entry after another on a single row. Each entry but the last runs `action`
        with itself as the scope; the last is where the person is, shown and not pressable."""
        items = block.get("items")
        if not (isinstance(items, list) or is_binding(items)):
            self.error(f"{where}.items", "must be a list or a binding")
        elif is_binding(items):
            self.check_binding(f"{where}.items", items)
        item = block.get("item")
        if not isinstance(item, dict):
            self.error(f"{where}.item", "must be an object")
            return
        self.unknown_keys(f"{where}.item", item, {"title"})
        if "title" not in item:
            self.error(f"{where}.item", "needs 'title'")
        else:
            self.check_text(f"{where}.item.title", item["title"])

    def check_openers(self, where: str, block: dict):
        """{type: openers, path, label?} (1.2, change 16): the Satellites that open the file at
        `path`, from the catalog's files.open providers whose extensions hold its own, one link
        each. Never in a protected document: a locked file's path goes to no other Satellite."""
        self.check_text(f"{where}.path", block.get("path"))
        if self.protected:
            self.error(where, "a protected document hands no path to another Satellite")

    def check_locate(self, where: str, action: dict):
        """{locate: path} (1.2, change 16): the client asks files.browse's locate for the path and
        opens the folder page it answers. One place at a time, and never from a protected
        document. In a player's menu (change 18), where the playing track carries only what the
        queue keeps, `route` names the Satellite's own GET route (resolved with the track) whose
        answer is the $. the path resolves in."""
        self.since(f"{where}.locate", "the locate action", 2)
        self.unknown_keys(where, action, {"locate", "route"} if self.in_audio else {"locate"})
        self.check_text(f"{where}.locate", action["locate"])
        if "route" in action:
            self.check_route(f"{where}.route", action["route"])
        if self.in_bulk:
            self.error(f"{where}.locate", "opens one folder: not in a selection or a tile's quick actions")
        if self.protected:
            self.error(f"{where}.locate", "a protected document hands no path to another Satellite")

    def check_media_options(self, where: str, block: dict):
        """size, shape and fit, shared by image and media-list: fixed words, never bindings,
        so a layout is known before any data arrives."""
        for key, choices in (("size", IMAGE_SIZES), ("shape", IMAGE_SHAPES), ("fit", IMAGE_FITS)):
            if key in block and block[key] not in choices:
                self.error(f"{where}.{key}", f"must be one of {sorted(choices)}")

    def check_image(self, where: str, block: dict):
        """{type: image, src} (1.2): `src` is a route template inside the Satellite, like an
        action's route, so the client loads it with its own session and it can't point
        anywhere else."""
        self.check_route(f"{where}.src", block.get("src"))
        for key in ("alt", "caption"):
            if key in block:
                self.check_text(f"{where}.{key}", block[key])
        self.check_media_options(where, block)

    def check_media_list(self, where: str, block: dict):
        """{type: media-list, items, item} (1.2): rows with a thumbnail from the Satellite's
        own routes, a title, a subtitle and a short piece of metadata; the row action is any
        action (navigate, a route, play). Like a media-grid's tiles, rows may come page by page
        (`more`, with `item.key` keeping a row across pages), in groups (`item.group`), with up to
        two icon actions at their end (`quick`, each drawn while its `visible` holds: a pair is a
        toggle) and a menu of actions (`menu`). `item.audio` binds a track id of the document's
        own audio.library provider, so the client marks the row playing."""
        self.check_items(f"{where}.items", block.get("items"))
        item = block.get("item")
        if not isinstance(item, dict):
            self.error(f"{where}.item", "must be an object")
            return
        self.unknown_keys(f"{where}.item", item, MEDIA_LIST_ITEM_KEYS)
        if "title" not in item:
            self.error(f"{where}.item", "needs 'title'")
        for key in ("title", "subtitle", "meta", "key", "group"):
            if key in item:
                self.check_text(f"{where}.item.{key}", item[key])
        if "image" in item:
            self.check_route(f"{where}.item.image", item["image"])
        if "audio" in item:
            if not is_binding(item["audio"]):
                self.error(f"{where}.item.audio", "must bind a track id")
            else:
                self.check_binding(f"{where}.item.audio", item["audio"])
            if self.provides is not None and AUDIO_LIBRARY not in self.provides:
                self.error(f"{where}.item.audio", f"marks the Satellite's own tracks, and it provides no {AUDIO_LIBRARY}")
        formats = item.get("format", {})
        if not isinstance(formats, dict) or not set(formats) <= {"subtitle", "meta", "group"} or any(
                value not in FORMATS for value in formats.values()):
            self.error(f"{where}.item.format", "must map 'subtitle'/'meta'/'group' to a known format")
        else:
            for key, value in formats.items():
                self.check_format(f"{where}.item.format.{key}", value)
        self.check_media_options(where, block)
        self.check_row_actions(where, block)
        if "more" in block:
            if not is_binding(block.get("items")):
                self.error(f"{where}.more", "needs `items` bound to the page's data")
            self.check_more(f"{where}.more", block["more"])
        if "reorder" in block:
            self.check_reorder(f"{where}.reorder", block)

    def check_row_actions(self, where: str, block: dict):
        """`quick` and `menu` (1.2), on a media-list's rows and a media-grid's tiles: the row is
        `$.`, and an entry may play it (not a selection), download it or update it in place."""
        if "quick" in block:
            self.check_media_actions(f"{where}.quick", block["quick"], LIMITS["quick_actions"],
                                     required=True, secure=False, icon=True, files=False, row=True)
        if "menu" in block:
            self.check_media_actions(f"{where}.menu", block["menu"], LIMITS["menu_entries"],
                                     required=True, secure=False, row=True)

    def check_media_grid(self, where: str, block: dict):
        """{type: media-grid, items, item} (1.2): a grid of images and videos from the
        Satellite's own routes, in groups, revealed page by page as it scrolls. A tile opens
        the shared viewer (`viewer`) or runs `action`; `selection` offers actions over the
        selected tiles. A tile runs the first entry of `open` whose `visible` holds instead, when
        the action depends on the item (a folder that opens elsewhere), and an item's `icon` is
        drawn when it has no image. Nothing in it is specific to one kind of collection."""
        self.check_items(f"{where}.items", block.get("items"))
        if "viewer" in block and "action" in block:
            self.error(where, "a media-grid's tiles open the viewer or run an action, not both")
        if "open" in block:
            self.check_tile_actions(f"{where}.open", block)
        # quick: a small button in each tile's corner, the first entry whose `visible` holds
        self.check_row_actions(where, block)
        layout = block.get("layout", "grid")
        if layout not in MEDIA_GRID_LAYOUTS:
            self.error(f"{where}.layout", f"must be one of {sorted(MEDIA_GRID_LAYOUTS)}")
        elif layout == "row":
            # a shelf: one row that scrolls sideways, at its size, nothing to page or select
            for key in ("more", "selection"):
                if key in block:
                    self.error(f"{where}.{key}", "a shelf (layout row) has no paging or selection")
        item = block.get("item")
        if not isinstance(item, dict):
            self.error(f"{where}.item", "must be an object")
        else:
            self.unknown_keys(f"{where}.item", item, MEDIA_GRID_ITEM_KEYS)
            if "image" not in item:
                self.error(f"{where}.item", "needs 'image'")
            else:
                self.check_route(f"{where}.item.image", item["image"])
            for key in ("key", "title", "subtitle", "group"):
                if key in item:
                    self.check_text(f"{where}.item.{key}", item[key])
            if "kind" in item and item["kind"] not in MEDIA_KINDS:
                self.check_binding(f"{where}.item.kind", item["kind"], required=True, choices=MEDIA_KINDS)
            if "duration" in item:
                self.check_number_or_binding(f"{where}.item.duration", item["duration"])
            if "icon" in item and item["icon"] not in self.icons:
                self.check_binding(f"{where}.item.icon", item["icon"], required=True, choices=self.icons)
            formats = item.get("format", {})
            if not isinstance(formats, dict) or not set(formats) <= {"subtitle", "group"} or any(
                    value not in FORMATS for value in formats.values()):
                self.error(f"{where}.item.format", "must map 'subtitle'/'group' to a known format")
            else:
                for key, value in formats.items():
                    self.check_format(f"{where}.item.format.{key}", value)
        if "viewer" in block:
            self.check_viewer(f"{where}.viewer", block["viewer"])
        if "selection" in block:
            selection = block["selection"]
            if not isinstance(selection, dict):
                self.error(f"{where}.selection", "must be {actions: [...]}")
            else:
                self.unknown_keys(f"{where}.selection", selection, {"actions"})
                self.check_media_actions(f"{where}.selection.actions", selection.get("actions"),
                                         LIMITS["selection_actions"], required=True, files=False,
                                         selection=True)
        if "size" in block and block["size"] not in IMAGE_SIZES:
            self.error(f"{where}.size", f"must be one of {sorted(IMAGE_SIZES)}")
        if "shape" in block and block["shape"] not in IMAGE_SHAPES:
            self.error(f"{where}.shape", f"must be one of {sorted(IMAGE_SHAPES)}")
        if "more" in block:
            self.check_more(f"{where}.more", block["more"])

    def check_tile_actions(self, where: str, block: dict):
        """[{action, visible}] (1.2): a tile runs the first entry whose `visible` holds (an entry
        without one always does) - the action chosen per item. In place of `viewer` and `action`."""
        if "viewer" in block or "action" in block:
            self.error(where, "a media-grid's tiles run one of viewer, action or open")
        entries = block["open"]
        if not isinstance(entries, list) or not entries:
            self.error(where, "must be a non-empty list of {action, visible}")
            return
        if len(entries) > LIMITS["tile_actions"]:
            self.error(where, f"at most {LIMITS['tile_actions']} entries")
        for index, entry in enumerate(entries):
            at = f"{where}[{index}]"
            if not isinstance(entry, dict):
                self.error(at, "must be an object")
                continue
            self.unknown_keys(at, entry, {"action", "visible"})
            if "action" not in entry:
                self.error(at, "needs an 'action'")
            else:
                self.check_action(f"{at}.action", entry["action"])
            if "visible" in entry and not isinstance(entry["visible"], bool):
                self.check_text(f"{at}.visible", entry["visible"])

    def check_more(self, where: str, more):
        """{route, cursor} (1.2): how a media-grid or a list loads its next page. `cursor` binds into the
        page's data - and into each further page's response, which has the same shape - to the
        provider's cursor for what comes next (null at the end); `route` gets it as {$value}.
        The provider owns the cursor: the client only passes it back."""
        if not isinstance(more, dict):
            self.error(where, "must be {route, cursor}")
            return
        self.unknown_keys(where, more, {"route", "cursor"})
        self.check_route(f"{where}.route", more.get("route"))
        if "cursor" not in more:
            self.error(where, "needs 'cursor'")
        else:
            self.check_binding(f"{where}.cursor", more["cursor"])

    def check_search(self, where: str, block: dict):
        """{type: search, key} (1.2): a search field that sets the page state `key` as the
        person types (after a short pause), so routes templated with $state.<key> load the
        results - like a choice, for free text."""
        key = block.get("key")
        if not isinstance(key, str) or key not in self.state_keys:
            self.error(f"{where}.key", f"must name one of the page's state keys (got {key!r})")
        if "placeholder" in block:
            self.check_text(f"{where}.placeholder", block["placeholder"])

    def check_map(self, where: str, block: dict):
        """{type: map, items, item} (1.2): items with a latitude and longitude on an
        interactive map, grouped into clusters that separate as it zooms. A marker opens the
        shared viewer on its items (`viewer`) or runs `action` - not both. Items without a
        location are left out. No map service is named: each client draws its own."""
        self.check_items(f"{where}.items", block.get("items"))
        if "viewer" in block and "action" in block:
            self.error(where, "a map's markers open the viewer or run an action, not both")
        item = block.get("item")
        if not isinstance(item, dict):
            self.error(f"{where}.item", "must be an object")
        else:
            self.unknown_keys(f"{where}.item", item, MAP_ITEM_KEYS)
            for key in ("lat", "lon"):
                if key not in item:
                    self.error(f"{where}.item", f"needs '{key}'")
                else:
                    self.check_number_or_binding(f"{where}.item.{key}", item[key])
            if "image" in item:
                self.check_route(f"{where}.item.image", item["image"])
            for key in ("key", "title"):
                if key in item:
                    self.check_text(f"{where}.item.{key}", item[key])
            if "kind" in item and item["kind"] not in MEDIA_KINDS:
                self.check_binding(f"{where}.item.kind", item["kind"], required=True, choices=MEDIA_KINDS)
            if "count" in item:
                self.check_number_or_binding(f"{where}.item.count", item["count"])
            if "bounds" in item:
                self.check_binding(f"{where}.item.bounds", item["bounds"])
        if "viewer" in block:
            self.check_viewer(f"{where}.viewer", block["viewer"])
        if "viewport" in block:
            # what the map shows, loaded for the area on screen: the route gets
            # {$value.bbox} ("south,west,north,east") and {$value.zoom}
            viewport = block["viewport"]
            if not isinstance(viewport, dict):
                self.error(f"{where}.viewport", "must be {route}")
            else:
                self.unknown_keys(f"{where}.viewport", viewport, {"route", "preview"})
                self.check_route(f"{where}.viewport.route", viewport.get("route"))
                if "preview" in viewport:
                    # a provider cluster's own items (change 15), with {$value.bbox} its bounds
                    self.check_route(f"{where}.viewport.preview", viewport["preview"])
        if "bounds" in block:
            self.check_binding(f"{where}.bounds", block["bounds"])

    def check_viewer(self, where: str, viewer):
        """The shared full-screen viewer of a media-grid: the full image (or the tile's own
        image), a video to play in its place, a title, facts and actions on the item shown."""
        if not isinstance(viewer, dict):
            self.error(where, "must be an object")
            return
        self.unknown_keys(where, viewer, MEDIA_VIEWER_KEYS)
        for key in ("image", "video"):
            if key in viewer:
                self.check_route(f"{where}.{key}", viewer[key])
        for key in ("title", "subtitle"):
            if key in viewer:
                self.check_text(f"{where}.{key}", viewer[key])
        fields = viewer.get("fields", [])
        if not isinstance(fields, list):
            self.error(f"{where}.fields", "must be a list of {label, value}")
            fields = []
        if len(fields) > LIMITS["viewer_fields"]:
            self.error(f"{where}.fields", f"at most {LIMITS['viewer_fields']} fields")
        for index, field in enumerate(fields):
            at = f"{where}.fields[{index}]"
            if not isinstance(field, dict):
                self.error(at, "must be an object")
                continue
            self.unknown_keys(at, field, {"label", "value", "format", "unit", "href", "action"})
            if not isinstance(field.get("label"), str):
                self.error(at, "needs a 'label'")
            if "value" not in field:
                self.error(at, "needs a 'value'")
            else:
                self.check_value(f"{at}.value", field["value"])
            if "format" in field:
                self.check_format(f"{at}.format", field["format"])
            if "unit" in field:
                self.check_text(f"{at}.unit", field["unit"])
            if "href" in field:
                self.check_href(f"{at}.href", field["href"])
            if "action" in field:
                # change 18: the value is a link that shows its path's folder - a locate, nothing
                # else, and never beside an href
                action = field["action"]
                if "href" in field:
                    self.error(f"{at}.action", "a field links one way: an href or an action")
                elif not isinstance(action, dict) or "locate" not in action:
                    self.error(f"{at}.action", "a field's action is a locate")
                else:
                    self.check_action(f"{at}.action", action)
        if "actions" in viewer:
            self.check_media_actions(f"{where}.actions", viewer["actions"], LIMITS["viewer_actions"])

    def check_href(self, where: str, template):
        """A viewer field's link (change 15): an address on a host the document names itself,
        https:// (or http://) and the host fixed, bindings only after them, each URL-encoded by
        the client. A protected document links nowhere: what it shows stays in it."""
        if self.protected:
            self.error(where, "a protected document links nowhere outside it")
            return
        if not isinstance(template, str) or len(template) > 2048 or not HREF_START.match(template):
            self.error(where, "must start with https:// (or http://), a host and /, before any binding")
            return
        for expression in PLACEHOLDER.findall(template):
            self.check_binding(where, expression)

    def check_media_actions(self, where: str, actions, limit: int, required: bool = False,
                            secure: bool = True, icon: bool = False, files: bool = True,
                            selection: bool = False, row: bool = False):
        """[{label, action, icon, style, visible}]: the viewer's actions on the item shown, a
        selection's on each selected item, or a row's or a tile's quick actions (no secure action
        there, and an icon each: the button has no room for its label) and menu entries."""
        if not isinstance(actions, list) or (required and not actions):
            self.error(where, "must be a list of {label, action}")
            return
        if len(actions) > limit:
            self.error(where, f"at most {limit} actions")
        for index, entry in enumerate(actions):
            at = f"{where}[{index}]"
            if not isinstance(entry, dict):
                self.error(at, "must be an object")
                continue
            self.unknown_keys(at, entry, {"label", "action", "icon", "style", "visible"})
            if "label" not in entry:
                self.error(at, "needs a 'label'")
            else:
                self.check_text(f"{at}.label", entry["label"])
            if "action" not in entry:
                self.error(at, "needs an 'action'")
            else:
                self.in_media_actions = secure  # where a secure action may be
                self.in_bulk = not files
                self.in_selection = selection
                self.in_row = row
                try:
                    self.check_action(f"{at}.action", entry["action"])
                finally:
                    self.in_media_actions = False
                    self.in_bulk = False
                    self.in_selection = False
                    self.in_row = False
            if icon and "icon" not in entry:
                self.error(at, "needs an 'icon'")
            if "icon" in entry and entry["icon"] not in self.icons:
                self.error(f"{at}.icon", f"unknown icon {entry['icon']!r}")
            if "style" in entry and entry["style"] not in BUTTON_STYLES:
                self.error(f"{at}.style", f"must be one of {sorted(BUTTON_STYLES)}")
            if "visible" in entry and not isinstance(entry["visible"], bool):
                self.check_text(f"{at}.visible", entry["visible"])

    def check_form(self, where: str, block: dict):
        keys = self.check_form_fields(where, block.get("fields"))
        submit = block.get("submit")
        if not isinstance(submit, dict) or not isinstance(submit.get("label"), str) or "action" not in submit:
            self.error(f"{where}.submit", "needs a 'label' and an 'action'")
        else:
            self.unknown_keys(f"{where}.submit", submit, {"label", "action"})
            self.check_action(f"{where}.submit.action", submit["action"])
            secrets = submit["action"].get("secrets") if isinstance(submit["action"], dict) else None
            if isinstance(secrets, dict):
                # the client's prompt asks for these, so the form never holds one
                for key in sorted(keys & set(secrets)):
                    self.error(f"{where}.submit.action.secrets.{key}",
                               "is also a field of the form: a secret is never typed in a form")

    def check_form_fields(self, where: str, fields, row: bool = False) -> set:
        """A form's fields, or (row) the fields of one repeatable row: each a {key, label, kind}
        input. A `rows` field (1.2) is a list the person adds rows to and removes them from, each
        row the same few inputs (`fields`, none of them rows), and the form sends it as a list of
        objects under its key; `add` names the button that adds one. Its value binds a list."""
        if not isinstance(fields, list) or not fields:
            self.error(f"{where}.fields", "must be a non-empty list")
            return set()
        if row and len(fields) > LIMITS["row_fields"]:
            self.error(f"{where}.fields", f"at most {LIMITS['row_fields']} inputs in a row")
        keys = set()
        for index, field in enumerate(fields):
            at = f"{where}.fields[{index}]"
            if not isinstance(field, dict):
                self.error(at, "must be an object")
                continue
            kind = field.get("kind")
            if kind == "rows":
                self.since(f"{at}.kind", "a rows field", 2)
                self.unknown_keys(at, field, {"key", "label", "kind", "value", "fields", "add", "required"})
            else:
                # a row's inputs start empty: the row's own value is the rows field's
                allowed = {"key", "label", "kind", "options", "placeholder", "required"}
                self.unknown_keys(at, field, allowed if row else allowed | {"value"})
            key = field.get("key")
            if not isinstance(key, str) or not IDENTIFIER.match(key):
                self.error(at, "needs an identifier 'key'")
            elif key in keys:
                self.error(at, f"duplicate key {key!r}")
            keys.add(key)
            if not isinstance(field.get("label"), str):
                self.error(at, "needs a 'label'")
            if kind not in FORM_FIELD_KINDS:
                self.error(at, f"kind must be one of {sorted(FORM_FIELD_KINDS)}")
            elif kind == "rows":
                if row:
                    self.error(f"{at}.kind", "a row holds no rows of its own")
                else:
                    self.check_form_fields(at, field.get("fields"), row=True)
                if "add" in field:
                    self.check_text(f"{at}.add", field["add"])
                if "value" in field and not isinstance(field["value"], list) and not (
                        isinstance(field["value"], str) and is_binding(field["value"])):
                    self.error(f"{at}.value", "must be a list of rows or a binding to one")
            if kind == "select":
                options = field.get("options")
                if not isinstance(options, list) or not options or not all(
                        isinstance(o, dict) and isinstance(o.get("label"), str) and "value" in o for o in options):
                    self.error(at, "a select needs 'options': [{value, label}, ...]")
            if "required" in field and not isinstance(field["required"], bool):
                self.error(f"{at}.required", "must be true or false")
        return keys

    def check_action(self, where: str, action):
        if not isinstance(action, dict):
            self.error(where, "must be an object")
            return
        if "navigate" in action:
            self.unknown_keys(where, action, {"navigate", "params"})
            self.check_navigate(where, action)
            return
        if "play" in action:
            self.check_play(where, action)
            return
        if "offline" in action:
            self.check_offline_action(where, action)
            return
        if "own" in action:
            self.check_own(where, action)
            return
        if "secure" in action:
            self.check_secure(where, action)
            return
        if "section" in action:
            self.check_section(where, action)
            return
        if "locate" in action:
            self.check_locate(where, action)
            return
        if "sync" in action:
            self.check_sync(where, action)
            return
        for kind in ("download", "share"):
            if kind in action:
                self.check_file_action(where, action, kind)
                return
        if "upload" in action:
            self.check_upload(where, action)
            return
        if "choose" in action:
            self.check_choose(where, action)
            return
        known = {"route", "method", "body", "confirm", "then", "reloads"}
        if "reloads" in action:
            # 1.2: once the request succeeded, the client reloads what it keeps from the capability
            self.since(f"{where}.reloads", "reloads", 2)
            self.check_reloadable(f"{where}.reloads", action["reloads"])
        if "pick" in action:
            self.check_pick(where, action["pick"])
            known.add("pick")
        if "secrets" in action:
            self.check_secrets(where, action)
            known.add("secrets")
        if "reveal" in action:
            self.check_reveal(where, action)
            known.add("reveal")
        self.unknown_keys(where, action, known)
        self.check_route(f"{where}.route", action.get("route"))
        if "method" in action and action["method"] not in METHODS:
            self.error(f"{where}.method", "must be GET or POST")
        if "body" in action:
            if not isinstance(action["body"], dict):
                self.error(f"{where}.body", "must be an object")
            else:
                self.check_values(f"{where}.body", action["body"])
        if "confirm" in action:
            self.check_text(f"{where}.confirm", action["confirm"])
        then = action.get("then")
        if then is None:
            return
        if isinstance(then, dict):
            self.unknown_keys(f"{where}.then", then, {"navigate", "params"})
            self.check_navigate(f"{where}.then", then)
        elif then not in ACTION_THEN:
            self.error(f"{where}.then", "must be 'refresh', 'back', 'update' or {navigate, params}")
        elif then == "update" and not self.in_row:
            # the answer's `item` is merged into the row the action ran from
            self.error(f"{where}.then", "update redraws a row: only in a media-list's or media-grid's quick and menu")

    def check_reloadable(self, where: str, name):
        if name not in RELOADABLE_CAPABILITIES:
            self.error(where, f"must be one of {sorted(RELOADABLE_CAPABILITIES)}")
        elif self.provides is not None and name not in self.provides:
            self.error(where, f"reloads what the Satellite's own {name} keeps, and it provides no {name}")

    def check_secrets(self, where: str, action: dict):
        """secrets: {key: {kind, new?}} (1.2), only in a protected document: before the request
        the client asks for each, in order, in its own prompt (twice for a `new` PIN) and puts it
        in the body under `key` - never in $form, $state or anything it keeps. Its words are the
        client's own and name the Satellite asking. No other document can raise such a prompt."""
        self.since(f"{where}.secrets", "secrets", 2)
        if not self.protected:
            self.error(f"{where}.secrets", "only a protected document asks for secrets")
        if self.in_bulk:
            self.error(f"{where}.secrets", "are asked once for one request: not in a selection or a tile's quick actions")
        if action.get("method") == "GET":
            self.error(f"{where}.secrets", "go in a POST's body, never in a GET")
        secrets = action["secrets"]
        if not isinstance(secrets, dict) or not secrets:
            self.error(f"{where}.secrets", "must be {key: {kind, new?}, ...}")
            return
        if len(secrets) > LIMITS["secrets"]:
            self.error(f"{where}.secrets", f"at most {LIMITS['secrets']} secrets for one action")
        body = action.get("body")
        for key, secret in secrets.items():
            at = f"{where}.secrets.{key}"
            if not IDENTIFIER.match(key):
                self.error(at, "the key must be an identifier")
            if isinstance(body, dict) and key in body:
                self.error(at, "is also in the body: the prompt fills it")
            if not isinstance(secret, dict):
                self.error(at, "must be {kind, new?}")
                continue
            self.unknown_keys(at, secret, {"kind", "new"})
            if secret.get("kind") not in SECRET_KINDS:
                self.error(f"{at}.kind", f"must be one of {sorted(SECRET_KINDS)}")
            if "new" in secret:
                if not isinstance(secret["new"], bool):
                    self.error(f"{at}.new", "must be true or false")
                elif secret["new"] and secret.get("kind") != "pin":
                    self.error(f"{at}.new", "only a PIN is chosen anew")

    def check_reveal(self, where: str, action: dict):
        """reveal: field (1.2), only in a protected document: when the request succeeds, the
        client shows that field of the answer once, in its own dialog, until the person confirms
        they stored it, then forgets it - it reaches no binding, notice or anything kept."""
        self.since(f"{where}.reveal", "reveal", 2)
        if not self.protected:
            self.error(f"{where}.reveal", "only a protected document reveals a secret")
        if self.in_bulk:
            self.error(f"{where}.reveal", "shows one answer: not in a selection or a tile's quick actions")
        if not isinstance(action["reveal"], str) or not IDENTIFIER.match(action["reveal"]):
            self.error(f"{where}.reveal", "must name one field of the answer")

    def check_file_action(self, where: str, action: dict, kind: str):
        """{download: route, name?} and {share: route, name?} (1.2): the client fetches one of
        the Satellite's own routes with its own session, then saves the file (download) or hands
        it to the system share sheet (share), named `name`. A download with `open: true` opens the
        file with the platform instead: a new browser tab, the phone's own viewer. Nothing is sent
        to the Satellite but that GET; a client that can't do it hides the control. One file at a
        time: not in a selection, and not in a tile's quick actions."""
        self.since(f"{where}.{kind}", f"the {kind} action", 2)
        self.unknown_keys(where, action, {kind, "name", "open"} if kind == "download" else {kind, "name"})
        self.check_route(f"{where}.{kind}", action[kind])
        if "name" in action:
            self.check_text(f"{where}.name", action["name"])
        if "open" in action and not isinstance(action["open"], bool):
            self.error(f"{where}.open", "must be true or false")
        if self.in_bulk:
            self.error(f"{where}.{kind}", "is one file at a time: not in a selection or a tile's quick actions")
        if kind == "share" and self.protected:
            self.error(f"{where}.share", "a protected document shares nothing")

    def check_section(self, where: str, action: dict):
        """{section: name} (1.2): the client opens the shared document of the Satellite `name`
        (a binding, or a Satellite's name) when that Satellite's manifest says it is a section of
        this one (section_of) - and nothing else: no route, no params. A client that can't open
        it (no such section, no shared document) hides the control or says so."""
        self.since(f"{where}.section", "the section action", 2)
        self.unknown_keys(where, action, {"section"})
        name = action["section"]
        if isinstance(name, str) and is_binding(name):
            self.check_binding(f"{where}.section", name)
        elif not isinstance(name, str) or not SATELLITE_NAME.fullmatch(name):
            self.error(f"{where}.section", "must be a Satellite's name or a binding to one")
        if self.in_bulk:
            self.error(f"{where}.section", "opens one section: not in a selection or a tile's quick actions")

    def check_sync(self, where: str, action: dict):
        """{sync: {capability}} (1.2): the client opens its own sync screen (the client
        capability sync_capabilities names) for the document's own Satellite, which must provide
        `capability`. The document supplies nothing else: no text, no route, no setting - the
        screen is the client's and reaches the provider through the capability's operations
        alone. A client without that screen hides the control."""
        self.since(f"{where}.sync", "the sync action", 2)
        self.unknown_keys(where, action, {"sync"})
        sync = action["sync"]
        if not isinstance(sync, dict) or set(sync) != {"capability"}:
            self.error(f"{where}.sync", "must be {capability}")
            return
        capability = sync["capability"]
        if not isinstance(capability, str) or capability not in SYNC_CAPABILITIES:
            self.error(f"{where}.sync.capability", f"must be one of {sorted(SYNC_CAPABILITIES)}")
            return
        if self.in_bulk:
            self.error(f"{where}.sync", "opens one screen: not in a selection or a tile's quick actions")
        if self.provides is not None and capability not in self.provides:
            self.error(f"{where}.sync", f"opens the Satellite's own {capability}, and it provides none")

    def check_upload(self, where: str, action: dict):
        """{upload: {multiple}, route, conflict?: {confirm?, route}, then?} (1.2): the person
        picks files on the device, and each is sent, one after another, as the raw body of a POST
        to `route`, with $value the file's {name, size} (the name made safe, as a download's).
        A 409 answer asks `conflict.confirm`, the client naming the file, then retries on
        `conflict.route`; declining skips that file. Without `conflict` a 409 is a failure. Each
        file is reported, and `then` runs once something arrived. Nothing reaches the Satellite
        but those POSTs; a client that can't pick files hides the control."""
        self.since(f"{where}.upload", "the upload action", 2)
        self.unknown_keys(where, action, {"upload", "route", "conflict", "then"})
        upload = action["upload"]
        if not isinstance(upload, dict):
            self.error(f"{where}.upload", "must be {multiple}")
        else:
            self.unknown_keys(f"{where}.upload", upload, {"multiple"})
            if "multiple" in upload and not isinstance(upload["multiple"], bool):
                self.error(f"{where}.upload.multiple", "must be true or false")
        self.check_route(f"{where}.route", action.get("route"))
        if "conflict" in action:
            conflict = action["conflict"]
            if not isinstance(conflict, dict):
                self.error(f"{where}.conflict", "must be {confirm, route}")
            else:
                self.unknown_keys(f"{where}.conflict", conflict, {"confirm", "route"})
                self.check_route(f"{where}.conflict.route", conflict.get("route"))
                if "confirm" in conflict:
                    self.check_text(f"{where}.conflict.confirm", conflict["confirm"])
        if action.get("then", "refresh") not in ("refresh", "back"):
            self.error(f"{where}.then", "must be 'refresh' or 'back'")
        if self.in_bulk:
            self.error(f"{where}.upload", "is a page's own action: not in a selection or a tile's quick actions")

    def check_choose(self, where: str, action: dict):
        """{choose: {source, items, item, title?, empty?, create?}, route, body?, conflict?, then?}
        (1.2): the person picks one row of the Satellite's own route `source` (its `items`, drawn
        as a media-list's rows, the source row as $. inside `item`) in the client's own dialog or
        sheet, then `route` runs with that row as $value. `create` offers one text field instead,
        and runs its own route with the text as $value. A 409 answer asks `conflict.confirm` (else
        the answer's error), then runs `conflict.route`; declining or cancelling runs nothing."""
        self.since(f"{where}.choose", "the choose action", 2)
        self.unknown_keys(where, action, {"choose", "route", "body", "conflict", "then"})
        choose = action["choose"]
        if not isinstance(choose, dict):
            self.error(f"{where}.choose", "must be {source, items, item}")
        else:
            self.unknown_keys(f"{where}.choose", choose, {"source", "items", "item", "title", "empty", "create"})
            self.check_route(f"{where}.choose.source", choose.get("source"))
            items = choose.get("items")
            if not is_binding(items):
                self.error(f"{where}.choose.items", "must bind the rows in the source's answer")
            else:
                self.check_binding(f"{where}.choose.items", items)
            item = choose.get("item")
            if not isinstance(item, dict):
                self.error(f"{where}.choose.item", "must be {title, subtitle?, image?}")
            else:
                self.unknown_keys(f"{where}.choose.item", item, {"title", "subtitle", "image"})
                if "title" not in item:
                    self.error(f"{where}.choose.item", "needs 'title'")
                for key in ("title", "subtitle"):
                    if key in item:
                        self.check_text(f"{where}.choose.item.{key}", item[key])
                if "image" in item:
                    self.check_route(f"{where}.choose.item.image", item["image"])
            for key in ("title", "empty"):
                if key in choose:
                    self.check_text(f"{where}.choose.{key}", choose[key])
            if "create" in choose:
                create = choose["create"]
                if not isinstance(create, dict):
                    self.error(f"{where}.choose.create", "must be {label, field, route, body?}")
                else:
                    self.unknown_keys(f"{where}.choose.create", create, {"label", "field", "route", "body"})
                    for key in ("label", "field"):
                        if key not in create:
                            self.error(f"{where}.choose.create", f"needs '{key}'")
                        else:
                            self.check_text(f"{where}.choose.create.{key}", create[key])
                    self.check_route(f"{where}.choose.create.route", create.get("route"))
                    self.check_body(f"{where}.choose.create.body", create)
        self.check_route(f"{where}.route", action.get("route"))
        self.check_body(f"{where}.body", action)
        if "conflict" in action:
            conflict = action["conflict"]
            if not isinstance(conflict, dict):
                self.error(f"{where}.conflict", "must be {confirm?, route, body?}")
            else:
                self.unknown_keys(f"{where}.conflict", conflict, {"confirm", "route", "body"})
                self.check_route(f"{where}.conflict.route", conflict.get("route"))
                self.check_body(f"{where}.conflict.body", conflict)
                if "confirm" in conflict:
                    self.check_text(f"{where}.conflict.confirm", conflict["confirm"])
        then = action.get("then")
        if isinstance(then, dict):
            self.unknown_keys(f"{where}.then", then, {"navigate", "params"})
            self.check_navigate(f"{where}.then", then)
        elif then is not None and then not in ("refresh", "back"):
            self.error(f"{where}.then", "must be 'refresh', 'back' or {navigate, params}")
        if self.in_bulk:
            self.error(f"{where}.choose", "asks the person: not in a selection or a tile's quick actions")

    def check_body(self, where: str, holder: dict):
        """An optional `body` of `holder`: an object of values and bindings."""
        if "body" not in holder:
            return
        if not isinstance(holder["body"], dict):
            self.error(where, "must be an object")
        else:
            self.check_values(where, holder["body"])

    def check_reorder(self, where: str, block: dict):
        """`reorder: {route, body?}` on a media-list (1.2): the person moves a row by its handle,
        the list moves at once, and `route` runs once per move with $value {from, to}, the row's
        old and new index; a failed move is put back. Every row must be loaded and stay apart:
        a key, and neither `more` nor `item.group`."""
        self.since(where, "media-list reorder", 2)
        reorder = block["reorder"]
        if not isinstance(reorder, dict):
            self.error(where, "must be {route, body?}")
            return
        self.unknown_keys(where, reorder, {"route", "body"})
        self.check_route(f"{where}.route", reorder.get("route"))
        self.check_body(f"{where}.body", reorder)
        item = block.get("item") if isinstance(block.get("item"), dict) else {}
        if "key" not in item:
            self.error(where, "needs item.key: a row is moved by its key")
        if "more" in block or "group" in item:
            self.error(where, "moves rows of a whole list: not with 'more' or item.group")

    def check_play(self, where: str, action: dict):
        """{play: {search} | {tracks | route, start?, shuffle?, queue?, context?}} (1.2): the
        client plays through its media.audio host. With `search` it plays what the audio.library
        provider finds. With `tracks` (a binding to a list of the page's tracks, or a list of
        bindings to single ones) or `route` (a GET of the Satellite's own route answering
        {tracks}) it plays those tracks of the document's own Satellite, which must provide
        audio.library: the host resolves each id through that provider, never a stream URL from
        the document. `start` binds the id of the track to begin with, `shuffle` shuffles, `queue`
        ("next" or "end") adds to the queue instead of replacing it, and `context` (text or a
        binding, at most 80 characters) is what the host reports with each play. A `route` answer may
        be paged ({tracks, count, cursor}): the host asks for more as the queue runs low, and draws a
        shuffle's positions lazily (docs/media-audio.md)."""
        self.since(f"{where}.play", "the play action", 2)
        self.unknown_keys(where, action, {"play"})
        play = action["play"]
        sources = [key for key in PLAY_SOURCES if isinstance(play, dict) and key in play]
        if len(sources) != 1:
            self.error(f"{where}.play", "must be {search}, {tracks} or {route}, exactly one of them")
            return
        source = sources[0]
        if source == "search":
            self.unknown_keys(f"{where}.play", play, {"search"})
            if not isinstance(play["search"], str) or not play["search"].strip():
                self.error(f"{where}.play.search", "must be a non-empty text or binding")
                return
            self.check_values(f"{where}.play.search", play["search"])
            return
        self.unknown_keys(f"{where}.play", play, {source, "start", "shuffle", "queue", "context"})
        self.check_track_source(f"{where}.play", play, source)
        if "start" in play:
            if not is_binding(play["start"]):
                self.error(f"{where}.play.start", "must bind a track id")
            else:
                self.check_binding(f"{where}.play.start", play["start"])
        if "shuffle" in play and not isinstance(play["shuffle"], bool):
            self.error(f"{where}.play.shuffle", "must be true or false")
        if "queue" in play and play["queue"] not in PLAY_QUEUE:
            self.error(f"{where}.play.queue", f"must be one of {sorted(PLAY_QUEUE)}")
        if "queue" in play and ("start" in play or play.get("shuffle")):
            self.error(f"{where}.play.queue", "adds to the queue: not with start or shuffle")
        if "start" in play and play.get("shuffle"):
            self.error(f"{where}.play.start", "starts at a track: not with shuffle")
        if "context" in play:
            context = play["context"]
            if not isinstance(context, str) or not context or (
                    not is_binding(context) and len(context) > LIMITS["play_context"]):
                self.error(f"{where}.play.context", f"must be a text of at most {LIMITS['play_context']} characters, or a binding")
            else:
                self.check_text(f"{where}.play.context", context)
        if self.in_selection:
            self.error(f"{where}.play", "plays one list: not in a selection")
        if self.provides is not None and AUDIO_LIBRARY not in self.provides:
            self.error(f"{where}.play", f"plays the Satellite's own tracks, and it provides no {AUDIO_LIBRARY}")

    def check_track_source(self, where: str, spec: dict, source: str):
        """A play's or an offline's tracks: `tracks` (a binding to a list of the page's tracks, or
        a list of bindings to single ones) or `route` (a GET of the Satellite's own route)."""
        if source == "tracks":
            tracks = spec["tracks"]
            if isinstance(tracks, list):
                if not tracks or len(tracks) > LIMITS["play_tracks"] or not all(is_binding(item) for item in tracks):
                    self.error(f"{where}.tracks", f"must be a binding, or a list of 1 to {LIMITS['play_tracks']} bindings")
                else:
                    for index, item in enumerate(tracks):
                        self.check_binding(f"{where}.tracks[{index}]", item)
            elif is_binding(tracks):
                self.check_binding(f"{where}.tracks", tracks)
            else:
                self.error(f"{where}.tracks", "must be a binding, or a list of bindings")
        else:
            self.check_route(f"{where}.route", spec["route"])

    def check_offline_action(self, where: str, action: dict):
        """{offline: {tracks | route}} (1.2, change 10): the client keeps those tracks of the
        document's own Satellite, which must provide audio.library, on the device (its
        media.audio-offline), at the listener's download quality, network rule and storage limit.
        `tracks` and `route` are a play's. The control's label and state are the client's
        (Download, Downloading 3 of 12, Downloaded with Remove download): the document supplies no
        path, URL or storage setting. A client without it hides the control."""
        self.since(f"{where}.offline", "the offline action", 2)
        self.unknown_keys(where, action, {"offline"})
        offline = action["offline"]
        sources = [key for key in ("tracks", "route") if isinstance(offline, dict) and key in offline]
        if len(sources) != 1:
            self.error(f"{where}.offline", "must be {tracks} or {route}, exactly one of them")
            return
        self.unknown_keys(f"{where}.offline", offline, {sources[0]})
        self.check_track_source(f"{where}.offline", offline, sources[0])
        if self.in_selection:
            self.error(f"{where}.offline", "keeps one list: not in a selection")
        if self.provides is not None and AUDIO_LIBRARY not in self.provides:
            self.error(f"{where}.offline", f"keeps the Satellite's own tracks, and it provides no {AUDIO_LIBRARY}")

    def check_own(self, where: str, action: dict):
        """{own: section} (1.2): the client opens the Satellite's own interface - its page.js on
        the web, its native screens in the app - at a section that interface names ("settings").
        A bridge to what stays native while a Satellite migrates: it reaches no route and grants
        nothing; the own interface enforces its own rules (a PIN, a permission) as it always did.
        A client without an own interface for the Satellite hides the control."""
        self.since(f"{where}.own", "the own action", 2)
        self.unknown_keys(where, action, {"own"})
        section = action["own"]
        if not isinstance(section, str) or not OWN_SECTION.fullmatch(section):
            self.error(f"{where}.own", "must be a section name: lowercase letters, digits and '-', up to 32")

    def check_secure(self, where: str, action: dict):
        """{secure: {capability, operation}, item, confirm, then} (1.2): in a media viewer's or
        selection's actions, the client runs one operation the vocabulary allows
        (secure_operations: media.vault move_in) on the items shown or selected - once, for all
        of them - behind its own unlock prompt. `item` binds each item's id; the client sends
        references to the document Satellite's own media.gallery items, which the server
        resolves itself. The document supplies no prompt, no PIN field and no route."""
        self.since(f"{where}.secure", "the secure action", 2)
        self.unknown_keys(where, action, {"secure", "item", "confirm", "then"})
        if not self.in_media_actions:
            self.error(f"{where}.secure", "is only for a media viewer's or selection's actions")
        secure = action["secure"]
        if not isinstance(secure, dict) or set(secure) != {"capability", "operation"}:
            self.error(f"{where}.secure", "must be {capability, operation}")
        elif (not isinstance(secure["capability"], str) or not isinstance(secure["operation"], str)
              or secure["operation"] not in SECURE_OPERATIONS.get(secure["capability"], ())):
            allowed = sorted(f"{name} {operation}" for name, operations in SECURE_OPERATIONS.items()
                             for operation in operations)
            self.error(f"{where}.secure", f"must be one of {allowed}")
        item = action.get("item")
        if not (isinstance(item, str) and item.startswith("$.") and valid_binding(item)):
            self.error(f"{where}.item", "must bind each item's id ($.id)")
        if "confirm" in action:
            self.check_text(f"{where}.confirm", action["confirm"])
        if action.get("then", "refresh") not in ("refresh", "back"):
            self.error(f"{where}.then", "must be 'refresh' or 'back'")
        if self.provides is not None and SECURE_ITEMS not in self.provides:
            self.error(f"{where}.secure", f"acts on the Satellite's own {SECURE_ITEMS} items, and it provides none")

    def check_pick(self, where: str, pick):
        """{pick: {capability, kinds, multiple, title}, route, body, then} (1.2): the client's
        media picker lets the person choose from whichever Satellite provides `capability`,
        then the action's route gets what was chosen as $value - a list of references
        ({provider, capability, id, kind}), never paths. Cancelling runs nothing."""
        self.since(f"{where}.pick", "the pick action", 2)
        if not isinstance(pick, dict):
            self.error(f"{where}.pick", "must be {capability, kinds, multiple, title}")
            return
        self.unknown_keys(f"{where}.pick", pick, {"capability", "kinds", "multiple", "title"})
        if pick.get("capability") not in PICKABLE:
            self.error(f"{where}.pick.capability", f"must be one of {sorted(PICKABLE)}")
        kinds = pick.get("kinds", sorted(MEDIA_KINDS))
        if not isinstance(kinds, list) or not kinds or not set(kinds) <= MEDIA_KINDS:
            self.error(f"{where}.pick.kinds", f"must be a non-empty list of {sorted(MEDIA_KINDS)}")
        if "multiple" in pick and not isinstance(pick["multiple"], bool):
            self.error(f"{where}.pick.multiple", "must be true or false")
        if "title" in pick:
            self.check_text(f"{where}.pick.title", pick["title"])

    def check_navigate(self, where: str, action: dict):
        target = action.get("navigate")
        if target not in self.pages:
            self.error(f"{where}.navigate", f"unknown page {target!r}")
            return
        params = action.get("params", {})
        if not isinstance(params, dict):
            self.error(f"{where}.params", "must be an object")
            return
        self.check_values(f"{where}.params", params)
        missing = [name for name in self.page_params(target) if name not in params]
        if missing:
            self.error(f"{where}.params", f"page {target!r} needs {missing}")

    def check_route(self, where: str, template):
        if not isinstance(template, str) or not template:
            self.error(where, "needs a route")
            return
        for expression in PLACEHOLDER.findall(template):
            self.check_binding(where, expression)
        # every placeholder stands for an encoded value, so checking the
        # template with "x" in each one checks every route it can produce
        if not is_safe_route(PLACEHOLDER.sub("x", template)):
            self.error(where, f"route {template!r} must be relative to the Satellite "
                              "(no leading '/', no '..', no scheme, no Core segment)")

    def check_text(self, where: str, value):
        if isinstance(value, str):
            if is_binding(value):
                self.check_binding(where, value)
        elif not isinstance(value, (int, float, bool)) and value is not None:
            self.error(where, "must be text, a number or a binding")

    def check_value(self, where: str, value):
        if is_binding(value):
            self.check_binding(where, value)

    def check_values(self, where: str, value):
        if isinstance(value, dict):
            for key, item in value.items():
                self.check_values(f"{where}.{key}", item)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                self.check_values(f"{where}[{index}]", item)
        elif is_binding(value):
            self.check_binding(where, value)

    def check_number_or_binding(self, where: str, value):
        if is_binding(value):
            self.check_binding(where, value)
        elif isinstance(value, bool) or not isinstance(value, (int, float)):
            self.error(where, "must be a number or a binding")

    def check_binding(self, where: str, value, required: bool = False, choices: set = None):
        if is_binding(value) and valid_binding(value):
            if value.startswith("$value."):
                self.since(where, "$value. bindings", 2)
            if self.in_audio and any(value == root or value.startswith(f"{root}.") for root in AUDIO_BINDINGS):
                self.error(where, f"{value!r}: the player has no page, only the playing track ($.)")
                return
            self.check_scope(where, value)
            return
        if required and not is_binding(value):
            self.error(where, f"must be one of {sorted(choices)} or a binding")
        else:
            self.error(where, f"binding {value!r} must start with $., $page., $params., $form., $state., "
                              "$sources. or be $value")

    def check_scope(self, where: str, value: str):
        """$state.x and $sources.x must name what the page declares."""
        for root, declared, what in (("$state", self.state_keys, "state"), ("$sources", self.source_names, "sources")):
            if value == root or value.startswith(f"{root}."):
                self.since(where, f"{root} bindings")
                name = value[len(root) + 1:].split(".")[0]
                if name and name not in declared:
                    self.error(where, f"{value!r}: the page declares no {what} entry {name!r}")


def normalise_provides(provides) -> tuple:
    """A manifest's [provides] table as ({capability: {version, operations}},
    problems). A capability with any problem is left out entirely, so a
    client never binds a shared block to a half-declared provider."""
    if provides is None:
        return {}, []
    if not isinstance(provides, dict):
        return {}, ["[provides] must be a table of capabilities"]
    normalised, problems = {}, []
    for name, entry in provides.items():
        found = []
        if not isinstance(entry, dict):
            problems.append(f"provides.{name} must be a table")
            continue
        version = entry.get("version", 1)
        operations = entry.get("operations", {})
        if isinstance(version, bool) or not isinstance(version, int):
            found.append(f"provides.{name}.version must be an integer")
        if not isinstance(operations, dict):
            found.append(f"provides.{name}.operations must map operations to routes")
            operations = {}
        for operation, route in operations.items():
            if not isinstance(route, str) or not is_safe_route(route):
                found.append(f"provides.{name}.operations.{operation} must be one of the Satellite's own routes")
        known = SATELLITE_CAPABILITIES.get(name)
        if known and not found:
            if version not in known["versions"]:
                found.append(f"provides.{name}: version {version} is not one this Engine knows")
            missing = known["operations"] - set(operations)
            if missing:
                found.append(f"provides.{name} is missing operations {sorted(missing)}")
            unknown = set(operations) - known["operations"] - known["optional"]
            if unknown:
                found.append(f"provides.{name} has operations version {version} doesn't define: {sorted(unknown)}")
        declared = {}
        if known and known["declares"] and not found:
            declared = _declared(name, entry, found)
        if found:
            problems.extend(found)
        else:
            normalised[name] = {"version": version, "operations": dict(operations), **declared}
    return normalised, problems


def _declared(name: str, entry: dict, found: list) -> dict:
    """What a files.open provider says it opens (change 16): its types, from FILE_KINDS, its
    extensions (in place of the types' lists) and its label - as the catalog publishes them."""
    declared = {}
    types = entry.get("types")
    if (not isinstance(types, list) or not types or not all(isinstance(kind, str) for kind in types)
            or set(types) - set(FILE_KINDS) or len(set(types)) != len(types)):
        found.append(f"provides.{name}.types must be a list of {sorted(FILE_KINDS)}")
    else:
        declared["types"] = list(types)
    if "extensions" in entry:
        extensions = entry["extensions"]
        limit = LIMITS["opener_extensions"]
        if (not isinstance(extensions, list) or not extensions or len(extensions) > limit
                or not all(isinstance(ext, str) and FILE_EXTENSION.fullmatch(ext) for ext in extensions)):
            found.append(f"provides.{name}.extensions must be 1 to {limit} extensions such as \".jpg\" (lower case)")
        else:
            declared["extensions"] = sorted(set(extensions))
    if "label" in entry:
        label = entry["label"]
        if not isinstance(label, str) or not label.strip() or len(label) > OPENER_LABEL_LIMIT:
            found.append(f"provides.{name}.label must be 1 to {OPENER_LABEL_LIMIT} characters")
        else:
            declared["label"] = label.strip()
    return declared


def contract_info() -> dict:
    """What this Engine supports - reported by GET /api/catalog."""
    return {
        "name": CONTRACT_NAME,
        "version": f"{MAJOR}.{MINOR}",
        "majors": [MAJOR],
        "capabilities": {name: sorted(entry["versions"]) for name, entry in SATELLITE_CAPABILITIES.items()},
    }


class UiDefinition:
    """What a Satellite's ui.json resolved to at its last (re)discovery:
    a validated document and its revision, or the reason it was refused."""

    def __init__(self, document=None, error: str = None):
        self.document = document
        self.error = error
        self.revision = revision(document) if document is not None else None

    def describe(self):
        if self.error:
            return {"contract": None, "revision": None, "error": self.error}
        described = {"contract": self.document["contract"], "revision": self.revision, "error": None}
        if self.document.get("preview") is True:
            # 1.2: clients with the Satellite's own interface keep opening it (docs/ui-contract.md)
            described["preview"] = True
        return described


def load_definition(satellite_dir: Path, satellite_name: str, provides=None, icons=None):
    """The UiDefinition for a Satellite directory, or None when it has no
    ui.json. Only reads and validates a JSON file - never imports code.
    `provides` is the Satellite's normalised [provides] table, `icons` its own
    icons (engine/starcore/icons.py), served in the document."""
    path = satellite_dir / UI_FILENAME
    if not path.is_file():
        return None
    try:
        return UiDefinition(load(path, provides, icons))
    except UiDocumentError as error:
        message = f"{UI_FILENAME} {error}"
        print(f"[WARNING]: {message} (satellite '{satellite_name}'). Its interface is not offered to clients.")
        return UiDefinition(error=message)


# ---------- formats ----------
#
# The same rules as Mission Control's contract.js and the app's contract.ts,
# checked against the same fixtures (contracts/ui/fixtures/formats.json). A
# Satellite uses this to build a line of text out of several values - the
# clients format single values themselves.

DASH = "—"
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _trim(value: float, digits: int) -> str:
    rounded = _round_half_up(value, digits)
    text = f"{rounded:.{digits}f}".rstrip("0").rstrip(".") if digits else str(int(rounded))
    return "0" if text in ("-0", "") else text


def _round_half_up(value: float, digits: int) -> float:
    # JavaScript's toFixed and Math.round round halves away from zero for
    # the values formats see; Python's round() rounds them to even
    factor = 10 ** digits
    return math.floor(abs(value) * factor + 0.5) / factor * (1 if value >= 0 else -1)


def _scaled(value: float, units, base: int) -> str:
    index, amount = 0, value
    while abs(amount) >= base and index < len(units) - 1:
        amount /= base
        index += 1
    return f"{_trim(amount, 0) if index == 0 else _trim(amount, 1)} {units[index]}"


def _duration(seconds: float) -> str:
    total = int(_round_half_up(seconds, 0))
    parts = ((86400, "d"), (3600, "h"), (60, "m"), (1, "s"))
    for index, (size, unit) in enumerate(parts):
        if total >= size or size == 1:
            whole = total // size
            rest = (total % size) // parts[index + 1][0] if index < len(parts) - 1 else 0
            return f"{whole}{unit} {rest}{parts[index + 1][1]}" if rest else f"{whole}{unit}"
    return f"{total}s"


def _relative(seconds: float, now: float) -> str:
    difference = now - seconds
    size = abs(difference)
    if size < 10:
        return "just now"
    if size < 60:
        amount = f"{int(size)}s"
    elif size < 3600:
        amount = f"{int(size // 60)} min"
    elif size < 86400:
        amount = f"{int(size // 3600)} h"
    else:
        amount = f"{int(size // 86400)} d"
    return f"{amount} ago" if difference > 0 else f"in {amount}"


def format_value(value, format: str = "text", unit=None, now: float = None, utc: bool = False) -> str:
    """A value as display text - "Formats" in docs/ui-contract.md."""
    numeric = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if value is None or isinstance(value, (dict, list)):
        return DASH
    if isinstance(value, bool):
        text = "Yes" if value else "No"
    elif not numeric:
        text = str(value)
    elif format == "integer":
        text = _trim(value, 0)
    elif format == "percent":
        return f"{_trim(value, 1)}%"
    elif format == "bytes":
        return _scaled(value, ("B", "KB", "MB", "GB", "TB"), 1024)
    elif format == "byterate":
        return f"{_scaled(value, ('B', 'KB', 'MB', 'GB', 'TB'), 1024)}/s"
    elif format == "bitrate":
        return _scaled(max(value, 0) * 8, ("b/s", "kb/s", "Mb/s", "Gb/s", "Tb/s"), 1000)
    elif format == "duration":
        return _duration(value)
    elif format in ("time", "date", "datetime"):
        moment = time.gmtime(value) if utc else time.localtime(value)
        clock = f"{moment.tm_hour:02d}:{moment.tm_min:02d}"
        day = f"{moment.tm_mday} {MONTHS[moment.tm_mon - 1]} {moment.tm_year}"
        return clock if format == "time" else day if format == "date" else f"{day}, {clock}"
    elif format == "relative":
        return _relative(value, time.time() if now is None else now)
    else:
        text = _trim(value, 2)
    return f"{text} {unit}" if unit else text
