# Satellites

Satellites are installable modules that extend StarCore without modifying the Engine.

They are discovered, loaded and managed by the Engine through a common extension system.

A Satellite can:

- expose API endpoints
- emit Signals
- store data
- contribute pages to Mission Control
- provide CLI commands (see CLI)

## Types of Satellites

### Native Satellites

Native Satellites provide functionality directly within StarCore.

Examples include:

- Status
- Files
- Photos
- Music

### Link Satellites

Link Satellites integrate third-party applications and services.

Examples include:

- Docker
- Jellyfin
- Home Assistant
- MQTT

Both categories share the same lifecycle and extension model. The only difference is their purpose.