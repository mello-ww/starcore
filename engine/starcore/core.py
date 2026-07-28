import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config.toml"

from .config import Configuration


class StarCore:
    def __init__(self):
        self.config = Configuration(CONFIG_PATH)

    def start(self):
        print("Starting StarCore...\n")

        print("Loading configuration...")
        print(self.config.get("engine"))
        print("Configuration loaded.\n")

        print("StarCore is ready.")

        try:
            while True:
                time.sleep(1)  # Keep the engine running
        except KeyboardInterrupt:
            self.stop()

    def stop(self):
        print("\nStopping StarCore...")
        print("StarCore has stopped.")