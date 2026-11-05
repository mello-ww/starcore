# StarCore - notes for coding agents (Codex)

StarCore is a self-hosted platform: a Python Engine (`engine/`) that loads Satellites
(`satellites/`), a web client, Mission Control (`mission_control/`), and an Android app
(`mobile/`, React Native). `CLAUDE.md` holds the fuller project notes. Both files follow the
same rules, and the documentation in `docs/` is the source of truth.

Start with `docs/architecture.md`, `docs/ui-contract.md`, `docs/satellites.md` and
`docs/roadmap.md` (current state and limitations).

## Rules

1. **Keep the core Satellite-agnostic.** The Engine and both clients never name a specific
   Satellite in shared code; `engine/tests/test_client_modularity.py` enforces it.
2. **Satellites declare their UI, capabilities and actions** through the shared contracts
   (`contracts/ui/`, a Satellite's `ui.json`). Client code is generic and reusable.
3. **UI contract 1.1** and its shared renderers are the base for every migration. Contract
   changes are additive; v1.0 documents and released clients keep working.
4. **Web and Android keep functional parity**, each with its platform's behaviour.
5. **Layout is shared.** Overlays, navigation and scroll spacing go through reusable
   mechanisms (`TopBarSlot`, `FloatingPlayerInset`, `PillTabs`, Mission Control's
   `#topbar-extras`), not fixed per-screen offsets.
6. **Visual identity:** StarCore tokens (`mission_control/tokens.css`,
   `mobile/src/theme/tokens.ts`), rounded floating surfaces, pill controls, the global accent
   for selected or active states, and restrained animation.
7. **Preserve existing functionality** and backward compatibility.
8. **Never deploy, restart production services or publish a release** without explicit
   approval. Development is separate from the Linux production installation.
9. **Preserve unrelated local changes.** Commit only what the task changed, with LF line
   endings.
10. **Don't run Graphify.** `graphify-out/` is local, ignored output. Read it selectively,
    only when it helps.

## Current state

Status runs on the declarative UI contract 1.1 on both clients. Music has its cross-platform
redesign and a retractable floating player, but keeps its own client code. Its player is the shared
AudioHost on both clients (`mobile/src/media/`, `mission_control/media/`; `docs/media-audio.md`). Photos and File
Explorer still need architectural work before moving to the contract.

## Checks

- Engine: `cd engine && .venv/Scripts/python -m unittest discover -s tests -t .`
- UI contract (web): `node --test contracts/ui/tests/web.test.mjs`
- Web audio host: `node --test mission_control/tests/media.test.mjs`
- Android: `cd mobile && npm test && npm run typecheck && npm run lint`
