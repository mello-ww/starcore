from ..library import MusicScanError, library_for, readable_duration, readable_size

COMMAND = {
    "description": "Inspect and index the local StarCore music library.",
    "usage": "music [scan [directory] | list [count] | albums [count]]",
    "aliases": [],
    "category": "Music",
    "examples": [
        "music",
        "music scan",
        "music scan ~/Music",
        "music list 20",
        "music albums"
    ]
}

LIST_LIMIT = 10


def music(engine, args):
    tracks = library_for(engine)
    if tracks is None:
        print("[ERROR]: the Music satellite is not loaded.")
        return

    if not args:
        _summary(tracks)
    elif args[0] == "scan":
        _scan(tracks, args[1:])
    elif args[0] == "list":
        _list(tracks, args[1:])
    elif args[0] == "albums":
        _albums(tracks, args[1:])
    else:
        print(f"[ERROR]: Usage: {COMMAND['usage']}")


def _summary(tracks):
    summary = tracks.summary()

    print("StarCore music library\n")
    print(f"Tracks       {summary['tracks']}")
    print(f"Albums       {summary['albums']}")
    print(f"Artists      {summary['artists']}")
    print(f"Duration     {readable_duration(summary['duration'])}")
    print(f"Size         {readable_size(summary['size_bytes'])}")
    print(f"Source       {summary['source']}")
    print(f"Last scan    {summary['last_scan'] or 'never'}")


def _scan(tracks, args):
    try:
        # the CLI splits on whitespace, so a path containing spaces arrives in pieces
        result = tracks.scan(" ".join(args) if args else None)
    except MusicScanError as error:
        print(f"[ERROR]: {error}")
        return

    print(f"Scanned {result['source']}\n")
    print(f"Found        {result['found']}")
    print(f"Added        {result['added']}")
    print(f"Updated      {result['updated']}")
    print(f"Unchanged    {result['unchanged']}")
    print(f"Duplicates   {result['duplicates']}")
    print(f"Removed      {result['removed']}")
    print(f"Failed       {len(result['failed'])}")

    for failure in result["failed"]:
        print(f"- {failure['file']}: {failure['reason']}")


def _list(tracks, args):
    limit = _limit(args)
    if limit is None:
        return

    known = tracks.tracks()
    if not known:
        print("The music library is empty. Run 'music scan' to index it.")
        return

    print(f"{len(known)} track(s), showing {min(limit, len(known))}\n")
    for entry in known[:limit]:
        position = f"{entry['track'] or '-':>3}"
        print(f"{position}  {readable_duration(entry['duration']):>6}  "
              f"{(entry['artist'] or '-')[:24]:<24}  {(entry['album'] or '-')[:24]:<24}  {entry['title']}")


def _albums(tracks, args):
    limit = _limit(args)
    if limit is None:
        return

    known = tracks.albums()
    if not known:
        print("The music library is empty. Run 'music scan' to index it.")
        return

    print(f"{len(known)} album(s), showing {min(limit, len(known))}\n")
    for album in known[:limit]:
        year = album["year"] or "----"
        print(f"{year}  {album['tracks']:>3} tracks  {readable_duration(album['duration']):>6}  "
              f"{album['artist'][:28]:<28}  {album['album']}")


def _limit(args):
    if len(args) > 1 or (args and not args[0].isdigit()):
        print(f"[ERROR]: Usage: {COMMAND['usage']}")
        return None

    return int(args[0]) if args else LIST_LIMIT
