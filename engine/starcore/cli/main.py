import os
import threading

from ..core import StarCore


def run(engine: StarCore):
    # commands are read on a background daemon thread so a shutdown requested
    # elsewhere (e.g. Mission Control) can wake the wait() below immediately,
    # instead of sitting blocked on input() until the next keypress
    def read_commands():
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

    threading.Thread(target=read_commands, name="starcore-cli", daemon=True).start()
    engine.stopped.wait()


def main():
    engine = StarCore()
    engine.start()

    try:
        run(engine)
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()

    # a remote shutdown (e.g. from Mission Control) can leave the CLI reader
    # thread blocked inside input() - it's a daemon thread so it can't block
    # process exit, but CPython's normal interpreter shutdown still tries to
    # acquire stdin's buffer lock and aborts the process when it can't. Our
    # own shutdown is already complete at this point, so exit directly rather
    # than let that finalization crash run.
    os._exit(0)

if __name__ == "__main__":
    main()
