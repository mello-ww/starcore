"""Image inspection with the standard library, and optional thumbnail rendering.

Dimensions, format and EXIF details are read straight from the file headers, so
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

# tags this parser understands, read straight out of IFD0, the Exif sub-IFD and
# the GPS sub-IFD - EXIF has hundreds of tags, and only the ones actually
# surfaced by the Photo satellite are worth decoding
EXIF_MAKE = 0x010F
EXIF_MODEL = 0x0110
EXIF_ORIENTATION = 0x0112
EXIF_DATE_TIME = 0x0132
EXIF_EXPOSURE_TIME = 0x829A
EXIF_FNUMBER = 0x829D
EXIF_ISO = 0x8827
EXIF_DATE_TIME_ORIGINAL = 0x9003
EXIF_FOCAL_LENGTH = 0x920A
EXIF_LENS_MODEL = 0xA434
EXIF_SUB_IFD = 0x8769
EXIF_GPS_IFD = 0x8825

GPS_LATITUDE_REF = 0x0001
GPS_LATITUDE = 0x0002
GPS_LONGITUDE_REF = 0x0003
GPS_LONGITUDE = 0x0004

# byte size of one component of each EXIF value type this parser can decode -
# see the TIFF 6.0 spec's "Type" table; types not listed here (undefined byte
# blobs, floats, ...) are simply skipped rather than guessed at
_TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}

METADATA_FIELDS = (
    "camera_make", "camera_model", "lens_model", "focal_length", "aperture",
    "shutter_speed", "iso", "orientation", "gps_latitude", "gps_longitude",
    "gps_coordinates", "captured_at",
)

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
    """Returns the EXIF capture date as an ISO string, or None when unavailable.

    Kept as a small wrapper around exif_metadata() for anything that only ever
    needed the date, but the Photo library itself now reads the fuller set of
    fields exif_metadata() returns in one pass instead of calling this.
    """
    return exif_metadata(path)["captured_at"]


def exif_metadata(path) -> dict:
    """EXIF details read from a JPEG's APP1 segment, when present and well formed.

    Every field defaults to None - a photo with no EXIF segment, a format this
    parser does not read EXIF from (PNG, WEBP), or a malformed or truncated
    segment simply carries less detail. This never raises, so a photo with bad
    or unusual EXIF data can still be imported; it just won't have that detail.
    """
    empty = dict.fromkeys(METADATA_FIELDS)

    try:
        exif = _jpeg_exif(path)
        if exif is None:
            return empty

        order = "<" if exif[:2] == b"II" else ">" if exif[:2] == b"MM" else None
        if order is None:
            return empty

        root = _read_ifd(exif, order, struct.unpack(f"{order}I", exif[4:8])[0])
        detail = _read_ifd(exif, order, root[EXIF_SUB_IFD]) if isinstance(root.get(EXIF_SUB_IFD), int) else {}
        gps = _read_ifd(exif, order, root[EXIF_GPS_IFD]) if isinstance(root.get(EXIF_GPS_IFD), int) else {}

        latitude = _gps_decimal(gps.get(GPS_LATITUDE), gps.get(GPS_LATITUDE_REF))
        longitude = _gps_decimal(gps.get(GPS_LONGITUDE), gps.get(GPS_LONGITUDE_REF))

        return {
            "camera_make": _text(root.get(EXIF_MAKE)),
            "camera_model": _text(root.get(EXIF_MODEL)),
            "lens_model": _text(detail.get(EXIF_LENS_MODEL)),
            "focal_length": _round(detail.get(EXIF_FOCAL_LENGTH)),
            "aperture": _round(detail.get(EXIF_FNUMBER)),
            "shutter_speed": _shutter_speed(detail.get(EXIF_EXPOSURE_TIME)),
            "iso": _int(detail.get(EXIF_ISO)),
            "orientation": _int(root.get(EXIF_ORIENTATION)),
            "gps_latitude": latitude,
            "gps_longitude": longitude,
            "gps_coordinates": _gps_readable(latitude, longitude),
            "captured_at": _parse_exif_datetime(detail.get(EXIF_DATE_TIME_ORIGINAL) or root.get(EXIF_DATE_TIME)),
        }
    except Exception:
        # a photo with EXIF data this parser trips over is still a usable photo -
        # it simply gets no metadata, exactly like one with no EXIF at all
        return empty


def megapixels(width: int, height: int):
    if not width or not height:
        return None

    return round(width * height / 1_000_000, 1)


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


def _jpeg_exif(path):
    """The raw EXIF/TIFF blob from a JPEG's APP1 segment, or None."""
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
    """Decodes one Image File Directory's entries into {tag: value}.

    A tag this parser has no use for, or one whose value cannot be decoded
    cleanly (an unsupported type, a truncated or out-of-range offset), is left
    out rather than guessed at - callers only ever see tags they asked about,
    and only when there was a real value to read.
    """
    fields = {}
    if offset < 0 or offset + 2 > len(exif):
        return fields

    count = struct.unpack(f"{order}H", exif[offset:offset + 2])[0]

    for index in range(count):
        entry = offset + 2 + index * 12
        if entry + 12 > len(exif):
            break

        tag, kind, length = struct.unpack(f"{order}HHI", exif[entry:entry + 8])
        value = _decode_entry(exif, order, kind, length, entry)
        if value is not None:
            fields[tag] = value

    return fields


