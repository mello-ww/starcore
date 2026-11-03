#!/usr/bin/env bash
# Installs (or updates) StarCore as a permanent Linux service. Run with sudo:
#
#   sudo bash deploy/linux/install.sh            # first install
#   sudo bash deploy/linux/install.sh --update   # fast-forward to origin/main, then re-sync
#
# Safe to run again: it never overwrites an existing config.toml, account or library, and
# it never starts, stops or restarts anything, and never touches nginx - those steps are
# printed at the end, to run deliberately. Layout (see docs/deployment.md, "Linux server"):
#
#   /opt/starcore/app       the checkout, owned by the starcore user
#   /opt/starcore/python    uv-managed Python 3.13 (outside any home directory)
#   /var/lib/starcore       accounts, sessions, audit log, Status history, Photo and Music
#                           libraries, Locked Folder state (systemd StateDirectory, 0700)
#   /srv/starcore/music     what Music scans; /srv/starcore/files - what File Explorer browses
set -euo pipefail

REPO_URL="${STARCORE_REPO:-https://github.com/mello-ww/starcore.git}"
BRANCH="${STARCORE_BRANCH:-main}"
SERVICE_USER=starcore
APP=/opt/starcore/app
PYTHON_DIR=/opt/starcore/python
DATA=/var/lib/starcore
MEDIA=/srv/starcore
UPDATE=0
[[ "${1:-}" == "--update" ]] && UPDATE=1

say() { printf '\n== %s\n' "$*"; }
as_service() { sudo -u "$SERVICE_USER" -H env HOME="$DATA" "$@"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

say "uv"
if ! command -v uv >/dev/null; then
    # reuse the uv already installed for the invoking admin rather than downloading one
    source_uv="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/.local/bin/uv"
    [[ -x "$source_uv" ]] || { echo "uv not found: install it, or put it at /usr/local/bin/uv" >&2; exit 1; }
    install -m 0755 "$source_uv" /usr/local/bin/uv
fi
uv --version

say "service user"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
id "$SERVICE_USER"

say "directories"
install -d -o root -g root -m 0755 /opt/starcore
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$PYTHON_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$MEDIA" "$MEDIA/music" "$MEDIA/files"

say "code"
if [[ ! -d "$APP/.git" ]]; then
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$APP"
    as_service git clone --branch "$BRANCH" "$REPO_URL" "$APP"
elif [[ $UPDATE -eq 1 ]]; then
    as_service git -C "$APP" fetch origin "$BRANCH"
    # never a merge or a reset: a checkout that has drifted stops here instead
    as_service git -C "$APP" merge --ff-only "origin/$BRANCH"
fi
as_service git -C "$APP" log -1 --format='%h %s'
[[ -z "$(as_service git -C "$APP" status --porcelain --untracked-files=no)" ]] \
    || { echo "the checkout has local changes to tracked files - resolve them first" >&2; exit 1; }

say "python and dependencies"
# Pillow (thumbnails) and cryptography (Locked Folder encryption) are both wanted: a plain
# `uv sync` would remove whichever extra isn't named
as_service env UV_PYTHON_INSTALL_DIR="$PYTHON_DIR" UV_CACHE_DIR="$DATA/.cache/uv" \
    uv sync --directory "$APP/engine" --frozen --python 3.13 --python-preference only-managed \
    --extra thumbnails --extra encryption
as_service "$APP/engine/.venv/bin/python" -c \
    "import sys, PIL, cryptography; print(sys.version.split()[0], 'Pillow', PIL.__version__, 'cryptography', cryptography.__version__)"

say "ffmpeg (video thumbnails, Music transcoding)"
if ! command -v ffmpeg >/dev/null; then
    apt-get install -y --no-install-recommends ffmpeg
fi
ffmpeg -version | head -1

say "configuration (only files that don't exist yet)"
# StarCore fills in any missing default on start; these are the values a server needs that
# differ from a development checkout. Existing config.toml files are left exactly as they are.
as_service "$APP/engine/.venv/bin/python" - "$APP" <<'PY'
import shutil, sys
from pathlib import Path

app = Path(sys.argv[1])
sys.path.insert(0, str(app / "engine"))
from starcore.toml_edit import write_value

SETTINGS = {
    # 8080 belongs to Pterodactyl Wings on this host; nginx proxies 443 -> 127.0.0.1:8090
    "engine": {("server", "host"): "127.0.0.1", ("server", "port"): 8090},
    "satellites/native/photo": {(None, "storage"): "/var/lib/starcore/photo"},
    "satellites/native/music": {(None, "storage"): "/var/lib/starcore/music",
                                (None, "library"): "/srv/starcore/music"},
    "satellites/native/file_explorer": {(None, "root"): "/srv/starcore/files"},
}
for folder, values in SETTINGS.items():
    config = app / folder / "config.toml"
    if config.exists():
        print(f"kept      {config}")
        continue
    defaults = config.with_name("config.default.toml")
    if defaults.exists():
        shutil.copyfile(defaults, config)
    for (section, key), value in values.items():
        write_value(config, section, key, value)
    print(f"created   {config}")
PY

say "systemd unit"
install -m 0644 "$APP/deploy/systemd/starcore.service" /etc/systemd/system/starcore.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/starcore.service || true

say "done - nothing was started"
cat <<EOF
Next, deliberately:
  sudo systemctl enable --now starcore        # start now and at every boot
  journalctl -u starcore -f                   # logs
  curl -s http://127.0.0.1:8090/api/auth/status
Then, for HTTPS on starcore-panel.duckdns.org (after reviewing the diff):
  diff -u /etc/nginx/sites-available/starcore $APP/deploy/nginx/starcore-panel.conf
  sudo cp /etc/nginx/sites-available/starcore /etc/nginx/sites-available/starcore.bak
  sudo cp $APP/deploy/nginx/starcore-panel.conf /etc/nginx/sites-available/starcore
  sudo nginx -t && sudo systemctl reload nginx
EOF
