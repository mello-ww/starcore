import os
import signal
import sys
import threading

from ..core import StarCore

# SIGBREAK only exists on Windows; SIGTERM exists wherever signal.signal is usable.
# Python's default handling of SIGTERM is immediate termination, which would skip
# the clean shutdown Ctrl+C already gets - a service manager (systemd, Task
# Scheduler) needs that to stop StarCore without leaving anything half-written.
_STOP_SIGNALS = [signal.SIGTERM] + ([signal.SIGBREAK] if hasattr(signal, "SIGBREAK") else [])


def _install_stop_signals(engine: StarCore):
    def handler(signum, frame):
        engine.stop()

    for stop_signal in _STOP_SIGNALS:
        try:
            signal.signal(stop_signal, handler)
        except (OSError, ValueError, RuntimeError):
            pass  # not available on this platform/thread; Ctrl+C and Mission Control still work


def _interactive() -> bool:
    return sys.stdin is not None and sys.stdin.isatty()


def _read_commands(engine: StarCore):
    print()
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║                        StarCore CLI                          ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print("Type 'help' for available commands.")
    print("Type 'exit' to quit.")
    print()

    while not engine.stopped.is_set():
        try:
            command = input("> ")
        except EOFError:
            break

        if not command:
            continue
        if command == "exit":
            break

        result = engine.execute_command(command)
        if result is not None:
            print(result)

    engine.stop()


def run(engine: StarCore):
    # an interactive terminal drives the CLI on its own thread, so a shutdown
    # requested elsewhere (e.g. Mission Control) can wake the wait() below
    # immediately instead of sitting blocked on input(). Without a terminal
    # (a service manager, a closed or redirected stdin) there is nothing to
    # read, and starting the thread would just hit EOF and stop the engine
    # the moment it started - so it stays off and shutdown goes through a
    # stop signal or Mission Control instead.
    if _interactive():
        threading.Thread(target=_read_commands, args=(engine,), name="starcore-cli", daemon=True).start()
    else:
        print("No interactive terminal detected. Stop StarCore with a stop signal or Mission Control.")

    engine.stopped.wait()


def main():
    engine = StarCore()
    _install_stop_signals(engine)
    engine.start()

    try:
        run(engine)
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()

    if engine.restart_requested:
        # re-exec this same process rather than starting a second one and
        # exiting - a real restart, not a Mission-Control-only refresh: every
        # service StarCore started is gone (stop() above already completed
        # cleanly) and a brand new interpreter picks it back up from scratch,
        # so nothing can be left half-initialized. "-m starcore" is one of the
        # two documented run modes (see README) regardless of which one this
        # process was actually launched with, so this doesn't need to guess
        # at (or reconstruct) the original invocation.
        os.execv(sys.executable, [sys.executable, "-m", "starcore"] + sys.argv[1:])
        return  # unreachable outside tests, where os.execv is mocked out

    # a remote shutdown (e.g. from Mission Control) can leave the CLI reader
    # thread blocked inside input() - it's a daemon thread so it can't block
    # process exit, but CPython's normal interpreter shutdown still tries to
    # acquire stdin's buffer lock and aborts the process when it can't. Our
    # own shutdown is already complete at this point, so exit directly rather
    # than let that finalization crash run.
    os._exit(0)

if __name__ == "__main__":
    main()
