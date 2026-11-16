from .library import library, readable_size


# read from the in-memory index, so the generic Core status stays cheap
def state(engine, satellite):
    photos = library(satellite)

    return {
        "photos": photos.count,
        "library_size": readable_size(photos.size),
        "storage": str(photos.root),
    }
