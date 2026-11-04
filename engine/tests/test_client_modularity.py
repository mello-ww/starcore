"""Clients know UI contracts and capabilities, not Satellites.

A guard over the *generic* client code - Mission Control's shell and shared
renderer, the Android app outside its Satellite-specific folders - that
fails when it names a Satellite. The couplings that predate UI contract 1.0
are listed with their current counts: the list may only shrink, as each is
migrated (docs/ui-contract.md, "Migration"). A new Satellite must never need
an entry here.

The same applies between Satellites: one Satellite's code naming another is
listed too, so that list can only shrink as well.
"""

from pathlib import Path
import re
import tomllib
import unittest

REPO = Path(__file__).resolve().parents[2]

# folders of Satellite-specific client code, which may know their own Satellite
SATELLITE_SPECIFIC = ("mobile/src/music/", "mobile/src/photo/", "mobile/src/status/", "mobile/src/lockedFolder/")

# generic code that still names a Satellite: (file, current count) - lower a
# count, or drop the line, when a coupling goes; never raise one or add a line
KNOWN_COUPLINGS = {
    # icons for servers older than 1.0, whose Satellites can't declare icon_name
    "mobile/src/satellites/icons.ts": 6,
    # the dedicated Photo and Music screens, and Status's screen and Home card for
    # servers older than its ui.json (the Satellites list reads the same table)
    "mobile/src/screens/HomeScreen.tsx": 4,
}

# Satellite code naming another Satellite: (file, current count)
KNOWN_CROSS_SATELLITE = {
    # Photo hosts the Locked Folder's page as a tab (until sections are discovered)
    "satellites/native/photo/mission_control/page.js": 1,
    # Photo shows the Locked Folder's private media in its library views
    "satellites/native/photo/private_media.py": 1,
    # the Locked Folder's vault lives beside Photo's library
    "satellites/native/locked_folder/vault.py": 1,
    # File Explorer refuses to browse into the Locked Folder - a security
    # boundary, which a capability ("files.protected") could express later
    "satellites/native/file_explorer/locked_folder_guard.py": 1,
    # not Satellite references: a Python type named "Status" and a column
    # label, matched by the same pattern
    "satellites/native/music/library.py": 1,
    "satellites/native/photo/commands/photo.py": 1,
}


def satellite_names() -> list:
    paths = [*REPO.glob("satellites/*/*/satellite.toml"), *REPO.glob("examples/satellites/*/*/satellite.toml")]
    return sorted({tomllib.loads(path.read_text(encoding="utf-8"))["name"] for path in paths})


def references(path: Path, names: list) -> list:
    """A Satellite name as a string literal ("Photo") or an object key
    (Photo: ...), outside comments - the forms a name branch takes."""
    alternatives = "|".join(re.escape(name) for name in names)
    pattern = re.compile(rf"""(['"`])({alternatives})\1|(?<![\w.$])({alternatives})\s*:(?!:)""")
    found = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip().startswith(("//", "*", "/*", "#")):
            continue
        found.extend(f"{number}: {match.group(0)}" for match in pattern.finditer(line))
    return found


def generic_client_files() -> list:
    files = [*REPO.glob("mission_control/*.js"), *REPO.glob("mission_control/ui/*.js")]
    for path in [*REPO.glob("mobile/src/**/*.ts"), *REPO.glob("mobile/src/**/*.tsx")]:
        relative = path.relative_to(REPO).as_posix()
        if not relative.startswith(SATELLITE_SPECIFIC):
            files.append(path)
    return sorted(files)


class ClientModularityTest(unittest.TestCase):
    def test_generic_client_code_names_no_satellite_beyond_the_known_couplings(self):
        names = satellite_names()
        self.assertIn("Showcase", names)  # the example counts too: a new Satellite is never special
        problems = []
        for path in generic_client_files():
            relative = path.relative_to(REPO).as_posix()
            found = references(path, names)
            allowed = KNOWN_COUPLINGS.get(relative, 0)
            if len(found) > allowed:
                problems.append(f"{relative} names a Satellite {len(found)} times (allowed {allowed}): {found}")
            elif len(found) < allowed:
                problems.append(f"{relative} now names a Satellite only {len(found)} times - "
                                f"lower its KNOWN_COUPLINGS entry to {len(found)} so it can't creep back")
        self.assertEqual(problems, [])

    def test_satellites_name_no_other_satellite_beyond_the_known_couplings(self):
        names = satellite_names()
        problems = []
        for manifest in REPO.glob("satellites/*/*/satellite.toml"):
            own = tomllib.loads(manifest.read_text(encoding="utf-8"))["name"]
            others = [name for name in names if name != own]
            folder = manifest.parent
            for path in [*folder.rglob("*.js"), *folder.rglob("*.py")]:
                relative = path.relative_to(REPO).as_posix()
                found = references(path, others)
                allowed = KNOWN_CROSS_SATELLITE.get(relative, 0)
                if len(found) != allowed:
                    problems.append(f"{relative}: {len(found)} references to other Satellites "
                                    f"(listed: {allowed}): {found}")
        self.assertEqual(problems, [])

    def test_the_shared_renderers_and_contract_name_no_satellite_at_all(self):
        names = satellite_names()
        for relative in ("mission_control/ui/renderer.js", "mission_control/ui/contract.js",
                         "mobile/src/satellites/ui/contract.ts", "mobile/src/satellites/ui/UiBlocks.tsx",
                         "mobile/src/satellites/ui/api.ts", "mobile/src/screens/SatelliteUiScreen.tsx",
                         "engine/starcore/ui_contract.py"):
            text = (REPO / relative).read_text(encoding="utf-8")
            for name in names:
                self.assertNotRegex(text, rf"\b{re.escape(name)}\b", f"{relative} mentions {name}")


if __name__ == "__main__":
    unittest.main()
