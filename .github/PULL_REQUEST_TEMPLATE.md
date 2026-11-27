## What this changes

<!-- One or two sentences: what changed and why. Link the issue if there is one. -->

## How it was checked

<!-- The checks you ran (see CONTRIBUTING.md) and anything you tried by hand. -->

- [ ] Engine and Satellites: `uv run python -m unittest discover -s tests -t .`
- [ ] UI contract and Mission Control: `node --test contracts/ui/tests/web.test.mjs mission_control/tests/*.test.mjs`
- [ ] Android: `npm test`, `npm run typecheck`, `npm run lint`
- [ ] Not needed (documentation only)

## Checklist

- [ ] Shared code (Engine, Mission Control, Android app) names no specific Satellite
- [ ] A UI contract change updates the Engine, both clients, the `ui.json` files and the fixtures together
- [ ] Web and Android stay at parity
- [ ] Docs and `CHANGELOG.md` updated where a user would notice
- [ ] Nothing personal: no host names, domains or paths from my own machines
