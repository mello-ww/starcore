# CLI

StarCore has one command system. The same commands, arguments, permissions,
output and exit codes apply wherever a command is typed:

| Where | How | Who it runs as |
|---|---|---|
| StarCore's own terminal | type at the `>` prompt after `python -m starcore` | the operator (full grants) |
| A shell or script | `python -m starcore <command> ...` from `engine/` | the operator (full grants) |
| Mission Control / mobile Console | `POST /api/commands/execute` | the signed-in session (remote grants) |

`starcore` is accepted as a leading word everywhere, so `starcore help` and
`help` are the same command.

## Quick start

```
python -m starcore help                      # every namespace
python -m starcore help music                # one namespace's commands
python -m starcore music seek --help         # one command: arguments, options, permission
python -m starcore engine health             # exit 0 healthy, 1 failing, 5 not running
python -m starcore music devices --json      # structured output for scripts
python -m starcore satellites disable Photo --yes
```

Inside the running StarCore terminal the same lines work without the
`python -m starcore` prefix (`music devices`, `engine status`, ...).

## Global options

| Option | Meaning |
|---|---|
| `--json` | print one JSON document instead of text (see below) |
| `--yes`, `-y` | confirm a command that would otherwise ask first |
| `--help`, `-h` | describe the command instead of running it |
| `--` | everything after it is a value, even if it starts with `-` |

Quote values that contain spaces: `music playlist-create "Road trip"`.
Backslashes are kept as typed, so Windows paths work: `music scan "D:\Music\New"`.

## Exit codes

| Code | Meaning | JSON `error.code` |
|---|---|---|
| 0 | success | - |
| 1 | the command failed (a scan error, an unhealthy check, an internal error) | `failed` |
| 2 | usage error: unknown command or option, missing or invalid argument | `usage` |
| 3 | not allowed: missing permission, or terminal-only from a remote console | `denied` |
| 4 | not found: unknown satellite, playlist, track or device | `not_found` |
| 5 | unavailable: satellite disabled, device offline or unsupported, StarCore not running | `unavailable` |
| 6 | needs confirmation: re-run with `--yes` (or it was declined) | `confirmation_required` |
| 7 | timed out waiting for a device | `timeout` |

## JSON output

Success:

```
$ python -m starcore engine version --json
{
  "ok": true,
  "command": "engine version",
  "exit_code": 0,
  "data": { "starcore": "1.0.0", "python": "3.14.7", "platform": "Windows" }
}
```

Failure (errors go to stderr in text mode, and into the document with `--json`):

```
$ python -m starcore music pause --device Laptop --json
{
  "ok": false,
  "command": "music pause",
  "exit_code": 5,
  "error": { "code": "unavailable", "message": "'Laptop' is offline (last seen 2026-11-02T21:14:03+00:00)" }
}
```

Some failures also carry `data` (for example `engine health` lists every check).

## Commands

Run `help <namespace>` for the live list. RO = read-only; the permission is
what the caller needs; "terminal" means the command cannot run from Mission
Control or the mobile Console.

### engine (core)

| Command | | Permission |
|---|---|---|
| `engine status` (also just `engine`) | engine state, satellites, commands, Mission Control | `engine.read` RO |
| `engine version` | StarCore, Python and platform versions | `engine.read` RO |
| `engine uptime` | how long StarCore has been running | `engine.read` RO |
| `engine health` | engine, Mission Control and every satellite; exit 0/1/5 | `engine.read` RO |
| `engine restart` | full restart (re-exec); asks first; terminal | `engine.manage` |
| `engine stop` | shut down; asks first; terminal | `engine.manage` |

### satellites (core)

| Command | | Permission |
|---|---|---|
| `satellites list` (also just `satellites`) | every satellite, its status and command namespaces | `engine.read` RO |
| `satellites show <name>` | details and published state | `engine.read` RO |
| `satellites enable <name>` | enable and start; terminal | `engine.manage` |
| `satellites disable <name>` | stop and disable; asks first; terminal | `engine.manage` |
| `satellites reload <name>` | reload from disk and restart; asks first; terminal | `engine.manage` |

