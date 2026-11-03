VERSION = "1.0.0"

COMMAND = {
    "description": "Display the current StarCore version.",
    "usage": "version",
    "aliases": ["ver"],
    "category": "Core",
    "read_only": True,
    "examples": [
        "version",
        "engine version --json",
    ]
}

def version(engine, args):
    return f"StarCore CLI v{VERSION}"
