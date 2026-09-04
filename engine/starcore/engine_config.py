from pathlib import Path
import tomllib

from .toml_edit import write_value


class ConfigurationError(Exception):
    """Raised when a configuration value fails validation."""


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


def _validate_optional_path(value) -> str:
    text = str(value).strip() if value is not None else ""
    return text  # existence is checked at startup (see ApiServer.start()), not here -
                 # an empty string just means "no HTTPS certificate/key configured"


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
    ("server", "https_enabled"): {
        "validate": _validate_bool,
        "description": "Serve Mission Control over HTTPS instead of plain HTTP",
        "restart_required": True,
    },
    ("server", "https_cert"): {
        "validate": _validate_optional_path,
        "description": "Path to the TLS certificate file (PEM), used when https_enabled is true",
        "restart_required": True,
    },
    ("server", "https_key"): {
        "validate": _validate_optional_path,
        "description": "Path to the TLS private key file (PEM), used when https_enabled is true",
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
        write_value(self.config_path, section, key, saved)
        self.config_data.setdefault(section, {})[key] = saved
        return saved
