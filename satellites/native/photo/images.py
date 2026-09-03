"""Image inspection with the standard library, and optional thumbnail rendering.

Dimensions, format and capture date are read straight from the file headers, so
the library keeps StarCore's dependency-free promise. Rendering a thumbnail is
the one thing the standard library cannot do for JPEG or WEBP: Pillow is used
when it happens to be installed, and the gallery falls back to the original
otherwise.
"""

from datetime import datetime
import struct

FORMATS = {
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".png": "png",
    ".webp": "webp",
}

EXTENSIONS = {
    "jpeg": ".jpg",
    "png": ".png",
    "webp": ".webp",
}

CONTENT_TYPES = {
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}

# markers that carry the frame dimensions, excluding the ones that only look like them
JPEG_SIZE_MARKERS = set(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
JPEG_STANDALONE_MARKERS = {0x01, 0xD8} | set(range(0xD0, 0xD8))

EXIF_DATE_TIME_ORIGINAL = 0x9003
EXIF_DATE_TIME = 0x0132
EXIF_SUB_IFD = 0x8769

_pillow = None


class UnsupportedImage(Exception):
    pass


def probe(path) -> dict:
    """Returns format, width and height, or raises UnsupportedImage."""
    with open(path, "rb") as file:
        header = file.read(32)

        # a file can be recognisable and still be too short to describe itself,
        # which has to read as an unusable image rather than a parsing failure
        try:
            if header[:2] == b"\xff\xd8":
                return {"format": "jpeg", **_jpeg_size(file)}
            if header[:8] == b"\x89PNG\r\n\x1a\n":
                return {"format": "png", **_png_size(header)}
            if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
                return {"format": "webp", **_webp_size(header + file.read(16))}
        except (struct.error, IndexError) as error:
            raise UnsupportedImage(f"the image header is incomplete ({error})")

    raise UnsupportedImage("unrecognized image format")


def capture_date(path):
    """Returns the EXIF capture date as an ISO string, or None when unavailable."""
    try:
        return _capture_date(path)
    except Exception:
        return None


def thumbnails_available() -> bool:
    return _load_pillow() is not None


def thumbnail(source, destination, size: int) -> bool:
    """Renders a downscaled copy of `source`. Returns False when that is not possible."""
    pillow = _load_pillow()
    if pillow is None:
        return False

    image_module, operations = pillow
    try:
        with image_module.open(source) as image:
            upright = operations.exif_transpose(image)
            upright.thumbnail((size, size))
            upright.convert("RGB").save(destination, "JPEG", quality=82)
    except Exception as error:
        print(f"[WARNING]: thumbnail for {source} could not be generated ({error}).")
        return False

    return True


def _load_pillow():
    global _pillow

    if _pillow is None:
        try:
            from PIL import Image, ImageOps
            _pillow = (Image, ImageOps)
        except ImportError:
            _pillow = False

    return _pillow or None


def _png_size(header: bytes) -> dict:
    width, height = struct.unpack(">II", header[16:24])
    return {"width": width, "height": height}


def _jpeg_size(file) -> dict:
    file.seek(2)

    while True:
        byte = file.read(1)
        if not byte:
            raise UnsupportedImage("truncated JPEG")
        if byte != b"\xff":
            continue

        marker = file.read(1)
        while marker == b"\xff":
            marker = file.read(1)
        if not marker:
            raise UnsupportedImage("truncated JPEG")

        code = marker[0]
        if code in JPEG_SIZE_MARKERS:
            file.read(3)
            height, width = struct.unpack(">HH", file.read(4))
            return {"width": width, "height": height}
        if code in JPEG_STANDALONE_MARKERS:
            continue
        if code == 0xD9:
            raise UnsupportedImage("JPEG has no frame header")

        length = struct.unpack(">H", file.read(2))[0]
        file.seek(length - 2, 1)


def _webp_size(header: bytes) -> dict:
    if len(header) < 30:
        raise UnsupportedImage("the WEBP header is incomplete")

    chunk = header[12:16]

    if chunk == b"VP8X":
        width = int.from_bytes(header[24:27], "little") + 1
        height = int.from_bytes(header[27:30], "little") + 1
    elif chunk == b"VP8L":
        bits = int.from_bytes(header[21:25], "little")
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
    elif chunk == b"VP8 ":
        width = struct.unpack("<H", header[26:28])[0] & 0x3FFF
        height = struct.unpack("<H", header[28:30])[0] & 0x3FFF
    else:
        raise UnsupportedImage("unrecognized WEBP variant")

    return {"width": width, "height": height}


def _capture_date(path):
    exif = _jpeg_exif(path)
    if exif is None:
        return None

    order = "<" if exif[:2] == b"II" else ">" if exif[:2] == b"MM" else None
    if order is None:
        return None

    root = _read_ifd(exif, order, struct.unpack(f"{order}I", exif[4:8])[0])
    detail = _read_ifd(exif, order, root[EXIF_SUB_IFD]) if EXIF_SUB_IFD in root else {}

    raw = detail.get(EXIF_DATE_TIME_ORIGINAL) or root.get(EXIF_DATE_TIME)
    if not isinstance(raw, str):
        return None

    return datetime.strptime(raw.strip(), "%Y:%m:%d %H:%M:%S").isoformat()


def _jpeg_exif(path):
    with open(path, "rb") as file:
        if file.read(2) != b"\xff\xd8":
            return None

        while True:
            byte = file.read(1)
            if not byte:
                return None
            if byte != b"\xff":
                continue

            marker = file.read(1)
            while marker == b"\xff":
                marker = file.read(1)
            if not marker:
                return None

            code = marker[0]
            if code in JPEG_STANDALONE_MARKERS:
                continue
            if code == 0xDA or code == 0xD9:
                return None  # image data starts here, there is no EXIF segment

            length = struct.unpack(">H", file.read(2))[0]
            payload = file.read(length - 2)
            if code == 0xE1 and payload.startswith(b"Exif\x00\x00"):
                return payload[6:]


def _read_ifd(exif: bytes, order: str, offset: int) -> dict:
    fields = {}
    count = struct.unpack(f"{order}H", exif[offset:offset + 2])[0]

    for index in range(count):
        entry = offset + 2 + index * 12
        tag, kind, length = struct.unpack(f"{order}HHI", exif[entry:entry + 8])

        if kind == 2:  # ASCII
            start = struct.unpack(f"{order}I", exif[entry + 8:entry + 12])[0] if length > 4 else entry + 8
            fields[tag] = exif[start:start + length].split(b"\x00")[0].decode("ascii", "ignore")
        elif kind == 4:  # LONG, used for the offset of the EXIF sub-IFD
            fields[tag] = struct.unpack(f"{order}I", exif[entry + 8:entry + 12])[0]

    return fields
