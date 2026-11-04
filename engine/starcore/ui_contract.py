"""StarCore UI contract v1 - the Engine's side.

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
  that shared blocks such as `file-browser` are bound to.

A document is presentation only. It grants nothing: every route it names is
an ordinary Satellite route, with the same authentication as any other.
Reading `ui.json` never imports or runs Python, which is why rediscovery can
refresh it safely without reloading a Satellite's code.
"""

from hashlib import sha256
from pathlib import Path
import json
import re

CONTRACT_NAME = "starcore.ui"
MAJOR = 1
MINOR = 0
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
FILE_BROWSER_SELECT = set(VOCABULARY["file_browser_select"])
ACTION_THEN = set(VOCABULARY["action_then"])
METHODS = set(VOCABULARY["methods"])
ICONS = set(VOCABULARY["icons"])
# Satellite capabilities a shared block can be bound to, with the protocol
# versions and operations this Engine knows. A Satellite may also declare a
# capability that isn't listed (the registry reports it as declared), but
# only these have a shared block on the clients.
SATELLITE_CAPABILITIES = {name: {"versions": set(spec["versions"]), "operations": set(spec["operations"])}
                          for name, spec in VOCABULARY["satellite_capabilities"].items()}
# the shared block bound to each capability
CAPABILITY_BLOCKS = {"file-browser": "files.browse"}
LIMITS = dict(VOCABULARY["limits"])

# segments the Core itself owns beneath every /api/satellites/<name>/ (see
# api/server.py) - a document can never point an action at them
RESERVED_SEGMENTS = {"assets", "enable", "disable", "reload", "ui"}

CONTRACT_PATTERN = re.compile(r"^starcore\.ui/(\d+)\.(\d+)$")
PAGE_ID = re.compile(r"^[a-z][a-z0-9_-]{0,47}$")
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,47}$")
FIRST_SEGMENT = re.compile(r"^[A-Za-z0-9_-]+$")
SEGMENT = re.compile(r"^[A-Za-z0-9_.~%-]+$")
QUERY = re.compile(r"^[A-Za-z0-9_.~%&=+-]*$")
PLACEHOLDER = re.compile(r"\{([^{}]*)\}")
BINDING_ROOTS = ("$.", "$page.", "$params.", "$form.")
BINDING_WORDS = {"$", "$value", "$page", "$params", "$form"}


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


def revision(document) -> str:
    """A content hash of a document: the same document always gets the same
    revision, so it doubles as its ETag and as the cache key on clients."""
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256(canonical.encode("utf-8")).hexdigest()[:16]


def load(path: Path) -> dict:
    """Reads and validates one ui.json. Raises UiDocumentError."""
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
    errors = validate(document)
    if errors:
        more = f" (and {len(errors) - 1} more)" if len(errors) > 1 else ""
        raise UiDocumentError(f"is invalid: {errors[0]}{more}")
    return document


def validate(document) -> list:
    """Every problem with a document, as "where: what" strings; [] if valid."""
    return _Validator(document).run()


