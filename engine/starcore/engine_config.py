from pathlib import Path
import tomllib


class Configuration:
    def __init__(self, config_path: Path):
        self.config_path = config_path
        self.config_data = self.load_config()

    def load_config(self):
        with open(self.config_path, "rb") as f:
            return tomllib.load(f)

    def get(self, key, default=None):
        return self.config_data.get(key, default)