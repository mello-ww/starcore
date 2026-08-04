from pathlib import Path
from ..command_registry import CommandRegistry

def parse(command: str, engine, registry: CommandRegistry):
    function = registry.get(command)

    if function is None:
        print(f"[ERROR]: command '{command}' not found in registry.")
        return 
    
    return function(engine)