"""Audio tags, duration and cover art read straight out of the container bytes.

FLAC, MP3, WAV, MP4 and Ogg all keep that information in documented headers, so the music
satellite can index a library with nothing but the standard library behind it. Everything
read here comes from an untrusted file: every parser is bounded and isolated by _guard.
"""

import os
import struct

from . import ogg

FORMATS = {
    ".mp3": "mp3",
    ".flac": "flac",
    ".wav": "wav",
    ".m4a": "m4a",
    ".mp4": "m4a",
    ".aac": "m4a",
    ".m4b": "m4a",
    ".alac": "m4a",
    ".ogg": "ogg",
    ".oga": "ogg",
    ".opus": "opus",
}

CONTENT_TYPES = {
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
    "wav": "audio/wav",
    "m4a": "audio/mp4",
    "ogg": "audio/ogg",
    "opus": "audio/ogg; codecs=opus",
}

TAG_KEYS = ("title", "artist", "album", "album_artist", "track", "disc", "year", "genre")

# read when present, never required
EXTRA_KEYS = (
    "date", "track_total", "disc_total", "composer", "producer", "label", "copyright", "isrc",
    "compilation", "lyrics", "comment", "mb_track_id", "mb_album_id", "mb_artist_id",
    "mb_release_group_id", "rg_track_gain", "rg_track_peak", "rg_album_gain", "rg_album_peak",
)

# technical description of the stream, filled in by each format's reader
TECHNICAL_KEYS = ("codec", "sample_rate", "bit_depth", "channels", "bitrate")

LOSSLESS_CODECS = {"flac", "alac", "pcm"}

MULTI_KEYS = ("artist", "album_artist", "genre", "composer")

VORBIS_TAGS = {
    "TITLE": "title",
    "ARTIST": "artist",
    "ARTISTS": "artist",
    "ALBUM": "album",
    "ALBUMARTIST": "album_artist",
    "ALBUM ARTIST": "album_artist",
    "TRACKNUMBER": "track",
    "DISCNUMBER": "disc",
    "TRACKTOTAL": "track_total",
    "TOTALTRACKS": "track_total",
    "DISCTOTAL": "disc_total",
    "TOTALDISCS": "disc_total",
    "DATE": "date",
    "YEAR": "year",
    "ORIGINALDATE": "date",
    "GENRE": "genre",
    "COMPOSER": "composer",
    "PRODUCER": "producer",
    "LABEL": "label",
    "ORGANIZATION": "label",
    "PUBLISHER": "label",
    "COPYRIGHT": "copyright",
    "ISRC": "isrc",
    "COMPILATION": "compilation",
    "LYRICS": "lyrics",
    "UNSYNCEDLYRICS": "lyrics",
    "COMMENT": "comment",
    "DESCRIPTION": "comment",
    "MUSICBRAINZ_TRACKID": "mb_track_id",
    "MUSICBRAINZ_ALBUMID": "mb_album_id",
    "MUSICBRAINZ_ARTISTID": "mb_artist_id",
    "MUSICBRAINZ_RELEASEGROUPID": "mb_release_group_id",
    "REPLAYGAIN_TRACK_GAIN": "rg_track_gain",
    "REPLAYGAIN_TRACK_PEAK": "rg_track_peak",
    "REPLAYGAIN_ALBUM_GAIN": "rg_album_gain",
    "REPLAYGAIN_ALBUM_PEAK": "rg_album_peak",
}

ID3_FRAMES = {
    b"TIT2": "title",
    b"TPE1": "artist",
    b"TALB": "album",
    b"TPE2": "album_artist",
    b"TRCK": "track",
    b"TPOS": "disc",
    b"TDRC": "date",
    b"TYER": "year",
    b"TDOR": "date",
    b"TCON": "genre",
    b"TCOM": "composer",
    b"TPUB": "label",
    b"TCOP": "copyright",
    b"TSRC": "isrc",
    b"TCMP": "compilation",
}

