"""StarCore Connect: one listener's devices, their playback state, and remote control between them.

The server only relays intent. Audio is always streamed by the device that plays it, never
through the one that controls it. A device belongs to the account that registered it, and a
command can only ever reach that same account's devices. Events are delivered by long-poll,
so this needs nothing beyond the HTTP server StarCore already runs.
"""

from collections import deque
from threading import Condition
import re
import secrets
import time

from .db import dumps, loads, now

DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
TRACK_ID = re.compile(r"^[0-9a-f]{8,64}$")
KINDS = ("web", "mobile", "desktop", "speaker", "other")
COMMANDS = ("play", "pause", "toggle", "next", "previous", "seek", "volume", "set_queue", "add_queue",
            "play_next", "shuffle", "repeat", "transfer_in", "stop")
REPEAT_MODES = ("off", "all", "one")
ONLINE_SECONDS = 90
EVENTS_KEPT = 256
WAIT_LIMIT = 30
WAITERS_PER_USER = 16
QUEUE_LIMIT = 10_000


class ConnectError(ValueError):
    pass


class Connect:
    def __init__(self, db):
        self.db = db
        self._condition = Condition()
        self._events = {}
        self._sequence = 0
        self._waiters = {}

    # ---------- devices ----------

    def register(self, user: str, device_id: str, name: str, kind: str, session_id: str = "",
                 capabilities: dict = None) -> dict:
        _device(device_id)
        kind = kind if kind in KINDS else "other"
        name = " ".join(str(name or "").split())[:60] or f"{kind.title()} player"
        capabilities = {key: bool(value) for key, value in (capabilities or {}).items()
                        if key in ("play", "remote", "volume", "lossless", "transcode", "offline")}
        self.db.execute("INSERT INTO devices (user, device_id, name, kind, session_id, capabilities, last_seen) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user, device_id) DO UPDATE SET name = excluded.name, "
                        "kind = excluded.kind, session_id = excluded.session_id, capabilities = excluded.capabilities, "
                        "last_seen = excluded.last_seen",
                        (user, device_id, name, kind, session_id or "", dumps(capabilities), time.time()))
        self._publish(user, {"type": "devices"})
        return self.device(user, device_id)

    def forget(self, user: str, device_id: str) -> bool:
        removed = self.db.execute("DELETE FROM devices WHERE user = ? AND device_id = ?", (user, device_id))
        self.db.execute("DELETE FROM playback_state WHERE user = ? AND device_id = ?", (user, device_id))
        self._publish(user, {"type": "devices"})
        return bool(removed)

    def touch(self, user: str, device_id: str):
        self.db.execute("UPDATE devices SET last_seen = ? WHERE user = ? AND device_id = ?",
                        (time.time(), user, device_id))

    def device(self, user: str, device_id: str):
        row = self.db.one("SELECT * FROM devices WHERE user = ? AND device_id = ?", (user, device_id))
        return self._device_payload(row) if row else None

    def devices(self, user: str) -> list:
        states = {row["device_id"]: loads(row["state"], {}) for row in self.db.all(
            "SELECT device_id, state FROM playback_state WHERE user = ?", (user,))}
        devices = []
        for row in self.db.all("SELECT * FROM devices WHERE user = ? ORDER BY last_seen DESC", (user,)):
            payload = self._device_payload(row)
            state = states.get(row["device_id"]) or {}
            payload["playing"] = bool(state.get("playing")) and payload["online"]
            payload["track_id"] = state.get("track_id")
            payload["volume"] = state.get("volume")
            devices.append(payload)
        return devices

    def _device_payload(self, row) -> dict:
        return {"id": row["device_id"], "name": row["name"], "kind": row["kind"],
                "capabilities": loads(row["capabilities"], {}), "last_seen": row["last_seen"],
                "online": time.time() - (row["last_seen"] or 0) < ONLINE_SECONDS}

    def _owned(self, user: str, device_id: str):
        if not isinstance(device_id, str) or not DEVICE_ID.match(device_id):
            raise ConnectError("unknown device")
        if self.device(user, device_id) is None:
            raise ConnectError("unknown device")

    # ---------- state ----------

    def save_state(self, user: str, device_id: str, state: dict) -> dict:
        self._owned(user, device_id)
        clean = clean_state(state)
        clean["updated_at"] = time.time()
        self.db.execute("INSERT INTO playback_state (user, device_id, state, updated_at) VALUES (?, ?, ?, ?) "
                        "ON CONFLICT (user, device_id) DO UPDATE SET state = excluded.state, "
                        "updated_at = excluded.updated_at", (user, device_id, dumps(clean), now()))
        self.touch(user, device_id)
        self._publish(user, {"type": "state", "device": device_id, "state": _summary(clean)})
        return clean

    def state(self, user: str, device_id: str = None):
        if device_id:
            row = self.db.one("SELECT state FROM playback_state WHERE user = ? AND device_id = ?", (user, device_id))
        else:
            row = self.db.one("SELECT state FROM playback_state WHERE user = ? ORDER BY updated_at DESC LIMIT 1",
                              (user,))
        return loads(row["state"]) if row else None

    def active(self, user: str):
        """The device currently playing, or the one that played last."""
        best = None
        for row in self.db.all("SELECT device_id, state FROM playback_state WHERE user = ?", (user,)):
            state = loads(row["state"], {})
            device = self.device(user, row["device_id"])
            if device is None:
                continue
            score = (bool(state.get("playing")) and device["online"], state.get("updated_at") or 0)
            if best is None or score > best[0]:
                best = (score, row["device_id"], state)
        return {"device": best[1], "state": best[2]} if best else None

    # ---------- control ----------

    def command(self, user: str, sender: str, target: str, command: str, arguments: dict = None) -> dict:
        self._owned(user, target)
        if sender:
            self._owned(user, sender)
        if command not in COMMANDS:
            raise ConnectError(f"command must be one of {', '.join(COMMANDS)}")
        arguments = clean_arguments(command, arguments or {})
        device = self.device(user, target)
        if not device["online"]:
            raise ConnectError(f"'{device['name']}' is not online")
        event = {"type": "command", "id": secrets.token_hex(6), "target": target, "from": sender or None,
                 "command": command, "arguments": arguments}
        self._publish(user, event)
        return event

    def transfer(self, user: str, sender: str, target: str, source: str = None, play: bool = True) -> dict:
        """Moves playback to another device with its queue, position, shuffle and repeat intact."""
        self._owned(user, target)
        origin = None
        if source:
            self._owned(user, source)
            origin = {"device": source, "state": self.state(user, source)}
        else:
            origin = self.active(user)
        if not origin or not origin["state"] or not origin["state"].get("queue"):
            raise ConnectError("there is nothing playing to transfer")
        state = dict(origin["state"])
        if state.get("playing") and state.get("updated_at"):
            elapsed = max(0.0, time.time() - state["updated_at"]) * float(state.get("speed") or 1)
            state["position"] = round(float(state.get("position") or 0) + elapsed, 2)
        state["playing"] = bool(play)
        if origin["device"] != target:
            device = self.device(user, origin["device"])
            if device and device["online"]:
                self._publish(user, {"type": "command", "id": secrets.token_hex(6), "target": origin["device"],
                                     "from": sender or None, "command": "pause", "arguments": {"transferred": True}})
        return self.command(user, sender, target, "transfer_in", {"state": state, "from_device": origin["device"]})

    # ---------- events ----------

    def _publish(self, user: str, event: dict):
        with self._condition:
            self._sequence += 1
            event = {**event, "seq": self._sequence, "at": time.time()}
            self._events.setdefault(user, deque(maxlen=EVENTS_KEPT)).append(event)
            self._condition.notify_all()

    def cursor(self) -> int:
        with self._condition:
            return self._sequence

    def wait_for_state(self, user: str, device_id: str, since: int, timeout: float):
        """The first state a device reports after `since`, or None once `timeout` passes.

        Lets a controller (the CLI) confirm a command took effect without
        registering as a device or marking the target as seen."""
        deadline = time.monotonic() + max(0.0, min(float(timeout), WAIT_LIMIT))
        with self._condition:
            while True:
                for event in self._events.get(user, ()):
                    if event["seq"] > since and event.get("type") == "state" and event.get("device") == device_id:
                        return event["state"]
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._condition.wait(remaining)

    def events(self, user: str, device_id: str, since: int, timeout: float = 25) -> dict:
        self._owned(user, device_id)
        self.touch(user, device_id)
        timeout = max(0.0, min(float(timeout), WAIT_LIMIT))
        deadline = time.monotonic() + timeout
        with self._condition:
            if self._waiters.get(user, 0) >= WAITERS_PER_USER:
                raise ConnectError("too many devices are listening at once")
            self._waiters[user] = self._waiters.get(user, 0) + 1
            try:
                while True:
                    pending = [event for event in self._events.get(user, ()) if event["seq"] > since
                               and event.get("target") in (None, device_id)]
                    remaining = deadline - time.monotonic()
                    if pending or remaining <= 0:
                        break
                    self._condition.wait(remaining)
            finally:
                self._waiters[user] -= 1
        self.touch(user, device_id)
        return {"events": pending, "cursor": max([since, *(event["seq"] for event in pending)])}


def _device(device_id):
    if not isinstance(device_id, str) or not DEVICE_ID.match(device_id):
        raise ConnectError("a device id is 8 to 64 letters, digits, '-' or '_'")


def _tracks(values) -> list:
    if not isinstance(values, list) or len(values) > QUEUE_LIMIT:
        raise ConnectError(f"a queue holds at most {QUEUE_LIMIT} tracks")
    return [value for value in values if isinstance(value, str) and TRACK_ID.match(value)]


def clean_state(state) -> dict:
    if not isinstance(state, dict):
        raise ConnectError("state must be an object")
    queue = _tracks(state.get("queue", []))
    index = state.get("index", 0)
    index = int(index) if isinstance(index, (int, float)) and queue else 0
    order = state.get("order")
    order = [int(value) for value in order if isinstance(value, int) and 0 <= value < len(queue)] \
        if isinstance(order, list) and len(order) == len(queue) else None
    return {
        "queue": queue,
        "index": max(0, min(index, len(queue) - 1)) if queue else 0,
        "order": order,
        "track_id": queue[max(0, min(index, len(queue) - 1))] if queue else None,
        "position": round(max(0.0, float(state.get("position") or 0)), 2),
        "duration": round(max(0.0, float(state.get("duration") or 0)), 2),
        "playing": bool(state.get("playing")),
        "shuffle": bool(state.get("shuffle")),
        "repeat": state.get("repeat") if state.get("repeat") in REPEAT_MODES else "off",
        "volume": round(max(0.0, min(float(state.get("volume") if state.get("volume") is not None else 1), 1.0)), 3),
        "speed": round(max(0.5, min(float(state.get("speed") or 1), 2.0)), 2),
        "context": str(state.get("context") or "")[:100] or None,
    }


