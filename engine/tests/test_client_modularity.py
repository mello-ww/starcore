"""Clients know UI contracts and capabilities, not Satellites.

A guard over the *generic* client code - Mission Control's shell and shared
renderer, the Android app outside its Satellite-specific folders - that
fails when it names a Satellite. The couplings that predate UI contract 1.0
are listed with their current counts: the list may only shrink, as each is
migrated (docs/ui-contract.md, "Migration"). A new Satellite must never need
an entry here.

The same applies between Satellites: one Satellite's code naming another is
listed too, so that list can only shrink as well.

Comments in shared code (the Engine, Mission Control, the app outside its
Satellite-specific folders, its Kotlin and manifest) name no Satellite at all,
with no exception list: they describe contracts and capabilities.
"""

from pathlib import Path
import io
import re
import tokenize
import tomllib
import unittest

REPO = Path(__file__).resolve().parents[2]

# folders of Satellite-specific client code, which may know their own Satellite
SATELLITE_SPECIFIC = ("mobile/src/music/", "mobile/src/photo/", "mobile/src/lockedFolder/")

# generic code that still names a Satellite: (file, current count) - lower a
# count, or drop the line, when a coupling goes; never raise one or add a line
KNOWN_COUPLINGS = {
    # the dedicated Photo and Music screens (the Satellites list reads the same table)
    "mobile/src/screens/HomeScreen.tsx": 2,
}

# generic mobile code that imports a Satellite-specific folder: (file, {folder: count}).
# The composition root is where native Satellite code is wired in; the Photo
# screens are still registered by the navigation. Lower a count when one goes.
KNOWN_IMPORTS = {
    # the composition root: Music's native screens, and the Locked Folder's unlock prompt for
    # the secure action (media.vault)
    "mobile/src/satellites/builtins.tsx": {"mobile/src/music/": 10, "mobile/src/lockedFolder/": 1},
    "mobile/src/navigation/MainTabs.tsx": {"mobile/src/photo/": 5},
    # Photo's background sync, started with the app
    "mobile/src/App.tsx": {"mobile/src/photo/": 1},
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
    files = [*REPO.glob("mission_control/*.js"), *REPO.glob("mission_control/ui/*.js"),
             *REPO.glob("mission_control/media/*.js")]
    for path in [*REPO.glob("mobile/src/**/*.ts"), *REPO.glob("mobile/src/**/*.tsx")]:
        relative = path.relative_to(REPO).as_posix()
        if not relative.startswith(SATELLITE_SPECIFIC):
            files.append(path)
    return sorted(files)


def shared_files() -> list:
    """Every shared source file whose comments are checked: the generic client code, plus
    Mission Control's styles and page, the Engine, and the app's Kotlin and manifest."""
    android = REPO / "mobile/android/app/src/main"
    files = [*generic_client_files(),
             *REPO.glob("mission_control/*.css"), *REPO.glob("mission_control/*.html"),
             *REPO.glob("mission_control/ui/*.css"), *REPO.glob("mission_control/media/*.css"),
             *REPO.glob("engine/starcore/**/*.py"),
             *android.glob("java/**/*.kt"), android / "AndroidManifest.xml"]
    return sorted(set(files))


BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"(?<![:\w\"'\\])//[^\n]*")
MARKUP_COMMENT = re.compile(r"<!--.*?-->", re.S)


def comments(path: Path) -> list:
    """(line, text) of each comment in a file: # comments and triple-quoted strings
    (docstrings) in Python, /* */ and // elsewhere, <!-- --> in markup."""
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".py":
        found = []
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type == tokenize.COMMENT or (
                    token.type == tokenize.STRING and token.string.lstrip("rbuRBU").startswith(('"""', "'''"))):
                found.append((token.start[0], token.string))
        return found
    patterns = [BLOCK_COMMENT, LINE_COMMENT]
    if path.suffix in (".html", ".xml"):
        patterns.append(MARKUP_COMMENT)
    return [(text.count("\n", 0, match.start()) + 1, match.group(0))
            for pattern in patterns for match in pattern.finditer(text)]


def satellite_name_pattern() -> re.Pattern:
    """A Satellite's name in prose: its manifest name, spelled out ("Locked Folder"), plural,
    capitalised, and its folders (locked_folder, src/photo/, lockedFolder/)."""
    words = set()
    for name in satellite_names():
        spelled = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)
        for form in {name, spelled, name[0].upper() + name[1:], spelled[0].upper() + spelled[1:]}:
            words.update({form, form + "s"})
    folders = {path.parent.name for path in REPO.glob("satellites/*/*/satellite.toml")}
    folders |= {prefix.rstrip("/").rsplit("/", 1)[1] for prefix in SATELLITE_SPECIFIC}
    names = "|".join(re.escape(word).replace(r"\ ", r"\s+") for word in sorted(words, key=len, reverse=True))
    snake = "|".join(re.escape(folder) for folder in sorted(folders) if "_" in folder)
    paths = "|".join(re.escape(folder) for folder in sorted(folders))
    # a folder in a path (src/photo/, ../music/, photo/api.ts), not a word before a slash
    folder_path = (rf"(?<![\w.])(?:src|native|link|\.\.?)/(?:{paths})/"
                   rf"|\b(?:{paths})/\w+\.(?:py|js|ts|tsx|css|kt)\b")
    return re.compile(rf"\b(?:{names})\b|\b(?:{snake})\b|{folder_path}")


