"""Small but structurally real audio files for the Music tests, built from the format specs."""

import base64
import io
import struct
import wave


def flac(tags: dict = None, seconds=180, sample_rate=44100, bits=16, channels=2, cover=None, artists=()) -> bytes:
    samples = sample_rate * seconds
    packed = (sample_rate << 44) | ((channels - 1) << 41) | ((bits - 1) << 36) | samples
    stream = struct.pack(">HH", 4096, 4096) + b"\x00\x00\x10\x00\x00\x10" + struct.pack(">Q", packed) + b"\x00" * 16
    comments = [f"{key}={value}" for key, value in (tags or {}).items()]
    comments += [f"ARTIST={artist}" for artist in artists]
    vorbis = struct.pack("<I", 6) + b"StarCo" + struct.pack("<I", len(comments))
    for comment in comments:
        encoded = comment.encode("utf-8")
        vorbis += struct.pack("<I", len(encoded)) + encoded
    blocks = _block(0, stream, False) + _block(4, vorbis, cover is None)
    if cover is not None:
        blocks += _block(6, _picture(cover), True)
    return b"fLaC" + blocks


def _block(kind: int, payload: bytes, last: bool) -> bytes:
    return bytes([kind | (0x80 if last else 0)]) + len(payload).to_bytes(3, "big") + payload


def _picture(cover: bytes) -> bytes:
    return (struct.pack(">I", 3) + struct.pack(">I", 9) + b"image/png" + struct.pack(">I", 0)
            + struct.pack(">IIII", 10, 10, 8, 0) + struct.pack(">I", len(cover)) + cover)


def wav(seconds=2, rate=8000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * rate * seconds)
    return buffer.getvalue()


def mp3(frames: dict = None, user: dict = None, lyrics: str = None, count=40) -> bytes:
    body = b""
    for identifier, text in (frames or {}).items():
        payload = b"\x03" + text.encode("utf-8") + b"\x00"
        body += identifier + struct.pack(">I", len(payload)) + b"\x00\x00" + payload
    for description, value in (user or {}).items():
        payload = b"\x03" + description.encode("utf-8") + b"\x00" + value.encode("utf-8")
        body += b"TXXX" + struct.pack(">I", len(payload)) + b"\x00\x00" + payload
    if lyrics is not None:
        payload = b"\x03eng" + b"\x00" + lyrics.encode("utf-8")
        body += b"USLT" + struct.pack(">I", len(payload)) + b"\x00\x00" + payload
    size = len(body)
    syncsafe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
    header = b"\xff\xfb\x90\x00"  # MPEG-1 layer III, 128 kbps, 44.1 kHz, stereo
    return b"ID3\x03\x00\x00" + syncsafe + body + (header + b"\x00" * 413) * count


# ---------- Ogg ----------

def _crc_table():
    table = []
    for index in range(256):
        value = index << 24
        for _ in range(8):
            value = ((value << 1) ^ 0x04C11DB7) if value & 0x80000000 else value << 1
        table.append(value & 0xFFFFFFFF)
    return table


CRC = _crc_table()


def _ogg_page(packet: bytes, sequence: int, granule: int, flags: int, serial=0x5354) -> bytes:
    segments = []
    remaining = len(packet)
    while remaining >= 255:
        segments.append(255)
        remaining -= 255
    segments.append(remaining)
    header = (b"OggS" + bytes([0, flags]) + struct.pack("<qII", granule, serial, sequence) + b"\x00\x00\x00\x00"
              + bytes([len(segments)]) + bytes(segments))
    page = bytearray(header + packet)
    crc = 0
    for byte in page:
        crc = ((crc << 8) ^ CRC[((crc >> 24) & 0xFF) ^ byte]) & 0xFFFFFFFF
    page[22:26] = struct.pack("<I", crc)
    return bytes(page)


def _comment_block(tags: dict, cover: bytes = None) -> bytes:
    comments = [f"{key}={value}" for key, value in tags.items()]
    if cover is not None:
        comments.append("METADATA_BLOCK_PICTURE=" + base64.b64encode(_picture(cover)).decode("ascii"))
    block = struct.pack("<I", 8) + b"StarCore" + struct.pack("<I", len(comments))
    for comment in comments:
        encoded = comment.encode("utf-8")
        block += struct.pack("<I", len(encoded)) + encoded
    return block


def opus(tags: dict = None, seconds=30, channels=2, cover=None) -> bytes:
    head = b"OpusHead" + bytes([1, channels]) + struct.pack("<HIhB", 312, 48000, 0, 0)
    comment = b"OpusTags" + _comment_block(tags or {}, cover)
    audio = b"\xfc" + b"\x00" * 40
    granule = 312 + 48000 * seconds
    return (_ogg_page(head, 0, 0, 0x02) + _ogg_page(comment, 1, 0, 0)
            + _ogg_page(audio, 2, granule, 0x04))


def vorbis(tags: dict = None, seconds=20, rate=44100) -> bytes:
    ident = b"\x01vorbis" + struct.pack("<IBIiii", 0, 2, rate, 0, 160000, 0) + b"\xb8\x01"
    comment = b"\x03vorbis" + _comment_block(tags or {}) + b"\x01"
    return (_ogg_page(ident, 0, 0, 0x02) + _ogg_page(comment, 1, 0, 0)
            + _ogg_page(b"\x00" * 30, 2, rate * seconds, 0x04))


# ---------- MP4 ----------

