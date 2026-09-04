from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock
import io
import sys
import tempfile
import threading
import time
import unittest

from starcore.cli.main import main, run
from starcore.core import StarCore
from starcore.manifest import SatelliteManifest
from starcore.satellite import Satellite
from starcore.satellite_config import SatelliteConfig
from tests.support import start_engine, stop_engine


class CoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def test_status_describes_a_running_core(self):
        status = self.engine.status()

        self.assertEqual(status["engine"], "StarCore")
        self.assertTrue(status["running"])
        self.assertGreaterEqual(status["uptime_seconds"], 0.0)
        self.assertEqual(status["satellites"]["total"], len(self.engine.registry.all()))
        self.assertEqual(status["commands"], len(self.engine.command_registry.all()))

    def test_status_reports_disabled_mission_control(self):
        mission_control = self.engine.status()["mission_control"]

        self.assertFalse(mission_control["enabled"])
        self.assertFalse(mission_control["running"])
        self.assertIsNone(mission_control["url"])

    def test_satellites_are_discovered_with_a_type(self):
        satellites = self.engine.registry.all()

        self.assertTrue(satellites)
        for satellite in satellites:
            self.assertIn(satellite.type, ("native", "link"))

    def test_registry_lookup_ignores_case(self):
        satellite = self.engine.registry.all()[0]

        self.assertIs(self.engine.registry.get(satellite.manifest.name.upper()), satellite)
        self.assertIs(self.engine.registry.get(satellite.manifest.name.lower()), satellite)

    def test_registry_returns_none_for_unknown_satellite(self):
        self.assertIsNone(self.engine.registry.get("does-not-exist"))

    def test_every_satellite_publishes_a_state_dictionary(self):
        for satellite in self.engine.registry.all():
            self.assertIsInstance(satellite.state(self.engine), dict)

    def test_core_commands_are_still_registered(self):
        commands = self.engine.command_registry.all()

        for name in ("help", "version"):
            self.assertIn(name, commands)
            self.assertEqual(commands[name]["source"], "core")

    def test_status_command_is_owned_by_a_satellite(self):
        entry = self.engine.command_registry.get("status")

        self.assertIsNotNone(entry)
        self.assertNotEqual(entry["source"], "core")
        self.assertIsNotNone(self.engine.registry.get(entry["source"]))

    def test_cli_and_api_observe_the_same_running_core(self):
        # the CLI calls execute_command() directly; the API calls the same
        # method through payloads.execute() - both must see one shared Core
        from starcore.api import payloads

        cli_result = self.engine.execute_command("version")
        api_result = payloads.execute(self.engine, "version")

        self.assertEqual(cli_result, "StarCore CLI v1.0.0")
        self.assertIn(cli_result, api_result["output"])


class SatelliteLoadingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine()

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def test_every_satellite_loads_what_it_declares(self):
        # a satellite whose modules fail to import is only reported as a warning, so
        # the result has to be checked rather than a clean start trusted
        for satellite in self.engine.registry.all():
            name = satellite.manifest.name
            if (satellite.path / "api.py").exists():
                self.assertTrue(satellite.routes, f"{name} declares api.py but registered no routes")
            if (satellite.path / "state.py").exists():
                self.assertIsNotNone(satellite.state_provider, f"{name} declares state.py but has no provider")
            if (satellite.path / "mission_control" / "page.js").exists():
                self.assertIsNotNone(satellite.page, f"{name} ships a page that was not picked up")

    def test_a_satellite_is_importable_as_a_package(self):
        registered = [satellite for satellite in self.engine.registry.all() if satellite.routes]
        self.assertTrue(registered, "no satellite exercises multi-module loading")

        for satellite in registered:
            package = f"satellites.{satellite.type}.{satellite.path.name}"
            self.assertIn(package, sys.modules)
            self.assertEqual(getattr(sys.modules[package], "__path__", None), [str(satellite.path)])

    def test_the_whole_package_chain_is_registered(self):
        satellite = next(satellite for satellite in self.engine.registry.all() if satellite.routes)

        for ancestor in ("satellites", f"satellites.{satellite.type}",
                         f"satellites.{satellite.type}.{satellite.path.name}"):
            self.assertIn(ancestor, sys.modules, f"{ancestor} is not importable")


