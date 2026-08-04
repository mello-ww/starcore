import importlib

def parse(command: str):
    module_name = f"starcore.cli.commands.{command}"
    module = importlib.import_module(module_name)
    function = getattr(module, command)
    return function()