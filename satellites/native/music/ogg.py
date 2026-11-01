"""Ogg Vorbis and Opus: identification header, comments, cover art and duration."""

import base64
import struct

PAGE_HEADER = 27
COMMENT_LIMIT = 16 * 1024 * 1024
TAIL = 64 * 1024
OPUS_RATE = 48000


def read(file, size: int, vorbis_comment) -> tuple:
    """Returns (tags, artwork, duration); vorbis_comment(tags, name, value) files one comment."""
    packets = _first_packets(file, 2)
    if len(packets) < 2:
        raise ValueError("the Ogg stream is missing its headers")

    identification, comments = packets
    tags = {}
    art = None

    if identification.startswith(b"OpusHead") and len(identification) >= 19:
        channels = identification[9]
        pre_skip = struct.unpack("<H", identification[10:12])[0]
        tags.update({"codec": "opus", "channels": channels, "sample_rate": OPUS_RATE})
        rate, skip = OPUS_RATE, pre_skip
        body = comments[8:] if comments.startswith(b"OpusTags") else b""
    elif identification.startswith(b"\x01vorbis") and len(identification) >= 30:
        channels = identification[11]
        rate = struct.unpack("<I", identification[12:16])[0]
        nominal = struct.unpack("<i", identification[20:24])[0]
        tags.update({"codec": "vorbis", "channels": channels, "sample_rate": rate})
        if nominal > 0:
            tags["bitrate"] = nominal
        skip = 0
        body = comments[7:] if comments.startswith(b"\x03vorbis") else b""
    else:
        raise ValueError("the Ogg stream is neither Vorbis nor Opus")

    for name, value in _comments(body):
        if name.upper() == "METADATA_BLOCK_PICTURE" and art is None:
            art = _picture(value)
        else:
            vorbis_comment(tags, name, value)

    granule = _last_granule(file, size)
    duration = (granule - skip) / rate if granule and rate and granule > skip else None
    return tags, art, duration


def _first_packets(file, wanted: int) -> list:
    file.seek(0)
    packets, current, total = [], b"", 0

    while len(packets) < wanted:
        header = file.read(PAGE_HEADER)
        if len(header) < PAGE_HEADER or header[:4] != b"OggS":
            break
        lacing = file.read(header[26])
        for segment in lacing:
            current += file.read(segment)
            total += segment
            if total > COMMENT_LIMIT:
                raise ValueError("the Ogg headers are implausibly large")
            if segment < 255:
                packets.append(current)
                current = b""
                if len(packets) == wanted:
                    break
    return packets


def _comments(body: bytes):
    if len(body) < 8:
        return
    offset = 4 + struct.unpack("<I", body[:4])[0]
    count = struct.unpack("<I", body[offset:offset + 4])[0]
    offset += 4
    for _ in range(min(count, 10_000)):
        if offset + 4 > len(body):
            return
        length = struct.unpack("<I", body[offset:offset + 4])[0]
        entry = body[offset + 4:offset + 4 + length].decode("utf-8", "replace")
        offset += 4 + length
        name, separator, value = entry.partition("=")
        if separator:
            yield name, value


def _picture(value: str):
    """METADATA_BLOCK_PICTURE is a base64 FLAC PICTURE block."""
    try:
        payload = base64.b64decode(value, validate=False)
        offset = 8 + struct.unpack(">I", payload[4:8])[0]
        mime = payload[8:offset].decode("ascii", "replace").lower()
        offset += 4 + struct.unpack(">I", payload[offset:offset + 4])[0] + 16
        length = struct.unpack(">I", payload[offset:offset + 4])[0]
        data = payload[offset + 4:offset + 4 + length]
    except (ValueError, struct.error):
        return None
    if not data:
        return None
    return data, "image/png" if "png" in mime or data[:4] == b"\x89PNG" else "image/jpeg"


def _last_granule(file, size: int):
    file.seek(max(size - TAIL, 0))
    tail = file.read(TAIL)
    offset = tail.rfind(b"OggS")
    while offset >= 0:
        if offset + 14 <= len(tail):
            granule = struct.unpack("<q", tail[offset + 6:offset + 14])[0]
            if granule > 0:
                return granule
        offset = tail.rfind(b"OggS", 0, offset)
    return None
