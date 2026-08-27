COMMAND = {
    "description": "Display help information.",
    "usage": "help [command]",
    "aliases": [],
    "category": "Core",
    "examples": [
        "help",
        "help version"
    ]
}

def help(engine, args):
    if len(args) > 1:
        print("[ERROR]: Usage: help [command]")
        return

    if len(args) == 0:
        print("Available commands:\n")

        commands = engine.command_registry.all()
        width = max(len(name) for name in commands)

        for command_name, entry in commands.items():
            description = entry["metadata"].get("description", "")
            source = entry.get("source", "core")
            suffix = f"  [{source}]" if source != "core" else ""
            print(f"{command_name:<{width}}  {description}{suffix}")

        return

    command_name = args[0]
    entry = engine.command_registry.get(command_name)

    if entry is None:
        print(f"[ERROR]: command '{command_name}' not found in registry.")
        return

    metadata = entry["metadata"]
    description = metadata.get("description", "")
    usage = metadata.get("usage", "")
    aliases = metadata.get("aliases", [])
    category = metadata.get("category", "")
    examples = metadata.get("examples", [])
    source = entry.get("source", "core")

    print(f"{command_name}\n")

    print("Description")
    print(f"  {description}\n")

    print("Usage")
    print(f"  {usage}\n")

    if aliases:
        print("Aliases")
        print(f"  {', '.join(aliases)}\n")

    if category:
        print("Category")
        print(f"  {category}\n")

    if source != "core":
        print("Satellite")
        print(f"  {source}\n")

    if examples:
        print("Examples")
        for example in examples:
            print(f"  {example}")