IMPORT = re.compile(r"""\bfrom\s+['"](\.[^'"]*)['"]|\brequire\(\s*['"](\.[^'"]*)['"]|\bimport\(\s*['"](\.[^'"]*)['"]""")


IMPORT_ANY = re.compile(r"""\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]""", re.M)


def satellite_imports(path: Path) -> dict:
    """{Satellite folder: how many imports} for a file's relative imports that land in a
    Satellite-specific folder (src/music/, src/photo/...)."""
    counts = {}
    for match in IMPORT.finditer(path.read_text(encoding="utf-8")):
        target = (path.parent / next(group for group in match.groups() if group)).resolve()
        try:
            relative = target.relative_to(REPO).as_posix() + "/"
        except ValueError:
            continue
        folder = next((prefix for prefix in SATELLITE_SPECIFIC if relative.startswith(prefix)), None)
        if folder:
            counts[folder] = counts.get(folder, 0) + 1
    return counts


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

    def test_the_engine_names_no_satellite_in_its_code(self):
        """The Engine loads Satellites by manifest: no string literal or object key in its
        code is a Satellite's name (a CLI column or help example uses a placeholder). No
        exception list."""
        names = satellite_names()
        problems = []
        for path in sorted(REPO.glob("engine/starcore/**/*.py")):
            found = references(path, names)
            if found:
                problems.append(f"{path.relative_to(REPO).as_posix()}: {found}")
        self.assertEqual(problems, [])

    def test_generic_mobile_code_imports_no_satellite_folder_beyond_the_known_ones(self):
        problems = []
        for path in generic_client_files():
            relative = path.relative_to(REPO).as_posix()
            if not relative.startswith("mobile/"):
                continue
            found = satellite_imports(path)
            allowed = KNOWN_IMPORTS.get(relative, {})
            if found != allowed:
                problems.append(f"{relative} imports Satellite folders {found} (listed: {allowed})")
        self.assertEqual(problems, [])

    def test_the_web_audio_host_imports_no_satellite_code(self):
        """Mission Control's shared player (mission_control/media/) stays Satellite-agnostic:
        it imports only its own folder, never a Satellite's page modules."""
        files = sorted(REPO.glob("mission_control/media/*.js"))
        self.assertTrue(files)
        for path in files:
            for match in IMPORT_ANY.finditer(path.read_text(encoding="utf-8")):
                target = next(group for group in match.groups() if group)
                self.assertTrue(target.startswith("./") and "/" not in target[2:],
                                f"{path.relative_to(REPO).as_posix()} imports {target}")

    def test_the_audio_host_and_shared_layout_import_no_satellite_folder(self):
        """The shared player and the shell around it stay Satellite-agnostic (docs/media-audio.md)."""
        files = [*REPO.glob("mobile/src/media/**/*.ts"), *REPO.glob("mobile/src/media/**/*.tsx"),
                 *REPO.glob("mobile/src/components/*.tsx"), REPO / "mobile/src/navigation/MainTabs.tsx"]
        self.assertTrue(any("media" in path.parts for path in files))
        for path in files:
            found = satellite_imports(path)
            self.assertNotIn("mobile/src/music/", found, path.relative_to(REPO).as_posix())
            if "media" in path.parts or "components" in path.parts:
                self.assertEqual(found, {}, path.relative_to(REPO).as_posix())

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

    def test_shared_code_comments_name_no_satellite(self):
        pattern = satellite_name_pattern()
        files = shared_files()
        self.assertTrue(any(path.suffix == ".kt" for path in files))
        problems = []
        for path in files:
            for line, comment in comments(path):
                for match in pattern.finditer(comment):
                    number = line + comment.count("\n", 0, match.start())
                    problems.append(f"{path.relative_to(REPO).as_posix()}:{number}: {match.group(0)!r}")
        self.assertEqual(problems, [])

    def test_the_comment_check_finds_a_satellite_in_each_kind_of_comment(self):
        pattern = satellite_name_pattern()
        for sample in ("// opens Photo's page", "/* the Locked\n Folder */", "# File Explorer",
                       "<!-- see src/music/ -->", "locked_folder/vault.py", "Photos' grid", "photo/api.ts"):
            self.assertRegex(sample, pattern)
        for sample in ("// a photo", "// the session's status", "// https://example.com/music",
                       "status/setup/login/logout"):
            self.assertNotRegex(sample, pattern)

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
