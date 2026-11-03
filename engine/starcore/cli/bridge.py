"""The one-shot CLI: `python -m starcore <command> [arguments] [--json] [--yes]`.

When a StarCore is running on this machine, the command is sent to it, so
it acts on the live engine (Connect playback, the running sync service,
lifecycle controls). When none is running, the command runs in this
process against the same configuration and data, with nothing started -
commands that need the live engine then say so (exit code 5).

How the running engine is reached:
- On start, the engine writes control.json to its data directory with the
  API address and a random token made fresh for this run. The file is
  readable only by the account that runs StarCore, and is removed on stop.
- POST /api/cli/run accepts that token, and only from this machine. It is
  not a session: web and mobile clients never see it, and a session cookie
  or bearer token is not accepted there. A leftover file from a crash holds
  a token no running engine will ever accept again.
"""

from contextlib import redirect_stdout
import http.client
from pathlib import Path
import ipaddress
import io
import json
import os
import secrets
import ssl
import sys
from urllib.parse import urlsplit

from .. import runtime_paths
from . import runner
from .spec import EXIT_CONFIRMATION, EXIT_TIMEOUT, EXIT_UNAVAILABLE

CONTROL_FILE = "control.json"
ENDPOINT = "/api/cli/run"
HEADER = "X-StarCore-Control"
CONNECT_TIMEOUT = 5
# a command runs to completion inside the engine (a full library scan can
# take a while); a command with a --background option returns at once
REPLY_TIMEOUT = 900
MAX_ARGUMENTS = runner.MAX_TOKENS


def control_path() -> Path:
    return runtime_paths.data_dir() / CONTROL_FILE


# ---------- engine side ----------

def publish(engine, path: Path = None):
    """Called by the process entry point once the engine has started."""
    if not engine.api.running:
        return None
    path = Path(path or control_path())
    token = secrets.token_urlsafe(32)
    host = engine.api.host
    connect = {"": "127.0.0.1", "0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
    shown = f"[{connect}]" if ":" in connect else connect
    scheme = "https" if engine.api.https_enabled else "http"
    record = {"url": f"{scheme}://{shown}:{engine.api.port}", "token": token, "pid": os.getpid(),
              "cert": str(engine.api.https_cert) if engine.api.https_enabled and engine.api.https_cert else None}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(record, file)
        os.replace(temporary, path)
    except OSError as error:
        print(f"[WARNING]: the one-shot CLI cannot reach this StarCore ({error}).")
        return None
    engine.control_token = token
    engine.control_path = path
    return path


def withdraw(engine):
    path = getattr(engine, "control_path", None)
    token = engine.control_token
    engine.control_token = None
    if path is None or token is None:
        return
    try:
        if json.loads(Path(path).read_text(encoding="utf-8")).get("token") == token:
            Path(path).unlink()
    except (OSError, ValueError):
        pass


def accepts(engine, presented: str, client: str) -> bool:
    expected = engine.control_token
    if not expected or not presented or not _same_machine(client, engine.api.host):
        return False
    return secrets.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))


def _same_machine(client: str, bound_host: str) -> bool:
    try:
        address = ipaddress.ip_address(client)
    except ValueError:
        return False
    if getattr(address, "ipv4_mapped", None):
        address = address.ipv4_mapped
    if address.is_loopback:
        return True
    # bound to one specific address of this machine: a request from that
    # same address can only come from this machine
    try:
        return address == ipaddress.ip_address(bound_host)
    except ValueError:
        return False


def handle(engine, body) -> tuple:
    """(status, payload) for POST /api/cli/run, once accepts() said yes."""
    argv = body.get("argv") if isinstance(body, dict) else None
    if (not isinstance(argv, list) or len(argv) > MAX_ARGUMENTS
            or not all(isinstance(item, str) for item in argv)):
        return 400, {"error": "'argv' must be a list of strings"}
    outcome = _run(engine, argv, runner.local_context(engine))
    return 200, {"exit_code": outcome.exit_code, "stdout": outcome.stdout, "stderr": outcome.stderr,
                 "confirm": outcome.confirm}


