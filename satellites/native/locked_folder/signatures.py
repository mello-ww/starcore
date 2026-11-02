"""RSA signature verification for biometric unlock, standard library only.

A phone's Keystore key signs with "SHA256withRSA" (RSASSA-PKCS1-v1_5 with
SHA-256) and hands over its public key as X.509 SubjectPublicKeyInfo DER.
Verification here rebuilds the one valid encoding of the expected digest and
compares it byte for byte with what the signature decrypts to, instead of
parsing the decrypted block - the approach RFC 8017 section 8.2.2
recommends, which avoids the classic padding-parsing forgeries.

Only verification lives here: StarCore never holds a private key.
"""

import hashlib
import hmac

RSA_ENCRYPTION_OID = bytes.fromhex("2a864886f70d010101")  # 1.2.840.113549.1.1.1
# DER DigestInfo prefix for SHA-256 (RFC 8017, section 9.2, note 1)
SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")
MIN_MODULUS_BITS = 2048
MAX_MODULUS_BITS = 8192


class PublicKey:
    def __init__(self, modulus: int, exponent: int):
        self.modulus = modulus
        self.exponent = exponent

    @property
    def size_bytes(self) -> int:
        return (self.modulus.bit_length() + 7) // 8


def parse_public_key(der: bytes) -> PublicKey:
    """An RSA public key from SubjectPublicKeyInfo DER. Raises ValueError for
    anything else, or for a key too weak to accept."""
    if not isinstance(der, (bytes, bytearray)) or not der:
        raise ValueError("the public key is empty")
    reader = _Der(bytes(der))
    spki = reader.read(0x30)
    reader.done()

    algorithm = spki.read(0x30)
    if algorithm.read(0x06).data != RSA_ENCRYPTION_OID:
        raise ValueError("the public key is not an RSA key")
    if algorithm.remaining:
        algorithm.read(0x05)  # NULL parameters
    algorithm.done()

    bits = spki.read(0x03).data
    spki.done()
    if not bits or bits[0] != 0:
        raise ValueError("the public key is malformed")

    rsa = _Der(bits[1:])
    numbers = rsa.read(0x30)
    rsa.done()
    modulus = numbers.read_integer()
    exponent = numbers.read_integer()
    numbers.done()

    if not MIN_MODULUS_BITS <= modulus.bit_length() <= MAX_MODULUS_BITS:
        raise ValueError(f"the public key must be {MIN_MODULUS_BITS} to {MAX_MODULUS_BITS} bits")
    if exponent < 3 or exponent % 2 == 0 or exponent >= modulus:
        raise ValueError("the public key has an invalid exponent")
    return PublicKey(modulus, exponent)


def verify(key: PublicKey, message: bytes, signature: bytes) -> bool:
    """True only for a valid RSASSA-PKCS1-v1_5 / SHA-256 signature of `message`."""
    size = key.size_bytes
    if not isinstance(signature, (bytes, bytearray)) or len(signature) != size:
        return False
    value = int.from_bytes(signature, "big")
    if value >= key.modulus:
        return False

    decrypted = pow(value, key.exponent, key.modulus).to_bytes(size, "big")
    return hmac.compare_digest(decrypted, expected_encoding(message, size))


def expected_encoding(message: bytes, size: int) -> bytes:
    digest_info = SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
    padding = size - len(digest_info) - 3
    if padding < 8:
        raise ValueError("the key is too small for a SHA-256 signature")
    return b"\x00\x01" + b"\xff" * padding + b"\x00" + digest_info


class _Element:
    def __init__(self, tag: int, data: bytes):
        self.tag = tag
        self.data = data


class _Der:
    """Just enough DER for SubjectPublicKeyInfo: definite lengths only,
    strict about trailing bytes and non-minimal encodings."""

    def __init__(self, data: bytes):
        self.data = data
        self.position = 0

    @property
    def remaining(self) -> int:
        return len(self.data) - self.position

    def done(self):
        if self.remaining:
            raise ValueError("the public key has unexpected trailing data")

    def read(self, expected_tag: int):
        if self.remaining < 2:
            raise ValueError("the public key is truncated")
        tag = self.data[self.position]
        if tag != expected_tag:
            raise ValueError("the public key is malformed")
        length = self.data[self.position + 1]
        self.position += 2
        if length & 0x80:
            count = length & 0x7F
            if count == 0 or count > 4 or self.remaining < count:
                raise ValueError("the public key is malformed")
            length = int.from_bytes(self.data[self.position:self.position + count], "big")
            if length < 0x80 or self.data[self.position] == 0:
                raise ValueError("the public key uses a non-minimal length")
            self.position += count
        if self.remaining < length:
            raise ValueError("the public key is truncated")
        content = self.data[self.position:self.position + length]
        self.position += length
        if tag in (0x30,):
            return _Der(content)
        return _Element(tag, content)

    def read_integer(self) -> int:
        element = self.read(0x02)
        data = element.data
        if not data or data[0] & 0x80:
            raise ValueError("the public key has a negative or empty integer")
        if len(data) > 1 and data[0] == 0 and not data[1] & 0x80:
            raise ValueError("the public key uses a non-minimal integer")
        return int.from_bytes(data, "big")
