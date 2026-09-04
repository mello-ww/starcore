# StarCore

> A modular self-hosted platform for building a unified self-hosted ecosystem.

StarCore is an open-source platform that provides a single Engine capable of powering both native features and integrations with existing self-hosted applications.

Instead of managing isolated applications with different interfaces, APIs and authentication systems, StarCore provides a common foundation where services can coexist and work together.

## Why?

Modern self-hosted environments often require many separate applications.

StarCore aims to provide:

- one Engine
- one API
- one authentication system
- one interface
- one modular ecosystem

Install only what you need.

StarCore's own single-administrator authentication protects every API endpoint (Mission
Control, satellite management, shutdown/restart, and satellite APIs alike) once an
administrator account is created - see "Authentication" in `docs/api.md` and
`docs/deployment.md`. Mission Control can also serve over HTTPS using a certificate you
provide - see "HTTPS" in the same two documents.

## Core concepts

- **Engine** — The core runtime that powers StarCore.
- **Native Satellites** — Native feature modules, including Status, FileExplorer, Photo and Music.
- **Link Satellites** — Integrations with external services.
- **Mission Control** — Official web interface.
- **Signals** — Internal event system.

## Running StarCore

Requires Python 3.13, on Windows or Linux. From the `engine` directory:

```
python -m starcore
```

This starts the Engine, loads the Satellites and serves Mission Control at http://127.0.0.1:8080. Run in a terminal, the interactive CLI starts alongside it; run headless (a service manager, no terminal attached), StarCore runs Mission Control on its own instead.

The interactive CLI starts the same Core:

```
python -m starcore.cli.main
```

See the Deployment documentation for installing, running as a Linux service and Windows unattended startup.

## Documentation

- API
- Architecture
- CLI 
- Deployment
- Mission Control
- Philosophy
- Roadmap
- Satellites
- Terminology