These call the same `StarCore.set_satellite_enabled()` / `reload_satellite()`
as Mission Control's buttons.

### music (Music satellite)

| Command | | Permission |
|---|---|---|
| `music stats` (also just `music`) | tracks, albums, artists, size, last scan | `music.read` RO |
| `music scan [directory] [--background]` | index the configured sources or one directory; terminal | `music.manage` |
| `music scan-status` | whether a scan is running, and its progress | `music.read` RO |
| `music tracks [count] [--offset n]` (alias `list`) | tracks with their ids | `music.read` RO |
| `music albums [count] [--offset n]` | albums | `music.read` RO |
| `music artists [count] [--offset n]` | album artists | `music.read` RO |
| `music likes [--kind track\|album\|artist]` | your likes | `music.read` RO |
| `music like <id>... [--kind ...]` / `music unlike <id>...` | like or unlike | `music.control` |
| `music playlists` | your playlists | `music.read` RO |
| `music playlist <playlist>` | one playlist with entry ids | `music.read` RO |
| `music playlist-create <name> [--description text]` | new empty playlist | `music.control` |
| `music playlist-add <playlist> <track-id>... [--allow-duplicates]` | add tracks | `music.control` |
| `music playlist-remove <playlist> <entry-id>...` | remove entries | `music.control` |
| `music playlist-delete <playlist>` | delete; asks first; terminal | `music.control` |
| `music devices` | StarCore Connect devices: online, playing, remote control | `music.read` RO |
| `music playback [--device d]` (alias `now`) | what a device is playing | `music.read` RO |
| `music play\|pause\|next\|previous [--device d] [--wait s]` | playback control | `music.control` |
| `music seek <position> [--device d] [--wait s]` | jump to seconds or `m:ss` | `music.control` |

A `<playlist>` is its id or its exact name (any letter case). Music data is
per account: the CLI acts for StarCore's account (or the single local
listener before setup); the Console acts for the signed-in session.

**Device targeting.** `--device` takes a device id, its exact name, or the
unique start of its name (`--device pix`). Without it, the active device
(the one playing, or the one that played last) is used. The command is sent
through StarCore Connect exactly as another device would send it, so only
what Connect supports is offered (play, pause, next, previous, seek).

- an unknown or ambiguous name: exit 4 or 2, with the matching devices listed
- a device that is offline, or that does not accept remote control: exit 5
- `--wait N` (0-30 s, default 0) waits for the device to report its new
  state; if it does not, exit 7. Without `--wait`, success means "sent".
- playback commands need the running StarCore (Connect is live state): exit 5 otherwise.

```
$ python -m starcore music devices
Device         Kind    State    Remote  Id
Pixel Phone *  mobile  playing  yes     a1b2c3d4e5f60708
Laptop         web     offline  yes     0f1e2d3c4b5a6978

* active device
$ python -m starcore music pause --device pixel --wait 5
Pause done - Pixel Phone.
$ python -m starcore music seek 1:30
Seek sent - Pixel Phone.
```

### photo (Photo satellite; alias `photos`)

| Command | | Permission |
|---|---|---|
| `photo stats` (also just `photo`) | photos, images, videos, albums, size, storage, sync | `photo.read` RO |
| `photo list [count]` | newest photos and videos | `photo.read` RO |
| `photo albums` | albums and their photo counts | `photo.read` RO |
| `photo sync` | sync listener state, counters, recent uploads (never the sync token) | `photo.read` RO |
| `photo scan [directory]` | preview what an import would add; imports nothing; terminal | `photo.manage` |
| `photo import [directory]` | import a directory; terminal | `photo.manage` |
| `photo config [<key> <value>]` | show or change Photo Sync settings; terminal | `photo.manage` |

