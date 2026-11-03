"""photo - library statistics, albums, sync status, and authorized scan/import.

Uses the same PhotoLibrary, AlbumStore, sync service and configuration
module as the Photo routes. A scan or import never reaches into the Locked
Folder: the library's own Locked Folder policy refuses it, as it does for
Mission Control.
"""

from starcore.cli.runner import table
from starcore.cli.spec import Argument, Command, CommandError, Unavailable, UsageError, bounded

from .. import configuration, sync
from ..albums import albums as album_store
from ..images import thumbnails_available
from ..library import PhotoImportError, library_for, readable_size
from ..private_media import policy

NAMESPACE = "photo"
SUMMARY = "Photo library statistics, albums, sync status, scan and import"
DEFAULT = "stats"
ALIASES = ("photos",)

READ = "photo.read"
MANAGE = "photo.manage"

LIST_LIMIT = 10


def _photos(ctx):
    photos = library_for(ctx.engine)
    if photos is None:
        raise Unavailable("the Photo satellite is not loaded")
    return photos


def _satellite(ctx):
    satellite = ctx.engine.registry.get("Photo")
    if satellite is None:
        raise Unavailable("the Photo satellite is not loaded")
    return satellite


def _source(ctx, directory) -> str:
    # a path with spaces may arrive unquoted, in pieces - joined as before
    if directory:
        return " ".join(directory)
    configured = _satellite(ctx).config.get("photo_directory", "") or ""
    if not configured:
        raise UsageError("name a directory, or configure a default with 'photo config photo_directory <path>'")
    return configured


def stats(ctx):
    photos = _photos(ctx)
    summary = photos.summary()
    running = sync.service(_satellite(ctx))
    return {**summary, "albums": len(album_store(_satellite(ctx)).all()),
            "sync": {"running": bool(running and running.running), "url": running.url if running and running.running
                     else None}}


def _render_stats(data: dict) -> str:
    return "\n".join([
        "StarCore photo library",
        "",
        f"Photos       {data['photos']}",
        f"Images       {data['images']}",
        f"Videos       {data['videos']}",
        f"Albums       {data['albums']}",
        f"Size         {readable_size(data['size_bytes'])}",
        f"Storage      {data['storage']}",
        f"Thumbnails   {'available' if thumbnails_available() else 'unavailable (originals are served instead)'}",
        f"Sync         {data['sync']['url'] if data['sync']['running'] else 'not running'}",
    ])


def list_photos(ctx, count):
    known = _photos(ctx).all()
    return {"total": len(known), "photos": [
        {key: entry.get(key) for key in ("id", "filename", "media_type", "width", "height", "size",
                                         "captured_at", "imported_at")}
        for entry in known[:count or LIST_LIMIT]]}


def _render_list(data: dict) -> str:
    if not data["total"]:
        return "The photo library is empty."
    lines = [f"{data['total']} photo(s), showing {len(data['photos'])}", ""]
    for entry in data["photos"]:
        dimensions = f"{entry['width']}x{entry['height']}"
        taken = entry["captured_at"] or entry["imported_at"]
        lines.append(f"{entry['id']}  {dimensions:<12} {readable_size(entry['size']):>9}  {taken}  {entry['filename']}")
    return "\n".join(lines)


def list_albums(ctx):
    photos = _photos(ctx)
    found = []
    for album in album_store(_satellite(ctx)).all():
        present = [photo_id for photo_id in album["photo_ids"] if photos.get(photo_id) is not None]
        found.append({"id": album["id"], "name": album["name"], "kind": album.get("kind", "virtual"),
                      "photos": len(present), "updated_at": album["updated_at"]})
    return {"albums": found}


def sync_status(ctx):
    described = sync.describe(_satellite(ctx))
    # the sync token is a credential for the upload listener: never shown here
    return {key: value for key, value in described.items() if key != "token"}


def _render_sync(data: dict) -> str:
    state = "running at " + data["url"] if data["running"] else ("enabled, not running" if data["enabled"]
                                                                  else "disabled")
    counts = data["counts"]
    lines = [f"Photo sync   {state}",
             f"Received     {counts['received']} (imported {counts['imported']}, duplicates {counts['duplicates']}, "
             f"failed {counts['failed']})"]
    if data["events"]:
        lines += ["", "Recent", table(data["events"][:10], [("at", "At"), ("status", "Status"),
                                                              ("filename", "File")])]
    return "\n".join(lines)


