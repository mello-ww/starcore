# StarCore Engine

The Python runtime that loads StarCore's Satellites, serves the API and Mission Control, and
runs the CLI. How to run it is in the repository's [README](../README.md); how it works is in
[docs/architecture.md](../docs/architecture.md), [docs/api.md](../docs/api.md) and
[docs/satellites.md](../docs/satellites.md).

Tests, from this folder: `uv run python -m unittest discover -s tests -t .` (or the virtual
environment's Python directly).
