# Contributing to StarCore

Thanks for looking. StarCore is a one-person project, so the most useful contributions are
small and focused: a bug report with the build info, a fix with a test, a documentation
correction. For anything larger, open an issue first so we can agree on the shape before you
write it.

## Setting up

```
cd engine
uv sync --extra thumbnails --extra encryption
uv run python -m starcore
```

That starts the Engine and Mission Control at http://127.0.0.1:8080. The Android app has its
own setup in [`mobile/README.md`](mobile/README.md). [Deployment](docs/guide/deployment.md)
covers everything else.

Work against a throwaway instance: set `STARCORE_DATA_DIR` to an empty folder so your test
account and sessions stay out of your real data.

## Checks

Run the ones that match what you changed. CI runs all of them on every pull request.

| What | Command |
| --- | --- |
| Engine and Satellites | `cd engine && uv run python -m unittest discover -s tests -t .` |
| UI contract and Mission Control | `node --test contracts/ui/tests/web.test.mjs mission_control/tests/*.test.mjs` |
| Android app | `cd mobile && npm test && npm run typecheck && npm run lint` |
| Android release build | `cd mobile/android && ./gradlew assembleRelease` (JDK 17) |

A documentation change needs none of them.

## The rules a change must follow

These are what keep StarCore modular. The first one is enforced by
`engine/tests/test_client_modularity.py`.

- **The core names no Satellite.** The Engine, Mission Control and the Android app never
  mention a specific Satellite in shared code, comments included. Describe the contract or
  the capability instead.
- **Satellites declare, clients render.** A Satellite describes its interface, capabilities
  and actions through the shared contracts (`ui.json`, `contracts/ui/`). Clients implement
  generic, reusable components, never a screen written for one Satellite.
- **A contract change is made everywhere at once.** A change to the
  [UI contract](docs/reference/ui-contract.md) updates the Engine's validator, both clients,
  every affected `ui.json` and the shared fixtures in the same pull request.
- **Parity.** Web and Android offer the same functionality, each with its platform's
  behaviour.
- **One visual language.** Colours and spacing come from the tokens
  (`mission_control/tokens.css`, mirrored by hand in `mobile/src/theme/tokens.ts`): near-black
  surfaces, rounded cards, pill-shaped controls, the accent for selected and active states,
  restrained motion that respects reduced-motion settings. No gradients or glow.
- **Nothing personal.** No host names, domains, mount points or paths from your own machines.
  Anything that depends on the environment is a setting with a generic default.

[How Satellites work](docs/satellites/README.md) and
[Your first Satellite](docs/guide/first-satellite.md) are the place to start for a new
Satellite.

## Pull requests

- One change per pull request, with the tests that cover it.
- Files are stored with LF line endings. On Windows, check `git diff --stat` before
  committing: a small change should not show as a whole file.
- Commit messages say what changed and why in a sentence, prefixed with `feat:`, `fix:`,
  `docs:` or `release:`.
- Update the docs that describe what you changed, and add a line to
  [`CHANGELOG.md`](CHANGELOG.md) for anything a user would notice.

## AI-assisted contributions

Most of StarCore was written with an AI assistant (see the README), and contributions made
the same way are welcome on the same terms as any other: you have read every line, you
understand it, and you ran the checks yourself.

## Security issues

Please don't open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is released under the project's
[GPL-3.0 license](LICENSE).