def _run(engine, argv: list, context) -> runner.Outcome:
    # typed commands contain their own failures; an older single-function
    # command can still raise, and that must not become a traceback or a 500
    try:
        return engine.run_command(argv, context)
    except Exception as error:
        return runner.Outcome(1, stderr=f"[ERROR]: internal error ({type(error).__name__})\n")


# ---------- client side ----------

def main(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            # a console that can't show a character gets "?" instead of a crash
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    reply = _send(argv)
    if reply is None:
        return _run_here(argv)
    if reply.get("confirm") and _interactive() and "--json" not in argv:
        if not _ask(reply["confirm"]):
            sys.stderr.write("Cancelled.\n")
            return EXIT_CONFIRMATION
        reply = _send([*argv, "--yes"]) or reply
    return _emit(reply)


def _emit(reply: dict) -> int:
    sys.stdout.write(reply.get("stdout") or "")
    sys.stderr.write(reply.get("stderr") or "")
    return int(reply.get("exit_code", 1))


def _send(argv: list):
    """The running engine's reply, or None when no StarCore is reachable."""
    try:
        record = json.loads(control_path().read_text(encoding="utf-8"))
        target, token = urlsplit(record["url"]), record["token"]
        host, port = target.hostname, target.port
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
    if not host or not port:
        return None

    if target.scheme == "https":
        connection = http.client.HTTPSConnection(host, port, timeout=CONNECT_TIMEOUT, context=_tls(record))
    else:
        connection = http.client.HTTPConnection(host, port, timeout=CONNECT_TIMEOUT)
    try:
        try:
            connection.connect()
        except (OSError, ssl.SSLError):
            return None  # nothing listening: a leftover file from a run that ended
        # connected quickly; the command itself may take longer (a scan)
        connection.sock.settimeout(REPLY_TIMEOUT)
        connection.request("POST", ENDPOINT, body=json.dumps({"argv": list(argv)}).encode("utf-8"),
                           headers={"Content-Type": "application/json", HEADER: token})
        response = connection.getresponse()
        body = response.read()
    except TimeoutError:
        return {"exit_code": EXIT_TIMEOUT, "stderr": f"[ERROR]: StarCore did not answer within {REPLY_TIMEOUT}s\n"}
    except (OSError, http.client.HTTPException) as error:
        return {"exit_code": EXIT_UNAVAILABLE, "stderr": f"[ERROR]: lost the connection to StarCore ({error})\n"}
    finally:
        connection.close()

    if response.status in (401, 403, 404):
        return None  # an older engine, or a token from a run that has since ended
    try:
        reply = json.loads(body)
    except ValueError:
        reply = None
    if response.status != 200 or not isinstance(reply, dict):
        return {"exit_code": EXIT_UNAVAILABLE, "stderr": f"[ERROR]: StarCore answered with HTTP {response.status}\n"}
    return reply


def _tls(record: dict):
    if not record["url"].startswith("https"):
        return None
    # trust exactly the certificate StarCore serves; the address is this
    # machine, so the name on the certificate does not have to match it
    context = ssl.create_default_context(cafile=record.get("cert") or None)
    context.check_hostname = False
    context.verify_flags |= getattr(ssl, "VERIFY_X509_PARTIAL_CHAIN", 0)
    return context


def _run_here(argv: list) -> int:
    from ..core import StarCore

    quiet = io.StringIO()
    with redirect_stdout(quiet):
        engine = StarCore()
        engine.load()
    context = runner.local_context(engine)
    if _interactive():
        context.interactive = True
        context.confirm = _ask
    with redirect_stdout(quiet):
        outcome = _run(engine, argv, context)
    sys.stdout.write(outcome.stdout)
    sys.stderr.write(outcome.stderr)
    return outcome.exit_code


def _interactive() -> bool:
    return bool(sys.stdin and sys.stdin.isatty())


def _ask(prompt: str) -> bool:
    # on stderr, so the question is seen even while stdout is captured or piped
    sys.stderr.write(f"{prompt} [y/N] ")
    sys.stderr.flush()
    return sys.stdin.readline().strip().lower() in ("y", "yes")

