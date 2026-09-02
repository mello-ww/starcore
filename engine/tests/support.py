from contextlib import redirect_stdout
from pathlib import Path
import io
import shutil
import tempfile

from starcore.core import StarCore

CONFIG_TEMPLATE = """[engine]
name = "StarCore"

[server]
enabled = {enabled}
host = "127.0.0.1"
port = 0
"""


def start_engine(mission_control=False):
    directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))
    config_path = directory / "config.toml"
    config_path.write_text(CONFIG_TEMPLATE.format(enabled=str(mission_control).lower()), encoding="utf-8")

    engine = StarCore(config_path)
    shutil.rmtree(directory, ignore_errors=True)

    with redirect_stdout(io.StringIO()):
        engine.start()

    return engine


def stop_engine(engine):
    with redirect_stdout(io.StringIO()):
        engine.stop()
