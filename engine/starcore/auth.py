"""Server-side authentication for StarCore.

Deliberately small: one admin-capable user to start (see docs/guide/mission-control.md
for the reasoning), stdlib-only password hashing and session tokens, and a
single flat JSON store - no ORM, no database dependency, matching the same
"avoid unnecessary dependencies" precedent the rest of the engine follows.

Nothing here assumes a browser. A session token works identically whether
it arrives as a cookie (the web UI) or an `Authorization: Bearer` header (a
future API/mobile client) - see AuthStore.token_from_request() and
docs/reference/api.md.

A session also carries a `kind` ("web" by default, "mobile" for a future
native client) and an optional `device_name` - free-form labels, not a
second authentication mechanism: a mobile client authenticates exactly the
same way a browser does, by calling login() with the user's password, and
`kind`/`device_name` exist purely so the account owner can later see which
sessions exist and revoke one by name (see list_sessions()/revoke_session()).
A Satellite that guards something of its own builds on this rather than inventing its
own notion of "is this really the user".

A device credential is the one other kind of token: issued to a signed-in caller for one
Satellite capability whose vocabulary entry allows it (media.sync, a phone's backup), it reaches
only that capability provider's routes (the server checks, see api/server.py), never expires,
and is stored only as its SHA-256, like a session token. It is listed and revoked with the
sessions, with when it was last used. It never
validates as a session: validate_session() and everything built on it answer no for it.
"""

from pathlib import Path
import hashlib
import json
import math
import os
import secrets
import threading
import time

PBKDF2_ITERATIONS = 260_000
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60  # a week - long enough that a browser
                                          # session cookie doesn't force a
                                          # daily re-login, short enough that
                                          # a stale token doesn't live forever
SESSION_COOKIE = "starcore_session"
DEVICE_LIMIT = 32  # device credentials at once; another needs one revoked first
LAST_USED_RESOLUTION = 60 * 60  # a device credential's "last used", to the hour


class AuthError(Exception):
    """Raised for a request auth cannot honestly satisfy (bad credentials,
    already bootstrapped, no such session). Never raised for "works as
    designed" cases like a first-time, not-yet-bootstrapped store."""


def hash_secret(secret: str, salt: bytes) -> str:
    """PBKDF2-HMAC-SHA256, the one password/PIN hashing routine StarCore
    uses everywhere a human-chosen secret needs to be stored - the account
    password here, and any Satellite's own secret (a PIN, for example),
    which imports this directly rather than re-implementing it, per "do not
    duplicate security-sensitive logic"."""
    return hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt, PBKDF2_ITERATIONS).hex()


