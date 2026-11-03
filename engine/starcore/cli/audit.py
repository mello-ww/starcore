"""An append-only record of state-changing, sensitive and refused commands.

One JSON object per line in StarCore's data directory (audit.log), rotated
to audit.log.1 past MAX_BYTES. It records who ran what, from where, and how
it ended - never a token, PIN or any value a command marks sensitive (see
spec.redacted()). Writing it can never make a command fail.
"""

from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
import json
import os

MAX_BYTES = 1024 * 1024


class AuditLog:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = Lock()

    def record(self, entry: dict):
        line = json.dumps({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry},
                          default=str, ensure_ascii=False)
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                if self.path.is_file() and self.path.stat().st_size > MAX_BYTES:
                    os.replace(self.path, self.path.with_name(self.path.name + ".1"))
                with open(self.path, "a", encoding="utf-8") as file:
                    file.write(line + "\n")
            except OSError as error:
                print(f"[WARNING]: could not write the audit log ({error}).")

    def recent(self, limit: int = 20) -> list:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        entries = []
        for line in lines[-limit:]:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries
