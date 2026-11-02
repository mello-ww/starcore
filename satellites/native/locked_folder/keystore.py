"""The server key: what lets StarCore open the vault key without the owner's
recovery key, so photos can be shown after a PIN or biometric unlock.

It is 32 random bytes kept in StarCore's application-data directory (next to
pin.json), never inside the vault folder - so a copy of the vault folder,
or of the drive it's on, holds nothing that opens it.

How it is protected at rest depends on the platform:

- Windows: DPAPI (CryptProtectData, current-user scope). The file is useless
  without the Windows account that wrote it: a stolen disk or a backup needs
  that account's password as well. A Windows password *reset* by an
  administrator (not an ordinary change), a new user profile or a reinstall
  makes it unreadable - which is what the recovery key is for.
- Elsewhere: a plain file readable only by StarCore's own account (0600).
  Anyone who can read it - root, a backup of the data directory, a stolen
  disk that holds both - can open the vault. Keep the data directory on an
  encrypted volume for disk-level protection.

Nobody who can run code as StarCore's account is kept out by either: that
is a full server compromise, which server-side encryption can't defend
against. See docs/satellites/locked_folder.md, "Threat model".
"""

from pathlib import Path
import os
import secrets
import stat
import sys

KEY_SIZE = 32
DPAPI_ENTROPY = b"StarCore Locked Folder server key v1"

BACKEND = "dpapi" if sys.platform == "win32" else "file"


class KeyUnavailable(Exception):
    """The server key exists but can't be read or opened here."""


def key_path(storage_root: Path, backend: str = None) -> Path:
    backend = backend or BACKEND
    return Path(storage_root) / ("vault-key.dpapi" if backend == "dpapi" else "vault-key")


def exists(storage_root: Path) -> bool:
    return key_path(storage_root).exists()


def load(storage_root: Path, create: bool = False) -> bytes:
    """The server key, created first when `create` is set and there is none.
    Raises KeyUnavailable when it can't be read (or there is none to read)."""
    path = key_path(storage_root)
    if not path.exists():
        if not create:
            raise KeyUnavailable("there is no server key on this server")
        return _create(path)
    try:
        stored = path.read_bytes()
    except OSError as error:
        raise KeyUnavailable(f"the server key could not be read ({type(error).__name__})") from None
    if BACKEND == "dpapi":
        key = _dpapi_unprotect(stored)
    else:
        _warn_if_exposed(path)
        key = stored
    if len(key) != KEY_SIZE:
        raise KeyUnavailable("the server key is damaged")
    return key


def _create(path: Path) -> bytes:
    key = secrets.token_bytes(KEY_SIZE)
    stored = _dpapi_protect(key) if BACKEND == "dpapi" else key
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError:
        return load(path.parent)  # created by someone else just now: use theirs
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(stored)
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return key


def _warn_if_exposed(path: Path):
    try:
        mode = path.stat().st_mode
    except OSError:
        return
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        print(f"[WARNING]: the Locked Folder server key {path} can be read by other accounts. "
              f"Restrict it to StarCore's own account (chmod 600).")


# ---------- DPAPI (Windows) ----------

def _dpapi():
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    signature = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.POINTER(Blob), ctypes.c_void_p,
                 ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt32.CryptProtectData.argtypes = signature
    crypt32.CryptProtectData.restype = wintypes.BOOL
    unprotect = [ctypes.POINTER(Blob), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(Blob), ctypes.c_void_p,
                 ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt32.CryptUnprotectData.argtypes = unprotect
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return ctypes, Blob, crypt32, kernel32


CRYPTPROTECT_UI_FORBIDDEN = 0x1


def _blob(ctypes, Blob, data: bytes):
    buffer = ctypes.create_string_buffer(data, len(data))
    return Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer


def _dpapi_call(data: bytes, protect: bool) -> bytes:
    ctypes, Blob, crypt32, kernel32 = _dpapi()
    source, _keep = _blob(ctypes, Blob, data)
    entropy, _keep_entropy = _blob(ctypes, Blob, DPAPI_ENTROPY)
    result = Blob()
    if protect:
        ok = crypt32.CryptProtectData(ctypes.byref(source), "StarCore Locked Folder", ctypes.byref(entropy),
                                      None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(result))
    else:
        ok = crypt32.CryptUnprotectData(ctypes.byref(source), None, ctypes.byref(entropy),
                                        None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(result))
    if not ok:
        code = ctypes.get_last_error()
        raise KeyUnavailable(f"Windows could not {'protect' if protect else 'open'} the server key "
                             f"(error {code}) - it may belong to another Windows account")
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(result.pbData, ctypes.c_void_p))


def _dpapi_protect(data: bytes) -> bytes:
    return _dpapi_call(data, protect=True)


def _dpapi_unprotect(data: bytes) -> bytes:
    return _dpapi_call(data, protect=False)
