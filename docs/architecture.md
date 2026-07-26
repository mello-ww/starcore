## Components

### Engine

The Engine is the foundation of StarCore.

It coordinates the platform, exposes the public API, manages the lifecycle of Satellites and provides shared platform services such as storage, authentication, configuration and the internal event system.

### Satellites

Satellites extend StarCore without modifying the Engine itself.

Each Satellite is an independent module that can expose API endpoints, store data, emit Signals and contribute pages to Mission Control.

There are two categories of Satellites:

- **Native Satellites**, which provide functionality directly within StarCore (Status, Files, Photos, Music...).
- **Link Satellites**, which integrate third-party applications and services (Docker, Jellyfin, Home Assistant...).

### Mission Control

Mission Control is the official graphical interface for StarCore.

It communicates exclusively with the Engine through its public API.

## Design

The Engine remains generic while functionality is added through Satellites.

By using a common Satellite system for both native features and third-party integrations, StarCore keeps a consistent extension model and avoids maintaining multiple plugin systems.



## Component overview

```mermaid
flowchart TB

subgraph Clients
MC[Mission Control]
CLI[CLI]
Third[Third-party Applications]
end

subgraph Core
Engine[StarCore Engine]
end

subgraph Platform
Storage
Auth
Signals
Config
end

subgraph Extensions
Native Satellites
Link Satellites
end

MC --> Engine
CLI --> Engine
Third --> Engine

Engine --> Storage
Engine --> Auth
Engine --> Signals
Engine --> Config

Engine --> Satellites
Engine --> Links
```