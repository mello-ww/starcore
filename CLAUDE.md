# StarCore - notes for Claude Code

StarCore is a self-hosted platform: a Python **Engine** that loads **Satellites** (plug-in
features), a web client (**Mission Control**, `mission_control/`) and an Android app
(`mobile/`, React Native). Read the docs below for detail instead of rediscovering it; this
file covers only what a session must not get wrong. `AGENTS.md` carries the same rules for
Codex.

## Where things are explained

- Architecture and components: `docs/architecture.md`
- Satellites, and how they declare an interface: `docs/satellites.md`, `docs/satellites/*.md`
- UI contract (blocks, formats, widgets, versions, migration): `docs/ui-contract.md`
- Terminology: `docs/terminology.md`. Philosophy: `docs/philosophy.md`
- Current state, known limitations, next steps: `docs/roadmap.md`, `CHANGELOG.md`
- Deployment and releases: `docs/deployment.md`, `docs/releasing.md`
- Android app: `mobile/README.md`

## Architectural rules

- **Satellite-agnostic core.** The Engine, Mission Control and the Android app never name a
  specific Satellite in shared code. `engine/tests/test_client_modularity.py` guards this; a
  legacy exception there should only ever shrink.
- **Satellites declare, clients render.** A Satellite describes its UI, capabilities and actions
  through the shared contracts (`contracts/ui/`, `ui.json`). Clients implement generic,
  reusable renderers and components, never screens hardcoded to one Satellite.
- **UI contract 1.1** (`starcore.ui/1.1`) and its shared renderers (`mission_control/ui/`,
  `mobile/src/satellites/ui/`, `mobile/src/components/`) are the foundation for every future
  migration. Contract changes are additive; existing 1.0 documents and released Alpha clients
  must keep working.
- **Parity.** Web and Android offer the same functionality, each with its platform's behaviour.
- **Reusable layout.** Overlays, navigation and scrolling use shared mechanisms, not per-screen
  offsets. On Android: the `AudioHost` in `mobile/src/media/` (the shared player),
  `TopBarSlot` (header control beside Developer Mode),
  `FloatingPlayerInset` / `FloatingPlayerSpacer` (scroll space for the floating player),
  `PillTabs`. On the web: the `#topbar-extras` slot in Mission Control's top bar.
- **Visual identity.** Tokens live in `mission_control/tokens.css` and
  `mobile/src/theme/tokens.ts`, kept in sync by hand. The look is near-black surfaces, rounded
  floating cards and bubbles, pill-shaped controls, the global accent colour for selected and
  active states, and restrained motion that respects reduced-motion settings. No gradients,
  glow or heavy decoration.
- **Compatibility.** Preserve existing features and backward compatibility. Keep a previous
  implementation until its replacement is validated.

## Current state (Nov 2026)

- **Status** is migrated to the declarative UI contract 1.1 on both clients. Its previous
  web page and Android screen remain as fallbacks until retired (`docs/satellites/status.md`).
- **Music** has its cross-platform redesign: StarCore tokens, pill controls and a
  retractable floating player whose top-bar disc shows the playing cover. It still uses its
  own `page.js` and native screens, not `ui.json`. On Android its player is now the shared
  AudioHost (`mobile/src/media/`), and on the web Mission Control's (`mission_control/media/`),
  both fed by the `audio.library` and `audio.session` capabilities (`docs/media-audio.md`). Native Satellite screens are wired in only by
  `mobile/src/satellites/builtins.tsx`.
- **Photos and File Explorer** still use Satellite-specific client code and need architectural
  work (shared capabilities such as a media gallery) before they move to the contract.

## Working rules

- **Development is separate from production.** The Linux production server is never touched
  from here: no deploys, no restarting its services, no publishing releases, without the
  user's explicit approval.
- **Preserve unrelated local changes.** Commit only the files you changed for the task. Never
  stash, reset or reformat others' work. Commit or push only when asked.
- **Line endings.** Files are stored with LF. Editing tools on Windows can write CRLF; check
  `git diff --stat` before committing, and normalise if a small change shows as whole files.
- **Local demos** use an isolated engine with its own data directory and test accounts, never
  the real configuration or user data. With a phone attached, address the emulator explicitly
  (`adb -s emulator-5554`).
- **Graphify** is not part of the workflow. Don't run or regenerate it. `graphify-out/` is
  local and ignored by Git; consult it only when a dependency question genuinely needs it,
  and read the relevant part rather than loading the whole graph.

## Checks

| What | Command |
| --- | --- |
| Engine and Satellites | `cd engine && .venv/Scripts/python -m unittest discover -s tests -t .` |
| UI contract, web | `node --test contracts/ui/tests/web.test.mjs` |
| Web audio host | `node --test mission_control/tests/media.test.mjs mission_control/tests/sleep.test.mjs` |
| Android | `cd mobile && npm test`, `npm run typecheck`, `npm run lint` |
| Android release build | `cd mobile/android && ./gradlew assembleRelease`, with `JAVA_HOME` set to a JDK 17 for that command only |

Run the checks relevant to what changed; a documentation change needs none of the builds.
