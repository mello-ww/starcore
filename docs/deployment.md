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

- It does not by itself make Mission Control safe to reach from outside a trusted network. Authentication (below) protects every API endpoint once an administrator account exists, but StarCore still has no built-in reverse proxy, rate limiting or intrusion detection - only bind to `0.0.0.0`, and only forward a port, on networks and to the extent you trust.
- It does not expose StarCore to the public internet. `0.0.0.0` only reaches devices that can already route to the server's private LAN address; it says nothing about port-forwarding, a reverse proxy, or any other path in from outside the LAN, and none of that is set up or recommended here.
- It does not touch Pterodactyl/Wings or its own configuration. StarCore's `[server]` section and port are independent of anything Pterodactyl manages.

## Authentication

StarCore ships with a single-administrator authentication system - see "Authentication" in
`docs/api.md` for the full mechanics (endpoints, sessions, password hashing). What matters for
deployment:

- A fresh install has no administrator account, and the API is deliberately open until one is
  created - Mission Control shows a setup screen for exactly this reason. **Create the
  administrator account before binding `server.host` to anything other than `127.0.0.1`.**
  There is no way to reach the setup screen remotely and lock everyone else out - the first
  visitor to complete it becomes the administrator - so do this from the machine itself, or
  over a connection you already trust, before opening the port up.
- Once the account exists, every API endpoint other than `/api/auth/*` requires a valid
  session, enforced entirely server-side (`ApiServer._authorized()`) - Mission Control hiding
  a button never was, and still isn't, the actual protection.
- Sessions last 7 days and are stored in `auth.json`, under StarCore's application-data
  directory (see "Runtime data location" below) - created on first use, and never inside the
  Git checkout by default. Deleting that file forgets every session and the administrator
  account itself, which is the supported way to reset a lost password: stop StarCore, delete
  `auth.json` from the application-data directory, start it again, and the setup screen
  reappears.
- Photo Sync (`satellites/native/photo/sync.py`) keeps its own separate device-token
  authentication on its own port - see "Photo Sync and authentication" in `docs/photo.md` -
  and is unaffected by any of this.

## Runtime data location

