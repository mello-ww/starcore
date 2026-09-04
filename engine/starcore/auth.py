"""Server-side authentication for StarCore.

Deliberately small: one admin-capable user to start (see docs/mission_control.md
for the reasoning), stdlib-only password hashing and session tokens, and a
single flat JSON store - no ORM, no database dependency, matching the same
"avoid unnecessary dependencies" precedent the rest of the engine follows.

Nothing here assumes a browser. A session token works identically whether
it arrives as a cookie (the web UI) or an `Authorization: Bearer` header (a
future API/mobile client) - see AuthStore.token_from_request() and
docs/api.md.
"""

from pathlib import Path
import hashlib
import json
import os
import secrets
import time

PBKDF2_ITERATIONS = 260_000
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60  # a week - long enough that a browser
                                          # session cookie doesn't force a
                                          # daily re-login, short enough that
                                          # a stale token doesn't live forever
SESSION_COOKIE = "starcore_session"


class AuthError(Exception):
    """Raised for a request auth cannot honestly satisfy (bad credentials,
    already bootstrapped, no such session). Never raised for "works as
    designed" cases like a first-time, not-yet-bootstrapped store."""


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS).hex()


class AuthStore:
    """Owns the on-disk credential/session file and all password/session logic.

    One JSON file, written atomically (temp file + os.replace) so a crash
    mid-write can never leave a half-written, unreadable store. Holds
    everything in memory between writes; every mutating call persists
    immediately since a login/logout is rare enough that this is never a
    meaningful cost.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self._data = self._load()

    def _load(self) -> dict:
        if not self.path.exists():
            return {"user": None, "sessions": {}}

        try:
            with open(self.path, "r", encoding="utf-8") as file:
                data = json.load(file)
        except (json.JSONDecodeError, OSError) as error:
            print(f"[WARNING]: auth store {self.path} is unreadable ({error}). "
                  f"Starting with no user and no sessions - a fresh setup will be required.")
            return {"user": None, "sessions": {}}

        if not isinstance(data, dict):
            return {"user": None, "sessions": {}}
        data.setdefault("user", None)
        data.setdefault("sessions", {})
        return data

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as file:
            json.dump(self._data, file)
        os.replace(tmp_path, self.path)

    @property
    def is_bootstrapped(self) -> bool:
        return self._data["user"] is not None

    def bootstrap(self, username: str, password: str) -> str:
        """Creates the first (and, for now, only) user. Returns a fresh session
        token, the same way login() does, so setup doubles as a first login.

        Raises AuthError if a user already exists - bootstrap is a one-time
        event, never a way to reset an existing password.
        """
        if self.is_bootstrapped:
            raise AuthError("StarCore already has an administrator account")
        if not username or not username.strip():
            raise AuthError("username must not be empty")
        if not password or len(password) < 8:
            raise AuthError("password must be at least 8 characters")

        salt = secrets.token_bytes(16)
        self._data["user"] = {
            "username": username.strip(),
            "salt": salt.hex(),
            "password_hash": _hash_password(password, salt),
        }
        self._save()
        return self.create_session(username.strip())

    def verify(self, username: str, password: str) -> bool:
        user = self._data["user"]
        if user is None or username != user["username"]:
            # still hashes something even on an unknown username, so a caller
            # timing the response can't use it to discover valid usernames
            _hash_password(password, secrets.token_bytes(16))
            return False

        salt = bytes.fromhex(user["salt"])
        # constant-time comparison - a plain == leaks how many leading bytes
        # matched through response timing
        return secrets.compare_digest(_hash_password(password, salt), user["password_hash"])

    def login(self, username: str, password: str) -> str:
        if not self.verify(username, password):
            raise AuthError("invalid username or password")
        return self.create_session(username)

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(32)
        self._data["sessions"][token] = {"username": username, "expires": time.time() + SESSION_TTL_SECONDS}
        self._save()
        return token

    def validate_session(self, token: str) -> bool:
        if not token:
            return False
        session = self._data["sessions"].get(token)
        if session is None:
            return False
        if session["expires"] < time.time():
            # expired - drop it now rather than waiting for a sweep, so a
            # stolen-then-expired token can never be revived by re-adding it
            del self._data["sessions"][token]
            self._save()
            return False
        return True

    def logout(self, token: str):
        if token and self._data["sessions"].pop(token, None) is not None:
            self._save()

    def purge_expired_sessions(self):
        now = time.time()
        expired = [token for token, session in self._data["sessions"].items() if session["expires"] < now]
        for token in expired:
            del self._data["sessions"][token]
        if expired:
            self._save()

    @staticmethod
    def token_from_request(cookie_header: str, authorization_header: str) -> str:
        """Pulls a session token from whichever of the two a client sent -
        the cookie (the web UI) or a Bearer header (a future API/mobile
        client, or any other non-browser caller) - so validate_session()
        never needs to know or care which kind of client this is.
        """
        if authorization_header:
            scheme, _, value = authorization_header.partition(" ")
            if scheme.lower() == "bearer" and value:
                return value.strip()

        for part in (cookie_header or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == SESSION_COOKIE:
                return value.strip()

        return ""
