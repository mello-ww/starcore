from pathlib import Path
import importlib

from .cli.spec import Command, Namespace
from .command_registry import CommandRegistry
from .module_loader import load_module_from_file, register_package

class CommandLoader:
    def __init__(self, registry: CommandRegistry, path: Path):
        self.command_registry = registry
        self.path = path

    def discover(self):
        self._discover_directory(self.path)

    def discover_satellite(self, satellite):
        commands_path = satellite.path / "commands"
        if not commands_path.exists():
            return

        module_prefix = f"satellites.{satellite.type}.{satellite.path.name}.commands"
        register_package(module_prefix, commands_path)
        self._discover_directory(commands_path, source=satellite.manifest.name, module_prefix=module_prefix)

    def _discover_directory(self, path: Path, source: str = "core", module_prefix: str = "starcore.cli.commands"):
        if not path.exists():
            print(f"[WARNING]: directory {path} does not exist. Skipping discovery for commands.")
            return

        # sorted for the same reason satellite discovery is: directory iteration
        # order differs by platform and filesystem, and command order should not
        for command_file in sorted(path.iterdir()):
            if command_file.is_file() and command_file.suffix == ".py" and command_file.stem != "__init__":
                command_name = command_file.stem
                module_name = f"{module_prefix}.{command_name}"

                if source == "core":
                    module = importlib.import_module(module_name)
                else:
                    # satellites aren't part of the starcore package, so load the file directly;
                    # a broken one is skipped like a broken state.py or api.py, never fatal
                    try:
                        module = load_module_from_file(module_name, command_file)
                    except Exception as error:
                        print(f"[WARNING]: command module '{command_name}' of '{source}' could not be loaded "
                              f"({error}). Skipping.")
                        continue

                if hasattr(module, "COMMANDS"):
                    self._register_typed(module, command_name, source)
                    continue

                try:
                    function = getattr(module, command_name)
                    metadata = getattr(module, "COMMAND", {})
                except AttributeError:
                    print(f"[WARNING]: command '{command_name}' has no entry function '{command_name}'. Skipping.")
                    continue

                self.command_registry.add(command_name, function, metadata, source=source)

    def _register_typed(self, module, module_name: str, source: str):
        """A module declaring COMMANDS is a typed namespace - see starcore/cli/spec.py."""
        try:
            namespace = Namespace(
                name=getattr(module, "NAMESPACE", module_name),
                summary=getattr(module, "SUMMARY", ""),
                default=getattr(module, "DEFAULT", None),
                aliases=tuple(getattr(module, "ALIASES", ())),
            )
            for command in module.COMMANDS:
                if not isinstance(command, Command):
                    raise ValueError(f"{command!r} is not a Command")
                namespace.add(command)
        except (TypeError, ValueError) as error:
            print(f"[WARNING]: commands in '{module_name}' from '{source}' are invalid ({error}). Skipping.")
            return
        self.command_registry.add_namespace(namespace, source=source)