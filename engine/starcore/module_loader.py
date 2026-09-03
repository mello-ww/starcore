from importlib.machinery import ModuleSpec
from pathlib import Path
import importlib.util
import sys


def load_module_from_file(module_name: str, path: Path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module

    try:
        spec.loader.exec_module(module)
    except Exception:
        del sys.modules[module_name]
        raise

    return module


def register_package(package_name: str, path: Path):
    """Makes a directory importable so a satellite can be split across several files."""
    registered = sys.modules.get(package_name)
    if registered is not None and getattr(registered, "__path__", None) == [str(path)]:
        return registered

    # the whole chain has to exist: importing a name below the package walks up to
    # its parents, and 'from . import x' resolves the package itself
    parent, _, _ = package_name.rpartition(".")
    if parent:
        register_package(parent, path.parent)

    spec = ModuleSpec(package_name, None, is_package=True)
    spec.submodule_search_locations = [str(path)]
    package = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = package
    return package
