from pathlib import Path
import os
import re
import tomllib


class ConfigurationError(Exception):
    """Raised when a configuration value fails validation."""


_SECTION_RE = re.compile(r"^\[(?P<name>[^\[\]]+)\]\s*(#.*)?$")


def _validate_host(value) -> str:
    text = str(value).strip()
    if not text:
        raise ConfigurationError("host must not be empty")
    return text


def _validate_port(value) -> int:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        raise ConfigurationError(f"port must be a whole number, got '{value}'")
    if not (0 <= port <= 65535):
        raise ConfigurationError("port must be between 0 and 65535")
    return port


def _validate_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("true", "1", "yes", "on"):
        return True
    if text in ("false", "0", "no", "off"):
        return False
    raise ConfigurationError(f"'{value}' is not a valid true/false value")


# the settings the CLI 'config' command and Mission Control's Configuration page
# can inspect and change - deliberately just [server] for now, kept generic so
# adding another section later doesn't require touching the CLI or the API
SETTINGS = {
    ("server", "host"): {
        "validate": _validate_host,
        "description": "Mission Control bind address",
        "restart_required": True,
    },
    ("server", "port"): {
        "validate": _validate_port,
        "description": "Mission Control port",
        "restart_required": True,
    },
    ("server", "enabled"): {
        "validate": _validate_bool,
        "description": "Whether Mission Control starts at all",
        "restart_required": True,
    },
}


def validate(section: str, key: str, value):
    setting = SETTINGS.get((section, key))
    if setting is None:
        raise ConfigurationError(f"'{section}.{key}' is not a configurable setting")

    return setting["validate"](value)


def describe(configuration: "Configuration") -> list:
    """The configurable settings, with their current value - what the CLI and the API show."""
    return [
        {
            "section": section,
            "key": key,
            "path": f"{section}.{key}",
            "value": configuration.section(section).get(key),
            "description": meta["description"],
            "restart_required": meta["restart_required"],
        }
        for (section, key), meta in SETTINGS.items()
    ]


class Configuration:
    def __init__(self, config_path: Path):
        self.config_path = Path(config_path)
        self.config_data = self.load_config()

    def load_config(self):
        if not self.config_path.exists():
            print(f"[WARNING]: configuration file {self.config_path} not found. Using defaults.")
            return {}

        try:
            with open(self.config_path, "rb") as f:
                return tomllib.load(f)
        except tomllib.TOMLDecodeError as error:
            print(f"[WARNING]: configuration file {self.config_path} is invalid ({error}). Using defaults.")
            return {}

    def get(self, key, default=None):
        return self.config_data.get(key, default)

    def section(self, name) -> dict:
        value = self.config_data.get(name)
        return value if isinstance(value, dict) else {}

    def set(self, section: str, key: str, value):
        """Validates a setting, writes it to config_path and returns the saved value.

        Only the target line is touched - everything else in the file (comments,
        key order, other sections) is left exactly as it was. Raises
        ConfigurationError for an unknown setting or an invalid value; nothing is
        written in that case.
        """
        saved = validate(section, key, value)
        _write_value(self.config_path, section, key, saved)
        self.config_data.setdefault(section, {})[key] = saved
        return saved


def _write_value(path: Path, section: str, key: str, value) -> None:
    # read_text() applies universal-newline translation, which would hide a CRLF
    # file's line endings before they could be detected - the raw bytes are
    # checked instead, so the file's existing convention is actually preserved
    newline = "\r\n" if path.exists() and b"\r\n" in path.read_bytes() else "\n"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    formatted = _format_scalar(value)

    section_start, section_end = _section_bounds(lines, section)

    if section_start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"[{section}]")
        lines.append(f"{key} = {formatted}")
    else:
        key_pattern = re.compile(rf"^(?P<indent>\s*){re.escape(key)}(?P<eq>\s*=\s*)(?P<value>[^#]*)(?P<comment>#.*)?$")
        for index in range(section_start + 1, section_end):
            match = key_pattern.match(lines[index])
            if match:
                comment = match.group("comment") or ""
                spacer = " " if comment else ""
                lines[index] = f"{match.group('indent')}{key}{match.group('eq')}{formatted}{spacer}{comment}".rstrip()
                break
        else:
            lines.insert(section_end, f"{key} = {formatted}")

    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    text = newline.join(lines)
    if text:
        text += newline
    partial.write_text(text, encoding="utf-8", newline="")
    os.replace(partial, path)


def _section_bounds(lines: list, section: str) -> tuple:
    """The line range of a [section] block: (header index, index of the next header or EOF)."""
    start = None
    for index, line in enumerate(lines):
        match = _SECTION_RE.match(line.strip())
        if not match:
            continue
        if start is not None:
            return start, index
        if match.group("name").strip() == section:
            start = index

    return start, len(lines)


def _format_scalar(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)

    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
