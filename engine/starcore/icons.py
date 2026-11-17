"""A Satellite's own icons (UI contract 1.2, contract change 5).

A Satellite may ship icons beyond the shared set: SVG files in an `icons/`
folder beside its satellite.toml, declared there in an `[icons]` table that
names, for each one, the shared icon clients draw when its file is refused:

    icon = "logo"            # the Satellite's own icon, one of [icons]
    icon_name = "camera"     # its shared icon
    [icons]
    logo = "camera"
    albums = "folder"

The Engine is the only place that ever reads one of these files. It accepts
a small, Feather-like subset of SVG - a 24 x 24 view box, stroked shapes in
the current colour, nothing filled, no script, style, link, transform or
colour - and turns every shape into absolute path data made of `M`, `L`, `C`
and `Z` only. Clients draw those paths with the stroke width given, in their
own colour: they never parse an SVG, so a file can't run anything or reach
anything, and every icon is single colour and tinted by the client's tokens.

What a client gets for an icon: {"fallback": "<shared icon>", "stroke": 1.6,
"paths": ["M3 6.5L...Z", ...]}, or {"fallback": ...} alone for a refused
file.
"""

from pathlib import Path
import math
import re
import xml.etree.ElementTree as ElementTree

from . import ui_contract

FOLDER = "icons"
# an own icon's name: never one of the shared set's, so a name in a document means one thing
OWN_NAME = ui_contract.OWN_ICON_NAME

LIMITS = ui_contract.LIMITS
SVG_NAMESPACE = "{http://www.w3.org/2000/svg}"
SHAPES = {"path", "line", "polyline", "polygon", "circle", "ellipse", "rect"}
IGNORED = {"title", "desc"}
# the presentation attributes a shape or group may carry: what clients draw anyway
STYLE = {"fill": {"none"}, "stroke": {"currentColor"}, "stroke-linecap": {"round"}, "stroke-linejoin": {"round"}}
GEOMETRY = {
    "path": {"d"},
    "line": {"x1", "y1", "x2", "y2"},
    "polyline": {"points"},
    "polygon": {"points"},
    "circle": {"cx", "cy", "r"},
    "ellipse": {"cx", "cy", "rx", "ry"},
    "rect": {"x", "y", "width", "height", "rx", "ry"},
}
ROOT = {"viewBox", "width", "height", "version", "stroke-width"}
MAX_DEPTH = 4
MAX_COORDINATE = 1000.0
# a quarter circle as a cubic curve
KAPPA = 0.5522847498307936


class IconError(ValueError):
    """A file that can't be served as an icon."""


def load_icons(satellite_dir: Path, declared) -> tuple:
    """A manifest's [icons] table as ({name: icon}, problems). A declaration with a bad name or
    fallback is left out; a refused file keeps its name with its fallback alone, so a document
    naming it still draws something."""
    if declared is None:
        return {}, []
    if not isinstance(declared, dict):
        return {}, ["[icons] must be a table of names, each with the shared icon drawn without it"]
    icons, problems = {}, []
    if len(declared) > LIMITS["icons"]:
        problems.append(f"[icons] declares more than {LIMITS['icons']} icons; the rest are left out")
    for name, fallback in list(declared.items())[:LIMITS["icons"]]:
        if not isinstance(name, str) or not OWN_NAME.fullmatch(name):
            problems.append(f"icons.{name}: a name is lower case letters, digits and '-', at most 32 characters")
            continue
        if name in ui_contract.ICONS:
            problems.append(f"icons.{name}: the shared icon set already has that name")
            continue
        if fallback not in ui_contract.ICONS:
            problems.append(f"icons.{name}: {fallback!r} is not in the shared icon set")
            continue
        icon = {"fallback": fallback}
        try:
            icon.update(read_icon(satellite_dir / FOLDER / f"{name}.svg"))
        except IconError as error:
            problems.append(f"{FOLDER}/{name}.svg {error}; clients draw {fallback!r}")
        icons[name] = icon
    return icons, problems