class _Validator:
    def __init__(self, document):
        self.document = document
        self.errors = []
        self.lenient = False  # a newer minor: unknown blocks and keys are skipped by clients
        self.pages = {}

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

        known = {"contract", "title", "requires", "entry", "navigation", "pages"}
        self.unknown_keys("", document, known)
        if "title" in document and not isinstance(document["title"], str):
            self.error("title", "must be a string")
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
            self.unknown_keys(where, item, {"page", "label", "icon"})
            if item.get("page") not in pages:
                self.error(where, f"unknown page {item.get('page')!r}")
            elif self.page_params(item["page"]):
                self.error(where, "a navigation page cannot require params")
            if not isinstance(item.get("label"), str) or not item["label"]:
                self.error(where, "needs a label")
            if "icon" in item and item["icon"] not in ICONS:
                self.error(where, f"unknown icon {item['icon']!r}")

        for page_id, page in pages.items():
            self.check_page(f"pages.{page_id}", page)
        return self.errors

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

    def check_page(self, where: str, page):
        if not isinstance(page, dict):
            self.error(where, "must be an object")
            return
        self.unknown_keys(where, page, {"title", "params", "source", "blocks"})
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

    def check_block(self, where: str, block, depth: int):
        if not isinstance(block, dict):
            self.error(where, "must be an object")
            return
        kind = block.get("type")
        if kind not in BLOCKS:
            if not self.lenient:
                self.error(where, f"unknown block type {kind!r}")
            return
        required, optional = BLOCKS[kind]
        for key in sorted(required - block.keys()):
            self.error(where, f"{kind} needs {key!r}")
        self.unknown_keys(where, block, required | optional | COMMON_BLOCK_KEYS)
        if "visible" in block and not isinstance(block["visible"], bool):
            self.check_text(f"{where}.visible", block["visible"])
        for key in ("required", "developer"):
            if key in block and not isinstance(block[key], bool):
                self.error(f"{where}.{key}", "must be true or false")

        for key in ("text", "label", "title", "description", "empty", "value", "unit"):
            if key in block and not (kind in ("toggle", "slider", "field", "metric") and key == "value"):
                self.check_text(f"{where}.{key}", block[key])
        if kind in ("field", "metric", "toggle", "slider") and "value" in block:
            self.check_value(f"{where}.value", block["value"])
        if "format" in block and kind != "list" and block["format"] not in FORMATS:
            self.error(f"{where}.format", f"unknown format {block['format']!r}")
        if "tone" in block and block["tone"] not in TONES:
            self.check_binding(f"{where}.tone", block["tone"], required=True, choices=TONES)
        if "style" in block:
            styles = TEXT_STYLES if kind == "text" else BUTTON_STYLES
            if block["style"] not in styles:
                self.error(f"{where}.style", f"must be one of {sorted(styles)}")
        for key in ("max", "min", "step"):
            if key in block:
                self.check_number_or_binding(f"{where}.{key}", block[key])
        if "action" in block:
            self.check_action(f"{where}.action", block["action"])

        if kind == "card" and isinstance(block.get("blocks"), list):
            self.check_blocks(f"{where}.blocks", block["blocks"], depth + 1)
        elif kind == "card" and "blocks" in block:
            self.error(f"{where}.blocks", "must be a list")
        elif kind == "list":
            self.check_list(where, block)
        elif kind == "form":
            self.check_form(where, block)
        elif kind == "file-browser":
            if block.get("capability") != CAPABILITY_BLOCKS[kind]:
                self.error(f"{where}.capability", f"a file-browser is bound to the {CAPABILITY_BLOCKS[kind]!r} capability")
            if "select" in block and block["select"] not in FILE_BROWSER_SELECT:
                self.error(f"{where}.select", f"must be one of {sorted(FILE_BROWSER_SELECT)}")

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
        self.unknown_keys(f"{where}.item", item, {"title", "subtitle", "value", "format", "icon"})
        if "title" not in item:
            self.error(f"{where}.item", "needs 'title'")
        for key in ("title", "subtitle", "value"):
            if key in item:
                self.check_text(f"{where}.item.{key}", item[key])
        if "icon" in item and item["icon"] not in ICONS:
            self.check_binding(f"{where}.item.icon", item["icon"], required=True, choices=ICONS)
        formats = item.get("format", {})
        if not isinstance(formats, dict) or any(value not in FORMATS for value in formats.values()):
            self.error(f"{where}.item.format", "must map 'subtitle'/'value' to a known format")

    def check_form(self, where: str, block: dict):
        fields = block.get("fields")
        if not isinstance(fields, list) or not fields:
            self.error(f"{where}.fields", "must be a non-empty list")
            fields = []
        keys = set()
        for index, field in enumerate(fields):
            at = f"{where}.fields[{index}]"
            if not isinstance(field, dict):
                self.error(at, "must be an object")
                continue
            self.unknown_keys(at, field, {"key", "label", "kind", "value", "options", "placeholder", "required"})
            key = field.get("key")
            if not isinstance(key, str) or not IDENTIFIER.match(key):
                self.error(at, "needs an identifier 'key'")
            elif key in keys:
                self.error(at, f"duplicate key {key!r}")
            keys.add(key)
            if not isinstance(field.get("label"), str):
                self.error(at, "needs a 'label'")
            if field.get("kind") not in FORM_FIELD_KINDS:
                self.error(at, f"kind must be one of {sorted(FORM_FIELD_KINDS)}")
            if field.get("kind") == "select":
                options = field.get("options")
                if not isinstance(options, list) or not options or not all(
                        isinstance(o, dict) and isinstance(o.get("label"), str) and "value" in o for o in options):
                    self.error(at, "a select needs 'options': [{value, label}, ...]")
        submit = block.get("submit")
        if not isinstance(submit, dict) or not isinstance(submit.get("label"), str) or "action" not in submit:
            self.error(f"{where}.submit", "needs a 'label' and an 'action'")
        else:
            self.unknown_keys(f"{where}.submit", submit, {"label", "action"})
            self.check_action(f"{where}.submit.action", submit["action"])

    def check_action(self, where: str, action):
        if not isinstance(action, dict):
            self.error(where, "must be an object")
            return
        if "navigate" in action:
            self.unknown_keys(where, action, {"navigate", "params"})
            self.check_navigate(where, action)
            return
        self.unknown_keys(where, action, {"route", "method", "body", "confirm", "then"})
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
            self.error(f"{where}.then", "must be 'refresh', 'back' or {navigate, params}")

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
            return
        if is_binding(value):
            self.error(where, f"binding {value!r} must start with $., $page., $params., $form. or be $value")
        elif required:
            self.error(where, f"must be one of {sorted(choices)} or a binding")
        else:
            self.error(where, f"binding {value!r} must start with $., $page., $params., $form. or be $value")


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
        if found:
            problems.extend(found)
        else:
            normalised[name] = {"version": version, "operations": dict(operations)}
    return normalised, problems


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
        return {"contract": self.document["contract"], "revision": self.revision, "error": None}


def load_definition(satellite_dir: Path, satellite_name: str):
    """The UiDefinition for a Satellite directory, or None when it has no
    ui.json. Only reads and validates a JSON file - never imports code."""
    path = satellite_dir / UI_FILENAME
    if not path.is_file():
        return None
    try:
        return UiDefinition(load(path))
    except UiDocumentError as error:
        message = f"{UI_FILENAME} {error}"
        print(f"[WARNING]: {message} (satellite '{satellite_name}'). Its interface is not offered to clients.")
        return UiDefinition(error=message)
