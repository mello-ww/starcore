# Deployment

How to run StarCore from a fresh checkout, on Windows and on Linux.

## Python version

StarCore targets **Python 3.13** (`engine/pyproject.toml` and `engine/uv.lock` both pin `requires-python = ">=3.13"`, and `engine/.python-version` pins `3.13` for `uv`). Install 3.13 rather than whatever the machine already has - StarCore does not lower this requirement to fit an older interpreter.

A Linux server that only has an older Python (Ubuntu 22.04/24.04 ship 3.10 or 3.12, for example) needs 3.13 installed alongside it first, through whichever of the following fits the distribution:

- the [deadsnakes PPA](https://launchpad.net/~deadsnakes/+archive/ubuntu/ppa) on Debian/Ubuntu (`apt install python3.13 python3.13-venv`)
- [pyenv](https://github.com/pyenv/pyenv) (`pyenv install 3.13`)
- `uv`'s own managed Pythons (`uv python install 3.13` - `uv` can then provision the interpreter itself, see below)

None of this is done for you: the server is prepared separately, and StarCore only needs `python3.13` to end up on `PATH` (or resolvable by `uv`) once that's done.

## Installing

StarCore itself has no required dependencies; Pillow is an optional extra that enables photo thumbnails (without it, the Photo Satellite serves original images instead). The project is managed with [`uv`](https://docs.astral.sh/uv/), which handles the virtual environment and this optional dependency identically on both platforms.

### With `uv` (preferred)

```
cd engine
uv sync                     # core install
uv sync --extra thumbnails  # also installs Pillow, for thumbnails
```

This creates `engine/.venv`. `uv` provisions Python 3.13 itself if it isn't already available.

### With a plain venv (no `uv` on the server)

```
cd engine
python3.13 -m venv .venv
```

Linux/macOS:
```
source .venv/bin/activate
```
Windows (PowerShell):
```
.venv\Scripts\Activate.ps1
```

Then, optionally:
```
pip install pillow
```

## Starting StarCore

The canonical entry point is the same on both platforms, run from the `engine` directory:

```
python -m starcore
```

(or `uv run python -m starcore`, which activates the venv for you). This loads `engine/config.toml`, discovers Satellites, starts Mission Control and - only when standard input is an interactive terminal - the terminal CLI. Every path StarCore uses (configuration, satellites, Mission Control's assets, a Satellite's own assets) is resolved from the engine's own file location, not from the current working directory, so this works identically whether you run it from the repository root, from inside `engine/`, or `cd`'d in from anywhere else - the only requirement is that the command runs with `engine/` as the working directory, so Python can find the `starcore` package.

### Interactive vs. headless

Run in a real terminal, StarCore behaves as before: it starts Mission Control and drops into the terminal CLI, `exit` or Ctrl+C stop it.

Run with no terminal attached - under systemd, Task Scheduler, or with stdin redirected - StarCore skips the CLI (there is nothing to read from, and trying would hit end-of-file immediately and shut the engine straight back down). It prints as much and keeps running Mission Control and any Satellite services. Stop it with a stop signal (SIGTERM, sent by `systemctl stop`, or Ctrl+C where a terminal exists) or from Mission Control's "Stop StarCore" button.

### Stopping StarCore

Any of the following triggers the same graceful shutdown - Mission Control's API server is closed, every Satellite's `stop` hook runs, and the process exits cleanly:

- typing `exit` in the terminal CLI
- Ctrl+C
- Mission Control's "Stop StarCore" button
- a SIGTERM (Linux) or Ctrl+Break/SIGBREAK (Windows), e.g. `systemctl stop starcore` or `kill <pid>`

## Linux

### systemd (optional)

A unit template is provided at `deploy/systemd/starcore.service`:

```ini
[Unit]
Description=StarCore
After=network.target

[Service]
Type=simple
# replace with an unprivileged user that owns the checkout below
User=starcore
# both paths must point at the checkout's engine/ directory and its venv
WorkingDirectory=/opt/starcore/engine
ExecStart=/opt/starcore/engine/.venv/bin/python -m starcore
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Edit `User`, `WorkingDirectory` and `ExecStart` for the actual install location, then:

```
sudo cp deploy/systemd/starcore.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now starcore
```

`Restart=on-failure` restarts StarCore if it crashes, but not after a clean stop (`systemctl stop`) - StarCore always exits with status 0 on a graceful shutdown, so it won't fight `systemctl stop` or loop on an intentional restart.

systemd is entirely optional; nothing about running StarCore in a terminal for development requires it.

### Logs

systemd captures StarCore's stdout/stderr into the journal automatically:

```
journalctl -u starcore -f
```

Outside systemd, StarCore logs to stdout/stderr like any other terminal program - redirect it yourself if you need it in a file.

### Stopping

```
sudo systemctl stop starcore
```

## Windows

### Normal workflow

```powershell
cd engine
uv sync
uv run python -m starcore
```

Mission Control is then at `http://127.0.0.1:8080`. Stop with Ctrl+C in that terminal, or "Stop StarCore" in Mission Control.

### Optional automatic startup

For running unattended (e.g. at log-on) rather than from an open terminal, `deploy/windows/start-starcore.ps1` wraps the same command and is meant to be pointed at from a Task Scheduler task:

- Program/script: `powershell.exe`
- Arguments: `-ExecutionPolicy Bypass -File "C:\path\to\starcore\deploy\windows\start-starcore.ps1"`

This is optional - a Task Scheduler task started this way runs with no terminal attached, so StarCore runs headless (see "Interactive vs. headless" above) and is stopped by ending the task or from Mission Control.

## Configuration

`engine/config.toml` is read once, at startup, from a fixed path next to the `starcore` package - it does not depend on the working directory, and defaults are used for anything missing (an absent file, an absent section, an absent key):

```toml
[server]
enabled = true
host = "127.0.0.1"
port = 8080
```

`host = "0.0.0.0"` exposes Mission Control beyond localhost, on either platform. The same is true for the Photo Satellite's phone-sync listener, configured separately in `satellites/native/photo/config.toml` (`sync_host`, `sync_port`) - it already followed this same one-`config.toml`-per-component pattern before this milestone, so it wasn't changed.

`[server]` doesn't have to be edited by hand. All three of the following read and write the exact same `config.toml`, through the same validation, and none of them ever claims a change is live - `[server]` is only read once at startup, so any of these always says a restart is required:

- the terminal CLI's `config` command (`config` to inspect, `config server.host 0.0.0.0` to change a setting)
- `GET`/`POST /api/configuration`
- Mission Control's Configuration page

See "Private LAN access" below for the specific case of `server.host`, and `docs/api.md` / `docs/mission_control.md` for the API and the Configuration page respectively.

## Persistent data

Each Satellite that stores anything keeps it under its own `data/` directory by default (`satellites/native/photo/data/`, `satellites/native/music/data/` - see `.gitignore`), resolved relative to the Satellite's own location, not the working directory or the platform. This is unchanged by this milestone and identical on Windows and Linux.

A Satellite's `storage` key in its `config.toml` accepts an absolute path instead, for anyone who wants data outside the checkout (for example on a Linux server where `/opt/starcore` is meant to be replaceable and `/var/lib/starcore/photo` isn't): set `storage = "/var/lib/starcore/photo"` (Linux) or an absolute Windows path, and StarCore uses it as-is rather than resolving it against the Satellite's directory. This is unchanged behavior, not new in this milestone - it just isn't used by the shipped defaults.

## Mission Control address

`http://<host>:<port>` from the `[server]` section above - `http://127.0.0.1:8080` by default, on both platforms.

## Private LAN access

By default `host = "127.0.0.1"` means Mission Control only accepts connections from the same machine it runs on - nothing else on the network can reach it, even if the machine is on the same LAN.

To reach Mission Control from another device on your private network (a phone, another computer), change `server.host` to `0.0.0.0`, which listens on every network interface instead of just loopback. On a Linux server this is the change referred to at the top of this milestone:

```toml
[server]
host = "0.0.0.0"
port = 8090
```

Any of these three ways make the same change:

```
# terminal CLI, from the engine directory
config server.host 0.0.0.0
config server.port 8090
```

```
# API
curl -X POST http://127.0.0.1:8090/api/configuration -H 'Content-Type: application/json' \
     -d '{"section": "server", "key": "host", "value": "0.0.0.0"}'
```

or the Configuration page in Mission Control, described in `docs/mission_control.md`.

Whichever way you use, the change is saved to `config.toml` immediately but does **not** apply to the process that's already running - `[server]` is only read at startup. **Restart StarCore** (`systemctl restart starcore` on Linux, or stop and re-run `python -m starcore` on Windows) for the new bind address to take effect. After restarting, reach Mission Control from another device using the server's LAN IP and the configured port, e.g. `http://192.168.1.20:8090`.

### Reverting to localhost-only

Set `server.host` back to `127.0.0.1` the same way (CLI, API, or the Configuration page) and restart StarCore. Mission Control then stops accepting connections from other devices again.

### Firewall considerations

Binding to `0.0.0.0` only changes which interfaces StarCore listens on - it doesn't open a path through the OS firewall by itself. Depending on the server's default firewall policy, an inbound rule may also be needed for the configured port:

**Linux**, `ufw`:
```
sudo ufw allow 8090/tcp
```
**Linux**, `firewalld`:
```
sudo firewall-cmd --add-port=8090/tcp --permanent
sudo firewall-cmd --reload
```
**Windows** (PowerShell, elevated):
```powershell
New-NetFirewallRule -DisplayName "StarCore Mission Control" -Direction Inbound -Protocol TCP -LocalPort 8090 -Action Allow
```

Scope any of the above to the private/LAN network profile rather than "any network" where the tool allows it, since the goal is reachability from trusted devices on the same private network, not from anywhere.

### What this does not do

- It does not add authentication. Mission Control has none yet (a planned future milestone) - anyone who can reach the configured host and port on the network has the same access as someone sitting at the machine, including the "Stop StarCore" button. Only bind to `0.0.0.0` on networks you trust.
- It does not expose StarCore to the public internet. `0.0.0.0` only reaches devices that can already route to the server's private LAN address; it says nothing about port-forwarding, a reverse proxy, or any other path in from outside the LAN, and none of that is set up or recommended here.
- It does not touch Pterodactyl/Wings or its own configuration. StarCore's `[server]` section and port are independent of anything Pterodactyl manages.
