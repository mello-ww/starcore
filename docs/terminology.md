## Engine

The core runtime of StarCore.

It coordinates the platform, exposes the API and provides shared platform services.

---

## Satellite

A Satellite is an installable module that extends StarCore.

There are two types of Satellites:

- **Native Satellites**, which provide functionality directly within StarCore.
- **Link Satellites**, which integrate third-party applications and services.

---

## Signal

An internal event emitted by the Engine or a Satellite.

---

## Mission Control

The official graphical interface of StarCore.

---

## UI contract

The versioned, declarative format (`starcore.ui/<major>.<minor>`) in which a Satellite describes its interface, in a `ui.json` beside its manifest. Clients render it; they never run code from it. See [UI contract](ui-contract.md).

---

## Block

One element of a UI contract document - a field, a list, a button, a slider, a form, a shared file browser... - drawn by each client with its own components. The set of blocks is closed and versioned.

---

## Template

A ready-made page layout built from blocks, such as a dashboard or a list with details. Planned for a later minor version of the UI contract; not implemented yet.

---

## Capability

Something one part of StarCore can rely on another to provide, named and versioned:

- A **Satellite capability** (such as `files.browse`) is a service a Satellite provides to the others through the Engine, declared under `[provides]` in its manifest and listed by the catalog. Any interface can use it without knowing which Satellite provides it.
- A **client capability** (such as native audio playback or a biometric prompt) is something Mission Control or the Android app can do on its device. Only a client update adds one.

---

## Shared block

A block bound to a Satellite capability rather than to a Satellite - the file browser is bound to `files.browse` - so any Satellite can embed it.

---

## Catalog

The Engine's description of what every loaded Satellite *is* - definitions, interfaces and the capabilities they provide - with a revision that changes only when one of them does. `GET /api/catalog`.

---

## Rediscovery

Re-reading Satellite metadata (`ui.json`, icons, capabilities) from disk while StarCore runs. It never loads or reloads code: a new Satellite found this way waits for the next restart.
