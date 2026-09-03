from .library import library, readable_size


# read from the in-memory index, so the generic Core status stays cheap
def state(engine, satellite):
    music = library(satellite)

    return {
        "tracks": music.count,
        "albums": len(music.albums()),
        "artists": len(music.artists()),
        "library_size": readable_size(music.size),
        "last_scan": music.summary()["last_scan"] or "never",
    }