# TXXX frames are matched on their description, case-insensitively
ID3_USER_FRAMES = {
    "musicbrainz release track id": "mb_track_id",
    "musicbrainz track id": "mb_track_id",
    "musicbrainz album id": "mb_album_id",
    "musicbrainz artist id": "mb_artist_id",
    "musicbrainz release group id": "mb_release_group_id",
    "replaygain_track_gain": "rg_track_gain",
    "replaygain_track_peak": "rg_track_peak",
    "replaygain_album_gain": "rg_album_gain",
    "replaygain_album_peak": "rg_album_peak",
    "producer": "producer",
    "label": "label",
    "artists": "artist",
}

MP4_TAGS = {
    b"\xa9nam": "title",
    b"\xa9ART": "artist",
    b"\xa9alb": "album",
    b"aART": "album_artist",
    b"trkn": "track",
    b"disk": "disc",
    b"\xa9day": "date",
    b"\xa9gen": "genre",
    b"gnre": "genre",
    b"\xa9wrt": "composer",
    b"cprt": "copyright",
    b"\xa9lyr": "lyrics",
    b"\xa9cmt": "comment",
    b"cpil": "compilation",
}

WAV_TAGS = {
    b"INAM": "title",
    b"IART": "artist",
    b"IPRD": "album",
    b"ITRK": "track",
    b"ICRD": "year",
    b"IGNR": "genre",
}

MPEG1_BITRATES = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
MPEG2_BITRATES = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
MPEG_SAMPLE_RATES = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}

# a Xing header sits behind the frame's side information, the one part of a frame whose
# length depends on the MPEG version and on whether the frame is mono
XING_OFFSETS = {(3, True): 21, (3, False): 36, (2, True): 13, (2, False): 21, (0, True): 13, (0, False): 21}

# freeform "----" atoms carry the same names Vorbis comments use
MP4_FREEFORM = {name.lower(): key for name, key in VORBIS_TAGS.items()}
MP4_FREEFORM.update({
    "musicbrainz track id": "mb_track_id",
    "musicbrainz album id": "mb_album_id",
    "musicbrainz artist id": "mb_artist_id",
    "musicbrainz release group id": "mb_release_group_id",
})

MP4_IMAGE_TYPES = {13: "image/jpeg", 14: "image/png"}

# the classic ID3v1 genre list, which ID3v1 tags and MP4 "gnre" atoms index into
GENRES = (
    "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal",
    "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial",
    "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop",
    "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental", "Acid", "House", "Game",
    "Sound Clip", "Gospel", "Noise", "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative",
    "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial",
    "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta",
    "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave",
    "Psychadelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz",
    "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock", "Folk", "Folk-Rock", "National Folk",
    "Swing", "Fast Fusion", "Bebob", "Latin", "Revival", "Celtic", "Bluegrass", "Avantgarde",
    "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock", "Slow Rock", "Big Band",
    "Chorus", "Easy Listening", "Acoustic", "Humour", "Speech", "Chanson", "Opera", "Chamber Music",
    "Sonata", "Symphony", "Booty Bass", "Primus", "Porn Groove", "Satire", "Slow Jam", "Club", "Tango",
    "Samba", "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle", "Duet", "Punk Rock",
    "Drum Solo", "A capella", "Euro-House", "Dance Hall",
)

MP3_SCAN = 64 * 1024


class UnsupportedAudio(Exception):
    """Raised when a file is not a readable file of a supported format."""


def probe(path) -> dict:
    """Returns the format, tags, duration and artwork flag, or raises UnsupportedAudio."""
    kind, tags, art, duration = _read(path)

    information = {"format": kind}
    for key in TAG_KEYS + EXTRA_KEYS + TECHNICAL_KEYS:
        information[key] = tags.get(key)

    if information["year"] is None and information["date"]:
        information["year"] = _year(information["date"])
    if information["date"] is None and information["year"]:
        information["date"] = str(information["year"])
    for key in MULTI_KEYS:
        information[f"{key}s"] = tags.get(f"{key}s") or ([information[key]] if information[key] else [])

    information["duration"] = round(duration, 1) if duration and duration > 0 else None
    information["has_artwork"] = art is not None

    if information["bitrate"] is None and information["duration"]:
        information["bitrate"] = int(_size_of(path) * 8 / information["duration"])
    information["lossless"] = information["codec"] in LOSSLESS_CODECS

    return information


