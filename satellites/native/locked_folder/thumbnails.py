"""Poster-frame thumbnails for Locked Folder videos - kept in memory only.

Photos caches its video thumbnails on disk; the vault must not, since a
plain JPEG of a private video would sit outside the encryption. Here a frame
is rendered with ffmpeg (when it is on PATH) straight to a pipe, held in a
small in-memory cache for unlocked sessions, and dropped as soon as no
session has the vault open.

An encrypted video is decrypted into the vault's own tmp folder just long
enough for ffmpeg to read it, then removed (see api._thumbnail). Piping the
plaintext to ffmpeg's stdin instead was considered and rejected: an MP4 whose
index sits at the end - most camera files - can't be read from a pipe, so it
would fail unpredictably. The copy is therefore the one place plaintext touches
disk; it is removed in a `finally`, and any copy a killed process leaves
behind is swept by the next thumbnail or move-out (Store.clear_staging).
"""

from collections import OrderedDict
import shutil
import subprocess
import threading
import time

from satellites.native.photo import videos

SIZE = 360
MAX_ENTRIES = 96
POSTER_OFFSET_SECONDS = 1.0
TIMEOUT_SECONDS = 30
RETRY_SECONDS = 300  # before a frame that failed with the same ffmpeg is tried again

_render_slots = threading.BoundedSemaphore(2)


class MemoryImage:
    """A rendered JPEG in the shape stream_response() expects."""

    def __init__(self, data: bytes):
        self.data = data
        self.size = len(data)

    def read_range(self, start: int, end: int):
        yield self.data[start:end + 1]

    def close(self):
        pass


class Entry:
    """One cached result: the frame (None when it failed) and the video's
    length. A failure only stands while the same ffmpeg is installed and for
    RETRY_SECONDS, so installing ffmpeg needs no restart."""

    def __init__(self, data, duration, binary):
        self.data = data
        self.duration = duration
        self.binary = binary
        self.at = time.monotonic()

    def usable(self, binary) -> bool:
        if self.data is not None:
            return True
        return self.binary == binary and time.monotonic() - self.at < RETRY_SECONDS


class Cache:
    """Thumbnails keyed by vault path plus the file's size and modified time,
    so a replaced file never gets a stale frame. Failures are remembered too,
    so a file ffmpeg can't read isn't retried on every grid scroll."""

    def __init__(self, max_entries: int = MAX_ENTRIES):
        self._entries = OrderedDict()
        self._max = max_entries
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            if key not in self._entries:
                return None
            self._entries.move_to_end(key)
            return self._entries[key]

    def put(self, key, value):
        with self._lock:
            self._entries[key] = value
            self._entries.move_to_end(key)
            while len(self._entries) > self._max:
                self._entries.popitem(last=False)

    def clear(self):
        with self._lock:
            self._entries.clear()

    def __len__(self):
        return len(self._entries)


def ffmpeg():
    return shutil.which("ffmpeg")


def render(source, binary=None, size: int = SIZE):
    """JPEG bytes of one frame, or None (no ffmpeg, unreadable file, timeout).
    The frame keeps its aspect ratio; nothing is written to disk."""
    binary = binary or ffmpeg()
    if not binary:
        return None
    scale = f"scale='min({size},iw)':'min({size},ih)':force_original_aspect_ratio=decrease"
    for offset in (POSTER_OFFSET_SECONDS, 0):  # a clip shorter than the offset retries at its first frame
        with _render_slots:
            try:
                result = subprocess.run(
                    [binary, "-v", "error", "-ss", f"{offset:.3f}", "-i", str(source),
                     "-frames:v", "1", "-vf", scale, "-q:v", "4", "-f", "mjpeg", "pipe:1"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    timeout=TIMEOUT_SECONDS,
                )
            except (OSError, subprocess.TimeoutExpired):
                return None
        if result.returncode == 0 and result.stdout[:2] == b"\xff\xd8":
            return result.stdout
    return None


def make(source, binary) -> Entry:
    """Frame and length of a readable local video file."""
    data = render(source, binary)
    return Entry(data, duration_of(source) if data else None, binary)


def duration_of(source):
    """Seconds, read from the MP4 header; None for other containers."""
    from satellites.native.photo import videos  # the one MP4 header reader
    try:
        return videos.probe(source).get("duration")
    except (videos.UnsupportedVideo, OSError):
        return None
