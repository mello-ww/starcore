"""The vault's keyring: its random vault key, stored only wrapped.

    <vault>/.starcore-vault/keyring.json
    {
      "format": "starcore-locked-folder-keyring", "version": 1,
      "vault_id": "<16 random bytes, hex>",
      "slots": {
        "server":   {"nonce", "key"},           # wrapped by the server key (keystore.py)
        "recovery": {"salt", "nonce", "key"}    # optional - wrapped by the owner's recovery key
      }
    }

It lives inside the vault, so a backup of the vault folder carries it - and
with the recovery key, that backup can be opened on another server. Neither
slot opens without its key, so the file itself gives nothing away. A copy is
also kept in StarCore's data directory (keyrings/<vault id>.json); if the one
in the vault is damaged or deleted, it is restored from there.

Without this file (both copies) the vault key is gone, and so is every
encrypted file - there is no other copy of the key anywhere, by design.
"""

from datetime import datetime, timezone
from pathlib import Path
import json
import os
import secrets

from . import crypto

META_DIR = ".starcore-vault"
KEYRING = "keyring.json"
OBJECTS = "objects"
OBJECT_SUFFIX = ".sclf"
FORMAT = "starcore-locked-folder-keyring"
VERSION = 1


class KeyProblem(Exception):
    """The vault is encrypted but can't be opened right now.

    code: encryption_unavailable - the `cryptography` package isn't installed
          key_unavailable        - this server's key doesn't open it (lost,
                                   another server, another Windows account)
          keyring_damaged        - the keyring is missing or unreadable"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def primary_path(root: Path) -> Path:
    return Path(root) / META_DIR / KEYRING


def mirror_dir(storage_root: Path) -> Path:
    return Path(storage_root) / "keyrings"


def has_objects(root: Path) -> bool:
    try:
        with os.scandir(Path(root) / META_DIR / OBJECTS) as entries:
            return any(entry.name.endswith(OBJECT_SUFFIX) for entry in entries)
    except OSError:
        return False


def is_encrypted(root) -> bool:
    """Cheap: whether this vault has (or had) a keyring - true even when the
    key can't be opened, and when the keyring itself went missing while
    encrypted files remain."""
    if root is None:
        return False
    return primary_path(root).exists() or has_objects(root)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Keyring:
    def __init__(self, data: dict, root: Path, storage_root: Path):
        self.data = data
        self.root = Path(root)
        self.storage_root = Path(storage_root)
        self.vault_id = bytes.fromhex(data["vault_id"])

    # ---------- loading and saving ----------

    @staticmethod
    def _parse(raw: bytes) -> dict:
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict) or data.get("format") != FORMAT or data.get("version") != VERSION:
            raise ValueError("not a keyring")
        vault_id = data.get("vault_id")
        if not isinstance(vault_id, str) or len(bytes.fromhex(vault_id)) != 16:
            raise ValueError("bad vault id")
        slots = data.get("slots")
        if not isinstance(slots, dict) or not isinstance(slots.get("server"), dict):
            raise ValueError("no server slot")
        if "recovery" in slots and not isinstance(slots["recovery"], dict):
            raise ValueError("bad recovery slot")
        return data

    @classmethod
    def load(cls, root: Path, storage_root: Path):
        """The vault's keyring, None for a vault that was never encrypted.
        Raises KeyProblem("keyring_damaged") when it should exist but can't
        be read from either copy."""
        root = Path(root)
        primary = primary_path(root)
        try:
            data = cls._parse(primary.read_bytes())
            return cls(data, root, storage_root)
        except FileNotFoundError:
            if not has_objects(root):
                return None
        except (OSError, ValueError, UnicodeDecodeError):
            pass

        mirrored = cls._from_mirror(root, storage_root)
        if mirrored is None:
            raise KeyProblem("keyring_damaged", "the vault's keyring is missing or damaged")
        print("[WARNING]: the Locked Folder keyring in the vault was missing or damaged; "
              "restored it from StarCore's own copy.")
        try:
            mirrored._write(primary, durable=True)
        except OSError:
            pass  # still usable from the copy
        return mirrored

    @classmethod
    def _from_mirror(cls, root: Path, storage_root: Path):
        directory = mirror_dir(storage_root)
        try:
            candidates = sorted(directory.glob("*.json"))
        except OSError:
            return None
        found = []
        for path in candidates:
            try:
                data = cls._parse(path.read_bytes())
            except (OSError, ValueError, UnicodeDecodeError):
                continue
            if data.get("root") == str(Path(root).resolve()):
                found.append(data)
        # more than one candidate for the same folder can't be told apart safely
        return cls(found[0], root, storage_root) if len(found) == 1 else None

    def save(self):
        """Writes the keyring into the vault (flushed to disk) and its copy
        into the data directory."""
        self._write(primary_path(self.root), durable=True)
        mirror = dict(self.data, root=str(self.root.resolve()))
        mirror_dir(self.storage_root).mkdir(parents=True, exist_ok=True)
        self._write(mirror_dir(self.storage_root) / f"{self.data['vault_id']}.json", durable=True, data=mirror)

    def _write(self, path: Path, durable: bool, data: dict = None):
        path.parent.mkdir(parents=True, exist_ok=True)
        # the copy in the vault never records where the vault was
        content = data if data is not None else {key: value for key, value in self.data.items() if key != "root"}
        partial = path.with_name(f".{path.name}.{secrets.token_hex(4)}.part")
        try:
            with open(partial, "w", encoding="utf-8") as file:
                json.dump(content, file, indent=2)
                if durable:
                    file.flush()
                    os.fsync(file.fileno())
            os.replace(partial, path)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise

    def delete(self):
        """Removes both copies - only once no encrypted file needs this key."""
        primary_path(self.root).unlink(missing_ok=True)
        (mirror_dir(self.storage_root) / f"{self.data['vault_id']}.json").unlink(missing_ok=True)

    # ---------- creating ----------

    @classmethod
    def create(cls, root: Path, storage_root: Path, server_key: bytes):
        """A new keyring with a fresh random vault key, not yet saved.
        Returns (keyring, vault key)."""
        vault_key = crypto.new_key()
        data = {
            "format": FORMAT,
            "version": VERSION,
            "vault_id": secrets.token_hex(16),
            "created": _now(),
            "cipher": "AES-256-GCM, HKDF-SHA256 per-file keys, 1 MiB segments",
            "slots": {},
        }
        keyring = cls(data, root, storage_root)
        keyring.set_server(vault_key, server_key)
        return keyring, vault_key

    # ---------- slots ----------

    def _label(self, slot: str) -> bytes:
        return slot.encode("ascii") + b"|" + self.vault_id

    def open_with_server(self, server_key: bytes) -> bytes:
        return crypto.unwrap(server_key, self.data["slots"]["server"], self._label("server"))

    def set_server(self, vault_key: bytes, server_key: bytes):
        slot = crypto.wrap(server_key, vault_key, self._label("server"))
        slot["created"] = _now()
        self.data["slots"]["server"] = slot

    @property
    def has_recovery(self) -> bool:
        return "recovery" in self.data["slots"]

    def open_with_recovery(self, secret: bytes) -> bytes:
        slot = self.data["slots"].get("recovery")
        if slot is None:
            raise crypto.WrongKey("no recovery key is set up")
        try:
            salt = bytes.fromhex(slot["salt"])
        except (KeyError, TypeError, ValueError):
            raise crypto.CorruptFile("a damaged recovery slot") from None
        return crypto.unwrap(crypto.recovery_kek(secret, salt), slot, self._label("recovery"))

    def set_recovery(self, vault_key: bytes) -> str:
        """Creates (or replaces) the recovery slot. Returns the recovery key
        text - the only time it exists anywhere outside the owner's hands."""
        secret, text = crypto.new_recovery_key()
        salt = secrets.token_bytes(16)
        slot = crypto.wrap(crypto.recovery_kek(secret, salt), vault_key, self._label("recovery"))
        slot["salt"] = salt.hex()
        slot["created"] = _now()
        self.data["slots"]["recovery"] = slot
        return text

    def remove_recovery(self):
        self.data["slots"].pop("recovery", None)