def artwork(path) -> tuple | None:
    """Returns (bytes, content type) for the embedded cover, or None when there is none."""
    try:
        return _read(path)[2]
    except Exception:
        return None


def _read(path) -> tuple:
    """Decides what the file is and hands it to the reader for that format."""
    with open(path, "rb") as file:
        size = _size(file)
        header = file.read(16)
        kind = _sniff(file, header, FORMATS.get(_extension(path)))

        if kind == "flac":
            return ("flac", *_flac(file))
        if kind == "mp3":
            return ("mp3", *_mp3(file, size))
        if kind == "wav":
            return ("wav", *_wav(file, size))
        if kind in ("ogg", "opus"):
            tags, art, duration = ogg.read(file, size, vorbis_comment)
            return ("opus" if tags.get("codec") == "opus" else "ogg", tags, art, duration)

        return ("m4a", *_mp4(file, size))


def _sniff(file, header: bytes, hint):
    if header[:4] == b"fLaC":
        return "flac"
    if header[:3] == b"ID3":
        return "mp3"
    if header[:4] == b"RIFF" and header[8:12] == b"WAVE":
        return "wav"
    if header[4:8] == b"ftyp":
        return "m4a"
    if header[:4] == b"OggS":
        return "ogg"
    if _mpeg_header(header, 0):
        return "mp3"

    # an MP3 without an ID3v2 tag can still start with junk, so trust the name that far
    if hint == "mp3":
        file.seek(0)
        if _first_frame(file.read(MP3_SCAN)) is not None:
            return "mp3"

    raise UnsupportedAudio("unrecognized audio format")


# ---------- FLAC ----------


def _flac(file) -> tuple:
    blocks = _guard(_flac_blocks, file) or []

    # STREAMINFO is mandatory and fixed size, so a file carrying only the magic
    # bytes is not a stream this can describe
    stream = _flac_block(blocks, 0)
    if stream is None or len(stream) < 34:
        raise UnsupportedAudio("the FLAC stream information is missing")

    tags = _guard(_flac_tags, blocks) or {}
    packed = int.from_bytes(stream[10:18], "big")
    tags.update({"codec": "flac", "sample_rate": packed >> 44, "channels": ((packed >> 41) & 0x07) + 1,
                 "bit_depth": ((packed >> 36) & 0x1F) + 1})

    return tags, _guard(_flac_picture, blocks), _guard(_flac_duration, blocks)


def _flac_blocks(file) -> list:
    file.seek(4)
    blocks = []

    while True:
        header = file.read(4)
        if len(header) < 4:
            break

        blocks.append((header[0] & 0x7F, file.read(int.from_bytes(header[1:4], "big"))))
        if header[0] & 0x80:  # the last block flag, after which the audio frames start
            break

    return blocks


def _flac_block(blocks: list, kind: int):
    for block_kind, payload in blocks:
        if block_kind == kind:
            return payload

    return None


def _flac_duration(blocks: list):
    payload = _flac_block(blocks, 0)
    if payload is None or len(payload) < 18:
        return None

    # sample rate, channels, bit depth and sample count share the same 64 bit field
    packed = int.from_bytes(payload[10:18], "big")
    sample_rate = packed >> 44
    total_samples = packed & 0xFFFFFFFFF

    return total_samples / sample_rate if sample_rate and total_samples else None


def _flac_tags(blocks: list) -> dict:
    payload = _flac_block(blocks, 4)
    if payload is None:
        return {}

    tags = {}
    offset = 4 + int.from_bytes(payload[0:4], "little")
    count = int.from_bytes(payload[offset:offset + 4], "little")
    offset += 4

    for _ in range(count):
        if offset + 4 > len(payload):
            break

        length = int.from_bytes(payload[offset:offset + 4], "little")
        entry = payload[offset + 4:offset + 4 + length].decode("utf-8", "replace")
        offset += 4 + length

        name, separator, value = entry.partition("=")
        if separator:
            vorbis_comment(tags, name, value)

    return tags


