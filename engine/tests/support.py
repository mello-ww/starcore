from contextlib import redirect_stdout
from pathlib import Path
import io
import shutil
import tempfile

from starcore.auth import AuthStore
from starcore.cli.audit import AuditLog
from starcore.core import StarCore

CONFIG_TEMPLATE = """[engine]
name = "StarCore"

[server]
enabled = {enabled}
host = "{host}"
port = {port}

[satellites]
services = {services}
"""


def start_engine(mission_control=False, services=False, host="127.0.0.1", port=0):
    directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))
    config_path = directory / "config.toml"
    # satellite background services stay off by default, so a test run never binds
    # a port or writes into a satellite's real storage
    config_path.write_text(
        CONFIG_TEMPLATE.format(enabled=str(mission_control).lower(), services=str(services).lower(),
                                host=host, port=port),
        encoding="utf-8")

    engine = StarCore(config_path)
    # a disposable, per-test credential/session store - never the real
    # engine/data/auth.json - so one test bootstrapping a user (or creating a
    # session) can never leak into, or be affected by, any other test
    engine.auth = AuthStore(directory / "auth.json")
    # the same for the command audit log (see starcore/cli/audit.py)
    engine.audit = AuditLog(directory / "audit.log")
    shutil.rmtree(directory, ignore_errors=True)

    with redirect_stdout(io.StringIO()):
        engine.start()

    return engine


def stop_engine(engine):
    with redirect_stdout(io.StringIO()):
        engine.stop()