def read_icon(path: Path) -> dict:
    """{"stroke", "paths"} for one icon file. Raises IconError."""
    try:
        with open(path, "rb") as file:
            raw = file.read(LIMITS["icon_bytes"] + 1)
    except FileNotFoundError:
        raise IconError("is missing")
    except OSError as error:
        raise IconError(f"could not be read ({error.strerror or error})")
    if len(raw) > LIMITS["icon_bytes"]:
        raise IconError(f"is larger than {LIMITS['icon_bytes'] // 1024} KB")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise IconError("is not UTF-8 text")
    return normalise_svg(text)


def normalise_svg(text: str) -> dict:
    """{"stroke": width, "paths": [path data]} for the text of an SVG file. Raises IconError."""
    lowered = text.lower()
    if "<!doctype" in lowered or "<!entity" in lowered or "<![cdata[" in lowered:
        raise IconError("has a DOCTYPE, entity or CDATA section")
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise IconError(f"is not well-formed XML ({error})")
    if _tag(root) != "svg":
        raise IconError("is not an <svg> element")
    attributes = _attributes(root, "svg")
    for name in attributes:
        if name not in ROOT and name not in STYLE:
            raise IconError(f"<svg> may not have {name!r}")
    view_box = re.split(r"[\s,]+", attributes.get("viewBox", "").strip())
    if view_box != ["0", "0", "24", "24"]:
        raise IconError("needs viewBox=\"0 0 24 24\"")
    if attributes.get("fill") != "none" or attributes.get("stroke") != "currentColor":
        raise IconError("needs fill=\"none\" and stroke=\"currentColor\" on <svg>: an icon is stroked in the client's colour")
    _check_style(attributes, "svg")
    stroke = _number(attributes.get("stroke-width", "1"), "stroke-width")
    if not 0.5 <= stroke <= 3:
        raise IconError("stroke-width must be between 0.5 and 3")

    paths = []
    _walk(root, paths, 0)
    if not paths:
        raise IconError("draws nothing")
    if len(paths) > LIMITS["icon_paths"]:
        raise IconError(f"has more than {LIMITS['icon_paths']} shapes")
    if sum(len(path) for path in paths) > LIMITS["icon_bytes"]:
        raise IconError("is too detailed")
    for path in paths:
        if not ui_contract.valid_icon_path(path):  # never expected: a safety net for what goes out
            raise IconError("could not be converted")
    return {"stroke": _float_out(stroke), "paths": paths}


def _tag(element) -> str:
    tag = element.tag
    if not isinstance(tag, str):
        raise IconError("has a processing instruction or comment where an element belongs")
    if tag.startswith(SVG_NAMESPACE):
        return tag[len(SVG_NAMESPACE):]
    if tag.startswith("{"):
        raise IconError(f"has an element outside SVG ({tag})")
    return tag


def _attributes(element, tag: str) -> dict:
    for name in element.attrib:
        if name.startswith("{"):
            raise IconError(f"<{tag}> has a namespaced attribute ({name}): no links")
    return dict(element.attrib)


def _check_style(attributes: dict, tag: str):
    for name, allowed in STYLE.items():
        if name in attributes and attributes[name] not in allowed:
            raise IconError(f"<{tag}> {name}={attributes[name]!r}: only {sorted(allowed)[0]!r} is drawn")


