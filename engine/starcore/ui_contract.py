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
MINOR = 1
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
CHART_KINDS = set(VOCABULARY["chart_kinds"])
COLUMN_ALIGN = set(VOCABULARY["column_align"])
PAGE_TEMPLATES = set(VOCABULARY["page_templates"])
# what arrived in 1.1: a document declaring 1.0 may not use it, so that a
# document always says which minor it needs (clients that know only 1.0
# skip a newer document's unknown blocks; a 1.0 one must not have any)
SINCE_1_1 = VOCABULARY["since"]["1.1"]
BLOCKS_1_1 = set(SINCE_1_1["blocks"])
FORMATS_1_1 = set(SINCE_1_1["formats"])
# Satellite capabilities with a protocol this Engine knows: their versions, the
# operations every provider must offer and those it may. A Satellite may also
# declare a capability that isn't listed (the registry reports it as declared).
# Clients draw a shared block only for the capabilities they list themselves.
SATELLITE_CAPABILITIES = {name: {"versions": set(spec["versions"]), "operations": set(spec["operations"]),
                                 "optional": set(spec.get("optional_operations", {}))}
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
BINDING_ROOTS = ("$.", "$page.", "$params.", "$form.", "$state.", "$sources.")
BINDING_WORDS = {"$", "$value", "$page", "$params", "$form", "$state", "$sources"}


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
        self.minor = MINOR
        self.pages = {}
        # what the blocks being checked can bind to: the page's declared
        # state keys and named sources (the header's and each widget's own
        # scope declare neither)
        self.state_keys = set()
        self.source_names = set()

    def since(self, where: str, what: str):
        """`what` arrived in 1.1: refused in a document that declares 1.0."""
        if self.minor < 1:
            self.error(where, f"{what} needs {CONTRACT_NAME}/1.1 or later (the document declares 1.{self.minor})")

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

        known = {"contract", "title", "requires", "entry", "navigation", "pages", "header", "widgets"}
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
            if "icon" in item and item["icon"] not in ICONS:
                self.error(where, f"unknown icon {item['icon']!r}")

        for page_id, page in pages.items():
            self.check_page(f"pages.{page_id}", page)
        if "header" in document:
            self.check_header(document["header"])
        if "widgets" in document:
            self.check_widgets(document["widgets"])
        return self.errors

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
            if "icon" in widget and widget["icon"] not in ICONS:
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

    def check_page(self, where: str, page):
        if not isinstance(page, dict):
            self.error(where, "must be an object")
            return
        self.unknown_keys(where, page, {"title", "params", "source", "sources", "state", "template", "blocks"})
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

    def check_block(self, where: str, block, depth: int):
        if not isinstance(block, dict):
            self.error(where, "must be an object")
            return
        kind = block.get("type")
        if kind not in BLOCKS:
            if not self.lenient:
                self.error(where, f"unknown block type {kind!r}")
            return
        if kind in BLOCKS_1_1:
            self.since(where, f"the {kind} block")
        required, optional = BLOCKS[kind]
        for key in sorted(required - block.keys()):
            self.error(where, f"{kind} needs {key!r}")
        self.unknown_keys(where, block, required | optional | COMMON_BLOCK_KEYS)
        if "visible" in block and not isinstance(block["visible"], bool):
            self.check_text(f"{where}.visible", block["visible"])
        for key in ("required", "developer"):
            if key in block and not isinstance(block[key], bool):
                self.error(f"{where}.{key}", "must be true or false")

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
        elif kind == "list":
            self.check_list(where, block)
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
        self.unknown_keys(f"{where}.item", item, {"title", "subtitle", "value", "format", "icon", "tone"})
        if "tone" in item:
            self.since(f"{where}.item.tone", "a list item's tone")
            if item["tone"] not in TONES:
                self.check_binding(f"{where}.item.tone", item["tone"], required=True, choices=TONES)
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
        else:
            for key, value in formats.items():
                self.check_format(f"{where}.item.format.{key}", value)

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
