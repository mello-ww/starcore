"""Verifies .gitignore actually protects the runtime-data/secret paths this
milestone introduced, and does not accidentally hide legitimate source or
configuration files - see "Runtime data location" in docs/deployment.md.

Uses a real, disposable git repository (git check-ignore) rather than
reimplementing gitignore's own matching rules, so this verifies exactly
what git itself would do with the real .gitignore - not this test's own
guess at gitignore semantics.
"""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from starcore import core as core_module

GITIGNORE_PATH = core_module.BASE_DIR / ".gitignore"


def _ignored(paths) -> set:
    """The subset of `paths` (repo-relative) that git would ignore, given
    the real repository's .gitignore, inside a throwaway git repo."""
    directory = Path(tempfile.mkdtemp(prefix="starcore-gitignore-tests-"))
    try:
        shutil.copyfile(GITIGNORE_PATH, directory / ".gitignore")
        subprocess.run(["git", "init", "-q"], cwd=directory, check=True)

        ignored = set()
        for relative in paths:
            target = directory / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("x", encoding="utf-8")

            result = subprocess.run(
                ["git", "check-ignore", "-q", relative],
                cwd=directory,
            )
            if result.returncode == 0:
                ignored.add(relative)
        return ignored
    finally:
        shutil.rmtree(directory, ignore_errors=True)


class GitignoreProtectsRuntimeDataTest(unittest.TestCase):
    """What must never reach a commit."""

    def test_the_legacy_auth_store_location_is_ignored(self):
        ignored = _ignored(["engine/data/auth.json"])
        self.assertIn("engine/data/auth.json", ignored)

    def test_satellite_data_directories_are_ignored(self):
        paths = [
            "satellites/native/locked_folder/data/pin.json",
            "satellites/native/photo/data/library.json",
            "satellites/native/music/data/library.json",
        ]
        self.assertEqual(_ignored(paths), set(paths))

    def test_certificate_and_key_files_are_ignored_wherever_they_live(self):
        paths = [
            "starcore-cert.pem",
            "starcore-key.pem",
            "certs/server.crt",
            "certs/server.p12",
            "certs/server.pfx",
        ]
        self.assertEqual(_ignored(paths), set(paths))

    def test_machine_specific_config_toml_is_ignored_wherever_it_lives(self):
        # config.toml is what an installation actually edits (bind
        # address/port, HTTPS paths, a Locked Folder path, a library
        # location, ...) - see config_defaults.py and docs/deployment.md,
        # "Keeping configuration up to date". Its config.default.toml
        # sibling (the tracked schema/shipped-defaults, never machine-
        # specific) is covered by GitignoreDoesNotHideSourceTest below.
        paths = [
            "engine/config.toml",
            "satellites/native/locked_folder/config.toml",
            "satellites/native/photo/config.toml",
            "satellites/native/music/config.toml",
            "satellites/native/file_explorer/config.toml",
            "satellites/native/status/config.toml",
            "satellites/link/docker/config.toml",
        ]
        self.assertEqual(_ignored(paths), set(paths))

    def test_mobile_build_artifacts_and_signing_secrets_are_ignored(self):
        # see mobile/README.md, "Project data and .gitignore" - the mobile
        # app is a separate project with its own build/dependency tooling,
        # so it needs its own set of generated-output and secret patterns
        # alongside the engine's.
        paths = [
            "mobile/node_modules/react-native/package.json",
            "mobile/android/app/build/outputs/apk/debug/app-debug.apk",
            "mobile/android/build/generated/foo",
            "mobile/android/local.properties",
            "mobile/android/app/release.keystore",
            "mobile/android/app/release.jks",
            "mobile/android/keystore.properties",
            "mobile/ios/Pods/Podfile.lock",
            "mobile/ios/build/output",
            "mobile/some.mobileprovision",
            "mobile/certs/distribution.p12",
            "mobile/.env",
        ]
        self.assertEqual(_ignored(paths), set(paths))


class GitignoreDoesNotHideSourceTest(unittest.TestCase):
    """What must always be trackable - the rules above must not be so broad
    that a normal source, config, or documentation file gets silently
    swallowed too."""

    def test_tracked_source_and_configuration_files_are_never_ignored(self):
        paths = [
            "engine/starcore/auth.py",
            "engine/starcore/runtime_paths.py",
            "engine/starcore/config_defaults.py",
            "engine/starcore/api/server.py",
            "engine/config.default.toml",
            "satellites/native/locked_folder/config.default.toml",
            "satellites/native/locked_folder/satellite.toml",
            "satellites/native/locked_folder/api.py",
            "satellites/native/locked_folder/mission_control/page.js",
            "satellites/native/photo/config.default.toml",
            "docs/deployment.md",
            "docs/locked_folder.md",
            "mission_control/index.html",
            "mission_control/app.js",
            "mobile/package.json",
            "mobile/src/App.tsx",
            "mobile/src/auth/session.ts",
            "mobile/android/app/build.gradle",
            "mobile/android/app/src/main/AndroidManifest.xml",
            "mobile/android/app/src/main/java/com/starcore/mobile/MainActivity.kt",
            "mobile/README.md",
        ]
        self.assertEqual(_ignored(paths), set())


if __name__ == "__main__":
    unittest.main()