def _summary(state: dict) -> dict:
    return {key: state[key] for key in ("track_id", "index", "position", "duration", "playing", "shuffle", "repeat",
                                         "volume", "updated_at", "context")} | {"queue_length": len(state["queue"])}


def clean_arguments(command: str, arguments: dict) -> dict:
    if not isinstance(arguments, dict):
        raise ConnectError("arguments must be an object")
    if command == "seek":
        return {"position": max(0.0, float(arguments.get("position") or 0))}
    if command == "volume":
        return {"value": max(0.0, min(float(arguments.get("value") or 0), 1.0))}
    if command == "shuffle":
        return {"on": bool(arguments.get("on"))}
    if command == "repeat":
        mode = arguments.get("mode")
        if mode not in REPEAT_MODES:
            raise ConnectError("repeat mode must be off, all or one")
        return {"mode": mode}
    if command in ("set_queue",):
        tracks = _tracks(arguments.get("tracks", []))
        if not tracks:
            raise ConnectError("set_queue needs at least one track")
        return {"tracks": tracks, "index": max(0, min(int(arguments.get("index") or 0), len(tracks) - 1)),
                "position": max(0.0, float(arguments.get("position") or 0)), "context": str(arguments.get("context") or "")[:100] or None}
    if command in ("add_queue", "play_next"):
        tracks = _tracks(arguments.get("tracks", []))
        if not tracks:
            raise ConnectError(f"{command} needs at least one track")
        return {"tracks": tracks}
    if command == "transfer_in":
        return {"state": clean_state(arguments.get("state") or {}) | {"position": float((arguments.get("state") or {}).get("position") or 0)},
                "from_device": arguments.get("from_device") if isinstance(arguments.get("from_device"), str) else None}
    if command == "pause":
        return {"transferred": bool(arguments.get("transferred"))}
    return {}
