from contextlib import redirect_stdout
from pathlib import Path
from unittest import SkipTest, mock
import io
import os
import shutil
import tempfile

from starcore import capabilities
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


def every_block(blocks):
    """Each block of a page, also inside a card, an actions row or a dropdown."""
    for block in blocks:
        yield block
        yield from every_block(block.get("blocks", []))


def protecting(folder):
    """starcore.capabilities.protection answering as a files.protected provider would for an
    area at `folder` that the session has open: protected, and open. Only what asks through the
    module sees it (the browsing Satellite's own guard keeps the real answer, so it lets the
    files through, as it does for an area open for the session)."""
    area = Path(folder).resolve()

    def protection(engine, path, token="", tree=False):
        if Path(path).resolve().is_relative_to(area):
            return capabilities.Protection(True, True, None)
        return capabilities.UNPROTECTED

    return mock.patch.object(capabilities, "protection", protection)


def link_folder(link, target):
    """A link at `link` to the folder `target`: a symbolic link, or a junction where Windows
    gives no right to make one."""
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            raise SkipTest("no symbolic links here")
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
