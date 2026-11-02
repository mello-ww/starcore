"""Encryption at rest for the Locked Folder - the file format and key handling.

Nothing here is a new cipher or mode. Everything is AES-256-GCM and
HKDF-SHA256 from the `cryptography` package (pyca/cryptography, OpenSSL),
put together the way Google Tink's "AES-GCM-HKDF streaming" AEAD does:

    file key   = HKDF-SHA256(vault key, salt = 32 random bytes per file,
                             info = "starcore-locked-folder/v1/file|" + vault id)
    segment i  = AES-256-GCM(file key, nonce = prefix(7) || i(4) || last(1),
                             aad = header)

so a large video is encrypted and decrypted one 1 MiB segment at a time,
any byte range can be read by decrypting only the segments it touches, and a
segment that was changed, swapped, reordered, dropped or cut short fails its
authentication tag before a single byte of it is used. Every file has its own
random salt, so its own key: nonces never repeat across files, and the
per-file segment counter never repeats within one.

File layout (format version 1):

    header    "SCLF" | version (1) | flags (1) | segment size (u32) |
              salt (32) | nonce prefix (7)                   - 49 bytes
    segments  each AES-GCM(segment) - segment size + 16 bytes, the last one
              shorter (and only ever empty for an empty file)
    metadata  AES-GCM(JSON: name, folder, size, sha256, modified, ...)
              with nonce prefix || ffffffff || 02 and
              aad = header || segment count (u64) || "meta"
    length    u32 length of the metadata block

Metadata sits at the end because an upload's SHA-256 and size are only known
once all of it has arrived. Its additional data includes the segment count,
so a file with segments cut off (or added) fails before anything is read.

The vault key itself is random (32 bytes from secrets) and never derived
from the PIN. It is stored only wrapped (AES-256-GCM) by a server key (see
keystore.py) and, optionally, by a key derived from the owner's recovery key
(see keys.py).
"""

import base64
import hashlib
import hmac
import json
import secrets
import struct

try:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    IMPORT_ERROR = None
except ImportError as error:  # the optional "encryption" extra isn't installed
    AESGCM = HKDF = hashes = None
    IMPORT_ERROR = error

    class InvalidTag(Exception):
        pass


MAGIC = b"SCLF"
VERSION = 1
KEY_SIZE = 32
SALT_SIZE = 32
PREFIX_SIZE = 7
TAG_SIZE = 16
SEGMENT_SIZE = 1024 * 1024
MIN_SEGMENT, MAX_SEGMENT = 4096, 16 * 1024 * 1024
MAX_METADATA = 64 * 1024
MAX_SEGMENTS = 0xFFFFFFFF  # the counter is 32 bits, and ffffffff is kept for the metadata nonce

_HEADER = struct.Struct(">4sBBI32s7s")
HEADER_SIZE = _HEADER.size
_LENGTH = struct.Struct(">I")
_COUNT = struct.Struct(">Q")

RECOVERY_BYTES = 32


def available() -> bool:
    return IMPORT_ERROR is None


class CorruptFile(Exception):
    """An encrypted file (or keyring entry) that is damaged, was tampered
    with, or belongs to another vault. Nothing of its plaintext is released."""


class WrongKey(Exception):
    """A wrapped key didn't open with the key that was tried."""


def _hkdf(key: bytes, salt: bytes, info: bytes, length: int = KEY_SIZE) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(key)


def new_key() -> bytes:
    return secrets.token_bytes(KEY_SIZE)


def _file_key(vault_key: bytes, vault_id: bytes, salt: bytes) -> bytes:
    return _hkdf(vault_key, salt, b"starcore-locked-folder/v1/file|" + vault_id)


def _segment_nonce(prefix: bytes, index: int, last: bool) -> bytes:
    return prefix + index.to_bytes(4, "big") + (b"\x01" if last else b"\x00")


def _metadata_nonce(prefix: bytes) -> bytes:
    return prefix + b"\xff\xff\xff\xff\x02"


def _metadata_aad(header: bytes, segments: int) -> bytes:
    return header + _COUNT.pack(segments) + b"meta"