def _atom(name: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body) + 8) + name + body


def m4a(title="Apple", artist="Orchard", codec=b"alac", seconds=60, rate=48000, bits=24) -> bytes:
    mvhd = _atom(b"mvhd", b"\x00" * 4 + b"\x00" * 8 + struct.pack(">II", 1000, seconds * 1000) + b"\x00" * 80)
    entry = b"\x00" * 6 + struct.pack(">H", 1) + b"\x00" * 8 + struct.pack(">HH", 2, bits) + b"\x00" * 4 \
        + struct.pack(">HH", rate, 0)
    stsd = _atom(b"stsd", b"\x00" * 4 + struct.pack(">I", 1) + _atom(codec, entry))
    trak = _atom(b"trak", _atom(b"mdia", _atom(b"minf", _atom(b"stbl", stsd))))

    def text(name: bytes, value: str) -> bytes:
        return _atom(name, _atom(b"data", struct.pack(">II", 1, 0) + value.encode("utf-8")))

    ilst = _atom(b"ilst", text(b"\xa9nam", title) + text(b"\xa9ART", artist) + text(b"\xa9alb", "Harvest")
                 + _atom(b"trkn", _atom(b"data", struct.pack(">II", 0, 0) + struct.pack(">HHHH", 0, 3, 9, 0))))
    meta = _atom(b"meta", b"\x00" * 4 + ilst)
    moov = _atom(b"moov", mvhd + trak + _atom(b"udta", meta))
    return _atom(b"ftyp", b"M4A \x00\x00\x00\x00M4A mp42isom") + moov + _atom(b"mdat", b"\x00" * 64)


# ---------- decodable audio, for playback checks ----------

def _crc8(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def _crc16(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x8005) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def _utf8_number(value: int) -> bytes:
    if value < 0x80:
        return bytes([value])
    if value < 0x800:
        return bytes([0xC0 | (value >> 6), 0x80 | (value & 0x3F)])
    return bytes([0xE0 | (value >> 12), 0x80 | ((value >> 6) & 0x3F), 0x80 | (value & 0x3F)])


def tone(seconds: float = 3.0, frequency: float = 440.0, rate: int = 44100, amplitude: float = 0.25) -> list:
    import math
    count = int(seconds * rate)
    return [int(amplitude * 32767 * math.sin(2 * math.pi * frequency * index / rate)) for index in range(count)]


def playable_flac(tags: dict = None, seconds: float = 3.0, frequency: float = 440.0, cover=None) -> bytes:
    """A real FLAC stream (VERBATIM subframes, 44.1 kHz, 16-bit mono) any decoder can play."""
    block = 4096
    samples = tone(seconds, frequency)
    samples += [0] * (-len(samples) % block)
    frames = b""
    for number in range(len(samples) // block):
        header = bytes([0xFF, 0xF8, (0b1100 << 4) | 0b1001, (0b0000 << 4) | (0b100 << 1)]) + _utf8_number(number)
        header += bytes([_crc8(header)])
        chunk = samples[number * block:(number + 1) * block]
        body = b"\x02" + struct.pack(f">{block}h", *chunk)
        frame = header + body
        frames += frame + struct.pack(">H", _crc16(frame))
    packed = (44100 << 44) | (0 << 41) | (15 << 36) | len(samples)
    stream = struct.pack(">HH", block, block) + b"\x00" * 6 + struct.pack(">Q", packed) + b"\x00" * 16
    comments = [f"{key}={value}" for key, value in (tags or {}).items()]
    vorbis = struct.pack("<I", 8) + b"StarCore" + struct.pack("<I", len(comments))
    for comment in comments:
        encoded = comment.encode("utf-8")
        vorbis += struct.pack("<I", len(encoded)) + encoded
    blocks = _block(0, stream, False) + _block(4, vorbis, cover is None)
    if cover is not None:
        blocks += _block(6, _picture(cover), True)
    return b"fLaC" + blocks + frames


def playable_wav(seconds: float = 3.0, frequency: float = 330.0) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(44100)
        handle.writeframes(struct.pack(f"<{int(seconds * 44100)}h", *tone(seconds, frequency)))
    return buffer.getvalue()


def write_demo_library(root, cover: bytes = None) -> list:
    """A small tagged library of decodable tones for manual testing of every client."""
    from pathlib import Path
    root = Path(root)
    written = []
    albums = (("Aurora Tones", "Northern Lights", "Ambient", (220, 247, 262, 294)),
              ("Aurora Tones", "Polar Night", "Ambient", (330, 349)),
              ("Signal Choir", "Carrier Waves", "Electronic", (392, 440, 494)))
    for artist, album, genre, notes in albums:
        for index, frequency in enumerate(notes, start=1):
            path = root / artist / album / f"{index:02d} - Tone {frequency} Hz.flac"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(playable_flac({"TITLE": f"Tone {frequency} Hz", "ARTIST": artist, "ALBUM": album,
                                            "ALBUMARTIST": artist, "TRACKNUMBER": str(index), "GENRE": genre,
                                            "DATE": "2026"}, seconds=8, frequency=frequency, cover=cover))
            lrc = path.with_suffix(".lrc")
            lrc.write_text(f"[00:00.50]Tone {frequency} begins\n[00:03.00]<00:03.00>Still <00:04.00>ringing\n"
                           f"[00:06.00]Fading out\n", encoding="utf-8")
            written.append(path)
    return written
