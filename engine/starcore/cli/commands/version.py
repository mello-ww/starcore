COMMAND = {
    "description": "Display the current StarCore version.",
    "usage": "version",
    "aliases": ["ver"],
    "category": "Core",
    "examples": [
        "version"
    ]
}

def version(engine, args):
    return "StarCore CLI v1.0.0"