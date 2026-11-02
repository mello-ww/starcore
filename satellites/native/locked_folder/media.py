"""What kind of media a vault file is, by its name."""

from pathlib import PurePath

MEDIA_TYPES = {
    ".jpg": ("photo", "image/jpeg"),
    ".jpeg": ("photo", "image/jpeg"),
    ".png": ("photo", "image/png"),
    ".webp": ("photo", "image/webp"),
    ".gif": ("photo", "image/gif"),
    ".heic": ("photo", "image/heic"),
    ".mp4": ("video", "video/mp4"),
    ".m4v": ("video", "video/mp4"),
    ".mov": ("video", "video/quicktime"),
    ".3gp": ("video", "video/3gpp"),
    ".webm": ("video", "video/webm"),
}


def kind(name: str):
    """(media type, content type) for a file name."""
    return MEDIA_TYPES.get(PurePath(str(name)).suffix.lower(), ("file", "application/octet-stream"))
