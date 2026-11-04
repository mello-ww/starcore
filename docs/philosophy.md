# Philosophy

StarCore is designed around a simple idea:

A self-hosted server should feel like a single platform rather than a collection of unrelated applications.

Whenever possible, StarCore integrates existing software instead of replacing it. (Link Satellites)

When integration is not enough or a better experience can be provided, functionality can be implemented natively. (Native Satellites)

The Engine should remain generic.

Feature-specific logic belongs to Satellites.

Shared platform capabilities belong to the Engine.

StarCore is designed to grow by composition rather than by increasing the complexity of the Engine.

The platform should evolve by installing new components, not by modifying its core.

## Interfaces

The same idea applies to what people see.

Clients know UI contracts and capabilities, not individual Satellites.

A Satellite declares its interface with reusable blocks; Mission Control and the Android app render the same declaration, each with its own platform components.

Shared interface components can be embedded by any Satellite. A file browser or a media picker is bound to a capability, never to the Satellite that happens to provide it.

Satellites provide capabilities to each other through the Engine, which keeps them discoverable.

A new Satellite should not require a client update, unless it introduces a genuinely new native capability - and then that capability is written once and becomes available to every Satellite after it.

Existing implementations are the reference for what the shared components must do. The platform becomes modular by extracting and generalising what already works, not by rebuilding it.

See [UI contract](ui-contract.md) for the contract, and for what is implemented today and what is still the target.
