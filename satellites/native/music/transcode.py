"""Optional FFmpeg transcoding into a size-bounded cache.

A transcode is written to a file and then served like any other, so the Core's range
handling gives seeking, resuming and correct lengths for free. FFmpeg is run with an
argument list (never a shell) and only ever reads a path the index already knows.
"""

from pathlib import Path
from threading import BoundedSemaphore, Lock
import os
import shutil
import subprocess

PROFILES = {
    "opus": {"high": 192, "normal": 128, "low": 64},
    "aac": {"high": 256, "normal": 160, "low": 96},
    "mp3": {"high": 320, "normal": 192, "low": 128},
}
CONTAINERS = {
    "opus": ("opus", "ogg", "audio/ogg; codecs=opus", ["-c:a", "libopus", "-vbr", "on"]),
    "aac": ("m4a", "ipod", "audio/mp4", ["-c:a", "aac", "-movflags", "+faststart"]),
    "mp3": ("mp3", "mp3", "audio/mpeg", ["-c:a", "libmp3lame"]),
}
TIMEOUT = 600


class TranscodeError(Exception):
    pass


class Transcoder:
    def __init__(self, cache_dir: Path, binary: str = "ffmpeg", workers: int = 2, cache_mb: int = 2048):
        self.cache_dir = Path(cache_dir)
        self.binary = binary or "ffmpeg"
        self.cache_bytes = max(int(cache_mb or 0), 64) * 1024 * 1024
        self._slots = BoundedSemaphore(max(int(workers or 1), 1))
        self._locks = {}
        self._locks_guard = Lock()

    @property
    def executable(self):
        candidate = Path(self.binary)
        if candidate.is_absolute():
            return str(candidate) if candidate.is_file() else None
        return shutil.which(self.binary)

    @property
    def available(self) -> bool:
        return self.executable is not None

    def plan(self, track: dict, quality: str, codec: str) -> dict:
        """What a request for this quality will actually deliver, decided before anything runs."""
        original = {"delivery": "original", "format": track["format"], "codec": track["codec"],
                    "bitrate": track["bitrate"], "lossless": track["quality"]["lossless"],
                    "content_type": None, "reason": None}
        if quality in (None, "", "original"):
            return original
        codec = codec if codec in PROFILES else "opus"
        target = PROFILES[codec].get(quality)
        if target is None:
            return {**original, "reason": f"unknown quality '{quality}', sending the original"}
        if not track["quality"]["lossless"] and track["bitrate"] and track["bitrate"] <= target * 1000 * 1.1:
            return {**original, "reason": "the original is already at or below the requested bitrate"}
        if not self.available:
            return {**original, "reason": "transcoding is unavailable on this server (FFmpeg not found)"}
        extension, _, content_type, _ = CONTAINERS[codec]
        return {"delivery": "transcode", "format": extension, "codec": codec, "bitrate": target * 1000,
                "lossless": False, "content_type": content_type, "reason": None, "profile": f"{codec}-{quality}"}

    def path_for(self, track_row, plan: dict) -> Path:
        extension = CONTAINERS[plan["codec"]][0]
        return self.cache_dir / f"{track_row['id']}-{track_row['content_hash']}-{plan['profile']}.{extension}"

    def transcode(self, track_row, plan: dict) -> Path:
        target = self.path_for(track_row, plan)
        with self._lock_for(target.name):
            if target.is_file():
                os.utime(target)
                return target
            if not self._slots.acquire(timeout=60):
                raise TranscodeError("the server is busy transcoding; try again shortly")
            try:
                self._run(Path(track_row["path"]), target, plan)
            finally:
                self._slots.release()
        self._evict(keep=target)
        return target

    def _run(self, source: Path, target: Path, plan: dict):
        executable = self.executable
        if executable is None:
            raise TranscodeError("FFmpeg is not available")
        if not source.is_file():
            raise TranscodeError("the original file is no longer on disk")
        _, muxer, _, codec_args = CONTAINERS[plan["codec"]]
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(f".{target.name}.{os.getpid()}.part")
        arguments = [executable, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                     "-protocol_whitelist", "file", "-i", f"file:{source}", "-map", "0:a:0", "-vn",
                     "-map_metadata", "-1", *codec_args, "-b:a", f"{plan['bitrate'] // 1000}k",
                     "-f", muxer, f"file:{partial}"]
        try:
            completed = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.PIPE, timeout=TIMEOUT, shell=False)
        except subprocess.TimeoutExpired:
            partial.unlink(missing_ok=True)
            raise TranscodeError("transcoding took too long")
        except OSError as error:
            partial.unlink(missing_ok=True)
            raise TranscodeError(f"FFmpeg could not be started ({error})")
        if completed.returncode != 0 or not partial.is_file() or partial.stat().st_size == 0:
            partial.unlink(missing_ok=True)
            detail = completed.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] if completed.stderr else []
            raise TranscodeError(f"FFmpeg failed{': ' + detail[0][:200] if detail else ''}")
        os.replace(partial, target)

    def _lock_for(self, name: str) -> Lock:
        with self._locks_guard:
            return self._locks.setdefault(name, Lock())

    def _evict(self, keep: Path):
        try:
            files = [path for path in self.cache_dir.iterdir() if path.is_file() and not path.name.startswith(".")]
        except OSError:
            return
        total = sum(path.stat().st_size for path in files)
        for path in sorted(files, key=lambda candidate: candidate.stat().st_mtime):
            if total <= self.cache_bytes:
                break
            if path == keep:
                continue
            size = path.stat().st_size
            try:
                path.unlink()
                total -= size
            except OSError:
                continue

    def cache_usage(self) -> dict:
        try:
            files = [path for path in self.cache_dir.iterdir() if path.is_file()]
        except OSError:
            files = []
        return {"files": len(files), "bytes": sum(path.stat().st_size for path in files), "limit": self.cache_bytes}