def vorbis_comment(tags: dict, name: str, value: str):
    """Shared by FLAC and Ogg, which use the same comment block."""
    key = VORBIS_TAGS.get(name.strip().upper())
    if key is None:
        return
    if key in ("track", "disc") and "/" in value:
        _put(tags, f"{key}_total", _number(value.partition("/")[2]))
    _put(tags, key, _typed(key, _text(value)))
    if key in MULTI_KEYS:
        _append(tags, f"{key}s", _text(value))


def _flac_picture(blocks: list):
    payload = _flac_block(blocks, 6)
    if payload is None:
        return None

    offset = 8 + int.from_bytes(payload[4:8], "big")
    mime = payload[8:offset].decode("ascii", "replace")

    # the description is followed by width, height, colour depth and palette size
    offset += 4 + int.from_bytes(payload[offset:offset + 4], "big") + 16
    length = int.from_bytes(payload[offset:offset + 4], "big")
    data = payload[offset + 4:offset + 4 + length]

    return (data, _image_type(mime, data)) if data else None


# ---------- MP3 ----------


def _mp3(file, size) -> tuple:
    file.seek(0)
    header = file.read(10)
    start = 0
    tags, art = {}, None

    if header[:3] == b"ID3" and len(header) == 10:
        start = 10 + _syncsafe(header[6:10])
        if header[5] & 0x10:  # a v2.4 footer repeats the ten byte header behind the tag
            start += 10

        tags, art = _guard(_id3v2, file, size, header) or ({}, None)

    if not tags:
        tags = _guard(_id3v1, file, size) or {}

    tags.update(_guard(_mp3_technical, file, start) or {})

    return tags, art, _guard(_mp3_duration, file, size, start)


def _mp3_technical(file, start) -> dict:
    file.seek(start)
    window = file.read(MP3_SCAN)
    offset = _first_frame(window)
    if offset is None:
        return {}

    frame = _mpeg_header(window, offset)
    technical = {"codec": "mp3", "sample_rate": frame["sample_rate"], "channels": 1 if frame["mono"] else 2}
    if not _xing_frames(window, offset, frame):
        technical["bitrate"] = frame["bitrate"]
    return technical


def _id3v2(file, size, header: bytes) -> tuple:
    major = header[3]
    file.seek(10)
    body = file.read(min(_syncsafe(header[6:10]), size))  # clamped, a bogus size reaches 256 MB
    tags = {}
    art = None
    offset = 0

    if header[5] & 0x40:
        # v2.4 counts the extended header's own size field, v2.3 does not
        offset = _syncsafe(body[0:4]) if major >= 4 else 4 + int.from_bytes(body[0:4], "big")

    while offset + 10 <= len(body):
        name = body[offset:offset + 4]
        if not name.strip(b"\x00"):  # padding between the frames and the audio
            break

        raw = body[offset + 4:offset + 8]
        length = _syncsafe(raw) if major >= 4 else int.from_bytes(raw, "big")
        if length <= 0:
            break

        payload = body[offset + 10:offset + 10 + length]
        offset += 10 + length

        if name == b"APIC" and art is None:
            art = _guard(_id3_picture, payload)
        elif name == b"USLT":
            _put(tags, "lyrics", _guard(_id3_lyrics, payload))
        elif name == b"TXXX":
            described = _guard(_id3_user_text, payload)
            if described:
                key = ID3_USER_FRAMES.get(described[0].lower())
                if key:
                    _put(tags, key, _typed(key, described[1]))
        elif name in ID3_FRAMES:
            key = ID3_FRAMES[name]
            values = _guard(_id3_values, payload) or []
            first = values[0] if values else None
            if key in ("track", "disc") and first and "/" in first:
                _put(tags, f"{key}_total", _number(first.partition("/")[2]))
            _put(tags, key, _typed(key, first))
            if key in MULTI_KEYS:
                for value in values:
                    _append(tags, f"{key}s", value)

    return tags, art


def _id3_values(payload: bytes) -> list:
    if len(payload) < 2:
        return []
    return [part.strip() for part in _id3_decode(payload[0], payload[1:]).split("\x00") if part.strip()]


def _id3_decode(encoding: int, raw: bytes) -> str:
    if encoding == 0:
        return raw.decode("latin-1", "replace")
    if encoding == 1:
        return raw.decode("utf-16", "replace")
    if encoding == 2:
        return raw.decode("utf-16-be", "replace")
    return raw.decode("utf-8", "replace")


def _id3_user_text(payload: bytes):
    encoding = payload[0]
    description, offset = _id3_string(payload, 1, encoding)
    value = _id3_decode(encoding, payload[offset:]).split("\x00")[0].strip()
    return _id3_decode(encoding, description).strip(), value or None


def _id3_lyrics(payload: bytes):
    # encoding, a three letter language and a terminated description come before the text
    encoding = payload[0]
    _, offset = _id3_string(payload, 4, encoding)
    return _typed("lyrics", _text(_id3_decode(encoding, payload[offset:])))


def _id3_text(payload: bytes):
    if len(payload) < 2:
        return None

    encoding = payload[0]
    if encoding == 0:
        text = payload[1:].decode("latin-1", "replace")
    elif encoding == 1:
        text = payload[1:].decode("utf-16", "replace")
    elif encoding == 2:
        text = payload[1:].decode("utf-16-be", "replace")
    else:
        text = payload[1:].decode("utf-8", "replace")

    # v2.4 separates several values with NULs, and every version pads with them
    for part in text.split("\x00"):
        if part.strip():
            return part.strip()

    return None


def _id3_picture(payload: bytes):
    encoding = payload[0]
    mime, offset = _id3_string(payload, 1, 0)  # the MIME type is always plain ASCII
    _, offset = _id3_string(payload, offset + 1, encoding)
    data = payload[offset:]

    return (data, _image_type(mime.decode("latin-1", "replace"), data)) if data else None


def _id3_string(payload: bytes, offset: int, encoding: int) -> tuple:
    """Returns one terminated string and the offset behind it."""
    if encoding in (1, 2):
        end = offset
        while end + 1 < len(payload):
            if payload[end:end + 2] == b"\x00\x00":
                return payload[offset:end], end + 2
            end += 2  # UTF-16 terminators only count on an even boundary
        return payload[offset:], len(payload)

    end = payload.find(b"\x00", offset)
    if end < 0:
        return payload[offset:], len(payload)

    return payload[offset:end], end + 1


def _id3v1(file, size) -> dict:
    if size < 128:
        return {}

    file.seek(size - 128)
    block = file.read(128)
    if block[:3] != b"TAG":
        return {}

    tags = {}
    _put(tags, "title", _latin(block[3:33]))
    _put(tags, "artist", _latin(block[33:63]))
    _put(tags, "album", _latin(block[63:93]))
    _put(tags, "year", _year(_latin(block[93:97])))
    _put(tags, "genre", GENRES[block[127]] if block[127] < len(GENRES) else None)

    if block[125] == 0 and block[126]:  # v1.1 spends the last two comment bytes on the track
        _put(tags, "track", block[126])

    return tags


def _mp3_duration(file, size, start):
    file.seek(start)
    window = file.read(MP3_SCAN)
    offset = _first_frame(window)
    if offset is None:
        return None

    frame = _mpeg_header(window, offset)
    frames = _xing_frames(window, offset, frame)
    if frames:
        return frames * frame["samples"] / frame["sample_rate"]

    return (size - start - offset) * 8 / frame["bitrate"]


def _first_frame(window: bytes):
    offset = window.find(b"\xff")

    while offset >= 0:
        if _mpeg_header(window, offset):
            return offset
        offset = window.find(b"\xff", offset + 1)

    return None