def _walk(parent, paths: list, depth: int):
    if (parent.text or "").strip():
        raise IconError(f"<{_tag(parent)}> has text")
    for child in parent:
        tag = _tag(child)
        if (child.tail or "").strip():
            raise IconError("has text between elements")
        if tag in IGNORED:
            continue
        attributes = _attributes(child, tag)
        if tag == "g":
            if depth >= MAX_DEPTH:
                raise IconError(f"nests groups more than {MAX_DEPTH} deep")
            for name in attributes:
                if name not in STYLE:
                    raise IconError(f"<g> may not have {name!r}")
            _check_style(attributes, "g")
            _walk(child, paths, depth + 1)
            continue
        if tag not in SHAPES:
            raise IconError(f"may not have <{tag}>")
        for name in attributes:
            if name not in GEOMETRY[tag] and name not in STYLE:
                raise IconError(f"<{tag}> may not have {name!r}")
        _check_style(attributes, tag)
        if len(child):
            raise IconError(f"<{tag}> may not have children")
        if (child.text or "").strip():
            raise IconError(f"<{tag}> has text")
        commands = _shape(tag, attributes)
        if commands:
            paths.append(_serialise(commands))
        if len(paths) > LIMITS["icon_paths"]:
            raise IconError(f"has more than {LIMITS['icon_paths']} shapes")


# ---------- shapes to absolute M, L, C, Z ----------

def _shape(tag: str, a: dict) -> list:
    if tag == "path":
        return parse_path(a.get("d", ""))
    if tag == "line":
        x1, y1, x2, y2 = (_coordinate(a.get(key, "0"), key) for key in ("x1", "y1", "x2", "y2"))
        return [("M", (x1, y1)), ("L", (x2, y2))]
    if tag in ("polyline", "polygon"):
        numbers = [_coordinate(value, "points") for value in re.split(r"[\s,]+", a.get("points", "").strip()) if value]
        if len(numbers) < 4 or len(numbers) % 2:
            raise IconError(f"<{tag}> points must be pairs, at least two")
        pairs = list(zip(numbers[::2], numbers[1::2]))
        commands = [("M", pairs[0])] + [("L", pair) for pair in pairs[1:]]
        return commands + [("Z", ())] if tag == "polygon" else commands
    if tag in ("circle", "ellipse"):
        cx, cy = _coordinate(a.get("cx", "0"), "cx"), _coordinate(a.get("cy", "0"), "cy")
        if tag == "circle":
            rx = ry = _coordinate(a.get("r", "0"), "r")
        else:
            rx, ry = _coordinate(a.get("rx", "0"), "rx"), _coordinate(a.get("ry", "0"), "ry")
        if rx <= 0 or ry <= 0:
            return []
        return _ellipse(cx, cy, rx, ry)
    # rect
    x, y = _coordinate(a.get("x", "0"), "x"), _coordinate(a.get("y", "0"), "y")
    width, height = _coordinate(a.get("width", "0"), "width"), _coordinate(a.get("height", "0"), "height")
    if width <= 0 or height <= 0:
        return []
    rx = _coordinate(a["rx"], "rx") if "rx" in a else None
    ry = _coordinate(a["ry"], "ry") if "ry" in a else None
    rx = ry if rx is None else rx
    ry = rx if ry is None else ry
    rx, ry = min(max(rx or 0, 0), width / 2), min(max(ry or 0, 0), height / 2)
    if not rx or not ry:
        return [("M", (x, y)), ("L", (x + width, y)), ("L", (x + width, y + height)), ("L", (x, y + height)), ("Z", ())]
    kx, ky = rx * KAPPA, ry * KAPPA
    right, bottom = x + width, y + height
    return [
        ("M", (x + rx, y)), ("L", (right - rx, y)),
        ("C", (right - rx + kx, y, right, y + ry - ky, right, y + ry)), ("L", (right, bottom - ry)),
        ("C", (right, bottom - ry + ky, right - rx + kx, bottom, right - rx, bottom)), ("L", (x + rx, bottom)),
        ("C", (x + rx - kx, bottom, x, bottom - ry + ky, x, bottom - ry)), ("L", (x, y + ry)),
        ("C", (x, y + ry - ky, x + rx - kx, y, x + rx, y)), ("Z", ()),
    ]


def _ellipse(cx, cy, rx, ry) -> list:
    kx, ky = rx * KAPPA, ry * KAPPA
    return [
        ("M", (cx + rx, cy)),
        ("C", (cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry)),
        ("C", (cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy)),
        ("C", (cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry)),
        ("C", (cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy)),
        ("Z", ()),
    ]


NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
ARITY = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}


def parse_path(data: str) -> list:
    """SVG path data as absolute [("M"|"L"|"C"|"Z", numbers)]. Raises IconError."""
    if len(data) > LIMITS["icon_bytes"]:
        raise IconError("<path> d is too long")
    scanner = _Scanner(data)
    out = []
    x = y = start_x = start_y = 0.0
    last_cubic = last_quad = None  # the reflected control point's source, for S and T
    command = None
    while True:
        scanner.skip()
        if scanner.done():
            break
        letter = scanner.letter()
        if letter is not None:
            command = letter
        elif command is None or command in "Zz":
            raise IconError("<path> d must start with a command")
        upper = command.upper()
        relative = command != upper
        if not out and upper != "M":
            raise IconError("<path> d must start with M")
        if upper == "Z":
            out.append(("Z", ()))
            x, y = start_x, start_y
            last_cubic = last_quad = None
            if letter is None:
                raise IconError("<path> d has numbers after Z")
            continue
        if upper == "A":
            values = [scanner.number(), scanner.number(), scanner.number(), scanner.flag(), scanner.flag(),
                      scanner.number(), scanner.number()]
        else:
            values = [scanner.number() for _ in range(ARITY[upper])]
        for value in values:
            if not math.isfinite(value) or abs(value) > MAX_COORDINATE:
                raise IconError("<path> d has a number out of range")
        dx, dy = (x, y) if relative else (0.0, 0.0)
        cubic = quad = None
        if upper == "M":
            x, y = values[0] + dx, values[1] + dy
            start_x, start_y = x, y
            out.append(("M", (x, y)))
            command = "l" if relative else "L"  # further pairs are line segments
        elif upper == "L":
            x, y = values[0] + dx, values[1] + dy
            out.append(("L", (x, y)))
        elif upper == "H":
            x = values[0] + (x if relative else 0.0)
            out.append(("L", (x, y)))
        elif upper == "V":
            y = values[0] + (y if relative else 0.0)
            out.append(("L", (x, y)))
        elif upper == "C":
            c1 = (values[0] + dx, values[1] + dy)
            c2 = (values[2] + dx, values[3] + dy)
            end = (values[4] + dx, values[5] + dy)
            out.append(("C", (*c1, *c2, *end)))
            cubic, (x, y) = c2, end
        elif upper == "S":
            c1 = (2 * x - last_cubic[0], 2 * y - last_cubic[1]) if last_cubic else (x, y)
            c2 = (values[0] + dx, values[1] + dy)
            end = (values[2] + dx, values[3] + dy)
            out.append(("C", (*c1, *c2, *end)))
            cubic, (x, y) = c2, end
        elif upper in ("Q", "T"):
            if upper == "Q":
                control = (values[0] + dx, values[1] + dy)
                end = (values[2] + dx, values[3] + dy)
            else:
                control = (2 * x - last_quad[0], 2 * y - last_quad[1]) if last_quad else (x, y)
                end = (values[0] + dx, values[1] + dy)
            c1 = (x + 2 / 3 * (control[0] - x), y + 2 / 3 * (control[1] - y))
            c2 = (end[0] + 2 / 3 * (control[0] - end[0]), end[1] + 2 / 3 * (control[1] - end[1]))
            out.append(("C", (*c1, *c2, *end)))
            quad, (x, y) = control, end
        else:  # A
            end = (values[5] + dx, values[6] + dy)
            out.extend(arc_to_cubics(x, y, values[0], values[1], values[2], values[3], values[4], *end))
            x, y = end
        last_cubic, last_quad = cubic, quad
        if len(out) > 4 * LIMITS["icon_bytes"]:
            raise IconError("<path> d is too long")
    return out


