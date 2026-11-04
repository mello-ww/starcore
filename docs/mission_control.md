# Mission Control

Mission Control is the official web interface of StarCore.

It shows the current state of the Core and of the Satellites loaded into it, and lets a user run commands and stop the Core from the browser. It talks to the Engine only through the public API, so it has no direct access to Core internals and no knowledge of individual Satellites.

## Starting StarCore

From the `engine` directory:

```
python -m starcore
```

The Engine loads its configuration, discovers Satellites and their commands, starts Mission Control and drops into the interactive terminal CLI - both run against the same Core at once, so a command typed in the terminal and a command run from Mission Control's Console see the same state. StarCore stays usable when Mission Control is disabled or cannot bind its port; only the web interface is unavailable in that case.

Mission Control is then available at:

```
http://127.0.0.1:8080
```

## What it displays

A persistent sidebar divides Mission Control into the Core and the Satellites orbiting it.

The Core section holds the pages that belong to StarCore itself:

- **Overview** - whether the Core is running, uptime, the number of loaded Satellites (split by type), the number of registered commands, the engine name and the address Mission Control is served from, alongside a map of the Satellites in orbit around the Core. Each Satellite in the orbit map is drawn from its generic `status` (see "Satellite status and icons" below); hovering or focusing one shows its name and status (`"Photo — running"`), and reduced-motion preferences are respected the same way they are everywhere else in Mission Control.
- **Satellites** - a card for every loaded Satellite: its own icon (or a generic fallback), name, version, author, description, type, status badge and the CLI commands it contributes
- **Console** - a web equivalent of the terminal CLI: it lists the available commands, lets a user enter and run one, and shows its output. It executes commands through the same command registry as the terminal, so behavior is identical either way. Its topbar also carries the Stop and Restart controls described in "Stopping and restarting StarCore" below.
- **Configuration** - view the current `[server]` settings and change them, with the same validation and "restart required" honesty as the CLI's `config` command. See "Configuration" below.

The Satellite section below it is built from the API rather than from a fixed list. A Satellite earns its own page by shipping one (`mission_control/page.js`, as the Photo Satellite does) or by publishing state through the `state.py` convention, in which case Mission Control renders that state generically. A Satellite that does neither stays in the Satellites list without a page of its own. The section scrolls on its own, so the Core pages stay reachable however many Satellites are loaded.

Pages are addressable: `#/overview`, `#/satellites`, `#/console`, `#/configuration` and `#/satellite/<name>` can be linked to directly, and browser navigation works as expected.

Mission Control polls the API every 5 seconds. If the Core becomes unreachable it keeps the last known values and shows an error message.

Home also carries each enabled Satellite's **widgets** - the summaries a Satellite declares in
its `ui.json` (UI contract 1.1, see [UI contract](ui-contract.md)), drawn by the shared renderer.
Status's is overall health, CPU, memory, satellites online and the most important warnings. A
widget without a source binds to the state its Satellite publishes, which already arrives with
that 5-second `/api/satellites` poll, so it adds no request of its own; clicking it opens the
page it names (`#/satellite/Status/overview`). Home names no Satellite.

## Stopping and restarting StarCore

The topbar's "Stop StarCore" button requests a graceful shutdown of the Core through the API - the same shutdown a terminal CLI `exit` triggers. It asks for confirmation before sending the request, and once StarCore has stopped the page stops polling and disables the Console and Restart button.

The "Restart" button next to it does the same graceful shutdown - it is not a second,
separate shutdown path - but leaves StarCore's process ready to start itself straight back up
(`POST /api/restart`, see `docs/api.md`). Like Stop, it asks for confirmation first (a second
click within a few seconds). After the request is sent, Mission Control shows a "StarCore is
restarting..." banner and polls `/api/status` in the background until the new process
answers, then reconnects and clears the banner automatically - there is nothing to click to
reconnect.

## Logging in

Mission Control is protected by StarCore's authentication system (`docs/api.md` -
"Authentication") once an administrator account exists. A fresh install shows a setup screen
instead of the app itself, asking for a username and password to create that first account;
after that, Mission Control shows a login screen to anyone without a valid session, and a
"Log out" button next to "Stop StarCore" in the topbar ends the current session and returns
to the login screen. Until an administrator account is created, the setup screen itself is
reachable with no session, by design. Opened from any device other than the server itself
(including through the HTTPS proxy), it also asks for the one-time setup code StarCore prints
at startup - see "Authentication" in `docs/api.md`.

## About and build information

Configuration > About shows the version, release channel, build number, commit and build date
of the running Engine (Mission Control is served by it, so they share one version), and the
sidebar shows the version at its bottom. **Copy build info** copies the same details as plain
text for a bug report - nothing about the server's address, accounts or paths. Everything comes
from `/api/status` "build" (`engine/starcore/build_info.py`: the `VERSION` file and Git); see
`docs/releasing.md`.

## Developer Mode

The terminal icon at the top right turns Developer Mode on and off. It is off by default and
remembered per account in this browser. While it is on, Mission Control also shows the Console,
Mission Control's address and port, Satellite reload buttons and versions, and each Satellite's
advanced settings and diagnostics. It only changes what is shown: every action is still checked
by the server. See docs/satellites.md, "Developer Mode".

## Configuration

Mission Control uses the `[server]` section of `engine/config.toml`:

