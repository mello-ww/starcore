from .. import configuration
from ..images import thumbnails_available
from ..library import PhotoImportError, library_for, readable_size

COMMAND = {
    "description": "Inspect and fill the local StarCore photo library.",
    "usage": "photo [list [count] | import <directory> | config [<key> <value>]]",
    "aliases": [],
    "category": "Photo",
    "examples": [
        "photo",
        "photo list 20",
        "photo import ~/Pictures",
        "photo config",
        "photo config sync_host 0.0.0.0",
        "photo config sync_port 8090",
    ]
}

LIST_LIMIT = 10


def photo(engine, args):
    photos = library_for(engine)
    if photos is None:
        print("[ERROR]: the Photo satellite is not loaded.")
        return

    if not args:
        _summary(photos)
    elif args[0] == "list":
        _list(photos, args[1:])
    elif args[0] == "import":
        _import(photos, args[1:])
    elif args[0] == "config":
        _config(engine, args[1:])
    else:
        print(f"[ERROR]: Usage: {COMMAND['usage']}")


def _summary(photos):
    print("StarCore photo library\n")
    print(f"Photos       {photos.count}")
    print(f"Size         {readable_size(photos.size)}")
    print(f"Storage      {photos.root}")
    print(f"Thumbnails   {'available' if thumbnails_available() else 'unavailable (originals are served instead)'}")


def _list(photos, args):
    if len(args) > 1 or (args and not args[0].isdigit()):
        print(f"[ERROR]: Usage: {COMMAND['usage']}")
        return

    limit = int(args[0]) if args else LIST_LIMIT
    known = photos.all()

    if not known:
        print("The photo library is empty.")
        return

    print(f"{len(known)} photo(s), showing {min(limit, len(known))}\n")
    for entry in known[:limit]:
        dimensions = f"{entry['width']}x{entry['height']}"
        taken = entry["captured_at"] or entry["imported_at"]
        print(f"{entry['id']}  {dimensions:<12} {readable_size(entry['size']):>9}  {taken}  {entry['filename']}")


def _import(photos, args):
    if not args:
        print(f"[ERROR]: Usage: {COMMAND['usage']}")
        return

    try:
        # the CLI splits on whitespace, so a path containing spaces arrives in pieces
        result = photos.import_directory(" ".join(args))
    except PhotoImportError as error:
        print(f"[ERROR]: {error}")
        return

    print(f"Imported from {result['source']}\n")
    print(f"Found        {result['found']}")
    print(f"Imported     {result['imported']}")
    print(f"Duplicates   {result['duplicates']}")
    print(f"Failed       {len(result['failed'])}")

    for failure in result["failed"]:
        print(f"- {failure['file']}: {failure['reason']}")


def _config(engine, args):
    satellite = engine.registry.get("Photo")
    if satellite is None:
        print("[ERROR]: the Photo satellite is not loaded.")
        return

    if not args:
        _show_config(satellite)
        return

    if len(args) != 2:
        print(f"[ERROR]: Usage: {COMMAND['usage']}")
        return

    key, raw_value = args
    try:
        result = configuration.update(engine, satellite, key, raw_value)
    except configuration.ConfigurationError as error:
        print(f"[ERROR]: {error}")
        return

    saved = next(setting for setting in result["settings"] if setting["key"] == key)
    print(f"{key} = {saved['value']}")
    if result["note"]:
        print(result["note"])


def _show_config(satellite):
    settings = configuration.describe(satellite)["settings"]
    if not settings:
        print("No configurable settings are registered.")
        return

    print("Photo Sync configuration\n")
    width = max(len(setting["key"]) for setting in settings)
    for setting in settings:
        print(f"{setting['key']:<{width}}  {setting['value']!r:<10}  {setting['description']}")

    print("\nChange a setting:  photo config <key> <value>")
    print("Changes are saved to config.toml immediately, and Photo Sync restarts on its own to apply them.")
