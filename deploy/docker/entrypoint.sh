#!/bin/sh
# Container entrypoint: writes the config.toml files that don't exist yet with the values a
# container needs (the same idea as deploy/linux/install.sh), then runs the given command.
# An existing config.toml is never touched. Override the port with STARCORE_PORT.
set -eu

python - <<'PY'
import os, shutil, sys
from pathlib import Path

app = Path("/app")
sys.path.insert(0, str(app / "engine"))
from starcore.toml_edit import write_value

SETTINGS = {
    # Mission Control must listen on every interface inside the container; publishing the
    # port (docker run -p) decides who can reach it
    "engine": {("server", "host"): "0.0.0.0",
               ("server", "port"): int(os.environ.get("STARCORE_PORT", "8090"))},
    "satellites/native/photo": {(None, "storage"): "/srv/starcore/photo"},
    "satellites/native/music": {(None, "storage"): "/data/music",
                                (None, "library"): "/srv/starcore/music"},
    "satellites/native/file_explorer": {(None, "root"): "/srv/starcore/files"},
}
for folder, values in SETTINGS.items():
    config = app / folder / "config.toml"
    if config.exists():
        continue
    defaults = config.with_name("config.default.toml")
    if defaults.exists():
        shutil.copyfile(defaults, config)
    for (section, key), value in values.items():
        write_value(config, section, key, value)
    print(f"created {config}", flush=True)
PY

exec "$@"
