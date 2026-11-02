"""Video inspection with the standard library, and optional thumbnail rendering.

Mirrors images.py's own approach and its "dependency-free by default" promise:
dimensions and duration are read straight from the container's own box/element
structure (no dependency for that), and rendering a poster-frame thumbnail is
the one thing that genuinely needs an external tool - ffmpeg, when it happens
to be on this machine's PATH - with the gallery falling back to no thumbnail
(just like images.py falls back to serving the original when Pillow isn't
installed) rather than failing the import.

Scope: MP4/MOV/M4V/3GP - the ISOBMFF family, which is what phone cameras
(Android and iPhone alike) actually record in. A phone almost never produces
WEBM/Matroska video, so that format isn't read here; a WEBM file simply isn't
recognized by probe() and is rejected the same way an unsupported image is.
"""

from pathlib import Path
import shutil
import struct
import subprocess

FORMATS = {
    ".mp4": "mp4",
    ".m4v": "mp4",
    ".mov": "mov",
    ".3gp": "3gp",
}

EXTENSIONS = {
    "mp4": ".mp4",
    "mov": ".mov",
    "3gp": ".3gp",
}

CONTENT_TYPES = {
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "3gp": "video/3gpp",
}

# how far into the clip to grab the poster frame - a fixed second in, capped to
# the clip's own length, so a very short video still gets a real frame instead
# of nothing (seeking past the end simply fails and thumbnail() reports that)
POSTER_OFFSET_SECONDS = 1.0

_ffmpeg = None


class UnsupportedVideo(Exception):
    pass


def probe(path) -> dict:
    """Returns format, width, height and duration (seconds, may be None), or
    raises UnsupportedVideo. Reads the ISOBMFF box tree directly - the same
    structure MP4, MOV, M4V and 3GP all share - looking only for the two boxes
    that carry what the library needs (moov/mvhd for duration, moov/trak/tkhd
    for the first video track's display size).

    Recognized by content, not by filename - the same way images.probe()
    sniffs JPEG/PNG/WEBP by magic bytes rather than trusting an extension.
    That matters here because sync.py hands add_file() an upload under a
    generic temp filename (no extension at all); probe() still has to work
    from the bytes alone, exactly like it does for a photo upload.
    """
    with open(path, "rb") as file:
        major_brand = _isobmff_major_brand(file)
        if major_brand is None:
            raise UnsupportedVideo("not a recognizable MP4-family video")

        file.seek(0)
        moov = _find_box(file, b"moov")
        if moov is None:
            raise UnsupportedVideo("the video has no 'moov' box (it may still be recording, or is corrupt)")

    duration = _duration_seconds(moov)
    width, height = _track_size(moov)

    return {"format": _format_for_brand(major_brand), "width": width, "height": height, "duration": duration}


def _format_for_brand(major_brand: bytes) -> str:
    if major_brand.startswith(b"qt"):
        return "mov"
    if major_brand.startswith(b"3g"):
        return "3gp"
    return "mp4"  # isom/mp41/mp42/M4V /avc1/... - everything else in this family


def duration_label(seconds) -> str:
    """A short mm:ss (or h:mm:ss) label - the one place this formatting is
    written, so the web panel and any future consumer agree on it."""
    if not isinstance(seconds, (int, float)) or seconds < 0:
        return ""

    total = round(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def thumbnails_available() -> bool:
    return _load_ffmpeg() is not None


def thumbnail(source, destination, size: int, duration=None) -> bool:
    """Renders a downscaled poster frame with ffmpeg. Returns False when that
    is not possible (ffmpeg missing, or it could not read this file) - the
    caller then serves no thumbnail for this video, exactly as images.py does
    for an image it cannot render one for."""
    ffmpeg = _load_ffmpeg()
    if ffmpeg is None:
        return False

    offset = min(POSTER_OFFSET_SECONDS, duration / 2) if duration else 0

    try:
        result = subprocess.run(
            [
                ffmpeg, "-y", "-ss", f"{offset:.3f}", "-i", str(source),
                "-frames:v", "1", "-vf", f"scale='min({size},iw)':'min({size},ih)':force_original_aspect_ratio=decrease",
                "-q:v", "3",
                # forced explicitly: the destination is a ".part" staging file
                # (see thumbnail_path()), not something ending in .jpg, so
                # ffmpeg can't infer the output format from its name
                "-f", "mjpeg", str(destination),
            ],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"[WARNING]: video thumbnail for {source} could not be generated ({error}).")
        return False

    if result.returncode != 0 or not Path(destination).is_file():
        print(f"[WARNING]: video thumbnail for {source} could not be generated "
              f"({result.stderr.decode(errors='replace').strip()[-200:]}).")
        return False

    return True


def _load_ffmpeg():
    global _ffmpeg

    # only a found binary is remembered: one installed after startup is picked up
    if not _ffmpeg:
        _ffmpeg = shutil.which("ffmpeg") or False

    return _ffmpeg or None


# ---------- ISOBMFF box parsing ----------
#
# An ISOBMFF file (MP4/MOV/M4V/3GP) is a flat sequence of boxes, each an
# 8-byte header (a big-endian uint32 size, then a 4-character type) followed
# by that many bytes of payload - which, for a "container" box like moov or
# trak, is itself a sequence of boxes. Only the handful of boxes the library
# actually needs are descended into; everything else is skipped over by size
# without being interpreted.

_CONTAINER_BOXES = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}