class _Scanner:
    """Reads path data one token at a time, as SVG does: "a1 1 0 011 1" is legal."""

    def __init__(self, text: str):
        self.text, self.at = text, 0

    def skip(self):
        while self.at < len(self.text) and self.text[self.at] in " \t\r\n,":
            self.at += 1

    def done(self) -> bool:
        return self.at >= len(self.text)

    def letter(self):
        character = self.text[self.at]
        if character in "MmLlHhVvCcSsQqTtAaZz":
            self.at += 1
            return character
        if character.isalpha():
            raise IconError(f"<path> d has an unknown command {character!r}")
        return None

    def number(self) -> float:
        self.skip()
        match = NUMBER.match(self.text, self.at)
        if not match:
            raise IconError("<path> d is missing a number")
        self.at = match.end()
        return float(match.group())

    def flag(self) -> float:
        self.skip()
        if self.at < len(self.text) and self.text[self.at] in "01":
            self.at += 1
            return float(self.text[self.at - 1])
        raise IconError("<path> d has an arc flag that isn't 0 or 1")


def arc_to_cubics(x1, y1, rx, ry, rotation, large, sweep, x2, y2) -> list:
    """An SVG elliptical arc as cubic curves (the SVG specification's endpoint-to-centre
    conversion, then one curve per quarter turn at most)."""
    if (x1, y1) == (x2, y2):
        return []
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0:
        return [("L", (x2, y2))]
    phi = math.radians(rotation % 360)
    cos, sin = math.cos(phi), math.sin(phi)
    hx, hy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cos * hx + sin * hy, -sin * hx + cos * hy
    scale = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if scale > 1:
        root = math.sqrt(scale)
        rx, ry = rx * root, ry * root
    numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    factor = math.sqrt(max(0.0, numerator / denominator)) if denominator else 0.0
    if large == sweep:
        factor = -factor
    cxp, cyp = factor * rx * y1p / ry, -factor * ry * x1p / rx
    cx = cos * cxp - sin * cyp + (x1 + x2) / 2
    cy = sin * cxp + cos * cyp + (y1 + y2) / 2

    def angle(ux, uy, vx, vy):
        return math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)

    ux, uy = (x1p - cxp) / rx, (y1p - cyp) / ry
    vx, vy = (-x1p - cxp) / rx, (-y1p - cyp) / ry
    start = angle(1, 0, ux, uy)
    delta = angle(ux, uy, vx, vy)
    if not sweep and delta > 0:
        delta -= 2 * math.pi
    elif sweep and delta < 0:
        delta += 2 * math.pi
    segments = max(1, math.ceil(abs(delta) / (math.pi / 2) - 1e-9))
    step = delta / segments
    t = 4 / 3 * math.tan(step / 4)

    def point(px, py):
        return cx + cos * rx * px - sin * ry * py, cy + sin * rx * px + cos * ry * py

    curves = []
    for index in range(segments):
        a1 = start + index * step
        a2 = a1 + step
        c1 = point(math.cos(a1) - t * math.sin(a1), math.sin(a1) + t * math.cos(a1))
        c2 = point(math.cos(a2) + t * math.sin(a2), math.sin(a2) - t * math.cos(a2))
        end = (x2, y2) if index == segments - 1 else point(math.cos(a2), math.sin(a2))
        curves.append(("C", (*c1, *c2, *end)))
    return curves


# ---------- numbers and output ----------

def _number(value: str, name: str) -> float:
    value = (value or "").strip()
    if not NUMBER.fullmatch(value):
        raise IconError(f"{name}={value!r} is not a number")
    number = float(value)
    if not math.isfinite(number):
        raise IconError(f"{name} is not a finite number")
    return number


def _coordinate(value: str, name: str) -> float:
    number = _number(value, name)
    if abs(number) > MAX_COORDINATE:
        raise IconError(f"{name} is out of range")
    return number


def _float_out(value: float) -> float:
    rounded = round(value, 3)
    return 0.0 if rounded == 0 else rounded


def _format(value: float) -> str:
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "", "-") else text


def _serialise(commands: list) -> str:
    return "".join(letter + " ".join(_format(value) for value in values) for letter, values in commands)