Without a directory, scan and import use the configured `photo_directory`.
Neither ever reads from the Locked Folder.

### status (Status satellite)

| Command | | Permission |
|---|---|---|
| `status snapshot` (also just `status`) | health and warnings, engine, satellites online, CPU, memory, sampling | `status.read` RO |
| `status hardware` (alias `metrics`) | CPU (per thread, frequency, load, temperature), memory, swap, drives, disk I/O | `status.read` RO |
| `status network` | interfaces: state, link speed, throughput, traffic, errors | `status.read` RO |
| `status services` | engine, satellites, dependencies, optional components | `status.read` RO |
| `status history [--period 1h\|24h\|7d\|30d] [--series cpu,memory,...]` | latest, average, peak and an ASCII trend per series | `status.read` RO |

These read the Status monitor's snapshot (the running StarCore's latest sample, or one taken on
the spot when no sampler runs) and its history file. Readings a machine can't provide are listed
with the reason. See `docs/satellites/status.md`.

```
$ python -m starcore status history --period 1h --series cpu,memory,net_rx
Last 1h (10s per point)

Series  Latest     Average    Peak        Trend
cpu     38.4 %     36.2 %     95.3 %      :__+_#_:
memory  78.3 %     77.9 %     80.8 %      ._-#:+=+
net_rx  36.5 kb/s  48.1 kb/s  272.0 kb/s  _._+.#..
```

(Captured after about a minute of sampling on a Windows 11 machine; network throughput is
shown in bits per second, like link speeds. The trend is ASCII, so any console can print it.)

### files (File Explorer satellite)

| Command | | Permission |
|---|---|---|
| `files storage` (also just `files`) | total/used/free per volume and for the machine | `files.read` RO |
| `files stat <absolute path>` | type, size, modified time (entries for a folder); terminal | `files.read` RO |

There is deliberately no listing, reading, writing or deleting here. A path
inside the Locked Folder is refused (exit 3) whoever asks.

### locked (Locked Folder satellite; alias `locked-folder`)

| Command | | Permission |
|---|---|---|
| `locked status` (also just `locked`) | configured, PIN set, lockouts, security problems, encryption state; terminal | `locked_folder.read` RO |

It never shows the vault path, file names, keys, PINs or tokens, and there is
no command that unlocks, lists, moves or decrypts anything, or sets, checks or
resets a PIN, recovery key or biometric device. Those stay behind the Locked
Folder's own PIN flow.

### Older commands

`version`, `help`, `hello` and `config [<section.key> <value>]` keep working
as before.

## Security model

**Grants.** A caller's grants are fixed by where it runs - nothing else widens
them, not a configuration setting, not a "developer" mode, not a flag:

- terminal and one-shot CLI: `*.read`, `*.control`, `*.manage`
- Mission Control / mobile Console: `*.read`, `*.control`

**Remote consoles.** Besides the permission, a command must be read-only or
explicitly marked remote to run from Mission Control or the mobile app. Every
state-changing command is terminal-only unless it opts in; a command that
asks for confirmation can never opt in; and remote grants never include
`manage`. Today the remote set is the read-only commands (except
`photo scan`, `files stat` and `locked status`, which stay terminal-only)
plus Music playback, likes and playlist edits (not `playlist-delete`). An
older single-function command runs remotely only if its `COMMAND` metadata
says `"read_only": True` (`help`, `version`, `hello`).

**Confirmation.** Disruptive commands (`engine restart|stop`,
`satellites disable|reload`, `music playlist-delete`) ask first in an
interactive terminal. A script must pass `--yes`; without it they stop with
exit 6 and change nothing. Confirmation never replaces authorization.

