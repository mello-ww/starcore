from ..command_registry import CommandRegistry

def parse(command: str, engine, registry: CommandRegistry):
    parts = command.strip().split()
    command_name = parts[0]
    arguments = parts[1:]
    entry = registry.get(command_name)

    if entry is None:
        print(f"[ERROR]: command '{command}' not found in registry.")
        return 

    function = entry["function"]
    
    return function(engine, arguments)