def _mpeg_header(data: bytes, offset: int):
    """Decodes a Layer III frame header, or returns None when there is not one here."""
    if offset + 4 > len(data) or data[offset] != 0xFF or (data[offset + 1] & 0xE0) != 0xE0:
        return None

    version = (data[offset + 1] >> 3) & 0x03
    layer = (data[offset + 1] >> 1) & 0x03
    bitrate_index = data[offset + 2] >> 4
    rate_index = (data[offset + 2] >> 2) & 0x03

    if version == 1 or layer != 1 or bitrate_index in (0, 15) or rate_index == 3:
        return None

    bitrate = (MPEG1_BITRATES if version == 3 else MPEG2_BITRATES)[bitrate_index]

    return {
        "version": version,
        "bitrate": bitrate * 1000,
        "sample_rate": MPEG_SAMPLE_RATES[version][rate_index],
        "mono": (data[offset + 3] >> 6) == 3,
        "samples": 1152 if version == 3 else 576,
    }


def _xing_frames(window: bytes, offset: int, frame: dict):
    start = offset + XING_OFFSETS[(frame["version"], frame["mono"])]
    if window[start:start + 4] not in (b"Xing", b"Info"):
        return None

    flags = int.from_bytes(window[start + 4:start + 8], "big")
    if not flags & 1:
        return None

    return int.from_bytes(window[start + 8:start + 12], "big")


# ---------- WAV ----------


def _wav(file, size) -> tuple:
    chunks = _guard(_wav_chunks, file, size) or {}
    tags = _guard(_wav_tags, file, chunks) or {}
    fmt = _wav_payload(file, chunks.get(b"fmt "))
    if fmt and len(fmt) >= 16:
        channels, sample_rate = struct.unpack("<HI", fmt[2:8])
        bits = struct.unpack("<H", fmt[14:16])[0]
        tags.update({"codec": "pcm", "channels": channels, "sample_rate": sample_rate, "bit_depth": bits,
                     "bitrate": channels * sample_rate * bits})
    return tags, None, _guard(_wav_duration, file, chunks)


def _wav_chunks(file, size) -> dict:
    """Maps chunk names to (offset, length), keeping the first of a repeated name."""
    chunks = {}
    offset = 12

    while offset + 8 <= size:
        file.seek(offset)
        header = file.read(8)
        if len(header) < 8:
            break

        name = header[:4]
        length = int.from_bytes(header[4:8], "little")
        if name == b"LIST" and length >= 4:
            name += file.read(4)  # LIST comes in several forms and only INFO carries tags

        chunks.setdefault(name, (offset + 8, min(length, size - offset - 8)))
        offset += 8 + length + (length & 1)  # chunks are padded to an even size

    return chunks


def _wav_payload(file, span):
    if span is None:
        return None

    file.seek(span[0])
    return file.read(span[1])


