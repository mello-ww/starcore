from pathlib import Path
import tomllib


class Configuration:
    def __init__(self, config_path: Path):
        self.config_path = config_path
        self.config_data = self.load_config()

    def load_config(self):
        if not Path(self.config_path).exists():
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