class LoginThrottle:
    """Slows down password guessing against /api/auth/login, per client address.

    After `max_attempts` failed sign-ins in a row, that address is refused for
    `base_lockout` seconds; each further lockout doubles, up to `max_lockout`.
    A successful sign-in clears the address's record, and a record left idle
    for `forget_after` seconds starts fresh.

    An attempt counts as failed from the moment it starts until succeeded()
    is called, so firing many guesses at once cannot get around the limit
    while the slow password check runs.

    Kept in memory only: a restart forgets it. Behind a reverse proxy every client shares the proxy's
    address, so they would also share one lockout.
    """

    MAX_TRACKED = 4096  # old idle records are dropped beyond this many addresses

    def __init__(self, max_attempts: int = 5, base_lockout: float = 30, max_lockout: float = 900,
                 forget_after: float = 3600, clock=time.monotonic):
        self.max_attempts = max_attempts
        self.base_lockout = base_lockout
        self.max_lockout = max_lockout
        self.forget_after = forget_after
        self._clock = clock
        self._lock = threading.Lock()
        self._records = {}  # client address -> {"failures", "lockouts", "locked_until", "last"}

    def begin(self, client: str) -> int:
        """0 if this client may try now (the attempt is counted), otherwise
        the whole seconds it must wait before trying again."""
        with self._lock:
            now = self._clock()
            record = self._records.get(client)
            if record is not None and record["locked_until"] > now:
                return max(1, math.ceil(record["locked_until"] - now))
            if record is None or now - record["last"] > self.forget_after:
                if len(self._records) >= self.MAX_TRACKED:
                    self._forget_idle(now)
                record = {"failures": 0, "lockouts": 0, "locked_until": 0.0, "last": now}
                self._records[client] = record

            record["last"] = now
            record["failures"] += 1
            if record["failures"] >= self.max_attempts:
                record["failures"] = 0
                record["lockouts"] += 1
                lockout = min(self.base_lockout * 2 ** (record["lockouts"] - 1), self.max_lockout)
                record["locked_until"] = now + lockout
            return 0

    def succeeded(self, client: str):
        with self._lock:
            self._records.pop(client, None)

    def _forget_idle(self, now: float):
        for client, record in list(self._records.items()):
            if record["locked_until"] <= now:
                del self._records[client]
        # still full of live lockouts (many addresses at once): drop the
        # oldest half so memory stays bounded
        if len(self._records) >= self.MAX_TRACKED:
            oldest = sorted(self._records, key=lambda client: self._records[client]["last"])
            for client in oldest[:len(oldest) // 2]:
                del self._records[client]


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
        # requests run on threads: every read-modify-write of the store holds this
        self._lock = threading.RLock()
        self._data = self._load()
        if self._data.pop("_migrated", False):
            self._save()

    def _load(self) -> dict:
        if not self.path.exists():
            return {"user": None, "sessions": {}, "devices": {}, "session_keys": "sha256"}

        try:
            with open(self.path, "r", encoding="utf-8") as file:
                data = json.load(file)
        except (json.JSONDecodeError, OSError) as error:
            print(f"[WARNING]: auth store {self.path} is unreadable ({error}). "
                  f"Starting with no user and no sessions - a fresh setup will be required.")
            return {"user": None, "sessions": {}, "devices": {}, "session_keys": "sha256"}

        if not isinstance(data, dict):
            return {"user": None, "sessions": {}, "devices": {}, "session_keys": "sha256"}
        data.setdefault("user", None)
        data.setdefault("sessions", {})
        # device credentials, by the SHA-256 of their token (never the token itself)
        if not isinstance(data.get("devices"), dict):
            data["devices"] = {}
        if not isinstance(data.get("sessions"), dict):
            data["sessions"] = {}
        if data.get("session_keys") != "sha256":
            # a store from before sessions were hashed: the same sessions, by the SHA-256 of
            # their token, so nobody is signed out and the file no longer holds a usable token
            data["sessions"] = {_token_key(token): session for token, session in data["sessions"].items()}
            data["session_keys"] = "sha256"
            data["_migrated"] = True
        return data

    def _save(self):
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
            with open(tmp_path, "w", encoding="utf-8") as file:
                json.dump(self._data, file)
            os.replace(tmp_path, self.path)

    def _session(self, token: str):
        """The live session a token is, or None. An expired one is dropped now rather than
        waiting for a sweep, so a stolen-then-expired token can never be revived."""
        if not token:
            return None
        with self._lock:
            key = _token_key(token)
            session = self._data["sessions"].get(key)
            if session is None:
                return None
            if session["expires"] < time.time():
                del self._data["sessions"][key]
                self._save()
                return None
            return session

    @property
    def is_bootstrapped(self) -> bool:
        return self._data["user"] is not None

    @property
    def username(self):
        """The account's name, or None before setup - never anything secret."""
        user = self._data["user"]
        return user["username"] if user else None

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
        with self._lock:
            if self.is_bootstrapped:
                raise AuthError("StarCore already has an administrator account")
            self._data["user"] = {
                "username": username.strip(),
                "salt": salt.hex(),
                "password_hash": hash_secret(password, salt),
            }
            self._save()
        return self.create_session(username.strip())

    def verify(self, username: str, password: str) -> bool:
        user = self._data["user"]
        if user is None or username != user["username"]:
            # still hashes something even on an unknown username, so a caller
            # timing the response can't use it to discover valid usernames
            hash_secret(password, secrets.token_bytes(16))
            return False

        salt = bytes.fromhex(user["salt"])
        # constant-time comparison - a plain == leaks how many leading bytes
        # matched through response timing
        return secrets.compare_digest(hash_secret(password, salt), user["password_hash"])

    def login(self, username: str, password: str, kind: str = "web", device_name: str = None) -> str:
        if not self.verify(username, password):
            raise AuthError("invalid username or password")
        return self.create_session(username, kind=kind, device_name=device_name)

    def create_session(self, username: str, kind: str = "web", device_name: str = None) -> str:
        """Issues a new session token.

        `kind`/`device_name` are labels only - see the module docstring. A
        mobile client is expected to pass kind="mobile" (and, ideally, a
        device_name) purely so list_sessions()/revoke_session() below can
        show and let the owner individually revoke it later; the actual
        authentication is identical to a browser login either way.
        """
        token = secrets.token_urlsafe(32)
        session = {
            "username": username,
            "expires": time.time() + SESSION_TTL_SECONDS,
            "kind": kind if kind in ("web", "mobile") else "web",
            "device_name": (str(device_name).strip()[:80] or None) if device_name else None,
            "session_id": secrets.token_hex(8),
            "created": time.time(),
        }
        with self._lock:
            # kept only as its SHA-256: whoever reads the file gets no working token
            self._data["sessions"][_token_key(token)] = session
            self._save()
        return token

    def validate_session(self, token: str) -> bool:
        return self._session(token) is not None

    def session_kind(self, token: str) -> str:
        """"web", "mobile", or "" for a token that doesn't (or no longer)
        validates - lets a Satellite treat a mobile session differently without re-implementing any part of
        session validation itself. Never raises - an invalid token is simply
        reported as no kind at all, the same as validate_session() reports
        it as simply not valid."""
        session = self._session(token)
        return session.get("kind", "web") if session else ""

    def session_username(self, token: str) -> str:
        """The account a valid token belongs to, or "" - so a Satellite can keep each
        account's own data apart without ever touching the session store itself."""
        session = self._session(token)
        return session.get("username", "") if session else ""

    def session_id(self, token: str) -> str:
        """The opaque id list_sessions() reports for this token, or "" when it doesn't validate."""
        session = self._session(token)
        return session.get("session_id", "") if session else ""

    def logout(self, token: str):
        if not token:
            return
        with self._lock:
            if self._data["sessions"].pop(_token_key(token), None) is not None:
                self._save()

    def list_sessions(self, current_token: str = None) -> list:
        """Every live (non-expired) session, for a "your devices" view in
        Mission Control - never the token itself, only the opaque
        `session_id` created alongside it, which is all revoke_session()
        below needs. Exposing the real bearer token back through an API
        response would be handing out a working credential a second time,
        exactly what "never expose ... through ... API responses" forbids for
        any secret.

        Device credentials are listed too, as kind "device" with the capability they are
        limited to and no expiry.
        """
        now = time.time()
        sessions = []
        current_key = _token_key(current_token) if current_token else None
        with self._lock:
            for key, session in self._data["sessions"].items():
                if session["expires"] < now:
                    continue
                sessions.append({
                    "session_id": session.get("session_id", ""),
                    "kind": session.get("kind", "web"),
                    "device_name": session.get("device_name"),
                    "created": session.get("created"),
                    "expires": session["expires"],
                    "current": key == current_key,
                })
            for key, device in self._data["devices"].items():
                sessions.append({
                    "session_id": device.get("session_id", ""),
                    "kind": "device",
                    "device_name": device.get("device_name"),
                    "capability": device.get("capability"),
                    "created": device.get("created"),
                    "expires": None,
                    # when it last reached the server (to the hour), so a stale one stands out
                    "last_used": device.get("last_used"),
                    "current": key == current_key,
                })
        sessions.sort(key=lambda entry: entry["created"] or 0, reverse=True)
        return sessions

    def revoke_session(self, session_id: str) -> bool:
        """Revokes one session or device credential by its opaque id (from list_sessions()),
        not by its token - the API never receives a token to revoke by, since
        the caller only ever gets the session_id back. Returns True if a
        session was actually found and removed."""
        with self._lock:
            for key, session in list(self._data["sessions"].items()):
                if session.get("session_id") == session_id:
                    del self._data["sessions"][key]
                    self._save()
                    return True
            for key, device in list(self._data["devices"].items()):
                if device.get("session_id") == session_id:
                    del self._data["devices"][key]
                    self._save()
                    return True
        return False

    # ---------- device credentials ----------

    def create_device(self, username: str, capability: str, device_name: str = None) -> tuple:
        """Issues a device credential limited to `capability`: (token, its entry as
        list_sessions() shows it). The token is returned once and kept only as its SHA-256.
        Whether the capability allows one is the caller's check (the server asks the
        vocabulary); this only refuses past DEVICE_LIMIT."""
        if not self.is_bootstrapped:
            raise AuthError("StarCore has no administrator account yet")
        if not isinstance(capability, str) or not capability:
            raise AuthError("a device credential needs a capability")
        token = secrets.token_urlsafe(32)
        name = (str(device_name).strip()[:80] or None) if device_name else None
        device = {
            "username": username,
            "capability": capability,
            "device_name": name,
            "session_id": secrets.token_hex(8),
            "created": time.time(),
        }
        with self._lock:
            if len(self._data["devices"]) >= DEVICE_LIMIT:
                raise AuthError(f"at most {DEVICE_LIMIT} device credentials at once - revoke one first")
            self._data["devices"][_token_key(token)] = device
            self._save()
        return token, {"session_id": device["session_id"], "kind": "device", "device_name": name,
                       "capability": capability, "created": device["created"], "expires": None,
                       "last_used": None}

    def device_credential(self, token: str):
        """{session_id, capability, device_name, username} of a device credential, or None for
        any other token (a session included)."""
        if not token:
            return None
        with self._lock:
            device = self._data["devices"].get(_token_key(token))
            if device is None:
                return None
            # its use, to the hour: a phone backs up in many requests, one write an hour is enough
            now = time.time()
            if now - (device.get("last_used") or 0) >= LAST_USED_RESOLUTION:
                device["last_used"] = now
                self._save()
        return {"session_id": device.get("session_id", ""), "capability": device.get("capability"),
                "device_name": device.get("device_name"), "username": device.get("username", "")}

    def caller(self, token: str):
        """Who a token is, for a Satellite that keeps something per caller (what one device
        sent): {id, kind: web|mobile|device, name} for a valid session or a device credential,
        None otherwise. id is the opaque session_id list_sessions() shows."""
        session = self._session(token)
        if session is not None:
            return {"id": session.get("session_id", ""), "kind": session.get("kind", "web"),
                    "name": session.get("device_name")}
        device = self.device_credential(token)
        if device is not None:
            return {"id": device["session_id"], "kind": "device", "name": device["device_name"]}
        return None

    def purge_expired_sessions(self):
        now = time.time()
        with self._lock:
            expired = [key for key, session in self._data["sessions"].items() if session["expires"] < now]
            for key in expired:
                del self._data["sessions"][key]
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


def _token_key(token: str) -> str:
    """What a session or a device credential is stored under: the SHA-256 of its token. The
    token is 256 random bits, so a plain digest is enough; nothing slow is needed against guessing."""
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()
