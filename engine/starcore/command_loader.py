from pathlib import Path
import importlib

from .command_registry import CommandRegistry

class CommandLoader:
    def __init__(self, registry: CommandRegistry, path: Path):
        self.command_registry = registry
        self.path = path

    def discover(self):
        self._discover_directory(self.path)

    def _discover_directory(self, path: Path):
        if not path.exists():
            print(f"[WARNING]: directory {path} does not exist. Skipping discovery for commands.")
            return

        for command_file in path.iterdir():
            if command_file.is_file() and command_file.suffix == ".py" and command_file.stem != "__init__":
                command_name = command_file.stem

                module_name = f"starcore.cli.commands.{command_name}"
                module = importlib.import_module(module_name)
                try:
                    function = getattr(module, command_name)
                    metadata = getattr(module, "COMMAND", {})
                except AttributeError:
                    print(f"[WARNING]: command '{command_name}' has no entry function '{command_name}'. Skipping.")
                    continue

                self.command_registry.add(command_name, function, metadata)