```toml
[server]
enabled = true
host = "127.0.0.1"
port = 8080
```

`enabled = false` starts the Core without the web interface. Defaults are used when the section, a key or the configuration file itself is missing.

`host`, `port` and `enabled` can all be viewed and changed from the Configuration page, without editing `config.toml` by hand - the same is true from the terminal CLI's `config` command (`docs/cli.md` covers the command convention it follows) and from `GET`/`POST /api/configuration` directly. All three go through the same `Configuration.set()` call, so validation and persistence are identical everywhere: an invalid value (an empty host, a non-numeric or out-of-range port) is rejected with a clear error and nothing is written.

`[server]` is only read once, when the Core starts, so a saved change never applies to the process that's already running - the Configuration page, the CLI and the API all say so plainly ("restart required") rather than implying the change is live. Restart StarCore for a saved `[server]` change to take effect.

By default `host = "127.0.0.1"` keeps Mission Control reachable only from the machine it runs on. Setting `host = "0.0.0.0"` makes it reachable from other devices on the same private network - see "Private LAN access" in the deployment documentation for how to do that safely, including the firewall changes it typically requires. Every API request still needs a session once the administrator exists; to reach Mission Control from the internet, put it behind the HTTPS reverse proxy described in the deployment documentation rather than exposing its port directly.

## Satellites in Mission Control

A Satellite's page is its own `mission_control/page.js` when it ships one. Otherwise, a
Satellite with a `ui.json` gets a page drawn by Mission Control's shared renderer
(`mission_control/ui/renderer.js`, mounted exactly like a `page.js`): its navigation as tabs,
its blocks, live data from its routes, and actions that call them. The renderer knows the
[UI contract](ui-contract.md), never a Satellite. A new revision of the document (after an
update or a rediscovery) remounts the page.

A Satellite that ships both a `ui.json` and a `page.js` gets the shared interface; its
`page.js` is the fallback if the document is refused. In Developer Mode, the button beside the
Satellite's title switches between the two (remembered per browser), so a Satellite moving to
`ui.json` can be compared with its previous page before that page is retired.

The Satellites page has a **Rediscover** button: StarCore re-reads every Satellite's
`ui.json` and manifest metadata from disk, without loading any code, and says what changed -
including any new Satellite folder, which loads at the next restart.

Satellites are never hardcoded into the Core or into the frontend. A Satellite appears in Mission Control as soon as the Engine discovers it, and it decides for itself what it contributes: state, routes of its own, a page of its own, or nothing at all. Mission Control renders published state as generic labelled values, and hands a Satellite that ships a page the container to draw in. Both are described in the Satellites documentation.

### Satellite status and icons

Every Satellite card, its sidebar entry and its own page show a status badge -
"Running", "Stopped", "Disabled" or "Error" - built from the generic `status` field
`GET /api/satellites` already reports (see "Status and icon" in `docs/satellites.md`); the
frontend does not compute or guess status itself, only labels the value it's given. The same
Satellite also shows an icon next to its name wherever it's listed, taken from its own
declared `icon` (again generic - the Core does not maintain a name-to-icon mapping) or a
neutral placeholder icon when it didn't declare one.

### Satellite configuration

A Satellite can also expose its own settings, kept separate from the Core's own
Configuration page (which only ever holds `[server]` - see "Configuration" above). A
configurable Satellite gets a small gear button: on its card on the Satellites page, and, on
its own Mission Control page, next to its name in the topbar (a Satellite's custom page fills
the same space its card's button would normally sit in, so the topbar is where that page's
gear lives instead).

The button opens a single reusable modal, built from whatever the Satellite's own
`GET .../configuration` response describes rather than anything Satellite-specific in
`app.js` - a field per setting, its input type (checkbox, number or text) inferred from the
current value's type. Saving sends only the changed field to `POST .../configuration`; a
rejected value is shown as a validation error in the modal without closing it, and a
successful save shows whatever note the Satellite returned (e.g. that a background service
was restarted, or that a restart of StarCore itself is still needed) - the same
error-and-note handling the Core's own Configuration page uses for `[server]`, applied
generically to any Satellite.

Which settings exist, their defaults, validation and persistence all belong to the
Satellite; Mission Control and the Core only provide the button, the modal, and the generic
request plumbing. Photo Sync's `sync_host`/`sync_port` are the first Satellite to use this -
see `docs/satellites/photo.md` - and the underlying mechanism is documented for Satellite authors in
`docs/satellites.md` under "Exposing configuration".

A setting a Satellite describes with `"type": "path"` (Photo's `photo_directory` and Music's
`library` - see `docs/satellites/photo.md` and `docs/satellites/music.md`) gets a "Browse…" button next to its
field in the modal, opening a small directory picker. The picker is itself completely
generic: it browses through whichever enabled Satellite provides the `files.browse`
capability (File Explorer, with its `entries` route - see [UI contract](ui-contract.md)) and
simply hands back whatever absolute path was chosen. It only appears when such a provider is
present and enabled; a `"path"` field always still accepts a typed path directly, with or
without it.

## API

Mission Control is a client of the Engine API, which is described in the API documentation. The frontend itself is plain HTML, CSS and JavaScript served by the Engine from the `mission_control` directory, so it has no build step and no dependencies.

The Console does not implement its own command handling - it calls `POST /api/commands/execute`, which runs the command through `StarCore.execute_command()`, the same method the terminal CLI calls directly.