def segment_count(region: int, segment_size: int) -> int:
    """How many segments a segment region of `region` bytes holds - every
    segment but the last is full, and the last holds at least one byte unless
    the whole file is empty."""
    if region < TAG_SIZE:
        raise CorruptFile("the file is too short")
    return max(1, (region - TAG_SIZE - 1) // (segment_size + TAG_SIZE) + 1)


# ---------- writing ----------

class Encryptor:
    """Encrypts a stream into an open binary file, segment by segment.

        with open(partial, "xb") as out:
            writer = Encryptor(out, vault_key, vault_id)
            for chunk in source:
                writer.write(chunk)
            metadata = writer.finish({"name": ..., "folder": ...})

    Only one segment of plaintext is ever held in memory. finish() adds the
    size and SHA-256 of everything written to the metadata."""

    def __init__(self, out, vault_key: bytes, vault_id: bytes, segment_size: int = SEGMENT_SIZE):
        if not MIN_SEGMENT <= segment_size <= MAX_SEGMENT:
            raise ValueError("unsupported segment size")
        salt = secrets.token_bytes(SALT_SIZE)
        self._prefix = secrets.token_bytes(PREFIX_SIZE)
        self.header = _HEADER.pack(MAGIC, VERSION, 0, segment_size, salt, self._prefix)
        self._aead = AESGCM(_file_key(vault_key, vault_id, salt))
        self._out = out
        self._segment_size = segment_size
        self._buffer = bytearray()
        self._index = 0
        self._hash = hashlib.sha256()
        self.size = 0
        self._finished = False
        out.write(self.header)

    def write(self, data: bytes):
        if self._finished:
            raise ValueError("already finished")
        self._hash.update(data)
        self.size += len(data)
        self._buffer += data
        # a full segment is held back until more data arrives, because only
        # then is it known not to be the last one
        while len(self._buffer) > self._segment_size:
            self._seal(bytes(self._buffer[:self._segment_size]), last=False)
            del self._buffer[:self._segment_size]

    def _seal(self, plaintext: bytes, last: bool):
        if self._index >= MAX_SEGMENTS:
            raise ValueError("the file is too large")
        nonce = _segment_nonce(self._prefix, self._index, last)
        self._out.write(self._aead.encrypt(nonce, plaintext, self.header))
        self._index += 1

    def finish(self, metadata: dict) -> dict:
        self._seal(bytes(self._buffer), last=True)
        self._buffer = bytearray()
        self._finished = True
        complete = dict(metadata, size=self.size, sha256=self._hash.hexdigest())
        blob = json.dumps(complete, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(blob) > MAX_METADATA:
            raise ValueError("the file's details are too long")
        sealed = self._aead.encrypt(_metadata_nonce(self._prefix), blob, _metadata_aad(self.header, self._index))
        self._out.write(sealed)
        self._out.write(_LENGTH.pack(len(sealed)))
        return complete


# ---------- reading ----------

class EncryptedFile:
    """An encrypted vault file opened for reading. Opening it checks the
    header and authenticates the metadata; segments are authenticated as
    they are read. Raises CorruptFile for anything that doesn't check out."""

    def __init__(self, path, vault_key: bytes, vault_id: bytes):
        self._file = open(path, "rb")
        try:
            self._open(vault_key, vault_id)
        except BaseException:
            self._file.close()
            raise

    def _open(self, vault_key: bytes, vault_id: bytes):
        file = self._file
        total = file.seek(0, 2)
        if total < HEADER_SIZE + TAG_SIZE + TAG_SIZE + _LENGTH.size:
            raise CorruptFile("the file is too short")
        file.seek(0)
        self.header = file.read(HEADER_SIZE)
        magic, version, flags, segment_size, salt, prefix = _HEADER.unpack(self.header)
        if magic != MAGIC:
            raise CorruptFile("not a Locked Folder file")
        if version != VERSION or flags != 0:
            raise CorruptFile("an unsupported Locked Folder file version")
        if not MIN_SEGMENT <= segment_size <= MAX_SEGMENT:
            raise CorruptFile("an invalid segment size")

        file.seek(total - _LENGTH.size)
        (meta_length,) = _LENGTH.unpack(file.read(_LENGTH.size))
        if not TAG_SIZE < meta_length <= MAX_METADATA + TAG_SIZE:
            raise CorruptFile("invalid metadata")
        region = total - HEADER_SIZE - meta_length - _LENGTH.size
        segments = segment_count(region, segment_size)
        last_length = region - (segments - 1) * (segment_size + TAG_SIZE) - TAG_SIZE
        if not 0 <= last_length <= segment_size or (segments > 1 and last_length == 0):
            raise CorruptFile("the file has been cut short or extended")

        self._aead = AESGCM(_file_key(vault_key, vault_id, salt))
        self._prefix = prefix
        self._segment_size = segment_size
        self._segments = segments
        file.seek(HEADER_SIZE + region)
        sealed = file.read(meta_length)
        try:
            blob = self._aead.decrypt(_metadata_nonce(prefix), sealed, _metadata_aad(self.header, segments))
            metadata = json.loads(blob.decode("utf-8"))
        except (InvalidTag, ValueError, UnicodeDecodeError):
            raise CorruptFile("the file is damaged or belongs to another vault") from None
        if not isinstance(metadata, dict):
            raise CorruptFile("invalid metadata")
        self.size = region - segments * TAG_SIZE
        if metadata.get("size") != self.size:
            raise CorruptFile("the file's size doesn't match its details")
        self.metadata = metadata

    def _segment(self, index: int) -> bytes:
        last = index == self._segments - 1
        stride = self._segment_size + TAG_SIZE
        length = self.size - (self._segments - 1) * self._segment_size + TAG_SIZE if last else stride
        self._file.seek(HEADER_SIZE + index * stride)
        sealed = self._file.read(length)
        if len(sealed) != length:
            raise CorruptFile("the file has been cut short")
        try:
            return self._aead.decrypt(_segment_nonce(self._prefix, index, last), sealed, self.header)
        except InvalidTag:
            raise CorruptFile("the file is damaged") from None

    def read_range(self, start: int, end: int):
        """Yields the plaintext bytes start..end (inclusive), decrypting only
        the segments they fall in."""
        if self.size == 0:
            self._segment(0)  # still authenticated, even with nothing to give
            return
        if start < 0 or end >= self.size or start > end:
            raise ValueError("range outside the file")
        first, last = start // self._segment_size, end // self._segment_size
        for index in range(first, last + 1):
            plaintext = self._segment(index)
            base = index * self._segment_size
            yield plaintext[max(start - base, 0):end - base + 1]

    def chunks(self):
        """Yields the whole plaintext, segment by segment."""
        if self.size == 0:
            self._segment(0)
            return
        yield from self.read_range(0, self.size - 1)

    def verify(self) -> str:
        """Authenticates every segment and checks the SHA-256 recorded at
        encryption time. Returns that digest; raises CorruptFile."""
        hasher = hashlib.sha256()
        for chunk in self.chunks():
            hasher.update(chunk)
        digest = hasher.hexdigest()
        if not hmac.compare_digest(digest, str(self.metadata.get("sha256", ""))):
            raise CorruptFile("the file's contents don't match its checksum")
        return digest

    def close(self):
        self._file.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ---------- wrapped keys ----------

def wrap(kek: bytes, key: bytes, label: bytes) -> dict:
    nonce = secrets.token_bytes(12)
    sealed = AESGCM(kek).encrypt(nonce, key, b"starcore-locked-folder/v1/slot|" + label)
    return {"nonce": base64.b64encode(nonce).decode("ascii"), "key": base64.b64encode(sealed).decode("ascii")}


def unwrap(kek: bytes, slot: dict, label: bytes) -> bytes:
    try:
        nonce = base64.b64decode(slot["nonce"], validate=True)
        sealed = base64.b64decode(slot["key"], validate=True)
    except (KeyError, TypeError, ValueError):
        raise CorruptFile("a damaged key slot") from None
    try:
        key = AESGCM(kek).decrypt(nonce, sealed, b"starcore-locked-folder/v1/slot|" + label)
    except InvalidTag:
        raise WrongKey("the key slot did not open") from None
    except ValueError:
        raise CorruptFile("a damaged key slot") from None
    if len(key) != KEY_SIZE:
        raise CorruptFile("a damaged key slot")
    return key


# ---------- the recovery key ----------
#
# 32 random bytes, shown once as 52 base32 characters in groups of four. With
# 256 bits of entropy it needs no slow key derivation: HKDF turns it (and a
# random per-slot salt) into the key that wraps the vault key.

def new_recovery_key():
    """(secret bytes, the text to show the owner)."""
    secret = secrets.token_bytes(RECOVERY_BYTES)
    text = base64.b32encode(secret).decode("ascii").rstrip("=")
    return secret, "-".join(text[i:i + 4] for i in range(0, len(text), 4))


def parse_recovery_key(text) -> bytes:
    if not isinstance(text, str) or len(text) > 200:
        raise ValueError("not a recovery key")
    compact = "".join(character for character in text.upper() if character.isalnum())
    compact = compact.replace("0", "O").replace("1", "I").replace("8", "B")  # look-alikes
    try:
        secret = base64.b32decode(compact + "=" * (-len(compact) % 8))
    except (ValueError, TypeError):
        raise ValueError("not a recovery key") from None
    if len(secret) != RECOVERY_BYTES:
        raise ValueError("not a recovery key")
    return secret


def recovery_kek(secret: bytes, salt: bytes) -> bytes:
    return _hkdf(secret, salt, b"starcore-locked-folder/v1/recovery")


# ---------- bindings ----------

def binding(vault_key: bytes, vault_id: bytes, label: str, payload) -> str:
    """A MAC that ties security state (the PIN record, the device list) to
    this vault: only someone holding the vault key can produce it."""
    key = _hkdf(vault_key, b"", b"starcore-locked-folder/v1/binding|" + vault_id)
    message = label.encode("utf-8") + b"|" + json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hmac.new(key, message, hashlib.sha256).hexdigest()
