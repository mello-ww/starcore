# StarCore documentation

Everything about running StarCore, using it and building on it. New here? Start with the
[README](../README.md), then [Deployment](guide/deployment.md).

## Guides

How to run StarCore and work with it day to day.

| | |
| --- | --- |
| [Deployment](guide/deployment.md) | Install on Windows or Linux, HTTPS, LAN access, configuration, runtime data |
| [Docker](guide/docker.md) | Run the Engine in a container |
| [Mission Control](guide/mission-control.md) | The web interface: sign-in, Home, Configuration, Developer Mode |
| [CLI](guide/cli.md) | Every command, `--json`, exit codes and permissions |
| [StarCore for Android](../mobile/README.md) | Install the app, or build and sign it yourself |
| [Your first Satellite](guide/first-satellite.md) | A working Satellite with an interface on both clients, in three small files |

## Concepts

What StarCore is made of, and why.

| | |
| --- | --- |
| [Architecture](concepts/architecture.md) | The Engine, Satellites, clients and how they talk |
| [Terminology](concepts/terminology.md) | The words StarCore uses, and what each one means |
| [Philosophy](concepts/philosophy.md) | The principles behind the design |

## Satellites

| | |
| --- | --- |
| [How Satellites work](satellites/README.md) | Manifest, routes, state, services, configuration, capabilities |
| [Status](satellites/status.md) | System readings, history and warnings |
| [Photo](satellites/photo.md) | Photo and video library, albums, map, phone backup |
| [Locked Folder](satellites/locked_folder.md) | The PIN-protected, optionally encrypted area of Photos |
| [Music](satellites/music.md) | Library, streaming, playlists, Daily Mixes, lyrics, Connect |
| [File Explorer](satellites/file_explorer.md) | Browse, preview, upload and manage files |

## Reference

The contracts every client and Satellite is written against.

| | |
| --- | --- |
| [API](reference/api.md) | The Engine's HTTP API, authentication and HTTPS |
| [UI contract](reference/ui-contract.md) | How a Satellite describes its interface (`ui.json`) for every client |
| [Audio playback](reference/media-audio.md) | The shared audio host and the `audio.library` and `audio.session` capabilities |

## Project

Where StarCore stands and how it ships.

| | |
| --- | --- |
| [Roadmap](project/roadmap.md) | Current state, known limitations, the latest security review, what comes next |
| [Remaining work](project/remaining-work.md) | The detailed list behind the shared interface |
| [Releasing](project/releasing.md) | Versions, signing, publishing, updates, backups and rollback |
| [Release notes](releases/v0.1.0.md) | 0.1.0, the first stable release ([0.1.0-alpha.1](releases/v0.1.0-alpha.1.md)) |
| [Changelog](../CHANGELOG.md) | Every change, release by release |
| [Contributing](../CONTRIBUTING.md) | Setting up, the checks to run, and the rules a change must follow |
| [Security policy](../SECURITY.md) | How to report a vulnerability |

## Archive

Audits and migration plans whose work is finished, kept for the reasoning they record:
[Photos parity audit](archive/photos-parity-audit.md),
[File Explorer migration](archive/file-explorer-migration.md),
[Open with](archive/open-with-audit.md),
[Locked Folder actions](archive/m5-locked-folder-actions-audit.md).