def _decode_entry(exif: bytes, order: str, kind: int, count: int, entry: int):
    size = _TYPE_SIZES.get(kind)
    if size is None or count <= 0:
        return None

    total = size * count
    if total <= 4:
        data = exif[entry + 8:entry + 8 + total]
    else:
        offset = struct.unpack(f"{order}I", exif[entry + 8:entry + 12])[0]
        if offset < 0 or offset + total > len(exif):
            return None
        data = exif[offset:offset + total]

    if len(data) < total:
        return None

    if kind == 2:  # ASCII
        return data.split(b"\x00")[0].decode("ascii", "ignore")
    if kind == 3:  # SHORT
        values = struct.unpack(f"{order}{count}H", data)
    elif kind == 4:  # LONG
        values = struct.unpack(f"{order}{count}I", data)
    elif kind == 5:  # RATIONAL
        values = tuple(_ratio(numerator, denominator) for numerator, denominator in struct.iter_unpack(f"{order}2I", data))
    elif kind == 10:  # SRATIONAL
        values = tuple(_ratio(numerator, denominator) for numerator, denominator in struct.iter_unpack(f"{order}2i", data))
    else:
        return None  # a type this parser does not need to understand

    return values[0] if count == 1 else values


def _ratio(numerator: int, denominator: int):
    return numerator / denominator if denominator else None


def _text(value):
    if not isinstance(value, str):
        return None

    text = value.strip(" \x00")
    return text or None


def _int(value):
    return int(value) if isinstance(value, (int, float)) else None


def _round(value, digits: int = 2):
    return round(value, digits) if isinstance(value, (int, float)) else None


def _shutter_speed(seconds):
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return None
    if seconds >= 1:
        return f"{seconds:g}s"

    return f"1/{round(1 / seconds)}"


def _parse_exif_datetime(raw):
    if not isinstance(raw, str):
        return None

    try:
        return datetime.strptime(raw.strip(), "%Y:%m:%d %H:%M:%S").isoformat()
    except ValueError:
        return None


def _gps_decimal(dms, ref):
    """Degrees/minutes/seconds plus a hemisphere letter, as decimal degrees."""
    if not isinstance(dms, tuple) or len(dms) != 3 or None in dms or not isinstance(ref, str):
        return None

    hemisphere = ref.strip().upper()
    if hemisphere not in ("N", "S", "E", "W"):
        return None  # not a hemisphere letter EXIF actually defines - can't sign it

    degrees, minutes, seconds = dms
    value = degrees + minutes / 60 + seconds / 3600
    return round(-value if hemisphere in ("S", "W") else value, 6)


def _gps_readable(latitude, longitude):
    if latitude is None or longitude is None:
        return None

    lat_direction = "N" if latitude >= 0 else "S"
    lon_direction = "E" if longitude >= 0 else "W"
    return f"{abs(latitude):.5f}° {lat_direction}, {abs(longitude):.5f}° {lon_direction}"