StarCore's own credentials, sessions, and a Satellite's own generated secrets (the Locked
Folder's PIN hash - see `docs/locked_folder.md`) are machine-specific runtime state, not
source code, and by default live entirely outside the Git checkout - the same way a desktop
application's user data never lives inside its own installation directory. `starcore.
runtime_paths.data_dir()` is the one place that decides where:

```
Windows:      %APPDATA%\StarCore
Linux/macOS:  $XDG_DATA_HOME/starcore   (defaults to ~/.local/share/starcore)
```

Set the `STARCORE_DATA_DIR` environment variable to override this - a fixed path for a
shared/service install (`/var/lib/starcore`, say), or anything else a particular deployment
needs. It always wins, on every platform. The directory (and everything under it) is created
lazily, only once something actually needs to be written there - nothing is created just by
starting StarCore or checking its status.

What actually lives there:

```
<data_dir>/auth.json                                  the administrator account and sessions
<data_dir>/satellites/LockedFolder/pin.json            the Locked Folder's PIN hash
```

Only the Locked Folder's own generated secret moves here - Photo's and Music's libraries stay
exactly where they've always been (`satellites/native/<name>/data/`, inside the checkout, but
already excluded by `.gitignore`): that content is the user's own photos and music, not a
credential, and moving potentially large existing libraries around automatically was
deliberately out of scope for this.

### Migrating an existing installation

An installation from before this was introduced had `engine/data/auth.json` (inside the
checkout) and, if a Locked Folder PIN had been set, `satellites/native/locked_folder/data/
pin.json` (also inside the checkout, and also already covered by `.gitignore` either way -
this was never actually reaching a commit, just living somewhere less appropriate than it
should have). The very first time a new StarCore build runs, each of these is moved
automatically - not copied - to its new location: the administrator account, every existing
session, and any configured Locked Folder PIN all keep working exactly as they did before,
with nothing to reconfigure.

This is safe to run repeatedly and is never destructive: if the new location already has its
own file (a second install pointed at the same checkout, for instance), the old one is simply
left exactly where it was rather than being overwritten or deleted, and migration is retried
(a no-op, at that point) on every subsequent start. If the move itself fails for some reason
(a permissions problem, e.g.), StarCore logs a `[WARNING]` and keeps working from the old
location for that run rather than losing anything or refusing to start - migration is simply
retried the next time.

## HTTPS

Configured through the same `[server]` section as everything else in `engine/config.toml`:

```toml
[server]
https_enabled = false
https_cert = ""   # path to a PEM certificate file
https_key = ""    # path to a PEM private key file
```

Enabling it wraps Mission Control's listening socket in TLS using Python's standard `ssl`
module - no extra dependency, on either platform. If the certificate or key is missing,
unreadable, or the two don't match, StarCore prints a `[WARNING]` explaining why and Mission
Control does **not** start - it never falls back to plain HTTP silently, since that would
give a false sense of security on a deployment that thinks it configured HTTPS correctly.

### Getting a certificate

For local or private-LAN use, a self-signed certificate is enough - browsers will warn about
it once, which is expected and fine on a network you already trust; it's the same trust model
as connecting to any other device on your LAN by IP.

**Linux/macOS** (`openssl` is normally already installed):
```
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout starcore-key.pem -out starcore-cert.pem -days 365 \
  -subj "/CN=localhost"
```

**Windows** (PowerShell, no separate install needed):
```powershell
$cert = New-SelfSignedCertificate -DnsName "localhost" -CertStoreLocation "cert:\CurrentUser\My"
$pwd = ConvertTo-SecureString -String "temporary" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath starcore.pfx -Password $pwd
# Convert to PEM (requires OpenSSL for Windows, or do this step from WSL/Git Bash instead):
openssl pkcs12 -in starcore.pfx -out starcore-cert.pem -clcerts -nokeys -passin pass:temporary
openssl pkcs12 -in starcore.pfx -out starcore-key.pem -nocerts -nodes -passin pass:temporary
```

or, more simply on Windows, generate the PEM pair directly from WSL or Git Bash using the same
`openssl req` command shown for Linux/macOS above.

For a certificate a browser won't warn about (a real domain name, reachable from the
internet), use a normal CA-issued certificate - for example [Let's
Encrypt](https://letsencrypt.org/) via `certbot` - and point `https_cert`/`https_key` at the
files it produces (`fullchain.pem` / `privkey.pem`). That is a much bigger step than running
StarCore on a private LAN and isn't required for the common case this document otherwise
covers.

Then point the config at the files and enable it:

```toml
[server]
https_enabled = true
https_cert = "/opt/starcore/certs/starcore-cert.pem"
https_key = "/opt/starcore/certs/starcore-key.pem"
```

`[server]` is only read at startup, same as `host`/`port` - restart StarCore for this to take
effect. Once it does, Mission Control is at `https://<host>:<port>` instead of `http://`.

**Never commit a certificate or private key to the repository** - `.gitignore` already
excludes `*.pem`, `*.key`, `*.crt`, `*.p12` and `*.pfx` (see "What's covered" below), but keep
them outside the checkout entirely (e.g. `/opt/starcore/certs/` on Linux, a sibling folder on
Windows) as good practice regardless.

## What's covered by `.gitignore`

Runtime data and secrets live outside the checkout by default (see "Runtime data location"
above), so there is normally nothing here to accidentally commit at all. `.gitignore` still
excludes, as a backstop:

- `engine/data/` - the historical, pre-migration location of the authentication store, kept
  ignored in case migration ever falls back to it (see "Migrating an existing installation"
  above) or an advanced setup points `STARCORE_DATA_DIR` back inside the checkout on purpose;
- `satellites/*/*/data/` - every Satellite's own storage directory (Photo's and Music's
  libraries, which are deliberately unaffected by this milestone and still live here; the
  Locked Folder's PIN hash too, if explicitly configured to live inside the checkout rather
  than the application-data directory);
- any `*.pem`/`*.key`/`*.crt`/`*.p12`/`*.pfx` file, wherever it lives in the checkout.

None of this is a substitute for the application-data directory being the default in the
first place - it is exactly the "defense in depth" a `.gitignore` rule is: a backstop for the
exception, not the mechanism the common case relies on.