class CliReplTest(unittest.TestCase):
    def test_exit_command_stops_the_engine(self):
        engine = start_engine(mission_control=True)
        inputs = iter(["version", "exit"])

        with mock.patch("starcore.cli.main._interactive", return_value=True), \
             mock.patch("builtins.input", lambda prompt="": next(inputs)), \
             redirect_stdout(io.StringIO()):
            run(engine)

        self.assertTrue(engine.stopped.is_set())
        self.assertFalse(engine.status()["running"])
        self.assertFalse(engine.api.running)

    def test_eof_stops_the_engine_like_exit(self):
        engine = start_engine(mission_control=False)

        with mock.patch("starcore.cli.main._interactive", return_value=True), \
             mock.patch("builtins.input", side_effect=EOFError), \
             redirect_stdout(io.StringIO()):
            run(engine)

        self.assertTrue(engine.stopped.is_set())

    def test_a_non_interactive_stdin_never_starts_a_reader_thread(self):
        # a service manager or a closed/redirected stdin reads as EOF on the very
        # first call - starting the reader thread there would immediately stop
        # the engine the moment it started, so it must not start at all
        engine = start_engine(mission_control=False)

        with mock.patch("starcore.cli.main._interactive", return_value=False), redirect_stdout(io.StringIO()):
            runner = threading.Thread(target=run, args=(engine,), daemon=True)
            runner.start()
            time.sleep(0.1)

            self.assertTrue(runner.is_alive())
            self.assertNotIn("starcore-cli", {thread.name for thread in threading.enumerate()})

            engine.stop()
            runner.join(timeout=2)

        self.assertFalse(runner.is_alive())
        self.assertTrue(engine.stopped.is_set())

    def test_remote_shutdown_unblocks_the_cli_without_waiting_for_input(self):
        engine = start_engine(mission_control=True)
        never = threading.Event()  # simulates a terminal blocked on input() forever

        def blocking_input(prompt=""):
            never.wait()
            raise EOFError

        try:
            # _interactive() is mocked explicitly (rather than relying on
            # whatever stdin happens to be while the suite runs) so this test
            # deterministically exercises the reader thread it's named after,
            # instead of silently testing nothing when stdin isn't a tty.
            with mock.patch("starcore.cli.main._interactive", return_value=True), \
                 mock.patch("builtins.input", blocking_input), redirect_stdout(io.StringIO()):
                reader = threading.Thread(target=run, args=(engine,), daemon=True)
                reader.start()

                time.sleep(0.1)  # let the reader thread reach the blocking input() call
                self.assertTrue(reader.is_alive())

                engine.stop()  # simulates what the API's /api/shutdown handler does
                reader.join(timeout=2)

            self.assertFalse(reader.is_alive())
            self.assertTrue(engine.stopped.is_set())
        finally:
            # engine.stop() above only unblocks run()'s own wait() - the inner
            # "starcore-cli" thread it spawned is still genuinely stuck inside
            # blocking_input()'s never.wait(), exactly as intended. Release it
            # and wait for it to actually finish here, or it leaks as a real,
            # permanently-blocked "starcore-cli"-named thread for the rest of
            # the test process - which would then poison every later test that
            # enumerates threads by name (e.g. the headless-stdin tests in
            # this file and in test_deployment.py).
            never.set()
            for thread in threading.enumerate():
                if thread.name == "starcore-cli":
                    thread.join(timeout=2)

    def test_request_restart_stops_the_engine_and_sets_the_flag(self):
        engine = start_engine(mission_control=False)
        self.assertFalse(engine.restart_requested)

        with redirect_stdout(io.StringIO()):
            engine.request_restart()

        self.assertTrue(engine.restart_requested)
        self.assertTrue(engine.stopped.is_set())
        self.assertFalse(engine.status()["running"])

    def test_a_plain_stop_never_sets_the_restart_flag(self):
        # request_restart() reuses stop() - this documents that stop() itself
        # never implies a restart was ever asked for
        engine = start_engine(mission_control=False)
        stop_engine(engine)

        self.assertFalse(engine.restart_requested)