def _isobmff_major_brand(file):
    """The 4-byte major_brand from the leading 'ftyp' box (e.g. b'isom',
    b'qt  ', b'3gp4'), or a generic fallback brand for the small number of
    older QuickTime .mov files that skip 'ftyp' entirely and start straight
    with 'moov'/'free'/'wide'/'mdat' - or None when this isn't an ISOBMFF
    file at all."""
    header = file.read(16)
    if len(header) < 8:
        return None

    box_type = header[4:8]
    if box_type == b"ftyp" and len(header) == 16:
        return header[8:12]  # major_brand sits right after the box's own size+type header
    if box_type in (b"moov", b"free", b"mdat", b"wide"):
        return b"qt  "  # no ftyp brand to read - assume the QuickTime family

    return None


def _find_box(file, name: bytes, end=None):
    """The first top-level box of the given name, read fully into memory (a
    moov box is metadata only - at most a few hundred KB even for a long
    video, never the media data itself, which lives in a sibling 'mdat')."""
    if end is None:
        file.seek(0, 2)
        end = file.tell()
        file.seek(0)

    while file.tell() < end:
        box_start = file.tell()
        header = file.read(8)
        if len(header) < 8:
            return None

        size, box_type = struct.unpack(">I4s", header)
        if size == 1:  # 64-bit "largesize" extension
            large = file.read(8)
            if len(large) < 8:
                return None
            size = struct.unpack(">Q", large)[0]
            header_len = 16
        elif size == 0:  # box extends to end of file
            size = end - box_start
            header_len = 8
        else:
            header_len = 8

        if size < header_len or box_start + size > end:
            return None

        if box_type == name:
            file.seek(box_start + header_len)
            return file.read(size - header_len)

        file.seek(box_start + size)

    return None


def _iter_boxes(data: bytes):
    offset = 0
    while offset + 8 <= len(data):
        size, box_type = struct.unpack(">I4s", data[offset:offset + 8])
        header_len = 8
        if size == 1:
            if offset + 16 > len(data):
                return
            size = struct.unpack(">Q", data[offset + 8:offset + 16])[0]
            header_len = 16
        elif size == 0:
            size = len(data) - offset

        if size < header_len or offset + size > len(data):
            return

        yield box_type, data[offset + header_len:offset + size]
        offset += size


def _duration_seconds(moov: bytes):
    for box_type, payload in _iter_boxes(moov):
        if box_type != b"mvhd" or len(payload) < 4:
            continue

        version = payload[0]
        try:
            if version == 1:
                # creation_time/modification_time are 8 bytes each in v1
                timescale = struct.unpack(">I", payload[20:24])[0]
                duration = struct.unpack(">Q", payload[24:32])[0]
            else:
                timescale, duration = struct.unpack(">II", payload[12:20])
        except struct.error:
            return None

        return round(duration / timescale, 2) if timescale else None

    return None


def _track_size(moov: bytes):
    """The display width/height of the first video track. A 'tkhd' box always
    carries a size (even for an audio-only track, where it's 0x0), so this
    also has to peek at whether the track actually contains a video media
    handler ('vide') before trusting its size - otherwise an audio track
    listed before the video one could win by simply coming first."""
    for box_type, trak in _iter_boxes(moov):
        if box_type != b"trak":
            continue

        if not _is_video_track(trak):
            continue

        size = _tkhd_size(trak)
        if size is not None:
            return size

    return (None, None)


def _is_video_track(trak: bytes) -> bool:
    for box_type, payload in _iter_boxes(trak):
        if box_type == b"mdia":
            for inner_type, inner in _iter_boxes(payload):
                if inner_type == b"hdlr" and len(inner) >= 12 and inner[8:12] == b"vide":
                    return True
    return False


def _tkhd_size(trak: bytes):
    for box_type, payload in _iter_boxes(trak):
        if box_type != b"tkhd" or len(payload) < 4:
            continue

        version = payload[0]
        try:
            # width/height sit right after the fixed 9-value transform matrix,
            # whose own offset depends on whether the times/duration fields
            # above it are 32-bit (version 0) or 64-bit (version 1)
            offset = 88 if version == 1 else 76
            width_fixed, height_fixed = struct.unpack(">II", payload[offset:offset + 8])
        except struct.error:
            return None

        # 16.16 fixed-point, as ISOBMFF stores every "unity matrix" dimension
        return (width_fixed >> 16) or None, (height_fixed >> 16) or None

    return None