def _wav_duration(file, chunks: dict):
    fmt = _wav_payload(file, chunks.get(b"fmt "))
    data = chunks.get(b"data")
    if data is None or fmt is None or len(fmt) < 16:
        return None

    channels, sample_rate = struct.unpack("<HI", fmt[2:8])
    byte_rate = struct.unpack("<I", fmt[8:12])[0]
    bits = struct.unpack("<H", fmt[14:16])[0]
    if not byte_rate:  # rebuilt from the other fields when a writer leaves it empty
        byte_rate = channels * sample_rate * (bits // 8)

    return data[1] / byte_rate if byte_rate else None


def _wav_tags(file, chunks: dict) -> dict:
    payload = _wav_payload(file, chunks.get(b"LISTINFO"))
    if not payload:
        return {}

    tags = {}
    offset = 4

    while offset + 8 <= len(payload):
        name = payload[offset:offset + 4]
        length = int.from_bytes(payload[offset + 4:offset + 8], "little")
        value = payload[offset + 8:offset + 8 + length]
        offset += 8 + length + (length & 1)

        key = WAV_TAGS.get(name)
        if key:
            _put(tags, key, _typed(key, _text(value.decode("utf-8", "replace"))))

    return tags


# ---------- MP4 ----------


def _mp4(file, size) -> tuple:
    moov = _guard(_mp4_atom, file, size, b"moov") or b""
    ilst = _guard(_mp4_ilst, moov) or b""

    tags = _guard(_mp4_tags, ilst) or {}
    tags.update(_guard(_mp4_technical, moov) or {})
    return tags, _guard(_mp4_artwork, ilst), _guard(_mp4_duration, moov)


def _mp4_technical(moov: bytes) -> dict:
    """The first audio sample entry: mp4a (AAC) or alac, with channels, sample size and rate."""
    for name, trak in _mp4_children(moov):
        if name != b"trak":
            continue
        stbl = _mp4_path(trak, (b"mdia", b"minf", b"stbl"))
        stsd = _mp4_child(stbl, b"stsd") if stbl else None
        if not stsd or len(stsd) < 8:
            continue
        for entry, body in _mp4_children(stsd[8:]):
            if entry not in (b"mp4a", b"alac") or len(body) < 28:
                continue
            channels, bits = struct.unpack(">HH", body[16:20])
            rate = int.from_bytes(body[24:26], "big")
            technical = {"codec": "alac" if entry == b"alac" else "aac", "channels": channels, "sample_rate": rate}
            if entry == b"alac":
                technical["bit_depth"] = bits
            return technical
    return {}


def _mp4_path(body: bytes, names: tuple):
    for name in names:
        body = _mp4_child(body, name) if body else None
    return body


def _mp4_atom(file, size, name: bytes):
    """Reads the body of a top level atom, or returns None when the file has none."""
    offset = 0

    while offset + 8 <= size:
        file.seek(offset)
        header = file.read(8)
        if len(header) < 8:
            return None

        length = int.from_bytes(header[:4], "big")
        body = offset + 8
        if length == 1:
            length = int.from_bytes(file.read(8), "big")
            body += 8
        elif length == 0:
            length = size - offset

        if length < 8:
            return None
        if header[4:8] == name:
            return file.read(min(offset + length - body, size - body))  # clamped against a bogus size

        offset += length

    return None


def _mp4_children(body: bytes):
    offset = 0

    while offset + 8 <= len(body):
        length = int.from_bytes(body[offset:offset + 4], "big")
        start = offset + 8
        if length == 1:
            length = int.from_bytes(body[start:start + 8], "big")
            start += 8
        elif length == 0:
            length = len(body) - offset

        if length < 8:
            return

        yield body[offset + 4:offset + 8], body[start:offset + length]
        offset += length


def _mp4_child(body: bytes, name: bytes):
    for child, payload in _mp4_children(body):
        if child == name:
            return payload

    return None


def _mp4_ilst(moov: bytes):
    udta = _mp4_child(moov, b"udta")
    meta = _mp4_child(udta, b"meta") if udta else None
    if meta is None:
        return None

    return _mp4_child(meta[4:], b"ilst")  # meta keeps a version and flags field before its children


def _mp4_duration(moov: bytes):
    mvhd = _mp4_child(moov, b"mvhd")
    if not mvhd:
        return None

    if mvhd[0] == 1:  # the creation and modification times are 64 bit in this version
        timescale = int.from_bytes(mvhd[20:24], "big")
        duration = int.from_bytes(mvhd[24:32], "big")
    else:
        timescale = int.from_bytes(mvhd[12:16], "big")
        duration = int.from_bytes(mvhd[16:20], "big")

    return duration / timescale if timescale and duration else None


def _mp4_tags(ilst: bytes) -> dict:
    tags = {}

    for name, body in _mp4_children(ilst):
        if name == b"----":
            freeform = _guard(_mp4_freeform, body)
            if freeform:
                key = MP4_FREEFORM.get(freeform[0].lower())
                if key:
                    _put(tags, key, _typed(key, freeform[1]))
            continue

        key = MP4_TAGS.get(name)
        if key is None:
            continue

        kind, payload = _mp4_data(body)
        if payload is None:
            continue

        if key in ("track", "disc"):
            _put(tags, key, int.from_bytes(payload[2:4], "big") if len(payload) >= 4 else None)
            if len(payload) >= 6:
                _put(tags, f"{key}_total", int.from_bytes(payload[4:6], "big") or None)
        elif key == "compilation":
            _put(tags, key, payload[:1] == b"\x01")
        elif name == b"gnre":
            index = int.from_bytes(payload, "big") - 1  # gnre indexes the genre list from one
            _put(tags, key, GENRES[index] if 0 <= index < len(GENRES) else None)
        elif kind == 1:
            _put(tags, key, _typed(key, _text(payload.decode("utf-8", "replace"))))

    return tags


def _mp4_freeform(body: bytes):
    name = _mp4_child(body, b"name")
    _, payload = _mp4_data(body)
    if name is None or payload is None:
        return None
    return name[4:].decode("utf-8", "replace"), _text(payload.decode("utf-8", "replace"))


def _mp4_data(body: bytes) -> tuple:
    for name, payload in _mp4_children(body):
        if name == b"data" and len(payload) >= 8:
            return int.from_bytes(payload[:4], "big"), payload[8:]

    return None, None


def _mp4_artwork(ilst: bytes):
    for name, body in _mp4_children(ilst):
        if name != b"covr":
            continue

        kind, payload = _mp4_data(body)
        if payload:
            return payload, MP4_IMAGE_TYPES.get(kind) or _image_type(None, payload)

    return None


# ---------- shared ----------


def _guard(reader, *arguments):
    """Runs one parser, so a malformed block can only cost the part it holds."""
    try:
        return reader(*arguments)
    except Exception:
        return None


def _put(tags: dict, key: str, value):
    if value is not None and tags.get(key) is None:
        tags[key] = value


def _append(tags: dict, key: str, value):
    if value and value not in tags.setdefault(key, []) and len(tags[key]) < 32:
        tags[key].append(value[:300])


def _typed(key: str, text):
    if text is None:
        return None
    if isinstance(text, bool):
        return text
    if key in ("track", "disc", "track_total", "disc_total"):
        return _number(text)
    if key == "year":
        return _year(text)
    if key in ("rg_track_gain", "rg_album_gain", "rg_track_peak", "rg_album_peak"):
        return _decibels(text)
    if key == "compilation":
        return str(text).strip().lower() in ("1", "true", "yes")
    if key == "date":
        return str(text).strip()[:10] or None
    if key == "lyrics":
        return str(text).strip()[:200_000] or None

    return str(text).strip()[:1000] or None


def _decibels(text):
    try:
        return round(float(str(text).lower().replace("db", "").strip()), 2)
    except ValueError:
        return None


def _size_of(path) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _text(value):
    text = str(value).replace("\x00", "").strip()
    return text or None


def _latin(raw: bytes):
    return _text(raw.decode("latin-1", "replace"))


def _number(text):
    counted = str(text).split("/")[0].strip()  # track numbers are often written as "3/12"
    return int(counted) if counted.isdigit() else None


def _year(text):
    if text is None:
        return None

    digits = str(text).strip()[:4]
    return int(digits) if digits.isdigit() else None


def _syncsafe(raw: bytes) -> int:
    """Reads a size that spends only seven bits per byte, so it cannot look like a frame sync."""
    value = 0
    for byte in raw:
        value = (value << 7) | (byte & 0x7F)

    return value


def _image_type(mime, data: bytes) -> str:
    name = (mime or "").strip().lower()

    if "png" in name:
        return "image/png"
    if "jpg" in name or "jpeg" in name:
        return "image/jpeg"
    if "gif" in name:
        return "image/gif"
    if name.startswith("image/"):
        return name
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"

    return "application/octet-stream"


def _extension(path) -> str:
    name = str(path).lower()
    dot = name.rfind(".")

    return name[dot:] if dot >= 0 else ""


def _size(file) -> int:
    position = file.tell()
    file.seek(0, 2)
    size = file.tell()
    file.seek(position)

    return size