**No execution surface.** A command line is split into plain string tokens
(quotes group words; nothing is expanded, evaluated or passed to a shell) and
each token is handed to a typed argument. Control characters, unknown options,
over-long lines and malformed identifiers are refused with exit 2. There is no
generic shell or script command. Paths go through each satellite's own checks
(Music and Photo refuse the Locked Folder; File Explorer's guard refuses it too).

**Audit.** Every state-changing or sensitive command, and every refused one,
is appended to `audit.log` in StarCore's data directory (rotated at 1 MB):
time, surface, actor (`terminal`, `local-cli` or `session:<id>` - an opaque
session id, never the token), account, command, arguments (values marked
sensitive are redacted) and outcome. Read-only commands are not logged. An
older single-function command that is not declared read-only is logged too,
with only the number of its arguments unless its `COMMAND` metadata sets
`"audit_arguments": True` (as `config` does - its values are settings and
paths, never secrets).

**Devices.** A Connect command reaches only the caller's own account's
devices, only if the device is online and accepts remote control, and
`--wait` is capped at 30 seconds.

## How the one-shot CLI reaches the running StarCore

`python -m starcore <command>` first looks for `control.json` in StarCore's
data directory. A running StarCore writes it at start, with its API address
and a token made fresh for that run, readable only by the account running
StarCore, and removes it on stop. The command is posted to
`POST /api/cli/run` with that token; the endpoint accepts nothing else (no
session cookie, no bearer token) and only connections from this machine.

When no StarCore is running (no file, or nothing answers), the command runs
in the CLI's own process against the same configuration and data, with no
service started. Read-only commands and scans work; commands that need the
live engine (`engine health`, playback, lifecycle, changing Photo settings)
exit 5. If Mission Control is disabled, StarCore has no API to reach, so the
CLI runs offline even while StarCore is running - prefer StarCore's own
terminal for state-changing commands in that setup.

## Adding commands

Command name = Python module = namespace. Core namespaces live in
`engine/starcore/cli/commands/`; a Satellite adds its own in
`satellites/<type>/<name>/commands/<namespace>.py`, discovered whenever the
satellite is (and refreshed on reload). A module declares:

```python
from starcore.cli.spec import Argument, Command, Option, bounded

NAMESPACE = "status"
SUMMARY = "System snapshot, service states and available metrics"
DEFAULT = "snapshot"          # run when only the namespace is typed (optional)
ALIASES = ()                  # other names for the namespace (optional)

def services(ctx):
    return {"services": [...]}  # data; rendered as text, or as-is with --json

COMMANDS = [
    Command("services", "Every Satellite's service state", services, "status.read",
            render=lambda data: "...", examples=("status services",)),
]
```

`Command` fields: `name`, `summary`, `handler(ctx, **values)`, `permission`
(`<area>.read|control|manage`), `arguments` / `options` (typed, validated
before the handler runs), `mutates` (state-changing: audited, terminal-only
unless `remote=True`), `confirm` (question asked first; `--yes` skips it),
`remote`, `requires_live`, `sensitive` (audit even when read-only), `render`,
`examples`, `aliases`. A handler raises `CommandError` (or `UsageError`,
`NotFound`, `Unavailable`, `PermissionDenied`, `CommandTimeout`) to fail with
the matching exit code; `ctx.user` is the account to act for and `ctx.live`
says whether this process is the running StarCore.

Use the satellite's own services - never a second copy of its logic.

A namespace name must be unique across the registry. Core commands are
discovered first, so a satellite cannot shadow a core command or another
satellite's. A satellite with no `commands/` directory contributes nothing.

An older module with a single function of the same name (and an optional
`COMMAND` metadata dict) still works; it receives the raw argument list.

**Schemas.** `help --json` returns every command's schema (arguments, options,
permission, read-only, confirmation, remote) filtered to what the caller may
run, and `GET /api/commands` includes the remote-runnable schemas per
namespace. That is what an automated client - an AI agent, later - would
read. Nothing executes commands on its own: running one always goes through
the same authorization as a person typing it.