class MainEntrypointTest(unittest.TestCase):
    """starcore.cli.main.main() itself - specifically, that a restart request
    makes it re-exec the process (never a second shutdown implementation, and
    never just refreshing Mission Control) while a plain stop exits for good.

    os.execv/os._exit are mocked because actually calling either would tear
    down the test process; StarCore is swapped for a disposable, unstarted
    instance the same way tests/support.start_engine() builds one, since
    main() constructs its own engine with no way to inject one.
    """

    def _disposable_engine(self, services=False) -> StarCore:
        directory = Path(tempfile.mkdtemp(prefix="starcore-tests-"))
        native = directory / "native"
        link = directory / "link"
        native.mkdir(parents=True)
        link.mkdir(parents=True)
        config_path = directory / "config.toml"
        config_path.write_text(
            f"[server]\nenabled = false\nhost = \"127.0.0.1\"\nport = 0\n"
            f"\n[satellites]\nservices = {str(services).lower()}\n",
            encoding="utf-8")

        engine = StarCore(config_path)
        engine.native_path = native
        engine.link_path = link
        return engine

    def test_main_re_execs_itself_after_a_requested_restart(self):
        engine = self._disposable_engine()

        with mock.patch("starcore.cli.main.StarCore", return_value=engine), \
             mock.patch("starcore.cli.main._interactive", return_value=False), \
             mock.patch("starcore.cli.main.os.execv") as execv, \
             mock.patch("starcore.cli.main.os._exit") as exit_, \
             redirect_stdout(io.StringIO()):
            threading.Thread(target=lambda: (time.sleep(0.1), engine.request_restart()), daemon=True).start()
            main()

        execv.assert_called_once()
        exit_.assert_not_called()
        args = execv.call_args[0]
        self.assertEqual(args[0], sys.executable)
        # the re-exec always targets "-m starcore" (one of the two documented
        # run modes) regardless of how this process itself was originally
        # invoked; anything the process was launched with beyond argv[0] is
        # carried through unchanged
        self.assertEqual(args[1][:3], [sys.executable, "-m", "starcore"])
        self.assertEqual(args[1][3:], sys.argv[1:])
        self.assertTrue(engine.restart_requested)
        self.assertTrue(engine.stopped.is_set())

    def test_main_exits_for_good_after_a_plain_stop(self):
        engine = self._disposable_engine()

        with mock.patch("starcore.cli.main.StarCore", return_value=engine), \
             mock.patch("starcore.cli.main._interactive", return_value=False), \
             mock.patch("starcore.cli.main.os.execv") as execv, \
             mock.patch("starcore.cli.main.os._exit") as exit_, \
             redirect_stdout(io.StringIO()):
            threading.Thread(target=lambda: (time.sleep(0.1), engine.stop()), daemon=True).start()
            main()

        execv.assert_not_called()
        exit_.assert_called_once_with(0)
        self.assertFalse(engine.restart_requested)


class SatelliteStateTest(unittest.TestCase):
    def satellite(self, state_provider):
        manifest = SatelliteManifest("Test", "1.0.0", "tests", "Test satellite.")
        return Satellite(manifest, SatelliteConfig({}), "native", Path("."), state_provider)

    def test_missing_provider_returns_empty_state(self):
        self.assertEqual(self.satellite(None).state(None), {})

    def test_failing_provider_is_isolated(self):
        def broken(engine, satellite):
            raise RuntimeError("boom")

        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.satellite(broken).state(None), {})

        self.assertIn("boom", output.getvalue())

    def test_non_dictionary_state_is_ignored(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.satellite(lambda engine, satellite: "nope").state(None), {})


if __name__ == "__main__":
    unittest.main()