def scan(ctx, directory):
    try:
        return _photos(ctx).scan(_source(ctx, directory), private=policy(ctx.engine))
    except PhotoImportError as error:
        raise CommandError(str(error))


def _render_scan(data: dict) -> str:
    return "\n".join([f"Scanned {data['source']} (nothing was imported)", "",
                      f"Found        {data['found']}", f"New          {data['new']}",
                      f"Duplicates   {data['duplicates']}", "", "Import them with 'photo import'."])


def import_photos(ctx, directory):
    try:
        result = _photos(ctx).import_directory(_source(ctx, directory), private=policy(ctx.engine))
    except PhotoImportError as error:
        raise CommandError(str(error))
    return {key: value for key, value in result.items() if key != "photos"}


def _render_import(result: dict) -> str:
    lines = [f"Imported from {result['source']}", "",
             f"Found        {result['found']}", f"Imported     {result['imported']}",
             f"Duplicates   {result['duplicates']}", f"Failed       {len(result['failed'])}"]
    lines += [f"- {failure['file']}: {failure['reason']}" for failure in result["failed"]]
    return "\n".join(lines)


def config(ctx, key, value):
    satellite = _satellite(ctx)
    if key is None:
        return {"settings": configuration.describe(satellite)["settings"], "changed": None}
    if value is None:
        raise UsageError("Usage: photo config [<key> <value>]")
    if not ctx.live:
        # a change restarts Photo Sync's listener, which belongs to the running StarCore
        raise Unavailable("changing Photo settings needs StarCore to be running - start it, then run this again")
    try:
        result = configuration.update(ctx.engine, satellite, key, value)
    except configuration.ConfigurationError as error:
        raise CommandError(str(error))
    saved = next(setting for setting in result["settings"] if setting["key"] == key)
    return {"settings": result["settings"], "changed": {"key": key, "value": saved["value"]}, "note": result["note"]}


def _render_config(data: dict) -> str:
    if data["changed"]:
        changed = data["changed"]
        return f"{changed['key']} = {changed['value']}" + (f"\n{data['note']}" if data.get("note") else "")
    settings = data["settings"]
    if not settings:
        return "No configurable settings are registered."
    width = max(len(setting["key"]) for setting in settings)
    lines = ["Photo Sync configuration", ""]
    lines += [f"{setting['key']:<{width}}  {setting['value']!r:<10}  {setting['description']}" for setting in settings]
    lines += ["", "Change a setting:  photo config <key> <value>",
              "Changes are saved to config.toml immediately, and Photo Sync restarts on its own to apply them."]
    return "\n".join(lines)


DIRECTORY = Argument("directory", "a directory on this machine (default: the configured photo_directory)",
                     required=False, variadic=True)

COMMANDS = [
    Command("stats", "Library totals: photos, images, videos, albums and storage", stats, READ,
            render=_render_stats, examples=("photo", "photos stats --json")),
    Command("list", "List the newest photos and videos", list_photos, READ,
            arguments=(Argument("count", f"how many to show (default {LIST_LIMIT})", type=bounded(1, 10_000),
                                required=False),),
            render=_render_list, examples=("photo list 20",)),
    Command("albums", "List albums and how many photos each holds", list_albums, READ,
            render=lambda data: table(data["albums"], [("name", "Album"), ("photos", "Photos"), ("kind", "Kind"),
                                                       ("id", "Id")]) or "No albums yet."),
    Command("sync", "Photo sync status and recent uploads", sync_status, READ, render=_render_sync,
            aliases=("sync-status",), examples=("photo sync", "photo sync --json")),
    Command("scan", "Preview what importing a directory would add, without importing", scan, MANAGE,
            arguments=(DIRECTORY,), remote=False, render=_render_scan,
            examples=("photo scan", "photo scan \"D:\\Pictures\\Phone\"")),
    Command("import", "Import a directory's photos and videos into the library", import_photos, MANAGE,
            arguments=(DIRECTORY,), mutates=True, render=_render_import, examples=("photo import ~/Pictures",)),
    Command("config", "Show or change Photo Sync settings", config, MANAGE,
            arguments=(Argument("key", "a setting name", required=False),
                       Argument("value", "its new value", required=False)),
            mutates=True, render=_render_config,
            examples=("photo config", "photo config sync_port 8090")),
]
